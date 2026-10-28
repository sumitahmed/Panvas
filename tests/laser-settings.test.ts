import assert from 'node:assert/strict';
import test from 'node:test';
import { LaserManager, type LaserManagerOptions } from '../src/components/notebook/engine/LaserManager.ts';
import { InputManager } from '../src/components/notebook/engine/InputManager.ts';
import { DrawingEngine } from '../src/components/notebook/engine/DrawingEngine.ts';
import { ViewportManager } from '../src/components/notebook/engine/ViewportManager.ts';
import { ShapeManager } from '../src/components/notebook/engine/ShapeManager.ts';
import { ImageManager } from '../src/components/notebook/engine/ImageManager.ts';
import { ToolManager } from '../src/components/notebook/engine/ToolManager.ts';
import { HistoryManager } from '../src/components/notebook/engine/HistoryManager.ts';
import { RulerManager } from '../src/components/notebook/engine/RulerManager.ts';
import { NotebookEngine } from '../src/components/notebook/engine/NotebookEngine.ts';

function createLaserScheduler() {
  let now = 0;
  let nextFrameId = 1;
  const frames = new Map<number, FrameRequestCallback>();

  return {
    options: {
      now: () => now,
      requestFrame: (callback: FrameRequestCallback) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      },
      cancelFrame: (handle: number) => {
        frames.delete(handle);
      },
    } satisfies LaserManagerOptions,
    setNow(time: number) { now = time; },
    getNow() { return now; },
    getPendingCount() { return frames.size; },
    runFrame(time = now) {
      now = time;
      const entry = frames.entries().next().value;
      if (!entry) throw new Error('No laser animation frame pending');
      frames.delete(entry[0]);
      entry[1](time);
    },
  };
}

