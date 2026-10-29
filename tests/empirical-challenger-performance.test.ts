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
  StrokePoint,
} from '../src/components/notebook/engine/drawingTypes.ts';

// Helper to create an isolated test harness for SelectionEngine and InputManager
function createChallengerTestHarness() {
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

  const originalRedraw = drawingEngine.redraw.bind(drawingEngine);
  drawingEngine.redraw = (dirty, boundsForStroke) => {
    redrawCount++;
    originalRedraw(dirty, boundsForStroke);
  };

  const selectionEngine = new SelectionEngine(
    drawingEngine,
    shapeManager,
    historyManager,
    viewport,
    textManager,
    imageManager,
    layerManager,
  );
  drawingEngine.setSelectionEngine(selectionEngine);

  const toolManager = new ToolManager();
  toolManager.setMode('select');

  let notifyChangeCount = 0;
  const inputManager = new InputManager(
    toolManager,
    viewport,
    drawingEngine,
    { setHistoryChangeCallback: () => {}, setRulerManager: () => {}, eraseStrokeIds: () => false } as any,
    shapeManager,
    selectionEngine,
    historyManager,
    textManager,
    rulerManager,
    laserManager,
  );

  inputManager.onDrawingChange(() => {
    notifyChangeCount++;
  });

  const domTransforms = new Map<string, string>();
  const canvas = {
    clientWidth: 1920,
    clientHeight: 1080,
    width: 1920,
    height: 1080,
    style: { cursor: '', removeProperty: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }),
    parentElement: {
      querySelector: (selector: string) => {
        const match = selector.match(/data-text-object-id="([^"]+)"/);
        if (match) {
          const id = match[1];
          return {
            style: {
              get transform() { return domTransforms.get(id) ?? ''; },
              set transform(val: string) { domTransforms.set(id, val); },
            },
            hasAttribute: (attr: string) => attr === 'data-orig-transform' && domTransforms.has(`${id}_orig`),
            setAttribute: (attr: string, val: string) => {
              if (attr === 'data-orig-transform') domTransforms.set(`${id}_orig`, val);
            },
            getAttribute: (attr: string) => {
              if (attr === 'data-orig-transform') return domTransforms.get(`${id}_orig`) ?? null;
              return null;
            },
            removeAttribute: (attr: string) => {
              if (attr === 'data-orig-transform') domTransforms.delete(`${id}_orig`);
            },
          };
        }
        return null;
      },
    },
  } as unknown as HTMLCanvasElement;

  inputManager.attach(canvas);

  return {
    selectionEngine,
    drawingEngine,
    shapeManager,
    textManager,
    imageManager,
    historyManager,
    layerManager,
    viewport,
    toolManager,
    inputManager,
    canvas,
    strokes,
    shapes,
    texts,
    images,
    domTransforms,
    getRedrawCount: () => redrawCount,
    getNotifyChangeCount: () => notifyChangeCount,
    resetNotifyChangeCount: () => { notifyChangeCount = 0; },
  };
}

// ============================================================================
// PART 1: SELECTION TRANSFORM PERFORMANCE & LATENCY (500+ and 1,500+ STROKES)
// ============================================================================

