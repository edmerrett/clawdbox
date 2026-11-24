import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// scripts/update.sh finds menu bar apps started before it rebuilt Clawdbox.app by their age (ps etime).
const script = readFileSync(new URL('../scripts/update.sh', import.meta.url), 'utf8');
const fn = /^etime_seconds\(\) \{[\s\S]*?^\}$/m.exec(script)?.[0];

const etime = (t: string) => execFileSync('/bin/bash', ['-c', `${fn}\netime_seconds "$1"`, 'test', t], { encoding: 'utf8' }).trim();

test('update.sh reads every ps etime format as seconds', () => {
  assert.ok(fn, 'etime_seconds is defined in update.sh');
  assert.equal(etime('   00:05'), '5');
  assert.equal(etime('09:08'), '548', 'leading zeros are not octal');
  assert.equal(etime('1:02:03'), '3723');
  assert.equal(etime('2-03:04:05'), '183845');
  assert.throws(() => etime(''), 'a process that is gone has no age');
});
