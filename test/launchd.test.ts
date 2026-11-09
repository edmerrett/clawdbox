import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appBundleFiles, launchdPlist } from '../src/tools/install.js';

test('app bundle declares Bluetooth usage and execs the daemon with quoted args', () => {
  const files = appBundleFiles({ node: '/usr/local/bin/node', cli: "/Users/ed/My Tools/clawdbox/dist/cli.js", args: ['--ble', '--python', '/Users/ed/My Tools/clawdbox/.venv/bin/python'], cwd: '/Users/ed/My Tools/clawdbox' });
  assert.match(files['Contents/Info.plist'], /NSBluetoothAlwaysUsageDescription/);
  assert.match(files['Contents/Info.plist'], /<key>CFBundleExecutable<\/key><string>clawdbox<\/string>/);
  const script = files['Contents/MacOS/clawdbox'];
  assert.match(script, /^#!\/bin\/bash/);
  assert.match(script, /cd '\/Users\/ed\/My Tools\/clawdbox'/);
  assert.match(script, /exec '\/usr\/local\/bin\/node' '\/Users\/ed\/My Tools\/clawdbox\/dist\/cli.js' daemon '--ble' '--python' '\/Users\/ed\/My Tools\/clawdbox\/.venv\/bin\/python'/);
});

test('launchd plist runs the launcher, keeps it alive and logs', () => {
  const plist = launchdPlist({ launcher: '/Users/ed/Applications/Clawdbox.app/Contents/MacOS/clawdbox', logDir: '/Users/ed/Library/Logs/clawdbox', cwd: '/x' });
  assert.match(plist, /<string>\/Users\/ed\/Applications\/Clawdbox.app\/Contents\/MacOS\/clawdbox<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /clawdbox\.log/);
});
