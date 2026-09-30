import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import type { ListeningPort } from '../../shared/types.js';

/**
 * Parse `ss -ltnpH`: listening TCP sockets. Owning pids are only shown for our own processes,
 * which is exactly the set we care about.
 */
export function parseSs(out: string): { port: number; pid: number }[] {
  const seen = new Set<string>();
  const result: { port: number; pid: number }[] = [];
  for (const line of out.split('\n')) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port < 1024) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const key = `${port}/${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ port, pid: Number(m[1]) });
    }
  }
  return result;
}

/** A readable command line: absolute paths shortened to their file name. */
function describeProcess(pid: number): string {
  const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  return args
    .map((a) => (a.startsWith('/') ? path.basename(a) : a))
    .join(' ')
    .slice(0, 120);
}

/** Listening ports with the directory each owning process runs in, one entry per port. Linux only. */
export async function listeningPorts(): Promise<(ListeningPort & { cwd: string })[]> {
  if (process.platform !== 'linux') return [];
  let out: string;
  try {
    out = await run('ss', ['-ltnpH']);
  } catch {
    return [];
  }
  const byPort = new Map<number, ListeningPort & { cwd: string }>();
  for (const { port, pid } of parseSs(out)) {
    if (byPort.has(port)) continue;
    try {
      byPort.set(port, { port, pid, command: describeProcess(pid), cwd: fs.readlinkSync(`/proc/${pid}/cwd`) });
    } catch {
      // the process exited between ss and /proc
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}
