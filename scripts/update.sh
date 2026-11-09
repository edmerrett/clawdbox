#!/bin/bash
# Update a git-based clawdbox install in place: pull main, reinstall deps, rebuild,
# rebuild the menu bar app if it changed, restart the daemon. Safe to run repeatedly.
#
#   scripts/update.sh            update if origin/main moved
#   scripts/update.sh --force    rebuild even when already up to date
#   scripts/update.sh --check    print whether an update is available and exit 0 (yes) / 1 (no)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LABEL=com.clawdbox.daemon
FORCE=0; CHECK=0
for a in "$@"; do case "$a" in --force) FORCE=1;; --check) CHECK=1;; esac; done
say() { echo "[clawdbox update $(date '+%H:%M:%S')] $*"; }

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  say "not a git checkout; update by reinstalling the package"; exit 2
fi
git fetch --quiet origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$CHECK" = 1 ]; then
  if [ "$LOCAL" = "$REMOTE" ]; then echo "up to date ($(git rev-parse --short HEAD))"; exit 1; fi
  echo "update available: $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"; exit 0
fi
if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" = 0 ]; then
  say "already up to date ($(git rev-parse --short HEAD))"; exit 0
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  say "local changes present; refusing to update. Commit or stash them first."; exit 3
fi

CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE" || true)
say "updating $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
git pull --ff-only --quiet origin main
npm ci --no-audit --no-fund --silent
npm run build --silent
if [ -x .venv/bin/pip ] && { [ "$FORCE" = 1 ] || grep -q '^bridge/requirements.txt' <<<"$CHANGED"; }; then
  say "updating the Python bridge dependency"
  .venv/bin/pip install -q -r bridge/requirements.txt
fi
if [ -d "$HOME/Applications/Clawdbar.app" ] && command -v swiftc >/dev/null && { [ "$FORCE" = 1 ] || grep -q '^menubar/' <<<"$CHANGED"; }; then
  say "rebuilding the menu bar app"
  menubar/install.sh >/dev/null
fi
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  say "restarting the daemon"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
else
  say "daemon is not installed as a launchd agent; restart it yourself if it is running"
fi
say "done: now at $(git rev-parse --short HEAD)"
