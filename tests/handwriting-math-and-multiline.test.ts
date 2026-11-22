import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { createEmptyDrawingData, type Stroke, type TextObject } from '../src/components/notebook/engine/drawingTypes.ts';
import {
  DEFAULT_HANDWRITING_TOOL_PREFERENCES,
} from '../src/services/beautification/handwritingBeautification.ts';
import {
  segmentHandwritingStrokesIntoLines,
} from '../src/services/recognition/bulkConversion.ts';
import {
  sanitizeRecognitionStrokes,
  type HandwritingRecognitionProvider,
  type RecognitionOptions,
  type RecognitionResult,
} from '../src/services/recognition/types.ts';
import {
  buildEditedTextPlacements,
  recognizeSelectedHandwritingMultiLine,
} from '../src/services/handwriting/multiLineOrdering.ts';
import {
  createMathTipTapContent,
  extractLatexFromTipTapContent,
  normalizeTextToMathLatex,
  recognizeHandwritingToMath,
} from '../src/services/handwriting/mathRecognizer.ts';
import { exportNotebookPdf } from '../src/services/pdf/notebookPdfExport.ts';

let nextId = 0;

function makeStroke(
  points: Array<[number, number]>,
  overrides: Partial<Stroke> = {},
): Stroke {
  nextId += 1;
  return {
    id: overrides.id ?? `stroke-${nextId}`,
    type: 'stroke',
    tool: overrides.tool ?? 'pen',
    color: overrides.color ?? '#1f2937',
    thickness: overrides.thickness ?? 2.4,
    opacity: overrides.opacity ?? 1,
    createdAt: overrides.createdAt ?? nextId * 100,
    layerId: overrides.layerId ?? 'layer-default',
    points: points.map(([x, y], index) => ({
      x,
      y,
      pressure: 0.55,
      t: index * 12,
    })),
  };
}

function samplePolyline(waypoints: Array<[number, number]>, stepSize = 3): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 1; i < waypoints.length; i += 1) {
    const [x1, y1] = waypoints[i - 1];
    const [x2, y2] = waypoints[i];
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(2, Math.ceil(dist / stepSize));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    }
  }
  out.push(waypoints[waypoints.length - 1]);
  return out;
}

function boxPoints(
  normPts: Array<[number, number]>,
  x: number,
  y: number,
  w: number,
  h: number,
): Array<[number, number]> {
  return samplePolyline(normPts.map(([nx, ny]) => [x + nx * w, y + ny * h]));
}

