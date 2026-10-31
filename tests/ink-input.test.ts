import assert from 'node:assert/strict';
import test from 'node:test';
import { InkInputFilter, mapPointerPressure } from '../src/components/notebook/engine/inkInput.ts';
import { InkCenterline } from '../src/components/notebook/engine/inkCenterline.ts';
import { InkSamples } from '../src/components/notebook/engine/inkSamples.ts';
import { PenGeometry } from '../src/components/notebook/engine/penGeometry.ts';
import { analyzeCircleGesture } from '../src/components/notebook/engine/circleSelectGesture.ts';
import { analyzeScribble } from '../src/components/notebook/engine/scribbleGesture.ts';
import { recognizeStraightLine } from '../src/components/notebook/engine/straightLineGesture.ts';
import { recognizeRoughShape } from '../src/components/notebook/engine/roughShapeGesture.ts';
import { inkFixture, INK_ZOOMS, INK_STABILIZATION, INK_CASES, qualityMetrics } from './fixtures/inkQuality.ts';

test('pressure mapping uses stylus pressure only when enabled and keeps mouse stable', () => {
  assert.equal(mapPointerPressure('mouse', 0.03, true), 0.5);
  assert.equal(mapPointerPressure('pen', 0.9, false), 0.5);
  assert.equal(mapPointerPressure('pen', 0, true), 0.5);
  assert.ok(mapPointerPressure('pen', 0.15, true) < mapPointerPressure('pen', 0.5, true));
  assert.ok(mapPointerPressure('pen', 0.85, true) > mapPointerPressure('pen', 0.5, true));
});

test('raw fidelity is exact at 0%; selected stabilization changes XY without changing physical pressure/time', () => {
  const source = [0, 8, -7, 9, -8, 10].map((y, index) => ({ x: index * 4, y, pressure: 0.2 + index * 0.12, t: index * 8 }));
  const raw = new InkInputFilter();
  const strong = new InkInputFilter();
  const rawPoints = source.map(point => raw.push(point, 0));
  const stablePoints = source.map(point => strong.push(point, 100));
  assert.deepEqual(rawPoints, source);
  assert.notDeepEqual(stablePoints, source, '100% must change a noisy centerline');
  assert.deepEqual(stablePoints.map(p => [p.pressure, p.t]), source.map(p => [p.pressure, p.t]));
  assert.ok(stablePoints.every((p, i) => Math.hypot(p.x - source[i].x, p.y - source[i].y) <= 2 + 1e-9));
});

test('every stabilization setting progressively reduces noisy-line jitter at 60/120/240 Hz', () => {
  for (const hz of [60, 120, 240]) for (const zoom of INK_ZOOMS) {
    const f = inkFixture('straight', hz, zoom);
    const jitter = INK_STABILIZATION.map(setting => {
      const filter = new InkInputFilter();
      return qualityMetrics(f.ideal, f.raw.map(p => filter.push(p, setting, zoom)), zoom).rmsDeviationPx;
    });
    for (let i = 1; i < jitter.length; i++) assert.ok(jitter[i] < jitter[i - 1], `${hz} Hz/${zoom}: slider must have progressive effect`);
    assert.ok(jitter[4] < jitter[0] * .6, `${hz} Hz/${zoom}: meaningful jitter reduction`);
  }
});

test('perceived filter output is invariant under page zoom, including irregular timing', () => {
  for (const kind of INK_CASES) for (const setting of INK_STABILIZATION) {
    const reference = new InkInputFilter();
    const expected = inkFixture(kind).raw.map(p => reference.push(p, setting));
    for (const zoom of INK_ZOOMS) {
      const filter = new InkInputFilter();
      const actual = inkFixture(kind, 120, zoom).raw.map(p => filter.push(p, setting, zoom));
      actual.forEach((p, i) => {
        assert.ok(Math.hypot(p.x * zoom - expected[i].x, p.y * zoom - expected[i].y) < 1e-8);
        assert.equal(p.pressure, expected[i].pressure); assert.equal(p.t, expected[i].t);
      });
    }
  }
});

