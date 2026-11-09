/**
 * Local HTTP endpoint. Claude Code hooks POST their JSON here. Also serves the
 * browser previewer and a small status/control API.
 *
 *   POST /event          hook body (JSON)  -> 204
 *   GET  /state          {current, pending, sessions, device}
 *   GET  /anims          all animations as palette-index JSON (for the previewer)
 *   POST /show/<state>   force a state (testing); ?hold=1 keeps it until the next event
 *   GET  /               previewer page
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

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
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
      if (req.method === 'POST' && url.pathname === '/event') {
        const raw = await readBody(req);
        let ev: HookEvent = {};
        if (raw.trim()) {
          try {
            ev = JSON.parse(raw);
          } catch {
            res.writeHead(400).end();
            return;
          }
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
