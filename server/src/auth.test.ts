import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Auth, COOKIE, isLocalRequest, parseCookies } from './auth.js';

function fakeReq(opts: { remote?: string; headers?: Record<string, string> } = {}): FastifyRequest {
  return {
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
    ip: opts.remote ?? '127.0.0.1',
    protocol: 'http',
  } as unknown as FastifyRequest;
}
function fakeReply() {
  const headers: Record<string, string> = {};
  return { reply: { header: (k: string, v: string) => (headers[k] = v) } as unknown as FastifyReply, headers };
}

test('local means loopback without proxy headers', () => {
  assert.ok(isLocalRequest('127.0.0.1', {}));
  assert.ok(isLocalRequest('::1', {}));
  assert.ok(!isLocalRequest('127.0.0.1', { 'x-forwarded-for': '100.64.0.7' }), 'tailscale serve / reverse proxies');
  assert.ok(!isLocalRequest('127.0.0.1', { 'tailscale-user-login': 'me@example.com' }));
  assert.ok(!isLocalRequest('192.168.1.20', {}), 'another machine on the LAN');
});

test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; ra_session=x%2By; b'), { a: '1', ra_session: 'x+y' });
});

test('without a password everything is allowed', () => {
  const auth = new Auth(fs.mkdtempSync(path.join(os.tmpdir(), 'ra-auth-')), undefined);
  assert.equal(auth.enabled, false);
  assert.ok(auth.allowed(fakeReq({ remote: '10.0.0.5' })));
});

test('with a password: remote needs a login, local does not, and logins survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-auth-'));
  const auth = new Auth(dir, 'hunter2');
  const remote = { headers: { 'x-forwarded-for': '100.64.0.7' } };
  assert.ok(auth.allowed(fakeReq()), 'local tools such as Claude curl-ing the dev API');
  assert.ok(!auth.allowed(fakeReq(remote)));

  const { reply: r1 } = fakeReply();
  assert.equal(auth.login(fakeReq(remote), r1, 'wrong'), 'wrong');
  const { reply, headers } = fakeReply();
  assert.equal(auth.login(fakeReq(remote), reply, 'hunter2'), 'ok');
  const cookie = headers['Set-Cookie']!;
  assert.match(cookie, /^ra_session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  const token = cookie.split(';')[0]!.split('=')[1]!;

  const withCookie = fakeReq({ headers: { ...remote.headers, cookie: `${COOKIE}=${token}` } });
  assert.ok(auth.allowed(withCookie));
  assert.ok(new Auth(dir, 'hunter2').allowed(withCookie), 'sessions are persisted');
  assert.ok(!fs.readFileSync(path.join(dir, 'auth-sessions.json'), 'utf8').includes(token), 'only a hash is stored');

  auth.logout(withCookie, fakeReply().reply);
  assert.ok(!auth.allowed(withCookie));
});

test('wrong passwords are rate limited per address', () => {
  const auth = new Auth(fs.mkdtempSync(path.join(os.tmpdir(), 'ra-auth-')), 'pw');
  const req = fakeReq({ headers: { 'x-forwarded-for': '100.64.0.9' } });
  for (let i = 0; i < 10; i++) assert.equal(auth.login(req, fakeReply().reply, 'nope'), 'wrong');
  assert.equal(auth.login(req, fakeReply().reply, 'pw'), 'limited', 'even the right password waits');
  const other = fakeReq({ headers: { 'x-forwarded-for': '100.64.0.10' } });
  assert.equal(auth.login(other, fakeReply().reply, 'pw'), 'ok');
});
