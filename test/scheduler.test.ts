import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/daemon/scheduler.js';

import { STATES, State } from '../src/anim/types.js';

const loopMs = Object.fromEntries(STATES.map((s) => [s, 800])) as Record<State, number>;
Object.assign(loopMs, { thinking: 600, reading: 600, writing: 400, running: 400, 'needs-you': 500 });
const base = {
  minHoldMs: 2000,
  maxBoundaryWaitMs: 1500,
  loopMs,
  flashMs: 3500,
  idleStageAfterMs: 600_000,
  idleStageCycleMs: 600_000,
};
const mk = () => new Scheduler(base);

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

test("a busy target is kept until the daemon changes it; staleness is the reducer's call", () => {
  const s = mk();
  s.shown('running', 0);
  s.setTarget('running', 0);
  assert.equal(s.tick(50_000), null);
  assert.equal(s.tick(3_600_000), null);
  // the reducer expired the session and the daemon passes the new aggregate in
  s.setTarget('idle', 3_600_000);
  assert.equal(s.tick(3_600_000), 'idle');
});

test('target changes while waiting are honoured', () => {
  const s = mk();
  s.shown('idle', 0);
  s.setTarget('reading', 100);
  s.setTarget('writing', 1000);
  assert.equal(s.tick(2400), 'writing');
});

test('a flash shows immediately and the panel returns to the target afterwards', () => {
  const s = mk();
  s.shown('thinking', 0);
  s.setTarget('thinking', 0);
  s.flash('heart', 100);
  assert.equal(s.tick(150), 'heart');
  s.shown('heart', 150);
  assert.equal(s.tick(2000), null);
  assert.equal(s.tick(3700), 'thinking');
});

test('long idle cycles through coffee and vibing', () => {
  const s = mk();
  s.shown('idle', 0);
  s.setTarget('idle', 0);
  assert.equal(s.tick(300_000), null);
  assert.equal(s.tick(600_000 + 2500), 'coffee');
  s.shown('coffee', 600_000 + 2500);
  assert.equal(s.tick(1_200_000 + 2500), 'vibing');
  s.shown('vibing', 1_200_000 + 2500);
  assert.equal(s.tick(1_800_000 + 2500), 'coffee');
  // any event snaps back to the activity state
  s.setTarget('reading', 1_900_000);
  assert.equal(s.tick(1_900_000 + 2500), 'reading');
});

test('idle stages are disabled with idleStageAfterMs 0', () => {
  const s = new Scheduler({ ...base, idleStageAfterMs: 0 });
  s.shown('idle', 0);
  s.setTarget('idle', 0);
  assert.equal(s.tick(3_600_000), null);
});
