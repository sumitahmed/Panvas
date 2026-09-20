import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import path from 'node:path';
import { InkSamples, type InkDispatch } from '../src/components/notebook/engine/inkSamples.ts';
import { createEmptyDrawingData, type Stroke, type StrokePoint } from '../src/components/notebook/engine/drawingTypes.ts';
import { InkInputFilter, mapPointerPressure } from '../src/components/notebook/engine/inkInput.ts';
import { PenGeometry } from '../src/components/notebook/engine/penGeometry.ts';
import { DrawingSaveScheduler } from '../src/components/notebook/drawingSaveScheduler.ts';
import { handwritingPaths, handwritingPath, geometryMetrics, pathDistance } from './fixtures/handwritingPaths.ts';

for (const name of Object.keys(handwritingPaths)) test(`${name}: same physical trajectory at 60/120/240Hz, zero filter error`, () => {
  const reference = handwritingPath(name, 960);
  for (const hz of [60,120,240]) {
    const raw = handwritingPath(name,hz);
    const filter = new InkInputFilter();
    const filtered = raw.map(p=>filter.push(p,52));
    const metrics = geometryMetrics(raw,filtered);
    assert.equal(metrics.maxDeviation,0);
    assert.equal(metrics.endpointError,0);
    assert.equal(metrics.pathLengthRatio,1);
    assert.equal(metrics.maxTurnErrorRadians,0);
    if (metrics.loopAreaRatio !== null) assert.equal(metrics.loopAreaRatio,1);
    assert.ok(Math.max(...reference.map(p=>pathDistance(p,filtered))) < .5, 'only bounded sampling/chord error, no added deformation');
  }
});

test('pressure ramps are linear with no temporal lag', () => {
  const filter = new InkInputFilter();
  for (let i=1;i<=100;i++) {
    const pressure=i/100;
    assert.equal(mapPointerPressure('pen',pressure,true),pressure);
    assert.equal(filter.push({x:i,y:0,pressure,t:i},100).pressure,pressure);
  }
});

test('incremental nib prefix never freezes geometry that later samples alter', () => {
  const commandPath = () => {
    const calls: unknown[]=[];
    const path = Object.fromEntries(['moveTo','lineTo','arc','rect','closePath'].map(name=>[name,(...args: number[])=>calls.push([name,...args])])) as unknown as Path2D;
    return {path,calls};
  };
  for (const inkFamily of [undefined,'ballpoint','fountain','brush','felt'] as const) {
    const points: StrokePoint[]=[];
    const geometry=new PenGeometry();
    const stroke={id:'prefix',type:'stroke' as const,tool:'pen' as const,points,color:'#000',opacity:.4,thickness:3,createdAt:0,inkFamily};
    let stable=0, previous: unknown[]=[];
    for (const p of handwritingPath('cursive',120)) {
      points.push(p); geometry.update(points);
      const check=commandPath(); geometry.trace(check.path,stroke,0,stable);
      assert.deepEqual(check.calls,previous,`${inkFamily}: stable prefix changed`);
      stable=geometry.stableEnd(stroke);
      const next=commandPath(); geometry.trace(next.path,stroke,0,stable); previous=next.calls;
    }
  }
});

const sample = (timeStamp: number, clientX: number, clientY: number, pressure = .5): InkDispatch =>
  ({ type: 'pointermove', pointerId: 7, pointerType: 'pen', timeStamp, clientX, clientY, pressure });

for (const type of ['pointermove', 'pointerrawupdate']) test(`${type}: keeps three coalesced samples plus missing dispatch endpoint`, () => {
  const stream = new InkSamples(sample(0, 0, 0));
  stream.consume({ ...sample(4, 4, 0), type, getCoalescedEvents: () => [sample(3, 3, 0), sample(1, 1, 0), sample(2, 2, 0)] });
  assert.deepEqual(stream.samples.map(p => p.clientX), [1, 2, 3, 4]);
});

