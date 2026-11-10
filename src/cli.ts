#!/usr/bin/env node
/**
 * clawdbox command line. One flags table feeds three consumers so they cannot drift:
 * `configFromFlags()` for the in-process daemon, `daemonArgsFromFlags()` for the launchd
 * agent's argv, and `makeDisplay()` for the one-shot `send`/`diag` commands.
 */
import { parseArgs, ParseArgsConfig } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DEFAULT_CONFIG, DaemonConfig, UPDATE_INTERVAL_MS, defaultSocketPath, packageVersion, repoRoot, runDaemon } from './daemon/main.js';
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
import { encodeGetSettings, encodeImage } from './protocol/divoom.js';
import { Device } from './daemon/device.js';
import { BleDisplay, BleMode, resolvePython } from './daemon/ble-display.js';
import { Display } from './daemon/display.js';
import { loadAnimSet } from './anim/load.js';

const PORT = DEFAULT_CONFIG.port;
const UPDATE_HOURS = UPDATE_INTERVAL_MS / 3_600_000;

const HELP = `clawdbox ${packageVersion()} - Claude Code companion for the Divoom TimeBox Evo

Usage:
  clawdbox daemon (--ble [--address UUID] [--upload | --slots [--select HEX]] [--python PATH]
                   | --mac XX:XX:XX:XX:XX:XX [--channel N] | --serial /dev/cu.NAME | --mock)
                  [--anims DIR] [--port ${PORT}] [--brightness 0-100 (default ${DEFAULT_CONFIG.brightness})]
                  [--hold-ms ${DEFAULT_CONFIG.minHoldMs}] [--idle-ms ${DEFAULT_CONFIG.idleAfterMs}] [--coffee-min 10 (0 disables)] [--flash-ms ${DEFAULT_CONFIG.flashMs}]
                  [--socket PATH] [--tcp-events] [--no-update-check] [-v]
      --ble          newer TimeBox-Evo-audio / Backpack M over BLE (bridge/clawdbox_ble.py + divoom-protocol).
                     Streams stills by default; --upload sends the loop per change (shows a transfer screen);
                     --slots is experimental (--select HEX: bytes before the slot number, default 4505)
      --mac          original Timebox Evo over Bluetooth Classic serial (--serial: the OS serial device instead)
      --tcp-events   also accept hook POSTs on the TCP port (needed for Claude Code's http hooks; less private)
  clawdbox discover                                  list paired Bluetooth Classic devices and serial ports
  clawdbox ble-scan                                  list Divoom BLE devices (needs the Python bridge deps)
  clawdbox send <state> (--ble | --mac MAC | --serial DEV | --mock)   push one animation and exit
  clawdbox diag (--mac MAC | --serial DEV)           step through settings query, brightness, stills, animation
  clawdbox scan --mac MAC [LAST]                     try RFCOMM channels 1..LAST (default 30); report which answers
  clawdbox sprites [--out art/anims]                 write the built-in Clawd sprites as JSON
  clawdbox build-anims <sheet.json | strips-dir> [--out art/anims] [--fps 6]
  clawdbox install-hooks [--http [--url URL]]        merge hooks into ~/.claude/settings.json (default: async curl to
                                                     the daemon's private Unix socket; --http: Claude Code http hooks)
  clawdbox uninstall-hooks
  clawdbox install-launchd <daemon flags> [--no-auto-update]
                                                     app bundle + login agent + ${UPDATE_HOURS}-hourly release updater
  clawdbox uninstall-launchd
  clawdbox update [--check | --force]                update to the newest release tag, rebuild, restart the daemon
  clawdbox show <state> [--port ${PORT}]                tell a running daemon to show a state (testing)

States: ${STATES.join(', ')}
`;

const OPTIONS = {
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
  socket: { type: 'string' },
  'tcp-events': { type: 'boolean', default: false },
  'no-update-check': { type: 'boolean', default: false },
  verbose: { type: 'boolean', short: 'v', default: false },
  out: { type: 'string' },
  fps: { type: 'string' },
  url: { type: 'string' },
  http: { type: 'boolean', default: false },
  'auto-update': { type: 'boolean', default: false },
  'no-auto-update': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  check: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} satisfies ParseArgsConfig['options'];

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

class UsageError extends Error {}

function parseFlags(argv: string[]): { v: Flags; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    return { v: values, positionals };
  } catch (e) {
    throw new UsageError(`${(e as Error).message.replace(/^.*?'(--?[^']+)'.*$/s, 'unknown or malformed option $1')} (try --help)`);
  }
}

