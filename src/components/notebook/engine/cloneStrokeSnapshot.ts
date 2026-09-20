import type { Stroke } from './drawingTypes.ts';

/** Detached persistence/history snapshot. Bulk numeric samples need no generic
 * structured-clone traversal; extensible object metadata still does. */
export function cloneStrokeSnapshot(stroke: Stroke): Stroke {
  const { points, inkClip, ...rest } = stroke;
  return {
    ...structuredClone(rest),
    points: points.map(point => ({ x: point.x, y: point.y, pressure: point.pressure, t: point.t })),
    ...('inkClip' in stroke ? { inkClip: inkClip?.map(polygon => polygon.map(ring => ring.map(([x,y]) => [x,y] as [number,number]))) } : {}),
  };
}
