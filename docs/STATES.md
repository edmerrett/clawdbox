# States and what triggers them

| state | sticker | triggered by |
|---|---|---|
| `idle` | Clawd | `SessionStart`, `Stop`, `Notification(idle_prompt)`, an interrupted tool, or a session going silent while busy (see [Interrupts](#interrupts-esc--stop)) |
| `thinking` | Clawd Lightbulb | `UserPromptSubmit`, every `PostToolUse`, unknown tools |
| `ultrathink` | Clawd Shiny | thinking, for the rest of a turn whose prompt contained "ultrathink" |
| `reading` | Clawd Magnifier | `PreToolUse` for Read, Grep, Glob, WebFetch, WebSearch, MCP tools that look like reads |
| `writing` | laptop, from the Clawd GIF | `PreToolUse` for Edit, Write, MultiEdit, NotebookEdit |
| `running` | Clawd Skateboard | `PreToolUse` for Bash |
| `needs-you` | question mark | `PermissionRequest`, `Notification(permission_prompt, elicitation_dialog, elicitation_url_dialog, agent_needs_input)`, `PreToolUse(AskUserQuestion)` |
| `coffee` | Clawd Coffee | idle for 10 min (`--coffee-min`) |
| `vibing` | Clawd Headphones | 10 min after coffee, then the two alternate |
| `wave` | Clawd wave | `SessionStart` with source `startup` |
| `done` | Clawd happy | `Stop` after a turn of 10 s or more |
| `error` | crying Clawd | `PostToolUseFailure` (not interrupts), `StopFailure` |
| `heart` | clawd heart | your prompt says thanks |

Flashes (`wave`, `done`, `error`, `heart`) last 3.5 s and jump the hold; `needs-you` jumps it too. Events from
subagents are ignored so Clawd doesn't flicker. With several sessions open, the most urgent state wins
(`needs-you` > `running` > `writing` > `reading` > `thinking` > `idle`).

The poses follow Anthropic's [Claude Code sticker set](https://www.stickermule.com/uk/claudecode); the body is
traced from the Clawd-with-laptop GIF. Clawd is Anthropic's character. This is a fan project.

## Hook events, in full

| Hook event | Detail | Result |
|---|---|---|
| `SessionStart` | any | **idle**, plus a **wave** flash when `source` is `startup` |
| `UserPromptSubmit` | prompt contains "ultrathink" | **ultrathink** for the rest of the turn |
| `UserPromptSubmit` | otherwise | **thinking**; a **heart** flash if the prompt says thanks |
| `PreToolUse` | Read, Grep, Glob, LS, NotebookRead, WebFetch, WebSearch, MCP tools named like read/get/list/search/fetch/query | **reading** |
| `PreToolUse` | Edit, Write, MultiEdit, NotebookEdit, MCP tools named like write/edit/create/update/apply | **writing** |
| `PreToolUse` | Bash | **running** |
| `PreToolUse` | AskUserQuestion | **needs-you** |
| `PreToolUse` | anything else | **thinking** |
| `PostToolUse` | any | **thinking** (or ultrathink) |
| `PostToolUseFailure` | not an Esc interrupt | **thinking**, plus an **error** flash |
| `PostToolUseFailure` | `is_interrupt` (you stopped the tool) | **idle** |
| `PermissionRequest` | any | **needs-you** |
| `PermissionDenied` | any | **thinking** |
| `Notification` | `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` | **needs-you** |
| `Notification` | `idle_prompt` | **idle** |
| `Notification` | anything else | ignored |
| `PreCompact`, `PostCompact` | | **thinking** |
| `Stop` | turn ran 10 s or more | **idle**, plus a **done** flash |
| `Stop` | shorter turn | **idle** |
| `StopFailure` | | **idle**, plus an **error** flash |
| `SessionEnd` | | session forgotten |

The installer subscribes to eleven events; the other Claude Code hook events are not registered and cost nothing.
Events with an `agent_id` (subagents) are ignored. Events for a session the daemon has never seen are ignored unless
they are `SessionStart`, `UserPromptSubmit` or `PreToolUse`. Ten idle minutes brings coffee, twenty brings
headphones, then they alternate.

## Interrupts (Esc / stop)

Claude Code runs no hook when you interrupt a turn: `Stop` "does not run if the stoppage occurred due to a user
interrupt", and nothing else takes its place. The daemon therefore reads silence as an interrupt, session by session:

| Session state | Silent for | Result |
|---|---|---|
| thinking, ultrathink, reading, writing | 60 s (`--idle-ms`) | that session goes **idle** |
| running, needs-you | 5 min (`--wait-ms`) | that session goes **idle** |
| running | 60 s (`--idle-ms`) | still **running**, but ranks below any session that is visibly active |

Running and needs-you wait longer because a long command and an unanswered prompt are silent for good reason. Each
session has its own clock, so another session's events do not keep an interrupted one alive, and an interrupted
session stops outranking the others: after 60 s the panel belongs to whichever session is still working. Subagent
events do not change the state but do count as a sign of life for their session. If Claude Code does report the
interrupt (`PostToolUseFailure` with `is_interrupt`), the session goes idle at once. A session that was wrongly
idled (a slow response with no tool calls) comes back on its next event.
