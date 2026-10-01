import fs from 'node:fs';
import path from 'node:path';
import { detectDevConfig } from './detect.js';

export const CONFIG_FILE = '.remote-ai.json';

export interface DevServerConfig {
  name: string;
  command: string;
  /** Directory to run in, relative to the worktree root ('' = root). */
  cwd: string;
}

export interface ProjectConfig {
  /** A .remote-ai.json, a guess from the repo's files, or nothing found. */
  source: 'file' | 'detected' | 'none';
  /** What the guess is based on, e.g. "Vite with pnpm". */
  detected?: string;
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

/**
 * The worktree's own config wins, then the main checkout's (which may be uncommitted, so it
 * applies to every branch without touching history), then a guess from the repo's files.
 */
export function loadProjectConfig(worktreePath: string, mainPath: string): ProjectConfig {
  for (const dir of [worktreePath, mainPath]) {
    const file = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(file)) return parseProjectConfig(fs.readFileSync(file, 'utf8'));
  }
  return detectDevConfig(worktreePath) ?? NONE;
}

/** `PORT_<NAME>` variable for a server, e.g. "api-v2" → PORT_API_V2. */
export function portVar(name: string): string {
  return `PORT_${name.toUpperCase().replace(/-/g, '_')}`;
}

const OS_NAME: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/**
 * The request "Set up with Claude" sends the session's agent: look at the repo and write
 * .remote-ai.json. Plain instructions any coding agent can follow.
 */
export function setupRequest(current: ProjectConfig, platform: string): string {
  const guess =
    current.source === 'detected'
      ? `remote-ai guessed this from the repo's files (${current.detected}):\n${JSON.stringify({ setup: current.setup, servers: current.servers }, null, 2)}\nKeep what is right and fix what isn't.`
      : current.source === 'file'
        ? `There is a ${CONFIG_FILE} already${current.error ? ` with a problem: ${current.error}` : ''}. Check it against the repo and fix it if needed.`
        : 'remote-ai found nothing it recognizes, so look at the README, scripts and config files.';
  return [
    `Set up this repository for remote-ai: write ${CONFIG_FILE} at the root of this worktree, saying how to install its dependencies and run its development servers. Don't start any servers yourself; remote-ai runs them.`,
    '',
    'Format:',
    '{',
    '  "setup": ["commands run once in each new worktree, from its root, e.g. installing dependencies"],',
    '  "servers": [{ "name": "web", "command": "npm run dev -- --port $PORT", "cwd": "optional/subfolder" }]',
    '}',
    '',
    'Rules:',
    '- Server names are lowercase letters, digits and dashes.',
    '- Each server gets its own port in $PORT; make its command listen on it (many dev servers need a flag such as --port $PORT). Every command also gets $PORT_<NAME> for every server (e.g. $PORT_API), so a frontend can find its backend.',
    '- List backends before the frontends that use them; servers start in that order.',
    `- Commands run in the user's shell on ${OS_NAME[platform] ?? platform}; $PORT and $PORT_<NAME> work on every OS.`,
    "- Use the project's own scripts and package manager. Include only servers needed for development, and services such as databases only if the project expects them to be started locally.",
    '',
    guess,
    '',
    `When ${CONFIG_FILE} is written, check that it is valid JSON, then say in a few lines what you set up.`,
  ].join('\n');
}
