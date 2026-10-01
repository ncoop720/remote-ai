import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { formatCode } from './devices.js';
import { WIFI_PREVIEW_OFFSET, type PreviewProxy } from './preview.js';
import type { Tailscale } from './tailscale.js';
import type { PairingCode, RemoteInfo } from '../../shared/types.js';

interface Settings {
  wifi: boolean;
  tailscale: boolean;
}

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];
// Virtual adapters (containers, VMs, VPNs) aren't where a phone on the Wi-Fi can reach.
const VIRTUAL = /^(docker|br-|veth|virbr|vEthernet|vmnet|vboxnet|bridge1\d\d|utun|tailscale|tun|tap|zt|wg)/i;
const PREFERRED = /^(en|eth|wl|wlan|wi-?fi|ethernet)/i;

/** This computer's addresses on the local network, the likeliest first. */
export function lanAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const found: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && PRIVATE_V4.some((r) => r.test(a.address))) found.push({ name, address: a.address });
    }
  }
  return found
    .sort((a, b) => Number(PREFERRED.test(b.name)) - Number(PREFERRED.test(a.name)))
    .map((f) => f.address);
}

/** A server whose connections, WebSockets included, can all be ended when it stops. */
function closable(server: http.Server): { server: http.Server; close(): Promise<void> } {
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    server,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function listen(server: http.Server, port: number, host: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => resolve(err));
    server.listen(port, host, () => resolve(null));
  });
}

/**
 * How devices reach this computer, beyond localhost: a listener on the local network (off until
 * turned on, since it's plain http), and built-in Tailscale. Both are switched from the Connect a
 * phone page and stay as they were across restarts (remote.json).
 */
export class RemoteAccess extends EventEmitter {
  private readonly file: string;
  private settings: Settings;
  private wifiServer: http.Server | null = null;
  private wifiError: string | undefined;
  private readonly sockets = new Set<net.Socket>();
  private previewPorts: number[] = [];
  /** Wi-Fi preview listeners, by the dev-server port each serves. */
  private readonly wifiPreviews = new Map<number, { server: http.Server; close(): Promise<void> }>();
  private tailscalePreviews: { server: http.Server; close(): Promise<void> } | null = null;
  private syncing = Promise.resolve();