/** Parse a numeric flag or fail with a clear message instead of letting NaN reach the device. */
function numFlag(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${name} must be a number between ${min} and ${max}, got "${raw}"`);
  return n;
}

function bleMode(v: Flags): BleMode {
  return v.slots ? 'slots' : v.upload ? 'upload' : 'stream';
}

function defaultAnims(v: Flags): string | undefined {
  const d = join(repoRoot(), 'art', 'anims');
  return v.anims ?? (existsSync(join(d, 'idle.json')) ? d : undefined);
}

/** The daemon configuration implied by the flags (validated). */
function configFromFlags(v: Flags): DaemonConfig {
  const coffeeMin = numFlag('coffee-min', v['coffee-min'], DEFAULT_CONFIG.idleStageAfterMs / 60_000, 0, 1440);
  return {
    ...DEFAULT_CONFIG,
    mac: v.mac,
    serial: v.serial,
    ble: v.ble,
    bleAddress: v.address,
    bleMode: bleMode(v),
    bleSelect: v.select,
    python: v.python,
    channel: v.channel === undefined ? undefined : numFlag('channel', v.channel, 1, 1, 30),
    mock: v.mock,
    port: numFlag('port', v.port, PORT, 1, 65535),
    animsDir: defaultAnims(v),
    brightness: numFlag('brightness', v.brightness, DEFAULT_CONFIG.brightness, 0, 100),
    minHoldMs: numFlag('hold-ms', v['hold-ms'], DEFAULT_CONFIG.minHoldMs, 0, 60_000),
    idleAfterMs: numFlag('idle-ms', v['idle-ms'], DEFAULT_CONFIG.idleAfterMs, 1000, 86_400_000),
    idleStageAfterMs: coffeeMin * 60_000,
    idleStageCycleMs: Math.max(60_000, coffeeMin * 60_000),
    flashMs: numFlag('flash-ms', v['flash-ms'], DEFAULT_CONFIG.flashMs, 500, 60_000),
    updateCheck: !v['no-update-check'],
    tcpEvents: v['tcp-events'] || v.http,
    socketPath: v.socket,
    verbose: v.verbose,
  };
}

/** The same flags, re-serialised for the launchd agent so nothing the user passed is dropped. */
function daemonArgsFromFlags(v: Flags, cfg: DaemonConfig): string[] {
  const args: string[] = [];
  if (cfg.ble) {
    args.push('--ble');
    if (cfg.bleAddress) args.push('--address', cfg.bleAddress);
    if (cfg.bleMode === 'upload') args.push('--upload');
    if (cfg.bleMode === 'slots') args.push('--slots');
    if (cfg.bleSelect) args.push('--select', cfg.bleSelect);
    args.push('--python', resolvePython(repoRoot(), cfg.python));
  } else if (cfg.serial) args.push('--serial', cfg.serial);
  else if (cfg.mac) args.push('--mac', cfg.mac);
  else if (cfg.mock) args.push('--mock');
  if (cfg.channel !== undefined) args.push('--channel', String(cfg.channel));
  if (cfg.animsDir) args.push('--anims', cfg.animsDir);
  // only flags the user set explicitly, so the agent follows future defaults
  const passthrough: [keyof Flags, string, unknown][] = [
    ['brightness', '--brightness', cfg.brightness],
    ['port', '--port', cfg.port],
    ['hold-ms', '--hold-ms', cfg.minHoldMs],
    ['idle-ms', '--idle-ms', cfg.idleAfterMs],
    ['coffee-min', '--coffee-min', cfg.idleStageAfterMs / 60_000],
    ['flash-ms', '--flash-ms', cfg.flashMs],
    ['socket', '--socket', cfg.socketPath],
  ];
  for (const [flag, name, value] of passthrough) if (v[flag] !== undefined && value !== undefined) args.push(name, String(value));
  if (cfg.tcpEvents) args.push('--tcp-events');
  if (!cfg.updateCheck) args.push('--no-update-check');
  if (cfg.verbose) args.push('-v');
  return args;
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function launchctl(args: string[], quiet = false): boolean {
  try {
    execFileSync('launchctl', args, { stdio: quiet ? 'ignore' : 'inherit' });
    return true;
  } catch {
    return false;
  }
}

function logDir(): string {
  return join(homedir(), 'Library', 'Logs', 'clawdbox');
}

/** Build a display for the one-shot commands from the same validated config the daemon uses. */
function makeDisplay(cfg: DaemonConfig, log: (m: string) => void): Display {
  if (cfg.ble) {
    return new BleDisplay({
      address: cfg.bleAddress,
      mode: cfg.bleMode,
      select: cfg.bleSelect,
      brightness: cfg.brightness,
      python: cfg.python,
      repoRoot: repoRoot(),
      log,
    });
  }
  return new Device(makeLink(cfg, log), { log, brightness: cfg.brightness });
}

function makeLink(cfg: DaemonConfig, log: (m: string) => void): Link {
  if (cfg.mock) return new MockLink(log);
  if (cfg.serial) return new SerialLink(cfg.serial, log);
  if (!cfg.mac) throw new UsageError('--mac XX:XX:XX:XX:XX:XX, --serial /dev/cu.NAME, --ble or --mock is required');
  return new RfcommLink(cfg.mac, cfg.channel, 15_000, log);
}

/** Native Bluetooth handles can keep Node alive after we are done; exit once the device is closed. */
function exitAfterClose(display: Display, graceMs: number): void {
  display.close();
  setTimeout(() => process.exit(0), graceMs).unref();
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------- commands ---------------- */

async function cmdSprites(v: Flags): Promise<void> {
  const out = resolve(v.out ?? join(repoRoot(), 'art', 'anims'));
  const files = writeAnims(Object.values(clawdSprites()), out);
  console.log(files.map((f) => `wrote ${f}`).join('\n'));
}

async function cmdBuildAnims(v: Flags, input: string | undefined): Promise<void> {
  if (!input) throw new UsageError('build-anims needs a sheet.json or a directory of PNG strips');
  const out = resolve(v.out ?? join(repoRoot(), 'art', 'anims'));
  const files = buildAnims(input, out, numFlag('fps', v.fps, 6, 1, 30));
  console.log(files.map((f) => `wrote ${f}`).join('\n'));
}

function cmdInstallHooks(v: Flags, cfg: DaemonConfig): void {
  if (v.http) {
    // Claude Code's native http hooks can only reach TCP: less private (any local process could squat the port).
    const url = v.url ?? `http://127.0.0.1:${cfg.port}/event`;
    installHooks({ mode: 'http', url });
    console.log(`hooks installed in ${settingsPath()} (http mode, posting to ${url}; run the daemon with --tcp-events)`);
  } else {
    const socketPath = cfg.socketPath ?? defaultSocketPath();
    installHooks({ mode: 'command', socketPath });
    console.log(`hooks installed in ${settingsPath()} (async curl to the daemon's socket ${socketPath})`);
  }
  console.log('Claude Code picks up settings changes automatically; if an open session stays quiet, restart it.');
}

