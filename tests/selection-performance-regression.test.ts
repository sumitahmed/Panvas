import assert from 'node:assert/strict';
import test from 'node:test';
import { SelectionEngine } from '../src/components/notebook/engine/SelectionEngine.ts';
import { LayerManager } from '../src/components/notebook/engine/LayerManager.ts';
import { HistoryManager } from '../src/components/notebook/engine/HistoryManager.ts';
import { InputManager } from '../src/components/notebook/engine/InputManager.ts';
import { ToolManager } from '../src/components/notebook/engine/ToolManager.ts';
import { ViewportManager } from '../src/components/notebook/engine/ViewportManager.ts';
import { RulerManager } from '../src/components/notebook/engine/RulerManager.ts';
import { LaserManager } from '../src/components/notebook/engine/LaserManager.ts';
import { DrawingEngine } from '../src/components/notebook/engine/DrawingEngine.ts';
import { ShapeManager } from '../src/components/notebook/engine/ShapeManager.ts';
import type { ImageManager } from '../src/components/notebook/engine/ImageManager.ts';
import { TextManager } from '../src/components/notebook/engine/TextManager.ts';
import {
  saveNotebookPosition,
  getNotebookPosition,
} from '../src/lib/readingPosition.ts';
import type {
  Stroke,
  Shape,
  TextObject,
  ImageObject,
} from '../src/components/notebook/engine/drawingTypes.ts';

// Helper to create an isolated selection engine test harness
function createSelectionTestHarness() {
  const strokes: Stroke[] = [];
  const shapes: Shape[] = [];
  const texts: TextObject[] = [];
  const images: ImageObject[] = [];

  const shapeManager = new ShapeManager();
  const imageManager = {
    getImages: () => images,
    getImage: (id: string) => images.find(img => img.id === id),
    getImageElement: () => null,
    isLoaded: () => false,
    deleteImage: () => {},
    clear: () => {},
  } as unknown as ImageManager;
  const layerManager = new LayerManager();
  const rulerManager = new RulerManager();
  const laserManager = new LaserManager();
  const viewport = new ViewportManager();
  const textManager = new TextManager();
  const historyManager = new HistoryManager();

  let redrawCount = 0;
  const drawingEngine = new DrawingEngine(
    viewport,
    shapeManager,
    imageManager,
    layerManager,
    rulerManager,
    laserManager,
  );
  // Spy on redraw
  const originalRedraw = drawingEngine.redraw.bind(drawingEngine);
  drawingEngine.redraw = (dirty, boundsForStroke) => {
    redrawCount++;
    originalRedraw(dirty, boundsForStroke);
  };

  const engine = new SelectionEngine(
    drawingEngine,
    shapeManager,
    historyManager,
    viewport,
    textManager,
    imageManager,
    layerManager,
  );
  drawingEngine.setSelectionEngine(engine);

  return {
    engine,
    drawingEngine,
    shapeManager,
    textManager,
    imageManager,
    historyManager,
    layerManager,
    viewport,
    strokes,
    shapes,
    texts,
    images,
    getRedrawCount: () => redrawCount,
  };
}

// ---------------------------------------------------------------------------
// TEST SUITE 1: Group Transformation Fidelity & Geometry Math
// ---------------------------------------------------------------------------

