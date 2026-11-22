import type { StrokePoint } from './drawingTypes.ts';

export interface ScribbleAnalysis {
  isScribble: boolean;
  reversals: number;
  pathLength: number;
}

interface AxisAnalysis {
  reversals: number;
  medianLeg: number;
  straightness: number;
}

function axisSpan(points: StrokePoint[], ax: number, ay: number): number {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const p = point.x * ax + point.y * ay;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return max - min;
}

function analyzeAxis(
  points: StrokePoint[],
  cumLen: Float64Array,
  ax: number,
  ay: number,
  span: number,
  relThresh: number,
): AxisAnalysis {
  if (span <= 1e-6) return { reversals: 0, medianLeg: 0, straightness: 0 };
  const threshold = Math.max(4, Math.min(span * relThresh, 18));
  const proj = new Float64Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    proj[i] = points[i].x * ax + points[i].y * ay;
  }

  let dir = 0;
  let initMin = proj[0];
  let initMinIdx = 0;
  let initMax = proj[0];
  let initMaxIdx = 0;
  let extreme = proj[0];
  let extremeIdx = 0;
  let legStartIdx = 0;
  const legs: Array<{ startIdx: number; endIdx: number; amp: number }> = [];

  for (let i = 1; i < points.length; i += 1) {
    const p = proj[i];
    if (dir === 0) {
      if (p < initMin) { initMin = p; initMinIdx = i; }
      if (p > initMax) { initMax = p; initMaxIdx = i; }
      const upFromMin = p - initMin >= threshold;
      const downFromMax = initMax - p >= threshold;
      if (upFromMin && !downFromMax) {
        dir = 1;
        legStartIdx = initMinIdx;
        extreme = p;
        extremeIdx = i;
      } else if (downFromMax && !upFromMin) {
        dir = -1;
        legStartIdx = initMaxIdx;
        extreme = p;
        extremeIdx = i;
      } else if (upFromMin && downFromMax) {
        if (initMinIdx < initMaxIdx) {
          legs.push({ startIdx: initMinIdx, endIdx: initMaxIdx, amp: Math.abs(proj[initMaxIdx] - proj[initMinIdx]) });
          dir = -1;
          legStartIdx = initMaxIdx;
          extreme = p;
          extremeIdx = i;
        } else {
          legs.push({ startIdx: initMaxIdx, endIdx: initMinIdx, amp: Math.abs(proj[initMinIdx] - proj[initMaxIdx]) });
          dir = 1;
          legStartIdx = initMinIdx;
          extreme = p;
          extremeIdx = i;
        }
      }
      continue;
    }

    if (dir === 1) {
      if (p >= extreme) {
        extreme = p;
        extremeIdx = i;
      } else if (extreme - p >= threshold) {
        legs.push({ startIdx: legStartIdx, endIdx: extremeIdx, amp: Math.abs(proj[extremeIdx] - proj[legStartIdx]) });
        dir = -1;
        legStartIdx = extremeIdx;
        extreme = p;
        extremeIdx = i;
      }
    } else {
      if (p <= extreme) {
        extreme = p;
        extremeIdx = i;
      } else if (p - extreme >= threshold) {
        legs.push({ startIdx: legStartIdx, endIdx: extremeIdx, amp: Math.abs(proj[extremeIdx] - proj[legStartIdx]) });
        dir = 1;
        legStartIdx = extremeIdx;
        extreme = p;
        extremeIdx = i;
      }
    }
  }

  if (dir !== 0 && extremeIdx > legStartIdx) {
    const finalAmp = Math.abs(proj[extremeIdx] - proj[legStartIdx]);
    if (finalAmp >= threshold) {
      legs.push({ startIdx: legStartIdx, endIdx: extremeIdx, amp: finalAmp });
    }
  }

  if (legs.length === 0) return { reversals: 0, medianLeg: 0, straightness: 0 };

  const amps = legs.map(leg => leg.amp).sort((a, b) => a - b);
  const mid = Math.floor(amps.length / 2);
  const medianLeg = amps.length % 2 === 1 ? amps[mid] : (amps[mid - 1] + amps[mid]) * 0.5;
  let sumChord = 0;
  let sumArc = 0;
  for (const leg of legs) {
    const start = points[leg.startIdx];
    const end = points[leg.endIdx];
    sumChord += Math.hypot(end.x - start.x, end.y - start.y);
    sumArc += cumLen[leg.endIdx] - cumLen[leg.startIdx];
  }
  return {
    reversals: Math.max(0, legs.length - 1),
    medianLeg,
    straightness: sumArc > 1e-6 ? sumChord / sumArc : 0,
  };
}

