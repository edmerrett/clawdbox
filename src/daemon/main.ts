import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITY_STATES, ActivityState, Anim, FLASH_STATES, FlashState, IDLE_STAGES, State, loopMs } from '../anim/types.js';
import { loadAnimSet } from '../anim/load.js';
import { clawdSprites } from '../anim/clawd.js';
import { Device } from './device.js';
import { BleDisplay } from './ble-display.js';
import { Display } from './display.js';
import { Link, MockLink, RfcommLink, SerialLink } from './link.js';
import { HookEvent, Reducer } from './reducer.js';
import { DEFAULT_SCHEDULER, Scheduler } from './scheduler.js';
import { startServer } from './server.js';

export interface DaemonConfig {
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
  verbose: boolean;
}

export const DEFAULT_CONFIG: DaemonConfig = {
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
  verbose: false,
};

export function repoRoot(): string {
  // src/daemon/main.ts -> repo root (works from dist/ too)
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
    device = new BleDisplay({ address: cfg.bleAddress, mode: cfg.bleMode, select: cfg.bleSelect, brightness: cfg.brightness, python: cfg.python, repoRoot: repoRoot(), log });
  } else {
    let link: Link;
    if (cfg.mock) link = new MockLink(cfg.verbose);
    else if (cfg.serial) link = new SerialLink(cfg.serial, log);
    else {
      if (!cfg.mac) throw new Error('--ble, --mac XX:XX:XX:XX:XX:XX or --serial /dev/cu.… is required (or --mock). Run "clawdbox discover".');
      link = new RfcommLink(cfg.mac, cfg.channel, 15_000, log);
    }
    device = new Device(link, { brightness: cfg.brightness, log });
  }
  device.prepare(anims);

  const reducer = new Reducer({ doneAfterMs: cfg.doneAfterMs });
  const sched = new Scheduler({
    minHoldMs: cfg.minHoldMs,
    idleAfterMs: cfg.idleAfterMs,
    maxBoundaryWaitMs: DEFAULT_SCHEDULER.maxBoundaryWaitMs,
    flashMs: cfg.flashMs,
    idleStageAfterMs: cfg.idleStageAfterMs,
    idleStageCycleMs: cfg.idleStageCycleMs,
    loopMs: Object.fromEntries(Object.entries(anims).map(([k, a]) => [k, loopMs(a)])) as Record<State, number>,
  });

  let forced: State | null = null;
  const onEvent = (ev: HookEvent) => {
    const now = Date.now();
    const { action, flash } = reducer.apply(ev, now);
    forced = null;
    debug(`event ${ev.hook_event_name ?? '?'} ${ev.tool_name ?? ''} ${ev.notification_type ?? ''} -> ${JSON.stringify(action)}${flash ? ` flash=${flash}` : ''} agg=${reducer.aggregate()}`);
    sched.setTarget(reducer.aggregate(), now);
    if (flash) sched.flash(flash, now);
  };
  const onForce = (s: State) => {
    forced = s;
    const now = Date.now();
    if ((FLASH_STATES as readonly string[]).includes(s)) sched.flash(s as FlashState, now);
    else if ((ACTIVITY_STATES as readonly string[]).includes(s)) sched.setTarget(s as ActivityState, now);
    else {
      // long-idle stage: pretend we've been idle long enough
      sched.setTarget('idle', now - cfg.idleStageAfterMs - cfg.idleStageCycleMs * IDLE_STAGES.indexOf(s as (typeof IDLE_STAGES)[number]));
    }
    log(`forced ${s}`);
  };

  const previewHtmlPath = join(repoRoot(), 'web', 'index.html');
  const server = startServer(
    cfg.port,
    cfg.host,
    {
      onEvent,
      onForce,
      anims: () => anims,
      status: () => ({
        current: sched.current,
        pending: sched.pending,
        forced,
        sessions: Object.fromEntries([...reducer.sessions].map(([k, v]) => [k, v])),
        device: { label: device.label, connected: device.connected, pushes: device.pushes, lastError: device.lastError },
        uptimeSec: Math.round(process.uptime()),
      }),
      previewHtmlPath,
    },
    log,
  );

  // Show idle right away so the panel is never blank.
  device
    .show('idle')
    .then(() => sched.shown('idle', Date.now()))
    .catch((e) => debug(`initial show failed: ${(e as Error).message}`));

  // A display hiccup must never take the daemon (and the hooks' endpoint) down.
  process.on('unhandledRejection', (e) => log(`unhandled rejection: ${(e as Error)?.message ?? e}`));
  process.on('uncaughtException', (e) => log(`uncaught exception: ${e.message}`));

  let busy = false;
  setInterval(async () => {
    const now = Date.now();
    const dropped = reducer.prune(now, cfg.sessionTtlMs);
    if (dropped.length) {
      log(`dropped stale sessions: ${dropped.join(', ')}`);
      sched.setTarget(reducer.aggregate(), now);
    }
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
  }, 100);

  let stopping = false;
  const shutdown = () => {
    if (stopping) process.exit(1);
    stopping = true;
    log('shutting down');
    device.close();
    server.close();
    // give the bridge a moment to drop the BLE link cleanly, then go
    setTimeout(() => process.exit(0), 400).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
