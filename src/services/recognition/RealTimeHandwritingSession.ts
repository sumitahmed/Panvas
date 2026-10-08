import type { BoundingBox, Stroke, StrokePoint } from '@/components/notebook/engine/drawingTypes';
import {
  DEFAULT_HANDWRITING_TOOL_PREFERENCES,
  getHandwritingBounds,
  sanitizeHandwritingToolPreferences,
  type HandwritingToolPreferences,
} from '../beautification/handwritingBeautification.ts';
import type { HandwritingRecognitionProvider, RecognitionResult } from './types.ts';
import { UNSUPPORTED_RECOGNITION_MESSAGE } from './providers/UnsupportedRecognitionProvider.ts';

export const HANDWRITING_IDLE_DELAY_MS = 650;

export interface HandwritingSessionFeedback {
  kind: 'unavailable' | 'error';
  message: string;
}

export interface HandwritingRecognitionCommit {
  batchId: string;
  pageId: string | null;
  strokes: Stroke[];
  sourceBounds: BoundingBox;
  result: RecognitionResult;
  preferences: HandwritingToolPreferences;
  providerId: string;
}

export interface HandwritingSessionScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type HandwritingStrokeRelation = 'same-line' | 'new-line' | 'unrelated';

const runtimeScheduler: HandwritingSessionScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface SealedRecognitionBatch {
  readonly id: string;
  readonly scope: number;
  readonly pageId: string | null;
  readonly strokes: Stroke[];
  readonly recognitionStrokes: Stroke[];
  readonly sourceStrokeIds: string[];
  readonly sourceBounds: BoundingBox;
  readonly preferences: HandwritingToolPreferences;
}

const HANDWRITING_LANGUAGE_LABELS: Record<string, string> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'hi-IN': 'Hindi',
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'de-DE': 'German',
  'ja-JP': 'Japanese',
  'zh-CN': 'Chinese (Simplified)',
};

/**
 * Activation-time guidance for an unavailable recognizer. Only the Windows
 * Ink provider may mention Windows language components — that guidance is
 * meaningless (and wrong) in ordinary browsers, which receive a neutral,
 * ink-preserving message instead.
 */
function unavailableRecognitionMessage(providerId: string, language: string): string {
  const label = HANDWRITING_LANGUAGE_LABELS[language] ?? language;
  if (providerId === 'windows-ink') {
    if (!label) return 'Windows handwriting recognition is unavailable. Install a Windows handwriting language component or choose another language.';
    return `Windows handwriting recognition is unavailable for ${label}. Install the Windows handwriting language component or choose another language.`;
  }
  return `${UNSUPPORTED_RECOGNITION_MESSAGE} Your ink will be kept.`;
}

function uniqueOrderedStrokes(strokes: readonly Stroke[]): Stroke[] {
  const seen = new Set<string>();
  return strokes.flatMap(stroke => {
    if (seen.has(stroke.id)) return [];
    seen.add(stroke.id);
    return [structuredClone(stroke)];
  });
}

function verticalOverlap(left: BoundingBox, right: BoundingBox): number {
  return Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
}

function horizontalGap(left: BoundingBox, right: BoundingBox): number {
  if (right.x > left.x + left.width) return right.x - (left.x + left.width);
  if (left.x > right.x + right.width) return left.x - (right.x + right.width);
  return 0;
}

function typicalStrokeHeight(strokes: readonly Stroke[]): number {
  const heights = strokes
    .map(stroke => getHandwritingBounds([stroke])?.height ?? 0)
    .filter(height => height > 0)
    .sort((left, right) => left - right);
  if (heights.length === 0) return 1;
  return heights[Math.floor((heights.length - 1) * 0.75)];
}

/**
 * Classifies page-coordinate ink without viewport scale, DPR, or screen-pixel
 * thresholds. The line scale is derived from the source strokes themselves.
 */
export function classifyHandwritingStroke(
  group: readonly Stroke[],
  next: Stroke,
): HandwritingStrokeRelation {
  const groupBounds = getHandwritingBounds(group);
  const nextBounds = getHandwritingBounds([next]);
  if (!groupBounds || !nextBounds) return 'unrelated';
  const groupLayerId = group.find(stroke => stroke.layerId)?.layerId;
  if (groupLayerId && next.layerId && groupLayerId !== next.layerId) return 'unrelated';

  const groupCenterY = groupBounds.y + groupBounds.height / 2;
  const nextCenterY = nextBounds.y + nextBounds.height / 2;
  const lineScale = Math.max(
    1,
    groupBounds.height,
    nextBounds.height,
    typicalStrokeHeight([...group, next]),
  );
  const overlap = verticalOverlap(groupBounds, nextBounds);
  const centerDistance = Math.abs(nextCenterY - groupCenterY);
  const sharesLineBand = overlap >= Math.min(groupBounds.height, nextBounds.height) * 0.15
    || centerDistance <= lineScale * 0.9;
  const gap = horizontalGap(groupBounds, nextBounds);
  const nextIsFarBehind = nextBounds.x + nextBounds.width < groupBounds.x - lineScale * 2;
  if (sharesLineBand && gap <= lineScale * 5 && !nextIsFarBehind) return 'same-line';

  const verticalAdvance = nextCenterY - groupCenterY;
  const startsNearWritingMargin = nextBounds.x <= groupBounds.x + Math.max(groupBounds.width * 0.75, lineScale * 4)
    && nextBounds.x + nextBounds.width >= groupBounds.x - lineScale * 2;
  if (verticalAdvance >= lineScale * 0.9 && startsNearWritingMargin) return 'new-line';
  return 'unrelated';
}

