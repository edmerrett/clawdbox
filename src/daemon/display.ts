/** What the daemon needs from a panel, whichever transport drives it. */
import { Anim, State } from '../anim/types.js';

export interface Display {
  readonly label: string;
  readonly connected: boolean;
  /** Successful state pushes. */
  pushes: number;
  lastError: string | null;
  /** Called after the link comes back following a drop, so the caller can re-show the current state. */
  onReconnect?: () => void;
  prepare(anims: Record<State, Anim>): void;
  show(state: State): Promise<void>;
  setBrightness(percent: number): Promise<void>;
  close(): void;
}
