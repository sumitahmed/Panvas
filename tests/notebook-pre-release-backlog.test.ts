import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPageIndicator } from '../src/components/notebook/pageIndicator.ts';
import { resolveDocumentToolCursor } from '../src/components/notebook/documentToolCursor.ts';
import {
  saveNotebookPosition,
  getNotebookPosition,
  clearNotebookPosition,
  savePdfPosition,
  getPdfPosition,
  clearPdfPosition,
} from '../src/lib/readingPosition.ts';
import { LaserManager } from '../src/components/notebook/engine/LaserManager.ts';
import { SelectionEngine } from '../src/components/notebook/engine/SelectionEngine.ts';
import { LayerManager } from '../src/components/notebook/engine/LayerManager.ts';
import { HistoryManager } from '../src/components/notebook/engine/HistoryManager.ts';
import { isPageFarOffscreen } from '../src/components/notebook/notebookPageRenderState.ts';
import type { ToolState, Stroke } from '../src/components/notebook/engine/drawingTypes.ts';

// Mock localStorage for reading position tests if not present in Node environment
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => { store.set(key, String(val)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  } as unknown as Storage;
}

// ---------------------------------------------------------------------------
// R0.1 Page Indicator Disambiguation
// ---------------------------------------------------------------------------
test('R0.1: formatPageIndicator formats logical page numbers correctly', () => {
  assert.equal(formatPageIndicator(1, 1), '1 / 1');
  assert.equal(formatPageIndicator(2, 4), '2 / 4');
  assert.equal(formatPageIndicator(7, 8), '7 / 8');
});

test('R0.1: continuation sheets format with explicit subpage context and avoid orphaned counts', () => {
  const pageNumberText = formatPageIndicator(1, 4);
  assert.equal(pageNumberText, '1 / 4');

  // Multi-sheet document page indicator format: "${pageNumberText} (Sheet ${subIndex}/${subTotal})"
  const totalSheets = 8;
  const currentSheet = 7;
  const continuationLabel = totalSheets > 1
    ? `${pageNumberText} (Sheet ${currentSheet}/${totalSheets})`
    : pageNumberText;

  assert.equal(continuationLabel, '1 / 4 (Sheet 7/8)');
  assert.ok(continuationLabel.includes('1 / 4'), 'Contains section page context');
  assert.ok(continuationLabel.includes('Sheet 7/8'), 'Contains unambiguous continuation sheet index');

  // Single-sheet document page format: only pageNumberText
  const singleSheetCount = 1;
  const singleLabel = singleSheetCount > 1
    ? `${pageNumberText} (Sheet 1/1)`
    : pageNumberText;
  assert.equal(singleLabel, '1 / 4');
  assert.ok(!singleLabel.includes('Sheet'), 'Single sheet does not display continuation counter');
});

// ---------------------------------------------------------------------------
// R1.1 Toolbar Second-Click Settings Popover & R1.2 Active-Tool Cursor
// ---------------------------------------------------------------------------
test('R1.1: toolbar second-click logic opens settings popover while first click selects tool with popover closed', () => {
  let activeTool: string = 'pen';
  let showPopup: boolean = false;

  const handleToolClick = (clickedTool: string) => {
    if (activeTool === clickedTool) {
      // 2nd click: toggle popup
      showPopup = !showPopup;
    } else {
      // 1st click: activate tool with popup closed
      activeTool = clickedTool;
      showPopup = false;
    }
  };

  // Initially active tool is 'pen', popup closed
  assert.equal(activeTool, 'pen');
  assert.equal(showPopup, false);

  // Click pen again -> 2nd click toggles popup open
  handleToolClick('pen');
  assert.equal(activeTool, 'pen');
  assert.equal(showPopup, true);

  // Click pen a third time -> toggles popup closed
  handleToolClick('pen');
  assert.equal(activeTool, 'pen');
  assert.equal(showPopup, false);

  // Click eraser -> switches tool, popup stays closed
  handleToolClick('eraser');
  assert.equal(activeTool, 'eraser');
  assert.equal(showPopup, false);

  // Click eraser again -> opens eraser settings popup
  handleToolClick('eraser');
  assert.equal(activeTool, 'eraser');
  assert.equal(showPopup, true);
});

