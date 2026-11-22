import type { StrokePoint } from '../notebook/engine/drawingTypes.ts';
import { recognizeRoughShape } from '../notebook/engine/roughShapeGesture.ts';
import { recognizeStraightLine } from '../notebook/engine/straightLineGesture.ts';

export type CanvasRecognizedShapeType = 'rectangle' | 'ellipse' | 'diamond' | 'line' | 'arrow';

export interface CanvasGestureRecognition {
  type: CanvasRecognizedShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  points: StrokePoint[];
  snapped: boolean;
}

export interface ExcalidrawShapeStyle {
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
}

export interface CanvasSceneElementIdentity {
  id: string;
  type: string;
  isDeleted?: boolean;
}

export function captureCanvasSceneElementIds(elements: readonly CanvasSceneElementIdentity[]): Set<string> {
  return new Set(elements.filter(element => !element.isDeleted).map(element => element.id));
}

/** A gesture is replaceable only when it created one unambiguous freedraw. */
export function findCurrentGestureFreedrawElement<T extends CanvasSceneElementIdentity>(
  elements: readonly T[],
  preGestureElementIds: ReadonlySet<string>,
): T | null {
  const candidates = elements.filter(element => (
    element.type === 'freedraw' && !element.isDeleted && !preGestureElementIds.has(element.id)
  ));
  return candidates.length === 1 ? candidates[0] : candidates.length > 1 ? candidates[candidates.length - 1] : null;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

const MIN_DIAMOND_POINTS = 16;
const MIN_DIAMOND_SPAN = 44;
const DIAMOND_CORNER_TOLERANCE = 0.2;
const MIN_ARROW_POINTS = 10;
const MIN_ARROW_SPAN = 56;
const MIN_ARROW_HEAD_ANGLE = 18 * Math.PI / 180;
const MAX_ARROW_HEAD_ANGLE = 72 * Math.PI / 180;

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

function pathLength(points: StrokePoint[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

function distanceToSegment(point: StrokePoint, start: [number, number], end: [number, number]): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - start[0]) * dx + (point.y - start[1]) * dy) / lengthSquared));
  return Math.hypot(point.x - (start[0] + projection * dx), point.y - (start[1] + projection * dy));
}

function segmentQuality(points: StrokePoint[]): { length: number; efficiency: number } | null {
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length < 8) return null;

  let path = 0;
  let maxDeviation = 0;
  for (let index = 1; index < points.length; index += 1) {
    path += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
    maxDeviation = Math.max(maxDeviation, distanceToSegment(points[index], [start.x, start.y], [end.x, end.y]));
  }
  const efficiency = length / Math.max(length, path);
  if (efficiency < 0.84 || maxDeviation > Math.max(5, length * 0.16)) return null;
  return { length, efficiency };
}

function angleBetween(first: [number, number], second: [number, number]): number {
  const firstLength = Math.hypot(first[0], first[1]);
  const secondLength = Math.hypot(second[0], second[1]);
  if (firstLength === 0 || secondLength === 0) return Math.PI;
  const cosine = Math.max(-1, Math.min(1, (first[0] * second[0] + first[1] * second[1]) / (firstLength * secondLength)));
  return Math.acos(cosine);
}

/**
 * Recognize the intentionally strict, single-stroke arrow gesture used by
 * draw-to-shape. The stroke must contain a straight shaft followed by two
 * short, opposite-side arrowhead branches that return through the tip.
 */
