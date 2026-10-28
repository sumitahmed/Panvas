export const DEFAULT_DRAWING_SAVE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;

/**
 * Bounded, per-page retry timers for drawing writes. A failed write must not
 * depend on the user making another edit: the snapshot is already immutable,
 * so it can be retried after the write queue has had time to release a lock.
 */
export class DrawingSaveRetryScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  private readonly retry: (key: string) => void;
  private readonly delaysMs: readonly number[];

  constructor(
    retry: (key: string) => void,
    delaysMs: readonly number[] = DEFAULT_DRAWING_SAVE_RETRY_DELAYS_MS,
  ) {
    this.retry = retry;
    this.delaysMs = delaysMs;
  }

  /** Returns true when a retry is scheduled (or was already scheduled). */
  schedule(key: string): boolean {
    if (this.timers.has(key)) return true;
    const attempt = this.attempts.get(key) ?? 0;
    if (attempt >= this.delaysMs.length) return false;
    this.attempts.set(key, attempt + 1);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.retry(key);
    }, this.delaysMs[attempt]);
    this.timers.set(key, timer);
    return true;
  }

  /** Cancels the timer and gives the next failure a fresh retry budget. */
  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
    this.attempts.delete(key);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.attempts.clear();
  }

  attemptCount(key: string): number {
    return this.attempts.get(key) ?? 0;
  }

  hasTimer(key: string): boolean {
    return this.timers.has(key);
  }
}
