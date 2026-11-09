#!/bin/bash
# Build Clawdbar.app (menu bar companion) with just the Xcode command line tools.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-build}"
APP="$OUT/Clawdbar.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# Pin the deployment target: with a newer SDK than the running macOS, swiftc's default
# target makes LaunchServices refuse the bundle (error -10825).
ARCH="$(uname -m)"
TARGET="${CLAWDBAR_TARGET:-${ARCH}-apple-macos12.0}"
echo "compiling for ${TARGET}..."
swiftc -O -target "$TARGET" -framework Cocoa -o "$APP/Contents/MacOS/Clawdbar" ClawdbarApp.swift
cp Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :LSMinimumSystemVersion string 12.0" "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
printf 'APPL????' > "$APP/Contents/PkgInfo"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "built $APP"
