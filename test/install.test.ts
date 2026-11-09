import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHooks, mergeHooks, removeHooks, installHooks, uninstallHooks, backupPath } from '../src/tools/install.js';

const SOCK = { mode: 'command' as const, socketPath: '/Users/ed/Library/Application Support/clawdbox/hook.sock' };
const HTTP = { mode: 'http' as const, url: 'http://127.0.0.1:7676/event' };

test('buildHooks covers every event and uses matcher only where supported', () => {
  const h = buildHooks(SOCK);
  assert.ok(h.PreToolUse && h.PostToolUse && h.Notification && h.Stop && h.SessionEnd && h.UserPromptSubmit && h.PermissionRequest);
  assert.equal((h.PreToolUse[0] as { matcher: string }).matcher, '*');
  assert.equal((h.Stop[0] as { matcher?: string }).matcher, undefined);
  const handler = (h.Stop[0] as { hooks: Record<string, unknown>[] }).hooks[0];
  assert.equal(handler.type, 'command');
  assert.equal(handler.async, true);
  assert.match(
    String(handler.command),
    /^\/usr\/bin\/curl .*--unix-socket '\/Users\/ed\/Library\/Application Support\/clawdbox\/hook.sock' .*--data-binary @- http:\/\/clawdbox\/event/,
  );
  const http = (buildHooks(HTTP).Stop[0] as { hooks: Record<string, unknown>[] }).hooks[0];
  assert.equal(http.type, 'http');
  assert.equal(http.url, HTTP.url);
});

test('socket paths that could escape the shell command are refused', () => {
  assert.throws(() => buildHooks({ mode: 'command', socketPath: "/tmp/x'; rm -rf ~; '" }), /not allowed/);
  assert.throws(() => buildHooks({ mode: 'command', socketPath: 'relative/path.sock' }), /not allowed/);
});

test('mergeHooks keeps unrelated hooks and replaces earlier clawdbox entries', () => {
  const existing = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    },
  };
  const once = mergeHooks(existing, buildHooks(SOCK));
  const twice = mergeHooks(once, buildHooks(HTTP));
  const stop = (twice.hooks as Record<string, unknown[]>).Stop;
  assert.equal(stop.length, 2, 'user hook + exactly one clawdbox hook');
  assert.deepEqual((stop[0] as { hooks: unknown[] }).hooks[0], { type: 'command', command: 'say done' });
  assert.equal((stop[1] as { hooks: Record<string, unknown>[] }).hooks[0].type, 'http');
  assert.deepEqual(twice.permissions, existing.permissions);
  const pre = (twice.hooks as Record<string, unknown[]>).PreToolUse;
  assert.equal(pre.length, 2);
  assert.equal((pre[0] as { matcher: string }).matcher, 'Bash');
});

test('removeHooks strips only ours, even if a user hook mentions our URL', () => {
  const merged = mergeHooks(
    { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl http://127.0.0.1:7676/event' }] }] } },
    buildHooks(SOCK),
  );
  const removed = removeHooks(merged) as { hooks: Record<string, unknown[]> };
  assert.deepEqual(Object.keys(removed.hooks), ['Stop']);
  assert.equal(removed.hooks.Stop.length, 1);
});

test('installHooks keeps the file mode, backs up once, and uninstall removes the backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdbox-settings-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify({ env: { SECRET: 'x' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say hi' }] }] } }));
  chmodSync(path, 0o600);
  installHooks(SOCK, path);
  assert.equal(statSync(path).mode & 0o777, 0o600, 'mode preserved');
  assert.ok(existsSync(backupPath(path)));
  assert.equal(statSync(backupPath(path)).mode & 0o777, 0o600, 'backup not world-readable');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.env.SECRET, 'x');
  assert.equal(after.hooks.Stop.length, 2);
  // second install does not re-snapshot the (now modified) file
  writeFileSync(backupPath(path), 'pristine');
  installHooks(SOCK, path);
  assert.equal(readFileSync(backupPath(path), 'utf8'), 'pristine');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).hooks.Stop.length, 2);
  uninstallHooks(path);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).hooks.Stop.length, 1);
  assert.ok(!existsSync(backupPath(path)));
});

test('installHooks refuses a settings file that is not valid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdbox-settings-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, '{ not json');
  assert.throws(() => installHooks(SOCK, path), /not valid JSON/);
});
