import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import path from 'node:path';
import { EraserGesture, type EraserFrameClock } from '../src/components/notebook/engine/EraserGesture.ts';
import type { InkPoint } from '../src/components/notebook/engine/inkRegion.ts';
import { regionIntersects, eraserCapsule, strokeRegion } from '../src/components/notebook/engine/inkRegion.ts';
import type { EraserMode, Stroke } from '../src/components/notebook/engine/drawingTypes.ts';
import { createEmptyDrawingData } from '../src/components/notebook/engine/drawingTypes.ts';
import { captureFreshPageOwnedDrawing } from '../src/components/notebook/notebookPageRenderState.ts';
import { capsuleInterval, splitOutsideCapsule } from '../src/components/notebook/engine/capsuleErase.ts';
import { cutStroke } from '../src/components/notebook/engine/inkRegion.ts';
import { cloneStrokeSnapshot } from '../src/components/notebook/engine/cloneStrokeSnapshot.ts';
import { getInkFamilyMaximumHalfWidth, getInkFamilyRenderHalfWidth } from '../src/components/notebook/engine/inkFamilyGeometry.ts';

function frameClock() {
  let now = 0, id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const clock: EraserFrameClock = {
    now: () => now,
    request: callback => { callbacks.set(++id, callback); return id; },
    cancel: handle => { callbacks.delete(handle); },
  };
  return { ...clock, callbacks, advance: (ms: number) => { now += ms; }, frame: () => {
    const batch = [...callbacks.values()]; callbacks.clear();
    batch.forEach(callback => callback(now));
  } };
}

test('ordered bends, loops and reversals retain adjacent capsules, with one presentation', () => {
  const clock = frameClock();
  const sweeps: InkPoint[][] = [];
  let redraws = 0;
  const gesture = new EraserGesture(1, true, 'pixel', 5, {
    pageId: 'A', begin: () => false,
    sweep: (a, b) => { sweeps.push([a, b]); return true; },
    present: () => { redraws++; }, complete: () => true,
  }, null, clock);
  const points = [{x:0,y:0}, {x:100,y:0}, {x:100,y:100}, {x:0,y:100}, {x:0,y:0}, {x:0,y:100}];
  points.forEach(point => { gesture.enqueue(point); gesture.enqueue(point); });
  assert.equal(sweeps.length, 0, 'input must only enqueue');
  assert.equal(clock.callbacks.size, 1);
  clock.frame();
  assert.deepEqual(sweeps, points.map((p, i) => [points[Math.max(0, i - 1)], p]));
  assert.equal(redraws, 1);
  gesture.finish();
  assert.equal(redraws, 1, 'no redundant terminal redraw');
});

test('budget exhaustion retains every segment and reports individually expensive sweeps', () => {
  const clock = frameClock();
  const processed: number[] = [];
  let redraws = 0;
  const profile = { name: 'test', startedAt: 0, counters: {}, samples: {}, meta: {} };
  const gesture = new EraserGesture(1, false, 'pixel', 5, {
    pageId: 'A', begin: () => false,
    sweep: (_a, b) => { processed.push(b.x); clock.advance(9); return true; },
    present: () => { redraws++; }, complete: () => true,
  }, profile, clock);
  for (let x = 0; x < 5; x++) gesture.enqueue({ x, y: 0 });
  clock.frame(); assert.deepEqual(processed, [0]); assert.equal(redraws, 1);
  clock.frame(); assert.deepEqual(processed, [0, 1]); assert.equal(redraws, 2);
  gesture.finish();
  assert.deepEqual(processed, [0, 1, 2, 3, 4]);
  assert.equal(redraws, 3, 'one terminal presentation despite three sweeps');
  assert.equal(clock.callbacks.size, 0);
  assert.equal(profile.counters['sweepBudgetOverruns'], 5);
  assert.equal(gesture.finish(), false, 'completion is idempotent');
});

let server: ViteDevServer;
let NotebookEngine: typeof import('../src/components/notebook/engine/NotebookEngine.ts').NotebookEngine;
before(async () => {
  server = await createServer({ configFile: false, root: process.cwd(), appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, resolve: { alias: { '@': path.resolve('src') } } });
  ({ NotebookEngine } = await server.ssrLoadModule('/src/components/notebook/engine/NotebookEngine.ts'));
});
after(async () => { await server?.close(); });

test('fast numeric stroke snapshots detach samples, clips and extensible metadata', () => {
  const source = stroke('snapshot',1,2,{metadata:{nested:{value:1}},inkClip:[[[[0,0],[10,0],[0,10],[0,0]]]]});
  const snapshot = cloneStrokeSnapshot(source);
  assert.deepEqual(snapshot,source);
  source.points[0].x=99; source.inkClip![0][0][0][0]=88; source.metadata!.nested.value=77;
  assert.equal(snapshot.points[0].x,1); assert.equal(snapshot.inkClip![0][0][0][0],0); assert.equal(snapshot.metadata!.nested.value,1);
});

