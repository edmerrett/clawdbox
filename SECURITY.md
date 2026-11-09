# Security

clawdbox runs entirely on your machine.

- The daemon listens on **127.0.0.1 only** (`--port`, default 7676). It accepts hook JSON on `POST /event` with a
  1 MB body limit, and `POST /show/<state>` to force a state. Any local process can call these; the worst outcome
  is a wrong sprite on the panel.
- Hook payloads include your prompt text. The daemon pattern-matches it in memory for "thanks" and "ultrathink"
  and never logs or stores it, even with `-v`.
- `install-hooks` edits `~/.claude/settings.json` and writes a `.clawdbox.bak` copy first. `install-launchd` writes
  `~/Library/LaunchAgents/com.clawdbox.daemon.plist` and `~/Applications/Clawdbox.app`. Nothing is written outside
  your home directory and nothing runs as root.
- The Python bridge talks only to the Divoom over Bluetooth and to the daemon over stdio.

To report a problem, open a GitHub issue or email the maintainer listed in `package.json`.
