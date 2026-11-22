import type { StrokePoint } from './drawingTypes.ts';

export type RecognizedRoughShapeType = 'ellipse' | 'rectangle' | 'triangle' | 'diamond' | 'star' | 'pentagon' | 'hexagon';

export interface RoughShapeRecognition {
  isShape: boolean;
  shapeType: RecognizedRoughShapeType | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  snapped: boolean;
  isCircle?: boolean;
}

export interface RoughShapeOptions {
  deliberateHold?: boolean;
}

interface OrientedFrame {
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotationDeg: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  uMid: number;
  vMid: number;
}

interface ShapeFit {
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  snapped: boolean;
  rmsError?: number;
}

const MIN_POINT_COUNT = 8;
const DEFAULT_MIN_SPAN = 28;
const DEFAULT_MIN_LONG_SPAN = 40;
const HOLD_MIN_SPAN = 18;
const HOLD_MIN_LONG_SPAN = 24;
const MIN_DURATION_MS = 140;
const MAX_DURATION_MS = 30_000;
const MAX_SNAP_ASPECT_RATIO = 1.24;
const AXIS_ALIGN_SNAP_RAD = (8 * Math.PI) / 180;

function rejected(): RoughShapeRecognition {
  return { isShape: false, shapeType: null, x: 0, y: 0, width: 0, height: 0, rotation: 0, snapped: false };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)))] ?? Infinity;
}

function foldQuarterTurn(rad: number): number {
  const quarter = Math.PI / 2;
  let a = ((rad % quarter) + quarter) % quarter;
  if (a > Math.PI / 4) a -= quarter;
  if (Math.abs(a) <= AXIS_ALIGN_SNAP_RAD) return 0;
  return a;
}

function trimHoldCluster(points: StrokePoint[], tolerance = 14): StrokePoint[] {
  if (points.length <= MIN_POINT_COUNT) return points;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const approxSpan = Math.max(maxX - minX, maxY - minY);
  const effectiveTolerance = Math.min(tolerance, Math.max(8, approxSpan * 0.16));
  const tail = points[points.length - 1];
  let endIdx = points.length - 1;
  let tailPathLen = 0;
  while (endIdx > MIN_POINT_COUNT - 1 && Math.hypot(points[endIdx - 1].x - tail.x, points[endIdx - 1].y - tail.y) <= effectiveTolerance) {
    tailPathLen += Math.hypot(points[endIdx].x - points[endIdx - 1].x, points[endIdx].y - points[endIdx - 1].y);
    endIdx -= 1;
  }
  const count = points.length - endIdx;
  const tailDisp = Math.hypot(tail.x - points[endIdx].x, tail.y - points[endIdx].y);
  // Only collapse genuine oscillating/dwelling hold tremor clusters; never blunt a clean moving corner.
  if (count < 4 || tailPathLen <= Math.max(8, tailDisp * 1.45)) return points;
  let sumX = 0;
  let sumY = 0;
  for (let i = endIdx; i < points.length; i += 1) {
    sumX += points[i].x;
    sumY += points[i].y;
  }
  return [
    ...points.slice(0, endIdx),
    { ...tail, x: sumX / count, y: sumY / count },
  ];
}

