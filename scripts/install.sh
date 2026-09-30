#!/usr/bin/env bash
# Install remote-ai on Linux or WSL2: check requirements, build, and run it as a systemd user
# service that starts at boot and survives logouts.
#
#   scripts/install.sh                  install and start the service on port 8787
#   scripts/install.sh --tailscale      also serve it on your tailnet over https (tailscale serve)
#   scripts/install.sh --wsl-autostart  WSL only: keep WSL running and start it when you log in to Windows
#   scripts/install.sh --uninstall      stop and remove the service (sessions and data are kept)
#
# Other options: --port N, --name NAME (service name), --no-service, --env KEY=VALUE (repeatable).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8787
NAME=remote-ai
SERVICE=1
WSL_AUTOSTART=0
TAILSCALE=0
UNINSTALL=0
EXTRA_ENV=()
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    --env) EXTRA_ENV+=("$2"); shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    --wsl-autostart) WSL_AUTOSTART=1; shift ;;
    --tailscale) TAILSCALE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || fail "remote-ai runs on Linux, or WSL2 on Windows."
IS_WSL=0
grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null && IS_WSL=1
UNIT="$HOME/.config/systemd/user/$NAME.service"
has_systemd() { systemctl --user show-environment >/dev/null 2>&1; }

win_path() { # a Windows environment variable as a WSL path
  # </dev/null: cmd.exe reads stdin, which would swallow the rest of a script piped into bash.
  wslpath "$(cmd.exe /c "echo %$1%" < /dev/null 2> /dev/null | tr -d '\r')"
}
STARTUP_SCRIPT=""
[ "$IS_WSL" = 1 ] && STARTUP_SCRIPT="$(win_path APPDATA)/Microsoft/Windows/Start Menu/Programs/Startup/remote-ai-wsl.vbs"

if [ "$UNINSTALL" = 1 ]; then
  if has_systemd && [ -f "$UNIT" ]; then
    systemctl --user disable --now "$NAME.service" || true
    rm -f "$UNIT"
    systemctl --user daemon-reload
    ok "Removed the $NAME service. Running Claude sessions keep going in tmux (tmux -L remote-ai ls)."
  else
    warn "No $NAME service to remove."
  fi
  if [ -n "$STARTUP_SCRIPT" ] && [ -f "$STARTUP_SCRIPT" ]; then
    rm -f "$STARTUP_SCRIPT"
    ok "Removed the Windows startup entry. (instanceIdleTimeout in .wslconfig is left as is.)"
  fi
  exit 0
fi

