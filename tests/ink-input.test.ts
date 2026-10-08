import assert from 'node:assert/strict';
import test from 'node:test';
import { InkInputFilter, mapPointerPressure } from '../src/components/notebook/engine/inkInput.ts';
import { InkCenterline } from '../src/components/notebook/engine/inkCenterline.ts';
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
