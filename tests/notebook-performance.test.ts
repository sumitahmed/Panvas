import assert from 'node:assert/strict';
import test from 'node:test';
import { residentPageIds, reuseResidentPageIds } from '../src/components/notebook/pageVisualWindow.ts';
import { InputManager } from '../src/components/notebook/engine/InputManager.ts';
import { ToolManager } from '../src/components/notebook/engine/ToolManager.ts';
import { WetInkSurface } from '../src/components/notebook/engine/WetInkSurface.ts';
import { getBrowserCanvasVisualScale, resolveCanvasBackingScale, ViewportManager } from '../src/components/notebook/engine/ViewportManager.ts';

test('120 scroll positions within the same resident rows retain React state identity', () => {
  const positions = Array.from({ length: 24 }, (_, i) => ({ id: `${i}`, x: 0, y: i * 1140, width: 794, height: 1123 }));
  const original = residentPageIds(positions, 0, 1400);
  for (let top = 0; top < 120; top++) assert.equal(reuseResidentPageIds(original, residentPageIds(positions, top, 1400)), original);
  const next = residentPageIds(positions, 4000, 1400);
  assert.equal(reuseResidentPageIds(original, next), next, 'new resident rows publish new state');
  const replacement = new Set(['different', ...[...original].slice(1)]);
  assert.equal(reuseResidentPageIds(original, replacement), replacement, 'same count with different IDs still updates');
});

for (const [name, dpr, visual] of [['phone', 3, 1], ['Desktop Site phone', 3, 390 / 980], ['desktop', 1, 1]] as const) {
  test(`${name} raster follows physical pixels without changing document coordinates`, () => {
    const zoom = 1.05;
    assert.equal(resolveCanvasBackingScale(dpr, zoom, 794, 1123, visual), dpr * zoom * visual);
    const viewport = new ViewportManager();
    viewport.setZoom(zoom);
    assert.deepEqual(viewport.screenToPage(210, 315), { x: 200, y: 300 });
    assert.deepEqual(viewport.pageToScreen(200, 300), { x: 210, y: 315 });
  });
}

test('invalid browser scales retain the original backing detail', () => {
  for (const scale of [0, -1, NaN, Infinity]) assert.equal(resolveCanvasBackingScale(3, 1, 794, 1123, scale), 3);
  assert.equal(resolveCanvasBackingScale(3, 1, 794, 1123), 3);
});

function withDom(run: () => void, touch = true, scale = 390 / 980) {
  const names = ['window', 'document', 'navigator'] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
    onpointerrawupdate: null, devicePixelRatio: 3, visualViewport: { scale },
    matchMedia: () => ({ matches: false }),
  }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: 'visible' }) });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { maxTouchPoints: touch ? 1 : 0 } });
  try { run(); } finally {
    names.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!);
      else delete (globalThis as any)[name];
    });
  }
}

test('canvas configuration applies touch visual scale to raster only', () => withDom(() => {
  const viewport = new ViewportManager();
  const transforms: number[][] = [];
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ({ scale: (...args: number[]) => transforms.push(args) }) };
  viewport.configureCanvas(canvas as any, 794, 1123, 1.05);
  const backing = 3 * 1.05 * (390 / 980);
  assert.equal(canvas.width, Math.floor(794 * backing));
  assert.equal(canvas.height, Math.floor(1123 * backing));
  assert.deepEqual(canvas.style, { width: '794px', height: '1123px' });
  assert.deepEqual(transforms, [[backing, backing]]);
  assert.equal(viewport.getDevicePixelRatio(), 3, 'coordinate clients still see raw DPR');
}));

test('fine mouse desktop retains full detail even with a reported visual scale', () => withDom(() => {
  assert.equal(getBrowserCanvasVisualScale(), 1);
  assert.equal(new ViewportManager().getCanvasBackingScale(1, 794, 1123), 3);
}, false));

class Surface extends EventTarget {
  writes = 0;
  top = 0;
  left = 0;
  get scrollTop() { return this.top; }
  set scrollTop(value: number) { this.top = value; this.writes++; }
  get scrollLeft() { return this.left; }
  set scrollLeft(value: number) { this.left = value; this.writes++; }
  style = { touchAction: '', removeProperty() {} };
  closest() { return this; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0 }; }
}
function pointer(surface: Surface, type: string, y: number) {
  const event = new Event(type);
  Object.assign(event, { pointerType: 'touch', pointerId: 17, clientX: 50, clientY: y, button: 0, buttons: 1 });
  surface.dispatchEvent(event);
}
function harness() {
  const surface = new Surface();
  const tools = new ToolManager();
  tools.setMode('hand');
  const input = new InputManager(tools, new ViewportManager(),
    { redraw() {}, endLiveStroke() {} } as any, { setRulerManager() {}, setHistoryChangeCallback() {} } as any,
    {} as any, {} as any, {} as any, {} as any, { setEnabled() { return false; } } as any, { clear() {} } as any);
  input.attach(surface as any);
  return { input, surface };
}

