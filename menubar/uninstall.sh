#!/bin/bash
set -euo pipefail
pkill -x Clawdbar 2>/dev/null || true
osascript -e 'tell application "System Events" to delete login item "Clawdbar"' >/dev/null 2>&1 || true
rm -rf "$HOME/Applications/Clawdbar.app"
echo "Clawdbar removed"
