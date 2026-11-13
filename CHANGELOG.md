# Changelog

## Unreleased

### Changed
- Install Update… shows what it is doing. While it runs, the menu shows the update's current step (checking the
  signature, installing dependencies, building, rebuilding Clawdbox.app, restarting) instead of a fixed
  "Installing update…" line. When it ends without restarting Clawdbox, you get a dialog: "Nothing to install" when
  the build is already current (and the stale "update available" line goes away), or "Update failed" naming the step
  it stopped at. When it installed without a restart, the daemon is restarted so the new build runs.

### Fixed
- Updates installed but never took effect when Clawdbox.app had been started outside launchd (opened by hand, or by
  an old login item): `update.sh` could not restart it, so the old daemon kept running, Check for Updates… said
  "up to date" on the old version, and Install Update… did nothing. `update.sh` now restarts Clawdbox.app in that
  case, and Install Update… restarts a daemon that still reports an older version than the installed checkout.

## 0.4.5

### Fixed
- Check for Updates… said "up to date" on an old build when the installed checkout had been `git pull`ed without
  rebuilding: the check compared the newest release with git HEAD. It now compares with the commit the running build
  came from (`dist/.built-commit`, falling back to HEAD), and `scripts/update.sh` decides whether to rebuild
  Clawdbox.app and the bridge from what changed since that build, not since HEAD.

## 0.4.4

### Fixed
- macOS no longer announces "“Clawdbox” can run in the background" at every login. Both launch agents now carry
  `AssociatedBundleIdentifiers` (`com.clawdbox.app`), so Background Task Management ties them to Clawdbox.app by
  bundle id instead of by the ad-hoc signature that changes with every build. `install-launchd` leaves an unchanged
  plist alone instead of rewriting it, and the updater adds the key to agents installed by earlier versions (it takes
  effect at the next login). If the notice still shows after that, stale entries from earlier installs are left in
  the Login Items database: `sfltool resetbtm`, then restart.

## 0.4.3

### Removed
- The "Updated to … (was …)" menu line after a background update. The version line already shows what is running;
  an update you start with Install Update… still ends with a dialog.

## 0.4.2

### Security
- Updates are signature-checked. `scripts/update.sh` (the six-hourly updater and Install Update…) installs a release
  tag only if it is an annotated tag signed by a key in `scripts/release-signers`, read from the installed checkout;
  push access to the repository is no longer enough to ship an update. `scripts/verify-release.sh` does the check,
  pins `ssh-keygen` as the verifier and refuses a tag object replayed under another name. `--main` is unchecked.

## 0.4.1

### Changed
- Updates you can see. The menu shows the installed version. Check for Updates… answers in a dialog (up to date, or
  the new version with Install Now) instead of a menu line you only saw by reopening the menu. While an
  update installs the menu bar reads "updating…"; when the new version is running a dialog says so (with What's New),
  and a failed update offers its log. Updates the background updater installs show as "Updated to … (was …)" in the
  menu. "Update available" names versions rather than commits; the daemon's update info gains `latestVersion`.

## 0.4.0

### Added
- Menu bar: Check for Updates… asks the daemon to look for a newer release now (`POST /update-check`) and says
  whether you are up to date, instead of waiting for the 6-hourly check.
- Force State now holds: the picked state stays on the panel (ticked in the menu) through hook events, flashes and
  idle stages until you pick Release, or the same state again. Previously a force lasted only until the next hook
  event and there was no way to undo it. The daemon gains `POST /show/<state>?hold=1` and `POST /release`, the CLI
  `clawdbox show <state> --hold` and `clawdbox release`; `/state` reports `held`. A plain `/show/<state>` (the
  previewer, `clawdbox show`) still lasts until the next hook event.

### Fixed
- A panel switched off (or out of range) while idle was still shown as connected in the menu bar. The BLE bridge now
  checks the link every 3 s, reports `disconnected` to the daemon and reconnects; Clawd is put back when the panel
  returns. With `--serial`, a device that hangs up now closes the link instead of being read forever, and Classic
  links reconnect straight away rather than at the next hook event.

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
