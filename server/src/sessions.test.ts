import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AgentRegistry } from './agents/index.js';
import { claudeAdapter } from './agents/claude/index.js';
import type { Config } from './config.js';
import { DevManager } from './dev.js';
import type { HostClient } from './hostclient.js';
import type { TermInfo } from './host/protocol.js';
import { SessionManager } from './sessions.js';
import { StateStore } from './state.js';
import { StatusStore } from './status.js';

function repo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

function setup(projectsDir: string | null, terms: TermInfo[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-sessions-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const cfg = { dataDir, projectsDir, worktreesDir: path.join(root, 'worktrees'), port: 8787, portBase: 3100, portStep: 10 } as Config;
  const host = { list: async () => terms } as unknown as HostClient;
  const state = new StateStore(dataDir, 3100, 10);
  const agents = new AgentRegistry([claudeAdapter({ command: 'claude', settingsPath: '/s.json' })]);
  const sessions = new SessionManager(cfg, host, state, new StatusStore(), agents, new DevManager(cfg, host, state));
  return { root, sessions };
}

test('projects are the folders added plus the main checkouts in the projects folder', async () => {
  const { root, sessions } = setup(null);
  const scanned = path.join(root, 'projects');
  repo(path.join(scanned, 'api'));
  fs.mkdirSync(path.join(scanned, 'notes'));
  const { sessions: withFolder } = setup(scanned);
  assert.deepEqual((await withFolder.listProjects()).map((p) => [p.name, p.source]), [['api', 'folder']]);

  const game = repo(path.join(root, 'code', 'game'));
  assert.equal(await sessions.addProject(game), 'game');
  assert.equal(await sessions.addProject(`${game}/`), 'game', 'adding again is a no-op');
  sessions.invalidate();
  const [project] = await sessions.listProjects();
  assert.equal(project?.path, game);
  assert.equal(project?.source, 'added');
  assert.deepEqual(project?.sessions.map((s) => [s.id, s.isMain, s.running]), [['game__main', true, false]]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('only main checkouts with unique names can be added', async () => {
  const { root, sessions } = setup(null);
  const game = repo(path.join(root, 'a', 'game'));
  await sessions.addProject(game);

  await assert.rejects(sessions.addProject(path.join(root, 'nope')), /existing folder/);
  fs.mkdirSync(path.join(root, 'plain'));
  await assert.rejects(sessions.addProject(path.join(root, 'plain')), /not a git repository/);
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat', path.join(root, 'wt')], { cwd: game });
  await assert.rejects(sessions.addProject(path.join(root, 'wt')), /worktree/);
  await assert.rejects(sessions.addProject(repo(path.join(root, 'b', 'game'))), /already a project named game/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('removing a project needs its sessions stopped, and leaves folder projects alone', async () => {
  const running: TermInfo = { session: 'game__main', name: 'agent', pid: 1, alive: true, exitCode: null, startedAt: 0, lastOutputAt: 0, bells: 0 };
  const { root, sessions } = setup(null, [running]);
  const game = repo(path.join(root, 'game'));
  await sessions.addProject(game);
  await assert.rejects(sessions.removeProject('game'), /Stop game's sessions first/);
  running.alive = false;
  await sessions.removeProject('game');
  sessions.invalidate();
  assert.deepEqual(await sessions.listProjects(), []);
  assert.ok(fs.existsSync(game), 'nothing on disk is touched');

  const scanned = path.join(root, 'projects');
  repo(path.join(scanned, 'api'));
  const { sessions: withFolder } = setup(scanned);
  await assert.rejects(withFolder.removeProject('api'), /can't be removed here/);
  fs.rmSync(root, { recursive: true, force: true });
});
