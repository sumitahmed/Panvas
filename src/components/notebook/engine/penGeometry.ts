import type { Stroke, StrokePoint } from './drawingTypes.ts';
import { inkWidthAt } from './inkFamilyGeometry.ts';

export interface InkBounds { left: number; top: number; right: number; bottom: number }
export function unionInkBounds(a: InkBounds | null, b: InkBounds): InkBounds {
  return a ? { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) } : { ...b };
}

/** Local straight segments through every sample. Width may need one future point
 * (fountain) or a distance-bounded end taper (brush), but XY never does. */
export class PenGeometry {
  points: StrokePoint[] = [];
  readonly distances: number[] = [];
  update(points: StrokePoint[]): boolean {
    const reset = this.points !== points || points.length < this.distances.length;
    if (reset) this.distances.length = 0;
    this.points = points;
    for (let i = this.distances.length; i < points.length; i++) {
      this.distances.push(i ? this.distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) : 0);
    }
    return reset;
  }
  width(stroke: Stroke, i: number): number {
    const point = this.points[i];
    if (!stroke.inkFamily) return Math.max(.5, stroke.thickness * point.pressure * 2);
    const before = this.points[Math.max(0, i - 1)], after = this.points[Math.min(this.points.length - 1, i + 1)];
    return inkWidthAt(stroke.inkFamily, { pressure: point.pressure, direction: Math.atan2(after.y - before.y, after.x - before.x),
      thickness: stroke.thickness, distance: this.distances[i], length: this.distances[this.distances.length - 1] ?? 0 });
  }
  /** Exclusive stable primitive index. Never freeze a nib width needing lookahead. */
  stableEnd(stroke: Stroke): number {
    let end = Math.max(0, this.points.length - 1);
    if (stroke.inkFamily === 'brush') {
      const threshold = (this.distances[this.distances.length - 1] ?? 0) - Math.max(1, stroke.thickness * 4);
      while (end > 0 && this.distances[end - 1] > threshold) end--;
    }
    return end;
  }
  bounds(stroke: Stroke, start: number, end: number): InkBounds | null {
    let bounds: InkBounds | null = null;
    for (let i = Math.max(0, start - 1); i < end; i++) {
      const p = this.points[i], r = this.width(stroke, i) / 2 + 2;
      bounds = unionInkBounds(bounds, { left: p.x - r, top: p.y - r, right: p.x + r, bottom: p.y + r });
    }
    return bounds;
  }
  /** All primitives have the same winding, so a single fill unions overlaps. */
  trace(path: Pick<Path2D, 'moveTo' | 'lineTo' | 'arc' | 'rect' | 'closePath'>, stroke: Stroke, start = 0, end = this.points.length): void {
    const disk = (p: StrokePoint, radius: number) => {
      path.moveTo(p.x + radius, p.y);
      path.arc(p.x, p.y, radius, 0, Math.PI * 2);
      path.closePath();
    };
    for (let i = start; i < end; i++) {
      const b = this.points[i], rb = this.width(stroke, i) / 2;
      if (!i) {
        if (stroke.inkFamily === 'felt') {
          if (this.points.length === 1) path.rect(b.x - rb, b.y - rb, rb * 2, rb * 2);
        }
        else disk(b, rb);
        continue;
      }
      const a = this.points[i - 1], ra = this.width(stroke, i - 1) / 2;
      const angle = Math.atan2(b.y - a.y, b.x - a.x), nx = -Math.sin(angle), ny = Math.cos(angle);
      path.moveTo(a.x + nx * ra, a.y + ny * ra);
      path.lineTo(a.x - nx * ra, a.y - ny * ra);
      path.lineTo(b.x - nx * rb, b.y - ny * rb);
      path.lineTo(b.x + nx * rb, b.y + ny * rb);
      path.closePath();
      if (stroke.inkFamily !== 'felt' || i > 1) disk(a, ra);
      if (stroke.inkFamily !== 'felt' || i < this.points.length - 1) disk(b, rb);
    }
  }
}

/** Export the same filled primitives; do not reintroduce legacy curve smoothing. */
export function penGeometrySvg(stroke: Stroke, sx = 1, sy = 1): string {
  const commands: string[] = [];
  const geometry = new PenGeometry();
  geometry.update(stroke.points);
  geometry.trace({
    moveTo: (x, y) => { commands.push(`M${x * sx} ${y * sy}`); },
    lineTo: (x, y) => { commands.push(`L${x * sx} ${y * sy}`); },
    closePath: () => { commands.push('Z'); },
    rect: (x, y, w, h) => { commands.push(`M${x * sx} ${y * sy} h${w * sx} v${h * sy} h${-w * sx} Z`); },
    // PenGeometry emits full clockwise disks only. Two arcs preserve their winding.
    arc: (x, y, radius) => {
      const rx = radius * sx, ry = radius * sy;
      commands.push(`A${rx} ${ry} 0 1 1 ${(x - radius) * sx} ${y * sy} A${rx} ${ry} 0 1 1 ${(x + radius) * sx} ${y * sy}`);
    },
  }, stroke);
  return commands.join(' ');
}