function cmdInstallLaunchd(v: Flags, cfg: DaemonConfig): void {
  if (!cfg.mac && !cfg.ble && !cfg.serial && !cfg.mock) throw new UsageError('--ble, --mac, --serial or --mock is required');
  if (process.platform !== 'darwin') throw new UsageError('install-launchd is macOS only');
  const logs = logDir();
  mkdirSync(logs, { recursive: true });
  const cli = join(repoRoot(), 'dist', 'cli.js');
  if (!existsSync(cli)) throw new UsageError('run "npm run build" first so dist/cli.js exists');
  const args = daemonArgsFromFlags(v, cfg);

  // 1. app bundle so macOS grants Bluetooth to the daemon
  const appDir = appBundlePath();
  writeAppBundle(
    appDir,
    appBundleFiles({ node: process.execPath, cli, args, cwd: repoRoot(), version: packageVersion() }),
    join(repoRoot(), 'assets', 'Clawd.icns'),
  );
  const launcher = join(appDir, 'Contents', 'MacOS', 'clawdbox');

  // 2. launchd agent that keeps it running
  const path = launchdPlistPath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, launchdPlist({ launcher, logDir: logs, cwd: repoRoot() }));
  const domain = launchdDomain();
  launchctl(['bootout', `${domain}/${LAUNCHD_LABEL}`], true);
  if (!launchctl(['bootstrap', domain, path]))
    console.warn(`launchctl bootstrap failed; load it manually with: launchctl bootstrap ${domain} ${path}`);

  // 3. updater agent (on by default; follows release tags, --no-auto-update to skip)
  if (!v['no-auto-update']) {
    const upath = updaterPlistPath();
    writeFileSync(
      upath,
      updaterPlist({
        script: join(repoRoot(), 'scripts', 'update.sh'),
        logDir: logs,
        cwd: repoRoot(),
        intervalSec: UPDATE_INTERVAL_MS / 1000,
      }),
    );
    launchctl(['bootout', `${domain}/${UPDATER_LABEL}`], true);
    if (launchctl(['bootstrap', domain, upath]))
      console.log(`auto-update:   ${upath} (every ${UPDATE_HOURS} h, log in ${join(logs, 'update.log')})`);
    else console.warn(`the updater agent was written but not loaded; load it with: launchctl bootstrap ${domain} ${upath}`);
  }
  console.log(`app bundle:    ${appDir}\nlaunchd agent: ${path}\nlogs:          ${logs}`);
  console.log(`\nIf macOS asks whether Clawdbox may use Bluetooth, allow it. Follow along with:  tail -f ${join(logs, 'clawdbox.log')}`);
  console.log(`A daemon still running in a terminal will keep port ${cfg.port}; stop it (Ctrl-C) so the agent can take over.`);
  if (!v['no-auto-update'])
    console.log(
      `Updates install themselves every ${UPDATE_HOURS} h when a new release tag appears (uninstall-launchd or --no-auto-update to stop).`,
    );
}

