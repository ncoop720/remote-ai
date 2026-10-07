# remote-ai

A dashboard for running Claude Code on your computer and driving it from a desktop browser or a phone. It comes as a desktop app for macOS, Windows and Linux, or as a server for a headless Linux machine.

- **Project** = a git repository you add (the server also picks up every repository in `~/projects`).
- **Session** = a branch checked out in its own git worktree, with Claude Code running there in a terminal the session host keeps alive.
- The browser shows the live terminal, surfaces permission prompts as buttons, and tracks each session's status (needs you / working / idle) through Claude Code hooks.

Everything runs on your machine. There is no relay and no dependency on Claude's Remote Control.

**[How to use it →](docs/guide.md)** Install, first run, sessions, dev servers and previews, connecting your phone, settings and troubleshooting.

## How it works

```
browser ──HTTP/WebSocket──► remote-ai server (Node, 127.0.0.1:8787)
                              │
                              ├─ git worktree add ~/worktrees/<project>/<branch>
                              └─ session host (a separate Node process; socket in ~/.remote-ai)
                                   ├─ terminal "agent":   claude --settings ~/.remote-ai/claude-settings.json
                                   │                        (hooks POST back to /api/hooks/claude)
                                   ├─ terminal "setup", "dev-<name>": the project's setup and dev servers
                                   └─ /ws/terminal/<id> ⇄ screen snapshot + live output (any number of viewers)
```

- The **session host** owns every terminal (node-pty, with a headless xterm per terminal that keeps the screen and scrollback). It runs apart from the dashboard server, so restarting or updating the server never touches your sessions. It starts by itself when the server first needs it, and logs to `~/.remote-ai/host.log`.
- Agents run behind an **adapter** (`server/src/agents/`). Claude Code is the only one so far; its launch flags, hooks, menus and transcript all live in `agents/claude/`.
- Hooks are passed with `claude --settings`, so your `~/.claude/settings.json` is never modified. They are HTTP hooks (SessionStart, which Claude Code only runs as a command, posts with curl).
- Each session gets a `PORT` environment variable (3100, 3110, …) for its dev server.

## Desktop app

