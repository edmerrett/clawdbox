import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildHooks, validateDaemonUrl } from '../src/tools/install.js';

const DAEMON = 'http://127.0.0.1:7676/event';

test('the checked-in hook examples match what install-hooks generates', () => {
  const cmd = JSON.parse(readFileSync(new URL('../hooks/claude-hooks.example.json', import.meta.url), 'utf8'));
  const http = JSON.parse(readFileSync(new URL('../hooks/claude-hooks.http.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(cmd, { hooks: buildHooks(DAEMON, 'command') });
  assert.deepEqual(http, { hooks: buildHooks(DAEMON, 'http') });
});

test('daemon URLs that could escape the shell command are refused', () => {
  assert.equal(validateDaemonUrl(DAEMON), DAEMON);
  assert.throws(() => validateDaemonUrl('http://127.0.0.1:7676/event; rm -rf ~'), /not allowed/);
  assert.throws(() => validateDaemonUrl("http://x/'"), /not allowed/);
  assert.throws(() => validateDaemonUrl('https://example.com/x'), /http:/);
  assert.throws(() => validateDaemonUrl('not a url'), /valid URL/);
});
