import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SerialLink, pickSppChannel, sameAddress } from '../src/daemon/link.js';

test('sameAddress ignores case and separators', () => {
  assert.ok(sameAddress('11-75-58-9b-dd-6a', '11:75:58:9B:DD:6A'));
  assert.ok(!sameAddress('11-75-58-9b-dd-6a', '11:75:58:9B:DD:6B'));
});

test('pickSppChannel prefers the service named SPP/serial over hands-free', () => {
  assert.equal(
    pickSppChannel([
      { name: 'Hands-Free unit', channel: 1 },
      { name: 'JL_SPP', channel: 2 },
    ]),
    2,
  );
  assert.equal(pickSppChannel([{ name: 'Serial Port', channel: 3 }]), 3);
  assert.equal(
    pickSppChannel([
      { name: 'Hands-Free unit', channel: 1 },
      { name: 'Advanced Audio', channel: 0 },
    ]),
    undefined,
  );
  assert.equal(pickSppChannel([]), undefined);
});

test('SerialLink reports a device that keeps returning end-of-file as closed', async (t) => {
  // a regular empty file reads like a serial device that has hung up: 0 bytes, forever
  const dir = mkdtempSync(join(tmpdir(), 'clawdbox-serial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cu.fake');
  writeFileSync(path, '');
  const link = new SerialLink(path);
  const closed = new Promise<Error | undefined>((resolve) => link.once('closed', resolve));
  await link.connect();
  assert.ok(link.open);
  const err = await closed;
  assert.equal(link.open, false);
  assert.match(err?.message ?? '', /hung up/);
});
