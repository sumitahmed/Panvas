import type { StrokePoint } from './drawingTypes.ts';

export interface ScribbleAnalysis {
  isScribble: boolean;
  reversals: number;
  pathLength: number;
}

/**
 * Recognize a deliberate scratch gesture without consuming ordinary writing.
 * A scribble must be quick, travel a meaningful distance, and reverse repeatedly
 * along its dominant axis. The caller still requires intersections with existing ink.
 * `screenScale` converts page-space samples to CSS pixels so span/length
 * thresholds describe the gesture the user actually drew, independent of zoom.
 */
export function analyzeScribble(points: StrokePoint[], screenScale = 1): ScribbleAnalysis {
  const scale = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
  if (points.length < 10) return { isScribble: false, reversals: 0, pathLength: 0 };
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
  const dominantAxis: 'x' | 'y' = width >= height ? 'x' : 'y';
  const dominantSpan = Math.max(width, height);
  const duration = points[points.length - 1].t - points[0].t;
  const minimumDelta = Math.max(3, dominantSpan * 0.035);
  let direction = 0;
  let reversals = 0;

  for (let index = 1; index < points.length; index += 1) {
    const delta = points[index][dominantAxis] - points[index - 1][dominantAxis];
    if (Math.abs(delta) < minimumDelta) continue;
    const nextDirection = Math.sign(delta);
    if (direction !== 0 && nextDirection !== direction) reversals += 1;
    direction = nextDirection;
  }

  const diagonal = Math.hypot(width, height);
  const isScribble = duration <= 1_600
    && dominantSpan >= 28
    && pathLength >= 90
    && pathLength >= diagonal * 2.4
    && reversals >= 4;

  return { isScribble, reversals, pathLength };
}

/** Find existing strokes repeatedly crossed by a recognized gesture. */
export function findScribbleTargets(
  points: StrokePoint[],
  findNearPoint: (x: number, y: number, radius: number) => string[],
  radius: number,
): Set<string> {
  const hitCounts = new Map<string, number>();
  const sampleStep = 6;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const samples = Math.max(1, Math.ceil(distance / sampleStep));
    for (let sample = 0; sample <= samples; sample += 1) {
      const t = sample / samples;
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      for (const id of findNearPoint(x, y, radius)) {
        hitCounts.set(id, (hitCounts.get(id) ?? 0) + 1);
      }
    }
  }

  return new Set([...hitCounts].filter(([, count]) => count >= 3).map(([id]) => id));
}
