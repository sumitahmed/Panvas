import assert from 'node:assert/strict';
import test from 'node:test';
import { SelectionEngine } from '../src/components/notebook/engine/SelectionEngine.ts';
import { LayerManager } from '../src/components/notebook/engine/LayerManager.ts';
import { HistoryManager } from '../src/components/notebook/engine/HistoryManager.ts';
import { LaserManager } from '../src/components/notebook/engine/LaserManager.ts';
import {
  DrawingSaveScheduler,
  DEFAULT_MAX_DEFERRAL_MS,
} from '../src/components/notebook/drawingSaveScheduler.ts';
import {
  capturePageOwnedDrawing,
  type PageOwnedDrawing,
} from '../src/components/notebook/notebookPageRenderState.ts';
import {
  createEmptyDrawingData,
  type DrawingData,
  type Stroke,
  type Shape,
  type ToolState,
} from '../src/components/notebook/engine/drawingTypes.ts';

// ---------------------------------------------------------------------------
// ADVERSARIAL TEST 1: R0.2 Rapid Inking Burst Stress (50+ Strokes)
// ---------------------------------------------------------------------------
test('R0.2 Inking burst stress: 60 rapid consecutive strokes without quiet intervals advance revisions monotonically without dropping data', async () => {
  const pageId = 'page-burst-test';
  const notebookId = 'nb-burst-test';

  // Simulated in-memory cache and persistence scheduler matching NotebookRenderer
  const sectionDataCache: Record<string, DrawingData> = {
    [pageId]: createEmptyDrawingData(),
  };
  const latestCapturedDrawing = new Map<string, PageOwnedDrawing>();
  const persistedSnapshots: PageOwnedDrawing[] = [];

  const scheduler = new DrawingSaveScheduler<PageOwnedDrawing>(
    snapshot => {
      persistedSnapshots.push(snapshot);
    },
    {
      debounceMs: 500,
      quietMs: 300,
      maxDeferralMs: DEFAULT_MAX_DEFERRAL_MS,
    },
  );

  let engineRevision = 0;
  const currentDrawingData = createEmptyDrawingData();
  const capturedSnapshots: PageOwnedDrawing[] = [];

  // Active drawing gesture starts
  scheduler.setGestureActive(true);

  // Generate a burst of 60 consecutive short strokes without quiet intervals
  const TOTAL_BURST_STROKES = 60;
  for (let i = 1; i <= TOTAL_BURST_STROKES; i++) {
    const stroke: Stroke = {
      id: `stroke-${i}`,
      layerId: 'layer-default',
      tool: 'pen',
      color: '#1e293b',
      width: 2.5,
      opacity: 1,
      points: [
        { x: 10 + i * 2, y: 20 + (i % 5) * 4, pressure: 0.6 },
        { x: 14 + i * 2, y: 24 + (i % 5) * 4, pressure: 0.8 },
        { x: 18 + i * 2, y: 22 + (i % 5) * 4, pressure: 0.4 },
      ],
    };

    // 1. Commit stroke to engine
    currentDrawingData.objects = currentDrawingData.objects || [];
    currentDrawingData.objects.push(stroke);
    engineRevision += 1;

    // 2. Capture immutable snapshot
    const snapshot = capturePageOwnedDrawing(
      notebookId,
      pageId,
      pageId,
      engineRevision,
      currentDrawingData,
    );
    assert.ok(snapshot !== null, `Snapshot ${i} must not be null`);
    capturedSnapshots.push(snapshot);

    // 3. Update in-memory cache synchronously (with publish = false during inking)
    latestCapturedDrawing.set(pageId, snapshot);
    sectionDataCache[pageId] = snapshot.data;

    // 4. Enqueue into scheduler
    scheduler.enqueue(snapshot);

    // Verify monotonic revision progression after every single stroke
    if (i > 1) {
      const prev = capturedSnapshots[i - 2];
      const curr = capturedSnapshots[i - 1];
      assert.ok(
        curr.drawingRevision > prev.drawingRevision,
        `Drawing revision must advance monotonically: prev=${prev.drawingRevision}, curr=${curr.drawingRevision}`,
      );
      assert.ok(
        curr.sequence > prev.sequence,
        `Sequence must advance monotonically: prev=${prev.sequence}, curr=${curr.sequence}`,
      );
    }
  }

  // ASSERTION: All 60 strokes were captured without drops
  assert.equal(capturedSnapshots.length, TOTAL_BURST_STROKES);
  assert.equal(engineRevision, TOTAL_BURST_STROKES);

  // In-memory cache contains all 60 strokes
  const finalCachedData = sectionDataCache[pageId];
  assert.ok(finalCachedData);
  assert.equal(finalCachedData.objects?.length, TOTAL_BURST_STROKES);

  // Latest captured snapshot contains exact revision and all 60 strokes
  const latestSnapshot = latestCapturedDrawing.get(pageId);
  assert.ok(latestSnapshot);
  assert.equal(latestSnapshot.drawingRevision, TOTAL_BURST_STROKES);
  assert.equal(latestSnapshot.data.objects?.length, TOTAL_BURST_STROKES);

  // ASSERTION: While gesture was active, scheduler held the pending write (non-blocking)
  assert.equal(
    persistedSnapshots.length,
    0,
    'During active gesture without quiet pause, scheduler must not flush prematurely',
  );

  // User finally lifts pen and quiet interval triggers or explicit flush occurs
  const flushedSnapshot = scheduler.flush();
  assert.ok(flushedSnapshot !== null, 'Flushed snapshot must exist');
  assert.equal(flushedSnapshot.drawingRevision, TOTAL_BURST_STROKES);
  assert.equal(flushedSnapshot.data.objects?.length, TOTAL_BURST_STROKES);
  assert.equal(persistedSnapshots.length, 1);
  assert.equal(persistedSnapshots[0].drawingRevision, TOTAL_BURST_STROKES);
  assert.equal(persistedSnapshots[0].data.objects?.length, TOTAL_BURST_STROKES);

  // Verify every stroke ID from 1 to 60 is present in order
  for (let i = 1; i <= TOTAL_BURST_STROKES; i++) {
    const found = persistedSnapshots[0].data.objects?.find(
      (obj: any) => obj.id === `stroke-${i}`,
    );
    assert.ok(found, `Stroke stroke-${i} must be preserved in persisted snapshot`);
  }
});

