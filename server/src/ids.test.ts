import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shellQuote } from './exec.js';
import { sessionId, slug } from './ids.js';

test('shellQuote leaves safe words alone and quotes the rest', () => {
  assert.equal(shellQuote('/home/me/.remote-ai/claude-settings.json'), '/home/me/.remote-ai/claude-settings.json');
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('a b'), `'a b'`);
});

test('session ids are safe in paths, URLs and host terminal names', () => {
  assert.equal(slug('feat/github.oauth'), 'feat-github-oauth');
  assert.equal(sessionId('my app', 'feat/x'), 'my-app__feat-x');
  assert.match(sessionId('a~b', 'c:d'), /^[A-Za-z0-9_-]+$/);
});
