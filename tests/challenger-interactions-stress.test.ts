import assert from 'node:assert/strict';
import test from 'node:test';
import { LaserManager, type LaserManagerOptions, type LaserTrailPoint } from '../src/components/notebook/engine/LaserManager.ts';
import { InputManager } from '../src/components/notebook/engine/InputManager.ts';
import { DrawingEngine } from '../src/components/notebook/engine/DrawingEngine.ts';
import { ViewportManager } from '../src/components/notebook/engine/ViewportManager.ts';
import { ShapeManager } from '../src/components/notebook/engine/ShapeManager.ts';
import { ToolManager } from '../src/components/notebook/engine/ToolManager.ts';
import { HistoryManager } from '../src/components/notebook/engine/HistoryManager.ts';
import { RulerManager } from '../src/components/notebook/engine/RulerManager.ts';
import { NotebookEngine } from '../src/components/notebook/engine/NotebookEngine.ts';
import {
  computeCursorTransform,
  dynamicEraserDescriptor,
  dynamicInkDescriptor,
  isPointInsideElement,
  resolveDocumentToolCursor,
  resolveToolCursorDescriptor,
  shouldShowPenCursor,
  StylusCursorOverlayController,
  type ToolCursorDescriptor,
} from '../src/components/notebook/documentToolCursor.ts';
import type { ToolState } from '../src/components/notebook/engine/drawingTypes.ts';

// ===========================================================================
// Test Utilities & Adversarial Generators
// ===========================================================================

function createLaserScheduler() {
  let now = 1000;
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
    advance(deltaMs: number) { now += deltaMs; },
    getNow() { return now; },
    getPendingCount() { return frames.size; },
    runAllFrames(time = now) {
      now = time;
      const callbacks = Array.from(frames.entries());
      frames.clear();
      for (const [_, cb] of callbacks) {
        cb(time);
      }
    },
    runSingleFrame(time = now) {
      now = time;
      const entry = frames.entries().next().value;
      if (!entry) return false;
      frames.delete(entry[0]);
      entry[1](time);
      return true;
    },
  };
}

function createQueuedFrameScheduler() {
  let nextFrameId = 1;
  const pendingFrames = new Map<number, () => void>();

  return {
    requestFrame: (cb: () => void) => {
      const id = nextFrameId++;
      pendingFrames.set(id, cb);
      return id;
    },
    cancelFrame: (id: number) => {
      pendingFrames.delete(id);
    },
    flush: () => {
      const entries = Array.from(pendingFrames.entries());
      pendingFrames.clear();
      for (const [_, cb] of entries) {
        cb();
      }
    },
    getPendingCount: () => pendingFrames.size,
  };
}

function createMockCanvasContext() {
  const lineSegments: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> = [];
  const renderedCircles: Array<{ x: number; y: number; r: number; fill: string }> = [];
  let currentPos = { x: 0, y: 0 };
  let currentFill = '';
  const mockGradient = { addColorStop: () => {} };

  const ctx = {
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    stroke: () => {},
    fill: () => {},
    arc: (x: number, y: number, r: number) => {
      renderedCircles.push({ x, y, r, fill: currentFill });
    },
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
    get fillStyle() { return currentFill; },
    set fillStyle(val: any) { currentFill = typeof val === 'string' ? val : ''; },
  } as unknown as CanvasRenderingContext2D;

  return { ctx, lineSegments, renderedCircles };
}

