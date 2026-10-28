import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WriteQueue } from '../electron/ipc/write-queue.ts';
import {
  MAX_DRAWING_PAYLOAD_BYTES,
  MAX_JSON_PAYLOAD_BYTES,
  requireDrawingPayload,
  requireJsonPayload,
  requireRemoteRecordPayload,
} from '../electron/ipc/payload-limits.ts';
import {
  DrawingPersistenceQueue,
  type DrawingSaveTarget,
} from '../src/components/notebook/drawingPersistenceQueue.ts';
import {
  DrawingSaveScheduler,
  DEFAULT_MAX_DEFERRAL_MS,
} from '../src/components/notebook/drawingSaveScheduler.ts';
import {
  capturePageOwnedDrawing,
  type PageOwnedDrawing,
} from '../src/components/notebook/notebookPageRenderState.ts';
import { createEmptyDrawingData, type DrawingData, type Stroke } from '../src/components/notebook/engine/drawingTypes.ts';
import { deriveSaveStatus, mergePageSaveStatus } from '../src/stores/saveStatus.ts';

const TARGET: DrawingSaveTarget = { workspaceId: 'workspace-1', notebookId: 'notebook-1' };

function pageSnapshot(sequence: number, pageId = 'page-1', revision = sequence): PageOwnedDrawing {
  return {
    documentId: TARGET.notebookId,
    sheetId: pageId,
    renderedSheetId: pageId,
    sceneOwnerSheetId: pageId,
    saveTargetSheetId: pageId,
    drawingRevision: revision,
    sequence,
    data: createEmptyDrawingData(),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
    }
    await delay(stepMs);
  }
}

function largeDrawing(minCompactBytes: number): DrawingData {
  const data = createEmptyDrawingData();
  const padding = 'p'.repeat(16 * 1024);
  const sample: Stroke = {
    id: 'stroke-0',
    type: 'stroke',
    tool: 'pen',
    points: [{ x: 0, y: 0, pressure: 0.5, t: 0 }],
    color: '#123456',
    thickness: 2,
    opacity: 1,
    createdAt: 0,
    metadata: { padding },
  };
  const perObject = Buffer.byteLength(JSON.stringify(sample), 'utf8');
  const count = Math.ceil(minCompactBytes / perObject) + 1;
  data.objects = Array.from({ length: count }, (_, index) => ({
    ...sample,
    id: `stroke-${index}`,
    createdAt: index,
    points: [{ x: index, y: index, pressure: 0.5, t: 0 }],
  }));
  return data;
}

test('captured page snapshots receive a monotonic persistence sequence', () => {
  const first = capturePageOwnedDrawing('notebook-1', 'page-a', 'page-a', 1, createEmptyDrawingData());
  const second = capturePageOwnedDrawing('notebook-1', 'page-b', 'page-b', 1, createEmptyDrawingData());
  assert.ok(first);
  assert.ok(second);
  assert.ok(second.sequence > first.sequence);
});

test('a failed drawing write retries passively without another edit', async () => {
  const snapshot = pageSnapshot(1);
  const attempts: number[] = [];
  const statuses: string[] = [];
  const failures: Array<{ willRetry: boolean }> = [];
  const queue = new DrawingPersistenceQueue(() => ({
    resolveTarget: () => TARGET,
    encode: current => JSON.stringify(current.data),
    save: async (_target, data, current) => {
      attempts.push(current.sequence);
      if (attempts.length === 1) throw new Error('write lock');
      return data;
    },
    onStatus: (_current, status) => statuses.push(status),
    onFailed: (_current, _error, context) => failures.push(context),
  }), [10]);

  try {
    assert.equal(queue.persist(snapshot), 'scheduled');
    await delay(0);
    assert.deepEqual(attempts, [1]);
    assert.equal(queue.hasFailed(snapshot.saveTargetSheetId), true);
    assert.deepEqual(failures, [{ willRetry: true }]);

    await delay(100);
    assert.deepEqual(attempts, [1, 1]);
    assert.equal(queue.hasFailed(snapshot.saveTargetSheetId), false);
    assert.deepEqual(statuses, ['saving', 'error', 'saving', 'saved']);
  } finally {
    queue.cancelRetries();
  }
});

