import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseEvent, Tailscale, tailnetHostname } from './tailscale.js';

const quiet = { info: () => undefined, warn: () => undefined };

test('device name on the tailnet', () => {
  assert.equal(tailnetHostname('Nathans-MacBook-Pro.local'), 'remote-ai-nathans-macbook-pro');
  assert.equal(tailnetHostname('DESKTOP_42'), 'remote-ai-desktop-42');
  assert.equal(tailnetHostname('***'), 'remote-ai-computer');
});

test('sidecar events', () => {
  assert.deepEqual(parseEvent('{"state":"needs-login","loginUrl":"https://login.tailscale.com/a/x"}'), {
    state: 'needs-login',
    loginUrl: 'https://login.tailscale.com/a/x',
    url: undefined,
    login: undefined,
    https: undefined,
    message: undefined,
  });
  assert.equal(parseEvent('{"state":"dancing"}'), null);
  assert.equal(parseEvent('2026/10/01 log line'), null);
});

// A stand-in for remote-ai-tailscale: signed in already, signs out on request, stops when stdin closes.
const FAKE = `#!/usr/bin/env node
const say = (e) => console.log(JSON.stringify(e));
say({ state: 'starting' });
say({ state: 'running', url: 'https://remote-ai-x.tail1.ts.net', login: 'me@example.com', https: true, secret: process.env.REMOTE_AI_PROXY_SECRET });
process.stdin.on('data', (d) => String(d).includes('logout') && say({ state: 'needs-login', loginUrl: 'https://login.tailscale.com/a/x' }));
process.stdin.on('end', () => process.exit(0));
`;

test('runs the sidecar and follows its state', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-ts-'));
  const binary = path.join(dir, 'fake-tailscale');
  fs.writeFileSync(binary, FAKE, { mode: 0o755 });
  const ts = new Tailscale({ binary, dataDir: dir, target: 'http://127.0.0.1:1', secret: 's3cret', log: quiet });
  const until = async (state: string) => {
    for (let i = 0; i < 100 && ts.info().state !== state; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(ts.info().state, state);
  };

  assert.equal(ts.owner(), null);
  ts.start();
  await until('running');
  assert.equal(ts.info().url, 'https://remote-ai-x.tail1.ts.net');
  assert.equal(ts.owner(), 'me@example.com', 'their own devices are trusted');

  ts.logout();
  await until('needs-login');
  assert.equal(ts.owner(), null, 'signed out: nobody is trusted by login');

  ts.stop();
  await until('off');
});
