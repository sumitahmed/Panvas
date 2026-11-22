import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import {
  MAX_QUERY_CELLS,
  SPATIAL_CELL_SIZE,
  SPATIAL_INDEX_THRESHOLD,
  StrokeSpatialIndex,
  intersectBounds,
  isEmptyBounds,
  objectIntersectsBounds,
} from '../src/components/notebook/engine/strokeSpatialIndex.ts';
import {
  DEFAULT_PAGE_LAYER_ID,
  type ImageObject,
  type Shape,
  type Stroke,
} from '../src/components/notebook/engine/drawingTypes.ts';

async function withViteServer<T>(run: (server: ViteDevServer) => Promise<T>): Promise<T> {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },
    server: { middlewareMode: true, watch: null, ws: false, hmr: false },
  });
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

function makeStroke(id: string, x: number, y: number, dx = 20, dy = 10, createdAt = 0): Stroke {
  return {
    id,
    type: 'stroke',
    tool: 'pen',
    centerline: 'polyline',
    color: '#111827',
    thickness: 2,
    opacity: 1,
    createdAt,
    points: [
      { x, y, pressure: 0.5, t: 0 },
      { x: x + dx, y: y + dy, pressure: 0.5, t: 16 },
    ],
  };
}

function createCanvasHarness() {
  const drawEvents: string[] = [];

  const makeMockContext = (canvas: any) => ({
    canvas,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    globalAlpha: 1,
    strokeStyle: '#000000',
    fillStyle: '#000000',
    lineWidth: 1,
    lineCap: 'round',
    lineJoin: 'round',
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {},
    transform() {},
    setTransform() {},
    resetTransform() {},
    getTransform() {
      return {
        a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
        inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      };
    },
    clearRect() {},
    fillRect() { drawEvents.push('fillRect'); },
    beginPath() {},
    rect() { drawEvents.push('rect'); },
    clip() {},
    moveTo() {},
    lineTo() {},
    ellipse() {},
    arc() {},
    closePath() {},
    stroke() { drawEvents.push('stroke'); },
    strokeRect() { drawEvents.push('strokeRect'); },
    fill() { drawEvents.push('fill'); },
    translate() {},
    rotate() {},
    scale() {},
    drawImage(source: any) {
      drawEvents.push(`drawImage:${source?.tagName ?? 'canvas'}`);
    },
    setLineDash() {},
  });

  const makeMockCanvas = (connected = true) => {
    const canvas: any = {
      tagName: 'CANVAS',
      width: 0,
      height: 0,
      isConnected: connected,
      style: {},
      dataset: {},
      parentElement: connected ? { appendChild() {}, insertBefore() {} } : null,
      remove() { canvas.isConnected = false; },
      insertAdjacentElement() {},
      getContext: () => ctx,
    };
    const ctx = makeMockContext(canvas);
    return canvas;
  };

  return { makeMockCanvas, drawEvents };
}

