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
import { BtPairedDevice, Link, MockLink, RfcommLink, SerialLink, pickSppChannel } from './daemon/link.js';
import { readdirSync } from 'node:fs';
import { encodeBrightness, encodeGetSettings, encodeImage } from './protocol/divoom.js';
import { Rgb, PIXELS } from './anim/types.js';
import { Device } from './daemon/device.js';
import { BleDisplay, resolvePython } from './daemon/ble-display.js';
import { Display } from './daemon/display.js';
import { loadAnimSet } from './anim/load.js';

const HELP = `clawdbox - Claude Code companion for the Divoom TimeBox Evo

Usage:
  clawdbox daemon (--ble [--address UUID] [--upload | --slots] | --mac XX:XX:XX:XX:XX:XX | --serial /dev/cu.NAME | --mock)
                  [--anims DIR] [--port 7676] [--brightness 0-100] [--hold-ms 2000] [--idle-ms 90000] [-v]
      --ble      newer TimeBox-Evo-audio / Backpack M (BLE, via bridge/clawdbox_ble.py + divoom-protocol)
                 default streams stills at the frame rate. --upload: send the loop per change (shows a transfer screen).
                 --slots: experimental, preload all loops and switch by slot
                 (--select HEX: bytes before the slot number, default 4505; 4504 selects Divoom's Signal presets)
      --mac      original Timebox Evo (Bluetooth Classic serial)
  clawdbox discover                 list paired Bluetooth Classic devices (needs bluetooth-serial-port)
  clawdbox ble-scan                 list Divoom BLE devices (needs the Python bridge deps)
  clawdbox send <state> (--ble | --mac MAC | --serial DEV)   push one animation and exit (smoke test)
  clawdbox diag (--mac MAC | --serial DEV)           step through brightness, still image, animation; log replies
  clawdbox scan --mac MAC [LAST]                     try RFCOMM channels 1..LAST (default 30) and report which one answers
  clawdbox sprites [--out art/anims]                 write the built-in Clawd sprites as JSON
  clawdbox build-anims <sheet.json | strips-dir> [--out art/anims] [--fps 6]
  clawdbox install-hooks [--url http://127.0.0.1:7676/event] [--http]   merge hooks into ~/.claude/settings.json
  clawdbox uninstall-hooks
  clawdbox install-launchd (--ble | --mac MAC) [--anims DIR] [--brightness N]   write + load ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist
  clawdbox uninstall-launchd
  clawdbox show <state> [--port 7676]                tell a running daemon to show a state (testing)

States: ${STATES.join(', ')}
`;

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mac: { type: 'string' },
    serial: { type: 'string' },
    ble: { type: 'boolean', default: false },
    address: { type: 'string' },
    stream: { type: 'boolean', default: false },
    upload: { type: 'boolean', default: false },
    slots: { type: 'boolean', default: false },
    select: { type: 'string' },
    python: { type: 'string' },
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
        serial: v.serial,
        ble: v.ble,
        bleAddress: v.address,
        bleMode: bleMode(),
        bleSelect: v.select,
        python: v.python,
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
      if (!v.mac && !v.ble && !v.serial) throw new Error('--ble, --mac or --serial is required');
      if (process.platform !== 'darwin') throw new Error('install-launchd is macOS only');
      const logDir = join(homedir(), 'Library', 'Logs', 'clawdbox');
      mkdirSync(logDir, { recursive: true });
      const cli = join(repoRoot(), 'dist', 'cli.js');
      if (!existsSync(cli)) throw new Error('run "npm run build" first so dist/cli.js exists');
      const args: string[] = [];
      if (v.ble) {
        args.push('--ble');
        if (v.address) args.push('--address', v.address);
        if (v.upload) args.push('--upload');
        if (v.slots) args.push('--slots');
        if (v.select) args.push('--select', v.select);
        args.push('--python', resolvePython(repoRoot(), v.python));
      } else if (v.serial) args.push('--serial', v.serial);
      else args.push('--mac', v.mac!);
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
      if (process.platform === 'darwin') {
        const ports = readdirSync('/dev').filter((f) => f.startsWith('cu.') && /timebox|evo|divoom|tivoo|ditoo|pixoo/i.test(f));
        if (ports.length) {
          console.log('serial devices created by macOS for paired Bluetooth devices:');
          for (const p of ports) console.log(`    --serial /dev/${p}`);
          console.log('If one of these is the Timebox, prefer it over --mac (see README).\n');
        }
      }
      const mod = await import('bluetooth-serial-port');
      const bt = new mod.BluetoothSerialPort();
      await new Promise<void>((done) =>
        bt.listPairedDevices((devices: BtPairedDevice[]) => {
          for (const d of devices) {
            const svc = (d.services ?? []).filter((s) => s.channel > 0);
            const spp = pickSppChannel(svc);
            console.log(`${d.address}  ${d.name}`);
            for (const s of svc) console.log(`    channel ${s.channel}  ${s.name ?? '(unnamed)'}${s.channel === spp ? '   <- serial port, will be used' : ''}`);
            if (svc.length && !spp) console.log('    (no service named SPP/serial; pass --channel to pick one)');
          }
          if (!devices.length) console.log('no paired devices; pair the Timebox in System Settings > Bluetooth first');
          done();
        }),
      );
      return;
    }

    case 'send': {
      const state = positionals[1];
      if (!state || !isState(state)) throw new Error(`send needs a state: ${STATES.join(', ')}`);
      const device = makeDisplay(console.log);
      const dir = defaultAnims();
      device.prepare(dir ? loadAnimSet(dir) : clawdSprites());
      await device.show(state);
      // give the box a moment to finish parsing before we hang up
      await new Promise((r) => setTimeout(r, v.ble ? 3000 : 800));
      device.close();
      console.log('done');
      return;
    }

    case 'ble-scan': {
      const python = resolvePython(repoRoot(), v.python);
      const { spawn } = await import('node:child_process');
      await new Promise<void>((done) => {
        const p = spawn(python, [join(repoRoot(), 'bridge', 'clawdbox_ble.py'), '--scan'], { stdio: ['ignore', 'pipe', 'inherit'] });
        p.stdout.on('data', (d: Buffer) => process.stdout.write(d));
        p.on('exit', () => done());
      });
      return;
    }

    case 'scan': {
      // Try every RFCOMM channel; the one that answers the settings query is the serial port.
      const mac = requireMac();
      const from = v.channel ? Number(v.channel) : 1;
      const to = Number(positionals[1] ?? 30);
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const results: { channel: number; connected: boolean; reply?: string; error?: string }[] = [];
      for (let ch = from; ch <= to; ch++) {
        const link = new RfcommLink(mac, ch, 6000);
        let reply: Buffer | undefined;
        link.on('data', (b: Buffer) => {
          if (b.length) reply = reply ? Buffer.concat([reply, b]) : b;
        });
        process.stdout.write(`channel ${String(ch).padStart(2)}: `);
        try {
          await link.connect();
          await pause(400);
          await link.write(encodeGetSettings());
          await pause(1500);
          const hex = reply?.toString('hex');
          results.push({ channel: ch, connected: true, reply: hex });
          console.log(hex ? `CONNECTED, replied ${hex}   <-- this is the one` : 'connected, no reply');
        } catch (e) {
          results.push({ channel: ch, connected: false, error: (e as Error).message });
          console.log(`no (${(e as Error).message})`);
        } finally {
          link.close();
          await pause(600);
        }
      }
      const winner = results.find((r) => r.reply);
      console.log(winner ? `\nUse --channel ${winner.channel}` : '\nNo channel replied. Paste this output back to me.');
      return;
    }

    case 'diag': {
      // Step through commands of increasing complexity so we can see where the box stops reacting.
      const link = makeLink();
      const device = new Device(link, { log: console.log });
      device.prepare(clawdSprites());
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const step = async (what: string, fn: () => Promise<void>) => {
        console.log(`\n--- ${what}`);
        await fn();
        await pause(2500);
        console.log(`    replies so far: ${device.replies}`);
      };
      await device.ensureConnected();
      console.log(`connected via ${link.label}${link instanceof RfcommLink ? ` channel ${link.channelUsed}` : ''}`);
      await step('0. settings query (box should send a reply)', () => device.send([encodeGetSettings()]));
      await step('1. brightness 10% (panel should dim)', () => device.send([encodeBrightness(10)]));
      await step('2. brightness 100% (panel should brighten)', () => device.send([encodeBrightness(100)]));
      const solid = (c: Rgb): Rgb[] => Array.from({ length: PIXELS }, () => c);
      await step('3. still image: solid red', () => device.send([encodeImage(solid([255, 0, 0]))]));
      const checker: Rgb[] = Array.from({ length: PIXELS }, (_, i) => (((i % 16) + Math.floor(i / 16)) % 2 ? [0, 0, 255] : [0, 255, 0]));
      await step('4. still image: green/blue checkerboard', () => device.send([encodeImage(checker)]));
      await step('5. animation: writing', () => device.show('writing'));
      console.log(`\ndone. link=${link.label} replies=${device.replies}`);
      console.log('Tell me the first step where the panel changed, and whether any "reply:" lines appeared.');
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

function bleMode(): 'upload' | 'stream' | 'slots' {
  return v.slots ? 'slots' : v.upload ? 'upload' : 'stream';
}

/** Build a display from --ble / --mock / --serial / --mac. */
function makeDisplay(log: (m: string) => void): Display {
  if (v.ble) return new BleDisplay({ address: v.address, mode: bleMode(), select: v.select, brightness: v.brightness ? Number(v.brightness) : undefined, python: v.python, repoRoot: repoRoot(), log });
  return new Device(makeLink(), { log, brightness: v.brightness ? Number(v.brightness) : undefined });
}

/** Build the device link from --mock / --serial / --mac. */
function makeLink(): Link {
  if (v.mock) return new MockLink(true);
  if (v.serial) return new SerialLink(v.serial, console.log);
  return new RfcommLink(requireMac(), v.channel ? Number(v.channel) : undefined, 15_000, console.log);
}

function requireMac(): string {
  if (!v.mac) throw new Error('--mac XX:XX:XX:XX:XX:XX is required');
  return v.mac;
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
