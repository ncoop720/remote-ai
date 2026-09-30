import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSs } from './ports.js';

test('parseSs reads ports and pids, skipping system ports and duplicates', () => {
  const out = [
    'LISTEN 0      4096       127.0.0.54:53   0.0.0.0:*',
    'LISTEN 0      511         127.0.0.1:5174 0.0.0.0:* users:(("node",pid=1263,fd=22))',
    'LISTEN 0      511              [::]:3100    [::]:* users:(("node",pid=2001,fd=20))',
    'LISTEN 0      511           0.0.0.0:3100 0.0.0.0:* users:(("node",pid=2001,fd=19))',
    'LISTEN 0      511                 *:3101       *:* users:(("node",pid=2002,fd=19),("node",pid=2003,fd=19))',
    '',
  ].join('\n');
  assert.deepEqual(parseSs(out), [
    { port: 5174, pid: 1263 },
    { port: 3100, pid: 2001 },
    { port: 3101, pid: 2002 },
    { port: 3101, pid: 2003 },
  ]);
});
