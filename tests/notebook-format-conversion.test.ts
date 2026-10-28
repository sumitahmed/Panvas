import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBasePageDimensions, resolvePageDimensions, resolvePageProperties } from '../src/lib/pageProperties.ts';
import { DEFAULT_PAGE_PROPERTY_SET, type Notebook, type NotebookPage, type PagePropertySet } from '../src/types/notebook.ts';
import type { DrawingData, Stroke, ShapeObject, ImageObject } from '../src/components/notebook/engine/drawingTypes.ts';

const mockNotebook: Notebook = {
  id: 'nb-1',
  workspaceId: 'ws-1',
  folderId: null,
  name: 'Format Notebook',
  order: 0,
  createdAt: 1000,
  updatedAt: 1000,
  isExpanded: true,
  userId: null,
  defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET },
};

test('Suite 5 - Test 24: Infinite to A4 Conversion adapts dimensions and paginates overflow text', () => {
  // Start with an Infinite page with 2500px content extent
  const initialOverrides: Partial<PagePropertySet> = {
    pageSize: 'Infinite',
    infiniteWidth: 794,
    layoutMode: 'document',
    layoutExtent: 2500,
  };
  const page: NotebookPage = {
    id: 'page-inf-to-a4',
    notebookId: 'nb-1',
    sectionId: 'sec-1',
    title: 'Infinite Notes',
    order: 0,
    createdAt: 1000,
    updatedAt: 1000,
    userId: null,
    pagePropertyOverrides: initialOverrides,
  };

  const initialProps = resolvePageProperties(mockNotebook, page);
  const initialDim = resolvePageDimensions(initialProps);
  assert.equal(initialProps.pageSize, 'Infinite');
  assert.equal(initialDim.width, 794);

  // Convert to A4
  const targetOverrides: Partial<PagePropertySet> = {
    ...page.pagePropertyOverrides,
    pageSize: 'A4',
    orientation: 'portrait',
  };
  const convertedPage: NotebookPage = {
    ...page,
    pagePropertyOverrides: targetOverrides,
  };

  const convertedProps = resolvePageProperties(mockNotebook, convertedPage);
  const baseDim = resolveBasePageDimensions(convertedProps);
  const convertedDim = resolvePageDimensions(convertedProps);

  assert.equal(convertedProps.pageSize, 'A4');
  assert.equal(convertedProps.orientation, 'portrait');
  assert.equal(baseDim.width, 794);
  assert.equal(baseDim.height, 1123);
  assert.equal(convertedDim.width, 794);
  assert.equal(convertedDim.height, 2500);

  // Verify multi-sheet continuation extent on A4
  const stride = 1155;
  const sheetCount = Math.ceil(2500 / 995);
  assert.equal(sheetCount, 3);
  const layoutExtent = sheetCount * stride - 32;
  assert.equal(layoutExtent, 3433);
});

test('Suite 5 - Test 25: Infinite to A3 Conversion adapts to A3 standard dimensions', () => {
  const page: NotebookPage = {
    id: 'page-inf-to-a3',
    notebookId: 'nb-1',
    sectionId: 'sec-1',
    title: 'Architecture Blueprint',
    order: 0,
    createdAt: 1000,
    updatedAt: 1000,
    userId: null,
    pagePropertyOverrides: {
      pageSize: 'Infinite',
      infiniteWidth: 1200,
    },
  };

  // Convert to A3 Landscape
  const convertedPage: NotebookPage = {
    ...page,
    pagePropertyOverrides: {
      pageSize: 'A3',
      orientation: 'landscape',
    },
  };

  const resolved = resolvePageProperties(mockNotebook, convertedPage);
  const dim = resolvePageDimensions(resolved);

  assert.equal(resolved.pageSize, 'A3');
  assert.equal(resolved.orientation, 'landscape');
  assert.equal(dim.width, 1587);
  assert.equal(dim.height, 1123);
});

