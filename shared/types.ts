// Types shared by the server API and the web client. Type-only: nothing here exists at runtime.

export type SessionState =
  | 'stopped' // no tmux session running
  | 'unknown' // tmux is running but no hook has reported yet
  | 'idle' // Claude finished a turn and is waiting for a prompt
  | 'working' // Claude is processing a prompt or running tools
  | 'needs_input' // a permission prompt or question is waiting
  | 'ended'; // the Claude process exited (the shell in the window is still alive)

export interface ToolRequest {
  name: string;
  input: unknown;
}

export interface SessionStatus {
  state: SessionState;
  message?: string;
  tool?: ToolRequest;
  lastMessage?: string;
  claudeSessionId?: string;
  transcriptPath?: string;
  updatedAt: number;
}

export interface TmuxWindow {
  index: number;
  name: string;
  command: string;
}

export interface SessionInfo {
  /** Stable id, also the tmux session name: `<project>__<branch>`. */
  id: string;
  project: string;
  branch: string | null;
  path: string;
  isMain: boolean;
  running: boolean;
  windows: TmuxWindow[];
  port: number | null;
  dirty: number;
  ahead: number | null;
  base: string | null;
  status: SessionStatus;
}

export interface ProjectInfo {
  name: string;
  path: string;
  defaultBranch: string | null;
  sessions: SessionInfo[];
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan';

export interface CreateSessionRequest {
  branch: string;
  base?: string;
  prompt?: string;
  permissionMode?: PermissionMode;
}

export interface StartSessionRequest {
  resume?: boolean;
  permissionMode?: PermissionMode;
}

export interface PromptOption {
  key: string;
  label: string;
  selected: boolean;
}

export interface VisiblePrompt {
  question: string;
  options: PromptOption[];
}

export type ServerEvent =
  | { type: 'status'; sessionId: string; status: SessionStatus }
  | { type: 'sessions' };
