// Types shared by the server API and the web client. Type-only: nothing here exists at runtime.

export type SessionState =
  | 'stopped' // the agent isn't running
  | 'unknown' // the agent is running but hasn't reported yet
  | 'idle' // the agent finished a turn and is waiting for a prompt
  | 'working' // the agent is processing a prompt or running tools
  | 'needs_input' // a permission prompt or question is waiting
  | 'ended'; // the agent's own session ended (its process is exiting)

export interface ToolRequest {
  name: string;
  input: unknown;
  /** One line about the call (the command, the file), written by the agent's adapter. */
  summary?: string;
}

export interface SessionStatus {
  state: SessionState;
  message?: string;
  tool?: ToolRequest;
  lastMessage?: string;
  /** The agent's own id for the conversation (Claude's session_id). */
  agentSessionId?: string;
  transcriptPath?: string;
  updatedAt: number;
}

/** A terminal the session host runs for a session: the agent, setup, or a dev server. */
export interface TerminalInfo {
  name: string;
  alive: boolean;
  exitCode: number | null;
  startedAt: number;
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
  /** Stable id, `<project>__<branch>`; names the session's terminals in the host. */
  id: string;
  /** The agent adapter this session runs ("claude"). */
  agent: string;
  project: string;
  branch: string | null;
  path: string;
  isMain: boolean;
  /** The agent's terminal is running. */
  running: boolean;
  terminals: TerminalInfo[];
  port: number | null;
  dirty: number;
  ahead: number | null;
  base: string | null;
  status: SessionStatus;
  dev: DevInfo;
  /** Ports that processes running inside this worktree are listening on. */
  ports: ListeningPort[];
}

export type DevAction = 'start' | 'stop' | 'restart' | 'setup';

/** One entry of the chat view, parsed from Claude Code's transcript. Results pair with tools by toolUseId. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string; time: string }
  | { kind: 'assistant'; id: string; text: string; time: string }
  | { kind: 'command'; id: string; text: string; time: string }
  | { kind: 'tool'; id: string; toolUseId: string; name: string; summary: string; time: string }
  | { kind: 'result'; id: string; toolUseId: string; ok: boolean; output: string };

/** "added" by picking its folder, or found in the projects "folder" (`~/projects` on a server). */
export type ProjectSource = 'added' | 'folder';

export interface ProjectInfo {
  name: string;
  path: string;
  source: ProjectSource;
  defaultBranch: string | null;
  sessions: SessionInfo[];
}

/** Values for `claude --permission-mode`. "manual" asks before every action (formerly "default"). */
export type PermissionMode = 'auto' | 'manual' | 'acceptEdits' | 'plan';

/** A coding agent the app can run, and whether it is ready on this machine. */
export interface AgentInfo {
  id: string;
  name: string;
  installed: boolean;
  signedIn: boolean;
  version?: string;
  /** Permission modes it accepts, first is the default. */
  modes: string[];
}

/** What the first-run checklist needs to know about this computer. */
export interface SetupInfo {
  platform: string;
  git: { installed: boolean; version?: string };
  agents: AgentInfo[];
}

export interface CreateSessionRequest {
  branch: string;
  base?: string;
  prompt?: string;
  /** Agent adapter id; the default agent when left out. */
  agent?: string;
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

/** What the running install is and whether it can update: a git checkout, or the desktop app. */
export type VersionInfo =
  | {
      kind: 'git';
      commit: string;
      branch: string;
      /** Commits on the upstream branch not yet pulled; null if there is no upstream or fetch failed. */
      behind: number | null;
      dirty: boolean;
      /** Running under systemd, which restarts the server after an update that needs it. */
      managed: boolean;
    }
  | {
      kind: 'desktop';
      version: string;
      state: DesktopUpdateState;
      /** The newest version seen, once a check found one. */
      latest: string | null;
      /** Download progress, 0-100. */
      progress: number | null;
      error?: string;
    };

/** "unsupported" when the app wasn't installed from a release (running from source). */
export type DesktopUpdateState = 'unsupported' | 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'error';

export interface UpdateResult {
  ok: boolean;
  from: string;
  to: string;
  /** Server code changed, so the process must restart to use it (web changes apply on reload). */
  restartNeeded: boolean;
  /** The server (or app) is restarting itself now. */
  restarting: boolean;
  log: string[];
}

/** A phone or browser paired with this computer. */
export interface DeviceInfo {
  id: string;
  name: string;
  /** How it reached the computer when it paired. */
  via: 'wifi' | 'tailscale' | 'other';
  createdAt: number;
  lastSeenAt: number;
}

/** Built-in Tailscale: the dashboard on your tailnet, with HTTPS. */
export interface TailscaleInfo {
  /** This install includes it (the desktop app does). */
  available: boolean;
  enabled: boolean;
  state: 'off' | 'starting' | 'needs-login' | 'needs-approval' | 'running' | 'error';
  /** Where to sign this computer in, while state is needs-login. */
  loginUrl?: string;
  /** The dashboard's address on the tailnet, once running. */
  url?: string;
  /** The Tailscale account this computer is signed in as; that account's devices get in without pairing. */
  login?: string;
  /** False when the tailnet has MagicDNS or HTTPS certificates turned off (then no notifications). */
  https?: boolean;
  message?: string;
}

/** How phones and other computers can reach this one. */
export interface RemoteInfo {
  wifi: {
    enabled: boolean;
    port: number;
    /** http://<address>:<port> for each address on the local network. */
    urls: string[];
    error?: string;
  };
  tailscale: TailscaleInfo;
}

/** A one-time code for pairing a device, and the links (with QR codes) that carry it. */
export interface PairingCode {
  /** As shown: ABCD-EFGH. */
  code: string;
  expiresAt: number;
  links: { via: 'tailscale' | 'wifi'; url: string; qrSvg: string }[];
}

/** How this browser may use the dashboard, from GET /api/auth. */
export interface AuthInfo {
  /** This browser has to log in or pair first. */
  required: boolean;
  /** A password is set, so logging in with it works too. */
  password: boolean;
  /** Set when this browser is a paired device. */
  device: DeviceInfo | null;
  /** The browser runs on this computer (it may switch remote access on and off). */
  local: boolean;
}

/** What the desktop app's window adds to the page, as `window.remoteAI` (see desktop/preload.ts). */
export interface DesktopBridge {
  desktop: true;
  platform: string;
  /** The native folder picker; null when cancelled. */
  pickFolder(): Promise<string | null>;
}

export type ServerEvent =
  | { type: 'status'; sessionId: string; status: SessionStatus }
  | { type: 'sessions' }
  /** Remote access or the paired devices changed. */
  | { type: 'remote' };
