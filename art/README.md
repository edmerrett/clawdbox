# Drawing the sprites

The daemon needs six looping animations, one per state, as `art/anims/<state>.json`:

| state | when | suggested loop |
|---|---|---|
| `idle` | waiting for your prompt, or no session | bob 1 px up/down, blink now and then (4–6 frames, ~200 ms) |
| `thinking` | Claude is generating between tools | ellipsis dots above the head (4–5 frames, ~250 ms) |
| `reading` | Read / Grep / Glob / WebFetch | holding or looking at a page, lines scroll (3–4 frames, ~250 ms) |
| `writing` | Edit / Write / MultiEdit | typing: text appears, cursor blinks (6–8 frames, ~150 ms) |
| `running` | Bash | running pose, speed lines, fast bob (4 frames, ~110 ms) |
| `needs-you` | permission prompt / question | big `?` pulsing, wide eyes (2 frames, ~400 ms) |

The files in `anims/` right now are procedural placeholders (`clawdbox placeholders` regenerates them).

## Rules that make 16x16 LED art read well
- Black background. Black pixels are LEDs that are off; use that for eyes and outlines.
- Saturated colours only; pastels wash out to white. Pure blue is dim, cyan is not.
- Minimum feature size 2 px. One-pixel details vanish from more than a metre away.
- At most ~5 colours per sprite. Keep a fixed palette across all six so transitions do not jump.
- Share a base pose: same body position in every state so switching does not teleport the character.
- 2–8 frames per loop, 100–400 ms per frame. The device streams the whole loop once per state change, so keep each animation under ~5 KB (about 12 frames of a 16-colour sprite).
- Do not darken the art to dim it. Brightness is a device setting (`--brightness`).

## Workflow A: Aseprite / LibreSprite (recommended)
1. One 16x16 file, one layer group per state if you like, a **frame tag per state** named exactly `idle`, `thinking`, `reading`, `writing`, `running`, `needs-you`. Set per-frame durations in the timeline.
2. Export:
   ```bash
   aseprite -b art/clawd.aseprite --sheet art/sheet.png --data art/sheet.json --list-tags --format json-array
   ```
3. Build and preview:
   ```bash
   npx clawdbox build-anims art/sheet.json
   npm run dev            # then open http://127.0.0.1:7676
   ```
Commit `clawd.aseprite`, `sheet.png`, `sheet.json` and the generated `anims/*.json`.

## Workflow B: Piskel (free, in the browser)
1. One Piskel project per state, 16x16. Export → Spritesheet, **1 row**, scale 1x, as `art/strips/<state>.png`.
2. `npx clawdbox build-anims art/strips --fps 6` (one global frame rate; Piskel can't export per-frame timing).

## File format
```json
{ "name": "idle", "frames": [ { "ms": 200, "palette": ["#000000", "#da7756"], "idx": [0,0,1, ...256 entries...] } ] }
```
`idx` is row-major, top-left first, index `x + 16*y`. This is the device's native palette-index layout, so it is cheap to encode.
