import assert from 'node:assert/strict';
import test from 'node:test';
import type { Stroke, TextObject } from '../src/components/notebook/engine/drawingTypes.ts';
import {
  createBeautifiedTextPlacement,
  createHandwritingTipTapContent,
  resolveHandwritingLinePlacement,
  sanitizeHandwritingToolPreferences,
} from '../src/services/beautification/handwritingBeautification.ts';
import { createBulkHandwritingLinePlacements, type ReviewedHandwritingLine } from '../src/services/recognition/bulkConversion.ts';
import { isHandwritingTextObject, textObjectStyle } from '../src/components/notebook/textTypography.ts';

function stroke(id: string, x = 100, y = 100, width = 120, height = 28): Stroke {
  return { id, type: 'stroke', tool: 'pen', color: '#111111', thickness: 2, opacity: 1, createdAt: 1,
    points: [{ x, y, pressure: .5, t: 0 }, { x: x + width, y: y + height, pressure: .5, t: 50 }] };
}

// Model a face with a valid zero descender. Font ascent/descent describe the
// CSS line box, while actual ascent/descent describe the visible glyphs.
function withFontMetrics(run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ getContext: () => ({
      font: '',
      measureText(text: string) {
        const size = parseFloat(this.font);
        return { width: text.length * size * .5, actualBoundingBoxAscent: size * .7,
          actualBoundingBoxDescent: 0, fontBoundingBoxAscent: size * .9, fontBoundingBoxDescent: size * .25 };
      },
    }) }),
  } });
  try { run(); } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

test('H2T anchors visible glyph top using the measured CSS baseline rather than source baseline metadata', () => withFontMetrics(() => {
  const placement = createBeautifiedTextPlacement('Hi', [stroke('source')], sanitizeHandwritingToolPreferences({ fontSize: 40 }))!;
  const cssBaseline = 36 + (48 - 36 - 10) / 2;
  assert.equal(placement.x, 100);
  assert.equal(placement.y + cssBaseline - 28, 100);
  assert.equal(placement.baseline, 100 + 28 * .82);
  assert.equal(placement.lineHeight, 48);
}));

test('H2T auto sizing preserves zero descent and follows source handwriting height', () => withFontMetrics(() => {
  const preferences = sanitizeHandwritingToolPreferences({});
  const placements = [20, 28, 40].map(height => createBeautifiedTextPlacement('Hi', [stroke('source', 100, 100, 120, height)], preferences)!);
  assert.equal(placements[1].fontSize, 40);
  for (const placement of placements) assert.ok(Math.abs(placement.fontSize * .7 - placement.bounds.height) <= .5);
  assert.ok(placements[0].fontSize < placements[1].fontSize && placements[1].fontSize < placements[2].fontSize);
}));

test('H2T allows line-box leading above the page edge while keeping visible glyphs at source Y=0', () => withFontMetrics(() => {
  const placement = createBeautifiedTextPlacement('Hi', [stroke('edge', 20, 0)], sanitizeHandwritingToolPreferences({ fontSize: 40 }))!;
  assert.ok(placement.y < 0);
  assert.equal(placement.y + 37 - 28, 0);
}));

test('H2T uses natural text advance and grows the editable box without shrinking or stretching a long phrase', () => withFontMetrics(() => {
  const preferences = sanitizeHandwritingToolPreferences({});
  const source = stroke('source', 100, 100, 60);
  const short = createBeautifiedTextPlacement('Hi', [source], preferences)!;
  const long = createBeautifiedTextPlacement('A long phrase with multiple words', [source], preferences)!;
  assert.equal(long.fontSize, short.fontSize);
  assert.equal(long.x, short.x);
  assert.equal(long.y, short.y);
  assert.ok(long.width > short.width);
  assert.ok(short.width >= 160 && short.height >= 72);
}));

test('bulk and realtime placement are identical despite earlier lines, close spacing, and different source margins', () => withFontMetrics(() => {
  const preferences = sanitizeHandwritingToolPreferences({});
  const lines: ReviewedHandwritingLine[] = [stroke('first', 100, 100), stroke('second', 106, 122), stroke('third', 115, 145)].map(source => {
    const placement = createBeautifiedTextPlacement(source.id, [source], preferences)!;
    return { id: source.id, strokes: [source], bounds: placement.bounds, baseline: placement.baseline,
      blankLinesBefore: 0, text: source.id, candidates: [], status: 'success' };
  });
  const existing = { x: 90, y: 95, width: 600, lineHeight: 120,
    sourceBounds: { x: 90, y: 60, width: 600, height: 28 }, sourceBaseline: 82.96 };
  const bulk = createBulkHandwritingLinePlacements(lines, preferences, () => [existing]);
  assert.deepEqual(bulk.map(item => item.placement), lines.map(line => createBeautifiedTextPlacement(line.text, line.strokes, preferences)));
  assert.deepEqual(bulk.map(item => item.placement.x), [100, 106, 115]);
  assert.deepEqual(bulk.map(item => item.placement.y), [91, 113, 136]);
}));

test('source-preserving H2T bypasses collision correction while the default resolver retains its existing behavior', () => withFontMetrics(() => {
  const placement = createBeautifiedTextPlacement('Hi', [stroke('source', 106, 122)], sanitizeHandwritingToolPreferences({}))!;
  const existing = [{ x: 100, y: 93, width: 180, lineHeight: 48,
    sourceBounds: { x: 100, y: 100, width: 120, height: 28 }, sourceBaseline: 122.96 }];
  assert.equal(resolveHandwritingLinePlacement(placement, existing, { preserveSource: true }), placement);
  const corrected = resolveHandwritingLinePlacement(placement, existing);
  assert.equal(corrected.x, 100);
  assert.ok(corrected.y > placement.y);
}));

function textObject(metadata?: TextObject['metadata']): TextObject {
  return { id: 'text', type: 'text', x: 100, y: 100, width: 160, height: 72, createdAt: 1, metadata,
    content: createHandwritingTipTapContent('Hi', { fontSize: 40, fontFamily: "'Patrick Hand', cursive" }) };
}

test('generated H2T shares the content face, measured font size, and explicit line height across renderers', () => {
  const object = textObject({ generatedFrom: 'handwriting-recognition', handwritingFontSize: 40, handwritingLineHeight: 48 });
  assert.equal(isHandwritingTextObject(object), true);
  assert.deepEqual(textObjectStyle(object), { fontFamily: "'Patrick Hand', cursive", fontSize: 40, lineHeight: '48px' });
});

test('ordinary manually-created text keeps its previous typography contract even with font marks or unrelated metadata', () => {
  const object = textObject({ handwritingFontSize: 40, handwritingLineHeight: 48 });
  assert.equal(isHandwritingTextObject(object), false);
  assert.deepEqual(textObjectStyle(object), { fontFamily: 'Inter, sans-serif' });
  object.fontFamily = "'Kalam', cursive";
  assert.deepEqual(textObjectStyle(object), { fontFamily: "'Kalam', cursive" });
});

test('H2T respects an explicitly selected object font and ignores invalid metric metadata', () => {
  const object = textObject({ generatedFrom: 'handwriting-recognition', handwritingFontSize: NaN, handwritingLineHeight: 0 });
  object.fontFamily = "'Kalam', cursive";
  assert.deepEqual(textObjectStyle(object), { fontFamily: "'Kalam', cursive" });
});
