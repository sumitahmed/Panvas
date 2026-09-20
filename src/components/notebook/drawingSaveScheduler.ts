export type DrawingSaveSchedulerEvent =
  | { type: 'saveScheduled'; delayMs: number }
  | { type: 'saveDeferredBecausePenActive' };

export interface DrawingSaveSchedulerOptions {
  debounceMs?: number;
  quietMs?: number;
  onEvent?: (event: DrawingSaveSchedulerEvent) => void;
}

/**
 * Keeps the latest immutable page snapshot, but never starts its synchronous
 * persistence preparation while a drawing contact is active. Explicit flushes
 * (page/app lifecycle boundaries) intentionally bypass the quiet-window gate.
 */
export class DrawingSaveScheduler<T> {
  private readonly debounceMs: number;
  private readonly quietMs: number;
  private readonly onEvent?: (event: DrawingSaveSchedulerEvent) => void;
  private pending: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gestureActive = false;
  private readonly save: (snapshot: T) => void;

  constructor(save: (snapshot: T) => void, options: DrawingSaveSchedulerOptions = {}) {
    this.save = save;
    this.debounceMs = options.debounceMs ?? 1000;
    this.quietMs = options.quietMs ?? 200;
    this.onEvent = options.onEvent;
  }

  enqueue(snapshot: T): void {
    this.pending = snapshot;
    this.schedule(this.debounceMs);
  }

  setGestureActive(active: boolean): void {
    if (this.gestureActive === active) return;
    this.gestureActive = active;
    if (!active && this.pending !== null && this.timer === null) this.schedule(this.quietMs);
  }

  peek(): T | null {
    return this.pending;
  }

  clear(): void {
    this.cancelTimer();
    this.pending = null;
  }

  /** Flushes the latest snapshot immediately for ownership/lifecycle boundaries. */
  flush(): T | null {
    this.cancelTimer();
    const pending = this.pending;
    this.pending = null;
    if (pending !== null) this.save(pending);
    return pending;
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    this.onEvent?.({ type: 'saveScheduled', delayMs });
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.gestureActive) {
        this.onEvent?.({ type: 'saveDeferredBecausePenActive' });
        return;
      }
      const pending = this.pending;
      this.pending = null;
      if (pending !== null) this.save(pending);
    }, delayMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
