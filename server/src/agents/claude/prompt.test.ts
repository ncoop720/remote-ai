import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVisiblePrompt } from './prompt.js';

const summary = (screen: string) => {
  const p = parseVisiblePrompt(screen);
  return p && { question: p.question, options: p.options.map((o) => `${o.key}${o.selected ? '*' : ''} ${o.label}`) };
};

test('numbered Bash permission prompt in a box', () => {
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
  assert.deepEqual(summary(screen), {
    question: 'Do you want to proceed?',
    options: ['1* Yes', "2 Yes, and don't ask again for pnpm add commands", '3 No, and tell Claude what to do differently (esc)'],
  });
});

test('borderless numbered prompt with the highlight on option 2', () => {
  const screen = ['Do you want to make this edit?', '  1. Yes', '❯ 2. Yes, allow all edits during this session', '  3. No'].join('\n');
  assert.deepEqual(summary(screen)?.options, ['1 Yes', '2* Yes, allow all edits during this session', '3 No']);
});

test('unnumbered folder-trust prompt, copied from Claude Code 2.1.286', () => {
  const screen = [
    '────────────────────────────────────────────────────────────────────────',
    ' Accessing workspace:',
    '',
    ' /tmp/ra-real/worktrees/demo/real-test',
    '',
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this",
    ' folder first.',
    '',
    " Claude Code'll be able to read, edit, and execute files here.",
    '',
    ' Security guide',
    '',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n');
  const p = parseVisiblePrompt(screen);
  assert.deepEqual(p?.options.map((o) => `${o.key}${o.selected ? '*' : ''} ${o.label}`), ['1* No, exit', '2 Yes, I trust this folder']);
  assert.match(p?.question ?? '', /^Quick safety check: Is this a project/);
});

test('option descriptions on the following lines are skipped', () => {
  const screen = [
    'Which database should we use?',
    '❯ 1. Postgres',
    '     Relational, already running on this machine',
    '  2. SQLite',
    '     A single file, no server',
    '  3. Type something.',
  ].join('\n');
  assert.deepEqual(summary(screen)?.options, ['1* Postgres', '2 SQLite', '3 Type something.']);
});

test('ordinary numbered lists and a typed input line are not prompts', () => {
  assert.equal(parseVisiblePrompt(['Here is the plan:', '1. Add the route', '2. Write tests', '', '> '].join('\n')), null);
  assert.equal(parseVisiblePrompt(['─────────────', '❯ fix the login bug', '─────────────', '  ? for shortcuts'].join('\n')), null);
  // several lines typed with Shift+Enter line up like a menu's options
  assert.equal(
    parseVisiblePrompt(['─────────────', '❯ first line', '  second line', '  third line', '─────────────', '  ⏸ manual mode on'].join('\n')),
    null,
  );
});

test('a sent message above the empty input box is not a prompt', () => {
  const screen = [
    '● Tell me which of these you want and I can fill in the',
    '  defaults on the page so Phase 1 can start.',
    '',
    '❯ Answer to questions from the artifact:',
    '  • Weapon 2 does nothing right now',
    '  • Yes, weapons and armor can roll different combinations of stats. Other items will',
    '  never differ',
    '  • Gear cannot change in combat. Rearranging inventory and drinking potions is fine',
    '',
    '✻ Cogitating… (12s · esc to interrupt)',
    '',
    '─────────────',
    '❯ ',
    '─────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');
  assert.equal(parseVisiblePrompt(screen), null);
});

test('prompts that scrolled far above the bottom are ignored', () => {
  const old = ['Do you want to proceed?', '❯ 1. Yes', '  2. No'];
  const filler = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  assert.equal(parseVisiblePrompt([...old, ...filler].join('\n')), null);
});
