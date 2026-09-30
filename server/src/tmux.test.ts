import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSessions, parseWindows } from './tmux.js';

const SEP = '\u001f';

test('parseSessions skips viewer sessions', () => {
  const out = [
    ['myapp__main', '2', '1', '/p/myapp'].join(SEP),
    ['myapp__main~a1b2c3', '2', '1', '/p/myapp'].join(SEP),
    ['api__refactor', '1', '0', '/w/api/refactor'].join(SEP),
    '',
  ].join('\n');
  assert.deepEqual(parseSessions(out), [
    { name: 'myapp__main', windows: 2, attached: 1, path: '/p/myapp' },
    { name: 'api__refactor', windows: 1, attached: 0, path: '/w/api/refactor' },
  ]);
});

test('parseWindows groups windows by session', () => {
  const out = [
    ['myapp__main', '0', 'claude', 'node'].join(SEP),
    ['myapp__main', '1', 'server', 'pnpm'].join(SEP),
    ['myapp__main~a1b2c3', '0', 'claude', 'node'].join(SEP),
  ].join('\n');
  const map = parseWindows(out);
  assert.equal(map.size, 1);
  assert.deepEqual(map.get('myapp__main'), [
    { index: 0, name: 'claude', command: 'node' },
    { index: 1, name: 'server', command: 'pnpm' },
  ]);
});