function recognizeArrow(points: StrokePoint[]): CanvasGestureRecognition | null {
  if (points.length < MIN_ARROW_POINTS || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return null;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const duration = last.t - first.t;
  if (duration < 140 || duration > 4_000) return null;

  let tipIndex = 1;
  let shaftLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    const candidateLength = Math.hypot(points[index].x - first.x, points[index].y - first.y);
    if (candidateLength > shaftLength) {
      shaftLength = candidateLength;
      tipIndex = index;
    }
  }
  if (shaftLength < MIN_ARROW_SPAN || tipIndex < 4 || tipIndex > points.length - 5) return null;

  const shaft = points.slice(0, tipIndex + 1);
  const shaftRecognition = recognizeStraightLine(shaft, false);
  if (!shaftRecognition.isLine) return null;

  const tip = points[tipIndex];
  const shaftVector: [number, number] = [tip.x - first.x, tip.y - first.y];
  const shaftUnit: [number, number] = [shaftVector[0] / shaftLength, shaftVector[1] / shaftLength];
  const branchMinimum = Math.max(10, shaftLength * 0.08);
  const returnTolerance = Math.max(8, shaftLength * 0.09);

  let branchOneIndex = tipIndex + 1;
  let branchOneLength = 0;
  for (let index = tipIndex + 1; index < points.length; index += 1) {
    const distance = Math.hypot(points[index].x - tip.x, points[index].y - tip.y);
    if (distance > branchOneLength) {
      branchOneLength = distance;
      branchOneIndex = index;
    }
    if (index > branchOneIndex && branchOneLength >= branchMinimum && distance <= returnTolerance) break;
  }
  if (branchOneLength < branchMinimum || branchOneIndex <= tipIndex + 1) return null;

  // Use the closest point to the tip as the branch return. Choosing the first
  // point inside the tolerance would mistake the final approach for the
  // beginning of the second branch on coarse pointer samples.
  let returnIndex = branchOneIndex + 1;
  let returnDistance = Infinity;
  for (let index = branchOneIndex + 1; index < points.length - 2; index += 1) {
    const distance = Math.hypot(points[index].x - tip.x, points[index].y - tip.y);
    if (distance < returnDistance) {
      returnDistance = distance;
      returnIndex = index;
    }
  }
  if (returnDistance > returnTolerance) return null;

  let branchTwoIndex = returnIndex + 1;
  let branchTwoLength = 0;
  for (let index = returnIndex + 1; index < points.length; index += 1) {
    const distance = Math.hypot(points[index].x - tip.x, points[index].y - tip.y);
    if (distance > branchTwoLength) {
      branchTwoLength = distance;
      branchTwoIndex = index;
    }
  }
  if (branchTwoLength < branchMinimum || branchTwoIndex <= returnIndex) return null;
  if (branchOneLength > shaftLength * 0.5 || branchTwoLength > shaftLength * 0.5) return null;

  const branchOne: [number, number] = [points[branchOneIndex].x - tip.x, points[branchOneIndex].y - tip.y];
  const branchTwo: [number, number] = [points[branchTwoIndex].x - tip.x, points[branchTwoIndex].y - tip.y];
  const oppositeShaft: [number, number] = [-shaftUnit[0], -shaftUnit[1]];
  const branchOneAngle = angleBetween(branchOne, oppositeShaft);
  const branchTwoAngle = angleBetween(branchTwo, oppositeShaft);
  if (
    branchOneAngle < MIN_ARROW_HEAD_ANGLE || branchOneAngle > MAX_ARROW_HEAD_ANGLE
    || branchTwoAngle < MIN_ARROW_HEAD_ANGLE || branchTwoAngle > MAX_ARROW_HEAD_ANGLE
  ) return null;

  const crossOne = shaftVector[0] * branchOne[1] - shaftVector[1] * branchOne[0];
  const crossTwo = shaftVector[0] * branchTwo[1] - shaftVector[1] * branchTwo[0];
  if (Math.abs(crossOne) < Number.EPSILON || Math.abs(crossTwo) < Number.EPSILON || Math.sign(crossOne) === Math.sign(crossTwo)) return null;
  if (Math.max(branchOneLength, branchTwoLength) / Math.max(Math.min(branchOneLength, branchTwoLength), Number.EPSILON) > 2.2) return null;

  if (
    !segmentQuality(points.slice(tipIndex, branchOneIndex + 1))
    || !segmentQuality(points.slice(branchOneIndex, returnIndex + 1))
    || !segmentQuality(points.slice(returnIndex, branchTwoIndex + 1))
  ) return null;

  return {
    type: 'arrow',
    x: first.x,
    y: first.y,
    width: tip.x - first.x,
    height: tip.y - first.y,
    points: shaftRecognition.points,
    snapped: false,
  };
}

/**
 * Diamonds are not part of the notebook rough-shape recognizer's output, so
 * this adapter adds a deliberately strict four-vertex check before falling
 * through to the shared ellipse/rectangle recognizer.
 */