function cmdUninstallLaunchd(): void {
  const domain = launchdDomain();
  launchctl(['bootout', `${domain}/${LAUNCHD_LABEL}`], true);
  launchctl(['bootout', `${domain}/${UPDATER_LABEL}`], true);
  rmSync(launchdPlistPath(), { force: true });
  rmSync(updaterPlistPath(), { force: true });
  rmSync(appBundlePath(), { recursive: true, force: true });
  console.log('launchd agents and app bundle removed');
}

async function cmdDiscover(): Promise<void> {
  if (process.platform === 'darwin') {
    const ports = readdirSync('/dev').filter((f) => f.startsWith('cu.') && /timebox|evo|divoom|tivoo|ditoo|pixoo/i.test(f));
    if (ports.length) {
      console.log('serial devices created by macOS for paired Bluetooth devices:');
      for (const p of ports) console.log(`    --serial /dev/${p}`);
      console.log('If one of these is the Timebox, prefer it over --mac (see README).\n');
    }
  }
  let mod: typeof import('bluetooth-serial-port');
  try {
    mod = await import('bluetooth-serial-port');
  } catch (e) {
    throw new Error(
      `bluetooth-serial-port is not installed or failed to build (${(e as Error).message}); run "npm rebuild bluetooth-serial-port"`,
    );
  }
  const bt = new mod.BluetoothSerialPort();
  const devices = await Promise.race([
    new Promise<BtPairedDevice[]>((done) => bt.listPairedDevices(done)),
    pause(10_000).then(() => {
      throw new Error('Bluetooth did not answer within 10 s');
    }),
  ]);
  for (const d of devices) {
    const svc = (d.services ?? []).filter((s) => s.channel > 0);
    const spp = pickSppChannel(svc);
    console.log(`${d.address}  ${d.name}`);
    for (const s of svc)
      console.log(`    channel ${s.channel}  ${s.name ?? '(unnamed)'}${s.channel === spp ? '   <- serial port, will be used' : ''}`);
    if (svc.length && !spp) console.log('    (no service named SPP/serial; pass --channel to pick one)');
  }
  if (!devices.length) console.log('no paired devices; pair the Timebox in System Settings > Bluetooth first');
}

async function cmdSend(cfg: DaemonConfig, state: string | undefined): Promise<void> {
  if (!state || !isState(state)) throw new UsageError(`send needs a state: ${STATES.join(', ')}`);
  const device = makeDisplay(cfg, console.log);
  device.prepare(cfg.animsDir ? loadAnimSet(cfg.animsDir) : clawdSprites());
  await device.show(state);
  // give the box a moment to finish parsing before we hang up
  await pause(cfg.ble ? 3000 : 800);
  console.log('done');
  exitAfterClose(device, cfg.ble ? 1500 : 200);
}