test('transport overlap retains late unique corners, pressure changes and timestamp-only samples', () => {
  const stream = new InkSamples(sample(0, 0, 0));
  stream.consume({ ...sample(3, 10, 10), type: 'pointerrawupdate', getCoalescedEvents: () => [sample(1, 0, 0)] });
  const result = stream.consume({ ...sample(3, 10, 10), getCoalescedEvents: () => [sample(1, 0, 0), sample(2, 10, 0), sample(3, 10, 10)] });
  assert.equal(result.added, 1);
  assert.equal(result.rebuild, true);
  assert.deepEqual(stream.samples.map(p => [p.clientX, p.clientY]), [[0, 0], [10, 0], [10, 10]]);
  stream.consume(sample(4, 10, 10, .8));
  stream.consume(sample(5, 10, 10, .8));
  assert.equal(stream.samples.length, 5);
});

test('drawing save deadline defers during pen contact and coalesces to the latest revision', async () => {
  const saved: number[] = [];
  const events: string[] = [];
  const scheduler = new DrawingSaveScheduler<{ revision: number }>(snapshot => saved.push(snapshot.revision), {
    debounceMs: 20,
    quietMs: 10,
    onEvent: event => events.push(event.type),
  });
  scheduler.setGestureActive(true);
  scheduler.enqueue({ revision: 1 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(saved, []);
  assert.ok(events.includes('saveDeferredBecausePenActive'));
  scheduler.enqueue({ revision: 2 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(saved, []);
  scheduler.setGestureActive(false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(saved, [2]);
  scheduler.setGestureActive(true);
  scheduler.enqueue({ revision: 3 });
  assert.deepEqual(scheduler.flush(), { revision: 3 });
  assert.deepEqual(saved, [2, 3]);
});

test('dense 2000-stroke persistence work begins only after contact quiets', async () => {
  const engine = new NotebookEngine();
  engine.setDrawingData(createEmptyDrawingData(), 'dense');
  const trajectory = handwritingPath('cursive', 64);
  const denseStrokes: Stroke[] = Array.from({ length: 2000 }, (_, index) => ({
    id: `dense-${index}`,
    type: 'stroke',
    tool: 'pen',
    points: trajectory.map(point => ({ ...point, x: point.x + (index % 40) * 22, y: point.y + Math.floor(index / 40) * 18 })),
    color: '#20242a',
    opacity: 1,
    thickness: 2,
    createdAt: index,
    centerline: 'polyline',
  }));
  engine.drawing.setStrokes(denseStrokes);
  let active = true;
  const saves: Array<{ revision: number; captureMs: number; stringifyMs: number; active: boolean }> = [];
  const scheduler = new DrawingSaveScheduler<{ revision: number }>(snapshot => {
    const captureStarted = performance.now();
    const data = engine.getDrawingData();
    const captureMs = performance.now() - captureStarted;
    const stringifyStarted = performance.now();
    JSON.stringify(data);
    const stringifyMs = performance.now() - stringifyStarted;
    saves.push({ revision: snapshot.revision, captureMs, stringifyMs, active });
  }, { debounceMs: 15, quietMs: 10 });
  scheduler.setGestureActive(active);
  scheduler.enqueue({ revision: 1 });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(saves.length, 0, 'dense persistence started during pen contact');
  scheduler.enqueue({ revision: 2 });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(saves.length, 0, 'superseded dense persistence started during pen contact');
  active = false;
  scheduler.setGestureActive(active);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].revision, 2);
  assert.equal(saves[0].active, false);
  assert.ok(saves[0].captureMs >= 0 && saves[0].stringifyMs >= 0);
  const processEnv = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (processEnv?.PANVAS_DENSE_BENCHMARK === '1') {
    console.log(JSON.stringify({ denseStrokes: denseStrokes.length, saveCount: saves.length, save: saves[0] }));
  }
  engine.destroy();
});

test('240Hz loop returns to its start without losing topology or timing', () => {
  const points = Array.from({ length: 49 }, (_, i) => sample(i * 1000 / 240, 10 * Math.cos(i * Math.PI / 24), 10 * Math.sin(i * Math.PI / 24)));
  const stream = new InkSamples(points[0]);
  stream.consume({ ...points.at(-1)!, getCoalescedEvents: () => points });
  assert.deepEqual(stream.samples.map(p => [p.clientX, p.clientY, p.timeStamp]), points.map(p => [p.clientX, p.clientY, p.timeStamp]));
});

let server: ViteDevServer;
let NotebookEngine: typeof import('../src/components/notebook/engine/NotebookEngine.ts').NotebookEngine;
before(async () => {
  server = await createServer({ configFile: false, root: process.cwd(), appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, resolve: { alias: { '@': path.resolve('src') } } });
  ({ NotebookEngine } = await server.ssrLoadModule('/src/components/notebook/engine/NotebookEngine.ts'));
});
after(async () => { await server?.close(); });

function fixture(t: test.TestContext, stabilization = 0) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const win = Object.assign(new EventTarget(), { onpointerrawupdate: null, devicePixelRatio: 1,
    localStorage: { getItem: () => null }, location: { search: '' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  const engine = new NotebookEngine();
  const canvas = Object.assign(new EventTarget(), { clientWidth: 800, clientHeight: 1000, width: 800, height: 1000,
    style: { removeProperty() {} }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 1000 }),
    setPointerCapture() {}, releasePointerCapture() {} }) as unknown as HTMLCanvasElement;
  engine.setDrawingData(createEmptyDrawingData(), 'A');
  engine.input.attach(canvas);
  engine.tools.setMode('draw');
  engine.tools.setStabilization(stabilization);
  engine.drawing.redraw = () => {};
  let live: StrokePoint[] = [];
  engine.drawing.renderLiveStroke = (points, _tool, _color, _thickness, _opacity, _pattern, _family, tip) => {
    live = structuredClone(tip && (points.at(-1)?.x !== tip.x || points.at(-1)?.y !== tip.y) ? [...points, tip] : points);
  };
  const emit = (type: string, time: number, x: number, y: number, extras: Record<string, unknown> = {}) => {
    const event = new Event(type);
    Object.defineProperty(event, 'timeStamp', { value: time });
    Object.assign(event, { pointerId: 7, pointerType: 'pen', clientX: x, clientY: y, pressure: .5,
      button: type === 'pointerdown' ? 0 : -1, buttons: type === 'pointerup' ? 0 : 1, ...extras });
    canvas.dispatchEvent(event);
  };
  t.after(() => {
    engine.destroy();
    if (saved) Object.defineProperty(globalThis, 'window', saved); else Reflect.deleteProperty(globalThis, 'window');
  });
  return { engine, emit, live: () => live };
}

test('actual input keeps raw history, late move corner, pressure and original relative timestamps', t => {
  const f = fixture(t);
  f.emit('pointerdown', 100, 0, 0);
  f.emit('pointerrawupdate', 130, 10, 10, { getCoalescedEvents: () => [sample(110, 5, 0)] });
  f.emit('pointermove', 130, 10, 10, { getCoalescedEvents: () => [sample(110, 5, 0), sample(120, 10, 0)] });
  f.emit('pointermove', 140, 10, 10, { pressure: .8 });
  f.emit('pointerup', 150, 10, 10, { pressure: 0 });
  const points = f.engine.drawing.getStrokes()[0].points;
  assert.deepEqual(points.map(p => [p.x, p.y, p.t]), [[0, 0, 0], [5, 0, 10], [10, 0, 20], [10, 10, 30], [10, 10, 40]]);
  assert.ok(points.at(-1)!.pressure > points.at(-2)!.pressure);
});

test('drawing contact lifecycle is emitted independently of recognition eligibility', t => {
  const f = fixture(t);
  const lifecycle: boolean[] = [];
  f.engine.onDrawingGestureLifecycle(active => lifecycle.push(active));
  f.emit('pointerdown', 0, 0, 0);
  f.emit('pointercancel', 10, 1, 1);
  assert.deepEqual(lifecycle, [true, false]);
  lifecycle.length = 0;
  f.emit('pointerdown', 20, 0, 0);
  f.engine.setDrawingData(createEmptyDrawingData(), 'B');
  assert.deepEqual(lifecycle, [true, false]);
});

test('pointer-up terminal survives stabilization and matches the physical tip', t => {
  const f = fixture(t, 52);
  f.emit('pointerdown', 100, 0, 0);
  f.emit('pointermove', 110, 100, 100);
  assert.deepEqual([f.live().at(-1)!.x, f.live().at(-1)!.y], [100, 100]);
  f.emit('pointerup', 120, 110, 106);
  const end = f.engine.drawing.getStrokes()[0].points.at(-1)!;
  assert.ok(Math.hypot(end.x - 110, end.y - 106) < 1e-10);
  assert.equal(end.t, 20);
});

test('stationary lift commits exactly the last live geometry without shortening', t => {
  const f = fixture(t, 52);
  f.emit('pointerdown', 0, 0, 0);
  f.emit('pointermove', 10, 10, 12);
  const preview = f.live();
  f.emit('pointerup', 20, 10, 12, { pressure: 0 });
  assert.deepEqual(f.engine.drawing.getStrokes()[0].points, preview);
});

test('tap renders a dot and survives undo/redo and actual engine serialization/reload', t => {
  const f = fixture(t);
  f.emit('pointerdown', 0, 20, 30);
  f.emit('pointerup', 10, 20, 30, { pressure: 0 });
  const original = structuredClone(f.engine.drawing.getStrokes());
  assert.equal(original[0].points.length, 1);
  let marks = 0;
  const ctx = { save() {}, restore() {}, beginPath() {}, moveTo() {}, closePath() {}, arc() { marks++; }, fill() {}, rect() { marks++; }, fillRect() { marks++; } } as unknown as CanvasRenderingContext2D;
  f.engine.drawing.renderStroke(ctx, original[0]);
  assert.equal(marks, 1);
  for (const inkFamily of ['ballpoint', 'fountain', 'brush', 'felt'] as const) {
    f.engine.drawing.renderStroke(ctx, { ...original[0], inkFamily });
  }
  assert.equal(marks, 5);
  f.engine.history.undo(); assert.equal(f.engine.drawing.getStrokes().length, 0);
  f.engine.history.redo(); assert.deepEqual(f.engine.drawing.getStrokes(), original);
  f.engine.setDrawingData(JSON.parse(JSON.stringify(f.engine.getDrawingData())), 'A');
  assert.deepEqual(f.engine.drawing.getStrokes(), JSON.parse(JSON.stringify(original)));
  f.engine.drawing.renderStroke(ctx, f.engine.drawing.getStrokes()[0]); assert.equal(marks, 6);
});

test('foreign pointer down/move/up cannot overwrite, cancel or finish ink; page replacement invalidates it', t => {
  const f = fixture(t);
  f.emit('pointerdown', 0, 0, 0);
  f.emit('pointerdown', 1, 900, 900, { pointerId: 8 });
  f.emit('pointermove', 2, 900, 900, { pointerId: 8, buttons: 0 });
  f.emit('pointerup', 3, 900, 900, { pointerType: 'mouse' });
  f.emit('pointermove', 4, 10, 10);
  f.emit('pointerup', 5, 10, 10);
  assert.deepEqual(f.engine.drawing.getStrokes()[0].points.map(p => [p.x, p.y]), [[0, 0], [10, 10]]);
  f.emit('pointerdown', 6, 30, 30);
  f.engine.setDrawingData(createEmptyDrawingData(), 'B');
  f.emit('pointerup', 7, 50, 50);
  assert.equal(f.engine.drawing.getStrokes().length, 0);
  f.emit('pointerdown', 8, 5, 5);
  f.engine.input.cancelActivePointerInteraction();
  f.emit('pointerup', 9, 10, 10);
  assert.equal(f.engine.drawing.getStrokes().length, 0, 'viewport promotion still cancels ink');
});
