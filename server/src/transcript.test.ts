import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTranscriptLine, summarizeToolInput, transcriptDir } from './transcript.js';

// Shapes copied from a Claude Code 2.1.286 transcript.
const line = (o: object) => JSON.stringify(o);

test('user prompt, tool call, tool result and reply', () => {
  assert.deepEqual(
    parseTranscriptLine(line({ type: 'user', uuid: 'u1', timestamp: 't1', message: { role: 'user', content: 'Run the tests' } })),
    [{ kind: 'user', id: 'u1', text: 'Run the tests', time: 't1' }],
  );
  assert.deepEqual(
    parseTranscriptLine(
      line({
        type: 'assistant',
        uuid: 'a1',
        timestamp: 't2',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test\n--watch=false', description: 'Run tests' } }] },
      }),
    ),
    [{ kind: 'tool', id: 'a1:0', toolUseId: 'toolu_1', name: 'Bash', summary: 'npm test', time: 't2' }],
  );
  assert.deepEqual(
    parseTranscriptLine(
      line({
        type: 'user',
        uuid: 'u2',
        message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'ok 3 tests', is_error: false }] },
        toolUseResult: { stdout: 'ok 3 tests' },
      }),
    ),
    [{ kind: 'result', id: 'u2:0', toolUseId: 'toolu_1', ok: true, output: 'ok 3 tests' }],
  );
  assert.deepEqual(
    parseTranscriptLine(line({ type: 'assistant', uuid: 'a2', timestamp: 't3', message: { content: [{ type: 'text', text: 'All 3 pass.' }] } })),
    [{ kind: 'assistant', id: 'a2:0', text: 'All 3 pass.', time: 't3' }],
  );
});

test('thinking, bookkeeping, meta and subagent lines are hidden', () => {
  assert.deepEqual(parseTranscriptLine(line({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } })), []);
  for (const type of ['attachment', 'mode', 'permission-mode', 'file-history-snapshot', 'system', 'ai-title', 'cost-state']) {
    assert.deepEqual(parseTranscriptLine(line({ type, uuid: 'x' })), [], type);
  }
  assert.deepEqual(parseTranscriptLine(line({ type: 'user', isMeta: true, message: { content: 'Caveat: …' } })), []);
  assert.deepEqual(parseTranscriptLine(line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } })), []);
  assert.deepEqual(parseTranscriptLine('not json'), []);
});

test('slash commands show as commands; their output is hidden', () => {
  assert.deepEqual(
    parseTranscriptLine(line({ type: 'user', uuid: 'c', timestamp: 't', message: { content: '<command-name>/model</command-name>\n<command-args>opus</command-args>' } })),
    [{ kind: 'command', id: 'c', text: '/model opus', time: 't' }],
  );
  assert.deepEqual(parseTranscriptLine(line({ type: 'user', message: { content: '<local-command-stdout>Set model</local-command-stdout>' } })), []);
});

test('failed and long tool results', () => {
  const [item] = parseTranscriptLine(
    line({ type: 'user', uuid: 'r', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: [{ type: 'text', text: 'x'.repeat(3000) }] }] } }),
  );
  assert.equal(item?.kind, 'result');
  if (item?.kind === 'result') {
    assert.equal(item.ok, false);
    assert.ok(item.output.length < 1600);
  }
});

test('tool summaries', () => {
  assert.equal(summarizeToolInput('Edit', { file_path: '/w/src/app.ts', old_string: 'a', new_string: 'b' }), '/w/src/app.ts');
  assert.equal(summarizeToolInput('Grep', { pattern: 'TODO', path: 'src' }), 'TODO in src');
  assert.equal(summarizeToolInput('TodoWrite', { todos: [1, 2, 3] }), '3 items');
  assert.equal(summarizeToolInput('mcp__thing__do', { query: 'hello' }), 'hello');
});

test('transcript folder naming matches Claude Code', () => {
  assert.match(transcriptDir('/tmp/ra-real/worktrees/demo/real-muomf0x3'), /projects[\\/]-tmp-ra-real-worktrees-demo-real-muomf0x3$/);
});