function createLaserInputHarness(laserOptions?: LaserManagerOptions) {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager({ ...scheduler.options, ...laserOptions });
  const tools = new ToolManager();
  const history = new HistoryManager();
  let redrawCount = 0;
  laser.setRedrawCallback(() => { redrawCount += 1; });
  tools.setDrawingTool('laser');

  const drawing = {
    getStrokes: () => [],
    findStrokesNearPoint: () => [],
    addStroke: () => {},
    removeStroke: () => undefined,
    redraw: () => { redrawCount += 1; },
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
    clientWidth: 1000,
    clientHeight: 800,
    width: 1000,
    height: 800,
    style: { cursor: '', removeProperty: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
  } as unknown as HTMLCanvasElement;
  input.attach(canvas);

  const pointer = (phase: 'Down' | 'Move' | 'Up', x: number, y: number, pointerId = 1, pointerType = 'pen') => {
    (input as any)[`handlePointer${phase}`]({
      button: 0,
      pointerId,
      pointerType,
      pressure: 0.5,
      clientX: x,
      clientY: y,
      shiftKey: false,
      preventDefault: () => {},
    });
  };

  return { input, laser, tools, history, scheduler, pointer, getRedrawCount: () => redrawCount };
}

function createMockToolState(overrides: Partial<ToolState> = {}): ToolState {
  return {
    mode: 'draw',
    drawingTool: 'pen',
    handwritingToTextEnabled: false,
    handwritingInkColor: '#20242a',
    handwritingInkThickness: 2.4,
    eraserMode: 'pixel',
    shapeTool: 'rectangle',
    color: '#2563eb',
    thickness: 2,
    opacity: 1,
    pressureSensitivity: true,
    strokePattern: 'solid',
    scribbleToErase: false,
    circleToSelect: false,
    straightLineRecognition: false,
    snapRecognizedLines: true,
    roughShapeRecognition: false,
    snapRecognizedShapes: false,
    rulerEnabled: false,
    stabilization: 50,
    shapeFillEnabled: false,
    ...overrides,
  };
}

// ===========================================================================
// SECTION 1: WORKSTREAM A — LASER SETTINGS & LIFECYCLE ADVERSARIAL STRESS
// ===========================================================================

test('STRESS [Laser-1]: Extreme duration values, boundaries, and setDecayMs fallback handling', () => {
  const laser = new LaserManager();

  // Test minimum boundary (500ms)
  laser.setDecayMs(500);
  assert.equal(laser.decayMs, 500);

  // Test sub-minimum clamping
  laser.setDecayMs(499);
  assert.equal(laser.decayMs, 500);
  laser.setDecayMs(0);
  assert.equal(laser.decayMs, 500);
  laser.setDecayMs(-1);
  assert.equal(laser.decayMs, 500);
  laser.setDecayMs(-100000);
  assert.equal(laser.decayMs, 500);
  laser.setDecayMs(-Infinity);
  assert.equal(laser.decayMs, 3000, 'Non-finite negative infinity should fall back to default 3000ms');

  // Test maximum boundary (10,000ms)
  laser.setDecayMs(10000);
  assert.equal(laser.decayMs, 10000);

  // Test super-maximum clamping
  laser.setDecayMs(10001);
  assert.equal(laser.decayMs, 10000);
  laser.setDecayMs(50000);
  assert.equal(laser.decayMs, 10000);
  laser.setDecayMs(Infinity);
  assert.equal(laser.decayMs, 3000, 'Non-finite positive infinity should fall back to default 3000ms');

  // Test NaN and invalid types in setDecayMs
  laser.setDecayMs(7500);
  assert.equal(laser.decayMs, 7500);
  laser.setDecayMs(NaN);
  assert.equal(laser.decayMs, 3000, 'setDecayMs(NaN) safely falls back to 3000ms');
  laser.setDecayMs('not-a-number' as any);
  assert.equal(laser.decayMs, 3000, 'Invalid string should fall back to 3000ms');

  // Sub-integer durations
  laser.setDecayMs(1234.56);
  assert.equal(laser.decayMs, 1234.56);
});

test('EMPIRICAL BUG [Laser-Bug-1]: LaserManager constructor fails to validate Number.isFinite on decayMs, allowing NaN to corrupt trail pruning', () => {
  // When initialized with options.decayMs = NaN:
  // In constructor line 66:
  //   this.decayMs = Math.max(500, Math.min(10000, options.decayMs ?? DEFAULT_DECAY_MS));
  // In JS: Math.min(10000, NaN) -> NaN, Math.max(500, NaN) -> NaN.
  // Because NaN is not null or undefined, the nullish coalescing operator does not trigger.
  const laserNaN = new LaserManager({ decayMs: NaN });

  // Empirically demonstrate the defect: decayMs becomes NaN instead of 3000ms default
  const isDecayMsNaN = Number.isNaN(laserNaN.decayMs);
  assert.equal(
    isDecayMsNaN,
    true,
    'Confirmed vulnerability: constructor leaves decayMs as NaN when options.decayMs is NaN'
  );

  // Demonstrate the blast radius: any point added to laserNaN is immediately destroyed because
  // cutoff = now - NaN = NaN, and (timestamp > NaN) is always false!
  const scheduler = createLaserScheduler();
  const corruptLaser = new LaserManager({ ...scheduler.options, decayMs: NaN });
  corruptLaser.addPoint({ x: 10, y: 10, pressure: 0.5 });
  const trail = corruptLaser.getActiveTrail();
  assert.equal(
    trail.length,
    0,
    'Confirmed blast radius: trail immediately drops all points when decayMs is NaN!'
  );
});

test('STRESS [Laser-2]: Rapid drag bursts across random coordinates with connectSeparateStrokes=false', () => {
  const harness = createLaserInputHarness({ connectSeparateStrokes: false });

  // Generate 50 rapid distinct drag bursts across disparate canvas areas
  const burstCount = 50;
  for (let b = 0; b < burstCount; b++) {
    const originX = (b * 37) % 800 + 20;
    const originY = (b * 53) % 600 + 20;

    harness.pointer('Down', originX, originY);
    for (let step = 1; step <= 4; step++) {
      harness.scheduler.advance(5);
      harness.pointer('Move', originX + step * 4, originY + step * 4);
    }
    harness.scheduler.advance(5);
    harness.pointer('Up', originX + 20, originY + 20);
    harness.scheduler.advance(10); // Gap between gestures
  }

  const trail = harness.laser.getActiveTrail();
  assert.ok(trail.length > 50, `Expected dense trail, got ${trail.length} points`);

  // Verify that stroke IDs monotonically increment per gesture
  let previousStrokeId = -1;
  const strokeIdsSeen = new Set<number>();
  for (const point of trail) {
    strokeIdsSeen.add(point.strokeId);
    if (previousStrokeId !== -1) {
      assert.ok(point.strokeId >= previousStrokeId, 'Stroke IDs must be non-decreasing');
    }
    previousStrokeId = point.strokeId;
  }
  assert.ok(strokeIdsSeen.size > 20, `Expected multiple distinct stroke IDs, got ${strokeIdsSeen.size}`);

  // Render to mock context and verify NO line segment bridges between distinct stroke IDs
  const { ctx, lineSegments } = createMockCanvasContext();
  harness.laser.render(ctx, 1.0);

  assert.ok(lineSegments.length > 0, 'Line segments must be rendered');
  for (const seg of lineSegments) {
    const dx = seg.to.x - seg.from.x;
    const dy = seg.to.y - seg.from.y;
    const distance = Math.hypot(dx, dy);
    // Intra-stroke steps are ~sqrt(4^2+4^2) = 5.66px; bridging gestures would jump 50px-500px!
    assert.ok(
      distance < 30,
      `Detected bridging segment across separate gestures! Distance: ${distance.toFixed(1)}px from (${seg.from.x}, ${seg.from.y}) to (${seg.to.x}, ${seg.to.y})`
    );
  }
});

test('STRESS [Laser-3]: Rapid drag bursts with connectSeparateStrokes=true preserves trail connectivity', () => {
  const harness = createLaserInputHarness({ connectSeparateStrokes: true });

  // Execute 3 distinct drag bursts
  harness.pointer('Down', 10, 10);
  harness.pointer('Move', 20, 20);
  harness.pointer('Up', 20, 20);

  harness.scheduler.advance(20);
  harness.pointer('Down', 100, 100);
  harness.pointer('Move', 110, 110);
  harness.pointer('Up', 110, 110);

  harness.scheduler.advance(20);
  harness.pointer('Down', 200, 200);
  harness.pointer('Move', 210, 210);
  harness.pointer('Up', 210, 210);

  const { ctx, lineSegments } = createMockCanvasContext();
  harness.laser.render(ctx, 1.0);

  // Bridges should exist: from (20,20) to (100,100), and from (110,110) to (200,200)
  const bridge1 = lineSegments.find(s => s.from.x === 20 && s.to.x === 100);
  const bridge2 = lineSegments.find(s => s.from.x === 110 && s.to.x === 200);
  assert.ok(bridge1 !== undefined, 'Bridge 1 must connect gesture 1 and gesture 2 when enabled');
  assert.ok(bridge2 !== undefined, 'Bridge 2 must connect gesture 2 and gesture 3 when enabled');
});

test('STRESS [Laser-4]: Dynamic connectSeparateStrokes toggles during active in-flight points', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager({ ...scheduler.options, connectSeparateStrokes: true });

  // Generate 4 gestures with 2 points each
  for (let g = 0; g < 4; g++) {
    laser.startStroke();
    laser.addPoint({ x: g * 100, y: g * 100, pressure: 0.5 });
    scheduler.advance(10);
    laser.addPoint({ x: g * 100 + 10, y: g * 100 + 10, pressure: 0.5 });
    scheduler.advance(10);
  }

  // 1. Initial connected render -> 4 intra-stroke segments + 3 bridge segments = 7 segments
  const mock1 = createMockCanvasContext();
  laser.render(mock1.ctx, 1.0);
  assert.equal(mock1.lineSegments.length, 7, 'Expected 7 segments with connectivity true');

  // 2. Toggle to disconnected -> exactly 4 intra-stroke segments
  laser.setConnectSeparateStrokes(false);
  const mock2 = createMockCanvasContext();
  laser.render(mock2.ctx, 1.0);
  assert.equal(mock2.lineSegments.length, 4, 'Expected 4 segments with connectivity false');

  // 3. Toggle back to connected -> 7 segments restored
  laser.setConnectSeparateStrokes(true);
  const mock3 = createMockCanvasContext();
  laser.render(mock3.ctx, 1.0);
  assert.equal(mock3.lineSegments.length, 7, 'Expected 7 segments after toggling back to true');

  // 4. Toggle 100 times in rapid sequence -> verify zero corruption or state leakage
  for (let i = 0; i < 100; i++) {
    laser.setConnectSeparateStrokes(i % 2 === 0);
  }
  assert.equal(laser.connectSeparateStrokes, false);
  const mock4 = createMockCanvasContext();
  laser.render(mock4.ctx, 1.0);
  assert.equal(mock4.lineSegments.length, 4);
});

