import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';

/** A TCP port something on this computer listens on, and the process that does. */
export interface ListeningSocket {
  port: number;
  pid: number;
}

export interface ListeningProcess extends ListeningSocket {
  /** A readable command line: absolute paths shortened to their file name. */
  command: string;
  /** The whole command line, paths and all. */
  commandLine: string;
  /** Its working directory, where the OS tells (not on Windows). */
  cwd: string | null;
  /** Parent, grandparent, ... up to the first process. */
  ancestors: number[];
}

const portOf = (address: string) => Number(address.slice(address.lastIndexOf(':') + 1));
const usable = (port: number) => Number.isInteger(port) && port >= 1024;

/** Keep the first process seen on each port. */
function onePerPort(sockets: ListeningSocket[]): ListeningSocket[] {
  const seen = new Set<number>();
  return sockets.filter((s) => (seen.has(s.port) ? false : (seen.add(s.port), true)));
}

/**
 * Parse Linux `ss -ltnpH`: listening TCP sockets. Owning pids are only shown for our own
 * processes, which is exactly the set we care about.
 */
export function parseSs(out: string): ListeningSocket[] {
  const seen = new Set<string>();
  const result: ListeningSocket[] = [];
  for (const line of out.split('\n')) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const port = portOf(local);
    if (!usable(port)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const key = `${port}/${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ port, pid: Number(m[1]) });
    }
  }
  return result;
}

/** Parse macOS `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: a `p<pid>` line, then `n<address>:<port>` lines. */
export function parseLsof(out: string): ListeningSocket[] {
  const result: ListeningSocket[] = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) {
      const port = portOf(line.slice(1));
      if (usable(port)) result.push({ port, pid });
    }
  }
  return result;
}

/** Parse `lsof -a -d cwd -p <pids> -Fpn`: each process's working directory. */
export function parseLsofCwd(out: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** Parse Windows `netstat -ano`: TCP lines in the LISTENING state. */
export function parseNetstat(out: string): ListeningSocket[] {
  const result: ListeningSocket[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
    const port = portOf(cols[1] ?? '');
    const pid = Number(cols[4]);
    if (usable(port) && pid > 0) result.push({ port, pid });
  }
  return result;
}

/** Parse `ps -A -o pid=,ppid=,command=` (macOS). */
export function parsePs(out: string): Map<number, { ppid: number; command: string }> {
  const procs = new Map<number, { ppid: number; command: string }>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), command: m[3]!.trim() });
  }
  return procs;
}

/** Parse the JSON list of Win32_Process objects PowerShell prints. */
export function parseWindowsProcesses(out: string): Map<number, { ppid: number; command: string; commandLine: string }> {
  const procs = new Map<number, { ppid: number; command: string; commandLine: string }>();
  let list: unknown;
  try {
    list = JSON.parse(out);
  } catch {
    return procs;
  }
  for (const p of Array.isArray(list) ? list : [list]) {
    const { ProcessId, ParentProcessId, Name, CommandLine } = (p ?? {}) as {
      ProcessId?: number;
      ParentProcessId?: number;
      Name?: string;
      CommandLine?: string | null;
    };
    if (typeof ProcessId === 'number') {
      procs.set(ProcessId, { ppid: ParentProcessId ?? 0, command: Name ?? '', commandLine: CommandLine ?? Name ?? '' });
    }
  }
  return procs;
}

export function ancestorsOf(pid: number, parentOf: (pid: number) => number | undefined): number[] {
  const chain: number[] = [];
  let p = parentOf(pid);
  while (p && p > 0 && !chain.includes(p) && chain.length < 64) {
    chain.push(p);
    p = parentOf(p);
  }
  return chain;
}

/** A process and everything it started, parents before their children. */
export function processTree(pid: number, parents: Map<number, number>): number[] {
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) {
    for (const [child, parent] of parents) if (parent === tree[i] && !tree.includes(child)) tree.push(child);
  }
  return tree;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** End a process and everything it started: politely, then by force if it's still there after a few seconds. */
