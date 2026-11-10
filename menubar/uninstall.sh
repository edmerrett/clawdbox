#!/bin/bash
set -euo pipefail
pkill -x Clawdbox 2>/dev/null || true
pkill -x Clawdbar 2>/dev/null || true
for name in Clawdbox Clawdbar; do osascript -e "tell application \"System Events\" to delete login item \"$name\"" >/dev/null 2>&1 || true; done
rm -rf "$HOME/Applications/Clawdbox.app" "$HOME/Applications/Clawdbar.app"
echo "Clawdbox.app removed"
