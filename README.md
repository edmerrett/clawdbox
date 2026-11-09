# clawdbox

A desk companion for Claude Code. Claude Code hooks tell a small daemon what Claude is doing, and the daemon
makes a pixel-art character act it out on a **Divoom TimeBox Evo** (16x16 Bluetooth LED matrix):
bobbing when idle, scanning a page while it reads, typing while it edits, sprinting while Bash runs,
and holding up a big `?` when it needs you.

```
Claude Code ──hook──▶ POST http://127.0.0.1:7676/event ──▶ clawdbox daemon ──Bluetooth SPP──▶ TimeBox Evo
                                                           ├─ reducer   hook events → per-session state, most urgent wins
                                                           ├─ scheduler hold ≥2 s, switch at loop boundary, needs-you jumps the queue, idle fallback
                                                           └─ device    one persistent RFCOMM socket, pre-encoded animations, ≤25 msgs/s
```

## Which Evo do you have?
Divoom shipped two very different devices under the TimeBox Evo name, and both pair as a Bluetooth speaker:

| | Original Timebox Evo (2018–~2023) | Newer TimeBox-Evo-audio / Backpack M (Anyka SoC) |
|---|---|---|
| Speaker shows up as | `Timebox-Evo-audio` | `TimeBox-Evo-audio` (capital B) |
| Display protocol | Bluetooth Classic serial (RFCOMM), `01 … 02` packets | **Bluetooth Low Energy**, `FE EF AA 55` envelope, 30-command handshake |
| Its Classic serial port | drives the display | accepts bytes and ignores them |
| clawdbox flag | `--mac XX:XX:…` | `--ble` |

If `clawdbox diag --mac …` connects but the panel never changes and the box never replies, you have the newer one: use `--ble`.

