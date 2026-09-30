import type { SessionInfo, SessionState } from '../../shared/types';

export const STATE_LABEL: Record<SessionState, string> = {
  needs_input: 'Needs you',
  working: 'Working',
  idle: 'Idle',
  unknown: 'Running',
  ended: 'Claude exited',
  stopped: 'Stopped',
};

export type StatusGroup = 'needs' | 'working' | 'idle' | 'stopped';

export function groupOf(s: SessionInfo): StatusGroup {
  switch (s.status.state) {
    case 'needs_input':
      return 'needs';
    case 'working':
      return 'working';
    case 'stopped':
      return 'stopped';
    default:
      return 'idle';
  }
}

/** One line under the branch name: what Claude is doing or last said. */
export function subtitle(s: SessionInfo): string {
  const st = s.status;
  if (st.state === 'needs_input') return st.message ?? 'Waiting for your answer';
  if (st.state === 'working') return 'Working…';
  if (st.state === 'stopped') return s.isMain ? 'Main checkout' : 'Worktree, not running';
  if (st.lastMessage) return st.lastMessage.replace(/\s+/g, ' ');
  return STATE_LABEL[st.state];
}

/** A one-line summary of a tool call, for the approval card. */
export function describeTool(tool: { name: string; input: unknown } | undefined): string | null {
  if (!tool || typeof tool.input !== 'object' || tool.input === null) return null;
  const input = tool.input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    if (typeof input[key] === 'string') return input[key] as string;
  }
  return null;
}
