import { getInkFamilyRenderHalfWidth } from './inkFamilyGeometry.ts';
import type { Stroke, StrokePoint } from './drawingTypes.ts';

const EPSILON = 1e-7;

function clonePoint(point: StrokePoint): StrokePoint {
  return { ...point };
}

function interpolatePoint(start: StrokePoint, end: StrokePoint, t: number): StrokePoint {
  if (t <= EPSILON) return clonePoint(start);
  if (t >= 1 - EPSILON) return clonePoint(end);

  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    pressure: start.pressure + (end.pressure - start.pressure) * t,
    t: start.t + (end.t - start.t) * t,
  };
}

function samePoint(a: StrokePoint, b: StrokePoint): boolean {
  return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
}

function outsideIntervals(
  start: StrokePoint,
  end: StrokePoint,
  centerX: number,
  centerY: number,
  radius: number,
): Array<[number, number]> {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const a = dx * dx + dy * dy;
  const startX = start.x - centerX;
  const startY = start.y - centerY;
  const radiusSq = radius * radius;

  if (a <= EPSILON) {
    return startX * startX + startY * startY > radiusSq ? [[0, 1]] : [];
  }

  const b = 2 * (startX * dx + startY * dy);
  const c = startX * startX + startY * startY - radiusSq;
  const discriminant = b * b - 4 * a * c;

  // A tangent removes no measurable part of the rendered segment.
  if (discriminant <= EPSILON) {
    const midpointX = startX + dx * 0.5;
    const midpointY = startY + dy * 0.5;
    return midpointX * midpointX + midpointY * midpointY >= radiusSq ? [[0, 1]] : [];
  }

  const root = Math.sqrt(discriminant);
  const roots = [(-b - root) / (2 * a), (-b + root) / (2 * a)]
    .filter(value => value > EPSILON && value < 1 - EPSILON)
    .sort((left, right) => left - right);
  const cuts = [0, ...roots, 1];
  const intervals: Array<[number, number]> = [];

  for (let index = 0; index < cuts.length - 1; index++) {
    const from = cuts[index];
    const to = cuts[index + 1];
    if (to - from <= EPSILON) continue;

    const midpoint = (from + to) / 2;
    const midpointX = startX + dx * midpoint;
    const midpointY = startY + dy * midpoint;
    if (midpointX * midpointX + midpointY * midpointY >= radiusSq) {
      intervals.push([from, to]);
    }
  }

  return intervals;
}

/**
 * Remove a circular region from a polyline without resampling any surviving source points.
 * Only the two exact circle-intersection points at a cut boundary are synthesized.
 */
export function splitStrokePointsOutsideCircle(
  points: readonly StrokePoint[],
  centerX: number,
  centerY: number,
  radius: number,
  protectedIntervalForSegment?: (start: StrokePoint, end: StrokePoint) => [number, number] | null,
): StrokePoint[][] {
  if (points.length < 2) return [];

  const segments: StrokePoint[][] = [];
  let current: StrokePoint[] = [];

  const finishCurrent = () => {
    if (current.length >= 2) segments.push(current);
    current = [];
  };

  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index];
    const end = points[index + 1];
    const outside = outsideIntervals(start, end, centerX, centerY, radius);
    const protectedInterval = protectedIntervalForSegment?.(start, end) ?? null;
    const cuts = [0, 1, ...outside.flat(), ...(protectedInterval ?? [])]
      .filter(value => value >= 0 && value <= 1)
      .sort((left, right) => left - right)
      .filter((value, cutIndex, values) => cutIndex === 0 || Math.abs(value - values[cutIndex - 1]) > EPSILON);
    const intervals: Array<[number, number]> = [];
    for (let cutIndex = 0; cutIndex < cuts.length - 1; cutIndex++) {
      const from = cuts[cutIndex];
      const to = cuts[cutIndex + 1];
      if (to - from <= EPSILON) continue;
      const midpoint = (from + to) / 2;
      const midpointX = start.x + (end.x - start.x) * midpoint;
      const midpointY = start.y + (end.y - start.y) * midpoint;
      const outsideEraser = Math.hypot(midpointX - centerX, midpointY - centerY) >= radius;
      const protectedByRuler = Boolean(protectedInterval && midpoint >= protectedInterval[0] && midpoint <= protectedInterval[1]);
      if (outsideEraser || protectedByRuler) intervals.push([from, to]);
    }

    if (intervals.length === 0) {
      finishCurrent();
      continue;
    }

    for (const [from, to] of intervals) {
      const intervalStart = interpolatePoint(start, end, from);
      const intervalEnd = interpolatePoint(start, end, to);
      const continuesPrevious = from <= EPSILON
        && current.length > 0
        && samePoint(current[current.length - 1], intervalStart);

      if (!continuesPrevious) {
        finishCurrent();
        current.push(intervalStart);
      }

      if (!samePoint(current[current.length - 1], intervalEnd)) {
        current.push(intervalEnd);
      }

      if (to < 1 - EPSILON) finishCurrent();
    }
  }

  finishCurrent();
  return segments;
}

/** The rendered half-width used by visual hit-testing and eraser clipping. */
export function getStrokeRenderHalfWidth(stroke: Stroke): number {
  if (stroke.inkFamily) return getInkFamilyRenderHalfWidth(stroke);
  const thickness = Math.max(0, stroke.thickness || 0);
  let maxPressure = 0.5;
  for (const point of stroke.points) {
    const pressure = point.pressure || 0.5;
    if (pressure > maxPressure) maxPressure = pressure;
  }

  switch (stroke.tool) {
    case 'marker':
      return Math.max(4, thickness * 3) / 2;
    case 'highlighter':
      return Math.max(8, thickness * 6) / 2;
    case 'pen':
      return Math.max(0.5, thickness * maxPressure * 2) / 2;
    case 'pencil':
      // Each of the two pencil passes is offset by at most one CSS pixel.
      return Math.max(0.3, thickness * maxPressure * 0.75) / 2 + 1;
    case 'eraser':
      return Math.max(2, thickness * 3) / 2;
    default:
      return thickness / 2;
  }
}

/** Stable pencil grain that does not change when a stroke is split into new arrays. */
export function getPencilRenderPoint(point: StrokePoint, pass: number): { x: number; y: number } {
  const seed = point.x * 0.173 + point.y * 0.197 + point.t * 0.031;
  const jitterScale = 0.5 * (pass + 1);
  return {
    x: point.x + Math.sin(seed * 7.3 + pass * 13.7) * jitterScale,
    y: point.y + Math.cos(seed * 11.1 + pass * 17.3) * jitterScale,
  };
}
