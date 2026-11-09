/**
 * Local HTTP endpoint. Claude Code hooks POST their JSON here. Also serves the
 * browser previewer and a small status/control API.
 *
 *   POST /event          hook body (JSON object)  -> 204
 *   GET  /state          {current, pending, sessions, device, transport}
 *   GET  /anims          all animations as palette-index JSON (for the previewer)
 *   POST /show/<state>   force a state until the next hook event (testing)
 *   GET  /               previewer page
 *
 * Loopback only. Requests that carry an Origin header from anywhere but this
 * server are refused, so a web page in the user's browser cannot forge events.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { Anim, State, isState, toAnimFile } from '../anim/types.js';
import { HookEvent } from './reducer.js';

export interface ServerDeps {
  onEvent(ev: HookEvent): void;
  onForce(state: State): void;
  status(): unknown;
  anims(): Record<State, Anim>;
  previewHtmlPath: string;
}

export class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
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

function originAllowed(req: IncomingMessage, host: string, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl, http hooks, same-origin fetches without Origin
  return origin === `http://${host}:${port}` || origin === `http://localhost:${port}`;
}

function boundPort(server: ReturnType<typeof createServer>, fallback: number): number {
  const a = server.address();
  return a && typeof a === 'object' ? a.port : fallback;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export function startServer(port: number, host: string, deps: ServerDeps, log: (m: string) => void) {
  let animsJson: string | null = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'POST' && !originAllowed(req, host, boundPort(server, port))) {
        res.writeHead(403).end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/event') {
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
        res.writeHead(200, { 'content-type': 'application/json' }).end(animsJson);
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/show/')) {
        const s = url.pathname.slice('/show/'.length);
        if (!isState(s)) return json(res, 400, { error: `unknown state ${s}` });
        deps.onForce(s);
        return json(res, 200, { ok: true, state: s });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(deps.previewHtmlPath));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      res.writeHead(404).end();
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        // answer first so the client sees 413, then drop whatever is still arriving
        if (!res.headersSent) res.writeHead(413, { connection: 'close' }).end();
        res.once('finish', () => req.destroy());
        return;
      }
      log(`http error: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nport ${port} is already in use: another clawdbox daemon is probably running.`);
      console.error(`stop it with:  pkill -f "cli.js daemon"      (or pass --port to run a second one)\n`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, host, () => log(`listening on http://${host}:${port}`));
  return server;
}
