import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrap, encodeBrightness, encodeImage, encodeAnimation, packIndices, bitsPerPixel, encodeFrame, ANIM_CHUNK } from '../src/protocol/divoom.js';
import { PIXELS, Rgb } from '../src/anim/types.js';

const BLACK: Rgb = [0, 0, 0];
const ORANGE: Rgb = [0xd9, 0x77, 0x57];

test('brightness 100% matches the documented wire bytes', () => {
  // 01 | len(payload)+2 = 04 00 | 74 64 | sum(04 00 74 64) = dc 00 | 02
  assert.equal(encodeBrightness(100).toString('hex'), '0104007464dc0002');
});

test('wrap: length counts payload + 2, checksum sums length bytes and payload', () => {
  const m = wrap([0x45, 0x00]);
  assert.deepEqual([...m], [0x01, 0x04, 0x00, 0x45, 0x00, 0x49, 0x00, 0x02]);
});

test('bitsPerPixel', () => {
  assert.equal(bitsPerPixel(1), 1);
  assert.equal(bitsPerPixel(2), 1);
  assert.equal(bitsPerPixel(3), 2);
  assert.equal(bitsPerPixel(4), 2);
  assert.equal(bitsPerPixel(5), 3);
  assert.equal(bitsPerPixel(16), 4);
  assert.equal(bitsPerPixel(256), 8);
});

test('packIndices is LSB-first', () => {
  // 1 bit: pixels 1,0,0,0,0,0,0,1 -> 0b10000001
  assert.deepEqual(packIndices([1, 0, 0, 0, 0, 0, 0, 1], 1), [0x81]);
  // 2 bits: 1,2,3,0 -> 0b00111001 = 0x39
  assert.deepEqual(packIndices([1, 2, 3, 0], 2), [0x39]);
  // 3 bits across a byte boundary: 7,7,7 -> 0b111111111 -> ff 01
  assert.deepEqual(packIndices([7, 7, 7], 3), [0xff, 0x01]);
});

test('still image: header, frame length and palette', () => {
  const px: Rgb[] = Array.from({ length: PIXELS }, (_, i) => (i === 0 ? ORANGE : BLACK));
  const m = encodeImage(px);
  const b = [...m];
  assert.equal(b[0], 0x01);
  assert.equal(b.at(-1), 0x02);
  // payload starts at byte 3
  assert.deepEqual(b.slice(3, 8), [0x44, 0x00, 0x0a, 0x0a, 0x04]);
  assert.equal(b[8], 0xaa);
  const frameLen = b[9] | (b[10] << 8);
  // AA(1) LLLL(2) TTTT(2) RR(1) NN(1) palette(2*3) pixels(32) = 45
  assert.equal(frameLen, 45);
  assert.deepEqual(b.slice(11, 14), [0, 0, 0]); // time 0, flag 0
  assert.equal(b[14], 2); // palette size
  assert.deepEqual(b.slice(15, 21), [...ORANGE, ...BLACK]); // first-seen order
  // pixel 0 = ORANGE = index 0, the rest BLACK = index 1, so byte 0 = 0b11111110
  assert.equal(b[21], 0xfe);
  // outer length = payload + 2
  const outerLen = b[1] | (b[2] << 8);
  assert.equal(outerLen, b.length - 1 - 2 - 2 - 1 + 2); // total - 01 - LLLL - CRC - 02 + 2
});

test('256-colour palette is encoded as 00 with 8 bits per pixel', () => {
  const px: Rgb[] = Array.from({ length: PIXELS }, (_, i) => [i, 0, 0] as Rgb);
  const f = encodeFrame(px, 0);
  assert.equal(f[6], 0x00);
  assert.equal(f.length, 1 + 2 + 2 + 1 + 1 + 256 * 3 + 256);
});

test('animation: frames concatenated, chunked at 200 bytes, header repeats total length', () => {
  const frame = (c: Rgb): Rgb[] => Array.from({ length: PIXELS }, (_, i) => (i % 2 ? c : BLACK));
  const anim = { name: 't', frames: [{ ms: 120, pixels: frame(ORANGE) }, { ms: 80, pixels: frame([0, 255, 0]) }, { ms: 100, pixels: frame([0, 0, 255]) }] };
  const msgs = encodeAnimation(anim);
  const perFrame = 45;
  const total = perFrame * 3; // 135 bytes -> 1 chunk
  assert.equal(msgs.length, Math.ceil(total / ANIM_CHUNK));
  const b = [...msgs[0]];
  assert.equal(b[3], 0x49);
  assert.equal(b[4] | (b[5] << 8), total);
  assert.equal(b[6], 0); // chunk index
  assert.equal(b[7], 0xaa);
  assert.equal(b[10] | (b[11] << 8), 120); // frame time ms LSB first
  // second frame starts right after the first
  assert.equal(b[7 + perFrame], 0xaa);
  assert.equal(b[7 + perFrame + 3] | (b[7 + perFrame + 4] << 8), 80);
});

test('animation with many frames spans multiple chunks with increasing indices', () => {
  const frames = Array.from({ length: 12 }, (_, k) => ({
    ms: 100,
    pixels: Array.from({ length: PIXELS }, (_, i) => ((i + k) % 3 === 0 ? ORANGE : BLACK) as Rgb),
  }));
  const msgs = encodeAnimation({ name: 'm', frames });
  assert.ok(msgs.length > 1);
  msgs.forEach((m, i) => {
    assert.equal(m[3], 0x49);
    assert.equal(m[6], i);
  });
  // every chunk but the last carries exactly ANIM_CHUNK bytes of frame data
  for (const m of msgs.slice(0, -1)) assert.equal(m.length, 1 + 2 + 1 + 2 + 1 + ANIM_CHUNK + 2 + 1);
});

test('single-frame animation falls back to a still image', () => {
  const msgs = encodeAnimation({ name: 's', frames: [{ ms: 0, pixels: Array(PIXELS).fill(BLACK) }] });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0][3], 0x44);
});