function trimOvershootLoop(points: StrokePoint[]): StrokePoint[] {
  const n = points.length;
  if (n < MIN_POINT_COUNT) return points;
  const directGap = Math.hypot(points[n - 1].x - points[0].x, points[n - 1].y - points[0].y);
  if (directGap <= 2) return points;

  const cumLen = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    cumLen[i] = cumLen[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const totalLen = cumLen[n - 1];
  if (totalLen <= 1e-6) return points;

  let bestGap = directGap;
  let bestI = 0;
  let bestJ = n - 1;
  for (let i = 0; i < n && cumLen[i] <= totalLen * 0.28; i += 1) {
    for (let j = n - 1; j >= i + 6 && cumLen[j] >= totalLen * 0.65; j -= 1) {
      if (cumLen[j] - cumLen[i] < totalLen * 0.55) continue;
      const gap = Math.hypot(points[j].x - points[i].x, points[j].y - points[i].y);
      if (gap < bestGap) {
        bestGap = gap;
        bestI = i;
        bestJ = j;
      }
    }
  }
  if ((bestGap <= directGap * 0.80 || (directGap > 10 && bestGap < directGap - 5)) && (bestI > 0 || bestJ < n - 1)) {
    return points.slice(bestI, bestJ + 1);
  }
  return points;
}

function getPathLength(points: ReadonlyArray<{ x: number; y: number }>): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

function resampleLoop(points: StrokePoint[], sampleCount = 64): Array<{ x: number; y: number }> {
  const n = points.length;
  const cumLen = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    cumLen[i] = cumLen[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const total = cumLen[n - 1];
  if (total <= 1e-6) return points.map(p => ({ x: p.x, y: p.y }));
  const out: Array<{ x: number; y: number }> = [];
  let seg = 1;
  for (let s = 0; s < sampleCount; s += 1) {
    const target = (s / Math.max(1, sampleCount - 1)) * total;
    while (seg < n - 1 && cumLen[seg] < target) seg += 1;
    const prev = cumLen[seg - 1];
    const len = cumLen[seg] - prev;
    const t = len > 1e-9 ? (target - prev) / len : 0;
    const p = points[seg - 1];
    const q = points[seg];
    out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  }
  return out;
}

function getAngularTraversal(points: ReadonlyArray<{ x: number; y: number }>, centerX: number, centerY: number): {
  netAngle: number;
  directionalConsistency: number;
} {
  let previousAngle = Math.atan2(points[0].y - centerY, points[0].x - centerX);
  let netAngle = 0;
  let absoluteAngle = 0;
  for (let i = 1; i < points.length; i += 1) {
    const angle = Math.atan2(points[i].y - centerY, points[i].x - centerX);
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

function buildOrientedFrame(points: ReadonlyArray<{ x: number; y: number }>, angleRad: number, robustQuantile = false): OrientedFrame {
  const ux = angleRad === 0 ? 1 : Math.cos(angleRad);
  const uy = angleRad === 0 ? 0 : Math.sin(angleRad);
  const vx = -uy;
  const vy = ux;
  const us: number[] = [];
  const vs: number[] = [];
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of points) {
    const u = p.x * ux + p.y * uy;
    const v = p.x * vx + p.y * vy;
    us.push(u);
    vs.push(v);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  if (robustQuantile && points.length >= 16) {
    const uLow = percentile(us, 0.04);
    const uHigh = percentile(us, 0.96);
    const vLow = percentile(vs, 0.04);
    const vHigh = percentile(vs, 0.96);
    const uCenter = (uLow + uHigh) * 0.5;
    const vCenter = (vLow + vHigh) * 0.5;
    const uHalf = Math.min((uMax - uMin) * 0.5, ((uHigh - uLow) * 0.5) * 1.03);
    const vHalf = Math.min((vMax - vMin) * 0.5, ((vHigh - vLow) * 0.5) * 1.03);
    if (uHalf > 4 && vHalf > 4) {
      uMin = uCenter - uHalf;
      uMax = uCenter + uHalf;
      vMin = vCenter - vHalf;
      vMax = vCenter + vHalf;
    }
  }
  const uMid = (uMin + uMax) * 0.5;
  const vMid = (vMin + vMax) * 0.5;
  return {
    cx: uMid * ux + vMid * vx,
    cy: uMid * uy + vMid * vy,
    width: uMax - uMin,
    height: vMax - vMin,
    rotationDeg: angleRad === 0 ? 0 : (angleRad * 180) / Math.PI,
    ux,
    uy,
    vx,
    vy,
    uMid,
    vMid,
  };
}

function pcaEllipseAngle(samples: ReadonlyArray<{ x: number; y: number }>): number {
  let mx = 0;
  let my = 0;
  for (const p of samples) {
    mx += p.x;
    my += p.y;
  }
  mx /= samples.length;
  my /= samples.length;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (const p of samples) {
    const dx = p.x - mx;
    const dy = p.y - my;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  if (Math.hypot(cxx - cyy, 2 * cxy) <= 1e-6) return 0;
  return foldQuarterTurn(0.5 * Math.atan2(2 * cxy, cxx - cyy));
}

function convexHull(points: ReadonlyArray<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const sorted = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  if (sorted.length <= 3) return sorted;
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  );
  const lower: Array<{ x: number; y: number }> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function minAreaObbAngle(samples: ReadonlyArray<{ x: number; y: number }>): number {
  const hull = convexHull(samples);
  if (hull.length < 3) return 0;
  const candidateAngles = [0];
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.hypot(dx, dy) > 1e-6) {
      candidateAngles.push(foldQuarterTurn(Math.atan2(dy, dx)));
    }
  }
  let bestAngle = 0;
  let bestArea = Infinity;
  for (const angle of candidateAngles) {
    const frame = buildOrientedFrame(hull, angle);
    const area = frame.width * frame.height;
    // Slight preference for exact axis alignment when areas match within 1.5%.
    const threshold = angle === 0 ? bestArea : bestArea * 0.985;
    if (area < threshold) {
      bestArea = area;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

function polygonArea(points: ReadonlyArray<{ x: number; y: number }>): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) * 0.5;
}

function triangleArea(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5;
}

function pointToSegmentDistance(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function fitTriangle(
  samples: ReadonlyArray<{ x: number; y: number }>,
  pathLength: number,
  snapEqualSides: boolean,
  deliberateHold: boolean,
): ShapeFit | null {
  // Treat the first 63 of 64 resampled loop samples as a closed cyclic sequence.
  const cyclic = samples.length > 8 ? samples.slice(0, samples.length - 1) : [...samples];
  const m = cyclic.length;
  if (m < 18) return null;

  const minGap = Math.max(4, Math.floor(m * 0.11));
  const arcErrors = (i0: number, i1: number, i2: number): number[] => {
    const v0 = cyclic[i0];
    const v1 = cyclic[i1];
    const v2 = cyclic[i2];
    const errs: number[] = [];
    for (let idx = 0; idx < m; idx += 1) {
      const pt = cyclic[idx];
      if (idx >= i0 && idx <= i1) {
        errs.push(pointToSegmentDistance(pt, v0, v1));
      } else if (idx >= i1 && idx <= i2) {
        errs.push(pointToSegmentDistance(pt, v1, v2));
      } else {
        errs.push(pointToSegmentDistance(pt, v2, v0));
      }
    }
    return errs;
  };

  // Coarse search (step=2) for top area-to-error triangle seeds.
  const seeds: Array<{ i: number; j: number; k: number; area: number }> = [];
  for (let i = 0; i < m; i += 2) {
    for (let j = i + minGap; j < m - minGap; j += 2) {
      for (let k = j + minGap; k < m; k += 2) {
        if (m - k + i < minGap) continue;
        const area = triangleArea(cyclic[i], cyclic[j], cyclic[k]);
        if (area <= 1e-3) continue;
        if (seeds.length < 4) {
          seeds.push({ i, j, k, area });
          seeds.sort((a, b) => b.area - a.area);
        } else if (area > seeds[seeds.length - 1].area) {
          seeds[seeds.length - 1] = { i, j, k, area };
          seeds.sort((a, b) => b.area - a.area);
        }
      }
    }
  }
  if (seeds.length === 0) return null;

  let bestIndices: [number, number, number] | null = null;
  let bestSumSq = Infinity;

  for (const seed of seeds) {
    let i = seed.i;
    let j = seed.j;
    let k = seed.k;
    const validTriple = (a: number, b: number, c: number) =>
      a >= 0 && a < b && b < c && c < m && (b - a) >= minGap && (c - b) >= minGap && (m - c + a) >= minGap;
    const costOf = (a: number, b: number, c: number) => {
      const errs = arcErrors(a, b, c);
      let s = 0;
      for (const e of errs) s += e * e;
      return s;
    };
    let curCost = costOf(i, j, k);
    for (let iter = 0; iter < 12; iter += 1) {
      let improved = false;
      for (const step of [-2, -1, 1, 2]) {
        if (validTriple(i + step, j, k)) {
          const c = costOf(i + step, j, k);
          if (c < curCost) { curCost = c; i += step; improved = true; }
        }
        if (validTriple(i, j + step, k)) {
          const c = costOf(i, j + step, k);
          if (c < curCost) { curCost = c; j += step; improved = true; }
        }
        if (validTriple(i, j, k + step)) {
          const c = costOf(i, j, k + step);
          if (c < curCost) { curCost = c; k += step; improved = true; }
        }
      }
      if (!improved) break;
    }
    if (curCost < bestSumSq) {
      bestSumSq = curCost;
      bestIndices = [i, j, k];
    }
  }

  if (!bestIndices) return null;
  const [i0, i1, i2] = bestIndices;
  const v0 = cyclic[i0];
  const v1 = cyclic[i1];
  const v2 = cyclic[i2];

  const s01 = Math.hypot(v1.x - v0.x, v1.y - v0.y);
  const s12 = Math.hypot(v2.x - v1.x, v2.y - v1.y);
  const s20 = Math.hypot(v0.x - v2.x, v0.y - v2.y);
  const minSide = Math.min(s01, s12, s20);
  const maxSide = Math.max(s01, s12, s20);
  if (minSide < (deliberateHold ? 18 : 26) || minSide / Math.max(1e-6, maxSide) < 0.25) {
    return null;
  }

  // Interior angles at all 3 vertices must be genuine triangle corners (18°..132°).
  const angleAt = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => {
    const ux = a.x - b.x, uy = a.y - b.y;
    const vx = c.x - b.x, vy = c.y - b.y;
    const denom = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (denom <= 1e-6) return 0;
    const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denom));
    return (Math.acos(cos) * 180) / Math.PI;
  };
  const ang0 = angleAt(v2, v0, v1);
  const ang1 = angleAt(v0, v1, v2);
  const ang2 = angleAt(v1, v2, v0);
  if (Math.min(ang0, ang1, ang2) < 18 || Math.max(ang0, ang1, ang2) > 132) {
    return null;
  }

  const triArea = triangleArea(v0, v1, v2);
  const loopArea = polygonArea(samples);
  const areaRatio = loopArea / Math.max(1e-6, triArea);
  // Circles/ellipses have areaRatio ~2.42 and rectangles ~1.8-2.0 against any inscribed triangle.
  if (areaRatio < 0.68 || areaRatio > (deliberateHold ? 1.34 : 1.24)) {
    return null;
  }

  const perimeter = s01 + s12 + s20;
  const charScale = perimeter / 3;
  const rawErrs = arcErrors(i0, i1, i2).map(d => d / Math.max(1e-6, charScale));
  const rmsError = Math.sqrt(rawErrs.reduce((sum, e) => sum + e * e, 0) / rawErrs.length);
  const p90Error = percentile(rawErrs, 0.9);
  const maxError = Math.max(...rawErrs);
  const pathRatio = pathLength / Math.max(1e-6, perimeter);

  if (
    rmsError > (deliberateHold ? 0.11 : 0.082)
    || p90Error > (deliberateHold ? 0.18 : 0.14)
    || maxError > (deliberateHold ? 0.36 : 0.25)
    || pathRatio < (deliberateHold ? 0.70 : 0.72)
    || pathRatio > (deliberateHold ? 1.44 : 1.38)
  ) {
    return null;
  }

  // Convert (v0, v1, v2) into ShapeManager's triangle frame (apex at (cx, y), base at y + height, rotated by rotation around (cx, cy)).
  const verts = [v0, v1, v2];
  let bestChoice = {
    cost: Infinity,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    snapped: false,
  };

  for (let aIdx = 0; aIdx < 3; aIdx += 1) {
    const apex = verts[aIdx];
    let b1 = verts[(aIdx + 1) % 3];
    let b2 = verts[(aIdx + 2) % 3];
    // Ensure (b2 - b1) x (apex - b1) < 0 so v = (-uy, ux) points from apex toward base.
    const cross = (b2.x - b1.x) * (apex.y - b1.y) - (b2.y - b1.y) * (apex.x - b1.x);
    if (cross > 0) {
      const tmp = b1;
      b1 = b2;
      b2 = tmp;
    }
    const baseDx = b2.x - b1.x;
    const baseDy = b2.y - b1.y;
    const baseLen = Math.hypot(baseDx, baseDy);
    if (baseLen <= 1e-6) continue;

    let theta = Math.atan2(baseDy, baseDx);
    let snapped = false;
    const snapStep = Math.PI / 4;
    const nearestSnap = Math.round(theta / snapStep) * snapStep;
    const angleDiff = Math.abs(Math.atan2(Math.sin(theta - nearestSnap), Math.cos(theta - nearestSnap)));
    if (angleDiff <= AXIS_ALIGN_SNAP_RAD) {
      theta = nearestSnap;
      snapped = true;
    }

    const ux = Math.abs(Math.cos(theta)) < 1e-12 ? 0 : Math.cos(theta);
    const uy = Math.abs(Math.sin(theta)) < 1e-12 ? 0 : Math.sin(theta);
    const vx = -uy;
    const vy = ux;

    const uA = apex.x * ux + apex.y * uy;
    const vA = apex.x * vx + apex.y * vy;
    const u1 = b1.x * ux + b1.y * uy;
    const v1p = b1.x * vx + b1.y * vy;
    const u2 = b2.x * ux + b2.y * uy;
    const v2p = b2.x * vx + b2.y * vy;

    const uMin = Math.min(uA, u1, u2);
    const uMax = Math.max(uA, u1, u2);
    const vMin = vA;
    const vMax = Math.max(v1p, v2p);
    let width = uMax - uMin;
    let height = vMax - vMin;
    if (width <= 4 || height <= 4) continue;

    // Measure how symmetric apex is over the base midpoint in this frame; reward horizontal bases (upright 0° or apex-down 180°).
    const asymmetry = Math.abs(uA - (u1 + u2) * 0.5) / width;
    const uprightBonus = Math.abs(theta) < 1e-3 ? -0.18 : (Math.abs(Math.sin(theta)) < 1e-3 ? -0.14 : 0);
    const choiceCost = asymmetry + uprightBonus;

    if (choiceCost < bestChoice.cost) {
      const aspectRatio = Math.max(width, height) / Math.max(1e-6, Math.min(width, height));
      if (snapEqualSides && aspectRatio <= 1.18) {
        const size = (width + height) * 0.5;
        width = size;
        height = size;
        snapped = true;
      }
      const uMid = (uMin + uMax) * 0.5;
      const vMid = (vMin + vMax) * 0.5;
      const cx = uMid * ux + vMid * vx;
      const cy = uMid * uy + vMid * vy;
      let rotDeg = (theta * 180) / Math.PI;
      if (Math.abs(rotDeg) < 1e-6) rotDeg = 0;
      bestChoice = {
        cost: choiceCost,
        x: cx - width * 0.5,
        y: cy - height * 0.5,
        width,
        height,
        rotation: rotDeg,
        snapped,
      };
    }
  }

  if (!Number.isFinite(bestChoice.cost)) return null;
  const score = rmsError / 0.08 + p90Error / 0.14 + Math.abs(areaRatio - 1) * 0.6;
  return {
    score,
    x: bestChoice.x,
    y: bestChoice.y,
    width: bestChoice.width,
    height: bestChoice.height,
    rotation: bestChoice.rotation,
    snapped: bestChoice.snapped,
  };
}

function rdpOpen(
  points: ReadonlyArray<{ x: number; y: number }>,
  eps: number,
): Array<{ x: number; y: number }> {
  if (points.length <= 2) return [...points];
  const a = points[0];
  const b = points[points.length - 1];
  let maxDist = -1;
  let split = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = pointToSegmentDistance(points[i], a, b);
    if (d > maxDist) {
      maxDist = d;
      split = i;
    }
  }
  if (maxDist <= eps) return [a, b];
  const left = rdpOpen(points.slice(0, split + 1), eps);
  const right = rdpOpen(points.slice(split), eps);
  return [...left.slice(0, -1), ...right];
}

function simplifyClosedPolygonCorners(
  samples: ReadonlyArray<{ x: number; y: number }>,
  epsFrac = 0.055,
): Array<{ x: number; y: number }> {
  const cyclic = samples.length > 8 ? samples.slice(0, samples.length - 1) : [...samples];
  const m = cyclic.length;
  if (m < 6) return [];

  let cx = 0;
  let cy = 0;
  for (const p of cyclic) {
    cx += p.x;
    cy += p.y;
  }
  cx /= m;
  cy /= m;

  let meanR = 0;
  let i0 = 0;
  let maxR = -1;
  for (let i = 0; i < m; i += 1) {
    const r = Math.hypot(cyclic[i].x - cx, cyclic[i].y - cy);
    meanR += r;
    if (r > maxR) {
      maxR = r;
      i0 = i;
    }
  }
  meanR /= m;
  if (meanR <= 1e-6) return [];

  const reordered = [...cyclic.slice(i0), ...cyclic.slice(0, i0)];
  let i1 = 1;
  let maxSpan = -1;
  for (let i = 1; i < m; i += 1) {
    const d = Math.hypot(reordered[i].x - reordered[0].x, reordered[i].y - reordered[0].y);
    if (d > maxSpan) {
      maxSpan = d;
      i1 = i;
    }
  }

  const eps = meanR * epsFrac;
  const arc1 = rdpOpen(reordered.slice(0, i1 + 1), eps);
  const arc2 = rdpOpen([...reordered.slice(i1), reordered[0]], eps);
  let verts = [...arc1.slice(0, -1), ...arc2.slice(0, -1)];

  // Merge micro-edges (keeping the vertex farther from centroid)
  const minEdge = meanR * 0.16;
  let merged = true;
  while (merged && verts.length > 3) {
    merged = false;
    for (let i = 0; i < verts.length; i += 1) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      if (Math.hypot(b.x - a.x, b.y - a.y) < minEdge) {
        const ra = Math.hypot(a.x - cx, a.y - cy);
        const rb = Math.hypot(b.x - cx, b.y - cy);
        verts.splice(ra >= rb ? (i + 1) % verts.length : i, 1);
        merged = true;
        break;
      }
    }
  }

  // Prune shallow collinear vertices (exterior turning angle < 24 degrees)
  while (verts.length > 3) {
    let minTurn = Infinity;
    let dropIdx = -1;
    for (let i = 0; i < verts.length; i += 1) {
      const prev = verts[(i - 1 + verts.length) % verts.length];
      const curr = verts[i];
      const next = verts[(i + 1) % verts.length];
      const ax = prev.x - curr.x;
      const ay = prev.y - curr.y;
      const bx = next.x - curr.x;
      const by = next.y - curr.y;
      const denom = Math.hypot(ax, ay) * Math.hypot(bx, by);
      if (denom <= 1e-9) {
        dropIdx = i;
        minTurn = 0;
        break;
      }
      const interior = (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / denom))) * 180) / Math.PI;
      const turn = 180 - interior;
      if (turn < minTurn) {
        minTurn = turn;
        dropIdx = i;
      }
    }
    if (dropIdx >= 0 && minTurn < 24) {
      verts.splice(dropIdx, 1);
    } else {
      break;
    }
  }

  return verts;
}

