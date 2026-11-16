export type Activity = 'idle' | 'thinking' | 'reading' | 'writing' | 'running' | 'needs-you'
export type Flash = 'wave' | 'done' | 'error' | 'heart'

/** What Clawd is doing in this session, kept in $.state so a reload keeps it. */
export type Clawd = {
  activity: Activity
  /** When `activity` last changed, in `$.clock.now()` ms: the idle stages count from it. */
  since: number
  /** The turn's prompt asked for ultrathink: thinking shows the rainbow variant until the turn ends. */
  ultra: boolean
  /** When the current turn began; `done` celebrates turns of ten seconds or more. */
  turnStartedAt?: number
  flash?: Flash
  flashUntil?: number
}

declare module 'claude-code' {
  interface PluginState {
    clawdbox: { clawd: Shaped<Clawd | null> }
  }
}
