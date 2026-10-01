import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { FastifyReply } from 'fastify';
import type { ChatItem } from '../../shared/types.js';

const INITIAL_BYTES = 3 * 1024 * 1024;
const MAX_INITIAL_ITEMS = 400;
const POLL_MS = 400;

/**
 * Stream an agent's transcript (one JSON event per line) as chat items over server-sent events: `{reset: true, items}` with the
 * recent history, then `{items}` as lines are appended.
 */
export function streamTranscript(reply: FastifyReply, file: string | null, parseLine: (line: string) => ChatItem[]): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj: object) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (!file) {
    send({ reset: true, items: [] });
    return;
  }

  let offset = 0;
  let partial = '';
  const decoder = new StringDecoder('utf8');
  const read = (start: number, end: number) => {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(end - start);
      return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, start));
    } finally {
      fs.closeSync(fd);
    }
  };
  const take = (text: string): ChatItem[] => {
    const lines = (partial + text).split('\n');
    partial = lines.pop() ?? '';
    return lines.flatMap(parseLine);
  };

  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    // not written yet
  }
  const start = Math.max(0, size - INITIAL_BYTES);
  let initial = size > 0 ? decoder.write(read(start, size)) : '';
  if (start > 0) initial = initial.slice(initial.indexOf('\n') + 1);
  offset = size;
  send({ reset: true, items: take(initial).slice(-MAX_INITIAL_ITEMS) });

  const poll = setInterval(() => {
    let now: number;
    try {
      now = fs.statSync(file).size;
    } catch {
      return;
    }
    if (now <= offset) return;
    const items = take(decoder.write(read(offset, now)));
    offset = now;
    if (items.length > 0) send({ items });
  }, POLL_MS);
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
  reply.raw.on('close', () => {
    clearInterval(poll);
    clearInterval(ping);
  });
}
