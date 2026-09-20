import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { createEmptyDrawingData, type DrawingData } from '../src/components/notebook/engine/drawingTypes.ts';
import { exportNotebookPdf, getSectionDividerContent, orderNotebookPages, resolveNotebookPageGeometry } from '../src/services/pdf/notebookPdfExport.ts';
import { extractPdfSourcePage, movePdfPage, normalizePdfPageState, rotatePdfPage } from '../src/services/pdf/pdfPageOperations.ts';
import type { NotebookPage, NotebookSection } from '../src/types/notebook.ts';
import { getNotebookCoverIdentity } from '../src/lib/notebookCover.ts';
import { drawPdfStroke } from '../src/services/pdf/drawPdfStroke.ts';
import { penGeometrySvg } from '../src/components/notebook/engine/penGeometry.ts';

test('new handwriting exports shared raw-centerline geometry, including dots and every nib', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const paths: string[] = [];
  const originalDraw = page.drawSvgPath.bind(page);
  page.drawSvgPath = (path, options) => { paths.push(path); originalDraw(path, options); };
  for (const inkFamily of [undefined, 'ballpoint', 'fountain', 'brush', 'felt'] as const) {
    for (const points of [[{ x: 10, y: 10, pressure: .5 }], [{ x: 10, y: 10, pressure: .5 }, { x: 20, y: 10, pressure: 1 }, { x: 20, y: 20, pressure: .5 }]]) {
      const stroke = { id: 'ink', type: 'stroke' as const, tool: 'pen' as const, centerline: 'polyline' as const,
        points, inkFamily, color: '#123456', opacity: .4, thickness: 3, createdAt: 0 };
      drawPdfStroke(page, stroke, .75, 1.25);
      assert.equal(paths.at(-1), penGeometrySvg(stroke, .75, 1.25));
      assert.ok(paths.at(-1)!.length > 0);
      assert.ok(!paths.at(-1)!.includes('Q'));
    }
  }
  assert.equal(paths.length, 10);
  assert.equal((await PDFDocument.load(await pdf.save())).getPageCount(), 1);
});

const baseProperties = createEmptyDrawingData().properties;
const pageInput = (id: string, overrides: Partial<typeof baseProperties> = {}, drawing: DrawingData = createEmptyDrawingData()) => ({
  id, title: id, properties: { ...baseProperties, ...overrides }, drawing: { ...drawing, properties: { ...baseProperties, ...overrides } },
});

test('finite paper geometry uses physical PDF points and orientation, not logical pixels', () => {
  const portrait = resolveNotebookPageGeometry({ ...baseProperties, pageSize: 'A4' })!;
  const landscape = resolveNotebookPageGeometry({ ...baseProperties, pageSize: 'Letter', orientation: 'landscape' })!;
  assert.ok(Math.abs(portrait.pdfWidth - 595.2756) < 0.001);
  assert.ok(Math.abs(portrait.pdfHeight - 841.8898) < 0.001);
  assert.equal(portrait.logicalWidth, 794);
  assert.equal(landscape.pdfWidth, 792);
  assert.equal(landscape.pdfHeight, 612);
  assert.equal(resolveNotebookPageGeometry({ ...baseProperties, pageSize: 'Custom' }), null);
});

test('notebook export preserves canonical section/page order and reloads as a multi-page PDF', async () => {
  const sections = [
    { id: 's2', order: 2, deletedAt: null }, { id: 's1', order: 1, deletedAt: null },
  ] as NotebookSection[];
  const pages = [
    { id: 'p3', sectionId: 's2', order: 0, createdAt: 3 },
    { id: 'p2', sectionId: 's1', order: 1, createdAt: 2 },
    { id: 'p1', sectionId: 's1', order: 0, createdAt: 1 },
  ] as NotebookPage[];
  assert.deepEqual(orderNotebookPages(sections, pages).map(page => page.id), ['p1', 'p2', 'p3']);
  const result = await exportNotebookPdf({ pages: [pageInput('p1'), pageInput('p2', { pageSize: 'Letter', orientation: 'landscape' })] });
  assert.equal(result.success, true);
  const pdf = await PDFDocument.load(result.bytes!);
  assert.equal(pdf.getPageCount(), 2);
  assert.ok(Math.abs(pdf.getPage(0).getWidth() - 595.2756) < 0.01);
  assert.equal(pdf.getPage(1).getWidth(), 792);
  assert.equal(pdf.getPage(1).getHeight(), 612);
});

