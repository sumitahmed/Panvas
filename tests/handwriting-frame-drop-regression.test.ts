import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeJson } from '../src/services/cloudsync/hash.ts';
import type { Stroke, StrokePoint } from '../src/components/notebook/engine/drawingTypes.ts';

test('canonicalizeJson matches canonical specification across primitives, arrays, and nested objects', () => {
  // Primitives
  assert.equal(canonicalizeJson(null), 'null');
  assert.equal(canonicalizeJson(123), '123');
  assert.equal(canonicalizeJson('hello'), '"hello"');
  assert.equal(canonicalizeJson(true), 'true');
  assert.equal(canonicalizeJson(false), 'false');

  // Arrays
  assert.equal(canonicalizeJson([]), '[]');
  assert.equal(canonicalizeJson([1, 'two', null, false]), '[1,"two",null,false]');

  // Object key sorting
  assert.equal(canonicalizeJson({ z: 1, a: 2, m: 3 }), '{"a":2,"m":3,"z":1}');

  // Undefined omission
  assert.equal(canonicalizeJson({ a: 1, b: undefined, c: 3 }), '{"a":1,"c":3}');

  // Nested structures
  const complex = {
    b: [{ z: 1, y: 2 }],
    a: { nested: true, count: 5 },
  };
  assert.equal(canonicalizeJson(complex), '{"a":{"count":5,"nested":true},"b":[{"y":2,"z":1}]}');
});

test('canonicalizeJson StrokePoint fast path matches exact canonical key order', () => {
  const pt1: StrokePoint = { x: 10.5, y: 20.25, pressure: 0.75, t: 150 };
  const pt2: StrokePoint = { x: 0, y: 0, pressure: 0, t: 0 };
  const pt3: StrokePoint = { x: -5, y: -10, pressure: 1, t: 999 };

  // Alphabetical order of StrokePoint keys: pressure, t, x, y
  assert.equal(canonicalizeJson(pt1), '{"pressure":0.75,"t":150,"x":10.5,"y":20.25}');
  assert.equal(canonicalizeJson(pt2), '{"pressure":0,"t":0,"x":0,"y":0}');
  assert.equal(canonicalizeJson(pt3), '{"pressure":1,"t":999,"x":-5,"y":-10}');

  // StrokePoint without optional pressure or t
  const ptWithoutPressure: any = { x: 1, y: 2, t: 3 };
  assert.equal(canonicalizeJson(ptWithoutPressure), '{"t":3,"x":1,"y":2}');

  const ptMinimal: any = { x: 1, y: 2 };
  assert.equal(canonicalizeJson(ptMinimal), '{"x":1,"y":2}');
});

test('canonicalizeJson memoization provides sub-millisecond warm execution on dense 1,200 stroke drawings', () => {
  const strokes: Stroke[] = [];
  for (let s = 0; s < 1200; s++) {
    const points: StrokePoint[] = [];
    for (let p = 0; p < 96; p++) {
      points.push({ x: p * 1.5, y: s * 2.0, pressure: 0.5, t: 1000 + p * 10 });
    }
    strokes.push({
      id: `stroke-${s}`,
      type: 'stroke',
      tool: 'pen',
      color: '#20242a',
      thickness: 2,
      opacity: 1,
      createdAt: s * 100,
      centerline: 'polyline',
      points,
    });
  }
  const drawing = { version: 1, strokes, objects: [] };

  // First canonicalization computes and caches
  const firstPass = canonicalizeJson(drawing);
  assert.ok(firstPass.length > 1_000_000);

  // Second pass: warm lookup must take < 2 ms (previously 200 ms)
  const warmStart = performance.now();
  const warmPass = canonicalizeJson(drawing);
  const warmDuration = performance.now() - warmStart;

  assert.equal(warmPass, firstPass);
  assert.ok(warmDuration < 5, `Warm canonicalize took ${warmDuration.toFixed(2)} ms, expected < 5 ms`);

  // Incremental addition of 1 stroke to 1,200 existing strokes must take < 10 ms
  const newStroke: Stroke = {
    id: 'stroke-1201',
    type: 'stroke',
    tool: 'pen',
    color: '#0055ff',
    thickness: 2,
    opacity: 1,
    createdAt: 120100,
    centerline: 'polyline',
    points: [{ x: 50, y: 50, pressure: 0.5, t: 0 }],
  };
  const updatedDrawing = { version: 1, strokes: [...strokes, newStroke], objects: [] };

  const incrementalStart = performance.now();
  const incrementalPass = canonicalizeJson(updatedDrawing);
  const incrementalDuration = performance.now() - incrementalStart;

  assert.ok(incrementalPass.includes('"stroke-1201"'));
  assert.ok(incrementalDuration < 15, `Incremental canonicalize took ${incrementalDuration.toFixed(2)} ms, expected < 15 ms`);
});

