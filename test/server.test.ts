import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startServers, parseHookEvent, hostAllowed } from '../src/daemon/server.js';
import { clawdSprites } from '../src/anim/clawd.js';
import { HookEvent } from '../src/daemon/reducer.js';
import { State } from '../src/anim/types.js';

const events: HookEvent[] = [];
const forced: State[] = [];
const socketPath = join(mkdtempSync(join(tmpdir(), 'clawdbox-sock-')), 'hook.sock');
const servers = await startServers(
  { port: 0, host: '127.0.0.1', socketPath, tcpEvents: false, log: () => {} },
  {
    onEvent: (ev) => events.push(ev),
    onForce: (s) => forced.push(s),
    status: () => ({ current: 'idle' }),
    anims: () => clawdSprites(),
    previewHtmlPath: new URL('../web/index.html', import.meta.url).pathname,
  },
);
const port = (servers.tcp.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
after(() => servers.close());

const post = (path: string, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  fetch(base + path, { method: 'POST', body, headers });

/** POST over the Unix socket, the way the installed hook's curl does. */
function postSocket(body: string, headers: Record<string, string> = { 'content-type': 'application/json' }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path: '/event', method: 'POST', headers: { host: 'clawdbox', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('parseHookEvent accepts objects and rejects everything else', () => {
  assert.deepEqual(parseHookEvent('{"hook_event_name":"Stop"}'), { hook_event_name: 'Stop' });
  assert.deepEqual(parseHookEvent(''), {});
  assert.equal(parseHookEvent('null'), null);
  assert.equal(parseHookEvent('[]'), null);
  assert.equal(parseHookEvent('"str"'), null);
  assert.equal(parseHookEvent('{"session_id": 42}'), null);
  assert.equal(parseHookEvent('{bad'), null);
});

test('hostAllowed accepts loopback names on our port and nothing else', () => {
  assert.ok(hostAllowed('127.0.0.1:7676', 7676, false));
  assert.ok(hostAllowed('localhost:7676', 7676, false));
  assert.ok(hostAllowed('[::1]:7676', 7676, false));
  assert.ok(!hostAllowed('127.0.0.1:7677', 7676, false));
  assert.ok(!hostAllowed('attacker.example:7676', 7676, false));
  assert.ok(!hostAllowed(undefined, 7676, false));
  assert.ok(hostAllowed('anything', 7676, true), 'the socket is already private');
});

test('hook events arrive over the Unix socket and answer 204', async () => {
  assert.equal(await postSocket(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', session_id: 's' })), 204);
  assert.equal(events.at(-1)?.tool_name, 'Read');
  assert.equal(await postSocket('null'), 400);
  assert.equal(await postSocket('{}', { 'content-type': 'text/plain' }), 415);
});

test('the TCP port does not accept hook events unless tcpEvents is on', async () => {
  const res = await post('/event', JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }));
  assert.equal(res.status, 404);
});

test('requests with a foreign Host are refused (DNS rebinding)', async () => {
  // fetch() will not override Host, so use the raw client like a rebinding page's browser would
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/state', headers: { host: 'attacker.example:' + port } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 421);
});

test('cross-origin POSTs are refused', async () => {
  const res = await post('/show/idle', '', { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  const ok = await post('/show/writing', '', { origin: `http://127.0.0.1:${port}` });
  assert.equal(ok.status, 200);
  assert.equal(forced.at(-1), 'writing');
});

test('/show validates the state; /state, /anims and / serve with security headers', async () => {
  assert.equal((await post('/show/nope', '')).status, 400);
  assert.deepEqual(await (await fetch(base + '/state')).json(), { current: 'idle' });
  const anims = (await (await fetch(base + '/anims')).json()) as Record<string, { frames: unknown[] }>;
  assert.ok(anims.idle.frames.length > 1);
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(base + '/nothing')).status, 404);
});

test('oversize bodies get 413 when TCP events are enabled', async () => {
  const s2 = await startServers(
    { port: 0, host: '127.0.0.1', tcpEvents: true, log: () => {} },
    { onEvent: () => {}, onForce: () => {}, status: () => ({}), anims: () => clawdSprites(), previewHtmlPath: '/dev/null' },
  );
  const p2 = (s2.tcp.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${p2}/event`, {
    method: 'POST',
    body: 'x'.repeat(1_100_000),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 413);
  s2.close();
});
