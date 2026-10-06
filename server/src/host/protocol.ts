import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type net from 'node:net';

/**
 * The session host speaks newline-delimited JSON over a Unix socket (a named pipe on Windows).
 * Clients send requests and get one response each; a client that attaches to a terminal or
 * watches the host also receives events. Bump the version on any incompatible change.
 */
export const PROTOCOL_VERSION = 1;

/** What to run in a new terminal: an argv (agents) or a shell command line (dev servers, setup). */
export interface TermSpec {
  session: string;
  name: string;
  cwd: string;
  argv?: string[];
  command?: string;
  /** Added to the host's environment, which comes from the user's login shell. */
  env?: Record<string, string>;
  /** Everything the terminal prints is appended here. */
  logFile?: string;
  cols?: number;
  rows?: number;
}

export interface TermInfo {
  session: string;
  name: string;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  startedAt: number;
  /** Last time the program printed anything, for activity-based status. */
  lastOutputAt: number;
  bells: number;
}

export interface TermRef {
  session: string;
  name: string;
}

export type Request =
  | { op: 'hello'; token: string; version: number }
  | { op: 'list' }
  | { op: 'spawn'; spec: TermSpec }
  | ({ op: 'write'; data: string } & TermRef)
  | ({ op: 'keys'; keys: string[] } & TermRef)
  | ({ op: 'paste'; text: string } & TermRef)
  | ({ op: 'screen' } & TermRef)
  | ({ op: 'resize'; cols: number; rows: number } & TermRef)
  | ({ op: 'kill' } & TermRef)
  | ({ op: 'remove' } & TermRef)
  | { op: 'killSession'; session: string }
  | ({ op: 'attach'; cols?: number; rows?: number } & TermRef)
  | ({ op: 'detach' } & TermRef)
  | { op: 'watch' }
  | { op: 'shutdown' };

export type RequestMessage = Request & { id: number };

export type Response = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string };

export interface HelloResult {
  version: number;
  pid: number;
  /** The host's own script, which tells a desktop install which copy of the host is in use. */
  entry?: string;
}

export interface AttachResult {
  /** Escape sequences that redraw the screen and scrollback as they are now. */
  snapshot: string;
  /** The size the snapshot is drawn for. Older hosts leave it out. */
  cols?: number;
  rows?: number;
  alive: boolean;
  exitCode: number | null;
}

export type HostEvent =
  | ({ ev: 'data'; data: string } & TermRef)
  /** To a terminal's other viewers when one of them resizes it. */
  | ({ ev: 'resize'; cols: number; rows: number } & TermRef)
  | ({ ev: 'exit'; code: number | null } & TermRef)
  | ({ ev: 'spawn' } & TermRef);

export type Message = Response | HostEvent;

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export function isValidTermName(name: unknown): name is string {
  return typeof name === 'string' && NAME.test(name);
}

/** Where the host listens. Unix socket paths are limited to ~104 bytes, so long data dirs fall back to tmp. */
export function socketPath(dataDir: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(dataDir)).digest('hex').slice(0, 12);
  if (process.platform === 'win32') return `\\\\.\\pipe\\remote-ai-host-${hash}`;
  const preferred = path.join(dataDir, 'host.sock');
  return Buffer.byteLength(preferred) < 100 ? preferred : path.join(os.tmpdir(), `remote-ai-host-${hash}.sock`);
}

/** Clients prove they may use the host with a token only the user can read. */
export function loadHostToken(dataDir: string): string {
  const file = path.join(dataDir, 'host-token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(file, token, { mode: 0o600 });
    return token;
  }
}

/** Call `onMessage` with each JSON line that arrives on the socket. Malformed lines are dropped. */
export function readLines(socket: net.Socket, onMessage: (msg: unknown) => void): void {
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let nl: number;
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(msg);
    }
  });
}

export function writeLine(socket: net.Socket, msg: object): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
}
