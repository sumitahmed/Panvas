import type { JSONContent } from '@tiptap/core';
import type { BoundingBox, Stroke } from '../../components/notebook/engine/drawingTypes.ts';
import type { HandwritingRecognitionProvider } from '../recognition/types.ts';

export type MathOcrEngineKind = 'onnx-texteller3' | 'provider-normalized' | 'fallback' | 'none';

export interface MathLineBatch {
  id: string;
  strokes: Stroke[];
  bounds: BoundingBox;
  coreY: number;
  layerId?: string;
}

export interface MathRecognitionResult {
  status: 'success' | 'empty' | 'needs-model';
  latex: string;
  lineCount: number;
  strokeCount: number;
  symbolsCount: number;
  warnings: string[];
  engine: MathOcrEngineKind;
  needsModelDownload: boolean;
}

export interface MathRecognitionOptions {
  provider?: HandwritingRecognitionProvider;
  language?: string;
  onProgress?: (info: { currentLine: number; totalLines: number }) => void;
}

export function createMathTipTapContent(
  latex: string,
  options: { displayMode?: boolean } = {},
): JSONContent {
  const cleanLatex = latex.trim();
  if (options.displayMode !== false) {
    return {
      type: 'doc',
      content: [{ type: 'blockMath', attrs: { latex: cleanLatex } }],
    };
  }
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'inlineMath', attrs: { latex: cleanLatex } }],
      },
    ],
  };
}

export function extractLatexFromTipTapContent(content: unknown): string | null {
  let firstEmptyMatch: string | null = null;

  const visit = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = visit(child);
        if (found !== null) return found;
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    if (record.type === 'blockMath' || record.type === 'inlineMath' || record.type === 'math') {
      const attrs = record.attrs && typeof record.attrs === 'object'
        ? record.attrs as Record<string, unknown>
        : null;
      if (attrs && typeof attrs.latex === 'string') {
        if (attrs.latex.trim().length > 0) return attrs.latex;
        if (firstEmptyMatch === null) firstEmptyMatch = attrs.latex;
      }
    }
    if (Array.isArray(record.content)) {
      const found = visit(record.content);
      if (found !== null) return found;
    }
    return null;
  };

  return visit(content) ?? firstEmptyMatch;
}

function isEligibleStroke(stroke: Stroke): boolean {
  return (stroke.tool === 'pen' || stroke.tool === 'pencil') && stroke.points.length >= 1;
}

interface StrokeGeom {
  index: number;
  stroke: Stroke;
  layerKey: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
  centerX: number;
  centerY: number;
}

function measureStrokeGeom(stroke: Stroke, index: number): StrokeGeom | null {
  if (stroke.points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of stroke.points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const pad = Math.max(1, (stroke.thickness || 2) * 0.5);
  const x0 = minX - pad;
  const y0 = minY - pad;
  const x1 = maxX + pad;
  const y1 = maxY + pad;
  const w = Math.max(2, x1 - x0);
  const h = Math.max(2, y1 - y0);
  return {
    index,
    stroke,
    layerKey: stroke.layerId ?? '',
    x0,
    y0,
    x1,
    y1,
    w,
    h,
    centerX: (x0 + x1) * 0.5,
    centerY: (y0 + y1) * 0.5,
  };
}

function spanOverlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function spanGap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));
}

function unionStrokeBounds(geoms: readonly StrokeGeom[]): BoundingBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const g of geoms) {
    if (g.x0 < minX) minX = g.x0;
    if (g.y0 < minY) minY = g.y0;
    if (g.x1 > maxX) maxX = g.x1;
    if (g.y1 > maxY) maxY = g.y1;
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(4, maxX - minX),
    height: Math.max(4, maxY - minY),
  };
}

function estimateMathScale(geoms: readonly StrokeGeom[]): number {
  const heights = geoms.map(g => g.h).filter(h => h >= 4).sort((a, b) => a - b);
  if (heights.length === 0) {
    const all = geoms.map(g => g.h).sort((a, b) => a - b);
    return Math.max(16, all[Math.floor(all.length * 0.5)] ?? 24);
  }
  const q60 = heights[Math.min(heights.length - 1, Math.floor((heights.length - 1) * 0.6))];
  return Math.max(14, Math.min(96, q60));
}

function isFlatHorizontalBar(g: StrokeGeom, scale: number): boolean {
  return g.h <= scale * 0.65 && g.w >= scale * 0.35 && g.w / Math.max(g.h, 1) >= 2.2;
}

/**
 * Structure-aware two-stage math line segmenter:
 * - Stage 1 atomically binds vertical math structures (equals pairs, fraction bars + numerator/denominator,
 *   multi-row delimiter matrices, tall operators ∫/∑/∏ with limits, radicals √, dots).
 * - Stage 2 separates distinct horizontal equation lines by line-core Y centers so stacked integrals
 *   never glue adjacent lines together, while keeping fractions, limits, and matrices intact.
 */
