import type { StrokePoint } from './drawingTypes.ts';

const SNAP_INCREMENT = Math.PI / 4;
const SNAP_TOLERANCE = 5.5 * Math.PI / 180;

export interface StraightLineRecognition {
  isLine: boolean;
  points: StrokePoint[];
  length: number;
  maxDeviation: number;
  efficiency: number;
  snappedAngle: number | null;
}

export interface StraightLineOptions {
  deliberateHold?: boolean;
}

function rejected(points: StrokePoint[], length = 0, maxDeviation = 0, efficiency = 0): StraightLineRecognition {
  return { isLine: false, points, length, maxDeviation, efficiency, snappedAngle: null };
}

function decimateLinePoints(points: StrokePoint[], minSpacing = 3): StrokePoint[] {
  if (points.length <= 2) return points;
  const out: StrokePoint[] = [points[0]];
  let lastKept = points[0];
  for (let i = 1; i < points.length - 1; i += 1) {
    if (Math.hypot(points[i].x - lastKept.x, points[i].y - lastKept.y) >= minSpacing) {
      out.push(points[i]);
      lastKept = points[i];
    }
  }
  const end = points[points.length - 1];
  if (out[out.length - 1] !== end) out.push(end);
  return out;
}

function trimHoldTail(points: StrokePoint[], tolerance = 14): StrokePoint[] {
  if (points.length <= 4) return points;
  const tail = points[points.length - 1];
  let endIndex = points.length - 1;
  let tailPathLen = 0;
  while (endIndex > 2 && Math.hypot(points[endIndex - 1].x - tail.x, points[endIndex - 1].y - tail.y) <= tolerance) {
    tailPathLen += Math.hypot(points[endIndex].x - points[endIndex - 1].x, points[endIndex].y - points[endIndex - 1].y);
    endIndex -= 1;
  }
  let trimmed = points;
  const count = points.length - endIndex;
  const tailDisp = Math.hypot(tail.x - points[endIndex].x, tail.y - points[endIndex].y);
  // Only collapse when the tail genuinely oscillated/dwelled in place (path length exceeds net
  // displacement), never when a clean moving straight line simply has dense samples near the end.
  if (count >= 4 && tailPathLen > Math.max(8, tailDisp * 1.45)) {
    // Anchor the tremor center on the final samples so approach points at the outer tolerance edge
    // do not pull the endpoint backward along short lines.
    const coreStart = Math.max(endIndex, points.length - Math.min(count, 16));
    let cx = 0;
    let cy = 0;
    const coreCount = points.length - coreStart;
    for (let i = coreStart; i < points.length; i += 1) {
      cx += points[i].x;
      cy += points[i].y;
    }
    cx /= coreCount;
    cy /= coreCount;
    let coreRadius = 0;
    for (let i = coreStart; i < points.length; i += 1) {
      coreRadius = Math.max(coreRadius, Math.hypot(points[i].x - cx, points[i].y - cy));
    }
    const collapseRadius = Math.min(tolerance, Math.max(3, coreRadius + 1.5));
    let collapseStart = points.length - 1;
    while (collapseStart > 2 && Math.hypot(points[collapseStart - 1].x - cx, points[collapseStart - 1].y - cy) <= collapseRadius) {
      collapseStart -= 1;
    }
    let sumX = 0;
    let sumY = 0;
    const collapsedCount = points.length - collapseStart;
    for (let i = collapseStart; i < points.length; i += 1) {
      sumX += points[i].x;
      sumY += points[i].y;
    }
    trimmed = [
      ...points.slice(0, collapseStart),
      { ...tail, x: sumX / collapsedCount, y: sumY / collapsedCount },
    ];
  }
  // Trim tiny <= 10px pen-down landing hook on long deliberate-hold lines.
  if (trimmed.length >= 8) {
    const start = trimmed[0];
    const end = trimmed[trimmed.length - 1];
    if (Math.hypot(end.x - start.x, end.y - start.y) >= 50) {
      let startIndex = 0;
      while (startIndex < Math.min(6, trimmed.length - 4)
        && Math.hypot(trimmed[startIndex + 1].x - start.x, trimmed[startIndex + 1].y - start.y) <= 10) {
        startIndex += 1;
      }
      if (startIndex > 0) trimmed = trimmed.slice(startIndex);
    }
  }
  return trimmed;
}