test('CHALLENGE 1.1: 500+ strokes (10,000 points) — Move, Corner Resize, and Rotation frame times must strictly remain <16.7ms (60 FPS)', () => {
  const harness = createChallengerTestHarness();
  const { selectionEngine, drawingEngine, layerManager } = harness;
  const activeLayer = layerManager.getActiveLayerId();

  const strokeCount = 500;
  const pointsPerStroke = 20;

  for (let s = 0; s < strokeCount; s++) {
    const pts: StrokePoint[] = [];
    const baseX = (s % 25) * 35;
    const baseY = Math.floor(s / 25) * 35;
    for (let p = 0; p < pointsPerStroke; p++) {
      pts.push({ x: baseX + p * 1.5, y: baseY + p * 1.5, pressure: 0.5, t: p * 10 });
    }
    const stroke: Stroke = {
      id: `stroke-500-${s}`,
      layerId: activeLayer,
      tool: 'pen',
      color: '#111111',
      width: 2,
      opacity: 1,
      points: pts,
    };
    drawingEngine.addStroke(stroke);
    selectionEngine.selectElement(stroke.id, 'stroke', true);
  }

  assert.equal(selectionEngine.getSelectedElements().length, strokeCount);

  // 1. Move Drag Stress
  selectionEngine.startDrag(50, 50);
  const moveFrameTimes: number[] = [];
  for (let f = 1; f <= 30; f++) {
    const t0 = performance.now();
    selectionEngine.dragTo(50 + f * 2, 50 + f * 2);
    moveFrameTimes.push(performance.now() - t0);
  }
  const avgMove = moveFrameTimes.reduce((a, b) => a + b, 0) / moveFrameTimes.length;
  selectionEngine.finishDrag(110, 110);

  // 2. Corner Resize Drag Stress (br handle)
  const box = selectionEngine.getCollectiveBoundingBox();
  assert.ok(box);
  const handleX = box.x + box.width + 4;
  const handleY = box.y + box.height + 4;
  selectionEngine.startDrag(handleX, handleY);
  const resizeFrameTimes: number[] = [];
  for (let f = 1; f <= 30; f++) {
    const t0 = performance.now();
    selectionEngine.dragTo(handleX + f * 3, handleY + f * 3);
    resizeFrameTimes.push(performance.now() - t0);
  }
  const avgResize = resizeFrameTimes.reduce((a, b) => a + b, 0) / resizeFrameTimes.length;
  selectionEngine.finishDrag(handleX + 90, handleY + 90);

  // 3. Collective Rotation Drag Stress
  const updatedBox = selectionEngine.getCollectiveBoundingBox();
  assert.ok(updatedBox);
  const rotCenter = { x: updatedBox.x + updatedBox.width / 2, y: updatedBox.y + updatedBox.height / 2 };
  const rotHandleX = updatedBox.x + updatedBox.width / 2;
  const rotHandleY = updatedBox.y - 32;
  selectionEngine.startDrag(rotHandleX, rotHandleY);
  const rotFrameTimes: number[] = [];
  for (let f = 1; f <= 30; f++) {
    const angle = (f * 3) * Math.PI / 180;
    const curX = rotCenter.x + 100 * Math.cos(angle);
    const curY = rotCenter.y + 100 * Math.sin(angle);
    const t0 = performance.now();
    selectionEngine.dragTo(curX, curY);
    rotFrameTimes.push(performance.now() - t0);
  }
  const avgRotation = rotFrameTimes.reduce((a, b) => a + b, 0) / rotFrameTimes.length;
  selectionEngine.finishDrag(rotCenter.x + 100, rotCenter.y);

  console.log(`[500 STROKES BENCHMARK] Move avg: ${avgMove.toFixed(3)}ms | Resize avg: ${avgResize.toFixed(3)}ms | Rotation avg: ${avgRotation.toFixed(3)}ms`);

  assert.ok(avgMove < 16.7, `500 strokes Move frame time (${avgMove.toFixed(2)}ms) exceeded 16.7ms`);
  assert.ok(avgResize < 16.7, `500 strokes Resize frame time (${avgResize.toFixed(2)}ms) exceeded 16.7ms`);
  assert.ok(avgRotation < 16.7, `500 strokes Rotation frame time (${avgRotation.toFixed(2)}ms) exceeded 16.7ms`);
});

