#!/bin/bash
# Build Clawdbar.app (menu bar companion) with just the Xcode command line tools.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-build}"
APP="$OUT/Clawdbar.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
echo "compiling…"
swiftc -O -framework Cocoa -o "$APP/Contents/MacOS/Clawdbar" ClawdbarApp.swift
cp Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "built $APP"
