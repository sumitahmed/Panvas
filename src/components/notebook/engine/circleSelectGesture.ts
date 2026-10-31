import type { StrokePoint } from './drawingTypes.ts';

export interface CircleGestureAnalysis {
  isCircle: boolean;
  closureDistance: number;
  width: number;
  height: number;
}

/** Recognize a deliberate closed loop while rejecting taps, open curves, and slow traces.
 * `screenScale` converts page-space samples to CSS pixels so size thresholds stay
 * zoom-invariant; aspect and closure ratios are scale-independent. */
export function analyzeCircleGesture(points: StrokePoint[], screenScale = 1): CircleGestureAnalysis {
  const scale = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
  if (points.length < 12) {
    return { isCircle: false, closureDistance: Infinity, width: 0, height: 0 };
  }
  if (scale !== 1) points = points.map(point => ({ ...point, x: point.x * scale, y: point.y * scale }));

  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  let pathLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1];
    minX = Math.min(minX, current.x);
    maxX = Math.max(maxX, current.x);
    minY = Math.min(minY, current.y);
    maxY = Math.max(maxY, current.y);
    pathLength += Math.hypot(current.x - previous.x, current.y - previous.y);
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const first = points[0];
  const last = points[points.length - 1];
  const closureDistance = Math.hypot(last.x - first.x, last.y - first.y);
  const duration = last.t - first.t;
  const minimumSpan = Math.min(width, height);
  const radiusX = width / 2;
  const radiusY = height / 2;
  const perimeterEstimate = Math.PI * (
    3 * (radiusX + radiusY) - Math.sqrt((3 * radiusX + radiusY) * (radiusX + 3 * radiusY))
  );
  const closedEnough = closureDistance <= Math.max(14, minimumSpan * 0.28);
  const plausibleLoopLength = pathLength >= perimeterEstimate * 0.68 && pathLength <= perimeterEstimate * 1.75;

  return {
    isCircle: duration <= 2_500
      && width >= 30
      && height >= 24
      && width / height <= 4
      && height / width <= 4
      && closedEnough
      && plausibleLoopLength,
    closureDistance,
    width,
    height,
  };
}

/** Even/odd point-in-polygon test used for selecting object centers. */
export function isPointInsideLoop(x: number, y: number, polygon: StrokePoint[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current];
    const b = polygon[previous];
    const crosses = (a.y > y) !== (b.y > y)
      && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}