export function segmentMathLines(strokes: readonly Stroke[]): MathLineBatch[] {
  const seenIds = new Set<string>();
  const geoms: StrokeGeom[] = [];
  for (const stroke of strokes) {
    if (seenIds.has(stroke.id) || !isEligibleStroke(stroke)) continue;
    seenIds.add(stroke.id);
    const geom = measureStrokeGeom(stroke, geoms.length);
    if (geom) geoms.push(geom);
  }
  if (geoms.length === 0) return [];

  const byLayer = new Map<string, StrokeGeom[]>();
  for (const g of geoms) {
    const list = byLayer.get(g.layerKey) ?? [];
    list.push(g);
    byLayer.set(g.layerKey, list);
  }

  const allBatches: MathLineBatch[] = [];
  for (const layerGeoms of byLayer.values()) {
    allBatches.push(...segmentLayerMathLines(layerGeoms));
  }
  allBatches.sort((a, b) => a.coreY - b.coreY || a.bounds.x - b.bounds.x);
  return allBatches.map((batch, idx) => ({
    ...batch,
    id: `math-line-${idx + 1}`,
  }));
}

function segmentLayerMathLines(geoms: readonly StrokeGeom[]): MathLineBatch[] {
  const n = geoms.length;
  const scale = estimateMathScale(geoms);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== i) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const multiRowMembers = new Set<number>();
  const tallOpMembers = new Set<number>();
  const equalsMembers = new Set<number>();

  // Rule A: Pair `=` double-bars first so they are never treated as fraction bars.
  for (let i = 0; i < n; i += 1) {
    const a = geoms[i];
    if (!isFlatHorizontalBar(a, scale) || a.w > scale * 2.4) continue;
    let bestJ = -1;
    let bestDist = Infinity;
    for (let j = i + 1; j < n; j += 1) {
      const b = geoms[j];
      if (!isFlatHorizontalBar(b, scale) || b.w > scale * 2.4) continue;
      const overlap = spanOverlap(a.x0, a.x1, b.x0, b.x1);
      const minW = Math.min(a.w, b.w);
      const maxW = Math.max(a.w, b.w);
      const yDist = spanGap(a.y0, a.y1, b.y0, b.y1);
      if (
        overlap >= minW * 0.55
        && minW / maxW >= 0.45
        && yDist <= scale * 0.7
        && Math.abs(a.centerX - b.centerX) <= scale * 0.5
      ) {
        if (yDist < bestDist) {
          bestDist = yDist;
          bestJ = j;
        }
      }
    }
    if (bestJ !== -1) {
      union(i, bestJ);
      equalsMembers.add(i);
      equalsMembers.add(bestJ);
    }
  }

  // Rule B: Horizontal fraction bars (\frac{num}{den}) -> bind numerator & denominator atomically.
  for (let i = 0; i < n; i += 1) {
    if (equalsMembers.has(i)) continue;
    const bar = geoms[i];
    if (bar.w < Math.max(26, scale * 1.45) || bar.w / Math.max(bar.h, 1) < 2.6 || bar.h > scale * 0.65) {
      continue;
    }
    const barLeft = bar.x0 - scale * 0.28;
    const barRight = bar.x1 + scale * 0.28;
    const above = geoms.filter((g, idx) => (
      idx !== i
      && !equalsMembers.has(idx)
      && g.centerX >= barLeft
      && g.centerX <= barRight
      && g.y1 <= bar.y1 + scale * 0.2
      && bar.y0 - g.y1 <= scale * 1.65
      && g.y0 >= bar.y0 - scale * 2.8
    ));
    const below = geoms.filter((g, idx) => (
      idx !== i
      && !equalsMembers.has(idx)
      && g.centerX >= barLeft
      && g.centerX <= barRight
      && g.y0 >= bar.y0 - scale * 0.2
      && g.y0 - bar.y1 <= scale * 1.65
      && g.y1 <= bar.y1 + scale * 2.8
    ));
    if (above.length === 0 || below.length === 0) continue;

    // Require genuine expression height or wide bar so stray `-` doesn't merge unrelated lines.
    const maxPartHeight = Math.max(...above.map(g => g.h), ...below.map(g => g.h));
    if (maxPartHeight < scale * 0.35 && bar.w < scale * 2.0) continue;

    multiRowMembers.add(i);
    for (const part of [...above, ...below]) {
      union(i, part.index);
      multiRowMembers.add(part.index);
    }
    // Pull in adjacent sibling symbols inside numerator/denominator Y-bands within the bar's X-span.
    const expandBand = (seeds: StrokeGeom[]) => {
      let bandY0 = Math.min(...seeds.map(g => g.y0));
      let bandY1 = Math.max(...seeds.map(g => g.y1));
      let changed = true;
      while (changed) {
        changed = false;
        for (const g of geoms) {
          if (multiRowMembers.has(g.index) || equalsMembers.has(g.index)) continue;
          if (g.centerX < barLeft - scale * 0.2 || g.centerX > barRight + scale * 0.2) continue;
          const overlapsBand = spanOverlap(g.y0, g.y1, bandY0, bandY1) > 0
            || spanGap(g.y0, g.y1, bandY0, bandY1) <= scale * 0.3;
          const distToBar = spanGap(g.y0, g.y1, bar.y0, bar.y1);
          if (overlapsBand && distToBar <= scale * 2.2) {
            union(i, g.index);
            multiRowMembers.add(g.index);
            bandY0 = Math.min(bandY0, g.y0);
            bandY1 = Math.max(bandY1, g.y1);
            changed = true;
          }
        }
      }
    };
    expandBand(above);
    expandBand(below);
  }

  // Rule C: Multi-row paired delimiters (matrices, cases).
  const tallDelimiters = geoms.filter(g => (
    !multiRowMembers.has(g.index)
    && g.h >= scale * 2.05
    && g.h / Math.max(g.w, 1) >= 1.7
  )).sort((a, b) => a.x0 - b.x0);

  for (let li = 0; li < tallDelimiters.length; li += 1) {
    const left = tallDelimiters[li];
    if (multiRowMembers.has(left.index)) continue;
    for (let ri = li + 1; ri < tallDelimiters.length; ri += 1) {
      const right = tallDelimiters[ri];
      if (multiRowMembers.has(right.index)) continue;
      if (right.x0 <= left.x1 || right.x0 - left.x1 > scale * 14) continue;
      const vOv = spanOverlap(left.y0, left.y1, right.y0, right.y1);
      const maxH = Math.max(left.h, right.h);
      if (vOv < maxH * 0.55 || Math.abs(left.centerY - right.centerY) > maxH * 0.35) continue;

      const minY = Math.min(left.y0, right.y0) - scale * 0.35;
      const maxY = Math.max(left.y1, right.y1) + scale * 0.35;
      const inside = geoms.filter(g => (
        g.index !== left.index
        && g.index !== right.index
        && g.centerX > left.x0
        && g.centerX < right.x1
        && g.centerY >= minY
        && g.centerY <= maxY
      ));
      const interiorBody = inside.filter(g => {
        const isSmallRightLimitOfLeft = g.h <= scale * 0.95 && g.w <= scale * 1.4
          && g.x0 <= left.x1 + scale * 1.25
          && (g.centerY <= left.y0 + left.h * 0.35 || g.centerY >= left.y1 - left.h * 0.35);
        const isSmallRightLimitOfRight = g.h <= scale * 0.95 && g.w <= scale * 1.4
          && g.x0 >= right.x0 - scale * 0.45 && g.x0 <= right.x1 + scale * 1.25;
        return !isSmallRightLimitOfLeft && !isSmallRightLimitOfRight;
      });
      if (interiorBody.length < 2) continue;
      const minInY = Math.min(...interiorBody.map(g => g.centerY));
      const maxInY = Math.max(...interiorBody.map(g => g.centerY));
      if (maxInY - minInY < scale * 1.1) continue;

      union(left.index, right.index);
      multiRowMembers.add(left.index);
      multiRowMembers.add(right.index);
      for (const part of inside) {
        union(left.index, part.index);
        multiRowMembers.add(part.index);
      }
      break;
    }
  }

  // Rule D: Tall operators (∫, ∑, ∏) and tall evaluation brackets (], |) + single/multi-stroke limits.
  const tallOperators = geoms.filter(g => (
    !multiRowMembers.has(g.index)
    && g.h >= Math.max(scale * 1.45, 34)
    && g.h / Math.max(g.w, 1) >= 1.1
  ));
  const tallOperatorSet = new Set(tallOperators.map(g => g.index));
  const opAttachedLimits = new Map<number, StrokeGeom[]>(tallOperators.map(op => [op.index, []]));

  for (const g of geoms) {
    if (multiRowMembers.has(g.index) || tallOperatorSet.has(g.index) || equalsMembers.has(g.index)) continue;
    // Only small/limit-sized glyphs in upper/lower hook zones can attach.
    if (g.h > Math.max(scale * 1.15, 64) || g.w > scale * 1.85) continue;

    let bestOp: StrokeGeom | null = null;
    let bestScore = Infinity;
    for (const op of tallOperators) {
      if (g.h > op.h * 0.48 || g.w > op.h * 0.9) continue;
      if (g.x1 < op.x0 - op.h * 0.9 || g.x0 > op.x1 + op.h * 0.9) continue;
      if (spanGap(g.x0, g.x1, op.x0, op.x1) > op.h * 0.9) continue;
      const nearTop = g.centerY >= op.y0 - op.h * 0.55
        && g.centerY <= op.y0 + op.h * 0.35
        && g.y1 <= op.centerY + scale * 0.15;
      const nearBottom = g.centerY >= op.y0 + op.h * 0.65
        && g.centerY <= op.y1 + op.h * 0.55
        && g.y0 >= op.centerY - scale * 0.15;
      if (!nearTop && !nearBottom) continue;

      const hookY = nearTop ? op.y0 + op.h * 0.14 : op.y1 - op.h * 0.14;
      const score = Math.abs(g.centerY - hookY) + spanGap(g.x0, g.x1, op.x0, op.x1) * 0.7;
      if (score < bestScore) {
        bestScore = score;
        bestOp = op;
      }
    }
    if (bestOp) {
      union(bestOp.index, g.index);
      tallOpMembers.add(bestOp.index);
      tallOpMembers.add(g.index);
      opAttachedLimits.get(bestOp.index)?.push(g);
    }
  }
  // Propagate to multi-stroke limit clusters (e.g. "-1", "-\infty", "10", "n=0").
  let expandedLimit = true;
  while (expandedLimit) {
    expandedLimit = false;
    for (const op of tallOperators) {
      const limits = opAttachedLimits.get(op.index) ?? [];
      if (limits.length === 0) continue;
      for (const g of geoms) {
        if (multiRowMembers.has(g.index) || tallOpMembers.has(g.index) || equalsMembers.has(g.index)) continue;
        if (g.h > Math.max(scale * 1.15, op.h * 0.48) || g.w > scale * 1.85) continue;
        if (g.x1 < op.x0 - op.h * 0.9 || g.x0 > op.x1 + op.h * 0.9) continue;
        const nearAttached = limits.some(lim => (
          spanGap(g.x0, g.x1, lim.x0, lim.x1) <= scale * 0.65
          && Math.abs(g.centerY - lim.centerY) <= scale * 0.45
          && ((lim.centerY <= op.centerY && g.y1 <= op.centerY + scale * 0.15)
            || (lim.centerY >= op.centerY && g.y0 >= op.centerY - scale * 0.15))
        ));
        if (nearAttached) {
          union(op.index, g.index);
          tallOpMembers.add(op.index);
          tallOpMembers.add(g.index);
          limits.push(g);
          expandedLimit = true;
        }
      }
    }
  }
  for (const op of tallOperators) tallOpMembers.add(op.index);

  // Rule E: Radicals (√ enclosing radicand).
  for (const rad of geoms) {
    if (multiRowMembers.has(rad.index) || tallOpMembers.has(rad.index) || equalsMembers.has(rad.index)) continue;
    if (rad.w < scale * 1.35 || rad.h < scale * 0.95) continue;
    const radRight = rad.x1 + scale * 0.25;
    const radLeft = rad.x0 + rad.w * 0.16;
    const inside = geoms.filter(g => (
      g.index !== rad.index
      && !multiRowMembers.has(g.index)
      && !tallOpMembers.has(g.index)
      && g.centerX >= radLeft
      && g.centerX <= radRight
      && g.y0 >= rad.y0 - scale * 0.1
      && g.y1 <= Math.max(rad.y1, rad.y0 + scale * 1.55) + scale * 0.25
    ));
    if (inside.length === 0) continue;
    // Check that the radical has top-right horizontal overhang (signature of √ bar vs letter).
    const rightSpanCount = rad.stroke.points.filter(p => p.x >= rad.x0 + rad.w * 0.45 && p.y <= rad.y0 + rad.h * 0.35).length;
    if (rightSpanCount === 0) continue;
    multiRowMembers.add(rad.index);
    for (const part of inside) {
      union(rad.index, part.index);
      multiRowMembers.add(part.index);
    }
  }

  // Rule F: Tiny dots / periods attached cleanly to nearest base symbol.
  for (const dot of geoms) {
    if (multiRowMembers.has(dot.index) || tallOpMembers.has(dot.index) || equalsMembers.has(dot.index)) continue;
    if (dot.h > scale * 0.35 || dot.w > scale * 0.35) continue;
    let bestTarget = -1;
    let bestScore = Infinity;
    for (const candidate of geoms) {
      if (candidate.index === dot.index || (candidate.h <= scale * 0.35 && candidate.w <= scale * 0.35)) continue;
      const xg = spanGap(dot.x0, dot.x1, candidate.x0, candidate.x1);
      const yg = spanGap(dot.y0, dot.y1, candidate.y0, candidate.y1);
      if (xg > scale * 0.55 || yg > scale * 0.75) continue;
      const score = yg + xg * 0.8;
      if (score < bestScore) {
        bestScore = score;
        bestTarget = candidate.index;
      }
    }
    if (bestTarget !== -1) union(bestTarget, dot.index);
  }

  // Collect Stage 1 atomic components.
  interface AtomicBlock {
    members: StrokeGeom[];
    bounds: BoundingBox;
    coreY: number;
    isMultiRow: boolean;
    isTallOp: boolean;
  }
  const compMap = new Map<number, StrokeGeom[]>();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    const list = compMap.get(r) ?? [];
    list.push(geoms[i]);
    compMap.set(r, list);
  }

  const atoms: AtomicBlock[] = [...compMap.values()].map(members => {
    const bounds = unionStrokeBounds(members);
    const hasMulti = members.some(m => multiRowMembers.has(m.index));
    const hasTallOp = members.some(m => tallOpMembers.has(m.index));
    let coreY = bounds.y + bounds.height * 0.5;
    if (hasTallOp && !hasMulti) {
      const opMember = members.find(m => tallOperatorSet.has(m.index));
      if (opMember) coreY = opMember.centerY;
    }
    return {
      members,
      bounds,
      coreY,
      isMultiRow: hasMulti,
      isTallOp: hasTallOp,
    };
  });

  // Stage 2: Cluster regular (non-tall-operator, non-multi-row) atoms into horizontal lines.
  const regularAtoms = atoms
    .filter(a => !a.isMultiRow && !a.isTallOp)
    .sort((a, b) => a.coreY - b.coreY || a.bounds.x - b.bounds.x);
  const specialAtoms = atoms
    .filter(a => a.isMultiRow || a.isTallOp)
    .sort((a, b) => a.coreY - b.coreY || a.bounds.x - b.bounds.x);

  interface LineCluster {
    atoms: AtomicBlock[];
    anchorY: number;
    y0: number;
    y1: number;
  }

  const lineClusters: LineCluster[] = [];
  const appendToCluster = (cluster: LineCluster, atom: AtomicBlock) => {
    cluster.atoms.push(atom);
    const nonMultiCores = cluster.atoms.filter(a => !a.isMultiRow).map(a => a.coreY);
    const sourceCores = nonMultiCores.length > 0 ? nonMultiCores : cluster.atoms.map(a => a.coreY);
    cluster.anchorY = sourceCores.reduce((s, v) => s + v, 0) / sourceCores.length;
    cluster.y0 = Math.min(cluster.y0, atom.bounds.y);
    cluster.y1 = Math.max(cluster.y1, atom.bounds.y + atom.bounds.height);
  };

  // First seed lines from regular body atoms.
  for (const atom of regularAtoms) {
    if (lineClusters.length === 0) {
      lineClusters.push({
        atoms: [atom],
        anchorY: atom.coreY,
        y0: atom.bounds.y,
        y1: atom.bounds.y + atom.bounds.height,
      });
      continue;
    }
    const current = lineClusters[lineClusters.length - 1];
    const centerDelta = atom.coreY - current.anchorY;
    const isSmallSubOrSuper = atom.bounds.height <= scale * 0.65
      && current.atoms.some(prev => (
        spanGap(atom.bounds.x, atom.bounds.x + atom.bounds.width, prev.bounds.x, prev.bounds.x + prev.bounds.width) <= scale * 1.4
        && Math.abs(atom.coreY - prev.coreY) <= scale * 1.05
      ));
    if (centerDelta <= scale * 0.78 || isSmallSubOrSuper) {
      appendToCluster(current, atom);
    } else {
      lineClusters.push({
        atoms: [atom],
        anchorY: atom.coreY,
        y0: atom.bounds.y,
        y1: atom.bounds.y + atom.bounds.height,
      });
    }
  }

  // Merge special (integral-with-limits, fractions, matrices) into matching inline equation line or create own line.
  for (const special of specialAtoms) {
    const sTop = special.bounds.y;
    const sBottom = special.bounds.y + special.bounds.height;
    let bestCluster: LineCluster | null = null;
    let bestDist = Infinity;

    for (const cluster of lineClusters) {
      const dist = Math.abs(cluster.anchorY - special.coreY);
      const insideVerticalSpan = special.isMultiRow
        ? (cluster.anchorY >= sTop - scale * 0.25 && cluster.anchorY <= sBottom + scale * 0.25)
        : dist <= Math.max(scale * 0.95, special.bounds.height * 0.48);
      if (insideVerticalSpan && dist < bestDist) {
        bestDist = dist;
        bestCluster = cluster;
      }
    }
    if (bestCluster) {
      appendToCluster(bestCluster, special);
    } else {
      lineClusters.push({
        atoms: [special],
        anchorY: special.coreY,
        y0: sTop,
        y1: sBottom,
      });
    }
  }

  // If a fraction/matrix sits next to regular atoms whose line split slightly, absorb overlapping regular clusters into the special cluster only when strictly inline.
  lineClusters.sort((a, b) => a.anchorY - b.anchorY);

  // Post-split orphan merge pass: merge tiny narrow fragments (1-3 small strokes such as detached '0'/'1' limits) into adjacent line.
  const clusterBox = (cluster: LineCluster) => unionStrokeBounds(cluster.atoms.flatMap(a => a.members));
  let mergedOrphan = true;
  while (mergedOrphan && lineClusters.length > 1) {
    mergedOrphan = false;
    for (let i = 0; i < lineClusters.length; i += 1) {
      const candidate = lineClusters[i];
      const strokeCount = candidate.atoms.reduce((sum, atom) => sum + atom.members.length, 0);
      if (strokeCount > 3) continue;
      const box = clusterBox(candidate);
      if (box.width >= scale * 2.2) continue;

      let bestIdx = -1;
      let bestGap = Infinity;
      for (const adjIdx of [i - 1, i + 1]) {
        if (adjIdx < 0 || adjIdx >= lineClusters.length) continue;
        const adjBox = clusterBox(lineClusters[adjIdx]);
        if (adjBox.width <= 0 || box.width >= adjBox.width * 0.25) continue;
        const vGap = spanGap(box.y, box.y + box.height, adjBox.y, adjBox.y + adjBox.height);
        if (vGap <= adjBox.height * 0.75 && vGap < bestGap) {
          bestGap = vGap;
          bestIdx = adjIdx;
        }
      }
      if (bestIdx !== -1) {
        const target = lineClusters[bestIdx];
        for (const atom of candidate.atoms) appendToCluster(target, atom);
        lineClusters.splice(i, 1);
        lineClusters.sort((a, b) => a.anchorY - b.anchorY);
        mergedOrphan = true;
        break;
      }
    }
  }

  return lineClusters.map((cluster, idx) => {
    const orderedGeoms = cluster.atoms
      .flatMap(a => a.members)
      .sort((a, b) => a.x0 - b.x0 || a.index - b.index);
    const batchStrokes = orderedGeoms.map(g => structuredClone(g.stroke));
    const bounds = unionStrokeBounds(orderedGeoms);
    return {
      id: `math-line-${idx + 1}`,
      strokes: batchStrokes,
      bounds,
      coreY: cluster.anchorY,
      layerId: batchStrokes[0]?.layerId,
    };
  });
}