function glyphStrokes(glyph: string, x: number, y: number, w = 28, h = 44): Stroke[] {
  switch (glyph) {
    case '0': {
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= 24; i += 1) {
        const a = (i / 24) * Math.PI * 2;
        pts.push([x + w / 2 + (w / 2) * Math.cos(a), y + h / 2 + (h / 2) * Math.sin(a)]);
      }
      return [makeStroke(pts)];
    }
    case '1':
      return [makeStroke(boxPoints([[0.22, 0.2], [0.5, 0.0], [0.5, 1.0]], x, y, w, h))];
    case '2':
      return [makeStroke(boxPoints([[0.15, 0.22], [0.45, 0.02], [0.85, 0.14], [0.88, 0.38], [0.45, 0.68], [0.05, 0.96], [0.95, 0.96]], x, y, w, h))];
    case '3':
      return [makeStroke(boxPoints([[0.15, 0.12], [0.65, 0.0], [0.92, 0.2], [0.45, 0.48], [0.95, 0.68], [0.65, 0.98], [0.1, 0.88]], x, y, w, h))];
    case '4':
      return [
        makeStroke(boxPoints([[0.15, 0.05], [0.15, 0.65], [0.95, 0.65]], x, y, w, h)),
        makeStroke(boxPoints([[0.72, 0.05], [0.72, 0.98]], x, y, w, h)),
      ];
    case '7':
      return [makeStroke(boxPoints([[0.05, 0.05], [0.95, 0.05], [0.58, 0.52], [0.28, 0.98]], x, y, w, h))];
    case 'a':
      return [makeStroke(boxPoints([[0.78, 0.25], [0.42, 0.04], [0.08, 0.35], [0.12, 0.82], [0.5, 0.96], [0.8, 0.45], [0.84, 0.88], [0.96, 0.95]], x, y, w, h))];
    case 'b':
      return [makeStroke(boxPoints([[0.12, 0.04], [0.12, 0.96], [0.55, 0.96], [0.92, 0.75], [0.78, 0.48], [0.32, 0.52], [0.12, 0.72]], x, y, w, h))];
    case 'i':
      return [
        makeStroke(boxPoints([[0.5, 0.32], [0.5, 1.0]], x, y, w, h)),
        makeStroke([[x + w * 0.46, y + h * 0.06], [x + w * 0.54, y + h * 0.09]]),
      ];
    case 'n':
      return [makeStroke(boxPoints([[0.08, 0.96], [0.08, 0.12], [0.35, 0.04], [0.78, 0.18], [0.92, 0.58], [0.92, 0.96]], x, y, w, h))];
    case 'x':
      return [
        makeStroke(boxPoints([[0.05, 0.05], [0.95, 0.95]], x, y, w, h)),
        makeStroke(boxPoints([[0.95, 0.05], [0.05, 0.95]], x, y, w, h)),
      ];
    case '+':
      return [
        makeStroke(boxPoints([[0.5, 0.05], [0.5, 0.95]], x, y, w, h)),
        makeStroke(boxPoints([[0.05, 0.5], [0.95, 0.5]], x, y, w, h)),
      ];
    case '-':
      return [makeStroke([[x, y + h / 2], [x + w, y + h / 2]])];
    case '=':
      return [
        makeStroke([[x, y + h * 0.35], [x + w, y + h * 0.35]]),
        makeStroke([[x, y + h * 0.65], [x + w, y + h * 0.65]]),
      ];
    case '(':
      return [makeStroke(boxPoints([[0.85, 0.02], [0.32, 0.25], [0.15, 0.5], [0.32, 0.75], [0.85, 0.98]], x, y, w, h))];
    case ')':
      return [makeStroke(boxPoints([[0.15, 0.02], [0.68, 0.25], [0.85, 0.5], [0.68, 0.75], [0.15, 0.98]], x, y, w, h))];
    case '\\pi':
      return [
        makeStroke([[x, y + 4], [x + w, y + 4]]),
        makeStroke([[x + w * 0.28, y + 6], [x + w * 0.28, y + h]]),
        makeStroke([[x + w * 0.72, y + 6], [x + w * 0.72, y + h]]),
      ];
    case '\\infty': {
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= 36; i += 1) {
        const t = (i / 36) * Math.PI * 2;
        pts.push([x + w / 2 + (w / 2) * Math.sin(t), y + h / 2 + (h / 2) * Math.sin(2 * t)]);
      }
      return [makeStroke(pts)];
    }
    case '\\int':
      return [makeStroke(boxPoints([[0.9, 0.08], [0.66, 0.0], [0.54, 0.14], [0.5, 0.5], [0.46, 0.86], [0.34, 1.0], [0.1, 0.92]], x, y, w, h))];
    case '\\sum':
      return [makeStroke(boxPoints([[0.95, 0.05], [0.08, 0.05], [0.62, 0.5], [0.08, 0.95], [0.95, 0.95]], x, y, w, h))];
    case '\\sqrt':
      return [makeStroke(boxPoints([[0.0, 0.52], [0.14, 0.98], [0.28, 0.05], [1.0, 0.05]], x, y, w, h))];
    case '\\neq':
      return [
        makeStroke([[x, y + h * 0.35], [x + w, y + h * 0.35]]),
        makeStroke([[x, y + h * 0.65], [x + w, y + h * 0.65]]),
        makeStroke([[x + w * 0.85, y + h * 0.05], [x + w * 0.15, y + h * 0.95]]),
      ];
    case '\\pm':
      return [
        makeStroke([[x + w * 0.5, y + h * 0.08], [x + w * 0.5, y + h * 0.66]]),
        makeStroke([[x + w * 0.12, y + h * 0.37], [x + w * 0.88, y + h * 0.37]]),
        makeStroke([[x + w * 0.12, y + h * 0.84], [x + w * 0.88, y + h * 0.84]]),
      ];
    case '\\le':
      return [
        makeStroke(boxPoints([[0.88, 0.08], [0.12, 0.42], [0.88, 0.74]], x, y, w, h)),
        makeStroke([[x + w * 0.12, y + h * 0.9], [x + w * 0.88, y + h * 0.9]]),
      ];
    case '\\div':
      return [
        makeStroke([[x, y + h * 0.5], [x + w, y + h * 0.5]]),
        makeStroke([[x + w * 0.46, y + h * 0.18], [x + w * 0.54, y + h * 0.21]]),
        makeStroke([[x + w * 0.46, y + h * 0.79], [x + w * 0.54, y + h * 0.82]]),
      ];
    default:
      throw new Error(`Unknown synthetic glyph: ${glyph}`);
  }
}