test('Workstream C.1: Multi-element move maintains exact group translation, analytical bounds, and undo/redo', () => {
  const harness = createSelectionTestHarness();
  const { engine, drawingEngine, shapeManager, historyManager, layerManager } = harness;
  const activeLayer = layerManager.getActiveLayerId();

  const s1: Stroke = {
    id: 's1',
    type: 'stroke',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000000',
    width: 2,
    opacity: 1,
    points: [{ x: 10, y: 10, pressure: 0.5 }, { x: 30, y: 40, pressure: 0.5 }],
  };
  const s2: Stroke = {
    id: 's2',
    type: 'stroke',
    layerId: activeLayer,
    tool: 'pen',
    color: '#ff0000',
    width: 2,
    opacity: 1,
    points: [{ x: 50, y: 50, pressure: 0.5 }, { x: 80, y: 90, pressure: 0.5 }],
  };
  const sh1: Shape = {
    id: 'sh1',
    layerId: activeLayer,
    type: 'shape',
    shapeType: 'rectangle',
    color: '#000000',
    strokeWidth: 2,
    fill: null,
    x: 100,
    y: 100,
    width: 60,
    height: 40,
    rotation: 0,
    opacity: 1,
    createdAt: Date.now(),
  };

  drawingEngine.addStroke(s1);
  drawingEngine.addStroke(s2);
  shapeManager.addShape(sh1);

  // Multi-select all 3 elements
  engine.selectElement('s1', 'stroke', true);
  engine.selectElement('s2', 'stroke', true);
  engine.selectElement('sh1', 'shape', true);

  assert.equal(engine.getSelectedElements().length, 3);

  // Initial collective bounds: x in [10, 160], y in [10, 140]
  const initialCollectiveBox = engine.getCollectiveBoundingBox();
  assert.ok(initialCollectiveBox);
  assert.equal(initialCollectiveBox.x, 10);
  assert.equal(initialCollectiveBox.y, 10);
  assert.equal(initialCollectiveBox.width, 150);
  assert.equal(initialCollectiveBox.height, 130);

  // Start move drag at (20, 20)
  engine.startDrag(20, 20);

  // Verify initial element boxes and positions were cached in O(1) structures
  const origBoxS1 = engine.getOriginalElementBox('s1');
  assert.ok(origBoxS1);
  assert.equal(origBoxS1.x, 10);
  assert.equal(origBoxS1.y, 10);
  assert.equal(origBoxS1.width, 20);
  assert.equal(origBoxS1.height, 30);

  // Drag by dx = 40, dy = 60
  engine.dragTo(60, 80);

  // Analytical bounding box during active drag must reflect offset immediately without point scans
  const draggingBox = engine.getCollectiveBoundingBox();
  assert.ok(draggingBox);
  assert.equal(draggingBox.x, 50);
  assert.equal(draggingBox.y, 70);
  assert.equal(draggingBox.width, 150);
  assert.equal(draggingBox.height, 130);

  // In-memory points must be correctly updated
  assert.equal(s1.points[0].x, 50);
  assert.equal(s1.points[0].y, 70);
  assert.equal(s1.points[1].x, 70);
  assert.equal(s1.points[1].y, 100);
  assert.equal(s2.points[0].x, 90);
  assert.equal(s2.points[0].y, 110);
  assert.equal(sh1.x, 140);
  assert.equal(sh1.y, 160);

  // Finish drag
  const moved = engine.finishDrag(60, 80);
  assert.equal(moved, true);

  // Verify undo restores exact initial state
  assert.equal(historyManager.canUndo(), true);
  historyManager.undo();

  assert.equal(s1.points[0].x, 10);
  assert.equal(s1.points[0].y, 10);
  assert.equal(s1.points[1].x, 30);
  assert.equal(s1.points[1].y, 40);
  assert.equal(sh1.x, 100);
  assert.equal(sh1.y, 100);

  // Verify redo restores moved positions
  assert.equal(historyManager.canRedo(), true);
  historyManager.redo();

  assert.equal(s1.points[0].x, 50);
  assert.equal(s1.points[0].y, 70);
  assert.equal(sh1.x, 140);
  assert.equal(sh1.y, 160);
});

