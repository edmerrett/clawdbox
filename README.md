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

## Requirements
- macOS (Linux works too; the Bluetooth library supports both). Node 20+.
- An **original TimeBox Evo**: pairs like a Bluetooth speaker. The later BLE-only revision uses a different protocol and is not supported.
- Xcode command line tools (`xcode-select --install`) if a prebuilt `bluetooth-serial-port` binary is not available for your Node version.

## Quick start (Mac)
```bash
git clone https://github.com/edmerrett/clawdbox && cd clawdbox
npm install && npm run build
```
1. **Pair** the Timebox in System Settings → Bluetooth. Quit the Divoom phone app; the box accepts one client at a time.
2. **Find its address**:
   ```bash
   node dist/cli.js discover
   ```
3. **Smoke test** one animation on the device:
   ```bash
   node dist/cli.js send running --mac XX:XX:XX:XX:XX:XX
   ```
   **macOS gotcha.** When the Mac auto-connects the paired speaker it also opens the Evo's real serial channel
   itself and exposes it as a device file such as `/dev/cu.Timebox-Evo-audio`. A fresh Bluetooth open from our
   side then lands on a second, dead endpoint: it "connects", accepts bytes, and nothing renders. Two ways out:
   - **Use the device file** (preferred, no native module involved): `discover` lists any `/dev/cu.*` that looks
     like a Timebox; pass it as `--serial /dev/cu.Timebox-Evo-audio` instead of `--mac` on every command.
   - **Or free the channel**: power-cycle the Timebox and run the command within a few seconds of it reconnecting.
   `clawdbox diag` steps through brightness, still images and an animation and reports replies from the box,
   which tells you immediately whether you are on a live channel.
4. **Run the daemon** and open the previewer at <http://127.0.0.1:7676>:
   ```bash
   node dist/cli.js daemon --mac XX:XX:XX:XX:XX:XX -v
   ```
5. **Install the hooks** (merges into `~/.claude/settings.json`, keeps your existing hooks, backs the file up first):
   ```bash
   node dist/cli.js install-hooks
   ```
   Start a Claude Code session and watch the character change as Claude works.
6. **Run it at login** as a launchd agent that restarts itself:
   ```bash
   node dist/cli.js install-launchd --mac XX:XX:XX:XX:XX:XX
   ```
   Logs land in `~/Library/Logs/clawdbox/`.

No device yet? `npm run dev` runs the daemon with a mock link so you can develop hooks and art on the previewer.

## States
| state | triggered by |
|---|---|
| `idle` | `SessionStart`, `Stop`, `Notification(idle_prompt)`, or 90 s of silence while busy (Esc interrupts fire no `Stop`) |
| `thinking` | `UserPromptSubmit`, every `PostToolUse`, unknown tools |
| `reading` | `PreToolUse` for Read, Grep, Glob, WebFetch, WebSearch, and MCP tools that look like reads |
| `writing` | `PreToolUse` for Edit, Write, MultiEdit, NotebookEdit |
| `running` | `PreToolUse` for Bash |
| `needs-you` | `PermissionRequest`, `Notification(permission_prompt / elicitation_dialog)`, `PreToolUse(AskUserQuestion)` |

Events from subagents (`agent_id` set) are ignored so the character does not flicker. With several sessions,
the most urgent state wins (`needs-you` > `running` > `writing` > `reading` > `thinking` > `idle`); sessions
silent for 6 h are forgotten.

## Hooks
`install-hooks` registers an **async command hook** on every relevant event: a one-second `curl` that forwards the
hook JSON to the daemon and always exits 0. Claude Code never waits for it, and a stopped daemon costs nothing.
`install-hooks --http` uses Claude Code's native `http` hook type instead (no shell, but Claude Code awaits it and
reports a non-blocking error for each event while the daemon is down). The generated config is in
[`hooks/claude-hooks.example.json`](hooks/claude-hooks.example.json). `uninstall-hooks` removes exactly what was added.

## Art
The built-in sprites (`src/anim/clawd.ts`) are traced cell-for-cell from the Clawd-with-laptop GIF: the 12x8
standing and crouching poses for idle, the sideways laptop-typing pose for writing, and the same body for the other
states. `clawdbox sprites` regenerates `art/anims/*.json` from them. To replace or refine them, draw in
Aseprite/LibreSprite or Piskel and run `clawdbox build-anims`, which writes the same `art/anims/<state>.json` files.
[`art/README.md`](art/README.md) has the full guide and the design rules for tiny LED matrices.

## Daemon options
```
--mac XX:XX:XX:XX:XX:XX   device address (required unless --serial or --mock)
--serial /dev/cu.NAME     use the OS serial device for the paired Evo instead of opening RFCOMM ourselves
--channel N               RFCOMM channel; auto-detected via SDP, falls back to 1
--anims DIR               animation directory (default art/anims if present, else placeholders)
--brightness 0-100        set panel brightness on connect
--hold-ms 2000            minimum time a state stays on screen
--idle-ms 90000           silence before a busy state falls back to idle
--port 7676               HTTP port (hooks must match)
-v                        log every event
```
HTTP API: `POST /event` (hook JSON → 204), `GET /state`, `GET /anims`, `POST /show/<state>` (force, for testing), `GET /` previewer.

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
