import type { DrawingData } from './engine/drawingTypes';
import { hasValidPageDrawingOwnership, type PageOwnedDrawing } from './notebookPageRenderState.ts';
import { DrawingSaveRetryScheduler } from './drawingSaveRetry.ts';

export type DrawingPersistenceStatus = 'saving' | 'saved' | 'error';

export interface DrawingSaveTarget {
  workspaceId: string;
  notebookId: string;
}

/**
 * `stale` means the snapshot belongs to a page/document that is no longer
 * writable (deleted or moved). `null` means the target is temporarily
 * unavailable (for example during workspace hydration) and should be retried.
 */
export type DrawingSaveTargetResolution = DrawingSaveTarget | 'stale' | null;

export interface DrawingSaveCompletion {
  /** No newer capture is currently queued for this page. */
  latestScheduled: boolean;
  /** This is the newest successful write for this page. */
  latestPersisted: boolean;
}

export interface DrawingPersistenceCallbacks {
  resolveTarget: (snapshot: PageOwnedDrawing) => DrawingSaveTargetResolution;
  encode: (snapshot: PageOwnedDrawing) => string;
  save: (target: DrawingSaveTarget, data: DrawingData, snapshot: PageOwnedDrawing) => Promise<DrawingData>;
  onSaveStarted?: (snapshot: PageOwnedDrawing) => void;
  onScheduled?: (snapshot: PageOwnedDrawing, target: DrawingSaveTarget) => void;
  onSaved?: (snapshot: PageOwnedDrawing, savedData: DrawingData, completion: DrawingSaveCompletion) => void;
  onFailed?: (snapshot: PageOwnedDrawing, error: unknown, context: { willRetry: boolean }) => void;
  onStatus?: (snapshot: PageOwnedDrawing, status: DrawingPersistenceStatus) => void;
}

interface ScheduledSave {
  revision: number;
  sequence: number;
  fingerprint: string;
  data: DrawingData;
}

interface PersistedSave {
  revision: number;
  sequence: number;
  fingerprint: string;
}

export type DrawingPersistResult =
  | 'invalid'
  | 'already-persisted'
  | 'superseded'
  | 'already-scheduled'
  | 'stale-target'
  | 'target-unavailable'
  | 'scheduled';

const activeQueues = new Set<DrawingPersistenceQueue>();

export function cancelQueuedPageDrawing(pageId: string): void {
  for (const queue of activeQueues) {
    queue.cancelPage(pageId);
  }
}

/**
 * Owns the drawing-write state machine. A revision/fingerprint is only marked
 * scheduled after the target has been resolved and the write is about to
 * start, so a failed target lookup cannot suppress a later flush. Failed
 * snapshots are retained and retried independently of new edits; a newer
 * capture always supersedes an older retry, so stale data can never overwrite
 * a newer page scene.
 */
export class DrawingPersistenceQueue {
  private readonly scheduled = new Map<string, ScheduledSave>();
  private readonly persisted = new Map<string, PersistedSave>();
  private readonly failed = new Map<string, PageOwnedDrawing>();
  private readonly callbacks: () => DrawingPersistenceCallbacks | null;
  private readonly retry: DrawingSaveRetryScheduler;
  private retriesEnabled = true;

  constructor(
    callbacks: () => DrawingPersistenceCallbacks | null,
    retryDelaysMs?: readonly number[],
  ) {
    this.callbacks = callbacks;
    this.retry = new DrawingSaveRetryScheduler(pageId => {
      const failed = this.failed.get(pageId);
      if (failed) this.persist(failed);
    }, retryDelaysMs);
    activeQueues.add(this);
  }

  cancelPage(pageId: string): void {
    this.scheduled.delete(pageId);
    this.persisted.delete(pageId);
    this.failed.delete(pageId);
    this.retry.cancel(pageId);
  }

  setRetriesEnabled(enabled: boolean): void {
    this.retriesEnabled = enabled;
    if (!enabled) this.retry.cancelAll();
  }

