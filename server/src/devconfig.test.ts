import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadProjectConfig, parseProjectConfig, portVar, setupRequest } from './devconfig.js';

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

test('without a config file, the repo is guessed at', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-cfg-'));
  assert.equal(loadProjectConfig(dir, dir).source, 'none');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  assert.deepEqual(loadProjectConfig(dir, dir), {
    source: 'detected',
    detected: 'Vite with npm',
    setup: ['npm ci'],
    servers: [{ name: 'dev', command: 'npm run dev -- --port $PORT --strictPort', cwd: '' }],
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

test('the request to the agent explains the format and includes the guess', () => {
  const guessed = setupRequest(
    { source: 'detected', detected: 'Vite with pnpm', setup: ['pnpm install'], servers: [{ name: 'dev', command: 'pnpm run dev', cwd: '' }] },
    'win32',
  );
  assert.match(guessed, /^Set up this repository for remote-ai: write \.remote-ai\.json/);
  assert.match(guessed, /\$PORT_<NAME>/);
  assert.match(guessed, /on Windows; \$PORT and \$PORT_<NAME> work on every OS/);
  assert.match(guessed, /\(Vite with pnpm\):\n\{\n {2}"setup": \[\n {4}"pnpm install"/);
  assert.match(setupRequest({ source: 'none', setup: [], servers: [] }, 'linux'), /found nothing it recognizes/);
  assert.match(setupRequest({ source: 'file', error: 'bad JSON', setup: [], servers: [] }, 'darwin'), /with a problem: bad JSON/);
});