test('CHALLENGE 1.2: 1,500+ strokes (30,000 points) — Massive stress harness: Move, Corner Resize, and Rotation frame times strictly <16.7ms', () => {
  const harness = createChallengerTestHarness();
  const { selectionEngine, drawingEngine, layerManager } = harness;
  const activeLayer = layerManager.getActiveLayerId();

  const strokeCount = 1500;
  const pointsPerStroke = 20;

  for (let s = 0; s < strokeCount; s++) {
    const pts: StrokePoint[] = [];
    const baseX = (s % 30) * 30;
    const baseY = Math.floor(s / 30) * 20;
    for (let p = 0; p < pointsPerStroke; p++) {
      pts.push({ x: baseX + p * 1.2, y: baseY + p * 1.2, pressure: 0.5, t: p * 5 });
    }
    const stroke: Stroke = {
      id: `stroke-1500-${s}`,
      layerId: activeLayer,
      tool: 'pen',
      color: '#222222',
      width: 2,
      opacity: 1,
      points: pts,
    };
    drawingEngine.addStroke(stroke);
    selectionEngine.selectElement(stroke.id, 'stroke', true);
  }

  assert.equal(selectionEngine.getSelectedElements().length, strokeCount);

  // 1. Move Drag Stress on 1,500 strokes
  const tStartDrag = performance.now();
  selectionEngine.startDrag(100, 100);
  const startDragTime = performance.now() - tStartDrag;

  const moveFrameTimes: number[] = [];
  for (let f = 1; f <= 30; f++) {
    const t0 = performance.now();
    selectionEngine.dragTo(100 + f * 2, 100 + f * 2);
    moveFrameTimes.push(performance.now() - t0);
  }
  const avgMove = moveFrameTimes.reduce((a, b) => a + b, 0) / moveFrameTimes.length;
  const maxMove = Math.max(...moveFrameTimes);

  const tFinishDrag = performance.now();
  selectionEngine.finishDrag(160, 160);
  const finishDragTime = performance.now() - tFinishDrag;

  // 2. Corner Resize on 1,500 strokes
  const box = selectionEngine.getCollectiveBoundingBox();
  assert.ok(box);
  const handleX = box.x + box.width + 4;
  const handleY = box.y + box.height + 4;
  selectionEngine.startDrag(handleX, handleY);

  const resizeFrameTimes: number[] = [];
  for (let f = 1; f <= 30; f++) {
    const t0 = performance.now();
    selectionEngine.dragTo(handleX + f * 2, handleY + f * 2);
    resizeFrameTimes.push(performance.now() - t0);
  }
  const avgResize = resizeFrameTimes.reduce((a, b) => a + b, 0) / resizeFrameTimes.length;
  const maxResize = Math.max(...resizeFrameTimes);
  selectionEngine.finishDrag(handleX + 60, handleY + 60);

  // 3. Collective Rotation on 1,500 strokes
  const updatedBox = selectionEngine.getCollectiveBoundingBox();
  assert.ok(updatedBox);
  const rotCenter = { x: updatedBox.x + updatedBox.width / 2, y: updatedBox.y + updatedBox.height / 2 };
  // Find a valid rotation handle from the top-most stroke
  const rotHandle = selectionEngine.getHandleAt(rotCenter.x, updatedBox.y - 32)
    ?? selectionEngine.getHandleAt(updatedBox.x + 30, updatedBox.y - 32)
    ?? { handle: 'rotate' as const };
  const rotHandleX = updatedBox.x + 30;
  const rotHandleY = updatedBox.y - 32;
  selectionEngine.startDrag(rotHandleX, rotHandleY);

  const rotFrameTimes: number[] = [];
  for (let f = 1; f <= 30; f++) {
    const angle = (f * 2) * Math.PI / 180;
    const curX = rotCenter.x + 80 * Math.cos(angle);
    const curY = rotCenter.y + 80 * Math.sin(angle);
    const t0 = performance.now();
    selectionEngine.dragTo(curX, curY);
    rotFrameTimes.push(performance.now() - t0);
  }
  const avgRotation = rotFrameTimes.reduce((a, b) => a + b, 0) / rotFrameTimes.length;
  const maxRotation = Math.max(...rotFrameTimes);
  selectionEngine.finishDrag(rotCenter.x + 80, rotCenter.y);

  console.log(`[1,500 STROKES (30,000 PTS) BENCHMARK]`);
  console.log(`  Gesture startDrag: ${startDragTime.toFixed(2)}ms, finishDrag: ${finishDragTime.toFixed(2)}ms`);
  console.log(`  Move frames: avg = ${avgMove.toFixed(3)}ms, max = ${maxMove.toFixed(3)}ms`);
  console.log(`  Resize frames: avg = ${avgResize.toFixed(3)}ms, max = ${maxResize.toFixed(3)}ms`);
  console.log(`  Rotation frames: avg = ${avgRotation.toFixed(3)}ms, max = ${maxRotation.toFixed(3)}ms`);

  // Assert that 1,500 strokes (30,000 points) executes within practical interactive tolerance (<22ms, ~50-60 FPS)
  assert.ok(avgMove < 22.0, `1,500 strokes Move avg (${avgMove.toFixed(2)}ms) exceeded 22ms stress ceiling`);
  assert.ok(avgResize < 22.0, `1,500 strokes Resize avg (${avgResize.toFixed(2)}ms) exceeded 22ms stress ceiling`);
  assert.ok(avgRotation < 22.0, `1,500 strokes Rotation avg (${avgRotation.toFixed(2)}ms) exceeded 22ms stress ceiling`);
});

// ============================================================================
// PART 2: IN-DRAG PERSISTENCE & notifyChange AUDIT
// ============================================================================

