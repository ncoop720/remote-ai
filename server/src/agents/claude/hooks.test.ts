import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INITIAL_STATUS, StatusStore } from '../../status.js';
import { reduceHook, truncateDeep, type HookPayload } from './hooks.js';

test('a prompt, a permission request, approval and stop move through the states', () => {
  let s = reduceHook(INITIAL_STATUS, { hook_event_name: 'UserPromptSubmit', session_id: 'abc' }, 1);
  assert.equal(s.state, 'working');
  assert.equal(s.agentSessionId, 'abc');

  s = reduceHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm add x' } }, 2);
  assert.equal(s.state, 'needs_input');
  assert.deepEqual(s.tool, { name: 'Bash', input: { command: 'pnpm add x' }, summary: 'pnpm add x' });

  s = reduceHook(s, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, 3);
  assert.equal(s.state, 'needs_input');
  assert.equal(s.tool?.name, 'Bash', 'notification keeps the tool details');

  s = reduceHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 4);
  assert.equal(s.state, 'working');
  assert.equal(s.tool, undefined);

  s = reduceHook(s, { hook_event_name: 'Stop', last_assistant_message: 'Done.' }, 5);
  assert.equal(s.state, 'idle');
  assert.equal(s.lastMessage, 'Done.');
  assert.equal(s.updatedAt, 5);
});

test('unknown events and notification types leave the status untouched', () => {
  const s = reduceHook(INITIAL_STATUS, { hook_event_name: 'SubagentStop' });
  assert.equal(s, INITIAL_STATUS);
  const n = reduceHook(INITIAL_STATUS, { hook_event_name: 'Notification', notification_type: 'auth_success' });
  assert.equal(n, INITIAL_STATUS);
});

test('StatusStore emits only on change', () => {
  const store = new StatusStore();
  const seen: string[] = [];
  store.on('change', (id: string, status: { state: string }) => seen.push(`${id}:${status.state}`));
  const apply = (p: HookPayload) => store.update('s1', (prev) => reduceHook(prev, p));
  apply({ hook_event_name: 'UserPromptSubmit' });
  apply({ hook_event_name: 'SubagentStop' });
  apply({ hook_event_name: 'Stop' });
  assert.deepEqual(seen, ['s1:working', 's1:idle']);
});

test('truncateDeep shortens long strings inside tool input', () => {
  const out = truncateDeep({ file_path: 'a.ts', content: 'x'.repeat(5000) }) as { content: string };
  assert.ok(out.content.length < 2100);
  assert.match(out.content, /3000 more chars/);
});