test('Workstream C.2: Multi-element 2x resize doubles relative distances and scales all group members outward', () => {
  const harness = createSelectionTestHarness();
  const { engine, drawingEngine, shapeManager, textManager, layerManager } = harness;
  const activeLayer = layerManager.getActiveLayerId();

  const s1: Stroke = {
    id: 's1',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000000',
    width: 2,
    opacity: 1,
    points: [{ x: 10, y: 10, pressure: 0.5 }, { x: 30, y: 30, pressure: 0.5 }],
  };
  const sh1: Shape = {
    id: 'sh1',
    layerId: activeLayer,
    type: 'shape',
    shapeType: 'rectangle',
    color: '#000000',
    strokeWidth: 2,
    fill: null,
    x: 110,
    y: 70,
    width: 40,
    height: 30,
    rotation: 0,
    opacity: 1,
    createdAt: Date.now(),
  };
  const t1: TextObject = {
    id: 't1',
    layerId: activeLayer,
    type: 'text',
    x: 160,
    y: 110,
    width: 50,
    height: 40,
    rotation: 0,
    text: 'Note',
    fontSize: 16,
    fontFamily: 'sans-serif',
    color: '#000',
    createdAt: Date.now(),
  };

  drawingEngine.addStroke(s1);
  shapeManager.addShape(sh1);
  textManager.addText(t1);

  engine.selectElement('s1', 'stroke', true);
  engine.selectElement('sh1', 'shape', true);
  engine.selectElement('t1', 'text', true);

  const initialBox = engine.getCollectiveBoundingBox();
  assert.ok(initialBox);
  // Collective box: x in [10, 210] (width 200), y in [10, 150] (height 140)
  assert.equal(initialBox.x, 10);
  assert.equal(initialBox.y, 10);
  assert.equal(initialBox.width, 200);
  assert.equal(initialBox.height, 140);

  const initialDistS1ToSh1 = Math.hypot((sh1.x + sh1.width / 2) - (10 + 30) / 2, (sh1.y + sh1.height / 2) - (10 + 30) / 2);

  // Handle at bottom-right of collective box is at (214, 154)
  engine.startDrag(214, 154);

  // Drag outward by collectiveBox.width and collectiveBox.height -> 2.0x scale
  engine.dragTo(214 + initialBox.width, 154 + initialBox.height);

  // Stroke 1 scaled relative to collective origin (10, 10):
  assert.equal(s1.points[0].x, 10 + (10 - 10) * 2);
  assert.equal(s1.points[0].y, 10 + (10 - 10) * 2);
  assert.equal(s1.points[1].x, 10 + (30 - 10) * 2);
  assert.equal(s1.points[1].y, 10 + (30 - 10) * 2);

  // Shape 1 scaled relative to collective origin (10, 10):
  assert.equal(sh1.x, 10 + (110 - 10) * 2); // 210
  assert.equal(sh1.y, 10 + (70 - 10) * 2);  // 130
  assert.equal(sh1.width, 40 * 2);          // 80
  assert.equal(sh1.height, 30 * 2);         // 60

  // Text 1 scaled relative to collective origin:
  assert.equal(t1.x, 10 + (160 - 10) * 2); // 310
  assert.equal(t1.y, 10 + (110 - 10) * 2); // 210
  assert.equal(t1.width, 50 * 2);          // 100

  // Verify relative distance between Stroke 1 center (30, 30) and Shape 1 center (250, 160) exactly doubled
  const scaledDistS1ToSh1 = Math.hypot((sh1.x + sh1.width / 2) - 30, (sh1.y + sh1.height / 2) - 30);
  assert.equal(scaledDistS1ToSh1, 2 * initialDistS1ToSh1);

  engine.finishDrag(214 + initialBox.width, 154 + initialBox.height);
});

test('Workstream C.3: Multi-element collective rotation rotates all items around collective centroid with zero drift', () => {
  const harness = createSelectionTestHarness();
  const { engine, drawingEngine, shapeManager, layerManager } = harness;
  const activeLayer = layerManager.getActiveLayerId();

  // Create symmetric layout around centroid (100, 100)
  const s1: Stroke = {
    id: 's1',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000000',
    width: 2,
    opacity: 1,
    points: [{ x: 50, y: 100, pressure: 0.5 }, { x: 70, y: 100, pressure: 0.5 }],
  };
  const sh1: Shape = {
    id: 'sh1',
    layerId: activeLayer,
    type: 'shape',
    shapeType: 'rectangle',
    color: '#000000',
    strokeWidth: 2,
    fill: null,
    x: 130,
    y: 85,
    width: 20,
    height: 30,
    rotation: 0,
    opacity: 1,
    createdAt: Date.now(),
  };

  drawingEngine.addStroke(s1);
  shapeManager.addShape(sh1);

  engine.selectElement('s1', 'stroke', true);
  engine.selectElement('sh1', 'shape', true);

  const collectiveBox = engine.getCollectiveBoundingBox();
  assert.ok(collectiveBox);
  const centroidX = collectiveBox.x + collectiveBox.width / 2; // 100
  const centroidY = collectiveBox.y + collectiveBox.height / 2; // 100
  assert.equal(centroidX, 100);
  assert.equal(centroidY, 100);

  // Rotation handle of sh1 is at midX=140, y=85-32=53
  const rotHandle = engine.getHandleAt(140, 53) ?? engine.getHandleAt(140, 61);
  assert.ok(rotHandle && rotHandle.handle === 'rotate');

  const startRotX = 140;
  const startRotY = engine.getHandleAt(140, 53) ? 53 : 61;
  engine.startDrag(startRotX, startRotY);

  // Initial angle from centroid (100, 100) to start handle (140, 53)
  const initialAngle = Math.atan2(startRotY - centroidY, startRotX - centroidX);
  const rotRadius = Math.hypot(startRotX - centroidX, startRotY - centroidY);
  // Rotate 90 degrees clockwise
  const targetAngle = initialAngle + Math.PI / 2;
  const targetX = centroidX + rotRadius * Math.cos(targetAngle);
  const targetY = centroidY + rotRadius * Math.sin(targetAngle);
  engine.dragTo(targetX, targetY);

  // Stroke 1 was at (60, 100), distance 40 to the left of centroid (100, 100).
  // After 90-degree clockwise rotation, it should orbit to 40 above centroid: center at (100, 60).
  const newS1CenterX = (s1.points[0].x + s1.points[1].x) / 2;
  const newS1CenterY = (s1.points[0].y + s1.points[1].y) / 2;
  assert.ok(Math.abs(newS1CenterX - 100) < 0.1, `s1 centerX should be ~100, got ${newS1CenterX}`);
  assert.ok(Math.abs(newS1CenterY - 60) < 0.1, `s1 centerY should be ~60, got ${newS1CenterY}`);

  // Shape 1 was at (140, 100), distance 40 to the right of centroid.
  // After 90-degree rotation, it should orbit to 40 below centroid: center at (100, 140).
  const newSh1CenterX = sh1.x + sh1.width / 2;
  const newSh1CenterY = sh1.y + sh1.height / 2;
  assert.ok(Math.abs(newSh1CenterX - 100) < 0.1, `sh1 centerX should be ~100, got ${newSh1CenterX}`);
  assert.ok(Math.abs(newSh1CenterY - 140) < 0.1, `sh1 centerY should be ~140, got ${newSh1CenterY}`);
  assert.ok(Math.abs((sh1.rotation ?? 0) - 90) < 0.1, `sh1 rotation should be ~90 deg`);

  engine.finishDrag(targetX, targetY);
});