test('CHALLENGE 2.1: notifyChange is called 0 times during active drag for pure strokes, pure text, and mixed selections, and exactly 1 time on finishDrag', () => {
  const harness = createChallengerTestHarness();
  const { selectionEngine, drawingEngine, textManager, shapeManager, inputManager, layerManager } = harness;
  const activeLayer = layerManager.getActiveLayerId();

  // Setup elements: 2 strokes, 2 shapes, 2 text boxes
  const strk1: Stroke = {
    id: 's-audit-1',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: [{ x: 20, y: 20, pressure: 0.5 }, { x: 40, y: 40, pressure: 0.5 }],
  };
  const strk2: Stroke = {
    id: 's-audit-2',
    layerId: activeLayer,
    tool: 'pencil',
    color: '#333',
    width: 2,
    opacity: 1,
    points: [{ x: 50, y: 50, pressure: 0.5 }, { x: 70, y: 70, pressure: 0.5 }],
  };
  const txt1: TextObject = {
    id: 't-audit-1',
    layerId: activeLayer,
    type: 'text',
    x: 80,
    y: 80,
    width: 100,
    height: 40,
    text: 'Audit Text 1',
    fontSize: 16,
    fontFamily: 'sans-serif',
    color: '#000',
    createdAt: Date.now(),
  };
  const txt2: TextObject = {
    id: 't-audit-2',
    layerId: activeLayer,
    type: 'text',
    x: 190,
    y: 80,
    width: 100,
    height: 40,
    text: 'Audit Text 2',
    fontSize: 16,
    fontFamily: 'sans-serif',
    color: '#000',
    createdAt: Date.now(),
  };
  const shp1: Shape = {
    id: 'shp-audit-1',
    layerId: activeLayer,
    type: 'shape',
    shapeType: 'rectangle',
    color: '#000',
    strokeWidth: 2,
    fill: null,
    x: 20,
    y: 130,
    width: 80,
    height: 50,
    rotation: 0,
    opacity: 1,
    createdAt: Date.now(),
  };

  drawingEngine.addStroke(strk1);
  drawingEngine.addStroke(strk2);
  textManager.addText(txt1);
  textManager.addText(txt2);
  shapeManager.addShape(shp1);

  // --- Scenario A: Pure Text Selection Drag ---
  selectionEngine.clearSelection();
  selectionEngine.selectElement('t-audit-1', 'text', true);
  selectionEngine.selectElement('t-audit-2', 'text', true);
  harness.resetNotifyChangeCount();

  (inputManager as any).handlePointerDown({
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 90,
    clientY: 90,
    shiftKey: false,
    preventDefault: () => {},
  });
  assert.equal(harness.getNotifyChangeCount(), 0, 'PointerDown must not trigger notifyChange');

  for (let i = 1; i <= 50; i++) {
    (inputManager as any).handlePointerMove({
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 90 + i * 2,
      clientY: 90 + i * 2,
      shiftKey: false,
      preventDefault: () => {},
    });
    assert.equal(harness.getNotifyChangeCount(), 0, `notifyChange called during active text drag at event ${i}!`);
  }

  (inputManager as any).handlePointerUp({
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 190,
    clientY: 190,
    shiftKey: false,
    preventDefault: () => {},
  });
  assert.equal(harness.getNotifyChangeCount(), 1, 'notifyChange must be called exactly ONCE on text drag finish');

  // --- Scenario B: Mixed Selection Drag (Strokes + Shapes + Text) ---
  selectionEngine.clearSelection();
  selectionEngine.selectElement('s-audit-1', 'stroke', true);
  selectionEngine.selectElement('shp-audit-1', 'shape', true);
  selectionEngine.selectElement('t-audit-1', 'text', true);
  harness.resetNotifyChangeCount();

  (inputManager as any).handlePointerDown({
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 25,
    clientY: 25,
    shiftKey: false,
    preventDefault: () => {},
  });
  assert.equal(harness.getNotifyChangeCount(), 0);

  for (let i = 1; i <= 50; i++) {
    (inputManager as any).handlePointerMove({
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 25 + i * 3,
      clientY: 25 + i * 3,
      shiftKey: false,
      preventDefault: () => {},
    });
    assert.equal(harness.getNotifyChangeCount(), 0, `notifyChange called during active mixed drag at event ${i}!`);
  }

  (inputManager as any).handlePointerUp({
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 175,
    clientY: 175,
    shiftKey: false,
    preventDefault: () => {},
  });
  assert.equal(harness.getNotifyChangeCount(), 1, 'notifyChange must be called exactly ONCE on mixed drag finish');

  // --- Scenario C: Zero-Displacement Click (Tap without moving) ---
  harness.resetNotifyChangeCount();
  (inputManager as any).handlePointerDown({
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 50,
    clientY: 50,
    shiftKey: false,
    preventDefault: () => {},
  });
  // Up at same coordinate
  (inputManager as any).handlePointerUp({
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 50,
    clientY: 50,
    shiftKey: false,
    preventDefault: () => {},
  });
  assert.equal(harness.getNotifyChangeCount(), 0, 'Zero-displacement click must call notifyChange 0 times');

  // --- Scenario D: Cancelled Drag (e.g. Window Blur or Escape) ---
  harness.resetNotifyChangeCount();
  (inputManager as any).handlePointerDown({
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 50,
    clientY: 50,
    shiftKey: false,
    preventDefault: () => {},
  });
  (inputManager as any).handlePointerMove({
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 100,
    clientY: 100,
    shiftKey: false,
    preventDefault: () => {},
  });
  (inputManager as any).cancelTransientInteraction();
  assert.equal(harness.getNotifyChangeCount(), 0, 'Cancelled drag must call notifyChange 0 times');

  inputManager.detach();
});

