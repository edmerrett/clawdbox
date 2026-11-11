#!/usr/bin/env python3
"""
BLE bridge for the newer TimeBox-Evo-audio / Backpack M generation (Anyka SoC).

The Node daemon spawns this and talks JSON lines over stdin/stdout:

  -> {"id":1,"op":"anim","name":"idle","frames":[{"ms":200,"pixels":[[r,g,b],...256]}...]}
  -> {"id":2,"op":"brightness","value":60}
  -> {"id":3,"op":"ping"}
  <- {"ev":"ready"} {"ev":"connected","address":..} {"ev":"disconnected","message":..} {"ev":"log","message":..}
  <- {"ev":"shown","id":1,"re":"anim",...}  {"ev":"error","id":2,"re":"brightness","message":..}

Replies to ops carry the request "id" and "re" (the op name); everything else is status.

Modes:
  stream  (default) push each frame as a 0x44 still at the frame's own timing (capped ~4 fps).
          Constant traffic, but no transfer screen and nothing written to storage.
  upload  one 0x8b animation upload per state change; the panel then loops it on its own,
          but shows its transfer screen during every upload.
  slots   upload every animation once (op "preload") into slots 0..N, then switch with one
          select command per state change. Experimental: the select opcode for uploaded
          content is not known on current firmware.

Depends on the divoom-protocol package (pip install -r bridge/requirements.txt).
Run from Terminal.app or iTerm2 on macOS: the spawning app must declare Bluetooth usage.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
import threading
import time
import traceback
from collections.abc import Awaitable, Callable
from typing import Any

try:
    from bleak.exc import BleakError
    from divoom_protocol import DivoomClient, aa_frame, commands
except ImportError as e:  # pragma: no cover
    _msg = f"divoom-protocol not installed ({e}); run: pip install -r bridge/requirements.txt"
    sys.stdout.write(json.dumps({"ev": "error", "fatal": True, "message": _msg}) + "\n")
    sys.stdout.flush()
    sys.exit(2)

Frame = dict[str, Any]
Pixels = list[tuple[int, int, int]]


class NotConnected(RuntimeError):
    """Raised by ops that need the panel while the link is down."""


# Errors that mean "the BLE link is unhappy; reconnect and try again".
LINK_ERRORS = (BleakError, OSError, NotConnected, asyncio.TimeoutError)

# A preload message carries every frame of every animation; give stdin room for it.
STDIN_LIMIT = 16 * 1024 * 1024
# How long an op may wait for the link to come back before it fails (the daemon
# retries on its own schedule; holding the lock forever would replay stale states).
RECONNECT_BUDGET_S = 45
# How often to check that the BLE link is still up. A box that powers off while the panel
# is idle sends no error on its own; without this the daemon keeps reporting "connected".
LINK_CHECK_S = 3


def emit(**ev: Any) -> None:
    sys.stdout.write(json.dumps(ev) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    emit(ev="log", message=msg)


class Bridge:
    def __init__(self, address: str | None, mode: str, slot: int, brightness: int | None, select_prefix: bytes):
        self.address = address
        self.mode = mode
        self.slot = slot
        self.brightness = brightness
        # bytes sent before the slot number to select a stored animation (slots mode)
        self.select_prefix = select_prefix
        self.client: DivoomClient | None = None
        self.connected = asyncio.Event()
        self.stopping = asyncio.Event()
        self.lock = asyncio.Lock()
        self.stream_task: asyncio.Task[None] | None = None
        self.slot_of: dict[str, int] = {}
        self.preloaded: list[tuple[str, list[Frame]]] = []
        self.latest_anim_id: int | None = None
        self.connecting: asyncio.Task[None] | None = None

    # ---------- connection ----------

    async def connect(self) -> None:
        """Connect, or join the attempt already running, so a watchdog drop and a failed
        write never run two connect loops side by side."""
        if self.connecting is None or self.connecting.done():
            self.connecting = asyncio.create_task(self._connect_loop())
        await asyncio.shield(self.connecting)

    async def _connect_loop(self) -> None:
        backoff = 2
        while not self.stopping.is_set():
            try:
                if not self.address:
                    log("scanning for a Divoom/TimeBox BLE device (6s)...")
                    found = await DivoomClient.scan(timeout=6.0)
                    if not found:
                        raise RuntimeError("no Divoom BLE device found; is the phone's Bluetooth off and the box on?")
                    addr, name = found[0]
                    log(f"found {name} @ {addr}")
                    self.address = addr
                client = DivoomClient(self.address)
                await client.connect()
                log("connected; running init handshake (~3s)...")
                await client.init_session()
                if self.brightness is not None:
                    await client.set_brightness(self.brightness)
                self.client = client
                self.connected.set()
                emit(ev="connected", address=self.address)
                return
            except Exception as e:  # noqa: BLE001 - any failure here means "retry"
                emit(ev="error", message=f"connect failed: {type(e).__name__}: {e}; retry in {backoff}s")
                await self._drop_client()
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

    async def _drop_client(self, reason: str = "link dropped") -> None:
        """Disconnect if we can; the link may already be dead, which is fine."""
        if self.connected.is_set():
            emit(ev="disconnected", message=reason)
        self.connected.clear()
        client, self.client = self.client, None
        if client is None:
            return
        try:
            await asyncio.wait_for(client.disconnect(), timeout=3)
        except (BleakError, OSError, asyncio.TimeoutError) as e:
            log(f"disconnect ignored: {type(e).__name__}: {e}")

    async def reconnect(self) -> None:
        await self._drop_client()
        await self.connect()
        if self.mode == "slots" and self.preloaded:
            log("re-uploading slots after reconnect")
            for name, frames in self.preloaded:
                await self._upload_slot(name, frames)

    def link_alive(self) -> bool:
        """False once the OS has noticed the box is gone (powered off, out of range)."""
        client = self.client
        if client is None:
            return False
        ble = getattr(client, "_ble", None)  # divoom-protocol keeps its BleakClient here
        return ble is None or bool(getattr(ble, "is_connected", True))

    async def watch_link(self) -> None:
        """Notice a dead link even when nothing is being written, report it, and reconnect."""
        while not self.stopping.is_set():
            await asyncio.sleep(LINK_CHECK_S)
            if not self.connected.is_set() or self.link_alive():
                continue
            async with self.lock:
                if not self.connected.is_set() or self.link_alive():
                    continue  # an op already handled it
                log("BLE link lost (panel off or out of range); reconnecting")
                await self.stop_stream()
                await self._drop_client("panel off or out of range")
            # the daemon re-shows the current state (or re-preloads slots) on "connected"
            await self.connect()

    async def with_retry(self, fn: Callable[[], Awaitable[Any]]) -> None:
        """Run fn(); on a link error reconnect (bounded) and run it again."""
        try:
            await fn()
        except LINK_ERRORS as e:
            log(f"BLE error ({type(e).__name__}: {e}); reconnecting")
            await asyncio.wait_for(self.reconnect(), timeout=RECONNECT_BUDGET_S)
            await fn()

    def require_client(self) -> DivoomClient:
        if self.client is None:
            raise NotConnected("not connected")
        return self.client

    # ---------- encoding ----------

    @staticmethod
    def decode(frames: list[Frame]) -> tuple[list[Pixels], list[int]]:
        pixels: list[Pixels] = [[(int(p[0]), int(p[1]), int(p[2])) for p in f["pixels"]] for f in frames]
        times = [max(50, int(f.get("ms", 100))) for f in frames]
        return pixels, times

    def encode_chunks(self, slot: int, frames: list[Frame]) -> list[bytes]:
        pixels, times = self.decode(frames)
        stream = aa_frame.encode_animation_stream(pixels, frame_time_ms=times)
        payloads = aa_frame.split_into_chunks(stream)
        if len(payloads) > 255:
            raise RuntimeError(f"animation too large: {len(payloads)} chunks")
        return [commands.animation_chunk(slot, len(payloads), i, p) for i, p in enumerate(payloads)]

    # ---------- display ----------

    async def stop_stream(self) -> None:
        task, self.stream_task = self.stream_task, None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception as e:  # noqa: BLE001 - a dead stream task must never block the next op
            log(f"stream task ended with {type(e).__name__}: {e}")

    async def show_anim(self, name: str, frames: list[Frame]) -> dict[str, Any]:
        pixels, times = self.decode(frames)
        await self.stop_stream()
        if self.mode == "stream" or len(frames) == 1:
            # land the first frame now (so "shown" means shown), then keep cycling in the background
            await self.with_retry(lambda: self.require_client().static_image(pixels[0]))
            if len(frames) > 1:
                self.stream_task = asyncio.create_task(self.stream(pixels, times, start=1))
            return {"mode": "stream"}
        t0 = time.time()
        chunks = self.encode_chunks(self.slot, frames)
        await self.with_retry(lambda: self.require_client().upload_animation(self.slot, chunks))
        return {"mode": "upload", "seconds": round(time.time() - t0, 2)}

    async def stream(self, pixels: list[Pixels], times: list[int], start: int = 0) -> None:
        """Push stills at the frame timing until cancelled. Each write takes the op lock so
        it never races a reconnect started by another op."""
        i = start
        await asyncio.sleep(max(times[(i - 1) % len(times)], 250) / 1000)
        while True:
            async with self.lock:
                try:
                    await self.require_client().static_image(pixels[i % len(pixels)])
                except LINK_ERRORS as e:
                    log(f"stream write failed ({type(e).__name__}: {e}); reconnecting")
                    await self.reconnect()
            # the panel can't take stills much faster than ~4 fps
            await asyncio.sleep(max(times[i % len(times)], 250) / 1000)
            i += 1

    async def _upload_slot(self, name: str, frames: list[Frame]) -> int:
        if name not in self.slot_of:
            self.slot_of[name] = self.slot + len(self.slot_of)
        slot = self.slot_of[name]
        await self.require_client().upload_animation(slot, self.encode_chunks(slot, frames))
        log(f"preloaded {name} into slot {slot}")
        await asyncio.sleep(0.3)
        return slot

    async def preload(self, anims: list[tuple[str, list[Frame]]]) -> dict[str, Any]:
        self.preloaded = anims
        for name, frames in anims:
            await self.with_retry(lambda name=name, frames=frames: self._upload_slot(name, frames))
        return {"slots": self.slot_of}

    async def play(self, name: str) -> dict[str, Any]:
        slot = self.slot_of.get(name)
        if slot is None:
            raise RuntimeError(f"{name} was not preloaded")
        payload = self.select_prefix + bytes([slot])
        await self.with_retry(lambda: self.require_client().send_raw_payload(payload))
        return {"mode": "slots", "slot": slot, "payload": payload.hex()}

    async def set_brightness(self, value: int) -> dict[str, Any]:
        self.brightness = int(value)
        await self.with_retry(lambda: self.require_client().set_brightness(self.brightness))
        return {"value": self.brightness}

    # ---------- ops ----------

    async def handle(self, msg: dict[str, Any]) -> None:
        op = msg.get("op")
        rid = msg.get("id")
        if op == "ping":
            emit(ev="pong", id=rid, re=op, connected=self.connected.is_set())
            return
        if op in ("anim", "play") and isinstance(rid, int):
            self.latest_anim_id = rid
        try:
            # ops that touch the panel wait for the link (the daemon's timeout bounds this)
            await self.connected.wait()
            async with self.lock:
                if op in ("anim", "play") and isinstance(rid, int) and rid != self.latest_anim_id:
                    # a newer state arrived while we waited; don't flip the panel through stale ones
                    emit(ev="shown", id=rid, re=op, name=msg.get("name"), skipped=True)
                    return
                if op == "anim":
                    result = await self.show_anim(str(msg.get("name", "?")), msg["frames"])
                    emit(ev="shown", id=rid, re=op, name=msg.get("name"), **result)
                elif op == "preload":
                    result = await self.preload([(a["name"], a["frames"]) for a in msg["anims"]])
                    emit(ev="preloaded", id=rid, re=op, **result)
                elif op == "play":
                    result = await self.play(str(msg["name"]))
                    emit(ev="shown", id=rid, re=op, name=msg["name"], **result)
                elif op == "brightness":
                    result = await self.set_brightness(msg["value"])
                    emit(ev="brightness", id=rid, re=op, **result)
                else:
                    emit(ev="error", id=rid, re=op, message=f"unknown op {op}")
        except Exception as e:  # noqa: BLE001 - report every op failure to the daemon, keep serving
            emit(ev="error", id=rid, re=op, message=f"{op} failed: {type(e).__name__}: {e}")

    async def run(self) -> None:
        emit(ev="ready", mode=self.mode)
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self.stopping.set)
        connect_task = asyncio.create_task(self.connect())
        watch_task = asyncio.create_task(self.watch_link())
        reader = asyncio.StreamReader(limit=STDIN_LIMIT)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
        stop_wait = asyncio.create_task(self.stopping.wait())
        pending_ops: set[asyncio.Task[None]] = set()
        try:
            while not self.stopping.is_set():
                line_task = asyncio.create_task(reader.readline())
                done, _ = await asyncio.wait({line_task, stop_wait}, return_when=asyncio.FIRST_COMPLETED)
                if line_task not in done:
                    line_task.cancel()
                    break
                try:
                    line = line_task.result()
                except ValueError:
                    emit(ev="error", message=f"message longer than {STDIN_LIMIT} bytes; dropped")
                    continue
                if not line:
                    break  # stdin closed: the daemon is gone
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    emit(ev="error", message="bad json")
                    continue
                if not isinstance(msg, dict):
                    emit(ev="error", message="message must be an object")
                    continue
                task = asyncio.create_task(self.handle(msg))
                pending_ops.add(task)
                task.add_done_callback(pending_ops.discard)
        finally:
            self.stopping.set()
            stop_wait.cancel()
            connect_task.cancel()
            watch_task.cancel()
            if self.connecting is not None:
                self.connecting.cancel()
            for t in list(pending_ops):
                t.cancel()
            extra = [self.connecting] if self.connecting is not None else []
            await asyncio.gather(connect_task, watch_task, stop_wait, *extra, *pending_ops, return_exceptions=True)
            await self.stop_stream()
            await self._drop_client()
            log("bridge stopped")


async def scan_only() -> None:
    found = await DivoomClient.scan(timeout=6.0)
    for addr, name in found:
        emit(ev="device", address=addr, name=name)
    if not found:
        emit(ev="error", message="no Divoom BLE device found")


def watch_parent(loop: asyncio.AbstractEventLoop, stopping: asyncio.Event) -> None:
    """Stop when the daemon that spawned us is gone, so we never keep the box's only
    BLE connection hostage after a crash. Asks the loop to shut down cleanly (which
    disconnects the panel) and hard-exits only if that takes too long."""
    parent = os.getppid()
    while os.getppid() == parent:
        time.sleep(1)
    loop.call_soon_threadsafe(stopping.set)
    time.sleep(5)
    os._exit(0)


def main() -> int:
    ap = argparse.ArgumentParser(description="clawdbox BLE bridge for the newer TimeBox-Evo-audio")
    ap.add_argument("--address", help="BLE address (CoreBluetooth UUID on macOS); default: scan for a Divoom/TimeBox")
    ap.add_argument("--mode", choices=["upload", "stream", "slots"], default="stream", help="see module docstring")
    ap.add_argument("--slot", type=int, default=0, help="first storage slot used by upload/slots modes")
    ap.add_argument("--brightness", type=int, help="panel brightness 0-100, applied on every connect")
    ap.add_argument("--scan", action="store_true", help="list devices and exit")
    ap.add_argument(
        "--select", default="4505", help="slots mode: hex bytes sent before the slot number (4504 = Signal presets)"
    )
    a = ap.parse_args()
    try:
        select = bytes.fromhex(a.select)
    except ValueError:
        ap.error("--select must be hex bytes, e.g. 4505")
    if a.scan:
        asyncio.run(scan_only())
        return 0
    bridge = Bridge(a.address, a.mode, a.slot, a.brightness, select)

    async def run_with_watchdog() -> None:
        threading.Thread(target=watch_parent, args=(asyncio.get_running_loop(), bridge.stopping), daemon=True).start()
        await bridge.run()

    try:
        asyncio.run(run_with_watchdog())
    except KeyboardInterrupt:
        return 0
    except Exception:  # noqa: BLE001 - last resort: make the crash visible to the daemon's err log
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
