/**
 * What Clawd is doing, and how a frame of it is drawn: the pure half of the mod, no `$` in it.
 *
 * The rules follow the daemon's reducer (src/daemon/reducer.ts, docs/STATES.md), fed by the
 * mod's own events instead of HTTP hooks: one session, so no merging.
 */
import { SPRITES, type PackedFrame } from './sprites'

import type { Activity, Clawd, Flash } from '../types'

export type { Activity, Clawd, Flash }
export type Shown = Activity | Flash | 'ultrathink' | 'coffee' | 'vibing'

export const FLASH_MS = 3500
export const DONE_AFTER_MS = 10_000
/** Idle this long brings coffee; as long again brings headphones; then they alternate. */
export const IDLE_STAGE_MS = 10 * 60_000

export const THANKS = /\b(thanks?|thank you|cheers|nice one|ta)\b/i
export const ULTRA = /ultrathink/i

export function fresh(now: number): Clawd {
  return { activity: 'idle', since: now, ultra: false }
}

/** First match wins; anything else (an unknown tool, most MCP tools) is thinking. */
export function activityForTool(tool: string): Activity {
  if (/^(Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch)$/.test(tool)) return 'reading'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'writing'
  if (tool === 'Bash') return 'running'
  if (tool === 'AskUserQuestion') return 'needs-you'
  if (/^mcp__.*(read|get|list|search|fetch|query)/i.test(tool)) return 'reading'
  if (/^mcp__.*(write|edit|create|update|apply)/i.test(tool)) return 'writing'
  return 'thinking'
}

export function setActivity(s: Clawd, activity: Activity, now: number, patch: Partial<Clawd> = {}): Clawd {
  const since = activity === s.activity ? s.since : now
  return { ...s, ...patch, activity, since }
}

export function flash(s: Clawd, which: Flash, now: number): Clawd {
  return { ...s, flash: which, flashUntil: now + FLASH_MS }
}

/** A turn began with `text` as its prompt. */
export function turnStarted(s: Clawd, text: string, now: number): Clawd {
  const next = setActivity(s, 'thinking', now, { ultra: ULTRA.test(text), turnStartedAt: now })
  return THANKS.test(text) ? flash(next, 'heart', now) : next
}

/** A turn ended: answered, aborted (Esc), refused or killed by an API error. */
export function turnEnded(s: Clawd, reason: 'answer' | 'aborted' | 'refusal' | 'error', now: number): Clawd {
  const long = s.turnStartedAt !== undefined && now - s.turnStartedAt >= DONE_AFTER_MS
  const next = setActivity(s, 'idle', now, { ultra: false, turnStartedAt: undefined })
  if (reason === 'error') return flash(next, 'error', now)
  if (reason === 'answer' && long) return flash(next, 'done', now)
  return next
}

/** A tool call finished; `isError` for a failure that was not the person's interrupt. */
export function toolEnded(s: Clawd, isError: boolean, now: number): Clawd {
  const next = setActivity(s, 'thinking', now)
  return isError ? flash(next, 'error', now) : next
}

/** What the panel shows at `now`: a flash, an idle stage, or the activity itself. */
export function shown(s: Clawd, now: number): Shown {
  if (s.flash && s.flashUntil !== undefined && now < s.flashUntil) return s.flash
  if (s.activity === 'thinking' && s.ultra) return 'ultrathink'
  if (s.activity === 'idle') {
    const stage = Math.floor((now - s.since) / IDLE_STAGE_MS)
    if (stage >= 1) return stage % 2 === 1 ? 'coffee' : 'vibing'
  }
  return s.activity
}

/** When `shown` changes next without a new event (a flash ends, an idle stage starts), or undefined. */
export function nextChangeAt(s: Clawd, now: number): number | undefined {
  if (s.flash && s.flashUntil !== undefined && now < s.flashUntil) return s.flashUntil
  if (s.activity === 'idle') return s.since + (Math.floor((now - s.since) / IDLE_STAGE_MS) + 1) * IDLE_STAGE_MS
  return undefined
}

/* ---------- frames ---------- */

export const SIDE = 16
export const OFF = 0x171717
export const BEZEL = 0x292929

export function frames(name: Shown): readonly PackedFrame[] {
  return SPRITES[name] ?? SPRITES.idle!
}

export function loopMs(name: Shown): number {
  return frames(name).reduce((n, f) => n + f[0], 0)
}

/** The frame playing at `now` (loops share one clock) and the ms until the next one starts. */
export function frameAt(name: Shown, now: number): { index: number; frame: PackedFrame; untilNext: number } {
  const list = frames(name)
  const total = loopMs(name)
  let t = ((now % total) + total) % total
  for (let index = 0; index < list.length; index++) {
    const frame = list[index]!
    if (t < frame[0]) return { index, frame, untilNext: frame[0] - t }
    t -= frame[0]
  }
  return { index: 0, frame: list[0]!, untilNext: list[0]![0] }
}

