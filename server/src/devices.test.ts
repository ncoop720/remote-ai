import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deviceName, Devices, formatCode, normalizeCode } from './devices.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ra-devices-'));

test('a code pairs one device, once, within ten minutes', () => {
  const devices = new Devices(tmp());
  const { code, expiresAt } = devices.createCode(1000);
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(expiresAt, 1000 + 10 * 60_000);

  const typed = formatCode(code).toLowerCase(); // "abcd-efgh"
  const paired = devices.pair(typed, { name: 'iPhone', via: 'wifi' }, 2000);
  assert.ok(typeof paired === 'object');
  assert.equal(devices.verify(paired.cookie, 3000)?.id, paired.device.id);
  assert.equal(devices.pair(code, { name: 'iPad', via: 'wifi' }, 3000), 'invalid', 'used up');

  const late = devices.createCode(0);
  assert.equal(devices.pair(late.code, { name: 'x', via: 'wifi' }, 11 * 60_000), 'invalid', 'expired');
});

test('devices and their tokens survive a restart; only hashes are stored', () => {
  const dir = tmp();
  const devices = new Devices(dir);
  const paired = devices.pair(devices.createCode().code, { name: 'Android phone', via: 'tailscale' });
  assert.ok(typeof paired === 'object');
  const stored = fs.readFileSync(path.join(dir, 'devices.json'), 'utf8');
  assert.ok(!stored.includes(paired.cookie.split('.')[1]!), 'no raw token on disk');
  const again = new Devices(dir);
  assert.equal(again.verify(paired.cookie)?.name, 'Android phone');
  assert.deepEqual(again.list().map((d) => [d.name, d.via]), [['Android phone', 'tailscale']]);
});

test('guessing codes is cut off after 30 misses', () => {
  const devices = new Devices(tmp());
  for (let i = 0; i < 30; i++) assert.equal(devices.pair('AAAAAAAA', { name: 'x', via: 'wifi' }, 1000), 'invalid');
  const { code } = devices.createCode(1000);
  assert.equal(devices.pair(code, { name: 'x', via: 'wifi' }, 1000), 'limited');
  assert.ok(typeof devices.pair(code, { name: 'x', via: 'wifi' }, 11 * 60_000 + 1000) === 'string', 'limit lifts');
});

test("a Home Screen app signs itself in with its browser's handoff code", () => {
  const devices = new Devices(tmp());
  const safari = devices.pair(devices.createCode().code, { name: 'iPhone', via: 'wifi' });
  assert.ok(typeof safari === 'object');
  const code = devices.handoffCode(safari.device.id);
  assert.equal(devices.handoffCode(safari.device.id), code, 'reused until redeemed');
  const app = devices.redeemHandoff(code);
  assert.equal(app?.device.id, safari.device.id, 'the same device, with its own token');
  assert.ok(devices.verify(app!.cookie) && devices.verify(safari.cookie), 'both tokens work');
  assert.equal(devices.redeemHandoff(code), null, 'single use');
  assert.equal(devices.list().length, 1);
});

test('names and codes', () => {
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone');
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari'), 'Android phone');
  assert.equal(normalizeCode(' abcd-efgh '), 'ABCDEFGH');
});
