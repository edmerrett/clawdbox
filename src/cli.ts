#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DEFAULT_CONFIG, repoRoot, runDaemon } from './daemon/main.js';
import { clawdSprites } from './anim/clawd.js';
import { writeAnims, buildAnims } from './tools/build-anims.js';
import {
  installHooks,
  uninstallHooks,
  launchdPlist,
  launchdPlistPath,
  LAUNCHD_LABEL,
  settingsPath,
  appBundleFiles,
  appBundlePath,
  writeAppBundle,
  updaterPlist,
  updaterPlistPath,
  UPDATER_LABEL,
} from './tools/install.js';
import { isState, STATES, Rgb, PIXELS } from './anim/types.js';
import { BtPairedDevice, Link, MockLink, RfcommLink, SerialLink, pickSppChannel } from './daemon/link.js';
import { encodeBrightness, encodeGetSettings, encodeImage } from './protocol/divoom.js';
import { Device } from './daemon/device.js';
import { BleDisplay, BleMode, resolvePython } from './daemon/ble-display.js';
import { Display } from './daemon/display.js';
import { loadAnimSet } from './anim/load.js';

const HELP = `clawdbox - Claude Code companion for the Divoom TimeBox Evo

Usage:
  clawdbox daemon (--ble [--address UUID] [--upload | --slots] | --mac XX:XX:XX:XX:XX:XX | --serial /dev/cu.NAME | --mock)
                  [--anims DIR] [--port 7676] [--brightness 0-100 (default 100)] [--hold-ms 2000] [--idle-ms 90000]
                  [--coffee-min 10 (long-idle stages start after N min; 0 disables)] [--flash-ms 3500] [--no-update-check] [-v]
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
  clawdbox install-launchd (--ble | --mac MAC) [--anims DIR] [--brightness N] [--auto-update]
                                                     write + load ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist
                                                     (--auto-update also installs a 6-hourly "clawdbox update" agent)
  clawdbox update [--check | --force]                pull main, rebuild, rebuild the menu bar app if changed, restart the daemon
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
    'coffee-min': { type: 'string' },
    'flash-ms': { type: 'string' },
    out: { type: 'string' },
    fps: { type: 'string' },
    url: { type: 'string' },
    http: { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    'no-update-check': { type: 'boolean', default: false },
    'auto-update': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const cmd = positionals[0];
// Numeric flags are validated inside main() so a typo is a one-line error, not a stack trace.
let port = DEFAULT_CONFIG.port;
let brightness = DEFAULT_CONFIG.brightness;
let channelFlag: number | undefined;
let coffeeMin = DEFAULT_CONFIG.idleStageAfterMs / 60_000;

function parseNumericFlags(): void {
  port = numFlag('port', v.port, DEFAULT_CONFIG.port, 1, 65535);
  brightness = numFlag('brightness', v.brightness, DEFAULT_CONFIG.brightness, 0, 100);
  channelFlag = v.channel === undefined ? undefined : numFlag('channel', v.channel, 1, 1, 30);
  coffeeMin = numFlag('coffee-min', v['coffee-min'], DEFAULT_CONFIG.idleStageAfterMs / 60_000, 0, 1440);
}
const defaultAnims = () => {
  const d = join(repoRoot(), 'art', 'anims');
  return v.anims ?? (existsSync(join(d, 'idle.json')) ? d : undefined);
};

async function main() {
  if (v.help || !cmd) {
    console.log(HELP);
    return;
  }
  parseNumericFlags();
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
        channel: channelFlag,
        mock: v.mock,
        port,
        animsDir: defaultAnims(),
        brightness,
        minHoldMs: numFlag('hold-ms', v['hold-ms'], DEFAULT_CONFIG.minHoldMs, 0, 60_000),
        idleAfterMs: numFlag('idle-ms', v['idle-ms'], DEFAULT_CONFIG.idleAfterMs, 1000, 86_400_000),
        idleStageAfterMs: coffeeMin * 60_000,
        idleStageCycleMs: Math.max(60_000, coffeeMin * 60_000),
        flashMs: numFlag('flash-ms', v['flash-ms'], DEFAULT_CONFIG.flashMs, 500, 60_000),
        updateCheck: !v['no-update-check'],
        verbose: v.verbose,
      });
      return;

    case 'sprites': {
      const out = resolve(v.out ?? join(repoRoot(), 'art', 'anims'));
      const files = writeAnims(Object.values(clawdSprites()), out);
      console.log(files.map((f) => `wrote ${f}`).join('\n'));
      return;
    }

    case 'build-anims': {
      const input = positionals[1];
      if (!input) throw new Error('build-anims needs a sheet.json or a directory of PNG strips');
      const out = resolve(v.out ?? join(repoRoot(), 'art', 'anims'));
      const files = buildAnims(input, out, numFlag('fps', v.fps, 6, 1, 30));
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
      if (v.brightness) args.push('--brightness', String(brightness));
      if (channelFlag !== undefined) args.push('--channel', String(channelFlag));
      if (v.port) args.push('--port', String(port));
      if (v['coffee-min'] !== undefined) args.push('--coffee-min', String(coffeeMin));
      // 1. app bundle so macOS grants Bluetooth to the daemon
      const appDir = appBundlePath();
      writeAppBundle(appDir, appBundleFiles({ node: process.execPath, cli, args, cwd: repoRoot() }));
      const launcher = join(appDir, 'Contents', 'MacOS', 'clawdbox');
      // 2. launchd agent that keeps it running
      const plist = launchdPlist({ launcher, logDir, cwd: repoRoot() });
      const path = launchdPlistPath();
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, plist);
      const domain = `gui/${process.getuid?.() ?? 501}`;
      try {
        execFileSync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
      } catch {
        /* not loaded yet */
      }
      try {
        execFileSync('launchctl', ['bootstrap', domain, path], { stdio: 'inherit' });
      } catch {
        console.warn(`launchctl bootstrap failed; load it manually with: launchctl bootstrap ${domain} ${path}`);
      }
      if (v['auto-update']) {
        const upath = updaterPlistPath();
        writeFileSync(
          upath,
          updaterPlist({ script: join(repoRoot(), 'scripts', 'update.sh'), logDir, cwd: repoRoot(), intervalSec: 6 * 3600 }),
        );
        try {
          execFileSync('launchctl', ['bootout', `${domain}/${UPDATER_LABEL}`], { stdio: 'ignore' });
        } catch {
          /* not loaded yet */
        }
        execFileSync('launchctl', ['bootstrap', domain, upath], { stdio: 'inherit' });
        console.log(`auto-update:   ${upath} (every 6 h, log in ${join(logDir, 'update.log')})`);
      }
      console.log(`app bundle:    ${appDir}\nlaunchd agent: ${path}\nlogs:          ${logDir}`);
      console.log('\nIf macOS asks whether Clawdbox may use Bluetooth, allow it. Check with:  tail -f ' + join(logDir, 'clawdbox.log'));
      console.log('Running daemon in a terminal? Stop it first (Ctrl-C), or the agent will fail to bind port 7676.');
      return;
    }
    case 'uninstall-launchd': {
      const path = launchdPlistPath();
      try {
        execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
      } catch {
        /* not loaded */
      }
      try {
        execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${UPDATER_LABEL}`], { stdio: 'ignore' });
      } catch {
        /* not loaded */
      }
      rmSync(path, { force: true });
      rmSync(updaterPlistPath(), { force: true });
      rmSync(appBundlePath(), { recursive: true, force: true });
      console.log('launchd agents and app bundle removed');
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
            for (const s of svc)
              console.log(
                `    channel ${s.channel}  ${s.name ?? '(unnamed)'}${s.channel === spp ? '   <- serial port, will be used' : ''}`,
              );
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
      setTimeout(() => process.exit(0), v.ble ? 1500 : 200).unref();
      return;
    }

    case 'ble-scan': {
      const python = resolvePython(repoRoot(), v.python);
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
      console.log(
        winner
          ? `\nUse --channel ${winner.channel}`
          : '\nNo channel replied. If the box pairs as "TimeBox-Evo-audio" (capital B) it is the newer BLE model: use --ble.',
      );
      return;
    }

    case 'diag': {
      // Step through commands of increasing complexity so we can see where the box stops reacting.
      const link = makeLink();
      const device = new Device(link, { log: console.log, brightness });
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
      console.log(
        device.replies
          ? 'The box answered: this transport works.'
          : 'The box never replied. On the newer TimeBox-Evo-audio the Classic serial port ignores commands; use --ble.',
      );
      device.close();
      return;
    }

    case 'update': {
      const args = [join(repoRoot(), 'scripts', 'update.sh')];
      if (v.force) args.push('--force');
      if (v.check) args.push('--check');
      try {
        execFileSync('/bin/bash', args, { stdio: 'inherit', cwd: repoRoot() });
      } catch (e) {
        process.exitCode = (e as { status?: number }).status ?? 1;
      }
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

function bleMode(): BleMode {
  return v.slots ? 'slots' : v.upload ? 'upload' : 'stream';
}

/** Parse a numeric flag or fail with a clear message instead of letting NaN reach the device. */
function numFlag(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number between ${min} and ${max}, got "${raw}"`);
  return n;
}

/** Build a display from --ble / --mock / --serial / --mac. */
function makeDisplay(log: (m: string) => void): Display {
  const brightness = v.brightness ? Number(v.brightness) : DEFAULT_CONFIG.brightness;
  if (v.ble)
    return new BleDisplay({
      address: v.address,
      mode: bleMode(),
      select: v.select,
      brightness,
      python: v.python,
      repoRoot: repoRoot(),
      log,
    });
  return new Device(makeLink(), { log, brightness });
}

/** Build the device link from --mock / --serial / --mac. */
function makeLink(): Link {
  if (v.mock) return new MockLink(true);
  if (v.serial) return new SerialLink(v.serial, console.log);
  return new RfcommLink(requireMac(), channelFlag, 15_000, console.log);
}

function requireMac(): string {
  if (!v.mac) throw new Error('--mac XX:XX:XX:XX:XX:XX is required');
  return v.mac;
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
