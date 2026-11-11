# Installing, running and updating

## One command (macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/edmerrett/clawdbox/main/install.sh | bash
```

That clones to `~/Tools/clawdbox`, installs the Node and Python dependencies, builds, installs the Claude Code
hooks, builds Clawdbox.app (the menu bar app, which also hosts the daemon), installs it as a login agent with a
six-hourly release updater, and then waits for Clawd to appear on the panel. Re-running it updates everything. Before you run it:

1. **Pair** the Timebox in System Settings → Bluetooth.
2. Turn the **phone's Bluetooth off**: the Divoom app reconnects to the box whenever it sees it, and the box accepts
   one controller at a time.
3. Run it from **Terminal.app or iTerm2**, which declare Bluetooth usage to macOS.

Original Evo (Bluetooth Classic, see [Which Evo?](#which-evo))? Add `--mac XX:XX:XX:XX:XX:XX`. Pass flags to the
one-liner with `| bash -s -- --mac …`. Other flags: `--no-auto-update` (skip the six-hourly release updater),
`--no-hooks`, `--no-launchd`, `--no-menubar`, `--brightness N`, `--dir PATH`. `uninstall.sh` removes everything
the installer set up. Prefer to read before you run? `curl -fsSLO …/install.sh && less install.sh && bash install.sh`;
tagged releases publish a `SHA256SUMS` that covers `install.sh`.

### Step by step instead
```bash
git clone https://github.com/edmerrett/clawdbox && cd clawdbox
npm install && npm run build
python3 -m venv .venv && .venv/bin/pip install -r bridge/requirements.txt   # newer Evo (BLE) only
node dist/cli.js send writing --ble            # smoke test: Clawd types on the panel (original Evo: --mac XX:…)
node dist/cli.js daemon --ble -v               # run the daemon; previewer at http://127.0.0.1:7676
node dist/cli.js install-hooks                 # merge hooks into ~/.claude/settings.json (backs it up first)
menubar/install.sh                             # build Clawdbox.app (menu bar + daemon host)
node dist/cli.js install-launchd --ble         # login agent + six-hourly release updater (--no-auto-update to skip)
```
`npm link` puts a `clawdbox` command on your PATH. No panel yet? `npm run dev` runs everything against a mock panel.

## Clawdbox.app

One app does three jobs: it sits in the menu bar (Clawd silhouette plus the current state, dimmed when the panel is
disconnected), it hosts the node daemon as a child process so the daemon inherits its Bluetooth permission, and it
restarts the daemon if it dies. Click it and the menu opens on a small digital Divoom playing whatever the panel is
showing, live. Below that the menu offers Check for Updates, Open Previewer, Force State, Restart Daemon, Show Logs
and, when a newer release exists, Install Update. The menu shows the installed version (`Clawdbox 0.4.0`). Check for
Updates answers in a dialog (up to date, or the new version with Install Now); while an update installs the menu bar
reads "updating…", and once the new version is running a dialog says so. Updates the six-hourly updater installs on
its own show as "Updated to … (was …)" in the menu. The update log is `~/Library/Logs/clawdbox/update.log`. A state picked under Force State is held (ticked) whatever the hooks
say, until you pick Release or the same state again. Quit stops the daemon too, until the next login.
`~/Applications/Clawdbox.app/Contents/MacOS/Clawdbox --check` prints what the menu bar would show. Without the Xcode
command line tools the installer falls back to a plain wrapper bundle with no menu bar item.

## Daemon options

```
--ble                     newer Evo over BLE via bridge/clawdbox_ble.py
--address UUID            BLE address from "clawdbox ble-scan" (default: scan and take the first Divoom/TimeBox)
--upload | --slots        BLE modes, see above (--select HEX for slots experiments)
--python PATH             interpreter for the bridge (default .venv/bin/python, else python3)
--mac XX:XX:XX:XX:XX:XX   original Evo over Bluetooth serial (--channel N to pin the RFCOMM channel)
--serial /dev/cu.NAME     original Evo via the OS serial device
--mock                    no panel; log what would have been sent
--anims DIR               animation directory (default art/anims)
--brightness 0-100        panel brightness, applied on every (re)connect; default 100
--hold-ms 2000            minimum time a state stays on screen
--idle-ms 60000           silence before a thinking/reading/writing session counts as interrupted and goes idle
--wait-ms 300000          the same for running and needs-you (a long command or an unanswered prompt)
--coffee-min 10           minutes idle before the coffee/headphones stages start (0 disables)
--flash-ms 3500           how long wave/done/error/heart stay up
--port 7676               TCP port for the previewer and status
--socket PATH             Unix socket for hook events (default ~/Library/Application Support/clawdbox/hook.sock)
--tcp-events              also accept hook POSTs on the TCP port (for Claude Code's http hooks; less private)
--no-update-check         don't look for newer release tags
-v                        log every event
```

Hook events: `POST /event` on the Unix socket (JSON object → 204). TCP, loopback only: `GET /state`, `GET /anims`,
`POST /show/<state>` (force until the next hook event; `?hold=1` until released), `POST /release`,
`POST /update-check` (check for a release now), `GET /` previewer. Every request needs a loopback `Host`; POSTs with a
foreign `Origin` are refused.

## Hooks

`install-hooks` registers an **async command hook** on every relevant event: a one-second `/usr/bin/curl` that
forwards the hook JSON to the daemon's `0600` Unix socket and always exits 0. Claude Code never waits for it, a
stopped daemon costs nothing, and no other local process can receive the payload. `install-hooks --http` uses
Claude Code's native `http` hook type over TCP instead (no shell, but Claude Code awaits it, reports a non-blocking
error per event while the daemon is down, and the port could be squatted; run the daemon with `--tcp-events`). See
[`hooks/claude-hooks.example.json`](hooks/claude-hooks.example.json). `uninstall-hooks` removes exactly what was added.

Prompt text is only ever pattern-matched in memory (for "thanks" and "ultrathink"). It is not logged or stored.

## Updating

```bash
clawdbox update            # update to the newest release tag, rebuild, rebuild Clawdbox.app if it changed, restart
clawdbox update --check    # exit 0 if a newer release exists, 1 if current
clawdbox update --main     # follow origin/main instead of release tags
```
The update builds into a staging directory and swaps it in only on success; a failed build restores the previous
commit. Dependencies are installed with `--ignore-scripts`. The installer also adds a launchd agent that runs the
update every six hours (log in `~/Library/Logs/clawdbox/update.log`); it follows release tags only, never `main`, and
`--no-auto-update` skips it. The daemon itself only checks (one `git ls-remote` every six hours) and reports in
`/state`; the menu bar then shows "Update available" with an "Install Update…" item. `--no-update-check` turns even
that off. Tagged releases (`v*`) are built by GitHub Actions and published with `Clawdbox.app` zipped, the npm
tarball and a `SHA256SUMS`.

## Linux
The daemon and the BLE bridge run on Linux (bleak uses BlueZ). There is no installer or menu bar app; follow the
step-by-step commands above, skip the launchd parts, and run `node dist/cli.js daemon --ble` under your own
supervisor. The hook socket defaults to `$XDG_RUNTIME_DIR/clawdbox/hook.sock`.
