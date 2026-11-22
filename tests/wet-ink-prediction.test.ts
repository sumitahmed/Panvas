import assert from 'node:assert/strict';
import test from 'node:test';
import { WetInkSurface } from '../src/components/notebook/engine/WetInkSurface.ts';
import { InputManager } from '../src/components/notebook/engine/InputManager.ts';
import { ViewportManager } from '../src/components/notebook/engine/ViewportManager.ts';
import { ToolManager } from '../src/components/notebook/engine/ToolManager.ts';
import { RulerManager } from '../src/components/notebook/engine/RulerManager.ts';
import type { Stroke, StrokePoint } from '../src/components/notebook/engine/drawingTypes.ts';

function createMockContext(width = 800, height = 600) {
  const ops: Array<{ op: string; args: unknown[] }> = [];
  const canvas: any = {
    width,
    height,
    style: { zIndex: '10', opacity: '1', left: '0px', top: '0px', width: `${width}px`, height: `${height}px` },
    dataset: {},
    isConnected: true,
    attributes: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this.attributes[k] = v; },
    insertAdjacentElement() {},
    remove() { this.isConnected = false; },
    getContext() { return ctx; },
  };
  const ctx: any = {
    canvas,
    fillStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save() { ops.push({ op: 'save', args: [] }); },
    restore() { ops.push({ op: 'restore', args: [] }); },
    resetTransform() { ops.push({ op: 'resetTransform', args: [] }); },
    setTransform(...args: unknown[]) { ops.push({ op: 'setTransform', args }); },
    beginPath() { ops.push({ op: 'beginPath', args: [] }); },
    rect(...args: unknown[]) { ops.push({ op: 'rect', args }); },
    clip() { ops.push({ op: 'clip', args: [] }); },
    clearRect(...args: unknown[]) { ops.push({ op: 'clearRect', args }); },
    drawImage(...args: unknown[]) { ops.push({ op: 'drawImage', args }); },
    moveTo(...args: unknown[]) { ops.push({ op: 'moveTo', args }); },
    lineTo(...args: unknown[]) { ops.push({ op: 'lineTo', args }); },
    arc(...args: unknown[]) { ops.push({ op: 'arc', args }); },
    closePath() {},
    fill() { ops.push({ op: 'fill', args: [] }); },
  };
  return { canvas, ctx, ops };
}

test('WetInkSurface renders ephemeral predicted points without mutating prefix or committing them on commit()', () => {
  const prevDoc = (globalThis as any).document;
  const createdContexts: Array<ReturnType<typeof createMockContext>> = [];
  (globalThis as any).document = {
    createElement(tag: string) {
      assert.equal(tag, 'canvas');
      const created = createMockContext(800, 600);
      createdContexts.push(created);
      return created.canvas;
    },
  };
  try {
    const target = createMockContext(800, 600);
    const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } as DOMMatrix;
    const surface = new WetInkSurface(target.ctx, matrix);
    const [liveBuf, prefixBuf] = createdContexts;

    const stroke: Stroke = {
      id: '__live__',
      type: 'stroke',
      tool: 'pen',
      color: '#111827',
      thickness: 3,
      opacity: 1,
      pattern: 'solid',
      centerline: 'polyline',
      createdAt: 0,
      points: [
        { x: 20, y: 20, pressure: 0.5, t: 0 },
        { x: 40, y: 20, pressure: 0.5, t: 8 },
        { x: 60, y: 20, pressure: 0.5, t: 16 },
        { x: 80, y: 20, pressure: 0.5, t: 24 },
      ],
    };
    const predicted: StrokePoint[] = [
      { x: 92, y: 20, pressure: 0.5, t: 32 },
      { x: 100, y: 20, pressure: 0.5, t: 40 },
    ];
    const pointCountBefore = stroke.points.length;

    surface.render(stroke, Infinity, predicted);
    assert.equal(stroke.points.length, pointCountBefore, 'predicted points must never mutate stroke.points');

    // Predicted endpoint (100) must appear in liveBuf.arc/lineTo ops, NOT in prefixBuf
    const liveHasPredX = liveBuf.ops.some(o => (o.op === 'lineTo' || o.op === 'moveTo') && Number(o.args[0]) >= 99);
    const prefixHasPredX = prefixBuf.ops.some(o => (o.op === 'lineTo' || o.op === 'moveTo') && Number(o.args[0]) >= 90);
    assert.equal(liveHasPredX, true, 'predicted extension must paint onto live WetInkSurface');
    assert.equal(prefixHasPredX, false, 'predicted extension must NEVER enter immutable prefix');

    // commit() must first strip ephemeral predicted pixels before drawing to target
    liveBuf.ops.length = 0;
    surface.commit(stroke);
    const finalClearBeforeCommit = liveBuf.ops.findIndex(o => o.op === 'clearRect');
    assert.ok(finalClearBeforeCommit >= 0, 'commit must clear ephemeral prediction tail before blitting to target');
    const postClearMaxX = Math.max(
      ...liveBuf.ops
        .filter((o, idx) => idx > finalClearBeforeCommit && (o.op === 'lineTo' || o.op === 'moveTo'))
        .map(o => Number(o.args[0])),
      0,
    );
    assert.ok(postClearMaxX <= 86, `final commit redraw must stop at real tip ~80, got ${postClearMaxX}`);
  } finally {
    (globalThis as any).document = prevDoc;
  }
});

