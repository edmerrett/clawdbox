import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/verify-release.sh', import.meta.url).pathname;
const hasKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'clawdbox-sig-'));
  const repo = join(dir, 'repo');
  for (const name of ['trusted', 'stranger'])
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(dir, name)]);
  const pub = readFileSync(join(dir, 'trusted.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  const signers = join(dir, 'signers');
  writeFileSync(signers, `# trusted keys\n\nclawdbox-release namespaces="git" ${pub}\n`);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', ...args],
      { cwd: repo, encoding: 'utf8' },
    );
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'f'), '1');
  git('add', 'f');
  git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'one');
  const sign = (key: string, tag: string) => git('-c', `user.signingkey=${join(dir, key)}`, 'tag', '-s', tag, '-m', tag);
  const verify = (tag: string, file = signers) => spawnSync(script, [file, tag], { cwd: repo, encoding: 'utf8' });
  return { dir, git, sign, verify, signers };
}

test('verify-release accepts only annotated tags signed by a trusted key', { skip: !hasKeygen && 'no ssh-keygen' }, (t) => {
  const { dir, git, sign, verify } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  sign('trusted', 'v1.0.0');
  const good = verify('v1.0.0');
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /Good "git" signature for clawdbox-release/);

  sign('stranger', 'v1.0.1');
  const stranger = verify('v1.0.1');
  assert.equal(stranger.status, 5);
  assert.match(stranger.stderr, /refusing v1\.0\.1/);

  git('-c', 'tag.gpgSign=false', 'tag', '-a', 'v1.0.2', '-m', 'unsigned');
  assert.equal(verify('v1.0.2').status, 5);

  git('-c', 'tag.gpgSign=false', 'tag', 'v1.0.3'); // lightweight
  assert.match(verify('v1.0.3').stderr, /not an annotated, signed tag/);

  // a new tag name pointing at an old, validly signed tag object
  git('update-ref', 'refs/tags/v9.9.9', git('rev-parse', 'refs/tags/v1.0.0').trim());
  const replay = verify('v9.9.9');
  assert.equal(replay.status, 5);
  assert.match(replay.stderr, /named 'v1\.0\.0'/);

  assert.equal(verify('v4.0.0').status, 5); // no such tag
});

test('verify-release fails closed without trusted keys', { skip: !hasKeygen && 'no ssh-keygen' }, (t) => {
  const { dir, sign, verify } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sign('trusted', 'v1.0.0');
  const empty = join(dir, 'empty');
  writeFileSync(empty, '# nothing trusted\n\n');
  assert.match(verify('v1.0.0', empty).stderr, /no trusted release keys/);
  assert.match(verify('v1.0.0', join(dir, 'missing')).stderr, /no trusted release keys/);
});

test('the committed release-signers file verifies the signed release tags', { skip: !hasKeygen && 'no ssh-keygen' }, () => {
  const root = new URL('..', import.meta.url).pathname;
  const tags = spawnSync('git', ['tag', '-l', 'v0.4.1'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  if (!tags) return; // shallow CI checkout without tags
  const r = spawnSync(script, [join(root, 'scripts/release-signers'), 'v0.4.1'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
