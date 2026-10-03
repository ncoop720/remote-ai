import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findExecutable } from '../which.js';
import { expandVars, leadingAssignments, parseEnvOutput, resolveLaunch, withoutAppImagePaths } from './launch.js';

test('the login environment is read after the marker, past anything rc files print', () => {
  const out = 'Welcome!\n__REMOTE_AI_ENV__PATH=/usr/bin:/opt/bin\0HOME=/home/me\0EMPTY=\0';
  assert.deepEqual(parseEnvOutput(out), { PATH: '/usr/bin:/opt/bin', HOME: '/home/me', EMPTY: '' });
  assert.equal(parseEnvOutput('no marker'), null);
});

test('programs are found on PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-launch-'));
  const bin = path.join(dir, 'agent');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'notexec'), '', { mode: 0o644 });
  assert.equal(findExecutable('agent', { PATH: `/nonexistent:${dir}` }, 'linux'), bin);
  assert.equal(findExecutable('notexec', { PATH: dir }, 'linux'), null);
  assert.equal(findExecutable(bin, { PATH: '' }, 'linux'), bin);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commands run through the shell, with variables filled in for cmd.exe', () => {
  const base = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
  const posix = resolveLaunch({ session: 's', name: 'dev-web', cwd: '/', command: 'vite --port $PORT', env: { PORT: '3100' } }, base, 'linux');
  assert.deepEqual([posix.file, ...posix.args], ['/bin/zsh', '-c', 'vite --port $PORT']);
  assert.equal(posix.env.PORT, '3100');

  const win = resolveLaunch(
    { session: 's', name: 'dev-web', cwd: 'C:\\', command: 'vite --port $PORT --api ${PORT_API} $HOME', env: { PORT: '3100', PORT_API: '3101' } },
    { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    'win32',
  );
  assert.equal(win.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(win.args, '/d /s /c "vite --port 3100 --api 3101 $HOME"');
  assert.equal(expandVars('$A$B', { A: '1' }), '1$B');
});

test('on Windows, a command\'s leading NAME=value assignments go in its environment', () => {
  const win = resolveLaunch(
    { session: 's', name: 'dev-web', cwd: 'C:\\', command: 'API_PORT=$PORT_API  DATA=~/dev/$PORT npx vite --port $PORT', env: { PORT: '3100', PORT_API: '3101' } },
    { ComSpec: 'cmd.exe', API_PORT: 'old' },
    'win32',
  );
  assert.equal(win.args, '/d /s /c "npx vite --port 3100"');
  assert.equal(win.env.API_PORT, '3101');
  assert.equal(win.env.DATA, '~/dev/3100');

  const vars = { PORT: '3100' };
  assert.deepEqual(leadingAssignments(`A="x y $PORT" B='$PORT' C=a"b"'c' D= run E=1`, vars), {
    env: { A: 'x y 3100', B: '$PORT', C: 'abc', D: '' },
    rest: 'run E=1',
  });
  assert.deepEqual(leadingAssignments('A="say \\"hi\\"" run', vars).env, { A: 'say "hi"' });
  assert.deepEqual(leadingAssignments('npm run dev', vars), { env: {}, rest: 'npm run dev' });
  assert.deepEqual(leadingAssignments('set A=1 && run', vars), { env: {}, rest: 'set A=1 && run' });
  assert.deepEqual(leadingAssignments('A=1&& run', vars), { env: {}, rest: 'A=1&& run' });
});

test('a missing program is reported by name', () => {
  assert.throws(
    () => resolveLaunch({ session: 's', name: 'agent', cwd: '/', argv: ['no-such-agent'] }, { PATH: '/nonexistent' }, 'linux'),
    /no-such-agent is not installed or not on PATH/,
  );
});

test("an AppImage's own paths are left out of what programs inherit", () => {
  const env = withoutAppImagePaths({
    APPDIR: '/tmp/.mount_remoteXYZ',
    PATH: '/tmp/.mount_remoteXYZ/usr/bin:/home/me/.local/bin:/usr/bin',
    LD_LIBRARY_PATH: '/tmp/.mount_remoteXYZ/usr/lib',
    HOME: '/home/me',
  });
  assert.equal(env.PATH, '/home/me/.local/bin:/usr/bin');
  assert.equal(env.LD_LIBRARY_PATH, undefined);
  assert.equal(env.HOME, '/home/me');
  assert.deepEqual(withoutAppImagePaths({ PATH: '/a:/b' }), { PATH: '/a:/b' });
});