test('InputManager clamps OS predicted events (<= 2 samples, <= 24 CSS px), excludes them from committed points, and caches rect across tools', () => {
  const prevRaf = (globalThis as any).requestAnimationFrame;
  const prevCaf = (globalThis as any).cancelAnimationFrame;
  const pendingRafTimers = new Set<ReturnType<typeof setTimeout>>();
  (globalThis as any).requestAnimationFrame = (cb: (ts: number) => void) => {
    const id = setTimeout(() => {
      pendingRafTimers.delete(id);
      cb(Date.now());
    }, 0);
    pendingRafTimers.add(id);
    return id as unknown as number;
  };
  (globalThis as any).cancelAnimationFrame = (id: number) => {
    const timerId = id as unknown as ReturnType<typeof setTimeout>;
    pendingRafTimers.delete(timerId);
    clearTimeout(timerId);
  };
  try {
  const toolManager = new ToolManager();
  const viewport = new ViewportManager();
  const liveCalls: Array<{ pointsLen: number; predicted: StrokePoint[] | undefined }> = [];
  const committedStrokes: Stroke[] = [];

  const drawingEngine: any = {
    beginLiveStroke() {},
    endLiveStroke() {},
    renderLiveStroke(points: StrokePoint[], _tool: any, _color: any, _thick: any, _op: any, _pat: any, _fam: any, _tip: any, _rev: any, predicted?: readonly StrokePoint[]) {
      liveCalls.push({ pointsLen: points.length, predicted: predicted ? predicted.map(p => ({ ...p })) : undefined });
    },
    commitLiveStroke() {},
    addStroke(stroke: Stroke) { committedStrokes.push(structuredClone(stroke)); },
    getStrokes() { return committedStrokes; },
    redraw() {},
    canEditActiveLayer() { return true; },
    ensureSurfaceReadyForInteraction() {},
    warmSelectionBacking() {},
    releaseSelectionSurfaces() {},
    startLasso() {},
    endLasso() {},
    renderLasso() {},
    renderLiveShapePreview() {},
    clearLiveShapePreview() {},
  };
  const eraserEngine: any = {
    startErasing() {},
    eraseSweep() { return false; },
    present() {},
    finishErasing() { return false; },
    eraseAt() { return false; },
    erasePoint() { return false; },
    eraseBatch() { return false; },
    endStroke() { return false; },
    reset() {},
    setRulerManager() {},
    setHistoryChangeCallback() {},
  };
  const shapeManager: any = { addShape() {}, getShapes() { return []; }, removeShape() {} };
  const selectionEngine: any = {
    getSelectedElements() { return []; },
    clearSelection() {},
    shouldDragFreeformRegion() { return false; },
    getHandleAt() { return null; },
    selectAt() { return false; },
    withDeferredSelectionNotifications(fn: () => boolean) { return fn(); },
    selectWithinLoop() {},
    flushPendingSelectionRedraw() {},
  };
  const historyManager: any = { pushExecuted() {} };
  const textManager: any = { getTexts() { return []; }, clearActiveTextId() {} };
  const rulerManager = new RulerManager();
  const laserManager: any = { addPoint() {}, clear() {} };

  let rectReads = 0;
  const listeners = new Map<string, Array<(e: any) => void>>();
  const canvas: any = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener(type: string, fn: any) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener() {},
    getBoundingClientRect() {
      rectReads += 1;
      return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
    },
  };

  const input = new InputManager(
    toolManager, viewport, drawingEngine, eraserEngine, shapeManager, selectionEngine, historyManager, textManager, rulerManager, laserManager,
  );
  input.attach(canvas);

  let fakeTime = 1000;
  const emit = (type: string, extra: Record<string, any>) => {
    fakeTime += 8;
    for (const fn of listeners.get(type) ?? []) {
      fn({ button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'pen', pointerId: 1, pressure: 0.5, timeStamp: fakeTime, clientX: 50, clientY: 50, type, ...extra });
    }
  };

  // 1. Pen draw with 3 predicted samples (where 3rd is >24 CSS px away)
  toolManager.setMode('draw');
  toolManager.setDrawingTool('pen');
  rectReads = 0;
  emit('pointerdown', { clientX: 50, clientY: 50 });
  emit('pointermove', {
    clientX: 70,
    clientY: 50,
    getCoalescedEvents: () => [],
    getPredictedEvents: () => [
      { clientX: 78, clientY: 50, pointerType: 'pen', pressure: 0.5 }, // +8px -> kept
      { clientX: 88, clientY: 50, pointerType: 'pen', pressure: 0.5 }, // +18px cumulative -> kept
      { clientX: 120, clientY: 50, pointerType: 'pen', pressure: 0.5 }, // clamped (3rd AND >24px)
    ],
  });
  const moveLive = liveCalls[liveCalls.length - 1];
  assert.ok(moveLive.predicted && moveLive.predicted.length === 2, 'must accept at most 2 bounded predicted samples within 24px');
  assert.equal(moveLive.predicted[0].x, 78);
  assert.equal(moveLive.predicted[1].x, 88);
  emit('pointerup', { clientX: 70, clientY: 50 });
  assert.equal(committedStrokes.length, 1);
  assert.ok(committedStrokes[0].points.every(p => p.x <= 70.001), 'predicted points must NEVER enter committed stroke.points');
  assert.equal(rectReads, 1, 'pen gesture must read getBoundingClientRect only once on pointerdown');

  // 2. Eraser + Select gestures must also cache bounding client rect across move events
  toolManager.setMode('erase');
  rectReads = 0;
  emit('pointerdown', { clientX: 100, clientY: 100 });
  for (let i = 1; i <= 5; i += 1) emit('pointermove', { clientX: 100 + i * 5, clientY: 100 });
  emit('pointerup', { clientX: 125, clientY: 100 });
  // One read on pointerdown + one if finish/enqueue doesn't re-read: strictly <= 1
  assert.equal(rectReads, 1, `eraser gesture must cache rect on pointerdown (got ${rectReads} reads)`);

  toolManager.setMode('select');
  rectReads = 0;
  emit('pointerdown', { clientX: 150, clientY: 150 });
  for (let i = 1; i <= 5; i += 1) emit('pointermove', { clientX: 150 + i * 5, clientY: 150 });
  emit('pointerup', { clientX: 175, clientY: 150 });
  assert.equal(rectReads, 1, `select/lasso gesture must cache rect on pointerdown (got ${rectReads} reads)`);
  } finally {
    for (const timerId of pendingRafTimers) clearTimeout(timerId);
    pendingRafTimers.clear();
    (globalThis as any).requestAnimationFrame = prevRaf;
    (globalThis as any).cancelAnimationFrame = prevCaf;
  }
});
