import type { Stroke } from './drawingTypes.ts';

const strokeSnapshotCache = new WeakMap<Stroke, Stroke>();

/** Detached persistence/history snapshot. Bulk numeric samples need no generic
 * structured-clone traversal; extensible object metadata still does.
 *
 * Uses WeakMap memoization so unchanging committed strokes in a document are
 * only point-cloned once, avoiding O(N * points) reallocations and GC pauses
 * during active drawing and autosave. */
export function cloneStrokeSnapshot(stroke: Stroke): Stroke {
  const cached = strokeSnapshotCache.get(stroke);
  if (cached) return cached;

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

  strokeSnapshotCache.set(stroke, snapshot);
  return snapshot;
}
