// Draws the app icons into web/public and desktop/ (run once: node scripts/make-icons.mjs). No dependencies:
// shapes are rasterised with 4x4 supersampling and written with a minimal PNG encoder.
import fs from 'node:fs';
import zlib from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Shapes in unit coordinates, drawn back to front: a terminal prompt ">_" and a status dot.
const INK = hex('#EDEAE4');
const AMBER = hex('#F2A541');
const STROKE = 0.075;
const shapes = [
  { color: INK, hit: (x, y) => segmentDistance(x, y, [0.3, 0.36], [0.46, 0.5]) < STROKE / 2 || segmentDistance(x, y, [0.46, 0.5], [0.3, 0.64]) < STROKE / 2 },
  { color: INK, hit: (x, y) => segmentDistance(x, y, [0.54, 0.64], [0.7, 0.64]) < STROKE / 2 },
  { color: AMBER, dot: true, hit: (x, y) => Math.hypot(x - 0.7, y - 0.34) < 0.07 },
];

function render(size, { background, monochrome, ink = [255, 255, 255] }) {
  const out = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = background ? [...hex(background), 255] : [0, 0, 0, 0];
      for (const shape of shapes) {
        if (monochrome && shape.dot) continue;
        let cover = 0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) if (shape.hit((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size)) cover++;
        }
        const k = cover / (S * S);
        if (k === 0) continue;
        const [cr, cg, cb] = monochrome ? ink : shape.color;
        r = r * (1 - k) + cr * k;
        g = g * (1 - k) + cg * k;
        b = b * (1 - k) + cb * k;
        a = a * (1 - k) + 255 * k;
      }
      out.set([r, g, b, a].map(Math.round), (y * size + x) * 4);
    }
  }
  return png(size, out);
}

const BLACK = [0, 0, 0];
for (const [name, size, opts] of [
  ['web/public/icon-192.png', 192, { background: '#121110' }],
  ['web/public/icon-512.png', 512, { background: '#121110' }],
  ['web/public/apple-touch-icon.png', 180, { background: '#121110' }],
  ['web/public/badge-96.png', 96, { monochrome: true }],
  // electron-builder makes the .icns and .ico from this.
  ['desktop/build/icon.png', 1024, { background: '#121110' }],
  // Windows and Linux trays; macOS menu-bar icons are black "template" images the system tints.
  ['desktop/assets/tray.png', 16, { background: '#121110' }],
  ['desktop/assets/tray@2x.png', 32, { background: '#121110' }],
  ['desktop/assets/trayTemplate.png', 16, { monochrome: true, ink: BLACK }],
  ['desktop/assets/trayTemplate@2x.png', 32, { monochrome: true, ink: BLACK }],
]) {
  const file = new URL(`../${name}`, import.meta.url);
  fs.mkdirSync(new URL('.', file), { recursive: true });
  fs.writeFileSync(file, render(size, opts));
  console.log('wrote', name);
}