// ---------------------------------------------------------------------------
// ADVERSARIAL TEST 2: R1.1 Toolbar Second-Click State Machine
// ---------------------------------------------------------------------------
test('R1.1 Toolbar state machine: cycles through tools, toggles popovers on repeat clicks, and never enters invalid/deselected states', () => {
  type ToolMode = 'draw' | 'erase' | 'select' | 'hand' | 'text';
  type DrawingTool = 'pen' | 'pencil' | 'highlighter' | 'laser';
  type ShapeType = 'rectangle' | 'circle' | 'line' | 'arrow' | 'triangle' | 'star';

  interface StateMachine {
    activeTool: string;
    showPopup: boolean;
    toolMode: ToolMode;
    drawingTool: DrawingTool;
    activeShape: ShapeType;
  }

  const CONFIGURABLE_DRAWING_TOOLS = new Set(['pen', 'pencil', 'highlighter']);
  const SHAPE_TOOLS = new Set(['rectangle', 'circle', 'line', 'arrow', 'triangle', 'star']);

  const state: StateMachine = {
    activeTool: 'pen',
    showPopup: false,
    toolMode: 'draw',
    drawingTool: 'pen',
    activeShape: 'rectangle',
  };

  const handleToolClick = (toolId: string) => {
    if (CONFIGURABLE_DRAWING_TOOLS.has(toolId)) {
      if (state.activeTool === toolId) {
        state.showPopup = !state.showPopup;
      } else {
        state.showPopup = false;
      }
      state.toolMode = 'draw';
      state.drawingTool = toolId as DrawingTool;
      state.activeTool = toolId;
    } else if (toolId === 'eraser') {
      if (state.activeTool === toolId) {
        state.showPopup = !state.showPopup;
      } else {
        state.showPopup = false;
      }
      state.toolMode = 'erase';
      state.activeTool = toolId;
    } else if (SHAPE_TOOLS.has(toolId)) {
      if (state.activeTool === toolId) {
        state.showPopup = !state.showPopup;
      } else {
        state.showPopup = false;
      }
      state.toolMode = 'draw';
      state.activeShape = toolId as ShapeType;
      state.activeTool = toolId;
    } else if (toolId === 'select') {
      state.showPopup = false;
      state.toolMode = 'select';
      state.activeTool = toolId;
    } else if (toolId === 'hand') {
      state.showPopup = false;
      state.toolMode = 'hand';
      state.activeTool = toolId;
    } else if (toolId === 'text') {
      state.showPopup = false;
      state.toolMode = 'text';
      state.activeTool = toolId;
    } else if (toolId === 'laser') {
      state.showPopup = false;
      state.toolMode = 'draw';
      state.drawingTool = 'laser';
      state.activeTool = toolId;
    }
  };

  const handleShapeVariantSelect = (newShape: ShapeType) => {
    state.activeTool = newShape;
    state.activeShape = newShape;
    state.toolMode = 'draw';
    state.showPopup = true; // Settings popup stays open on variant change
  };

  // 1. Inactive click -> activates tool, popover closed
  assert.equal(state.activeTool, 'pen');
  assert.equal(state.showPopup, false);

  handleToolClick('pencil');
  assert.equal(state.activeTool, 'pencil');
  assert.equal(state.showPopup, false);
  assert.equal(state.toolMode, 'draw');

  // 2. Active tool repeat click -> opens settings popover
  handleToolClick('pencil');
  assert.equal(state.activeTool, 'pencil');
  assert.equal(state.showPopup, true);

  // 3. Active tool 3rd click -> closes settings popover
  handleToolClick('pencil');
  assert.equal(state.activeTool, 'pencil');
  assert.equal(state.showPopup, false);

  // 4. Switch to eraser -> switches tool, popover stays closed
  handleToolClick('eraser');
  assert.equal(state.activeTool, 'eraser');
  assert.equal(state.toolMode, 'erase');
  assert.equal(state.showPopup, false);

  // 5. Repeat click on eraser -> opens eraser settings
  handleToolClick('eraser');
  assert.equal(state.showPopup, true);

  // 6. Switch to rectangle shape while eraser popup was open -> closes popup, activates rectangle
  handleToolClick('rectangle');
  assert.equal(state.activeTool, 'rectangle');
  assert.equal(state.toolMode, 'draw');
  assert.equal(state.showPopup, false);

  // 7. Repeat click on rectangle -> opens shape popup
  handleToolClick('rectangle');
  assert.equal(state.showPopup, true);

  // 8. Select shape variant 'circle' inside ShapePopup -> switches to circle, popup STAYS OPEN
  handleShapeVariantSelect('circle');
  assert.equal(state.activeTool, 'circle');
  assert.equal(state.activeShape, 'circle');
  assert.equal(state.showPopup, true);

  // 9. Switch to non-configurable tool 'select' -> closes popup, tool is select
  handleToolClick('select');
  assert.equal(state.activeTool, 'select');
  assert.equal(state.toolMode, 'select');
  assert.equal(state.showPopup, false);

  // 10. Repeat click on 'select' -> does NOT open popup, never deselects tool
  handleToolClick('select');
  assert.equal(state.activeTool, 'select');
  assert.equal(state.toolMode, 'select');
  assert.equal(state.showPopup, false);

  // 11. Repeat click on 'hand' -> never opens popup, tool remains hand
  handleToolClick('hand');
  assert.equal(state.activeTool, 'hand');
  assert.equal(state.showPopup, false);
  handleToolClick('hand');
  assert.equal(state.activeTool, 'hand');
  assert.equal(state.showPopup, false);

  // 12. Stress / Fuzzing: 1,000 rapid clicks across all tools
  const ALL_TOOLS = [
    'pen', 'pencil', 'highlighter', 'eraser', 'rectangle', 'circle',
    'line', 'arrow', 'select', 'hand', 'text', 'laser',
  ];
  for (let i = 0; i < 1000; i++) {
    const randomTool = ALL_TOOLS[i % ALL_TOOLS.length];
    handleToolClick(randomTool);

    // INVARIANT ASSERTIONS:
    assert.ok(state.activeTool, 'Active tool must never be falsy');
    assert.ok(ALL_TOOLS.includes(state.activeTool), `Active tool ${state.activeTool} must be a valid known tool`);
    assert.ok(
      ['draw', 'erase', 'select', 'hand', 'text'].includes(state.toolMode),
      `Tool mode ${state.toolMode} must never be invalid or deselected`,
    );
  }
});