## Requirements
- macOS (Linux works too). Node 20+.
- **Newer Evo (`--ble`)**: Python 3.10+ and the [divoom-protocol](https://github.com/orionparrott/divoom-protocol) package, installed into a venv in this folder:
  ```bash
  python3 -m venv .venv && .venv/bin/pip install -r bridge/requirements.txt
  ```
  On macOS run clawdbox from **Terminal.app or iTerm2**: macOS only grants Bluetooth to processes launched by an app that declares it, and Python spawned from some other tools is killed on its first BLE call.
- **Original Evo (`--mac`)**: Xcode command line tools (`xcode-select --install`) if a prebuilt `bluetooth-serial-port` binary is not available for your Node version.

## Quick start (Mac)
```bash
git clone https://github.com/edmerrett/clawdbox && cd clawdbox
npm install && npm run build
```
1. **Pair** the Timebox in System Settings → Bluetooth. Turn the phone's Bluetooth **off**: the Divoom app reconnects to the box whenever it sees it, and the box accepts one controller at a time.
2. **Smoke test** one animation on the device.
   Newer Evo (BLE): the bridge scans for the box itself, connects, runs the ~3 s handshake, and uploads the loop:
   ```bash
   node dist/cli.js send writing --ble
   ```
   Original Evo (Classic): find the address, then send:
   ```bash
   node dist/cli.js discover
   node dist/cli.js send writing --mac XX:XX:XX:XX:XX:XX
   ```
   In the examples below, replace `--ble` with `--mac XX:…` for the original.
   **macOS gotcha.** When the Mac auto-connects the paired speaker it also opens the Evo's real serial channel
   itself and exposes it as a device file such as `/dev/cu.Timebox-Evo-audio`. A fresh Bluetooth open from our
   side then lands on a second, dead endpoint: it "connects", accepts bytes, and nothing renders. Two ways out:
   - **Use the device file** (preferred, no native module involved): `discover` lists any `/dev/cu.*` that looks
     like a Timebox; pass it as `--serial /dev/cu.Timebox-Evo-audio` instead of `--mac` on every command.
   - **Or free the channel**: power-cycle the Timebox and run the command within a few seconds of it reconnecting.
   `clawdbox diag` steps through brightness, still images and an animation and reports replies from the box,
   which tells you immediately whether you are on a live channel.
3. **Run the daemon** and open the previewer at <http://127.0.0.1:7676>:
   ```bash
   node dist/cli.js daemon --ble -v
   ```
4. **Install the hooks** (merges into `~/.claude/settings.json`, keeps your existing hooks, backs the file up first):
   ```bash
   node dist/cli.js install-hooks
   ```
   Start a Claude Code session and watch the character change as Claude works.
5. **Run it at login.** This writes a tiny `~/Applications/Clawdbox.app` wrapper (macOS grants Bluetooth per app, so
   a bare launchd job would be killed on its first Bluetooth call) and a launchd agent that keeps it running:
   ```bash
   node dist/cli.js install-launchd --ble
   ```
   Allow the one-time "Clawdbox would like to use Bluetooth" prompt. Logs land in `~/Library/Logs/clawdbox/`.
   `uninstall-launchd` removes both.
6. **Optional:** `npm link` puts a `clawdbox` command on your PATH so every command above works from any folder.

No device yet? `npm run dev` runs the daemon with a mock link so you can develop hooks and art on the previewer.

## States and reactions
The poses follow Anthropic's Claude Code sticker set. Activity states come from hook events; flashes are short
reactions layered on top; long-idle stages appear when nothing has happened for a while.

| state | sticker | triggered by |
|---|---|---|
| `idle` | Clawd | `SessionStart`, `Stop`, `Notification(idle_prompt)`, or 90 s of silence while busy (Esc interrupts fire no `Stop`) |
| `thinking` | Clawd Lightbulb | `UserPromptSubmit`, every `PostToolUse`, unknown tools |
| `ultrathink` | Clawd Shiny | same as thinking, for the rest of a turn whose prompt contained "ultrathink" |
| `reading` | Clawd Magnifier | `PreToolUse` for Read, Grep, Glob, WebFetch, WebSearch, and MCP tools that look like reads |
| `writing` | (laptop, from the Clawd GIF) | `PreToolUse` for Edit, Write, MultiEdit, NotebookEdit |
| `running` | Clawd Skateboard | `PreToolUse` for Bash |
| `needs-you` | (question mark) | `PermissionRequest`, `Notification(permission_prompt / elicitation_dialog)`, `PreToolUse(AskUserQuestion)` |
| `coffee` | Clawd Coffee | idle for 10 min (`--coffee-min`) |
| `vibing` | Clawd Headphones | 10 min after coffee; then the two alternate |
| `wave` (flash) | Clawd wave | `SessionStart` with source `startup` |
| `done` (flash) | Clawd happy | `Stop` after a turn that ran 10 s or more |
| `error` (flash) | (crying Clawd) | `PostToolUseFailure` (not interrupts), `StopFailure` |
| `heart` (flash) | clawd heart | your prompt says thanks |

Flashes last 3.5 s (`--flash-ms`) and jump the hold; `needs-you` also jumps it. Events from subagents (`agent_id`
set) are ignored so the character does not flicker. With several sessions, the most urgent state wins
(`needs-you` > `running` > `writing` > `reading` > `thinking` > `idle`); sessions silent for 6 h are forgotten.

## Hooks
`install-hooks` registers an **async command hook** on every relevant event: a one-second `curl` that forwards the
hook JSON to the daemon and always exits 0. Claude Code never waits for it, and a stopped daemon costs nothing.
`install-hooks --http` uses Claude Code's native `http` hook type instead (no shell, but Claude Code awaits it and
reports a non-blocking error for each event while the daemon is down). The generated config is in
[`hooks/claude-hooks.example.json`](hooks/claude-hooks.example.json). `uninstall-hooks` removes exactly what was added.

## Art
The built-in sprites (`src/anim/clawd.ts`) use the 12x8 Clawd body traced from the Clawd-with-laptop GIF, posed
after the Claude Code sticker set (magnifier, skateboard, lightbulb, shiny, coffee, headphones, happy, wave,
heart). `clawdbox sprites` regenerates `art/anims/*.json` from them. To replace or refine them, draw in
Aseprite/LibreSprite or Piskel and run `clawdbox build-anims`, which writes the same `art/anims/<state>.json` files.
[`art/README.md`](art/README.md) has the full guide and the design rules for tiny LED matrices.

