import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Anim, IDLE_STAGES, STATES, State, isActivityState, isFlashState, isIdleStage, loopMs } from '../anim/types.js';
import { loadAnimSet } from '../anim/load.js';
import { clawdSprites } from '../anim/clawd.js';
import { Device } from './device.js';
import { BleDisplay } from './ble-display.js';
import { Display } from './display.js';
import { Link, MockLink, RfcommLink, SerialLink } from './link.js';
import { HookEvent, Reducer } from './reducer.js';
import { DEFAULT_SCHEDULER, Scheduler } from './scheduler.js';
import { startServers } from './server.js';
import { UpdateChecker } from './update-check.js';
import { readFileSync } from 'node:fs';

export interface DaemonConfig {
  /** Unix socket that receives hook events (default ~/Library/Application Support/clawdbox/hook.sock). */
  socketPath?: string;
  /** Also accept POST /event over TCP, for Claude Code's native http hooks (less private). */
  tcpEvents: boolean;
  mac?: string;
  serial?: string;
  /** Newer Evo generation: drive it over BLE via the Python bridge. */
  ble?: boolean;
  bleAddress?: string;
  bleMode?: 'upload' | 'stream' | 'slots';
  bleSelect?: string;
  python?: string;
  channel?: number;
  mock: boolean;
  port: number;
  host: string;
  animsDir?: string;
  /** Panel brightness applied on every connect (0-100). */
  brightness: number;
  minHoldMs: number;
  idleAfterMs: number;
  flashMs: number;
  doneAfterMs: number;
  idleStageAfterMs: number;
  idleStageCycleMs: number;
  sessionTtlMs: number;
  /** Check origin/main for updates (every 6 h) and report it in /state. */
  updateCheck: boolean;
  verbose: boolean;
}

/** More live sessions than this is a bug or abuse; the oldest are forgotten first. */
const MAX_SESSIONS = 64;
/** How often the daemon (and the optional launchd updater) look for a newer clawdbox. */
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Scheduler tick. */
const TICK_MS = 100;

export const DEFAULT_CONFIG: DaemonConfig = {
  tcpEvents: false,
  mock: false,
  brightness: 100,
  port: 7676,
  host: '127.0.0.1',
  minHoldMs: DEFAULT_SCHEDULER.minHoldMs,
  idleAfterMs: DEFAULT_SCHEDULER.idleAfterMs,
  flashMs: DEFAULT_SCHEDULER.flashMs,
  doneAfterMs: 10_000,
  idleStageAfterMs: DEFAULT_SCHEDULER.idleStageAfterMs,
  idleStageCycleMs: DEFAULT_SCHEDULER.idleStageCycleMs,
  sessionTtlMs: 6 * 60 * 60 * 1000,
  updateCheck: true,
  verbose: false,
};

export function repoRoot(): string {
  // src/daemon/main.ts -> repo root (works from dist/ too)
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Where hook events are received. Lives under the user's home, directory mode 0700, socket 0600. */
export function defaultSocketPath(): string {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'clawdbox')
      : join(process.env.XDG_RUNTIME_DIR ?? join(homedir(), '.local', 'state'), 'clawdbox');
  return join(base, 'hook.sock');
}

