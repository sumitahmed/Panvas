import type { BoundingBox, Stroke } from '../../components/notebook/engine/drawingTypes.ts';
import {
  createBeautifiedTextPlacement,
  getHandwritingBounds,
  resolveHandwritingLinePlacement,
  type BeautifiedTextPlacement,
  type ExistingHandwritingLinePlacement,
  type HandwritingToolPreferences,
} from '../beautification/handwritingBeautification.ts';
import type {
  HandwritingRecognitionProvider,
  RecognitionOptions,
  RecognitionStatus,
} from './types.ts';

export interface HandwritingLineBatch {
  id: string;
  strokes: Stroke[];
  bounds: BoundingBox;
  baseline: number;
  blankLinesBefore: number;
  layerId?: string;
}

export interface ReviewedHandwritingLine extends HandwritingLineBatch {
  text: string;
  candidates: string[];
  status: RecognitionStatus;
  error?: string;
  language?: string;
}

export interface PlacedHandwritingLine {
  line: ReviewedHandwritingLine;
  placement: BeautifiedTextPlacement;
}

interface StrokeGeometry {
  stroke: Stroke;
  originalIndex: number;
  bounds: BoundingBox;
  centerY: number;
  baseline: number;
}

function quantile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))];
}

function verticalOverlap(left: BoundingBox, right: BoundingBox): number {
  return Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
}

function axisGap(leftStart: number, leftSize: number, rightStart: number, rightSize: number): number {
  return Math.max(0, Math.max(leftStart, rightStart) - Math.min(leftStart + leftSize, rightStart + rightSize));
}

function samePhysicalLine(left: StrokeGeometry, right: StrokeGeometry, typicalHeight: number): boolean {
  if ((left.stroke.layerId ?? '') !== (right.stroke.layerId ?? '')) return false;
  const minimumHeight = Math.max(1, Math.min(left.bounds.height, right.bounds.height));
  const overlapRatio = verticalOverlap(left.bounds, right.bounds) / minimumHeight;
  const scale = Math.max(
    1,
    typicalHeight,
    Math.min(Math.max(left.bounds.height, right.bounds.height), typicalHeight * 1.5),
  );
  const centerDistance = Math.abs(left.centerY - right.centerY);
  const baselineDistance = Math.abs(left.baseline - right.baseline);
  return centerDistance <= scale * 0.62
    || baselineDistance <= scale * 0.58
    || (overlapRatio >= 0.45 && centerDistance <= scale);
}

export function isEligibleHandwritingStroke(stroke: Stroke): boolean {
  return (stroke.tool === 'pen' || stroke.tool === 'pencil') && stroke.points.length >= 2;
}

/** Returns only exact selected, editable Pen/Pencil strokes in canonical drawing order. */
export function getEligibleSelectedHandwritingStrokes(
  strokes: readonly Stroke[],
  selectedIds: ReadonlySet<string>,
  isEditable: (stroke: Stroke) => boolean = () => true,
): Stroke[] {
  return strokes
    .filter(stroke => selectedIds.has(stroke.id) && isEligibleHandwritingStroke(stroke) && isEditable(stroke))
    .map(stroke => structuredClone(stroke));
}

/**
 * Segments arbitrary selected ink using page-coordinate geometry only. Pairwise
 * vertical affinity keeps letters, dots, and crossbars together while separate
 * baselines become independent ordered recognition batches.
 */
