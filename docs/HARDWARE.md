# Hardware: which Divoom, which transport

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

## Phone interference
The Divoom phone app reconnects to the box whenever it sees it, and the box accepts one controller at a time. You do
not need the phone's Bluetooth off, only the Divoom app's access to it: iOS Settings → Privacy & Security → Bluetooth →
Divoom off (Android: Apps → Divoom → Permissions → Nearby devices). Once the daemon holds the connection the phone
cannot take it; the race only exists while the box is free (power cycle, daemon restart, login).
