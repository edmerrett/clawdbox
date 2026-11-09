/**
 * Turns raw Claude Code hook events into a per-session state, and merges all
 * sessions into the single state the display should show.
 */
import { PRIORITY, State } from '../anim/types.js';

/** The subset of the hook JSON body we care about. Everything is optional on purpose. */
export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  notification_type?: string;
  agent_id?: string;
  reason?: string;
  source?: string;
  [k: string]: unknown;
}

export interface ToolRule {
  /** Regex tested against tool_name (unanchored). */
  match: RegExp;
  state: State;
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

export interface SessionRecord {
  state: State;
  updatedAt: number;
}

export type ReducerAction =
  | { kind: 'set'; state: State }
  | { kind: 'end' }
  | { kind: 'ignore'; why: string };

/** Pure mapping from one event to what should happen to its session. */
export function classify(ev: HookEvent, rules: ToolRule[] = DEFAULT_TOOL_RULES): ReducerAction {
  if (ev.agent_id) return { kind: 'ignore', why: 'subagent' };
  const tool = ev.tool_name ?? '';
  switch (ev.hook_event_name) {
    case 'SessionStart':
      return { kind: 'set', state: 'idle' };
    case 'UserPromptSubmit':
    case 'PreCompact':
    case 'PostCompact':
    case 'PermissionDenied':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { kind: 'set', state: 'thinking' };
    case 'PreToolUse': {
      const rule = rules.find((r) => r.match.test(tool));
      return { kind: 'set', state: rule?.state ?? 'thinking' };
    }
    case 'PermissionRequest':
      return { kind: 'set', state: 'needs-you' };
    case 'Notification': {
      const t = ev.notification_type ?? '';
      if (NEEDS_YOU_NOTIFICATIONS.has(t)) return { kind: 'set', state: 'needs-you' };
      if (t === 'idle_prompt') return { kind: 'set', state: 'idle' };
      return { kind: 'ignore', why: `notification ${t || '(none)'}` };
    }
    case 'Stop':
    case 'StopFailure':
      return { kind: 'set', state: 'idle' };
    case 'SessionEnd':
      return { kind: 'end' };
    default:
      return { kind: 'ignore', why: `event ${ev.hook_event_name ?? '(none)'}` };
  }
}

export class Reducer {
  readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly rules: ToolRule[] = DEFAULT_TOOL_RULES) {}

  /** Apply an event. Returns the action taken (useful for logging). */
  apply(ev: HookEvent, now = Date.now()): ReducerAction {
    const action = classify(ev, this.rules);
    const id = ev.session_id ?? 'unknown';
    if (action.kind === 'set') this.sessions.set(id, { state: action.state, updatedAt: now });
    else if (action.kind === 'end') this.sessions.delete(id);
    return action;
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
  aggregate(): State {
    let best: State = 'idle';
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
