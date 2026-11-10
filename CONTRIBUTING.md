# Contributing

Thanks for helping Clawd out.

## Dev loop
```bash
npm install
npm run dev          # daemon against a mock panel, previewer at http://127.0.0.1:7676
npm test             # unit tests (node:test), no device needed
npm run lint         # tsc --noEmit
npm run format       # prettier
```
Fire a fake hook at the running daemon:
```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"PreToolUse","tool_name":"Read","session_id":"dev"}' http://127.0.0.1:7676/event
```

## Layout
- `src/protocol/` Divoom Classic packet encoder (original Evo). Pure functions, fully unit-tested.
- `src/daemon/` reducer (events → state), scheduler (when to switch), displays (BLE bridge, Classic link, mock), HTTP server.
- `src/anim/` sprite types, loader, and the built-in Clawd poses as ASCII art.
- `src/tools/` art importer and the hooks / launchd installers.
- `bridge/` Python BLE bridge for the newer Evo, on top of divoom-protocol.
- `menubar/` Clawdbox.app: Swift menu bar app and daemon host.
- `web/` the previewer page.

## Adding a state
1. Add the name to `STATES` (and `ACTIVITY_STATES` or `FLASH_STATES`) in `src/anim/types.ts`.
2. Draw it in `src/anim/clawd.ts` and add it to `clawdSprites()`.
3. Map events to it in `src/daemon/reducer.ts`; add a test in `test/reducer.test.ts`.
4. `npm run sprites` to regenerate `art/anims/`, then `scripts/render-gifs.py` for the README sprite GIFs and
   `node scripts/render-promo.mjs --voice docs/promo/voice` for the explainer video (needs Playwright and ffmpeg; edit
   `docs/promo/explainer.html`; narration text in `docs/promo/voice/script.txt`, regenerated with `scripts/make-voice.sh`).

## Art rules for LEDs
Black background, saturated colours, nothing finer than 2 px, no frame shorter than 150 ms, same feet row in every
pose. `npm test` enforces the frame-time rule.

## Supporting another Divoom device
Open an issue with: the Bluetooth name(s) it advertises, whether it pairs as a speaker, and the output of
`node dist/cli.js diag --mac <addr>` and `node dist/cli.js ble-scan`.

## Pull requests
Keep them focused. CI runs lint, format check, tests and a mock run on macOS and Linux, plus a ruff check of the
bridge and a Swift build of the menu bar app.
