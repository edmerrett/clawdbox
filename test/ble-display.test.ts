import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BleDisplay } from '../src/daemon/ble-display.js';
import { clawdSprites } from '../src/anim/clawd.js';

const fake = new URL('./fake-bridge.mjs', import.meta.url).pathname;
const repoRoot = new URL('..', import.meta.url).pathname;

function make(env: Record<string, string> = {}) {
  const logs: string[] = [];
  const d = new BleDisplay({
    repoRoot,
    python: process.execPath,
    bridgeScript: fake,
    env,
    log: (m) => logs.push(m),
    requestTimeoutMs: 2000,
  });
  d.prepare(clawdSprites());
  return { d, logs };
}

test('shows are answered by id and connect-retry status is not mistaken for a reply', async (t) => {
  const { d, logs } = make();
  t.after(() => d.close());
  await d.show('writing');
  assert.equal(d.pushes, 1);
  assert.ok(d.connected);
  assert.ok(logs.some((l) => l.includes('bridge error: connect failed')));
  assert.ok(logs.some((l) => l.includes('showing writing')));
});

test('one failed show does not poison later shows', async (t) => {
  const { d } = make({ FAKE_FAIL_FIRST: '1' });
  t.after(() => d.close());
  await assert.rejects(d.show('idle'), /simulated/);
  await d.show('reading');
  await d.show('running');
  assert.equal(d.pushes, 2);
});

test('a show queued before the bridge connects waits for the connection', async (t) => {
  const { d, logs } = make({ FAKE_SLOW_CONNECT: '400' });
  t.after(() => d.close());
  await d.show('idle');
  const connectedAt = logs.findIndex((l) => l.includes('bridge connected'));
  const shownAt = logs.findIndex((l) => l.includes('showing idle'));
  assert.ok(connectedAt >= 0 && shownAt > connectedAt, 'connected must be logged before showing');
});