/** 256 0xRRGGBB values; an unlit LED (black) is drawn as `OFF`, as the menu bar's panel draws it. */
export function rgb(frame: PackedFrame): number[] {
  const [, palette, pixels] = frame
  const out = new Array<number>(SIDE * SIDE)
  for (let i = 0; i < out.length; i++) {
    const c = palette[parseInt(pixels[i] ?? '0', 36)] ?? 0
    out[i] = c === 0 ? OFF : c
  }
  return out
}

/* ---------- terminal: Raster cells ---------- */

/** `big` (a pane body of 36+ columns, the bezel included): two columns by one row per LED (32x16, square
 * on most fonts). Otherwise half blocks (16x8). */
export type RasterSize = { columns: number; rows: number; big: boolean }

export function rasterSize(bodyColumns: number): RasterSize {
  return bodyColumns >= 36 ? { columns: 32, rows: 16, big: true } : { columns: 16, rows: 8, big: false }
}

const UPPER_HALF = 0x2580
const SPACE = 0x20

/** RasterProps `cells`: base64 of little-endian u32 triplets [codePoint, fg, bg], row-major. */
export function cells(frame: PackedFrame, size: RasterSize): string {
  const px = rgb(frame)
  const words = new Uint32Array(size.columns * size.rows * 3)
  let w = 0
  for (let y = 0; y < size.rows; y++) {
    for (let x = 0; x < size.columns; x++) {
      if (size.big) {
        const c = px[(x >> 1) + SIDE * y]!
        words[w++] = SPACE
        words[w++] = c
        words[w++] = c
      } else {
        words[w++] = UPPER_HALF
        words[w++] = px[x + SIDE * (2 * y)]!
        words[w++] = px[x + SIDE * (2 * y + 1)]!
      }
    }
  }
  return base64(littleEndian(words))
}

function littleEndian(words: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(words.length * 4)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < words.length; i++) view.setUint32(i * 4, words[i]!, true)
  return bytes
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const left = bytes.length - i
  if (left === 1) {
    const n = bytes[i]! << 16
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '=='
  } else if (left === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }
  return out
}

/* ---------- desktop, editor, mobile: one animated SVG ---------- */

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')

/** The TimeBox the menu bar draws (8pt pitch, 7pt LEDs, 10pt bezel), every frame of `name` in one SVG. */
export function svg(name: Shown): string {
  const list = frames(name)
  const total = loopMs(name)
  const cell = 8
  const bezel = 10
  const side = cell * SIDE + bezel * 2
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side}" height="${side}">`,
    `<rect width="${side}" height="${side}" rx="14" fill="${hex(BEZEL)}"/>`,
    `<rect x="${bezel - 2}" y="${bezel - 2}" width="${cell * SIDE + 4}" height="${cell * SIDE + 4}" rx="4" fill="#000"/>`,
    `<defs><pattern id="led" width="${cell}" height="${cell}" patternUnits="userSpaceOnUse" x="${bezel}" y="${bezel}">`,
    `<rect x="0.5" y="0.5" width="${cell - 1}" height="${cell - 1}" fill="${hex(OFF)}"/></pattern></defs>`,
    `<rect x="${bezel}" y="${bezel}" width="${cell * SIDE}" height="${cell * SIDE}" fill="url(#led)"/>`,
  ]
  let start = 0
  for (const frame of list) {
    const byColor = new Map<number, string>()
    const px = rgb(frame)
    px.forEach((c, i) => {
      if (c === OFF) return
      const x = bezel + (i % SIDE) * cell + 0.5
      const y = bezel + Math.floor(i / SIDE) * cell + 0.5
      byColor.set(c, (byColor.get(c) ?? '') + `M${x} ${y}h${cell - 1}v${cell - 1}h-${cell - 1}z`)
    })
    const paths = [...byColor].map(([c, d]) => `<path fill="${hex(c)}" d="${d}"/>`).join('')
    if (list.length === 1) {
      parts.push(`<g>${paths}</g>`)
      break
    }
    const a = start / total
    const b = (start + frame[0]) / total
    const [values, times] =
      a === 0 ? ['visible;hidden', `0;${round(b)}`] : b >= 1 ? ['hidden;visible', `0;${round(a)}`] : ['hidden;visible;hidden', `0;${round(a)};${round(b)}`]
    parts.push(
      `<g visibility="${a === 0 ? 'visible' : 'hidden'}">` +
        `<animate attributeName="visibility" values="${values}" keyTimes="${times}" dur="${total}ms" calcMode="discrete" repeatCount="indefinite"/>` +
        `${paths}</g>`,
    )
    start += frame[0]
  }
  parts.push('</svg>')
  return parts.join('')
}

const round = (n: number) => Math.round(n * 10000) / 10000
