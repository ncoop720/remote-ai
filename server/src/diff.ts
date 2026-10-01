import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import type { DiffFile, DiffResult } from '../../shared/types.js';

const MAX_FILE_PATCH = 60 * 1024;
const MAX_TOTAL_PATCH = 600 * 1024;
const MAX_UNTRACKED = 50;
const MAX_UNTRACKED_BYTES = 200 * 1024;

const git = (cwd: string, args: string[]) => run('git', ['-C', cwd, ...args]);

/**
 * What the worktree changed since it branched: the merge base with `base` (or HEAD for the main
 * checkout) against the working tree, so committed and uncommitted work both count.
 */
export async function diffBase(worktree: string, base: string | null): Promise<string> {
  if (!base) return 'HEAD';
  try {
    return (await git(worktree, ['merge-base', base, 'HEAD'])).trim();
  } catch {
    return 'HEAD';
  }
}

/** Totals for the session list: `git diff --shortstat` (tracked files only). */
export function parseShortstat(out: string): { files: number; additions: number; deletions: number } {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(out);
  return { files: Number(m?.[1] ?? 0), additions: Number(m?.[2] ?? 0), deletions: Number(m?.[3] ?? 0) };
}

export async function diffStat(worktree: string, against: string) {
  return parseShortstat(await git(worktree, ['diff', '--shortstat', '-M', against]).catch(() => ''));
}

/** Split `git diff` output into one entry per file. */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const header = /^diff --git a\/(.*) b\/(.*)$/m.exec(chunk);
    const renameFrom = /^rename from (.*)$/m.exec(chunk)?.[1];
    const renameTo = /^rename to (.*)$/m.exec(chunk)?.[1];
    const filePath = renameTo ?? header?.[2] ?? '';
    const status: DiffFile['status'] = /^new file mode/m.test(chunk)
      ? 'added'
      : /^deleted file mode/m.test(chunk)
        ? 'deleted'
        : renameFrom
          ? 'renamed'
          : 'modified';
    let additions = 0;
    let deletions = 0;
    for (const line of chunk.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
    const truncated = chunk.length > MAX_FILE_PATCH;
    files.push({
      path: filePath,
      oldPath: renameFrom,
      status,
      additions,
      deletions,
      binary: /^Binary files /m.test(chunk),
      truncated,
      patch: truncated ? chunk.slice(0, MAX_FILE_PATCH) : chunk,
    });
  }
  return files;
}

/** Untracked files, shown as additions (git diff leaves them out). */
async function untrackedFiles(worktree: string): Promise<DiffFile[]> {
  const out = await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => '');
  const names = out.split('\0').filter(Boolean);
  const files: DiffFile[] = [];
  for (const name of names.slice(0, MAX_UNTRACKED)) {
    const full = path.join(worktree, name);
    let buf: Buffer;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      buf = fs.readFileSync(full).subarray(0, MAX_UNTRACKED_BYTES);
    } catch {
      continue;
    }
    const binary = buf.subarray(0, 8000).includes(0);
    const lines = binary ? [] : buf.toString('utf8').replace(/\n$/, '').split('\n');
    const patch = binary
      ? `diff --git a/${name} b/${name}\nBinary file (untracked)\n`
      : `diff --git a/${name} b/${name}\nnew file (untracked)\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
    const truncated = patch.length > MAX_FILE_PATCH;
    files.push({
      path: name,
      status: 'untracked',
      additions: lines.length,
      deletions: 0,
      binary,
      truncated,
      patch: truncated ? patch.slice(0, MAX_FILE_PATCH) : patch,
    });
  }
  return files;
}

export async function worktreeDiff(worktree: string, base: string | null): Promise<DiffResult> {
  const against = await diffBase(worktree, base);
  const patch = await git(worktree, ['diff', '--no-color', '--no-ext-diff', '-M', against]);
  let files = [...parsePatch(patch), ...(await untrackedFiles(worktree))];
  let total = 0;
  let truncated = false;
  files = files.filter((f) => {
    total += f.patch.length;
    if (total > MAX_TOTAL_PATCH) truncated = true;
    return total <= MAX_TOTAL_PATCH;
  });
  const shortAgainst = against === 'HEAD' ? 'HEAD' : against.slice(0, 8);
  return {
    base,
    against: shortAgainst,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    truncated,
  };
}
