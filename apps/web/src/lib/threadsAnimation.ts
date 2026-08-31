export type ThreadsRenderMode = "animated" | "static" | "fallback";

export interface ThreadsRenderModeInput {
  webglAvailable: boolean;
  prefersReducedMotion: boolean;
}

export function resolveThreadsRenderMode(input: ThreadsRenderModeInput): ThreadsRenderMode {
  if (!input.webglAvailable) {
    return "fallback";
  }
  if (input.prefersReducedMotion) {
    return "static";
  }
  return "animated";
}

/**
 * Tracks elapsed "active" time for an animation, excluding any time spent
 * paused (e.g. a hidden tab or reduced-motion mode). Resuming after a pause
 * never causes elapsed time to jump forward.
 */
export class PausableClock {
  private accumulatedMs = 0;
  private runningSinceMs: number | null;

  constructor(startMs: number, running: boolean) {
    this.runningSinceMs = running ? startMs : null;
  }

  pause(atMs: number): void {
    if (this.runningSinceMs === null) {
      return;
    }
    this.accumulatedMs += atMs - this.runningSinceMs;
    this.runningSinceMs = null;
  }

  resume(atMs: number): void {
    if (this.runningSinceMs !== null) {
      return;
    }
    this.runningSinceMs = atMs;
  }

  elapsedSeconds(atMs: number): number {
    const runningMs = this.runningSinceMs === null ? 0 : atMs - this.runningSinceMs;
    return (this.accumulatedMs + runningMs) / 1000;
  }
}
