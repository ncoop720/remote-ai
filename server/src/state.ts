import fs from 'node:fs';
import path from 'node:path';

interface StateData {
  /** Dev-server port block assigned to each worktree path. */
  ports: Record<string, number>;
  /** Branch each worktree was created from, used for "commits ahead". */
  bases: Record<string, string>;
  /** Agent adapter each worktree's sessions run. */
  agents: Record<string, string>;
  /** Main checkouts added as projects, wherever they are. */
  projects: string[];
}

/** Small JSON file for facts that must outlive the session host (whose terminals end on reboot). */
export class StateStore {
  private readonly file: string;
  private data: StateData;

  constructor(
    dataDir: string,
    private readonly portBase: number,
    private readonly portStep: number,
  ) {
    this.file = path.join(dataDir, 'state.json');
    this.data = fs.existsSync(this.file)
      ? { ports: {}, bases: {}, agents: {}, projects: [], ...(JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StateData>) }
      : { ports: {}, bases: {}, agents: {}, projects: [] };
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  portFor(worktreePath: string): number | null {
    return this.data.ports[worktreePath] ?? null;
  }

  allocatePort(worktreePath: string): number {
    const existing = this.data.ports[worktreePath];
    if (existing !== undefined) return existing;
    const used = new Set(Object.values(this.data.ports));
    let port = this.portBase;
    while (used.has(port)) port += this.portStep;
    this.data.ports[worktreePath] = port;
    this.save();
    return port;
  }

  baseFor(worktreePath: string): string | null {
    return this.data.bases[worktreePath] ?? null;
  }

  setBase(worktreePath: string, base: string): void {
    this.data.bases[worktreePath] = base;
    this.save();
  }

  agentFor(worktreePath: string): string | null {
    return this.data.agents[worktreePath] ?? null;
  }

  setAgent(worktreePath: string, agent: string): void {
    if (this.data.agents[worktreePath] === agent) return;
    this.data.agents[worktreePath] = agent;
    this.save();
  }

  projects(): string[] {
    return [...this.data.projects];
  }

  addProject(repoPath: string): void {
    if (this.data.projects.includes(repoPath)) return;
    this.data.projects.push(repoPath);
    this.save();
  }

  removeProject(repoPath: string): void {
    this.data.projects = this.data.projects.filter((p) => p !== repoPath);
    this.save();
  }

  forget(worktreePath: string): void {
    delete this.data.ports[worktreePath];
    delete this.data.bases[worktreePath];
    delete this.data.agents[worktreePath];
    this.save();
  }
}