test('cheap broad-phase nib bounds contain actual solid, dashed and dotted pressure geometry', () => {
  for (const inkFamily of ['ballpoint','fountain','brush','felt'] as const)
    for (const pattern of ['solid','dashed','dotted'] as const)
      for (const thickness of [.2,2,12,60]) {
        const s = stroke('nib',0,0,{inkFamily,pattern,thickness,points:Array.from({length:30},(_,i)=>({
          x:i*4,y:Math.sin(i)*20,pressure:(i%7)/6,t:i*4,
        }))});
        assert.ok(getInkFamilyMaximumHalfWidth(s)+1e-9 >= getInkFamilyRenderHalfWidth(s));
      }
});

test('analytic capsule covers a sparse crossing, endpoints, reversal and pressure interpolation', () => {
  assert.deepEqual(capsuleInterval({x:50,y:-30},{x:50,y:30},{x:0,y:0},{x:100,y:0},6), [.4,.6]);
  assert.deepEqual(capsuleInterval({x:50,y:-30},{x:50,y:30},{x:100,y:0},{x:0,y:0},6), [.4,.6]);
  assert.equal(capsuleInterval({x:110,y:-30},{x:110,y:30},{x:0,y:0},{x:100,y:0},6), null);
  const source = stroke('pressure',0,0,{points:[{x:0,y:0,pressure:.2,t:0},{x:100,y:0,pressure:.8,t:100}]});
  const split = splitOutsideCapsule(source,{x:50,y:-100},{x:50,y:100},5)!;
  assert.equal(split.length,2);
  for (const point of split.flat()) {
    assert.ok(Math.abs(point.pressure-(.2+.006*point.x))<1e-12);
    assert.equal(point.t,point.x);
  }
});

test('old inkClip holes survive splitting, serialization, reload, and exact undo/redo', t => {
  const f = fixture(t);
  const source = stroke('legacy',0,20,{points:[{x:0,y:20,pressure:.5,t:0},{x:200,y:20,pressure:.5,t:200}]});
  const clipped = cutStroke(source,eraserCapsule({x:40,y:0},{x:40,y:40},8))!;
  f.engine.drawing.setStrokes([structuredClone(clipped)]);
  f.emit('pointerdown',100,0); f.emit('pointerup',100,40);
  const erased = structuredClone(f.engine.drawing.getStrokes());
  assert.equal(erased.length,2);
  for (const fragment of erased) {
    assert.ok(fragment.inkClip);
    assert.equal(regionIntersects(strokeRegion(fragment),eraserCapsule({x:40,y:20},{x:40,y:20},1)),false);
  }
  f.engine.history.undo(); assert.deepEqual(f.engine.drawing.getStrokes(),[clipped]);
  f.engine.history.redo(); assert.deepEqual(f.engine.drawing.getStrokes(),erased);
  const serialized = JSON.parse(JSON.stringify(f.engine.getDrawingData()));
  f.engine.setDrawingData(serialized,'reloaded');
  assert.deepEqual(f.engine.drawing.getStrokes(),erased);
});

test('multi-fragment cuts never reuse an existing or newly reserved ID', t => {
  const f = fixture(t);
  const original = [stroke('loop',0,0,{points:Array.from({length:7},(_,i)=>({x:i*20,y:i%2?20:-20,pressure:.5,t:i}))}),
    stroke('loop:erase:1',500,500)];
  f.engine.drawing.setStrokes(structuredClone(original));
  f.emit('pointerdown',-20,0); f.emit('pointerup',150,0);
  const result = structuredClone(f.engine.drawing.getStrokes());
  assert.ok(result.length>4); assert.equal(new Set(result.map(s=>s.id)).size,result.length);
  f.engine.history.undo(); assert.deepEqual(f.engine.drawing.getStrokes(),original);
  f.engine.history.redo(); assert.deepEqual(f.engine.drawing.getStrokes(),result);
});

function stroke(id: string, x: number, y: number, extra: Partial<Stroke> = {}): Stroke {
  return { id, type: 'stroke', tool: 'pen', thickness: 2, color: '#222', opacity: .6, createdAt: 1,
    layerId: 'layer-default', points: [{x,y,pressure:.5,t:0}, {x:x+2,y:y+2,pressure:.5,t:1}], ...extra };
}

