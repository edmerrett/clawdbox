#!/usr/bin/env python3
"""
BLE bridge for the newer TimeBox-Evo-audio / Backpack M generation (Anyka SoC).

The Node daemon spawns this and talks JSON lines over stdin/stdout:

  -> {"op":"anim","name":"idle","frames":[{"ms":200,"pixels":[[r,g,b],...256]}...]}
  -> {"op":"brightness","value":60}
  -> {"op":"ping"}
  <- {"ev":"ready"} {"ev":"connected","address":..,"name":..} {"ev":"shown","name":..}
     {"ev":"error","message":..} {"ev":"log","message":..} {"ev":"pong"}

Modes:
  upload  (default) one 0x8b animation upload per state change; the panel then loops it
          on its own, so no traffic while a state is held.
  stream  push each frame as a 0x44 still at the frame's own timing (capped ~4 fps).
          Constant traffic, but no transfer screen and nothing written to storage.
  slots   upload every animation once (op "preload") into slots 0..N, then switch
          with a single play_slot command per state change. Instant, if the firmware
          honours slot selection for uploaded content.

Depends on the divoom-protocol package (pip install -r bridge/requirements.txt).
Run from Terminal.app or iTerm2 on macOS: the spawning app must declare Bluetooth usage.
"""
import argparse
import asyncio
import json
import sys
import time

try:
    from divoom_protocol import DivoomClient, aa_frame, commands
    from bleak.exc import BleakError
except ImportError as e:  # pragma: no cover
    sys.stdout.write(json.dumps({"ev": "error", "fatal": True,
                                 "message": f"divoom-protocol not installed ({e}); run: pip install -r bridge/requirements.txt"}) + "\n")
    sys.stdout.flush()
    sys.exit(2)


def emit(**ev):
    sys.stdout.write(json.dumps(ev) + "\n")
    sys.stdout.flush()


def log(msg):
    emit(ev="log", message=msg)


