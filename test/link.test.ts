import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSppChannel, sameAddress } from '../src/daemon/link.js';

test('sameAddress ignores case and separators', () => {
  assert.ok(sameAddress('11-75-58-9b-dd-6a', '11:75:58:9B:DD:6A'));
  assert.ok(!sameAddress('11-75-58-9b-dd-6a', '11:75:58:9B:DD:6B'));
});

test('pickSppChannel prefers the service named SPP/serial over hands-free', () => {
  assert.equal(pickSppChannel([{ name: 'Hands-Free unit', channel: 1 }, { name: 'JL_SPP', channel: 2 }]), 2);
  assert.equal(pickSppChannel([{ name: 'Serial Port', channel: 3 }]), 3);
  assert.equal(pickSppChannel([{ name: 'Hands-Free unit', channel: 1 }, { name: 'Advanced Audio', channel: 0 }]), undefined);
  assert.equal(pickSppChannel([]), undefined);
});
