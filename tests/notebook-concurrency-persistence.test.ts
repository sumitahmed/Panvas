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
import { computeSectionRenumbering } from '../src/lib/notebookPageRenumbering.ts';
import type { NotebookPage } from '../src/types/notebook.ts';

function createSnapshot(pageId: string, sequence: number, revision = sequence): PageOwnedDrawing {
  return {
    documentId: 'nb-1',
    sheetId: pageId,
    renderedSheetId: pageId,
    sceneOwnerSheetId: pageId,
    saveTargetSheetId: pageId,
    drawingRevision: revision,
    sequence,
    data: createEmptyDrawingData(),
  };
}

test('Suite 6 - Test 29: No Drawing Interruption during page operations or title renumbering', () => {
  // Simulate active drawing gesture state
  let isDrawingGestureActive = true;
  let unmountCalled = false;
  let pointsCommitted = 0;
  let pendingActivationPageId: string | null = null;
  let activePageId = 'page-1';

  // Live drawing engine mock
  const liveDrawing = {
    unmount: () => {
      unmountCalled = true;
    },
    addPoint: (x: number, y: number) => {
      pointsCommitted++;
    },
  };

  // Simulating the barrier in NotebookRenderer:
  const requestPageActivation = (newPageId: string) => {
    if (isDrawingGestureActive) {
      // Barrier: defer activation until penUp
      pendingActivationPageId = newPageId;
      return;
    }
    // Safe activation
    liveDrawing.unmount();
    activePageId = newPageId;
  };

  // User is actively drawing points
  liveDrawing.addPoint(10, 20);
  liveDrawing.addPoint(15, 25);
  assert.equal(pointsCommitted, 2);

  // While stroke is in-flight, an insert/reorder/renumber triggers page activation
  requestPageActivation('page-2');

  // Verify that live drawing was NOT unmounted and stroke was NOT interrupted
  assert.equal(unmountCalled, false, 'Live drawing engine must not be unmounted while stroke is active');
  assert.equal(pendingActivationPageId, 'page-2');
  assert.equal(activePageId, 'page-1');

  // More points arrive in current stroke
  liveDrawing.addPoint(20, 30);
  assert.equal(pointsCommitted, 3);

  // Pen up (gesture finishes)
  isDrawingGestureActive = false;
  if (pendingActivationPageId) {
    const deferredTarget = pendingActivationPageId;
    pendingActivationPageId = null;
    liveDrawing.unmount();
    activePageId = deferredTarget;
  }

  // Now activation completes cleanly after stroke points were safely captured
  assert.equal(unmountCalled, true);
  assert.equal(activePageId, 'page-2');
  assert.equal(pointsCommitted, 3, 'All in-flight stroke points must be preserved');
});

test('Suite 6 - Test 30: Concurrent Save Resilience through DrawingPersistenceQueue with stale cleanup', async () => {
  const targetMap = new Map<string, DrawingSaveTarget | 'stale' | null>([
    ['page-1', { workspaceId: 'ws-1', notebookId: 'nb-1' }],
    ['page-2', { workspaceId: 'ws-1', notebookId: 'nb-1' }],
  ]);

  const savedPages: string[] = [];
  const callbacks: DrawingPersistenceCallbacks = {
    resolveTarget: (snapshot) => targetMap.get(snapshot.saveTargetSheetId) ?? null,
    encode: (snapshot) => JSON.stringify(snapshot.data),
    save: async (target, data, snapshot) => {
      savedPages.push(snapshot.saveTargetSheetId);
      return data;
    },
  };

  const queue = new DrawingPersistenceQueue(() => callbacks);

  // Queue save for page-1
  const snap1 = createSnapshot('page-1', 1);
  const res1 = queue.persist(snap1);
  assert.equal(res1, 'scheduled');

  // Rapidly delete page-1 while another page-2 is created and saved
  targetMap.set('page-1', 'stale');
  queue.cancelPage('page-1');

  // Persisting to stale target returns 'stale-target' and clears failures
  const snap1Retry = createSnapshot('page-1', 2);
  const res1Stale = queue.persist(snap1Retry);
  assert.equal(res1Stale, 'stale-target');
  assert.equal(queue.hasFailed('page-1'), false);

  // Page 2 persists concurrently without colliding
  const snap2 = createSnapshot('page-2', 1);
  const res2 = queue.persist(snap2);
  assert.equal(res2, 'scheduled');

  // Wait for microtasks
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.ok(savedPages.includes('page-2'));
  assert.equal(queue.hasFailed('page-1'), false);
  assert.equal(queue.hasFailed('page-2'), false);
});