export function segmentHandwritingStrokesIntoLines(strokes: readonly Stroke[]): HandwritingLineBatch[] {
  const seen = new Set<string>();
  const geometries = strokes.flatMap((source, originalIndex) => {
    if (seen.has(source.id) || !isEligibleHandwritingStroke(source)) return [];
    seen.add(source.id);
    const stroke = structuredClone(source);
    const bounds = getHandwritingBounds([stroke]);
    if (!bounds) return [];
    return [{
      stroke,
      originalIndex,
      bounds,
      centerY: bounds.y + bounds.height / 2,
      baseline: bounds.y + bounds.height * 0.82,
    } satisfies StrokeGeometry];
  });
  if (geometries.length === 0) return [];

  const typicalHeight = Math.max(1, quantile(geometries.map(item => Math.max(1, item.bounds.height)), 0.7));
  const parents = geometries.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  const minorStrokeIndexes = new Set(geometries.flatMap((geometry, index) => (
    geometry.bounds.height <= typicalHeight * 0.38 && geometry.bounds.width <= typicalHeight * 1.35
      ? [index]
      : []
  )));
  const mainStrokeIndexes = geometries.flatMap((_, index) => minorStrokeIndexes.has(index) ? [] : [index]);

  // First establish baselines from substantial letter strokes. Tiny dots and
  // crossbars are attached afterwards so one mark cannot bridge two lines.
  const baselineIndexes = mainStrokeIndexes.length > 0
    ? mainStrokeIndexes
    : geometries.map((_, index) => index);
  for (let leftOffset = 0; leftOffset < baselineIndexes.length; leftOffset += 1) {
    for (let rightOffset = leftOffset + 1; rightOffset < baselineIndexes.length; rightOffset += 1) {
      const left = baselineIndexes[leftOffset];
      const right = baselineIndexes[rightOffset];
      if (samePhysicalLine(geometries[left], geometries[right], typicalHeight)) union(left, right);
    }
  }

  if (mainStrokeIndexes.length > 0) {
    for (const minorIndex of minorStrokeIndexes) {
      const minor = geometries[minorIndex];
      const nearest = mainStrokeIndexes
        .flatMap(mainIndex => {
          const main = geometries[mainIndex];
          if ((minor.stroke.layerId ?? '') !== (main.stroke.layerId ?? '')) return [];
          const horizontalGap = axisGap(minor.bounds.x, minor.bounds.width, main.bounds.x, main.bounds.width);
          const verticalGap = axisGap(minor.bounds.y, minor.bounds.height, main.bounds.y, main.bounds.height);
          if (horizontalGap > typicalHeight * 1.5 || verticalGap > typicalHeight * 1.3) return [];
          return [{ mainIndex, score: verticalGap + horizontalGap * 0.7 + Math.abs(minor.centerY - main.centerY) * 0.08 }];
        })
        .sort((left, right) => left.score - right.score)[0];
      if (nearest) union(minorIndex, nearest.mainIndex);
    }
  }

  const components = new Map<number, StrokeGeometry[]>();
  geometries.forEach((geometry, index) => {
    const root = find(index);
    const component = components.get(root) ?? [];
    component.push(geometry);
    components.set(root, component);
  });

  const lines = [...components.values()].flatMap((component, componentIndex) => {
    const ordered = [...component].sort((left, right) => {
      const horizontalDistance = left.bounds.x - right.bounds.x;
      if (Math.abs(horizontalDistance) > typicalHeight * 0.18) return horizontalDistance;
      return left.originalIndex - right.originalIndex;
    });
    const lineStrokes = ordered.map(item => structuredClone(item.stroke));
    const bounds = getHandwritingBounds(lineStrokes);
    if (!bounds) return [];
    return [{
      id: `handwriting-line-${componentIndex + 1}`,
      strokes: lineStrokes,
      bounds,
      baseline: quantile(component.map(item => item.baseline), 0.75),
      blankLinesBefore: 0,
      layerId: lineStrokes[0]?.layerId,
    } satisfies HandwritingLineBatch];
  }).sort((left, right) => left.baseline - right.baseline || left.bounds.x - right.bounds.x);

  const baselineDeltas = lines.slice(1)
    .map((line, index) => line.baseline - lines[index].baseline)
    .filter(delta => delta > 0 && delta <= typicalHeight * 2.2);
  const expectedPitch = Math.max(typicalHeight * 1.35, quantile(baselineDeltas, 0.5));
  return lines.map((line, index) => {
    if (index === 0) return { ...line, id: 'handwriting-line-1' };
    const baselineDelta = line.baseline - lines[index - 1].baseline;
    const blankLinesBefore = baselineDelta >= expectedPitch * 1.65
      ? Math.min(6, Math.max(1, Math.round(baselineDelta / expectedPitch) - 1))
      : 0;
    return { ...line, id: `handwriting-line-${index + 1}`, blankLinesBefore };
  });
}

/** Recognizes line batches serially through the existing production provider. */
export async function recognizeHandwritingLines(
  provider: HandwritingRecognitionProvider,
  lines: readonly HandwritingLineBatch[],
  options: RecognitionOptions = {},
): Promise<ReviewedHandwritingLine[]> {
  const reviewed: ReviewedHandwritingLine[] = [];
  for (const line of lines) {
    try {
      const result = await provider.recognize(structuredClone(line.strokes), options);
      const text = result.status === 'success' ? result.text.trim() : '';
      const candidates = [text, ...(result.candidates ?? [])]
        .map(candidate => candidate.trim())
        .filter((candidate, index, values) => candidate.length > 0 && values.indexOf(candidate) === index);
      reviewed.push({
        ...line,
        strokes: structuredClone(line.strokes),
        text,
        candidates,
        status: text ? 'success' : result.status === 'success' ? 'empty' : result.status,
        error: result.error,
        language: result.language ?? options.language,
      });
    } catch (error) {
      reviewed.push({
        ...line,
        strokes: structuredClone(line.strokes),
        text: '',
        candidates: [],
        status: 'error',
        error: error instanceof Error ? error.message : 'Handwriting recognition failed for this line.',
        language: options.language,
      });
    }
  }
  return reviewed;
}

export function formatHandwritingReviewText(lines: readonly Pick<ReviewedHandwritingLine, 'text' | 'blankLinesBefore'>[]): string {
  return lines.map((line, index) => (
    `${index === 0 ? '' : '\n'}${'\n'.repeat(line.blankLinesBefore)}${line.text}`
  )).join('');
}

/** Places reviewed H2T lines at their source geometry, including close or indented lines. */
export function createBulkHandwritingLinePlacements(
  lines: readonly ReviewedHandwritingLine[],
  preferences: HandwritingToolPreferences,
  existingLinesForLayer: (line: ReviewedHandwritingLine) => readonly ExistingHandwritingLinePlacement[] = () => [],
): PlacedHandwritingLine[] {
  const generatedByLayer = new Map<string, ExistingHandwritingLinePlacement[]>();
  return lines.flatMap(line => {
    if (!line.text.trim()) return [];
    const initial = createBeautifiedTextPlacement(line.text, line.strokes, preferences);
    if (!initial) return [];
    const layerKey = line.layerId ?? '';
    const generated = generatedByLayer.get(layerKey) ?? [];
    const placement = resolveHandwritingLinePlacement(initial, [
      ...existingLinesForLayer(line),
      ...generated,
    ], { preserveSource: true });
    generated.push({
      x: placement.x,
      y: placement.y,
      width: placement.width,
      lineHeight: placement.lineHeight,
      sourceBounds: placement.bounds,
      sourceBaseline: placement.baseline,
    });
    generatedByLayer.set(layerKey, generated);
    return [{ line, placement }];
  });
}