  persist(snapshot: PageOwnedDrawing): DrawingPersistResult {
    if (!hasValidPageDrawingOwnership(snapshot)) return 'invalid';
    const callbacks = this.callbacks();
    if (!callbacks) return 'invalid';

    const pageId = snapshot.saveTargetSheetId;
    const { data, sequence } = snapshot;

    const persisted = this.persisted.get(pageId);
    if (persisted && sequence <= persisted.sequence) {
      this.clearFailure(pageId, sequence);
      return 'already-persisted';
    }

    const scheduled = this.scheduled.get(pageId);
    if (scheduled && sequence < scheduled.sequence) return 'superseded';
    if (scheduled && sequence === scheduled.sequence && scheduled.data === data) return 'already-scheduled';

    // Resolve first. Marking a revision as scheduled before this point was the
    // reason a transient lookup failure could suppress every later flush.
    const target = callbacks.resolveTarget(snapshot);
    if (target === 'stale') {
      this.failed.delete(pageId);
      this.retry.cancel(pageId);
      return 'stale-target';
    }
    if (!target) {
      this.handleFailure(snapshot, new Error('Drawing save target is unavailable.'));
      return 'target-unavailable';
    }

    callbacks.onSaveStarted?.(snapshot);
    const fingerprint = callbacks.encode(snapshot);
    const currentScheduled = this.scheduled.get(pageId);
    if (currentScheduled && currentScheduled.sequence === sequence && currentScheduled.fingerprint === fingerprint) {
      return 'already-scheduled';
    }
    // Encoding is synchronous but can yield through profiler hooks; re-check
    // that a newer capture did not replace this page's pending write.
    if (currentScheduled && currentScheduled.sequence > sequence) return 'superseded';

    this.scheduled.set(pageId, { revision: snapshot.drawingRevision, sequence, fingerprint, data });
    // A newer capture supersedes an older failure. A retry of the same
    // snapshot stays in the failed map until it actually succeeds.
    this.clearFailure(pageId, sequence - 1);
    callbacks.onStatus?.(snapshot, 'saving');
    callbacks.onScheduled?.(snapshot, target);

    void callbacks.save(target, data, snapshot).then(savedData => {
      const latestScheduled = this.scheduled.get(pageId);
      const latestPersisted = this.persisted.get(pageId);
      const isLatestPersisted = !latestPersisted || sequence >= latestPersisted.sequence;
      if (isLatestPersisted) {
        this.persisted.set(pageId, { revision: snapshot.drawingRevision, sequence, fingerprint });
        this.clearFailure(pageId, sequence);
      }
      const completion: DrawingSaveCompletion = {
        latestScheduled: latestScheduled?.sequence === sequence,
        latestPersisted: isLatestPersisted,
      };
      callbacks.onSaved?.(snapshot, savedData, completion);
      // An older write that finishes while a newer one is queued must not
      // flash "Saved" or overwrite the newer status.
      if (completion.latestScheduled && completion.latestPersisted) {
        callbacks.onStatus?.(snapshot, 'saved');
      }
    }).catch(error => {
      const latestScheduled = this.scheduled.get(pageId);
      if (latestScheduled?.sequence === sequence) this.scheduled.delete(pageId);
      const latestPersisted = this.persisted.get(pageId);
      if (latestPersisted && sequence <= latestPersisted.sequence) return;
      // A newer write is already responsible for this page; an older failure
      // must not surface a false error or queue a stale retry.
      if (latestScheduled && latestScheduled.sequence > sequence) return;
      this.handleFailure(snapshot, error);
    });

    return 'scheduled';
  }

  /** Immediate lifecycle flush (navigation/unmount), independent of the timer. */
  flushFailed(): void {
    for (const [pageId, snapshot] of [...this.failed]) {
      this.retry.cancel(pageId);
      this.persist(snapshot);
    }
  }

  getScheduledSequence(pageId: string): number | undefined {
    return this.scheduled.get(pageId)?.sequence;
  }

  hasFailed(pageId: string): boolean {
    return this.failed.has(pageId);
  }

  cancelRetries(): void {
    this.retry.cancelAll();
  }

  private handleFailure(snapshot: PageOwnedDrawing, error: unknown): void {
    const pageId = snapshot.saveTargetSheetId;
    const existing = this.failed.get(pageId);
    if (!existing || snapshot.sequence >= existing.sequence) {
      this.failed.set(pageId, snapshot);
    }
    const callbacks = this.callbacks();
    callbacks?.onStatus?.(snapshot, 'error');
    const willRetry = this.retriesEnabled && this.retry.schedule(pageId);
    callbacks?.onFailed?.(snapshot, error, { willRetry });
  }

  private clearFailure(pageId: string, upToSequence: number): void {
    const failed = this.failed.get(pageId);
    if (!failed || failed.sequence > upToSequence) return;
    this.failed.delete(pageId);
    this.retry.cancel(pageId);
  }
}
