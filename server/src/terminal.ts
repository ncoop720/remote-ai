import type { WebSocket } from 'ws';
import type { HostClient } from './hostclient.js';
import type { TermRef } from './host/protocol.js';

type ClientMessage = { t: 'i'; d: string } | { t: 'r'; c: number; r: number };

/** The program's size: `size` before the snapshot, `resize` when another viewer changes it. */
type ServerMessage = { t: 'size' | 'resize'; c: number; r: number };

/** Close codes the web client understands. */
export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_EXITED = 4410;

function size(n: unknown): number | undefined {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 10 && v <= 500 ? v : undefined;
}

/**
 * Bridge a browser terminal to one terminal in the session host. The browser first gets the
 * program's size and a snapshot of the screen and scrollback, then the live output. Every viewer
 * types into the same program, which draws for whichever viewer sized it last; the others are told
 * the new size so they draw at it too.
 */
export async function attachTerminal(
  socket: WebSocket,
  opts: { host: HostClient; ref: TermRef; cols: unknown; rows: unknown },
): Promise<void> {
  // Output goes in text frames, everything else as JSON in binary frames, which pages from before
  // there was anything else ignore.
  const send = (data: string) => {
    if (socket.readyState === socket.OPEN) socket.send(data);
  };
  const control = (msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(Buffer.from(JSON.stringify(msg)));
  };
  const close = (code: number, reason: string) => {
    if (socket.readyState === socket.OPEN) socket.close(code, reason);
  };

  // What the host says while the snapshot is still on its way waits behind it.
  let early: (() => void)[] | null = [];
  const inOrder = (fn: () => void) => (early ? early.push(fn) : fn());

  const attachment = await opts.host.attach(
    opts.ref,
    { cols: size(opts.cols), rows: size(opts.rows) },
    {
      data: (data) => inOrder(() => send(data)),
      resize: (c, r) => inOrder(() => control({ t: 'resize', c, r })),
      exit: () => inOrder(() => close(CLOSE_EXITED, 'exited')),
      close: () => inOrder(() => close(1011, 'host disconnected')),
    },
  );
  if (!attachment) {
    close(CLOSE_NOT_FOUND, 'Not running');
    return;
  }
  if (attachment.cols && attachment.rows) control({ t: 'size', c: attachment.cols, r: attachment.rows });
  send(attachment.snapshot);
  for (const fn of early) fn();
  early = null;
  if (!attachment.alive) {
    attachment.close();
    close(CLOSE_EXITED, 'exited');
    return;
  }

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') attachment.write(msg.d);
    else if (msg.t === 'r') {
      const c = size(msg.c);
      const r = size(msg.r);
      if (c && r) attachment.resize(c, r);
    }
  });
  socket.on('close', () => attachment.close());
}