## Daemon options
```
--ble                     newer Evo over BLE via bridge/clawdbox_ble.py (Python + divoom-protocol)
--address UUID            BLE address from "clawdbox ble-scan" (default: scan and take the first Divoom/TimeBox)
--stream                  BLE: push stills at the frame rate instead of uploading the loop to the panel (see below)
--python PATH             interpreter for the bridge (default .venv/bin/python, else python3)
--mac XX:XX:XX:XX:XX:XX   original Evo: device address (required unless --ble, --serial or --mock)
--serial /dev/cu.NAME     use the OS serial device for the paired Evo instead of opening RFCOMM ourselves
--channel N               RFCOMM channel; auto-detected via SDP, falls back to 1
--anims DIR               animation directory (default art/anims if present, else placeholders)
--brightness 0-100        panel brightness, applied on every (re)connect; default 100
--hold-ms 2000            minimum time a state stays on screen
--idle-ms 90000           silence before a busy state falls back to idle
--coffee-min 10           minutes idle before the coffee/headphones stages start (0 disables)
--flash-ms 3500           how long wave/done/error/heart stay up
--port 7676               HTTP port (hooks must match)
-v                        log every event
```
HTTP API: `POST /event` (hook JSON → 204), `GET /state`, `GET /anims`, `POST /show/<state>` (force, for testing), `GET /` previewer.

## BLE notes (newer Evo)
Three ways to get frames onto the panel, pick with a flag:

| mode | what happens on a state change | trade-off |
|---|---|---|
| `--ble` (stream, default) | each frame is pushed as a still at the frame's own timing | no transfer screen, nothing stored on the panel; capped around 4 fps and constant BLE traffic |
| `--ble --upload` | the loop is uploaded (~0.5 s) and the panel plays it | the panel shows its own transfer screen during every upload, which with frequent changes is most of the time |
| `--ble --slots` | all six loops are uploaded once at startup, then one select command per change | experimental: on the firmware tested, `45 04 N` plays Divoom's Signal presets and `45 06 N` shows an error screen; the opcode that selects an uploaded Custom slot is not yet known (`--select HEX` to experiment) |

divoom-protocol has not confirmed whether uploads write the panel's flash, which is another reason streaming is
the default for an always-on toy. The bridge reconnects and re-runs the
handshake by itself when the link drops, and re-uploads slots after a reconnect. If the panel stops reacting after
an unclean disconnect, power-cycle it.

## Protocol notes
The encoder (`src/protocol/divoom.ts`) follows RomRider's reverse-engineered
[PROTOCOL.md](https://github.com/RomRider/node-divoom-timebox-evo/blob/master/PROTOCOL.md) and the actively
maintained [hass-divoom](https://github.com/d03n3rfr1tz3/hass-divoom) implementation:
`01 LLLL PAYLOAD CRCR 02` framing with a 16-bit byte sum, `0x44` still images, `0x49` streamed animations in
200-byte chunks with per-frame palettes, `0x74` brightness. Everything is unit-tested against the documented
layout, but one detail is worded differently by the two sources: whether the animation header's total length counts
each frame's `AA` byte. We follow hass-divoom (it does). If animations with more than one chunk misbehave on your
unit, that is the first thing to check.

## Prior art
This project leans on patterns from [divoom-claude-monitor](https://github.com/kryogenica/divoom-claude-monitor),
[tivoo-control](https://github.com/solar2ain/tivoo-control), [claude-busylight](https://github.com/alexx-avdeev/claude-busylight),
[claude-code-hue](https://github.com/Minetorpia/claude-code-hue) and the Claude Code
[hooks reference](https://code.claude.com/docs/en/hooks).

## Licence
MIT for the code. The character is Anthropic's Clawd, reproduced here for a personal desk toy; Clawd is Anthropic's mark.
