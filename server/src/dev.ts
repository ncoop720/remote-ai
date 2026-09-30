import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { portVar, type ProjectConfig } from './devconfig.js';
import { HttpError } from './errors.js';
import { shellQuote } from './exec.js';
import { beginLog, logDir, logFile } from './logs.js';
import type { StateStore } from './state.js';
import { SHELLS, type Tmux } from './tmux.js';
import type { DevInfo, SetupState, TmuxWindow } from '../../shared/types.js';

export const SETUP_WINDOW = 'setup';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function devWindow(server: string): string {
  return `dev-${server}`;
}

/** The part of a session the dev manager needs. */
export interface DevTarget {
  id: string;
  path: string;
}

/**
 * Dev servers and setup for one worktree, each in its own tmux window of the session. Commands
 * are typed into an interactive shell (like the claude window) so rc files set up PATH, and a
 * server counts as running while that shell has a foreground program.
 */
export class DevManager {
  constructor(
    private readonly cfg: Config,
    private readonly tmux: Tmux,
    private readonly state: StateStore,
  ) {}

  private marker(worktreePath: string, kind: 'done' | 'failed'): string {
    const key = crypto.createHash('sha1').update(worktreePath).digest('hex').slice(0, 16);
    return path.join(this.cfg.dataDir, 'setup', `${key}.${kind}`);
  }

  /** Ports assigned to each server: consecutive numbers in the worktree's block. */
  ports(worktreePath: string, config: ProjectConfig, allocate: boolean): Map<string, number> {
    const base = allocate ? this.state.allocatePort(worktreePath) : this.state.portFor(worktreePath);
    return new Map(base === null ? [] : config.servers.map((s, i) => [s.name, base + i]));
  }

  /** Every command gets all servers' ports as PORT_<NAME>, so servers can find each other. */
  private env(target: DevTarget, config: ProjectConfig): Record<string, string> {
    const env: Record<string, string> = { REMOTE_AI_SESSION: target.id };
    for (const [name, port] of this.ports(target.path, config, true)) env[portVar(name)] = String(port);
    return env;
  }

  info(target: DevTarget, config: ProjectConfig, windows: TmuxWindow[]): DevInfo {
    const byName = new Map(windows.map((w) => [w.name, w]));
    const busy = (name: string) => {
      const w = byName.get(name);
      return Boolean(w && !SHELLS.has(w.command));
    };
    let setup: SetupState = 'none';
    if (config.setup.length > 0) {
      if (byName.has(SETUP_WINDOW) && !fs.existsSync(this.marker(target.path, 'failed'))) setup = 'running';
      else if (fs.existsSync(this.marker(target.path, 'failed'))) setup = 'failed';
      else if (fs.existsSync(this.marker(target.path, 'done'))) setup = 'done';
      else setup = 'pending';
    }
    const ports = this.ports(target.path, config, false);
    return {
      source: config.source,
      error: config.error,
      setup,
      servers: config.servers.map((s) => ({
        name: s.name,
        port: ports.get(s.name) ?? null,
        state: busy(devWindow(s.name)) ? 'running' : 'stopped',
        command: s.command,
        cwd: s.cwd,
      })),
    };
  }

  private checkLimits(config: ProjectConfig): void {
    if (config.error) throw new HttpError(400, config.error);
    if (config.servers.length > this.cfg.portStep) {
      throw new HttpError(400, `At most ${this.cfg.portStep} servers fit in a session's port block`);
    }
  }

  /** Run the setup commands in a "setup" window. It closes itself on success and stays open on failure. */
  async runSetup(target: DevTarget, config: ProjectConfig, windows: TmuxWindow[]): Promise<void> {
    this.checkLimits(config);
    if (config.setup.length === 0) throw new HttpError(400, 'This project has no setup commands');
    if (this.info(target, config, windows).setup === 'running') throw new HttpError(409, 'Setup is already running');

    const done = this.marker(target.path, 'done');
    const failed = this.marker(target.path, 'failed');
    fs.mkdirSync(path.dirname(done), { recursive: true });
    fs.rmSync(done, { force: true });
    fs.rmSync(failed, { force: true });

    const win = `=${target.id}:${SETUP_WINDOW}`;
    if (windows.some((w) => w.name === SETUP_WINDOW)) await this.tmux.killWindow(win);
    await this.tmux.newWindow(target.id, SETUP_WINDOW, target.path, this.env(target, config));
    const file = logFile(this.cfg.dataDir, target.id, SETUP_WINDOW);
    beginLog(file, `setup: ${config.setup.join(' && ')}`);
    await this.tmux.pipeToFile(win, file);

    // Each command starts from the worktree root, whatever the previous one cd'd into.
    const steps = config.setup.join(` && cd ${shellQuote(target.path)} && `);
    const command = `${steps} && touch ${shellQuote(done)} && exit || touch ${shellQuote(failed)}`;
    await this.tmux.sendText(win, command);
    await this.tmux.sendKeys(win, ['Enter']);
  }

