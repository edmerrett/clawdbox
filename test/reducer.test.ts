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

test('needs-you in any session wins; pruning drops stale sessions', () => {
  const r = new Reducer();
  r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 1000);
  r.apply({ session_id: 'b', hook_event_name: 'UserPromptSubmit' }, 1000);
  r.apply({ session_id: 'b', hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, 1000);
  assert.equal(r.aggregate(), 'needs-you');
  r.apply({ session_id: 'b', hook_event_name: 'Stop' }, 2000);
  assert.equal(r.aggregate(), 'running');
  assert.deepEqual(r.prune(62_000, 60_000), ['a']);
  assert.equal(r.aggregate(), 'idle');
  assert.deepEqual([...r.sessions.keys()], ['b']);
});

const QUIET = 60_000;
const WAIT = 300_000;

test('an interrupted turn (no Stop hook) goes idle after the quiet timeout', () => {
  for (const tool of [undefined, 'Read', 'Edit']) {
    const r = new Reducer();
    r.apply({ session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'ultrathink' }, 0);
    if (tool) r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: tool }, 1000);
    // Esc: nothing more arrives
    assert.deepEqual(r.expire(30_000, QUIET, WAIT), []);
    assert.notEqual(r.aggregate(30_000, QUIET), 'idle');
    assert.deepEqual(r.expire(61_001, QUIET, WAIT), ['a']);
    assert.equal(r.aggregate(61_001, QUIET), 'idle');
    const rec = r.sessions.get('a');
    assert.equal(rec?.ultra, false);
    assert.equal(rec?.turnStartedAt, undefined);
    // a late Stop must not celebrate a turn that was written off
    assert.equal(r.apply({ session_id: 'a', hook_event_name: 'Stop' }, 70_000).flash, undefined);
  }
});

test('running and needs-you wait longer: a long command or an unanswered prompt is not an interrupt', () => {
  const r = new Reducer();
  r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 0);
  r.apply({ session_id: 'b', hook_event_name: 'UserPromptSubmit' }, 0);
  r.apply({ session_id: 'b', hook_event_name: 'PermissionRequest' }, 0);
  assert.deepEqual(r.expire(200_000, QUIET, WAIT), []);
  assert.equal(r.aggregate(200_000, QUIET), 'needs-you');
  assert.deepEqual(r.expire(300_001, QUIET, WAIT).sort(), ['a', 'b']);
  assert.equal(r.aggregate(300_001, QUIET), 'idle');
});

test('a stale interrupted session does not block another session from taking over', () => {
  const r = new Reducer();
  // a: interrupted mid-edit at t=1000, then silent. b: keeps working the whole time.
  r.apply({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, 0);
  r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Edit' }, 1000);
  for (let t = 5000; t <= 120_000; t += 5000) {
    r.apply({ session_id: 'b', hook_event_name: t % 10_000 ? 'PreToolUse' : 'PostToolUse', tool_name: 'Read' }, t);
    r.expire(t, QUIET, WAIT);
  }
  // b's events must not keep a alive (they used to share one silence timer)
  assert.equal(r.sessions.get('a')?.state, 'idle');
  assert.equal(r.aggregate(120_000, QUIET), 'thinking');
  // a brand-new session takes the panel too
  r.apply({ session_id: 'c', hook_event_name: 'SessionStart', source: 'startup' }, 121_000);
  r.apply({ session_id: 'c', hook_event_name: 'UserPromptSubmit' }, 122_000);
  r.apply({ session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'Write' }, 123_000);
  assert.equal(r.aggregate(123_000, QUIET), 'writing');
});

test('a quiet running session yields to an active one but still shows when alone', () => {
  const r = new Reducer();
  r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 0);
  r.apply({ session_id: 'b', hook_event_name: 'UserPromptSubmit' }, 50_000);
  // fresh: running outranks thinking
  assert.equal(r.aggregate(55_000, QUIET), 'running');
  // a has been silent for over a minute (interrupted, or just slow): b takes over
  r.apply({ session_id: 'b', hook_event_name: 'PreToolUse', tool_name: 'Read' }, 61_000);
  assert.equal(r.aggregate(61_000, QUIET), 'reading');
  // b finishes; a's command may well still be running, so it shows again
  r.apply({ session_id: 'b', hook_event_name: 'Stop' }, 70_000);
  assert.equal(r.aggregate(70_000, QUIET), 'running');
  // the command ends: a is live again and outranks as before
  r.apply({ session_id: 'a', hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 80_000);
  r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 81_000);
  r.apply({ session_id: 'b', hook_event_name: 'UserPromptSubmit' }, 82_000);
  assert.equal(r.aggregate(82_000, QUIET), 'running');
});

test('needs-you is never demoted while it waits', () => {
  const r = new Reducer();
  r.apply({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, 0);
  r.apply({ session_id: 'a', hook_event_name: 'PermissionRequest' }, 0);
  r.apply({ session_id: 'b', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 200_000);
  assert.equal(r.aggregate(200_000, QUIET), 'needs-you');
});

test('an interrupt reported by a tool failure goes idle at once, without an error flash', () => {
  const r = new Reducer();
  r.apply({ session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'ultrathink' }, 0);
  r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 1000);
  const res = r.apply({ session_id: 'a', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', is_interrupt: true }, 2000);
  assert.deepEqual(res, { action: { kind: 'set', state: 'idle' } });
  assert.equal(r.sessions.get('a')?.ultra, false);
  // the next prompt starts a normal turn
  assert.deepEqual(r.apply({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, 3000).action, { kind: 'set', state: 'thinking' });
});

test('subagent events keep a busy session alive without changing or reviving it', () => {
  const r = new Reducer();
  r.apply({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, 0);
  r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Task' }, 1000);
  for (let t = 20_000; t <= 200_000; t += 20_000) {
    assert.equal(r.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'sub' }, t).action.kind, 'ignore');
    assert.deepEqual(r.expire(t, QUIET, WAIT), []);
  }
  assert.equal(r.sessions.get('a')?.state, 'thinking');
  r.apply({ session_id: 'a', hook_event_name: 'Stop' }, 210_000);
  r.apply({ session_id: 'a', hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'sub' }, 220_000);
  assert.equal(r.sessions.get('a')?.state, 'idle');
  assert.equal(r.sessions.get('a')?.updatedAt, 210_000);
});
