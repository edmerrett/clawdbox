# Security

## Reporting a vulnerability

Please report privately with GitHub's **Report a vulnerability** on the repository's
[Security tab](https://github.com/edmerrett/clawdbox/security/advisories/new), not in a public issue. Fixes go into
the next release, and only the latest release is supported: the auto-updater moves every install onto it.

## What runs on your machine

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
  The six-hourly auto-updater is installed by default (`--no-auto-update` to skip it). It installs a `v*` tag only
  when the tag is an annotated tag, named as its ref says, with a good SSH signature from a key in
  `scripts/release-signers`. That file is read from the checkout already installed, so a new tag cannot vouch for
  itself, and the verifier is pinned to `ssh-keygen` whatever your git config says. Push access to the repository
  alone therefore cannot ship an update: it also takes the release signing key. A tag that fails the check is
  refused (and blocks updates until it is removed or replaced), and nothing on `main` reaches an install until it is
  tagged. `--main` follows `main` without signature checks. Git checks each object's hash and `npm ci` checks every
  package against the sha512 in `package-lock.json`; the Python bridge dependency is pinned by version only.
  The daemon's only network egress is one `git ls-remote` of this repository every six hours (`--no-update-check`
  disables it); the updater, when enabled, fetches from GitHub, npm and PyPI.
- **Clawdbox.app.** It is built on your Mac from source. It is signed ad-hoc, or with the self-signed
  "Clawdbox Local Signing" certificate that `menubar/make-signing-cert.sh` creates in your login keychain. That
  certificate only keeps the app's identity, and with it the Bluetooth permission, stable across rebuilds. It is
  not an Apple Developer ID, never leaves your Mac, and `menubar/uninstall.sh` removes it. The app hosts the daemon from a config file (`~/Library/Application Support/clawdbox/daemon.json`,
  mode 0600) that must point inside your home folder at clawdbox's own CLI; "Install Update…" runs
  `scripts/update.sh` from the checkout named in the launchd plist, verified the same way. Nothing it executes
  comes from the network.
- **Installer.** `install.sh` is a single function (a truncated download runs nothing), adopts the current
  directory only when it is a checkout of the official repository, never falls back from `npm ci` to `npm install`,
  and kills processes by exact path. Tagged releases publish `SHA256SUMS` covering `install.sh`. `install-launchd` writes
  `~/Library/LaunchAgents/com.clawdbox.daemon.plist` and `~/Applications/Clawdbox.app`. Nothing is written outside
  your home directory and nothing runs as root.
- **Restarts after an update** go through the launchd agent. If Clawdbox.app is running outside it, `update.sh`
  quits it by exact process name and reopens `~/Applications/Clawdbox.app`.
- The Python bridge talks only to the Divoom over Bluetooth and to the daemon over stdio.

## How the repository is protected

- `main` changes only through squash-merged pull requests. Every CI job (tests on macOS and Linux, the bridge
  lint, the menu bar app build) and CodeQL must pass. Force-pushes and deletion are blocked.
- Only repository admins can create, move or delete `v*` release tags. Each tag must also carry an SSH signature
  from `scripts/release-signers`, which installs check (above) and the release workflow re-checks before building.
- Releases are built by GitHub Actions with a [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations):
  `gh attestation verify <file> --repo edmerrett/clawdbox` proves a download came from that workflow.
- Workflows run with read-only tokens unless a job needs more, pin every action to a commit SHA, and do not keep
  git credentials in the checkout. Dependabot proposes dependency and action updates weekly. Secret scanning with
  push protection is on.
- The rulesets live in [`.github/rulesets/`](.github/rulesets) and are applied with `scripts/apply-repo-settings.sh`.