function fitDiamond(
  samples: ReadonlyArray<{ x: number; y: number }>,
  aabbFrame: OrientedFrame,
  pathLength: number,
  snapEqualSides: boolean,
  deliberateHold: boolean,
): ShapeFit | null {
  if (aabbFrame.width <= 8 || aabbFrame.height <= 8) return null;
  const halfW = aabbFrame.width * 0.5;
  const halfH = aabbFrame.height * 0.5;
  const loopArea = polygonArea(samples);
  const rectangularity = loopArea / Math.max(1e-6, aabbFrame.width * aabbFrame.height);
  if (rectangularity < 0.38 || rectangularity > 0.68) return null;

  const normPts = samples.map(p => ({
    un: (p.x - aabbFrame.cx) / halfW,
    vn: (p.y - aabbFrame.cy) / halfH,
  }));
  const cardinalVertices: Array<[number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const cornerDists = cardinalVertices.map(([vx, vy]) => (
    Math.min(...normPts.map(p => Math.hypot(p.un - vx, p.vn - vy)))
  ));
  const maxCornerDist = Math.max(...cornerDists);
  const meanCornerDist = cornerDists.reduce((s, d) => s + d, 0) / 4;
  if (maxCornerDist > (deliberateHold ? 0.27 : 0.23) || meanCornerDist > (deliberateHold ? 0.19 : 0.15)) {
    return null;
  }

  const edges: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
    [{ x: 0, y: -1 }, { x: 1, y: 0 }],
    [{ x: 1, y: 0 }, { x: 0, y: 1 }],
    [{ x: 0, y: 1 }, { x: -1, y: 0 }],
    [{ x: -1, y: 0 }, { x: 0, y: -1 }],
  ];
  const edgeErrors = normPts.map(({ un, vn }) => (
    Math.min(...edges.map(([a, b]) => pointToSegmentDistance({ x: un, y: vn }, a, b)))
  ));
  const rmsError = Math.sqrt(edgeErrors.reduce((s, e) => s + e * e, 0) / edgeErrors.length);
  const p90Error = percentile(edgeErrors, 0.9);
  const maxError = Math.max(...edgeErrors);
  const expectedPerimeter = 2 * Math.hypot(aabbFrame.width, aabbFrame.height);
  const pathRatio = pathLength / Math.max(1e-6, expectedPerimeter);

  if (
    rmsError > (deliberateHold ? 0.115 : 0.085)
    || p90Error > (deliberateHold ? 0.19 : 0.15)
    || maxError > (deliberateHold ? 0.36 : 0.28)
    || pathRatio < (deliberateHold ? 0.70 : 0.72)
    || pathRatio > (deliberateHold ? 1.44 : 1.38)
  ) {
    return null;
  }

  const geom = geometryFor(aabbFrame, 'diamond', snapEqualSides);
  return {
    score: rmsError / 0.085 + p90Error / 0.15,
    rmsError,
    x: geom.x,
    y: geom.y,
    width: geom.width,
    height: geom.height,
    rotation: 0,
    snapped: geom.snapped,
  };
}

