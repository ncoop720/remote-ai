import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { noticeFor, PushService, type Sender } from './push.js';
import type { SessionStatus } from '../../shared/types.js';

const label = { id: 'game__feat-x', project: 'game', branch: 'feat/x', agent: 'Claude Code' };
const s = (state: SessionStatus['state'], extra: Partial<SessionStatus> = {}): SessionStatus => ({ state, updatedAt: 1, ...extra });

test('a permission request notifies with the command', () => {
  const n = noticeFor(label, s('working'), s('needs_input', { tool: { name: 'Bash', input: { command: 'pnpm add x' }, summary: 'pnpm add x' } }));
  assert.deepEqual(n, { title: 'game / feat/x needs you', body: 'Bash: pnpm add x', tag: 'game__feat-x', url: '/#/s/game__feat-x' });
});

test('the follow-up permission_prompt notification does not notify twice', () => {
  assert.equal(noticeFor(label, s('needs_input'), s('needs_input', { message: 'Claude needs your permission' })), null);
});

test('finishing a turn notifies with the reply; idle reminders do not', () => {
  const n = noticeFor(label, s('working'), s('idle', { lastMessage: 'All   3 tests\npass.' }));
  assert.equal(n?.title, 'game / feat/x finished');
  assert.equal(n?.body, 'All 3 tests pass.');
  assert.equal(noticeFor(label, s('idle'), s('idle', { message: 'Claude is waiting for your input' })), null);
  assert.equal(noticeFor(label, s('unknown'), s('working')), null);
  assert.equal(noticeFor(label, s('working'), s('idle'))?.body, 'Claude Code finished its turn');
});

test('subscriptions persist, and expired ones are dropped when a send gets 410', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-push-'));
  const keys = { p256dh: 'BPk', auth: 'aa' };
  const sent: { endpoint: string; payload: string; topic: string }[] = [];
  const sender: Sender = async (sub, payload, options) => {
    sent.push({ endpoint: sub.endpoint, payload, topic: options.topic });
    if (sub.endpoint.endsWith('/gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
  };

  const push = new PushService(dir, 'https://example.com/remote-ai', sender);
  assert.throws(() => push.subscribe({ endpoint: 'http://insecure', keys }), /Not a push subscription/);
  assert.throws(() => push.subscribe({ endpoint: 'https://x/no-keys' }), /Not a push subscription/);
  push.subscribe({ endpoint: 'https://relay.example/ok', keys });
  push.subscribe({ endpoint: 'https://relay.example/gone', keys });
  push.subscribe({ endpoint: 'https://relay.example/ok', keys });

  const reloaded = new PushService(dir, 'https://example.com/remote-ai', sender);
  assert.equal(reloaded.info().subscriptions, 2, 'resubscribing replaces, and subscriptions survive a restart');
  assert.equal(reloaded.info().publicKey, push.info().publicKey, 'VAPID keys are kept');

  const result = await reloaded.send({ title: 't', body: 'b', tag: 'game__feat-x', url: '/' });
  assert.deepEqual(result, { sent: 1, failed: 1 });
  assert.equal(reloaded.info().subscriptions, 1, 'the 410 subscription was dropped');
  assert.deepEqual(JSON.parse(sent[0]!.payload), { title: 't', body: 'b', tag: 'game__feat-x', url: '/' });
  assert.match(sent[0]!.topic, /^[A-Za-z0-9_-]{32}$/, 'topics must be 32 url-safe characters');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the real sender encrypts for the browser (aes128gcm) and signs with VAPID', async () => {
  const { default: webpush } = await import('web-push');
  const ecdh = (await import('node:crypto')).createECDH('prime256v1');
  ecdh.generateKeys();
  const vapid = webpush.generateVAPIDKeys();
  const req = webpush.generateRequestDetails(
    { endpoint: 'https://relay.example/x', keys: { p256dh: ecdh.getPublicKey('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } },
    '{"title":"t"}',
    { TTL: 3600, vapidDetails: { subject: 'https://example.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey } },
  );
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.match(String(req.headers.Authorization), /^vapid t=.+, k=/);
  assert.ok((req.body as Buffer).length > 16);
});