test('STRESS [Laser-5]: Dynamic decay duration changes mid-stroke without point loss or math explosion', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager({ ...scheduler.options, decayMs: 5000 });

  // Add 10 points spaced 200ms apart from t=1000 to t=2800
  scheduler.setNow(1000);
  laser.startStroke();
  for (let i = 0; i < 10; i++) {
    scheduler.setNow(1000 + i * 200);
    laser.addPoint({ x: i * 10, y: i * 10, pressure: 0.5 });
  }

  // At now = 3000: points have elapsed times from 200ms to 2000ms.
  // With decayMs = 5000, all 10 points are alive.
  scheduler.setNow(3000);
  assert.equal(laser.getActiveTrail().length, 10);

  // Shorten decayMs to 1500ms dynamically:
  // Cutoff is now 3000 - 1500 = 1500.
  // Points at t=1000, t=1200, t=1400 (timestamp <= 1500) must be pruned.
  // Remaining points: t=1600, 1800, 2000, 2200, 2400, 2600, 2800 (7 points).
  laser.setDecayMs(1500);
  const prunedTrail = laser.getActiveTrail();
  assert.equal(prunedTrail.length, 7, `Expected 7 alive points after decayMs reduction, got ${prunedTrail.length}`);
  assert.equal(prunedTrail[0].timestamp, 1600);

  // Verify opacity range for all surviving points is strictly between 0 and 1
  for (const point of prunedTrail) {
    const opacity = laser.getPointOpacity(point);
    assert.ok(opacity > 0 && opacity <= 1.0, `Opacity out of bounds: ${opacity}`);
  }

  // Lengthen decayMs to 10,000ms dynamically
  laser.setDecayMs(10000);
  scheduler.setNow(4000);
  // Point at t=1600 is elapsed 2400ms: with 10,000ms decay, opacity is 1 - 2400/10000 = 0.76
  const opacity1600 = laser.getPointOpacity(prunedTrail[0], 4000);
  assert.ok(Math.abs(opacity1600 - 0.76) < 0.01, `Expected opacity ~0.76, got ${opacity1600}`);
});

