import type { AgentInfo, ChatItem, SessionStatus, VisiblePrompt } from '../../../shared/types.js';

export interface LaunchOptions {
  /** First message, sent as the agent starts. */
  prompt?: string;
  /** Continue the worktree's most recent conversation. */
  resume?: boolean;
  /** Agent-specific permission mode (for Claude: auto, manual, acceptEdits, plan). */
  mode?: string;
  /** Extra instructions, such as the dev servers the dashboard runs for this worktree. */
  systemPrompt?: string;
}

/**
 * Everything agent-specific lives behind this interface, so another coding agent (Codex CLI,
 * Gemini CLI, ...) can be added without touching the rest of the app. Each agent is its vendor's
 * own CLI running in a terminal the session host owns, so people keep their own plans.
 *
 * Agents get the basic tier (terminal, worktrees, dev servers, preview, diff) for free. The full
 * tier (chat view, approval buttons, exact status and push) comes from the optional parts:
 * `hooks`, `parsePrompt` and `transcript`.
 */
export interface AgentAdapter {
  /** "claude", "codex", "gemini", ... */
  id: string;
  /** Shown in the UI: "Claude Code". */
  name: string;
  detect(): Promise<Pick<AgentInfo, 'installed' | 'signedIn' | 'version'>>;
  /** The command line that starts the agent in a worktree. */
  launch(opts: LaunchOptions): string[];
  /** The repo file the agent reads its instructions from: CLAUDE.md, AGENTS.md, GEMINI.md. */
  instructionFile: string;
  /** Where working / needs-you / done comes from: the agent's hooks, or terminal activity. */
  status: 'hooks' | 'activity';
  /** Permission modes `launch` accepts, first is the default. */
  modes: readonly string[];
  /** The command line that runs the vendor's official installer on this platform. */
  install?(platform: NodeJS.Platform): string[];
  /** The command line that signs in to the agent's account. */
  signIn?(): string[];
  /** Events the agent posts to /api/hooks/<id>: where each one came from, and how it moves the status. */
  hooks?: {
    cwd(payload: unknown): string | undefined;
    reduce(prev: SessionStatus, payload: unknown): SessionStatus;
  };
  /** A menu the agent is showing (permission prompt, question), read from the visible screen. */
  parsePrompt?(screen: string): VisiblePrompt | null;
  /** The agent's own session log, read for the chat view. */
  transcript?: {
    find(cwd: string, reported: string | undefined): string | null;
    parse(line: string): ChatItem[];
  };
}
