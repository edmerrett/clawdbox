/**
 * Clawdbox as a Claude Code mod: the menu bar's digital Divoom in a pane beside the chat.
 *
 * Clawd acts out this session straight from Claude Code's own events (no daemon, no hooks
 * over HTTP, no Bluetooth): reading for Read/Grep, typing for Edit, skateboarding for Bash,
 * a question mark when a permission prompt is waiting for you, coffee after ten idle minutes.
 *
 * The terminal draws the 16x16 panel as a Raster and repaints it frame by frame with
 * `$.ui.blit`; the desktop app, VS Code and mobile get one SVG whose frames SMIL animates.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Clawd } from '../types'
import {
  activityForTool,
  cells,
  flash,
  frameAt,
  fresh,
  nextChangeAt,
  rasterSize,
  setActivity,
  shown,
  svg,
  toolEnded,
  turnEnded,
  turnStarted,
  type RasterSize,
  type Shown,
} from './clawd'

const PANE = 'clawdbox'
const TITLE = 'Clawdbox'
const LED = 'led'
/** Room for the 32-column panel inside its bezel (border and padding: 36), with a little to spare. */
const COLUMNS = 40

// Bump the tag when Clawd's fields change: it declines what an older version stored.
const clawd = atom({ plugin: 'clawdbox', key: 'clawd' } as const, null as Clawd | null, { shape: 'clawd-1' })

const CAPTION: Record<Shown, string> = {
  idle: 'idle',
  thinking: 'thinking',
  ultrathink: 'ultrathink',
  reading: 'reading',
  writing: 'writing',
  running: 'running',
  'needs-you': 'needs you',
  coffee: 'coffee break',
  vibing: 'vibing',
  wave: 'hello!',
  done: 'done',
  error: 'oops',
  heart: 'thanks!',
}

// The module's own variables start over on a reload; Clawd's state lives in $.state.
let timer: Timer | undefined
/** The Raster the terminal pane last drew, which blits must match; undefined when none is mounted. */
let mounted: RasterSize | undefined
let lastShown: Shown | undefined

async function change($: EngineInterface, fn: (s: Clawd, now: number) => Clawd) {
  const now = await $.clock.now()
  await update($, clawd, s => fn(s ?? fresh(now), now))
  void tick($)
}

/** Plays the panel: blits each frame to a mounted Raster and redraws when what is shown changes. */
async function tick($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  const now = await $.clock.now()
  const s = (await read($, clawd)) ?? fresh(now)
  const name = shown(s, now)
  const at = frameAt(name, now)
  if (name !== lastShown) {
    lastShown = name
    $.ui.invalidate('ui.render')
  } else if (mounted) {
    const size = mounted
    try {
      const r = await $.ui.blit({ requestId: PANE, key: LED, cells: cells(at.frame, size), columns: size.columns, rows: size.rows })
      if ('deny' in r && r.deny) mounted = undefined
    } catch {
      mounted = undefined // no surface to paint; the next terminal render mounts it again
    }
  }
  const due = nextChangeAt(s, now)
  let wait = mounted ? at.untilNext : 60_000
  if (due !== undefined) wait = Math.min(wait, due - now)
  schedule($, wait)
}

function schedule($: EngineInterface, ms: number) {
  timer?.cancel()
  timer = $.clock.after(Math.max(30, ms), () => void tick($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'clawdbox', description: "Show Clawd's Divoom beside the chat (/clawdbox close hides it)" })
    const now = await $.clock.now()
    // A reload keeps what Clawd was doing; a new session starts with a wave.
    if ((await read($, clawd)) === null) await update($, clawd, () => flash(fresh(now), 'wave', now))
    if (e.isInteractive) void $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS })
    void tick($)

    return next(e)
  })

  on('command.run', { command: 'clawdbox' }, async ($, e) => {
    if (/^\s*(close|hide|off)\s*$/i.test(e.args)) {
      await $.ui.close({ id: PANE })
      return { text: 'Clawdbox closed. /clawdbox brings it back.' }
    }
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS })
    void tick($)

    return { text: isPlaced ? 'Clawdbox is open.' : 'Clawdbox opens once the window has room for it.' }
  })

  // A turn of the main loop: thinking (or ultrathink), a heart if you said thanks.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await change($, (s, now) => turnStarted(s, e.text, now))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await change($, (s, now) => turnEnded(s, e.reason, now))
    return next(e)
  })

  // Tools set the pose while they run; subagents' tools are ignored so Clawd doesn't flicker.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await change($, (s, now) => setActivity(s, activityForTool(e.tool), now))
    let isError = false
    try {
      const r = await next(e)
      isError = 'isError' in r && r.isError === true && !next.signal.aborted
      return r
    } finally {
      await change($, (s, now) => (next.signal.aborted ? setActivity(s, 'idle', now) : toolEnded(s, isError, now)))
    }
  }).catch(($, e, next) => next(e)) // Clawd only watches: a failure here must never stop the tool

  // A call that will be put to the person: Clawd holds up the question mark until it runs.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.approver === 'person' && e.tool_use_id && e.agentId === undefined) {
      await change($, (s, now) => setActivity(s, 'needs-you', now))
    }
    return verdict
  }).catch(($, e, next) => next(e)) // nor change the engine's verdict

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await $.clock.now()
    const s = (await read($, clawd)) ?? fresh(now)
    const name = shown(s, now)
    lastShown = name
    const caption = CAPTION[name]

    if (e.surface === 'terminal') {
      const { Box, Text, Raster } = $.ui.resolve(e)
      const size = rasterSize(e.props.bodyColumns)
      const at = frameAt(name, now)
      // A Raster just mounted: wake the ticker for its next frame (it sleeps while none is shown).
      if (!mounted) schedule($, at.untilNext)
      mounted = size
      const frame = at.frame

      return (
        <Box flexDirection="column" alignItems="center">
          <Box borderStyle="round" borderColor="#3a3a3a" backgroundColor="#292929" paddingX={1}>
            <Raster key={LED} columns={size.columns} rows={size.rows} cells={cells(frame, size)} />
          </Box>
          <Text dimColor>{caption}</Text>
        </Box>
      )
    }

    const { Box, Text, Svg } = $.ui.resolve(e)
    const isWidget = e.props.placement === 'widget'
    const px = isWidget ? 96 : 176

    return (
      <Box flexDirection="column" alignItems="center">
        <Svg source={svg(name)} alt={`Clawd on a Divoom panel: ${caption}`} width={px} height={px} />
        {!isWidget && <Text dimColor>{caption}</Text>}
      </Box>
    )
  })
}
