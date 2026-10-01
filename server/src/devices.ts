import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '../../shared/types.js';

export const DEVICE_COOKIE = 'ra_device';
/** Browsers cap cookies at 400 days; the cookie is renewed as the device keeps using it. */
export const DEVICE_MAX_AGE_S = 400 * 24 * 3600;
const CODE_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 24 * 3600_000;
/** No 0/O or 1/I, so a code read off the screen can't be mistyped. 8 characters is 40 bits. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
/** Wrong codes allowed in any 10 minutes, from everyone together. */
const MAX_FAILURES = 30;

interface Device extends DeviceInfo {
  /** A device can hold more than one token: a browser and its Home Screen app, for one. */
  tokenHashes: string[];
}

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

function randomCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Codes are shown as ABCD-EFGH; accept them typed any which way. */
export function normalizeCode(input: unknown): string {
  return typeof input === 'string' ? input.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A short name for a device from its browser's user agent. */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Browser';
}

export interface Paired {
  device: DeviceInfo;
  /** The cookie value to set: `<device id>.<secret>`. */
  cookie: string;
}

/**
 * Phones and other browsers paired with this computer. Pairing takes a one-time code the computer
 * shows (as a QR code, or typed); the device then keeps a token in a cookie. Only token hashes are
 * stored, in devices.json.
 */
export class Devices {
  private readonly file: string;
  private devices: Device[];
  private readonly codes = new Map<string, number>();
  private readonly handoffs = new Map<string, { deviceId: string; expiresAt: number }>();
  private failures: number[] = [];

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'devices.json');
    try {
      this.devices = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Device[];
    } catch {
      this.devices = [];
    }
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
  }

  list(): DeviceInfo[] {
    return this.devices.map(({ tokenHashes: _, ...info }) => info);
  }

  /** A new single-use code, valid for 10 minutes. */
  createCode(now = Date.now()): { code: string; expiresAt: number } {
    for (const [code, expires] of this.codes) if (expires < now) this.codes.delete(code);
    const code = randomCode();
    const expiresAt = now + CODE_TTL_MS;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  private issue(device: Device): string {
    const secret = crypto.randomBytes(32).toString('base64url');
    device.tokenHashes = [...device.tokenHashes.slice(-4), hashToken(secret)];
    return `${device.id}.${secret}`;
  }

  /** Pair a new device with a code. */
  pair(input: unknown, info: { name: string; via: DeviceInfo['via'] }, now = Date.now()): Paired | 'invalid' | 'limited' {
    this.failures = this.failures.filter((t) => t > now - 10 * 60_000);
    if (this.failures.length >= MAX_FAILURES) return 'limited';
    const code = normalizeCode(input);
    const expires = this.codes.get(code);
    if (expires === undefined || expires < now) {
      this.failures.push(now);
      return 'invalid';
    }
    this.codes.delete(code);
    const device: Device = {
      id: crypto.randomBytes(9).toString('base64url'),
      name: info.name,
      via: info.via,
      createdAt: now,
      lastSeenAt: now,
      tokenHashes: [],
    };
    const cookie = this.issue(device);
    this.devices.push(device);
    this.save();
    const { tokenHashes: _, ...public_ } = device;
    return { device: public_, cookie };
  }

  /** The device a cookie belongs to, or null. Marks it as seen. */
  verify(cookie: string | undefined, now = Date.now()): DeviceInfo | null {
    if (!cookie) return null;
    const dot = cookie.indexOf('.');
    const device = this.devices.find((d) => d.id === cookie.slice(0, dot));
    if (!device || dot < 1) return null;
    const hash = Buffer.from(hashToken(cookie.slice(dot + 1)), 'hex');
    const ok = device.tokenHashes.some((h) => {
      const stored = Buffer.from(h, 'hex');
      return stored.length === hash.length && crypto.timingSafeEqual(stored, hash);
    });
    if (!ok) return null;
    if (now - device.lastSeenAt > 60_000) {
      device.lastSeenAt = now;
      this.save();
    }
    const { tokenHashes: _, ...info } = device;
    return info;
  }

  remove(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    for (const [code, h] of this.handoffs) if (h.deviceId === id) this.handoffs.delete(code);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }

  /**
   * A code that lets this device's Home Screen app sign itself in. iOS keeps an installed web
   * app's cookies apart from Safari's, so the app would otherwise start unpaired; the code goes in
   * the web app manifest's start_url. One per device, reused until it is redeemed or expires.
   */
  handoffCode(deviceId: string, now = Date.now()): string {
    for (const [code, h] of this.handoffs) {
      if (h.expiresAt < now) this.handoffs.delete(code);
      else if (h.deviceId === deviceId) return code;
    }
    const code = crypto.randomBytes(16).toString('base64url');
    this.handoffs.set(code, { deviceId, expiresAt: now + HANDOFF_TTL_MS });
    return code;
  }

  redeemHandoff(code: unknown, now = Date.now()): Paired | null {
    if (typeof code !== 'string') return null;
    const h = this.handoffs.get(code);
    if (!h || h.expiresAt < now) return null;
    this.handoffs.delete(code);
    const device = this.devices.find((d) => d.id === h.deviceId);
    if (!device) return null;
    const cookie = this.issue(device);
    device.lastSeenAt = now;
    this.save();
    const { tokenHashes: _, ...info } = device;
    return { device: info, cookie };
  }
}