function fitStar(
  samples: ReadonlyArray<{ x: number; y: number }>,
  pathLength: number,
  snapEqualSides: boolean,
  deliberateHold: boolean,
): ShapeFit | null {
  const hull = convexHull(samples);
  if (hull.length < 5) return null;
  const loopArea = polygonArea(samples);
  const hullArea = polygonArea(hull);
  const convexity = loopArea / Math.max(1e-6, hullArea);
  if (convexity < 0.32 || convexity > 0.72) return null;

  let cx = 0;
  let cy = 0;
  for (const p of samples) {
    cx += p.x;
    cy += p.y;
  }
  cx /= samples.length;
  cy /= samples.length;

  const radii = samples.map(p => Math.hypot(p.x - cx, p.y - cy));
  const baseR = percentile(radii, 0.94);
  if (baseR <= 8) return null;

  const buildStarVerts = (rOuter: number, innerRatio: number, startAngle: number) => (
    Array.from({ length: 10 }, (_, k) => {
      const a = startAngle + (k * Math.PI) / 5;
      const r = k % 2 === 0 ? rOuter : rOuter * innerRatio;
      return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
    })
  );

  const sectorAngleSpan = (2 * Math.PI) / 5;
  let bestPhi = 0;
  let bestInnerRatio = 0.40;
  let bestR = baseR;
  let bestSumSq = Infinity;

  for (let step = -18; step < 18; step += 1) {
    const phi = (step / 36) * sectorAngleSpan;
    const startAngle = -Math.PI / 2 + phi;
    for (const innerRatio of [0.35, 0.40, 0.45]) {
      for (const rScale of [0.96, 1.0, 1.04]) {
        const rOuter = baseR * rScale;
        const verts = buildStarVerts(rOuter, innerRatio, startAngle);
        let sumSq = 0;
        for (const pt of samples) {
          let minD = Infinity;
          for (let e = 0; e < 10; e += 1) {
            const d = pointToSegmentDistance(pt, verts[e], verts[(e + 1) % 10]);
            if (d < minD) minD = d;
          }
          sumSq += minD * minD;
        }
        if (sumSq < bestSumSq) {
          bestSumSq = sumSq;
          bestPhi = phi;
          bestInnerRatio = innerRatio;
          bestR = rOuter;
        }
      }
    }
  }

  const snappedPhi = Math.abs(bestPhi) <= AXIS_ALIGN_SNAP_RAD ? 0 : bestPhi;
  const startAngle = -Math.PI / 2 + snappedPhi;
  const verts = buildStarVerts(bestR, bestInnerRatio, startAngle);

  const rawErrs = samples.map(pt => {
    let minD = Infinity;
    for (let e = 0; e < 10; e += 1) {
      const d = pointToSegmentDistance(pt, verts[e], verts[(e + 1) % 10]);
      if (d < minD) minD = d;
    }
    return minD / bestR;
  });
  const rmsError = Math.sqrt(rawErrs.reduce((s, e) => s + e * e, 0) / rawErrs.length);
  const p90Error = percentile(rawErrs, 0.9);
  const maxError = Math.max(...rawErrs);

  const sectorMax = new Float64Array(5).fill(0);
  const sectorMin = new Float64Array(5).fill(Infinity);
  const sampleAngles = samples.map(p => Math.atan2(p.y - cy, p.x - cx));
  for (let s = 0; s < 5; s += 1) {
    const outerAng = startAngle + s * sectorAngleSpan;
    const innerAng = outerAng + Math.PI / 5;
    for (let i = 0; i < samples.length; i += 1) {
      const dOuter = Math.abs(Math.atan2(Math.sin(sampleAngles[i] - outerAng), Math.cos(sampleAngles[i] - outerAng)));
      if (dOuter <= (22 * Math.PI) / 180 && radii[i] > sectorMax[s]) sectorMax[s] = radii[i];
      const dInner = Math.abs(Math.atan2(Math.sin(sampleAngles[i] - innerAng), Math.cos(sampleAngles[i] - innerAng)));
      if (dInner <= (22 * Math.PI) / 180 && radii[i] < sectorMin[s]) sectorMin[s] = radii[i];
    }
    if (sectorMax[s] < bestR * 0.74 || sectorMin[s] > bestR * (bestInnerRatio + 0.18)) {
      return null;
    }
  }
  for (let s = 0; s < 5; s += 1) {
    const prevInner = sectorMin[(s + 4) % 5];
    const nextInner = sectorMin[s];
    if (sectorMax[s] - prevInner < bestR * 0.25 || sectorMax[s] - nextInner < bestR * 0.25) {
      return null;
    }
  }

  for (let k = 0; k < 10; k += 1) {
    const v = verts[k];
    const vDist = Math.min(...samples.map(p => Math.hypot(p.x - v.x, p.y - v.y))) / bestR;
    const limit = k % 2 === 0 ? (deliberateHold ? 0.30 : 0.24) : (deliberateHold ? 0.28 : 0.22);
    if (vDist > limit) return null;
  }

  const innerR = bestR * bestInnerRatio;
  const edgeLen = Math.hypot(bestR - innerR * Math.cos(Math.PI / 5), innerR * Math.sin(Math.PI / 5));
  const modelPerim = 10 * edgeLen;
  const pathRatio = pathLength / Math.max(1e-6, modelPerim);

  if (
    rmsError > (deliberateHold ? 0.14 : 0.11)
    || p90Error > (deliberateHold ? 0.23 : 0.18)
    || maxError > (deliberateHold ? 0.42 : 0.34)
    || pathRatio < 0.72
    || pathRatio > 1.38
  ) {
    return null;
  }

  const rotDeg = snappedPhi === 0 ? 0 : (snappedPhi * 180) / Math.PI;
  if (rotDeg === 0) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of samples) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const rx = (maxX - minX) / (2 * Math.sin((2 * Math.PI) / 5));
    const ry = (maxY - minY) / (1 + Math.cos(Math.PI / 5));
    const cxBox = (minX + maxX) * 0.5;
    const cyBox = minY + ry;
    const aspectRatio = Math.max(rx, ry) / Math.max(1e-6, Math.min(rx, ry));
    if (snapEqualSides && aspectRatio <= 1.18) {
      const rSnap = (rx + ry) * 0.5;
      return {
        score: rmsError / 0.11 + p90Error / 0.18,
        rmsError,
        x: cxBox - rSnap,
        y: cyBox - rSnap,
        width: rSnap * 2,
        height: rSnap * 2,
        rotation: 0,
        snapped: true,
      };
    }
    return {
      score: rmsError / 0.11 + p90Error / 0.18,
      rmsError,
      x: cxBox - rx,
      y: cyBox - ry,
      width: rx * 2,
      height: ry * 2,
      rotation: 0,
      snapped: false,
    };
  }

  return {
    score: rmsError / 0.11 + p90Error / 0.18,
    rmsError,
    x: cx - bestR,
    y: cy - bestR,
    width: bestR * 2,
    height: bestR * 2,
    rotation: rotDeg,
    snapped: snapEqualSides,
  };
}