test('480 raw Hand samples plus 120 display moves produce only 120 scroll pairs', () => withDom(() => {
  const { input, surface } = harness();
  pointer(surface, 'pointerdown', 400);
  for (let frame = 1; frame <= 120; frame++) {
    for (let raw = 1; raw <= 4; raw++) pointer(surface, 'pointerrawupdate', 400 - frame + (4 - raw) / 4);
    pointer(surface, 'pointermove', 400 - frame);
  }
  assert.equal(surface.writes, 240);
  assert.equal(surface.scrollTop, 120);
  let final = -1;
  input.navigationGestures.onIdle(() => { final = surface.scrollTop; });
  pointer(surface, 'pointerup', 280);
  assert.equal(final, 120, 'final scroll is applied before the lifecycle releases');
  assert.equal(input.navigationGestures.active, false);
  input.detach();
}));

for (const mode of ['draw', 'erase', 'ruler', 'laser']) {
  test(`raw ${mode} samples still reach the original high fidelity handler`, () => withDom(() => {
    const { input, surface } = harness();
    const runtime = input as any;
    let samples = 0;
    if (mode === 'draw') { runtime.isDrawing = true; runtime.strokeModeAtStart = 'draw'; runtime.continueDrawing = () => samples++; }
    if (mode === 'erase') { runtime.eraserGesture = { pointerId: 17 }; runtime.continueErasing = () => samples++; }
    if (mode === 'ruler') { runtime.rulerDragMode = 'move'; runtime.continueRulerInteraction = () => samples++; }
    if (mode === 'laser') { runtime.laserPointerActive = true; runtime.continueLaser = () => samples++; }
    for (let sample = 1; sample <= 10; sample++) pointer(surface, 'pointerrawupdate', 400 - sample);
    assert.equal(samples, 10);
    runtime.isDrawing = false; runtime.eraserGesture = null; runtime.rulerDragMode = null; runtime.laserPointerActive = false;
    input.detach();
  }));
}

function fakeCanvasContext(canvas: any) {
  return {
    canvas,
    fillStyle: '',
    resetTransform() {}, clearRect() {}, save() {}, restore() {}, setTransform() {},
    beginPath() {}, rect() {}, clip() {}, drawImage() {}, fill() {},
    moveTo() {}, lineTo() {}, arc() {}, closePath() {},
  };
}

function fakeCanvas(connected = false) {
  const style: any = {};
  let opacityWrites = 0;
  Object.defineProperty(style, 'opacity', {
    enumerable: true,
    get: () => style._opacity ?? '',
    set: (value: string) => { style._opacity = value; opacityWrites++; },
  });
  const canvas: any = {
    width: 120, height: 90, style, dataset: {}, isConnected: connected,
    setAttribute() {},
    remove() { canvas.isConnected = false; },
    getContext() { return fakeCanvasContext(canvas); },
    get opacityWrites() { return opacityWrites; },
  };
  return canvas;
}

function withCanvasDom(run: () => void) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => fakeCanvas(),
  } });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ zIndex: '10' }) });
  try { run(); } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as any).document;
    if (previousComputedStyle) Object.defineProperty(globalThis, 'getComputedStyle', previousComputedStyle);
    else delete (globalThis as any).getComputedStyle;
  }
}

test('wet ink keeps one connected spare across a handwriting burst and avoids redundant opacity writes', () => withCanvasDom(() => {
  const targetCanvas = fakeCanvas(true);
  targetCanvas.style = { left: '0px', top: '0px', width: '120px', height: '90px' };
  targetCanvas.insertions = 0;
  targetCanvas.insertAdjacentElement = (_position: string, node: any) => {
    node.isConnected = true;
    targetCanvas.insertions++;
  };
  const target = { canvas: targetCanvas } as any;
  const transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } as any;
  const surface = new WetInkSurface(target, transform);
  assert.equal(targetCanvas.insertions, 1);

  const stroke = {
    id: 'live', type: 'stroke', tool: 'pen', color: '#111', opacity: 0.4, thickness: 2, createdAt: 0,
    points: [{ x: 4, y: 4, pressure: 0.5, t: 0 }, { x: 12, y: 10, pressure: 0.5, t: 8 }],
  } as any;
  surface.render(stroke);
  assert.equal(surface.canvas.style.opacity, '0.4');
  const writes = (surface.canvas as any).opacityWrites;
  surface.render(stroke);
  assert.equal((surface.canvas as any).opacityWrites, writes, 'unchanged opacity must not dirty the canvas style');

  surface.pause();
  assert.equal(surface.canvas.isConnected, true, 'transparent spare stays connected between adjacent strokes');
  assert.equal(surface.canvas.style.opacity, '0');
  surface.resume(transform);
  assert.equal(targetCanvas.insertions, 1, 'resuming a connected spare must not reinsert it');
  surface.render(stroke);
  assert.equal(surface.canvas.style.opacity, '0.4', 'resumed surface restores ink opacity');

  surface.dispose();
  assert.equal(surface.canvas.isConnected, false);
}));
