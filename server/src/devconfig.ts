import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.remote-ai.json';

export interface DevServerConfig {
  name: string;
  command: string;
  /** Directory to run in, relative to the worktree root ('' = root). */
  cwd: string;
}

export interface ProjectConfig {
  source: 'file' | 'default' | 'none';
  error?: string;
  /** Run once in each new worktree, from its root, e.g. installing dependencies. */
  setup: string[];
  servers: DevServerConfig[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
const RESERVED = new Set(['claude', 'setup']);
const NONE: ProjectConfig = { source: 'none', setup: [], servers: [] };

function invalid(error: string): ProjectConfig {
  return { source: 'file', error, setup: [], servers: [] };
}

export function parseProjectConfig(text: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return invalid(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid(`${CONFIG_FILE} must contain an object`);
  const obj = raw as { setup?: unknown; servers?: unknown };

  const setup = obj.setup ?? [];
  if (!Array.isArray(setup) || !setup.every((s) => typeof s === 'string' && s.trim())) {
    return invalid('"setup" must be a list of commands');
  }
  const serversRaw = obj.servers ?? [];
  if (!Array.isArray(serversRaw)) return invalid('"servers" must be a list');

  const servers: DevServerConfig[] = [];
  for (const entry of serversRaw) {
    const { name, command, cwd = '' } = (entry ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !NAME.test(name) || RESERVED.has(name)) {
      return invalid(`Server name ${JSON.stringify(name)} must be lowercase letters, digits and dashes, and not "claude" or "setup"`);
    }
    if (servers.some((s) => s.name === name)) return invalid(`Two servers are named "${name}"`);
    if (typeof command !== 'string' || !command.trim()) return invalid(`Server "${name}" needs a command`);
    if (typeof cwd !== 'string' || path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) {
      return invalid(`Server "${name}" cwd must be a folder inside the repo`);
    }
    servers.push({ name, command, cwd });
  }
  return { source: 'file', setup: setup as string[], servers };
}

/** A guess for repos without a config file: an npm project with a "dev" script. */
export function defaultConfig(root: string): ProjectConfig {
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    return NONE;
  }
  if (typeof pkg.scripts?.dev !== 'string') return NONE;
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const install = has('pnpm-lock.yaml')
    ? 'pnpm install --frozen-lockfile'
    : has('yarn.lock')
      ? 'yarn install --frozen-lockfile'
      : has('package-lock.json')
        ? 'npm ci'
        : 'npm install';
  return { source: 'default', setup: [install], servers: [{ name: 'dev', command: 'npm run dev', cwd: '' }] };
}

/**
 * The worktree's own config wins, then the main checkout's (which may be uncommitted, so it
 * applies to every branch without touching history), then a guess from package.json.
 */
export function loadProjectConfig(worktreePath: string, mainPath: string): ProjectConfig {
  for (const dir of [worktreePath, mainPath]) {
    const file = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(file)) return parseProjectConfig(fs.readFileSync(file, 'utf8'));
  }
  return defaultConfig(worktreePath);
}

/** `PORT_<NAME>` variable for a server, e.g. "api-v2" → PORT_API_V2. */
export function portVar(name: string): string {
  return `PORT_${name.toUpperCase().replace(/-/g, '_')}`;
}
