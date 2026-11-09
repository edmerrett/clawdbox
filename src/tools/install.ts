/**
 * Installers: merge hooks into ~/.claude/settings.json and write a launchd agent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOOK_EVENTS_WITH_MATCHER = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'];
export const HOOK_EVENTS_PLAIN = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
export const MARKER = 'clawdbox';

type Handler = Record<string, unknown>;

export function hookHandler(url: string, mode: 'command' | 'http'): Handler {
  if (mode === 'http') {
    // Awaited by Claude Code; a dead daemon shows a non-blocking error on each event.
    return { type: 'http', url, timeout: 2, statusMessage: MARKER };
  }
  // Fire-and-forget: async command, exits 0 whatever happens, output discarded.
  return {
    type: 'command',
    command: `curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- ${url} >/dev/null 2>&1 || true`,
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
  return Array.isArray(g?.hooks) && g.hooks.some((h) => h.statusMessage === MARKER || (typeof h.command === 'string' && h.command.includes('7676/event')) || (typeof h.url === 'string' && h.url.endsWith('/event') && h.statusMessage === MARKER));
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

export function installHooks(url: string, mode: 'command' | 'http', path = settingsPath()): void {
  mkdirSync(join(path, '..'), { recursive: true });
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    copyFileSync(path, `${path}.clawdbox.bak`);
    settings = JSON.parse(readFileSync(path, 'utf8'));
  }
  const merged = mergeHooks(settings, buildHooks(url, mode));
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n');
}

export function uninstallHooks(path = settingsPath()): void {
  if (!existsSync(path)) return;
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify(removeHooks(settings), null, 2) + '\n');
}

/* ---------- launchd ---------- */

export const LAUNCHD_LABEL = 'com.clawdbox.daemon';

export function launchdPlist(opts: { node: string; cli: string; args: string[]; logDir: string; cwd: string }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const argv = [opts.node, opts.cli, 'daemon', ...opts.args].map((a) => `      <string>${esc(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argv}
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
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
  </dict>
</plist>
`;
}

export function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}