test('STRESS [Laser-6]: Trail memory cap (MAX_TRAIL_POINTS=2048) under point floods', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager({ ...scheduler.options, decayMs: 10000 });

  // Flood 5,000 points into the laser manager at the same timestamp
  scheduler.setNow(1000);
  laser.startStroke();
  for (let i = 0; i < 5000; i++) {
    laser.addPoint({ x: i, y: i, pressure: 0.5 });
  }

  const trail = laser.getActiveTrail();
  assert.equal(trail.length, 2048, `Trail length must be hard-capped at 2048, got ${trail.length}`);
  // Oldest remaining point should be point 5000 - 2048 = 2952
  assert.equal(trail[0].x, 2952);
  assert.equal(trail[trail.length - 1].x, 4999);
});

test('STRESS [Laser-7]: Single-point taps and zero-distance moves render without NaN or canvas crashes', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager(scheduler.options);

  // Single-point tap (down + up at same coordinate)
  laser.startStroke();
  laser.addPoint({ x: 50, y: 50, pressure: 0.5 });

  const { ctx, lineSegments, renderedCircles } = createMockCanvasContext();
  // Should not throw or divide by zero
  assert.doesNotThrow(() => {
    laser.render(ctx, 1.0);
  });
  // No line segments for a single point
  assert.equal(lineSegments.length, 0);
  // Head glow circle and inner circle must be rendered
  assert.equal(renderedCircles.length, 2);
  assert.equal(renderedCircles[0].x, 50);
  assert.equal(renderedCircles[0].y, 50);

  // Zero-distance move (x: 50, y: 50 followed by x: 50, y: 50)
  laser.addPoint({ x: 50, y: 50, pressure: 0.5 });
  assert.doesNotThrow(() => {
    laser.render(ctx, 1.0);
  });
});