function createMockCanvasContext() {
  const lineSegments: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> = [];
  let currentPos = { x: 0, y: 0 };
  const mockGradient = { addColorStop: () => {} };

  const ctx = {
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    stroke: () => {},
    fill: () => {},
    arc: () => {},
    moveTo: (x: number, y: number) => { currentPos = { x, y }; },
    lineTo: (x: number, y: number) => {
      lineSegments.push({ from: { ...currentPos }, to: { x, y } });
      currentPos = { x, y };
    },
    createLinearGradient: () => mockGradient,
    createRadialGradient: () => mockGradient,
    lineCap: '',
    lineJoin: '',
    globalCompositeOperation: '',
    shadowColor: '',
    shadowBlur: 0,
    strokeStyle: '',
    lineWidth: 1,
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D;

  return { ctx, lineSegments };
}

function createLaserInputHarness(laserOptions?: LaserManagerOptions) {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager({ ...scheduler.options, ...laserOptions });
  const tools = new ToolManager();
  const history = new HistoryManager();
  let redraws = 0;
  laser.setRedrawCallback(() => { redraws += 1; });
  tools.setDrawingTool('laser');

  const drawing = {
    getStrokes: () => [],
    findStrokesNearPoint: () => [],
    addStroke: () => {},
    removeStroke: () => undefined,
    redraw: () => { redraws += 1; },
    renderLiveStroke: () => {},
    commitLiveStroke: () => {},
    endLiveStroke: () => {},
    renderLasso: () => {},
  };

  const input = new InputManager(
    tools,
    new ViewportManager(),
    drawing as any,
    { setHistoryChangeCallback: () => {}, setRulerManager: () => {}, eraseStrokeIds: () => false } as any,
    { addShape: () => {} } as any,
    { selectWithinLoop: () => 0 } as any,
    history,
    {} as any,
    new RulerManager(),
    laser,
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

  const pointer = (phase: 'Down' | 'Move' | 'Up', x: number, y: number) => {
    (input as any)[`handlePointer${phase}`]({
      button: 0,
      pointerId: 11,
      pointerType: 'mouse',
      pressure: 0.5,
      clientX: x,
      clientY: y,
      shiftKey: false,
      preventDefault: () => {},
    });
  };

  return { input, laser, tools, history, scheduler, pointer, getRedraws: () => redraws };
}

// ---------------------------------------------------------------------------
// 1. Duration Configuration & Clamping
// ---------------------------------------------------------------------------

test('laser duration: default is 3000ms', () => {
  const laser = new LaserManager();
  assert.equal(laser.decayMs, 3000);
});

test('laser duration: setDecayMs updates duration within valid range (500–10,000ms)', () => {
  const laser = new LaserManager();
  laser.setDecayMs(1500);
  assert.equal(laser.decayMs, 1500);
  laser.setDecayMs(5000);
  assert.equal(laser.decayMs, 5000);
  laser.setDecayMs(10000);
  assert.equal(laser.decayMs, 10000);
  laser.setDecayMs(500);
  assert.equal(laser.decayMs, 500);
});

test('laser duration: setDecayMs clamps values below 500ms to 500ms', () => {
  const laser = new LaserManager();
  laser.setDecayMs(200);
  assert.equal(laser.decayMs, 500);
  laser.setDecayMs(0);
  assert.equal(laser.decayMs, 500);
  laser.setDecayMs(-1000);
  assert.equal(laser.decayMs, 500);
});

test('laser duration: setDecayMs clamps values above 10,000ms to 10,000ms', () => {
  const laser = new LaserManager();
  laser.setDecayMs(12000);
  assert.equal(laser.decayMs, 10000);
  laser.setDecayMs(50000);
  assert.equal(laser.decayMs, 10000);
});

test('laser duration: constructor clamps initial decayMs', () => {
  const shortLaser = new LaserManager({ decayMs: 100 });
  assert.equal(shortLaser.decayMs, 500);
  const longLaser = new LaserManager({ decayMs: 20000 });
  assert.equal(longLaser.decayMs, 10000);
});

test('laser duration: setDecayMs with non-finite number falls back to default 3000ms', () => {
  const laser = new LaserManager();
  laser.setDecayMs(1500);
  assert.equal(laser.decayMs, 1500);
  laser.setDecayMs(Number.NaN);
  assert.equal(laser.decayMs, 3000);
});

test('laser duration: opacity calculation respects dynamic decay duration', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager({ ...scheduler.options, decayMs: 1000 });

  laser.addPoint({ x: 10, y: 10, pressure: 0.5, t: 0 });
  scheduler.setNow(0);
  assert.equal(laser.getPointOpacity(laser.getActiveTrail()[0]), 1.0);

  scheduler.setNow(500);
  assert.equal(laser.getPointOpacity(laser.getActiveTrail()[0]), 0.5);

  // Dynamically change decay to 2000ms
  laser.setDecayMs(2000);
  // At now=500 with decay=2000, opacity = 1 - (500/2000) = 0.75
  assert.equal(laser.getPointOpacity(laser.getActiveTrail()[0]), 0.75);

  // Shorten decay to 500ms: point at t=0 with now=500 is expired
  laser.setDecayMs(500);
  scheduler.setNow(501);
  assert.equal(laser.getActiveTrail().length, 0);
});

// ---------------------------------------------------------------------------
// 2. Inter-Stroke Connectivity & Stroke Segmentation
// ---------------------------------------------------------------------------

test('inter-stroke connectivity: default is enabled (true)', () => {
  const laser = new LaserManager();
  assert.equal(laser.connectSeparateStrokes, true);
});

test('inter-stroke connectivity: startStroke increments strokeId per gesture', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager(scheduler.options);

  // Stroke 1
  laser.startStroke();
  laser.addPoint({ x: 10, y: 10, pressure: 0.5, t: 0 });
  laser.addPoint({ x: 20, y: 20, pressure: 0.5, t: 10 });

  // Stroke 2
  laser.startStroke();
  laser.addPoint({ x: 100, y: 100, pressure: 0.5, t: 20 });
  laser.addPoint({ x: 110, y: 110, pressure: 0.5, t: 30 });

  const trail = laser.getActiveTrail();
  assert.equal(trail.length, 4);
  assert.equal(trail[0].strokeId, 1);
  assert.equal(trail[1].strokeId, 1);
  assert.equal(trail[2].strokeId, 2);
  assert.equal(trail[3].strokeId, 2);
});

