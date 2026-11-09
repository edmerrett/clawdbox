/**
 * Drives the newer TimeBox-Evo-audio / Backpack M generation over Bluetooth Low
 * Energy by spawning bridge/clawdbox_ble.py (which uses the divoom-protocol
 * package) and talking JSON lines to it. Each request carries an id that the
 * bridge echoes back, so replies are matched exactly and status events (connect
 * retries, logs) can never be mistaken for answers.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Anim, State } from '../anim/types.js';
import { Display } from './display.js';

export type BleMode = 'upload' | 'stream' | 'slots';

const RESTART_MIN_MS = 2000;
const RESTART_MAX_MS = 30_000;
const PRELOAD_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 60_000;
const CONNECT_WAIT_MS = 150_000;
const SIGKILL_AFTER_MS = 3000;

export interface BleOptions {
  address?: string;
  mode?: BleMode;
  /** slots mode: hex bytes sent before the slot number (default 4505). */
  select?: string;
  brightness?: number;
  python?: string;
  /** Path to the bridge script (default bridge/clawdbox_ble.py under repoRoot). */
  bridgeScript?: string;
  /** Extra environment for the bridge process (tests use this). */
  env?: Record<string, string>;
  repoRoot: string;
  log?: (m: string) => void;
  /** Chatty details (prepared sizes); defaults to silent. */
  debug?: (m: string) => void;
  /** Per-request timeout. Shows wait for the link first, so this only covers the op itself. */
  requestTimeoutMs?: number;
}