function stripOuterAlignedWrapper(latex: string): string {
  let trimmed = latex.trim();
  const beginMatch = /^\\begin\{aligned\}([\s\S]*)\\end\{aligned\}$/.exec(trimmed);
  if (beginMatch) trimmed = beginMatch[1].trim();
  const alignStar = /^\\begin\{align\*?\}([\s\S]*)\\end\{align\*?\}$/.exec(trimmed);
  if (alignStar) trimmed = alignStar[1].trim();
  return trimmed;
}

function insertAlignedAnchor(line: string): string {
  if (line.includes('&')) return line;
  const trimmed = line.trim();
  const leadingMatch = /^(=|\\leq|\\le|\\geq|\\ge|\\neq|\\approx|\\equiv|\\implies|\\Rightarrow|\\to)(?=\s|$|[^A-Za-z])/.exec(trimmed);
  if (leadingMatch) {
    return `& ${trimmed}`;
  }
  // Find first top-level relational operator (`=`, `\le`, `\ge`, `\neq`, `\approx`) outside braces.
  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && ch === '=') {
      return `${trimmed.slice(0, i).trimEnd()} &= ${trimmed.slice(i + 1).trimStart()}`;
    }
  }
  return trimmed;
}

/**
 * Cleanly join per-line LaTeX expressions into a single valid KaTeX display expression,
 * using `\begin{aligned} ... \end{aligned}` with `&` alignment on relational steps.
 */