test('inter-stroke connectivity: when disabled, render skips segments between different strokeIds', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager({ ...scheduler.options, connectSeparateStrokes: false });

  // Stroke 1: (10, 10) -> (20, 20)
  laser.startStroke();
  laser.addPoint({ x: 10, y: 10, pressure: 0.5, t: 0 });
  laser.addPoint({ x: 20, y: 20, pressure: 0.5, t: 10 });

  // Stroke 2: (100, 100) -> (110, 110)
  laser.startStroke();
  laser.addPoint({ x: 100, y: 100, pressure: 0.5, t: 20 });
  laser.addPoint({ x: 110, y: 110, pressure: 0.5, t: 30 });

  const { ctx, lineSegments } = createMockCanvasContext();
  laser.render(ctx, 1.0, 30);

  // Line segments should be:
  // Segment 1: (10, 10) -> (20, 20) within stroke 1
  // Bridge segment: (20, 20) -> (100, 100) MUST BE SKIPPED because strokeId 1 !== strokeId 2
  // Segment 2: (100, 100) -> (110, 110) within stroke 2
  assert.equal(lineSegments.length, 2);
  assert.deepEqual(lineSegments[0], { from: { x: 10, y: 10 }, to: { x: 20, y: 20 } });
  assert.deepEqual(lineSegments[1], { from: { x: 100, y: 100 }, to: { x: 110, y: 110 } });
});

test('inter-stroke connectivity: when enabled, render connects all consecutive trail points', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager({ ...scheduler.options, connectSeparateStrokes: true });

  // Stroke 1: (10, 10) -> (20, 20)
  laser.startStroke();
  laser.addPoint({ x: 10, y: 10, pressure: 0.5, t: 0 });
  laser.addPoint({ x: 20, y: 20, pressure: 0.5, t: 10 });

  // Stroke 2: (100, 100) -> (110, 110)
  laser.startStroke();
  laser.addPoint({ x: 100, y: 100, pressure: 0.5, t: 20 });
  laser.addPoint({ x: 110, y: 110, pressure: 0.5, t: 30 });

  const { ctx, lineSegments } = createMockCanvasContext();
  laser.render(ctx, 1.0, 30);

  // Line segments should include the bridge:
  // Segment 1: (10, 10) -> (20, 20)
  // Segment 2 (bridge): (20, 20) -> (100, 100)
  // Segment 3: (100, 100) -> (110, 110)
  assert.equal(lineSegments.length, 3);
  assert.deepEqual(lineSegments[0], { from: { x: 10, y: 10 }, to: { x: 20, y: 20 } });
  assert.deepEqual(lineSegments[1], { from: { x: 20, y: 20 }, to: { x: 100, y: 100 } });
  assert.deepEqual(lineSegments[2], { from: { x: 100, y: 100 }, to: { x: 110, y: 110 } });
});

test('inter-stroke connectivity: dynamic toggle updates rendering on the fly', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager({ ...scheduler.options, connectSeparateStrokes: true });

  laser.startStroke();
  laser.addPoint({ x: 0, y: 0, pressure: 0.5, t: 0 });
  laser.addPoint({ x: 10, y: 10, pressure: 0.5, t: 5 });

  laser.startStroke();
  laser.addPoint({ x: 50, y: 50, pressure: 0.5, t: 10 });
  laser.addPoint({ x: 60, y: 60, pressure: 0.5, t: 15 });

  // Initially connected -> 3 segments
  const mock1 = createMockCanvasContext();
  laser.render(mock1.ctx, 1.0, 15);
  assert.equal(mock1.lineSegments.length, 3);

  // Toggle off -> 2 segments (bridge skipped)
  laser.setConnectSeparateStrokes(false);
  assert.equal(laser.connectSeparateStrokes, false);
  const mock2 = createMockCanvasContext();
  laser.render(mock2.ctx, 1.0, 15);
  assert.equal(mock2.lineSegments.length, 2);

  // Toggle on -> 3 segments restored
  laser.setConnectSeparateStrokes(true);
  const mock3 = createMockCanvasContext();
  laser.render(mock3.ctx, 1.0, 15);
  assert.equal(mock3.lineSegments.length, 3);
});

// ---------------------------------------------------------------------------
// 3. InputManager Integration & Gesture Boundaries
// ---------------------------------------------------------------------------

