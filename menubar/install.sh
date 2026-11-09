#!/bin/bash
# Build Clawdbar, copy it to ~/Applications, launch it, and register it as a login item.
set -euo pipefail
cd "$(dirname "$0")"
./build.sh build
DEST="$HOME/Applications/Clawdbar.app"
mkdir -p "$HOME/Applications"
pkill -x Clawdbar 2>/dev/null || true
rm -rf "$DEST"
cp -R build/Clawdbar.app "$DEST"
if ! open "$DEST"; then
  echo "LaunchServices refused to open the bundle; starting the binary directly"
  nohup "$DEST/Contents/MacOS/Clawdbar" >/dev/null 2>&1 &
fi
sleep 2
osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$DEST\", hidden:false}" >/dev/null 2>&1 \
  && echo "added to Login Items" || echo "could not add to Login Items (add $DEST manually in System Settings → General → Login Items)"
echo "Clawdbar is running: look for Clawd in the menu bar."
echo
echo "What the menu bar is showing right now (from the running daemon):"
for i in $(seq 1 15); do
  if "$DEST/Contents/MacOS/Clawdbar" --check 2>/dev/null; then break; fi
  if [ "$i" = 15 ]; then
    echo "(no daemon answered on 127.0.0.1:7676 within 15 s; check ~/Library/Logs/clawdbox/clawdbox.log — the menu bar updates by itself once it is up)"
  else
    sleep 1
  fi
done
echo
echo "Launcher check: $(/usr/bin/otool -l "$DEST/Contents/MacOS/Clawdbar" 2>/dev/null | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print "built for macOS " $2; exit}') on $(sw_vers -productVersion)"
