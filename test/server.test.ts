import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { startServer, parseHookEvent } from '../src/daemon/server.js';
import { clawdSprites } from '../src/anim/clawd.js';
import { HookEvent } from '../src/daemon/reducer.js';
import { State } from '../src/anim/types.js';

const events: HookEvent[] = [];
const forced: State[] = [];
const server = startServer(
  0,
  '127.0.0.1',
  {
    onEvent: (ev) => events.push(ev),
    onForce: (s) => forced.push(s),
    status: () => ({ current: 'idle' }),
    anims: () => clawdSprites(),
    previewHtmlPath: new URL('../web/index.html', import.meta.url).pathname,
  },
  () => {},
);
await new Promise((r) => server.once('listening', r));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
after(() => server.close());

const post = (path: string, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  fetch(base + path, { method: 'POST', body, headers });

test('parseHookEvent accepts objects and rejects everything else', () => {
  assert.deepEqual(parseHookEvent('{"hook_event_name":"Stop"}'), { hook_event_name: 'Stop' });
  assert.deepEqual(parseHookEvent(''), {});
  assert.equal(parseHookEvent('null'), null);
  assert.equal(parseHookEvent('[]'), null);
  assert.equal(parseHookEvent('"str"'), null);
  assert.equal(parseHookEvent('{"session_id": 42}'), null);
  assert.equal(parseHookEvent('{bad'), null);
});

test('POST /event accepts a hook body and answers 204 with no body', async () => {
  const res = await post('/event', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', session_id: 's' }));
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(events.at(-1)?.tool_name, 'Read');
});

test('POST /event rejects non-JSON content types, malformed bodies and oversize bodies', async () => {
  assert.equal((await post('/event', '{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('/event', 'null')).status, 400);
  assert.equal((await post('/event', '{"a":')).status, 400);
  assert.equal((await post('/event', 'x'.repeat(1_100_000))).status, 413);
});

test('cross-origin POSTs are refused', async () => {
  const res = await post('/show/idle', '', { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  const ok = await post('/show/writing', '', { origin: `http://127.0.0.1:${port}` });
  assert.equal(ok.status, 200);
  assert.equal(forced.at(-1), 'writing');
});

test('/show validates the state; /state, /anims and / serve', async () => {
  assert.equal((await post('/show/nope', '')).status, 400);
  assert.deepEqual(await (await fetch(base + '/state')).json(), { current: 'idle' });
  const anims = (await (await fetch(base + '/anims')).json()) as Record<string, { frames: unknown[] }>;
  assert.ok(anims.idle.frames.length > 1);
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.equal((await fetch(base + '/nothing')).status, 404);
});