test('STRESS [Laser-8]: rAF and trail lifecycle cleanup under rapid churn and unmount', () => {
  const scheduler = createLaserScheduler();
  const laser = new LaserManager(scheduler.options);

  // Cycle addPoint and clear 200 times
  for (let i = 0; i < 200; i++) {
    laser.addPoint({ x: i, y: i, pressure: 0.5 });
    assert.equal(laser.isAnimating(), true);
    assert.equal(scheduler.getPendingCount(), 1);
    laser.clear();
    assert.equal(laser.isAnimating(), false);
    assert.equal(laser.getActiveTrail().length, 0);
    assert.equal(scheduler.getPendingCount(), 0);
  }

  // Simulate self-terminating rAF decay loop
  laser.addPoint({ x: 10, y: 10, pressure: 0.5 });
  assert.equal(laser.isAnimating(), true);
  assert.equal(scheduler.getPendingCount(), 1);

  // Run frames until decayMs expires
  scheduler.advance(1000);
  scheduler.runSingleFrame();
  assert.equal(laser.isAnimating(), true); // Still alive at 1s
  assert.equal(scheduler.getPendingCount(), 1);

  scheduler.advance(2500); // Now 3500ms > 3000ms decay
  scheduler.runSingleFrame();
  // Animation should self-terminate when trail is empty!
  assert.equal(laser.getActiveTrail().length, 0);
  assert.equal(laser.isAnimating(), false);
  assert.equal(scheduler.getPendingCount(), 0, 'No pending rAF frames must remain after trail expiration');
});


// ===========================================================================
// SECTION 2: WORKSTREAM B — STYLUS CURSOR ADVERSARIAL STRESS
// ===========================================================================

test('STRESS [Cursor-1]: 120Hz–240Hz high-frequency pointer stream coordinate fidelity & rAF coalescing', () => {
  const mockContainer = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 1920,
      bottom: 1080,
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  } as unknown as HTMLElement;

  let currentTransform = '';
  const scheduler = createQueuedFrameScheduler();

  const controller = new StylusCursorOverlayController({
    getDescriptor: () => dynamicInkDescriptor('pen', '#ef4444'),
    getContainer: () => mockContainer,
    onVisibilityChange: () => {},
    onPositionChange: t => { currentTransform = t; },
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
  });

  // Hotspot for pen is (7, 26)
  // Simulate 240Hz pointer stream (events every 4.16ms)
  // 4 raw events per 16.6ms display frame
  const frameIntervalMs = 16.66;
  const eventIntervalMs = 4.16;

  for (let frame = 0; frame < 10; frame++) {
    // 4 raw events arrive between paints
    for (let sub = 0; sub < 4; sub++) {
      const t = frame * frameIntervalMs + sub * eventIntervalMs;
      // High-DPI subpixel coordinates
      const clientX = 100 + Math.sin(t / 20) * 50 + sub * 0.25;
      const clientY = 200 + Math.cos(t / 20) * 50 + sub * 0.125;

      controller.handlePointerMove({ pointerType: 'pen', clientX, clientY });
    }

    // Only 1 rAF should be scheduled per frame burst
    assert.equal(scheduler.getPendingCount(), 1, 'Exactly one rAF should be queued per frame burst');
    scheduler.flush();
    assert.equal(scheduler.getPendingCount(), 0);

    // Verify currentTransform matches the 4th (latest) subpixel event coordinates
    const latestT = frame * frameIntervalMs + 3 * eventIntervalMs;
    const expectedX = 100 + Math.sin(latestT / 20) * 50 + 3 * 0.25;
    const expectedY = 200 + Math.cos(latestT / 20) * 50 + 3 * 0.125;
    const expectedTransform = computeCursorTransform(expectedX, expectedY, 7, 26);

    assert.equal(
      currentTransform,
      expectedTransform,
      `Frame ${frame}: Cursor transform drift detected! Expected ${expectedTransform}, got ${currentTransform}`
    );
  }

  controller.destroy();
});

