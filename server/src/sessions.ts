import fs from 'node:fs';
import path from 'node:path';
import * as git from './git.js';
import type { Worktree } from './git.js';
import type { AgentAdapter, AgentRegistry } from './agents/index.js';
import type { DevManager } from './dev.js';
import { loadProjectConfig } from './devconfig.js';
import { HttpError } from './errors.js';
import { expandHome, type Config } from './config.js';
import { sessionId, slug } from './ids.js';
import type { HostClient } from './hostclient.js';
import type { TermInfo, TermRef } from './host/protocol.js';
import { listeningPorts, type ListeningProcess } from './ports.js';
import type { SessionLabel } from './push.js';
import type { StateStore } from './state.js';
import type { StatusStore } from './status.js';
import type {
  ChatItem,
  CreateSessionRequest,
  DevAction,
  ListeningPort,
  PermissionMode,
  ProjectInfo,
  ProjectSource,
  SessionInfo,
  StartSessionRequest,
  VisiblePrompt,
} from '../../shared/types.js';

export { HttpError };

interface WorktreeRef {
  id: string;
  project: string;
  projectPath: string;
  worktree: Worktree;
  isMain: boolean;
}

const inside = (dir: string, root: string) => dir === root || dir.startsWith(root + path.sep);

/**
 * The listening ports that belong to a session: those whose process runs inside its worktree (the
 * deepest worktree, when they nest), or else that one of its terminals started, however deep down.
 * Working directories aren't available on Windows, and a server may run outside its worktree.
 */
export function sessionPorts(
  ports: ListeningProcess[],
  session: { path: string; terminalPids: number[] },
  allPaths: string[],
): ListeningPort[] {
  const pids = new Set(session.terminalPids);
  return ports
    .filter((p) => {
      const home = p.cwd === null ? undefined : allPaths.filter((root) => inside(p.cwd!, root)).sort((a, b) => b.length - a.length)[0];
      if (home !== undefined) return home === session.path;
      return pids.has(p.pid) || p.ancestors.some((a) => pids.has(a));
    })
    .map(({ port, pid, command }) => ({ port, pid, command }));
}

