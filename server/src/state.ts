import fs from 'node:fs';
import path from 'node:path';

interface StateData {
  /** Dev-server port block assigned to each worktree path. */
  ports: Record<string, number>;
  /** Branch each worktree was created from, used for "commits ahead". */
  bases: Record<string, string>;
}

/** Small JSON file for facts that must outlive tmux sessions (which die on reboot). */
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
      ? { ports: {}, bases: {}, ...(JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StateData>) }
      : { ports: {}, bases: {} };
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

  forget(worktreePath: string): void {
    delete this.data.ports[worktreePath];
    delete this.data.bases[worktreePath];
    this.save();
  }
}