function fixture(t: test.TestContext, raw = true, mode: EraserMode = 'pixel') {
  const clock = frameClock();
  const saved = new Map(['requestAnimationFrame', 'cancelAnimationFrame', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const fakeWindow = Object.assign(new EventTarget(), raw ? { onpointerrawupdate: null } : {});
  Object.defineProperties(globalThis, {
    requestAnimationFrame: { configurable: true, value: clock.request },
    cancelAnimationFrame: { configurable: true, value: clock.cancel },
    window: { configurable: true, value: fakeWindow },
  });
  // Profiler remains disabled in the Node environment; tests use a deterministic rAF clock.
  Object.assign(fakeWindow, { localStorage: { getItem: () => null }, location: { search: '' } });
  const engine = new NotebookEngine();
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: 800, clientHeight: 1000, width: 800, height: 1000,
    style: { cursor: '', touchAction: '', removeProperty: () => {} },
    getBoundingClientRect: () => ({left:0,top:0,width:800,height:1000}),
    setPointerCapture: () => {}, releasePointerCapture: () => {},
  }) as unknown as HTMLCanvasElement;
  engine.setDrawingData(createEmptyDrawingData(), 'A');
  engine.input.attach(canvas);
  engine.tools.setMode('erase'); engine.tools.setEraserMode(mode); engine.tools.setThickness(3);
  let redraws = 0;
  engine.drawing.redraw = () => { redraws++; };
  t.after(() => {
    engine.destroy();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const emit = (type: string, x: number, y: number, extras: Record<string, unknown> = {}) => {
    const e = new Event(type);
    Object.assign(e, { pointerId: 7, pointerType: 'pen', button: type === 'pointerdown' ? 0 : -1,
      buttons: type === 'pointerup' ? 0 : 1, pressure: .5, clientX: x, clientY: y, ...extras });
    canvas.dispatchEvent(e);
  };
  return { engine, clock, emit, redraws: () => redraws };
}

test('100 raw events plus duplicate pointermoves enqueue only once and never redraw in handlers', t => {
  const f = fixture(t);
  const swept: number[] = [];
  f.engine.eraser.eraseSweep = (_a, b) => { swept.push(b.x); return true; };
  f.emit('pointerdown', 0, 0);
  for (let x = 1; x <= 100; x++) { f.emit('pointerrawupdate', x, 0); f.emit('pointermove', x, 0); }
  assert.equal(swept.length, 101, 'cheap geometry is applied immediately without an application queue'); assert.equal(f.redraws(), 0);
  let frames = 0;
  while (f.clock.callbacks.size) {
    const before = f.redraws(); f.clock.frame(); frames++;
    assert.equal(f.redraws() - before, 1);
  }
  assert.equal(swept.length, 101);
  swept.forEach((x,i) => assert.ok(Math.abs(x-i) < 1e-9));
  assert.equal(f.redraws(), frames);
  f.emit('pointerup', 100, 0);
  assert.equal(f.redraws(), frames);
});

test('fallback coalesced input keeps corners even when dispatch endpoints repeat', t => {
  const f = fixture(t, false);
  const swept: InkPoint[] = [];
  f.engine.eraser.eraseSweep = (_a, b) => { swept.push({ ...b }); return true; };
  f.emit('pointerdown', 0, 0);
  f.emit('pointermove', 0, 0, { getCoalescedEvents: () => [
    {clientX:30,clientY:0}, {clientX:30,clientY:30}, {clientX:0,clientY:0},
  ] });
  f.emit('pointerup', 0, 0);
  assert.deepEqual(swept, [{x:0,y:0}, {x:30,y:0}, {x:30,y:30}, {x:0,y:0}]);
});

test('pointerup final point drains before one history command and one Stage C capture; undo/redo is exact', t => {
  const f = fixture(t);
  const original = [stroke('start',0,0), stroke('middle',50,0), stroke('end',100,0), stroke('safe',50,50)];
  f.engine.drawing.setStrokes(structuredClone(original));
  let captures = 0, saved: unknown;
  f.engine.onSceneMutation(() => { captures++; saved = f.engine.getDrawingData().objects; });
  f.emit('pointerdown',0,0); f.emit('pointerrawupdate',50,0);
  assert.equal(f.engine.history.canUndo(), false); assert.equal(captures, 0);
  f.emit('pointerup',100,0);
  const result = structuredClone(f.engine.drawing.getStrokes());
  assert.equal(captures, 1); assert.deepEqual(saved, result);
  assert.equal(result.some(s => s.id === 'end' && !s.inkClip), false);
  assert.equal(f.clock.callbacks.size, 0);
  f.engine.history.undo(); assert.deepEqual(f.engine.drawing.getStrokes(), original);
  assert.equal(f.engine.history.canUndo(), false, 'only one history command');
  f.engine.history.redo(); assert.deepEqual(f.engine.drawing.getStrokes(), result);
});

for (const mode of ['pixel', 'stroke', 'highlighter', 'all'] as const) {
  test(`${mode}: batched vector result equals sequential capsules including ruler protection`, t => {
    const f = fixture(t, true, mode);
    f.engine.ruler.setEnabled(true); f.engine.ruler.setCenter(100,100); f.engine.ruler.setWidth(220);
    const original = [stroke('pen',0,0), stroke('high',100,0,{tool:'highlighter'}),
      stroke('protected',100,100,{tool:'highlighter'}), stroke('far',200,200)];
    f.engine.drawing.setStrokes(structuredClone(original));
    const points = [{x:0,y:0}, {x:100,y:0}, {x:100,y:100}, {x:0,y:100}, {x:0,y:0}, {x:100,y:0}];
    f.engine.eraser.startErasing(mode, false);
    points.forEach((p,i) => f.engine.eraser.eraseSweep(points[Math.max(0,i-1)], p, mode, 3, false));
    const baseline = structuredClone(f.engine.drawing.getStrokes());
    f.engine.eraser.finishErasing(); f.engine.history.clear();
    f.engine.drawing.setStrokes(structuredClone(original));
    f.emit('pointerdown',0,0);
    points.slice(1).forEach(p => f.emit('pointerrawupdate',p.x,p.y));
    f.emit('pointerup',100,0);
    assert.deepEqual(f.engine.drawing.getStrokes(), baseline);
    assert.ok(f.engine.drawing.getStrokes().some(s => s.id === 'protected'));
    if (mode === 'highlighter') assert.deepEqual(f.engine.drawing.getStrokes().find(s => s.id === 'pen'), original[0]);
  });
}

test('pixel erase follows A-B-C corridor without erasing shortcut; locked and hidden layers survive', t => {
  const f = fixture(t);
  const locked = f.engine.layers.create('Locked'); f.engine.layers.setLocked(locked.id,true);
  const hidden = f.engine.layers.create('Hidden'); f.engine.layers.setVisible(hidden.id,false);
  f.engine.drawing.setStrokes([stroke('AB',50,0), stroke('BC',100,50), stroke('diagonal',50,50),
    stroke('locked',50,0,{layerId:locked.id}), stroke('hidden',50,0,{layerId:hidden.id})]);
  f.emit('pointerdown',0,0); f.emit('pointerrawupdate',100,0); f.emit('pointerup',100,100);
  const remaining = f.engine.drawing.getStrokes();
  for (const [id,x,y] of [['AB',50,0],['BC',100,50]] as const) {
    const s = remaining.find(s => s.id === id);
    assert.ok(!s || !regionIntersects(strokeRegion(s),eraserCapsule({x,y},{x,y},.1)));
  }
  for (const id of ['diagonal','locked','hidden']) assert.equal(remaining.find(s => s.id === id)?.inkClip, undefined);
});

test('page A is captured before replacement; stale rAF cannot mutate page B', t => {
  const f = fixture(t);
  f.engine.drawing.setStrokes([stroke('A-ink',50,0)]);
  let snapshot: ReturnType<typeof captureFreshPageOwnedDrawing> = null;
  f.engine.onSceneMutation(() => {
    const owner = f.engine.getDrawingOwnership();
    snapshot = captureFreshPageOwnedDrawing('book','A',owner.pageId ?? '',owner.revision,() => f.engine.getDrawingData());
  });
  f.emit('pointerdown',0,0); f.emit('pointerrawupdate',100,0);
  const staleFrame = [...f.clock.callbacks.values()][0];
  const b = createEmptyDrawingData(); b.objects = [stroke('B-ink',50,0)];
  f.engine.setDrawingData(b,'B');
  assert.ok(snapshot); assert.equal(snapshot.saveTargetSheetId,'A');
  assert.notDeepEqual(snapshot.data.objects,[stroke('A-ink',50,0)]);
  staleFrame(16); f.clock.frame();
  assert.deepEqual(f.engine.getDrawingData().objects,b.objects);
});

for (const ending of ['pointercancel','lostpointercapture','detach','destroy']) {
  test(`${ending} drains queued geometry exactly once before teardown`, t => {
    const f = fixture(t);
    f.engine.drawing.setStrokes([stroke('ink',50,0)]);
    let captures = 0;
    f.engine.onSceneMutation(() => { captures++; });
    f.emit('pointerdown',0,0); f.emit('pointerrawupdate',100,0);
    if (ending === 'detach') f.engine.input.detach();
    else if (ending === 'destroy') f.engine.destroy();
    else f.emit(ending,100,0);
    assert.equal(captures,1); assert.equal(f.clock.callbacks.size,0);
    f.engine.input.flushPendingErasing(); assert.equal(captures,1);
  });
}
