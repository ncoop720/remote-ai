import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultConfig, loadProjectConfig, parseProjectConfig, portVar } from './devconfig.js';

test('parses servers with default cwd', () => {
  const c = parseProjectConfig(
    JSON.stringify({
      setup: ['npm ci --prefix server'],
      servers: [
        { name: 'server', cwd: 'server', command: 'npm start' },
        { name: 'client', command: 'npm run dev -- --port $PORT' },
      ],
    }),
  );
  assert.equal(c.error, undefined);
  assert.deepEqual(c.setup, ['npm ci --prefix server']);
  assert.deepEqual(c.servers, [
    { name: 'server', cwd: 'server', command: 'npm start' },
    { name: 'client', cwd: '', command: 'npm run dev -- --port $PORT' },
  ]);
});

test('reports mistakes instead of throwing', () => {
  const error = (value: unknown) => parseProjectConfig(typeof value === 'string' ? value : JSON.stringify(value)).error ?? '';
  assert.match(error('{nope'), /not valid JSON/);
  assert.match(error({ servers: [{ name: 'claude', command: 'x' }] }), /not "claude"/);
  assert.match(error({ servers: [{ name: 'Web App', command: 'x' }] }), /lowercase/);
  assert.match(error({ servers: [{ name: 'web' }] }), /needs a command/);
  assert.match(error({ servers: [{ name: 'web', command: 'x', cwd: '../elsewhere' }] }), /inside the repo/);
  assert.match(error({ servers: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] }), /Two servers/);
  assert.match(error({ setup: 'npm ci' }), /list of commands/);
});

test('guesses from package.json when there is no config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-cfg-'));
  assert.equal(defaultConfig(dir).source, 'none');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  assert.deepEqual(defaultConfig(dir), {
    source: 'default',
    setup: ['npm ci'],
    servers: [{ name: 'dev', command: 'npm run dev', cwd: '' }],
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a worktree's own config wins over the main checkout's", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-cfg-'));
  const main = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(main);
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(main, '.remote-ai.json'), JSON.stringify({ servers: [{ name: 'main', command: 'x' }] }));
  assert.equal(loadProjectConfig(wt, main).servers[0]?.name, 'main');
  fs.writeFileSync(path.join(wt, '.remote-ai.json'), JSON.stringify({ servers: [{ name: 'own', command: 'y' }] }));
  assert.equal(loadProjectConfig(wt, main).servers[0]?.name, 'own');
  fs.rmSync(root, { recursive: true, force: true });
});

test('portVar makes an environment variable name', () => {
  assert.equal(portVar('api-v2'), 'PORT_API_V2');
});
