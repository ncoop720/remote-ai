import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyWorktreeIncludes, parseWorktrees, worktreeIncludeFiles } from './git.js';

test('worktree includes: untracked matches are copied, tracked files and non-matches are not', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-git-'));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  execFileSync('git', ['init', '-q', repo]);
  write('.worktreeinclude', '# secrets\nserver/.env\n*.local.json\n');
  write('tracked.local.json', '{}');
  execFileSync('git', ['-C', repo, 'add', '.']);
  write('server/.env', 'SECRET=1');
  write('.claude/settings.local.json', '{}');
  write('notes.txt', 'not listed');

  assert.deepEqual((await worktreeIncludeFiles(repo)).sort(), ['.claude/settings.local.json', 'server/.env']);

  fs.mkdirSync(wt);
  await copyWorktreeIncludes(repo, wt);
  assert.equal(fs.readFileSync(path.join(wt, 'server/.env'), 'utf8'), 'SECRET=1');
  assert.ok(fs.existsSync(path.join(wt, '.claude/settings.local.json')));
  assert.ok(!fs.existsSync(path.join(wt, 'notes.txt')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('worktree includes: no list file means nothing to copy', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-git-'));
  execFileSync('git', ['init', '-q', repo]);
  assert.deepEqual(await worktreeIncludeFiles(repo), []);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('parseWorktrees reads main checkout, branches and detached heads', () => {
  const out = [
    'worktree /home/me/projects/myapp',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /home/me/worktrees/myapp/feat-x',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/feat/x',
    '',
    'worktree /home/me/worktrees/myapp/spike',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    '',
    'worktree /home/me/worktrees/myapp/gone',
    'HEAD 4444444444444444444444444444444444444444',
    'branch refs/heads/gone',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');

  const wts = parseWorktrees(out);
  assert.equal(wts.length, 4);
  assert.deepEqual(wts[0], {
    path: '/home/me/projects/myapp',
    head: '1111111111111111111111111111111111111111',
    branch: 'main',
    bare: false,
    detached: false,
    prunable: false,
  });
  assert.equal(wts[1]?.branch, 'feat/x');
  assert.equal(wts[2]?.branch, null);
  assert.equal(wts[2]?.detached, true);
  assert.equal(wts[3]?.prunable, true);
});

test('clone URLs and project names', async () => {
  const { projectNameFromUrl, validateClone } = await import('./git.js');
  assert.equal(projectNameFromUrl('https://github.com/ncoop720/mmorpg.git'), 'mmorpg');
  assert.equal(projectNameFromUrl('git@github.com:ncoop720/remote-ai.git'), 'remote-ai');
  assert.equal(projectNameFromUrl('https://gitlab.com/group/sub/app/'), 'app');
  assert.equal(validateClone('https://github.com/a/b.git', 'b'), null);
  assert.equal(validateClone('git@github.com:a/b.git', 'b'), null);
  assert.match(validateClone('/etc', 'etc') ?? '', /https/);
  assert.match(validateClone('--upload-pack=evil', 'x') ?? '', /https/);
  assert.match(validateClone('https://github.com/a/b.git', '../escape') ?? '', /Project names/);
  assert.match(validateClone('https://github.com/a/b.git', '.hidden') ?? '', /Project names/);
});

test('parseWorktrees handles empty output', () => {
  assert.deepEqual(parseWorktrees(''), []);
});
