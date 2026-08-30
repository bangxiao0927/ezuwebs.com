/**
 * Exponential reconnect delay, doubling per attempt starting from
 * `baseMs` and capped at `maxMs`. `attempt` is 1 for the first
 * reconnect try after a disconnect.
 */
export function reconnectDelayMs(attempt: number, baseMs = 500, maxMs = 10_000): number {
  const delay = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, maxMs);
}
