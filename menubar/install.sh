#!/bin/bash
# Build Clawdbox.app and copy it to ~/Applications.
#   --login-item   also launch it now and register it as a login item (only when the launchd agent is not used)
#   --wait         keep polling the daemon for up to 15 s before reporting what the menu bar shows
set -euo pipefail
cd "$(dirname "$0")"
./build.sh build
DEST="$HOME/Applications/Clawdbox.app"
mkdir -p "$HOME/Applications"
# Replace the bundle in place. The launchd agent (or the installer) relaunches it; when the
# app's own "Install Update…" runs this, bash is already a separate process, so this is safe.
rm -rf "$DEST"
cp -R build/Clawdbox.app "$DEST"
# LaunchServices caches the icon by path; the wrapper bundle that used to live here had none.
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREG" ] && "$LSREG" -f "$DEST" >/dev/null 2>&1 || true
touch "$DEST"
# the old two-app layout
osascript -e 'tell application "System Events" to delete login item "Clawdbar"' >/dev/null 2>&1 || true
rm -rf "$HOME/Applications/Clawdbar.app"
if [ "${1:-}" = "--login-item" ]; then
  pkill -x Clawdbox 2>/dev/null || true
  open "$DEST" || nohup "$DEST/Contents/MacOS/Clawdbox" >/dev/null 2>&1 &
  osascript -e 'tell application "System Events" to delete login item "Clawdbox"' >/dev/null 2>&1 || true
  osascript -e 'on run argv' -e 'tell application "System Events" to make login item at end with properties {path:(item 1 of argv), hidden:false}' -e 'end run' "$DEST" >/dev/null 2>&1 \
    && echo "added to Login Items" || echo "could not add to Login Items (add $DEST manually in System Settings → General → Login Items)"
fi
echo "installed $DEST"
echo
WAIT=1; for a in "$@"; do [ "$a" = "--wait" ] && WAIT=15; done
echo "What the menu bar is showing right now (from the running daemon):"
for i in $(seq 1 "$WAIT"); do
  if "$DEST/Contents/MacOS/Clawdbox" --check 2>/dev/null; then break; fi
  if [ "$i" = "$WAIT" ]; then
    echo "(no daemon answered on 127.0.0.1:7676; the menu bar updates by itself once it is up)"
  else
    sleep 1
  fi
done
echo
echo "Launcher check: $(/usr/bin/otool -l "$DEST/Contents/MacOS/Clawdbox" 2>/dev/null | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print "built for macOS " $2; exit}') on $(sw_vers -productVersion)"