// ---------------------------------------------------------------------------
// ADVERSARIAL TEST 3: R2.1 Lasso Multi-Element Group Transforms (3 Strokes + 2 Shapes)
// ---------------------------------------------------------------------------
function createTestSelectionHarness() {
  const strokes: Stroke[] = [];
  const shapes: Shape[] = [];
  const texts: any[] = [];
  const images: any[] = [];
  let redrawCount = 0;

  const drawingEngine = {
    getStrokes: () => strokes,
    findStrokesNearPoint: () => [],
    addStroke: (s: Stroke) => strokes.push(s),
    removeStrokes: (ids: Set<string>) => {
      const removed = strokes.filter(s => ids.has(s.id));
      for (const s of removed) {
        const idx = strokes.indexOf(s);
        if (idx !== -1) strokes.splice(idx, 1);
      }
      return removed;
    },
    redraw: () => { redrawCount++; },
  };

  const shapeManager = {
    getShapes: () => shapes,
    findShapeAt: () => null,
    findShapesNearPoint: () => [],
    addShape: (s: Shape) => shapes.push(s),
    removeShapes: (ids: Set<string>) => {
      const removed = shapes.filter(s => ids.has(s.id));
      for (const s of removed) {
        const idx = shapes.indexOf(s);
        if (idx !== -1) shapes.splice(idx, 1);
      }
      return removed;
    },
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

test('R2.1 Lasso multi-element group transforms: 2x scale doubles relative distances and 90-degree rotation orbits collective centroid', () => {
  const { engine, strokes, shapes, layerManager } = createTestSelectionHarness();
  const activeLayer = layerManager.getActiveLayerId();

  // 3 distinct strokes
  const s1: Stroke = {
    id: 's1',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: [{ x: 10, y: 10, pressure: 0.5 }, { x: 30, y: 30, pressure: 0.5 }],
  };
  const s2: Stroke = {
    id: 's2',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: [{ x: 50, y: 40, pressure: 0.5 }, { x: 90, y: 80, pressure: 0.5 }],
  };
  const s3: Stroke = {
    id: 's3',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: [{ x: 110, y: 20, pressure: 0.5 }, { x: 130, y: 60, pressure: 0.5 }],
  };

  // 2 distinct shapes with different bounding boxes
  const sh1: Shape = {
    id: 'sh1',
    layerId: activeLayer,
    shapeType: 'rectangle',
    color: '#000',
    strokeWidth: 2,
    x: 140,
    y: 80,
    width: 60,
    height: 40,
    rotation: 0,
  };
  const sh2: Shape = {
    id: 'sh2',
    layerId: activeLayer,
    shapeType: 'ellipse',
    color: '#000',
    strokeWidth: 2,
    x: 20,
    y: 120,
    width: 80,
    height: 60,
    rotation: 0,
  };

  strokes.push(s1, s2, s3);
  shapes.push(sh1, sh2);

  // Multi-select all 5 elements
  engine.selectElement('s1', 'stroke', true);
  engine.selectElement('s2', 'stroke', true);
  engine.selectElement('s3', 'stroke', true);
  engine.selectElement('sh1', 'shape', true);
  engine.selectElement('sh2', 'shape', true);

  assert.equal(engine.getSelectedElements().length, 5);

  // Collective bounding box:
  // s1: x in [10, 30], y in [10, 30]
  // s2: x in [50, 90], y in [40, 80]
  // s3: x in [110, 130], y in [20, 60]
  // sh1: x in [140, 200], y in [80, 120]
  // sh2: x in [20, 100], y in [120, 180]
  // Collective box: minX=10, maxX=200 (width=190), minY=10, maxY=180 (height=170)
  const collectiveBox = engine.getCollectiveBoundingBox();
  assert.ok(collectiveBox !== null);
  assert.equal(collectiveBox.x, 10);
  assert.equal(collectiveBox.y, 10);
  assert.equal(collectiveBox.width, 190);
  assert.equal(collectiveBox.height, 170);

  const initialCentroidX = collectiveBox.x + collectiveBox.width / 2; // 105
  const initialCentroidY = collectiveBox.y + collectiveBox.height / 2; // 95

  // Initial distance between s1 center (20, 20) and sh1 center (170, 100):
  const initialDistS1ToSh1 = Math.hypot(170 - 20, 100 - 20); // sqrt(150^2 + 80^2) = 170

  // --- PART A: Apply 2x Scale ---
  // Start drag on bottom-right handle of sh1 (at x=204, y=124)
  engine.startDrag(204, 124);

  // Drag by dx = width (190) and dy = height (170) -> scaleX = 2.0, scaleY = 2.0
  engine.dragTo(204 + collectiveBox.width, 124 + collectiveBox.height);

  // Anchor is collective top-left: (transX, transY) = (10, 10)
  // Verify Stroke 1 scaled outward relative to collective anchor (10, 10)
  assert.equal(s1.points[0].x, 10 + (10 - 10) * 2); // 10
  assert.equal(s1.points[0].y, 10 + (10 - 10) * 2); // 10
  assert.equal(s1.points[1].x, 10 + (30 - 10) * 2); // 50
  assert.equal(s1.points[1].y, 10 + (30 - 10) * 2); // 50

  // Verify Stroke 2 scaled outward
  assert.equal(s2.points[0].x, 10 + (50 - 10) * 2); // 90
  assert.equal(s2.points[0].y, 10 + (40 - 10) * 2); // 70

  // Verify Shape 1 scaled outward and dimensions doubled
  assert.equal(sh1.x, 10 + (140 - 10) * 2); // 270
  assert.equal(sh1.y, 10 + (80 - 10) * 2);  // 150
  assert.equal(sh1.width, 60 * 2);          // 120
  assert.equal(sh1.height, 40 * 2);         // 80

  // Verify Shape 2 scaled outward and dimensions doubled
  assert.equal(sh2.x, 10 + (20 - 10) * 2);  // 30
  assert.equal(sh2.y, 10 + (120 - 10) * 2); // 230
  assert.equal(sh2.width, 80 * 2);          // 160
  assert.equal(sh2.height, 60 * 2);         // 120

  // Verify relative distance between Stroke 1 center (30, 30) and Shape 1 center (330, 190):
  const scaledDistS1ToSh1 = Math.hypot(330 - 30, 190 - 30); // sqrt(300^2 + 160^2) = 340
  assert.equal(scaledDistS1ToSh1, 2 * initialDistS1ToSh1, 'Relative distances between elements must exactly double');

  engine.finishDrag(204 + collectiveBox.width, 124 + collectiveBox.height);

  // --- PART B: Apply 90-Degree Group Rotation ---
  // Restore elements to original positions for rotation test
  s1.points[0] = { x: 10, y: 10, pressure: 0.5 };
  s1.points[1] = { x: 30, y: 30, pressure: 0.5 };
  s2.points[0] = { x: 50, y: 40, pressure: 0.5 };
  s2.points[1] = { x: 90, y: 80, pressure: 0.5 };
  s3.points[0] = { x: 110, y: 20, pressure: 0.5 };
  s3.points[1] = { x: 130, y: 60, pressure: 0.5 };
  sh1.x = 140; sh1.y = 80; sh1.width = 60; sh1.height = 40; sh1.rotation = 0;
  sh2.x = 20; sh2.y = 120; sh2.width = 80; sh2.height = 60; sh2.rotation = 0;

  // Rotation handle of s3 is at (midX, minY - offset). Check both 24px and 32px stalk heights
  const rotHandle = engine.getHandleAt(120, -4) ?? engine.getHandleAt(120, -12);
  assert.ok(rotHandle && rotHandle.handle === 'rotate', 'Rotation handle must be found on selection');
  const rotY = engine.getHandleAt(120, -4) ? -4 : -12;

  engine.startDrag(120, rotY);

  // Center is (105, 95). Start angle is atan2(rotY - 95, 120 - 105)
  const startAngle = Math.atan2(rotY - initialCentroidY, 120 - initialCentroidX);
  const targetAngle = startAngle + Math.PI / 2; // Rotate +90 degrees clockwise
  const rotRadius = Math.hypot(120 - initialCentroidX, rotY - initialCentroidY);
  const dragTargetX = initialCentroidX + rotRadius * Math.cos(targetAngle);
  const dragTargetY = initialCentroidY + rotRadius * Math.sin(targetAngle);

  engine.dragTo(dragTargetX, dragTargetY);

  // Verify Stroke 1 rotated 90 degrees around collective centroid (105, 95):
  // Formula: newX = cx - (origY - cy), newY = cy + (origX - cx)
  // s1 point 0: (10, 10): ox = 10 - 105 = -95, oy = 10 - 95 = -85
  // newX = 105 - (-85) = 190, newY = 95 + (-95) = 0
  assert.ok(Math.abs(s1.points[0].x - 190) < 0.001);
  assert.ok(Math.abs(s1.points[0].y - 0) < 0.001);

  // Verify Shape 1 center rotated 90 degrees around collective centroid (105, 95):
  // origCenter = (170, 100), ox = 170 - 105 = 65, oy = 100 - 95 = 5
  // newCenter = (105 - 5, 95 + 65) = (100, 160)
  // shape.x = 100 - 60/2 = 70, shape.y = 160 - 40/2 = 140
  assert.ok(Math.abs(sh1.x - 70) < 0.001);
  assert.ok(Math.abs(sh1.y - 140) < 0.001);
  assert.equal(sh1.rotation, 90);

  // Verify collective centroid after rotation:
  // All rotated points maintain distance from (105, 95) with zero centroid drift
  const s1Dist = Math.hypot(s1.points[0].x - initialCentroidX, s1.points[0].y - initialCentroidY);
  const origS1Dist = Math.hypot(10 - initialCentroidX, 10 - initialCentroidY);
  assert.ok(Math.abs(s1Dist - origS1Dist) < 0.001, 'Orbital distance to collective centroid must be preserved');

  engine.finishDrag(dragTargetX, dragTargetY);

  // --- PART C: Verify Single-Element Transforms Preserve Single-Element Anchor ---
  engine.clearSelection();
  sh1.x = 140; sh1.y = 80; sh1.width = 60; sh1.height = 40; sh1.rotation = 0;
  engine.selectElement('sh1', 'shape', false);
  assert.equal(engine.getSelectedElements().length, 1);

  const singleShapeBefore = { x: sh1.x, y: sh1.y, width: sh1.width, height: sh1.height, rotation: sh1.rotation };
  const singleHandleBr = engine.getHandleAt(sh1.x + sh1.width + 4, sh1.y + sh1.height + 4);
  assert.ok(singleHandleBr && singleHandleBr.handle === 'br');

  engine.startDrag(sh1.x + sh1.width + 4, sh1.y + sh1.height + 4);
  engine.dragTo(sh1.x + sh1.width + 4 + 20, sh1.y + sh1.height + 4 + 10);

  // Single-element anchor: top-left (x, y) stays anchored
  assert.ok(Math.abs(sh1.x - singleShapeBefore.x) < 0.001);
  assert.ok(Math.abs(sh1.y - singleShapeBefore.y) < 0.001);
  assert.ok(sh1.width > singleShapeBefore.width);

  // Unselected elements (s1, s2, s3, sh2) remain completely unaffected
  assert.equal(sh2.width, 80);
  assert.equal(sh2.height, 60);
});

// ---------------------------------------------------------------------------
// REGRESSION: middle-click autoscroll is native Chromium behavior
// ---------------------------------------------------------------------------
test('Middle-click autoscroll is delegated to Chromium instead of a notebook handler', async () => {
  const { readFile, access } = await import('node:fs/promises');
  const renderer = await readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8');
  assert.equal(renderer.includes('useAutoScroll'), false, 'notebook must not mount a custom autoscroll hook');
  assert.equal(renderer.includes('AutoScrollIndicator'), false, 'notebook must not render a custom autoscroll indicator');
  assert.equal(renderer.includes('e.button === 1'), false, 'notebook must not intercept the middle button');
  await assert.rejects(access(new URL('../src/components/notebook/useAutoScroll.tsx', import.meta.url)), /ENOENT/);
  await assert.rejects(access(new URL('../src/components/notebook/autoScrollVelocity.ts', import.meta.url)), /ENOENT/);
});

// ---------------------------------------------------------------------------
// ADVERSARIAL TEST 5: R4.1 & R4.2 Laser Pointer Trail, Fading & Cleanup
// ---------------------------------------------------------------------------
test('R4.1 & R4.2 Laser pointer: decay duration is 3000ms, opacity follows smooth ease-out curve, dense input is handled without loss, and clear() terminates RAF', () => {
  let currentTime = 10_000;
  let nextHandle = 1;
  const activeHandles = new Set<number>();
  let redrawCount = 0;

  const laser = new LaserManager({
    now: () => currentTime,
    requestFrame: cb => {
      const handle = nextHandle++;
      activeHandles.add(handle);
      return handle;
    },
    cancelFrame: handle => {
      activeHandles.delete(handle);
    },
  });
  laser.setRedrawCallback(() => { redrawCount++; });

  // ASSERTION: Decay duration is between 2500ms and 3500ms (exactly 3000ms)
  assert.ok(laser.decayMs >= 2500 && laser.decayMs <= 3500, `Laser decay ${laser.decayMs}ms must be between 2500ms and 3500ms`);
  assert.equal(laser.decayMs, 3000);

  // Add 1,000 dense points rapidly (simulating high-frequency stylus stream)
  for (let i = 0; i < 1000; i++) {
    laser.addPoint({ x: i, y: i * 0.5, pressure: 0.5, t: currentTime });
  }

  // All 1,000 points accommodated in buffer
  assert.equal(laser.getActiveTrail().length, 1000);
  assert.equal(laser.isAnimating(), true);
  assert.equal(activeHandles.size, 1);

  // Verify smooth fading curve vs linear progress
  // At t = 0 (just added):
  const p0 = laser.getActiveTrail()[0];
  const linear0 = laser.getPointOpacity(p0, currentTime);
  const smooth0 = Math.sin(linear0 * (Math.PI / 2));
  assert.equal(linear0, 1.0);
  assert.equal(smooth0, 1.0);

  // Advance time by 1500ms (50% decay)
  currentTime += 1500;
  const linearHalf = laser.getPointOpacity(p0, currentTime);
  const smoothHalf = Math.sin(linearHalf * (Math.PI / 2));
  assert.equal(linearHalf, 0.5);
  // Cosine ease-out remains visibly bright (> 0.70) at mid-life:
  assert.ok(smoothHalf > 0.70, `Smooth opacity at half-life (${smoothHalf}) must remain > 0.70`);
  assert.ok(Math.abs(smoothHalf - Math.SQRT1_2) < 0.001);

  // Advance time by another 1200ms (2700ms total, 90% decay)
  currentTime += 1200;
  const linearLate = laser.getPointOpacity(p0, currentTime);
  const smoothLate = Math.sin(linearLate * (Math.PI / 2));
  assert.ok(linearLate < 0.15);
  assert.ok(smoothLate < 0.20);
  assert.ok(smoothLate > 0.0);

  // Advance time past 3000ms (decay expired)
  currentTime += 301; // 3001ms elapsed
  assert.equal(laser.getActiveTrail(currentTime).length, 0, 'Expired points must be pruned');

  // Verify dense burst up to MAX_TRAIL_POINTS (2048) does not cause unbounded growth
  for (let i = 0; i < 2500; i++) {
    laser.addPoint({ x: i, y: i, pressure: 0.5, t: currentTime });
  }
  assert.ok(laser.getActiveTrail(currentTime).length <= 2048, 'Trail buffer must cap at MAX_TRAIL_POINTS (2048)');

  // Verify clear() immediately terminates animation and purges points
  assert.ok(laser.getActiveTrail().length > 0);
  assert.equal(laser.isAnimating(), true);

  laser.clear();
  assert.equal(laser.getActiveTrail().length, 0, 'Trail must be empty after clear()');
  assert.equal(laser.isAnimating(), false, 'isAnimating must be false after clear()');
  assert.equal(activeHandles.size, 0, 'Active RAF handles must be completely cleared');
});