export function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export async function runDaemon(cfg: DaemonConfig): Promise<void> {
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  const debug = cfg.verbose ? log : () => {};

  let anims: Record<State, Anim>;
  if (cfg.animsDir) {
    anims = loadAnimSet(cfg.animsDir);
    log(`loaded animations from ${cfg.animsDir}`);
  } else {
    anims = clawdSprites();
    log('using built-in Clawd sprites (pass --anims <dir> for your own)');
  }

  let device: Display;
  if (cfg.ble) {
    device = new BleDisplay({
      address: cfg.bleAddress,
      mode: cfg.bleMode,
      select: cfg.bleSelect,
      brightness: cfg.brightness,
      python: cfg.python,
      repoRoot: repoRoot(),
      log,
    });
  } else {
    let link: Link;
    if (cfg.mock) link = new MockLink(cfg.verbose ? log : undefined);
    else if (cfg.serial) link = new SerialLink(cfg.serial, log);
    else {
      if (!cfg.mac)
        throw new Error('--ble, --mac XX:XX:XX:XX:XX:XX or --serial /dev/cu.… is required (or --mock). Run "clawdbox discover".');
      link = new RfcommLink(cfg.mac, cfg.channel, 15_000, log);
    }
    device = new Device(link, { brightness: cfg.brightness, log, debug });
  }
  device.prepare(anims);
  // After a link drop the panel may be showing the Divoom clock; put Clawd back.
  device.onReconnect = () => {
    const state = sched.current;
    log(`link is back; re-showing ${state}`);
    device.show(state).catch((e) => debug(`re-show failed: ${(e as Error).message}`));
  };

  const reducer = new Reducer({ doneAfterMs: cfg.doneAfterMs });
  const sched = new Scheduler({
    minHoldMs: cfg.minHoldMs,
    idleAfterMs: cfg.idleAfterMs,
    maxBoundaryWaitMs: DEFAULT_SCHEDULER.maxBoundaryWaitMs,
    flashMs: cfg.flashMs,
    idleStageAfterMs: cfg.idleStageAfterMs,
    idleStageCycleMs: cfg.idleStageCycleMs,
    onIdleFallback: (now) => {
      log('no events for a while; treating the session as idle');
      reducer.idleAll(now);
    },
    loopMs: Object.fromEntries(Object.entries(anims).map(([k, a]) => [k, loopMs(a)])) as Record<State, number>,
  });

  let forced: State | null = null;
  const onEvent = (ev: HookEvent) => {
    const now = Date.now();
    const { action, flash } = reducer.apply(ev, now);
    forced = null;
    debug(
      `event ${ev.hook_event_name ?? '?'} ${ev.tool_name ?? ''} ${ev.notification_type ?? ''} -> ${JSON.stringify(action)}${flash ? ` flash=${flash}` : ''} agg=${reducer.aggregate()}`,
    );
    sched.setTarget(reducer.aggregate(), now);
    if (flash) sched.flash(flash, now);
  };
  const onForce = (s: State) => {
    forced = s;
    const now = Date.now();
    if (isFlashState(s)) sched.flash(s, now);
    else if (isActivityState(s)) sched.setTarget(s, now);
    else if (isIdleStage(s)) {
      // long-idle stage: pretend we've been idle long enough
      sched.setTarget('idle', now - cfg.idleStageAfterMs - cfg.idleStageCycleMs * IDLE_STAGES.indexOf(s));
    }
    log(`forced ${s}`);
  };

  const updates = new UpdateChecker(repoRoot(), packageVersion(), log);
  if (cfg.updateCheck) updates.start(UPDATE_INTERVAL_MS);

  const previewHtmlPath = join(repoRoot(), 'web', 'index.html');
  const servers = await startServers(
    { port: cfg.port, host: cfg.host, socketPath: cfg.socketPath ?? defaultSocketPath(), tcpEvents: cfg.tcpEvents, log },
    {
      onEvent,
      onForce,
      anims: () => anims,
      status: () => ({
        current: sched.current,
        pending: sched.pending,
        forced,
        transport: cfg.mock ? 'mock' : cfg.ble ? `ble ${cfg.bleMode ?? 'stream'}` : cfg.serial ? 'serial' : 'rfcomm',
        sessions: Object.fromEntries(reducer.sessions),
        states: STATES,
        device: { label: device.label, connected: device.connected, pushes: device.pushes, lastError: device.lastError },
        uptimeSec: Math.round(process.uptime()),
        update: updates.info,
      }),
      previewHtmlPath,
    },
  );

  let busy = false;
  // Show idle right away so the panel is never blank (servers are up, so a port clash
  // has already been handled before the bridge takes the panel's single BLE link).
  busy = true;
  device
    .show('idle')
    .then(() => sched.shown('idle', Date.now()))
    .catch((e) => debug(`initial show failed: ${(e as Error).message}`))
    .finally(() => {
      busy = false;
    });

  // A display hiccup must never take the daemon (and the hooks' endpoint) down,
  // but a real bug should be visible in the log with its stack.
  process.on('unhandledRejection', (e) => log(`unhandled rejection: ${(e as Error)?.stack ?? String(e)}`));
  process.on('uncaughtException', (e) => log(`uncaught exception: ${e.stack ?? e.message}`));

  const tick = setInterval(async () => {
    const now = Date.now();
    const dropped = reducer.prune(now, cfg.sessionTtlMs, MAX_SESSIONS);
    if (dropped.length) {
      log(`dropped stale sessions: ${dropped.join(', ')}`);
      sched.setTarget(reducer.aggregate(), now);
    }
    if (forced && sched.current !== forced && sched.pending !== forced) forced = null;
    if (busy) return;
    const next = sched.tick(now);
    if (!next) return;
    busy = true;
    try {
      await device.show(next);
      sched.shown(next, Date.now());
    } catch (e) {
      debug(`show failed: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }, TICK_MS);

  let stopping = false;
  const shutdown = () => {
    if (stopping) process.exit(1);
    stopping = true;
    log('shutting down');
    clearInterval(tick);
    updates.stop();
    device.close();
    servers.close();
    servers.tcp.closeAllConnections();
    servers.socket?.closeAllConnections();
    // the bridge disconnects the panel on SIGTERM; give it a moment, then go
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
