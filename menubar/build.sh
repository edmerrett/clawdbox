#!/bin/bash
# Build Clawdbox.app (menu bar app that also hosts the daemon) with just the Xcode command line tools.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-build}"
APP="$OUT/Clawdbox.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# Pin the deployment target: with a newer SDK than the running macOS, swiftc's default
# target makes LaunchServices refuse the bundle (error -10825).
ARCH="$(uname -m)"
TARGET="${CLAWDBAR_TARGET:-${ARCH}-apple-macos12.0}"
echo "compiling for ${TARGET}..."
swiftc -O -target "$TARGET" -framework Cocoa -o "$APP/Contents/MacOS/Clawdbox" ClawdboxApp.swift
cp Info.plist "$APP/Contents/Info.plist"
cp ../assets/Clawd.icns "$APP/Contents/Resources/Clawd.icns"
/usr/libexec/PlistBuddy -c "Add :LSMinimumSystemVersion string 12.0" "$APP/Contents/Info.plist" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c "Set :LSMinimumSystemVersion 12.0" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
# Sign with a stable identity when there is one, so macOS keeps the Bluetooth permission
# across rebuilds (it is tied to the signature; an ad-hoc one changes every build).
# CLAWDBOX_SIGN_IDENTITY overrides; else the certificate menubar/make-signing-cert.sh creates.
IDENTITY="${CLAWDBOX_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ] && security find-certificate -c "Clawdbox Local Signing" >/dev/null 2>&1; then
  IDENTITY="Clawdbox Local Signing"
fi
if [ -n "$IDENTITY" ] && codesign --force --sign "$IDENTITY" "$APP" >/dev/null 2>&1; then
  echo "signed with \"$IDENTITY\""
else
  [ -n "$IDENTITY" ] && echo "could not sign with \"$IDENTITY\"; falling back to an ad-hoc signature"
  codesign --force --sign - "$APP" >/dev/null 2>&1 || true
  echo "ad-hoc signed: macOS asks for Bluetooth again after each rebuild (run menubar/make-signing-cert.sh once to stop that)"
fi
echo "built $APP"
