import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clawdSprites } from '../src/anim/clawd.js';
import { THEMES, activeTheme, christmasIdle, withTheme } from '../src/anim/themes.js';
import { PIXELS, STATES, fromAnimFile, loopMs, toAnimFile } from '../src/anim/types.js';
import { animationBytes } from '../src/protocol/divoom.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/daemon/settings.js';
import { Scheduler } from '../src/daemon/scheduler.js';

const eq = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

test('the Christmas idle follows the LED rules: 16x16, animates, no strobing, a sane loop, streams quickly', () => {
  const a = christmasIdle();
  assert.equal(a.name, 'idle');
  assert.ok(a.frames.length >= 2);
  for (const f of a.frames) {
    assert.equal(f.pixels.length, PIXELS);
    assert.ok(f.ms >= 150, `a ${f.ms}ms frame strobes on LEDs`);
  }
  const loop = loopMs(a);
  assert.ok(loop >= 400 && loop <= 3000, `loop ${loop}ms`);
  assert.ok(animationBytes(a) < 5000, `${animationBytes(a)} bytes`);
  assert.deepEqual(fromAnimFile(toAnimFile(a)).frames[3].pixels, a.frames[3].pixels, 'survives the JSON round-trip');
});

test('the Christmas idle has a tree, a star, Clawd in a Santa hat, and twinkles', () => {
  const [f0, f2] = [christmasIdle().frames[0], christmasIdle().frames[2]];
  const at = (f: typeof f0, x: number, y: number) => f.pixels[x + 16 * y];
  const count = (f: typeof f0, c: readonly number[]) => f.pixels.filter((p) => eq(p, c)).length;
  assert.ok(count(f0, [0x10, 0x90, 0x30]) >= 20, 'a pine tree');
  assert.deepEqual(at(f0, 12, 0), [0xff, 0xd0, 0x10], 'a star on top');
  assert.ok(count(f0, [0xd9, 0x6f, 0x4f]) >= 40, 'Clawd is there, in his usual orange');
  assert.ok(count(f0, [0xe0, 0x20, 0x20]) >= 10, 'a red Santa hat');
  assert.ok(
    f0.pixels.slice(0, 16 * 7).some((p, i) => i % 16 < 10 && eq(p, [0xc8, 0xd8, 0xf0])),
    'snow in the sky',
  );
  assert.notDeepEqual(at(f0, 11, 4), at(f2, 11, 4), 'the fairy lights change colour');
  // feet on the same row as every standard pose, so switching to and from it never jumps
  const feet = (f: typeof f0) => Math.max(...f.pixels.flatMap((p, i) => (eq(p, [0xd9, 0x6f, 0x4f]) ? [Math.floor(i / 16)] : [])));
  assert.equal(feet(f0), feet(clawdSprites().idle.frames[0]));
});

test('withTheme overrides only what the theme draws and leaves the base set alone', () => {
  const base = clawdSprites();
  const themed = withTheme(base, THEMES.christmas);
  assert.notEqual(themed, base);
  assert.notDeepEqual(themed.idle, base.idle);
  assert.equal(themed.idle.name, 'idle');
  for (const s of STATES) if (s !== 'idle') assert.equal(themed[s], base[s], `${s} is untouched`);
  assert.equal(withTheme(base, null), base, 'themes off is the base set itself');
  assert.equal(clawdSprites().idle.frames.length, base.idle.frames.length);
});

test('every theme is valid and the active theme is a registered one', () => {
  assert.ok(Object.values(THEMES).includes(activeTheme()));
  assert.equal(activeTheme(new Date('2026-07-01')).name, 'christmas');
  for (const t of Object.values(THEMES)) {
    assert.ok(t.label.length > 0);
    for (const [s, a] of Object.entries(t.sprites())) {
      assert.ok((STATES as readonly string[]).includes(s), `${t.name} draws unknown state ${s}`);
      assert.ok(a!.frames.every((f) => f.pixels.length === PIXELS && f.ms >= 150));
    }
  }
});

test('settings: default off, saved privately, read back; junk falls back to the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdbox-settings-'));
  const path = join(dir, 'nested', 'settings.json');
  assert.deepEqual(loadSettings(path), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.themes, false);
  saveSettings(path, { themes: true });
  assert.deepEqual(loadSettings(path), { themes: true });
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, '{not json');
  assert.deepEqual(loadSettings(path), DEFAULT_SETTINGS);
  writeFileSync(path, '{"themes":"yes"}');
  assert.deepEqual(loadSettings(path), DEFAULT_SETTINGS);
  writeFileSync(path, '[true]');
  assert.deepEqual(loadSettings(path), DEFAULT_SETTINGS);
});

test('the scheduler finds loop boundaries in a swapped set without touching its options', () => {
  const loops = Object.fromEntries(STATES.map((s) => [s, 800])) as Record<(typeof STATES)[number], number>;
  const opts = { minHoldMs: 2000, maxBoundaryWaitMs: 1500, loopMs: loops, flashMs: 3500, idleStageAfterMs: 0, idleStageCycleMs: 1 };
  const s = new Scheduler(opts);
  s.shown('idle', 0);
  s.setTarget('reading', 0);
  s.setLoopMs({ ...loops, idle: loopMs(christmasIdle()) }); // 2000 ms
  assert.equal(s.tick(2400), null, '2400 ms is a boundary of the old 800 ms loop, not the new one');
  assert.equal(s.tick(4000), 'reading', 'the new loop ends at 4000 ms');
  assert.equal(opts.loopMs, loops);
  assert.equal(loops.idle, 800);
});