  constructor(
    private readonly opts: {
      dataDir: string;
      /** Port of the Wi-Fi listener; the main server stays on localhost. */
      wifiPort: number;
      app: FastifyInstance;
      tailscale: Tailscale;
      preview: PreviewProxy;
      /** Where the Tailscale sidecar sends preview requests, on localhost. */
      previewPort: number;
      log: { info(msg: string): void; warn(obj: object, msg: string): void };
    },
  ) {
    super();
    this.file = path.join(opts.dataDir, 'remote.json');
    try {
      this.settings = { wifi: false, tailscale: false, ...(JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Settings>) };
    } catch {
      this.settings = { wifi: false, tailscale: false };
    }
    opts.tailscale.on('change', () => this.emit('change'));
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2));
  }

  /** Start whatever was on last time. */
  async restore(): Promise<void> {
    const previews = closable(this.opts.preview.tailscaleServer());
    const err = await listen(previews.server, this.opts.previewPort, '127.0.0.1');
    if (err) this.opts.log.warn({ err }, `previews over Tailscale are off: port ${this.opts.previewPort} is taken`);
    else this.tailscalePreviews = previews;
    if (this.settings.wifi) await this.startWifi();
    if (this.settings.tailscale) this.opts.tailscale.start();
  }

  /** The dev-server ports sessions use now: serve those (and only those) for previews. */
  setPreviewPorts(ports: number[]): void {
    const next = [...new Set(ports)].sort((a, b) => a - b);
    if (next.join() === this.previewPorts.join()) return;
    this.previewPorts = next;
    this.opts.tailscale.setPreviewPorts(next);
    this.syncWifiPreviews();
  }

  /** Over Wi-Fi, each dev-server port P is served on P + 10000, while Wi-Fi is on. */
  private syncWifiPreviews(): void {
    this.syncing = this.syncing.then(async () => {
      const wanted = new Set(this.wifiServer ? this.previewPorts.filter((p) => p + WIFI_PREVIEW_OFFSET <= 65535) : []);
      for (const [port, listener] of this.wifiPreviews) {
        if (wanted.has(port)) continue;
        this.wifiPreviews.delete(port);
        await listener.close();
      }
      for (const port of wanted) {
        if (this.wifiPreviews.has(port)) continue;
        const listener = closable(this.opts.preview.wifiServer(port));
        const err = await listen(listener.server, port + WIFI_PREVIEW_OFFSET, '0.0.0.0');
        if (err) this.opts.log.warn({ err }, `no Wi-Fi preview for port ${port}`);
        else this.wifiPreviews.set(port, listener);
      }
    });
  }

  info(): RemoteInfo {
    const ts = this.opts.tailscale;
    return {
      wifi: {
        enabled: this.wifiServer !== null,
        port: this.opts.wifiPort,
        urls: this.wifiServer ? lanAddresses().map((a) => `http://${a}:${this.opts.wifiPort}`) : [],
        error: this.wifiError,
      },
      tailscale: { available: ts.available, enabled: this.settings.tailscale, ...ts.info() },
    };
  }

  async setWifi(on: boolean): Promise<void> {
    this.settings.wifi = on;
    this.save();
    if (on) await this.startWifi();
    else await this.stopWifi();
    this.emit('change');
  }

  setTailscale(on: boolean): void {
    this.settings.tailscale = on;
    this.save();
    if (on) this.opts.tailscale.start();
    else this.opts.tailscale.stop();
    this.emit('change');
  }

  /** The same app, on every interface. Requests from there are remote, so they need pairing. */
  private startWifi(): Promise<void> {
    if (this.wifiServer) return Promise.resolve();
    const { app } = this.opts;
    const server = http.createServer((req, res) => app.routing(req, res));
    server.on('upgrade', (req, socket, head) => app.server.emit('upgrade', req, socket, head));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    return new Promise((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.wifiError =
          err.code === 'EADDRINUSE' ? `Port ${this.opts.wifiPort} is in use by another program` : err.message;
        this.opts.log.warn({ err }, 'wifi listener failed');
        resolve();
      });
      server.listen(this.opts.wifiPort, '0.0.0.0', () => {
        this.wifiServer = server;
        this.wifiError = undefined;
        this.opts.log.info(`listening on the local network, port ${this.opts.wifiPort}`);
        this.syncWifiPreviews();
        resolve();
      });
    });
  }

  private stopWifi(): Promise<void> {
    const server = this.wifiServer;
    this.wifiServer = null;
    this.wifiError = undefined;
    this.syncWifiPreviews();
    if (!server) return Promise.resolve();
    // Open terminals and event streams would keep it alive; end them.
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  /** Links that carry a pairing code, the one that works from anywhere first, each with its QR code. */
  async pairingLinks(code: string, expiresAt: number): Promise<PairingCode> {
    const info = this.info();
    const urls: { via: 'tailscale' | 'wifi'; url: string }[] = [];
    if (info.tailscale.state === 'running' && info.tailscale.url) urls.push({ via: 'tailscale', url: info.tailscale.url });
    if (info.wifi.urls[0]) urls.push({ via: 'wifi', url: info.wifi.urls[0] });
    const links = await Promise.all(
      urls.map(async ({ via, url }) => {
        const full = `${url}/#/pair/${code}`;
        const qrSvg = await QRCode.toString(full, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return { via, url: full, qrSvg };
      }),
    );
    return { code: formatCode(code), expiresAt, links };
  }

  async close(): Promise<void> {
    this.opts.tailscale.stop();
    await this.stopWifi();
    await this.syncing;
    await this.tailscalePreviews?.close();
  }
}
