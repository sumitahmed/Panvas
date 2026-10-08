import type { StrokePoint } from './drawingTypes.ts';

/** Maps PointerEvent pressure without inventing pressure for devices that do not report it. */
export function mapPointerPressure(pointerType: string, pressure: number, enabled: boolean): number {
  if (!enabled || pointerType === 'mouse' || !Number.isFinite(pressure) || pressure <= 0) return 0.5;
  return Math.max(0.01, Math.min(1, pressure));
}

/** Speed-adaptive One Euro centerline filter (Casiez et al., CHI 2012).
 * Physical samples are retained by InputManager; only the visible centerline is
 * filtered. Parameters use CSS pixels and seconds, independent of page zoom/DPR.
 * Pressure/timestamps pass through unchanged. No prediction or lift-time snap. */
export class InkInputFilter {
  private previous: StrokePoint | null = null;
  private x = 0;
  private y = 0;
  private velocityX = 0;
  private velocityY = 0;

  reset(): void {
    this.previous = null;
    this.velocityX = this.velocityY = 0;
  }

  push(raw: StrokePoint, stabilization: number, screenScale = 1): StrokePoint {
    const scale = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
    const amount = Number.isFinite(stabilization) ? Math.max(0, Math.min(1, stabilization / 100)) : 0;
    const previous = this.previous;
    this.previous = raw;
    const x = raw.x * scale, y = raw.y * scale;
    if (!previous || amount === 0) {
      this.x = x; this.y = y;
      this.velocityX = this.velocityY = 0;
      return { ...raw };
    }
    // Equal timestamps can carry distinct pressure/position; do not drop them.
    const dt = Math.max(.001, (raw.t - previous.t) / 1000 || 1 / 240);
    const derivativeAlpha = 1 / (1 + 1 / (2 * Math.PI * 10 * dt));
    this.velocityX += derivativeAlpha * ((x - previous.x * scale) / dt - this.velocityX);
    this.velocityY += derivativeAlpha * ((y - previous.y * scale) / dt - this.velocityY);
    const cutoff = 6 + 38 * (1 - amount) ** 2 + .04 * Math.hypot(this.velocityX, this.velocityY);
    // Limit the filter time constant to 20 ms, including slow motion.
    const alpha = Math.max(1 / (1 + 1 / (2 * Math.PI * cutoff * dt)), dt / (dt + .02));
    let dx = (x - this.x) * (1 - alpha), dy = (y - this.y) * (1 - alpha);
    const deviation = Math.hypot(dx, dy), limit = 2 * amount;
    // A spatial bound preserves small letters, reversals and intentional corners.
    if (deviation > limit) { dx *= limit / deviation; dy *= limit / deviation; }
    this.x = x - dx; this.y = y - dy;
    return { ...raw, x: this.x / scale, y: this.y / scale };
  }
}