test('strong stabilization retains intentional corners, reversals, loops and dots within its explicit two-pixel bound', () => {
  for (const kind of INK_CASES) for (const hz of [60, 120, 240]) {
    const f = inkFixture(kind, hz, 1, false), filter = new InkInputFilter();
    const output = f.raw.map(p => filter.push(p, 100));
    output.forEach((p, i) => assert.ok(Math.hypot(p.x - f.raw[i].x, p.y - f.raw[i].y) <= 2 + 1e-8));
    assert.deepEqual(output[0], f.raw[0]);
    assert.equal(output.length, f.raw.length);
    if (kind === 'dot') assert.deepEqual(output, f.raw);
    if (kind === 'zigzag') for (const vertex of [[50, 30], [80, 90], [110, 30]])
      assert.ok(output.some(p => Math.hypot(p.x - vertex[0], p.y - vertex[1]) <= 2.1), 'deliberate cusp survives');
    if (kind === 'circle') assert.ok(output.every(p => Math.abs(Math.hypot(p.x - 75, p.y - 65) - 40) < 2.01), 'loop retained');
  }
});

test('local curve sampling preserves an immutable prefix, pressure endpoints and sharp corners', () => {
  const curve = new InkCenterline(), output: import('../src/components/notebook/engine/drawingTypes.ts').StrokePoint[] = [];
  for (const p of inkFixture('circle', 24, 1, false).raw) {
    const prefix = structuredClone(output);
    curve.append(p, output);
    assert.deepEqual(output.slice(0, prefix.length), prefix, 'already rendered geometry cannot change');
    assert.deepEqual(output.at(-1), p, 'physical filtered sample is retained');
  }
  assert.ok(output.length > 25, 'sparse curved input is tessellated');
  assert.ok(output.every(p => p.pressure === .5));
  curve.reset(); output.length = 0;
  const corner = [{ x: 0, y: 0, pressure: .2, t: 0 }, { x: 20, y: 0, pressure: .5, t: 10 }, { x: 20, y: 20, pressure: .8, t: 20 }];
  corner.forEach(p => curve.append(p, output));
  assert.deepEqual(output, corner, 'an intentional right angle must not become a global spline');
});

test('sparse circle interpolation improves chord error without geometric overshoot', () => {
  const f = inkFixture('sparse', 120, 1, false), curve = new InkCenterline(), output: typeof f.raw = [];
  f.raw.forEach(p => curve.append(p, output));
  const radialError = (points: typeof f.raw) => {
    let sum = 0, count = 0;
    for (let i = 1; i < points.length; i++) for (let j = 0; j <= 10; j++) {
      const u = j / 10, a = points[i - 1], b = points[i];
      sum += Math.abs(Math.hypot(a.x + (b.x - a.x) * u - 75, a.y + (b.y - a.y) * u - 65) - 40); count++;
    }
    return sum / count;
  };
  assert.ok(radialError(output) < radialError(f.raw) * .3);
  assert.ok(output.every(p => Math.abs(Math.hypot(p.x - 75, p.y - 65) - 40) < .8));
});

test('filter reset isolates consecutive strokes', () => {
  const filter = new InkInputFilter();
  filter.push({ x: 500, y: 500, pressure: 1, t: 10 }, 100);
  filter.reset();
  assert.deepEqual(filter.push({ x: 10, y: 20, pressure: .2, t: 0 }, 100), { x: 10, y: 20, pressure: .2, t: 0 });
});

test('a long sampling gap uses actual elapsed time instead of imposing an extra slow-device delay', () => {
  const filter = new InkInputFilter();
  filter.push({ x: 0, y: 0, pressure: .5, t: 0 }, 100);
  const sample = { x: 8, y: 0, pressure: .8, t: 1000 }, output = filter.push(sample, 100);
  assert.ok(sample.x - output.x <= 8 * .02 / 1.02 + 1e-9, '20ms maximum time constant still applies after a sparse sample');
  assert.equal(output.pressure, sample.pressure); assert.equal(output.t, sample.t);
});

test('the entire sampled centerline is zoom-invariant, not only its filtered endpoints', () => {
  for (const kind of INK_CASES) for (const setting of INK_STABILIZATION) {
    const render = (zoom: number) => {
      const filter = new InkInputFilter(), curve = new InkCenterline(), output: import('../src/components/notebook/engine/drawingTypes.ts').StrokePoint[] = [];
      for (const p of inkFixture(kind, 120, zoom).raw) curve.append(filter.push(p, setting, zoom), output, zoom);
      return output;
    };
    const reference = render(1);
    for (const zoom of INK_ZOOMS) {
      const output = render(zoom);
      assert.equal(output.length, reference.length);
      output.forEach((p, i) => {
        assert.ok(Math.hypot(p.x * zoom - reference[i].x, p.y * zoom - reference[i].y) < 1e-7);
        assert.equal(p.pressure, reference[i].pressure); assert.equal(p.t, reference[i].t);
      });
    }
  }
});