test('multi-line recognition orders lines top-to-bottom, preserves paragraph gaps, and chunks >128 strokes safely', async () => {
  const denseLineStrokes: Stroke[] = Array.from({ length: 260 }, (_, index) => (
    makeStroke([[20 + index * 10, 40], [26 + index * 10, 76]], { id: `dense-${260 - index}`, createdAt: index })
  ));
  const secondParagraphStrokes: Stroke[] = [
    makeStroke([[20, 190], [60, 226]], { id: 'para2-a' }),
    makeStroke([[75, 190], [115, 226]], { id: 'para2-b' }),
  ];

  const chunkSizes: number[] = [];
  const firstBatchMinXs: number[] = [];
  const provider: HandwritingRecognitionProvider = {
    id: 'mock-multiline',
    name: 'Mock Multiline',
    isOffline: true,
    async isAvailable() { return true; },
    async recognize(strokes: Stroke[], _options?: RecognitionOptions): Promise<RecognitionResult> {
      sanitizeRecognitionStrokes(strokes); // Must never exceed 128 strokes
      chunkSizes.push(strokes.length);
      if (strokes[0]?.id.startsWith('dense-')) {
        firstBatchMinXs.push(Math.min(...strokes[0].points.map(p => p.x)));
        return {
          status: 'success',
          text: chunkSizes.length === 1 ? 'First dense' : chunkSizes.length === 2 ? 'line segment' : 'complete.',
          isAvailable: true,
        };
      }
      return { status: 'success', text: 'Second paragraph', isAvailable: true };
    },
  };

  const result = await recognizeSelectedHandwritingMultiLine(provider, [
    ...secondParagraphStrokes,
    ...denseLineStrokes,
  ]);

  assert.equal(result.status, 'success');
  assert.equal(result.isAvailable, true);
  assert.equal(result.strokeCount, 262);
  assert.equal(result.lines.length, 2);
  assert.deepEqual(chunkSizes, [120, 120, 20, 2]);
  assert.ok(firstBatchMinXs[0] < firstBatchMinXs[1] && firstBatchMinXs[1] < firstBatchMinXs[2]);
  assert.equal(result.lines[0].text, 'First dense line segment complete.');
  assert.equal(result.lines[1].text, 'Second paragraph');
  assert.ok(result.lines[1].blankLinesBefore >= 1);
  assert.equal(result.fullText, `First dense line segment complete.${'\n'.repeat(1 + result.lines[1].blankLinesBefore)}Second paragraph`);
});

test('multi-line recognition refuses to fabricate text when provider is unavailable', async () => {
  const strokes = [
    makeStroke([[20, 20], [50, 55]]),
    makeStroke([[70, 20], [100, 55]]),
  ];
  const unavailableProvider: HandwritingRecognitionProvider = {
    id: 'windows-ink',
    name: 'Windows Ink',
    isOffline: true,
    async isAvailable() { return true; },
    async recognize(): Promise<RecognitionResult> {
      return {
        status: 'unavailable',
        text: '',
        isAvailable: false,
        error: 'Windows handwriting language component is unavailable.',
      };
    },
  };

  const result = await recognizeSelectedHandwritingMultiLine(unavailableProvider, strokes);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.isAvailable, false);
  assert.equal(result.fullText, '');
  assert.match(result.error ?? '', /unavailable/i);
});

test('buildEditedTextPlacements aligns same-count lines or creates one multi-paragraph TextObject when edited line counts change', () => {
  const strokes = [
    makeStroke([[30, 40], [140, 72]], { id: 'l1' }),
    makeStroke([[30, 110], [180, 142]], { id: 'l2' }),
  ];
  const originalLines = segmentHandwritingStrokesIntoLines(strokes);
  assert.equal(originalLines.length, 2);

  // Case 1: same non-empty line count (CRLF + trailing whitespace normalized)
  const sameCountPlacements = buildEditedTextPlacements(
    'Edited line one\r\nEdited line two\r\n   \r\n',
    originalLines,
    DEFAULT_HANDWRITING_TOOL_PREFERENCES,
    [],
  );
  assert.equal(sameCountPlacements.length, 2);
  assert.equal(sameCountPlacements[0].content.content[0].content[0].text, 'Edited line one');
  assert.equal(sameCountPlacements[1].content.content[0].content[0].text, 'Edited line two');
  assert.ok(sameCountPlacements[1].y > sameCountPlacements[0].y);
  assert.equal(sameCountPlacements[0].metadata?.generatedFrom, 'handwriting-recognition');

  // Case 2: user added a line & internal blank paragraph -> 1 unified multi-paragraph TextObject
  const existing: TextObject[] = [];
  const mergedPlacements = buildEditedTextPlacements(
    'First line\r\n\r\nSecond added line\r\nThird added line\r\n',
    originalLines,
    DEFAULT_HANDWRITING_TOOL_PREFERENCES,
    existing,
  );
  assert.equal(mergedPlacements.length, 1);
  const unified = mergedPlacements[0];
  assert.equal(unified.x, 30);
  assert.equal(unified.y, 40);
  assert.ok(unified.width >= 220);
  assert.equal(unified.content.type, 'doc');
  assert.equal(unified.content.content.length, 4);
  assert.equal(unified.content.content[0].content[0].text, 'First line');
  assert.deepEqual(unified.content.content[1].content, []);
  assert.equal(unified.content.content[2].content[0].text, 'Second added line');
  assert.equal(unified.content.content[3].content[0].text, 'Third added line');
  assert.deepEqual(unified.metadata?.sourceStrokeIds, ['l1', 'l2']);
});

