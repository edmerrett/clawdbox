import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appBundleFiles, launchdPlist } from '../src/tools/install.js';

test('app bundle declares Bluetooth usage and execs the daemon with quoted args', () => {
  const files = appBundleFiles({
    node: '/usr/local/bin/node',
    cli: '/Users/ed/My Tools/clawdbox/dist/cli.js',
    args: ['--ble', '--python', '/Users/ed/My Tools/clawdbox/.venv/bin/python'],
    cwd: '/Users/ed/My Tools/clawdbox',
  });
  assert.match(files['Contents/Info.plist'], /NSBluetoothAlwaysUsageDescription/);
  assert.match(files['Contents/Info.plist'], /<key>CFBundleExecutable<\/key><string>clawdbox<\/string>/);
  const script = files['Contents/MacOS/clawdbox'];
  assert.match(script, /^#!\/bin\/bash/);
  assert.match(script, /cd '\/Users\/ed\/My Tools\/clawdbox'/);
  assert.match(
    script,
    /exec '\/usr\/local\/bin\/node' '\/Users\/ed\/My Tools\/clawdbox\/dist\/cli.js' daemon '--ble' '--python' '\/Users\/ed\/My Tools\/clawdbox\/.venv\/bin\/python'/,
  );
});

test('launchd plist runs the launcher, keeps it alive and logs', () => {
  const plist = launchdPlist({
    launcher: '/Users/ed/Applications/Clawdbox.app/Contents/MacOS/clawdbox',
    logDir: '/Users/ed/Library/Logs/clawdbox',
    cwd: '/x',
  });
  assert.match(plist, /<string>\/Users\/ed\/Applications\/Clawdbox.app\/Contents\/MacOS\/clawdbox<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /clawdbox\.log/);
});

test('updater plist runs the update script on an interval and logs', async () => {
  const { updaterPlist } = await import('../src/tools/install.js');
  const plist = updaterPlist({
    script: '/Users/ed/clawdbox/scripts/update.sh',
    logDir: '/Users/ed/Library/Logs/clawdbox',
    cwd: '/Users/ed/clawdbox',
    intervalSec: 21600,
  });
  assert.match(plist, /<string>\/bin\/bash<\/string>\s*<string>\/Users\/ed\/clawdbox\/scripts\/update.sh<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>21600<\/integer>/);
  assert.match(plist, /update\.log/);
});

test('both agents name the Clawdbox app so macOS stops re-announcing them as background activity', async () => {
  const { updaterPlist, agentBundleIds } = await import('../src/tools/install.js');
  const ids = /<key>AssociatedBundleIdentifiers<\/key>\s*<array>\s*<string>com\.clawdbox\.app<\/string>\s*<\/array>/;
  assert.match(launchdPlist({ launcher: '/a', logDir: '/l', cwd: '/x', bundleIds: agentBundleIds(true) }), ids);
  assert.match(updaterPlist({ script: '/s', logDir: '/l', cwd: '/x', intervalSec: 60, bundleIds: agentBundleIds(true) }), ids);
  assert.deepEqual(agentBundleIds(false), ['com.clawdbox.app', 'com.clawdbox.daemon']);
});
