<p align="center">
  <img src="docs/promo/clawdbox-explainer.gif" alt="How clawdbox works, animated" width="640">
</p>

<h1 align="center">clawdbox</h1>

<p align="center">
  A desk companion for <a href="https://claude.com/claude-code">Claude Code</a>.<br>
  Clawd lives on a 16×16 Divoom LED panel and acts out whatever Claude is doing.
</p>

<p align="center">
  <a href="https://github.com/edmerrett/clawdbox/actions/workflows/ci.yml"><img src="https://github.com/edmerrett/clawdbox/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/edmerrett/clawdbox/releases"><img src="https://img.shields.io/github/v/release/edmerrett/clawdbox" alt="release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
</p>

---

Claude reads a file, Clawd puts on a detective hat. Claude edits code, Clawd types on a tiny laptop. Claude runs a
command, Clawd skateboards. Claude needs you, Clawd holds up a question mark. Leave it alone for ten minutes and
Clawd makes a coffee. Say thanks and you get a heart.

| | | | |
|:-:|:-:|:-:|:-:|
| ![idle](docs/sprites/idle.gif) | ![thinking](docs/sprites/thinking.gif) | ![reading](docs/sprites/reading.gif) | ![writing](docs/sprites/writing.gif) |
| **idle** | **thinking** | **reading** | **writing** |
| ![running](docs/sprites/running.gif) | ![needs-you](docs/sprites/needs-you.gif) | ![coffee](docs/sprites/coffee.gif) | ![heart](docs/sprites/heart.gif) |
| **running** | **needs you** | **coffee** | **thanks** |

Thirteen states in all, posed after Anthropic's [Claude Code stickers](https://www.stickermule.com/uk/claudecode).
[What triggers each one →](docs/STATES.md)

## Install

You need a **Divoom TimeBox Evo** paired to your Mac, **Node 20+** and **Python 3.10+**. Run this from Terminal.app:

```bash
curl -fsSL https://raw.githubusercontent.com/edmerrett/clawdbox/main/install.sh | bash
```

It installs the Claude Code hooks, builds `Clawdbox.app` (a menu bar item that also runs the daemon), registers it
to start at login with automatic release updates, and waits for Clawd to appear on the panel. Re-run it to update;
`uninstall.sh` removes everything. Two things to know first:

- Turn off the **Divoom app's Bluetooth permission** on your phone, or the app keeps grabbing the box.
- Have the **original 2018 Evo**? Add `--mac XX:XX:XX:XX:XX:XX` (`| bash -s -- --mac …`). [Which one do I have? →](docs/HARDWARE.md)

[Step-by-step install, daemon flags, hooks and updating →](docs/INSTALL.md)

## How it works

```
Claude Code ──hook──▶ private socket ──▶ clawdbox daemon ──▶ Bluetooth LE ──▶ Divoom panel
                                         ├─ reducer    which state Claude is in
                                         ├─ scheduler  hold ≥2 s, switch on a loop boundary, flashes jump the queue
                                         └─ display    stream Clawd's frames to the LEDs
```

Claude Code's [hooks](https://code.claude.com/docs/en/hooks) fire on every tool call, prompt, permission request and
stop. Each one posts a little JSON to the daemon's private Unix socket in the background and never waits. The daemon
works out what Clawd should be doing, smooths the flicker of rapid tool calls, and streams the right loop to the
panel. A browser previewer at <http://127.0.0.1:7676> shows the same thing; the menu bar shows connection and state,
and clicking it opens a small digital Divoom playing the current animation.

## Make it yours

Every sprite is a few lines of ASCII in [`src/anim/clawd.ts`](src/anim/clawd.ts), or draw your own in Aseprite or
Piskel and run `clawdbox build-anims`. [Art guide →](docs/ART.md)

## More

- [Hardware and protocols](docs/HARDWARE.md): the two Evos, BLE modes, prior art, phone interference
- [Security](SECURITY.md): what listens where, what the auto-updater trusts
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)
- The BLE protocol is [divoom-protocol](https://github.com/orionparrott/divoom-protocol)'s work; the Classic protocol follows
  [RomRider](https://github.com/RomRider/node-divoom-timebox-evo) and [hass-divoom](https://github.com/d03n3rfr1tz3/hass-divoom).

## Licence

MIT. Clawd is Anthropic's character, reproduced here for a desk toy; this project is not affiliated with Anthropic or Divoom.
