import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { inkRgb, presentationColor, presentationData } from '../src/lib/themePresentation.ts';
import { marginRuling, MARGIN_RULE_ACCENT } from '../src/components/notebook/templates/marginRuling.ts';
import { createEmptyDrawingData } from '../src/components/notebook/engine/drawingTypes.ts';
import { exportNotebookPdf } from '../src/services/pdf/notebookPdfExport.ts';
import { renderPdfAnnotations } from '../src/services/pdf/renderPdfAnnotations.ts';

test('Ink matches CSS half saturation and keeps neutral colors neutral', () => {
  assert.deepEqual(inkRgb(255, 0, 0), [155, 27, 27]);
  assert.equal(presentationColor('#f00', 'ink'), '#9b1b1b');
  assert.equal(presentationColor('#FFFFFF', 'ink'), '#ffffff');
  for (const channel of [0, 30, 128, 255]) assert.deepEqual(inkRgb(channel, channel, channel), [channel, channel, channel]);
  for (const theme of ['light', 'dark'] as const) assert.equal(presentationColor('#FF0000', theme), '#FF0000');
  assert.equal(presentationColor('transparent', 'ink'), 'transparent');
});

test('Ink export copies paint only; paper, rich-text source, geometry and opacity remain intact', () => {
  const source = {
    properties: { paperColor: '#FFF9C4', ruleLineColor: '#ff0000' },
    objects: [
      { type: 'shape', color: '#ff0000', fill: '#00ff00', x: 20, y: 40, width: 90, rotation: 45, opacity: 0.3 },
      { type: 'text', metadata: { color: '#ff0000', elementBackground: '#00ff00' },
        content: { marks: [{ type: 'textStyle', attrs: { color: '#ff0000', fontSize: '18px' } }] } },
    ],
  };
  const before = JSON.stringify(source);
  const copy = presentationData(source, 'ink');
  assert.notEqual(copy, source);
  assert.equal(copy.properties.paperColor, '#FFF9C4');
  assert.equal(copy.properties.ruleLineColor, '#9b1b1b');
  assert.equal(copy.objects[0].color, '#9b1b1b');
  assert.equal(copy.objects[0].opacity, 0.3);
  assert.equal(copy.objects[0].x, 20);
  assert.equal(copy.objects[0].rotation, 45);
  assert.equal(copy.objects[1].metadata?.color, '#9b1b1b');
  assert.equal(copy.objects[1].content?.marks[0].attrs.color, '#9b1b1b');
  assert.equal(JSON.stringify(source), before);
  assert.equal(presentationData(source, 'light'), source);
  assert.equal(presentationData(source, 'dark'), source);
});

test('reference ruling structures have wide/single and regular/double margins at multiple page sizes', () => {
  for (const [width, height] of [[794, 1123], [1123, 794], [559, 794]]) {
    const wide = marginRuling(width, height, 'Large ruled with margin');
    const double = marginRuling(width, height, 'Double margin ruled');
    assert.equal(wide.margins.length, 1);
    assert.equal(double.margins.length, 2);
    assert.equal(double.margins[1] - double.margins[0], 6);
    assert.equal(wide.horizontal[1] - wide.horizontal[0], 150);
    assert.equal(double.horizontal[1] - double.horizontal[0], 32);
    assert.ok(wide.margins[0] < width);
    assert.ok(double.horizontal.at(-1)! < height);
  }
});

async function pdfPaint(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  const streams = pdf.getPage(0).node.Contents()!.asArray().map(ref =>
    Buffer.from(decodePDFRawStream(pdf.context.lookup(ref, PDFRawStream)).decode()).toString(),
  ).join('\n');
  return [...streams.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (rg|RG)\b/g)].map(match =>
    match.slice(1, 4).map(channel => Math.round(Number(channel) * 255)),
  );
}

test('both new templates export as vectors on chosen paper in all three themes without mutating sources', async () => {
  for (const template of ['Large ruled with margin', 'Double margin ruled'] as const) {
    for (const paperColor of ['#ffffff', '#FFF9C4', '#232323', '#e3f2fd']) {
      const drawing = createEmptyDrawingData();
      Object.assign(drawing.properties, { template, paperColor, ruleLineColor: '#0000ff', margins: 'No Margin' });
      drawing.objects = [{ id: 'red', type: 'shape', shapeType: 'rectangle', x: 180, y: 120,
        width: 100, height: 80, color: '#ff0000', fill: '#ff0000', strokeWidth: 1, rotation: 0, createdAt: 0 }];
      const before = JSON.stringify(drawing);
      for (const theme of ['light', 'ink', 'dark'] as const) {
        const result = await exportNotebookPdf({ theme, pages: [{ id: 'page', title: 'Page', drawing, properties: drawing.properties }] });
        assert.equal(result.success, true);
        assert.equal(result.unsupportedObjects, 0);
        assert.equal(result.approximatedObjects, 0);
        assert.ok(!result.warnings.some(warning => warning.code === 'template-approximated'));
        const paints = await pdfPaint(result.bytes!);
        const paper = paperColor.slice(1).match(/../g)!.map(hex => Number.parseInt(hex, 16));
        assert.deepEqual(paints[0], paper);
        assert.ok(paints.some(paint => JSON.stringify(paint) === JSON.stringify(theme === 'ink' ? [155, 27, 27] : [255, 0, 0])));
        if (template === 'Double margin ruled') {
          const accent = presentationColor(MARGIN_RULE_ACCENT, theme).slice(1).match(/../g)!.map(hex => Number.parseInt(hex, 16));
          assert.ok(paints.some(paint => JSON.stringify(paint) === JSON.stringify(accent)));
        }
      }
      assert.equal(JSON.stringify(drawing), before);
    }
  }
});

test('annotated PDF preserves source vector colors while muting only export copies of authored notes', async () => {
  const original = await PDFDocument.create();
  original.addPage([400, 500]).drawRectangle({ x: 20, y: 20, width: 80, height: 80, color: { type: 'RGB', red: 0, green: 0, blue: 1 } });
  const bytes = await original.save();
  const drawing = createEmptyDrawingData();
  drawing.objects = [{ id: 'red', type: 'shape', shapeType: 'rectangle', x: 200, y: 200,
    width: 80, height: 80, color: '#ff0000', fill: '#ff0000', strokeWidth: 1, rotation: 0, createdAt: 0 }];
  const before = JSON.stringify(drawing);
  const result = await renderPdfAnnotations(bytes, [drawing], undefined, undefined, 'ink');
  assert.equal(result.unsupportedObjects, 0);
  const paints = await pdfPaint(result.bytes);
  assert.ok(paints.some(paint => JSON.stringify(paint) === '[0,0,255]'));
  assert.ok(paints.some(paint => JSON.stringify(paint) === '[155,27,27]'));
  assert.equal(JSON.stringify(drawing), before);
});
