import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildClaudeCommand } from './claude.js';
import { shellQuote } from './exec.js';
import { sessionId, slug } from './ids.js';

test('shellQuote leaves safe words alone and quotes the rest', () => {
  assert.equal(shellQuote('/home/me/.remote-ai/claude-settings.json'), '/home/me/.remote-ai/claude-settings.json');
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('a b'), `'a b'`);
});

test('buildClaudeCommand adds flags only when needed', () => {
  assert.equal(
    buildClaudeCommand({ claudeCommand: 'claude', settingsPath: '/d/s.json' }),
    'claude --settings /d/s.json',
  );
  assert.equal(
    buildClaudeCommand({ claudeCommand: 'claude', settingsPath: '/d/s.json', permissionMode: 'manual' }),
    'claude --settings /d/s.json --permission-mode manual',
  );
  assert.equal(
    buildClaudeCommand({
      claudeCommand: 'claude',
      settingsPath: '/d/s.json',
      permissionMode: 'plan',
      resume: true,
      prompt: "Add a dark-mode toggle; don't break SSR",
    }),
    `claude --settings /d/s.json --permission-mode plan --continue 'Add a dark-mode toggle; don'\\''t break SSR'`,
  );
});

test('session ids are tmux-safe', () => {
  assert.equal(slug('feat/github.oauth'), 'feat-github-oauth');
  assert.equal(sessionId('my app', 'feat/x'), 'my-app__feat-x');
  assert.ok(!sessionId('a~b', 'c:d').includes('~'));
  assert.ok(!sessionId('a~b', 'c:d').includes(':'));
});
