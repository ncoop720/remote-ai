import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectDevConfig, parseProcfile, serverName } from './detect.js';

/** A throwaway repo with these files (objects become JSON). */
function repo(files: Record<string, string | object>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-detect-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const summary = (files: Record<string, string | object>) => {
  const c = detectDevConfig(repo(files));
  return c && { detected: c.detected, setup: c.setup, servers: c.servers.map((s) => `${s.name}${s.cwd ? ` (${s.cwd})` : ''}: ${s.command}`) };
};

test('a Node app, with its package manager and the flags its dev server needs for $PORT', () => {
  assert.deepEqual(summary({ 'package.json': { scripts: { dev: 'vite', build: 'vite build' } }, 'pnpm-lock.yaml': '' }), {
    detected: 'Vite with pnpm',
    setup: ['pnpm install --frozen-lockfile'],
    servers: ['dev: pnpm run dev --port $PORT --strictPort'],
  });
  assert.deepEqual(summary({ 'package.json': { scripts: { dev: 'next dev' }, dependencies: { next: '15' } }, 'package-lock.json': '{}' }), {
    detected: 'Next.js with npm',
    setup: ['npm ci'],
    servers: ['dev: npm run dev'], // Next reads $PORT itself
  });
  assert.deepEqual(summary({ 'package.json': { scripts: { start: 'ng serve' } }, 'yarn.lock': '' })?.servers, [
    'dev: yarn run start --port $PORT',
  ]);
  assert.equal(summary({ 'package.json': { scripts: { test: 'vitest' } } }), null, 'no dev script');
  assert.deepEqual(summary({ 'package.json': { scripts: { dev: 'tsx watch src/index.ts' } } })?.setup, ['npm install'], 'no lockfile');
});

test('apps in their own folders: one server each, backends first, each installing its own', () => {
  assert.deepEqual(
    summary({
      'client/package.json': { scripts: { dev: 'vite' } },
      'client/package-lock.json': '{}',
      'server/package.json': { scripts: { dev: 'nodemon index.js' } },
      'server/package-lock.json': '{}',
      'README.md': '# app',
    }),
    {
      detected: '2 Node and Vite apps with npm',
      // From inside each folder: run from the root, npm's INIT_CWD is the root and Prisma's install looks there.
      setup: ['cd server && npm ci', 'cd client && npm ci'],
      servers: ['server (server): npm run dev', 'client (client): npm run dev -- --port $PORT --strictPort'],
    },
  );
  assert.deepEqual(
    summary({
      'api/package.json': { scripts: { dev: 'tsx watch src/index.ts' } },
      'api/yarn.lock': '',
      'web/package.json': { scripts: { dev: 'vite' } },
    })?.setup,
    ['cd api && yarn install --frozen-lockfile', 'cd web && npm install'],
  );
});

test('app folders with longer names, still backends first', () => {
  assert.deepEqual(
    summary({
      'client-threejs/package.json': { scripts: { dev: 'vite' } },
      'game-server/package.json': { scripts: { start: 'tsx watch src/index.ts' } },
      'shared/types.ts': '',
      'node_modules/x/package.json': { scripts: { dev: 'x' } },
    })?.servers,
    ['game-server (game-server): npm run start', 'client-threejs (client-threejs): npm run dev -- --port $PORT --strictPort'],
  );
});

test('a workspace monorepo installs once at the root', () => {
  const c = summary({
    'package.json': { workspaces: ['apps/*'] },
    'pnpm-workspace.yaml': 'packages: [apps/*]',
    'pnpm-lock.yaml': '',
    'apps/web/package.json': { scripts: { dev: 'next dev' } },
    'apps/api/package.json': { scripts: { dev: 'tsx watch src/main.ts' } },
  });
  assert.deepEqual(c?.setup, ['pnpm install --frozen-lockfile']);
  assert.deepEqual(c?.servers, ['api (apps/api): pnpm run dev', 'web (apps/web): pnpm run dev']);
});

test('Python: Django, FastAPI and Flask, through the project tool that locks them', () => {
  assert.deepEqual(summary({ 'manage.py': '', 'uv.lock': '', 'pyproject.toml': '[project]\ndependencies = ["django"]' }), {
    detected: 'Django with uv',
    setup: ['uv sync'],
    servers: ['web: uv run python manage.py runserver $PORT'],
  });
  assert.deepEqual(
    summary({ 'app/main.py': 'from fastapi import FastAPI\napi = FastAPI()\n', 'poetry.lock': '', 'pyproject.toml': 'fastapi = "^0.115"' })?.servers,
    ['web: poetry run uvicorn app.main:api --reload --port $PORT'],
  );
  assert.deepEqual(summary({ 'app.py': 'from flask import Flask', 'requirements.txt': 'Flask==3.1' }), {
    detected: 'Flask with pip',
    setup: [],
    servers: ['web: flask run --debug --port $PORT'],
  });
});

test('Rails keeps its asset watchers but serves on $PORT', () => {
  assert.deepEqual(
    summary({
      'Gemfile': "gem 'rails', '~> 8.0'",
      'bin/rails': '',
      'Procfile.dev': 'web: bin/rails server -p 3000\ncss: bin/rails tailwindcss:watch\n',
    }),
    { detected: 'Rails', setup: ['bundle install'], servers: ['web: bin/rails server -p $PORT', 'css: bin/rails tailwindcss:watch'] },
  );
});

test('a Procfile.dev says what to run; Go, Rust and Compose as last resorts', () => {
  assert.deepEqual(
    summary({ 'Procfile.dev': 'api: go run ./cmd/api\nweb: npm run dev\n', 'package.json': { scripts: { dev: 'vite' } } })?.servers,
    ['api: go run ./cmd/api', 'web: npm run dev'],
  );
  assert.deepEqual(summary({ 'go.mod': 'module x', 'main.go': 'package main\n' })?.servers, ['app: go run .']);
  assert.deepEqual(summary({ 'Cargo.toml': '', 'src/main.rs': '' })?.servers, ['app: cargo run']);
  assert.deepEqual(summary({ 'compose.yaml': 'services: {}' })?.servers, ['compose: docker compose up']);
  assert.equal(summary({ 'README.md': 'hi' }), null);
});

test('names and Procfile lines', () => {
  assert.equal(serverName('Web_App'), 'web-app');
  assert.equal(serverName('setup'), 'app');
  assert.deepEqual(parseProcfile('# comment\nweb: rails s\n\nworker:  sidekiq  \n'), [
    { name: 'web', command: 'rails s' },
    { name: 'worker', command: 'sidekiq' },
  ]);
});
