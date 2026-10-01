import type { WebSocket } from 'ws';
import type { HostClient } from './hostclient.js';
import type { TermRef } from './host/protocol.js';

type ClientMessage = { t: 'i'; d: string } | { t: 'r'; c: number; r: number };

/** Close codes the web client understands. */
export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_EXITED = 4410;

function size(n: unknown): number | undefined {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 10 && v <= 500 ? v : undefined;
}

/**
 * Bridge a browser terminal to one terminal in the session host. The browser first gets a snapshot
 * of the screen and scrollback, then the live output. Every viewer types into the same program;
 * the terminal takes the size of whichever viewer resized last.
 */
export async function attachTerminal(
  socket: WebSocket,
  opts: { host: HostClient; ref: TermRef; cols: unknown; rows: unknown },
): Promise<void> {
  const send = (data: string) => {
    if (socket.readyState === socket.OPEN) socket.send(data);
  };
  const close = (code: number, reason: string) => {
    if (socket.readyState === socket.OPEN) socket.close(code, reason);
  };

  const attachment = await opts.host.attach(
    opts.ref,
    { cols: size(opts.cols), rows: size(opts.rows) },
    { data: send, exit: () => close(CLOSE_EXITED, 'exited'), close: () => close(1011, 'host disconnected') },
  );
  if (!attachment) {
    close(CLOSE_NOT_FOUND, 'Not running');
    return;
  }
  send(attachment.snapshot);
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