class Bridge:
    def __init__(self, address, mode, slot, brightness):
        self.address = address
        self.mode = mode
        self.slot = slot
        self.brightness = brightness
        self.client = None
        self.stream_task = None
        self.lock = asyncio.Lock()
        self.slot_of = {}      # name -> slot (slots mode)
        self.preloaded = []    # [(name, frames)] so we can re-upload after a reconnect

    # ---------- connection ----------
    async def connect(self):
        backoff = 2
        while True:
            try:
                if not self.address:
                    log("scanning for a Divoom/TimeBox BLE device (6s)...")
                    found = await DivoomClient.scan(timeout=6.0)
                    if not found:
                        raise RuntimeError("no Divoom BLE device found; is the phone's Bluetooth off and the box powered?")
                    addr, name = found[0]
                    log(f"found {name} @ {addr}")
                    self.address = addr
                self.client = DivoomClient(self.address)
                await self.client.connect()
                log("connected; running init handshake (~3s)...")
                await self.client.init_session()
                if self.brightness is not None:
                    await self.client.set_brightness(self.brightness)
                emit(ev="connected", address=self.address)
                return
            except Exception as e:
                emit(ev="error", message=f"connect failed: {type(e).__name__}: {e}; retry in {backoff}s")
                try:
                    if self.client:
                        await self.client.disconnect()
                except Exception:
                    pass
                self.client = None
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

    async def reconnect(self):
        try:
            if self.client:
                await self.client.disconnect()
        except Exception:
            pass
        self.client = None
        await self.connect()
        if self.mode == "slots" and self.preloaded:
            log("re-uploading slots after reconnect")
            await self.preload(self.preloaded, announce=False)

    async def with_retry(self, fn):
        """Run fn(); on a BLE error reconnect once and run it again."""
        try:
            await fn()
        except (BleakError, OSError, RuntimeError) as e:
            log(f"BLE error ({e}); reconnecting")
            await self.reconnect()
            await fn()

    # ---------- display ----------
    async def stop_stream(self):
        if self.stream_task:
            self.stream_task.cancel()
            try:
                await self.stream_task
            except (asyncio.CancelledError, Exception):
                pass
            self.stream_task = None

    def encode_chunks(self, slot, frames):
        pixels = [[tuple(p) for p in f["pixels"]] for f in frames]
        times = [max(50, int(f.get("ms", 100))) for f in frames]
        stream = aa_frame.encode_animation_stream(pixels, frame_time_ms=times)
        payloads = aa_frame.split_into_chunks(stream)
        if len(payloads) > 255:
            raise RuntimeError(f"animation too large: {len(payloads)} chunks")
        return [commands.animation_chunk(slot, len(payloads), i, p) for i, p in enumerate(payloads)]

    async def preload(self, anims, announce=True):
        """slots mode: upload each animation into its own slot once."""
        self.preloaded = anims
        for i, (name, frames) in enumerate(anims):
            slot = self.slot + i
            self.slot_of[name] = slot
            chunks = self.encode_chunks(slot, frames)
            await self.with_retry(lambda: self.client.upload_animation(slot, chunks))
            log(f"preloaded {name} into slot {slot}")
            await asyncio.sleep(0.3)
        if announce:
            emit(ev="preloaded", slots=self.slot_of)

    async def play(self, name):
        slot = self.slot_of.get(name)
        if slot is None:
            raise RuntimeError(f"{name} was not preloaded")
        await self.with_retry(lambda: self.client.play_slot(slot))
        emit(ev="shown", name=name, mode="slots", slot=slot)

    async def show_anim(self, name, frames):
        pixels = [[tuple(p) for p in f["pixels"]] for f in frames]
        times = [max(50, int(f.get("ms", 100))) for f in frames]
        await self.stop_stream()
        if self.mode == "stream" or len(frames) == 1:
            if len(frames) == 1:
                await self.with_retry(lambda: self.client.static_image(pixels[0]))
            else:
                self.stream_task = asyncio.create_task(self.stream(pixels, times))
            emit(ev="shown", name=name, mode="stream")
            return

        async def upload():
            chunks = self.encode_chunks(self.slot, frames)
            await self.client.upload_animation(self.slot, chunks)

        t0 = time.time()
        await self.with_retry(upload)
        emit(ev="shown", name=name, mode="upload", seconds=round(time.time() - t0, 2))

    async def stream(self, pixels, times):
        i = 0
        while True:
            try:
                await self.client.static_image(pixels[i % len(pixels)])
            except (BleakError, OSError) as e:
                log(f"stream write failed ({e}); reconnecting")
                await self.reconnect()
            # the panel can't take stills much faster than ~4 fps
            await asyncio.sleep(max(times[i % len(times)], 250) / 1000)
            i += 1

    async def set_brightness(self, value):
        self.brightness = value
        await self.with_retry(lambda: self.client.set_brightness(int(value)))
        emit(ev="brightness", value=value)

    # ---------- main loop ----------
    async def run(self):
        emit(ev="ready", mode=self.mode)
        await self.connect()
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                emit(ev="error", message="bad json")
                continue
            op = msg.get("op")
            async with self.lock:
                try:
                    if op == "anim":
                        await self.show_anim(msg.get("name", "?"), msg["frames"])
                    elif op == "preload":
                        await self.preload([(a["name"], a["frames"]) for a in msg["anims"]])
                    elif op == "play":
                        await self.play(msg["name"])
                    elif op == "brightness":
                        await self.set_brightness(msg["value"])
                    elif op == "ping":
                        emit(ev="pong", connected=self.client is not None)
                    else:
                        emit(ev="error", message=f"unknown op {op}")
                except Exception as e:
                    emit(ev="error", message=f"{op} failed: {type(e).__name__}: {e}")
        await self.stop_stream()
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass


async def scan_only():
    found = await DivoomClient.scan(timeout=6.0)
    for addr, name in found:
        emit(ev="device", address=addr, name=name)
    if not found:
        emit(ev="error", message="no Divoom BLE device found")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", help="BLE address (CoreBluetooth UUID on macOS). Default: scan and take the first Divoom/TimeBox.")
    ap.add_argument("--mode", choices=["upload", "stream", "slots"], default="upload")
    ap.add_argument("--slot", type=int, default=0)
    ap.add_argument("--brightness", type=int)
    ap.add_argument("--scan", action="store_true", help="list devices and exit")
    a = ap.parse_args()
    if a.scan:
        asyncio.run(scan_only())
        return
    try:
        asyncio.run(Bridge(a.address, a.mode, a.slot, a.brightness).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
