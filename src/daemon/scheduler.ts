/**
 * Decides what the display shows and when it is allowed to change.
 *
 *  - Smooth: a state is held for at least `minHoldMs`, and we prefer to switch
 *    at a loop boundary of the animation currently playing.
 *  - `needs-you` bypasses the hold and switches immediately.
 *  - Flashes (wave, done, error, heart) show immediately for `flashMs`, then the
 *    panel returns to whatever the reducer wants.
 *  - Long idle: after `idleStageAfterMs` with no events, idle cycles through
 *    IDLE_STAGES (coffee, vibing, ...) every `idleStageCycleMs`.
 *
 * Interrupted turns (Esc fires no Stop hook) are not handled here: the reducer
 * expires silent sessions one by one and the daemon passes the new target in.
 *
 * Pure and clock-free: callers pass `now` so it is easy to test.
 */
import { ActivityState, FlashState, IDLE_STAGES, State, isFlashState } from '../anim/types.js';

export interface SchedulerOptions {
  minHoldMs: number;
  /** Loop length per state, in ms, so we can find loop boundaries. */
  loopMs: Record<State, number>;
  /** Don't wait for a loop boundary longer than this. */
  maxBoundaryWaitMs: number;
  /** How long a flash stays up. */
  flashMs: number;
  /** Idle this long before the long-idle stages start (0 disables). */
  idleStageAfterMs: number;
  /** Then move to the next stage every this often. */
  idleStageCycleMs: number;
}

/** How close to a loop boundary counts as "at" it. */
const BOUNDARY_WINDOW_MS = 120;

export const DEFAULT_SCHEDULER: Omit<SchedulerOptions, 'loopMs'> = {
  minHoldMs: 2000,
  maxBoundaryWaitMs: 1500,
  flashMs: 3500,
  idleStageAfterMs: 10 * 60_000,
  idleStageCycleMs: 10 * 60_000,
};

export class Scheduler {
  /** What is on the panel right now. */
  current: State = 'idle';
  private shownAt = 0;
  /** What the reducer wants. */
  target: ActivityState = 'idle';
  private lastEventAt = -1;
  private flashState: FlashState | null = null;
  private flashUntil = 0;

  constructor(private readonly opts: SchedulerOptions) {}

  /** The reducer's aggregate changed (or an event arrived). */
  setTarget(state: ActivityState, now: number): void {
    this.lastEventAt = now;
    this.target = state;
  }

  /** Show a short reaction now, then go back to the target. */
  flash(state: FlashState, now: number): void {
    this.flashState = state;
    this.flashUntil = now + this.opts.flashMs;
  }

  /** What the panel should be showing, before hold/boundary smoothing. */
  desired(now: number): State {
    if (this.flashState && now < this.flashUntil) return this.flashState;
    if (this.target === 'idle' && this.opts.idleStageAfterMs > 0 && this.lastEventAt >= 0) {
      const idleFor = now - this.lastEventAt;
      if (idleFor >= this.opts.idleStageAfterMs) {
        const i = Math.floor((idleFor - this.opts.idleStageAfterMs) / this.opts.idleStageCycleMs) % IDLE_STAGES.length;
        return IDLE_STAGES[i];
      }
    }
    return this.target;
  }

  get pending(): State {
    return this.desired(Date.now());
  }

  /**
   * Called every ~100 ms. Returns the state to switch to, or null to keep going.
   * The caller pushes the animation and then calls `shown()`.
   */
  tick(now: number): State | null {
    if (this.flashState && now >= this.flashUntil) this.flashState = null;

    const want = this.desired(now);
    if (want === this.current) return null;

    // Urgent things jump the queue; so does returning from a flash that just ended.
    if (want === 'needs-you' || this.flashState === want) return want;
    if (this.isFlash(this.current)) return want;

    const held = now - this.shownAt;
    if (held < this.opts.minHoldMs) return null;

    // Prefer a loop boundary, but not forever.
    const loop = this.opts.loopMs[this.current] || 0;
    if (loop > 0) {
      const intoLoop = held % loop;
      const untilBoundary = loop - intoLoop;
      const waitedPastHold = held - this.opts.minHoldMs;
      const nearBoundary = intoLoop < BOUNDARY_WINDOW_MS || untilBoundary < BOUNDARY_WINDOW_MS;
      if (!nearBoundary && waitedPastHold < this.opts.maxBoundaryWaitMs) return null;
    }
    return want;
  }

  private isFlash(s: State): boolean {
    return isFlashState(s);
  }

  /** Confirm that `state` is now on the panel. */
  shown(state: State, now: number): void {
    this.current = state;
    this.shownAt = now;
  }
}
