#!/bin/bash
# Remove everything install.sh set up (keeps the checkout itself).
set -uo pipefail
cd "$(dirname "$0")"
echo "▸ removing hooks from ~/.claude/settings.json"; node dist/cli.js uninstall-hooks 2>/dev/null || true
echo "▸ removing the launchd agents and Clawdbox.app"; node dist/cli.js uninstall-launchd 2>/dev/null || true
echo "▸ removing the menu bar app"; menubar/uninstall.sh 2>/dev/null || true
pkill -f "cli.js daemon" 2>/dev/null || true
pkill -f clawdbox_ble.py 2>/dev/null || true
echo "done. Delete this folder to remove the checkout."
