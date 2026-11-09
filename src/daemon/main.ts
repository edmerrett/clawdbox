import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Anim, State, loopMs } from '../anim/types.js';
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
  python?: string;
  channel?: number;
  mock: boolean;
  port: number;
  host: string;
  animsDir?: string;
  brightness?: number;
  minHoldMs: number;
  idleAfterMs: number;
  sessionTtlMs: number;
  verbose: boolean;
}

export const DEFAULT_CONFIG: DaemonConfig = {
  mock: false,
  port: 7676,
  host: '127.0.0.1',
  minHoldMs: DEFAULT_SCHEDULER.minHoldMs,
  idleAfterMs: DEFAULT_SCHEDULER.idleAfterMs,
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
    device = new BleDisplay({ address: cfg.bleAddress, mode: cfg.bleMode, brightness: cfg.brightness, python: cfg.python, repoRoot: repoRoot(), log });
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

  const reducer = new Reducer();
  const sched = new Scheduler({
    minHoldMs: cfg.minHoldMs,
    idleAfterMs: cfg.idleAfterMs,
    maxBoundaryWaitMs: DEFAULT_SCHEDULER.maxBoundaryWaitMs,
    loopMs: Object.fromEntries(Object.entries(anims).map(([k, a]) => [k, loopMs(a)])) as Record<State, number>,
  });

  let forced: State | null = null;
  const onEvent = (ev: HookEvent) => {
    const action = reducer.apply(ev);
    forced = null;
    debug(`event ${ev.hook_event_name ?? '?'} ${ev.tool_name ?? ''} ${ev.notification_type ?? ''} -> ${JSON.stringify(action)} agg=${reducer.aggregate()}`);
    sched.setTarget(reducer.aggregate(), Date.now());
  };
  const onForce = (s: State) => {
    forced = s;
    sched.setTarget(s, Date.now());
    log(`forced ${s}`);
  };

  const previewHtmlPath = join(repoRoot(), 'web', 'index.html');
  startServer(
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
  void device.show('idle').then(() => sched.shown('idle', Date.now()));

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

  const shutdown = () => {
    log('shutting down');
    device.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