function recognizeDiamond(points: StrokePoint[], snapEqualSides: boolean): CanvasGestureRecognition | null {
  if (points.length < MIN_DIAMOND_POINTS || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return null;
  }

  const bounds = getBounds(points);
  const minimumSpan = Math.min(bounds.width, bounds.height);
  if (minimumSpan < MIN_DIAMOND_SPAN) return null;

  const first = points[0];
  const last = points[points.length - 1];
  if (last.t - first.t < 140 || last.t - first.t > 4_000) return null;
  if (Math.hypot(last.x - first.x, last.y - first.y) > Math.max(8, minimumSpan * 0.14)) return null;

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const corners: Array<[number, number]> = [
    [centerX, bounds.minY],
    [bounds.maxX, centerY],
    [centerX, bounds.maxY],
    [bounds.minX, centerY],
  ];
  const cornerTolerance = minimumSpan * DIAMOND_CORNER_TOLERANCE;
  if (!corners.every(([x, y]) => points.some(point => Math.hypot(point.x - x, point.y - y) <= cornerTolerance))) return null;

  const edges = corners.map((corner, index) => [corner, corners[(index + 1) % corners.length]] as const);
  const deviations = points.map(point => Math.min(...edges.map(([start, end]) => distanceToSegment(point, start, end))) / minimumSpan);
  const rmsDeviation = Math.sqrt(deviations.reduce((sum, value) => sum + value * value, 0) / deviations.length);
  const sortedDeviations = [...deviations].sort((a, b) => a - b);
  const p90Deviation = sortedDeviations[Math.floor(sortedDeviations.length * 0.9)] ?? 1;
  const expectedPerimeter = 2 * Math.hypot(bounds.width, bounds.height);
  const ratio = pathLength(points) / expectedPerimeter;
  if (rmsDeviation > 0.085 || p90Deviation > 0.16 || ratio < 0.76 || ratio > 1.3) return null;

  let x = bounds.minX;
  let y = bounds.minY;
  let width = bounds.width;
  let height = bounds.height;
  let snapped = false;
  if (snapEqualSides) {
    const size = Math.max(width, height);
    x = centerX - size / 2;
    y = centerY - size / 2;
    width = size;
    height = size;
    snapped = true;
  }
  return { type: 'diamond', x, y, width, height, points, snapped };
}

export function recognizeCanvasGesture(
  points: StrokePoint[],
  options: { snapToAngles?: boolean; snapEqualSides?: boolean } = {},
): CanvasGestureRecognition | null {
  const snapToAngles = options.snapToAngles ?? false;
  const snapEqualSides = options.snapEqualSides ?? false;

  const arrow = recognizeArrow(points);
  if (arrow) return arrow;

  const diamond = recognizeDiamond(points, snapEqualSides);
  if (diamond) return diamond;

  const rough = recognizeRoughShape(points, snapEqualSides);
  if (rough.isShape && (rough.shapeType === 'rectangle' || rough.shapeType === 'ellipse')) {
    return {
      type: rough.shapeType,
      x: rough.x,
      y: rough.y,
      width: rough.width,
      height: rough.height,
      rotation: rough.rotation,
      points,
      snapped: rough.snapped,
    };
  }

  const line = recognizeStraightLine(points, snapToAngles);
  if (!line.isLine) return null;
  const start = line.points[0];
  const end = line.points[1];
  return {
    type: 'line',
    x: start.x,
    y: start.y,
    width: end.x - start.x,
    height: end.y - start.y,
    points: line.points,
    snapped: line.snappedAngle !== null,
  };
}

/** Convert a recognized gesture into the public Excalidraw element skeleton format. */
export function createExcalidrawShapeSkeleton(
  recognition: CanvasGestureRecognition,
  style: ExcalidrawShapeStyle = {},
): Record<string, unknown> {
  const common = {
    strokeColor: style.strokeColor ?? '#1e1e1e',
    backgroundColor: style.backgroundColor ?? 'transparent',
    fillStyle: style.fillStyle ?? 'solid',
    strokeWidth: style.strokeWidth ?? 2,
    strokeStyle: style.strokeStyle ?? 'solid',
    roughness: style.roughness ?? 1,
    opacity: style.opacity ?? 100,
  };
  if (recognition.type === 'line' || recognition.type === 'arrow') {
    return {
      type: recognition.type,
      x: recognition.x,
      y: recognition.y,
      points: [[0, 0], [recognition.width, recognition.height]],
      startArrowhead: null,
      endArrowhead: recognition.type === 'arrow' ? 'arrow' : null,
      ...common,
    };
  }
  return {
    type: recognition.type,
    x: recognition.x,
    y: recognition.y,
    width: recognition.width,
    height: recognition.height,
    ...(recognition.rotation ? { angle: (recognition.rotation * Math.PI) / 180 } : {}),
    ...common,
  };
}
