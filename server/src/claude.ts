import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { shellQuote } from './exec.js';
import type { PermissionMode } from '../../shared/types.js';

/** Hook events forwarded to the dashboard. Each one just POSTs its JSON input and prints nothing. */
const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
] as const;

export const PERMISSION_MODES: readonly PermissionMode[] = ['auto', 'manual', 'acceptEdits', 'plan'];

/** The token lets /api/hook reject posts that didn't come from our generated hook command. */
export function loadHookToken(dataDir: string): string {
  const file = path.join(dataDir, 'hook-token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/**
 * Write the settings file passed to every session with `claude --settings`, so hooks apply
 * to dashboard sessions only and ~/.claude/settings.json is never touched.
 */
export function writeClaudeSettings(dataDir: string, port: number, token: string): string {
  const url = `http://127.0.0.1:${port}/api/hook`;
  const command =
    `curl -s -m 2 -X POST -H 'Content-Type: application/json' -H 'X-Remote-AI-Token: ${token}' ` +
    `--data-binary @- ${url} >/dev/null 2>&1 || true`;
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command, timeout: 5 }] }]]),
  );
  const file = path.join(dataDir, 'claude-settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  return file;
}

export function buildClaudeCommand(opts: {
  claudeCommand: string;
  settingsPath: string;
  permissionMode?: PermissionMode;
  resume?: boolean;
  prompt?: string;
}): string {
  const parts = [opts.claudeCommand, '--settings', shellQuote(opts.settingsPath)];
  // Always explicit when chosen: leaving it out falls back to the user's configured default, which may be auto.
  if (opts.permissionMode) parts.push('--permission-mode', opts.permissionMode);
  if (opts.resume) parts.push('--continue');
  if (opts.prompt?.trim()) parts.push(shellQuote(opts.prompt.trim()));
  return parts.join(' ');
}
