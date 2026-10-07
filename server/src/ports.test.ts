import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ancestorsOf, parseLsof, parseLsofCwd, parseNetstat, parsePs, parseSs, parseWindowsProcesses, processTree } from './ports.js';

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

test('macOS: lsof listening sockets and working directories, ps for the process tree', () => {
  const listen = ['p501', 'n127.0.0.1:3100', 'n[::1]:3100', 'p88', 'n*:631', 'p777', 'n*:5173', ''].join('\n');
  assert.deepEqual(parseLsof(listen), [
    { port: 3100, pid: 501 },
    { port: 3100, pid: 501 },
    { port: 5173, pid: 777 },
  ]);
  assert.deepEqual([...parseLsofCwd('p501\nfcwd\nn/Users/me/worktrees/app/feat\np777\nn/Users/me/code\n')], [
    [501, '/Users/me/worktrees/app/feat'],
    [777, '/Users/me/code'],
  ]);
  const ps = parsePs('    1     0 /sbin/launchd\n  400     1 /bin/zsh -l\n  501   400 /usr/local/bin/node vite --port 3100\n');
  assert.deepEqual(ps.get(501), { ppid: 400, command: '/usr/local/bin/node vite --port 3100' });
  assert.deepEqual(ancestorsOf(501, (p) => ps.get(p)?.ppid), [400, 1]);
});

test('Windows: netstat LISTENING lines and the process list', () => {
  const netstat = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012',
    '  TCP    127.0.0.1:3100         0.0.0.0:0              LISTENING       8812',
    '  TCP    [::]:5173              [::]:0                 LISTENING       9100',
    '  TCP    192.168.1.5:50123      52.1.1.1:443           ESTABLISHED     4400',
    '',
  ].join('\r\n');
  assert.deepEqual(parseNetstat(netstat), [
    { port: 3100, pid: 8812 },
    { port: 5173, pid: 9100 },
  ]);
  const procs = parseWindowsProcesses(
    '[{"ProcessId":4,"ParentProcessId":0,"Name":"System","CommandLine":null},' +
      '{"ProcessId":8812,"ParentProcessId":700,"Name":"node.exe","CommandLine":"\\"node\\" C:\\\\code\\\\app\\\\node_modules\\\\vite\\\\bin\\\\vite.js"}]',
  );
  assert.deepEqual(procs.get(8812), { ppid: 700, command: 'node.exe', commandLine: '"node" C:\\code\\app\\node_modules\\vite\\bin\\vite.js' });
  assert.equal(procs.get(4)?.commandLine, 'System', 'no command line shown');
  assert.equal(parseWindowsProcesses('{"ProcessId":5,"ParentProcessId":4,"Name":"x"}').size, 1, 'a single object');
});

test('ancestor walks stop at loops', () => {
  assert.deepEqual(ancestorsOf(3, (p) => ({ 3: 2, 2: 3 })[p]), [2, 3]);
});

test('a process tree is the process and everything under it, and nothing else', () => {
  // pid -> parent: 10 started 11 and 12, 12 started 13; 20 is a sibling of 10; 30 loops onto itself
  const parents = new Map([[10, 1], [11, 10], [12, 10], [13, 12], [20, 1], [30, 30]]);
  assert.deepEqual(processTree(10, parents), [10, 11, 12, 13]);
  assert.deepEqual(processTree(13, parents), [13]);
  assert.deepEqual(processTree(30, parents), [30]);
});
