import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMarkdown } from './markdown.ts';

test('inline code, bold and links', () => {
  assert.deepEqual(parseInline('Run `npm test` and **then** see [docs](https://example.com/x).'), [
    { t: 'text', v: 'Run ' },
    { t: 'code', v: 'npm test' },
    { t: 'text', v: ' and ' },
    { t: 'bold', children: [{ t: 'text', v: 'then' }] },
    { t: 'text', v: ' see ' },
    { t: 'link', v: 'docs', href: 'https://example.com/x' },
    { t: 'text', v: '.' },
  ]);
});

test('bold can contain code, as in Claude\'s "**`file`:**" summaries', () => {
  assert.deepEqual(parseInline('**`src/math.ts`:** added'), [
    { t: 'bold', children: [{ t: 'code', v: 'src/math.ts' }, { t: 'text', v: ':' }] },
    { t: 'text', v: ' added' },
  ]);
});

test('only http(s) links become links', () => {
  assert.deepEqual(parseInline('[x](javascript:alert(1))'), [{ t: 'text', v: '[x](javascript:alert(1))' }]);
});

test('blocks: heading, paragraph, list, code, quote', () => {
  const blocks = parseMarkdown(
    ['## Plan', '', 'Two steps:', '1. Add the route', '2. Test it', '', '```ts', 'const a = 1;', '', 'const b = 2;', '```', '> note', 'Done.'].join('\n'),
  );
  assert.deepEqual(
    blocks.map((b) => b.t),
    ['h', 'p', 'list', 'code', 'quote', 'p'],
  );
  const list = blocks[2];
  assert.ok(list?.t === 'list' && list.ordered && list.items.length === 2);
  const code = blocks[3];
  assert.ok(code?.t === 'code' && code.lang === 'ts' && code.v === 'const a = 1;\n\nconst b = 2;');
});

test('an unclosed code fence runs to the end', () => {
  const blocks = parseMarkdown('```\nstill streaming');
  assert.deepEqual(blocks, [{ t: 'code', lang: '', v: 'still streaming' }]);
});
