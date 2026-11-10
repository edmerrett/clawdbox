<p align="center">
  <img src="docs/sprites/all-states.gif" alt="Clawd in all thirteen states" width="100%">
</p>

<h1 align="center">clawdbox</h1>

<p align="center">
  A desk companion for <a href="https://claude.com/claude-code">Claude Code</a>.<br>
  Clawd lives on a 16×16 Divoom LED panel and acts out whatever Claude is doing.
</p>

<p align="center">
  <a href="https://github.com/edmerrett/clawdbox/actions/workflows/ci.yml"><img src="https://github.com/edmerrett/clawdbox/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node 20+">
  <img src="https://img.shields.io/badge/panel-Divoom%20TimeBox%20Evo-orange" alt="Divoom TimeBox Evo">
</p>

---

Claude reads a file, Clawd puts on a detective hat and peers through a magnifying glass. Claude edits code,
Clawd types on a tiny laptop. Claude runs a shell command, Clawd skateboards. Claude needs you, Clawd holds up a
big question mark. Leave it alone for ten minutes and Clawd makes a coffee. Say thanks and you get a heart.

| | | | |
|:-:|:-:|:-:|:-:|
| ![idle](docs/sprites/idle.gif) | ![thinking](docs/sprites/thinking.gif) | ![reading](docs/sprites/reading.gif) | ![writing](docs/sprites/writing.gif) |
| **idle** | **thinking** | **reading** | **writing** |
| ![running](docs/sprites/running.gif) | ![needs-you](docs/sprites/needs-you.gif) | ![coffee](docs/sprites/coffee.gif) | ![vibing](docs/sprites/vibing.gif) |
| **running** | **needs-you** | **coffee** (10 min idle) | **vibing** (20 min idle) |
| ![ultrathink](docs/sprites/ultrathink.gif) | ![done](docs/sprites/done.gif) | ![error](docs/sprites/error.gif) | ![heart](docs/sprites/heart.gif) |
| **ultrathink** | **done** | **error** | **heart** |

## How it works

```
Claude Code ──hook──▶ unix socket (0600) ──▶ clawdbox daemon ──▶ Divoom panel
                                                    ├─ reducer    hook events → per-session state, most urgent wins
                                                    ├─ scheduler  hold ≥2 s, switch at loop boundary, flashes jump the queue
                                                    └─ display    BLE bridge (newer Evo) or Bluetooth serial (original Evo)
```

Claude Code's [hooks](https://code.claude.com/docs/en/hooks) fire on every tool call, prompt, permission request
and stop. Each one POSTs a little JSON to the daemon's private Unix socket in the background and never waits for an
answer.
The daemon works out what Clawd should be doing, smooths out the flicker of rapid tool calls, and streams the
right loop to the panel. A browser previewer shows the same thing. On macOS one app, `Clawdbox.app`, hosts the
daemon (so it has Bluetooth permission), supervises it, and sits in the menu bar showing whether the panel is
connected and which state is up.

## What you need