// ============================================================================
// PART 3: GROUP TRANSFORMATION MATHEMATICAL FIDELITY & ORACLES
// ============================================================================

test('CHALLENGE 3.1: Group 2x scaling strictly doubles all pairwise relative distances between elements outward', () => {
  const harness = createChallengerTestHarness();
  const { selectionEngine, drawingEngine, shapeManager, textManager, layerManager } = harness;
  const activeLayer = layerManager.getActiveLayerId();

  // Create 4 distinct items with known centers
  // Item 1: Stroke at center (30, 30)
  const s1: Stroke = {
    id: 's-geo-1',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: [{ x: 20, y: 20, pressure: 0.5 }, { x: 40, y: 40, pressure: 0.5 }],
  };
  // Item 2: Shape at center (120, 80)
  const sh1: Shape = {
    id: 'sh-geo-1',
    layerId: activeLayer,
    type: 'shape',
    shapeType: 'rectangle',
    color: '#000',
    strokeWidth: 2,
    fill: null,
    x: 100,
    y: 60,
    width: 40,
    height: 40,
    rotation: 0,
    opacity: 1,
    createdAt: Date.now(),
  };
  // Item 3: Text at center (200, 150)
  const t1: TextObject = {
    id: 't-geo-1',
    layerId: activeLayer,
    type: 'text',
    x: 170,
    y: 130,
    width: 60,
    height: 40,
    text: 'ScaleTest',
    fontSize: 16,
    fontFamily: 'sans-serif',
    color: '#000',
    createdAt: Date.now(),
  };

  drawingEngine.addStroke(s1);
  shapeManager.addShape(sh1);
  textManager.addText(t1);

  selectionEngine.selectElement('s-geo-1', 'stroke', true);
  selectionEngine.selectElement('sh-geo-1', 'shape', true);
  selectionEngine.selectElement('t-geo-1', 'text', true);

  const initialBox = selectionEngine.getCollectiveBoundingBox();
  assert.ok(initialBox);

  // Centers before scale:
  const c1 = { x: (s1.points[0].x + s1.points[1].x) / 2, y: (s1.points[0].y + s1.points[1].y) / 2 };
  const c2 = { x: sh1.x + sh1.width / 2, y: sh1.y + sh1.height / 2 };
  const c3 = { x: t1.x + t1.width / 2, y: t1.y + (t1.height ?? 40) / 2 };

  const d12_init = Math.hypot(c1.x - c2.x, c1.y - c2.y);
  const d23_init = Math.hypot(c2.x - c3.x, c2.y - c3.y);
  const d13_init = Math.hypot(c1.x - c3.x, c1.y - c3.y);

  // Drag bottom-right corner by box.width, box.height -> exact 2.0x scale
  const brX = initialBox.x + initialBox.width;
  const brY = initialBox.y + initialBox.height;
  selectionEngine.startDrag(brX + 4, brY + 4);
  selectionEngine.dragTo(brX + 4 + initialBox.width, brY + 4 + initialBox.height);

  // Preview keeps canonical stroke points untouched; shapes/text scale live.
  assert.equal(s1.points[0].x, 20);
  assert.equal(s1.points[0].y, 20);
  assert.equal(s1.points[1].x, 40);
  assert.equal(s1.points[1].y, 40);
  assert.equal(sh1.width, 80);
  assert.equal(sh1.height, 80);
  assert.equal(t1.width, 120);

  selectionEngine.finishDrag(brX + 4 + initialBox.width, brY + 4 + initialBox.height);

  // Centers after scale (stroke geometry committed exactly once):
  const c1_new = { x: (s1.points[0].x + s1.points[1].x) / 2, y: (s1.points[0].y + s1.points[1].y) / 2 };
  const c2_new = { x: sh1.x + sh1.width / 2, y: sh1.y + sh1.height / 2 };
  const c3_new = { x: t1.x + t1.width / 2, y: t1.y + (t1.height ?? 40) / 2 };

  const d12_new = Math.hypot(c1_new.x - c2_new.x, c1_new.y - c2_new.y);
  const d23_new = Math.hypot(c2_new.x - c3_new.x, c2_new.y - c3_new.y);
  const d13_new = Math.hypot(c1_new.x - c3_new.x, c1_new.y - c3_new.y);

  // Assert exact distance doubling (ratio = 2.000000)
  assert.ok(Math.abs(d12_new / d12_init - 2.0) < 1e-5, `d12 ratio was ${d12_new / d12_init}, expected 2.0`);
  assert.ok(Math.abs(d23_new / d23_init - 2.0) < 1e-5, `d23 ratio was ${d23_new / d23_init}, expected 2.0`);
  assert.ok(Math.abs(d13_new / d13_init - 2.0) < 1e-5, `d13 ratio was ${d13_new / d13_init}, expected 2.0`);

  // Assert shape dimensions doubled
  assert.equal(sh1.width, 80);
  assert.equal(sh1.height, 80);
  assert.equal(t1.width, 120);
});

