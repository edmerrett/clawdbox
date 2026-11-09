import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHooks, mergeHooks, removeHooks } from '../src/tools/install.js';

const URL = 'http://127.0.0.1:7676/event';

test('buildHooks covers every event and uses matcher only where supported', () => {
  const h = buildHooks(URL, 'command');
  assert.ok(h.PreToolUse && h.PostToolUse && h.Notification && h.Stop && h.SessionEnd && h.UserPromptSubmit && h.PermissionRequest);
  assert.equal((h.PreToolUse[0] as { matcher: string }).matcher, '*');
  assert.equal((h.Stop[0] as { matcher?: string }).matcher, undefined);
  const handler = (h.Stop[0] as { hooks: Record<string, unknown>[] }).hooks[0];
  assert.equal(handler.type, 'command');
  assert.equal(handler.async, true);
  assert.match(String(handler.command), /curl .*--data-binary @- http:\/\/127\.0\.0\.1:7676\/event/);
  const http = (buildHooks(URL, 'http').Stop[0] as { hooks: Record<string, unknown>[] }).hooks[0];
  assert.equal(http.type, 'http');
  assert.equal(http.url, URL);
});

test('mergeHooks keeps unrelated hooks and replaces earlier clawdbox entries', () => {
  const existing = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    },
  };
  const once = mergeHooks(existing, buildHooks(URL, 'command'));
  const twice = mergeHooks(once, buildHooks(URL, 'http'));
  const stop = (twice.hooks as Record<string, unknown[]>).Stop;
  assert.equal(stop.length, 2, 'user hook + exactly one clawdbox hook');
  assert.deepEqual((stop[0] as { hooks: unknown[] }).hooks[0], { type: 'command', command: 'say done' });
  assert.equal((stop[1] as { hooks: Record<string, unknown>[] }).hooks[0].type, 'http');
  assert.deepEqual(twice.permissions, existing.permissions);
  const pre = (twice.hooks as Record<string, unknown[]>).PreToolUse;
  assert.equal(pre.length, 2);
  assert.equal((pre[0] as { matcher: string }).matcher, 'Bash');
});

test('removeHooks strips only ours', () => {
  const merged = mergeHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }, buildHooks(URL, 'command'));
  const removed = removeHooks(merged) as { hooks: Record<string, unknown[]> };
  assert.deepEqual(Object.keys(removed.hooks), ['Stop']);
  assert.equal(removed.hooks.Stop.length, 1);
});
