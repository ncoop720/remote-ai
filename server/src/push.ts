import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webpush, { type PushSubscription } from 'web-push';
import { HttpError } from './errors.js';
import { summarizeToolInput } from './transcript.js';
import type { SessionStatus } from '../../shared/types.js';

export interface Notice {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other on the device. */
  tag: string;
  url: string;
}

export interface SessionLabel {
  id: string;
  project: string;
  branch: string;
}

function oneLine(text: string | undefined, max = 180): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** What to tell your phone about a status change, if anything: Claude needs you, or finished a turn. */
export function noticeFor(label: SessionLabel, prev: SessionStatus, next: SessionStatus): Notice | null {
  const where = `${label.project} / ${label.branch}`;
  const url = `/#/s/${encodeURIComponent(label.id)}`;
  if (next.state === 'needs_input' && prev.state !== 'needs_input') {
    const tool = next.tool ? `${next.tool.name}: ${summarizeToolInput(next.tool.name, next.tool.input)}` : '';
    return { title: `${where} needs you`, body: oneLine(tool || next.message || 'Claude is waiting for your answer'), tag: label.id, url };
  }
  if (next.state === 'idle' && prev.state === 'working') {
    return { title: `${where} finished`, body: oneLine(next.lastMessage) || 'Claude finished its turn', tag: label.id, url };
  }
  return null;
}

interface StoredSubscription {
  subscription: PushSubscription;
  userAgent?: string;
  createdAt: string;
}

function isSubscription(v: unknown): v is PushSubscription {
  const s = v as PushSubscription | undefined;
  return Boolean(
    s &&
      typeof s.endpoint === 'string' &&
      /^https:\/\//.test(s.endpoint) &&
      typeof s.keys?.p256dh === 'string' &&
      typeof s.keys?.auth === 'string',
  );
}

export type Sender = (
  subscription: PushSubscription,
  payload: string,
  options: { TTL: number; urgency: 'high'; topic: string; timeout: number },
) => Promise<unknown>;

/**
 * Web Push with our own VAPID keys (no third-party account). Payloads are encrypted for the
 * browser, so the push relays (Google, Apple, Mozilla) only carry ciphertext.
 */
export class PushService {
  private readonly subsFile: string;
  private readonly publicKey: string;
  private subs: StoredSubscription[];

  constructor(
    dataDir: string,
    subject: string,
    private readonly sender: Sender = (sub, payload, options) => webpush.sendNotification(sub, payload, options),
  ) {
    const keysFile = path.join(dataDir, 'vapid.json');
    let keys: { publicKey: string; privateKey: string };
    if (fs.existsSync(keysFile)) {
      keys = JSON.parse(fs.readFileSync(keysFile, 'utf8')) as typeof keys;
    } else {
      keys = webpush.generateVAPIDKeys();
      fs.writeFileSync(keysFile, JSON.stringify(keys), { mode: 0o600 });
    }
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
    this.subsFile = path.join(dataDir, 'push-subscriptions.json');
    this.subs = fs.existsSync(this.subsFile)
      ? (JSON.parse(fs.readFileSync(this.subsFile, 'utf8')) as StoredSubscription[])
      : [];
  }

  private save(): void {
    const tmp = `${this.subsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.subs, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.subsFile);
  }

  info(): { publicKey: string; subscriptions: number } {
    return { publicKey: this.publicKey, subscriptions: this.subs.length };
  }

  subscribe(subscription: unknown, userAgent?: string): PushSubscription {
    if (!isSubscription(subscription)) throw new HttpError(400, 'Not a push subscription');
    this.subs = this.subs.filter((s) => s.subscription.endpoint !== subscription.endpoint);
    this.subs.push({ subscription, userAgent, createdAt: new Date().toISOString() });
    this.save();
    return subscription;
  }

  unsubscribe(endpoint: string): void {
    this.subs = this.subs.filter((s) => s.subscription.endpoint !== endpoint);
    this.save();
  }

  /** Send to every device (or one). Devices whose subscription has expired are forgotten. */
  async send(notice: Notice, only?: PushSubscription): Promise<{ sent: number; failed: number }> {
    // A topic lets the push relay replace an undelivered notice for the same session.
    const topic = crypto.createHash('sha256').update(notice.tag).digest('base64url').slice(0, 32);
    const targets = only ? [only] : this.subs.map((s) => s.subscription);
    let sent = 0;
    let failed = 0;
    const gone: string[] = [];
    await Promise.all(
      targets.map(async (sub) => {
        try {
          await this.sender(sub, JSON.stringify(notice), { TTL: 3600, urgency: 'high', topic, timeout: 10_000 });
          sent++;
        } catch (err) {
          failed++;
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) gone.push(sub.endpoint);
        }
      }),
    );
    if (gone.length > 0) {
      this.subs = this.subs.filter((s) => !gone.includes(s.subscription.endpoint));
      this.save();
    }
    return { sent, failed };
  }
}
