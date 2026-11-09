import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reducer, HookEvent } from '../src/daemon/reducer.js';

/** Classify a single PreToolUse/Notification event in a fresh reducer with a live session. */
function classify(ev: HookEvent) {
  const r = new Reducer();
  r.apply({ session_id: 'x', hook_event_name: 'SessionStart' }, 0);
  return r.apply({ session_id: 'x', ...ev }, 1).action;
}

test('tool names map to states', () => {
  const s = (tool: string) => classify({ hook_event_name: 'PreToolUse', tool_name: tool });
  assert.deepEqual(s('Read'), { kind: 'set', state: 'reading' });
  assert.deepEqual(s('Grep'), { kind: 'set', state: 'reading' });
  assert.deepEqual(s('Edit'), { kind: 'set', state: 'writing' });
  assert.deepEqual(s('Write'), { kind: 'set', state: 'writing' });
  assert.deepEqual(s('Bash'), { kind: 'set', state: 'running' });
  assert.deepEqual(s('AskUserQuestion'), { kind: 'set', state: 'needs-you' });
  assert.deepEqual(s('Task'), { kind: 'set', state: 'thinking' });
  assert.deepEqual(s('mcp__github__list_issues'), { kind: 'set', state: 'reading' });
});

test('subagent events are ignored', () => {
  assert.equal(classify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'a1' }).kind, 'ignore');
});

test('notifications: permission prompts need you, idle_prompt goes idle, others ignored', () => {
  assert.deepEqual(classify({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }), {
    kind: 'set',
    state: 'needs-you',
  });
  assert.deepEqual(classify({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), { kind: 'set', state: 'idle' });
  assert.equal(classify({ hook_event_name: 'Notification', notification_type: 'auth_success' }).kind, 'ignore');
});

test('a session walks through a turn', () => {
  const r = new Reducer();
  const ev = (o: object) => r.apply({ session_id: 's1', ...o }, 1000);
  ev({ hook_event_name: 'SessionStart' });
  assert.equal(r.aggregate(), 'idle');
  ev({ hook_event_name: 'UserPromptSubmit' });
  assert.equal(r.aggregate(), 'thinking');
  ev({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
  assert.equal(r.aggregate(), 'reading');
  ev({ hook_event_name: 'PostToolUse', tool_name: 'Read' });
  assert.equal(r.aggregate(), 'thinking');
  ev({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.equal(r.aggregate(), 'needs-you');
  ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  assert.equal(r.aggregate(), 'running');
  ev({ hook_event_name: 'Stop' });
  assert.equal(r.aggregate(), 'idle');
  ev({ hook_event_name: 'SessionEnd' });
  assert.equal(r.sessions.size, 0);
});

test('stray events for unknown sessions do not create records', () => {
  const r = new Reducer();
  assert.equal(r.apply({ session_id: 'ghost', hook_event_name: 'Stop' }, 0).action.kind, 'ignore');
  assert.equal(r.apply({ session_id: 'ghost', hook_event_name: 'PostToolUse', tool_name: 'Read' }, 0).action.kind, 'ignore');
  assert.equal(r.apply({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, 0).action.kind, 'ignore');
  assert.equal(r.sessions.size, 0);
  // but a tool call proves a live session
  r.apply({ session_id: 'live', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 0);
  assert.equal(r.aggregate(), 'running');
});

test('flashes: wave on startup, heart on thanks, done after a long turn, error on failure', () => {
  const r = new Reducer({ doneAfterMs: 10_000 });
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup' }, 0).flash, 'wave');
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'SessionStart', source: 'resume' }, 0).flash, undefined);
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'thanks, now fix the tests' }, 1000).flash, 'heart');
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'Stop' }, 5000).flash, undefined, 'short turn: no celebration');
  r.apply({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'refactor everything' }, 10_000);
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }, 12_000).flash, 'error');
  assert.equal(
    r.apply({ session_id: 's', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', is_interrupt: true }, 12_500).flash,
    undefined,
  );
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'Stop' }, 25_000).flash, 'done');
});

test('ultrathink in the prompt makes thinking rainbow for the rest of the turn', () => {
  const r = new Reducer();
  r.apply({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'ultrathink about this' }, 0);
  assert.equal(r.aggregate(), 'ultrathink');
  r.apply({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read' }, 1);
  assert.equal(r.aggregate(), 'reading');
  r.apply({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Read' }, 2);
  assert.equal(r.aggregate(), 'ultrathink');
  r.apply({ session_id: 's', hook_event_name: 'Stop' }, 3);
  r.apply({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'ok' }, 4);
  assert.equal(r.aggregate(), 'thinking');
});

test('SessionStart wipes a previous turn so resume cannot celebrate or stay rainbow', () => {
  const r = new Reducer({ doneAfterMs: 10_000 });
  r.apply({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'ultrathink please' }, 0);
  r.apply({ session_id: 's', hook_event_name: 'SessionStart', source: 'resume' }, 60_000);
  assert.equal(r.sessions.get('s')?.ultra, false);
  assert.equal(r.sessions.get('s')?.turnStartedAt, undefined);
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'Stop' }, 61_000).flash, undefined);
});

test('needs-you in any session wins; pruning drops stale sessions; idleAll quiets everyone', () => {
  const r = new Reducer();
  r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 1000);
  r.apply({ session_id: 'b', hook_event_name: 'UserPromptSubmit' }, 1000);
  r.apply({ session_id: 'b', hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, 1000);
  assert.equal(r.aggregate(), 'needs-you');
  r.apply({ session_id: 'b', hook_event_name: 'Stop' }, 2000);
  assert.equal(r.aggregate(), 'running');
  r.idleAll(3000);
  assert.equal(r.aggregate(), 'idle');
  r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 1000);
  assert.deepEqual(r.prune(62_000, 60_000), ['a']);
  assert.equal(r.aggregate(), 'idle');
  assert.deepEqual([...r.sessions.keys()], ['b']);
});
