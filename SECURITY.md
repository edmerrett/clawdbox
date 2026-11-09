# Security

clawdbox runs entirely on your machine.

- The daemon listens on **127.0.0.1 only** (`--port`, default 7676). It accepts hook JSON on `POST /event`
  (must be `application/json`, a JSON object, under 1 MB) and `POST /show/<state>` to force a state. Any local
  process can call these; the worst outcome is a wrong sprite on the panel.
- Web pages cannot reach it: POSTs that carry an `Origin` header from anywhere but the daemon's own origin are
  refused with 403, and no CORS headers are sent, so a browser tab can neither forge events nor read `/state`.
- Hook payloads include your prompt text. The daemon pattern-matches it in memory for "thanks" and "ultrathink"
  and never logs or stores it, even with `-v`.
- `install-hooks` edits `~/.claude/settings.json` atomically (temp file + rename), keeps a `.clawdbox.bak` of the
  pristine file, only ever adds or removes entries tagged `statusMessage: "clawdbox"`, and refuses daemon URLs that
  could escape the shell command it writes. `install-launchd` writes
  `~/Library/LaunchAgents/com.clawdbox.daemon.plist` and `~/Applications/Clawdbox.app`. Nothing is written outside
  your home directory and nothing runs as root.
- The Python bridge talks only to the Divoom over Bluetooth and to the daemon over stdio.

To report a problem privately, use GitHub's "Report a vulnerability" on the repository's Security tab, or email the maintainer listed in `package.json`.
