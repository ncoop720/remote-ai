import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { imageExtension, Uploads } from './uploads.js';

test('images are known by their first bytes, whatever they are called', () => {
  const bytes = (s: string) => Buffer.from(s, 'latin1');
  assert.equal(imageExtension(bytes('\x89PNG\r\n\x1a\n rest')), 'png');
  assert.equal(imageExtension(bytes('\xff\xd8\xff\xe0 rest')), 'jpg');
  assert.equal(imageExtension(bytes('GIF89a rest')), 'gif');
  assert.equal(imageExtension(bytes('RIFF\x00\x00\x00\x00WEBPVP8 ')), 'webp');
  assert.equal(imageExtension(bytes('\x00\x00\x00\x18ftypheic')), null, 'HEIC is turned into JPEG before it is sent');
  assert.equal(imageExtension(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(imageExtension(Buffer.alloc(0)), null);
});

test('saved images are kept a week', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-uploads-'));
  const uploads = new Uploads(dataDir);
  const png = Buffer.from('\x89PNG\r\n\x1a\n....', 'latin1');
  const old = uploads.saveImage(png);
  assert.match(path.basename(old), /^\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
  assert.deepEqual(fs.readFileSync(old), png);
  assert.ok(uploads.has(old));
  assert.ok(!uploads.has(path.join(dataDir, 'state.json')), 'only images saved here');

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
  const fresh = uploads.saveImage(png);
  assert.ok(!fs.existsSync(old));
  assert.ok(uploads.has(fresh));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