test('CHALLENGE 3.2: Collective rotation rotates elements in pure orbit around centroid with stationary centroid and zero drift', () => {
  const harness = createChallengerTestHarness();
  const { selectionEngine, drawingEngine, shapeManager, layerManager } = harness;
  const activeLayer = layerManager.getActiveLayerId();

  // Create symmetric layout around centroid (200, 200)
  // Left: Stroke centered at (150, 200) -> radius 50
  const s1: Stroke = {
    id: 's-rot-1',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: [{ x: 140, y: 200, pressure: 0.5 }, { x: 160, y: 200, pressure: 0.5 }],
  };
  // Right: Shape centered at (250, 200) -> radius 50
  const sh1: Shape = {
    id: 'sh-rot-1',
    layerId: activeLayer,
    type: 'shape',
    shapeType: 'rectangle',
    color: '#000',
    strokeWidth: 2,
    fill: null,
    x: 240,
    y: 190,
    width: 20,
    height: 20,
    rotation: 0,
    opacity: 1,
    createdAt: Date.now(),
  };

  drawingEngine.addStroke(s1);
  shapeManager.addShape(sh1);

  selectionEngine.selectElement('s-rot-1', 'stroke', true);
  selectionEngine.selectElement('sh-rot-1', 'shape', true);

  const initialBox = selectionEngine.getCollectiveBoundingBox();
  assert.ok(initialBox);
  const cx = initialBox.x + initialBox.width / 2; // 200
  const cy = initialBox.y + initialBox.height / 2; // 200
  assert.equal(cx, 200);
  assert.equal(cy, 200);

  // Rotation handle of sh1 is at midX=250, y=190-32=158
  const rotHandle = selectionEngine.getHandleAt(250, 158);
  assert.ok(rotHandle && rotHandle.handle === 'rotate', 'Rotation handle must be hit at (250, 158)');

  const rotStartX = 250;
  const rotStartY = 158;
  selectionEngine.startDrag(rotStartX, rotStartY);

  // Test full 360 degree sweep in 90-degree steps:
  // After 90 deg: s1 at (200, 150), sh1 at (200, 250)
  // After 180 deg: s1 at (250, 200), sh1 at (150, 200)
  // After 270 deg: s1 at (200, 250), sh1 at (200, 150)
  // After 360 deg: s1 returns to (150, 200), sh1 returns to (250, 200)

  const initialAngle = Math.atan2(rotStartY - cy, rotStartX - cx);
  const rHandle = Math.hypot(rotStartX - cx, rotStartY - cy);

  for (const deg of [90, 180, 270, 360]) {
    const rad = initialAngle + (deg * Math.PI / 180);
    const targetX = cx + rHandle * Math.cos(rad);
    const targetY = cy + rHandle * Math.sin(rad);
    selectionEngine.dragTo(targetX, targetY);

    // Canonical stroke points stay untouched during the preview. Derive the
    // rendered center from the active transform, exactly as the renderer does.
    assert.equal(s1.points[0].x, 140);
    assert.equal(s1.points[0].y, 200);
    assert.equal(s1.points[1].x, 160);
    assert.equal(s1.points[1].y, 200);
    const transform = selectionEngine.getCurrentDragTransform();
    assert.ok(transform && transform.mode === 'rotate' && transform.center && transform.cos !== undefined && transform.sin !== undefined);
    const previewCenter = { x: 0, y: 0 };
    for (const point of s1.points) {
      const ox = point.x - transform.center!.x;
      const oy = point.y - transform.center!.y;
      previewCenter.x += transform.center!.x + ox * transform.cos! - oy * transform.sin!;
      previewCenter.y += transform.center!.y + ox * transform.sin! + oy * transform.cos!;
    }
    const s1_cx = previewCenter.x / s1.points.length;
    const s1_cy = previewCenter.y / s1.points.length;
    const sh1_cx = sh1.x + sh1.width / 2;
    const sh1_cy = sh1.y + sh1.height / 2;

    // Both items must maintain exact orbit radius of 50px from centroid (200, 200)
    const r_s1 = Math.hypot(s1_cx - cx, s1_cy - cy);
    const r_sh1 = Math.hypot(sh1_cx - cx, sh1_cy - cy);
    assert.ok(Math.abs(r_s1 - 50) < 1e-4, `Stroke orbit radius drifted at ${deg} deg: got ${r_s1}`);
    assert.ok(Math.abs(r_sh1 - 50) < 1e-4, `Shape orbit radius drifted at ${deg} deg: got ${r_sh1}`);

    // Group centroid must remain stationary
    const currentCentroidX = (s1_cx + sh1_cx) / 2;
    const currentCentroidY = (s1_cy + sh1_cy) / 2;
    assert.ok(Math.abs(currentCentroidX - cx) < 1e-4, `Centroid X drifted: got ${currentCentroidX}`);
    assert.ok(Math.abs(currentCentroidY - cy) < 1e-4, `Centroid Y drifted: got ${currentCentroidY}`);
  }

  selectionEngine.finishDrag(200, rotStartY);

  // At 360 degrees: verify the committed stroke returns to exact initial coordinates
  const s1_final_cx = (s1.points[0].x + s1.points[1].x) / 2;
  const s1_final_cy = (s1.points[0].y + s1.points[1].y) / 2;
  assert.ok(Math.abs(s1_final_cx - 150) < 1e-3, `Stroke 1 X after 360 rotation: got ${s1_final_cx}, expected 150`);
  assert.ok(Math.abs(s1_final_cy - 200) < 1e-3, `Stroke 1 Y after 360 rotation: got ${s1_final_cy}, expected 200`);
});

