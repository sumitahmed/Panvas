export type DrawingSaveSchedulerEvent =
  | { type: 'saveScheduled'; delayMs: number }
  | { type: 'saveDeferredBecausePenActive' };

export interface DrawingSaveSchedulerOptions {
  debounceMs?: number;
  quietMs?: number;
  maxDeferralMs?: number;
  onEvent?: (event: DrawingSaveSchedulerEvent) => void;
}

export const DEFAULT_MAX_DEFERRAL_MS = 10_000;

/**
 * Keeps the latest immutable page snapshot, but never starts its synchronous
 * persistence preparation while a drawing contact is active. Explicit flushes
 * (page/app lifecycle boundaries) intentionally bypass the quiet-window gate.
 * 
 * Two-tier checkpoint persistence:
 * 1. During normal pauses, pen-up flushes pending saves quickly (300ms).
 * 2. Continuous handwriting (> 10,000ms) marks a checkpoint so the very next
 *    pen-up flushes immediately without waiting for the full idle pause.
 */
export class DrawingSaveScheduler<T> {
  private readonly debounceMs: number;
  private readonly quietMs: number;
  private readonly maxDeferralMs: number;
  private readonly onEvent?: (event: DrawingSaveSchedulerEvent) => void;
  private pending: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gestureActive = false;
  private readonly save: (snapshot: T) => void;
  private deferralStartedAt: number | null = null;
  private checkpointPending = false;

  constructor(save: (snapshot: T) => void, options: DrawingSaveSchedulerOptions = {}) {
    this.save = save;
    this.debounceMs = options.debounceMs ?? 1000;
    this.quietMs = options.quietMs ?? 300;
    this.maxDeferralMs = options.maxDeferralMs ?? DEFAULT_MAX_DEFERRAL_MS;
    this.onEvent = options.onEvent;
  }

  enqueue(snapshot: T): void {
    this.pending = snapshot;
    if (this.deferralStartedAt === null) {
      this.deferralStartedAt = Date.now();
    }
    if (Date.now() - this.deferralStartedAt >= this.maxDeferralMs) {
      this.checkpointPending = true;
    }
    this.schedule(this.debounceMs);
  }

  setGestureActive(active: boolean): void {
    if (this.gestureActive === active) return;
    this.gestureActive = active;
    if (!active && this.pending !== null) {
      if (this.deferralStartedAt !== null && Date.now() - this.deferralStartedAt >= this.maxDeferralMs) {
        this.checkpointPending = true;
      }
      const delay = this.checkpointPending ? 0 : this.quietMs;
      this.schedule(delay);
    }
  }

  peek(): T | null {
    return this.pending;
  }

  clear(): void {
    this.cancelTimer();
    this.pending = null;
    this.deferralStartedAt = null;
    this.checkpointPending = false;
  }

  /** Flushes the latest snapshot immediately for ownership/lifecycle boundaries. */
  flush(): T | null {
    this.cancelTimer();
    const pending = this.pending;
    this.pending = null;
    this.deferralStartedAt = null;
    this.checkpointPending = false;
    if (pending !== null) this.save(pending);
    return pending;
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    if (this.deferralStartedAt === null && this.pending !== null) {
      this.deferralStartedAt = Date.now();
    }
    if (this.deferralStartedAt !== null && Date.now() - this.deferralStartedAt >= this.maxDeferralMs) {
      this.checkpointPending = true;
    }
    const effectiveDelay = this.checkpointPending && !this.gestureActive ? 0 : delayMs;
    this.onEvent?.({ type: 'saveScheduled', delayMs: effectiveDelay });
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.gestureActive) {
        this.onEvent?.({ type: 'saveDeferredBecausePenActive' });
        if (this.deferralStartedAt !== null && Date.now() - this.deferralStartedAt >= this.maxDeferralMs) {
          this.checkpointPending = true;
        }
        return;
      }
      const pending = this.pending;
      this.pending = null;
      this.deferralStartedAt = null;
      this.checkpointPending = false;
      if (pending !== null) this.save(pending);
    }, effectiveDelay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
