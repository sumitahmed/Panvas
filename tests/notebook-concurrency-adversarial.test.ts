import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DrawingPersistenceQueue,
  type DrawingSaveTarget,
  type DrawingPersistenceCallbacks,
  cancelQueuedPageDrawing,
} from '../src/components/notebook/drawingPersistenceQueue.ts';
import type { PageOwnedDrawing } from '../src/components/notebook/notebookPageRenderState.ts';
import { createEmptyDrawingData, type Stroke } from '../src/components/notebook/engine/drawingTypes.ts';
import { computeSectionRenumbering, type PageForRenumbering } from '../src/lib/notebookPageRenumbering.ts';
import type { NotebookPage } from '../src/types/notebook.ts';

function createSnapshot(pageId: string, sequence: number, revision = sequence): PageOwnedDrawing {
  return {
    documentId: 'nb-stress-1',
    sheetId: pageId,
    renderedSheetId: pageId,
    sceneOwnerSheetId: pageId,
    saveTargetSheetId: pageId,
    drawingRevision: revision,
    sequence,
    data: createEmptyDrawingData(),
  };
}

test('Adversarial 1: In-Flight Stylus Stroke Protection Barrier with Rapid Switching and Self-Activation', () => {
  let isDrawingGestureActive = true;
  let unmountCount = 0;
  let mountCount = 0;
  const committedPoints: Array<{ x: number; y: number }> = [];
  let pendingActivationPageId: string | null = null;
  let activePageId = 'page-1';
  let focusedPageId = 'page-1';

  const engine = {
    unmount: () => {
      unmountCount++;
    },
    mount: (pageId: string) => {
      mountCount++;
      focusedPageId = pageId;
    },
    addStrokePoint: (x: number, y: number) => {
      committedPoints.push({ x, y });
    },
    getOwnership: () => ({ pageId: focusedPageId }),
  };

  // The NotebookRenderer activation barrier logic:
  const handleActivatePage = (targetPageId: string) => {
    if (targetPageId === focusedPageId && engine.getOwnership().pageId === targetPageId) {
      return; // Safe no-op when activating current active page
    }
    engine.unmount();
    engine.mount(targetPageId);
    activePageId = targetPageId;
  };

  const requestPageActivation = (targetPageId: string) => {
    if (isDrawingGestureActive) {
      pendingActivationPageId = targetPageId;
      return;
    }
    handleActivatePage(targetPageId);
  };

  // Step 1: User puts stylus down on page-1
  engine.addStrokePoint(10, 10);
  engine.addStrokePoint(15, 12);
  assert.equal(committedPoints.length, 2);
  assert.equal(unmountCount, 0, 'Must not unmount at stroke start');

  // Step 2: Rapid activation requests arrive while stylus is still touching the digitizer
  requestPageActivation('page-2');
  requestPageActivation('page-3');
  requestPageActivation('page-4');

  // Verify that engine is NEVER unmounted during the in-flight stroke
  assert.equal(unmountCount, 0, 'Engine must NOT be unmounted during in-flight drawing');
  assert.equal(pendingActivationPageId, 'page-4', 'Last pending target must be preserved');
  assert.equal(activePageId, 'page-1', 'Active page must stay on page-1 during stroke');

  // Step 3: Additional stroke points arrive during the pending activation interval
  engine.addStrokePoint(20, 18);
  engine.addStrokePoint(30, 25);
  assert.equal(committedPoints.length, 4);

  // Step 4: Stylus lifts off the screen (penUp / gesture completes)
  isDrawingGestureActive = false;
  if (pendingActivationPageId) {
    const deferredTarget = pendingActivationPageId;
    pendingActivationPageId = null;
    handleActivatePage(deferredTarget);
  }

  // Verify safe deferred activation to target page-4
  assert.equal(unmountCount, 1, 'Engine unmounted exactly once after pen lift');
  assert.equal(mountCount, 1, 'Engine mounted target page');
  assert.equal(activePageId, 'page-4');
  assert.equal(committedPoints.length, 4, 'All 4 points preserved intact');

  // Step 5: Edge case — User starts drawing on page-4 and activation requests page-4 again (self-activation)
  isDrawingGestureActive = true;
  engine.addStrokePoint(50, 50);
  requestPageActivation('page-4'); // Re-activating currently active page
  isDrawingGestureActive = false;

  if (pendingActivationPageId) {
    const deferredTarget = pendingActivationPageId;
    pendingActivationPageId = null;
    handleActivatePage(deferredTarget);
  }

  // Self-activation must not trigger a redundant unmount
  assert.equal(unmountCount, 1, 'Self-activation must not unmount');
  assert.equal(activePageId, 'page-4');
});

