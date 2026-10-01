import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { HostClient } from './hostclient.js';
import type { TermRef } from './host/protocol.js';

// Starts a real session host (from source, via tsx) in a scratch data dir.
const posix = process.platform !== 'win32';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-host-'));
const quiet = { info: () => undefined, warn: () => undefined };
let host: HostClient;

const until = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const screenOf = (ref: TermRef) => host.screen(ref);

before(() => {
  host = new HostClient(dataDir, quiet);
});

after(async () => {
  await host.shutdown().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('runs a command, takes input, and reports its exit', { skip: !posix }, async () => {
  const ref = { session: 'proj__main', name: 'dev-web' };
  const exits: (number | null)[] = [];
  host.on('exit', (r: TermRef, code: number | null) => r.name === ref.name && exits.push(code));
  const log = path.join(dataDir, 'logs', 'web.log');
  await host.spawn({ ...ref, cwd: dataDir, command: 'echo "port $PORT"; read line; echo "got $line"; exit 3', env: { PORT: '3100' }, logFile: log });

  await until(async () => (await screenOf(ref)).includes('port 3100'));
  await host.paste(ref, 'hello');
  await host.keys(ref, ['Enter']);
  await until(async () => exits.length > 0);
  assert.deepEqual(exits, [3]);

  const [info] = (await host.list()).filter((t) => t.name === ref.name);
  assert.equal(info?.alive, false);
  assert.equal(info?.exitCode, 3);
  assert.match(fs.readFileSync(log, 'utf8'), /port 3100[\s\S]*got hello/);
  await assert.rejects(host.keys({ session: 'proj__main', name: 'nope' }, ['Enter']), /No terminal/);
});

test('a viewer gets a snapshot and then live output', { skip: !posix }, async () => {
  const ref = { session: 'proj__main', name: 'agent' };
  await host.spawn({ ...ref, cwd: dataDir, command: 'printf "\\033[31mready\\033[0m\\n"; cat' });
  await until(async () => (await screenOf(ref)).includes('ready'));

  const received: string[] = [];
  let exited = false;
  const view = await host.attach(ref, { cols: 80, rows: 24 }, {
    data: (d) => received.push(d),
    exit: () => (exited = true),
    close: () => undefined,
  });
  assert.ok(view);
  assert.ok(view.alive);
  assert.match(view.snapshot, /\x1b\[31mready/);

  view.write('echo-me\r');
  await until(async () => received.join('').includes('echo-me'));
  await assert.rejects(host.spawn({ ...ref, cwd: dataDir, command: 'true' }), /already running/);

  await host.killSession(ref.session);
  assert.deepEqual((await host.list()).filter((t) => t.session === ref.session), []);
  view.close();
  assert.equal(exited, false, 'a removed terminal is not reported as exited');
});

test('a new client finds terminals started by an earlier one', { skip: !posix }, async () => {
  const ref = { session: 'proj__feat', name: 'agent' };
  await host.spawn({ ...ref, cwd: dataDir, command: 'sleep 30' });
  const other = new HostClient(dataDir, quiet);
  assert.ok((await other.list()).some((t) => t.session === ref.session && t.alive));
  await other.killSession(ref.session);
});

test('on Linux the host starts without descriptors inherited from the app', { skip: process.platform !== 'linux' }, async () => {
  // A descriptor without close-on-exec, like the ones Electron holds.
  const { execFileSync } = await import('node:child_process');
  const { file, args } = (await import('./hostclient.js')).detachedCommand('/bin/sh', ['-c', 'ls /proc/$$/fd; echo err >&2']);
  const out = execFileSync('/bin/bash', ['-c', 'exec 7</dev/null 12</dev/null; exec "$@" 2>&1', 'wrap', file, ...args], {
    encoding: 'utf8',
  });
  assert.deepEqual(out.split(/\s+/).filter((w) => /^\d+$/.test(w)).map(Number).filter((n) => n > 2), []);
  assert.match(out, /^err$/m, 'stderr still goes where it did');
});

test("the host doesn't inherit an AppImage's mount", async () => {
  const { hostEnvironment } = await import('./hostclient.js');
  const env = hostEnvironment({
    APPDIR: '/tmp/.mount_ra',
    APPIMAGE: '/home/me/remote-ai.AppImage',
    LD_LIBRARY_PATH: '/tmp/.mount_ra/usr/lib',
    PATH: '/tmp/.mount_ra/usr/bin:/usr/bin',
  });
  assert.deepEqual(env, { PATH: '/usr/bin' });
});