function uniformLineSamples(points: StrokePoint[], sampleCount = 40): Array<{ x: number; y: number }> {
  const cumLen = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumLen.push(cumLen[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const total = cumLen[cumLen.length - 1];
  if (total <= 1e-6) return points.map(p => ({ x: p.x, y: p.y }));
  const samples: Array<{ x: number; y: number }> = [];
  let seg = 1;
  for (let s = 0; s < sampleCount; s += 1) {
    const target = (s / Math.max(1, sampleCount - 1)) * total;
    while (seg < cumLen.length - 1 && cumLen[seg] < target) seg += 1;
    const prevLen = cumLen[seg - 1];
    const segLen = cumLen[seg] - prevLen;
    const t = segLen > 1e-9 ? (target - prevLen) / segLen : 0;
    const p = points[seg - 1];
    const q = points[seg];
    samples.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  }
  return samples;
}

/**
 * Recognize deliberate straight ink using endpoint distance, decimated path efficiency,
 * and scale-proportional perpendicular deviation. Optional snapping targets 0/45/90-degree
 * increments. `screenScale` converts page-space samples to CSS pixels so thresholds are
 * zoom-invariant.
 */
export function recognizeStraightLine(
  points: StrokePoint[],
  snapToAngles: boolean,
  screenScale = 1,
  options: StraightLineOptions = {},
): StraightLineRecognition {
  const scale = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
  const scaled = scale === 1 ? points : points.map(point => ({ ...point, x: point.x * scale, y: point.y * scale }));
  const result = recognizeStraightLineInScreenSpace(scaled, snapToAngles, options);
  if (scale === 1 || !result.isLine) return result;
  return {
    ...result,
    points: result.points.map(point => ({ ...point, x: point.x / scale, y: point.y / scale })),
  };
}

function recognizeStraightLineInScreenSpace(
  rawPoints: StrokePoint[],
  snapToAngles: boolean,
  options: StraightLineOptions,
): StraightLineRecognition {
  const deliberateHold = Boolean(options.deliberateHold);
  if (rawPoints.length < 4 || rawPoints.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    return rejected(rawPoints);
  }

  const points = deliberateHold ? trimHoldTail(rawPoints, 14) : rawPoints;
  const start = points[0];
  const end = points[points.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const minLength = deliberateHold ? 24 : 48;
  if (length < minLength) return rejected(rawPoints, length);

  const decimated = decimateLinePoints(points, deliberateHold ? 4 : 3);
  const uniform = uniformLineSamples(decimated, 40);
  const pathSource = deliberateHold ? uniform : decimated;
  let decimatedPathLength = 0;
  let previousProgress = 0;
  let backwardsDistance = 0;
  for (let index = 1; index < pathSource.length; index += 1) {
    decimatedPathLength += Math.hypot(
      pathSource[index].x - pathSource[index - 1].x,
      pathSource[index].y - pathSource[index - 1].y,
    );
  }
  for (const point of pathSource) {
    const progress = ((point.x - start.x) * dx + (point.y - start.y) * dy) / length;
    if (progress < previousProgress) backwardsDistance += previousProgress - progress;
    previousProgress = progress;
  }

  let maxDeviation = 0;
  for (const point of points) {
    const deviation = Math.abs((point.x - start.x) * dy - (point.y - start.y) * dx) / length;
    if (deviation > maxDeviation) maxDeviation = deviation;
  }

  let squaredDeviationTotal = 0;
  for (const point of uniform) {
    const deviation = Math.abs((point.x - start.x) * dy - (point.y - start.y) * dx) / length;
    squaredDeviationTotal += deviation * deviation;
  }

  const efficiency = length / Math.max(length, decimatedPathLength);
  const rmsDeviation = Math.sqrt(squaredDeviationTotal / uniform.length);
  const maxAllowedDeviation = Math.min(36, Math.max(deliberateHold ? 8 : 6, length * (deliberateHold ? 0.10 : 0.065)));
  const rmsAllowedDeviation = Math.min(18, Math.max(deliberateHold ? 4 : 3, length * (deliberateHold ? 0.055 : 0.032)));
  const minEfficiency = deliberateHold ? 0.85 : 0.93;
  const maxBackwards = Math.max(deliberateHold ? 14 : 10, length * (deliberateHold ? 0.14 : 0.05));
  const duration = end.t - start.t;
  const validDuration = deliberateHold
    ? Number.isFinite(duration) && duration >= 0
    : Number.isFinite(duration) && duration >= 25 && duration <= 30_000;

  const isLine = validDuration
    && efficiency >= minEfficiency
    && maxDeviation <= maxAllowedDeviation
    && rmsDeviation <= rmsAllowedDeviation
    && backwardsDistance <= maxBackwards;

  if (!isLine) return rejected(rawPoints, length, maxDeviation, efficiency);

  const rawAngle = Math.atan2(dy, dx);
  const nearestSnapAngle = Math.round(rawAngle / SNAP_INCREMENT) * SNAP_INCREMENT;
  const angleDifference = Math.abs(Math.atan2(
    Math.sin(rawAngle - nearestSnapAngle),
    Math.cos(rawAngle - nearestSnapAngle),
  ));
  const snappedAngle = snapToAngles && angleDifference <= SNAP_TOLERANCE
    ? nearestSnapAngle
    : null;
  if (snappedAngle === null) {
    return {
      isLine: true,
      points: [{ ...start }, { ...end }],
      length,
      maxDeviation,
      efficiency,
      snappedAngle: null,
    };
  }
  const cos = Math.abs(Math.cos(snappedAngle)) < 1e-12 ? 0 : Math.cos(snappedAngle);
  const sin = Math.abs(Math.sin(snappedAngle)) < 1e-12 ? 0 : Math.sin(snappedAngle);

  return {
    isLine: true,
    points: [
      { ...start },
      {
        ...end,
        x: start.x + cos * length,
        y: start.y + sin * length,
      },
    ],
    length,
    maxDeviation,
    efficiency,
    snappedAngle,
  };
}

export interface ArrowRecognition {
  isArrow: boolean;
  shapeType: 'arrow' | 'double-arrow';
  points: [StrokePoint, StrokePoint] | null;
  length: number;
  snappedAngle: number | null;
}

function rejectedArrow(): ArrowRecognition {
  return { isArrow: false, shapeType: 'arrow', points: null, length: 0, snappedAngle: null };
}

function polylineLength(points: ReadonlyArray<{ x: number; y: number }>): number {
  let len = 0;
  for (let i = 1; i < points.length; i += 1) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

function isCleanSegment(points: StrokePoint[], minEfficiency = 0.80, maxDevFraction = 0.22): boolean {
  if (points.length < 2) return false;
  const start = points[0];
  const end = points[points.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 8) return false;

  const decimated = decimateLinePoints(points, 3);
  const pathLen = polylineLength(decimated);
  if (len / Math.max(len, pathLen) < minEfficiency) return false;

  const maxAllowed = Math.max(6, len * maxDevFraction);
  for (const p of points) {
    const dev = Math.abs((p.x - start.x) * dy - (p.y - start.y) * dx) / len;
    if (dev > maxAllowed) return false;
  }
  return true;
}

function hasValidArrowHead(
  suffix: StrokePoint[],
  tip: StrokePoint,
  ux: number,
  uy: number,
  shaftLen: number,
): boolean {
  if (suffix.length < 2) return false;
  const nx = -uy;
  const ny = ux;
  const local = (p: StrokePoint) => {
    const px = p.x - tip.x;
    const py = p.y - tip.y;
    const back = -(px * ux + py * uy);
    const side = px * nx + py * ny;
    return { back, side, dist: Math.hypot(back, side) };
  };

  const minVBarb = Math.max(10, shaftLen * 0.10);
  const maxVBarb = shaftLen * 0.45;
  const returnTol = Math.max(10, shaftLen * 0.14);

  // Sub-pattern A: V-head (two opposite-side barbs around tip)
  if (suffix.length >= 3) {
    let b1Idx = -1;
    let b1Peak = 0;
    let firstSideSign = 0;
    let decreasing = false;
    for (let k = 1; k < suffix.length; k += 1) {
      const loc = local(suffix[k]);
      if (firstSideSign === 0 && Math.abs(loc.side) >= 4) firstSideSign = Math.sign(loc.side);
      if (loc.dist > b1Peak) {
        b1Peak = loc.dist;
        b1Idx = k;
        decreasing = false;
      } else if (loc.dist < b1Peak - 3) {
        decreasing = true;
      }
      if (
        b1Idx > 0
        && b1Peak >= minVBarb
        && ((decreasing && loc.dist <= Math.max(returnTol, b1Peak * 0.55))
          || (firstSideSign !== 0 && Math.sign(loc.side) === -firstSideSign && Math.abs(loc.side) >= 4))
      ) {
        break;
      }
    }

    if (b1Idx > 0 && b1Peak >= minVBarb && b1Peak <= maxVBarb) {
      const b1Loc = local(suffix[b1Idx]);
      const b1Ang = (Math.atan2(Math.abs(b1Loc.side), b1Loc.back) * 180) / Math.PI;
      if (b1Loc.back > 0 && b1Ang >= 15 && b1Ang <= 72 && Math.abs(b1Loc.side) >= 4 && isCleanSegment(suffix.slice(0, b1Idx + 1))) {
        let retIdx = -1;
        let retDist = Infinity;
        for (let k = b1Idx + 1; k < suffix.length - 1; k += 1) {
          const d = local(suffix[k]).dist;
          if (d < retDist) {
            retDist = d;
            retIdx = k;
          }
        }
        if (retIdx > b1Idx && retDist <= returnTol) {
          let b2Idx = -1;
          let b2Peak = 0;
          for (let k = retIdx + 1; k < suffix.length; k += 1) {
            const d = local(suffix[k]).dist;
            if (d > b2Peak) {
              b2Peak = d;
              b2Idx = k;
            }
          }
          if (b2Idx > retIdx && b2Peak >= minVBarb && b2Peak <= maxVBarb) {
            const b2Loc = local(suffix[b2Idx]);
            const b2Ang = (Math.atan2(Math.abs(b2Loc.side), b2Loc.back) * 180) / Math.PI;
            const b2 = suffix[b2Idx];
            const tailDist = Math.hypot(suffix[suffix.length - 1].x - b2.x, suffix[suffix.length - 1].y - b2.y);
            if (
              b2Loc.back > 0
              && b2Ang >= 15
              && b2Ang <= 72
              && Math.sign(b2Loc.side) === -Math.sign(b1Loc.side)
              && Math.abs(b2Loc.side) >= 4
              && Math.max(b1Peak, b2Peak) / Math.min(b1Peak, b2Peak) <= 2.4
              && isCleanSegment(suffix.slice(b1Idx, retIdx + 1))
              && isCleanSegment(suffix.slice(retIdx, b2Idx + 1))
              && (tailDist <= Math.max(8, b2Peak * 0.35) || local(suffix[suffix.length - 1]).dist <= returnTol)
            ) {
              return true;
            }
          }
        }

        // Cross-over V-head: tip -> b1 -> b2 (-> optional return to tip)
        let b2Idx = -1;
        let b2Peak = 0;
        for (let k = b1Idx + 1; k < suffix.length; k += 1) {
          const loc = local(suffix[k]);
          if (Math.sign(loc.side) === -Math.sign(b1Loc.side) && loc.dist > b2Peak) {
            b2Peak = loc.dist;
            b2Idx = k;
          }
        }
        if (b2Idx > b1Idx && b2Peak >= minVBarb && b2Peak <= maxVBarb) {
          const b2Loc = local(suffix[b2Idx]);
          const b2Ang = (Math.atan2(Math.abs(b2Loc.side), b2Loc.back) * 180) / Math.PI;
          const b2 = suffix[b2Idx];
          const endLoc = local(suffix[suffix.length - 1]);
          const tailDist = Math.hypot(suffix[suffix.length - 1].x - b2.x, suffix[suffix.length - 1].y - b2.y);
          const validTail = tailDist <= Math.max(8, b2Peak * 0.35)
            || (endLoc.dist <= returnTol && isCleanSegment(suffix.slice(b2Idx)));
          if (
            b2Loc.back > 0
            && b2Ang >= 15
            && b2Ang <= 72
            && Math.abs(b2Loc.side) >= 4
            && Math.max(b1Peak, b2Peak) / Math.min(b1Peak, b2Peak) <= 2.4
            && isCleanSegment(suffix.slice(b1Idx, b2Idx + 1), 0.78, 0.25)
            && validTail
          ) {
            return true;
          }
        }
      }
    }
  }

  // Sub-pattern B: Clean single-barb checkmark tip (———> or ———\)
  const end = suffix[suffix.length - 1];
  const endLoc = local(end);
  const barbLen = endLoc.dist;
  if (barbLen < 12 || barbLen > shaftLen * 0.42 || Math.abs(endLoc.side) < 8) return false;
  const cosFwd = Math.max(-1, Math.min(1, -endLoc.back / barbLen));
  const revAngleDeg = (Math.acos(cosFwd) * 180) / Math.PI;
  if (revAngleDeg < 115 || revAngleDeg > 168) return false;

  const decSuffix = decimateLinePoints(suffix, 3);
  const suffixPathLen = polylineLength(decSuffix);
  if (barbLen / Math.max(barbLen, suffixPathLen) < 0.85) return false;

  const bx = end.x - tip.x;
  const by = end.y - tip.y;
  const maxBarbDev = Math.max(6, barbLen * 0.20);
  for (const p of suffix) {
    const dev = Math.abs((p.x - tip.x) * by - (p.y - tip.y) * bx) / barbLen;
    if (dev > maxBarbDev) return false;
  }
  return true;
}

/**
 * Recognize single-stroke drawn arrows (`start -> tip` shaft followed by a V-head or
 * single-barb checkmark head) during hold-to-snap. Returns page-space endpoints and
 * optional 45-degree angle snapping around `start`.
 */
export function recognizeArrowGesture(
  points: StrokePoint[],
  snapToAngles: boolean,
  screenScale = 1,
  options: StraightLineOptions = {},
): ArrowRecognition {
  const scale = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
  const scaled = scale === 1 ? points : points.map(point => ({ ...point, x: point.x * scale, y: point.y * scale }));
  const result = recognizeArrowGestureInScreenSpace(scaled, snapToAngles, options);
  if (scale === 1 || !result.isArrow || !result.points) return result;
  return {
    ...result,
    length: result.length / scale,
    points: [
      { ...result.points[0], x: result.points[0].x / scale, y: result.points[0].y / scale },
      { ...result.points[1], x: result.points[1].x / scale, y: result.points[1].y / scale },
    ],
  };
}

function recognizeArrowGestureInScreenSpace(
  rawPoints: StrokePoint[],
  snapToAngles: boolean,
  options: StraightLineOptions,
): ArrowRecognition {
  const deliberateHold = Boolean(options.deliberateHold);
  if (rawPoints.length < 6 || rawPoints.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    return rejectedArrow();
  }

  const points = deliberateHold ? trimHoldTail(rawPoints, 8) : rawPoints;
  const n = points.length;
  if (n < 6) return rejectedArrow();

  const start = points[0];
  const end = points[n - 1];
  const duration = end.t - start.t;
  const validDuration = deliberateHold
    ? Number.isFinite(duration) && duration >= 0
    : Number.isFinite(duration) && duration >= 25 && duration <= 30_000;
  if (!validDuration) return rejectedArrow();

  const dists = points.map(p => Math.hypot(p.x - start.x, p.y - start.y));
  const cumLen = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    cumLen[i] = cumLen[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const totalLen = cumLen[n - 1];
  let globalMaxDist = 0;
  let globalMaxIdx = 0;
  for (let i = 1; i < n; i += 1) {
    if (dists[i] > globalMaxDist) {
      globalMaxDist = dists[i];
      globalMaxIdx = i;
    }
  }
  if (globalMaxDist < 36) return rejectedArrow();

  // Locate the earliest local distance peak (>= 90% of max reach) before a >= 8px pullback,
  // so a return-to-tip overshoot does not swallow the first arrowhead barb into the shaft.
  let firstPeakIdx = -1;
  let peakDist = 0;
  let peakIdx = -1;
  for (let i = 3; i <= n - 3; i += 1) {
    if (dists[i] > peakDist) {
      peakDist = dists[i];
      peakIdx = i;
    }
    if (peakDist >= globalMaxDist * 0.90 && dists[i] <= peakDist - 8) {
      firstPeakIdx = peakIdx;
      break;
    }
  }

  const candidateIndices: number[] = [];
  if (firstPeakIdx >= 3 && firstPeakIdx <= n - 3) candidateIndices.push(firstPeakIdx);
  if (globalMaxIdx >= 3 && globalMaxIdx <= n - 3 && globalMaxIdx !== firstPeakIdx) candidateIndices.push(globalMaxIdx);

  for (const tipIdx of candidateIndices) {
    const idxFrac = tipIdx / (n - 1);
    const lenFrac = totalLen > 1e-6 ? cumLen[tipIdx] / totalLen : 0;
    if ((idxFrac < 0.32 && lenFrac < 0.42) || idxFrac > 0.94) continue;

    const tip = points[tipIdx];
    const dx = tip.x - start.x;
    const dy = tip.y - start.y;
    const shaftLen = Math.hypot(dx, dy);
    if (shaftLen < 36) continue;
    if (Math.hypot(end.x - start.x, end.y - start.y) <= shaftLen * 0.25) continue;

    const shaftPts = points.slice(0, tipIdx + 1);
    const decShaft = decimateLinePoints(shaftPts, 3);
    const shaftPathLen = polylineLength(decShaft);
    const efficiency = shaftLen / Math.max(shaftLen, shaftPathLen);
    if (efficiency < 0.88) continue;

    let prevProj = 0;
    let backwards = 0;
    for (const p of decShaft) {
      const proj = ((p.x - start.x) * dx + (p.y - start.y) * dy) / shaftLen;
      if (proj < prevProj) backwards += prevProj - proj;
      prevProj = proj;
    }
    if (backwards > Math.max(10, shaftLen * 0.12)) continue;

    let maxDev = 0;
    let sqDev = 0;
    for (const p of shaftPts) {
      const dev = Math.abs((p.x - start.x) * dy - (p.y - start.y) * dx) / shaftLen;
      if (dev > maxDev) maxDev = dev;
      sqDev += dev * dev;
    }
    const rmsDev = Math.sqrt(sqDev / shaftPts.length);
    if (maxDev > Math.min(28, Math.max(8, shaftLen * 0.095)) || rmsDev > Math.min(14, Math.max(4, shaftLen * 0.05))) {
      continue;
    }

    const ux = dx / shaftLen;
    const uy = dy / shaftLen;
    if (!hasValidArrowHead(points.slice(tipIdx), tip, ux, uy, shaftLen)) continue;

    const rawAngle = Math.atan2(dy, dx);
    const nearestSnapAngle = Math.round(rawAngle / SNAP_INCREMENT) * SNAP_INCREMENT;
    const angleDiff = Math.abs(Math.atan2(
      Math.sin(rawAngle - nearestSnapAngle),
      Math.cos(rawAngle - nearestSnapAngle),
    ));
    const snappedAngle = snapToAngles && angleDiff <= SNAP_TOLERANCE ? nearestSnapAngle : null;
    const cos = snappedAngle !== null ? (Math.abs(Math.cos(snappedAngle)) < 1e-12 ? 0 : Math.cos(snappedAngle)) : 0;
    const sin = snappedAngle !== null ? (Math.abs(Math.sin(snappedAngle)) < 1e-12 ? 0 : Math.sin(snappedAngle)) : 0;
    const finalTip: StrokePoint = snappedAngle === null
      ? { ...tip }
      : { ...tip, x: start.x + cos * shaftLen, y: start.y + sin * shaftLen };

    return {
      isArrow: true,
      shapeType: 'arrow',
      points: [{ ...start }, finalTip],
      length: shaftLen,
      snappedAngle,
    };
  }

  return rejectedArrow();
}