test('InputManager: separate drag gestures invoke startStroke and produce segmented trails', () => {
  const harness = createLaserInputHarness({ connectSeparateStrokes: false });

  // Gesture 1: Down -> Move -> Up
  harness.pointer('Down', 10, 10);
  harness.pointer('Move', 20, 20);
  harness.pointer('Up', 20, 20);

  // Gesture 2: Down -> Move -> Up
  harness.pointer('Down', 80, 80);
  harness.pointer('Move', 90, 90);
  harness.pointer('Up', 90, 90);

  const trail = harness.laser.getActiveTrail();
  // Points: (10, 10), (20, 20), (20, 20) for gesture 1
  // Points: (80, 80), (90, 90), (90, 90) for gesture 2
  assert.ok(trail.length >= 4);
  const stroke1Id = trail[0].strokeId;
  const stroke2Point = trail.find(p => p.x === 80 && p.y === 80);
  assert.ok(stroke2Point, 'stroke 2 point exists');
  assert.notEqual(stroke1Id, stroke2Point.strokeId, 'gestures receive different strokeIds');

  // Verify render skips the bridge between gesture 1 and gesture 2
  const { ctx, lineSegments } = createMockCanvasContext();
  harness.laser.render(ctx, 1.0);
  const bridgedSegment = lineSegments.find(
    s => (s.from.x === 20 && s.to.x === 80) || (s.from.y === 20 && s.to.y === 80)
  );
  assert.equal(bridgedSegment, undefined, 'no segment bridges between gesture 1 and gesture 2');
});

// ---------------------------------------------------------------------------
// 4. Complete Lifecycle Cleanup (rAF, canvas detach, unmount, destroy)
// ---------------------------------------------------------------------------

test('lifecycle cleanup: LaserManager.clear empties trail, cancels animation frame, and resets isAnimating', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager(scheduler.options);

  laser.addPoint({ x: 50, y: 50, pressure: 0.5, t: 0 });
  assert.equal(laser.getActiveTrail().length, 1);
  assert.equal(laser.isAnimating(), true);
  assert.equal(scheduler.getPendingCount(), 1);

  laser.clear();
  assert.equal(laser.getActiveTrail().length, 0);
  assert.equal(laser.isAnimating(), false);
  assert.equal(scheduler.getPendingCount(), 0);
});

test('lifecycle cleanup: InputManager.detach clears laserManager and cancels animation', () => {
  const harness = createLaserInputHarness();

  harness.pointer('Down', 40, 40);
  harness.pointer('Move', 60, 60);
  assert.equal(harness.laser.getActiveTrail().length, 2);
  assert.equal(harness.laser.isAnimating(), true);
  assert.equal(harness.scheduler.getPendingCount(), 1);

  harness.input.detach();
  assert.equal(harness.laser.getActiveTrail().length, 0);
  assert.equal(harness.laser.isAnimating(), false);
  assert.equal(harness.scheduler.getPendingCount(), 0);
});

test('lifecycle cleanup: DrawingEngine.detachCanvas clears laserManager', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager(scheduler.options);
  const viewport = new ViewportManager();
  const shape = new ShapeManager();
  const image = new ImageManager();
  const drawing = new DrawingEngine(viewport, shape, image, undefined, undefined, laser);

  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    style: { width: '', height: '', cursor: '', removeProperty: () => {} },
    getContext: () => ({
      save: () => {},
      restore: () => {},
      setTransform: () => {},
      clearRect: () => {},
      scale: () => {},
      transform: () => {},
    }),
  } as unknown as HTMLCanvasElement;
  drawing.setCanvas(canvas, 800, 600);

  laser.addPoint({ x: 100, y: 100, pressure: 0.5, t: 0 });
  assert.equal(laser.getActiveTrail().length, 1);
  assert.equal(laser.isAnimating(), true);

  drawing.detachCanvas();
  assert.equal(laser.getActiveTrail().length, 0);
  assert.equal(laser.isAnimating(), false);
  assert.equal(scheduler.getPendingCount(), 0);
});

test('lifecycle cleanup: NotebookEngine unmount and destroy clear laser', () => {
  const engine = new NotebookEngine();
  const laser = engine.laser;

  laser.addPoint({ x: 15, y: 25, pressure: 0.5, t: 0 });
  assert.equal(laser.getActiveTrail().length, 1);

  engine.unmount();
  assert.equal(laser.getActiveTrail().length, 0);
  assert.equal(laser.isAnimating(), false);

  laser.addPoint({ x: 35, y: 45, pressure: 0.5, t: 0 });
  assert.equal(laser.getActiveTrail().length, 1);

  engine.destroy();
  assert.equal(laser.getActiveTrail().length, 0);
  assert.equal(laser.isAnimating(), false);
});
