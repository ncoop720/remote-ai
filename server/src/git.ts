import fs from 'node:fs';
import path from 'node:path';
import { CommandError, run } from './exec.js';

export interface Worktree {
  path: string;
  head: string | null;
  /** Short branch name, or null when detached. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

/**
 * The one spelling of a path, for everything that keys on it (ports, bases, agents, setup markers)
 * or passes it on. On Windows git prints C:/Users/me/..., where path.join and the agent's hooks
 * give C:\Users\me\...; both become the latter.
 */
export function canonicalPath(p: string, platform = process.platform): string {
  if (platform !== 'win32') return p;
  return path.win32.normalize(p).replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

/** Parse `git worktree list --porcelain`. The first entry is the main checkout. */
export function parseWorktrees(porcelain: string, platform = process.platform): Worktree[] {
  const result: Worktree[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    const first = lines[0];
    if (!first?.startsWith('worktree ')) continue;
    const wt: Worktree = {
      path: canonicalPath(first.slice('worktree '.length), platform),
      head: null,
      branch: null,
      bare: false,
      detached: false,
      prunable: false,
    };
    for (const line of lines.slice(1)) {
      if (line.startsWith('HEAD ')) wt.head = line.slice(5);
      else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'bare') wt.bare = true;
      else if (line === 'detached') wt.detached = true;
      else if (line.startsWith('prunable')) wt.prunable = true;
    }
    result.push(wt);
  }
  return result;
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  return parseWorktrees(await run('git', ['-C', repo, 'worktree', 'list', '--porcelain']));
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch (err) {
    if (err instanceof CommandError && err.exitCode === 1) return false;
    throw err;
  }
}

export async function isValidBranchName(branch: string): Promise<boolean> {
  try {
    await run('git', ['check-ref-format', '--branch', branch]);
    return true;
  } catch {
    return false;
  }
}

/** Create a worktree at `path`, creating `branch` from `base` unless it already exists. */
export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  if (await branchExists(repo, branch)) {
    await run('git', ['-C', repo, 'worktree', 'add', path, branch]);
  } else {
    await run('git', ['-C', repo, 'worktree', 'add', '-b', branch, path, base]);
  }
}

/**
 * Untracked files in `repo` matched by its `.worktreeinclude` (gitignore syntax), such as `.env`
 * files. Same convention as Claude Code's own worktrees. Paths are relative, with `/` separators.
 */
export async function worktreeIncludeFiles(repo: string): Promise<string[]> {
  const listFile = path.join(repo, '.worktreeinclude');
  if (!fs.existsSync(listFile)) return [];
  const out = await run('git', ['-C', repo, 'ls-files', '--others', '--ignored', `--exclude-from=${listFile}`, '-z']);
  return out.split('\0').filter(Boolean);
}

/** Copy `.worktreeinclude` files from the main checkout into a new worktree. Returns what was copied. */
export async function copyWorktreeIncludes(repo: string, worktreePath: string): Promise<string[]> {
  const files = await worktreeIncludeFiles(repo);
  for (const rel of files) {
    const dest = path.join(worktreePath, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repo, rel), dest);
    fs.chmodSync(dest, fs.statSync(path.join(repo, rel)).mode);
  }
  return files;
}

export async function removeWorktree(repo: string, path: string, force: boolean): Promise<void> {
  const args = ['-C', repo, 'worktree', 'remove', ...(force ? ['--force'] : []), path];
  await run('git', args);
}

const REPO_URL = /^(https:\/\/[^\s]+|ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** "https://github.com/me/my-app.git" → "my-app". */
export function projectNameFromUrl(url: string): string {
  return (
    url
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/, '') ?? ''
  );
}

export function validateClone(url: string, name: string): string | null {
  if (!REPO_URL.test(url)) return 'Use an https:// or SSH (git@host:owner/repo) URL';
  if (!PROJECT_NAME.test(name)) return 'Project names use letters, digits, dots, dashes and underscores';
  return null;
}

/** Clone without ever prompting: a missing credential fails fast instead of hanging the server. */
export async function cloneRepo(url: string, dest: string): Promise<void> {
  await run('git', ['clone', '--quiet', '--', url, dest], {
    env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
    timeoutMs: 10 * 60_000,
    label: 'git clone',
  });
}

/** Number of changed or untracked files. */
export async function dirtyCount(path: string): Promise<number> {
  const out = await run('git', ['-C', path, 'status', '--porcelain']);
  return out.split('\n').filter((l) => l.trim().length > 0).length;
}

/** Commits on HEAD that are not on `base`, or null if `base` can't be resolved. */
export async function aheadOf(path: string, base: string): Promise<number | null> {
  try {
    const out = await run('git', ['-C', path, 'rev-list', '--count', `${base}..HEAD`]);
    return Number(out.trim());
  } catch {
    return null;
  }
}
