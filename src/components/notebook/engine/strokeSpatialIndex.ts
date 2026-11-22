import type { Stroke } from './drawingTypes.ts';
import { boundsOverlap, eraseBounds, type EraseBounds } from './capsuleErase.ts';

/**
 * Minimum stroke count on a page before the 2D grid spatial index activates.
 * Below this threshold a linear pass with cached bounds is already sub-50µs
 * and avoids maintaining grid buckets while drawing light pages.
 */
export const SPATIAL_INDEX_THRESHOLD = 256;

/** World-space size of each spatial hash cell (CSS pixels). */
export const SPATIAL_CELL_SIZE = 128;

/**
 * Maximum number of grid cells a single query will inspect before falling back
 * to the full ordered stroke array (e.g., extreme zoom-out or whole-page marquee).
 */
export const MAX_QUERY_CELLS = 256;

const CELL_KEY_OFFSET = 33_554_432; // 2^25
const CELL_KEY_STRIDE = 67_108_864; // 2^26 (safe integer range for cell coords)

function cellKey(cx: number, cy: number): number {
  return (cy + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (cx + CELL_KEY_OFFSET);
}

/**
 * Intersect two optional world-space AABBs. When one side is null/undefined the
 * other bound is returned directly; when both are null/undefined returns null.
 */
export function intersectBounds(
  a: EraseBounds | null | undefined,
  b: EraseBounds | null | undefined
): EraseBounds | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

/** Returns true when a bounds rectangle is inverted / covers zero area. */
export function isEmptyBounds(bounds: EraseBounds | null | undefined): boolean {
  return Boolean(bounds && (bounds.right < bounds.left || bounds.bottom < bounds.top));
}

/**
 * Exact rotated-AABB intersection check for rectangular canvas objects
 * (shapes and images) against a world-space cull rectangle.
 */
export function objectIntersectsBounds(
  obj: { x: number; y: number; width: number; height: number; rotation?: number; strokeWidth?: number },
  bounds: EraseBounds
): boolean {
  const halfStroke = (obj.strokeWidth ?? 0) / 2;
  const cx = obj.x + obj.width / 2;
  const cy = obj.y + obj.height / 2;
  const hw = Math.abs(obj.width) / 2;
  const hh = Math.abs(obj.height) / 2;
  const rot = obj.rotation ?? 0;
  let extentX: number;
  let extentY: number;
  if (rot === 0) {
    extentX = hw + halfStroke;
    extentY = hh + halfStroke;
  } else {
    const rad = (rot * Math.PI) / 180;
    const absCos = Math.abs(Math.cos(rad));
    const absSin = Math.abs(Math.sin(rad));
    extentX = hw * absCos + hh * absSin + halfStroke;
    extentY = hw * absSin + hh * absCos + halfStroke;
  }
  return (
    cx + extentX >= bounds.left &&
    cx - extentX <= bounds.right &&
    cy + extentY >= bounds.top &&
    cy - extentY <= bounds.bottom
  );
}

export interface SpatialQueryResult {
  strokes: readonly Stroke[];
  /**
   * True when the returned slice was already filtered against `queryBounds`
   * (either via exact cell lookup or empty-bounds short-circuit). False when
   * the full ordered stroke list was returned so callers should apply per-stroke
   * AABB culling.
   */
  exactFilterApplied: boolean;
}

/**
 * Lightweight 2D uniform-grid spatial index for committed strokes on a page.
 * Preserves exact stroke z-order (array index) on every query while accelerating
 * viewport redraws, dirty-rect repaints, hit-testing, marquee selection, and
 * eraser sweeps on dense pages (>= SPATIAL_INDEX_THRESHOLD strokes).
 */
export class StrokeSpatialIndex {
  private cells = new Map<number, number[]>();
  private oversizedIndices: number[] = [];
  private boundsById = new Map<string, EraseBounds>();
  private indexedCount = 0;
  private dirty = true;
  private seenStamp: Uint32Array = new Uint32Array(0);
  private currentStamp = 1;
  private readonly computeBounds: (stroke: Stroke) => EraseBounds;

  constructor(computeBounds: (stroke: Stroke) => EraseBounds = eraseBounds) {
    this.computeBounds = computeBounds;
  }

  getBounds(stroke: Stroke): EraseBounds {
    let cached = this.boundsById.get(stroke.id);
    if (!cached) {
      cached = this.computeBounds(stroke);
      this.boundsById.set(stroke.id, cached);
    }
    return cached;
  }

  /** Clear cached geometry and trigger lazy rebuild on the next >=threshold query. */
  reset(): void {
    this.cells.clear();
    this.oversizedIndices.length = 0;
    this.boundsById.clear();
    this.indexedCount = 0;
    this.dirty = true;
  }

  /** Mark cell structure dirty while keeping valid cached bounds for unaffected strokes. */
  markStructureDirty(): void {
    this.cells.clear();
    this.oversizedIndices.length = 0;
    this.indexedCount = 0;
    this.dirty = true;
  }

  /** Invalidate a single stroke's cached bounds and mark cells dirty. */
  invalidateStroke(strokeId: string): void {
    this.boundsById.delete(strokeId);
    if (!this.dirty && this.indexedCount > 0) {
      this.markStructureDirty();
    }
  }

  /** Incrementally append a newly committed stroke when the index is already active and clean. */
  appendStroke(stroke: Stroke, totalStrokes: number): void {
    if (totalStrokes < SPATIAL_INDEX_THRESHOLD) {
      return;
    }
    if (this.dirty || this.indexedCount !== totalStrokes - 1) {
      this.dirty = true;
      return;
    }
    const index = totalStrokes - 1;
    this.insertIndex(stroke, index);
    this.indexedCount = totalStrokes;
    this.ensureSeenCapacity(totalStrokes);
  }

  /** Remove cached bounds for deleted strokes and mark the grid dirty if active. */
  removeStrokeIds(ids: Iterable<string>): void {
    for (const id of ids) {
      this.boundsById.delete(id);
    }
    if (this.indexedCount > 0 || !this.dirty) {
      this.markStructureDirty();
    }
  }

  /**
   * Query strokes intersecting `queryBounds`, preserving their z-order in
   * `orderedStrokes`.
   */
  query(
    queryBounds: EraseBounds | null | undefined,
    orderedStrokes: readonly Stroke[]
  ): SpatialQueryResult {
    const count = orderedStrokes.length;
    if (count === 0) {
      return { strokes: orderedStrokes, exactFilterApplied: true };
    }
    if (queryBounds && isEmptyBounds(queryBounds)) {
      return { strokes: [], exactFilterApplied: true };
    }
    if (!queryBounds || count < SPATIAL_INDEX_THRESHOLD) {
      return { strokes: orderedStrokes, exactFilterApplied: false };
    }

    const minCx = Math.floor(queryBounds.left / SPATIAL_CELL_SIZE);
    const maxCx = Math.floor(queryBounds.right / SPATIAL_CELL_SIZE);
    const minCy = Math.floor(queryBounds.top / SPATIAL_CELL_SIZE);
    const maxCy = Math.floor(queryBounds.bottom / SPATIAL_CELL_SIZE);

    const spanX = maxCx - minCx + 1;
    const spanY = maxCy - minCy + 1;
    if (spanX <= 0 || spanY <= 0) {
      return { strokes: [], exactFilterApplied: true };
    }
    if (spanX * spanY > MAX_QUERY_CELLS) {
      return { strokes: orderedStrokes, exactFilterApplied: false };
    }

    if (this.dirty || this.indexedCount !== count) {
      this.rebuild(orderedStrokes);
    }

    this.ensureSeenCapacity(count);
    this.currentStamp += 1;
    if (this.currentStamp >= 0xffff_fffe) {
      this.seenStamp.fill(0);
      this.currentStamp = 1;
    }
    const stamp = this.currentStamp;
    const seen = this.seenStamp;
    const matchedIndices: number[] = [];

    for (let cy = minCy; cy <= maxCy; cy += 1) {
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        const bucket = this.cells.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 1) {
          const idx = bucket[i];
          if (seen[idx] === stamp) continue;
          seen[idx] = stamp;
          const stroke = orderedStrokes[idx];
          if (!stroke) continue;
          if (boundsOverlap(queryBounds, this.getBounds(stroke))) {
            matchedIndices.push(idx);
          }
        }
      }
    }

    for (let i = 0; i < this.oversizedIndices.length; i += 1) {
      const idx = this.oversizedIndices[i];
      if (seen[idx] === stamp) continue;
      seen[idx] = stamp;
      const stroke = orderedStrokes[idx];
      if (!stroke) continue;
      if (boundsOverlap(queryBounds, this.getBounds(stroke))) {
        matchedIndices.push(idx);
      }
    }

    if (matchedIndices.length <= 1) {
      if (matchedIndices.length === 0) {
        return { strokes: [], exactFilterApplied: true };
      }
      return { strokes: [orderedStrokes[matchedIndices[0]]], exactFilterApplied: true };
    }

    matchedIndices.sort((a, b) => a - b);
    const result: Stroke[] = new Array(matchedIndices.length);
    for (let i = 0; i < matchedIndices.length; i += 1) {
      result[i] = orderedStrokes[matchedIndices[i]];
    }
    return { strokes: result, exactFilterApplied: true };
  }

  private ensureSeenCapacity(count: number): void {
    if (this.seenStamp.length < count) {
      this.seenStamp = new Uint32Array(Math.max(count, SPATIAL_INDEX_THRESHOLD));
      this.currentStamp = 1;
    }
  }

  private rebuild(orderedStrokes: readonly Stroke[]): void {
    this.cells.clear();
    this.oversizedIndices.length = 0;
    const count = orderedStrokes.length;
    for (let i = 0; i < count; i += 1) {
      this.insertIndex(orderedStrokes[i], i);
    }
    this.indexedCount = count;
    this.dirty = false;
    this.ensureSeenCapacity(count);
  }

  private insertIndex(stroke: Stroke, index: number): void {
    const b = this.getBounds(stroke);
    const minCx = Math.floor(b.left / SPATIAL_CELL_SIZE);
    const maxCx = Math.floor(b.right / SPATIAL_CELL_SIZE);
    const minCy = Math.floor(b.top / SPATIAL_CELL_SIZE);
    const maxCy = Math.floor(b.bottom / SPATIAL_CELL_SIZE);

    // Track large-span strokes once in `oversizedIndices` rather than expanding
    // into hundreds/thousands of buckets or clamping to a single cell.
    const spanX = maxCx - minCx + 1;
    const spanY = maxCy - minCy + 1;
    if (spanX * spanY > 64) {
      this.oversizedIndices.push(index);
      return;
    }

    for (let cy = minCy; cy <= maxCy; cy += 1) {
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        const key = cellKey(cx, cy);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push(index);
      }
    }
  }
}