export function assembleMultiLineMathLatex(lines: readonly string[]): string {
  const cleaned = lines
    .map(line => stripOuterAlignedWrapper(line))
    .map(line => line.trim())
    .filter(Boolean);
  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) return cleaned[0];

  const expanded: string[] = [];
  for (const line of cleaned) {
    if (line.includes('\\\\')) {
      for (const sub of line.split('\\\\')) {
        const s = sub.trim();
        if (s) expanded.push(s);
      }
    } else {
      expanded.push(line);
    }
  }
  if (expanded.length === 1) return expanded[0];

  const hasLeadingRelation = expanded.some(l => /^(=|\\le|\\leq|\\ge|\\geq|\\neq|\\approx|\\equiv|\\implies|\\Rightarrow)/.test(l));
  const equalCount = expanded.filter(l => l.includes('=')).length;
  const shouldAlign = hasLeadingRelation || equalCount >= 2;
  const formatted = shouldAlign ? expanded.map(insertAlignedAnchor) : expanded;
  return `\\begin{aligned}\n${formatted.join(' \\\\\n')}\n\\end{aligned}`;
}

/**
 * Normalize recognized plain text (e.g. from OS Windows Ink when ONNX model
 * is not yet downloaded) into clean KaTeX-compatible LaTeX without hallucinating.
 */
