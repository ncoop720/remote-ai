import { spawnSync } from 'node:child_process';
import { findExecutable } from '../which.js';
import type { TermSpec } from './protocol.js';

export interface Launch {
  file: string;
  args: string[];
  env: Record<string, string>;
}

const MARKER = '__REMOTE_AI_ENV__';

/**
 * Variables that belong to whatever started the host, not to the programs it runs: a tmux or
 * Claude Code session it was started from, the desktop app's AppImage, and remote-ai's own
 * settings and ports (each terminal gets its own PORT).
 */
function isInherited(name: string): boolean {
  return (
    /^(TMUX|TMUX_PANE|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|PORT|INVOCATION_ID|JOURNAL_STREAM|PWD|OLDPWD|SHLVL|_|APPDIR|APPIMAGE|ARGV0|OWD)$/.test(name) ||
    name.startsWith('REMOTE_AI_') ||
    name.startsWith('PORT_')
  );
}

/**
 * An AppImage adds its own mount to PATH and other search paths. Drop those entries: the programs
 * we start are the user's, and the mount goes away when the app quits.
 */
export function withoutAppImagePaths(env: Record<string, string | undefined>): Record<string, string> {
  const appdir = env.APPDIR;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!appdir || !v.includes(appdir)) {
      out[k] = v;
      continue;
    }
    const kept = v.split(':').filter((entry) => entry && !entry.startsWith(appdir));
    if (kept.length > 0) out[k] = kept.join(':');
  }
  return out;
}

/** Parse `env -0` output that follows the marker; anything a noisy rc file printed first is skipped. */
export function parseEnvOutput(out: string): Record<string, string> | null {
  const at = out.lastIndexOf(MARKER);
  if (at === -1) return null;
  const env: Record<string, string> = {};
  for (const entry of out.slice(at + MARKER.length).split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * The environment the user's login shell sets up, or null on Windows or if the shell fails.
 * Apps started from a desktop launcher (macOS especially) get a minimal PATH, so ask the shell
 * once, the way VS Code does.
 */
export function loginShellEnv(): Record<string, string> | null {
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/sh';
  const result = spawnSync(shell, ['-ilc', `command printf '%s' '${MARKER}'; command env -0`], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: process.env,
  });
  return result.stdout ? parseEnvOutput(result.stdout) : null;
}

/** The environment a terminal the user opened would have. Windows programs already get the user's environment. */
export function baseEnvironment(): Record<string, string> {
  const env = withoutAppImagePaths({ ...process.env, ...loginShellEnv() });
  for (const k of Object.keys(env)) if (isInherited(k)) delete env[k];
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

/** cmd.exe has no `$VAR`, so on Windows the variables we set ($PORT, $PORT_API, ...) are filled in. */
export function expandVars(command: string, vars: Record<string, string>): string {
  return command.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (whole, braced, bare) => {
    const value = vars[(braced ?? bare) as string];
    return value === undefined ? whole : value;
  });
}

/** Quote one argument for cmd.exe /s /c "...". */
function cmdQuote(arg: string): string {
  return /^[A-Za-z0-9_\-./:=@\\]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/** Turn a terminal spec into the program node-pty should start. Throws if the program can't be found. */
export function resolveLaunch(spec: TermSpec, base: Record<string, string>, platform = process.platform): Launch {
  const env = { ...base, ...spec.env };
  if (spec.command !== undefined) {
    if (platform === 'win32') {
      return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', expandVars(spec.command, spec.env ?? {})], env };
    }
    return { file: env.SHELL || '/bin/sh', args: ['-c', spec.command], env };
  }

  const [program, ...args] = spec.argv ?? [];
  if (!program) throw new Error('Nothing to run');
  const file = findExecutable(program, env, platform);
  if (!file) throw new Error(`${program} is not installed or not on PATH`);
  // Batch files (npm's shims, for one) only run through cmd.exe.
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[file, ...args].map(cmdQuote).join(' ')}"`], env };
  }
  return { file, args, env };
}
