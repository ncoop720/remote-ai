import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

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
 * can make them can already use tmux and git directly. `tailscale serve` and other proxies
 * connect from loopback too, but mark the request with forwarding headers.
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

/** Optional password for remote access, with login sessions that survive restarts. */
export class Auth {
  private readonly file: string;
  private sessions: Record<string, number>;
  private readonly failures = new Map<string, number[]>();

  constructor(
    dataDir: string,
    private readonly password: string | undefined,
  ) {
    this.file = path.join(dataDir, 'auth-sessions.json');
    this.sessions = fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, number>) : {};
  }

  get enabled(): boolean {
    return Boolean(this.password);
  }

  private save(): void {
    const now = Date.now();
    for (const [k, expires] of Object.entries(this.sessions)) if (expires < now) delete this.sessions[k];
    fs.writeFileSync(this.file, JSON.stringify(this.sessions), { mode: 0o600 });
  }

  private tokenKey(token: string): string {
    return hash(token).toString('hex');
  }

  loggedIn(req: FastifyRequest): boolean {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return false;
    const expires = this.sessions[this.tokenKey(token)];
    return expires !== undefined && expires > Date.now();
  }

  allowed(req: FastifyRequest): boolean {
    return !this.enabled || isLocalRequest(req.socket.remoteAddress, req.headers) || this.loggedIn(req);
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
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https';
    reply.header(
      'Set-Cookie',
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`,
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
