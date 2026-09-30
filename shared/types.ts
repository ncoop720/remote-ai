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

export interface DevServerInfo {
  name: string;
  /** Port the dashboard assigned; the command sees it as $PORT. Null until first started. */
  port: number | null;
  state: 'running' | 'stopped';
  command: string;
  cwd: string;
}

export type SetupState = 'none' | 'pending' | 'running' | 'done' | 'failed';

export interface DevInfo {
  /** Where the dev config came from: .remote-ai.json, a guess from package.json, or nowhere. */
  source: 'file' | 'default' | 'none';
  error?: string;
  setup: SetupState;
  servers: DevServerInfo[];
}

export interface ListeningPort {
  port: number;
  pid: number;
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
  dev: DevInfo;
  /** Ports that processes running inside this worktree are listening on. */
  ports: ListeningPort[];
  /** Tracked changes since the branch point (untracked files are counted in `dirty`). */
  changes: { files: number; additions: number; deletions: number };
  /** The title Claude gave its latest conversation here, if any. */
  title: string | null;
}

export type DevAction = 'start' | 'stop' | 'restart' | 'setup';

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked';
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  /** The file's part of `git diff`, including its header lines. */
  patch: string;
}

export interface DiffResult {
  /** Branch the worktree was compared with (null: the main checkout, compared with HEAD). */
  base: string | null;
  /** The commit compared against: the merge base with `base`, or HEAD. */
  against: string;
  files: DiffFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

/** One entry of the chat view, parsed from Claude Code's transcript. Results pair with tools by toolUseId. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string; time: string }
  | { kind: 'assistant'; id: string; text: string; time: string }
  | { kind: 'command'; id: string; text: string; time: string }
  | { kind: 'tool'; id: string; toolUseId: string; name: string; summary: string; time: string }
  | { kind: 'result'; id: string; toolUseId: string; ok: boolean; output: string };

export interface ProjectInfo {
  name: string;
  path: string;
  defaultBranch: string | null;
  sessions: SessionInfo[];
}

/** Values for `claude --permission-mode`. "manual" asks before every action (formerly "default"). */
export type PermissionMode = 'auto' | 'manual' | 'acceptEdits' | 'plan';

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