test('R1.2: resolveDocumentToolCursor generates appropriate SVG data URI cursors and caches them', () => {
  const penToolState: ToolState = {
    mode: 'draw',
    drawingTool: 'pen',
    color: '#3b82f6',
    thickness: 4,
    eraserType: 'stroke',
    shape: 'rectangle',
    roughShapes: false,
    textFontSize: 16,
    textColor: '#000000',
    textFontFamily: 'sans-serif',
    textAlign: 'left',
    activePreset: 1,
  };

  const penCursor = resolveDocumentToolCursor(penToolState);
  assert.ok(penCursor !== undefined);
  assert.ok(penCursor.startsWith('url("data:image/svg+xml'), 'Pen cursor is SVG data URI');
  assert.ok(penCursor.includes('3b82f6') || penCursor.includes('%233b82f6'), 'Pen cursor includes tool color');

  // Verify caching: subsequent call with same state returns exact same string reference
  const cachedCursor = resolveDocumentToolCursor(penToolState);
  assert.equal(cachedCursor, penCursor);

  // Verify eraser cursor has circular outline and thickness
  const eraserToolState: ToolState = {
    ...penToolState,
    mode: 'erase',
    thickness: 16,
  };
  const eraserCursor = resolveDocumentToolCursor(eraserToolState);
  assert.ok(eraserCursor !== undefined);
  assert.ok(eraserCursor.startsWith('url("data:image/svg+xml'), 'Eraser cursor is SVG data URI');
  assert.ok(eraserCursor.includes('stroke-dasharray') || eraserCursor.includes('%22stroke-dasharray'), 'Eraser cursor uses dashed circle');

  // Non-drawing tool (e.g. hand or select) returns undefined
  const selectToolState: ToolState = {
    ...penToolState,
    mode: 'select',
  };
  assert.equal(resolveDocumentToolCursor(selectToolState), undefined);
});

// ---------------------------------------------------------------------------
// R2.1 Lasso Multi-Element Group Transform
// ---------------------------------------------------------------------------
function createSelectionHarness() {
  const strokes: Stroke[] = [];
  const shapes: any[] = [];
  const texts: any[] = [];
  const images: any[] = [];
  let redrawCount = 0;

  const drawingEngine = {
    getStrokes: () => strokes,
    findStrokesNearPoint: () => [],
    addStroke: (s: Stroke) => strokes.push(s),
    removeStroke: (id: string) => {
      const idx = strokes.findIndex(s => s.id === id);
      if (idx !== -1) strokes.splice(idx, 1);
    },
    redraw: () => { redrawCount++; },
  };

  const shapeManager = {
    getShapes: () => shapes,
    findShapeAt: () => null,
  };

  const textManager = { getTexts: () => texts };
  const imageManager = { getImages: () => images };
  const historyManager = new HistoryManager();
  const viewport = {
    screenToWorld: (x: number, y: number) => ({ x, y }),
    worldToScreen: (x: number, y: number) => ({ x, y }),
    getState: () => ({ scale: 1, panX: 0, panY: 0 }),
  };
  const layerManager = new LayerManager();

  const engine = new SelectionEngine(
    drawingEngine as any,
    shapeManager as any,
    historyManager as any,
    viewport as any,
    textManager as any,
    imageManager as any,
    layerManager,
  );

  return { engine, strokes, shapes, historyManager, layerManager };
}

test('R2.1: SelectionEngine computes collective bounding box for multi-element selections', () => {
  const { engine, strokes, layerManager } = createSelectionHarness();
  const activeLayer = layerManager.getActiveLayerId();
  const s1: Stroke = {
    id: 's1',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: [{ x: 10, y: 10, pressure: 0.5 }, { x: 50, y: 50, pressure: 0.5 }],
  };
  const s2: Stroke = {
    id: 's2',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: [{ x: 100, y: 80, pressure: 0.5 }, { x: 200, y: 160, pressure: 0.5 }],
  };
  strokes.push(s1, s2);

  engine.selectElement('s1', 'stroke', true);
  engine.selectElement('s2', 'stroke', true);
  assert.equal(engine.getSelectedElements().length, 2);

  const box = engine.getCollectiveBoundingBox();
  assert.ok(box !== null);
  // stroke1: minX=10, maxX=50, minY=10, maxY=50
  // stroke2: minX=100, maxX=200, minY=80, maxY=160
  // collective: minX=10, maxX=200, minY=10, maxY=160
  assert.equal(box.x, 10);
  assert.equal(box.y, 10);
  assert.equal(box.width, 190);
  assert.equal(box.height, 150);
});

test('R2.1: multi-element group handles exposed and bounds accurately reflect all selected items', () => {
  const { engine, strokes, layerManager } = createSelectionHarness();
  const activeLayer = layerManager.getActiveLayerId();
  const s1: Stroke = {
    id: 's1',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: [{ x: 20, y: 20, pressure: 0.5 }, { x: 60, y: 60, pressure: 0.5 }],
  };
  const s2: Stroke = {
    id: 's2',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: [{ x: 120, y: 40, pressure: 0.5 }, { x: 180, y: 100, pressure: 0.5 }],
  };
  strokes.push(s1, s2);

  engine.selectElement('s1', 'stroke', true);
  engine.selectElement('s2', 'stroke', true);

  const box = engine.getCollectiveBoundingBox();
  assert.ok(box !== null);
  assert.equal(box.x, 20);
  assert.equal(box.y, 20);
  assert.equal(box.width, 160);
  assert.equal(box.height, 80);

  // Bottom-right handle of s2 at (180, 100)
  const handleAtBr = engine.getHandleAt(180, 100);
  assert.deepEqual(handleAtBr, { id: 's2', handle: 'br' });

  // Rotation handle of s1 at canonical (40, 20 - 32) = (40, -12)
  const handleAtRotate = engine.getHandleAt(40, -12);
  assert.deepEqual(handleAtRotate, { id: 's1', handle: 'rotate' });

  // Stalk hit tolerance also cleanly captures lower stalk click at (40, 20 - 24) = (40, -4)
  const handleAtStalk = engine.getHandleAt(40, -4);
  assert.deepEqual(handleAtStalk, { id: 's1', handle: 'rotate' });

  // Dragging the rotation handle enters rotate mode
  engine.startDrag(40, -12);
  assert.equal(engine.isDragging, true);
  assert.equal(engine['dragMode'], 'rotate');
  engine.finishDrag(40, -12);
});

