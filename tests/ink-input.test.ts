import assert from 'node:assert/strict';
import test from 'node:test';
import { InkInputFilter, mapPointerPressure } from '../src/components/notebook/engine/inkInput.ts';

test('pressure mapping uses stylus pressure only when enabled and keeps mouse stable', () => {
  assert.equal(mapPointerPressure('mouse', 0.03, true), 0.5);
  assert.equal(mapPointerPressure('pen', 0.9, false), 0.5);
  assert.equal(mapPointerPressure('pen', 0, true), 0.5);
  assert.ok(mapPointerPressure('pen', 0.15, true) < mapPointerPressure('pen', 0.5, true));
  assert.ok(mapPointerPressure('pen', 0.85, true) > mapPointerPressure('pen', 0.5, true));
});

test('fidelity mode bounds XY deviation to zero and preserves contact pressure at every setting', () => {
  const source = [0, 8, -7, 9, -8, 10].map((y, index) => ({ x: index * 4, y, pressure: 0.2 + index * 0.12, t: index * 8 }));
  const raw = new InkInputFilter();
  const strong = new InkInputFilter();
  const rawPoints = source.map(point => raw.push(point, 0));
  const stablePoints = source.map(point => strong.push(point, 100));
  assert.deepEqual(rawPoints, source);
  assert.deepEqual(stablePoints, source, 'cosmetic stabilization cannot rewrite intentional turns or pressure');
});

test('filter reset isolates consecutive strokes', () => {
  const filter = new InkInputFilter();
  filter.push({ x: 500, y: 500, pressure: 1, t: 10 }, 100);
  filter.reset();
  assert.deepEqual(filter.push({ x: 10, y: 20, pressure: .2, t: 0 }, 100), { x: 10, y: 20, pressure: .2, t: 0 });
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
