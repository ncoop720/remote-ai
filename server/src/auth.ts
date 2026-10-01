import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEVICE_COOKIE, DEVICE_MAX_AGE_S, type Devices } from './devices.js';
import type { DeviceInfo } from '../../shared/types.js';

export const COOKIE = 'ra_session';
const MAX_AGE_S = 30 * 24 * 3600;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Requests made on this machine without going through a proxy. They are trusted: anything that
 * can make them can already run programs as you. `tailscale serve`, the built-in Tailscale proxy
 * and other proxies connect from loopback too, but mark the request with forwarding headers.
 */
export function isLocalRequest(remoteAddress: string | undefined, headers: Record<string, unknown>): boolean {
  return (
    LOOPBACK.has(remoteAddress ?? '') &&
    headers['x-forwarded-for'] === undefined &&
    headers['tailscale-user-login'] === undefined &&
    headers['forwarded'] === undefined
  );
}

const hash = (s: string) => crypto.createHash('sha256').update(s).digest();

/** What deciding access needs from a request: a Fastify one, or a plain Node one (previews). */
export interface RequestLike {
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string };
}

export interface AuthOptions {
  password?: string;
  /**
   * Remote requests need a paired device (or the password). Without this and without a password,
   * remote access is open, as in v1, where only a proxy such as `tailscale serve` exposed it.
   */
  requirePairing?: boolean;
  /** The built-in Tailscale proxy marks its requests with this secret, and adds the sender's login. */
  proxySecret?: string;
  /** The Tailscale login this computer is signed in as. That person's own devices are trusted. */
  tailnetOwner?: () => string | null;
}

export function isSecure(req: FastifyRequest): boolean {
  return req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https';
}

/** Who may use the dashboard: this computer, paired devices, a logged-in password, or your own tailnet devices. */
export class Auth {
  private readonly file: string;
  private sessions: Record<string, number>;
  private readonly failures = new Map<string, number[]>();
  private readonly password: string | undefined;

  constructor(
    dataDir: string,
    private readonly devices: Devices,
    private readonly opts: AuthOptions = {},
  ) {
    this.password = opts.password;
    this.file = path.join(dataDir, 'auth-sessions.json');
    this.sessions = fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, number>) : {};
  }

  get enabled(): boolean {
    return Boolean(this.password);
  }

  /** Remote access needs pairing or a password; otherwise it is open (the v1 default). */
  get guarded(): boolean {
    return this.enabled || Boolean(this.opts.requirePairing);
  }

  private save(): void {
    const now = Date.now();
    for (const [k, expires] of Object.entries(this.sessions)) if (expires < now) delete this.sessions[k];
    fs.writeFileSync(this.file, JSON.stringify(this.sessions), { mode: 0o600 });
  }

  private tokenKey(token: string): string {
    return hash(token).toString('hex');
  }

  loggedIn(req: RequestLike): boolean {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return false;
    const expires = this.sessions[this.tokenKey(token)];
    return expires !== undefined && expires > Date.now();
  }

  /** The paired device this request comes from, if any. */
  device(req: RequestLike): DeviceInfo | null {
    return this.devices.verify(parseCookies(req.headers.cookie)[DEVICE_COOKIE]);
  }

  /** The request came through the built-in Tailscale proxy (its secret is on it). */
  viaTailscale(req: RequestLike): boolean {
    const secret = this.opts.proxySecret;
    const given = req.headers['x-remote-ai-proxy'];
    return Boolean(secret) && typeof given === 'string' && given.length === secret!.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret!));
  }

  /** Sent through the built-in Tailscale proxy by a device signed in as the same person as this computer. */
  ownTailnetDevice(req: RequestLike): boolean {
    const owner = this.opts.tailnetOwner?.();
    const login = req.headers['x-remote-ai-tailscale-login'];
    return Boolean(owner) && login === owner && this.viaTailscale(req);
  }

  allowed(req: RequestLike): boolean {
    return (
      isLocalRequest(req.socket.remoteAddress, req.headers) ||
      this.device(req) !== null ||
      this.loggedIn(req) ||
      this.ownTailnetDevice(req) ||
      !this.guarded
    );
  }

  /** Set (or renew) a paired device's cookie. */
  setDeviceCookie(req: FastifyRequest, reply: FastifyReply, value: string): void {
    reply.header(
      'Set-Cookie',
      `${DEVICE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_MAX_AGE_S}${isSecure(req) ? '; Secure' : ''}`,
    );
  }

  /** At most 10 wrong passwords per address per 15 minutes. */
  private limited(ip: string): boolean {
    const recent = (this.failures.get(ip) ?? []).filter((t) => t > Date.now() - 15 * 60_000);
    this.failures.set(ip, recent);
    return recent.length >= 10;
  }

  login(req: FastifyRequest, reply: FastifyReply, password: unknown): 'ok' | 'wrong' | 'limited' {
    const ip = String(req.headers['x-forwarded-for'] ?? req.ip).split(',')[0]!.trim();
    if (this.limited(ip)) return 'limited';
    const ok = typeof password === 'string' && crypto.timingSafeEqual(hash(password), hash(this.password ?? ''));
    if (!ok || !this.enabled) {
      this.failures.get(ip)!.push(Date.now());
      return 'wrong';
    }
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions[this.tokenKey(token)] = Date.now() + MAX_AGE_S * 1000;
    this.save();
    reply.header(
      'Set-Cookie',
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}${isSecure(req) ? '; Secure' : ''}`,
    );
    return 'ok';
  }

  logout(req: FastifyRequest, reply: FastifyReply): void {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      delete this.sessions[this.tokenKey(token)];
      this.save();
    }
    reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }
}