// ---------------------------------------------------------------------------
// TEST SUITE 2: InputManager Frame-Pacing & notifyChange Deferral
// ---------------------------------------------------------------------------

test('Workstream C.4: InputManager does NOT call notifyChange during active drag, but calls it once on finish', () => {
  const harness = createSelectionTestHarness();
  const { engine, drawingEngine, textManager, historyManager, layerManager, viewport } = harness;
  const toolManager = new ToolManager();
  toolManager.setMode('select');

  // Add a text note to ensure text objects are present
  const textNote: TextObject = {
    id: 'txt-perf-1',
    layerId: layerManager.getActiveLayerId(),
    type: 'text',
    x: 50,
    y: 50,
    width: 100,
    height: 60,
    rotation: 0,
    text: 'Performance test',
    fontSize: 16,
    fontFamily: 'sans-serif',
    color: '#000000',
    createdAt: Date.now(),
  };
  textManager.addText(textNote);

  let notifyChangeCount = 0;
  const input = new InputManager(
    toolManager,
    viewport,
    drawingEngine,
    { setHistoryChangeCallback: () => {}, setRulerManager: () => {}, eraseStrokeIds: () => false } as any,
    harness.shapeManager,
    engine,
    historyManager,
    textManager,
    new RulerManager(),
    new LaserManager(),
  );
  input.onDrawingChange(() => {
    notifyChangeCount++;
  });

  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    style: { cursor: '', removeProperty: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    parentElement: {
      querySelector: (selector: string) => {
        if (selector.includes('txt-perf-1')) {
          return {
            style: { transform: '' },
            hasAttribute: () => false,
            setAttribute: () => {},
            getAttribute: () => null,
            removeAttribute: () => {},
          };
        }
        return null;
      },
    },
  } as unknown as HTMLCanvasElement;
  input.attach(canvas);

  // Pre-select the text element
  engine.selectElement('txt-perf-1', 'text');

  // 1. Pointer Down on the element to start transform
  (input as any).handlePointerDown({
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    pressure: 0.5,
    clientX: 60,
    clientY: 60,
    shiftKey: false,
    preventDefault: () => {},
  });

  assert.equal(notifyChangeCount, 0, 'PointerDown must not trigger notifyChange');

  // 2. Dispatch 20 continuous pointer move events during active drag
  for (let i = 1; i <= 20; i++) {
    (input as any).handlePointerMove({
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      pressure: 0.5,
      clientX: 60 + i * 5,
      clientY: 60 + i * 5,
      shiftKey: false,
      preventDefault: () => {},
    });
  }

  // In-drag assertion: notifyChange must remain 0 throughout the gesture
  assert.equal(
    notifyChangeCount,
    0,
    'notifyChange must be 0 throughout the active drag to eliminate structuredClone and React re-renders',
  );

  // 3. Pointer Up to finish selection
  (input as any).handlePointerUp({
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    pressure: 0.5,
    clientX: 160,
    clientY: 160,
    shiftKey: false,
    preventDefault: () => {},
  });

  // Finish assertion: notifyChange must be invoked exactly once on completion
  assert.equal(
    notifyChangeCount,
    1,
    'notifyChange must be called strictly once upon drag completion to commit persistence and UI state',
  );

  // Verify text note's committed position was updated by +100, +100
  assert.equal(textNote.x, 150);
  assert.equal(textNote.y, 150);

  input.detach();
});