export function normalizeTextToMathLatex(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) return '';

  let latex = trimmed
    .replace(/\r\n/g, '\n')
    .replace(/[−–—]/g, '-')
    .replace(/[×✕]/g, '\\times ')
    .replace(/[÷]/g, '\\div ')
    .replace(/<=|<=/g, '\\le ')
    .replace(/>=|>=/g, '\\ge ')
    .replace(/!=/g, '\\neq ')
    .replace(/\+\-/g, '\\pm ')
    .replace(/±/g, '\\pm ')
    .replace(/->|→/g, '\\to ')
    .replace(/∞/g, '\\infty ')
    .replace(/≤/g, '\\le ')
    .replace(/≥/g, '\\ge ')
    .replace(/≠/g, '\\neq ')
    .replace(/≈/g, '\\approx ')
    .replace(/∫/g, '\\int ')
    .replace(/∑/g, '\\sum ')
    .replace(/√\(([^)]+)\)/g, '\\sqrt{$1}')
    .replace(/\bsqrt\(([^)]+)\)/gi, '\\sqrt{$1}')
    .replace(/\binfinity\b|\binfty\b/gi, '\\infty')
    .replace(/\bpi\b|π/g, '\\pi')
    .replace(/\balpha\b|α/g, '\\alpha')
    .replace(/\bbeta\b|β/g, '\\beta')
    .replace(/\bgamma\b|γ/g, '\\gamma')
    .replace(/\btheta\b|θ/g, '\\theta')
    .replace(/\blambda\b|λ/g, '\\lambda')
    .replace(/\bsigma\b|σ/g, '\\sigma')
    .replace(/\bdelta\b|δ/g, '\\delta')
    .replace(/\bomega\b|ω/g, '\\omega')
    .replace(/\b(sin|cos|tan|log|ln|lim)\b/g, '\\$1');

  // Avoid double backslashes if a keyword already had a prefix.
  latex = latex.replace(/\\\\(pi|alpha|beta|gamma|theta|lambda|sigma|delta|omega|infty|sin|cos|tan|log|ln|lim)/g, '\\$1');

  if (latex.includes('\n')) {
    const lines = latex
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (lines.length > 1) {
      return `\\begin{aligned}${lines.join(' \\\\ ')}\\end{aligned}`;
    }
    return lines[0] ?? '';
  }

  return latex.replace(/\s+/g, ' ').trim();
}

