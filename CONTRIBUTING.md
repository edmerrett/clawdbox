# Contributing

Thanks for helping Clawd out.

## Dev loop
Work in your own clone, not in an install's checkout (`~/Tools/clawdbox` belongs to the auto-updater):
```bash
git clone https://github.com/edmerrett/clawdbox ~/src/clawdbox && cd ~/src/clawdbox
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
4. `npm run sprites` to regenerate `art/anims/`, then `scripts/render-gifs.py` for the README sprite GIFs.

## Art rules for LEDs
Black background, saturated colours, nothing finer than 2 px, no frame shorter than 150 ms, same feet row in every
pose. `npm test` enforces the frame-time rule.

## Supporting another Divoom device
Open an issue with: the Bluetooth name(s) it advertises, whether it pairs as a speaker, and the output of
`node dist/cli.js diag --mac <addr>` and `node dist/cli.js ble-scan`.

## Releasing
1. In a PR, bump `version` in `package.json` and `package-lock.json` and turn `## Unreleased` in CHANGELOG.md into
   `## <version>`. Merge it once CI is green.
2. Tag the merged commit on `main` with a **signed** annotated tag, check it, and push it:
   ```bash
   git fetch origin main --tags
   git tag -s v<version> -m "clawdbox <version>" origin/main
   git show v<version>:package.json | grep '"version"'          # must be <version>
   scripts/verify-release.sh scripts/release-signers v<version> # must print Good "git" signature
   git push origin v<version>
   ```
   Tag only after the version bump is on `main`. The release workflow refuses a tag that does not match
   `package.json`, or that is not signed by a key in `scripts/release-signers`, and installs refuse unsigned tags
   too. `git config tag.gpgSign true` stops you forgetting `-s`.
3. Pushing the tag runs the release workflow, which publishes the GitHub release with build provenance. Installs
   pick it up within six hours, or at once with Check for Updates….

## Pull requests
Keep them focused. `main` only changes through squash-merged PRs, and every check must pass: lint, format and tests
on macOS and Linux with Node 20 and 22, a ruff check of the bridge, the Swift build and a live run of the menu bar
app, and CodeQL. Add a CHANGELOG entry under `## Unreleased` for anything a user would notice.

## Repository settings
Branch and tag protection live in [`.github/rulesets/`](.github/rulesets). After changing them, a repository admin
runs `scripts/apply-repo-settings.sh` (needs the GitHub CLI) to apply them, along with the merge, Dependabot,
secret-scanning and Actions settings it lists.