test('a lifecycle flush retries a failed snapshot immediately', async () => {
  const snapshot = pageSnapshot(1);
  const attempts: number[] = [];
  let fail = true;
  const queue = new DrawingPersistenceQueue(() => ({
    resolveTarget: () => TARGET,
    encode: () => '{}',
    save: async (_target, data, current) => {
      attempts.push(current.sequence);
      if (fail) throw new Error('locked');
      return data;
    },
  }), [60_000]);

  try {
    queue.persist(snapshot);
    await delay(0);
    assert.equal(queue.hasFailed(snapshot.saveTargetSheetId), true);

    fail = false;
    queue.flushFailed();
    await delay(0);
    assert.deepEqual(attempts, [1, 1]);
    assert.equal(queue.hasFailed(snapshot.saveTargetSheetId), false);
  } finally {
    queue.cancelRetries();
  }
});

test('an unavailable save target is retried but a deleted page is not written', async () => {
  const transient = pageSnapshot(1, 'page-transient');
  let available = false;
  let saves = 0;
  const queue = new DrawingPersistenceQueue(() => ({
    resolveTarget: current => current.saveTargetSheetId === 'page-transient'
      ? (available ? TARGET : null)
      : 'stale',
    encode: () => '{}',
    save: async (_target, data) => {
      saves += 1;
      return data;
    },
  }), [60_000]);

  try {
    assert.equal(queue.persist(transient), 'target-unavailable');
    assert.equal(queue.getScheduledSequence('page-transient'), undefined);
    assert.equal(queue.hasFailed('page-transient'), true);
    assert.equal(saves, 0);

    available = true;
    queue.flushFailed();
    await delay(0);
    assert.equal(saves, 1);
    assert.equal(queue.hasFailed('page-transient'), false);
    assert.equal(queue.getScheduledSequence('page-transient'), 1);

    const deleted = pageSnapshot(2, 'page-deleted');
    assert.equal(queue.persist(deleted), 'stale-target');
    assert.equal(queue.hasFailed('page-deleted'), false);
    assert.equal(queue.getScheduledSequence('page-deleted'), undefined);
    assert.equal(saves, 1);
  } finally {
    queue.cancelRetries();
  }
});

test('late completion from an older capture cannot overwrite the newer page status', async () => {
  const first = pageSnapshot(1);
  const second = pageSnapshot(2);
  const firstWrite = deferred<DrawingData>();
  const secondWrite = deferred<DrawingData>();
  const statuses: Array<[number, string]> = [];
  const completions: Array<[boolean, boolean]> = [];
  const queue = new DrawingPersistenceQueue(() => ({
    resolveTarget: () => TARGET,
    encode: current => `json-${current.sequence}`,
    save: (_target, _data, current) => current.sequence === 1 ? firstWrite.promise : secondWrite.promise,
    onStatus: (current, status) => statuses.push([current.sequence, status]),
    onSaved: (_current, _data, completion) => completions.push([completion.latestScheduled, completion.latestPersisted]),
  }), []);

  try {
    assert.equal(queue.persist(first), 'scheduled');
    assert.equal(queue.persist(second), 'scheduled');

    secondWrite.resolve(second.data);
    await delay(0);
    assert.deepEqual(statuses, [[1, 'saving'], [2, 'saving'], [2, 'saved']]);

    firstWrite.resolve(first.data);
    await delay(0);
    assert.deepEqual(statuses, [[1, 'saving'], [2, 'saving'], [2, 'saved']]);
    assert.deepEqual(completions, [[true, true], [false, false]]);
  } finally {
    queue.cancelRetries();
  }
});

test('a failed older write cannot surface an error after a newer write succeeded', async () => {
  const first = pageSnapshot(1);
  const second = pageSnapshot(2);
  const firstWrite = deferred<DrawingData>();
  const secondWrite = deferred<DrawingData>();
  let failures = 0;
  const statuses: string[] = [];
  const queue = new DrawingPersistenceQueue(() => ({
    resolveTarget: () => TARGET,
    encode: current => `json-${current.sequence}`,
    save: (_target, _data, current) => current.sequence === 1 ? firstWrite.promise : secondWrite.promise,
    onStatus: (_current, status) => statuses.push(status),
    onFailed: () => { failures += 1; },
  }), [10]);

  try {
    queue.persist(first);
    queue.persist(second);
    secondWrite.resolve(second.data);
    await delay(0);

    firstWrite.reject(new Error('old write failed'));
    await delay(0);
    assert.equal(failures, 0);
    assert.equal(queue.hasFailed('page-1'), false);
    assert.deepEqual(statuses, ['saving', 'saving', 'saved']);
  } finally {
    queue.cancelRetries();
  }
});