  async start(target: DevTarget, config: ProjectConfig, windows: TmuxWindow[], only?: string): Promise<void> {
    this.checkLimits(config);
    const servers = config.servers.filter((s) => !only || s.name === only);
    if (servers.length === 0) throw new HttpError(only ? 404 : 400, only ? `No server named ${only}` : 'No dev servers are configured');
    if (this.info(target, config, windows).setup === 'running') throw new HttpError(409, 'Setup is still running');

    const env = this.env(target, config);
    const ports = this.ports(target.path, config, true);
    for (const [i, server] of servers.entries()) {
      const name = devWindow(server.name);
      const win = `=${target.id}:${name}`;
      const existing = windows.find((w) => w.name === name);
      if (existing && !SHELLS.has(existing.command)) continue;

      if (!existing) {
        const cwd = path.join(target.path, server.cwd);
        await this.tmux.newWindow(target.id, name, cwd, { ...env, PORT: String(ports.get(server.name)) });
      }
      const file = logFile(this.cfg.dataDir, target.id, server.name);
      beginLog(file, `${server.name}: ${server.command}`);
      await this.tmux.pipeToFile(win, file);
      await this.tmux.sendText(win, server.command);
      await this.tmux.sendKeys(win, ['Enter']);
      // Later servers may read files an earlier one writes as it starts (e.g. a port in .env).
      if (i < servers.length - 1) await sleep(500);
    }
  }

  /** Ctrl-C each running server and wait (up to ~5 s) for it to get back to its shell. */
  async stop(target: DevTarget, config: ProjectConfig, only?: string): Promise<void> {
    const servers = config.servers.filter((s) => !only || s.name === only);
    if (only && servers.length === 0) throw new HttpError(404, `No server named ${only}`);
    const running = async () => {
      const windows = (await this.tmux.listWindows()).get(target.id) ?? [];
      return servers.filter((s) => {
        const w = windows.find((x) => x.name === devWindow(s.name));
        return w && !SHELLS.has(w.command);
      });
    };
    for (let attempt = 0; attempt < 10; attempt++) {
      const left = await running();
      if (left.length === 0) return;
      if (attempt % 4 === 0) {
        for (const s of left) await this.tmux.sendKeys(`=${target.id}:${devWindow(s.name)}`, ['C-c']);
      }
      await sleep(500);
    }
    throw new HttpError(500, 'A server did not stop after Ctrl-C; open its terminal to check');
  }

  logFile(sessionId: string, name: string): string {
    return logFile(this.cfg.dataDir, sessionId, name);
  }

  /** Forget setup markers and logs of a worktree that is being removed. */
  forget(target: DevTarget): void {
    fs.rmSync(this.marker(target.path, 'done'), { force: true });
    fs.rmSync(this.marker(target.path, 'failed'), { force: true });
    fs.rmSync(logDir(this.cfg.dataDir, target.id), { recursive: true, force: true });
  }

  /** Appended to Claude's system prompt so it uses these servers and logs instead of starting its own. */
  describeForClaude(target: DevTarget, config: ProjectConfig): string | undefined {
    if (config.servers.length === 0 || config.error) return undefined;
    const ports = this.ports(target.path, config, true);
    const api = `http://127.0.0.1:${this.cfg.port}/api/sessions/${target.id}/dev`;
    const lines = config.servers.map(
      (s) =>
        `- ${s.name}: \`${s.command}\`${s.cwd ? ` in ${s.cwd}/` : ''}, port ${ports.get(s.name)}, ` +
        `output in ${logFile(this.cfg.dataDir, target.id, s.name)}`,
    );
    return [
      'This worktree is managed by the remote-ai dashboard, which runs its dev servers in separate tmux windows.',
      'Do not start these servers yourself; read their log files to see their output and errors.',
      ...lines,
      `Start them: curl -s -X POST '${api}/start'. Restart one after changes it does not pick up by itself: curl -s -X POST '${api}/restart?name=NAME'.`,
    ].join('\n');
  }
}
