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

## Install

```bash
git clone https://github.com/ncoop720/remote-ai.git ~/code/remote-ai
~/code/remote-ai/scripts/install.sh
```

The script checks the requirements, builds, and installs a **systemd user service** (`remote-ai`) that starts at boot and restarts on failure. Stopping or restarting the service never touches your sessions: Claude runs in tmux, outside the service (`KillMode=process`). Logs: `journalctl --user -u remote-ai -f`.

Options: `--tailscale` (serve it on your tailnet), `--wsl-autostart` (WSL only, see below), `--port N`, `--no-service` (just build; run `npm start` yourself), `--uninstall`.

Clone the repositories you want to work on into `~/projects`. Each one shows up as a project.

### On Windows (WSL2)

Run the same commands inside Ubuntu. WSL needs systemd (`[boot] systemd=true` in `/etc/wsl.conf`, the default on recent Ubuntu images) and, because it stops a distro shortly after its last terminal closes, `--wsl-autostart` keeps it running: it sets `instanceIdleTimeout=-1` in `%UserProfile%\.wslconfig` and adds a hidden Windows startup entry that boots the distro when you log in. With `networkingMode=mirrored` in `.wslconfig`, Ubuntu and Windows share `localhost`, so dev servers and databases on either side can reach each other. Mirrored networking only bridges IPv4 loopback: browsers fall back to it by themselves, but if a Windows tool stalls on `localhost`, use `127.0.0.1`.

### Reaching it from your phone

The server listens on localhost only. Use [Tailscale](https://tailscale.com) to reach it from your other devices without opening any ports: install it on the machine (on Windows for WSL) and on your phone, turn on HTTPS in the Tailscale admin console, then:

```bash
tailscale serve --bg 8787
# → https://<machine>.<tailnet>.ts.net
```

Https matters: it's what lets the phone install the dashboard as an app and receive push notifications.

### Password (optional)

Set `REMOTE_AI_PASSWORD` (or `"password"` in `~/.remote-ai/config.json`) to require a login for requests that arrive through a proxy such as `tailscale serve` or from another machine. Requests made on the machine itself are trusted, since anything that can make them can already run tmux and git. Logins last 30 days.

Don't expose the dashboard to the public internet: anyone who can open it gets a shell on the machine.

## Dev servers, logs and preview

Describe a project's dev servers in `.remote-ai.json` at the repo root:

```json
{
  "setup": ["npm ci --prefix server", "npm ci --prefix client"],
  "servers": [
    { "name": "server", "cwd": "server", "command": "npm start" },
    { "name": "client", "cwd": "client", "command": "npm run dev -- --port $PORT --strictPort" }
  ]
}
```

- **setup** runs once in every new worktree (each command from the worktree root), in a `setup` tmux window that closes itself when it succeeds. Rerun it from the Logs panel.
- **servers** each run in their own tmux window (`dev-<name>`). A server gets `$PORT`, and every command gets `$PORT_<NAME>` for all servers, so a frontend can find its backend. Ports come from the session's block (3100–3109 for the first worktree, 3110–3119 for the next, …).
- The file can be committed, or left uncommitted in the main checkout: worktrees without their own copy use the main checkout's.
- Without a config file, a repo whose `package.json` has a `dev` script gets `npm run dev` (and `npm ci` as setup).

Output goes to `~/.remote-ai/logs/<session>/<name>.log` and streams to the Logs panel, where you can pick lines and paste them into Claude's prompt. Claude is told about the servers, their ports and log files (via `--append-system-prompt`), and how to restart them, so it reads the logs instead of starting its own copies.

The Preview panel shows any port a process inside the worktree listens on, at `http://<the host you opened the dashboard on>:<port>`. Dev servers that only listen on localhost can be previewed from the machine itself; to preview them from your phone they need to listen on all interfaces (for Vite, `--host`). When the dashboard itself is served over https (e.g. `tailscale serve`), browsers won't embed http pages, so use "Open ↗".

## Chat view and notifications

On a phone a session opens in **Chat**: your messages, Claude's replies (rendered Markdown), and its tool calls as compact rows you can tap to see input and output. It is read from Claude Code's own transcript (`~/.claude/projects/…`), so it always matches the terminal, which stays one tab away. On desktop, switch the left pane between Terminal and Chat.

The bell turns on **push notifications** for that device: one when a session needs you (a permission prompt or a question) and one when Claude finishes a turn. They use standard Web Push with keys the server generates (`~/.remote-ai/vapid.json`); payloads are end-to-end encrypted, so the browser's push service only relays ciphertext. Push needs a secure page, so open the dashboard over https (`tailscale serve`) or on localhost. On iPhone, add the page to the Home Screen first and turn notifications on from there.

## Updating

Use **Check for updates** at the bottom of the sidebar (or the session list on a phone). It pulls, reinstalls dependencies if they changed, rebuilds, and, when running as the service, restarts the server. Claude sessions and dev servers keep running in tmux, and open pages reconnect by themselves. By hand:

```bash
cd ~/code/remote-ai && git pull && npm ci && npm run build && systemctl --user restart remote-ai
```

Web-only changes apply on the next page load, without a restart.

## Configuration

Set environment variables, or put the same keys (camelCase) in `~/.remote-ai/config.json`.

| Env var | Default | |
|---|---|---|
| `REMOTE_AI_PORT` | `8787` | HTTP port |
| `REMOTE_AI_HOST` | `localhost` | Bind address (localhost = 127.0.0.1 and ::1) |
| `REMOTE_AI_PROJECTS_DIR` | `~/projects` | Where project checkouts live |
| `REMOTE_AI_WORKTREES_DIR` | `~/worktrees` | Where new worktrees are created |
| `REMOTE_AI_DATA_DIR` | `~/.remote-ai` | State, generated tmux.conf, hook settings |
| `REMOTE_AI_TMUX_SOCKET` | `remote-ai` | Name of the dedicated tmux server |
| `REMOTE_AI_CLAUDE_COMMAND` | `claude` | Command used to start Claude Code |
| `REMOTE_AI_PORT_BASE` | `3100` | First dev-server port |
| `REMOTE_AI_PASSWORD` | (none) | Require a login for proxied and remote requests |
| `REMOTE_AI_PUSH_SUBJECT` | repo URL | Contact sent to push services (VAPID subject) |

With the service, set these in `~/.config/systemd/user/remote-ai.service` (`Environment=KEY=value`) or in `~/.remote-ai/config.json`, then `systemctl --user restart remote-ai`.

## Development

```bash
npm run dev        # server on :8787 (tsx watch) + Vite on :5173 with proxying
npm test           # unit tests (node:test)
npm run typecheck
```

The server needs Linux (tmux), so develop inside WSL2 or on the server itself.

## Roadmap

- [x] Phase 1: projects and worktree sessions, live terminal, hook-driven status, approval buttons, phone key bar and composer
- [x] Phase 2: per-project dev servers and setup, streaming logs, port detection and page preview
- [x] Phase 3: phone chat view built from the session transcript, push notifications
- [x] Phase 4: install script (systemd service, Tailscale, WSL autostart), optional password, self-update