export async function stopProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    // A console program without its console can only be ended by force. Fails if it already exited.
    await run('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => undefined);
    return;
  }
  const ps = await run('ps', ['-A', '-o', 'pid=,ppid=,command=']).then(parsePs, () => new Map<number, { ppid: number }>());
  const tree = processTree(pid, new Map([...ps].map(([p, { ppid }]) => [p, ppid])));
  const signal = (pids: number[], sig: NodeJS.Signals) => {
    for (const p of pids) {
      try {
        process.kill(p, sig);
      } catch {
        // already gone
      }
    }
  };
  signal(tree, 'SIGTERM');
  for (let i = 0; i < 30 && tree.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  signal(tree.filter(alive), 'SIGKILL');
}

function shorten(command: string): string {
  return command
    .split(' ')
    .map((a) => (a.startsWith('/') ? path.basename(a) : a))
    .join(' ')
    .slice(0, 120);
}

async function sockets(): Promise<ListeningSocket[]> {
  try {
    switch (process.platform) {
      case 'linux':
        return onePerPort(parseSs(await run('ss', ['-ltnpH'])));
      case 'darwin':
        // lsof exits 1 when nothing matches.
        return onePerPort(parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']).catch(() => '')));
      case 'win32':
        return onePerPort(parseNetstat(await run('netstat', ['-ano', '-p', 'TCP'])).concat(parseNetstat(await run('netstat', ['-ano', '-p', 'TCPv6']))));
      default:
        return [];
    }
  } catch {
    return [];
  }
}

/** Listening ports and their owners, cheaply: for noticing that something changed. */
export function listeningSockets(): Promise<ListeningSocket[]> {
  return sockets();
}

function linuxDetails(pid: number): Omit<ListeningProcess, 'port' | 'pid'> | null {
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    const parentOf = (p: number) => {
      try {
        // The field after the command name in parentheses (which may itself contain spaces or parens).
        const stat = fs.readFileSync(`/proc/${p}/stat`, 'utf8');
        return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      } catch {
        return undefined;
      }
    };
    return { command: shorten(command), commandLine: command, cwd, ancestors: ancestorsOf(pid, parentOf) };
  } catch {
    return null; // exited since the listing
  }
}

/** Listening ports with what each owning process is, where it runs and what started it. */
export async function listeningPorts(): Promise<ListeningProcess[]> {
  const found = await sockets();
  if (found.length === 0) return [];
  const result: ListeningProcess[] = [];

  if (process.platform === 'linux') {
    for (const s of found) {
      const d = linuxDetails(s.pid);
      if (d) result.push({ ...s, ...d });
    }
  } else if (process.platform === 'darwin') {
    const pids = [...new Set(found.map((s) => s.pid))].join(',');
    const [ps, cwd] = await Promise.all([
      run('ps', ['-A', '-o', 'pid=,ppid=,command=']).then(parsePs, () => new Map()),
      run('lsof', ['-a', '-d', 'cwd', '-p', pids, '-Fpn']).then(parseLsofCwd, () => new Map<number, string>()),
    ]);
    for (const s of found) {
      result.push({
        ...s,
        command: shorten(ps.get(s.pid)?.command ?? ''),
        commandLine: ps.get(s.pid)?.command ?? '',
        cwd: cwd.get(s.pid) ?? null,
        ancestors: ancestorsOf(s.pid, (p) => ps.get(p)?.ppid),
      });
    }
  } else if (process.platform === 'win32') {
    const procs = await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ]).then(parseWindowsProcesses, () => new Map<number, { ppid: number; command: string; commandLine: string }>());
    for (const s of found) {
      const proc = procs.get(s.pid);
      result.push({
        ...s,
        command: proc?.command ?? '',
        commandLine: proc?.commandLine ?? '',
        cwd: null,
        ancestors: ancestorsOf(s.pid, (p) => procs.get(p)?.ppid),
      });
    }
  }
  return result.sort((a, b) => a.port - b.port);
}
