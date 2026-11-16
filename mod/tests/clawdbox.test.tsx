import { expect, mock, test } from 'claude-code/testing'

import {
  activityForTool,
  cells,
  DONE_AFTER_MS,
  FLASH_MS,
  frameAt,
  fresh,
  IDLE_STAGE_MS,
  nextChangeAt,
  rasterSize,
  shown,
  svg,
  turnEnded,
  turnStarted,
} from '../hooks/clawd'

const PANE = {
  plugin: 'clawdbox',
  component: 'Pane',
  requestId: 'clawdbox',
  props: {
    title: 'Clawdbox',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

test('a new session waves, then settles to idle', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'clawdbox' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /hello!/ }))?.text).toBe('hello!')
    await ui.unmount()
  }

  await clock.advance(4000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /idle/ }))?.text).toBe('idle')
  await ui.unmount()
})

test('tools set the pose while they run, and failures flash', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'clawdbox' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  let seen = ''
  on('tool.call', async (_, e) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    seen = (await ui.find({ type: 'Text' }))?.text ?? ''
    await ui.unmount()
    return e.tool === 'Bash' ? { result: {}, isError: true } : { result: {} }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(4000)

  await $.tool.call({ tool: 'Read', file_path: '/x' })
  expect(seen).toBe('reading')
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
  expect(seen).toBe('writing')

  await $.tool.call({ tool: 'Bash', command: 'false' })
  expect(seen).toBe('running')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('oops')
  await clock.advance(4000)
  await ui.unmount()
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await after.find({ type: 'Text' }))?.text).toBe('thinking')
  await after.unmount()
})

test('the terminal panel is a Raster that the clock repaints', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'clawdbox' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const blits: string[] = []
  on('ui.blit', (_, e) => {
    if ('cells' in e && typeof e.cells === 'string') blits.push(e.cells)
    return { value: {} }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(4000) // past the wave
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const raster = await ui.find({ type: 'Raster', key: 'led' })
  expect(raster).toBeDefined()
  await clock.advance(3000)
  expect(blits.length).toBeGreaterThan(2)
  await ui.unmount()
})

test('a value an earlier version stored is declined', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('state.get', () => ({ value: { value: { mood: 'grumpy' }, version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('idle')
  await ui.unmount()
})

test('frames encode to the sizes the Raster mounts', () => {
  const big = rasterSize(36)
  const small = rasterSize(20)
  expect(big).toEqual({ columns: 32, rows: 16, big: true })
  expect(small).toEqual({ columns: 16, rows: 8, big: false })
  const frame = frameAt('idle', 0).frame
  // 12 bytes a cell, base64 is 4 chars per 3 bytes
  expect(cells(frame, big).length).toBe((32 * 16 * 12 * 4) / 3)
  expect(cells(frame, small).length).toBe((16 * 8 * 12 * 4) / 3)
})

test('every state fits the Svg limit', () => {
  for (const name of [
    'idle', 'thinking', 'ultrathink', 'reading', 'writing', 'running', 'needs-you',
    'coffee', 'vibing', 'wave', 'done', 'error', 'heart',
  ] as const) {
    expect(svg(name).length).toBeLessThan(131072)
  }
})

test('turns follow the daemon: thinking, ultrathink, heart, done after a long turn', () => {
  let s = fresh(0)
  s = turnStarted(s, 'please ultrathink about this', 1000)
  expect(shown(s, 1000)).toBe('ultrathink')
  s = turnEnded(s, 'answer', 1000 + DONE_AFTER_MS)
  expect(shown(s, 1000 + DONE_AFTER_MS)).toBe('done')
  expect(shown(s, 1000 + DONE_AFTER_MS + FLASH_MS)).toBe('idle')

  s = turnStarted(s, 'thanks, that works', 50_000)
  expect(shown(s, 50_000)).toBe('heart')
  expect(shown(s, 50_000 + FLASH_MS)).toBe('thinking')
  s = turnEnded(s, 'answer', 54_000)
  expect(shown(s, 54_000)).toBe('idle') // a short turn: no celebration
  s = turnEnded(turnStarted(s, 'go', 60_000), 'aborted', 90_000)
  expect(shown(s, 90_000)).toBe('idle') // Esc: no done flash
})

test('idle brings coffee, then headphones, then they alternate', () => {
  const s = fresh(0)
  expect(shown(s, IDLE_STAGE_MS - 1)).toBe('idle')
  expect(shown(s, IDLE_STAGE_MS)).toBe('coffee')
  expect(shown(s, 2 * IDLE_STAGE_MS)).toBe('vibing')
  expect(shown(s, 3 * IDLE_STAGE_MS)).toBe('coffee')
  expect(nextChangeAt(s, 1)).toBe(IDLE_STAGE_MS)
})

test('tools map to poses as the daemon maps them', () => {
  expect(activityForTool('Grep')).toBe('reading')
  expect(activityForTool('MultiEdit')).toBe('writing')
  expect(activityForTool('Bash')).toBe('running')
  expect(activityForTool('AskUserQuestion')).toBe('needs-you')
  expect(activityForTool('mcp__github__list_issues')).toBe('reading')
  expect(activityForTool('mcp__github__create_issue')).toBe('writing')
  expect(activityForTool('Agent')).toBe('thinking')
})
