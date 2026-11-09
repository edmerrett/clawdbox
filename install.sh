#!/bin/bash
# clawdbox one-shot installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/edmerrett/clawdbox/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --mac XX:XX:XX:XX:XX:XX     # original Evo
#   ./install.sh                                                      # from a checkout
#
# Does everything: clone or update the checkout, install Node and Python deps, build,
# install the Claude Code hooks, install the daemon as a login agent, install the Clawdbar
# menu bar app, then wait for Clawd to appear on the panel. Re-running it updates an
# existing install. Options:
#
#   --dir PATH        where to keep the checkout (default ~/Tools/clawdbox, or the current checkout)
#   --mac XX:XX:…     original Timebox Evo over Bluetooth Classic (default is --ble, the newer Evo)
#   --no-auto-update  skip the six-hourly updater (on by default; it follows release tags)
#   --no-hooks        don't touch ~/.claude/settings.json
#   --no-launchd      don't install the login agent (you run the daemon yourself)
#   --no-menubar      skip the menu bar app
#   --brightness N    panel brightness 0-100 (default 100)
#
# The whole script is a function so a truncated download cannot run half of it.
main() {
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REPO_URL="https://github.com/edmerrett/clawdbox"
DIR=""; TRANSPORT=(--ble); HOOKS=1; LAUNCHD=1; MENUBAR=1; AUTOUPDATE=1; BRIGHTNESS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2;;
    --mac) TRANSPORT=(--mac "$2"); shift 2;;
    --ble) TRANSPORT=(--ble); shift;;
    --auto-update) AUTOUPDATE=1; shift;;
    --no-auto-update) AUTOUPDATE=0; shift;;
    --no-hooks) HOOKS=0; shift;;
    --no-launchd) LAUNCHD=0; shift;;
    --no-menubar) MENUBAR=0; shift;;
    --brightness) BRIGHTNESS="$2"; shift 2;;
    -h|--help) usage; return 0;;
    *) echo "unknown option: $1 (try --help)" >&2; return 2;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$2"; }

[ "$(uname -s)" = Darwin ] || die "this installer is for macOS; on Linux follow the README steps by hand"

# ---------- prerequisites ----------
step "checking prerequisites"
need git "git is missing: run 'xcode-select --install' and re-run"
need node "Node.js 20+ is missing: install from https://nodejs.org or 'brew install node'"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $(node -v) is too old; 20 or newer is required"
need npm "npm is missing"
if [ "${TRANSPORT[0]}" = "--ble" ]; then
  need python3 "python3 (3.10+) is missing: 'brew install python' or https://python.org"
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || die "python3 is $(python3 -V); 3.10 or newer is required"
fi
if [ "$MENUBAR" = 1 ] && ! xcrun -f swiftc >/dev/null 2>&1; then
  echo "swiftc not found: the menu bar app needs the Xcode command line tools ('xcode-select --install'). Skipping it for now."
  MENUBAR=0
fi
echo "node $(node -v), $(python3 -V 2>/dev/null || echo 'no python'), $(xcrun -f swiftc >/dev/null 2>&1 && echo swiftc ok || echo 'no swiftc')"

# ---------- checkout ----------
# The current directory is used only when it is a checkout of the official repository, so
# running the one-liner inside some other project (or a fork) cannot hijack the install.
if [ -z "$DIR" ]; then
  if [ -d .git ] && [ "$(git remote get-url origin 2>/dev/null)" = "$REPO_URL" ] || [ "$(git remote get-url origin 2>/dev/null)" = "$REPO_URL.git" ]; then
    DIR="$(pwd)"
  else
    DIR="$HOME/Tools/clawdbox"
  fi
fi
step "checkout at $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet --tags origin main
  if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no)" ]; then
    echo "local changes present; NOT updating the checkout (this also blocks 'clawdbox update'):"
    git -C "$DIR" status --porcelain --untracked-files=no | sed 's/^/    /'
  else
    git -C "$DIR" pull --ff-only --quiet origin main && echo "updated to $(git -C "$DIR" rev-parse --short HEAD)"
  fi
else
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet "$REPO_URL" "$DIR"
  echo "cloned $(git -C "$DIR" rev-parse --short HEAD)"
fi
cd "$DIR"
echo "installing commit $(git rev-parse --short HEAD) ($(git log -1 --format=%cd --date=short))"

# ---------- stop what we are about to replace ----------
if [ "$LAUNCHD" = 1 ]; then
  step "stopping the running daemon"
  launchctl bootout "gui/$(id -u)/com.clawdbox.daemon" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/com.clawdbox.update" 2>/dev/null || true
  pkill -f "$DIR/dist/cli.js daemon" 2>/dev/null || true
  pkill -f "$DIR/bridge/clawdbox_ble.py" 2>/dev/null || true
  sleep 1