test('StrokeSpatialIndex preserves z-order, handles oversized strokes, and enforces thresholds', () => {
  const index = new StrokeSpatialIndex();

  const smallBatch = Array.from({ length: SPATIAL_INDEX_THRESHOLD - 1 }, (_, i) =>
    makeStroke(`s-${i}`, (i % 10) * 500, Math.floor(i / 10) * 500, 20, 10, i),
  );
  const belowThreshold = index.query({ left: 0, top: 0, right: 200, bottom: 200 }, smallBatch);
  assert.equal(belowThreshold.exactFilterApplied, false);
  assert.equal(belowThreshold.strokes, smallBatch);

  const strokes: Stroke[] = [];
  for (let i = 0; i < 1000; i += 1) {
    strokes.push(makeStroke(`s-${i}`, (i % 40) * 400, Math.floor(i / 40) * 400, 30, 15, i));
  }
  const huge = makeStroke('huge-diag', 100, 100, 5000, 5000, 500);
  strokes.splice(500, 0, huge);

  const midQuery = index.query({ left: 2500, top: 2500, right: 2650, bottom: 2650 }, strokes);
  assert.equal(midQuery.exactFilterApplied, true);
  assert.ok(midQuery.strokes.some(s => s.id === 'huge-diag'), 'oversized stroke matches mid-segment query');

  const offDiagQuery = index.query({ left: 5200, top: 200, right: 5350, bottom: 350 }, strokes);
  assert.equal(offDiagQuery.exactFilterApplied, true);
  assert.equal(offDiagQuery.strokes.some(s => s.id === 'huge-diag'), false, 'oversized stroke excluded outside bounds');

  strokes.push(makeStroke('z-1', 1200, 1200, 25, 25, 2001));
  index.appendStroke(strokes[strokes.length - 1], strokes.length);
  strokes.push(makeStroke('z-2', 1205, 1205, 25, 25, 2002));
  index.appendStroke(strokes[strokes.length - 1], strokes.length);

  const clusterQuery = index.query({ left: 1190, top: 1190, right: 1240, bottom: 1240 }, strokes);
  assert.equal(clusterQuery.exactFilterApplied, true);
  const orderedIds = clusterQuery.strokes.map(s => s.id);
  assert.ok(orderedIds.indexOf('s-123') < orderedIds.indexOf('z-1'));
  assert.ok(orderedIds.indexOf('z-1') < orderedIds.indexOf('z-2'));
  assert.ok(orderedIds.includes('huge-diag'));

  const idx = strokes.findIndex(s => s.id === 'z-1');
  strokes.splice(idx, 1);
  index.removeStrokeIds(['z-1']);
  huge.points[0] = { x: 9000, y: 9000, pressure: 0.5, t: 0 };
  huge.points[1] = { x: 9200, y: 9200, pressure: 0.5, t: 16 };
  index.invalidateStroke('huge-diag');

  const afterMutation = index.query({ left: 1190, top: 1190, right: 1240, bottom: 1240 }, strokes);
  assert.equal(afterMutation.strokes.some(s => s.id === 'z-1'), false);
  assert.equal(afterMutation.strokes.some(s => s.id === 'huge-diag'), false);
  assert.equal(afterMutation.strokes.some(s => s.id === 'z-2'), true);

  const sidePx = (Math.ceil(Math.sqrt(MAX_QUERY_CELLS)) + 2) * SPATIAL_CELL_SIZE;
  const giantQuery = index.query({ left: 0, top: 0, right: sidePx, bottom: sidePx }, strokes);
  assert.equal(giantQuery.exactFilterApplied, false);
  assert.equal(giantQuery.strokes, strokes);

  const empty = intersectBounds({ left: 0, top: 0, right: 50, bottom: 50 }, { left: 100, top: 0, right: 150, bottom: 50 });
  assert.equal(isEmptyBounds(empty), true);
  const emptyRes = index.query(empty, strokes);
  assert.deepEqual(emptyRes.strokes, []);
  assert.equal(emptyRes.exactFilterApplied, true);
});