/**
 * Render handwritten ink strokes cleanly as a crisp black-on-white PNG for the
 * local TexTeller3 Vision-to-LaTeX ONNX model:
 * - Pure #FFFFFF background, solid #000000 ink
 * - 40px white padding, proportional stroke thickness, aspect-preserving scale (max 1024px)
 */
export async function rasterizeStrokesForMathOCR(strokes: readonly Stroke[]): Promise<Uint8Array | null> {
  const eligible = strokes.filter(isEligibleStroke);
  if (eligible.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const strokeHeights: number[] = [];

  for (const stroke of eligible) {
    let sMinY = Infinity;
    let sMaxY = -Infinity;
    for (const pt of stroke.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
      if (pt.y < sMinY) sMinY = pt.y;
      if (pt.y > sMaxY) sMaxY = pt.y;
    }
    if (Number.isFinite(sMinY)) strokeHeights.push(Math.max(8, sMaxY - sMinY));
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  strokeHeights.sort((a, b) => a - b);
  const medianH = strokeHeights[Math.floor(strokeHeights.length / 2)] || 42;
  const boxW = Math.max(8, maxX - minX);
  const boxH = Math.max(8, maxY - minY);
  // Preserve exact aspect ratio with pure white margins; normalize stroke width to ~3.6-4.0px in final 448x448 ViT space.
  const pad = Math.max(28, Math.round(Math.min(boxW, boxH) * 0.16));
  const maxDim = 1024;
  const rawW = boxW + pad * 2;
  const rawH = boxH + pad * 2;
  const scale = Math.min(2.5, maxDim / Math.max(rawW, rawH));
  const targetW = Math.max(64, Math.ceil(rawW * scale));
  const targetH = Math.max(64, Math.ceil(rawH * scale));
  const boxScaleTo420 = Math.min(2.0, 420 / Math.max(boxW, boxH));
  const targetFinalPx = boxW > boxH * 2.2 ? 4.0 : 3.6;
  const strokeWidthPage = Math.max(
    2.8,
    Math.min(11, Math.min(targetFinalPx / boxScaleTo420, Math.max(3.6, medianH * 0.16))),
  );

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const el = document.createElement('canvas');
    el.width = targetW;
    el.height = targetH;
    canvas = el;
    ctx = el.getContext('2d');
  } else if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(targetW, targetH);
    canvas = off;
    ctx = off.getContext('2d');
  } else {
    return null;
  }
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(pad - minX, pad - minY);
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#000000';
  ctx.lineWidth = strokeWidthPage;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of eligible) {
    const pts = stroke.points;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, strokeWidthPage * 0.55, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2) {
      ctx.lineTo(pts[1].x, pts[1].y);
    } else {
      for (let i = 1; i < pts.length - 1; i += 1) {
        const midX = (pts[i].x + pts[i + 1].x) * 0.5;
        const midY = (pts[i].y + pts[i + 1].y) * 0.5;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    }
    ctx.stroke();
  }
  ctx.restore();

  if ('convertToBlob' in canvas) {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }
  const blob = await new Promise<Blob | null>(resolve => {
    (canvas as HTMLCanvasElement).toBlob(b => resolve(b), 'image/png');
  });
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/**
 * Convert selected handwriting strokes into clean KaTeX-compatible LaTeX.
 * 1) In Electron with Local Math AI downloaded: runs quantized TexTeller3 ONNX via utilityProcess.
 * 2) Otherwise: queries the OS/browser text provider if available and normalizes math syntax,
 *    never emitting synthetic gibberish when offline/unrecognized.
 */
