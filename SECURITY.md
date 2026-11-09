# Security

clawdbox runs entirely on your machine.

- **Hook events** (which include your prompt text and tool inputs) travel from Claude Code to the daemon over a
  **Unix domain socket** with mode `0600` in a `0700` directory under your home folder. Only your user can connect
  to it, so another local process cannot capture the stream by binding a port first. `--tcp-events` (needed for
  Claude Code's native `http` hooks) re-enables TCP delivery and gives that protection up.
- The **TCP port** (`--port`, default 7676) binds to **127.0.0.1 only** and serves the previewer, `GET /state`,
  `GET /anims` and `POST /show/<state>`. Any local process can read the state or force a sprite; the worst outcome
  is a wrong sprite on the panel. Bodies are capped at 1 MB, connections and request time are limited.
- **Browsers**: every request must carry a loopback `Host` header (a DNS-rebinding page's requests carry its own
  domain and get 421), POSTs with a foreign `Origin` get 403, no CORS headers are sent, and the previewer page is
  served with a Content-Security-Policy. A web page can neither forge events nor read `/state`.
- Hook payloads include your prompt text. The daemon pattern-matches it in memory for "thanks" and "ultrathink"
  and never logs or stores it, even with `-v`.
- `install-hooks` edits `~/.claude/settings.json` atomically (temp file + rename), preserving its mode (that file
  can hold API keys), refuses to overwrite a file that changed underneath it, only ever adds or removes entries tagged
  `statusMessage: "clawdbox"`, and only writes socket paths and URLs that cannot escape the shell command. The hook
  command pins `/usr/bin/curl`. A `.clawdbox.bak` with the original mode is kept until `uninstall-hooks`.
- **Updates and trust.** `clawdbox update` follows release tags (not `main`), installs Node dependencies with
  `--ignore-scripts`, builds into a staging directory and rolls back on failure. The Python dependency is pinned.
  Unattended auto-update is **opt-in**; enabling it means trusting whoever can push a `v*` tag to this repository.
  The daemon's only network egress is one `git ls-remote` of this repository every six hours (`--no-update-check`
  disables it); the updater, when enabled, fetches from GitHub, npm and PyPI.
- **Menu bar app.** "Install Update…" runs `scripts/update.sh` from the checkout named in the launchd plist the
  installer wrote, verified to be under your home folder and to be a clawdbox package. It never executes a path
  received from the daemon.
- **Installer.** `install.sh` is a single function (a truncated download runs nothing), adopts the current
  directory only when it is a checkout of the official repository, never falls back from `npm ci` to `npm install`,
  and kills processes by exact path. Tagged releases publish `SHA256SUMS` covering `install.sh`. `install-launchd` writes
  `~/Library/LaunchAgents/com.clawdbox.daemon.plist` and `~/Applications/Clawdbox.app`. Nothing is written outside
  your home directory and nothing runs as root.
- The Python bridge talks only to the Divoom over Bluetooth and to the daemon over stdio.

To report a problem privately, use GitHub's "Report a vulnerability" on the repository's Security tab, or email the maintainer listed in `package.json`.
