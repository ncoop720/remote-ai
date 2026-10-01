import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Auth, COOKIE, isLocalRequest, parseCookies } from './auth.js';
import { DEVICE_COOKIE, Devices } from './devices.js';

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

test('without a password or pairing, everything is allowed (as in v1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-auth-'));
  const auth = new Auth(dir, new Devices(dir));
  assert.equal(auth.enabled, false);
  assert.ok(auth.allowed(fakeReq({ remote: '10.0.0.5' })));
});

test('with a password: remote needs a login, local does not, and logins survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-auth-'));
  const auth = new Auth(dir, new Devices(dir), { password: 'hunter2' });
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
  assert.ok(new Auth(dir, new Devices(dir), { password: 'hunter2' }).allowed(withCookie), 'sessions are persisted');
  assert.ok(!fs.readFileSync(path.join(dir, 'auth-sessions.json'), 'utf8').includes(token), 'only a hash is stored');

  auth.logout(withCookie, fakeReply().reply);
  assert.ok(!auth.allowed(withCookie));
});

test('wrong passwords are rate limited per address', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-auth-'));
  const auth = new Auth(dir, new Devices(dir), { password: 'pw' });
  const req = fakeReq({ headers: { 'x-forwarded-for': '100.64.0.9' } });
  for (let i = 0; i < 10; i++) assert.equal(auth.login(req, fakeReply().reply, 'nope'), 'wrong');
  assert.equal(auth.login(req, fakeReply().reply, 'pw'), 'limited', 'even the right password waits');
  const other = fakeReq({ headers: { 'x-forwarded-for': '100.64.0.10' } });
  assert.equal(auth.login(other, fakeReply().reply, 'pw'), 'ok');
});

test('with pairing required, remote requests need a paired device', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-auth-'));
  const devices = new Devices(dir);
  const auth = new Auth(dir, devices, { requirePairing: true });
  const phone = { remote: '192.168.1.20', headers: { 'user-agent': 'iPhone' } };
  assert.ok(auth.allowed(fakeReq()), 'this computer');
  assert.ok(!auth.allowed(fakeReq(phone)));

  const { code } = devices.createCode();
  const paired = devices.pair(code, { name: 'iPhone', via: 'wifi' });
  assert.ok(typeof paired === 'object');
  const cookie = `${DEVICE_COOKIE}=${paired.cookie}`;
  assert.ok(auth.allowed(fakeReq({ ...phone, headers: { cookie } })));
  assert.equal(auth.device(fakeReq({ ...phone, headers: { cookie } }))?.name, 'iPhone');
  assert.ok(!auth.allowed(fakeReq({ ...phone, headers: { cookie: `${DEVICE_COOKIE}=${paired.cookie}x` } })), 'a wrong token');

  devices.remove(paired.device.id);
  assert.ok(!auth.allowed(fakeReq({ ...phone, headers: { cookie } })), 'removed devices are out');
});

test('through the Tailscale proxy, only your own devices get in without pairing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-auth-'));
  const auth = new Auth(dir, new Devices(dir), { requirePairing: true, proxySecret: 's3cret', tailnetOwner: () => 'me@example.com' });
  const via = (login: string, secret = 's3cret') =>
    fakeReq({ headers: { 'x-forwarded-for': '100.64.0.7', 'x-remote-ai-proxy': secret, 'x-remote-ai-tailscale-login': login } });
  assert.ok(auth.allowed(via('me@example.com')));
  assert.ok(!auth.allowed(via('friend@example.com')), "someone else's device on a shared tailnet");
  assert.ok(!auth.allowed(via('me@example.com', 'forged')), 'headers without the proxy secret');
  assert.ok(!auth.allowed(fakeReq({ remote: '10.0.0.5', headers: { 'x-remote-ai-tailscale-login': 'me@example.com' } })));
});
