import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Config } from './config.js';
import { DevManager } from './dev.js';
import { parseProjectConfig } from './devconfig.js';
import { StateStore } from './state.js';
import type { Tmux } from './tmux.js';

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-dev-'));
  const cfg = { dataDir, port: 8787, portStep: 10 } as Config;
  const state = new StateStore(dataDir, 3100, 10);
  const dev = new DevManager(cfg, {} as Tmux, state);
  const config = parseProjectConfig(
    JSON.stringify({
      setup: ['npm ci'],
      servers: [
        { name: 'server', cwd: 'server', command: 'npm start' },
        { name: 'client', command: 'npm run dev -- --port $PORT' },
      ],
    }),
  );
  return { dataDir, dev, config, target: { id: 'game__feat', path: '/w/game/feat' } };
}

test('servers get consecutive ports from the worktree block', () => {
  const { dev, config, target, dataDir } = setup();
  assert.deepEqual([...dev.ports(target.path, config, true)], [['server', 3100], ['client', 3101]]);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('info reports running servers and setup state from windows and markers', () => {
  const { dev, config, target, dataDir } = setup();
  let info = dev.info(target, config, [{ index: 0, name: 'claude', command: 'claude' }]);
  assert.equal(info.setup, 'pending');
  assert.deepEqual(info.servers.map((s) => [s.name, s.state, s.port]), [['server', 'stopped', null], ['client', 'stopped', null]]);

  dev.ports(target.path, config, true);
  info = dev.info(target, config, [
    { index: 0, name: 'claude', command: 'claude' },
    { index: 1, name: 'setup', command: 'npm' },
    { index: 2, name: 'dev-server', command: 'npm' },
    { index: 3, name: 'dev-client', command: 'bash' },
  ]);
  assert.equal(info.setup, 'running');
  assert.deepEqual(info.servers.map((s) => [s.name, s.state, s.port]), [['server', 'running', 3100], ['client', 'stopped', 3101]]);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Claude is told the servers, ports, log files and how to restart', () => {
  const { dev, config, target, dataDir } = setup();
  const text = dev.describeForClaude(target, config) ?? '';
  assert.match(text, /Do not start these servers yourself/);
  assert.match(text, /- server: `npm start` in server\/, port 3100, output in .*game__feat.server\.log/);
  assert.match(text, /- client: `npm run dev -- --port \$PORT`, port 3101/);
  assert.match(text, /curl -s -X POST 'http:\/\/127\.0\.0\.1:8787\/api\/sessions\/game__feat\/dev\/restart\?name=NAME'/);
  assert.equal(dev.describeForClaude(target, parseProjectConfig('{}')), undefined);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
