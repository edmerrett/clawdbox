# Sharing clawdbox

Assets in this folder: `clawdbox-explainer.mp4` (37 s, 1080×1080, narrated, captions burned in), `poster.png`
(thumbnail) and `clawdbox-explainer.gif` (the README hero). Upload the MP4 natively rather than linking YouTube:
LinkedIn autoplays native video, muted, so the captions carry it until someone turns the sound on.

## Post

My desk now has a tiny orange colleague who reacts to what Claude Code is doing.

Claude reads a file, Clawd puts on a detective hat. Claude edits code, Clawd types on a tiny laptop. Claude runs a
command, Clawd skateboards. Claude needs me, Clawd holds up a question mark. Leave it for ten minutes and Clawd
makes a coffee. Say thanks and you get a heart.

It is called clawdbox, and it is open source.

How it works: Claude Code has hooks that fire on every tool call, prompt, permission request and stop. A small
daemon on the Mac turns those into one of thirteen states and streams pixel art to a 16×16 Divoom LED panel over
Bluetooth. The poses are borrowed from Anthropic's Claude Code stickers.

Things I learned building it:

• Hooks are a surprisingly good event stream. Eleven events cover everything an observer needs, and they run in
the background, so Claude never waits on the LEDs.
• The two generations of Divoom TimeBox Evo look identical and speak completely different protocols. Ask me how
long that took to find out.
• The hard part was not the LEDs, it was the state machine: hold each state long enough to read, switch on a loop
boundary, let a flash like the heart jump the queue.
• Rapid tool calls look like strobing. A two-second minimum hold made it watchable.

One command installs it, a menu bar app shows connection and state, and it updates itself from GitHub releases.

Repo: github.com/edmerrett/clawdbox

Clawd is Anthropic's character; this is a desk toy, not an affiliation.

#ClaudeCode #OpenSource #DeveloperTools #PixelArt #Maker

## Shorter version

Claude Code now has a desk companion. Clawd lives on a 16×16 Divoom LED panel and acts out what Claude is doing:
detective hat for reading, tiny laptop for editing, skateboard for shell commands, a question mark when it needs
you, a coffee when you have wandered off.

It runs on Claude Code's hooks, a small Mac daemon and Bluetooth. Thirteen states, one-command install, open
source: github.com/edmerrett/clawdbox

#ClaudeCode #OpenSource #PixelArt
