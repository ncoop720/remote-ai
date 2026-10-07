import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath } from './git.js';

export interface StateData {
  /** Dev-server port block assigned to each worktree path. */
  ports: Record<string, number>;
  /** Branch each worktree was created from, used for "commits ahead". */
  bases: Record<string, string>;
  /** Agent adapter each worktree's sessions run. */
  agents: Record<string, string>;
  /** Main checkouts added as projects, wherever they are. */
  projects: string[];
}

/**
 * Give every path its one spelling. Before paths had one, creating a Windows session stored its
 * worktree as path.join spells it (C:\Users\...) and everything after as git prints it
 * (C:/Users/...). All lookups went by git's, so where a path has both, git's entry is the one in
 * use (its dev servers run on that port block) and the other is dropped.
 */
export function oneSpelling(data: StateData, platform = process.platform): StateData {
  const byPath = <T>(entries: Record<string, T>): Record<string, T> => {
    const result: Record<string, T> = {};
    for (const [p, value] of Object.entries(entries)) {
      const key = canonicalPath(p, platform);
      const fromGit = !p.includes('\\');
      if (!Object.hasOwn(result, key) || fromGit) result[key] = value;
    }
    return result;
  };
  return {
    ...data,
    ports: byPath(data.ports),
    bases: byPath(data.bases),
    agents: byPath(data.agents),
    projects: [...new Set(data.projects.map((p) => canonicalPath(p, platform)))],
  };
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
    const stored: StateData = fs.existsSync(this.file)
      ? { ports: {}, bases: {}, agents: {}, projects: [], ...(JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StateData>) }
      : { ports: {}, bases: {}, agents: {}, projects: [] };
    this.data = oneSpelling(stored);
    if (JSON.stringify(this.data) !== JSON.stringify(stored)) this.save();
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

  /** Every worktree the state has something on. */
  worktreePaths(): string[] {
    return [...new Set([...Object.keys(this.data.ports), ...Object.keys(this.data.bases), ...Object.keys(this.data.agents)])];
  }

  forget(worktreePath: string): void {
    delete this.data.ports[worktreePath];
    delete this.data.bases[worktreePath];
    delete this.data.agents[worktreePath];
    this.save();
  }
}
