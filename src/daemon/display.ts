/** What the daemon needs from a panel, whichever transport drives it. */
import { Anim, State } from '../anim/types.js';

export interface Display {
  readonly label: string;
  readonly connected: boolean;
  /** Successful state pushes. */
  pushes: number;
  lastError: string | null;
  prepare(anims: Record<State, Anim>): void;
  show(state: State): Promise<void>;
  setBrightness(percent: number): Promise<void>;
  close(): void;
}
