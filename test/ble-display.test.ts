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

test('a panel that drops while idle is reported disconnected, then re-shown when it is back', async (t) => {
  const { d, logs } = make({ FAKE_DROP_AFTER: '150', FAKE_BACK_AFTER: '300' });
  t.after(() => d.close());
  let reshown = 0;
  d.onReconnect = () => reshown++;
  await d.ensureConnected();
  assert.ok(d.connected);
  await waitUntil(() => !d.connected);
  assert.match(d.lastError ?? '', /panel off/);
  assert.ok(logs.some((l) => l.includes('bridge lost the panel')));
  await waitUntil(() => d.connected);
  assert.equal(reshown, 1);
  assert.equal(d.lastError, null);
});

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}
