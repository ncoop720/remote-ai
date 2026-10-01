import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Config } from './config.js';
import { DevManager, setupCommand } from './dev.js';
import { parseProjectConfig } from './devconfig.js';
import { StateStore } from './state.js';
import type { HostClient } from './hostclient.js';
import type { TermInfo } from './host/protocol.js';

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-dev-'));
  const cfg = { dataDir, port: 8787, portStep: 10 } as Config;
  const state = new StateStore(dataDir, 3100, 10);
  const dev = new DevManager(cfg, {} as HostClient, state);
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

const term = (name: string, alive: boolean, exitCode: number | null = null): TermInfo => ({
  session: 'game__feat', name, pid: 1, alive, exitCode, startedAt: 0, lastOutputAt: 0, bells: 0,
});

test('info reports running servers and setup state from terminals and markers', () => {
  const { dev, config, target, dataDir } = setup();
  let info = dev.info(target, config, [term('agent', true)]);
  assert.equal(info.setup, 'pending');
  assert.deepEqual(info.servers.map((s) => [s.name, s.state, s.port]), [['server', 'stopped', null], ['client', 'stopped', null]]);

  dev.ports(target.path, config, true);
  info = dev.info(target, config, [term('agent', true), term('setup', true), term('dev-server', true), term('dev-client', false, 1)]);
  assert.equal(info.setup, 'running');
  assert.deepEqual(info.servers.map((s) => [s.name, s.state, s.port]), [['server', 'running', 3100], ['client', 'stopped', 3101]]);

  // A finished setup is remembered after its terminal is gone (the host restarted).
  assert.equal(dev.info(target, config, [term('setup', false, 1)]).setup, 'failed');
  assert.equal(dev.info(target, config, []).setup, 'failed');
  assert.equal(dev.info(target, config, [term('setup', false, 0)]).setup, 'done');
  assert.equal(dev.info(target, config, []).setup, 'done');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('setup commands each start from the worktree root', () => {
  assert.equal(setupCommand(['npm ci', 'npm run build'], '/w/my app', 'linux'), "npm ci && cd '/w/my app' && npm run build");
  assert.equal(setupCommand(['npm ci', 'npm run build'], 'C:\\w\\app', 'win32'), 'npm ci && cd /d "C:\\w\\app" && npm run build');
});

test('the agent is told the servers, ports, log files and how to restart', () => {
  const { dev, config, target, dataDir } = setup();
  const text = dev.describeForAgent(target, config) ?? '';
  assert.match(text, /Do not start these servers yourself/);
  assert.match(text, /- server: `npm start` in server\/, port 3100, output in .*game__feat.server\.log/);
  assert.match(text, /- client: `npm run dev -- --port \$PORT`, port 3101/);
  assert.match(text, /curl -s -X POST 'http:\/\/127\.0\.0\.1:8787\/api\/sessions\/game__feat\/dev\/restart\?name=NAME'/);
  assert.equal(dev.describeForAgent(target, parseProjectConfig('{}')), undefined);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
