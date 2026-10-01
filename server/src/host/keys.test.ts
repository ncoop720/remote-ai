import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keySequence, pasteSequence } from './keys.js';

test('arrow keys follow the cursor-key mode', () => {
  assert.equal(keySequence('Up', false), '\x1b[A');
  assert.equal(keySequence('Up', true), '\x1bOA');
  assert.equal(keySequence('BTab', false), '\x1b[Z');
  assert.equal(keySequence('C-c', false), '\x03');
  assert.equal(keySequence('F13', false), undefined);
});

test('pastes are bracketed only when the program asked', () => {
  assert.equal(pasteSequence('a\nb', true), '\x1b[200~a\nb\x1b[201~');
  assert.equal(pasteSequence('a\nb', false), 'a\rb');
  // Pasted text can't end the paste early.
  assert.equal(pasteSequence('x\x1b[201~y', true), '\x1b[200~xy\x1b[201~');
});