test('slow and fast strokes remain causal and bounded; extreme gaps cannot cause unbounded tessellation', () => {
  for (const hz of [60, 120, 240]) for (const duration of [250, 1000, 4000]) for (const kind of INK_CASES) for (const setting of INK_STABILIZATION) {
    const filter = new InkInputFilter(), fixture = inkFixture(kind, hz, 1, true, duration);
    for (const p of fixture.raw) {
      const output = filter.push(p, setting);
      assert.ok(Math.hypot(output.x - p.x, output.y - p.y) <= setting / 50 + 1e-8);
      assert.equal(output.pressure, p.pressure); assert.equal(output.t, p.t);
    }
  }
  const curve = new InkCenterline(), points: import('../src/components/notebook/engine/drawingTypes.ts').StrokePoint[] = [];
  const input = [{ x: 0, y: 0, pressure: .5, t: 0 }, { x: 1e6, y: 0, pressure: .5, t: 8 }, { x: 2e6, y: 2e5, pressure: .5, t: 16 }];
  input.forEach(p => curve.append(p, points));
  assert.deepEqual(points, input, 'extreme sampling gaps use exact chords');
});


test('nib strategies distinguish direction, pressure, taper and flat felt geometry', async () => {
  const { buildInkFamilyGeometry, inkSampleWidths, INK_FAMILIES } = await import('../src/components/notebook/engine/inkFamilyGeometry.ts');
  const base = { id: 'nib', type: 'stroke' as const, tool: 'pen' as const, createdAt: 0, color: '#000000', opacity: 1, thickness: 4, points: Array.from({ length: 21 }, (_, i) => ({ x: i * 5, y: 0, pressure: 0.5, t: i })) };
  const fountain = { ...base, inkFamily: 'fountain' as const };
  const horizontal = inkSampleWidths(fountain)[10];
  const vertical = inkSampleWidths({ ...fountain, points: base.points.map(p => ({ ...p, x: 0, y: p.x })) })[10];
  assert.ok(vertical > horizontal * 3);
  const brush = inkSampleWidths({ ...base, inkFamily: 'brush' });
  assert.ok(brush[10] > brush[0] * 3 && brush[10] > brush[20] * 3);
  assert.deepEqual(inkSampleWidths({ ...base, inkFamily: 'felt' }), inkSampleWidths({ ...base, inkFamily: 'felt', points: base.points.map(p => ({ ...p, pressure: 0.1 })) }));
  for (const inkFamily of INK_FAMILIES) for (const pattern of ['solid', 'dashed', 'dotted'] as const) {
    const stroke = { ...base, inkFamily, pattern };
    const geometry = buildInkFamilyGeometry(stroke);
    assert.ok(geometry.length);
    assert.ok(geometry.flat().every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    assert.deepEqual(buildInkFamilyGeometry(JSON.parse(JSON.stringify(stroke))), geometry);
  }
  assert.deepEqual(buildInkFamilyGeometry(base), []);
});


test('patterned nib hit/eraser width includes the actual rendered marks', async () => {
  const { buildInkFamilyGeometry } = await import('../src/components/notebook/engine/inkFamilyGeometry.ts');
  const { getStrokeRenderHalfWidth } = await import('../src/components/notebook/engine/strokeGeometry.ts');
  const stroke = { id: 'wide-dot', type: 'stroke' as const, tool: 'pen' as const, createdAt: 0, color: '#000000', opacity: 1, thickness: 10, inkFamily: 'fountain' as const, pattern: 'dotted' as const, points: [{ x: 0, y: 0, pressure: 1, t: 0 }, { x: 100, y: 0, pressure: 1, t: 1 }] };
  const firstDot = buildInkFamilyGeometry(stroke)[0];
  const visibleRadius = Math.max(...firstDot.map(p => Math.hypot(p.x, p.y)));
  assert.ok(getStrokeRenderHalfWidth(stroke) + 1e-8 >= visibleRadius);
});

type ProbePoint = import('../src/components/notebook/engine/drawingTypes.ts').StrokePoint;

function dispatch(x: number, y: number, t: number, history: { x: number; y: number; t: number }[] = []) {
  const coalesced = history.map(h => ({ pointerId: 7, pointerType: 'pen', clientX: h.x, clientY: h.y, pressure: .5, timeStamp: h.t, type: 'pointermove' }));
  return {
    pointerId: 7, pointerType: 'pen', clientX: x, clientY: y, pressure: .5, timeStamp: t, type: 'pointermove',
    getCoalescedEvents: history.length ? () => coalesced : undefined,
  };
}

test('out-of-order coalesced history reports the chronological insertion index and stays sorted', () => {
  const stream = new InkSamples(dispatch(0, 0, 0) as any);
  stream.consume(dispatch(0, 0, 0) as any);
  stream.consume(dispatch(3, 0, 12) as any);
  stream.consume(dispatch(6, 0, 24) as any);
  // A held-back sample between t=12 and t=24 arrives late.
  const result = stream.consume(dispatch(9, 0, 30, [{ x: 4.5, y: 1, t: 18 }]) as any);
  assert.equal(result.rebuild, true);
  assert.ok(Number.isFinite(result.insertedAt));
  assert.equal(stream.samples[result.insertedAt].timeStamp, 18);
  const times = stream.samples.map(s => s.timeStamp);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

type FilterCheckpoint = ReturnType<InkInputFilter['checkpoint']>;
type CurveCheckpoint = ReturnType<InkCenterline['checkpoint']>;

function refilter(points: ProbePoint[], setting: number, zoom: number,
  resume?: { filterState: FilterCheckpoint; curveState: CurveCheckpoint; output: ProbePoint[]; at: number }): ProbePoint[] {
  const filter = new InkInputFilter(), curve = new InkCenterline(), output: ProbePoint[] = [];
  let at = 0;
  if (resume) {
    filter.restore(resume.filterState);
    curve.restore(resume.curveState);
    output.push(...resume.output);
    at = resume.at;
  }
  for (; at < points.length; at++) curve.append(filter.push(points[at], setting, zoom), output, zoom);
  return output;
}

test('filter and centerline checkpoints restore state exactly, so an incremental refilter equals a full one', () => {
  for (const setting of [0, 50, 100]) for (const zoom of [1, .5]) {
    const raw = inkFixture('word', 120, zoom).raw;
    // Process in three batches, checkpointing at each batch boundary.
    const filter = new InkInputFilter(), curve = new InkCenterline(), output: ProbePoint[] = [];
    const checkpoints: { samples: number; filtered: number; filterState: FilterCheckpoint; curveState: CurveCheckpoint }[] = [];
    let at = 0;
    for (const batchEnd of [10, 20, raw.length]) {
      checkpoints.push({ samples: at, filtered: output.length, filterState: filter.checkpoint(), curveState: curve.checkpoint() });
      for (; at < batchEnd; at++) curve.append(filter.push(raw[at], setting, zoom), output, zoom);
    }
    const prefix = structuredClone(output);
    // Rewind to the checkpoint at sample 20 and replay the same tail.
    const resume = checkpoints[2];
    const replayed = refilter(raw, setting, zoom, { filterState: resume.filterState, curveState: resume.curveState, output: output.slice(0, resume.filtered), at: resume.samples });
    assert.deepEqual(replayed, prefix, 'restored state must reproduce the identical continuation');
    // Bit-exact equality with a from-scratch run of the same samples.
    assert.deepEqual(replayed, refilter(raw, setting, zoom));
  }
});

test('a mid-stream sample insertion moves only post-rewind geometry; the displayed prefix never changes', () => {
  const setting = 50, zoom = 1;
  const raw = inkFixture('word', 240, zoom).raw;
  const filter = new InkInputFilter(), curve = new InkCenterline(), output: ProbePoint[] = [];
  const checkpoints: { samples: number; filtered: number; filterState: FilterCheckpoint; curveState: CurveCheckpoint }[] = [];
  let at = 0;
  while (at < 60) {
    checkpoints.push({ samples: at, filtered: output.length, filterState: filter.checkpoint(), curveState: curve.checkpoint() });
    for (const end = Math.min(at + 3, 60); at < end; at++) curve.append(filter.push(raw[at], setting, zoom), output, zoom);
  }
  const prefixSnapshot = structuredClone(output);
  // One held-back sample between raw[54] and raw[55] arrives late.
  const streamSamples = [...raw.slice(0, 60)];
  streamSamples.splice(55, 0, { x: (raw[54].x + raw[55].x) / 2, y: (raw[54].y + raw[55].y) / 2 + .4, pressure: .5, t: (raw[54].t + raw[55].t) / 2 });
  const insertion = 55;
  const checkpoint = [...checkpoints].reverse().find(cp => cp.samples <= insertion)!;
  const incremental = refilter(streamSamples, setting, zoom,
    { filterState: checkpoint.filterState, curveState: checkpoint.curveState, output: output.slice(0, checkpoint.filtered), at: checkpoint.samples });
  assert.deepEqual(incremental.slice(0, checkpoint.filtered),
    prefixSnapshot.slice(0, checkpoint.filtered), 'geometry before the rewind point is final and must not move');
  const fromScratch = refilter(streamSamples, setting, zoom);
  assert.deepEqual(incremental, fromScratch, 'incremental refilter equals the full chronological refilter');
});

test('PenGeometry keeps valid cumulative distances across in-place revisions and truncation', () => {
  const points = Array.from({ length: 12 }, (_, i) => ({ x: i * 4, y: 0, pressure: .5, t: i * 8 }));
  const geometry = new PenGeometry();
  geometry.update(points);
  const full = geometry.distances[geometry.distances.length - 1];
  const revised = points.map((p, i) => i < 6 ? p : { x: i * 4 + 2, y: 1, pressure: .5, t: i * 8 });
  // Truncate in place (same array identity), then regrow with a revised tail.
  points.length = 6;
  geometry.update(points);
  assert.equal(geometry.distances.length, 6);
  points.length = 0;
  points.push(...revised);
  geometry.update(points, true, 6);
  assert.equal(geometry.distances.length, points.length);
  let cumulative = 0;
  for (let i = 1; i < points.length; i++) {
    cumulative += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    assert.ok(Math.abs(geometry.distances[i] - cumulative) < 1e-9, `distance ${i} matches the revised geometry`);
  }
  assert.ok(geometry.distances.at(-1)! > full, 'the revised detour is longer than the original path');
  // A different array identity still fully resets (wet-surface rebuild semantics).
  const reset = geometry.update(points.map(p => ({ ...p })));
  assert.equal(reset, true);
});

// ---- Gesture recognition zoom invariance ----
// Recognizer thresholds describe the gesture the user drew on screen (CSS px).
// The same physical gesture must get the same verdict at every zoom level, and
// sub-threshold screen gestures must stay rejected when zoomed out.

function screenStroke(points: [number, number][], msPerSample = 8): ProbePoint[] {
  return points.map(([x, y], i) => ({ x, y, pressure: .5, t: i * msPerSample }));
}
function straightLineScreen(length: number): ProbePoint[] {
  return screenStroke(Array.from({ length: 49 }, (_, i) => [i * length / 48, 0]));
}
function bowedLineScreen(length: number, bow: number): ProbePoint[] {
  return screenStroke(Array.from({ length: 49 }, (_, i) => {
    const u = i / 48;
    return [u * length, bow * Math.sin(Math.PI * u)];
  }));
}
function scribbleScreen(): ProbePoint[] {
  // Five left-right traversals along x with a slight downward drift.
  const points: [number, number][] = [];
  for (let traversal = 0; traversal < 5; traversal++) {
    for (let step = 0; step <= 8; step++) {
      const u = step / 8;
      const x = traversal % 2 === 0 ? u * 30 : 30 - u * 30;
      points.push([x, traversal * 2 + u * 1.5]);
    }
  }
  return screenStroke(points, 17.5);
}
function circleScreen(radius: number, sweepDegrees = 360): ProbePoint[] {
  const count = 24, sweep = sweepDegrees * Math.PI / 180;
  return screenStroke(Array.from({ length: count + 1 }, (_, i) => {
    const angle = sweep * i / count;
    return [30 + radius * Math.cos(angle), 30 + radius * Math.sin(angle)];
  }), 10);
}
function ellipseScreen(radiusX: number, radiusY: number): ProbePoint[] {
  return screenStroke(Array.from({ length: 41 }, (_, i) => {
    const angle = Math.PI * 2 * i / 40;
    return [40 + radiusX * Math.cos(angle), 30 + radiusY * Math.sin(angle)];
  }), 10);
}
const toPage = (points: ProbePoint[], zoom: number) => points.map(p => ({ ...p, x: p.x / zoom, y: p.y / zoom }));

test('gesture verdicts are invariant under page zoom for the same on-screen gesture', () => {
  const cases = {
    line: straightLineScreen(100),
    bowed: bowedLineScreen(100, 15),
    scribble: scribbleScreen(),
    word: inkFixture('word', 120, 1).raw,
    circle: circleScreen(18),
    arc: circleScreen(18, 300),
    ellipse: ellipseScreen(36, 24),
  };
  for (const zoom of INK_ZOOMS) {
    assert.equal(recognizeStraightLine(toPage(cases.line, zoom), false, zoom).isLine, true, `line accepted at zoom ${zoom}`);
    assert.equal(recognizeStraightLine(toPage(cases.bowed, zoom), false, zoom).isLine, false, `bowed line rejected at zoom ${zoom}`);
    assert.equal(analyzeScribble(toPage(cases.scribble, zoom), zoom).isScribble, true, `scribble accepted at zoom ${zoom}`);
    assert.equal(analyzeScribble(toPage(cases.word, zoom), zoom).isScribble, false, `handwriting not erased at zoom ${zoom}`);
    assert.equal(analyzeCircleGesture(toPage(cases.circle, zoom), zoom).isCircle, true, `circle accepted at zoom ${zoom}`);
    assert.equal(analyzeCircleGesture(toPage(cases.arc, zoom), zoom).isCircle, false, `open arc rejected at zoom ${zoom}`);
    const shape = recognizeRoughShape(toPage(cases.ellipse, zoom), false, zoom);
    assert.equal(shape.isShape && shape.shapeType, 'ellipse', `ellipse recognized at zoom ${zoom}`);
    assert.equal(recognizeRoughShape(toPage(cases.word, zoom), false, zoom).isShape, false, `handwriting not reshaped at zoom ${zoom}`);
  }
});

test('sub-threshold screen gestures stay rejected when zoomed out instead of crossing page-space thresholds', () => {
  // A 40 CSS-px line sits below the 56 px deliberate-line threshold; page space
  // at 35% zoom made it look like a 114-unit stroke and accepted it.
  for (const zoom of [.35, .5, .75]) {
    assert.equal(recognizeStraightLine(toPage(straightLineScreen(40), zoom), false, zoom).isLine, false, `40px line rejected at zoom ${zoom}`);
    assert.equal(analyzeCircleGesture(toPage(circleScreen(12), zoom), zoom).isCircle, false, `24px circle rejected at zoom ${zoom}`);
    assert.equal(recognizeRoughShape(toPage(ellipseScreen(16, 10), zoom), false, zoom).isShape, false, `32px ellipse rejected at zoom ${zoom}`);
  }
  // The same gestures are also rejected at 100%: the threshold itself is unchanged.
  assert.equal(recognizeStraightLine(straightLineScreen(40), false, 1).isLine, false);
  assert.equal(analyzeCircleGesture(circleScreen(12), 1).isCircle, false);
});

test('recognized gesture geometry is returned in page space regardless of zoom', () => {
  const zoom = .5, pageLine = toPage(straightLineScreen(100), zoom);
  const recognized = recognizeStraightLine(pageLine, false, zoom);
  assert.ok(recognized.isLine);
  assert.deepEqual(recognized.points, [pageLine[0], pageLine.at(-1)], 'endpoints match the page-space input exactly');
  const shape = recognizeRoughShape(toPage(ellipseScreen(36, 24), zoom), false, zoom);
  assert.ok(shape.isShape);
  const pagePoints = toPage(ellipseScreen(36, 24), zoom);
  const xs = pagePoints.map(p => p.x), ys = pagePoints.map(p => p.y);
  assert.ok(Math.abs(shape.x - Math.min(...xs)) < 1e-6 && Math.abs(shape.y - Math.min(...ys)) < 1e-6);
  assert.ok(Math.abs(shape.width - (Math.max(...xs) - Math.min(...xs))) < 1e-6);
  assert.ok(Math.abs(shape.height - (Math.max(...ys) - Math.min(...ys))) < 1e-6);
});
