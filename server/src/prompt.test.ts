import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVisiblePrompt } from './prompt.js';

test('parses a Bash permission prompt', () => {
  const screen = [
    '● The dev server can\'t resolve @auth/sveltekit. Installing it.',
    '',
    '╭──────────────────────────────────────────────────────────────╮',
    '│ Bash command                                                 │',
    '│                                                              │',
    '│   pnpm add @auth/core @auth/sveltekit                        │',
    '│   Install Auth.js packages                                   │',
    '│                                                              │',
    '│ Do you want to proceed?                                      │',
    '│ ❯ 1. Yes                                                     │',
    '│   2. Yes, and don\'t ask again for pnpm add commands         │',
    '│   3. No, and tell Claude what to do differently (esc)        │',
    '╰──────────────────────────────────────────────────────────────╯',
    '',
  ].join('\n');

  const prompt = parseVisiblePrompt(screen);
  assert.ok(prompt);
  assert.equal(prompt.question, 'Do you want to proceed?');
  assert.deepEqual(
    prompt.options.map((o) => [o.key, o.label, o.selected]),
    [
      ['1', 'Yes', true],
      ['2', "Yes, and don't ask again for pnpm add commands", false],
      ['3', 'No, and tell Claude what to do differently (esc)', false],
    ],
  );
});

test('parses a borderless prompt with the highlight on option 2', () => {
  const screen = ['Do you want to make this edit?', '  1. Yes', '❯ 2. Yes, allow all edits during this session', '  3. No'].join('\n');
  const prompt = parseVisiblePrompt(screen);
  assert.equal(prompt?.options.find((o) => o.selected)?.key, '2');
});

test('ignores numbered lists in ordinary output', () => {
  const screen = ['Here is the plan:', '1. Add the route', '2. Write tests', '', '> '].join('\n');
  assert.equal(parseVisiblePrompt(screen), null);
});

test('ignores prompts that scrolled far above the bottom', () => {
  const old = ['Do you want to proceed?', '❯ 1. Yes', '  2. No'];
  const filler = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  assert.equal(parseVisiblePrompt([...old, ...filler].join('\n')), null);
});