function fitRegularPolygon(
  samples: ReadonlyArray<{ x: number; y: number }>,
  sides: 5 | 6,
  pathLength: number,
  snapEqualSides: boolean,
  deliberateHold: boolean,
): ShapeFit | null {
  const hull = convexHull(samples);
  if (hull.length < sides) return null;
  const loopArea = polygonArea(samples);
  const hullArea = polygonArea(hull);
  if (loopArea / Math.max(1e-6, hullArea) < 0.74) return null;

  let corners = simplifyClosedPolygonCorners(samples, deliberateHold ? 0.062 : 0.055);
  if (corners.length !== sides && deliberateHold) {
    corners = simplifyClosedPolygonCorners(samples, 0.068);
  }
  if (corners.length !== sides) return null;

  const sideLens = corners.map((c, i) => {
    const next = corners[(i + 1) % sides];
    return Math.hypot(next.x - c.x, next.y - c.y);
  });
  const minCornerSide = Math.min(...sideLens);
  const maxCornerSide = Math.max(...sideLens);
  if (minCornerSide / Math.max(1e-6, maxCornerSide) < 0.55) return null;

  let cx = 0;
  let cy = 0;
  for (const c of corners) {
    cx += c.x;
    cy += c.y;
  }
  cx /= sides;
  cy /= sides;
  const baseR = corners.reduce((s, c) => s + Math.hypot(c.x - cx, c.y - cy), 0) / sides;
  if (baseR <= 8) return null;

  const sectorAngle = (2 * Math.PI) / sides;
  const buildVerts = (centerX: number, centerY: number, rx: number, ry: number, startAngle: number) => (
    Array.from({ length: sides }, (_, k) => {
      const a = startAngle + k * sectorAngle;
      return { x: centerX + Math.cos(a) * rx, y: centerY + Math.sin(a) * ry };
    })
  );

  let bestPhi = 0;
  let bestSumSq = Infinity;
  for (let step = -18; step < 18; step += 1) {
    const phi = (step / 36) * sectorAngle;
    const verts = buildVerts(cx, cy, baseR, baseR, -Math.PI / 2 + phi);
    let sumSq = 0;
    for (const pt of samples) {
      let minD = Infinity;
      for (let e = 0; e < sides; e += 1) {
        const d = pointToSegmentDistance(pt, verts[e], verts[(e + 1) % sides]);
        if (d < minD) minD = d;
      }
      sumSq += minD * minD;
    }
    if (sumSq < bestSumSq) {
      bestSumSq = sumSq;
      bestPhi = phi;
    }
  }

  let snappedPhi = Math.abs(bestPhi) <= AXIS_ALIGN_SNAP_RAD ? 0 : bestPhi;
  if (sides === 6 && snappedPhi !== 0 && Math.abs(Math.abs(snappedPhi) - Math.PI / 6) <= AXIS_ALIGN_SNAP_RAD) {
    snappedPhi = Math.sign(snappedPhi) * (Math.PI / 6);
  }

  let finalCx = cx;
  let finalCy = cy;
  let finalRx = baseR;
  let finalRy = baseR;
  let rotDeg = snappedPhi === 0 ? 0 : (snappedPhi * 180) / Math.PI;
  let modelVerts = buildVerts(finalCx, finalCy, finalRx, finalRy, -Math.PI / 2 + snappedPhi);

  if (rotDeg === 0) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of samples) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const rxBox = sides === 6 ? (maxX - minX) / Math.sqrt(3) : (maxX - minX) / (2 * Math.sin((2 * Math.PI) / 5));
    const ryBox = sides === 6 ? (maxY - minY) * 0.5 : (maxY - minY) / (1 + Math.cos(Math.PI / 5));
    const cxBox = (minX + maxX) * 0.5;
    const cyBox = sides === 6 ? (minY + maxY) * 0.5 : minY + ryBox;
    const boxAspect = Math.max(rxBox, ryBox) / Math.max(1e-6, Math.min(rxBox, ryBox));
    if (boxAspect <= 1.24) {
      const boxVerts = buildVerts(cxBox, cyBox, rxBox, ryBox, -Math.PI / 2);
      let boxSumSq = 0;
      for (const pt of samples) {
        let minD = Infinity;
        for (let e = 0; e < sides; e += 1) {
          const d = pointToSegmentDistance(pt, boxVerts[e], boxVerts[(e + 1) % sides]);
          if (d < minD) minD = d;
        }
        boxSumSq += minD * minD;
      }
      if (boxSumSq <= bestSumSq * 1.05) {
        finalCx = cxBox;
        finalCy = cyBox;
        finalRx = rxBox;
        finalRy = ryBox;
        modelVerts = boxVerts;
      }
    }
  }

  const charR = (finalRx + finalRy) * 0.5;
  const edgeErrs = samples.map(pt => {
    let minD = Infinity;
    for (let e = 0; e < sides; e += 1) {
      const d = pointToSegmentDistance(pt, modelVerts[e], modelVerts[(e + 1) % sides]);
      if (d < minD) minD = d;
    }
    return minD / charR;
  });
  const rmsError = Math.sqrt(edgeErrs.reduce((s, e) => s + e * e, 0) / edgeErrs.length);
  const p90Error = percentile(edgeErrs, 0.9);
  const maxError = Math.max(...edgeErrs);
  const maxVertexDist = Math.max(...modelVerts.map(v => (
    Math.min(...samples.map(p => Math.hypot(p.x - v.x, p.y - v.y))) / charR
  )));

  // Reject rounded circular arcs: samples in the middle 50% of an inscribed N-gon chord
  // bulge outward by 0.134*R (hexagon) to 0.191*R (pentagon), whereas polygon edges stay flat.
  let bulgeSum = 0;
  let bulgeCount = 0;
  for (let e = 0; e < sides; e += 1) {
    const a = modelVerts[e];
    const b = modelVerts[(e + 1) % sides];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len <= 1e-6) continue;
    const ux = ex / len;
    const uy = ey / len;
    // Outward normal relative to (finalCx, finalCy)
    let nx = uy;
    let ny = -ux;
    const midX = (a.x + b.x) * 0.5 - finalCx;
    const midY = (a.y + b.y) * 0.5 - finalCy;
    if (midX * nx + midY * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    for (const pt of samples) {
      const t = ((pt.x - a.x) * ux + (pt.y - a.y) * uy) / len;
      if (t >= 0.25 && t <= 0.75) {
        const signedOut = (pt.x - a.x) * nx + (pt.y - a.y) * ny;
        if (Math.abs(signedOut) <= charR * 0.25) {
          bulgeSum += signedOut / charR;
          bulgeCount += 1;
        }
      }
    }
  }
  const meanOutBulge = bulgeCount > 0 ? bulgeSum / bulgeCount : 0;

  let modelPerim = 0;
  for (let e = 0; e < sides; e += 1) {
    const a = modelVerts[e];
    const b = modelVerts[(e + 1) % sides];
    modelPerim += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const areaRatio = loopArea / Math.max(1e-6, polygonArea(modelVerts));
  const pathRatio = pathLength / Math.max(1e-6, modelPerim);

  if (
    rmsError > (deliberateHold ? 0.088 : 0.075)
    || p90Error > (deliberateHold ? 0.145 : 0.125)
    || maxError > (deliberateHold ? 0.24 : 0.20)
    || maxVertexDist > (deliberateHold ? 0.22 : 0.18)
    || meanOutBulge > 0.060
    || areaRatio < 0.78
    || areaRatio > 1.24
    || pathRatio < 0.74
    || pathRatio > 1.34
  ) {
    return null;
  }

  const aspectRatio = Math.max(finalRx, finalRy) / Math.max(1e-6, Math.min(finalRx, finalRy));
  if (snapEqualSides && aspectRatio <= 1.18) {
    return {
      score: rmsError / 0.075 + p90Error / 0.125,
      rmsError,
      x: finalCx - charR,
      y: finalCy - charR,
      width: charR * 2,
      height: charR * 2,
      rotation: rotDeg,
      snapped: true,
    };
  }

  return {
    score: rmsError / 0.075 + p90Error / 0.125,
    rmsError,
    x: finalCx - finalRx,
    y: finalCy - finalRy,
    width: finalRx * 2,
    height: finalRy * 2,
    rotation: rotDeg,
    snapped: false,
  };
}

