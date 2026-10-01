import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { portVar, type ProjectConfig } from './devconfig.js';
import { HttpError } from './errors.js';
import { shellQuote } from './exec.js';
import type { HostClient } from './hostclient.js';
import type { TermInfo } from './host/protocol.js';
import { beginLog, logDir, logFile } from './logs.js';
import type { StateStore } from './state.js';
import type { DevInfo, SetupState } from '../../shared/types.js';

export const SETUP_TERMINAL = 'setup';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function devTerminal(server: string): string {
  return `dev-${server}`;
}

/** The part of a session the dev manager needs. */
export interface DevTarget {
  id: string;
  path: string;
}

/** Run setup commands one after another, each from the worktree root whatever the previous one cd'd into. */
export function setupCommand(commands: string[], root: string, platform = process.platform): string {
  const cd = platform === 'win32' ? `cd /d "${root}"` : `cd ${shellQuote(root)}`;
  return commands.join(` && ${cd} && `);
}

/**
 * Dev servers and setup for one worktree, each in its own terminal in the session host. A server
 * is running while its process is; its output goes to a log file the Logs panel streams.
 */
export class DevManager {
  constructor(
    private readonly cfg: Config,
    private readonly host: HostClient,
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

  /**
   * Setup's result outlives its terminal (the host forgets terminals when it restarts), so a
   * finished setup is recorded in a marker file.
   */
  private setupState(target: DevTarget, term: TermInfo | undefined): SetupState {
    const done = this.marker(target.path, 'done');
    const failed = this.marker(target.path, 'failed');
    if (term?.alive) return 'running';
    if (term && !fs.existsSync(term.exitCode === 0 ? done : failed)) {
      fs.mkdirSync(path.dirname(done), { recursive: true });
      fs.rmSync(term.exitCode === 0 ? failed : done, { force: true });
      fs.writeFileSync(term.exitCode === 0 ? done : failed, '');
    }
    if (fs.existsSync(failed)) return 'failed';
    if (fs.existsSync(done)) return 'done';
    return 'pending';
  }

  /** `terms` are this session's terminals in the host. */
  info(target: DevTarget, config: ProjectConfig, terms: TermInfo[]): DevInfo {
    const byName = new Map(terms.map((t) => [t.name, t]));
    const ports = this.ports(target.path, config, false);
    return {
      source: config.source,
      detected: config.detected,
      error: config.error,
      setup: config.setup.length > 0 ? this.setupState(target, byName.get(SETUP_TERMINAL)) : 'none',
      servers: config.servers.map((s) => ({
        name: s.name,
        port: ports.get(s.name) ?? null,
        state: byName.get(devTerminal(s.name))?.alive ? 'running' : 'stopped',
        command: s.command,
        cwd: s.cwd,
      })),
    };
  }

  private async terms(target: DevTarget): Promise<TermInfo[]> {
    return (await this.host.list()).filter((t) => t.session === target.id);
  }

  private checkLimits(config: ProjectConfig): void {
    if (config.error) throw new HttpError(400, config.error);
    if (config.servers.length > this.cfg.portStep) {
      throw new HttpError(400, `At most ${this.cfg.portStep} servers fit in a session's port block`);
    }
  }

  /** Run the setup commands in a "setup" terminal; its exit code says whether setup worked. */
  async runSetup(target: DevTarget, config: ProjectConfig): Promise<void> {
    this.checkLimits(config);
    if (config.setup.length === 0) throw new HttpError(400, 'This project has no setup commands');
    if ((await this.terms(target)).some((t) => t.name === SETUP_TERMINAL && t.alive)) {
      throw new HttpError(409, 'Setup is already running');
    }
    fs.rmSync(this.marker(target.path, 'done'), { force: true });
    fs.rmSync(this.marker(target.path, 'failed'), { force: true });

    const file = logFile(this.cfg.dataDir, target.id, SETUP_TERMINAL);
    beginLog(file, `setup: ${config.setup.join(' && ')}`);
    await this.host.spawn({
      session: target.id,
      name: SETUP_TERMINAL,
      cwd: target.path,
      command: setupCommand(config.setup, target.path),
      env: this.env(target, config),
      logFile: file,
    });
  }

  async start(target: DevTarget, config: ProjectConfig, only?: string): Promise<void> {
    this.checkLimits(config);
    const servers = config.servers.filter((s) => !only || s.name === only);
    if (servers.length === 0) throw new HttpError(only ? 404 : 400, only ? `No server named ${only}` : 'No dev servers are configured');
    const terms = await this.terms(target);
    if (terms.some((t) => t.name === SETUP_TERMINAL && t.alive)) throw new HttpError(409, 'Setup is still running');

    const env = this.env(target, config);
    const ports = this.ports(target.path, config, true);
    for (const [i, server] of servers.entries()) {
      const name = devTerminal(server.name);
      if (terms.some((t) => t.name === name && t.alive)) continue;
      const file = logFile(this.cfg.dataDir, target.id, server.name);
      beginLog(file, `${server.name}: ${server.command}`);
      await this.host.spawn({
        session: target.id,
        name,
        cwd: path.join(target.path, server.cwd),
        command: server.command,
        env: { ...env, PORT: String(ports.get(server.name)) },
        logFile: file,
      });
      // Later servers may read files an earlier one writes as it starts (e.g. a port in .env).
      if (i < servers.length - 1) await sleep(500);
    }
  }

  /** Ctrl-C each running server, and end any that are still running ~5 s later. */
  async stop(target: DevTarget, config: ProjectConfig, only?: string): Promise<void> {
    const servers = config.servers.filter((s) => !only || s.name === only);
    if (only && servers.length === 0) throw new HttpError(404, `No server named ${only}`);
    const names = new Set(servers.map((s) => devTerminal(s.name)));
    const running = async () => (await this.terms(target)).filter((t) => t.alive && names.has(t.name));
    for (let attempt = 0; attempt < 10; attempt++) {
      const left = await running();
      if (left.length === 0) return;
      if (attempt % 4 === 0) {
        for (const t of left) await this.host.keys({ session: target.id, name: t.name }, ['C-c']);
      }
      await sleep(500);
    }
    for (const t of await running()) await this.host.kill({ session: target.id, name: t.name });
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

  /** Appended to the agent's instructions so it uses these servers and logs instead of starting its own. */
  describeForAgent(target: DevTarget, config: ProjectConfig): string | undefined {
    if (config.servers.length === 0 || config.error) return undefined;
    const ports = this.ports(target.path, config, true);
    const api = `http://127.0.0.1:${this.cfg.port}/api/sessions/${target.id}/dev`;
    const lines = config.servers.map(
      (s) =>
        `- ${s.name}: \`${s.command}\`${s.cwd ? ` in ${s.cwd}/` : ''}, port ${ports.get(s.name)}, ` +
        `output in ${logFile(this.cfg.dataDir, target.id, s.name)}`,
    );
    return [
      'This worktree is managed by the remote-ai dashboard, which runs its dev servers itself.',
      'Do not start these servers yourself; read their log files to see their output and errors.',
      ...lines,
      `Start them: curl -s -X POST '${api}/start'. Restart one after changes it does not pick up by itself: curl -s -X POST '${api}/restart?name=NAME'.`,
    ].join('\n');
  }
}
