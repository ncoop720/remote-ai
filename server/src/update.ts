import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import type { UpdateResult, VersionInfo } from '../../shared/types.js';

/** Where /api/version and /api/update get their answers: git for a checkout, electron-updater in the desktop app. */
export interface UpdateProvider {
  info(check: boolean): Promise<VersionInfo>;
  update(): Promise<UpdateResult>;
}

/** The checkout this server runs from: the nearest folder up with remote-ai's package.json. */
export function installRoot(start: string): string | null {
  for (let dir = start; ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'remote-ai' && fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      // keep looking
    }
    if (path.dirname(dir) === dir) return null;
  }
}

export async function versionInfo(root: string, fetch: boolean): Promise<Extract<VersionInfo, { kind: 'git' }>> {
  const git = (...args: string[]) => run('git', ['-C', root, ...args]).then((s) => s.trim());
  let behind: number | null = null;
  try {
    if (fetch) await git('fetch', '--quiet');
    behind = Number(await git('rev-list', '--count', 'HEAD..@{upstream}'));
  } catch {
    behind = null;
  }
  return {
    kind: 'git',
    commit: await git('rev-parse', '--short', 'HEAD'),
    branch: await git('rev-parse', '--abbrev-ref', 'HEAD'),
    behind,
    dirty: (await git('status', '--porcelain', '--untracked-files=no')) !== '',
    managed: Boolean(process.env.INVOCATION_ID),
  };
}

function exec(cmd: string, args: string[], cwd: string, log: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    log.push(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { cwd, env: process.env });
    const collect = (d: Buffer) => log.push(...d.toString().split('\n').filter(Boolean));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args[0] ?? ''} exited with ${code}`));
    });
  });
}

/** Fast-forward to upstream, reinstall if dependencies changed, and rebuild. */
export async function update(root: string): Promise<Omit<UpdateResult, 'restarting'>> {
  const log: string[] = [];
  const head = async () => (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim();
  const from = await head();
  try {
    await exec('git', ['pull', '--ff-only'], root, log);
    const to = await head();
    if (to === from) return { ok: true, from, to, restartNeeded: false, log: [...log, 'Already up to date.'] };
    const changed = (await run('git', ['-C', root, 'diff', '--name-only', from, to])).split('\n').filter(Boolean);
    if (changed.some((f) => f === 'package.json' || f === 'package-lock.json')) {
      await exec('npm', ['ci', '--no-audit', '--no-fund'], root, log);
    }
    await exec('npm', ['run', 'build'], root, log);
    const restartNeeded = changed.some((f) => /^(server|shared)\/|^package(-lock)?\.json$/.test(f));
    return { ok: true, from, to, restartNeeded, log: log.slice(-60) };
  } catch (err) {
    log.push((err as Error).message);
    return { ok: false, from, to: await head(), restartNeeded: false, log: log.slice(-60) };
  }
}

/** Updates for a git checkout: pull and rebuild, then restart if running under systemd. */
export function gitUpdates(root: string): UpdateProvider {
  return {
    info: (check) => versionInfo(root, check),
    async update() {
      const result = await update(root);
      // Under systemd (Restart=always) exiting is a restart. Sessions live in the session host, so they carry on.
      const restarting = result.ok && result.restartNeeded && Boolean(process.env.INVOCATION_ID);
      if (restarting) setTimeout(() => process.exit(0), 500);
      return { ...result, restarting };
    },
  };
}
