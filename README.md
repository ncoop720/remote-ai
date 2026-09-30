# remote-ai

A self-hosted web dashboard for running Claude Code on a remote machine and driving it from a desktop browser or a phone.

- **Project** = a git repository in `~/projects`.
- **Session** = a branch checked out in its own git worktree, with Claude Code running in a tmux session there.
- The browser shows the live terminal, surfaces permission prompts as buttons, and tracks each session's status (needs you / working / idle) through Claude Code hooks.

Everything runs on your machine. There is no relay and no dependency on Claude's Remote Control.

## How it works

```
browser ──HTTP/WebSocket──► remote-ai server (Node, 127.0.0.1:8787)
                              │
                              ├─ git worktree add ~/worktrees/<project>/<branch>
                              ├─ tmux -L remote-ai new-session <project>__<branch>
                              │    └─ window "claude": claude --settings ~/.remote-ai/claude-settings.json
                              │                                  (hooks POST back to /api/hook)
                              └─ /ws/terminal/<id> ⇄ node-pty ⇄ tmux attach (one viewer per browser)
```

- Sessions live on a **dedicated tmux server** (`tmux -L remote-ai`), so they never mix with your own tmux sessions. Attach from SSH with `tmux -L remote-ai attach -t <project>__<branch>`.
- Hooks are passed with `claude --settings`, so your `~/.claude/settings.json` is never modified.
- Each session gets a `PORT` environment variable (3100, 3110, …) for its dev server.

## Requirements

A Linux machine (a VPS, or WSL2 on Windows) with:

- Node.js 22+
- tmux 3.2+
- git, curl
- Build tools for `node-pty`: `sudo apt install build-essential python3`
- Claude Code, logged in (`claude` then `/login`)

## Install and run

```bash
git clone https://github.com/ncoop720/remote-ai.git
cd remote-ai
npm install
npm run build
npm start            # http://127.0.0.1:8787
```

Clone the repositories you want to work on into `~/projects`. Each one shows up as a project.

### Reaching it from your phone

The server listens on localhost only. Use [Tailscale](https://tailscale.com) to reach it from your other devices without opening any ports:

```bash
tailscale serve --bg 8787
# → https://<machine>.<tailnet>.ts.net
```

Don't expose the dashboard to the public internet: anyone who can open it gets a shell on the machine.

## Configuration

Set environment variables, or put the same keys (camelCase) in `~/.remote-ai/config.json`.

| Env var | Default | |
|---|---|---|
| `REMOTE_AI_PORT` | `8787` | HTTP port |
| `REMOTE_AI_HOST` | `127.0.0.1` | Bind address |
| `REMOTE_AI_PROJECTS_DIR` | `~/projects` | Where project checkouts live |
| `REMOTE_AI_WORKTREES_DIR` | `~/worktrees` | Where new worktrees are created |
| `REMOTE_AI_DATA_DIR` | `~/.remote-ai` | State, generated tmux.conf, hook settings |
| `REMOTE_AI_TMUX_SOCKET` | `remote-ai` | Name of the dedicated tmux server |
| `REMOTE_AI_CLAUDE_COMMAND` | `claude` | Command used to start Claude Code |
| `REMOTE_AI_PORT_BASE` | `3100` | First dev-server port |

## Development

```bash
npm run dev        # server on :8787 (tsx watch) + Vite on :5173 with proxying
npm test           # unit tests (node:test)
npm run typecheck
```

The server needs Linux (tmux), so develop inside WSL2 or on the server itself.

## Roadmap

- [x] Phase 1: projects and worktree sessions, live terminal, hook-driven status, approval buttons, phone key bar and composer
- [ ] Phase 2: dev server per session (`server` tmux window), streaming logs, port detection and page preview
- [ ] Phase 3: phone chat view built from the session transcript, push notifications
- [ ] Phase 4: setup script (Tailscale, systemd service), optional auth
