import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/daemon/scheduler.js';

const loopMs = { idle: 800, thinking: 600, reading: 600, writing: 400, running: 400, 'needs-you': 500 };
const mk = () => new Scheduler({ minHoldMs: 2000, idleAfterMs: 90_000, maxBoundaryWaitMs: 1500, loopMs });

test('holds a state for minHoldMs before switching', () => {
  const s = mk();
  s.shown('idle', 0);
  s.setTarget('reading', 100);
  assert.equal(s.tick(500), null);
  assert.equal(s.tick(1900), null);
  // at 2400 we are 2400 into idle's 800 ms loop = boundary -> switch
  assert.equal(s.tick(2400), 'reading');
});

test('waits for a loop boundary but never longer than maxBoundaryWaitMs', () => {
  const s = mk();
  s.shown('idle', 0);
  s.setTarget('writing', 0);
  // 2300: 2300 % 800 = 700 -> 100 until boundary -> near boundary -> switch
  assert.equal(s.tick(2300), 'writing');
  const s2 = mk();
  s2.shown('idle', 0);
  s2.setTarget('writing', 0);
  // 2400 is an exact boundary
  assert.equal(s2.tick(2400), 'writing');
  const s3 = mk();
  s3.shown('idle', 0);
  s3.setTarget('writing', 0);
  // 2200: 2200 % 800 = 600, 200 to go, not near; waited 200 past hold -> wait
  assert.equal(s3.tick(2200), null);
  // 3600: 3600 % 800 = 400, not near, but waited 1600 past hold -> forced
  assert.equal(s3.tick(3600), 'writing');
});

test('needs-you bypasses the hold', () => {
  const s = mk();
  s.shown('reading', 0);
  s.setTarget('needs-you', 50);
  assert.equal(s.tick(60), 'needs-you');
});

test('falls back to idle when events stop (Esc interrupt)', () => {
  const s = mk();
  s.shown('running', 0);
  s.setTarget('running', 0);
  assert.equal(s.tick(50_000), null);
  assert.equal(s.tick(90_001 + 2000), 'idle');
});

test('target changes while waiting are honoured', () => {
  const s = mk();
  s.shown('idle', 0);
  s.setTarget('reading', 100);
  s.setTarget('writing', 1000);
  assert.equal(s.tick(2400), 'writing');
});