async function cmdBleScan(cfg: DaemonConfig): Promise<void> {
  const python = resolvePython(repoRoot(), cfg.python);
  await new Promise<void>((done, fail) => {
    const p = spawn(python, [join(repoRoot(), 'bridge', 'clawdbox_ble.py'), '--scan'], { stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', (d: Buffer) => process.stdout.write(d));
    p.on('error', (e) =>
      fail(
        new Error(
          `could not start ${python}: ${e.message} (install the bridge deps: python3 -m venv .venv && .venv/bin/pip install -r bridge/requirements.txt)`,
        ),
      ),
    );
    p.on('exit', (code) => (code === 0 ? done() : fail(new Error(`bridge scan exited with ${code}`))));
  });
}

async function cmdScan(cfg: DaemonConfig, last: string | undefined): Promise<void> {
  // Try every RFCOMM channel; the one that answers the settings query is the serial port.
  if (!cfg.mac) throw new UsageError('scan needs --mac XX:XX:XX:XX:XX:XX');
  const from = cfg.channel ?? 1;
  const to = numFlag('last channel', last, 30, from, 30);
  const results: { channel: number; reply?: string }[] = [];
  for (let ch = from; ch <= to; ch++) {
    const link = new RfcommLink(cfg.mac, ch, 6000);
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
      results.push({ channel: ch, reply: hex });
      console.log(hex ? `CONNECTED, replied ${hex}   <-- this is the one` : 'connected, no reply');
    } catch (e) {
      results.push({ channel: ch });
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
}

async function cmdDiag(cfg: DaemonConfig): Promise<void> {
  // Step through commands of increasing complexity so we can see where the box stops reacting.
  const link = makeLink(cfg, console.log);
  const device = new Device(link, { log: console.log, debug: console.log, brightness: cfg.brightness });
  device.prepare(clawdSprites());
  const step = async (what: string, fn: () => Promise<void>) => {
    console.log(`\n--- ${what}`);
    await fn();
    await pause(2500);
    console.log(`    replies so far: ${device.replies}`);
  };
  await device.ensureConnected();
  console.log(`connected via ${link.label}${link instanceof RfcommLink ? ` channel ${link.channelUsed}` : ''}`);
  await step('0. settings query (box should send a reply)', () => device.send([encodeGetSettings()]));
  await step('1. brightness 10% (panel should dim)', () => device.setBrightness(10));
  await step('2. brightness 100% (panel should brighten)', () => device.setBrightness(100));
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
  exitAfterClose(device, 500);
}

function cmdUpdate(v: Flags): void {
  const args = [join(repoRoot(), 'scripts', 'update.sh')];
  if (v.force) args.push('--force');
  if (v.check) args.push('--check');
  try {
    execFileSync('/bin/bash', args, { stdio: 'inherit', cwd: repoRoot() });
  } catch (e) {
    process.exitCode = (e as { status?: number }).status ?? 1;
  }
}

async function cmdShow(cfg: DaemonConfig, state: string | undefined): Promise<void> {
  if (!state || !isState(state)) throw new UsageError(`show needs a state: ${STATES.join(', ')}`);
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/show/${state}`, { method: 'POST' });
    console.log(await res.text());
  } catch {
    throw new Error(`no daemon answered on 127.0.0.1:${cfg.port}; start one with "clawdbox daemon --ble" or restart the login agent`);
  }
}

/* ---------------- entry ---------------- */

async function main(argv: string[]): Promise<void> {
  const { v, positionals } = parseFlags(argv);
  const cmd = positionals[0];
  if (v.help || !cmd) {
    console.log(HELP);
    return;
  }
  const cfg = configFromFlags(v);
  switch (cmd) {
    case 'daemon':
      return runDaemon(cfg);
    case 'sprites':
      return cmdSprites(v);
    case 'build-anims':
      return cmdBuildAnims(v, positionals[1]);
    case 'install-hooks':
      return cmdInstallHooks(v, cfg);
    case 'uninstall-hooks':
      uninstallHooks();
      console.log(`clawdbox hooks removed from ${settingsPath()}`);
      return;
    case 'install-launchd':
      return cmdInstallLaunchd(v, cfg);
    case 'uninstall-launchd':
      return cmdUninstallLaunchd();
    case 'discover':
      return cmdDiscover();
    case 'ble-scan':
      return cmdBleScan(cfg);
    case 'send':
      return cmdSend(cfg, positionals[1]);
    case 'scan':
      return cmdScan(cfg, positionals[1]);
    case 'diag':
      return cmdDiag(cfg);
    case 'update':
      return cmdUpdate(v);
    case 'show':
      return cmdShow(cfg, positionals[1]);
    default:
      throw new UsageError(`unknown command "${cmd}" (try --help)`);
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(e instanceof UsageError ? 2 : 1);
});
