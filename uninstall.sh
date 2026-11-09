#!/bin/bash
# Remove everything install.sh set up (keeps the checkout itself). Works even if dist/ is missing.
set -uo pipefail
cd "$(dirname "$0")"
UID_=$(id -u)
echo "▸ stopping and removing the launchd agents"
launchctl bootout "gui/$UID_/com.clawdbox.daemon" 2>/dev/null || true
launchctl bootout "gui/$UID_/com.clawdbox.update" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.clawdbox.daemon.plist" "$HOME/Library/LaunchAgents/com.clawdbox.update.plist"
rm -rf "$HOME/Applications/Clawdbox.app"
pkill -f "$PWD/dist/cli.js daemon" 2>/dev/null || true
pkill -f "$PWD/bridge/clawdbox_ble.py" 2>/dev/null || true
echo "▸ removing the menu bar app"
menubar/uninstall.sh 2>/dev/null || true
echo "▸ removing hooks from ~/.claude/settings.json"
if [ -f dist/cli.js ]; then
  node dist/cli.js uninstall-hooks || echo "  could not edit settings.json; remove the entries tagged \"statusMessage\": \"clawdbox\" by hand"
else
  echo "  dist/ is missing (run 'npm run build' then 'node dist/cli.js uninstall-hooks'), or remove the entries tagged"
  echo "  \"statusMessage\": \"clawdbox\" from ~/.claude/settings.json by hand"
fi
rm -f "$HOME/Library/Application Support/clawdbox/hook.sock"
echo "done. Left in place: this checkout, ~/Library/Logs/clawdbox/. Delete them if you want a clean slate."
