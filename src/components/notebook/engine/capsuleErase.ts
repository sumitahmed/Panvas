import type { Stroke, StrokePoint } from './drawingTypes.ts';
import type { InkPoint } from './inkRegion.ts';
import { getStrokeRenderHalfWidth } from './strokeGeometry.ts';
import { getInkFamilyMaximumHalfWidth } from './inkFamilyGeometry.ts';

type Interval = [number, number];
export type EraseBounds = { left: number; top: number; right: number; bottom: number };
export function eraseBounds(stroke: Stroke): EraseBounds {
  const pad = (stroke.inkFamily ? getInkFamilyMaximumHalfWidth(stroke) : getStrokeRenderHalfWidth(stroke)) + 2;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of stroke.points) {
    left = Math.min(left,p.x-pad); right = Math.max(right,p.x+pad);
    top = Math.min(top,p.y-pad); bottom = Math.max(bottom,p.y+pad);
  }
  return { left, top, right, bottom };
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
    slab((p.x-a.x)*ux+(p.y-a.y)*uy, dx*ux+dy*uy, 0, length);
    slab(-(p.x-a.x)*uy+(p.y-a.y)*ux, -dx*uy+dy*ux, -radius, radius);
    if (lo < hi) intervals.push([lo, hi]);
  }
  if (!intervals.length) return null;
  // A capsule is convex, so the union is one interval.
  return [Math.min(...intervals.map(i => i[0])), Math.max(...intervals.map(i => i[1]))];
}

const interpolate = (p: StrokePoint, q: StrokePoint, t: number): StrokePoint => ({
  x: p.x + (q.x-p.x)*t, y: p.y + (q.y-p.y)*t,
  pressure: p.pressure + (q.pressure-p.pressure)*t, t: p.t + (q.t-p.t)*t,
});

/** Null means untouched. Empty means fully removed. No surviving sample is
 * resampled; boundary samples interpolate pressure and time. */
export function splitOutsideCapsule(stroke: Stroke, a: InkPoint, b: InkPoint, radius: number): StrokePoint[][] | null {
  const points = stroke.points;
  const padding = getStrokeRenderHalfWidth(stroke);
  const result: StrokePoint[][] = [];
  let current: StrokePoint[] = [], changed = false;
  const finish = () => { if (current.length) result.push(current); current = []; };
  for (let i = 0; i < Math.max(1, points.length - 1); i++) {
    const p = points[i], q = points[Math.min(i+1, points.length-1)];
    if (!p) break;
    const cut = capsuleInterval(p, q, a, b, radius + padding);
    if (!cut) { if (!current.length) current.push(p); current.push(q); continue; }
    changed = true;
    if (cut[0] > 1e-9) { if (!current.length) current.push(p); current.push(interpolate(p,q,cut[0])); }
    finish();
    if (cut[1] < 1-1e-9) current.push(interpolate(p,q,cut[1]), q);
  }
  finish();
  return changed ? result : null;
}

export function strokeHitsCapsule(stroke: Stroke, a: InkPoint, b: InkPoint, radius: number): boolean {
  const padding = getStrokeRenderHalfWidth(stroke);
  return stroke.points.some((p, i, points) => capsuleInterval(p, points[Math.min(i+1,points.length-1)], a,b,radius+padding) !== null);
}
