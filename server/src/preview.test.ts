import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { Auth } from './auth.js';
import { DEVICE_COOKIE, Devices } from './devices.js';
import { downstreamHeaders, PREVIEW_PORT_HEADER, PreviewProxy, upstreamHeaders, withoutOwnCookies } from './preview.js';

test('requests reach the dev server as if local, without our cookies', () => {
  const h = upstreamHeaders(
    {
      host: 'remote-ai-pc.tail1.ts.net:3100',
      origin: 'https://remote-ai-pc.tail1.ts.net:3100',
      cookie: `theme=dark; ${DEVICE_COOKIE}=abc.def; ra_session=xyz`,
      'x-remote-ai-proxy': 'secret',
      'x-forwarded-host': 'remote-ai-pc.tail1.ts.net:3100',
      accept: 'text/html',
    },
    3100,
    '100.64.0.7',
  );
  assert.deepEqual(h, {
    host: 'localhost:3100',
    origin: 'http://localhost:3100',
    cookie: 'theme=dark',
    accept: 'text/html',
    'x-forwarded-for': '100.64.0.7',
  });
  assert.equal(withoutOwnCookies(`${DEVICE_COOKIE}=a`), undefined);
});

test("redirects come back to the phone's address; the dev server can't set our cookies", () => {
  const h = downstreamHeaders(
    { location: 'http://localhost:3100/login?next=/', 'set-cookie': ['sid=1; Path=/', `${DEVICE_COOKIE}=evil; Path=/`] },
    3100,
    'https://remote-ai-pc.tail1.ts.net:3100',
  );
  assert.equal(h.location, 'https://remote-ai-pc.tail1.ts.net:3100/login?next=/');
  assert.deepEqual(h['set-cookie'], ['sid=1; Path=/']);
  assert.equal(downstreamHeaders({ location: 'http://localhost:31000/x' }, 3100, 'http://a').location, 'http://localhost:31000/x');
});

// A dev server: echoes what it was sent, redirects /old, sets a cookie, and echoes WebSocket messages.
let dev: http.Server;
let devPort: number;
let wifi: http.Server;
let wifiPort: number;
let tailnet: http.Server;
let tailnetPort: number;
let cookie: string;

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));

before(async () => {
  dev = http.createServer((req, res) => {
    if (req.url === '/old') return void res.writeHead(302, { location: `http://localhost:${devPort}/new` }).end();
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=1; Path=/' });
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie ?? null }));
  });
  const wss = new WebSocketServer({ server: dev });
  wss.on('connection', (ws, req) => ws.on('message', (m) => ws.send(`${req.headers.host} ${String(m)}`)));
  devPort = await listen(dev);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-preview-'));
  const devices = new Devices(dir);
  const auth = new Auth(dir, devices, { requirePairing: true, proxySecret: 's3cret', tailnetOwner: () => 'me@example.com' });
  const paired = devices.pair(devices.createCode().code, { name: 'iPhone', via: 'wifi' });
  assert.ok(typeof paired === 'object');
  cookie = `${DEVICE_COOKIE}=${paired.cookie}`;
  const proxy = new PreviewProxy(auth, (port) => port === devPort);
  wifi = proxy.wifiServer(devPort);
  wifiPort = await listen(wifi);
  tailnet = proxy.tailscaleServer();
  tailnetPort = await listen(tailnet);
});

after(() => {
  for (const s of [dev, wifi, tailnet]) {
    s.closeAllConnections();
    s.close();
  }
});

// Requests from 127.0.0.1 count as this computer's own unless forwarded; a phone's come forwarded.
const asPhone = { 'x-forwarded-for': '192.168.1.20' };

test('over Wi-Fi: paired devices get the dev server, others a page saying why', async () => {
  const base = `http://127.0.0.1:${wifiPort}`;
  const refused = await fetch(`${base}/`, { headers: asPhone });
  assert.equal(refused.status, 401);
  assert.match(await refused.text(), /isn’t connected/);

  const res = await fetch(`${base}/page?q=1`, { headers: { ...asPhone, cookie: `${cookie}; theme=dark`, origin: base } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: '/page?q=1', host: `localhost:${devPort}`, origin: `http://localhost:${devPort}`, cookie: 'theme=dark' });
  assert.equal(res.headers.get('set-cookie'), 'sid=1; Path=/');

  const moved = await fetch(`${base}/old`, { headers: { ...asPhone, cookie }, redirect: 'manual' });
  assert.equal(moved.headers.get('location'), `${base}/new`);
});

test('over Wi-Fi: hot-reload WebSockets pass through for paired devices only', async () => {
  const url = `ws://127.0.0.1:${wifiPort}/hmr`;
  const echoed = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { ...asPhone, cookie } });
    ws.on('open', () => ws.send('hello'));
    ws.on('message', (m) => {
      resolve(String(m));
      ws.close();
    });
    ws.on('error', reject);
  });
  assert.equal(echoed, `localhost:${devPort} hello`);

  const status = await new Promise<number>((resolve) => {
    const ws = new WebSocket(url, { headers: asPhone });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(-1));
  });
  assert.equal(status, 401);
});

test('through Tailscale: only the sidecar (with its secret) gets in, for session ports', async () => {
  const base = `http://127.0.0.1:${tailnetPort}`;
  const sidecar = (port: number, login?: string) => ({
    'x-forwarded-for': '100.64.0.7',
    'x-forwarded-host': `remote-ai-pc.tail1.ts.net:${port}`,
    'x-forwarded-proto': 'https',
    'x-remote-ai-proxy': 's3cret',
    [PREVIEW_PORT_HEADER]: String(port),
    ...(login ? { 'x-remote-ai-tailscale-login': login } : {}),
  });
  assert.equal((await fetch(`${base}/`, { headers: { ...sidecar(devPort), 'x-remote-ai-proxy': 'forged' } })).status, 403);
  assert.equal((await fetch(`${base}/`, { headers: sidecar(devPort, 'friend@example.com') })).status, 401, 'not the owner, not paired');
  const own = await fetch(`${base}/x`, { headers: sidecar(devPort, 'me@example.com') });
  assert.equal(own.status, 200, "the owner's own device");
  assert.equal(((await own.json()) as { host: string }).host, `localhost:${devPort}`);
  assert.equal((await fetch(`${base}/`, { headers: sidecar(5432, 'me@example.com') })).status, 404, 'not a session port');

  const moved = await fetch(`${base}/old`, { headers: sidecar(devPort, 'me@example.com'), redirect: 'manual' });
  assert.equal(moved.headers.get('location'), `https://remote-ai-pc.tail1.ts.net:${devPort}/new`);
});