test('a newer capture supersedes a failed snapshot and cancels its retry', async () => {
  const first = pageSnapshot(1);
  const second = pageSnapshot(2);
  const attempts: number[] = [];
  let firstFailed = false;
  const queue = new DrawingPersistenceQueue(() => ({
    resolveTarget: () => TARGET,
    encode: current => `json-${current.sequence}`,
    save: async (_target, data, current) => {
      attempts.push(current.sequence);
      if (current.sequence === 1 && !firstFailed) {
        firstFailed = true;
        throw new Error('locked');
      }
      return data;
    },
  }), [20]);

  try {
    queue.persist(first);
    await delay(0);
    assert.equal(queue.hasFailed('page-1'), true);

    queue.persist(second);
    await delay(0);
    assert.equal(queue.hasFailed('page-1'), false);
    assert.deepEqual(attempts, [1, 2]);

    await delay(80);
    assert.deepEqual(attempts, [1, 2]);
  } finally {
    queue.cancelRetries();
  }
});

test('the same immutable snapshot is written once', async () => {
  const snapshot = pageSnapshot(1);
  let saves = 0;
  const queue = new DrawingPersistenceQueue(() => ({
    resolveTarget: () => TARGET,
    encode: () => 'json',
    save: async (_target, data) => {
      saves += 1;
      return data;
    },
  }), []);

  assert.equal(queue.persist(snapshot), 'scheduled');
  assert.equal(queue.persist(snapshot), 'already-scheduled');
  await delay(0);
  assert.equal(queue.persist(snapshot), 'already-persisted');
  assert.equal(saves, 1);
});

test('per-page save status is ordered and keeps an error visible until that page recovers', () => {
  let pages: Record<string, { status: 'saving' | 'saved' | 'error'; sequence: number }> = {};
  pages = mergePageSaveStatus(pages, 'page-a', 2, 'saved') ?? {};
  assert.equal(mergePageSaveStatus(pages, 'page-a', 1, 'error'), null);

  pages = mergePageSaveStatus(pages, 'page-b', 1, 'saved') ?? {};
  assert.equal(deriveSaveStatus('idle', pages), 'saved');

  pages = mergePageSaveStatus(pages, 'page-a', 3, 'error') ?? {};
  assert.equal(deriveSaveStatus('idle', pages), 'error');

  pages = mergePageSaveStatus(pages, 'page-b', 2, 'saving') ?? {};
  assert.equal(deriveSaveStatus('idle', pages), 'error');

  pages = mergePageSaveStatus(pages, 'page-a', 4, 'saved') ?? {};
  assert.equal(deriveSaveStatus('idle', pages), 'saving');

  pages = mergePageSaveStatus(pages, 'page-b', 3, 'saved') ?? {};
  assert.equal(deriveSaveStatus('idle', pages), 'saved');
  assert.equal(deriveSaveStatus('error', {}), 'error');
  assert.equal(deriveSaveStatus('idle', {}), 'idle');
});

test('drawing payloads use a larger ceiling than generic JSON payloads', () => {
  assert.equal(MAX_JSON_PAYLOAD_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_DRAWING_PAYLOAD_BYTES, 64 * 1024 * 1024);

  const exactGenericLimit = 'x'.repeat(MAX_JSON_PAYLOAD_BYTES - 2);
  assert.equal(Buffer.byteLength(JSON.stringify(exactGenericLimit), 'utf8'), MAX_JSON_PAYLOAD_BYTES);
  assert.doesNotThrow(() => requireJsonPayload(exactGenericLimit, 'content payload'));
  assert.throws(() => requireJsonPayload(`${exactGenericLimit}x`, 'content payload'), {
    message: 'Invalid content payload.',
  });

  const aboveGenericLimit = 'x'.repeat(MAX_JSON_PAYLOAD_BYTES + 1);
  assert.doesNotThrow(() => requireDrawingPayload(aboveGenericLimit));
  assert.throws(() => requireDrawingPayload('x'.repeat(MAX_DRAWING_PAYLOAD_BYTES + 1)), {
    message: 'Invalid content payload.',
  });
});

