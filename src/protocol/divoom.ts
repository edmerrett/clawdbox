/**
 * Divoom TimeBox Evo (16x16, Bluetooth Classic SPP) message encoder.
 *
 * Sources: RomRider/node-divoom-timebox-evo PROTOCOL.md and
 * d03n3rfr1tz3/hass-divoom devices/divoom.py. Both agree on the layout below.
 *
 * Outer message:   01 | LLLL | PAYLOAD | CRCR | 02
 *   LLLL = len(PAYLOAD) + 2, LSB first
 *   CRCR = 16-bit sum of (LLLL bytes + PAYLOAD), LSB first  (a checksum, not a CRC)
 *   The Evo needs no 01/02/03 escaping.
 *
 * Frame (used by image and animation):
 *   AA | LLLL | TTTT | RR | NN | palette (RGB x NN) | packed indices
 *   LLLL = length of the whole frame including AA and LLLL, LSB first
 *   TTTT = frame time ms LSB first (0 for a still image)
 *   RR   = 00 (palette reset flag; every frame carries its own palette)
 *   NN   = palette size, 256 encoded as 00
 *   indices: ceil(log2(NN)) bits each (min 1), packed LSB-first, pixel index x + 16*y
 */
import { Anim, Frame, PIXELS, Rgb, palettize } from '../anim/types.js';

export const CMD_IMAGE = 0x44;
export const CMD_ANIMATION = 0x49;
export const CMD_BRIGHTNESS = 0x74;
/** Ask the box for its current settings; it answers with 01 .. 04 46 55 .. 02. */
export const CMD_GET_SETTINGS = 0x46;

/** Max frame-data bytes per animation packet. */
export const ANIM_CHUNK = 200;
/** Device drops the link above ~30 messages/s; stay below it. */
export const MAX_MSGS_PER_SEC = 25;

function u16le(n: number): number[] {
  if (n < 0 || n > 0xffff) throw new Error(`u16 out of range: ${n}`);
  return [n & 0xff, (n >> 8) & 0xff];
}

/** Wrap a payload in the outer 01 .. 02 framing with length and checksum. */
export function wrap(payload: Uint8Array | number[]): Buffer {
  const body = [...u16le(payload.length + 2), ...payload];
  const sum = body.reduce((a, b) => a + b, 0) & 0xffff;
  return Buffer.from([0x01, ...body, ...u16le(sum), 0x02]);
}

export function bitsPerPixel(colours: number): number {
  return Math.max(1, Math.ceil(Math.log2(colours)));
}

/** Pack palette indices LSB-first at `bits` bits each. */
export function packIndices(idx: readonly number[], bits: number): number[] {
  const out: number[] = [];
  let acc = 0;
  let nbits = 0;
  for (const p of idx) {
    acc |= (p & ((1 << bits) - 1)) << nbits;
    nbits += bits;
    while (nbits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      nbits -= 8;
    }
  }
  if (nbits > 0) out.push(acc & 0xff);
  return out;
}

/** Encode one frame (AA ... pixels). */
export function encodeFrame(pixels: readonly Rgb[], timeMs: number): number[] {
  if (pixels.length !== PIXELS) throw new Error(`frame must have ${PIXELS} pixels, got ${pixels.length}`);
  const { palette, idx } = palettize(pixels);
  if (palette.length > 256) throw new Error('more than 256 colours in a frame');
  const nn = palette.length === 256 ? 0 : palette.length;
  const body = [
    ...u16le(Math.round(timeMs)),
    0x00, // RR: palette reset
    nn,
    ...palette.flatMap(([r, g, b]) => [r, g, b]),
    ...packIndices(idx, bitsPerPixel(palette.length)),
  ];
  const length = body.length + 3; // AA + LLLL
  return [0xaa, ...u16le(length), ...body];
}

/** Still image: one complete message. */
export function encodeImage(pixels: readonly Rgb[]): Buffer {
  return wrap([CMD_IMAGE, 0x00, 0x0a, 0x0a, 0x04, ...encodeFrame(pixels, 0)]);
}

/** Looping animation: one message per 200-byte chunk, to be sent in order. */
export function encodeAnimation(anim: Anim): Buffer[] {
  if (anim.frames.length === 0) throw new Error(`${anim.name}: no frames`);
  if (anim.frames.length === 1) return [encodeImage(anim.frames[0].pixels)];
  const data = anim.frames.flatMap((f: Frame) => encodeFrame(f.pixels, f.ms));
  if (data.length >= 0x10000) throw new Error(`${anim.name}: animation too large (${data.length} bytes, max 65535)`);
  const chunks = Math.ceil(data.length / ANIM_CHUNK);
  if (chunks > 256) throw new Error(`${anim.name}: too many chunks (${chunks})`);
  const out: Buffer[] = [];
  for (let i = 0; i < chunks; i++) {
    const chunk = data.slice(i * ANIM_CHUNK, (i + 1) * ANIM_CHUNK);
    out.push(wrap([CMD_ANIMATION, ...u16le(data.length), i, ...chunk]));
  }
  return out;
}

export function encodeBrightness(percent: number): Buffer {
  const b = Math.max(0, Math.min(100, Math.round(percent)));
  return wrap([CMD_BRIGHTNESS, b]);
}

export function encodeGetSettings(): Buffer {
  return wrap([CMD_GET_SETTINGS]);
}

/** Byte size of the frame data an animation would stream (for sanity checks / README). */
export function animationBytes(anim: Anim): number {
  return anim.frames.reduce((n, f) => n + encodeFrame(f.pixels, f.ms).length, 0);
}
