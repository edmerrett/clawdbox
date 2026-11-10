/**
 * Local HTTP endpoints.
 *
 * Hook events arrive on a Unix domain socket (mode 0600) so that no other local
 * process can squat the port and capture prompts/tool inputs:
 *   POST /event          hook body (JSON object) -> 204
 *
 * A loopback TCP port serves the UIs:
 *   GET  /state          {current, pending, sessions, device, transport, update}
 *   GET  /anims          all animations as palette-index JSON (for the previewer)
 *   POST /show/<state>   force a state until the next hook event (testing)
 *        ?hold=1         ...or until released, whatever the hooks say
 *   POST /release        release a forced state; the panel follows the hooks again
 *   POST /update-check   look for a newer release now -> the update part of /state
 *   GET  /               previewer page
 *   POST /event          only when `tcpEvents` is enabled (Claude Code's native http hooks)
 *
 * Every request must carry a loopback Host header (defeats DNS rebinding), POSTs
 * must not carry a foreign Origin (defeats browser forgery), bodies are capped.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { Anim, State, isState, toAnimFile } from '../anim/types.js';
import { HookEvent } from './reducer.js';

export interface ServerDeps {
  onEvent(ev: HookEvent): void;
  onForce(state: State, hold?: boolean): void;
  onRelease(): void;
  checkUpdates(): Promise<unknown>;
  status(): unknown;
  anims(): Record<State, Anim>;
  previewHtmlPath: string;
}

export interface ServerOptions {
  port: number;
  host: string;
  /** Unix socket path for hook events; omit to disable. */
  socketPath?: string;
  /** Accept POST /event over TCP too (needed for Claude Code's `http` hook type). */
  tcpEvents?: boolean;
  log: (m: string) => void;
}

export class BodyTooLarge extends Error {}

const BODY_LIMIT = 1_000_000;
const MAX_CONNECTIONS = 64;
const REQUEST_TIMEOUT_MS = 10_000;

function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.pause();
        finish(() => reject(new BodyTooLarge('body too large')));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', (e) => finish(() => reject(e)));
    req.on('close', () => finish(() => reject(new Error('connection closed'))));
  });
}

/** A hook body must be a JSON object whose interesting fields, if present, are strings. */
export function parseHookEvent(raw: string): HookEvent | null {
  let v: unknown;
  try {
    v = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const k of ['hook_event_name', 'session_id', 'tool_name', 'notification_type', 'agent_id', 'prompt', 'source', 'reason']) {
    if (o[k] !== undefined && typeof o[k] !== 'string') return null;
  }
  return o as HookEvent;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Host must name this machine's loopback (a rebinding page's Host names the attacker's domain). */
export function hostAllowed(hostHeader: string | undefined, port: number, viaSocket: boolean): boolean {
  if (viaSocket) return true; // curl --unix-socket sends "localhost"; nothing else can reach the socket
  if (!hostHeader) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader);
  if (!m) return false;
  const [, name, p] = m;
  return LOOPBACK_HOSTS.has(name) && (p === undefined || Number(p) === port);
}

export function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // curl, http hooks, same-origin fetches without Origin
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), 'cache-control': 'no-store' });
  res.end(s);
}

/** Remove a stale socket file, but never one something is still listening on. */
async function clearStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const alive = await new Promise<boolean>((resolve) => {
    const c = connect(path);
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
  if (alive) throw new Error(`another clawdbox daemon is listening on ${path}`);
  unlinkSync(path);
}

export interface Servers {
  tcp: Server;
  socket: Server | null;
  close(): void;
}

export async function startServers(opts: ServerOptions, deps: ServerDeps): Promise<Servers> {
  let animsJson: string | null = null;
  let boundPort = opts.port;

  const handler = (viaSocket: boolean) => async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!hostAllowed(req.headers.host, boundPort, viaSocket)) {
        res.writeHead(421).end();
        return;
      }
      if (req.method === 'POST' && !viaSocket && !originAllowed(req.headers.origin, boundPort)) {
        res.writeHead(403).end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/event') {
        if (!viaSocket && !opts.tcpEvents) {
          res.writeHead(404).end();
          return;
        }
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
          res.writeHead(415).end();
          return;
        }
        const ev = parseHookEvent(await readBody(req));
        if (!ev) {
          res.writeHead(400).end();
          return;
        }
        deps.onEvent(ev);
        // Empty 2xx: Claude Code treats a text body as a non-blocking error.
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/state') return json(res, 200, deps.status());
      if (req.method === 'GET' && url.pathname === '/anims') {
        animsJson ??= JSON.stringify(Object.fromEntries(Object.entries(deps.anims()).map(([k, a]) => [k, toAnimFile(a)])));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(animsJson);
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/show/')) {
        const s = url.pathname.slice('/show/'.length);
        if (!isState(s)) return json(res, 400, { error: `unknown state ${s}` });
        const hold = url.searchParams.get('hold') === '1';
        deps.onForce(s, hold);
        return json(res, 200, { ok: true, state: s, held: hold });
      }
      if (req.method === 'POST' && url.pathname === '/release') {
        deps.onRelease();
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/update-check') return json(res, 200, await deps.checkUpdates());
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res
          .writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy':
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
          })
          .end(readFileSync(deps.previewHtmlPath));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      res.writeHead(404).end();
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        if (!res.headersSent) res.writeHead(413, { connection: 'close' }).end();
        res.once('finish', () => req.destroy());
        return;
      }
      opts.log(`http error: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  };

  const harden = (s: Server) => {
    s.maxConnections = MAX_CONNECTIONS;
    s.requestTimeout = REQUEST_TIMEOUT_MS;
    s.headersTimeout = REQUEST_TIMEOUT_MS;
  };

  const tcp = createServer(handler(false));
  harden(tcp);
  await listenWithRetry(tcp, () => tcp.listen(opts.port, opts.host), opts.log, `${opts.host}:${opts.port}`);
  const addr = tcp.address();
  if (addr && typeof addr === 'object') boundPort = addr.port;
  opts.log(`listening on http://${opts.host}:${boundPort}`);

  let socket: Server | null = null;
  if (opts.socketPath) {
    mkdirSync(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
    await clearStaleSocket(opts.socketPath);
    socket = createServer(handler(true));
    harden(socket);
    await new Promise<void>((resolve, reject) => {
      socket!.once('error', reject);
      socket!.listen(opts.socketPath, () => resolve());
    });
    chmodSync(opts.socketPath, 0o600);
    opts.log(`hook socket at ${opts.socketPath}`);
  }

  return {
    tcp,
    socket,
    close() {
      tcp.close();
      socket?.close();
      if (opts.socketPath) {
        try {
          unlinkSync(opts.socketPath);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/** Bind, retrying with backoff while the port is held by someone else (never exit on EADDRINUSE). */
async function listenWithRetry(server: Server, bind: () => void, log: (m: string) => void, what: string): Promise<void> {
  let delay = 1000;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: NodeJS.ErrnoException) => {
          server.off('listening', onOk);
          reject(e);
        };
        const onOk = () => {
          server.off('error', onErr);
          resolve();
        };
        server.once('error', onErr);
        server.once('listening', onOk);
        bind();
      });
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EADDRINUSE') throw err;
      log(`${what} is in use (another clawdbox daemon, or something else?); retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

/** Legacy helper kept for tests: start the TCP server only. */
export function startServer(port: number, host: string, deps: ServerDeps, log: (m: string) => void): Promise<Servers> {
  return startServers({ port, host, tcpEvents: true, log }, deps);
}
