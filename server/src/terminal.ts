import crypto from 'node:crypto';
import os from 'node:os';
import pty from 'node-pty';
import type { WebSocket } from 'ws';
import type { Tmux } from './tmux.js';

type ClientMessage = { t: 'i'; d: string } | { t: 'r'; c: number; r: number };

function clampSize(n: unknown, fallback: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 10 && v <= 500 ? v : fallback;
}

/**
 * Bridge a browser terminal to one tmux window. Each browser gets its own grouped
 * "viewer" session, so a phone on the server window and a laptop on the claude window
 * don't switch each other's view. The viewer is destroyed when the browser disconnects.
 */
export function attachTerminal(
  socket: WebSocket,
  opts: { tmux: Tmux; sessionId: string; window: string; cols: unknown; rows: unknown },
): void {
  const viewer = `${opts.sessionId}~${crypto.randomBytes(3).toString('hex')}`;
  const args = [
    ...opts.tmux.baseArgs(),
    'new-session', '-t', opts.sessionId, '-s', viewer,
    ';', 'set-option', '-t', viewer, 'destroy-unattached', 'on',
    ';', 'select-window', '-t', `${viewer}:${opts.window}`,
  ];

  const term = pty.spawn('tmux', args, {
    name: 'xterm-256color',
    cols: clampSize(opts.cols, 100),
    rows: clampSize(opts.rows, 30),
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  });

  term.onData((data) => {
    if (socket.readyState === socket.OPEN) socket.send(data);
  });
  term.onExit(() => {
    if (socket.readyState === socket.OPEN) socket.close(1000, 'detached');
  });

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
    else if (msg.t === 'r') term.resize(clampSize(msg.c, 100), clampSize(msg.r, 30));
  });
  socket.on('close', () => term.kill());
}