test('math recognizer handles empty selection and TipTap math round-trip helpers', async () => {
  const empty = await recognizeHandwritingToMath([]);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.latex, '');

  const blockDoc = createMathTipTapContent('\\frac{x+1}{2}');
  assert.equal(blockDoc.type, 'doc');
  assert.equal(blockDoc.content?.[0].type, 'blockMath');
  assert.equal(extractLatexFromTipTapContent(blockDoc), '\\frac{x+1}{2}');

  const inlineDoc = createMathTipTapContent('x_{i}^{2}', { displayMode: false });
  assert.equal(inlineDoc.content?.[0].type, 'paragraph');
  assert.equal(inlineDoc.content?.[0].content?.[0].type, 'inlineMath');
  assert.equal(extractLatexFromTipTapContent(inlineDoc), 'x_{i}^{2}');
  assert.equal(extractLatexFromTipTapContent({ type: 'doc', content: [{ type: 'paragraph' }] }), null);
});

test('math recognizer normalizes offline provider fallback cleanly and emits zero gibberish when ONNX is unavailable', async () => {
  const noProvider = await recognizeHandwritingToMath(glyphStrokes('x', 30, 20, 26, 36));
  assert.equal(noProvider.status, 'needs-model');
  assert.equal(noProvider.latex, '');
  assert.equal(noProvider.engine, 'fallback');

  const provider: HandwritingRecognitionProvider = {
    id: 'mock-os-ink',
    name: 'Mock OS Ink',
    isOffline: true,
    async isAvailable() { return true; },
    async recognize(): Promise<RecognitionResult> {
      return { status: 'success', text: 'x + 5 + 4 + 3 = 9', isAvailable: true };
    },
  };
  const fallbackOk = await recognizeHandwritingToMath([
    ...glyphStrokes('x', 20, 20, 24, 34),
    ...glyphStrokes('+', 52, 22, 20, 24),
  ], { provider });
  assert.equal(fallbackOk.status, 'success');
  assert.equal(fallbackOk.engine, 'provider-normalized');
  assert.equal(fallbackOk.latex, 'x + 5 + 4 + 3 = 9');
  assert.equal(normalizeTextToMathLatex('x <= infinity != 0'), 'x \\le \\infty \\neq 0');
});

test('freeform PDF export preserves blockMath, inlineMath, and non-WinAnsi symbols visibly without throwing', async () => {
  const drawing = createEmptyDrawingData();
  drawing.objects = [
    {
      id: 'math-block',
      type: 'text',
      x: 60,
      y: 80,
      width: 300,
      height: 80,
      createdAt: 1,
      content: createMathTipTapContent('\\frac{x+1}{2}+\\pi\\le\\infty'),
    },
    {
      id: 'math-inline',
      type: 'text',
      x: 60,
      y: 190,
      width: 360,
      height: 80,
      createdAt: 2,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Result ' },
              { type: 'inlineMath', attrs: { latex: '\\sqrt{x^{2}+1}' } },
              { type: 'text', text: ' ≈ 3.14' },
            ],
          },
        ],
      },
    },
  ];

  const result = await exportNotebookPdf({
    pages: [{ id: 'p1', title: 'Math Page', properties: drawing.properties, drawing }],
  });

  assert.equal(result.success, true, result.error);
  assert.equal(result.exportedObjects, 2);
  assert.ok(result.warnings.some(w => w.code === 'rich-text-approximated'));
  assert.ok(result.bytes && result.bytes.length > 0);

  const loaded = await PDFDocument.load(result.bytes);
  assert.equal(loaded.getPageCount(), 1);
  // Decode PDF stream contents (including hex-encoded Tj text literals) to assert visible math output
  const decodePdfHexLiterals = (stream: string): string => stream.replace(/<([0-9A-Fa-f]+)>/g, (_, hex: string) => (
    Buffer.from(hex, 'hex').toString('latin1')
  ));
  const streamText = loaded.context.enumerateIndirectObjects()
    .map(([, obj]) => {
      const raw = (obj as { contents?: Uint8Array }).contents;
      if (!raw) return '';
      try {
        return decodePdfHexLiterals(inflateSync(raw).toString('latin1'));
      } catch {
        return decodePdfHexLiterals(Buffer.from(raw).toString('latin1'));
      }
    })
    .join('\n');

  assert.match(streamText, /\(x\+1\)\/2\+pi<=inf/);
  assert.match(streamText, /sqrt\(x\^2\+1\)/);
  assert.match(streamText, /~= 3\.14/);
});