test('Adversarial 2: Persistence Queue Stale Cleanup, Retry Cancellation & Concurrency Resilience', async () => {
  const targetMap = new Map<string, DrawingSaveTarget | 'stale' | null>([
    ['page-alpha', null], // Temporarily unavailable
    ['page-beta', { workspaceId: 'ws-1', notebookId: 'nb-1' }],
  ]);

  const savedPages: string[] = [];
  const statusLog: Array<{ pageId: string; status: string }> = [];

  const callbacks: DrawingPersistenceCallbacks = {
    resolveTarget: (snapshot) => targetMap.get(snapshot.saveTargetSheetId) ?? null,
    encode: (snapshot) => JSON.stringify(snapshot.data),
    save: async (target, data, snapshot) => {
      savedPages.push(snapshot.saveTargetSheetId);
      return data;
    },
    onStatus: (snapshot, status) => {
      statusLog.push({ pageId: snapshot.saveTargetSheetId, status });
    },
  };

  const queue = new DrawingPersistenceQueue(() => callbacks, [10, 20, 40]);

  // 1. Enqueue save for page-alpha when target is unavailable
  const snapAlpha = createSnapshot('page-alpha', 1);
  const resAlpha = queue.persist(snapAlpha);
  assert.equal(resAlpha, 'target-unavailable');
  assert.equal(queue.hasFailed('page-alpha'), true, 'Unavailable target must enter failed retry queue');

  // 2. Enqueue save for page-beta (valid target)
  const snapBeta = createSnapshot('page-beta', 1);
  const resBeta = queue.persist(snapBeta);
  assert.equal(resBeta, 'scheduled');

  // 3. User deletes page-alpha while its retry timer is ticking
  targetMap.set('page-alpha', 'stale');
  cancelQueuedPageDrawing('page-alpha');

  // Verify that cancelQueuedPageDrawing cleared failed state immediately
  assert.equal(queue.hasFailed('page-alpha'), false, 'cancelQueuedPageDrawing must purge failed state');

  // 4. If a stale snapshot attempts persistence, verify it returns 'stale-target' and does NOT fail or retry
  const snapAlphaStale = createSnapshot('page-alpha', 2);
  const resAlphaStale = queue.persist(snapAlphaStale);
  assert.equal(resAlphaStale, 'stale-target');
  assert.equal(queue.hasFailed('page-alpha'), false, 'Stale target must not be marked failed');

  // 5. Force lifecycle flushFailed: page-alpha must NOT be retried
  queue.flushFailed();
  assert.equal(queue.hasFailed('page-alpha'), false);

  // Wait for page-beta microtasks
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(savedPages.includes('page-beta'), 'Concurrent page-beta save must succeed');
  assert.ok(!savedPages.includes('page-alpha'), 'Deleted page-alpha must NEVER be saved');

  queue.cancelRetries();
});

