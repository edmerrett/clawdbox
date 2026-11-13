/**
 * How long the panel has been unreachable, for the menu bar: it says "connecting…" for a
 * while after start-up or a drop, and "can't reach the Divoom" once that runs long.
 * Starts counting from creation (the daemon has not connected yet at start-up).
 */
export function downtimeTracker(now: () => number = Date.now): (connected: boolean) => number | null {
  let downSince: number | null = now();
  return (connected) => {
    if (connected) {
      downSince = null;
      return null;
    }
    downSince ??= now();
    return Math.floor((now() - downSince) / 1000);
  };
}
