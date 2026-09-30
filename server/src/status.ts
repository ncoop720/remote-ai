import { EventEmitter } from 'node:events';
import type { SessionStatus } from '../../shared/types.js';

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

export const INITIAL_STATUS: SessionStatus = { state: 'unknown', updatedAt: 0 };

/** Pure transition from one hook event to the next status. */
export function reduceHook(prev: SessionStatus, p: HookPayload, now = Date.now()): SessionStatus {
  const base: SessionStatus = {
    ...prev,
    claudeSessionId: p.session_id ?? prev.claudeSessionId,
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
        tool: p.tool_name ? { name: p.tool_name, input: truncateDeep(p.tool_input) } : undefined,
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

/** In-memory status per session id. Emits `change` with (sessionId, status). */
export class StatusStore extends EventEmitter {
  private readonly statuses = new Map<string, SessionStatus>();

  get(sessionId: string): SessionStatus {
    return this.statuses.get(sessionId) ?? INITIAL_STATUS;
  }

  apply(sessionId: string, payload: HookPayload): void {
    const prev = this.get(sessionId);
    const next = reduceHook(prev, payload);
    if (next === prev) return;
    this.statuses.set(sessionId, next);
    this.emit('change', sessionId, next);
  }

  reset(sessionId: string): void {
    this.statuses.delete(sessionId);
    this.emit('change', sessionId, INITIAL_STATUS);
  }
}
