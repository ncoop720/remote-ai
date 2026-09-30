import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import * as git from './git.js';
import type { Worktree } from './git.js';
import { buildClaudeCommand } from './claude.js';
import type { DevManager } from './dev.js';
import { loadProjectConfig } from './devconfig.js';
import { HttpError } from './errors.js';
import { sessionId, slug } from './ids.js';
import { listeningPorts } from './ports.js';
import { parseVisiblePrompt } from './prompt.js';
import { findTranscript } from './transcript.js';
import type { StateStore } from './state.js';
import type { StatusStore } from './status.js';
import type { Tmux } from './tmux.js';
import type {
  CreateSessionRequest,
  DevAction,
  ListeningPort,
  PermissionMode,
  ProjectInfo,
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

/** Keys the mobile key bar may send. Names are tmux key names. */
const ALLOWED_KEYS = new Set(['Escape', 'C-c', 'BTab', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Enter']);
const CLAUDE_WINDOW = 'claude';
const CACHE_MS = 1500;

export class SessionManager {
  private cache: { at: number; projects: ProjectInfo[] } | null = null;
  private index: WorktreeRef[] = [];

  constructor(
    private readonly cfg: Config,
    private readonly tmux: Tmux,
    private readonly state: StateStore,
    private readonly statuses: StatusStore,
    private readonly settingsPath: string,
    private readonly dev: DevManager,
  ) {}

  invalidate(): void {
    this.cache = null;
  }

  /** Every directory in projectsDir that is a main git checkout (worktrees have a `.git` file, not a dir). */
  private discoverProjects(): { name: string; path: string }[] {
    if (!fs.existsSync(this.cfg.projectsDir)) return [];
    return fs
      .readdirSync(this.cfg.projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: path.join(this.cfg.projectsDir, d.name) }))
      .filter((p) => {
        try {
          return fs.statSync(path.join(p.path, '.git')).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
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
    const [projects, tmuxSessions, windows, ports] = await Promise.all([
      Promise.resolve(this.discoverProjects()),
      this.tmux.listSessions(),
      this.tmux.listWindows(),
      listeningPorts(),
    ]);
    const running = new Set(tmuxSessions.map((s) => s.name));
    const index: WorktreeRef[] = [];
    const selfPort = this.cfg.port;
    // A port belongs to the worktree its process runs in; nested paths go to the longest match.
    const portsIn = (root: string, all: string[]): ListeningPort[] =>
      ports
        .filter((p) => p.port !== selfPort && (p.cwd === root || p.cwd.startsWith(root + path.sep)))
        .filter((p) => !all.some((other) => other.length > root.length && (p.cwd === other || p.cwd.startsWith(other + path.sep))))
        .map(({ port, pid, command }) => ({ port, pid, command }));

    const result = await Promise.all(
      projects.map(async (p): Promise<ProjectInfo> => {
        const worktrees = (await git.listWorktrees(p.path).catch(() => [] as Worktree[])).filter(
          (w) => !w.bare && !w.prunable,
        );
        const defaultBranch = worktrees[0]?.branch ?? null;
        const allPaths = worktrees.map((w) => w.path);

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
            const isRunning = running.has(id);
            const sessionWindows = windows.get(id) ?? [];
            const config = loadProjectConfig(wt.path, p.path);
            return {
              id,
              project: p.name,
              branch: wt.branch,
              path: wt.path,
              isMain,
              running: isRunning,
              windows: sessionWindows,
              port: this.state.portFor(wt.path),
              dirty,
              ahead,
              base,
              status: isRunning ? this.statuses.get(id) : { state: 'stopped', updatedAt: 0 },
              dev: this.dev.info({ id, path: wt.path }, config, sessionWindows),
              ports: portsIn(wt.path, allPaths),
            };
          }),
        );
        return { name: p.name, path: p.path, defaultBranch, sessions };
      }),
    );

    this.index = index;
    this.cache = { at: Date.now(), projects: result };
    return result;
  }

  /** Rebuild the id → worktree index from git alone (no tmux, no status), which is cheap. */
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

  async createSession(projectName: string, req: CreateSessionRequest): Promise<string> {
    const branch = req.branch?.trim();
    if (!branch || !(await git.isValidBranchName(branch))) throw new HttpError(400, 'Invalid branch name');
    const project = this.discoverProjects().find((p) => p.name === projectName);
    if (!project) throw new HttpError(404, `Unknown project ${projectName}`);

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

    const id = sessionId(project.name, branch);
    await this.startTmux(id, wtPath, project.path, { prompt: req.prompt, permissionMode: req.permissionMode });
    // A fresh worktree has no dependencies installed yet.
    const config = loadProjectConfig(wtPath, project.path);
    if (created && config.setup.length > 0 && !config.error) {
      await this.dev.runSetup({ id, path: wtPath }, config, (await this.tmux.listWindows()).get(id) ?? []);
    }
    this.invalidate();
    return id;
  }

  async startSession(id: string, req: StartSessionRequest): Promise<void> {
    const ref = await this.find(id);
    await this.startTmux(id, ref.worktree.path, ref.projectPath, { resume: req.resume, permissionMode: req.permissionMode });
    this.invalidate();
  }

  private async startTmux(
    id: string,
    cwd: string,
    mainPath: string,
    opts: { prompt?: string; permissionMode?: PermissionMode; resume?: boolean },
  ): Promise<void> {
    if (await this.tmux.hasSession(id)) return;
    const port = this.state.allocatePort(cwd);
    await this.tmux.newSession({
      name: id,
      cwd,
      window: CLAUDE_WINDOW,
      env: { PORT: String(port), REMOTE_AI_SESSION: id },
    });
    const appendSystemPrompt = this.dev.describeForClaude({ id, path: cwd }, loadProjectConfig(cwd, mainPath));
    // Typed into an interactive shell (not passed as the window command) so the user's
    // shell rc files set up PATH, and the shell survives if Claude exits.
    const command = buildClaudeCommand({
      claudeCommand: this.cfg.claudeCommand,
      settingsPath: this.settingsPath,
      appendSystemPrompt,
      ...opts,
    });
    await this.tmux.sendText(this.target(id), command);
    await this.tmux.sendKeys(this.target(id), ['Enter']);
    this.statuses.reset(id);
  }

  /** Start, stop or restart dev servers (all, or the one named), or rerun setup. */
  async devAction(id: string, action: DevAction, name?: string): Promise<void> {
    const ref = await this.find(id);
    await this.requireRunning(id);
    const target = { id, path: ref.worktree.path };
    const config = loadProjectConfig(ref.worktree.path, ref.projectPath);
    const windows = async () => (await this.tmux.listWindows()).get(id) ?? [];
    switch (action) {
      case 'setup':
        await this.dev.runSetup(target, config, await windows());
        break;
      case 'start':
        await this.dev.start(target, config, await windows(), name);
        break;
      case 'stop':
        await this.dev.stop(target, config, name);
        break;
      case 'restart':
        await this.dev.stop(target, config, name);
        await this.dev.start(target, config, await windows(), name);
        break;
      default:
        throw new HttpError(400, `Unknown action ${String(action)}`);
    }
    this.invalidate();
  }

  /** Project and branch for notifications; falls back to the id if the worktree is gone. */
  async label(id: string): Promise<{ id: string; project: string; branch: string }> {
    const ref = await this.find(id).catch(() => null);
    if (!ref) return { id, project: id.split('__')[0] ?? id, branch: id.split('__')[1] ?? '' };
    return { id, project: ref.project, branch: ref.worktree.branch ?? path.basename(ref.worktree.path) };
  }

  /** The Claude transcript to show in the chat view, or null before the first conversation. */
  async transcriptFor(id: string): Promise<string | null> {
    const ref = await this.find(id);
    return findTranscript(ref.worktree.path, this.statuses.get(id).transcriptPath);
  }

  /** Where a session's server (or setup) output is logged; the name must be one it has. */
  async logPath(id: string, name: string): Promise<string> {
    const ref = await this.find(id);
    const config = loadProjectConfig(ref.worktree.path, ref.projectPath);
    if (name !== 'setup' && !config.servers.some((s) => s.name === name)) throw new HttpError(404, `No log named ${name}`);
    return this.dev.logFile(id, name);
  }

  async stopSession(id: string): Promise<void> {
    if (await this.tmux.hasSession(id)) await this.tmux.killSession(id);
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

  private target(id: string, window = CLAUDE_WINDOW): string {
    return `=${id}:${window}`;
  }

  private async requireRunning(id: string): Promise<void> {
    if (!(await this.tmux.hasSession(id))) throw new HttpError(409, 'Session is not running');
  }

  async sendKeys(id: string, keys: string[]): Promise<void> {
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 20 || !keys.every((k) => ALLOWED_KEYS.has(k))) {
      throw new HttpError(400, 'Unsupported keys');
    }
    await this.requireRunning(id);
    await this.tmux.sendKeys(this.target(id), keys);
  }

  /** Paste text into Claude's input box, optionally pressing Enter to submit it. */
  async sendText(id: string, text: string, submit: boolean): Promise<void> {
    if (typeof text !== 'string' || text.length === 0) throw new HttpError(400, 'Text is required');
    await this.requireRunning(id);
    await this.tmux.paste(this.target(id), text);
    if (submit) {
      // Give Claude Code a moment to finish handling the paste before Enter arrives.
      await new Promise((r) => setTimeout(r, 80));
      await this.tmux.sendKeys(this.target(id), ['Enter']);
    }
  }

  async visiblePrompt(id: string): Promise<VisiblePrompt | null> {
    await this.requireRunning(id);
    return parseVisiblePrompt(await this.tmux.capture(this.target(id)));
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
    await this.tmux.sendKeys(this.target(id), [...moves, 'Enter']);
  }
}