function evaluateEllipse(
  samples: ReadonlyArray<{ x: number; y: number }>,
  frame: OrientedFrame,
  pathLength: number,
  deliberateHold = false,
): { score: number; rmsError: number } | null {
  if (frame.width <= 1e-6 || frame.height <= 1e-6) return null;
  const halfW = frame.width * 0.5;
  const halfH = frame.height * 0.5;
  const errors = samples.map(point => {
    const u = point.x * frame.ux + point.y * frame.uy;
    const v = point.x * frame.vx + point.y * frame.vy;
    const un = (u - frame.uMid) / halfW;
    const vn = (v - frame.vMid) / halfH;
    return Math.abs(Math.hypot(un, vn) - 1);
  });
  const rmsError = Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length);
  const p90Error = percentile(errors, 0.9);
  const maxError = Math.max(...errors);
  const perimeter = Math.PI * (
    3 * (halfW + halfH) - Math.sqrt((3 * halfW + halfH) * (halfW + 3 * halfH))
  );
  const pathRatio = pathLength / perimeter;

  if (
    rmsError > (deliberateHold ? 0.19 : 0.17)
    || p90Error > (deliberateHold ? 0.30 : 0.27)
    || maxError > (deliberateHold ? 0.58 : 0.52)
    || pathRatio < (deliberateHold ? 0.70 : 0.72)
    || pathRatio > (deliberateHold ? 1.44 : 1.38)
  ) {
    return null;
  }
  return { score: rmsError / 0.15 + p90Error / 0.24, rmsError };
}

