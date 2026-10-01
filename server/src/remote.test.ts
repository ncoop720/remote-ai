import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { lanAddresses, RemoteAccess } from './remote.js';
import { Tailscale } from './tailscale.js';

const iface = (address: string, internal = false) =>
  ({ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo;
const quiet = { info: () => undefined, warn: () => undefined };

test('LAN addresses: private IPv4 on real adapters, Wi-Fi and Ethernet first', () => {
  assert.deepEqual(
    lanAddresses({
      lo: [iface('127.0.0.1', true)],
      docker0: [iface('172.17.0.1')],
      'vEthernet (WSL)': [iface('172.29.80.1')],
      tailscale0: [iface('100.101.1.2')],
      utun3: [iface('10.8.0.2')],
      bridge100: [iface('192.168.64.1')], // macOS VMs and Internet Sharing
      en0: [iface('192.168.1.73'), { ...iface('fe80::1'), family: 'IPv6' }],
      eth1: [iface('10.0.0.5')], // equally likely adapters keep the system's order
      ppp0: [iface('8.8.4.4')],
    }),
    ['192.168.1.73', '10.0.0.5'],
  );
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

test('the Wi-Fi listener serves the same app, and turns off', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-remote-'));
  const app = Fastify();
  app.get('/api/who', async (req) => ({ remote: req.socket.remoteAddress, port: req.socket.localPort }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const wifiPort = await freePort();
  const tailscale = new Tailscale({ binary: null, dataDir, target: 'http://127.0.0.1:1', secret: 'x', log: quiet });
  const remote = new RemoteAccess({ dataDir, wifiPort, app, tailscale, log: quiet });

  assert.equal(remote.info().wifi.enabled, false);
  await remote.setWifi(true);
  assert.equal(remote.info().wifi.enabled, true);
  const res = (await (await fetch(`http://127.0.0.1:${wifiPort}/api/who`)).json()) as { port: number };
  assert.equal(res.port, wifiPort, 'routed into the app, which can tell it came in over Wi-Fi');
  assert.equal(remote.info().tailscale.available, false);

  await remote.setWifi(false);
  await assert.rejects(fetch(`http://127.0.0.1:${wifiPort}/api/who`));
  // Remembered for next time.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'remote.json'), 'utf8')), { wifi: false, tailscale: false });
  await app.close();
});
