import type { BoundingBox, Stroke, TextObject } from '../../components/notebook/engine/drawingTypes.ts';
import { generateId } from '../../lib/utils/id.ts';
import {
  createBeautifiedTextPlacement,
  createHandwritingTipTapContent,
  getHandwritingBounds,
  sanitizeHandwritingToolPreferences,
  type ExistingHandwritingLinePlacement,
  type HandwritingToolPreferences,
} from '../beautification/handwritingBeautification.ts';
import {
  createBulkHandwritingLinePlacements,
  formatHandwritingReviewText,
  segmentHandwritingStrokesIntoLines,
  type HandwritingLineBatch,
  type ReviewedHandwritingLine,
} from '../recognition/bulkConversion.ts';
import type {
  HandwritingRecognitionProvider,
  RecognitionOptions,
} from '../recognition/types.ts';

const MAX_RECOGNITION_CHUNK_STROKES = 120;
const UNAVAILABLE_RECOGNITION_ERROR = 'Handwriting recognition is unavailable on this device.';

export interface MultiLineRecognitionResult {
  lines: ReviewedHandwritingLine[];
  fullText: string;
  status: 'success' | 'empty' | 'unavailable' | 'error';
  providerId: string;
  strokeCount: number;
  isAvailable: boolean;
  error?: string;
}