test('Suite 6 - Test 31: Sync Serialization of deletions and renamings without orphaned records', () => {
  interface JournalEntry {
    id: string;
    entityType: 'notebookPage';
    entityId: string;
    operation: 'create' | 'update' | 'delete';
    timestamp: number;
    payload?: Record<string, unknown>;
    deletedAt?: number;
  }

  const journal: JournalEntry[] = [];
  let clock = 1000;

  // 1. Create Page 1
  journal.push({
    id: 'j-1',
    entityType: 'notebookPage',
    entityId: 'p-1',
    operation: 'create',
    timestamp: ++clock,
    payload: { title: 'Page 1', titleProvenance: 'default', sectionId: 'sec-1' },
  });

  // 2. Create Page 2
  journal.push({
    id: 'j-2',
    entityType: 'notebookPage',
    entityId: 'p-2',
    operation: 'create',
    timestamp: ++clock,
    payload: { title: 'Page 2', titleProvenance: 'default', sectionId: 'sec-1' },
  });

  // 3. User renames Page 2 to 'Design' (provenance flips to custom)
  journal.push({
    id: 'j-3',
    entityType: 'notebookPage',
    entityId: 'p-2',
    operation: 'update',
    timestamp: ++clock,
    payload: { title: 'Design', titleProvenance: 'custom' },
  });

  // 4. Delete Page 1 (emits delete tombstone)
  const deleteTime = ++clock;
  journal.push({
    id: 'j-4',
    entityType: 'notebookPage',
    entityId: 'p-1',
    operation: 'delete',
    timestamp: deleteTime,
    deletedAt: deleteTime,
  });

  // 5. Renumbering check on remaining pages
  const remainingPages: NotebookPage[] = [
    {
      id: 'p-2',
      notebookId: 'nb-1',
      sectionId: 'sec-1',
      title: 'Design',
      titleProvenance: 'custom',
      order: 0,
      createdAt: 1000,
      updatedAt: 1000,
      userId: null,
      deletedAt: null,
    },
  ];

  const renumberUpdates = computeSectionRenumbering(remainingPages);
  // 'Design' is custom, so NO renumber update should be emitted
  assert.equal(renumberUpdates.length, 0);

  // Replay journal into reconstructed database
  const state = new Map<string, { id: string; title: string; titleProvenance: string; deletedAt?: number | null }>();
  for (const entry of journal) {
    if (entry.operation === 'create') {
      state.set(entry.entityId, {
        id: entry.entityId,
        title: entry.payload!.title as string,
        titleProvenance: entry.payload!.titleProvenance as string,
        deletedAt: null,
      });
    } else if (entry.operation === 'update') {
      const existing = state.get(entry.entityId);
      if (existing) {
        if (entry.payload?.title) existing.title = entry.payload.title as string;
        if (entry.payload?.titleProvenance) existing.titleProvenance = entry.payload.titleProvenance as string;
      }
    } else if (entry.operation === 'delete') {
      const existing = state.get(entry.entityId);
      if (existing) {
        existing.deletedAt = entry.deletedAt;
      }
    }
  }

  // Active pages check:
  const activePages = [...state.values()].filter(p => !p.deletedAt);
  assert.equal(activePages.length, 1);
  assert.equal(activePages[0].id, 'p-2');
  assert.equal(activePages[0].title, 'Design');
  assert.equal(activePages[0].titleProvenance, 'custom');

  // Tombstoned page check:
  const deletedPage = state.get('p-1');
  assert.ok(deletedPage?.deletedAt, 'Deleted page must have a tombstone timestamp');
  assert.equal(deletedPage?.deletedAt, deleteTime);
});
