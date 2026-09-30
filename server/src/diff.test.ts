import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { diffStat, parseShortstat, worktreeDiff } from './diff.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

test('parseShortstat', () => {
  assert.deepEqual(parseShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)\n'), { files: 3, additions: 10, deletions: 2 });
  assert.deepEqual(parseShortstat(' 1 file changed, 1 deletion(-)'), { files: 1, additions: 0, deletions: 1 });
  assert.deepEqual(parseShortstat(''), { files: 0, additions: 0, deletions: 0 });
});

test('a branch diff covers commits, uncommitted edits, renames, deletions and untracked files', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-diff-'));
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text);
  git(repo, 'init', '-q', '-b', 'main');
  write('app.ts', 'const a = 1;\nconst b = 2;\n');
  write('old-name.ts', 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
  write('gone.ts', 'bye\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');

  git(repo, 'checkout', '-q', '-b', 'feat');
  write('app.ts', 'const a = 1;\nconst b = 3;\nconst c = 4;\n');
  git(repo, 'commit', '-q', '-am', 'committed on the branch');
  // main moves on too; the diff should only show the branch's own work.
  git(repo, 'checkout', '-q', 'main');
  write('main-only.ts', 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'main moves on');
  git(repo, 'checkout', '-q', 'feat');
  // Uncommitted work on the branch.
  git(repo, 'mv', 'old-name.ts', 'new-name.ts');
  git(repo, 'rm', '-q', 'gone.ts');
  write('notes.md', 'untracked\nfile\n');

  const d = await worktreeDiff(repo, 'main');
  const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['app.ts', 'gone.ts', 'new-name.ts', 'notes.md']);
  assert.equal(byPath['app.ts']!.status, 'modified');
  assert.equal(byPath['app.ts']!.additions, 2);
  assert.equal(byPath['app.ts']!.deletions, 1);
  assert.equal(byPath['new-name.ts']!.status, 'renamed');
  assert.equal(byPath['new-name.ts']!.oldPath, 'old-name.ts');
  assert.equal(byPath['gone.ts']!.status, 'deleted');
  assert.equal(byPath['notes.md']!.status, 'untracked');
  assert.equal(byPath['notes.md']!.additions, 2);
  assert.match(byPath['app.ts']!.patch, /^@@ .* @@/m);
  assert.equal(d.base, 'main');
  assert.equal(d.against.length, 8);

  const stat = await diffStat(repo, git(repo, 'merge-base', 'main', 'HEAD').trim());
  assert.deepEqual(stat, { files: 3, additions: 2, deletions: 2 });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('the main checkout compares uncommitted work with HEAD', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-diff-'));
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const d = await worktreeDiff(repo, null);
  assert.equal(d.against, 'HEAD');
  assert.deepEqual(d.files.map((f) => [f.path, f.additions, f.deletions]), [['a.txt', 1, 1]]);
  fs.rmSync(repo, { recursive: true, force: true });
});