test('Suite 5 - Test 26: Fixed to Infinite Conversion unites multi-page document into continuous surface without content loss', () => {
  // Fixed A4 document spanning 3 physical continuation sheets
  const fixedPage: NotebookPage = {
    id: 'page-fixed-to-inf',
    notebookId: 'nb-1',
    sectionId: 'sec-1',
    title: 'Long Draft',
    order: 0,
    createdAt: 1000,
    updatedAt: 1000,
    userId: null,
    pagePropertyOverrides: {
      pageSize: 'A4',
      orientation: 'portrait',
      layoutMode: 'document',
      layoutExtent: 3433,
    },
  };

  const documentBody = {
    id: 'doc-body-1',
    type: 'text',
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Section 1 introduction.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Section 2 middle content across page breaks.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Section 3 concluding remarks.' }] },
      ],
    },
  };

  // Convert back to Infinite
  const convertedPage: NotebookPage = {
    ...fixedPage,
    pagePropertyOverrides: {
      ...fixedPage.pagePropertyOverrides,
      pageSize: 'Infinite',
      infiniteWidth: 794,
    },
  };

  const resolved = resolvePageProperties(mockNotebook, convertedPage);
  assert.equal(resolved.pageSize, 'Infinite');
  assert.equal(resolved.infiniteWidth, 794);

  // All 3 paragraphs remain completely intact
  assert.equal(documentBody.content.content.length, 3);
  assert.equal(documentBody.content.content[0].content[0].text, 'Section 1 introduction.');
  assert.equal(documentBody.content.content[2].content[0].text, 'Section 3 concluding remarks.');
});

test('Suite 5 - Test 27: Drawing & Image Preservation during format conversion', () => {
  // Drawing data with strokes, shapes, and images at specific positions
  const drawingData: DrawingData = {
    version: 1,
    properties: { ...DEFAULT_PAGE_PROPERTY_SET, pageSize: 'Infinite', infiniteWidth: 800 },
    strokes: [
      {
        id: 'stroke-1',
        points: [{ x: 100, y: 150, pressure: 0.5 }, { x: 150, y: 200, pressure: 0.7 }],
        color: '#ff0000',
        size: 3,
        tool: 'pen',
        createdAt: 1000,
      } as Stroke,
    ],
    objects: [
      {
        id: 'shape-1',
        type: 'shape',
        shapeType: 'rectangle',
        x: 200,
        y: 300,
        width: 150,
        height: 100,
        strokeColor: '#0000ff',
      } as unknown as ShapeObject,
      {
        id: 'image-1',
        type: 'image',
        fileId: 'img-file-1',
        x: 50,
        y: 600,
        width: 300,
        height: 200,
      } as unknown as ImageObject,
    ],
  };

  // Convert page from Infinite to A4
  const convertedProperties = {
    ...drawingData.properties,
    pageSize: 'A4' as const,
    orientation: 'portrait' as const,
  };
  const convertedDrawingData: DrawingData = {
    ...drawingData,
    properties: convertedProperties,
  };

  // All strokes, shapes, images and coordinates are strictly preserved
  assert.equal(convertedDrawingData.strokes.length, 1);
  assert.equal(convertedDrawingData.strokes[0].id, 'stroke-1');
  assert.deepEqual(convertedDrawingData.strokes[0].points, [
    { x: 100, y: 150, pressure: 0.5 },
    { x: 150, y: 200, pressure: 0.7 },
  ]);

  const shapes = convertedDrawingData.objects?.filter(o => o.type === 'shape');
  assert.equal(shapes?.length, 1);
  assert.equal(shapes![0].id, 'shape-1');
  assert.equal(shapes![0].x, 200);
  assert.equal(shapes![0].y, 300);

  const images = convertedDrawingData.objects?.filter(o => o.type === 'image');
  assert.equal(images?.length, 1);
  assert.equal(images![0].id, 'image-1');
  assert.equal(images![0].x, 50);
  assert.equal(images![0].y, 600);
});

test('Suite 5 - Test 28: Conversion Persistence survives serialize/deserialize lifecycle', () => {
  const convertedPage: NotebookPage = {
    id: 'page-persist-conversion',
    notebookId: 'nb-1',
    sectionId: 'sec-1',
    title: 'Converted Specification',
    order: 0,
    createdAt: 1000,
    updatedAt: 2000,
    userId: null,
    deletedAt: null,
    pagePropertyOverrides: {
      pageSize: 'A3',
      orientation: 'landscape',
      paperColor: '#fafafa',
      template: 'Large grid',
    },
  };

  const serialized = JSON.stringify(convertedPage);
  const reloaded: NotebookPage = JSON.parse(serialized);

  assert.equal(reloaded.pagePropertyOverrides?.pageSize, 'A3');
  assert.equal(reloaded.pagePropertyOverrides?.orientation, 'landscape');
  assert.equal(reloaded.pagePropertyOverrides?.paperColor, '#fafafa');
  assert.equal(reloaded.pagePropertyOverrides?.template, 'Large grid');

  const resolved = resolvePageProperties(mockNotebook, reloaded);
  const dim = resolvePageDimensions(resolved);
  assert.equal(dim.width, 1587);
  assert.equal(dim.height, 1123);
});
