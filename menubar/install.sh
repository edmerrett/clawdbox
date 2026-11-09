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
open "$DEST"
osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$DEST\", hidden:false}" >/dev/null 2>&1 \
  && echo "added to Login Items" || echo "could not add to Login Items (add $DEST manually in System Settings → General → Login Items)"
echo "Clawdbar is running: look for Clawd in the menu bar."
