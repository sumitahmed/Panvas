import type { Stroke, StrokePoint } from './drawingTypes.ts';
import type { InkPoint } from './inkRegion.ts';
import { getStrokeRenderHalfWidth } from './strokeGeometry.ts';
import { getInkFamilyMaximumHalfWidth } from './inkFamilyGeometry.ts';

type Interval = [number, number];
export type EraseBounds = { left: number; top: number; right: number; bottom: number };
export function eraseBoundsWithHalfWidth(stroke: Stroke, halfWidth: number): EraseBounds {
  const pad = halfWidth + 2;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of stroke.points) {
    left = Math.min(left, p.x - pad); right = Math.max(right, p.x + pad);
    top = Math.min(top, p.y - pad); bottom = Math.max(bottom, p.y + pad);
  }
  return { left, top, right, bottom };
}
export function strokeBoundsPadding(stroke: Stroke): number {
  const halfWidth = stroke.inkFamily ? getInkFamilyMaximumHalfWidth(stroke) : getStrokeRenderHalfWidth(stroke);
  // A square cap extends half the stroke width along its tangent and in both
  // perpendicular directions, so its axis-aligned diagonal reach is halfWidth * sqrt(2).
  return (stroke.tool === 'highlighter' ? halfWidth * Math.SQRT2 : halfWidth) + 2;
}

export function eraseBounds(stroke: Stroke): EraseBounds {
  // eraseBoundsWithHalfWidth adds +2 internally.
  return eraseBoundsWithHalfWidth(stroke, strokeBoundsPadding(stroke) - 2);
}
export const boundsOverlap = (a: EraseBounds, b: EraseBounds) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

/** Intersection of a line segment with a swept disk. Constant work, independent
 * of pointer travel distance. Independently implemented analytic geometry. */
export function capsuleInterval(p: InkPoint, q: InkPoint, a: InkPoint, b: InkPoint, radius: number): Interval | null {
  const dx = q.x - p.x, dy = q.y - p.y;
  const intervals: Interval[] = [];
  const circle = (c: InkPoint) => {
    const x = p.x - c.x, y = p.y - c.y;
    const aa = dx * dx + dy * dy, cc = x * x + y * y - radius * radius;
    if (aa < 1e-20) { if (cc <= 0) intervals.push([0, 1]); return; }
    const bb = x * dx + y * dy, disc = bb * bb - aa * cc;
    if (disc <= 0) return;
    const root = Math.sqrt(disc);
    const lo = Math.max(0, (-bb - root) / aa), hi = Math.min(1, (-bb + root) / aa);
    if (lo < hi) intervals.push([lo, hi]);
  };
  circle(a); circle(b);
  const sx = b.x - a.x, sy = b.y - a.y, length = Math.hypot(sx, sy);
  if (length > 1e-10) {
    const ux = sx / length, uy = sy / length;
    let lo = 0, hi = 1;
    const slab = (origin: number, delta: number, min: number, max: number) => {
      if (Math.abs(delta) < 1e-15) { if (origin < min || origin > max) hi = -1; return; }
      const t0 = (min - origin) / delta, t1 = (max - origin) / delta;
      lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
    };
    slab((p.x - a.x) * ux + (p.y - a.y) * uy, dx * ux + dy * uy, 0, length);
    slab(-(p.x - a.x) * uy + (p.y - a.y) * ux, -dx * uy + dy * ux, -radius, radius);
    if (lo < hi) intervals.push([lo, hi]);
  }
  if (!intervals.length) return null;
  // A capsule is convex, so the union is one interval.
  return [Math.min(...intervals.map(i => i[0])), Math.max(...intervals.map(i => i[1]))];
}

const interpolate = (p: StrokePoint, q: StrokePoint, t: number): StrokePoint => ({
  x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t,
  pressure: p.pressure + (q.pressure - p.pressure) * t, t: p.t + (q.t - p.t) * t,
});

const polylineLength = (points: StrokePoint[]): number => {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
};

function squareCapTangent(points: StrokePoint[], fromEnd: boolean): InkPoint {
  if (!fromEnd) {
    const start = points[0];
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - start.x;
      const dy = points[i].y - start.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) return { x: dx / len, y: dy / len };
    }
  } else {
    const end = points[points.length - 1];
    for (let i = points.length - 2; i >= 0; i--) {
      const dx = end.x - points[i].x;
      const dy = end.y - points[i].y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) return { x: dx / len, y: dy / len };
    }
  }
  return { x: 1, y: 0 };
}

function pointInOrientedSquare(
  point: InkPoint,
  center: InkPoint,
  tangent: InkPoint,
  halfWidth: number,
): boolean {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const along = Math.abs(dx * tangent.x + dy * tangent.y);
  const across = Math.abs(-dx * tangent.y + dy * tangent.x);
  return along <= halfWidth + 1e-6 && across <= halfWidth + 1e-6;
}

function squareCapHitsCapsule(
  center: InkPoint,
  tangent: InkPoint,
  halfWidth: number,
  a: InkPoint,
  b: InkPoint,
  radius: number,
): boolean {
  if (pointInOrientedSquare(a, center, tangent, halfWidth) || pointInOrientedSquare(b, center, tangent, halfWidth)) {
    return true;
  }
  const ux = tangent.x * halfWidth;
  const uy = tangent.y * halfWidth;
  const nx = -tangent.y * halfWidth;
  const ny = tangent.x * halfWidth;
  const c0 = { x: center.x - ux - nx, y: center.y - uy - ny };
  const c1 = { x: center.x + ux - nx, y: center.y + uy - ny };
  const c2 = { x: center.x + ux + nx, y: center.y + uy + ny };
  const c3 = { x: center.x - ux + nx, y: center.y - uy + ny };
  return capsuleInterval(c0, c1, a, b, radius) !== null
    || capsuleInterval(c1, c2, a, b, radius) !== null
    || capsuleInterval(c2, c3, a, b, radius) !== null
    || capsuleInterval(c3, c0, a, b, radius) !== null;
}

