# Clawdbox for Claude Code

The menu bar's digital Divoom as a Claude Code mod: a 16×16 TimeBox in a pane on the right of the chat, with
Clawd acting out whatever Claude is doing in that session. It plays the same thirteen animations as the real panel
([`art/anims`](../art/anims)), and you don't need the panel, the daemon or a Mac.

| Where | What you see |
|---|---|
| Terminal (fullscreen layout, 110+ columns) | docked on the right: a 32×16-cell LED grid in a rounded bezel, state underneath |
| Terminal (narrower, or the main screen) | inline above the prompt; under 36 columns it switches to half blocks (16×8 cells) |
| Desktop app, VS Code, mobile | the menu bar's TimeBox drawn as an animated SVG; as a desktop widget, just the panel |

## Install

At the prompt of a terminal session:

```
/plugin install clawdbox --marketplace edmerrett/clawdbox
```

Answer `y` to add the marketplace (`github:edmerrett/clawdbox`), then choose a scope: user installs it for every
session. It is active at once, with no restart. From a shell instead:

```bash
claude plugin install clawdbox --marketplace edmerrett/clawdbox
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with
`edmerrett/clawdbox`, then Add plugin. A mod installed from a terminal at the user scope loads in the desktop app's
local sessions too.

The pane opens when an interactive session starts. `/clawdbox` opens it again and `/clawdbox close` hides it. When
there is nowhere to draw it, `/clawdbox` says why, and Clawd's state shows on the status line meanwhile.

To run it from a checkout while working on it, point Claude Code at the folder instead:

```bash
claude --plugin-dir ~/Tools/clawdbox/mod
```

## What Clawd does

The rules are the daemon's ([docs/STATES.md](../docs/STATES.md)), fed by the mod's events instead of HTTP hooks:

| Mod event | Clawd |
|---|---|
| `session.start` (a new session) | **wave**, then **idle** |
| `turn.start` | **thinking**; **ultrathink** if the prompt says so; a **heart** if it says thanks |
| `tool.call` | **reading** (Read, Grep, Glob, web, read-like MCP tools), **writing** (Edit, Write, …), **running** (Bash), **needs-you** (AskUserQuestion), else thinking; back to thinking when the tool ends, with an **error** flash if it failed |
| `tool.check` answered `ask` for a person | **needs-you** until the tool runs |
| `turn.complete` | **idle**; **done** after a turn of 10 s or more, **error** on an API error, nothing on Esc |
| 10 / 20 idle minutes | **coffee**, then **vibing**, alternating |

Subagents' tools and turns are ignored, as the daemon ignores them, so Clawd doesn't flicker.

## How it works

- `hooks/register.tsx`: the hooks. State lives in `$.state` (so a hot reload keeps it). A `ui.render` hook draws
  the `Pane`. In the terminal that is a `Raster` that a `$.clock.after` ticker repaints with `$.ui.blit` on each
  frame boundary (it only ticks fast while a Raster is mounted). Elsewhere it is an `Svg` whose frames SMIL animates
  on its own.
- `hooks/clawd.ts`: everything without `$`: the state rules, frame timing, the Raster's cell encoding and the SVG.
- `hooks/sprites.ts`: generated from `art/anims/*.json` by `npm run mod:sprites`. `npm test` fails if it is out of
  date.

## Developing

```bash
claude plugin validate mod
```

```bash
claude plugin test mod
```

Type-checking needs the types Claude Code writes to `mod/.claude-plugin/types/` the first time it loads the mod
(git ignores them); after that, `tsc -p` with a tsconfig that extends `.claude-plugin/types/tsconfig.json`.
