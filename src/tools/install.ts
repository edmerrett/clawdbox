/**
 * Installers: merge hooks into ~/.claude/settings.json and write a launchd agent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOOK_EVENTS_WITH_MATCHER = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'];
export const HOOK_EVENTS_PLAIN = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
export const MARKER = 'clawdbox';

type Handler = Record<string, unknown>;

/** The daemon URL must be a plain http URL; it is embedded in a shell command Claude Code runs. */
export function validateDaemonUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a valid URL: ${url}`);
  }
  if (u.protocol !== 'http:') throw new Error(`daemon URL must be http://, got ${u.protocol}`);
  if (!/^[A-Za-z0-9.:/_-]+$/.test(u.href)) throw new Error(`daemon URL has characters that are not allowed: ${url}`);
  return u.href;
}

export function hookHandler(url: string, mode: 'command' | 'http'): Handler {
  url = validateDaemonUrl(url);
  if (mode === 'http') {
    // Awaited by Claude Code; a dead daemon shows a non-blocking error on each event.
    return { type: 'http', url, timeout: 2, statusMessage: MARKER };
  }
  // Fire-and-forget: async command, exits 0 whatever happens, output discarded.
  return {
    type: 'command',
    command: `curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- '${url}' >/dev/null 2>&1 || true`,
    async: true,
    timeout: 5,
    statusMessage: MARKER,
  };
}

export function buildHooks(url: string, mode: 'command' | 'http'): Record<string, unknown[]> {
  const h = hookHandler(url, mode);
  const out: Record<string, unknown[]> = {};
  for (const ev of HOOK_EVENTS_WITH_MATCHER) out[ev] = [{ matcher: '*', hooks: [h] }];
  for (const ev of HOOK_EVENTS_PLAIN) out[ev] = [{ hooks: [h] }];
  return out;
}

function isOurs(group: unknown): boolean {
  const g = group as { hooks?: Handler[] };
  return (
    Array.isArray(g?.hooks) &&
    g.hooks.some(
      (h) =>
        h.statusMessage === MARKER ||
        (typeof h.command === 'string' && h.command.includes('7676/event')) ||
        (typeof h.url === 'string' && h.url.endsWith('/event') && h.statusMessage === MARKER),
    )
  );
}

/** Merge our hooks into an existing settings object, replacing earlier clawdbox entries only. */
export function mergeHooks(settings: Record<string, unknown>, ours: Record<string, unknown[]>): Record<string, unknown> {
  const hooks = { ...((settings.hooks as Record<string, unknown[]>) ?? {}) };
  for (const [ev, groups] of Object.entries(ours)) {
    const kept = (hooks[ev] ?? []).filter((g) => !isOurs(g));
    hooks[ev] = [...kept, ...groups];
  }
  return { ...settings, hooks };
}

export function removeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = { ...((settings.hooks as Record<string, unknown[]>) ?? {}) };
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] ?? []).filter((g) => !isOurs(g));
    if (!hooks[ev].length) delete hooks[ev];
  }
  return { ...settings, hooks };
}

export function settingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  try {
    const v = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message}); fix it by hand before installing hooks`);
  }
}

/** Write via a temp file and rename so a crash never leaves a half-written settings file. */
function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.clawdbox.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, path);
}

export function installHooks(url: string, mode: 'command' | 'http', path = settingsPath()): void {
  const settings = readSettings(path);
  // keep the first pristine backup; later installs only touch our own entries
  if (existsSync(path) && !existsSync(`${path}.clawdbox.bak`)) copyFileSync(path, `${path}.clawdbox.bak`);
  writeSettings(path, mergeHooks(settings, buildHooks(url, mode)));
}

export function uninstallHooks(path = settingsPath()): void {
  if (!existsSync(path)) return;
  writeSettings(path, removeHooks(readSettings(path)));
}

/* ---------- launchd + app bundle ---------- */

export const LAUNCHD_LABEL = 'com.clawdbox.daemon';
export const APP_NAME = 'Clawdbox';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * macOS grants Bluetooth per *app*: a process whose responsible bundle has no
 * NSBluetoothAlwaysUsageDescription is killed on its first CoreBluetooth call.
 * So the launchd agent runs a minimal app bundle whose only executable is a
 * shell script that execs the daemon. TCC then prompts once for "Clawdbox".
 */
export function appBundleFiles(opts: { node: string; cli: string; args: string[]; cwd: string }): Record<string, string> {
  const script = `#!/bin/bash
# Launcher for the clawdbox daemon; lives in an app bundle so macOS lets it use Bluetooth.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
cd ${shq(opts.cwd)}
exec ${shq(opts.node)} ${shq(opts.cli)} daemon ${opts.args.map(shq).join(' ')}
`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleName</key><string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key><string>${LAUNCHD_LABEL}</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>CFBundleShortVersionString</key><string>0.1</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>clawdbox</string>
    <key>LSUIElement</key><true/>
    <key>LSBackgroundOnly</key><true/>
    <key>NSBluetoothAlwaysUsageDescription</key>
    <string>Clawdbox drives your Divoom TimeBox over Bluetooth to show what Claude Code is doing.</string>
    <key>NSBluetoothPeripheralUsageDescription</key>
    <string>Clawdbox drives your Divoom TimeBox over Bluetooth to show what Claude Code is doing.</string>
  </dict>
</plist>
`;
  return { 'Contents/Info.plist': plist, 'Contents/PkgInfo': 'APPL????', 'Contents/MacOS/clawdbox': script };
}

export function appBundlePath(): string {
  return join(homedir(), 'Applications', `${APP_NAME}.app`);
}

export function writeAppBundle(appDir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(appDir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, { mode: rel.endsWith('/clawdbox') ? 0o755 : 0o644 });
  }
}

/** launchd agent that runs the app bundle's launcher script. */
export function launchdPlist(opts: { launcher: string; logDir: string; cwd: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${esc(opts.launcher)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${esc(opts.cwd)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${esc(join(opts.logDir, 'clawdbox.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${esc(join(opts.logDir, 'clawdbox.err.log'))}</string>
    <key>ProcessType</key>
    <string>Interactive</string>
  </dict>
</plist>
`;
}

export function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/* ---------- auto-update agent ---------- */

export const UPDATER_LABEL = 'com.clawdbox.update';

export function updaterPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${UPDATER_LABEL}.plist`);
}

/** Runs scripts/update.sh on a fixed interval; it exits quickly when nothing changed. */
export function updaterPlist(opts: { script: string; logDir: string; cwd: string; intervalSec: number }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${UPDATER_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${esc(opts.script)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${esc(opts.cwd)}</string>
    <key>StartInterval</key>
    <integer>${opts.intervalSec}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${esc(join(opts.logDir, 'update.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${esc(join(opts.logDir, 'update.log'))}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
  </dict>
</plist>
`;
}