function trimHighlighterCapEndpoints(
  stroke: Stroke,
  a: InkPoint,
  b: InkPoint,
  radius: number,
): StrokePoint[][] | null {
  const points = stroke.points;
  if (stroke.tool !== 'highlighter' || points.length === 0) return null;
  const halfWidth = getStrokeRenderHalfWidth(stroke);
  if (points.length === 1) {
    return squareCapHitsCapsule(points[0], { x: 1, y: 0 }, halfWidth, a, b, radius) ? [] : null;
  }

  let next = [...points];
  let trimmed = false;

  const trimFront = (pts: StrokePoint[]): StrokePoint[] => {
    const tangent = squareCapTangent(pts, false);
    if (!squareCapHitsCapsule(pts[0], tangent, halfWidth, a, b, radius)) return pts;
    trimmed = true;
    const total = polylineLength(pts);
    const maxTrim = Math.min(total, halfWidth * 2 + radius + 2);
    let lo = 0;
    let hi = maxTrim;
    const sampleAt = (dist: number): { point: StrokePoint; tail: StrokePoint[]; tan: InkPoint } | null => {
      let rem = dist;
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        const segLen = Math.hypot(q.x - p.x, q.y - p.y);
        if (segLen <= 1e-6) continue;
        if (rem <= segLen) {
          const t = rem / segLen;
          const pt = interpolate(p, q, t);
          return {
            point: pt,
            tail: [pt, ...pts.slice(i + 1)],
            tan: { x: (q.x - p.x) / segLen, y: (q.y - p.y) / segLen },
          };
        }
        rem -= segLen;
      }
      return null;
    };
    const atMax = sampleAt(hi);
    if (!atMax || squareCapHitsCapsule(atMax.point, atMax.tan, halfWidth, a, b, radius)) {
      if (hi >= total - 0.5) return [];
      return atMax ? atMax.tail : [];
    }
    for (let iter = 0; iter < 16; iter++) {
      const mid = (lo + hi) * 0.5;
      const sample = sampleAt(mid);
      if (!sample || squareCapHitsCapsule(sample.point, sample.tan, halfWidth, a, b, radius)) lo = mid;
      else hi = mid;
    }
    const finalSample = sampleAt(hi);
    return finalSample ? finalSample.tail : [];
  };

  next = trimFront(next);
  if (next.length >= 2) {
    const reversed = [...next].reverse();
    const trimmedReversed = trimFront(reversed);
    next = [...trimmedReversed].reverse();
  }
  if (!trimmed) return null;
  if (next.length < 2 || polylineLength(next) < 0.5) return [];
  return [next];
}

/** Null means untouched. Empty means fully removed. No surviving sample is
 * resampled; boundary samples interpolate pressure and time. */
export function splitOutsideCapsule(stroke: Stroke, a: InkPoint, b: InkPoint, radius: number): StrokePoint[][] | null {
  const points = stroke.points;
  const padding = getStrokeRenderHalfWidth(stroke);
  const result: StrokePoint[][] = [];
  let current: StrokePoint[] = [], changed = false;
  const finish = () => { if (current.length) result.push(current); current = []; };
  for (let i = 0; i < Math.max(1, points.length - 1); i++) {
    const p = points[i], q = points[Math.min(i + 1, points.length - 1)];
    if (!p) break;
    const cut = capsuleInterval(p, q, a, b, radius + padding);
    if (!cut) { if (!current.length) current.push(p); current.push(q); continue; }
    changed = true;
    if (cut[0] > 1e-9) { if (!current.length) current.push(p); current.push(interpolate(p, q, cut[0])); }
    finish();
    if (cut[1] < 1 - 1e-9) current.push(interpolate(p, q, cut[1]), q);
  }
  finish();
  if (changed) {
    // Discard degenerate cut stubs (< 0.5 px) that would otherwise render a full
    // square highlighter cap over the erased point.
    return result.filter(fragment => fragment.length >= 2 && polylineLength(fragment) >= 0.5);
  }
  return trimHighlighterCapEndpoints(stroke, a, b, radius);
}

export function strokeHitsCapsule(stroke: Stroke, a: InkPoint, b: InkPoint, radius: number): boolean {
  const padding = getStrokeRenderHalfWidth(stroke);
  if (stroke.points.some((p, i, points) => capsuleInterval(p, points[Math.min(i + 1, points.length - 1)], a, b, radius + padding) !== null)) {
    return true;
  }
  if (stroke.tool !== 'highlighter' || stroke.points.length === 0) return false;
  if (stroke.points.length === 1) {
    return squareCapHitsCapsule(stroke.points[0], { x: 1, y: 0 }, padding, a, b, radius);
  }
  return squareCapHitsCapsule(stroke.points[0], squareCapTangent(stroke.points, false), padding, a, b, radius)
    || squareCapHitsCapsule(stroke.points[stroke.points.length - 1], squareCapTangent(stroke.points, true), padding, a, b, radius);
}
