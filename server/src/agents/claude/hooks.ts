import fs from 'node:fs';
import path from 'node:path';
import type { SessionStatus } from '../../../../shared/types.js';
import { summarizeToolInput } from './transcript.js';

/** The subset of Claude Code hook input we use. Every event carries session_id, transcript_path and cwd. */
export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  notification_type?: string;
  message?: string;
  tool_name?: string;
  tool_input?: unknown;
  last_assistant_message?: string;
}

/** Hook events forwarded to the dashboard. */
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

/** Claude Code refuses HTTP hooks for these, so they POST with curl from a command hook instead. */
const COMMAND_ONLY = new Set<string>(['SessionStart']);

/**
 * Write the settings file passed to every session with `claude --settings`, so hooks apply to
 * dashboard sessions only and ~/.claude/settings.json is never touched. HTTP hooks post the event
 * straight to the dashboard and need no shell; the token lets it reject posts from anyone else.
 */
export function writeClaudeSettings(dataDir: string, port: number, token: string): string {
  const url = `http://127.0.0.1:${port}/api/hooks/claude`;
  const http = { type: 'http', url, headers: { 'X-Remote-AI-Token': token }, timeout: 5 };
  const command = {
    type: 'command',
    command:
      `curl -s -m 2 -X POST -H 'Content-Type: application/json' -H 'X-Remote-AI-Token: ${token}' ` +
      `--data-binary @- ${url} >/dev/null 2>&1 || true`,
    timeout: 5,
  };
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [event, [{ hooks: [COMMAND_ONLY.has(event) ? command : http] }]]),
  );
  const file = path.join(dataDir, 'claude-settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  return file;
}

const MAX_STRING = 2000;

/** Tool input can hold whole files (Write, Edit); keep only enough to show on an approval card. */
export function truncateDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length - MAX_STRING} more chars)` : value;
  }
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => truncateDeep(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateDeep(v, depth + 1)]));
}

/** Pure transition from one hook event to the next status. */
export function reduceHook(prev: SessionStatus, p: HookPayload, now = Date.now()): SessionStatus {
  const base: SessionStatus = {
    ...prev,
    agentSessionId: p.session_id ?? prev.agentSessionId,
    transcriptPath: p.transcript_path ?? prev.transcriptPath,
    updatedAt: now,
  };
  const clear = { tool: undefined, message: undefined };

  switch (p.hook_event_name) {
    case 'SessionStart':
      return { ...base, ...clear, state: 'idle' };
    case 'UserPromptSubmit':
      return { ...base, ...clear, state: 'working' };
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { ...base, ...clear, state: 'working' };
    case 'PermissionRequest':
      return {
        ...base,
        state: 'needs_input',
        message: p.tool_name ? `Claude wants to use ${p.tool_name}` : 'Claude needs permission',
        tool: p.tool_name
          ? { name: p.tool_name, input: truncateDeep(p.tool_input), summary: summarizeToolInput(p.tool_name, p.tool_input) }
          : undefined,
      };
    case 'Notification':
      switch (p.notification_type) {
        case 'permission_prompt':
        case 'elicitation_dialog':
        case 'elicitation_url_dialog':
        case 'agent_needs_input':
          // Keep the tool from a preceding PermissionRequest; it has the details.
          return { ...base, state: 'needs_input', message: p.message ?? base.message };
        case 'idle_prompt':
          return { ...base, ...clear, state: 'idle', message: p.message };
        default:
          return prev;
      }
    case 'Stop':
      return { ...base, ...clear, state: 'idle', lastMessage: p.last_assistant_message ?? prev.lastMessage };
    case 'StopFailure':
      return { ...base, ...clear, state: 'idle', message: 'The turn ended with an error' };
    case 'SessionEnd':
      return { ...base, ...clear, state: 'ended' };
    default:
      return prev;
  }
}