test('objectIntersectsBounds, ImageManager default-layer filtering, and ShapeManager culling', async () => {
  const prevDoc = (globalThis as any).document;
  try {
    await withViteServer(async server => {
    const [{ ViewportManager }, { ShapeManager }, { ImageManager }] = await Promise.all([
      server.ssrLoadModule('/src/components/notebook/engine/ViewportManager.ts'),
      server.ssrLoadModule('/src/components/notebook/engine/ShapeManager.ts'),
      server.ssrLoadModule('/src/components/notebook/engine/ImageManager.ts'),
    ]);

    const mockCtx: any = {
      save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
      drawImage() {}, beginPath() {}, rect() {}, clip() {}, closePath() {},
      stroke() {}, fill() {}, strokeRect() {}, fillRect() {}, setLineDash() {},
      strokeStyle: '#000', fillStyle: '#000', lineWidth: 2, globalAlpha: 1,
    };
    (globalThis as any).document = {
      createElement: () => ({ tagName: 'CANVAS', width: 0, height: 0, getContext: () => mockCtx }),
    };

    const viewport = new ViewportManager();
    const images = new ImageManager(viewport);
    const fakeBitmap = { complete: true, naturalWidth: 100, width: 100, height: 100, tagName: 'IMG' } as any;
    const drawLog: string[] = [];
    mockCtx.drawImage = (img: any) => {
      if (img === fakeBitmap) drawLog.push('img');
    };
    (images as any).imageCache.set('f1', fakeBitmap);

    const imgDefaultLayer: ImageObject = {
      id: 'img-default',
      type: 'image',
      x: 100,
      y: 100,
      width: 200,
      height: 20,
      fileId: 'f1',
      rotation: Math.PI / 4,
      createdAt: 1,
    };
    const imgOtherLayer: ImageObject = {
      id: 'img-other',
      type: 'image',
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      fileId: 'f1',
      rotation: 0,
      layerId: 'layer-2',
      createdAt: 2,
    };
    images.setImages([imgDefaultLayer, imgOtherLayer]);

    images.renderImages(mockCtx, DEFAULT_PAGE_LAYER_ID, undefined, { left: 260, top: 20, right: 320, bottom: 250 });
    assert.equal(drawLog.length, 1, '45-degree rotated image intersecting cullBounds on DEFAULT_PAGE_LAYER_ID renders');

    drawLog.length = 0;
    images.renderImages(mockCtx, DEFAULT_PAGE_LAYER_ID, undefined, { left: 900, top: 900, right: 1100, bottom: 1100 });
    assert.equal(drawLog.length, 0, 'off-bounds image is culled');

    assert.equal(
      objectIntersectsBounds({ x: 0, y: 0, width: 100, height: 10, rotation: 90 }, { left: 40, top: 30, right: 60, bottom: 55 }),
      true,
    );

    const shapes = new ShapeManager(viewport);
    const renderedRects: number[] = [];
    mockCtx.rect = (x: number) => { renderedRects.push(x); };
    mockCtx.strokeRect = (x: number) => { renderedRects.push(x); };
    const s1: Shape = {
      id: 'sh-1', type: 'shape', shapeType: 'rectangle',
      x: 50, y: 50, width: 100, height: 80, color: '#000', strokeWidth: 2, fill: null, rotation: 0, createdAt: 1,
    };
    const s2: Shape = {
      id: 'sh-2', type: 'shape', shapeType: 'rectangle',
      x: 2000, y: 2000, width: 100, height: 80, color: '#000', strokeWidth: 2, fill: null, rotation: 0, createdAt: 2,
    };
    shapes.setShapes([s1, s2]);
    shapes.renderShapes(mockCtx, DEFAULT_PAGE_LAYER_ID, undefined, { left: 0, top: 0, right: 300, bottom: 300 });
    assert.deepEqual(renderedRects, [50]);
    });
  } finally {
    if (prevDoc === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = prevDoc;
  }
});

test('DrawingEngine zeros aux buffers, preserves Images -> Strokes -> Shapes on selection drag, and halts detached paints', async () => {
  const prevDoc = (globalThis as any).document;
  const prevWin = (globalThis as any).window;
  try {
    const harness = createCanvasHarness();
    (globalThis as any).document = {
      createElement: () => harness.makeMockCanvas(false),
      documentElement: { classList: { contains: () => false } },
    };
    (globalThis as any).window = {
      devicePixelRatio: 1,
      location: { search: '' },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    };

    await withViteServer(async server => {
    const [{ DrawingEngine }, { ViewportManager }, { ShapeManager }, { ImageManager }, { LayerManager }, { RulerManager }, { LaserManager }] = await Promise.all([
      server.ssrLoadModule('/src/components/notebook/engine/DrawingEngine.ts'),
      server.ssrLoadModule('/src/components/notebook/engine/ViewportManager.ts'),
      server.ssrLoadModule('/src/components/notebook/engine/ShapeManager.ts'),
      server.ssrLoadModule('/src/components/notebook/engine/ImageManager.ts'),
      server.ssrLoadModule('/src/components/notebook/engine/LayerManager.ts'),
      server.ssrLoadModule('/src/components/notebook/engine/RulerManager.ts'),
      server.ssrLoadModule('/src/components/notebook/engine/LaserManager.ts'),
    ]);

    const viewport = new ViewportManager();
    const shapes = new ShapeManager(viewport);
    const images = new ImageManager(viewport);
    const layers = new LayerManager();
    const engine = new DrawingEngine(viewport, shapes, images, layers, new RulerManager(), new LaserManager());

    const liveCanvas = harness.makeMockCanvas(true);
    engine.setCanvas(liveCanvas, 800, 600);

    const imgObj = { complete: true, naturalWidth: 60, width: 60, height: 60, tagName: 'IMG' } as any;
    (images as any).imageCache.set('img-file', imgObj);

    const stroke = makeStroke('sel-stroke', 40, 40, 60, 60, 1);
    const shape: Shape = {
      id: 'sel-shape', type: 'shape', shapeType: 'rectangle',
      x: 40, y: 40, width: 80, height: 80, color: '#111', strokeWidth: 2, fill: '#eee', rotation: 0, createdAt: 2,
    };
    const image: ImageObject = {
      id: 'sel-img', type: 'image',
      x: 40, y: 40, width: 60, height: 60, fileId: 'img-file', rotation: 0, createdAt: 3,
    };

    engine.setStrokes([stroke], undefined, false);
    shapes.setShapes([shape]);
    images.setImages([image]);

    const dragOrder: string[] = [];
    const origRenderImage = images.renderImage.bind(images);
    images.renderImage = (ctx: any, img: ImageObject) => {
      dragOrder.push(`image:${img.id}`);
      return origRenderImage(ctx, img);
    };
    const origRenderTransformingStroke = (engine as any).renderTransformingStroke.bind(engine);
    (engine as any).renderTransformingStroke = (ctx: any, st: Stroke, t: any) => {
      dragOrder.push(`stroke:${st.id}`);
      return origRenderTransformingStroke(ctx, st, t);
    };
    const origRenderShape = shapes.renderShape.bind(shapes);
    shapes.renderShape = (ctx: any, sh: Shape) => {
      dragOrder.push(`shape:${sh.id}`);
      return origRenderShape(ctx, sh);
    };

    engine.beginSelectionDrag([
      { id: 'sel-shape', type: 'shape' },
      { id: 'sel-stroke', type: 'stroke' },
      { id: 'sel-img', type: 'image' },
    ]);
    dragOrder.length = 0;
    harness.drawEvents.length = 0;
    engine.redraw();

    assert.deepEqual(dragOrder, ['image:sel-img', 'stroke:sel-stroke', 'shape:sel-shape']);

    const backingMap: Map<any, any> = (engine as any).selectionBackingCanvases;
    const allocatedBackings = [...backingMap.values()];
    assert.ok(allocatedBackings.length > 0 && allocatedBackings[0].width > 0);

    engine.endSelectionDrag();
    assert.equal(backingMap.size, 0);
    assert.equal(allocatedBackings[0].width, 0);
    assert.equal(allocatedBackings[0].height, 0);

    engine.startLasso();
    const lassoCanvas = (engine as any).lassoBackingCanvas;
    assert.ok(lassoCanvas && lassoCanvas.width > 0);
    engine.endLasso();
    assert.equal((engine as any).lassoBackingCanvas, null);
    assert.equal(lassoCanvas.width, 0);
    assert.equal(lassoCanvas.height, 0);

    engine.warmSelectionBacking();
    const warmed = [...backingMap.values()];
    assert.ok(warmed.length > 0 && warmed[0].width > 0);
    engine.resize(820, 620);
    assert.equal(backingMap.size, 0);
    assert.equal(warmed[0].width, 0);

    engine.setRetainedOffscreen(true);
    harness.drawEvents.length = 0;
    engine.redraw();
    assert.equal(harness.drawEvents.length, 0, 'retainedOffscreen engine does not paint');

    engine.setRetainedOffscreen(false);
    liveCanvas.isConnected = false;
    engine.redraw();
    assert.equal(harness.drawEvents.length, 0, 'disconnected connected-origin canvas does not paint');

    const destroyCanvas = harness.makeMockCanvas(true);
    engine.setCanvas(destroyCanvas, 800, 600);
    assert.ok(destroyCanvas.width > 0);
    engine.destroy();
    assert.equal(destroyCanvas.width, 0);
    assert.equal(destroyCanvas.height, 0);
    });
  } finally {
    if (prevDoc === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = prevDoc;
    if (prevWin === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWin;
  }
});

test('workspaceStore debounces passive setActivePage writes and flushes on unload/pagehide', async () => {
  const prevWin = (globalThis as any).window;
  const prevDoc = (globalThis as any).document;
  const storage = new Map<string, string>();
  let setCalls = 0;
  const listeners: Record<string, Array<() => void>> = {};

  try {
    await withViteServer(async server => {
    const [{ useWorkspaceStore, flushDeferredWorkspaceStorage }, { notebookRepository }] = await Promise.all([
      server.ssrLoadModule('/src/stores/workspaceStore.ts'),
      server.ssrLoadModule('/src/repositories/NotebookRepository.ts'),
    ]);

    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => { setCalls += 1; storage.set(k, v); },
        removeItem: (k: string) => { storage.delete(k); },
      },
      addEventListener: (ev: string, cb: () => void) => { (listeners[ev] ??= []).push(cb); },
    };
    (globalThis as any).document = {
      visibilityState: 'visible',
      addEventListener: (ev: string, cb: () => void) => { (listeners[ev] ??= []).push(cb); },
    };

    notebookRepository.updateLastOpened = async () => {};
    notebookRepository.updatePageLastOpened = async () => {};

    useWorkspaceStore.setState({
      workspaces: [{ id: 'ws1', name: 'W', order: 0, createdAt: 1, updatedAt: 1 }],
      notebooks: [{ id: 'nb1', workspaceId: 'ws1', folderId: null, name: 'N', order: 0, isExpanded: true, createdAt: 1, updatedAt: 1 }],
      notebookSections: [{ id: 'sec1', workspaceId: 'ws1', notebookId: 'nb1', name: 'S', order: 0, isExpanded: true, createdAt: 1, updatedAt: 1 }],
      notebookPages: [
        { id: 'p1', sectionId: 'sec1', notebookId: 'nb1', title: 'P1', type: 'notebook', order: 0, createdAt: 1, updatedAt: 1 },
        { id: 'p2', sectionId: 'sec1', notebookId: 'nb1', title: 'P2', type: 'notebook', order: 1, createdAt: 1, updatedAt: 1 },
        { id: 'p3', sectionId: 'sec1', notebookId: 'nb1', title: 'P3', type: 'notebook', order: 2, createdAt: 1, updatedAt: 1 },
      ],
      activeWorkspaceId: 'ws1',
      activeNotebookId: 'nb1',
      activeNotebookSectionId: 'sec1',
      activePageId: 'p1',
      activeCanvasId: null,
    });

    setCalls = 0;
    await useWorkspaceStore.getState().setActivePage('p2', false);
    assert.equal(useWorkspaceStore.getState().activePageId, 'p2');
    assert.equal(setCalls, 0, 'passive setActivePage(id, false) must NOT write localStorage synchronously');

    await useWorkspaceStore.getState().setActivePage('p3', false);
    assert.equal(setCalls, 0);

    for (const cb of listeners.pagehide ?? []) cb();
    assert.equal(storage.get('panvas.activePageId'), 'p3');
    assert.equal(setCalls, 1, 'deferred writes coalesce to final value on flush');

    await useWorkspaceStore.getState().setActivePage('p2', true);
    assert.equal(storage.get('panvas.activePageId'), 'p2');
    assert.ok(setCalls >= 2);
    flushDeferredWorkspaceStorage();
    });
  } finally {
    if (prevWin === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWin;
    if (prevDoc === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = prevDoc;
  }
});
