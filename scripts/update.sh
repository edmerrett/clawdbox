#!/bin/bash
# Update a git-based clawdbox install in place, safely:
#   - updates to the newest release tag (v*), not whatever is on main (--main to track main)
#   - installs a tag only if it is signed by a key in scripts/release-signers, read from the
#     checkout already installed (so a new tag cannot vouch for itself)
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
# Clawdbox.app launches this from a GUI context whose PATH lacks Homebrew.
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

# Never move backwards or sideways: if the installed commit already contains the target
# (a checkout of main is usually ahead of the newest tag), there is nothing to do.
if git merge-base --is-ancestor "$TARGET" "$BUILT" 2>/dev/null; then CURRENT=1; else CURRENT=0; fi
if [ "$CHECK" = 1 ]; then
  if [ "$CURRENT" = 1 ]; then echo "up to date ($(short "$BUILT") already includes $TARGET_REF)"; exit 1; fi
  echo "update available: $(short "$BUILT") -> $TARGET_REF ($(short "$TARGET"))"; exit 0
fi
if [ "$CURRENT" = 1 ] && [ "$FORCE" = 0 ]; then
  say "already up to date ($(short "$BUILT") already includes $TARGET_REF)"; exit 0
fi
if [ "$CURRENT" = 1 ] && [ "$FORCE" = 1 ]; then
  # --force rebuilds what is checked out; it does not downgrade to the tag
  TARGET=$(git rev-parse HEAD); TARGET_REF="HEAD"
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  say "local changes present; refusing to update:"; git status --porcelain --untracked-files=no | sed 's/^/    /'; exit 4
fi

# Who made this release: the tag must carry a good signature from a trusted key. --force on a
# current install rebuilds what is already checked out and needs no check.
if [ "$TRACK" = tags ] && [ "$TARGET_REF" != HEAD ]; then
  say "checking the signature on $TARGET_REF"
  "$ROOT/scripts/verify-release.sh" "$ROOT/scripts/release-signers" "$TARGET_REF" || {
    say "not updating: $TARGET_REF is not signed by a trusted release key (see scripts/release-signers)"; exit 5; }
elif [ "$TRACK" = main ]; then
  say "following main: commits are not signature-checked"
fi

PREV=$(git rev-parse HEAD)
# What changed since the running build, not since HEAD: a `git pull` may have moved HEAD already.
CHANGED=$(git diff --name-only "$BUILT" "$TARGET" 2>/dev/null || git diff --name-only "$PREV" "$TARGET" || true)
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
say "installing dependencies"
npm ci --no-audit --no-fund --silent --ignore-scripts
if grep -q -- '--mac\|--serial' "$HOME/Library/Application Support/clawdbox/daemon.json" "$HOME/Applications/Clawdbox.app/Contents/MacOS/clawdbox" 2>/dev/null; then
  npm rebuild bluetooth-serial-port --silent || say "bluetooth-serial-port did not build; the Classic transport may be unavailable"
fi
# Build beside the live dist/ and swap in one move.
say "building"
npx tsc -p tsconfig.json --outDir dist.new
chmod +x dist.new/cli.js
echo "$TARGET" > dist.new/.built-commit
rm -rf dist.old; [ -d dist ] && mv dist dist.old; mv dist.new dist; rm -rf dist.old
trap - ERR

if [ -x .venv/bin/pip ] && { [ "$FORCE" = 1 ] || grep -q '^bridge/requirements.txt' <<<"$CHANGED"; }; then
  say "updating the Python bridge dependency"
  .venv/bin/pip install -q -r bridge/requirements.txt || say "pip install failed; the bridge keeps its current dependency"
fi
if [ -x "$HOME/Applications/Clawdbox.app/Contents/MacOS/Clawdbox" ] && xcrun -f swiftc >/dev/null 2>&1 && { [ "$FORCE" = 1 ] || grep -q '^menubar/' <<<"$CHANGED"; }; then
  say "rebuilding Clawdbox.app"
  menubar/install.sh || say "Clawdbox.app rebuild failed; the old one keeps running"
fi
# Installs from before 0.4.4: tie the launch agents to Clawdbox.app by bundle id, so macOS stops
# announcing "Clawdbox can run in the background" at every login (takes effect at next login).
for plist in "$HOME/Library/LaunchAgents/com.clawdbox.daemon.plist" "$HOME/Library/LaunchAgents/com.clawdbox.update.plist"; do
  [ -f "$plist" ] || continue
  /usr/libexec/PlistBuddy -c "Print :AssociatedBundleIdentifiers" "$plist" >/dev/null 2>&1 && continue
  if /usr/libexec/PlistBuddy -c "Add :AssociatedBundleIdentifiers array" \
       -c "Add :AssociatedBundleIdentifiers:0 string com.clawdbox.app" "$plist" >/dev/null 2>&1; then
    say "tied $(basename "$plist") to Clawdbox.app (AssociatedBundleIdentifiers)"
  fi
done
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  say "restarting the daemon"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
elif pgrep -x Clawdbox >/dev/null 2>&1 && [ -d "$HOME/Applications/Clawdbox.app" ]; then
  # Clawdbox.app was started outside launchd (opened by hand or as a login item) and hosts the
  # daemon itself; without this the old daemon kept running and the update looked like a no-op.
  say "restarting Clawdbox.app (it is not running under launchd)"
  pkill -x Clawdbox || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x Clawdbox >/dev/null 2>&1 || break; sleep 0.5; done
  open -g "$HOME/Applications/Clawdbox.app" || say "could not relaunch Clawdbox.app; open it yourself"
else
  say "daemon is not installed as a launchd agent; restart it yourself if it is running"
fi
say "done: now at $TARGET_REF ($(short "$TARGET"))"