/** Prefer the repo's venv, then whatever python3 is on PATH. */
export function resolvePython(repoRoot: string, explicit?: string): string {
  if (explicit) return explicit;
  const venv = join(repoRoot, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

interface BridgeEvent {
  ev: string;
  /** Request id this event answers, when it is a reply. */
  id?: number;
  /** Which op it answers. */
  re?: string;
  message?: string;
  address?: string;
  fatal?: boolean;
  [k: string]: unknown;
}

interface Waiter {
  id: number;
  resolve: (ev: BridgeEvent) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class BleDisplay implements Display {
  readonly label: string;
  connected = false;
  pushes = 0;
  lastError: string | null = null;
  onReconnect?: () => void;

  private anims: Record<State, Anim> | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private waiters = new Map<number, Waiter>();
  private nextId = 1;
  /** Serialises shows. Always settles fulfilled so one failure cannot poison later shows. */
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  /** The bridge said it can never work (deps missing); distinct from the user closing the display. */
  private fatal = false;
  private restartMs = RESTART_MIN_MS;
  private restartTimer: NodeJS.Timeout | null = null;
  private everConnected = false;
  private preloading = false;
  private preloaded = false;
  private readonly log: (m: string) => void;
  private readonly debug: (m: string) => void;
  private readonly requestTimeoutMs: number;

  constructor(private readonly opts: BleOptions) {
    this.log = opts.log ?? (() => {});
    this.debug = opts.debug ?? (() => {});
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.label = `ble ${opts.address ?? '(scan)'} via ${opts.mode ?? 'stream'}`;
  }

  prepare(anims: Record<State, Anim>): void {
    this.anims = anims;
    for (const [s, a] of Object.entries(anims)) this.debug(`prepared ${s}: ${a.frames.length} frames`);
  }

  private start(): void {
    if (this.proc || this.closed || this.fatal || this.restartTimer) return;
    const python = resolvePython(this.opts.repoRoot, this.opts.python);
    const script = this.opts.bridgeScript ?? join(this.opts.repoRoot, 'bridge', 'clawdbox_ble.py');
    const args = [script, '--mode', this.opts.mode ?? 'stream'];
    if (this.opts.address) args.push('--address', this.opts.address);
    if (this.opts.brightness !== undefined) args.push('--brightness', String(this.opts.brightness));
    if (this.opts.select) args.push('--select', this.opts.select);
    this.log(`starting bridge: ${python} ${args.join(' ')}`);
    const proc = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.opts.env } });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: proc.stderr }).on('line', (line) => this.log(`bridge stderr: ${line}`));
    proc.on('error', (err) => {
      this.lastError = err.message;
      this.log(`bridge could not start: ${err.message}`);
    });
    proc.stdin.on('error', (err) => this.debug(`bridge stdin: ${err.message}`));
    proc.on('exit', (code, signal) => {
      this.proc = null;
      this.connected = false;
      this.preloaded = false;
      this.failAll(new Error(`bridge exited (${code ?? signal})`));
      if (this.closed || this.fatal) return;
      this.log(`bridge exited with code ${code ?? signal}; restarting in ${this.restartMs / 1000}s`);
      // a pending request must not respawn early: start() is a no-op while this timer runs
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, this.restartMs);
      this.restartTimer.unref();
      this.restartMs = Math.min(this.restartMs * 2, RESTART_MAX_MS);
    });
  }

  private failAll(err: Error): void {
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters.clear();
  }

  private onLine(line: string): void {
    let ev: BridgeEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      this.log(`bridge: ${line}`);
      return;
    }
    switch (ev.ev) {
      case 'log':
        this.log(`bridge: ${ev.message}`);
        break;
      case 'connected': {
        const wasDrop = this.everConnected;
        this.connected = true;
        this.everConnected = true;
        this.lastError = null;
        this.restartMs = RESTART_MIN_MS;
        this.log(`bridge connected to ${ev.address}`);
        if (this.opts.mode === 'slots') this.preloadSlots(wasDrop);
        else if (wasDrop) this.onReconnect?.();
        break;
      }
      case 'error':
        if (!ev.re) {
          // status (connect retry etc.), not a reply
          this.lastError = ev.message ?? 'error';
          this.log(`bridge error: ${ev.message}`);
          if (ev.fatal) {
            this.fatal = true;
            this.log('the bridge cannot run until its dependencies are installed; restart the daemon afterwards');
          }
        }
        break;
    }
    if (typeof ev.id === 'number') {
      const w = this.waiters.get(ev.id);
      if (w) {
        this.waiters.delete(ev.id);
        clearTimeout(w.timer);
        if (ev.ev === 'error') w.reject(new Error(ev.message ?? 'bridge error'));
        else w.resolve(ev);
      }
    }
  }

  private preloadSlots(wasDrop: boolean): void {
    if (!this.anims || this.preloading) return;
    this.preloading = true;
    const anims = Object.entries(this.anims).map(([name, a]) => ({ name, frames: a.frames.map((f) => ({ ms: f.ms, pixels: f.pixels })) }));
    this.request({ op: 'preload', anims }, PRELOAD_TIMEOUT_MS)
      .then((r) => {
        this.preloaded = true;
        this.log(`preloaded slots: ${JSON.stringify(r.slots)}`);
        if (wasDrop) this.onReconnect?.();
      })
      .catch((e) => this.log(`preload failed: ${(e as Error).message}`))
      .finally(() => {
        this.preloading = false;
      });
  }

  private request(msg: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<BridgeEvent> {
    this.start();
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error(this.lastError ?? (this.restartTimer ? 'bridge restarting' : 'bridge not running')));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`bridge did not answer ${String(msg.op)} within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.waiters.set(id, { id, resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, ...msg }) + '\n');
    });
  }

  show(state: State): Promise<void> {
    const anim = this.anims?.[state];
    if (!anim) return Promise.reject(new Error(`no animation prepared for ${state}`));
    const msg =
      this.opts.mode === 'slots'
        ? { op: 'play', name: state }
        : { op: 'anim', name: state, frames: anim.frames.map((f) => ({ ms: f.ms, pixels: f.pixels })) };
    const run = this.queue.then(async () => {
      if (this.opts.mode === 'slots') await this.waitFor(() => this.preloaded, 'slots were not preloaded in time');
      else await this.waitFor(() => this.connected, 'bridge did not connect in time');
      const ev = await this.request(msg);
      this.pushes++;
      this.log(
        `showing ${state}${ev.seconds ? ` (${ev.seconds}s upload)` : ''}${ev.slot !== undefined ? ` (slot ${ev.slot}, sent ${ev.payload})` : ''}`,
      );
    });
    // The chain itself never rejects; the caller gets this call's own outcome.
    this.queue = run.catch((e) => {
      this.lastError = (e as Error).message;
      this.log(`show ${state} failed: ${this.lastError}`);
    });
    return run;
  }

  async setBrightness(percent: number): Promise<void> {
    await this.waitFor(() => this.connected, 'bridge did not connect in time');
    await this.request({ op: 'brightness', value: Math.max(0, Math.min(100, Math.round(percent))) });
  }

  /** Make sure the bridge is up and connected (waits for the first connected event). */
  ensureConnected(timeoutMs = CONNECT_WAIT_MS): Promise<void> {
    return this.waitFor(() => this.connected, 'bridge did not connect in time', timeoutMs);
  }

  private async waitFor(cond: () => boolean, why: string, timeoutMs = CONNECT_WAIT_MS): Promise<void> {
    this.start();
    const t0 = Date.now();
    while (!cond()) {
      if (this.closed || this.fatal) throw new Error(this.lastError ?? 'bridge closed');
      if (Date.now() - t0 > timeoutMs) throw new Error(why);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Ask the bridge to stop; it disconnects the panel cleanly on SIGTERM. SIGKILL only if it hangs. */
  close(): void {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const proc = this.proc;
    if (!proc) return;
    this.failAll(new Error('display closed'));
    try {
      proc.stdin.end();
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, SIGKILL_AFTER_MS).unref();
  }
}
