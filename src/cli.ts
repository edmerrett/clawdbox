#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { DEFAULT_CONFIG, repoRoot, runDaemon } from './daemon/main.js';
import { clawdSprites } from './anim/clawd.js';
import { writeAnims, buildAnims } from './tools/build-anims.js';
import { installHooks, uninstallHooks, launchdPlist, launchdPlistPath, LAUNCHD_LABEL, settingsPath } from './tools/install.js';
import { isState, STATES } from './anim/types.js';
import { MockLink, RfcommLink } from './daemon/link.js';
import { Device } from './daemon/device.js';
import { loadAnimSet } from './anim/load.js';

const HELP = `clawdbox - Claude Code companion for the Divoom TimeBox Evo

Usage:
  clawdbox daemon [--mac XX:XX:XX:XX:XX:XX | --mock] [--anims DIR] [--port 7676] [--brightness 0-100]
                  [--hold-ms 2000] [--idle-ms 90000] [--channel N] [-v]
  clawdbox discover                 list paired Bluetooth devices (needs bluetooth-serial-port)
  clawdbox send <state> --mac MAC [--anims DIR]      push one animation and exit (smoke test)
  clawdbox sprites [--out art/anims]                 write the built-in Clawd sprites as JSON
  clawdbox build-anims <sheet.json | strips-dir> [--out art/anims] [--fps 6]
  clawdbox install-hooks [--url http://127.0.0.1:7676/event] [--http]   merge hooks into ~/.claude/settings.json
  clawdbox uninstall-hooks
  clawdbox install-launchd --mac MAC [--anims DIR] [--brightness N]     write + load ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist
  clawdbox uninstall-launchd
  clawdbox show <state> [--port 7676]                tell a running daemon to show a state (testing)

States: ${STATES.join(', ')}
`;

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mac: { type: 'string' },
    channel: { type: 'string' },
    mock: { type: 'boolean', default: false },
    anims: { type: 'string' },
    port: { type: 'string' },
    brightness: { type: 'string' },
    'hold-ms': { type: 'string' },
    'idle-ms': { type: 'string' },
    out: { type: 'string' },
    fps: { type: 'string' },
    url: { type: 'string' },
    http: { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const cmd = positionals[0];
const num = (s: string | undefined, d: number) => (s === undefined ? d : Number(s));
const port = num(v.port, DEFAULT_CONFIG.port);
const defaultAnims = () => {
  const d = join(repoRoot(), 'art', 'anims');
  return v.anims ?? (existsSync(join(d, 'idle.json')) ? d : undefined);
};

async function main() {
  if (v.help || !cmd) {
    console.log(HELP);
    return;
  }
  switch (cmd) {
    case 'daemon':
      await runDaemon({
        ...DEFAULT_CONFIG,
        mac: v.mac,
        channel: v.channel ? Number(v.channel) : undefined,
        mock: v.mock,
        port,
        animsDir: defaultAnims(),
        brightness: v.brightness ? Number(v.brightness) : undefined,
        minHoldMs: num(v['hold-ms'], DEFAULT_CONFIG.minHoldMs),
        idleAfterMs: num(v['idle-ms'], DEFAULT_CONFIG.idleAfterMs),
        verbose: v.verbose,
      });
      return;

    case 'sprites':
    case 'placeholders': {
      const out = resolve(v.out ?? join(repoRoot(), 'art', 'anims'));
      const files = writeAnims(Object.values(clawdSprites()), out);
      console.log(files.map((f) => `wrote ${f}`).join('\n'));
      return;
    }

    case 'build-anims': {
      const input = positionals[1];
      if (!input) throw new Error('build-anims needs a sheet.json or a directory of PNG strips');
      const out = resolve(v.out ?? join(repoRoot(), 'art', 'anims'));
      const files = buildAnims(input, out, num(v.fps, 6));
      console.log(files.map((f) => `wrote ${f}`).join('\n'));
      return;
    }

    case 'install-hooks': {
      const url = v.url ?? `http://127.0.0.1:${port}/event`;
      installHooks(url, v.http ? 'http' : 'command');
      console.log(`hooks installed in ${settingsPath()} (${v.http ? 'http' : 'async command'} mode, posting to ${url})`);
      console.log('Claude Code picks up settings changes automatically; if an open session stays quiet, restart it.');
      return;
    }
    case 'uninstall-hooks':
      uninstallHooks();
      console.log(`clawdbox hooks removed from ${settingsPath()}`);
      return;

    case 'install-launchd': {
      if (!v.mac) throw new Error('--mac is required');
      if (process.platform !== 'darwin') throw new Error('install-launchd is macOS only');
      const logDir = join(homedir(), 'Library', 'Logs', 'clawdbox');
      mkdirSync(logDir, { recursive: true });
      const cli = join(repoRoot(), 'dist', 'cli.js');
      if (!existsSync(cli)) throw new Error('run "npm run build" first so dist/cli.js exists');
      const args = ['--mac', v.mac];
      const anims = defaultAnims();
      if (anims) args.push('--anims', anims);
      if (v.brightness) args.push('--brightness', v.brightness);
      if (v.channel) args.push('--channel', v.channel);
      const plist = launchdPlist({ node: process.execPath, cli, args, logDir, cwd: repoRoot() });
      const path = launchdPlistPath();
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, plist);
      try {
        execSync(`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL} 2>/dev/null; launchctl bootstrap gui/$(id -u) "${path}"`, { stdio: 'inherit', shell: '/bin/bash' });
      } catch {
        console.warn('launchctl bootstrap failed; load it manually with: launchctl bootstrap gui/$(id -u) ' + path);
      }
      console.log(`launchd agent written to ${path}\nlogs: ${logDir}`);
      return;
    }
    case 'uninstall-launchd': {
      const path = launchdPlistPath();
      try {
        execSync(`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`, { stdio: 'inherit', shell: '/bin/bash' });
      } catch {
        /* not loaded */
      }
      if (existsSync(path)) execSync(`rm "${path}"`);
      console.log('launchd agent removed');
      return;
    }

    case 'discover': {
      const mod = await import('bluetooth-serial-port');
      const bt = new mod.BluetoothSerialPort();
      await new Promise<void>((done) =>
        bt.listPairedDevices((devices: { name: string; address: string }[]) => {
          for (const d of devices) console.log(`${d.address}  ${d.name}`);
          if (!devices.length) console.log('no paired devices; pair the Timebox in System Settings > Bluetooth first');
          done();
        }),
      );
      return;
    }

    case 'send': {
      const state = positionals[1];
      if (!state || !isState(state)) throw new Error(`send needs a state: ${STATES.join(', ')}`);
      const link = v.mock ? new MockLink(true) : new RfcommLink(requireMac(), v.channel ? Number(v.channel) : undefined);
      const device = new Device(link, { log: console.log, brightness: v.brightness ? Number(v.brightness) : undefined });
      const dir = defaultAnims();
      device.prepare(dir ? loadAnimSet(dir) : clawdSprites());
      await device.show(state);
      await new Promise((r) => setTimeout(r, 500));
      device.close();
      return;
    }

    case 'show': {
      const state = positionals[1];
      if (!state || !isState(state)) throw new Error(`show needs a state: ${STATES.join(', ')}`);
      const res = await fetch(`http://127.0.0.1:${port}/show/${state}`, { method: 'POST' });
      console.log(await res.text());
      return;
    }

    default:
      console.error(`unknown command ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

function requireMac(): string {
  if (!v.mac) throw new Error('--mac XX:XX:XX:XX:XX:XX is required');
  return v.mac;
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