function rectangleScore(
  samples: ReadonlyArray<{ x: number; y: number }>,
  frame: OrientedFrame,
  pathLength: number,
  deliberateHold: boolean,
): number | null {
  if (frame.width <= 1e-6 || frame.height <= 1e-6) return null;
  const halfW = frame.width * 0.5;
  const halfH = frame.height * 0.5;
  const normPts = samples.map(point => {
    const u = point.x * frame.ux + point.y * frame.uy;
    const v = point.x * frame.vx + point.y * frame.vy;
    return { un: (u - frame.uMid) / halfW, vn: (v - frame.vMid) / halfH };
  });
  const edgeErrors = normPts.map(({ un, vn }) => Math.abs(1 - Math.max(Math.abs(un), Math.abs(vn))));
  const rmsError = Math.sqrt(edgeErrors.reduce((sum, error) => sum + error * error, 0) / edgeErrors.length);
  const p90Error = percentile(edgeErrors, 0.9);
  const maxError = Math.max(...edgeErrors);
  const pathRatio = pathLength / (2 * (frame.width + frame.height));
  const rectangularity = polygonArea(samples) / Math.max(1e-6, frame.width * frame.height);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const cornerDists = corners.map(([sx, sy]) => Math.min(...normPts.map(p => Math.hypot(p.un - sx, p.vn - sy))));
  const maxCornerDist = Math.max(...cornerDists);
  const meanCornerDist = cornerDists.reduce((s, d) => s + d, 0) / 4;
  const allowedCornerDist = deliberateHold ? 0.46 : 0.36;

  if (
    maxCornerDist > allowedCornerDist
    || meanCornerDist > (deliberateHold ? 0.36 : 0.29)
    || rectangularity < (deliberateHold ? 0.66 : 0.78)
    || rmsError > (deliberateHold ? 0.19 : 0.135)
    || p90Error > (deliberateHold ? 0.30 : 0.22)
    || maxError > (deliberateHold ? 0.65 : 0.42)
    || pathRatio < (deliberateHold ? 0.68 : 0.72)
    || pathRatio > (deliberateHold ? 1.48 : 1.38)
  ) {
    return null;
  }
  return rmsError / 0.125 + p90Error / 0.21;
}

function geometryFor(
  frame: OrientedFrame,
  shapeType: 'ellipse' | 'rectangle' | 'diamond' | 'pentagon' | 'hexagon' | 'star',
  snapEqualSides: boolean,
): Pick<RoughShapeRecognition, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'snapped' | 'isCircle'> {
  const aspectRatio = Math.max(frame.width, frame.height) / Math.max(1e-6, Math.min(frame.width, frame.height));
  const maxSnapRatio = shapeType === 'ellipse' || shapeType === 'rectangle' ? MAX_SNAP_ASPECT_RATIO : 1.18;
  const nearEqualCircle = shapeType === 'ellipse' && aspectRatio <= 1.12;
  if ((!snapEqualSides && !nearEqualCircle) || aspectRatio > maxSnapRatio) {
    return {
      x: frame.cx - frame.width * 0.5,
      y: frame.cy - frame.height * 0.5,
      width: frame.width,
      height: frame.height,
      rotation: shapeType === 'diamond' ? 0 : frame.rotationDeg,
      snapped: false,
      isCircle: false,
    };
  }

  const size = (frame.width + frame.height) * 0.5;
  return {
    x: frame.cx - size * 0.5,
    y: frame.cy - size * 0.5,
    width: size,
    height: size,
    rotation: shapeType === 'ellipse' || shapeType === 'diamond' ? 0 : frame.rotationDeg,
    snapped: snapEqualSides,
    isCircle: shapeType === 'ellipse',
  };
}

function fitToRecognition(shapeType: RecognizedRoughShapeType, fit: ShapeFit): RoughShapeRecognition {
  return {
    isShape: true,
    shapeType,
    x: fit.x,
    y: fit.y,
    width: fit.width,
    height: fit.height,
    rotation: fit.rotation,
    snapped: fit.snapped,
    isCircle: false,
  };
}

/**
 * Recognize deliberate, single-turn closed loops into rotated rectangles/squares,
 * rotated ovals/circles, triangles, upright diamonds, 5-point stars, pentagons, or hexagons.
 * Uses oriented PCA/hull frames and normalized residuals so tilted ovals remain ovals,
 * rounded-corner rectangles classify cleanly, and circles do not degenerate into polygons.
 * `screenScale` converts page-space samples to CSS pixels; returned geometry is page-space.
 */
