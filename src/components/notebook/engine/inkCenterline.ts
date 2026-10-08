import type { StrokePoint } from './drawingTypes.ts';

/** Causal, bounded local Hermite interpolation. Completed segments never change.
 * Store the sampled curve in the existing page-space polyline representation so
 * wet/dry ink, erasing, selection, persistence and exports share identical points.
 * This does not reinterpret saved strokes or add a second input filter. */
export class InkCenterline {
  private previous: StrokePoint | null = null;
  private directionX = 0;
  private directionY = 0;
  private tangentX = 0;
  private tangentY = 0;
  private previousLength = 0;

  reset(): void { this.previous = null; this.previousLength = 0; }

  append(point: StrokePoint, output: StrokePoint[], screenScale = 1): void {
    const a = this.previous;
    this.previous = point;
    if (!a) { output.push(point); return; }
    const dx = point.x - a.x, dy = point.y - a.y, length = Math.hypot(dx, dy);
    if (length < 1e-8) { output.push(point); return; }
    const ux = dx / length, uy = dy / length;
    const turn = Math.atan2(this.directionX * uy - this.directionY * ux, this.directionX * ux + this.directionY * uy);
    const curve = this.previousLength > 1e-8 && Math.abs(turn) < Math.PI / 3
      && length / this.previousLength < 4 && this.previousLength / length < 4;
    let endX = ux, endY = uy;
    if (curve) {
      // Extrapolate half the local turn, without extrapolating the endpoint.
      const c = Math.cos(turn / 2), s = Math.sin(turn / 2);
      endX = ux * c - uy * s; endY = ux * s + uy * c;
      const scale = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
      const normalLimit = Math.min(length / 4, 2 / scale);
      const along1 = Math.max(0, Math.min(length / 2, (this.tangentX * ux + this.tangentY * uy) * length / 3));
      const normal1 = Math.max(-normalLimit, Math.min(normalLimit, (-this.tangentX * uy + this.tangentY * ux) * length / 3));
      const along2 = Math.max(0, Math.min(length / 2, (endX * ux + endY * uy) * length / 3));
      const normal2 = Math.max(-normalLimit, Math.min(normalLimit, (-endX * uy + endY * ux) * length / 3));
      const c1x = a.x + ux * along1 - uy * normal1, c1y = a.y + uy * along1 + ux * normal1;
      const c2x = point.x - ux * along2 + uy * normal2, c2y = point.y - uy * along2 - ux * normal2;
      const bend = Math.max(Math.hypot(a.x - 2 * c1x + c2x, a.y - 2 * c1y + c2y),
        Math.hypot(c1x - 2 * c2x + point.x, c1y - 2 * c2y + point.y));
      // Cubic second-derivative bound gives <= .025 CSS-pixel chord error.
      // An extreme sampling gap stays a chord instead of allocating an
      // unbounded number of subdivisions. Normal input needs only a few.
      const steps = Math.max(1, Math.ceil(Math.sqrt(3 * bend * scale / (.025 * 4))));
      if (steps > 32) { endX = ux; endY = uy; }
      for (let i = 1; steps <= 32 && i < steps; i++) {
        const u = i / steps, v = 1 - u;
        output.push({ x: v ** 3 * a.x + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u ** 3 * point.x,
          y: v ** 3 * a.y + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u ** 3 * point.y,
          pressure: a.pressure + (point.pressure - a.pressure) * u, t: a.t + (point.t - a.t) * u });
      }
    }
    // Dots, two-point flicks and deliberate sharp turns retain their exact joins.
    output.push(point);
    this.directionX = ux; this.directionY = uy;
    this.tangentX = endX; this.tangentY = endY;
    this.previousLength = length;
  }
}
