import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  /** Where phones on the same Wi-Fi connect, once that is turned on (the main port stays on localhost). */
  wifiPort: number;
  /** Every git checkout in this directory is a project, besides those added one by one. Null for none. */
  projectsDir: string | null;
  /** Where new worktrees are created: `<worktreesDir>/<project>/<branch>`. */
  worktreesDir: string;
  /** Holds state.json, logs, claude-settings.json, and the session host's socket, token and log. */
  dataDir: string;
  claudeCommand: string;
  /** First dev-server port; each session gets a block of `portStep` ports. */
  portBase: number;
  portStep: number;
  /** Contact URL or mailto: sent to push services with each notification (VAPID "sub"). */
  pushSubject: string;
  /** When set, requests that reach the server through a proxy or the network must log in. */
  password?: string;
  /** Requests from other devices need a paired device (or the password). The desktop app always pairs. */
  requirePairing?: boolean;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Settings come from env vars, then `<dataDir>/config.json`, then `defaults` (which the desktop app
 * uses for its own data folder and to leave out the projects directory), then built-in defaults.
 */
export function loadConfig(defaults: Partial<Config> = {}): Config {
  const env = process.env;
  const dataDir = path.resolve(expandHome(env.REMOTE_AI_DATA_DIR ?? defaults.dataDir ?? '~/.remote-ai'));
  fs.mkdirSync(dataDir, { recursive: true });

  const configPath = path.join(dataDir, 'config.json');
  const file: Partial<Config> = fs.existsSync(configPath)
    ? (JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<Config>)
    : {};

  const projectsDir =
    env.REMOTE_AI_PROJECTS_DIR ?? (file.projectsDir !== undefined ? file.projectsDir : defaults.projectsDir !== undefined ? defaults.projectsDir : '~/projects');
  return {
    host: env.REMOTE_AI_HOST ?? file.host ?? defaults.host ?? '127.0.0.1',
    port: Number(env.REMOTE_AI_PORT ?? file.port ?? defaults.port ?? 8787),
    wifiPort: Number(env.REMOTE_AI_WIFI_PORT ?? file.wifiPort ?? defaults.wifiPort ?? Number(env.REMOTE_AI_PORT ?? file.port ?? defaults.port ?? 8787) + 1),
    projectsDir: projectsDir ? path.resolve(expandHome(projectsDir)) : null,
    worktreesDir: path.resolve(expandHome(env.REMOTE_AI_WORKTREES_DIR ?? file.worktreesDir ?? defaults.worktreesDir ?? '~/worktrees')),
    dataDir,
    claudeCommand: env.REMOTE_AI_CLAUDE_COMMAND ?? file.claudeCommand ?? defaults.claudeCommand ?? 'claude',
    portBase: Number(env.REMOTE_AI_PORT_BASE ?? file.portBase ?? defaults.portBase ?? 3100),
    portStep: Number(file.portStep ?? defaults.portStep ?? 10),
    pushSubject: env.REMOTE_AI_PUSH_SUBJECT ?? file.pushSubject ?? 'https://github.com/ncoop720/remote-ai',
    password: env.REMOTE_AI_PASSWORD || file.password || undefined,
    requirePairing: env.REMOTE_AI_REQUIRE_PAIRING ? env.REMOTE_AI_REQUIRE_PAIRING === '1' : (file.requirePairing ?? defaults.requirePairing),
  };
}
