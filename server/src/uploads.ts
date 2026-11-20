import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.js';

/** How long sent images are kept. The agent reads one as it's pasted, so this is only for later. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** The extension for an image agents can read (PNG, JPEG, GIF, WebP), from its first bytes. */
export function imageExtension(data: Buffer): string | null {
  const ascii = (start: number, end: number) => data.subarray(start, end).toString('latin1');
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Images sent from the dashboard, such as photos from a phone. An agent takes an image by its path
 * pasted into the prompt, as when a file is dropped on its terminal, so each one is saved here first.
 */
export class Uploads {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'uploads');
  }

  /** Save an image and return its path. Images older than a week go as new ones arrive. */
  saveImage(data: Buffer, now = Date.now()): string {
    const ext = imageExtension(data);
    if (!ext) throw new HttpError(415, 'Send a PNG, JPEG, GIF or WebP image');
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune(now);
    const stamp = new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const file = path.join(this.dir, `${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
    fs.writeFileSync(file, data);
    return file;
  }

  /** Whether a path is an image saved here. */
  has(file: string): boolean {
    return path.dirname(file) === this.dir && fs.existsSync(file);
  }

  private prune(now: number): void {
    for (const name of fs.readdirSync(this.dir)) {
      const file = path.join(this.dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > KEEP_MS) fs.rmSync(file);
      } catch {
        // gone already
      }
    }
  }
}
