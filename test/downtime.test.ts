import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downtimeTracker } from '../src/daemon/downtime.js';

test('downtime counts from start-up, resets on connect, and restarts on a drop', () => {
  let t = 1_000_000;
  const down = downtimeTracker(() => t);
  t += 5_000;
  assert.equal(down(false), 5); // never connected yet: counts from start-up
  assert.equal(down(true), null);
  t += 60_000;
  assert.equal(down(false), 0); // dropped: counts from the first look at the drop
  t += 12_500;
  assert.equal(down(false), 12);
});