test('EMPIRICAL BUG [Cursor-Bug-1]: StylusCursorOverlayController synchronous requestFrame re-entrancy freezes position updates', () => {
  // If requestFrame executes the callback synchronously (common in test mocks, microtask flushers,
  // or immediate scheduling environments):
  // In StylusCursorOverlayController.ts:
  //   this.rafId = req(() => {
  //     this.rafId = null;
  //     this.applyPosition();
  //   });
  // Execution order:
  //   1. req() is called
  //   2. callback runs immediately -> this.rafId = null; this.applyPosition()
  //   3. req() returns 1
  //   4. this.rafId is assigned 1!
  // On all subsequent calls to scheduleRaf():
  //   if (this.rafId !== null) return; -> sees rafId === 1 and NO-OPS forever!
  const mockContainer = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 1000 }),
  } as unknown as HTMLElement;

  let positionUpdates = 0;
  let lastTransform = '';
  const syncController = new StylusCursorOverlayController({
    getDescriptor: () => dynamicInkDescriptor('pen', '#ef4444'),
    getContainer: () => mockContainer,
    onVisibilityChange: () => {},
    onPositionChange: t => {
      positionUpdates++;
      lastTransform = t;
    },
    requestFrame: cb => {
      cb(); // execute synchronously
      return 1;
    },
  });

  // First move (initial reveal calls applyPosition synchronously inside handlePointerMove, then scheduleRaf runs cb)
  syncController.handlePointerMove({ pointerType: 'pen', clientX: 100, clientY: 100 });
  const initialUpdates = positionUpdates;
  assert.equal(initialUpdates, 2, 'Initial move executes applyPosition directly and via synchronous cb');
  assert.equal(lastTransform, computeCursorTransform(100, 100, 7, 26));

  // Subsequent move: should trigger scheduleRaf() -> applyPosition()
  syncController.handlePointerMove({ pointerType: 'pen', clientX: 200, clientY: 200 });

  // Empirically demonstrate the defect: positionUpdates did NOT increment and transform was NOT updated to (200, 200)!
  assert.equal(
    positionUpdates,
    initialUpdates,
    'Confirmed vulnerability: Synchronous requestFrame execution permanently freezes StylusCursorOverlayController updates!'
  );
  assert.equal(
    lastTransform,
    computeCursorTransform(100, 100, 7, 26),
    'Confirmed defect: Cursor transform remained stuck at (100, 100) instead of updating to (200, 200)'
  );

  syncController.destroy();
});

test('STRESS [Cursor-2]: Rapid pointer type churn (pen vs mouse vs touch differentiation)', () => {
  let isVisible = false;
  const visibilityEvents: boolean[] = [];

  const mockContainer = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 100,
      right: 900,
      bottom: 700,
      width: 800,
      height: 600,
      x: 100,
      y: 100,
      toJSON: () => {},
    }),
  } as unknown as HTMLElement;

  const scheduler = createQueuedFrameScheduler();

  const controller = new StylusCursorOverlayController({
    getDescriptor: () => dynamicInkDescriptor('pen', '#ef4444'),
    getContainer: () => mockContainer,
    onVisibilityChange: v => {
      isVisible = v;
      visibilityEvents.push(v);
    },
    onPositionChange: () => {},
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
  });

  // Churn cycle: Pen -> Mouse -> Touch -> Pen -> Touch -> Mouse
  const churn = [
    { type: 'pen', x: 200, y: 200, expected: true },
    { type: 'mouse', x: 210, y: 210, expected: false },
    { type: 'pen', x: 220, y: 220, expected: true },
    { type: 'touch', x: 230, y: 230, expected: false },
    { type: 'mouse', x: 240, y: 240, expected: false },
    { type: 'pen', x: 250, y: 250, expected: true },
    { type: 'touch', x: 260, y: 260, expected: false },
  ];

  for (const { type, x, y, expected } of churn) {
    controller.handlePointerMove({ pointerType: type, clientX: x, clientY: y });
    scheduler.flush();
    assert.equal(
      controller.getIsVisible(),
      expected,
      `Device differentiation failed for pointerType: ${type}. Expected visible=${expected}, got visible=${controller.getIsVisible()}`
    );
  }

  // Verify touch down and move never show overlay
  controller.handlePointerDown({ pointerType: 'touch', clientX: 300, clientY: 300 });
  assert.equal(controller.getIsVisible(), false);
  controller.handlePointerMove({ pointerType: 'touch', clientX: 310, clientY: 310 });
  assert.equal(controller.getIsVisible(), false);
  controller.handlePointerUp({ pointerType: 'touch', clientX: 310, clientY: 310 });
  assert.equal(controller.getIsVisible(), false);

  // Verify mouse down and move never show overlay
  controller.handlePointerDown({ pointerType: 'mouse', clientX: 300, clientY: 300 });
  assert.equal(controller.getIsVisible(), false);
  controller.handlePointerMove({ pointerType: 'mouse', clientX: 310, clientY: 310 });
  assert.equal(controller.getIsVisible(), false);
  controller.handlePointerUp({ pointerType: 'mouse', clientX: 310, clientY: 310 });
  assert.equal(controller.getIsVisible(), false);

  controller.destroy();
});