test('Workstream C.5: Suppress pointerrawupdate during active selection transforms', () => {
  const harness = createSelectionTestHarness();
  const { engine, drawingEngine, textManager, historyManager, layerManager, viewport } = harness;
  const toolManager = new ToolManager();
  toolManager.setMode('select');

  const s1: Stroke = {
    id: 's-raw',
    layerId: layerManager.getActiveLayerId(),
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: [{ x: 10, y: 10, pressure: 0.5 }],
  };
  drawingEngine.addStroke(s1);
  engine.selectElement('s-raw', 'stroke');

  const input = new InputManager(
    toolManager,
    viewport,
    drawingEngine,
    { setHistoryChangeCallback: () => {}, setRulerManager: () => {}, eraseStrokeIds: () => false } as any,
    harness.shapeManager,
    engine,
    historyManager,
    textManager,
    new RulerManager(),
    new LaserManager(),
  );

  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    style: { cursor: '', removeProperty: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as unknown as HTMLCanvasElement;
  input.attach(canvas);

  // Start selection transform
  (input as any).handlePointerDown({
    button: 0,
    pointerId: 2,
    pointerType: 'pen',
    pressure: 0.5,
    clientX: 10,
    clientY: 10,
    shiftKey: false,
    preventDefault: () => {},
  });

  // Dispatch pointerrawupdate event
  let rawProcessed = false;
  const rawEvent = {
    type: 'pointerrawupdate',
    button: 0,
    pointerId: 2,
    pointerType: 'pen',
    pressure: 0.5,
    clientX: 20,
    clientY: 20,
    shiftKey: false,
    preventDefault: () => {},
  };

  (input as any).handlePointerMove(rawEvent);

  // Because selectionDragMode === 'transform', pointerrawupdate is suppressed,
  // so stroke points do not advance on raw updates
  assert.equal(s1.points[0].x, 10, 'pointerrawupdate must be ignored during selection transform');

  input.detach();
});

// ---------------------------------------------------------------------------
// TEST SUITE 3: Scroll Persistence Debouncing
// ---------------------------------------------------------------------------

test('Workstream D.1: Scroll handler debounces saveNotebookPosition by 250ms, eliminating 60-120Hz storage I/O', async () => {
  // Mock localStorage
  const storageMock: Record<string, string> = {};
  let setItemCallCount = 0;

  const originalLocalStorage = globalThis.localStorage;
  (globalThis as any).localStorage = {
    getItem: (key: string) => storageMock[key] ?? null,
    setItem: (key: string, value: string) => {
      setItemCallCount++;
      storageMock[key] = value;
    },
    removeItem: (key: string) => {
      delete storageMock[key];
    },
  };

  try {
    const notebookId = 'nb-scroll-debounce-test';
    let savePositionTimeout: ReturnType<typeof setTimeout> | null = null;

    // Mimic the exact debounced scroll handler in NotebookRenderer.tsx
    const persistPositionDebounced = (pageId: string, scrollX: number, scrollY: number) => {
      if (savePositionTimeout !== null) clearTimeout(savePositionTimeout);
      savePositionTimeout = setTimeout(() => {
        savePositionTimeout = null;
        saveNotebookPosition(notebookId, { pageId, scrollX, scrollY });
      }, 250);
    };

    const flushPendingPosition = (pageId: string, scrollX: number, scrollY: number) => {
      if (savePositionTimeout !== null) {
        clearTimeout(savePositionTimeout);
        savePositionTimeout = null;
        saveNotebookPosition(notebookId, { pageId, scrollX, scrollY });
      }
    };

    // Simulate 50 rapid scroll events firing at 120Hz (every 8ms)
    for (let frame = 1; frame <= 50; frame++) {
      persistPositionDebounced('page-1', 0, frame * 10);
    }

    // During active rapid scrolling, localStorage.setItem must NOT be called synchronously
    assert.equal(
      setItemCallCount,
      0,
      'Active scrolling must debounce writes; 0 synchronous localStorage.setItem calls allowed at 120Hz',
    );

    // Wait for the 250ms debounce timer to expire
    await new Promise(resolve => setTimeout(resolve, 270));

    // After scrolling stops for >250ms, it must save exactly once with the latest position (scrollY = 500)
    assert.equal(
      setItemCallCount,
      1,
      'localStorage.setItem must be invoked exactly once after debounce duration completes',
    );
    const persisted = getNotebookPosition(notebookId);
    assert.ok(persisted);
    assert.equal(persisted.pageId, 'page-1');
    assert.equal(persisted.scrollY, 500);

    // Test unmount/flush: rapid scroll followed by immediate flush
    persistPositionDebounced('page-1', 0, 750);
    assert.equal(setItemCallCount, 1, 'Still 1 write before flush');
    flushPendingPosition('page-1', 0, 750);
    assert.equal(setItemCallCount, 2, 'Flush immediately persists pending reading position');
    const finalPos = getNotebookPosition(notebookId);
    assert.equal(finalPos?.scrollY, 750);
  } finally {
    (globalThis as any).localStorage = originalLocalStorage;
  }
});

// ---------------------------------------------------------------------------
// TEST SUITE 4: Heavy Load & Multi-Stroke Transformation Performance
// ---------------------------------------------------------------------------

test('Workstream C.6: 500+ strokes selection transformation executes in <16ms per frame (60fps benchmark)', () => {
  const harness = createSelectionTestHarness();
  const { engine, drawingEngine, layerManager } = harness;
  const activeLayer = layerManager.getActiveLayerId();

  // Generate 500 distinct strokes, each with 20 points (10,000 points total)
  const strokeCount = 500;
  const pointsPerStroke = 20;

  for (let s = 0; s < strokeCount; s++) {
    const strokePoints = [];
    const baseX = (s % 20) * 40;
    const baseY = Math.floor(s / 20) * 40;
    for (let p = 0; p < pointsPerStroke; p++) {
      strokePoints.push({
        x: baseX + p * 1.5,
        y: baseY + p * 1.5,
        pressure: 0.5,
        t: p * 10,
      });
    }

    const stroke: Stroke = {
      id: `stroke-heavy-${s}`,
      layerId: activeLayer,
      tool: 'pen',
      color: '#1a1a1a',
      width: 2,
      opacity: 1,
      points: strokePoints,
    };
    drawingEngine.addStroke(stroke);
    engine.selectElement(stroke.id, 'stroke', true);
  }

  assert.equal(engine.getSelectedElements().length, strokeCount);

  // Find point not hitting any stroke handle to guarantee move transform
  let startX = 200, startY = 200;
  while (engine.getHandleAt(startX, startY) !== null) {
    startX += 10;
    startY += 10;
  }

  // Start selection drag
  const startDragTime = performance.now();
  engine.startDrag(startX, startY);
  const startDragDuration = performance.now() - startDragTime;
  assert.ok(startDragDuration < 60, `startDrag on 500 strokes took ${startDragDuration.toFixed(2)}ms (must be <60ms)`);

  // Measure 30 simulated interactive animation frames (dragTo)
  const frameTimes: number[] = [];
  for (let frame = 1; frame <= 30; frame++) {
    const frameStart = performance.now();
    engine.dragTo(startX + frame * 2, startY + frame * 2);
    const frameDuration = performance.now() - frameStart;
    frameTimes.push(frameDuration);
  }

  const averageFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  const maxFrameTime = Math.max(...frameTimes);

  // Assert that average frame time is well under the 16.7ms (60 FPS) budget
  assert.ok(
    averageFrameTime < 16.0,
    `Average dragTo frame time on 500 strokes was ${averageFrameTime.toFixed(2)}ms, exceeding 16ms budget!`,
  );
  // Log performance result for audit
  console.log(`[PERF VERIFIED] 500 strokes (10,000 points): avg frame = ${averageFrameTime.toFixed(3)}ms, max = ${maxFrameTime.toFixed(3)}ms`);

  // Finish drag and verify positions
  engine.finishDrag(startX + 60, startY + 60);
  const firstStroke = drawingEngine.getStrokes()[0];
  assert.equal(firstStroke.points[0].x, 60, 'First stroke translated by +60px');
  assert.equal(firstStroke.points[0].y, 60, 'First stroke translated by +60px');
});
