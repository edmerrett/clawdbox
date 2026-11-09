/**
 * Owns the link to the Evo: reconnects with backoff, paces writes under the
 * device's message-rate limit, and pushes pre-encoded animations.
 */
import { Anim, State } from '../anim/types.js';
import { encodeAnimation, encodeBrightness, MAX_MSGS_PER_SEC } from '../protocol/divoom.js';
import { Link } from './link.js';
import { Display } from './display.js';

export interface DeviceOptions {
  brightness?: number;
  log?: (msg: string) => void;
  /** Chatty details (prepared sizes, raw replies); defaults to silent. */
  debug?: (msg: string) => void;
}

export class Device implements Display {
  get label(): string {
    return this.link.label;
  }
  private encoded = new Map<State, Buffer[]>();
  private queue: Promise<void> = Promise.resolve();
  private connecting: Promise<void> | null = null;
  private backoffMs = 1000;
  private closed = false;
  private readonly log: (msg: string) => void;
  private readonly debug: (msg: string) => void;
  /** Incremented on every successful push; lets the UI show device status. */
  pushes = 0;
  onReconnect?: () => void;
  private everConnected = false;
  /** A stalled write must not block the queue forever. */
  writeTimeoutMs = 10_000;
  /** Messages received from the box; proof it is parsing what we send. */
  replies = 0;
  lastError: string | null = null;
  /** Pause after connect before the first write; the box drops bytes sent too early. */
  settleMs = 500;

  constructor(
    private readonly link: Link,
    private readonly opts: DeviceOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.debug = opts.debug ?? (() => {});
    link.on('data', (buf: Buffer) => {
      if (!buf.length) return; // the library emits an empty buffer on close
      this.replies++;
      this.debug(`reply: ${buf.toString('hex')}`);
    });
    link.on('closed', (err?: Error) => {
      if (this.closed) return; // we hung up on purpose
      this.lastError = err?.message ?? 'link closed';
      this.log(`link closed${err ? `: ${err.message}` : ''}; will reconnect`);
    });
  }

  /** Encode every animation once so a state change is just a series of writes. */
  prepare(anims: Record<State, Anim>): void {
    for (const [state, anim] of Object.entries(anims) as [State, Anim][]) {
      const msgs = encodeAnimation(anim);
      this.encoded.set(state, msgs);
      const bytes = msgs.reduce((n, m) => n + m.length, 0);
      this.debug(`prepared ${state}: ${anim.frames.length} frames, ${msgs.length} msgs, ${bytes} bytes`);
    }
  }

  get connected(): boolean {
    return this.link.open;
  }

  async ensureConnected(): Promise<void> {
    if (this.link.open) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      while (!this.closed && !this.link.open) {
        try {
          this.log(`connecting to ${this.link.label}...`);
          await this.link.connect();
          if (this.closed) {
            this.link.close();
            return;
          }
          this.backoffMs = 1000;
          this.lastError = null;
          this.log('connected');
          const wasDrop = this.everConnected;
          this.everConnected = true;
          await sleep(this.settleMs);
          try {
            if (this.opts.brightness !== undefined) await this.rawWrite([encodeBrightness(this.opts.brightness)]);
          } catch (e) {
            // a failed first write means the link is not really usable: drop it and retry
            this.log(`first write failed (${(e as Error).message}); reconnecting`);
            this.link.close();
            continue;
          }
          if (wasDrop) this.onReconnect?.();
        } catch (e) {
          this.lastError = (e as Error).message;
          this.log(`connect failed: ${this.lastError}; retry in ${this.backoffMs / 1000}s`);
          await sleep(this.backoffMs);
          this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
        }
      }
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Show a state. Serialised: a new request waits for the previous push to finish. */
  show(state: State): Promise<void> {
    const msgs = this.encoded.get(state);
    if (!msgs) return Promise.reject(new Error(`no animation prepared for ${state}`));
    const run = this.queue.then(() => this.push(state, msgs));
    this.queue = run.catch(() => {});
    return run;
  }

  private async push(state: State, msgs: Buffer[]): Promise<void> {
    await this.ensureConnected();
    if (this.closed) return;
    try {
      await this.rawWrite(msgs);
      this.pushes++;
      this.log(`showing ${state}`);
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log(`write failed: ${this.lastError}`);
      this.link.close();
      throw e;
    }
  }

  private async rawWrite(msgs: Buffer[]): Promise<void> {
    const gap = Math.ceil(1000 / MAX_MSGS_PER_SEC);
    for (let i = 0; i < msgs.length; i++) {
      await withTimeout(this.link.write(msgs[i]), this.writeTimeoutMs, 'write timed out');
      if (i < msgs.length - 1) await sleep(gap);
    }
  }

  async setBrightness(percent: number): Promise<void> {
    await this.ensureConnected();
    await this.rawWrite([encodeBrightness(percent)]);
  }

  /** Send arbitrary pre-encoded messages (diagnostics). */
  async send(msgs: Buffer[]): Promise<void> {
    await this.ensureConnected();
    await this.rawWrite(msgs);
  }

  close(): void {
    this.closed = true;
    this.link.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(why)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