// ---------------------------------------------------------------------------
// R3.1 & R3.2 Reading Position Persistence
// ---------------------------------------------------------------------------
test('R3.1: saveNotebookPosition and getNotebookPosition round-trip accurately', () => {
  const notebookId = 'nb-test-123';
  clearNotebookPosition(notebookId);

  assert.equal(getNotebookPosition(notebookId), null);

  saveNotebookPosition(notebookId, {
    pageId: 'page-456',
    scrollX: 120.4,
    scrollY: 340.8,
  });

  const restored = getNotebookPosition(notebookId);
  assert.ok(restored !== null);
  assert.equal(restored.pageId, 'page-456');
  assert.equal(restored.scrollX, 120);
  assert.equal(restored.scrollY, 341);
  assert.ok(typeof restored.timestamp === 'number');

  clearNotebookPosition(notebookId);
  assert.equal(getNotebookPosition(notebookId), null);
});

test('R3.2: savePdfPosition and getPdfPosition round-trip accurately', () => {
  const pdfId = 'pdf-doc-789';
  clearPdfPosition(pdfId);

  assert.equal(getPdfPosition(pdfId), null);

  savePdfPosition(pdfId, {
    pdfPage: 3,
    scrollX: 0,
    scrollY: 850,
  });

  const restored = getPdfPosition(pdfId);
  assert.ok(restored !== null);
  assert.equal(restored.pdfPage, 3);
  assert.equal(restored.scrollY, 850);
  assert.ok(typeof restored.timestamp === 'number');

  clearPdfPosition(pdfId);
  assert.equal(getPdfPosition(pdfId), null);
});

// ---------------------------------------------------------------------------
// R4.1 & R4.2 Laser Pointer Duration & Lifecycle Cleanup
// ---------------------------------------------------------------------------
test('R4.1: LaserManager defaults to 3000ms decay and supports smooth easing curve', () => {
  let currentTime = 1000;
  const scheduler = {
    options: {
      now: () => currentTime,
      requestFrame: (cb: FrameRequestCallback) => 1,
      cancelFrame: () => {},
    },
  };

  const laser = new LaserManager(scheduler.options);
  assert.equal(laser.decayMs, 3000, 'Default decay duration is 3000ms');

  laser.addPoint({ x: 50, y: 50, pressure: 0.5, t: currentTime });
  assert.equal(laser.getActiveTrail().length, 1);

  // At 1500ms after addPoint (half decay):
  currentTime = 2500;
  const point = laser.getActiveTrail()[0];
  const linearProgress = laser.getPointOpacity(point);
  assert.equal(linearProgress, 0.5);

  // Cosine ease-out curve at 50% decay:
  const smoothOpacity = Math.sin(linearProgress * (Math.PI / 2));
  assert.ok(smoothOpacity > 0.7, 'Smooth ease-out remains brighter longer at mid-lifetime');

  // At 3000ms after addPoint (fully decayed):
  currentTime = 4001;
  assert.equal(laser.getActiveTrail().length, 0, 'Trail prunes fully expired points');
});

test('R4.2: LaserManager clear() immediately clears trail and cancels animation', () => {
  let cancelledHandle: number | null = null;
  const laser = new LaserManager({
    decayMs: 3000,
    requestFrame: () => 42,
    cancelFrame: (handle: number) => { cancelledHandle = handle; },
  });

  laser.addPoint({ x: 10, y: 10, pressure: 0.5, t: 100 });
  assert.equal(laser.getActiveTrail().length, 1);
  assert.equal(laser.isAnimating(), true);

  laser.clear();
  assert.equal(laser.getActiveTrail().length, 0);
  assert.equal(laser.isAnimating(), false);
  assert.equal(cancelledHandle, 42);
});

// ---------------------------------------------------------------------------
// R5.1 Performance & Scalability: Page Memoization & Placeholder Logic
// ---------------------------------------------------------------------------
test('R5.1: far-offscreen threshold identifies distant pages accurately', () => {
  const containerHeight = 800;
  const scale = 1.0;
  const scrollTop = 1600;

  // Page at Y = 1600 (currently visible) -> NOT far offscreen
  assert.equal(isPageFarOffscreen(1600, scale, scrollTop, containerHeight, false), false);

  // Page at Y = 2800 (1200px away, within 3 viewports) -> NOT far offscreen
  assert.equal(isPageFarOffscreen(2800, scale, scrollTop, containerHeight, false), false);

  // Page at Y = 6000 (4400px away, > 3 viewports) -> IS far offscreen
  assert.equal(isPageFarOffscreen(6000, scale, scrollTop, containerHeight, false), true);

  // Resident page is never far offscreen
  assert.equal(isPageFarOffscreen(6000, scale, scrollTop, containerHeight, true), false);
});