test('STRESS [Cursor-3]: Pointer capture survival across container boundaries and interrupt handling', () => {
  let isVisible = false;
  let transform = '';

  const mockContainer = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 100,
      right: 500,
      bottom: 500,
      width: 400,
      height: 400,
      x: 100,
      y: 100,
      toJSON: () => {},
    }),
  } as unknown as HTMLElement;

  const scheduler = createQueuedFrameScheduler();

  const controller = new StylusCursorOverlayController({
    getDescriptor: () => dynamicInkDescriptor('pen', '#ef4444'),
    getContainer: () => mockContainer,
    onVisibilityChange: v => { isVisible = v; },
    onPositionChange: t => { transform = t; },
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
  });

  // 1. Hover outside container -> hidden
  controller.handlePointerMove({ pointerType: 'pen', clientX: 50, clientY: 50 });
  assert.equal(controller.getIsVisible(), false);

  // 2. Touch down inside container -> isPenDown = true, visible = true
  controller.handlePointerDown({ pointerType: 'pen', clientX: 200, clientY: 200 });
  assert.equal(controller.getIsPenDown(), true);
  assert.equal(controller.getIsVisible(), true);

  // 3. Drag far outside container (pointer capture active) -> MUST REMAIN VISIBLE
  controller.handlePointerMove({ pointerType: 'pen', clientX: 800, clientY: 900 });
  scheduler.flush();
  assert.equal(
    controller.getIsVisible(),
    true,
    'Stylus cursor must survive pointer capture when dragged outside container bounds'
  );
  assert.equal(transform, computeCursorTransform(800, 900, 7, 26));

  // 4. Pointer cancel (palm rejection or OS interrupt) -> MUST IMMEDIATELY HIDE and reset isPenDown
  controller.handlePointerCancel({ pointerType: 'pen' });
  assert.equal(controller.getIsPenDown(), false, 'isPenDown must be false after pointercancel');
  assert.equal(controller.getIsVisible(), false, 'Overlay must hide immediately after pointercancel');

  // 5. Test window blur during drawing
  controller.handlePointerDown({ pointerType: 'pen', clientX: 250, clientY: 250 });
  assert.equal(controller.getIsPenDown(), true);
  assert.equal(controller.getIsVisible(), true);

  controller.handleBlur();
  assert.equal(controller.getIsPenDown(), false, 'isPenDown must reset on window blur');
  assert.equal(controller.getIsVisible(), false, 'Overlay must hide on window blur');

  controller.destroy();
});

