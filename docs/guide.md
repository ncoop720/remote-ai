# Using remote-ai

remote-ai runs Claude Code on your computer and lets you drive it from the computer or from your phone. Each piece of work gets its own **session**: a git branch checked out in its own folder (a worktree), with Claude working there. You can run several at once, see which ones need you, answer Claude's questions with a tap, and preview the app being built.

This guide covers the desktop app. For running remote-ai as a server on a headless Linux machine, see the [README](../README.md#server-install-linux).

- [Install](#install)
- [First run](#first-run)
- [Sessions](#sessions)
- [Working with Claude in a session](#working-with-claude-in-a-session)
- [Dev servers, logs and preview](#dev-servers-logs-and-preview)
- [Your phone](#your-phone)
- [The app in the background](#the-app-in-the-background)
- [Settings and files](#settings-and-files)
- [Troubleshooting](#troubleshooting)

## Install

Download the installer for your computer from the [releases page](https://github.com/ncoop720/remote-ai/releases).

| System | File | Notes |
|---|---|---|
| macOS | `.dmg` | Drag remote-ai to Applications. |
| Windows | `.exe` | Installs for your user only; no admin rights needed. |
| Linux | `.AppImage` or `.deb` | Make the AppImage executable (`chmod +x`) and run it. |

The builds aren't code-signed yet, so the first time you open remote-ai:

- **macOS** says it can't check the app. Open **System Settings → Privacy & Security** and choose **Open Anyway** (or right-click the app and choose **Open**).
- **Windows** SmartScreen says it protected your PC. Choose **More info → Run anyway**.

## First run

remote-ai opens a checklist the first time. It comes back by itself until the computer is ready (or until you choose **Skip for now**), and you can always reach it from **Projects & setup** at the bottom of the sidebar.

1. **Git.** remote-ai uses git worktrees, so git must be installed. If it isn't, the checklist says how to get it for your system.
2. **Claude Code.** If it isn't installed, **Install Claude Code** runs Anthropic's official installer in a terminal on the page. Then **Sign in** runs `claude auth login`, which opens a browser to sign in to your Claude account. remote-ai never sees your credentials; Claude Code keeps them as usual. (Claude Code also works with an `ANTHROPIC_API_KEY` set in your environment.)
3. **Projects.** Add the git repositories you work on: **Choose a folder…** opens a folder picker, or type a path. Pick the repository's main checkout. Projects are only listed in remote-ai; removing one never touches its files.
4. **Connect your phone** (optional). See [Your phone](#your-phone).

remote-ai also turns on **Open at login**, so it's there whenever the computer is on. You can turn that off in the tray menu.

## Sessions

The sidebar (or, on a phone, the home screen) lists your projects and their sessions. Each session's dot shows its state:

| State | Meaning |
|---|---|
| **Needs you** | Claude is asking for permission or asking a question. |
| **Working** | Claude is working on your request. |
| **Idle** | Claude finished its turn and is waiting for you. |
| **Running** | Claude is starting up and hasn't reported yet. |
| **Claude exited** | Claude's own session ended. |
| **Stopped** | Nothing is running in this worktree. |

Next to each branch is the title Claude gave its latest conversation, so you can tell sessions apart. On a phone, sessions are grouped by state (Needs you, Working, Idle, Not running), and the chips at the top filter by project. When sessions need you, the browser tab's title counts them: "(2) remote-ai".

### Start a session

Choose **New** (or **+** next to a project) and fill in:

- **Project**: which repository. **+ Clone a repo** clones one from an `https://` or `git@host:owner/repo` URL into `~/projects` and adds it. Cloning never asks for a password, so for private repositories set up git credentials (an SSH key, or a credential helper) on the computer first.
- **New branch**: the branch to work on, such as `feat/dark-mode`. If it doesn't exist, it's created from **From** (the repository's main branch unless you say otherwise). If it does exist, that branch is used.
- **First prompt** (optional): what Claude should start on.
- **Permissions**: how much Claude may do without asking.
  - **Auto**: a classifier approves safe actions and asks about the rest.
  - **Ask**: Claude asks before every action.
  - **Edits**: Claude edits files without asking, and asks about everything else.
  - **Plan**: Claude only plans and doesn't change anything.

remote-ai creates the worktree in `~/worktrees/<project>/<branch>`, copies files listed in the repository's `.worktreeinclude` (such as `.env` files), runs the project's setup if it has one, and starts Claude there. The main checkout is a session too, for working directly on it.

### End, resume and remove

- **End session** (**End** on a phone) stops Claude, the dev servers and any setup in that session. The worktree and its changes stay.
- An ended session offers **New conversation** or **Resume last conversation** (Claude's own `--continue`), with a choice of permissions.
- **Remove worktree** stops the session and deletes its folder. The branch itself is kept, so nothing committed is lost. If the worktree has uncommitted changes, remove asks first; **Discard changes and remove** deletes them.

Sessions don't depend on the window or the app being open: they run in a background process (the session host) that keeps going when you close the window, quit the app or update it.

## Working with Claude in a session

A session has these views. On a computer, the left side switches between **Terminal** and **Chat**, and **Preview & logs** opens a column on the right. On a phone they're tabs: **Chat**, **Terminal**, **Logs** and **Preview**.

- **Terminal** is Claude Code itself, live. Type into it as you would in your own terminal; **Shift+Enter** (or **Ctrl+Enter**) starts a new line. Any number of browsers can watch the same session.
- **Chat** shows the conversation as messages: your prompts, Claude's replies, and each tool Claude used as a row you can tap to see what it ran and what came back. Type at the bottom to send a message. While Claude is working, **Interrupt** stops its current turn (like pressing Esc) without ending the session.
- **Questions and approvals.** When Claude shows a menu (permission to run a command, a question, the folder-trust check on a new worktree), it appears as buttons under the conversation in **Chat**. Tap one to answer. In **Terminal**, answer in the terminal itself.
- **Phone keys.** The Terminal tab on a phone has a key bar for keys phones lack: **Esc**, **^C**, **⇧Tab** (switches Claude's mode), **Tab**, **↑**, **↓**, **←**, **→** and **⏎**.

### Review changes

Once a session has changed files, its header shows a **Changes** button with the line count (**+12 −3**), or the number of new files. It opens everything the branch changed since it started, committed or not, new files included, as a diff per file. Use it to check Claude's work from your phone before you merge.

## Dev servers, logs and preview

remote-ai can run each session's development servers, show their output, and show the pages they serve, on the computer and on your phone.

### Which servers

If the repository has a `.remote-ai.json`, that says what to run. Otherwise remote-ai guesses from its files, and the Logs panel says what it found ("Detected: Vite with pnpm"). It recognizes:

- a `Procfile.dev`;
- Node apps (npm, pnpm, yarn or bun), including apps in separate `server/` and `client/` folders and workspace monorepos;
- Django, FastAPI and Flask (through uv, Poetry or Pipenv when the project uses one);
- Rails, Go and Rust;
- and as a last resort a `Procfile` or Docker Compose.

**Set up with Claude** (in the Logs panel) asks the session's Claude to read the repository and write a proper `.remote-ai.json`, correcting the guess. If Claude isn't running, it starts with that request. Answer any question Claude is showing first.

You can also write the file yourself, at the root of the repository (committed, or left uncommitted in the main checkout so it applies to every branch):

```json
{
  "setup": ["cd server && npm ci", "cd client && npm ci"],
  "servers": [
    { "name": "server", "cwd": "server", "command": "npm start" },
    { "name": "client", "cwd": "client", "command": "npm run dev -- --port $PORT" }
  ]
}
```

- **setup** runs once in every new worktree, each command from the worktree root, typically to install dependencies. Run it again from the setup chip in the Logs panel.
- **servers** each run in their own terminal. Server names are lowercase letters, digits and dashes.
- Each session gets its own block of ports (3100–3109 for the first, 3110–3119 for the next, and so on), so several branches can run at once. A server gets its port in `$PORT`, and every command gets `$PORT_<NAME>` for every server (`$PORT_SERVER`, `$PORT_CLIENT`), so a frontend can find its backend. These work on every system, Windows included.
- List backends before frontends; servers start in that order.

### Running them

In the Logs panel, pick a server and use **Start**, **Stop** or **Restart**, or **Start all**. Output streams live, and the **All lines** button switches to **Errors only**. Tap lines to select them, then **Send to Claude** pastes them into Claude's prompt so you can ask about them.

Claude is told which servers run where and where their logs are, so it reads the logs instead of starting its own copies, and restarts a server when it needs to.

### Preview

The Preview panel shows the pages a session's servers serve: any port a process in that worktree listens on, or that the session started. Pick the port, type a path, and use **Open ↗** to open the page in its own tab. On a computer, the **Full** button switches to **Phone** width. **Stop** (■ on a phone) ends whatever listens on that port: a server from the Logs panel stops as it would there, and anything else, such as a server Claude started in the background, ends along with whatever it started.

On your phone, previews come through remote-ai's own address, so they work even when the dev server only listens on the computer itself (you don't need Vite's `--host`), and hot reload works. Your phone has to be paired, and only the sessions' own ports are shown.

## Your phone

### Connect

Open **Connect a phone** (in the tray menu, at the bottom of the sidebar, or in the checklist). Choose how the phone reaches the computer, then scan the QR code with the phone's camera. The code works once, for ten minutes; you can also type it on the phone instead.

**Anywhere, with Tailscale (recommended).** remote-ai joins your Tailscale network as its own device, so the Tailscale app isn't needed on the computer.

1. Turn on **Anywhere, with Tailscale** and choose **Sign in to Tailscale**. Sign in in the browser (a free personal account is enough).
2. On your phone, install the Tailscale app and sign in to the same account.
3. Scan the QR code. Phones signed in to Tailscale as you get in without the code; other people's devices on the same Tailscale network need one.

The dashboard is then at `https://remote-ai-<computer>.<your-tailnet>.ts.net`, from anywhere, over HTTPS. That's what notifications and installing the app need. If the page says HTTPS is off, turn on **MagicDNS** and **HTTPS Certificates** in the [DNS settings](https://login.tailscale.com/admin/dns) of the Tailscale admin console, then switch Tailscale off and on in remote-ai.

**On this Wi-Fi.** Turn on **On this Wi-Fi** to let phones on the same network connect at `http://<computer>:8788`. It's plain http, so only use it on networks you trust (others on the network could read the traffic), and phones can't get notifications over it. Your computer's firewall may ask whether to allow remote-ai on the network; allow it on private networks.

### Add it to your Home Screen

After pairing, the page suggests adding remote-ai to the Home Screen so it opens like an app:

- **iPhone:** in Safari, tap **Share**, then **Add to Home Screen**. Open it from the Home Screen; it signs itself in.
- **Android:** in Chrome, open the menu and choose **Add to Home screen** (or **Install app**).

### Notifications

On your phone, tap the bell at the top of the session list to turn on notifications for that device. You'll hear when a session needs you and when Claude finishes a turn. Notifications need the Tailscale (https) address; on iPhone they also need the Home Screen app (iOS 16.4 or later), so turn them on from there.

On the computer, the desktop app shows its own notifications when its window isn't in front.

### Paired devices

**Connect a phone** lists every paired device with when it was last used. **Remove** signs a device out for good; it needs a new code to come back. Only the computer itself can turn Wi-Fi or Tailscale access on and off.

## The app in the background

remote-ai lives in the tray (the menu bar on macOS). Closing the window keeps it running. The tray menu has:

- **Open remote-ai**, and a line saying how many sessions run and how many need you;
- **Connect a phone…**;
- **Open at login**;
- updates: **Check for updates**, download progress, or **Restart to update**;
- **Quit (sessions keep running)**: the window and the dashboard close, but Claude and the dev servers keep working, and the next start picks them up;
- **Stop all sessions and quit…**: ends everything first.

### Updates

remote-ai checks for a new version when it starts and every few hours, and downloads it in the background. When it's ready, the tray and the bottom of the sidebar say **Restart to update**; otherwise the update installs the next time you quit. **Check for updates** checks right away. Your sessions keep running through the update, and your projects, paired devices and settings stay.

Two installs can't update themselves: on macOS, because the app isn't signed yet, and on Linux, the `.deb`. For those, download the new installer from the [releases page](https://github.com/ncoop720/remote-ai/releases) and install it over the old one.

## Settings and files

remote-ai keeps its files in `~/.remote-ai` (in your home folder on every system):

| File | What it is |
|---|---|
| `config.json` | Settings (below). Create it if you need it. |
| `state.json` | Your projects, each worktree's ports, and which branch it came from. |
| `devices.json`, `remote.json` | Paired devices, and whether Wi-Fi and Tailscale access are on. |
| `logs/<session>/<server>.log` | Dev-server and setup output. |
| `server.log`, `host.log` | The app's and the session host's own logs, for troubleshooting. |
| `tailscale/` | This computer's identity on your tailnet. |

Settings in `config.json`, all optional (restart remote-ai after changing them):

```json
{
  "port": 8787,
  "wifiPort": 8788,
  "worktreesDir": "~/worktrees",
  "portBase": 3100,
  "claudeCommand": "claude"
}
```

| Setting | Default | |
|---|---|---|
| `port` | `8787` | The dashboard, on the computer only. Change it if another program uses 8787. |
| `wifiPort` | port + 1 | Where phones connect on Wi-Fi. |
| `worktreesDir` | `~/worktrees` | Where new worktrees go. |
| `portBase` | `3100` | The first dev-server port; each session gets the next block of 10. |
| `claudeCommand` | `claude` | How to start Claude Code, if it isn't `claude` on your PATH. |

### Uninstall

Choose **Stop all sessions and quit…** in the tray, then uninstall the app as usual for your system (on macOS, move it to the Trash; on Windows, **Settings → Apps**). To remove its data too, delete `~/.remote-ai`. Your repositories and worktrees are left as they are.

## Troubleshooting

**"Port 8787 is already in use."** Another copy of remote-ai (perhaps the server version) or another program is using it. Quit the other one, or set `"port"` in `~/.remote-ai/config.json`.

**Claude Code isn't found after installing it.** remote-ai looks on your PATH and in `~/.local/bin`, where the official installer puts it. If you installed it elsewhere, set `"claudeCommand"` to its full path.

**A session's dev server starts but nothing shows in Preview.** The port appears once the server listens. It must run inside the session's worktree or be started by the session (by remote-ai or by Claude). Check the server's output in the Logs panel for the port it actually chose; servers should use `$PORT`.

**The phone can't connect over Wi-Fi.** Make sure the phone is on the same network, not a guest network (those often keep devices apart), and that the computer's firewall allows remote-ai. Tailscale avoids both problems.

**"This device isn't connected."** The phone isn't paired, or was removed. Open **Connect a phone** on the computer and scan a new code.

**Tailscale says HTTPS is off.** Turn on MagicDNS and HTTPS Certificates in the Tailscale admin console's [DNS settings](https://login.tailscale.com/admin/dns), then switch Tailscale off and on in remote-ai.

**The Linux AppImage doesn't start.** Some distributions (Ubuntu 24.04 and later) restrict the sandbox Electron apps use. Start it with `--no-sandbox`, or install the `.deb` instead.

**Something else.** `~/.remote-ai/server.log` and `~/.remote-ai/host.log` say what went wrong. Please include them when [reporting a problem](https://github.com/ncoop720/remote-ai/issues).