Download the installer for your OS from the [releases](https://github.com/ncoop720/remote-ai/releases): a `.dmg` for macOS, an `.exe` for Windows, an `.AppImage` or `.deb` for Linux. On first start the app opens a checklist: it checks for git, installs Claude Code with Anthropic's official installer and runs its sign-in if needed, and asks for the repositories to add.

- The app lives in the tray (the menu bar on macOS) and starts at login; closing the window keeps it running. **Quit** leaves sessions running in the session host, and the next start picks them up again. **Stop all sessions and quit** ends them.
- Notifications come from the app itself, so the dashboard's bell (Web Push, for phones) is hidden in its window.
- **Connect a phone** (in the tray, the sidebar and the checklist) shows a QR code. Scanning it opens the dashboard on the phone and pairs it with a one-time code (valid once, for 10 minutes; it can be typed too). Paired devices are listed there and can be removed. Every request from another device needs a paired device; requests from the computer itself don't.
- Phones reach the computer in one of two ways, both off until you turn them on there:
  - **On this Wi-Fi**: a second listener on port 8788 (`"wifiPort"` in `config.json`). It is plain http, so use it on networks you trust; phones can't get notifications over it.
  - **Anywhere, with Tailscale**: the app joins your tailnet as its own device (built in with [tsnet](https://tailscale.com/kb/1244/tsnet), so the Tailscale app isn't needed on the computer) and serves the dashboard at `https://remote-ai-<computer>.<tailnet>.ts.net`. Sign the computer in once from the Connect page. Your own devices, signed in to Tailscale as you, get in without a code; other people's on the same tailnet need one. HTTPS (and so notifications and installing the app) needs MagicDNS and HTTPS Certificates turned on in the tailnet's [DNS settings](https://login.tailscale.com/admin/dns).
- On iPhone, add the page to the Home Screen after pairing (Share, then Add to Home Screen) and open it from there to turn on notifications. The Home Screen app signs itself in, even though iOS keeps its cookies apart from Safari's.
- Updates come from the GitHub releases: the app checks at start and every 6 hours, downloads a new version in the background, and offers **Restart to update** (or installs it on quit). The unsigned macOS build and the `.deb` can't replace themselves, so install a new version over the old one there. Sessions keep running through an update, because the session host runs from its own copy outside the app (`~/.remote-ai/host-runtime/`), which only changes when the host itself does.
- Data, logs and settings live in `~/.remote-ai`, as with the server. The window is served on `127.0.0.1:8787`; set `"port"` in `~/.remote-ai/config.json` to change it.
- The builds aren't code-signed yet, so macOS and Windows warn the first time you open the app.

To build it yourself: `npm run desktop:start` runs it from source (with its own data in `~/.remote-ai-desktop-dev`), and `npm run desktop:dist` makes installers for this OS in `dist/release`. Building the Tailscale part (`tailscale/`, in Go) uses `go` from your PATH, or downloads a Go release into `~/.cache/remote-ai-build`. To release, set `version` in `package.json` and push a matching tag (`v2.0.0`): GitHub Actions (`.github/workflows/desktop.yml`) builds all three and uploads them to a draft release, which you then publish on GitHub. Installed apps don't see a release until it's published.

## Server install (Linux)

### Requirements

A Linux machine (a VPS, or WSL2 on Windows) with:

- Node.js 22+
- git, curl
- Build tools for `node-pty`: `sudo apt install build-essential python3`
- Claude Code, logged in (`claude` then `/login`)

### Install

```bash
git clone https://github.com/ncoop720/remote-ai.git ~/code/remote-ai
~/code/remote-ai/scripts/install.sh
```

The script checks the requirements, builds, and installs a **systemd user service** (`remote-ai`) that starts at boot and restarts on failure. Stopping or restarting the service never touches your sessions: Claude runs in the session host, outside the service's main process (`KillMode=process`). Logs: `journalctl --user -u remote-ai -f`.

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

Set `REMOTE_AI_PASSWORD` (or `"password"` in `~/.remote-ai/config.json`) to require a login for requests that arrive through a proxy such as `tailscale serve` or from another machine. Or set `REMOTE_AI_REQUIRE_PAIRING=1` (`"requirePairing": true`) to require a paired device instead, as the desktop app does; pair devices from Connect a phone in a browser on the machine itself. Requests made on the machine itself are trusted, since anything that can make them can already run programs as you. Logins last 30 days.

Don't expose the dashboard to the public internet: anyone who can open it gets a shell on the machine.

## Dev servers, logs and preview

Describe a project's dev servers in `.remote-ai.json` at the repo root:

```json
{
  "setup": ["cd server && npm ci", "cd client && npm ci"],
  "servers": [
    { "name": "server", "cwd": "server", "command": "npm start" },
    { "name": "client", "cwd": "client", "command": "npm run dev -- --port $PORT --strictPort" }
  ]
}
```

- **setup** runs once in every new worktree (each command from the worktree root), in a `setup` terminal; its exit code says whether it worked. Rerun it from the Logs panel.
- **servers** each run in their own terminal (`dev-<name>`), through your shell (`cmd.exe` on Windows, where `$PORT`-style variables are filled in for you and a leading `NAME=value …` sets those variables, as it would in a POSIX shell). A server gets `$PORT`, and every command gets `$PORT_<NAME>` for all servers, so a frontend can find its backend. Ports come from the session's block (3100–3109 for the first worktree, 3110–3119 for the next, …).
- The file can be committed, or left uncommitted in the main checkout: worktrees without their own copy use the main checkout's.
- Without a config file, remote-ai guesses from the repo: a `Procfile.dev`; a Node app's `dev` script with its package manager (npm, pnpm, yarn or bun), including apps in `server/` and `client/`-style folders and workspace monorepos, passing `--port $PORT` to Vite, Astro and Angular, which ignore `$PORT`; Django, FastAPI or Flask (through uv, Poetry or Pipenv when the repo uses one); Rails; Go; Rust; and as a last resort a `Procfile` or `docker compose up`. The Logs panel says what it detected.
- **Set up with Claude** (in the Logs panel) asks the session's agent to read the repo and write `.remote-ai.json`, starting the agent if it isn't running. It gets the format, the `$PORT` rules and the guess above to correct, and is told not to start servers itself.

Output goes to `~/.remote-ai/logs/<session>/<name>.log` and streams to the Logs panel, where you can pick lines and paste them into Claude's prompt. Claude is told about the servers, their ports and log files (via `--append-system-prompt`), and how to restart them, so it reads the logs instead of starting its own copies.

The Preview panel shows the ports a session's processes listen on: those running inside its worktree, or started from its terminals (found with `ss` on Linux, `lsof` on macOS, `netstat` on Windows). On the computer itself it shows each port directly (`http://localhost:<port>`, which reaches servers listening on either 127.0.0.1 or ::1). Other devices see them through the address they reached remote-ai on, so dev servers that only listen on localhost work too, and nothing needs `--host`:

- **Tailscale**: each port is served on the same port of the tailnet device, over https (`https://remote-ai-<computer>.<tailnet>.ts.net:3100`), so previews show inside the https dashboard.
- **Wi-Fi**: port P is served on P + 10000 (`http://<computer>:13100` for 3100).

Either way the device must be paired, only ports that belong to a session are served, and the dev server sees requests as if from localhost (so Vite's and Next's host checks pass) without remote-ai's cookies; hot reload works. A server install reached through `tailscale serve` still embeds `http://<host>:<port>`, which browsers block inside https; use "Open ↗" there.

## Chat view and notifications

On a phone a session opens in **Chat**: your messages, Claude's replies (rendered Markdown), and its tool calls as compact rows you can tap to see input and output. It is read from Claude Code's own transcript (`~/.claude/projects/…`), so it always matches the terminal, which stays one tab away. On desktop, switch the left pane between Terminal and Chat.

The bell turns on **push notifications** for that device: one when a session needs you (a permission prompt or a question) and one when Claude finishes a turn. They use standard Web Push with keys the server generates (`~/.remote-ai/vapid.json`); payloads are end-to-end encrypted, so the browser's push service only relays ciphertext. Push needs a secure page, so open the dashboard over https (`tailscale serve`) or on localhost. On iPhone, add the page to the Home Screen first and turn notifications on from there.

## Updating

Use **Check for updates** at the bottom of the sidebar (or the session list on a phone). It pulls, reinstalls dependencies if they changed, rebuilds, and, when running as the service, restarts the server. Claude sessions and dev servers keep running in the session host, and open pages reconnect by themselves. By hand:

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
| `REMOTE_AI_DATA_DIR` | `~/.remote-ai` | State, logs, hook settings, the session host's socket |
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

The session host started by `npm run dev` runs from source and keeps running when the server restarts. After changing `server/src/host/`, stop your sessions and kill the host (its pid is in `~/.remote-ai/host.log`) so the next request starts the new one.

## Roadmap

- [x] Phase 1: projects and worktree sessions, live terminal, hook-driven status, approval buttons, phone key bar and composer
- [x] Phase 2: per-project dev servers and setup, streaming logs, port detection and page preview
- [x] Phase 3: phone chat view built from the session transcript, push notifications
- [x] Phase 4: install script (systemd service, Tailscale, WSL autostart), optional password, self-update

v2:

- [x] Session host and agent adapters: native terminals on macOS, Windows and Linux instead of tmux; Claude Code as the first adapter
- [x] Desktop app: installers, tray, start at login, updates, first-run checklist
- [x] Pairing: QR code for phones, then built-in Tailscale with https
- [x] Preview through the app's secure address
- [x] Dev-server detection, and Set up with Claude