- A **Divoom TimeBox Evo**. There are two very different devices sold under that name; see [Which Evo?](#which-evo).
- **macOS** (Linux works for the daemon too). **Node 20+**.
- For the newer Evo: **Python 3.10+**. The BLE protocol lives in the excellent
  [divoom-protocol](https://github.com/orionparrott/divoom-protocol) package.
- For the original Evo: Xcode command line tools, if a prebuilt `bluetooth-serial-port` binary is not available for your Node.

## Install (macOS, one command)

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

## States and reactions

| state | sticker | triggered by |
|---|---|---|
| `idle` | Clawd | `SessionStart`, `Stop`, `Notification(idle_prompt)`, or 90 s of silence while busy (Esc fires no `Stop`) |
| `thinking` | Clawd Lightbulb | `UserPromptSubmit`, every `PostToolUse`, unknown tools |
| `ultrathink` | Clawd Shiny | thinking, for the rest of a turn whose prompt contained "ultrathink" |
| `reading` | Clawd Magnifier | `PreToolUse` for Read, Grep, Glob, WebFetch, WebSearch, MCP tools that look like reads |
| `writing` | laptop, from the Clawd GIF | `PreToolUse` for Edit, Write, MultiEdit, NotebookEdit |
| `running` | Clawd Skateboard | `PreToolUse` for Bash |
| `needs-you` | question mark | `PermissionRequest`, `Notification(permission_prompt, elicitation_dialog, elicitation_url_dialog, agent_needs_input)`, `PreToolUse(AskUserQuestion)` |
| `coffee` | Clawd Coffee | idle for 10 min (`--coffee-min`) |
| `vibing` | Clawd Headphones | 10 min after coffee, then the two alternate |
| `wave` | Clawd wave | `SessionStart` with source `startup` |
| `done` | Clawd happy | `Stop` after a turn of 10 s or more |
| `error` | crying Clawd | `PostToolUseFailure` (not interrupts), `StopFailure` |
| `heart` | clawd heart | your prompt says thanks |

Flashes (`wave`, `done`, `error`, `heart`) last 3.5 s and jump the hold; `needs-you` jumps it too. Events from
subagents are ignored so Clawd doesn't flicker. With several sessions open, the most urgent state wins
(`needs-you` > `running` > `writing` > `reading` > `thinking` > `idle`).

The poses follow Anthropic's [Claude Code sticker set](https://www.stickermule.com/uk/claudecode); the body is
traced from the Clawd-with-laptop GIF. Clawd is Anthropic's character. This is a fan project.

## Which Evo?

| | Original Timebox Evo (2018–~2023) | Newer TimeBox-Evo-audio / Backpack M |
|---|---|---|
| Speaker shows up as | `Timebox-Evo-audio` | `TimeBox-Evo-audio` (capital B) |
| Display protocol | Bluetooth Classic serial, `01 … 02` packets | **Bluetooth Low Energy**, `FE EF AA 55` envelope, 30-command handshake |
| Its Classic serial port | drives the display | accepts bytes and ignores them |
| clawdbox flag | `--mac XX:XX:…` | `--ble` |

Not sure? `node dist/cli.js diag --mac XX:…` sends a settings query, brightness changes and a test image, and
tells you whether the box ever replied. Silence on every step means the newer one: use `--ble`.

### BLE modes

| flag | what happens on a state change | trade-off |
|---|---|---|
| `--ble` (default: stream) | each frame is pushed as a still at the frame's own timing | nothing stored on the panel, no transfer screen; ~4 fps cap |
| `--ble --upload` | the loop is uploaded (~0.5 s) and the panel plays it | the panel shows a transfer screen during every upload |
| `--ble --slots` | all loops uploaded once at startup, then one select command per change | experimental: the opcode that selects an uploaded slot is not yet known on this firmware (`--select HEX` to experiment) |

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
--idle-ms 90000           silence before a busy state falls back to idle
--coffee-min 10           minutes idle before the coffee/headphones stages start (0 disables)
--flash-ms 3500           how long wave/done/error/heart stay up
--port 7676               TCP port for the previewer and status
--socket PATH             Unix socket for hook events (default ~/Library/Application Support/clawdbox/hook.sock)
--tcp-events              also accept hook POSTs on the TCP port (for Claude Code's http hooks; less private)
--no-update-check         don't look for newer release tags
-v                        log every event
```

Hook events: `POST /event` on the Unix socket (JSON object → 204). TCP, loopback only: `GET /state`, `GET /anims`,
`POST /show/<state>` (force, for testing), `GET /` previewer. Every request needs a loopback `Host`; POSTs with a
foreign `Origin` are refused.

## Hooks

`install-hooks` registers an **async command hook** on every relevant event: a one-second `/usr/bin/curl` that
forwards the hook JSON to the daemon's `0600` Unix socket and always exits 0. Claude Code never waits for it, a
stopped daemon costs nothing, and no other local process can receive the payload. `install-hooks --http` uses
Claude Code's native `http` hook type over TCP instead (no shell, but Claude Code awaits it, reports a non-blocking
error per event while the daemon is down, and the port could be squatted; run the daemon with `--tcp-events`). See
[`hooks/claude-hooks.example.json`](hooks/claude-hooks.example.json). `uninstall-hooks` removes exactly what was added.

Prompt text is only ever pattern-matched in memory (for "thanks" and "ultrathink"). It is not logged or stored.

## Your own art

Every sprite is a few lines of ASCII in [`src/anim/clawd.ts`](src/anim/clawd.ts); `clawdbox sprites` regenerates
the JSON. Or draw in Aseprite/LibreSprite/Piskel and run `clawdbox build-anims`; states you don't draw fall back
to the built-ins. [`art/README.md`](art/README.md) has the workflow and the rules for art that reads on LEDs
(black background, saturated colours, nothing finer than 2 px, nothing faster than 150 ms).

## Protocol notes

- **Newer Evo (BLE):** all credit to [divoom-protocol](https://github.com/orionparrott/divoom-protocol), which
  decoded the handshake, the session token and the image preamble from iOS captures.
- **Original Evo (Classic):** `src/protocol/divoom.ts` follows RomRider's
  [PROTOCOL.md](https://github.com/RomRider/node-divoom-timebox-evo/blob/master/PROTOCOL.md) and
  [hass-divoom](https://github.com/d03n3rfr1tz3/hass-divoom), unit-tested against the documented layout. The
  macOS quirk: when the Mac auto-connects the speaker it opens the Evo's real serial channel itself and exposes it
  as `/dev/cu.Timebox-Evo-audio`; use `--serial` with that path rather than `--mac`.

## Prior art

Patterns borrowed from [divoom-claude-monitor](https://github.com/kryogenica/divoom-claude-monitor),
[tivoo-control](https://github.com/solar2ain/tivoo-control), [claude-busylight](https://github.com/alexx-avdeev/claude-busylight),
[claude-code-hue](https://github.com/Minetorpia/claude-code-hue) and the "Clauddy" trick of pre-uploading faces.

## Contributing

Issues and PRs welcome. `npm test` runs the suite (Node's built-in runner, no device needed), `npm run lint`
type-checks, `npm run format` runs Prettier. If you have a Divoom device this project doesn't support yet, open an
issue with the name it advertises and what `clawdbox diag` prints. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT. Clawd is Anthropic's character, reproduced here for a desk toy; this project is not affiliated with Anthropic or Divoom.
