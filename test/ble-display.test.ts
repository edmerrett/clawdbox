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

test('shows are answered by id and connect-retry status is not mistaken for a reply', async () => {
  const { d, logs } = make();
  await d.show('writing');
  assert.equal(d.pushes, 1);
  assert.ok(d.connected);
  assert.ok(logs.some((l) => l.includes('bridge error: connect failed')));
  assert.ok(logs.some((l) => l.includes('showing writing')));
  d.close();
});

test('one failed show does not poison later shows', async () => {
  const { d } = make({ FAKE_FAIL_FIRST: '1' });
  await assert.rejects(d.show('idle'), /simulated/);
  await d.show('reading');
  await d.show('running');
  assert.equal(d.pushes, 2);
  d.close();
});

test('a show queued before the bridge connects waits for it', async () => {
  const { d } = make({ FAKE_SLOW_CONNECT: '400' });
  const t0 = Date.now();
  await d.show('idle');
  assert.ok(Date.now() - t0 >= 350);
  d.close();
});