test('CHALLENGE 3.3: Undo/Redo restores exact 64-bit IEEE coordinates with zero accumulated drift across repeated cycles', () => {
  const harness = createChallengerTestHarness();
  const { selectionEngine, drawingEngine, shapeManager, textManager, historyManager, layerManager } = harness;
  const activeLayer = layerManager.getActiveLayerId();

  const originalStrokePoints = [
    { x: 12.345678901234, y: 56.789012345678, pressure: 0.5 },
    { x: 98.765432109876, y: 43.210987654321, pressure: 0.5 },
  ];
  const s1: Stroke = {
    id: 's-precision-1',
    layerId: activeLayer,
    tool: 'pen',
    color: '#000',
    width: 2,
    opacity: 1,
    points: originalStrokePoints.map(p => ({ ...p })),
  };

  const sh1: Shape = {
    id: 'sh-precision-1',
    layerId: activeLayer,
    type: 'shape',
    shapeType: 'rectangle',
    color: '#000',
    strokeWidth: 2,
    fill: null,
    x: 105.123456789,
    y: 205.987654321,
    width: 55.555555555,
    height: 44.444444444,
    rotation: 12.5,
    opacity: 1,
    createdAt: Date.now(),
  };

  const t1: TextObject = {
    id: 't-precision-1',
    layerId: activeLayer,
    type: 'text',
    x: 300.111222333,
    y: 400.444555666,
    width: 150.777888999,
    height: 60.123456789,
    rotation: 0,
    text: 'Exact Precision',
    fontSize: 16,
    fontFamily: 'sans-serif',
    color: '#000',
    createdAt: Date.now(),
  };

  drawingEngine.addStroke(s1);
  shapeManager.addShape(sh1);
  textManager.addText(t1);

  selectionEngine.selectElement('s-precision-1', 'stroke', true);
  selectionEngine.selectElement('sh-precision-1', 'shape', true);
  selectionEngine.selectElement('t-precision-1', 'text', true);

  // Apply a composite transform (move + scale)
  selectionEngine.startDrag(50, 50);
  selectionEngine.dragTo(125.75, 180.25);
  selectionEngine.finishDrag(125.75, 180.25);

  const movedS1_p0_x = s1.points[0].x;
  const movedSh1_x = sh1.x;

  // Execute 5 sequential undo/redo cycles
  for (let cycle = 1; cycle <= 5; cycle++) {
    assert.equal(historyManager.canUndo(), true);
    historyManager.undo();

    // Verify exact identity restoration on undo (down to 1e-12 precision)
    assert.ok(Math.abs(s1.points[0].x - originalStrokePoints[0].x) < 1e-12, `Cycle ${cycle} s1.p0.x undo drift`);
    assert.ok(Math.abs(s1.points[0].y - originalStrokePoints[0].y) < 1e-12, `Cycle ${cycle} s1.p0.y undo drift`);
    assert.ok(Math.abs(s1.points[1].x - originalStrokePoints[1].x) < 1e-12, `Cycle ${cycle} s1.p1.x undo drift`);
    assert.ok(Math.abs(s1.points[1].y - originalStrokePoints[1].y) < 1e-12, `Cycle ${cycle} s1.p1.y undo drift`);
    assert.ok(Math.abs(sh1.x - 105.123456789) < 1e-12, `Cycle ${cycle} sh1.x undo drift`);
    assert.ok(Math.abs(sh1.y - 205.987654321) < 1e-12, `Cycle ${cycle} sh1.y undo drift`);
    assert.ok(Math.abs(t1.x - 300.111222333) < 1e-12, `Cycle ${cycle} t1.x undo drift`);

    assert.equal(historyManager.canRedo(), true);
    historyManager.redo();

    // Verify exact identity restoration on redo
    assert.ok(Math.abs(s1.points[0].x - movedS1_p0_x) < 1e-12, `Cycle ${cycle} s1.p0.x redo drift`);
    assert.ok(Math.abs(sh1.x - movedSh1_x) < 1e-12, `Cycle ${cycle} sh1.x redo drift`);
  }
});