fi

# ---------- build ----------
step "installing Node dependencies and building"
# --ignore-scripts: no dependency install scripts run from a curl|bash flow. The one native
# optional module (Bluetooth Classic, original Evo only) is rebuilt explicitly when needed.
npm ci --no-audit --no-fund --silent --ignore-scripts
if [ "${TRANSPORT[0]}" = "--mac" ]; then
  npm rebuild bluetooth-serial-port --silent || die "bluetooth-serial-port failed to build; install the Xcode command line tools and re-run"
fi
npm run build --silent
git rev-parse HEAD > dist/.built-commit
if [ "${TRANSPORT[0]}" = "--ble" ]; then
  step "installing the Python BLE bridge dependency"
  [ -x .venv/bin/pip ] || python3 -m venv .venv
  .venv/bin/pip install -q -r bridge/requirements.txt
fi

# ---------- hooks ----------
if [ "$HOOKS" = 1 ]; then
  step "installing the Claude Code hooks"
  node dist/cli.js install-hooks
fi

# ---------- daemon ----------
ARGS=("${TRANSPORT[@]}")
if [ -n "$BRIGHTNESS" ]; then ARGS+=(--brightness "$BRIGHTNESS"); fi
if [ "$LAUNCHD" = 1 ]; then
  step "installing the daemon as a login agent"
  if [ "$AUTOUPDATE" = 0 ]; then ARGS+=(--no-auto-update); fi
  node dist/cli.js install-launchd "${ARGS[@]}"
else
  echo "skipping the login agent; run:  node dist/cli.js daemon ${ARGS[*]} -v"
fi

# ---------- menu bar ----------
if [ "$MENUBAR" = 1 ]; then
  step "installing the Clawdbar menu bar app"
  menubar/install.sh
fi

# ---------- wait for Clawd ----------
if [ "$LAUNCHD" = 1 ]; then
  step "waiting up to 45 s for the daemon to reach the panel (phone Bluetooth off, Divoom app closed)"
  ok=0
  for i in $(seq 1 45); do
    s=$(curl -sf http://127.0.0.1:7676/state 2>/dev/null || true)
    if [ -n "$s" ]; then
      connected=$(printf '%s' "$s" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).device.connected')
      current=$(printf '%s' "$s" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).current')
      if [ "$connected" = "true" ]; then printf '\r\033[Kpanel connected, showing %s\n' "$current"; ok=1; break; fi
      printf '\r\033[Kdaemon up, connecting to the panel… (%ss)' "$i"
    else
      printf '\r\033[Kstarting daemon… (%ss)' "$i"
    fi
    sleep 1
  done
  if [ "$ok" = 0 ]; then
    echo
    echo "the daemon has not connected to the panel yet. It keeps retrying in the background; check:"
    echo "  tail -f ~/Library/Logs/clawdbox/clawdbox.log"
    echo "Common causes: the phone's Bluetooth is on (the Divoom app grabs the box), the box is off, or macOS"
    echo "is asking whether Clawdbox may use Bluetooth (System Settings → Privacy & Security → Bluetooth)."
  fi
fi

echo
bold "clawdbox is installed."
echo "  checkout:    $DIR"
echo "  previewer:   http://127.0.0.1:7676"
echo "  logs:        ~/Library/Logs/clawdbox/"
echo "  update:      re-run this script, or 'node dist/cli.js update'$( [ "$AUTOUPDATE" = 1 ] && [ "$LAUNCHD" = 1 ] && echo ' (also automatic every 6 h)')"
echo "  uninstall:   $DIR/uninstall.sh"
echo "Start a Claude Code session and watch Clawd."
}

usage() {
cat <<'USAGE'
clawdbox one-shot installer for macOS

  curl -fsSL https://raw.githubusercontent.com/edmerrett/clawdbox/main/install.sh | bash
  curl -fsSL .../install.sh | bash -s -- --mac XX:XX:XX:XX:XX:XX     # original Evo
  ./install.sh [options]                                            # from a checkout

Options:
  --dir PATH        where to keep the checkout (default ~/Tools/clawdbox, or the current official checkout)
  --mac XX:XX:…     original Timebox Evo over Bluetooth Classic (default is --ble, the newer Evo)
  --no-auto-update  skip the six-hourly updater (on by default; it follows release tags)
  --no-hooks        don't touch ~/.claude/settings.json
  --no-launchd      don't install the login agent (you run the daemon yourself)
  --no-menubar      skip the menu bar app
  --brightness N    panel brightness 0-100 (default 100)
USAGE
}

main "$@"
