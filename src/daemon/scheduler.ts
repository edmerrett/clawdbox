/**
 * Decides what the display shows and when it is allowed to change.
 *
 * Rules (from the design interview):
 *  - Smooth: a state is held for at least `minHoldMs`, and we prefer to switch
 *    at a loop boundary of the animation currently playing.
 *  - `needs-you` bypasses the hold and switches immediately.
 *  - If a non-idle state receives no events for `idleAfterMs`, fall back to idle
 *    (covers Esc interrupts, where Claude Code fires no Stop hook).
 *
 * Pure and clock-free: callers pass `now` so it is easy to test.
 */
import { State } from '../anim/types.js';

export interface SchedulerOptions {
  minHoldMs: number;
  idleAfterMs: number;
  /** Loop length per state, in ms, so we can find loop boundaries. */
  loopMs: Record<State, number>;
  /** Don't wait for a loop boundary longer than this. */
  maxBoundaryWaitMs: number;
}

export const DEFAULT_SCHEDULER: Omit<SchedulerOptions, 'loopMs'> = {
  minHoldMs: 2000,
  idleAfterMs: 90_000,
  maxBoundaryWaitMs: 1500,
};

export class Scheduler {
  /** What is on the panel right now. */
  current: State = 'idle';
  /** When the current animation was (re)started. */
  private shownAt = 0;
  /** What the reducer wants. */
  private target: State = 'idle';
  private targetSince = 0;
  private lastEventAt = -1;

  constructor(private readonly opts: SchedulerOptions) {}

  /** The reducer's aggregate changed (or an event arrived). */
  setTarget(state: State, now: number): void {
    this.lastEventAt = now;
    if (state !== this.target) {
      this.target = state;
      this.targetSince = now;
    }
  }

  get pending(): State {
    return this.target;
  }

  /**
   * Called every ~100 ms. Returns the state to switch to, or null to keep going.
   * The caller is responsible for actually pushing the animation and then calling `shown()`.
   */
  tick(now: number): State | null {
    // Idle fallback: nothing heard for a long time while busy.
    if (this.target !== 'idle' && this.lastEventAt >= 0 && now - this.lastEventAt > this.opts.idleAfterMs) {
      this.target = 'idle';
      this.targetSince = now;
    }
    if (this.target === this.current) return null;

    if (this.target === 'needs-you') return this.target;

    const held = now - this.shownAt;
    if (held < this.opts.minHoldMs) return null;

    // Prefer a loop boundary, but not forever.
    const loop = this.opts.loopMs[this.current] || 0;
    if (loop > 0) {
      const intoLoop = held % loop;
      const untilBoundary = loop - intoLoop;
      const waitedPastHold = held - this.opts.minHoldMs;
      const nearBoundary = intoLoop < 120 || untilBoundary < 120;
      if (!nearBoundary && waitedPastHold < this.opts.maxBoundaryWaitMs) return null;
    }
    return this.target;
  }

  /** Confirm that `state` is now on the panel. */
  shown(state: State, now: number): void {
    this.current = state;
    this.shownAt = now;
  }
}