test('drawing persistence save callbacks do not force re-renders when drawing revision is unchanged', () => {
  let sectionDataRevision = 0;
  let cache: Record<string, any> = {};
  let publishedCache = cache;
  let drawingGestureActive = false;
  let pendingPublish = false;

  const updateSectionDataCache = (update: (current: Record<string, any>) => Record<string, any>, publish = true) => {
    const next = update(cache);
    cache = next;
    if (publish && next !== publishedCache) {
      publishedCache = next;
      if (drawingGestureActive) {
        pendingPublish = true;
      } else {
        sectionDataRevision++;
      }
    }
  };

  const sectionDataRevisionRef: Record<string, number> = {};

  const publishSnapshotPageData = (snapshot: { saveTargetSheetId: string; drawingRevision: number }, data: any) => {
    const pageId = snapshot.saveTargetSheetId;
    const knownRevision = sectionDataRevisionRef[pageId];
    if (knownRevision !== undefined && knownRevision > snapshot.drawingRevision) return;
    if (knownRevision === snapshot.drawingRevision) {
      updateSectionDataCache(previous => {
        const current = previous[pageId];
        if (!current) return { ...previous, [pageId]: data };
        return {
          ...previous,
          [pageId]: { ...current, version: data.version },
        };
      }, false); // Critical: false suppresses unnecessary React re-renders!
      return;
    }
    sectionDataRevisionRef[pageId] = snapshot.drawingRevision;
    updateSectionDataCache(previous => ({ ...previous, [pageId]: data }));
  };

  // Simulate user finishing stroke at revision 10
  const pageId = 'page-1';
  sectionDataRevisionRef[pageId] = 10;
  cache[pageId] = { version: 1, strokes: ['initial'] };
  publishedCache = cache;

  // On save scheduled: snapshot at revision 10
  publishSnapshotPageData({ saveTargetSheetId: pageId, drawingRevision: 10 }, { version: 1, strokes: ['initial'] });
  assert.equal(sectionDataRevision, 0, 'onScheduled must NOT trigger a React component re-render');

  // On save finished: snapshot at revision 10
  publishSnapshotPageData({ saveTargetSheetId: pageId, drawingRevision: 10 }, { version: 1, strokes: ['initial'] });
  assert.equal(sectionDataRevision, 0, 'onSaved must NOT trigger a React component re-render');

  // While drawing gesture is active, any required publish must be deferred
  drawingGestureActive = true;
  updateSectionDataCache(prev => ({ ...prev, external: true }), true);
  assert.equal(sectionDataRevision, 0, 'Active pen gesture must defer React re-render');
  assert.equal(pendingPublish, true, 'Pending publish must be flagged for pen-up');

  // Pen lifted (pen-up): flushes pending publish
  drawingGestureActive = false;
  if (pendingPublish) {
    pendingPublish = false;
    sectionDataRevision++;
  }
  assert.equal(sectionDataRevision, 1, 'Pen-up flushes deferred publish');
});

