import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isErrorLine, lineText, parseAnsi } from './ansi.ts';

const show = (text: string) => parseAnsi(text).map((line) => line.map((s) => [s.text, s.className]));

test('colors, bold and reset', () => {
  assert.deepEqual(show('\x1b[32m✓\x1b[0m built in \x1b[1m295ms\x1b[22m\n'), [
    [['✓', 'c2'], [' built in ', ''], ['295ms', 'b']],
  ]);
});

test('colors carry across lines until reset', () => {
  assert.deepEqual(show('\x1b[31mError: boom\n    at x.ts:1\x1b[39m\nok'), [
    [['Error: boom', 'c1']],
    [['    at x.ts:1', 'c1']],
    [['ok', '']],
  ]);
});

test('bright and 256-color codes map to the 16 basic colors', () => {
  assert.deepEqual(show('\x1b[91ma\x1b[38;5;4mb\x1b[38;5;200mc\x1b[38;2;1;2;3md'), [
    [['a', 'c9'], ['b', 'c4'], ['c', ''], ['d', '']],
  ]);
});

test('carriage returns keep only the last redraw; CRLF endings are fine', () => {
  assert.deepEqual(show('10%\r50%\r100% done\r\nnext\r\n'), [[['100% done', '']], [['next', '']]]);
});

test('screen clears, cursor moves and window titles are dropped', () => {
  const lines = parseAnsi('\x1b[2J\x1b[3J\x1b[H\x1b]0;vite\x07  VITE ready\x1b[K\n');
  assert.equal(lineText(lines[0]!), '  VITE ready');
});

test('error lines are recognised', () => {
  assert.ok(isErrorLine(parseAnsi("Error: Cannot find package 'x'")[0]!));
  assert.ok(isErrorLine(parseAnsi('npm ERR! code 1')[0]!));
  assert.ok(!isErrorLine(parseAnsi('GET /settings 200 in 38ms')[0]!));
});