test('Adversarial 3: Sync Serialization & Renumbering Idempotence Under Churn', () => {
  // Construct a realistic section with 10 pages
  const pages: PageForRenumbering[] = [
    { id: 'p-1', title: 'Page 1', order: 0, titleProvenance: 'default', deletedAt: null },
    { id: 'p-2', title: 'Page 2', order: 1, titleProvenance: 'default', deletedAt: null },
    { id: 'p-3', title: 'Custom Chapter 1', order: 2, titleProvenance: 'custom', deletedAt: null },
    { id: 'p-4', title: 'Page 4', order: 3, titleProvenance: 'default', deletedAt: null },
    { id: 'p-5', title: 'Page 5', order: 4, titleProvenance: 'default', deletedAt: null },
    { id: 'p-6', title: 'Page 6', order: 5, titleProvenance: 'default', deletedAt: null },
    { id: 'p-7', title: 'Page 7', order: 6, titleProvenance: 'custom', deletedAt: null }, // Custom page named "Page 7"!
    { id: 'p-8', title: 'Page 8', order: 7, titleProvenance: 'default', deletedAt: null },
    { id: 'p-9', title: 'Page 9', order: 8, titleProvenance: 'default', deletedAt: null },
    { id: 'p-10', title: 'Legacy Notes', order: 9, titleProvenance: undefined, deletedAt: null }, // Legacy page without provenance!
  ];

  // Rapid deletion of p-2 and p-5
  const remainingPages = pages.filter(p => p.id !== 'p-2' && p.id !== 'p-5');
  remainingPages.forEach((p, index) => {
    p.order = index;
  });

  // Remaining active list:
  // index 0 (order 0): p-1, 'Page 1' (default) -> matches expected 'Page 1'
  // index 1 (order 1): p-3, 'Custom Chapter 1' (custom) -> preserved
  // index 2 (order 2): p-4, 'Page 4' (default) -> expected 'Page 3' (needs update)
  // index 3 (order 3): p-6, 'Page 6' (default) -> expected 'Page 4' (needs update)
  // index 4 (order 4): p-7, 'Page 7' (custom) -> custom, so preserved! Must NOT be renamed!
  // index 5 (order 5): p-8, 'Page 8' (default) -> expected 'Page 6' (needs update)
  // index 6 (order 6): p-9, 'Page 9' (default) -> expected 'Page 7' (needs update)
  // index 7 (order 7): p-10, 'Legacy Notes' (undefined) -> treated as custom, preserved!

  const updates = computeSectionRenumbering(remainingPages);

  // Assert expected updates
  assert.equal(updates.length, 4, 'Exactly 4 default pages should need renumbering');

  assert.deepEqual(updates, [
    { id: 'p-4', title: 'Page 3', titleProvenance: 'default' },
    { id: 'p-6', title: 'Page 4', titleProvenance: 'default' },
    { id: 'p-8', title: 'Page 6', titleProvenance: 'default' },
    { id: 'p-9', title: 'Page 7', titleProvenance: 'default' },
  ]);

  // Apply updates to simulate state update
  for (const update of updates) {
    const p = remainingPages.find(item => item.id === update.id);
    if (p) p.title = update.title;
  }

  // Verify IDEMPOTENCE: Running renumbering a second time must produce 0 updates
  const secondPassUpdates = computeSectionRenumbering(remainingPages);
  assert.equal(secondPassUpdates.length, 0, 'Renumbering must be strictly idempotent with zero cyclic updates');

  // Verify that custom and legacy titles were preserved with 100% fidelity
  assert.equal(remainingPages.find(p => p.id === 'p-3')?.title, 'Custom Chapter 1');
  assert.equal(remainingPages.find(p => p.id === 'p-7')?.title, 'Page 7');
  assert.equal(remainingPages.find(p => p.id === 'p-10')?.title, 'Legacy Notes');
});

test('Adversarial 4: Monotonic Persistence Sequence and Out-of-Order Rejection', async () => {
  const target: DrawingSaveTarget = { workspaceId: 'ws-1', notebookId: 'nb-1' };
  const persistenceHistory: Array<{ sequence: number; revision: number }> = [];

  const callbacks: DrawingPersistenceCallbacks = {
    resolveTarget: () => target,
    encode: (snapshot) => JSON.stringify(snapshot.data),
    save: async (_target, _data, snapshot) => {
      persistenceHistory.push({ sequence: snapshot.sequence, revision: snapshot.drawingRevision });
      return snapshot.data;
    },
  };

  const queue = new DrawingPersistenceQueue(() => callbacks);

  // Generate sequence 1, 2, 3
  const snap1 = createSnapshot('page-seq', 1, 1);
  const snap2 = createSnapshot('page-seq', 2, 2);
  const snap3 = createSnapshot('page-seq', 3, 3);

  // Queue snapshot 2 first, then attempt to queue an older snapshot 1
  queue.persist(snap2);
  const resStale = queue.persist(snap1);

  assert.equal(resStale, 'superseded', 'Older sequence must be rejected as superseded');

  // Queue newer snapshot 3
  const resNewer = queue.persist(snap3);
  assert.equal(resNewer, 'scheduled', 'Newer sequence must be accepted');

  await new Promise(resolve => setTimeout(resolve, 30));

  // Verify that sequence 1 was NEVER persisted
  assert.ok(!persistenceHistory.some(h => h.sequence === 1));
  assert.ok(persistenceHistory.some(h => h.sequence === 2));
  assert.ok(persistenceHistory.some(h => h.sequence === 3));
});
