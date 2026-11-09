#!/bin/bash
# Update a git-based clawdbox install in place, safely:
#   - updates to the newest release tag (v*), not whatever is on main (--main to track main)
#   - refuses when the checkout has local changes
#   - builds into dist.new and swaps only on success; on failure the checkout is reset to
#     the previously built commit, so a bad update never leaves a broken install behind
#   - installs Node deps with --ignore-scripts (no dependency install scripts run unattended)
#
#   scripts/update.sh            update if a newer release exists
#   scripts/update.sh --force    rebuild even when already current
#   scripts/update.sh --check    exit 0 if an update is available, 1 if current, 2+ on error
#   scripts/update.sh --main     follow origin/main instead of release tags
set -euo pipefail
# Clawdbar launches this from a GUI context whose PATH lacks Homebrew; the launchd agent sets its own.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LABEL=com.clawdbox.daemon
STAMP="dist/.built-commit"
FORCE=0; CHECK=0; TRACK=tags
for a in "$@"; do
  case "$a" in
    --force) FORCE=1;; --check) CHECK=1;; --main) TRACK=main;;
    *) echo "unknown option: $a" >&2; exit 2;;
  esac
done
say() { echo "[clawdbox update $(date '+%Y-%m-%d %H:%M:%S')] $*"; }
short() { git rev-parse --short "$1"; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { say "not a git checkout; update by reinstalling the package"; exit 2; }
git fetch --quiet --tags origin main || { say "could not reach origin"; exit 3; }

# What is installed: the commit the current dist/ was built from (falls back to HEAD).
BUILT=$(cat "$STAMP" 2>/dev/null || git rev-parse HEAD)
# What is available.
if [ "$TRACK" = tags ]; then
  TARGET_REF=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)
  [ -n "$TARGET_REF" ] || { say "no release tags on origin yet; use --main to follow main"; exit 2; }
else
  TARGET_REF=origin/main
fi
TARGET=$(git rev-parse "$TARGET_REF^{commit}")

if [ "$CHECK" = 1 ]; then
  if [ "$BUILT" = "$TARGET" ]; then echo "up to date ($TARGET_REF, $(short "$TARGET"))"; exit 1; fi
  echo "update available: $(short "$BUILT") -> $TARGET_REF ($(short "$TARGET"))"; exit 0
fi
if [ "$BUILT" = "$TARGET" ] && [ "$FORCE" = 0 ]; then
  say "already up to date ($TARGET_REF, $(short "$TARGET"))"; exit 0
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  say "local changes present; refusing to update:"; git status --porcelain --untracked-files=no | sed 's/^/    /'; exit 4
fi

PREV=$(git rev-parse HEAD)
CHANGED=$(git diff --name-only "$PREV" "$TARGET" || true)
say "updating $(short "$PREV") -> $TARGET_REF ($(short "$TARGET"))"

rollback() {
  say "update failed; restoring $(short "$PREV")"
  git checkout --quiet "$PREV" 2>/dev/null || true
  rm -rf dist.new
}
trap rollback ERR

# Detached checkout of the release tag (or fast-forward of main when tracking main).
if [ "$TRACK" = tags ]; then git checkout --quiet "$TARGET"; else git merge --ff-only --quiet "$TARGET"; fi

# Dependencies without running install scripts; the one native optional module is rebuilt
# only when the install actually uses the original Evo's Bluetooth Classic transport.
npm ci --no-audit --no-fund --silent --ignore-scripts
if grep -q -- '--mac\|--serial' "$HOME/Applications/Clawdbox.app/Contents/MacOS/clawdbox" 2>/dev/null; then
  npm rebuild bluetooth-serial-port --silent || say "bluetooth-serial-port did not build; the Classic transport may be unavailable"
fi
# Build beside the live dist/ and swap in one move.
npx tsc -p tsconfig.json --outDir dist.new
chmod +x dist.new/cli.js
echo "$TARGET" > dist.new/.built-commit
rm -rf dist.old; [ -d dist ] && mv dist dist.old; mv dist.new dist; rm -rf dist.old
trap - ERR

if [ -x .venv/bin/pip ] && { [ "$FORCE" = 1 ] || grep -q '^bridge/requirements.txt' <<<"$CHANGED"; }; then
  say "updating the Python bridge dependency"
  .venv/bin/pip install -q -r bridge/requirements.txt || say "pip install failed; the bridge keeps its current dependency"
fi
if [ -d "$HOME/Applications/Clawdbar.app" ] && xcrun -f swiftc >/dev/null 2>&1 && { [ "$FORCE" = 1 ] || grep -q '^menubar/' <<<"$CHANGED"; }; then
  say "rebuilding the menu bar app"
  menubar/install.sh || say "menu bar app rebuild failed; the old one keeps running"
fi
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  say "restarting the daemon"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
else
  say "daemon is not installed as a launchd agent; restart it yourself if it is running"
fi
say "done: now at $TARGET_REF ($(short "$TARGET"))"
