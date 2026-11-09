/**
 * Turns raw Claude Code hook events into a per-session activity state, merges
 * all sessions into the single state the display should show, and emits short
 * "flash" reactions (wave, done, error, heart) for the scheduler to layer on top.
 */
import { ActivityState, FlashState, PRIORITY } from '../anim/types.js';

/** The subset of the hook JSON body we care about. Everything is optional on purpose. */
export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  notification_type?: string;
  agent_id?: string;
  prompt?: string;
  is_interrupt?: boolean;
  reason?: string;
  source?: string;
  [k: string]: unknown;
}

export interface ToolRule {
  /** Regex tested against tool_name (unanchored). */
  match: RegExp;
  state: ActivityState;
}

/** First matching rule wins. Anything unmatched (MCP tools etc.) counts as thinking. */
export const DEFAULT_TOOL_RULES: ToolRule[] = [
  { match: /^(Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch)$/, state: 'reading' },
  { match: /^(Edit|Write|MultiEdit|NotebookEdit)$/, state: 'writing' },
  { match: /^Bash$/, state: 'running' },
  { match: /^AskUserQuestion$/, state: 'needs-you' },
  { match: /^mcp__.*(read|get|list|search|fetch|query)/i, state: 'reading' },
  { match: /^mcp__.*(write|edit|create|update|apply)/i, state: 'writing' },
];

const NEEDS_YOU_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);

export interface ReducerOptions {
  rules?: ToolRule[];
  /** A turn must run at least this long before "done" celebrates. */
  doneAfterMs?: number;
  /** Prompt text that triggers the heart. */
  thanks?: RegExp;
  /** Prompt text that switches thinking to the rainbow variant for the turn. */
  ultra?: RegExp;
}

export interface SessionRecord {
  state: ActivityState;
  updatedAt: number;
  /** When the current turn started (UserPromptSubmit). */
  turnStartedAt?: number;
  /** The prompt asked for ultrathink; thinking shows the rainbow variant until Stop. */
  ultra: boolean;
}

export type ReducerAction =
  | { kind: 'set'; state: ActivityState }
  | { kind: 'end' }
  | { kind: 'ignore'; why: string };

export interface ReducerResult {
  action: ReducerAction;
  /** Short reaction to layer on top, if any. */
  flash?: FlashState;
}

export class Reducer {
  readonly sessions = new Map<string, SessionRecord>();
  private readonly rules: ToolRule[];
  private readonly doneAfterMs: number;
  private readonly thanks: RegExp;
  private readonly ultra: RegExp;

  constructor(opts: ReducerOptions = {}) {
    this.rules = opts.rules ?? DEFAULT_TOOL_RULES;
    this.doneAfterMs = opts.doneAfterMs ?? 10_000;
    this.thanks = opts.thanks ?? /\b(thanks?|thank you|cheers|nice one|ta)\b/i;
    this.ultra = opts.ultra ?? /ultrathink/i;
  }

  /** Apply an event. Returns what happened, for the scheduler and for logging. */
  apply(ev: HookEvent, now = Date.now()): ReducerResult {
    if (ev.agent_id) return { action: { kind: 'ignore', why: 'subagent' } };
    const id = ev.session_id ?? 'unknown';
    const rec = this.sessions.get(id);
    const set = (state: ActivityState, patch: Partial<SessionRecord> = {}): ReducerResult => {
      this.sessions.set(id, { ultra: false, ...rec, ...patch, state, updatedAt: now });
      return { action: { kind: 'set', state } };
    };
    const tool = ev.tool_name ?? '';

    switch (ev.hook_event_name) {
      case 'SessionStart':
        return { ...set('idle'), flash: ev.source === 'startup' || ev.source === undefined ? 'wave' : undefined };

      case 'UserPromptSubmit': {
        const prompt = ev.prompt ?? '';
        const ultra = this.ultra.test(prompt);
        const r = set(ultra ? 'ultrathink' : 'thinking', { turnStartedAt: now, ultra });
        if (this.thanks.test(prompt)) r.flash = 'heart';
        return r;
      }

      case 'PreToolUse': {
        const rule = this.rules.find((r) => r.match.test(tool));
        return set(rule?.state ?? this.thinkingFor(rec));
      }

      case 'PostToolUse':
      case 'PermissionDenied':
      case 'PreCompact':
      case 'PostCompact':
        return set(this.thinkingFor(rec));

      case 'PostToolUseFailure': {
        const r = set(this.thinkingFor(rec));
        if (!ev.is_interrupt) r.flash = 'error';
        return r;
      }

      case 'PermissionRequest':
        return set('needs-you');

      case 'Notification': {
        const t = ev.notification_type ?? '';
        if (NEEDS_YOU_NOTIFICATIONS.has(t)) return set('needs-you');
        if (t === 'idle_prompt') return set('idle');
        return { action: { kind: 'ignore', why: `notification ${t || '(none)'}` } };
      }

      case 'Stop': {
        const ran = rec?.turnStartedAt ? now - rec.turnStartedAt : 0;
        const r = set('idle', { turnStartedAt: undefined, ultra: false });
        if (ran >= this.doneAfterMs) r.flash = 'done';
        return r;
      }
      case 'StopFailure': {
        const r = set('idle', { turnStartedAt: undefined, ultra: false });
        r.flash = 'error';
        return r;
      }

      case 'SessionEnd':
        this.sessions.delete(id);
        return { action: { kind: 'end' } };

      default:
        return { action: { kind: 'ignore', why: `event ${ev.hook_event_name ?? '(none)'}` } };
    }
  }

  private thinkingFor(rec: SessionRecord | undefined): ActivityState {
    return rec?.ultra ? 'ultrathink' : 'thinking';
  }

  /** Drop sessions that have been silent for longer than maxAgeMs. */
  prune(now: number, maxAgeMs: number): string[] {
    const dropped: string[] = [];
    for (const [id, rec] of this.sessions) {
      if (now - rec.updatedAt > maxAgeMs) {
        this.sessions.delete(id);
        dropped.push(id);
      }
    }
    return dropped;
  }

  /** The most urgent state across sessions; idle when there are none. */
  aggregate(): ActivityState {
    let best: ActivityState = 'idle';
    for (const rec of this.sessions.values()) {
      if (PRIORITY[rec.state] > PRIORITY[best]) best = rec.state;
    }
    return best;
  }

  /** Most recent activity timestamp across sessions, or 0. */
  lastActivity(): number {
    let t = 0;
    for (const rec of this.sessions.values()) t = Math.max(t, rec.updatedAt);
    return t;
  }
}

/** Backwards-compatible helper used by tests and logging. */
export function classify(ev: HookEvent, rules: ToolRule[] = DEFAULT_TOOL_RULES): ReducerAction {
  return new Reducer({ rules }).apply(ev).action;
}