export function recognizeRoughShape(
  points: StrokePoint[],
  snapEqualSides: boolean,
  screenScale = 1,
  options: RoughShapeOptions = {},
): RoughShapeRecognition {
  const scale = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
  const scaled = scale === 1 ? points : points.map(point => ({ ...point, x: point.x * scale, y: point.y * scale }));
  const result = recognizeRoughShapeInScreenSpace(scaled, snapEqualSides, options);
  if (scale === 1 || !result.isShape) return result;
  return { ...result, x: result.x / scale, y: result.y / scale, width: result.width / scale, height: result.height / scale };
}

function recognizeRoughShapeInScreenSpace(
  rawPoints: StrokePoint[],
  snapEqualSides: boolean,
  options: RoughShapeOptions,
): RoughShapeRecognition {
  const deliberateHold = Boolean(options.deliberateHold);
  if (rawPoints.length < MIN_POINT_COUNT || rawPoints.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return rejected();
  }

  const holdTrimmed = deliberateHold ? trimHoldCluster(rawPoints, 14) : rawPoints;
  const points = trimOvershootLoop(holdTrimmed);
  const first = points[0];
  const last = points[points.length - 1];
  const duration = last.t - first.t;
  const minDuration = deliberateHold ? 0 : MIN_DURATION_MS;
  if (!Number.isFinite(duration) || duration < minDuration || (!deliberateHold && duration > MAX_DURATION_MS)) {
    return rejected();
  }

  const openSamples = resampleLoop(points, 64);
  const initialAngle = pcaEllipseAngle(openSamples);
  const initialFrame = buildOrientedFrame(openSamples, initialAngle);
  const minSpan = Math.min(initialFrame.width, initialFrame.height);
  const maxSpan = Math.max(initialFrame.width, initialFrame.height);
  const diag = Math.hypot(initialFrame.width, initialFrame.height);
  const requiredMinSpan = deliberateHold ? HOLD_MIN_SPAN : DEFAULT_MIN_SPAN;
  const requiredLongSpan = deliberateHold ? HOLD_MIN_LONG_SPAN : DEFAULT_MIN_LONG_SPAN;
  if (minSpan < requiredMinSpan || maxSpan < requiredLongSpan) return rejected();

  const closureDistance = Math.hypot(last.x - first.x, last.y - first.y);
  const maxClosure = deliberateHold
    ? Math.max(32, Math.min(180, Math.max(maxSpan * 0.62, diag * 0.44)))
    : Math.max(24, Math.min(120, maxSpan * 0.32));
  if (closureDistance > maxClosure) return rejected();

  // Use the resampled loop centroid rather than the OBB midpoint: for right triangles
  // the OBB midpoint sits directly on (or outside) the hypotenuse, causing netAngle ~ 0.
  let centroidX = 0;
  let centroidY = 0;
  for (const sample of openSamples) {
    centroidX += sample.x;
    centroidY += sample.y;
  }
  centroidX /= openSamples.length;
  centroidY /= openSamples.length;
  const traversal = getAngularTraversal(openSamples, centroidX, centroidY);
  const turns = Math.abs(traversal.netAngle) / (Math.PI * 2);
  const minTurns = deliberateHold ? 0.65 : 0.75;
  const maxTurns = deliberateHold ? 1.38 : 1.25;
  const minConsistency = deliberateHold ? 0.58 : 0.78;
  if (turns < minTurns || turns > maxTurns || traversal.directionalConsistency < minConsistency) return rejected();

  // On deliberate hold with a natural 10-30% closure gap, close the loop smoothly before uniform
  // arc-length resampling so corner pauses and closure gaps never distort PCA/OBB/triangle fitting.
  const closedPoints = deliberateHold && closureDistance > 8 ? [...points, first] : points;
  const samples = deliberateHold && closureDistance > 8 ? resampleLoop(closedPoints, 64) : openSamples;
  const frameSource = deliberateHold ? samples : points;
  const ellipseAngle = pcaEllipseAngle(samples);
  const ellipseFrame = buildOrientedFrame(frameSource, ellipseAngle);
  const aabbFrame = buildOrientedFrame(frameSource, 0, deliberateHold);
  const pathLength = getPathLength(closedPoints);

  const star = fitStar(samples, pathLength, snapEqualSides, deliberateHold);
  const triangle = fitTriangle(samples, pathLength, snapEqualSides, deliberateHold);
  const diamond = fitDiamond(samples, aabbFrame, pathLength, snapEqualSides, deliberateHold);
  const pentagon = fitRegularPolygon(samples, 5, pathLength, snapEqualSides, deliberateHold);
  const hexagon = fitRegularPolygon(samples, 6, pathLength, snapEqualSides, deliberateHold);

  const rectAngle = minAreaObbAngle(samples);
  const rectFrame = buildOrientedFrame(frameSource, rectAngle, deliberateHold);
  const ellipseFit = evaluateEllipse(samples, ellipseFrame, pathLength, deliberateHold);
  const ellipse = ellipseFit ? ellipseFit.score : null;
  const rectangle = rectangleScore(samples, rectFrame, pathLength, deliberateHold);

  if (star !== null && (triangle === null || star.score < triangle.score) && (diamond === null || star.score < diamond.score)) {
    return fitToRecognition('star', star);
  }

  // Upright cardinal diamonds have ~45-degree edges so minAreaObbAngle sees a rotated square.
  // Prefer diamond when all 4 cardinal peaks are tight and OBB would otherwise force a ~45-degree tilt.
  if (
    diamond !== null
    && (triangle === null || diamond.score < triangle.score)
    && (ellipse === null || diamond.score < ellipse)
    && (rectangle === null || Math.abs(rectFrame.rotationDeg) > 25 || diamond.score < rectangle)
  ) {
    return fitToRecognition('diamond', diamond);
  }

  const bestRegularPoly = pentagon !== null && (hexagon === null || pentagon.score <= hexagon.score)
    ? { type: 'pentagon' as const, fit: pentagon }
    : hexagon !== null
      ? { type: 'hexagon' as const, fit: hexagon }
      : null;

  if (
    bestRegularPoly !== null
    && (triangle === null || bestRegularPoly.fit.score < triangle.score)
    && (rectangle === null || bestRegularPoly.fit.score < rectangle)
    && (ellipseFit === null || (bestRegularPoly.fit.rmsError ?? Infinity) < ellipseFit.rmsError * 0.90)
  ) {
    return fitToRecognition(bestRegularPoly.type, bestRegularPoly.fit);
  }

  if (triangle !== null && (ellipse === null || triangle.score < ellipse) && (rectangle === null || triangle.score < rectangle)) {
    return fitToRecognition('triangle', triangle);
  }

  if (ellipse === null && rectangle === null) return rejected();

  const shapeType: 'ellipse' | 'rectangle' = rectangle !== null && (ellipse === null || rectangle < ellipse)
    ? 'rectangle'
    : 'ellipse';
  const winningFrame = shapeType === 'rectangle' ? rectFrame : ellipseFrame;
  return { isShape: true, shapeType, ...geometryFor(winningFrame, shapeType, snapEqualSides) };
}
