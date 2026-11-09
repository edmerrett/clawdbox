# Changelog

## 0.2.0 (unreleased)

### Security
- Hook events now arrive over a `0600` Unix domain socket instead of a loopback TCP port, so no other local
  process can capture prompts or tool inputs by binding the port first. The TCP port serves only the previewer
  and status; `--tcp-events` restores TCP hook delivery for Claude Code's native `http` hooks.
- Every request must carry a loopback `Host` (defeats DNS rebinding); the previewer sends CSP and `nosniff`.
- Auto-update is opt-in, follows release tags instead of `main`, installs dependencies with `--ignore-scripts`,
  builds into a staging directory and rolls back on failure. The Python dependency is pinned.
- Clawdbar resolves the checkout from its own launchd plist, never from the daemon's response.
- Hook installer keeps the settings file's mode, protects and later removes its backup, refuses concurrent edits.
- Installer: `main()` wrapper, no silent `npm install` fallback, only adopts a cwd that is the official checkout,
  kills by exact path. Actions pinned by SHA; releases ship `SHA256SUMS`.

### Fixed
- Bridge restart backoff was bypassed; `fatal` bridge errors no longer look like a closed display.
- Device reconnect: a failed first write drops the link; serial transport no longer leaks a descriptor.
- `install-launchd` forwards every daemon flag; numeric flags validated once; friendlier errors for
  `show`, `ble-scan`, `discover` and unknown options.
- Bridge: bounded reconnects, stale state changes skipped, clean shutdown, larger stdin limit.
- Update check compares against the newest release tag by ancestry, so local commits don't show as "behind".

## 0.1.0

### Added
- Clawd sprites for thirteen states, posed after the Claude Code sticker set, with per-state GIFs in `docs/`.
- `--ble` transport for the newer TimeBox-Evo-audio via a Python bridge on divoom-protocol (stream, upload and
  experimental slots modes); Bluetooth Classic transport for the original Evo (`--mac`, `--serial`).
- Flashes (wave, done, error, heart), `ultrathink` rainbow thinking, and long-idle coffee/headphones stages.
- `install-hooks`, `install-launchd` (via a Bluetooth-declaring app bundle), `diag`, `scan`, `ble-scan`, `send`.
- Clawdbar, a Swift menu bar app showing connection and current state.
- Browser previewer with LED gamma.
- `clawdbox update`, an optional six-hourly auto-update agent, update detection in the daemon and menu bar, and a
  tag-triggered release workflow that publishes Clawdbar.app and the npm tarball.

### Security
- `/event` requires `application/json` and a JSON object; cross-origin POSTs are refused; bodies over 1 MB get 413.
- Hook installer validates and quotes the daemon URL, writes settings atomically, touches only its own entries.
