import type { StrokePoint } from './drawingTypes.ts';

/** Maps PointerEvent pressure without inventing pressure for devices that do not report it. */
export function mapPointerPressure(pointerType: string, pressure: number, enabled: boolean): number {
  if (!enabled || pointerType === 'mouse' || !Number.isFinite(pressure) || pressure <= 0) return 0.5;
  return Math.max(0.01, Math.min(1, pressure));
}

/** Fidelity mode: accepted physical samples are authoritative. Maximum XY
 * displacement is zero at every sample rate and stabilization setting. Keep the
 * interface/settings compatible; a cosmetic follower must not rewrite ink. */
export class InkInputFilter {
  reset(): void {}

  push(raw: StrokePoint, _stabilization: number): StrokePoint { return { ...raw }; }
}