/** A main git checkout: worktrees have a `.git` file, not a directory. */
function isMainCheckout(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

/** Keys the mobile key bar may send. */
const ALLOWED_KEYS = new Set(['Escape', 'C-c', 'BTab', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Enter']);
/** The host terminal the session's agent runs in. */
export const AGENT_TERMINAL = 'agent';
const CACHE_MS = 1500;

export class SessionManager {
  private cache: { at: number; projects: ProjectInfo[] } | null = null;
  private index: WorktreeRef[] = [];

  constructor(
    private readonly cfg: Config,
    private readonly host: HostClient,
    private readonly state: StateStore,
    private readonly statuses: StatusStore,
    private readonly agents: AgentRegistry,
    private readonly dev: DevManager,
  ) {}

  invalidate(): void {
    this.cache = null;
  }

  /**
   * Projects are the folders added one by one, then every main checkout in projectsDir. Names must
   * be unique (they start session ids), so a later folder with a name already taken is skipped.
   */
  private discoverProjects(): { name: string; path: string; source: ProjectSource }[] {
    const found: { name: string; path: string; source: ProjectSource }[] = [];
    const add = (p: string, source: ProjectSource) => {
      const name = path.basename(p);
      if (isMainCheckout(p) && !found.some((f) => f.name === name || f.path === p)) found.push({ name, path: p, source });
    };
    for (const p of this.state.projects()) add(p, 'added');
    const dir = this.cfg.projectsDir;
    if (dir && fs.existsSync(dir)) {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith('.')) add(path.join(dir, d.name), 'folder');
      }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Add a main checkout anywhere on this computer as a project. */
  async addProject(input: string): Promise<string> {
    const repo = typeof input === 'string' && input.trim() ? path.resolve(expandHome(input.trim())) : '';
    if (!repo || !fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) throw new HttpError(400, 'Choose an existing folder');
    if (!isMainCheckout(repo)) {
      if (fs.existsSync(path.join(repo, '.git'))) throw new HttpError(400, "That folder is a git worktree; add the repository's main checkout instead");
      throw new HttpError(400, 'That folder is not a git repository. Run git init there first, or pick a repository.');
    }
    const name = path.basename(repo);
    const existing = this.discoverProjects();
    if (existing.some((p) => p.path === repo)) return name;
    if (existing.some((p) => p.name === name)) throw new HttpError(409, `There is already a project named ${name}`);
    this.state.addProject(repo);
    this.invalidate();
    return name;
  }

  /** Stop listing a project that was added by hand. Nothing on disk changes. */
  async removeProject(name: string): Promise<void> {
    const project = this.discoverProjects().find((p) => p.name === name);
    if (!project) throw new HttpError(404, `Unknown project ${name}`);
    if (project.source !== 'added') throw new HttpError(400, `${name} is in the projects folder, so it can't be removed here`);
    const running = (await this.host.list()).some((t) => t.alive && t.session.startsWith(`${slug(name)}__`));
    if (running) throw new HttpError(409, `Stop ${name}'s sessions first`);
    this.state.removeProject(project.path);
    this.invalidate();
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const projects = this.cache && Date.now() - this.cache.at < CACHE_MS ? this.cache.projects : await this.scan();
    // Statuses change between scans (hooks), so always serve the live ones.
    return projects.map((p) => ({
      ...p,
      sessions: p.sessions.map((s) => (s.running ? { ...s, status: this.statuses.get(s.id) } : s)),
    }));
  }

  private async scan(): Promise<ProjectInfo[]> {
    const [projects, terms, ports] = await Promise.all([
      Promise.resolve(this.discoverProjects()),
      this.host.list(),
      listeningPorts(),
    ]);
    const termsBySession = new Map<string, TermInfo[]>();
    for (const t of terms) termsBySession.set(t.session, [...(termsBySession.get(t.session) ?? []), t]);
    const listed = await Promise.all(
      projects.map(async (p) => ({
        ...p,
        worktrees: (await git.listWorktrees(p.path).catch(() => [] as Worktree[])).filter((w) => !w.bare && !w.prunable),
      })),
    );
    // Worktrees can nest, even across projects, so ports are placed knowing all of them.
    const allPaths = listed.flatMap((p) => p.worktrees.map((w) => w.path));
    // remote-ai's own listeners (dashboard, Wi-Fi, previews) aren't a session's, even run from a worktree.
    const ownPorts = new Set([this.cfg.port, this.cfg.wifiPort, this.cfg.previewPort]);
    const candidates = ports.filter((p) => p.pid !== process.pid && !ownPorts.has(p.port));
    const index: WorktreeRef[] = [];

    const result = await Promise.all(
      listed.map(async (p): Promise<ProjectInfo> => {
        const { worktrees } = p;
        const defaultBranch = worktrees[0]?.branch ?? null;

        const sessions = await Promise.all(
          worktrees.map(async (wt, i): Promise<SessionInfo> => {
            const isMain = i === 0;
            const id = sessionId(p.name, wt.branch ?? path.basename(wt.path));
            index.push({ id, project: p.name, projectPath: p.path, worktree: wt, isMain });

            const base = this.state.baseFor(wt.path) ?? (isMain ? null : defaultBranch);
            const [dirty, ahead] = await Promise.all([
              git.dirtyCount(wt.path).catch(() => 0),
              base ? git.aheadOf(wt.path, base) : Promise.resolve(null),
            ]);
            const sessionTerms = termsBySession.get(id) ?? [];
            const isRunning = sessionTerms.some((t) => t.name === AGENT_TERMINAL && t.alive);
            const config = loadProjectConfig(wt.path, p.path);
            return {
              id,
              agent: this.agentFor(wt.path).id,
              project: p.name,
              branch: wt.branch,
              path: wt.path,
              isMain,
              running: isRunning,
              terminals: sessionTerms.map(({ name, alive, exitCode, startedAt }) => ({ name, alive, exitCode, startedAt })),
              port: this.state.portFor(wt.path),
              dirty,
              ahead,
              base,
              status: isRunning ? this.statuses.get(id) : { state: 'stopped', updatedAt: 0 },
              dev: this.dev.info({ id, path: wt.path }, config, sessionTerms),
              ports: sessionPorts(candidates, { path: wt.path, terminalPids: sessionTerms.filter((t) => t.alive).map((t) => t.pid) }, allPaths),
            };
          }),
        );
        return { name: p.name, path: p.path, source: p.source, defaultBranch, sessions };
      }),
    );

    this.index = index;
    this.cache = { at: Date.now(), projects: result };
    return result;
  }

  /** Rebuild the id → worktree index from git alone (no host, no status), which is cheap. */
  private async refreshIndex(): Promise<void> {
    const index: WorktreeRef[] = [];
    for (const p of this.discoverProjects()) {
      const worktrees = await git.listWorktrees(p.path).catch(() => [] as Worktree[]);
      worktrees
        .filter((w) => !w.bare && !w.prunable)
        .forEach((wt, i) => {
          const id = sessionId(p.name, wt.branch ?? path.basename(wt.path));
          index.push({ id, project: p.name, projectPath: p.path, worktree: wt, isMain: i === 0 });
        });
    }
    this.index = index;
  }

  private async find(id: string): Promise<WorktreeRef> {
    let ref = this.index.find((r) => r.id === id);
    if (!ref) {
      await this.refreshIndex();
      ref = this.index.find((r) => r.id === id);
    }
    if (!ref) throw new HttpError(404, `Unknown session ${id}`);
    return ref;
  }

  /** Map a hook's cwd to the session whose worktree contains it (longest path wins). */
  async resolveByCwd(cwd: string): Promise<string | null> {
    const match = () => {
      let best: WorktreeRef | null = null;
      for (const ref of this.index) {
        const root = ref.worktree.path;
        if ((cwd === root || cwd.startsWith(root + path.sep)) && root.length > (best?.worktree.path.length ?? -1)) {
          best = ref;
        }
      }
      return best?.id ?? null;
    };
    const found = match();
    if (found) return found;
    await this.refreshIndex();
    return match();
  }

  /** The adapter a worktree's sessions run; sessions from before adapters existed ran Claude. */
  private agentFor(worktreePath: string): AgentAdapter {
    const id = this.state.agentFor(worktreePath);
    return id && this.agents.has(id) ? this.agents.get(id) : this.agents.default;
  }

  /** An event an agent's hooks posted: find its session from the working directory and move its status. */
  async applyAgentEvent(agentId: string, payload: unknown): Promise<string | null> {
    const adapter = this.agents.get(agentId);
    const cwd = adapter.hooks?.cwd(payload);
    if (!adapter.hooks || !cwd) return null;
    const id = await this.resolveByCwd(cwd);
    if (!id) return null;
    const reduce = adapter.hooks.reduce;
    this.statuses.update(id, (prev) => reduce(prev, payload));
    return id;
  }

  async createSession(projectName: string, req: CreateSessionRequest): Promise<string> {
    const branch = req.branch?.trim();
    if (!branch || !(await git.isValidBranchName(branch))) throw new HttpError(400, 'Invalid branch name');
    const project = this.discoverProjects().find((p) => p.name === projectName);
    if (!project) throw new HttpError(404, `Unknown project ${projectName}`);
    const agent = this.agents.get(req.agent);
    if (req.permissionMode && !agent.modes.includes(req.permissionMode)) throw new HttpError(400, 'Invalid permission mode');

    const worktrees = await git.listWorktrees(project.path);
    let wtPath = worktrees.find((w) => w.branch === branch)?.path;
    let created = false;
    if (!wtPath) {
      const base = req.base?.trim() || worktrees[0]?.branch || 'HEAD';
      wtPath = path.join(this.cfg.worktreesDir, slug(project.name), slug(branch));
      if (fs.existsSync(wtPath)) throw new HttpError(409, `${wtPath} already exists`);
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      await git.addWorktree(project.path, wtPath, branch, base);
      await git.copyWorktreeIncludes(project.path, wtPath);
      this.state.setBase(wtPath, base);
      created = true;
    }
    this.state.setAgent(wtPath, agent.id);

    const id = sessionId(project.name, branch);
    await this.startAgent(id, wtPath, project.path, { prompt: req.prompt, mode: req.permissionMode });
    // A fresh worktree has no dependencies installed yet.
    const config = loadProjectConfig(wtPath, project.path);
    if (created && config.setup.length > 0 && !config.error) {
      await this.dev.runSetup({ id, path: wtPath }, config);
    }
    this.invalidate();
    return id;
  }

  async startSession(id: string, req: StartSessionRequest): Promise<void> {
    const ref = await this.find(id);
    const agent = this.agentFor(ref.worktree.path);
    if (req.permissionMode && !agent.modes.includes(req.permissionMode)) throw new HttpError(400, 'Invalid permission mode');
    await this.startAgent(id, ref.worktree.path, ref.projectPath, { resume: req.resume, mode: req.permissionMode });
    this.invalidate();
  }

  /** Start the worktree's agent in the host, unless it is already running there. */
  private async startAgent(
    id: string,
    cwd: string,
    mainPath: string,
    opts: { prompt?: string; mode?: PermissionMode; resume?: boolean },
  ): Promise<void> {
    if (await this.agentRunning(id)) return;
    const agent = this.agentFor(cwd);
    const port = this.state.allocatePort(cwd);
    const systemPrompt = this.dev.describeForAgent({ id, path: cwd }, loadProjectConfig(cwd, mainPath));
    this.statuses.reset(id);
    try {
      await this.host.spawn({
        session: id,
        name: AGENT_TERMINAL,
        cwd,
        argv: agent.launch({ ...opts, systemPrompt }),
        env: { PORT: String(port), REMOTE_AI_SESSION: id },
      });
    } catch (err) {
      throw new HttpError(500, (err as Error).message);
    }
  }

  /** Start, stop or restart dev servers (all, or the one named), or rerun setup. */
  async devAction(id: string, action: DevAction, name?: string): Promise<void> {
    const ref = await this.find(id);
    const target = { id, path: ref.worktree.path };
    const config = loadProjectConfig(ref.worktree.path, ref.projectPath);
    switch (action) {
      case 'setup':
        await this.dev.runSetup(target, config);
        break;
      case 'start':
        await this.dev.start(target, config, name);
        break;
      case 'stop':
        await this.dev.stop(target, config, name);
        break;
      case 'restart':
        await this.dev.stop(target, config, name);
        await this.dev.start(target, config, name);
        break;
      default:
        throw new HttpError(400, `Unknown action ${String(action)}`);
    }
    this.invalidate();
  }

  /** Project, branch and agent for notifications; falls back to the id if the worktree is gone. */
  async label(id: string): Promise<SessionLabel> {
    const ref = await this.find(id).catch(() => null);
    if (!ref) return { id, project: id.split('__')[0] ?? id, branch: id.split('__')[1] ?? '', agent: this.agents.default.name };
    return {
      id,
      project: ref.project,
      branch: ref.worktree.branch ?? path.basename(ref.worktree.path),
      agent: this.agentFor(ref.worktree.path).name,
    };
  }

  /** The agent's transcript for the chat view and how to read it; no file before the first conversation. */
  async transcriptFor(id: string): Promise<{ file: string | null; parse: (line: string) => ChatItem[] }> {
    const ref = await this.find(id);
    const transcript = this.agentFor(ref.worktree.path).transcript;
    if (!transcript) return { file: null, parse: () => [] };
    return { file: transcript.find(ref.worktree.path, this.statuses.get(id).transcriptPath), parse: transcript.parse };
  }

  /** Where a session's server (or setup) output is logged; the name must be one it has. */
  async logPath(id: string, name: string): Promise<string> {
    const ref = await this.find(id);
    const config = loadProjectConfig(ref.worktree.path, ref.projectPath);
    if (name !== 'setup' && !config.servers.some((s) => s.name === name)) throw new HttpError(404, `No log named ${name}`);
    return this.dev.logFile(id, name);
  }

  /** End the agent, dev servers and setup of a session. */
  async stopSession(id: string): Promise<void> {
    await this.host.killSession(id);
    this.statuses.reset(id);
    this.invalidate();
  }

  /** Stop the session and remove its worktree. The branch itself is kept. */
  async deleteSession(id: string, force: boolean): Promise<void> {
    const ref = await this.find(id);
    if (ref.isMain) throw new HttpError(400, "The main checkout can't be removed, only stopped");
    await this.stopSession(id);
    await git.removeWorktree(ref.projectPath, ref.worktree.path, force);
    this.dev.forget({ id, path: ref.worktree.path });
    this.state.forget(ref.worktree.path);
    this.invalidate();
  }

  private agentTerm(id: string): TermRef {
    return { session: id, name: AGENT_TERMINAL };
  }

  private async agentRunning(id: string): Promise<boolean> {
    return (await this.host.list()).some((t) => t.session === id && t.name === AGENT_TERMINAL && t.alive);
  }

  private async requireRunning(id: string): Promise<void> {
    if (!(await this.agentRunning(id))) throw new HttpError(409, 'Session is not running');
  }

  async sendKeys(id: string, keys: string[]): Promise<void> {
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 20 || !keys.every((k) => ALLOWED_KEYS.has(k))) {
      throw new HttpError(400, 'Unsupported keys');
    }
    await this.requireRunning(id);
    await this.host.keys(this.agentTerm(id), keys);
  }

  /** Paste text into the agent's input box, optionally pressing Enter to submit it. */
  async sendText(id: string, text: string, submit: boolean): Promise<void> {
    if (typeof text !== 'string' || text.length === 0) throw new HttpError(400, 'Text is required');
    await this.requireRunning(id);
    await this.host.paste(this.agentTerm(id), text);
    if (submit) {
      // Give the agent a moment to finish handling the paste before Enter arrives.
      await new Promise((r) => setTimeout(r, 80));
      await this.host.keys(this.agentTerm(id), ['Enter']);
    }
  }

  async visiblePrompt(id: string): Promise<VisiblePrompt | null> {
    const ref = await this.find(id);
    const parse = this.agentFor(ref.worktree.path).parsePrompt;
    await this.requireRunning(id);
    return parse ? parse(await this.host.screen(this.agentTerm(id))) : null;
  }

  /**
   * Choose an option in the prompt that is on screen right now. Moves the highlight with
   * arrow keys and presses Enter, and refuses if the prompt has gone away.
   */
  async answer(id: string, key: string): Promise<void> {
    const prompt = await this.visiblePrompt(id);
    if (!prompt) throw new HttpError(409, 'No prompt is showing');
    const target = prompt.options.findIndex((o) => o.key === key);
    const current = prompt.options.findIndex((o) => o.selected);
    if (target === -1) throw new HttpError(400, `No option ${key}`);
    const delta = target - current;
    const moves = Array<string>(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up');
    await this.host.keys(this.agentTerm(id), [...moves, 'Enter']);
  }
}
