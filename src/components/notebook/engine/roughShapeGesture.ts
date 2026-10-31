import type { StrokePoint } from './drawingTypes.ts';

export type RecognizedRoughShapeType = 'ellipse' | 'rectangle';

export interface RoughShapeRecognition {
  isShape: boolean;
  shapeType: RecognizedRoughShapeType | null;
  x: number;
  y: number;
  width: number;
  height: number;
  snapped: boolean;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

const MIN_POINT_COUNT = 16;
const MIN_SPAN = 44;
const MIN_LONG_SPAN = 56;
const MIN_DURATION_MS = 140;
const MAX_DURATION_MS = 4_000;
const MAX_SNAP_ASPECT_RATIO = 1.18;

function rejected(): RoughShapeRecognition {
  return { isShape: false, shapeType: null, x: 0, y: 0, width: 0, height: 0, snapped: false };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Infinity;
}

function getBounds(points: StrokePoint[]): Bounds {
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function getPathLength(points: StrokePoint[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

function getAngularTraversal(points: StrokePoint[], centerX: number, centerY: number): {
  netAngle: number;
  directionalConsistency: number;
} {
  let previousAngle = Math.atan2(points[0].y - centerY, points[0].x - centerX);
  let netAngle = 0;
  let absoluteAngle = 0;
  for (const point of points.slice(1)) {
    const angle = Math.atan2(point.y - centerY, point.x - centerX);
    const delta = Math.atan2(Math.sin(angle - previousAngle), Math.cos(angle - previousAngle));
    netAngle += delta;
    absoluteAngle += Math.abs(delta);
    previousAngle = angle;
  }
  return {
    netAngle,
    directionalConsistency: Math.abs(netAngle) / Math.max(absoluteAngle, Number.EPSILON),
  };
}

function ellipseScore(points: StrokePoint[], bounds: Bounds, pathLength: number): number | null {
  const radiusX = bounds.width / 2;
  const radiusY = bounds.height / 2;
  const centerX = bounds.minX + radiusX;
  const centerY = bounds.minY + radiusY;
  const errors = points.map(point => Math.abs(Math.hypot(
    (point.x - centerX) / radiusX,
    (point.y - centerY) / radiusY,
  ) - 1));
  const rmsError = Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length);
  const p90Error = percentile(errors, 0.9);
  const maxError = Math.max(...errors);
  const perimeter = Math.PI * (
    3 * (radiusX + radiusY) - Math.sqrt((3 * radiusX + radiusY) * (radiusX + 3 * radiusY))
  );
  const pathRatio = pathLength / perimeter;

  if (rmsError > 0.135 || p90Error > 0.2 || maxError > 0.38 || pathRatio < 0.78 || pathRatio > 1.28) {
    return null;
  }
  return rmsError / 0.135 + p90Error / 0.2;
}

function rectangleScore(points: StrokePoint[], bounds: Bounds, pathLength: number): number | null {
  const minimumSpan = Math.min(bounds.width, bounds.height);
  const edgeErrors = points.map(point => Math.min(
    Math.abs(point.x - bounds.minX),
    Math.abs(point.x - bounds.maxX),
    Math.abs(point.y - bounds.minY),
    Math.abs(point.y - bounds.maxY),
  ) / minimumSpan);
  const rmsError = Math.sqrt(edgeErrors.reduce((sum, error) => sum + error * error, 0) / edgeErrors.length);
  const p90Error = percentile(edgeErrors, 0.9);
  const maxError = Math.max(...edgeErrors);
  const pathRatio = pathLength / (2 * (bounds.width + bounds.height));
  const cornerTolerance = minimumSpan * 0.17;
  const corners = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ];
  const visitsEveryCorner = corners.every(([cornerX, cornerY]) => points.some(point => (
    Math.hypot(point.x - cornerX, point.y - cornerY) <= cornerTolerance
  )));

  if (!visitsEveryCorner || rmsError > 0.055 || p90Error > 0.1 || maxError > 0.17 || pathRatio < 0.78 || pathRatio > 1.28) {
    return null;
  }
  return rmsError / 0.055 + p90Error / 0.1;
}

function geometryFor(bounds: Bounds, snapEqualSides: boolean): Pick<RoughShapeRecognition, 'x' | 'y' | 'width' | 'height' | 'snapped'> {
  const aspectRatio = Math.max(bounds.width, bounds.height) / Math.min(bounds.width, bounds.height);
  if (!snapEqualSides || aspectRatio > MAX_SNAP_ASPECT_RATIO) {
    return { x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height, snapped: false };
  }

  const size = (bounds.width + bounds.height) / 2;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return {
    x: centerX - size / 2,
    y: centerY - size / 2,
    width: size,
    height: size,
    snapped: true,
  };
}

/**
 * Recognize only large, deliberate, single-turn closed loops. Ellipses must stay close
 * to an ellipse fitted to their bounds; rectangles must track all four edges and visit
 * all four corners. This intentionally leaves small, open, self-crossing, and irregular
 * handwriting strokes untouched. `screenScale` converts page-space samples to CSS
 * pixels so span thresholds stay zoom-invariant; returned geometry is page-space.
 */
export function recognizeRoughShape(points: StrokePoint[], snapEqualSides: boolean, screenScale = 1): RoughShapeRecognition {
  const scale = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
  const scaled = scale === 1 ? points : points.map(point => ({ ...point, x: point.x * scale, y: point.y * scale }));
  const result = recognizeRoughShapeInScreenSpace(scaled, snapEqualSides);
  if (scale === 1 || !result.isShape) return result;
  return { ...result, x: result.x / scale, y: result.y / scale, width: result.width / scale, height: result.height / scale };
}

function recognizeRoughShapeInScreenSpace(points: StrokePoint[], snapEqualSides: boolean): RoughShapeRecognition {
  if (points.length < MIN_POINT_COUNT || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return rejected();
  }

  const bounds = getBounds(points);
  const minimumSpan = Math.min(bounds.width, bounds.height);
  const maximumSpan = Math.max(bounds.width, bounds.height);
  if (minimumSpan < MIN_SPAN || maximumSpan < MIN_LONG_SPAN) return rejected();

  const first = points[0];
  const last = points[points.length - 1];
  const duration = last.t - first.t;
  const closureDistance = Math.hypot(last.x - first.x, last.y - first.y);
  if (
    duration < MIN_DURATION_MS
    || duration > MAX_DURATION_MS
    || closureDistance > Math.max(8, minimumSpan * 0.12)
  ) {
    return rejected();
  }

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const traversal = getAngularTraversal(points, centerX, centerY);
  const turns = Math.abs(traversal.netAngle) / (Math.PI * 2);
  if (turns < 0.84 || turns > 1.16 || traversal.directionalConsistency < 0.82) return rejected();

  const pathLength = getPathLength(points);
  const ellipse = ellipseScore(points, bounds, pathLength);
  const rectangle = rectangleScore(points, bounds, pathLength);
  if (ellipse === null && rectangle === null) return rejected();

  const shapeType: RecognizedRoughShapeType = rectangle !== null && (ellipse === null || rectangle < ellipse)
    ? 'rectangle'
    : 'ellipse';
  return { isShape: true, shapeType, ...geometryFor(bounds, snapEqualSides) };
}