/** Pure page-coordinate grouping; viewport zoom and DPR are intentionally absent. */
export function shouldGroupHandwritingStrokes(group: readonly Stroke[], next: Stroke): boolean {
  return classifyHandwritingStroke(group, next) === 'same-line';
}

/**
 * Owns only eligible Pen/Pencil strokes emitted while the independent mode is
 * active. Pending ink is mutable only until it is sealed. Sealed batches keep
 * exact cloned source strokes and are recognized serially in writing order.
 */
export class RealTimeHandwritingSession {
  private active = false;
  private pointerDown = false;
  private pending: Stroke[] = [];
  private physicalPoints = new Map<string, StrokePoint[]>();
  private timer: unknown = null;
  private scope = 0;
  private pageId: string | null = null;
  private batchSequence = 0;
  private sealedBatches: SealedRecognitionBatch[] = [];
  private processing = false;
  private destroyed = false;
  private preferences = sanitizeHandwritingToolPreferences(DEFAULT_HANDWRITING_TOOL_PREFERENCES);
  private feedbackListeners = new Set<(feedback: HandwritingSessionFeedback) => void>();
  private noticeGeneration = 0;
  private failureNoticeGeneration = -1;
  private readonly provider: HandwritingRecognitionProvider;
  private readonly commit: (conversion: HandwritingRecognitionCommit) => boolean;
  private readonly sourceStrokesExist: (strokes: readonly Stroke[]) => boolean;
  private readonly scheduler: HandwritingSessionScheduler;
  private readonly idleDelayMs: number;

  constructor(
    provider: HandwritingRecognitionProvider,
    commit: (conversion: HandwritingRecognitionCommit) => boolean,
    sourceStrokesExist: (strokes: readonly Stroke[]) => boolean,
    scheduler: HandwritingSessionScheduler = runtimeScheduler,
    idleDelayMs = HANDWRITING_IDLE_DELAY_MS,
  ) {
    this.provider = provider;
    this.commit = commit;
    this.sourceStrokesExist = sourceStrokesExist;
    this.scheduler = scheduler;
    this.idleDelayMs = idleDelayMs;
  }

  subscribeFeedback(listener: (feedback: HandwritingSessionFeedback) => void): () => void {
    this.feedbackListeners.add(listener);
    return () => this.feedbackListeners.delete(listener);
  }

  private feedback(feedback: HandwritingSessionFeedback): void {
    for (const listener of this.feedbackListeners) listener(feedback);
  }

  private feedbackOnce(feedback: HandwritingSessionFeedback, generation = this.noticeGeneration): void {
    if (generation !== this.noticeGeneration || this.failureNoticeGeneration === generation) return;
    this.failureNoticeGeneration = generation;
    this.feedback(feedback);
  }

  getPreferences(): Readonly<HandwritingToolPreferences> {
    return this.preferences;
  }

  setPreferences(preferences: unknown): void {
    this.preferences = sanitizeHandwritingToolPreferences(preferences);
  }

  setPageId(pageId: string | null): void {
    this.invalidateScope();
    this.pageId = pageId;
  }

  setActive(active: boolean): void {
    if (this.destroyed || this.active === active) return;
    this.active = active;
    if (!active) {
      // Turning the mode off mid-stroke cancels only that unfinished gesture.
      // Earlier sealed same-page batches remain valid and independently owned.
      if (this.pointerDown) {
        this.clearTimer();
        return;
      }
      this.flush();
      return;
    }
    this.noticeGeneration += 1;
    const activationScope = this.scope;
    const activationGeneration = this.noticeGeneration;
    void this.provider.isAvailable()
      .then(available => {
        if (!this.active || activationScope !== this.scope || available) return;
        this.feedbackOnce(
          { kind: 'unavailable', message: unavailableRecognitionMessage(this.provider.id, this.preferences.language) },
          activationGeneration,
        );
      })
      .catch(error => {
        if (!this.active || activationScope !== this.scope) return;
        this.feedbackOnce({
          kind: 'error',
          message: `${error instanceof Error ? error.message : 'Handwriting recognition failed.'} Your ink will be kept.`,
        }, activationGeneration);
      });
  }

  beginStroke(): void {
    if (!this.active || this.destroyed) return;
    this.pointerDown = true;
    this.clearTimer();
  }

  cancelStroke(): void {
    if (this.destroyed) return;
    this.pointerDown = false;
    if (!this.active) {
      this.flush();
      return;
    }
    if (this.pending.length > 0) this.schedule();
    this.drainSealedBatches();
  }

