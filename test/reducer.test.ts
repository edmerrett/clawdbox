import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reducer, classify } from '../src/daemon/reducer.js';

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
  assert.deepEqual(classify({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }), { kind: 'set', state: 'needs-you' });
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

test('flashes: wave on startup, heart on thanks, done after a long turn, error on failure', () => {
  const r = new Reducer({ doneAfterMs: 10_000 });
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup' }, 0).flash, 'wave');
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'SessionStart', source: 'resume' }, 0).flash, undefined);
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'thanks, now fix the tests' }, 1000).flash, 'heart');
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'Stop' }, 5000).flash, undefined, 'short turn: no celebration');
  r.apply({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'refactor everything' }, 10_000);
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }, 12_000).flash, 'error');
  assert.equal(r.apply({ session_id: 's', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', is_interrupt: true }, 12_500).flash, undefined);
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

test('needs-you in any session wins; pruning drops stale sessions', () => {
  const r = new Reducer();
  r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 1000);
  r.apply({ session_id: 'b', hook_event_name: 'Notification', notification_type: 'permission_prompt' }, 1000);
  assert.equal(r.aggregate(), 'needs-you');
  r.apply({ session_id: 'b', hook_event_name: 'Stop' }, 2000);
  assert.equal(r.aggregate(), 'running');
  assert.deepEqual(r.prune(62_000, 60_000), ["a"]);
  assert.equal(r.aggregate(), 'idle');
});