test('section export contains only its own ordered pages and begins with its named divider', async () => {
  const sectionInput = {
    id: 'section-b',
    name: 'Design Decisions',
    notebookName: 'Panvas Architecture',
    pages: [pageInput('b-1'), pageInput('b-2', { pageSize: 'Letter', orientation: 'landscape' })],
  };
  assert.deepEqual(getSectionDividerContent(sectionInput), {
    sectionName: 'Design Decisions',
    notebookName: 'Panvas Architecture',
  });
  const result = await exportNotebookPdf({ sections: [sectionInput] });
  assert.equal(result.success, true);
  assert.deepEqual(result.sectionDividers, [{
    sectionId: 'section-b',
    sectionName: 'Design Decisions',
    notebookName: 'Panvas Architecture',
    pageIndex: 0,
  }]);
  const pdf = await PDFDocument.load(result.bytes!);
  assert.equal(pdf.getPageCount(), 3);
  assert.ok(Math.abs(pdf.getPage(0).getWidth() - 595.2756) < 0.01);
  assert.ok(Math.abs(pdf.getPage(1).getWidth() - 595.2756) < 0.01);
  assert.equal(pdf.getPage(2).getWidth(), 792);
});

test('whole-notebook export keeps section order, divider names, and page groups separate', async () => {
  const result = await exportNotebookPdf({
    sections: [
      { id: 'section-1', name: 'Foundations', notebookName: 'Notebook', pages: [pageInput('s1-a')] },
      { id: 'section-2', name: 'Implementation', notebookName: 'Notebook', pages: [pageInput('s2-a', { pageSize: 'A5' }), pageInput('s2-b', { pageSize: 'A5' })] },
    ],
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.sectionDividers.map(divider => [divider.sectionId, divider.sectionName, divider.pageIndex]), [
    ['section-1', 'Foundations', 0],
    ['section-2', 'Implementation', 2],
  ]);
  const pdf = await PDFDocument.load(result.bytes!);
  assert.equal(pdf.getPageCount(), 5);
  assert.ok(Math.abs(pdf.getPage(0).getWidth() - 595.2756) < 0.01);
  assert.ok(Math.abs(pdf.getPage(1).getWidth() - 595.2756) < 0.01);
  assert.ok(Math.abs(pdf.getPage(2).getWidth() - 419.5276) < 0.01);
  assert.ok(Math.abs(pdf.getPage(3).getWidth() - 419.5276) < 0.01);
  assert.ok(Math.abs(pdf.getPage(4).getWidth() - 419.5276) < 0.01);
});

test('whole-notebook export prepends the canonical cover before section dividers without mutating metadata', async () => {
  const cover = { kind: 'template' as const, id: 'plum' as const };
  const before = JSON.stringify(cover);
  const result = await exportNotebookPdf({
    cover: { notebookName: 'Project Memory', cover },
    sections: [{ id: 'section-1', name: 'Foundations', notebookName: 'Project Memory', pages: [pageInput('page-1')] }],
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.notebookCover, { notebookName: 'Project Memory', coverIdentity: 'template:plum', coverKind: 'template', pageIndex: 0 });
  assert.equal(result.sectionDividers[0].pageIndex, 1);
  assert.equal((await PDFDocument.load(result.bytes!)).getPageCount(), 3);
  assert.equal(JSON.stringify(cover), before);
});

test('custom cover images are embedded and missing covers safely use the shared default identity', async () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const custom = await exportNotebookPdf({
    cover: { notebookName: 'Custom', cover: { kind: 'image', dataUrl, position: '25% 75%' } },
    pages: [pageInput('custom-cover-page')],
  });
  assert.equal(custom.notebookCover?.coverKind, 'image');
  assert.equal(custom.notebookCover?.coverIdentity, getNotebookCoverIdentity({ kind: 'image', dataUrl, position: '25% 75%' }));
  assert.equal((await PDFDocument.load(custom.bytes!)).getPageCount(), 2);

  const fallback = await exportNotebookPdf({ cover: { notebookName: 'Fallback' }, pages: [pageInput('fallback-page')] });
  assert.equal(fallback.notebookCover?.coverIdentity, 'template:linen');
  assert.equal(fallback.notebookCover?.coverKind, 'template');
});

test('page-only and section-only exports do not gain a notebook cover implicitly', async () => {
  const pageOnly = await exportNotebookPdf({ pages: [pageInput('page-only')] });
  const sectionOnly = await exportNotebookPdf({ sections: [{ id: 'section-only', name: 'Section', notebookName: 'Notebook', pages: [pageInput('section-page')] }] });
  assert.equal(pageOnly.notebookCover, null);
  assert.equal(sectionOnly.notebookCover, null);
  assert.equal((await PDFDocument.load(pageOnly.bytes!)).getPageCount(), 1);
  assert.equal((await PDFDocument.load(sectionOnly.bytes!)).getPageCount(), 2);
});

test('visible vectors and formatted text export while hidden layers stay excluded without input mutation', async () => {
  const drawing: DrawingData = {
    version: 3,
    properties: { ...baseProperties, template: 'Cornell' },
    layers: [
      { id: 'visible', name: 'Visible', visible: true, locked: false, order: 0 },
      { id: 'hidden', name: 'Hidden', visible: false, locked: false, order: 1 },
    ],
    objects: [
      { id: 'stroke', type: 'stroke', tool: 'highlighter', points: [{ x: 10, y: 10, pressure: 1, t: 0 }, { x: 100, y: 100, pressure: 1, t: 1 }], color: '#ffff00', thickness: 8, opacity: 0.4, createdAt: 1, layerId: 'visible' },
      { id: 'shape', type: 'shape', shapeType: 'rectangle', x: 40, y: 50, width: 100, height: 80, color: '#ff0000', strokeWidth: 2, fill: null, rotation: 0, createdAt: 2, layerId: 'visible' },
      { id: 'text', type: 'text', x: 50, y: 160, width: 260, createdAt: 3, layerId: 'visible', content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [{ type: 'text', text: 'Exported heading', marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#336699', fontSize: '18px' } }] }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'List item', marks: [{ type: 'italic' }] }] }] }] }, { type: 'codeBlock', content: [{ type: 'text', text: 'const answer = 42;' }] }] } },
      { id: 'hidden-stroke', type: 'stroke', tool: 'pen', points: [{ x: 1, y: 1, pressure: 1, t: 0 }, { x: 2, y: 2, pressure: 1, t: 1 }], color: '#000000', thickness: 1, opacity: 1, createdAt: 4, layerId: 'hidden' },
    ],
  };
  const before = JSON.stringify(drawing);
  const result = await exportNotebookPdf({ pages: [pageInput('vectors', {}, drawing)] });
  assert.equal(result.success, true);
  assert.equal(result.exportedObjects, 3);
  assert.equal(JSON.stringify(drawing), before);
  assert.ok(result.warnings.some(warning => warning.code === 'rich-text-approximated'));
  assert.equal((await PDFDocument.load(result.bytes!)).getPageCount(), 1);
});

test('PNG assets embed and missing or unsupported image assets produce structured warnings', async () => {
  const drawing: DrawingData = {
    ...createEmptyDrawingData(),
    objects: [
      { id: 'ok', type: 'image', x: 20, y: 20, width: 20, height: 20, fileId: 'png', rotation: 15, createdAt: 1 },
      { id: 'missing', type: 'image', x: 50, y: 20, width: 20, height: 20, fileId: 'missing', rotation: 0, createdAt: 2 },
    ],
  };
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const result = await exportNotebookPdf({ pages: [pageInput('images', {}, drawing)], loadImage: async id => id === 'png' ? { mimeType: 'image/png', data: png } : undefined });
  assert.equal(result.success, true);
  assert.equal(result.exportedObjects, 1);
  assert.equal(result.unsupportedObjects, 1);
  assert.ok(result.warnings.some(warning => warning.code === 'image-skipped' && warning.objectId === 'missing'));
  await PDFDocument.load(result.bytes!);
});

test('custom page size fails explicitly instead of guessing dimensions', async () => {
  const result = await exportNotebookPdf({ pages: [pageInput('custom', { pageSize: 'Custom' })] });
  assert.equal(result.success, false);
  assert.equal(result.bytes, null);
  assert.match(result.error ?? '', /stores no custom dimensions/);
});

test('PDF page operations rotate, reorder, and extract a valid source page end-to-end', async () => {
  const source = await PDFDocument.create();
  source.addPage([200, 300]); source.addPage([400, 500]);
  const bytes = await source.save();
  let state = normalizePdfPageState(undefined, 2);
  state = rotatePdfPage(state, 1, 1);
  state = movePdfPage(state, 1, 0);
  assert.deepEqual(state.pageOrder, [2, 1]);
  assert.equal(state.rotations[1], 90);
  const extracted = await extractPdfSourcePage(bytes, 2);
  const loaded = await PDFDocument.load(extracted);
  assert.equal(loaded.getPageCount(), 1);
  assert.equal(loaded.getPage(0).getWidth(), 400);
  assert.equal(loaded.getPage(0).getHeight(), 500);
});


test('extended notebook pages retain the original scale instead of clipping lower notes', async () => {
  const original = resolveNotebookPageGeometry(baseProperties)!;
  const extended = resolveNotebookPageGeometry({ ...baseProperties, extraHeight: 560 })!;
  assert.equal(extended.logicalHeight, original.logicalHeight + 560);
  assert.ok(Math.abs(extended.scaleY - original.scaleY) < 1e-12);
  const output = await exportNotebookPdf({ pages: [pageInput('extended', { extraHeight: 560 })] });
  assert.equal(output.success, true);
  assert.ok(Math.abs((await PDFDocument.load(output.bytes!)).getPage(0).getHeight() - extended.pdfHeight) < 1e-8);
});

test('four-sided notebook export enlarges the sheet while retaining a fixed A3 source frame', async () => {
  const base = resolveNotebookPageGeometry({ ...baseProperties, pageSize: 'A3' })!;
  const surrounded = resolveNotebookPageGeometry({ ...baseProperties, pageSize: 'A3', extraTop: 120, extraRight: 80, extraBottom: 240, extraLeft: 60 })!;
  assert.deepEqual({ width: surrounded.sourceWidth, height: surrounded.sourceHeight }, { width: 1123, height: 1587 });
  assert.deepEqual({ x: surrounded.sourceX, y: surrounded.sourceY }, { x: 60, y: 120 });
  assert.ok(Math.abs(surrounded.scaleX - base.scaleX) < 1e-12);
  assert.ok(Math.abs(surrounded.scaleY - base.scaleY) < 1e-12);
  const output = await exportNotebookPdf({ pages: [pageInput('surrounded', { pageSize: 'A3', extraTop: 120, extraRight: 80, extraBottom: 240, extraLeft: 60 })] });
  const exportedPage = (await PDFDocument.load(output.bytes!)).getPage(0);
  assert.ok(Math.abs(exportedPage.getWidth() - surrounded.pdfWidth) < 1e-8);
  assert.ok(Math.abs(exportedPage.getHeight() - surrounded.pdfHeight) < 1e-8);
});

test('PDF extension export includes cropped image, nib, styled line and sticky without mutating data', async () => {
  const { renderPdfAnnotations } = await import('../src/services/pdf/renderPdfAnnotations.ts');
  const { createStickyPreset } = await import('../src/components/notebook/stickyNotes.ts');
  const source = await PDFDocument.create(); source.addPage([400, 500]);
  const drawing = createEmptyDrawingData(); drawing.properties.extraHeight = 400;
  drawing.objects = [
    { id: 'image', type: 'image', createdAt: 0, x: 20, y: 530, width: 80, height: 60, rotation: 45, opacity: 0.35, fileId: 'original', crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 } },
    { id: 'nib', type: 'stroke', createdAt: 0, tool: 'pen', inkFamily: 'fountain', pattern: 'dashed', color: '#2468ac', thickness: 3, opacity: 0.7, points: [{ x: 50, y: 620, pressure: 0.5, t: 1 }, { x: 150, y: 730, pressure: 0.9, t: 2 }] },
    { id: 'line', type: 'shape', createdAt: 0, shapeType: 'arrow', lineStyle: 'wavy', x: 50, y: 750, width: 200, height: 50, rotation: 20, color: '#111111', fill: null, strokeWidth: 2 },
    createStickyPreset('lined', 'sticky', 170, 540),
  ];
  const before = JSON.stringify(drawing);
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  for (const rotation of [0, 90, 180, 270] as const) {
    const output = await renderPdfAnnotations(await source.save(), [drawing], { version: 1, pageOrder: [1], rotations: { 1: rotation } }, async () => ({ mimeType: 'image/png', data: png }));
    assert.equal(output.exportedObjects, 4); assert.equal(output.unsupportedObjects, 0);
    const loaded = await PDFDocument.load(output.bytes);
    assert.equal(loaded.getPage(0).getHeight(), 900);
    assert.equal(loaded.getPage(0).getRotation().angle, rotation);
  }
  assert.equal(JSON.stringify(drawing), before);
});
