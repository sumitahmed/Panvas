import type { EraserMode } from './drawingTypes.ts';
import type { InkPoint } from './inkRegion.ts';
import { gate0Profiler, type Gate0Record } from '../../../dev/gate0Profiler.ts';

export interface EraserGestureOwner {
  pageId: string | null;
  begin: (mode: EraserMode) => boolean;
  sweep: (start: InkPoint, end: InkPoint, mode: EraserMode, radius: number) => boolean;
  present: () => void;
  complete: () => boolean;
}

export interface EraserFrameClock {
  now: () => number;
  request: (callback: FrameRequestCallback) => number;
  cancel: (handle: number) => void;
}

const browserClock: EraserFrameClock = {
  now: () => performance.now(),
  request: callback => requestAnimationFrame(callback),
  cancel: handle => cancelAnimationFrame(handle),
};

/** One gesture owns its engine callbacks until completion. No live page lookup. */
export class EraserGesture {
  private pending: Array<{ point: InkPoint; at: number }> = [];
  private head = 0;
  private lastQueued: InkPoint | null = null;
  private lastProcessed: InkPoint | null = null;
  private frame: number | null = null;
  private begun = false;
  private state: 'active' | 'ending' | 'completed' = 'active';
  private previousFramePending = 0;
  readonly pointerId: number;
  readonly usesRawInput: boolean;
  readonly mode: EraserMode;
  readonly radius: number;
  private readonly owner: EraserGestureOwner;
  private readonly profile: Gate0Record | null;
  private readonly clock: EraserFrameClock;
  private readonly budgetMs: number;
  private readonly immediateGeometry: boolean;
  private unpresentedChange = false;
  private unpresentedAt: number[] = [];

  constructor(
    pointerId: number,
    usesRawInput: boolean,
    mode: EraserMode,
    radius: number,
    owner: EraserGestureOwner,
    profile: Gate0Record | null,
    clock: EraserFrameClock = browserClock,
    budgetMs = 8,
    immediateGeometry = false,
  ) {
    this.pointerId = pointerId;
    this.usesRawInput = usesRawInput;
    this.mode = mode;
    this.radius = radius;
    this.owner = owner;
    this.profile = profile;
    this.clock = clock;
    this.budgetMs = budgetMs;
    this.immediateGeometry = immediateGeometry;
    gate0Profiler.annotate(profile, { pageId: owner.pageId, rawInput: usesRawInput, frameBudgetMs: budgetMs });
  }

  /** Ignore the duplicate transport, not revisits to earlier points in the path. */
  acceptsMovement(event: Pick<PointerEvent, 'pointerId' | 'type'>): boolean {
    return this.state === 'active' && event.pointerId === this.pointerId
      && event.type === (this.usesRawInput ? 'pointerrawupdate' : 'pointermove');
  }

  enqueue(point: InkPoint): void {
    if (this.state !== 'active') return;
    if (this.lastQueued?.x === point.x && this.lastQueued.y === point.y) return;
    const ownedPoint = { x: point.x, y: point.y };
    this.lastQueued = ownedPoint;
    this.pending.push({ point: ownedPoint, at: this.clock.now() });
    gate0Profiler.increment(this.profile, 'queuedPathPositions');
    this.sampleQueue();
    if (this.immediateGeometry) this.process(true, false);
    this.schedule();
  }

  private sampleQueue(): void {
    gate0Profiler.sample(this.profile, 'pendingPathLength', this.pending.length - this.head);
    const oldest = this.pending[this.head];
    gate0Profiler.sample(this.profile, 'oldestQueuedMovementAgeMs', oldest ? this.clock.now() - oldest.at : 0);
  }

  private schedule(): void {
    if (this.frame !== null || this.state !== 'active') return;
    this.frame = this.clock.request(() => {
      this.frame = null;
      if (this.state !== 'active') return;
      this.process(false);
      if (this.head < this.pending.length) this.schedule();
    });
  }

  private process(terminal: boolean, present = true): void {
    const started = this.clock.now();
    const end = this.pending.length;
    let changed = false;
    let sweeps = 0;
    let longestSweep = 0;
    const processedAt: number[] = [];
    this.sampleQueue();
    if (!this.begun) {
      this.begun = true;
      changed = this.owner.begin(this.mode);
    }
    while (this.head < end) {
      const sample = this.pending[this.head];
      const sweepStarted = this.clock.now();
      gate0Profiler.sample(this.profile, 'oldestQueuedMovementAgeMs', sweepStarted - sample.at);
      // The initial degenerate capsule retains the old pointerdown eraseAt semantics.
      const sweepChanged = this.owner.sweep(this.lastProcessed ?? sample.point, sample.point, this.mode, this.radius);
      changed = sweepChanged || changed;
      const duration = this.clock.now() - sweepStarted;
      longestSweep = Math.max(longestSweep, duration);
      if (duration > this.budgetMs) gate0Profiler.increment(this.profile, 'sweepBudgetOverruns');
      this.lastProcessed = sample.point;
      if (sweepChanged) processedAt.push(sample.at);
      this.head += 1;
      sweeps += 1;
      // Never interrupt or drop a capsule; this budget cannot bound one expensive sweep.
      if (!terminal && this.clock.now() - started >= this.budgetMs) break;
    }
    this.unpresentedChange ||= changed;
    this.unpresentedAt.push(...processedAt);
    if (present && this.unpresentedChange) {
      this.owner.present();
      gate0Profiler.increment(this.profile, terminal ? 'terminalPresentations' : 'framePresentations');
      for (const at of this.unpresentedAt) {
        // CPU canvas submission only: actual display latency needs browser/frame evidence.
        gate0Profiler.sample(this.profile, 'movementToCanvasSubmissionMs', this.clock.now() - at);
      }
      if (this.profile && gate0Profiler.isEnabled()) {
        const times = this.unpresentedAt.slice();
        // A frame-opportunity proxy, not a claim about physical display scanout.
        requestAnimationFrame(() => {
          for (const at of times) gate0Profiler.sample(this.profile, 'movementToNextFrameOpportunityMs', this.clock.now()-at);
        });
      }
      this.unpresentedChange = false;
      this.unpresentedAt = [];
    }
    const duration = this.clock.now() - started;
    gate0Profiler.increment(this.profile, 'sweepsProcessed', sweeps);
    gate0Profiler.sample(this.profile, terminal ? 'terminalProcessingMs' : 'eraserFrameWorkMs', duration);
    gate0Profiler.sample(this.profile, 'sweepsPerBatch', sweeps);
    gate0Profiler.sample(this.profile, 'longestSweepPerBatchMs', longestSweep);
    if (duration >= 50) gate0Profiler.increment(this.profile, 'eraserBatchesOver50Ms');
    const remaining = this.pending.length - this.head;
    gate0Profiler.sample(this.profile, 'backlogGrowthPositions', remaining - this.previousFramePending);
    this.previousFramePending = remaining;
    // Compact consumed entries without shifting the array for every pointer sample.
    this.pending = this.pending.slice(this.head);
    this.head = 0;
    this.sampleQueue();
  }

  /** Synchronous ownership barrier for pointerup, capture, detach and page replacement. */
  finish(): boolean {
    if (this.state !== 'active') return false;
    this.state = 'ending';
    if (this.frame !== null) this.clock.cancel(this.frame);
    this.frame = null;
    const started = this.clock.now();
    this.process(true);
    this.state = 'completed';
    const changed = this.owner.complete();
    gate0Profiler.annotate(this.profile, { completionTailMs: this.clock.now() - started });
    return changed;
  }
}
