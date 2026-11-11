# Changelog

## Unreleased

### Added
- Menu bar: Check for Updates… asks the daemon to look for a newer release now (`POST /update-check`) and says
  whether you are up to date, instead of waiting for the 6-hourly check.
- Force State now holds: the picked state stays on the panel (ticked in the menu) through hook events, flashes and
  idle stages until you pick Release, or the same state again. Previously a force lasted only until the next hook
  event and there was no way to undo it. The daemon gains `POST /show/<state>?hold=1` and `POST /release`, the CLI
  `clawdbox show <state> --hold` and `clawdbox release`; `/state` reports `held`. A plain `/show/<state>` (the
  previewer, `clawdbox show`) still lasts until the next hook event.

### Removed
- The animated explainer video and its tooling (`docs/promo`, `scripts/render-promo.mjs`, `scripts/make-voice.sh`)
  and the unused `assets/icon-preview.png`. The README hero is now the all-states sprite GIF.

## 0.3.0

### Added
- A small digital Divoom at the top of the menu bar menu: a 16×16 LED panel that plays the animation for the current
  state while the menu is open, dimmed when the real panel is disconnected. `Clawdbox --check --snapshot <file>` saves
  it as a PNG.

### Fixed
- Stopping a turn (Esc / the stop button) left its state on the panel. Claude Code fires no hook on an interrupt,
  and the only fallback was one 90 s silence timer shared by every session, so events from any other session kept
  an interrupted one alive and, because the most urgent state wins, it kept the panel from them. Staleness is now
  tracked per session: thinking/reading/writing go idle after 60 s of silence (`--idle-ms`), running and needs-you
  after 5 min (`--wait-ms`, new), and a `running` session silent for 60 s no longer outranks an active one.
- A tool failure reported as an interrupt (`is_interrupt`) sets the session idle at once instead of thinking.
- Subagent events keep their session alive, so a turn working through subagents is not mistaken for an interrupted one.

### Changed
- `--idle-ms` defaults to 60000 (was 90000) and applies per session.

## 0.2.1

### Changed
- Shorter README; details moved to docs/INSTALL.md, docs/HARDWARE.md, docs/STATES.md, docs/ART.md.
- Animated explainer (docs/promo) rendered from the real sprites, with narration (ElevenLabs, `eleven_v4`) and burned-in captions:
  MP4 for sharing, GIF as the README hero. `scripts/make-voice.sh` regenerates an offline Piper narration as a fallback.
- One app: Clawdbox.app is the menu bar item and hosts the daemon as a supervised child, replacing the wrapper
  bundle plus Clawdbar.app pair. Quit stops the daemon until next login; Restart Daemon restarts the child.
- App icon rendered from the sprite; installers re-register the bundle so Finder and Spotlight pick it up.
- Installer builds the app before the login agent and no longer prints a stream of "offline" checks.

## 0.2.0

### Security
- Hook events now arrive over a `0600` Unix domain socket instead of a loopback TCP port, so no other local
  process can capture prompts or tool inputs by binding the port first. The TCP port serves only the previewer
  and status; `--tcp-events` restores TCP hook delivery for Claude Code's native `http` hooks.
- Every request must carry a loopback `Host` (defeats DNS rebinding); the previewer sends CSP and `nosniff`.
- Auto-update follows release tags instead of `main` (`--no-auto-update` to skip it), installs dependencies with `--ignore-scripts`,
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