  completeStroke(stroke: Stroke, physicalPoints?: readonly StrokePoint[]): void {
    if (this.destroyed) return;
    this.pointerDown = false;
    if (!this.active) {
      this.flush();
      return;
    }
    this.clearTimer();
    const snapshot = structuredClone(stroke);
    if (this.pending.length > 0 && !shouldGroupHandwritingStrokes(this.pending, snapshot)) {
      this.sealPending();
    }
    if (physicalPoints) this.physicalPoints.set(snapshot.id, physicalPoints.map(point => ({ ...point })));
    this.pending = uniqueOrderedStrokes([...this.pending, snapshot]);
    this.schedule();
    this.drainSealedBatches();
  }

  /** Flushes a completed pending phrase. Recognition failure still leaves all ink intact. */
  flush(): void {
    this.clearTimer();
    if (this.pointerDown || this.pending.length === 0) return;
    this.sealPending();
    this.drainSealedBatches();
  }

  /** Page switch/unmount: preserve raw ink and make every outstanding result stale. */
  invalidateScope(): void {
    this.scope += 1;
    this.noticeGeneration += 1;
    this.pointerDown = false;
    this.clearTimer();
    this.pending = [];
    this.physicalPoints.clear();
    this.sealedBatches = [];
  }

  destroy(): void {
    this.destroyed = true;
    this.invalidateScope();
    this.feedbackListeners.clear();
  }

  /** Re-arm this owned session when its engine is remounted after an effect replay. */
  revive(): void {
    if (!this.destroyed) return;
    this.destroyed = false;
    this.active = false;
    this.pointerDown = false;
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      if (this.pointerDown) {
        this.schedule();
        return;
      }
      this.flush();
    }, this.idleDelayMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }

  private sealPending(): void {
    if (this.pending.length === 0) return;
    const strokes = uniqueOrderedStrokes(this.pending);
    this.pending = [];
    const recognitionStrokes = strokes.map(stroke => {
      const points = this.physicalPoints.get(stroke.id);
      this.physicalPoints.delete(stroke.id);
      return points ? { ...stroke, points } : stroke;
    });
    const sourceBounds = getHandwritingBounds(strokes);
    if (!sourceBounds) return;
    this.sealedBatches.push({
      id: `handwriting-${this.scope}-${++this.batchSequence}`,
      scope: this.scope,
      pageId: this.pageId,
      strokes,
      recognitionStrokes,
      sourceStrokeIds: strokes.map(stroke => stroke.id),
      sourceBounds: { ...sourceBounds },
      preferences: { ...this.preferences, recentColors: [...this.preferences.recentColors] },
    });
  }

  private drainSealedBatches(): void {
    if (this.processing || this.pointerDown || this.destroyed || this.sealedBatches.length === 0) return;
    this.processing = true;
    void this.processSealedBatches();
  }

  private async processSealedBatches(): Promise<void> {
    try {
      while (!this.pointerDown && !this.destroyed) {
        const batch = this.sealedBatches.shift();
        if (!batch) break;
        await this.recognize(batch);
      }
    } finally {
      this.processing = false;
      if (!this.pointerDown && !this.destroyed && this.sealedBatches.length > 0) this.drainSealedBatches();
    }
  }

  private async recognize(batch: SealedRecognitionBatch): Promise<void> {
    let result: RecognitionResult;
    try {
      // The provider receives its own clone. It cannot mutate sealed ownership
      // or the exact source snapshot retained for validation and undo.
      result = await this.provider.recognize(uniqueOrderedStrokes(batch.recognitionStrokes), {
        language: batch.preferences.language || undefined,
      });
    } catch (error) {
      if (batch.scope !== this.scope || this.destroyed) return;
      this.feedbackOnce({
        kind: 'error',
        message: `${error instanceof Error ? error.message : 'Handwriting recognition failed.'} Your ink was kept.`,
      });
      return;
    }
    if (batch.scope !== this.scope || this.destroyed) return;

    if (result.status === 'unavailable') {
      this.feedbackOnce({
        kind: 'unavailable',
        message: result.error || unavailableRecognitionMessage(this.provider.id, batch.preferences.language),
      });
      return;
    }
    if (result.status === 'error') {
      this.feedbackOnce({
        kind: 'error',
        message: `${result.error || 'The handwriting recognition bridge failed.'} Your ink was kept.`,
      });
      return;
    }
    if (result.status === 'empty' || !result.text.trim()) return;
    if (batch.sourceStrokeIds.length !== batch.strokes.length || !this.sourceStrokesExist(batch.strokes)) return;
    try {
      this.commit({
        batchId: batch.id,
        pageId: batch.pageId,
        strokes: uniqueOrderedStrokes(batch.strokes),
        sourceBounds: { ...batch.sourceBounds },
        result: { ...result, text: result.text.trim() },
        preferences: { ...batch.preferences, recentColors: [...batch.preferences.recentColors] },
        providerId: this.provider.id,
      });
    } catch (error) {
      this.feedbackOnce({
        kind: 'error',
        message: `${error instanceof Error ? error.message : 'Handwriting conversion failed.'} Your ink was kept.`,
      });
    }
  }
}
