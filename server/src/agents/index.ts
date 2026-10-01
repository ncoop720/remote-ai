import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentInfo } from '../../../shared/types.js';
import { HttpError } from '../errors.js';
import type { AgentAdapter } from './types.js';

export type { AgentAdapter, LaunchOptions } from './types.js';

/** Hooks post with this token, so /api/hooks/* can reject posts that didn't come from our sessions. */
export function loadHookToken(dataDir: string): string {
  const file = path.join(dataDir, 'hook-token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/** The agents this install knows how to run. The first is the default for new sessions. */
export class AgentRegistry {
  private readonly byId: Map<string, AgentAdapter>;

  constructor(readonly adapters: AgentAdapter[]) {
    if (adapters.length === 0) throw new Error('At least one agent adapter is required');
    this.byId = new Map(adapters.map((a) => [a.id, a]));
  }

  get default(): AgentAdapter {
    return this.adapters[0]!;
  }

  get(id: string | null | undefined): AgentAdapter {
    if (!id) return this.default;
    const adapter = this.byId.get(id);
    if (!adapter) throw new HttpError(400, `Unknown agent ${id}`);
    return adapter;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Which agents are installed and signed in, for the New session form and first-run checks. */
  async detect(): Promise<AgentInfo[]> {
    return Promise.all(
      this.adapters.map(async (a) => ({ id: a.id, name: a.name, modes: [...a.modes], ...(await a.detect()) })),
    );
  }
}
