/**
 * Drives the newer TimeBox-Evo-audio / Backpack M generation over Bluetooth Low
 * Energy by spawning bridge/clawdbox_ble.py (which uses the divoom-protocol
 * package) and talking JSON lines to it.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Anim, State } from '../anim/types.js';
import { Display } from './display.js';

export interface BleOptions {
  address?: string;
  mode?: 'upload' | 'stream';
  brightness?: number;
  python?: string;
  repoRoot: string;
  log?: (m: string) => void;
}

/** Prefer the repo's venv, then whatever python3 is on PATH. */
export function resolvePython(repoRoot: string, explicit?: string): string {
  if (explicit) return explicit;
  const venv = join(repoRoot, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

interface BridgeEvent {
  ev: string;
  message?: string;
  name?: string;
  address?: string;
  fatal?: boolean;
  [k: string]: unknown;
}

export class BleDisplay implements Display {
  readonly label: string;
  connected = false;
  pushes = 0;
  lastError: string | null = null;
  private anims: Record<State, Anim> | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private waiters: ((ev: BridgeEvent) => void)[] = [];
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private restartMs = 2000;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: BleOptions) {
    this.log = opts.log ?? (() => {});
    this.label = `ble ${opts.address ?? '(scan)'} via ${opts.mode ?? 'upload'}`;
  }

  prepare(anims: Record<State, Anim>): void {
    this.anims = anims;
    for (const [s, a] of Object.entries(anims)) this.log(`prepared ${s}: ${a.frames.length} frames`);
  }

  private start(): void {
    if (this.proc || this.closed) return;
    const python = resolvePython(this.opts.repoRoot, this.opts.python);
    const script = join(this.opts.repoRoot, 'bridge', 'clawdbox_ble.py');
    const args = [script, '--mode', this.opts.mode ?? 'upload'];
    if (this.opts.address) args.push('--address', this.opts.address);
    if (this.opts.brightness !== undefined) args.push('--brightness', String(this.opts.brightness));
    this.log(`starting bridge: ${python} ${args.join(' ')}`);
    const proc = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: proc.stderr }).on('line', (line) => this.log(`bridge stderr: ${line}`));
    proc.on('exit', (code) => {
      this.proc = null;
      this.connected = false;
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w({ ev: 'error', message: `bridge exited (${code})` });
      if (this.closed) return;
      this.log(`bridge exited with code ${code}; restarting in ${this.restartMs / 1000}s`);
      setTimeout(() => this.start(), this.restartMs);
      this.restartMs = Math.min(this.restartMs * 2, 30_000);
    });
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
      case 'connected':
        this.connected = true;
        this.lastError = null;
        this.restartMs = 2000;
        this.log(`bridge connected to ${ev.address}`);
        break;
      case 'error':
        this.lastError = ev.message ?? 'error';
        this.log(`bridge error: ${ev.message}`);
        if (ev.fatal) this.closed = true;
        break;
    }
    if (ev.ev === 'shown' || ev.ev === 'error' || ev.ev === 'brightness' || ev.ev === 'pong') {
      const w = this.waiters.shift();
      if (w) w(ev);
    }
  }

  private request(msg: object, timeoutMs = 60_000): Promise<BridgeEvent> {
    this.start();
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('bridge not running'));
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(new Error('bridge timed out'));
      }, timeoutMs);
      const done = (ev: BridgeEvent) => {
        clearTimeout(t);
        if (ev.ev === 'error') reject(new Error(ev.message));
        else resolve(ev);
      };
      this.waiters.push(done);
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  show(state: State): Promise<void> {
    const anim = this.anims?.[state];
    if (!anim) return Promise.reject(new Error(`no animation prepared for ${state}`));
    const msg = { op: 'anim', name: state, frames: anim.frames.map((f) => ({ ms: f.ms, pixels: f.pixels })) };
    this.queue = this.queue
      .then(async () => {
        const ev = await this.request(msg);
        this.pushes++;
        this.log(`showing ${state}${ev.seconds ? ` (${ev.seconds}s upload)` : ''}`);
      })
      .catch((e) => {
        this.lastError = (e as Error).message;
        this.log(`show ${state} failed: ${this.lastError}`);
        throw e;
      });
    return this.queue;
  }

  async setBrightness(percent: number): Promise<void> {
    await this.request({ op: 'brightness', value: Math.max(0, Math.min(100, Math.round(percent))) });
  }

  /** Make sure the bridge is up and connected (waits for the first connected event). */
  async ensureConnected(timeoutMs = 90_000): Promise<void> {
    this.start();
    const t0 = Date.now();
    while (!this.connected && !this.closed) {
      if (Date.now() - t0 > timeoutMs) throw new Error('bridge did not connect in time');
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.closed) throw new Error(this.lastError ?? 'bridge closed');
  }

  close(): void {
    this.closed = true;
    this.proc?.stdin.end();
    setTimeout(() => this.proc?.kill(), 1500);
  }
}
