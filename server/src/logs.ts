import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { FastifyReply } from 'fastify';

const INITIAL_BYTES = 64 * 1024;
const MAX_CHUNK = 1024 * 1024;
const ROTATE_BYTES = 5 * 1024 * 1024;
const POLL_MS = 400;

export function logDir(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'logs', sessionId);
}

export function logFile(dataDir: string, sessionId: string, name: string): string {
  return path.join(logDir(dataDir, sessionId), `${name}.log`);
}

/** Mark the start of a new run. A log that grew large is moved to `<name>.log.1` first. */
export function beginLog(file: string, title: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
  fs.appendFileSync(file, `\n\x1b[2m──── ${title} · ${new Date().toLocaleString()} ────\x1b[0m\n`);
}

function readRange(file: string, start: number, end: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Stream a log over server-sent events: the last 64 KB as `{reset: true, text}`, then each
 * appended chunk as `{text}`. A shrinking file (rotation) starts over with a reset.
 */
export function streamLog(reply: FastifyReply, file: string): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj: object) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
  let offset = 0;
  let decoder = new StringDecoder('utf8');

  const reset = () => {
    const size = sizeOf(file);
    const start = Math.max(0, size - INITIAL_BYTES);
    let text = size > 0 ? new StringDecoder('utf8').end(readRange(file, start, size)) : '';
    // Starting mid-file: drop the partial first line.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    decoder = new StringDecoder('utf8');
    offset = size;
    send({ reset: true, text });
  };

  reset();
  const poll = setInterval(() => {
    const size = sizeOf(file);
    if (size < offset) return reset();
    if (size === offset) return;
    const end = Math.min(size, offset + MAX_CHUNK);
    const buf = readRange(file, offset, end);
    offset += buf.length;
    const text = decoder.write(buf);
    if (text) send({ text });
  }, POLL_MS);
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
  reply.raw.on('close', () => {
    clearInterval(poll);
    clearInterval(ping);
  });
}
