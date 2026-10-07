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
import { mentions, SessionManager, sessionPorts } from './sessions.js';
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

test('ports go to the worktree their process runs in, or else the session whose terminal started it', () => {
  const proc = (port: number, cwd: string | null, ancestors: number[] = []) => ({ port, pid: port, command: 'node', commandLine: 'node', cwd, ancestors });
  const ports = [
    proc(3100, '/w/app/feat'),
    proc(3101, '/w/app/feat/packages/web'), // deeper inside the same worktree
    proc(3110, '/w/app/feat/nested'), // a worktree nested inside another
    proc(3120, null, [900, 500, 1]), // Windows: no cwd, but started under the session's terminal (pid 500)
    proc(3130, '/tmp', [500]), // runs elsewhere, still started by the session
    proc(5432, '/var/lib/postgres', [1]), // unrelated
  ];
  const all = ['/w/app/feat', '/w/app/feat/nested', '/w/app/main'];
  assert.deepEqual(
    sessionPorts(ports, { path: '/w/app/feat', terminalPids: [500] }, all).map((p) => p.port),
    [3100, 3101, 3120, 3130],
  );
  assert.deepEqual(sessionPorts(ports, { path: '/w/app/feat/nested', terminalPids: [] }, all).map((p) => p.port), [3110]);
  assert.deepEqual(sessionPorts(ports, { path: '/w/app/main', terminalPids: [] }, all), []);
});

test("a port names the dev server whose terminal runs it, so stopping it stops that server", () => {
  const proc = (port: number, ancestors: number[]) => ({ port, pid: port, command: 'node', commandLine: 'node', cwd: '/w/app', ancestors });
  const ports = [proc(3100, [700, 600, 1]), proc(3101, [800, 1]), proc(5173, [900, 500, 1])];
  const servers = new Map([[600, 'api'], [800, 'web']]); // dev-server terminals; 500 is the agent's
  assert.deepEqual(
    sessionPorts(ports, { path: '/w/app', terminalPids: [500, 600, 800], servers }, ['/w/app']).map((p) => [p.port, p.server]),
    [[3100, 'api'], [3101, 'web'], [5173, null]],
  );
});

test('without a working directory, a port goes to the worktree its command line runs from', () => {
  const proc = (port: number, commandLine: string, ancestors: number[] = []) => ({ port, pid: port, command: 'node.exe', commandLine, cwd: null, ancestors });
  // git lists worktrees with forward slashes; Windows command lines use backslashes and any case
  const all = ['/code/game', '/code/game-2', '/code/game/nested'];
  const ports = [
    proc(5173, '"node" "/code/game/client/node_modules/.bin/../vite/bin/vite.js"', [9999]), // its shell has exited
    proc(3110, 'node --import file:///code/game/server/node_modules/tsx/dist/loader.mjs src/index.ts', [500]),
    proc(3120, 'node /code/game-2/server.js'),
    proc(3130, 'node /code/game/nested/x.js', [500]), // a nested worktree's, though the session started it
    proc(3140, 'node server.js', [500]), // nothing to go by but the terminal
  ];
  assert.deepEqual(sessionPorts(ports, { path: '/code/game', terminalPids: [500] }, all).map((p) => p.port), [5173, 3110, 3140]);
  assert.deepEqual(sessionPorts(ports, { path: '/code/game-2', terminalPids: [] }, all).map((p) => p.port), [3120]);

  assert.ok(mentions('"node" C:\\Users\\Me\\Code\\Game\\client\\node_modules\\vite\\bin\\vite.js', 'C:/Users/me/code/game', 'win32'));
  assert.ok(mentions('node --import file:///C:/Users/me/code/game/x.mjs', 'C:/Users/me/code/game', 'win32'));
  assert.ok(mentions('serve "C:\\Users\\me\\code\\game"', 'C:/Users/me/code/game', 'win32'));
  assert.ok(!mentions('node C:\\Users\\me\\code\\game-2\\x.js', 'C:/Users/me/code/game', 'win32'));
  assert.ok(!mentions('node /srv/code/game/x.js', '/code/game', 'linux'));
});