function resampleByArcLength(points: StrokePoint[], cumLen: Float64Array, step: number): Array<{ x: number; y: number }> {
  const total = cumLen[cumLen.length - 1];
  if (total <= 1e-6) return [{ x: points[0].x, y: points[0].y }];
  const out: Array<{ x: number; y: number }> = [{ x: points[0].x, y: points[0].y }];
  let seg = 1;
  for (let target = step; target < total - 1e-6; target += step) {
    while (seg < cumLen.length - 1 && cumLen[seg] < target) seg += 1;
    const prevLen = cumLen[seg - 1];
    const segLen = cumLen[seg] - prevLen;
    const t = segLen > 1e-9 ? (target - prevLen) / segLen : 0;
    const p = points[seg - 1];
    const q = points[seg];
    out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  }
  const last = points[points.length - 1];
  out.push({ x: last.x, y: last.y });
  return out;
}

function simplifyDouglasPeucker(points: StrokePoint[], epsilon: number): StrokePoint[] {
  const n = points.length;
  if (n <= 2) return points;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [startIdx, endIdx] = stack.pop()!;
    if (endIdx - startIdx <= 1) continue;
    const a = points[startIdx];
    const b = points[endIdx];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = startIdx + 1; i < endIdx; i += 1) {
      const p = points[i];
      const dist = len > 1e-9
        ? Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len
        : Math.hypot(p.x - a.x, p.y - a.y);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > epsilon && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([startIdx, maxIdx], [maxIdx, endIdx]);
    }
  }
  const simplified: StrokePoint[] = [];
  for (let i = 0; i < n; i += 1) {
    if (keep[i]) simplified.push(points[i]);
  }
  return simplified;
}

function turnMetrics(points: ReadonlyArray<{ x: number; y: number }>, sharpAngleRad: number): { sharpTurns: number; winding: number } {
  const vecs: Array<{ ux: number; uy: number }> = [];
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) vecs.push({ ux: dx / len, uy: dy / len });
  }
  let sharpTurns = 0;
  let signedTurn = 0;
  let absTurn = 0;
  for (let i = 1; i < vecs.length; i += 1) {
    const prev = vecs[i - 1];
    const curr = vecs[i];
    const dot = Math.max(-1, Math.min(1, prev.ux * curr.ux + prev.uy * curr.uy));
    const cross = prev.ux * curr.uy - prev.uy * curr.ux;
    const angle = Math.atan2(cross, dot);
    if (Math.abs(angle) >= sharpAngleRad) sharpTurns += 1;
    signedTurn += angle;
    absTurn += Math.abs(angle);
  }
  return {
    sharpTurns,
    winding: absTurn > 1e-6 ? Math.abs(signedTurn) / absTurn : 1,
  };
}

/**
 * Recognize a deliberate scratch gesture without consuming ordinary writing.
 * Evaluation uses rotation-invariant tangent/position principal axes and
 * hysteresis leg amplitudes so horizontal, vertical, and diagonal scribbles
 * behave identically across zoom levels and pointer sampling rates.
 */
