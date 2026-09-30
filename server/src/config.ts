import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  /** Directory whose git checkouts are the projects. */
  projectsDir: string;
  /** Where new worktrees are created: `<worktreesDir>/<project>/<branch>`. */
  worktreesDir: string;
  /** Holds state.json, the generated tmux.conf, claude-settings.json and the hook token. */
  dataDir: string;
  /** Dedicated tmux server (`tmux -L <socket>`) so our sessions never mix with yours. */
  tmuxSocket: string;
  claudeCommand: string;
  /** First dev-server port; each session gets a block of `portStep` ports. */
  portBase: number;
  portStep: number;
  /** Contact URL or mailto: sent to push services with each notification (VAPID "sub"). */
  pushSubject: string;
  /** When set, requests that reach the server through a proxy or the network must log in. */
  password?: string;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Settings come from env vars, then `<dataDir>/config.json`, then defaults. */
export function loadConfig(): Config {
  const env = process.env;
  const dataDir = path.resolve(expandHome(env.REMOTE_AI_DATA_DIR ?? '~/.remote-ai'));
  fs.mkdirSync(dataDir, { recursive: true });

  const configPath = path.join(dataDir, 'config.json');
  const file: Partial<Config> = fs.existsSync(configPath)
    ? (JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<Config>)
    : {};

  return {
    // "localhost" listens on both 127.0.0.1 and ::1, so clients that try IPv6 first still connect.
    host: env.REMOTE_AI_HOST ?? file.host ?? 'localhost',
    port: Number(env.REMOTE_AI_PORT ?? file.port ?? 8787),
    projectsDir: path.resolve(expandHome(env.REMOTE_AI_PROJECTS_DIR ?? file.projectsDir ?? '~/projects')),
    worktreesDir: path.resolve(expandHome(env.REMOTE_AI_WORKTREES_DIR ?? file.worktreesDir ?? '~/worktrees')),
    dataDir,
    tmuxSocket: env.REMOTE_AI_TMUX_SOCKET ?? file.tmuxSocket ?? 'remote-ai',
    claudeCommand: env.REMOTE_AI_CLAUDE_COMMAND ?? file.claudeCommand ?? 'claude',
    portBase: Number(env.REMOTE_AI_PORT_BASE ?? file.portBase ?? 3100),
    portStep: Number(file.portStep ?? 10),
    pushSubject: env.REMOTE_AI_PUSH_SUBJECT ?? file.pushSubject ?? 'https://github.com/ncoop720/remote-ai',
    password: env.REMOTE_AI_PASSWORD || file.password || undefined,
  };
}
