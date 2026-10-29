import type { Stroke } from './drawingTypes.ts';

const strokeSnapshotCache = new WeakMap<Stroke, Stroke>();
// Committed scene snapshots and the page cache share numeric sample arrays.
// Track that detachment so a later handoff can clone only the small stroke
// header instead of copying every point for every page transfer.
const detachedStrokes = new WeakSet<Stroke>();

function cloneHeader(stroke: Stroke, cloneMetadata: boolean): Stroke {
  const { points, inkClip, metadata, ...rest } = stroke;
  // Most ink headers contain only scalar values. Avoid a native structured
  // clone call per stroke in that common case. Extensible nested metadata
  // retains the exact previous deep-clone/alias/error semantics.
  let scalarHeader = Object.getOwnPropertySymbols(rest).length === 0;
  for (const value of Object.values(rest)) {
    if ((value !== null && typeof value === 'object') || typeof value === 'function' || typeof value === 'symbol') {
      scalarHeader = false;
      break;
    }
  }

  const snapshot: Stroke = {
    ...(scalarHeader ? rest : structuredClone(rest)),
    ...(metadata === undefined ? {} : { metadata: cloneMetadata ? structuredClone(metadata) : metadata }),
    points,
    ...('inkClip' in stroke ? { inkClip } : {}),
  };
  detachedStrokes.add(snapshot);
  return snapshot;
}

/**
 * Register a stroke that is already detached from persisted/page-cache state as
 * its own persistence snapshot. Committed ink is immutable except for the
 * selection engine, which replaces the points/clip arrays instead of mutating
 * them in place, so the snapshot can share those numeric arrays. This turns the
 * first autosave after loading a dense page from an O(strokes * points) clone
 * into one shallow header per stroke.
 */
export function primeStrokeSnapshot(stroke: Stroke): void {
  detachedStrokes.add(stroke);
  if (strokeSnapshotCache.has(stroke)) return;
  strokeSnapshotCache.set(stroke, cloneHeader(stroke, true));
}

export function cloneStrokeSnapshot(stroke: Stroke): Stroke {
  const cached = strokeSnapshotCache.get(stroke);
  if (cached) return cached;

  // A page-cache snapshot already owns immutable numeric arrays. Preserve those
  // array identities across handoffs so process-wide geometry/metrics caches
  // keyed by the sample array continue to hit.
  if (detachedStrokes.has(stroke)) return cloneHeader(stroke, false);

  const { points, inkClip, ...rest } = stroke;
  // Most ink headers contain only scalar values. Avoid a native structured
  // clone call per stroke in that common case. Extensible nested metadata
  // retains the exact previous deep-clone/alias/error semantics.
  let scalarHeader = Object.getOwnPropertySymbols(rest).length === 0;
  for (const value of Object.values(rest)) {
    if ((value !== null && typeof value === 'object') || typeof value === 'function' || typeof value === 'symbol') {
      scalarHeader = false;
      break;
    }
  }

  const snapshot: Stroke = {
    ...(scalarHeader ? rest : structuredClone(rest)),
    points: points.map(point => ({ x: point.x, y: point.y, pressure: point.pressure, t: point.t })),
    ...('inkClip' in stroke ? { inkClip: inkClip?.map(polygon => polygon.map(ring => ring.map(([x,y]) => [x,y] as [number,number]))) } : {}),
  };

  detachedStrokes.add(snapshot);
  strokeSnapshotCache.set(stroke, snapshot);
  return snapshot;
}

/**
 * Adopt a stroke from an immutable page-cache payload. Unlike
 * cloneStrokeSnapshot this does not copy sample/clip arrays: page-cache data is
 * never mutated in place, selection replaces whole arrays on the engine's
 * (separately cloned) header, and sharing the numeric arrays preserves the
 * process-wide geometry cache across page handoffs.
 */
export function adoptPageStrokeSnapshot(stroke: Stroke): Stroke {
  const cached = strokeSnapshotCache.get(stroke);
  if (cached) return cached;
  const snapshot = cloneHeader(stroke, false);
  strokeSnapshotCache.set(stroke, snapshot);
  return snapshot;
}

/** Drop the memoized snapshot after an in-place point or clip mutation. */
export function invalidateStrokeSnapshot(stroke: Stroke): void {
  strokeSnapshotCache.delete(stroke);
  detachedStrokes.delete(stroke);
}