export function analyzeScribble(points: StrokePoint[], screenScale = 1): ScribbleAnalysis {
  const scale = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
  if (points.length < 10) return { isScribble: false, reversals: 0, pathLength: 0 };
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { isScribble: false, reversals: 0, pathLength: 0 };
    }
  }
  if (scale !== 1) points = points.map(point => ({ ...point, x: point.x * scale, y: point.y * scale }));

  const n = points.length;
  const cumLen = new Float64Array(n);
  let mxx = 0;
  let myy = 0;
  let mxy = 0;
  let meanX = 0;
  let meanY = 0;

  for (let i = 1; i < n; i += 1) {
    const p = points[i - 1];
    const q = points[i];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const segLen = Math.hypot(dx, dy);
    cumLen[i] = cumLen[i - 1] + segLen;
    if (segLen > 1e-6) {
      mxx += (dx * dx) / segLen;
      myy += (dy * dy) / segLen;
      mxy += (dx * dy) / segLen;
      meanX += (p.x + q.x) * 0.5 * segLen;
      meanY += (p.y + q.y) * 0.5 * segLen;
    }
  }

  const pathLength = cumLen[n - 1];
  if (pathLength <= 1e-6) return { isScribble: false, reversals: 0, pathLength: 0 };

  meanX /= pathLength;
  meanY /= pathLength;

  const thetaT = 0.5 * Math.atan2(2 * mxy, mxx - myy);
  const tx = Math.cos(thetaT);
  const ty = Math.sin(thetaT);
  const anisotropy = Math.hypot(mxx - myy, 2 * mxy) / pathLength;

  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (let i = 1; i < n; i += 1) {
    const segLen = cumLen[i] - cumLen[i - 1];
    if (segLen <= 1e-6) continue;
    const ax = points[i - 1].x - meanX;
    const ay = points[i - 1].y - meanY;
    const bx = points[i].x - meanX;
    const by = points[i].y - meanY;
    cxx += (segLen / 3) * (ax * ax + ax * bx + bx * bx);
    cyy += (segLen / 3) * (ay * ay + ay * by + by * by);
    cxy += (segLen / 3) * (ax * ay + 0.5 * (ax * by + bx * ay) + bx * by);
  }

  const thetaP = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const ux0 = Math.cos(thetaP);
  const uy0 = Math.sin(thetaP);
  const vx0 = -uy0;
  const vy0 = ux0;
  const span0 = axisSpan(points, ux0, uy0);
  const span1 = axisSpan(points, vx0, vy0);
  const [ux, uy, spanU, vx, vy, spanV] = span0 >= span1
    ? [ux0, uy0, span0, vx0, vy0, span1]
    : [vx0, vy0, span1, ux0, uy0, span0];

  const tanSpan = axisSpan(points, tx, ty);
  const tanPerpSpan = axisSpan(points, -ty, tx);
  const obbDiagonal = Math.min(Math.hypot(spanU, spanV), Math.hypot(tanSpan, tanPerpSpan));
  const majorSpan = Math.max(spanU, tanSpan);

  const majorAxis = analyzeAxis(points, cumLen, ux, uy, spanU, 0.14);
  const minorAxis = analyzeAxis(points, cumLen, vx, vy, spanV, 0.18);
  const tangentAxis = analyzeAxis(points, cumLen, tx, ty, tanSpan, 0.16);
  const reversals = Math.max(majorAxis.reversals, minorAxis.reversals, tangentAxis.reversals);

  const duration = points[n - 1].t - points[0].t;
  if (!Number.isFinite(duration) || duration < 0 || duration > 1_600 || majorSpan < 28 || pathLength < 90 || obbDiagonal <= 1e-6) {
    return { isScribble: false, reversals, pathLength };
  }

  const sharpAngleRad = (100 * Math.PI) / 180;
  const finePoints = resampleByArcLength(points, cumLen, Math.max(3, Math.min(5, obbDiagonal * 0.04)));
  const rawWinding = turnMetrics(finePoints, sharpAngleRad).winding;
  const dpPoints = simplifyDouglasPeucker(points, Math.max(2.5, Math.min(5, obbDiagonal * 0.03)));
  const { sharpTurns, winding: dpWinding } = turnMetrics(dpPoints, sharpAngleRad);

  const densityRatio = pathLength / obbDiagonal;
  const majorBackForth = sharpTurns >= 4
    && majorAxis.reversals >= 4
    && densityRatio >= 2.4
    && majorAxis.medianLeg >= Math.max(12, spanU * 0.35)
    && majorAxis.straightness >= 0.84
    && anisotropy >= 0.40;

  const alternatingTurns = sharpTurns >= 4 && dpWinding <= 0.52 && rawWinding <= 0.52;
  const bestZig = tangentAxis.reversals >= 4 && tangentAxis.medianLeg >= minorAxis.medianLeg
    ? tangentAxis
    : minorAxis;
  const aspect = spanU / Math.max(1, spanV);
  const minorZigzag = alternatingTurns
    && bestZig.reversals >= 4
    && ((spanV >= 28 && bestZig.medianLeg >= 28 && aspect <= 3.7)
      || (spanV >= 46 && bestZig.medianLeg >= 44 && aspect <= 5.5))
    && bestZig.medianLeg >= spanV * 0.65
    && bestZig.straightness >= 0.92
    && densityRatio >= 1.95
    && anisotropy >= 0.45;

  const obliqueSlash = alternatingTurns
    && tangentAxis.reversals >= 4
    && tangentAxis.medianLeg >= 42
    && tangentAxis.straightness >= 0.92
    && anisotropy >= 0.65
    && densityRatio >= 2.15
    && majorAxis.reversals >= 4
    && majorAxis.medianLeg >= 16;

  return {
    isScribble: majorBackForth || minorZigzag || obliqueSlash,
    reversals,
    pathLength,
  };
}

/** Find existing strokes repeatedly crossed by a recognized gesture. */
export function findScribbleTargets(
  points: StrokePoint[],
  findNearPoint: (x: number, y: number, radius: number) => string[],
  radius: number,
): Set<string> {
  const hitCounts = new Map<string, number>();
  const sampleStep = 6;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const samples = Math.max(1, Math.ceil(distance / sampleStep));
    for (let sample = 0; sample <= samples; sample += 1) {
      const t = sample / samples;
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      for (const id of findNearPoint(x, y, radius)) {
        hitCounts.set(id, (hitCounts.get(id) ?? 0) + 1);
      }
    }
  }

  return new Set([...hitCounts].filter(([, count]) => count >= 3).map(([id]) => id));
}
