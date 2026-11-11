import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateChecker, compareVersions } from '../src/daemon/update-check.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'tag.gpgSign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

test('compareVersions orders numerically', () => {
  assert.ok(compareVersions('0.10.0', '0.9.1') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('reports the newest release version and that it is not installed yet', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdbox-upd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, 'origin');
  const checkout = join(dir, 'checkout');
  execFileSync('git', ['init', '-q', '-b', 'main', origin]);
  writeFileSync(join(origin, 'f'), '1');
  git(origin, 'add', 'f');
  git(origin, 'commit', '-qm', 'one');
  git(origin, 'tag', '-a', 'v0.9.0', '-m', '0.9.0');
  execFileSync('git', ['clone', '-q', origin, checkout]);
  writeFileSync(join(origin, 'f'), '2');
  git(origin, 'commit', '-qam', 'two');
  git(origin, 'tag', '-a', 'v0.10.0', '-m', '0.10.0');

  const checker = new UpdateChecker(checkout, '0.9.0');
  const info = await checker.check();
  assert.equal(info.error, null);
  assert.equal(info.version, '0.9.0');
  assert.equal(info.latestVersion, '0.10.0'); // numeric, not string, ordering
  assert.equal(info.latestCommit, git(origin, 'rev-parse', 'HEAD'));
  assert.equal(info.updateAvailable, true);

  git(checkout, 'fetch', '-q', '--tags');
  git(checkout, 'checkout', '-q', 'v0.10.0');
  const after = await new UpdateChecker(checkout, '0.10.0').check();
  assert.equal(after.updateAvailable, false);
  assert.equal(after.latestVersion, '0.10.0');
});