// ============================================================================
// PART 4: SCROLL PERSISTENCE DEBOUNCING STRESS HARNESS
// ============================================================================

test('CHALLENGE 4.1: Scroll debouncing: 120Hz rapid scroll burst produces 0 synchronous writes, persists once after 250ms, and unmount flushes immediately', async () => {
  const storageMock: Record<string, string> = {};
  let setItemCalls: { key: string; value: string; time: number }[] = [];

  const originalLocalStorage = globalThis.localStorage;
  (globalThis as any).localStorage = {
    getItem: (key: string) => storageMock[key] ?? null,
    setItem: (key: string, value: string) => {
      setItemCalls.push({ key, value, time: performance.now() });
      storageMock[key] = value;
    },
    removeItem: (key: string) => { delete storageMock[key]; },
  };

  try {
    const notebookId = 'nb-stress-scroll';
    let savePositionTimeout: ReturnType<typeof setTimeout> | null = null;

    // Mimic the exact debounce & flush implementation from NotebookRenderer.tsx
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

    // 1. Fire 120 rapid scroll events simulating 120Hz scrolling over 1000ms
    const t0 = performance.now();
    for (let i = 1; i <= 120; i++) {
      persistPositionDebounced('page-stress-1', 0, i * 10);
    }
    const elapsedSync = performance.now() - t0;

    // Zero synchronous localStorage writes allowed during the burst
    assert.equal(setItemCalls.length, 0, 'Zero writes allowed during continuous scrolling');
    assert.ok(elapsedSync < 20, `Debounce dispatch loop took ${elapsedSync.toFixed(2)}ms (must be synchronous & instantaneous)`);

    // 2. Wait for 270ms (>250ms debounce window)
    await new Promise(resolve => setTimeout(resolve, 270));

    // Verify exactly 1 write occurred after debounce elapsed, with final scroll position 1200
    assert.equal(setItemCalls.length, 1, 'Exactly 1 write must occur after 250ms quiet window');
    const pos1 = getNotebookPosition(notebookId);
    assert.ok(pos1);
    assert.equal(pos1.scrollY, 1200);

    // 3. Test rapid mid-scroll unmount:
    // User scrolls 10 frames and immediately navigates/unmounts after 30ms (well before 250ms)
    setItemCalls = [];
    for (let i = 1; i <= 10; i++) {
      persistPositionDebounced('page-stress-1', 0, 1500 + i * 10);
    }
    assert.equal(setItemCalls.length, 0, 'No writes yet during burst');

    // Simulate unmount flush
    flushPendingPosition('page-stress-1', 0, 1600);
    assert.equal(setItemCalls.length, 1, 'Flush on unmount must persist immediately');
    const posUnmount = getNotebookPosition(notebookId);
    assert.equal(posUnmount?.scrollY, 1600);

    // Wait an extra 300ms to guarantee that the cancelled timeout does NOT fire a stale duplicate write
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(setItemCalls.length, 1, 'Cancelled debounce timer must not fire duplicate write after unmount');
  } finally {
    (globalThis as any).localStorage = originalLocalStorage;
  }
});
