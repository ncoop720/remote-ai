import os from 'node:os';
import path from 'node:path';
import { run } from '../../exec.js';
import { findExecutable } from '../../which.js';
import type { AgentAdapter, LaunchOptions } from '../types.js';
import { reduceHook, type HookPayload } from './hooks.js';
import { parseVisiblePrompt } from './prompt.js';
import { findTranscript, parseTranscriptLine, readTitle } from './transcript.js';

/** Values for `claude --permission-mode`. "manual" asks before every action (formerly "default"). */
export const CLAUDE_MODES = ['auto', 'manual', 'acceptEdits', 'plan'] as const;

/** `claude auth status --json` prints { loggedIn, authMethod, ... }. */
export function parseAuthStatus(out: string): boolean {
  try {
    return (JSON.parse(out) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * The official installers, from https://code.claude.com/docs/en/setup. An argv rather than a
 * command line, so the PowerShell one never passes through cmd.exe's quoting.
 */
export function claudeInstallArgs(platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']
    : ['bash', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'];
}

/**
 * Where to run `claude` from: PATH, or where the official installer puts it. A fresh install is
 * often not on this process's PATH yet (the installer edits shell profiles, which only new shells read).
 */
function resolveClaude(name: string): string {
  if (name !== 'claude') return name;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  return (
    findExecutable(name, process.env) ??
    findExecutable(path.join(os.homedir(), '.local', 'bin', exe), process.env) ??
    findExecutable(path.join(os.homedir(), '.claude', 'local', exe), process.env) ??
    name
  );
}

export function buildClaudeArgs(command: string[], settingsPath: string, opts: LaunchOptions): string[] {
  const args = [...command, '--settings', settingsPath];
  // Always explicit when chosen: leaving it out falls back to the user's configured default, which may be auto.
  if (opts.mode) args.push('--permission-mode', opts.mode);
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.resume) args.push('--continue');
  if (opts.prompt?.trim()) args.push(opts.prompt.trim());
  return args;
}

/**
 * Claude Code, the first adapter and the only one with the full tier at launch: status and
 * approvals from its hooks, menus from its screen, the chat view from its transcript.
 */
export function claudeAdapter(opts: { command: string; settingsPath: string }): AgentAdapter {
  const [name = 'claude', ...extra] = opts.command.trim().split(/\s+/);
  const command = () => [resolveClaude(name), ...extra];
  return {
    id: 'claude',
    name: 'Claude Code',
    instructionFile: 'CLAUDE.md',
    status: 'hooks',
    modes: CLAUDE_MODES,

    async detect() {
      const [exe, ...args] = command();
      let version: string | undefined;
      try {
        version = /\d+\.\d+\.\d+/.exec(await run(exe!, [...args, '--version']))?.[0];
      } catch {
        return { installed: false, signedIn: false };
      }
      // An API key in the environment counts too; `auth status` reports that as logged in.
      const signedIn = await run(exe!, [...args, 'auth', 'status', '--json']).then(parseAuthStatus, () => false);
      return { installed: true, signedIn, version };
    },

    launch: (launch) => buildClaudeArgs(command(), opts.settingsPath, launch),

    install: claudeInstallArgs,

    signIn: () => [...command(), 'auth', 'login'],

    hooks: {
      cwd: (payload) => (payload as HookPayload | null)?.cwd,
      reduce: (prev, payload) => reduceHook(prev, payload as HookPayload),
    },

    parsePrompt: parseVisiblePrompt,

    transcript: { find: findTranscript, parse: parseTranscriptLine, title: readTitle },
  };
}
