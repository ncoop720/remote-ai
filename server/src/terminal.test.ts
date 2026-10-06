import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { WebSocket } from 'ws';
import type { HostClient } from './hostclient.js';
import { attachTerminal } from './terminal.js';

/** A browser's socket: text frames come out as strings, binary frames as parsed JSON. */
function fakeSocket() {
  const socket = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    frames: [] as unknown[],
    send(data: string | Buffer) {
      socket.frames.push(typeof data === 'string' ? data : JSON.parse(data.toString()));
    },
    close() {
      socket.readyState = 3;
    },
  });
  return socket;
}

test('a browser gets the size, then the snapshot, then what the host said meanwhile', async () => {
  const socket = fakeSocket();
  const resized: number[][] = [];
  const host = {
    attach: async (_ref: unknown, _size: unknown, on: Parameters<HostClient['attach']>[2]) => {
      // Arrives in the same read as the attach result, before the snapshot has been sent.
      on.data('after');
      on.resize(90, 20);
      return { snapshot: 'snapshot', cols: 80, rows: 24, alive: true, exitCode: null, write: () => undefined, resize: (c: number, r: number) => resized.push([c, r]), close: () => undefined };
    },
  } as unknown as HostClient;

  await attachTerminal(socket as unknown as WebSocket, { host, ref: { session: 's', name: 'agent' }, cols: 100, rows: 30 });
  assert.deepEqual(socket.frames, [{ t: 'size', c: 80, r: 24 }, 'snapshot', 'after', { t: 'resize', c: 90, r: 20 }]);

  socket.emit('message', Buffer.from(JSON.stringify({ t: 'r', c: 70, r: 25 })));
  socket.emit('message', Buffer.from(JSON.stringify({ t: 'r', c: 5, r: 25 })));
  assert.deepEqual(resized, [[70, 25]], 'sizes out of range are ignored');
});

test("an older host's attach has no size, and none is sent", async () => {
  const socket = fakeSocket();
  const host = {
    attach: async () => ({ snapshot: 'snapshot', alive: true, exitCode: null, write: () => undefined, resize: () => undefined, close: () => undefined }),
  } as unknown as HostClient;

  await attachTerminal(socket as unknown as WebSocket, { host, ref: { session: 's', name: 'agent' }, cols: undefined, rows: undefined });
  assert.deepEqual(socket.frames, ['snapshot']);
});
