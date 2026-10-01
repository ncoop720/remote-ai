import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Auth } from './auth.js';
import { DEVICE_COOKIE } from './devices.js';
import { COOKIE as SESSION_COOKIE } from './auth.js';

/** Set by the Tailscale sidecar: which dev-server port the phone asked for. */
export const PREVIEW_PORT_HEADER = 'x-remote-ai-preview-port';
/** Over Wi-Fi, dev-server port P is served on P + 10000 (P itself is taken by the dev server). */
// Dev servers are reached at localhost, which may be IPv4 or IPv6 (Vite on recent Node listens on
// ::1); Node tries both since v20.
export const WIFI_PREVIEW_OFFSET = 10000;

const OWN_COOKIES = new Set([DEVICE_COOKIE, SESSION_COOKIE]);

function page(status: number, title: string, text: string): { status: number; body: string } {
  return {
    status,
    body:
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="font:15px system-ui,sans-serif;background:#121110;color:#edeae4;display:grid;place-items:center;min-height:90vh;margin:0;padding:24px;text-align:center">` +
      `<div><h1 style="font-size:18px">${title}</h1><p style="color:#a8a29a;max-width:420px">${text}</p></div>`,
  };
}

/** remote-ai's own cookies and headers stay out of the dev server's sight. */
export function withoutOwnCookies(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  const kept = cookie
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !OWN_COOKIES.has(c.slice(0, c.indexOf('=')).trim()));
  return kept.length ? kept.join('; ') : undefined;
}

/**
 * The request as the dev server should see it: from its own machine. Dev servers guard against
 * other hosts (Vite's allowedHosts, Next's allowedDevOrigins), and the device has already been
 * checked here, so Host and Origin say localhost.
 */
export function upstreamHeaders(headers: http.IncomingHttpHeaders, port: number, clientIp: string | undefined): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || k.startsWith('x-remote-ai-') || k.startsWith('x-forwarded-') || k === 'forwarded') continue;
    out[k] = v;
  }
  out.host = `localhost:${port}`;
  if (headers.origin) out.origin = `http://localhost:${port}`;
  const cookie = withoutOwnCookies(headers.cookie);
  if (cookie) out.cookie = cookie;
  else delete out.cookie;
  if (clientIp) out['x-forwarded-for'] = clientIp;
  return out;
}

/** Redirects to the dev server's own address point back to where the phone reached it; its cookies can't replace ours. */
export function downstreamHeaders(headers: http.IncomingHttpHeaders, port: number, publicOrigin: string): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  const location = headers.location;
  if (location) {
    out.location = location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|$)`), publicOrigin);
  }
  const cookies = headers['set-cookie'];
  if (cookies) {
    const kept = cookies.filter((c) => !OWN_COOKIES.has(c.slice(0, c.indexOf('=')).trim()));
    if (kept.length) out['set-cookie'] = kept;
    else delete out['set-cookie'];
  }
  return out;
}

export interface PreviewTarget {
  port: number;
  /** Where the browser reached it, e.g. https://remote-ai-pc.tail1234.ts.net:3100. */
  publicOrigin: string;
}

/**
 * Dev-server pages for other devices. Each dev server keeps its own origin (its own port), so its
 * absolute paths and hot reload work. The device must be paired, as for the dashboard, and only
 * ports that belong to a session are served.
 */
export class PreviewProxy {
  constructor(
    private readonly auth: Auth,
    /** Ports that belong to a session right now. */
    private readonly isSessionPort: (port: number) => boolean,
  ) {}

  /** Whether to serve the request, or the page saying why not. */
  private refuse(req: http.IncomingMessage, port: number): { status: number; body: string } | null {
    if (!this.auth.allowed(req)) {
      return page(401, 'This device isn’t connected', 'Open remote-ai on this device and pair it with your computer first.');
    }
    if (!this.isSessionPort(port)) {
      return page(404, `Nothing on port ${port}`, `None of your sessions has a server listening on port ${port} right now.`);
    }
    return null;
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse, target: PreviewTarget): void {
    const refusal = this.refuse(req, target.port);
    if (refusal) {
      res.writeHead(refusal.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(refusal.body);
      return;
    }
    const upstream = http.request(
      {
        host: 'localhost',
        port: target.port,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req.headers, target.port, req.socket.remoteAddress),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, downstreamHeaders(up.headers, target.port, target.publicOrigin));
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      const p = page(502, `Port ${target.port} isn’t answering`, 'The dev server stopped, or is still starting. Try again in a moment.');
      if (!res.headersSent) res.writeHead(p.status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(p.body);
    });
    req.pipe(upstream);
  }

  /** WebSockets (hot reload, mostly) pass straight through once the device is checked. */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, target: PreviewTarget): void {
    socket.on('error', () => socket.destroy());
    const refusal = this.refuse(req, target.port);
    if (refusal) {
      socket.end(`HTTP/1.1 ${refusal.status} ${http.STATUS_CODES[refusal.status]}\r\nConnection: close\r\n\r\n`);
      return;
    }
    const conn = net.connect({ host: 'localhost', port: target.port }, () => {
      const headers = upstreamHeaders(req.headers, target.port, req.socket.remoteAddress);
      const lines = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${String(v)}`]));
      conn.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) conn.write(head);
      socket.pipe(conn).pipe(socket);
    });
    conn.on('error', () => socket.destroy());
    socket.on('close', () => conn.destroy());
  }

  /** An HTTP server for one Wi-Fi preview port, serving dev-server port `port`. */
  wifiServer(port: number): http.Server {
    const target = (req: http.IncomingMessage): PreviewTarget => ({ port, publicOrigin: `http://${req.headers.host}` });
    const server = http.createServer((req, res) => this.handle(req, res, target(req)));
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, target(req)));
    return server;
  }

  /**
   * The server the Tailscale sidecar forwards preview requests to, on localhost. It only takes
   * requests carrying the proxy's secret, which say which port the phone asked for.
   */
  tailscaleServer(): http.Server {
    const target = (req: http.IncomingMessage): PreviewTarget | null => {
      const port = Number(req.headers[PREVIEW_PORT_HEADER]);
      if (!this.auth.viaTailscale(req) || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
      const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      return { port, publicOrigin: `${proto}://${String(req.headers['x-forwarded-host'] ?? `localhost:${port}`)}` };
    };
    const server = http.createServer((req, res) => {
      const t = target(req);
      if (!t) res.writeHead(403).end();
      else this.handle(req, res, t);
    });
    server.on('upgrade', (req, socket, head) => {
      const t = target(req);
      if (!t) socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      else this.upgrade(req, socket, head, t);
    });
    return server;
  }
}
