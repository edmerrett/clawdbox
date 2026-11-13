#!/bin/bash
set -euo pipefail
pkill -x Clawdbox 2>/dev/null || true
pkill -x Clawdbar 2>/dev/null || true
for name in Clawdbox Clawdbar; do osascript -e "tell application \"System Events\" to delete login item \"$name\"" >/dev/null 2>&1 || true; done
rm -rf "$HOME/Applications/Clawdbox.app" "$HOME/Applications/Clawdbar.app"
echo "Clawdbox.app removed"
# the local signing certificate menubar/make-signing-cert.sh created, if any
if security find-certificate -c "Clawdbox Local Signing" >/dev/null 2>&1; then
  security delete-identity -c "Clawdbox Local Signing" >/dev/null 2>&1 \
    || security delete-certificate -c "Clawdbox Local Signing" >/dev/null 2>&1 || true
  echo "removed the Clawdbox Local Signing certificate"
fi