test('EMPIRICAL BUG [Cursor-Bug-2]: dynamicEraserDescriptor falsy thickness evaluation (thickness || 16) produces inconsistent clamping', () => {
  // In documentToolCursor.ts line 44:
  //   const clampedThickness = Math.max(4, Math.min(64, Math.round(thickness || 16)));
  // Because 0 is falsy, thickness || 16 evaluates to 16 for thickness = 0.
  // But for 1px (which is truthy), 1 || 16 evaluates to 1, which clamps to 4px.
  // And for negative numbers (e.g. -10, which is truthy), -10 || 16 evaluates to -10, which clamps to 4px.
  const descZero = dynamicEraserDescriptor(0);
  const descOne = dynamicEraserDescriptor(1);
  const descNegative = dynamicEraserDescriptor(-10);

  // Empirically demonstrate the inconsistency:
  // 0px thickness produces 16px eraser (r=8)
  assert.ok(descZero.svg.includes('r="8"'), '0px thickness produces 16px eraser');
  // 1px thickness produces 4px eraser (r=2)
  assert.ok(descOne.svg.includes('r="2"'), '1px thickness produces 4px eraser');
  // -10px thickness produces 4px eraser (r=2)
  assert.ok(descNegative.svg.includes('r="2"'), '-10px thickness produces 4px eraser');

  // Documenting the inconsistency: 0px is larger than 1px!
  assert.ok(
    descZero.width > descOne.width,
    'Confirmed vulnerability: 0px thickness results in a larger cursor (16px) than 1px thickness (4px) due to falsy defaulting!'
  );
});

test('STRESS [Cursor-4]: Systematic eraser diameter scaling across 4px–64px range', () => {
  // Systematic range verification across all valid integer thicknesses 4..64
  for (let thickness = 4; thickness <= 64; thickness += 4) {
    const desc = dynamicEraserDescriptor(thickness);
    const expectedRadius = Math.round(thickness / 2);
    const expectedSize = Math.max(16, thickness + 6);
    const expectedHotspot = Math.round(expectedSize / 2);

    assert.equal(desc.width, expectedSize, `Thickness ${thickness}: invalid width`);
    assert.equal(desc.height, expectedSize, `Thickness ${thickness}: invalid height`);
    assert.equal(desc.hotspotX, expectedHotspot, `Thickness ${thickness}: invalid hotspotX`);
    assert.equal(desc.hotspotY, expectedHotspot, `Thickness ${thickness}: invalid hotspotY`);
    assert.ok(desc.svg.includes(`r="${expectedRadius}"`), `Thickness ${thickness}: invalid radius in SVG`);

    // Verify hotspot offset centers the circle exactly under the pointer coordinate
    const transform = computeCursorTransform(500, 500, desc.hotspotX, desc.hotspotY);
    const expectedTransform = `translate3d(${500 - expectedHotspot}px, ${500 - expectedHotspot}px, 0)`;
    assert.equal(transform, expectedTransform);
  }
});

test('STRESS [Cursor-5]: Dynamic tool descriptor resolution, mode switching, and color normalizations', () => {
  // Non-drawing modes must return undefined
  assert.equal(resolveToolCursorDescriptor(createMockToolState({ mode: 'select' })), undefined);
  assert.equal(resolveToolCursorDescriptor(createMockToolState({ mode: 'text' })), undefined);
  assert.equal(resolveToolCursorDescriptor(createMockToolState({ mode: 'hand' })), undefined);

  // All supported drawing tools return valid descriptors with positive dimensions and hotspots
  const drawingTools: ToolState['drawingTool'][] = ['pen', 'pencil', 'highlighter', 'marker', 'laser', 'eraser'];
  for (const tool of drawingTools) {
    const desc = resolveToolCursorDescriptor(createMockToolState({ mode: 'draw', drawingTool: tool }));
    assert.ok(desc !== undefined, `Descriptor missing for tool: ${tool}`);
    assert.ok(desc.width > 0);
    assert.ok(desc.height > 0);
    assert.ok(desc.hotspotX >= 0 && desc.hotspotX <= desc.width);
    assert.ok(desc.hotspotY >= 0 && desc.hotspotY <= desc.height);
    assert.ok(desc.svg.startsWith('<svg'));
  }

  // Eraser in mode 'erase'
  const descEraseMode = resolveToolCursorDescriptor(createMockToolState({ mode: 'erase', thickness: 30 }));
  assert.ok(descEraseMode !== undefined);
  assert.ok(descEraseMode.svg.includes('r="15"'));

  // Color normalization: 3-digit hex #abc -> #aabbcc
  const desc3Digit = dynamicInkDescriptor('pen', '#abc');
  assert.ok(desc3Digit.svg.includes('#aabbcc'));

  // Color normalization: 8-digit hex with alpha #11223344 -> #112233
  const desc8Digit = dynamicInkDescriptor('pen', '#11223344');
  assert.ok(desc8Digit.svg.includes('#112233'));

  // Empty or invalid color falls back to #2563eb
  const descInvalidColor = dynamicInkDescriptor('pen', '');
  assert.ok(descInvalidColor.svg.includes('#2563eb'));
});
