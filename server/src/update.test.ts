import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installRoot, versionInfo } from './update.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

test('versionInfo counts commits waiting upstream', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-upd-'));
  const origin = path.join(root, 'origin');
  const install = path.join(root, 'install');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ name: 'remote-ai' }));
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'one');
  git(root, 'clone', '-q', origin, install);

  let info = await versionInfo(install, true);
  assert.equal(info.behind, 0);
  assert.equal(info.branch, 'main');
  assert.equal(info.dirty, false);

  fs.writeFileSync(path.join(origin, 'a.txt'), 'x');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'two');
  fs.writeFileSync(path.join(install, 'package.json'), '{"name":"remote-ai","changed":1}');
  info = await versionInfo(install, true);
  assert.equal(info.behind, 1);
  assert.equal(info.dirty, true, 'local edits would block a fast-forward');

  assert.equal(installRoot(path.join(install, 'dist', 'server', 'src')), install);
  fs.rmSync(root, { recursive: true, force: true });
});
