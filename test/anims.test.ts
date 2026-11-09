import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { clawdSprites as placeholders } from '../src/anim/clawd.js';
import { fromAnimFile, loopMs, STATES, toAnimFile, PIXELS } from '../src/anim/types.js';
import { fromStrips, writeAnims } from '../src/tools/build-anims.js';
import { loadAnimSet } from '../src/anim/load.js';
import { animationBytes } from '../src/protocol/divoom.js';

test('placeholders exist for every state, are 16x16 and loop in a sane range', () => {
  const all = placeholders();
  for (const s of STATES) {
    const a = all[s];
    assert.ok(a.frames.length >= 2, `${s} should animate`);
    for (const f of a.frames) assert.equal(f.pixels.length, PIXELS);
    const loop = loopMs(a);
    assert.ok(loop >= 400 && loop <= 3000, `${s} loop ${loop}ms`);
    for (const f of a.frames) assert.ok(f.ms >= 150, `${s} has a ${f.ms}ms frame; LEDs strobe below ~150ms`);
    assert.ok(animationBytes(a) < 5000, `${s} should stream quickly (${animationBytes(a)} bytes)`);
  }
});

test('anim JSON round-trips exactly', () => {
  const a = placeholders().running;
  const back = fromAnimFile(toAnimFile(a));
  assert.deepEqual(
    back.frames.map((f) => f.ms),
    a.frames.map((f) => f.ms),
  );
  assert.deepEqual(back.frames[2].pixels, a.frames[2].pixels);
});

test('PNG strips import, write, and load as a full set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdbox-strips-'));
  const out = mkdtempSync(join(tmpdir(), 'clawdbox-anims-'));
  for (const s of STATES) {
    const n = 3;
    const png = new PNG({ width: 16 * n, height: 16 });
    for (let i = 0; i < n; i++) {
      // one coloured pixel per frame at (i, i); everything else transparent
      const idx = (i * png.width + (i * 16 + i)) * 4;
      png.data[idx] = 255;
      png.data[idx + 1] = 128;
      png.data[idx + 2] = 0;
      png.data[idx + 3] = 255;
    }
    writeFileSync(join(dir, `${s}.png`), PNG.sync.write(png));
  }
  const anims = fromStrips(dir, 8);
  assert.equal(anims.length, STATES.length);
  assert.equal(anims[0].frames.length, 3);
  assert.equal(anims[0].frames[0].ms, 125);
  assert.deepEqual(anims[0].frames[1].pixels[1 + 16 * 1], [255, 128, 0]);
  assert.deepEqual(anims[0].frames[1].pixels[0], [0, 0, 0], 'transparent becomes black');
  writeAnims(anims, out);
  const set = loadAnimSet(out);
  assert.deepEqual(set.running.frames[2].pixels[2 + 16 * 2], [255, 128, 0]);
});