export async function recognizeHandwritingToMath(
  strokes: readonly Stroke[],
  options: MathRecognitionOptions = {},
): Promise<MathRecognitionResult> {
  const eligible = strokes.filter(isEligibleStroke);
  if (eligible.length === 0) {
    return {
      status: 'empty',
      latex: '',
      lineCount: 0,
      strokeCount: 0,
      symbolsCount: 0,
      warnings: [],
      engine: 'none',
      needsModelDownload: false,
    };
  }

  const lineBatches = segmentMathLines(eligible);
  const detectedLineCount = Math.max(1, lineBatches.length);
  const mathOcrBridge = typeof window !== 'undefined' ? window.panvas?.mathOcr : undefined;
  let electronNeedsDownload = false;

  if (mathOcrBridge) {
    try {
      const status = await mathOcrBridge.getStatus();
      if (status.ready) {
        const perLineLatex: string[] = [];
        for (let idx = 0; idx < lineBatches.length; idx += 1) {
          options.onProgress?.({ currentLine: idx + 1, totalLines: detectedLineCount });
          const pngBytes = await rasterizeStrokesForMathOCR(lineBatches[idx].strokes);
          if (!pngBytes) continue;
          const ocr = await mathOcrBridge.recognizeImage(pngBytes);
          const clean = ocr.latex.trim();
          if (clean) perLineLatex.push(clean);
        }
        const assembled = assembleMultiLineMathLatex(perLineLatex);
        if (assembled) {
          const warnings = perLineLatex.length < detectedLineCount
            ? [`Recognized ${perLineLatex.length} of ${detectedLineCount} lines — review and edit below.`]
            : [];
          return {
            status: 'success',
            latex: assembled,
            lineCount: detectedLineCount,
            strokeCount: eligible.length,
            symbolsCount: assembled.length,
            warnings,
            engine: 'onnx-texteller3',
            needsModelDownload: false,
          };
        }
      } else {
        electronNeedsDownload = true;
      }
    } catch (err) {
      console.warn('Local Math AI recognition error, falling back cleanly:', err);
    }
  }

  // Clean fallback: use OS Ink / provider per segmented line if available, without gibberish.
  if (options.provider) {
    try {
      const available = await options.provider.isAvailable();
      if (available) {
        const perLineLatex: string[] = [];
        for (let idx = 0; idx < lineBatches.length; idx += 1) {
          options.onProgress?.({ currentLine: idx + 1, totalLines: detectedLineCount });
          const res = await options.provider.recognize(lineBatches[idx].strokes.slice(0, 128), { language: options.language });
          const normalized = res.status === 'success' ? normalizeTextToMathLatex(res.text) : '';
          if (normalized) perLineLatex.push(normalized);
        }
        const assembled = assembleMultiLineMathLatex(perLineLatex);
        if (assembled) {
          return {
            status: 'success',
            latex: assembled,
            lineCount: detectedLineCount,
            strokeCount: eligible.length,
            symbolsCount: assembled.length,
            warnings: electronNeedsDownload
              ? ['Using OS handwriting fallback. Download Local Math AI below for full fractions, integrals & matrices.']
              : [],
            engine: 'provider-normalized',
            needsModelDownload: electronNeedsDownload,
          };
        }
      }
    } catch {
      // Fall through cleanly below
    }
  }

  return {
    status: 'needs-model',
    latex: '',
    lineCount: detectedLineCount,
    strokeCount: eligible.length,
    symbolsCount: 0,
    warnings: electronNeedsDownload
      ? ['Download Local Math AI (~317 MB, one-time, offline) for accurate handwriting-to-LaTeX recognition, or type LaTeX below.']
      : ['Enter or paste LaTeX below (full on-device Math OCR runs in the Panvas desktop app).'],
    engine: 'fallback',
    needsModelDownload: electronNeedsDownload,
  };
}