function joinRecognizedChunks(parts: readonly string[]): string {
  let combined = '';
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    if (!combined) {
      combined = piece;
      continue;
    }
    const noLeadingSpace = /^[,.;:!?%)\]}]/.test(piece) || /[(\[{]$/.test(combined);
    combined += (noLeadingSpace ? '' : ' ') + piece;
  }
  return combined;
}

function splitLineIntoBoundedChunks(strokes: readonly Stroke[]): Stroke[][] {
  if (strokes.length <= MAX_RECOGNITION_CHUNK_STROKES) {
    return [strokes.map(stroke => structuredClone(stroke))];
  }
  const ordered = strokes
    .map((stroke, index) => ({
      stroke,
      index,
      minX: getHandwritingBounds([stroke])?.x ?? 0,
    }))
    .sort((left, right) => (
      left.minX - right.minX
      || left.stroke.createdAt - right.stroke.createdAt
      || left.index - right.index
    ));

  const chunks: Stroke[][] = [];
  for (let start = 0; start < ordered.length; start += MAX_RECOGNITION_CHUNK_STROKES) {
    chunks.push(
      ordered
        .slice(start, start + MAX_RECOGNITION_CHUNK_STROKES)
        .map(entry => structuredClone(entry.stroke)),
    );
  }
  return chunks;
}

async function safeIsAvailable(provider: HandwritingRecognitionProvider): Promise<boolean> {
  try {
    return await provider.isAvailable();
  } catch {
    return false;
  }
}

function buildUnavailableResult(
  providerId: string,
  batches: readonly HandwritingLineBatch[],
  strokeCount: number,
  options: RecognitionOptions,
  error = UNAVAILABLE_RECOGNITION_ERROR,
): MultiLineRecognitionResult {
  return {
    lines: batches.map(batch => ({
      ...batch,
      strokes: structuredClone(batch.strokes),
      text: '',
      candidates: [],
      status: 'unavailable',
      error,
      language: options.language,
    })),
    fullText: '',
    status: 'unavailable',
    providerId,
    strokeCount,
    isAvailable: false,
    error,
  };
}

/**
 * Segments selected ink into reading-order lines, chunks dense lines cleanly at
 * <= 120 strokes so no stroke is ever dropped past the IPC 128-stroke ceiling,
 * and formats multi-line text preserving paragraph breaks.
 */
export async function recognizeSelectedHandwritingMultiLine(
  provider: HandwritingRecognitionProvider,
  strokes: Stroke[],
  options: RecognitionOptions = {},
): Promise<MultiLineRecognitionResult> {
  const batches = segmentHandwritingStrokesIntoLines(strokes);
  const strokeCount = batches.reduce((sum, batch) => sum + batch.strokes.length, 0);
  const available = await safeIsAvailable(provider);

  if (batches.length === 0) {
    return {
      lines: [],
      fullText: '',
      status: 'empty',
      providerId: provider.id,
      strokeCount: 0,
      isAvailable: available,
    };
  }

  if (!available) {
    return buildUnavailableResult(provider.id, batches, strokeCount, options);
  }

  const reviewed: ReviewedHandwritingLine[] = [];
  for (const batch of batches) {
    const chunks = splitLineIntoBoundedChunks(batch.strokes);
    const chunkTexts: string[] = [];
    let singleChunkCandidates: string[] = [];
    let chunkError: string | undefined;
    let detectedLanguage = options.language;

    for (const chunk of chunks) {
      try {
        const result = await provider.recognize(chunk, options);
        if (result.status === 'unavailable') {
          return buildUnavailableResult(
            provider.id,
            batches,
            strokeCount,
            options,
            result.error || UNAVAILABLE_RECOGNITION_ERROR,
          );
        }
        if (result.language) detectedLanguage = result.language;
        if (result.status === 'success' && result.text.trim()) {
          const text = result.text.trim();
          chunkTexts.push(text);
          if (chunks.length === 1) {
            singleChunkCandidates = [text, ...(result.candidates ?? [])]
              .map(candidate => candidate.trim())
              .filter((candidate, index, values) => candidate.length > 0 && values.indexOf(candidate) === index);
          }
        } else if (result.status === 'error') {
          chunkError = chunkError ?? (result.error || 'Handwriting recognition failed for this line.');
        }
      } catch (error) {
        chunkError = chunkError ?? (error instanceof Error ? error.message : 'Handwriting recognition failed for this line.');
      }
    }

    const lineText = joinRecognizedChunks(chunkTexts);
    const candidates = chunks.length === 1
      ? singleChunkCandidates
      : lineText ? [lineText] : [];

    reviewed.push({
      ...batch,
      strokes: structuredClone(batch.strokes),
      text: lineText,
      candidates,
      status: lineText ? 'success' : chunkError ? 'error' : 'empty',
      error: lineText ? undefined : chunkError,
      language: detectedLanguage,
    });
  }

  const fullText = formatHandwritingReviewText(reviewed).replace(/^\n+|\n+$/g, '');
  const firstError = reviewed.find(line => line.status === 'error' && line.error)?.error;
  const status: MultiLineRecognitionResult['status'] = fullText.trim()
    ? 'success'
    : firstError
      ? 'error'
      : 'empty';

  return {
    lines: reviewed,
    fullText,
    status,
    providerId: provider.id,
    strokeCount,
    isAvailable: true,
    ...(firstError ? { error: firstError } : {}),
  };
}

function toExistingHandwritingPlacements(
  texts: readonly TextObject[],
  layerId: string | undefined,
): ExistingHandwritingLinePlacement[] {
  return texts.flatMap(text => {
    const metadata = text.metadata;
    const sourceBounds = metadata?.sourceBounds as Partial<BoundingBox> | undefined;
    const sourceBaseline = metadata?.sourceBaseline;
    const lineHeight = metadata?.handwritingLineHeight;
    if (
      metadata?.generatedFrom !== 'handwriting-recognition'
      || text.layerId !== layerId
      || !sourceBounds
      || !Number.isFinite(sourceBounds.x)
      || !Number.isFinite(sourceBounds.y)
      || !Number.isFinite(sourceBounds.width)
      || !Number.isFinite(sourceBounds.height)
      || !Number.isFinite(sourceBaseline)
      || !Number.isFinite(lineHeight)
    ) {
      return [];
    }
    return [{
      x: text.x,
      y: text.y,
      width: text.width,
      lineHeight: lineHeight as number,
      sourceBounds: sourceBounds as BoundingBox,
      sourceBaseline: sourceBaseline as number,
    }];
  });
}

function unionLineBounds(lines: readonly HandwritingLineBatch[]): BoundingBox | null {
  if (lines.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    minX = Math.min(minX, line.bounds.x);
    minY = Math.min(minY, line.bounds.y);
    maxX = Math.max(maxX, line.bounds.x + line.bounds.width);
    maxY = Math.max(maxY, line.bounds.y + line.bounds.height);
  }
  return Number.isFinite(minX)
    ? { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
    : null;
}

function medianNumber(values: readonly number[]): number {
  if (values.length === 0) return 24;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function measureLongestLineWidth(lines: readonly string[], fontFamily: string, fontSize: number): number {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context) {
      context.font = `${fontSize}px ${fontFamily}`;
      return Math.max(0, ...lines.map(line => context.measureText(line || ' ').width));
    }
  }
  return Math.max(0, ...lines.map(line => line.length * fontSize * 0.56));
}

function normalizeEditedLines(editedText: string): string[] {
  const split = editedText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+$/g, ''));
  while (split.length > 0 && split[split.length - 1].trim() === '') {
    split.pop();
  }
  while (split.length > 0 && split[0].trim() === '') {
    split.shift();
  }
  return split;
}

/**
 * Converts user-edited multi-line text back into positioned TipTap TextObjects.
 * Preserves per-line baseline placement when line counts match, or emits a
 * single multi-paragraph TextObject over the union selection bounds when the
 * user merged, split, or added lines.
 */
