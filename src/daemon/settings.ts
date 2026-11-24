/**
 * Settings the user changes at runtime (from the menu bar or the CLI) and that must survive a
 * restart or an update. A small JSON file in the user's own application-support folder.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Settings {
  /** Seasonal art replaces the standard idle view (see src/anim/themes.ts). */
  themes: boolean;
}

export const DEFAULT_SETTINGS: Settings = { themes: false };

export function defaultSettingsPath(): string {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'clawdbox')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'clawdbox');
  return join(base, 'settings.json');
}

/** Read the settings; a missing or unreadable file, or a bad field, falls back to the default. */
export function loadSettings(path: string): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { themes: typeof o.themes === 'boolean' ? o.themes : DEFAULT_SETTINGS.themes };
}

/** Write atomically (temp file + rename), folder 0700, file 0600. */
export function saveSettings(path: string, s: Settings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