say "Checking requirements"
missing=()
need() { command -v "$1" >/dev/null 2>&1 || missing+=("$2"); }
need node nodejs
need npm npm
need tmux tmux
need git git
need curl curl
need make build-essential
need g++ build-essential
need python3 python3
if [ ${#missing[@]} -gt 0 ]; then
  pkgs=$(printf '%s\n' "${missing[@]}" | sort -u | tr '\n' ' ')
  fail "Missing: ${pkgs}— on Ubuntu or Debian: sudo apt install ${pkgs}"
fi
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "Node.js 22 or newer is required (found $(node -v))."
tmux_version=$(tmux -V | grep -oE '[0-9]+\.[0-9]+' | head -1)
awk "BEGIN { exit !($tmux_version >= 3.2) }" || fail "tmux 3.2 or newer is required (found $tmux_version)."
if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
  ok "Node $(node -v), tmux $tmux_version, Claude Code found"
else
  warn "Claude Code isn't installed yet: curl -fsSL https://claude.ai/install.sh | bash"
fi

say "Installing dependencies and building"
cd "$ROOT"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent > /dev/null
mkdir -p "$HOME/projects"
ok "Built in $ROOT"

if [ "$SERVICE" = 1 ]; then
  say "Setting up the $NAME service"
  if ! has_systemd; then
    warn "systemd isn't running for your user, so there's no service. Start it by hand: cd $ROOT && npm start"
    [ "$IS_WSL" = 1 ] && warn "In WSL, turn systemd on: add '[boot]' and 'systemd=true' to /etc/wsl.conf, then run 'wsl --shutdown' in Windows."
  else
    listener=$(ss -ltnpH "sport = :$PORT" 2>/dev/null | head -1)
    if [ -n "$listener" ] && ! systemctl --user is-active --quiet "$NAME.service"; then
      fail "Port $PORT is already in use (${listener##* }). If that's 'npm start' in a terminal, stop it with Ctrl-C and run this again."
    fi
    mkdir -p "$(dirname "$UNIT")"
    {
      echo "[Unit]"
      echo "Description=remote-ai dashboard ($NAME)"
      echo "After=network-online.target"
      echo
      echo "[Service]"
      echo "WorkingDirectory=$ROOT"
      echo "ExecStart=$(command -v node) dist/server/src/index.js"
      echo "Environment=REMOTE_AI_PORT=$PORT"
      echo "Environment=PATH=$HOME/.local/bin:$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin"
      for kv in "${EXTRA_ENV[@]}"; do echo "Environment=$kv"; done
      echo "Restart=always"
      echo "RestartSec=2"
      echo "# Stop only the dashboard: the tmux server it started, with every Claude session, keeps running."
      echo "KillMode=process"
      echo
      echo "[Install]"
      echo "WantedBy=default.target"
    } > "$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable "$NAME.service" --quiet
    systemctl --user restart "$NAME.service"
    # Lingering starts user services at boot, without anyone logged in.
    loginctl enable-linger "$USER" 2>/dev/null || warn "Couldn't turn on lingering; the service runs only while you're logged in."
    for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && break; sleep 1; done
    if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null; then
      ok "Running at http://127.0.0.1:$PORT (logs: journalctl --user -u $NAME -f)"
    else
      fail "The service didn't start. See: journalctl --user -u $NAME -n 50"
    fi
  fi
fi

if [ "$IS_WSL" = 1 ]; then
  if [ "$WSL_AUTOSTART" = 1 ]; then
    say "Keeping WSL running for the service"
    wslconfig="$(win_path USERPROFILE)/.wslconfig"
    # WSL stops a distro 15 s after its last terminal closes; -1 keeps it (and the service) up.
    python3 - "$wslconfig" <<'PY'
import re, sys
path = sys.argv[1]
try:
    lines = open(path, encoding='utf-8-sig').read().splitlines()
except FileNotFoundError:
    lines = []
setting = 'instanceIdleTimeout=-1'
out, in_general, done = [], False, False
for line in lines:
    s = line.strip()
    if s.startswith('['):
        if in_general and not done:
            out.append(setting); done = True
        in_general = s.lower() == '[general]'
    elif in_general and re.match(r'(?i)instanceIdleTimeout\s*=', s):
        if not done:
            out.append(setting); done = True
        continue
    out.append(line)
if in_general and not done:
    out.append(setting); done = True
if not done:
    out += ['', '[general]', '# Keep WSL running with no terminal open, so remote-ai stays up.', setting]
open(path, 'w', encoding='utf-8', newline='\r\n').write('\n'.join(out).lstrip('\n') + '\n')
PY
    ok "Set instanceIdleTimeout=-1 in $wslconfig"
    # Starts this distro (and so systemd and the service) when you log in to Windows, without a window.
    printf 'CreateObject("WScript.Shell").Run "wsl.exe -d %s --exec /bin/true", 0, False\r\n' "$WSL_DISTRO_NAME" > "$STARTUP_SCRIPT"
    ok "WSL will start when you log in to Windows ($STARTUP_SCRIPT)"
    warn "Takes effect after WSL restarts: run 'wsl --shutdown' in Windows, then open Ubuntu once."
  else
    warn "WSL shuts down when no terminal is open, which stops the service. Rerun with --wsl-autostart to keep it running."
  fi
fi

say "Reaching it from your phone"
ts=""
command -v tailscale > /dev/null 2>&1 && ts=tailscale
[ -z "$ts" ] && [ "$IS_WSL" = 1 ] && [ -x "/mnt/c/Program Files/Tailscale/tailscale.exe" ] && ts="/mnt/c/Program Files/Tailscale/tailscale.exe"
if [ -n "$ts" ] && [ "$TAILSCALE" = 1 ]; then
  "$ts" serve --bg "$PORT"
  ok "Serving on your tailnet over https; the URL is above."
elif [ -n "$ts" ]; then
  echo "  Run: $ts serve --bg $PORT"
  echo "  Then open https://<this machine>.<your tailnet>.ts.net on your phone (with Tailscale installed there)."
else
  where="this machine"
  [ "$IS_WSL" = 1 ] && where="Windows"
  echo "  1. Install Tailscale on $where and on your phone, signed in to the same account: https://tailscale.com/download"
  echo "  2. Turn on HTTPS certificates: https://login.tailscale.com/admin/dns"
  echo "  3. Run: tailscale serve --bg $PORT   (then rerun this script with --tailscale, or just open the URL it prints)"
fi
