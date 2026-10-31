import type { StrokePoint } from './drawingTypes.ts';

const SNAP_INCREMENT = Math.PI / 4;
const SNAP_TOLERANCE = 4 * Math.PI / 180;

export interface StraightLineRecognition {
  isLine: boolean;
  points: StrokePoint[];
  length: number;
  maxDeviation: number;
  efficiency: number;
  snappedAngle: number | null;
}

function rejected(points: StrokePoint[], length = 0, maxDeviation = 0, efficiency = 0): StraightLineRecognition {
  return { isLine: false, points, length, maxDeviation, efficiency, snappedAngle: null };
}

/**
 * Recognize deliberate straight ink using endpoint distance, path efficiency, and
 * perpendicular deviation. Optional snapping is limited to 0/45/90-degree increments.
 * `screenScale` converts page-space samples to CSS pixels so the fixed thresholds
 * describe the gesture the user actually drew, independent of page zoom.
 */
export function recognizeStraightLine(points: StrokePoint[], snapToAngles: boolean, screenScale = 1): StraightLineRecognition {
  const scale = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
  const scaled = scale === 1 ? points : points.map(point => ({ ...point, x: point.x * scale, y: point.y * scale }));
  const result = recognizeStraightLineInScreenSpace(scaled, snapToAngles);
  if (scale === 1 || !result.isLine) return result;
  return {
    ...result,
    points: result.points.map(point => ({ ...point, x: point.x / scale, y: point.y / scale })),
  };
}

function recognizeStraightLineInScreenSpace(points: StrokePoint[], snapToAngles: boolean): StraightLineRecognition {
  if (points.length < 4) return rejected(points);

  const start = points[0];
  const end = points[points.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 56) return rejected(points, length);

  let pathLength = 0;
  let squaredDeviationTotal = 0;
  let maxDeviation = 0;
  let previousProgress = 0;
  let backwardsDistance = 0;

  for (let index = 1; index < points.length; index += 1) {
    pathLength += Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    );
  }

  for (const point of points) {
    const relativeX = point.x - start.x;
    const relativeY = point.y - start.y;
    const progress = (relativeX * dx + relativeY * dy) / length;
    const deviation = Math.abs(relativeX * dy - relativeY * dx) / length;
    maxDeviation = Math.max(maxDeviation, deviation);
    squaredDeviationTotal += deviation * deviation;
    if (progress < previousProgress) backwardsDistance += previousProgress - progress;
    previousProgress = progress;
  }

  const efficiency = length / Math.max(length, pathLength);
  const rmsDeviation = Math.sqrt(squaredDeviationTotal / points.length);
  const maxAllowedDeviation = Math.min(6, Math.max(2.5, length * 0.025));
  const rmsAllowedDeviation = Math.min(3.5, Math.max(1.5, length * 0.014));
  const duration = end.t - start.t;
  const isLine = duration >= 60
    && duration <= 5_000
    && efficiency >= 0.965
    && maxDeviation <= maxAllowedDeviation
    && rmsDeviation <= rmsAllowedDeviation
    && backwardsDistance <= length * 0.025;

  if (!isLine) return rejected(points, length, maxDeviation, efficiency);

  const rawAngle = Math.atan2(dy, dx);
  const nearestSnapAngle = Math.round(rawAngle / SNAP_INCREMENT) * SNAP_INCREMENT;
  const angleDifference = Math.abs(Math.atan2(
    Math.sin(rawAngle - nearestSnapAngle),
    Math.cos(rawAngle - nearestSnapAngle),
  ));
  const snappedAngle = snapToAngles && angleDifference <= SNAP_TOLERANCE
    ? nearestSnapAngle
    : null;
  const finalAngle = snappedAngle ?? rawAngle;

  return {
    isLine: true,
    points: [
      { ...start },
      {
        ...end,
        x: start.x + Math.cos(finalAngle) * length,
        y: start.y + Math.sin(finalAngle) * length,
      },
    ],
    length,
    maxDeviation,
    efficiency,
    snappedAngle,
  };
}