export function buildEditedTextPlacements(
  editedText: string,
  originalLines: HandwritingLineBatch[],
  preferences: HandwritingToolPreferences,
  existingLinesForLayer: TextObject[],
): TextObject[] {
  if (originalLines.length === 0) return [];
  const lines = normalizeEditedLines(editedText);
  const nonEmptyLines = lines.filter(line => line.trim().length > 0);
  if (nonEmptyLines.length === 0) return [];

  const sanitizedPreferences = sanitizeHandwritingToolPreferences(preferences);
  const conversionId = generateId('handwriting-bulk');
  const createdAt = Date.now();

  if (nonEmptyLines.length === originalLines.length) {
    const reviewed: ReviewedHandwritingLine[] = originalLines.map((batch, index) => ({
      ...batch,
      strokes: structuredClone(batch.strokes),
      text: nonEmptyLines[index].trim(),
      candidates: [nonEmptyLines[index].trim()],
      status: 'success',
      language: sanitizedPreferences.language || undefined,
    }));

    const placements = createBulkHandwritingLinePlacements(
      reviewed,
      sanitizedPreferences,
      line => toExistingHandwritingPlacements(existingLinesForLayer, line.layerId),
    );

    return placements.map(({ line, placement }, lineIndex) => ({
      id: generateId('txt'),
      type: 'text',
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      content: createHandwritingTipTapContent(line.text, {
        fontFamily: sanitizedPreferences.fontFamily,
        fontSize: placement.fontSize,
        color: sanitizedPreferences.color,
      }),
      createdAt: createdAt + lineIndex,
      layerId: line.layerId,
      metadata: {
        generatedFrom: 'handwriting-recognition',
        recognitionLanguage: sanitizedPreferences.language || undefined,
        recognitionBatchId: `${conversionId}-line-${lineIndex + 1}`,
        handwritingLineId: `${conversionId}-line-${lineIndex + 1}`,
        bulkConversionId: conversionId,
        bulkLineIndex: lineIndex,
        bulkLineCount: placements.length,
        blankLinesBefore: line.blankLinesBefore,
        sourceStrokeIds: line.strokes.map(stroke => stroke.id),
        sourceBounds: structuredClone(line.bounds),
        sourceBaseline: placement.baseline,
        sourceLineHeight: line.bounds.height,
        sourceLeftX: line.bounds.x,
        sourceRightX: line.bounds.x + line.bounds.width,
        handwritingLineHeight: placement.lineHeight,
        handwritingFontSize: placement.fontSize,
        autoConverted: false,
      },
    }));
  }

  const unionBounds = unionLineBounds(originalLines);
  if (!unionBounds) return [];

  const representativeHeight = Math.max(12, medianNumber(originalLines.map(line => line.bounds.height)));
  const medianLine = originalLines.find(line => line.bounds.height === representativeHeight) ?? originalLines[0];
  const samplePlacement = createBeautifiedTextPlacement(
    nonEmptyLines[0],
    medianLine.strokes,
    sanitizedPreferences,
  );
  const fontSize = sanitizedPreferences.fontSize === 'auto'
    ? (samplePlacement?.fontSize ?? 24)
    : sanitizedPreferences.fontSize;
  const lineHeight = Math.ceil(fontSize * 1.2);
  const measuredWidth = measureLongestLineWidth(lines, sanitizedPreferences.fontFamily, fontSize);
  const joinedText = lines.join('\n');

  const sourceStrokeIds: string[] = [];
  const seenStrokeIds = new Set<string>();
  for (const line of originalLines) {
    for (const stroke of line.strokes) {
      if (!seenStrokeIds.has(stroke.id)) {
        seenStrokeIds.add(stroke.id);
        sourceStrokeIds.push(stroke.id);
      }
    }
  }

  return [{
    id: generateId('txt'),
    type: 'text',
    x: unionBounds.x,
    y: unionBounds.y,
    width: Math.max(220, Math.ceil(unionBounds.width + 24), Math.ceil(measuredWidth + 24)),
    height: Math.max(72, Math.ceil(unionBounds.height), Math.ceil(lines.length * lineHeight + 16)),
    content: createHandwritingTipTapContent(joinedText, {
      fontFamily: sanitizedPreferences.fontFamily,
      fontSize,
      color: sanitizedPreferences.color,
    }),
    createdAt,
    layerId: originalLines[0]?.layerId,
    metadata: {
      generatedFrom: 'handwriting-recognition',
      recognitionLanguage: sanitizedPreferences.language || undefined,
      recognitionBatchId: conversionId,
      handwritingLineId: conversionId,
      bulkConversionId: conversionId,
      bulkLineIndex: 0,
      bulkLineCount: 1,
      sourceStrokeIds,
      sourceBounds: unionBounds,
      sourceBaseline: unionBounds.y + Math.min(unionBounds.height, representativeHeight) * 0.82,
      sourceLineHeight: representativeHeight,
      sourceLeftX: unionBounds.x,
      sourceRightX: unionBounds.x + unionBounds.width,
      handwritingLineHeight: lineHeight,
      handwritingFontSize: fontSize,
      autoConverted: false,
    },
  }];
}
