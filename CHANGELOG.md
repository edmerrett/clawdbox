# Changelog

## Unreleased

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