test('Cloud Sync pageDrawing records use the drawing ceiling while other records keep the generic limit', () => {
  const aboveGenericLimit = 'x'.repeat(MAX_JSON_PAYLOAD_BYTES + 1);
  assert.doesNotThrow(() => requireRemoteRecordPayload({
    kind: 'pageDrawing',
    tombstone: false,
    payload: aboveGenericLimit,
  }));
  assert.throws(() => requireRemoteRecordPayload({
    kind: 'pageContent',
    tombstone: false,
    payload: aboveGenericLimit,
  }), { message: 'Invalid remote sync payload.' });
  assert.doesNotThrow(() => requireRemoteRecordPayload({
    kind: 'pageContent',
    tombstone: true,
    payload: aboveGenericLimit,
  }));
});

test('a drawing above the generic payload ceiling survives an atomic write and reload', async () => {
  const drawing = largeDrawing(MAX_JSON_PAYLOAD_BYTES + 512 * 1024);
  const compact = JSON.stringify(drawing);
  const compactBytes = Buffer.byteLength(compact, 'utf8');
  assert.ok(compactBytes > MAX_JSON_PAYLOAD_BYTES);
  assert.ok(compactBytes < MAX_DRAWING_PAYLOAD_BYTES);
  assert.doesNotThrow(() => requireDrawingPayload(drawing));
  assert.throws(() => requireJsonPayload(drawing, 'content payload'), {
    message: 'Invalid content payload.',
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'panvas-large-drawing-'));
  try {
    const target = path.join(directory, 'page-1.drawing.json');
    const queue = new WriteQueue();
    await queue.enqueue(target, JSON.stringify(drawing, null, 2));
    const reloaded = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(JSON.stringify(reloaded), compact);
    assert.deepEqual((await readdir(directory)).filter(name => name.includes('.tmp-')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('drawing saves, per-page status, and Cloud Sync validation are wired to the ordered queue', async () => {
  const [renderer, handlers, store] = await Promise.all([
    readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../electron/ipc/domain-handlers.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/stores/canvasStore.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(renderer, /new DrawingPersistenceQueue\(/);
  assert.match(renderer, /drawingPersistenceRef\.current\?\.flushFailed\(\)/);
  assert.match(renderer, /getScheduledSequence\(outgoingPageId\) !== latest\.sequence/);
  assert.match(renderer, /setSaveStatusForPage\(snapshot\.saveTargetSheetId, snapshot\.sequence, status\)/);
  assert.doesNotMatch(renderer, /latestScheduledDrawingRevisionRef/);

  assert.match(handlers, /channel === 'notebook:saveDrawing'[\s\S]*?requireDrawingPayload\(args\[3\]\)/);
  assert.match(handlers, /registerHandler\('notebook:saveDrawing'[\s\S]*?requireDrawingPayload\(drawingData\)/);
  assert.equal((handlers.match(/requireRemoteRecordPayload\(/g) ?? []).length, 2);
  assert.match(handlers, /for \(const record of bundle\.pageDrawings\)[\s\S]*?requireDrawingPayload\(record\.data\)/);

  assert.match(store, /mergePageSaveStatus\(/);
  assert.match(store, /deriveSaveStatus\(/);
});

test('continuous handwriting with short pauses (<1000ms) defers saves during active ink and flushes cleanly on pen-up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const saved: Array<{ revision: number }> = [];
  const events: string[] = [];
  const scheduler = new DrawingSaveScheduler<{ revision: number }>(snapshot => saved.push(snapshot), {
    debounceMs: 60,
    quietMs: 30,
    maxDeferralMs: 500,
    onEvent: event => events.push(event.type),
  });

  try {
    // Simulate 4 successive handwriting strokes where inter-stroke pauses are shorter than debounceMs (60ms)
    for (let stroke = 1; stroke <= 4; stroke++) {
      scheduler.setGestureActive(true);
      scheduler.enqueue({ revision: stroke });
      // Active contact duration
      t.mock.timers.tick(15);
      // Pen-up
      scheduler.setGestureActive(false);
      // User starts next stroke quickly (10ms pause < quietMs 30ms and debounceMs 60ms)
      if (stroke < 4) {
        t.mock.timers.tick(10);
      }
    }

    // Before quietMs elapses from final pen-up, save has not occurred yet
    assert.equal(saved.length, 0);

    // Now advance quietMs (30ms) to elapse after the 4th pen-up and save to flush
    t.mock.timers.tick(30);

    // The final authoritative revision must have flushed cleanly
    assert.equal(saved.length, 1);
    assert.equal(saved[0].revision, 4);
    assert.equal(scheduler.peek(), null);
  } finally {
    t.mock.timers.reset();
  }
});

test('sustained handwriting exceeding maxDeferralMs triggers immediate checkpoint persistence on the next pen-up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const saved: Array<{ revision: number; savedAt: number }> = [];
  const scheduledDelays: number[] = [];
  const scheduler = new DrawingSaveScheduler<{ revision: number; savedAt?: number }>(
    snapshot => saved.push({ revision: snapshot.revision, savedAt: Date.now() }),
    {
      debounceMs: 50,
      quietMs: 40,
      maxDeferralMs: 70, // 70ms maximum deferral
      onEvent: event => {
        if (event.type === 'saveScheduled') scheduledDelays.push(event.delayMs);
      },
    },
  );

  try {
    // Verify DEFAULT_MAX_DEFERRAL_MS constant contract
    assert.equal(DEFAULT_MAX_DEFERRAL_MS, 10_000);

    // Pen goes down for sustained handwriting
    scheduler.setGestureActive(true);
    scheduler.enqueue({ revision: 1 });

    // Keep pen down continuously past maxDeferralMs (70ms)
    t.mock.timers.tick(90);

    // Because gesture remained active, no saves must have occurred during contact
    assert.equal(saved.length, 0);

    // Add another stroke snapshot while still active
    scheduler.enqueue({ revision: 2 });

    // Pen up!
    scheduler.setGestureActive(false);

    // Because deferral exceeded maxDeferralMs, checkpoint was marked and delay scheduled as 0ms
    assert.ok(scheduledDelays.includes(0), 'Expected a 0ms scheduled delay on checkpoint pen-up');

    // Allow checkpoint flush to settle
    t.mock.timers.tick(0);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].revision, 2);
    assert.equal(scheduler.peek(), null);

    // Verify that after flushing the checkpoint, state is cleanly reset:
    // Next stroke returns to normal quietMs delay, not stuck in 0ms checkpoint mode
    scheduledDelays.length = 0;
    scheduler.setGestureActive(true);
    scheduler.enqueue({ revision: 3 });
    scheduler.setGestureActive(false);
    assert.equal(scheduledDelays[scheduledDelays.length - 1], 40, 'Resets to quietMs after checkpoint flushes');
    t.mock.timers.tick(40);
    assert.equal(saved.length, 2);
    assert.equal(saved[1].revision, 3);
  } finally {
    t.mock.timers.reset();
  }
});

test('in-memory revision monotonicity: stale persistence completions and retries are rejected', async () => {
  const first = pageSnapshot(1, 'page-monotonic', 1);
  const second = pageSnapshot(2, 'page-monotonic', 2);
  const third = pageSnapshot(3, 'page-monotonic', 3);

  const firstDeferred = deferred<DrawingData>();
  const secondDeferred = deferred<DrawingData>();
  const thirdDeferred = deferred<DrawingData>();

  const statuses: Array<[number, string]> = [];
  const completions: Array<{ sequence: number; latestScheduled: boolean; latestPersisted: boolean }> = [];

  const queue = new DrawingPersistenceQueue(() => ({
    resolveTarget: () => TARGET,
    encode: current => `json-${current.sequence}`,
    save: (_target, _data, current) => {
      if (current.sequence === 1) return firstDeferred.promise;
      if (current.sequence === 2) return secondDeferred.promise;
      return thirdDeferred.promise;
    },
    onStatus: (current, status) => statuses.push([current.sequence, status]),
    onSaved: (current, _data, completion) => completions.push({ sequence: current.sequence, ...completion }),
  }), [10]);

  try {
    // Dispatch revisions 1, 2, 3 in succession
    assert.equal(queue.persist(first), 'scheduled');
    assert.equal(queue.persist(second), 'scheduled');
    assert.equal(queue.persist(third), 'scheduled');

    // Third (newest) write resolves first
    thirdDeferred.resolve(third.data);
    await delay(5);

    assert.equal(queue.getScheduledSequence('page-monotonic'), 3);
    assert.deepEqual(completions, [{ sequence: 3, latestScheduled: true, latestPersisted: true }]);

    // Older write 1 now resolves late
    firstDeferred.resolve(first.data);
    await delay(5);

    // Write 1 must NOT be marked latestPersisted, latestScheduled, or flash saved status
    const firstCompletion = completions.find(c => c.sequence === 1);
    assert.ok(firstCompletion);
    assert.equal(firstCompletion.latestPersisted, false);
    assert.equal(firstCompletion.latestScheduled, false);

    // Older write 2 now rejects late (e.g. timeout / network abort)
    secondDeferred.reject(new Error('stale network error'));
    await delay(5);

    // Stale error must be discarded: must NOT mark page-monotonic as failed
    assert.equal(queue.hasFailed('page-monotonic'), false);

    // An attempt to re-persist an older snapshot must be rejected immediately as superseded/already-persisted
    const staleSnapshot = pageSnapshot(2, 'page-monotonic', 2);
    assert.equal(queue.persist(staleSnapshot), 'already-persisted');

    // Final status verification: newest write remains the sole authoritative status
    const lastStatus = statuses.filter(s => s[0] === 3).pop();
    assert.deepEqual(lastStatus, [3, 'saved']);
  } finally {
    queue.cancelRetries();
  }
});

test('rapid burst persistence: 50 concurrent stroke mutations resolve in-order to the newest snapshot without data loss', async () => {
  const burstCount = 50;
  const pageId = 'page-burst';
  const savedSnapshots: PageOwnedDrawing[] = [];

  const queue = new DrawingPersistenceQueue(() => ({
    resolveTarget: () => TARGET,
    encode: current => `json-${current.sequence}`,
    save: async (_target, data, current) => {
      // Introduce random async latency (1ms to 15ms) to scramble completion order
      const randomLatency = Math.floor(Math.random() * 15) + 1;
      await delay(randomLatency);
      savedSnapshots.push(current);
      return data;
    },
  }), []);

  try {
    // Generate 50 rapid sequential stroke snapshots
    const snapshots: PageOwnedDrawing[] = [];
    for (let i = 1; i <= burstCount; i++) {
      const drawing = createEmptyDrawingData();
      for (let s = 1; s <= i; s++) {
        drawing.objects.push({
          id: `stroke-${s}`,
          type: 'stroke',
          tool: 'pen',
          points: [{ x: s, y: s, pressure: 0.5, t: s }],
          color: '#000000',
          thickness: 2,
          opacity: 1,
          createdAt: s,
        });
      }
      snapshots.push({
        documentId: TARGET.notebookId,
        sheetId: pageId,
        renderedSheetId: pageId,
        sceneOwnerSheetId: pageId,
        saveTargetSheetId: pageId,
        drawingRevision: i,
        sequence: i,
        data: drawing,
      });
    }

    // Rapid-fire persist all 50 snapshots
    for (const snap of snapshots) {
      const res = queue.persist(snap);
      assert.ok(res === 'scheduled' || res === 'already-scheduled');
    }

    // Wait for all async writes to settle
    await delay(120);

    // Queue must not have failed
    assert.equal(queue.hasFailed(pageId), false);

    // The scheduled sequence must be exactly the final snapshot (50)
    assert.equal(queue.getScheduledSequence(pageId), burstCount);

    // Re-persisting the final snapshot must report already-persisted
    const finalRes = queue.persist(snapshots[burstCount - 1]);
    assert.equal(finalRes, 'already-persisted');

    // Attempting to persist any earlier snapshot (e.g. 1, 25, 49) must be rejected
    for (const seq of [1, 10, 25, 40, 49]) {
      const staleRes = queue.persist(snapshots[seq - 1]);
      assert.equal(staleRes, 'already-persisted');
    }
  } finally {
    queue.cancelRetries();
  }
});

test('end-to-end integration: DrawingSaveScheduler chained with DrawingPersistenceQueue preserves live strokes across rapid writing and liftoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const pageId = 'page-e2e-handwriting';
  let persistedDrawing: DrawingData | null = null;
  const persistedSequences: number[] = [];

  const queue = new DrawingPersistenceQueue(() => ({
    resolveTarget: () => TARGET,
    encode: current => JSON.stringify(current.data),
    save: async (_target, data, current) => {
      persistedDrawing = data;
      persistedSequences.push(current.sequence);
      return data;
    },
  }), []);

  const scheduler = new DrawingSaveScheduler<PageOwnedDrawing>(
    snapshot => {
      queue.persist(snapshot);
    },
    { debounceMs: 40, quietMs: 20, maxDeferralMs: 100 },
  );

  try {
    const drawing = createEmptyDrawingData();

    // Stroke 1
    scheduler.setGestureActive(true);
    drawing.objects.push({
      id: 'stroke-1',
      type: 'stroke',
      tool: 'pen',
      points: [{ x: 10, y: 10, pressure: 0.5, t: 10 }],
      color: '#000',
      thickness: 2,
      opacity: 1,
      createdAt: 10,
    });
    scheduler.enqueue({
      documentId: TARGET.notebookId,
      sheetId: pageId,
      renderedSheetId: pageId,
      sceneOwnerSheetId: pageId,
      saveTargetSheetId: pageId,
      drawingRevision: 1,
      sequence: 1,
      data: structuredClone(drawing),
    });
    t.mock.timers.tick(10);
    scheduler.setGestureActive(false); // Pen up

    // Short pause (10ms < quietMs 20ms) - user starts Stroke 2 before quietMs fires
    t.mock.timers.tick(10);
    scheduler.setGestureActive(true);
    drawing.objects.push({
      id: 'stroke-2',
      type: 'stroke',
      tool: 'pen',
      points: [{ x: 20, y: 20, pressure: 0.5, t: 20 }],
      color: '#000',
      thickness: 2,
      opacity: 1,
      createdAt: 20,
    });
    scheduler.enqueue({
      documentId: TARGET.notebookId,
      sheetId: pageId,
      renderedSheetId: pageId,
      sceneOwnerSheetId: pageId,
      saveTargetSheetId: pageId,
      drawingRevision: 2,
      sequence: 2,
      data: structuredClone(drawing),
    });
    t.mock.timers.tick(10);
    scheduler.setGestureActive(false); // Pen up

    // Allow quiet window to elapse (20ms) and save to persist
    t.mock.timers.tick(20);
    await Promise.resolve();

    assert.ok(persistedDrawing !== null);
    assert.equal(persistedDrawing.objects.length, 2);
    assert.deepEqual(persistedSequences, [2]);

    // Stroke 3 with prolonged contact exceeding maxDeferralMs (100ms)
    scheduler.setGestureActive(true);
    drawing.objects.push({
      id: 'stroke-3',
      type: 'stroke',
      tool: 'pen',
      points: [{ x: 30, y: 30, pressure: 0.5, t: 30 }],
      color: '#000',
      thickness: 2,
      opacity: 1,
      createdAt: 30,
    });
    scheduler.enqueue({
      documentId: TARGET.notebookId,
      sheetId: pageId,
      renderedSheetId: pageId,
      sceneOwnerSheetId: pageId,
      saveTargetSheetId: pageId,
      drawingRevision: 3,
      sequence: 3,
      data: structuredClone(drawing),
    });

    // Hold pen down for 120ms (> maxDeferralMs 100ms)
    t.mock.timers.tick(120);
    assert.equal(persistedSequences.length, 1, 'No save during active contact even past maxDeferralMs');

    // Pen up: checkpoint must flush immediately (0ms delay)
    scheduler.setGestureActive(false);
    t.mock.timers.tick(0);
    await Promise.resolve();

    assert.equal(persistedSequences.length, 2);
    assert.equal(persistedSequences[1], 3);
    assert.equal(persistedDrawing.objects.length, 3);
  } finally {
    queue.cancelRetries();
    t.mock.timers.reset();
  }
});

