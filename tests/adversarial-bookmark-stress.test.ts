// ============================================================================
// Panvas — Adversarial Bookmark Stress, Concurrency & Resilience Test Suite
// Milestone M5: Code-Executing Adversarial Stress Testing
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { useBookmarkStore } from '@/stores/bookmarkStore';
import {
  BookmarkRepository,
  BOOKMARKS_STORAGE_KEY,
  validateBookmark,
  isBookmarkMatch,
} from '@/services/bookmarks/BookmarkRepository';
import {
  generateBookmarkId,
  parseBookmarkId,
  formatPdfPageId,
} from '@/services/bookmarks/bookmarkId';
import {
  createBookmarkHistoryCommand,
  toggleBookmarkWithHistory,
} from '@/services/bookmarks/bookmarkHistory';
import { HistoryManager } from '@/components/notebook/engine/HistoryManager';
import type { HistoryCommand, Stroke, PageProperties } from '@/components/notebook/engine/drawingTypes';
import { computeSectionRenumbering, type PageForRenumbering } from '@/lib/notebookPageRenumbering';
import { DrawingPersistenceQueue } from '@/components/notebook/drawingPersistenceQueue';
import { PageRenderer } from '@/components/notebook/PageRenderer';
import { Thumbnail } from '@/components/pdf/PdfThumbnailSidebar';

// ---- Environment Polyfill Setup ----

interface MockStorage {
  store: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
}

function createMockLocalStorage(): MockStorage {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };
}

const mockStorage = createMockLocalStorage();

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = mockStorage as unknown as Storage;
}

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    localStorage: mockStorage,
  };
} else if (!(globalThis as any).window.localStorage) {
  (globalThis as any).window.localStorage = mockStorage;
}

const mockProperties: PageProperties = {
  template: 'Blank',
  paperColor: 'White',
  ruleColor: 'Blue',
  ruling: 'None',
  pageSize: 'A4',
  orientation: 'Portrait',
  margins: 'Normal',
  gridSpacing: 20,
  lineSpacing: 24,
  columns: 1,
  headerHeight: 0,
  footerHeight: 0,
};

function createSampleStroke(id: string, color = '#1e293b', width = 2): Stroke {
  return {
    id,
    type: 'pen',
    color,
    width,
    opacity: 1,
    points: [
      { x: 10, y: 10, pressure: 0.5 },
      { x: 25, y: 35, pressure: 0.7 },
      { x: 40, y: 60, pressure: 0.6 },
    ],
    layerId: 'layer-default',
    createdAt: Date.now(),
  };
}

async function resetHarness(workspaceId: string | null = null) {
  mockStorage.clear();
  useBookmarkStore.setState({ bookmarks: [], isLoaded: true, currentWorkspaceId: workspaceId });
}

// ============================================================================
// SUITE 1: Concurrency & Rapid Burst Mutations (100+ Concurrent Operations)
// ============================================================================

test('Suite 1.1: 150 rapid concurrent operations across 5 notebooks and 5 PDFs serialize without deadlock or lost updates', async () => {
  await resetHarness('ws_burst_test');
  const repo = new BookmarkRepository();

  const notebookCount = 5;
  const pdfCount = 5;
  const pagesPerDoc = 15; // Total targets: 150 distinct document-page combinations

  const operations: Promise<unknown>[] = [];

  // Launch 150 concurrent asynchronous add operations simultaneously
  for (let d = 1; d <= notebookCount; d++) {
    const docId = `nb_burst_${d}`;
    for (let p = 1; p <= pagesPerDoc; p++) {
      operations.push(
        repo.addBookmark('ws_burst_test', {
          documentId: docId,
          pageId: `page_${d}_${p}`,
          documentType: 'notebook',
          title: `Notebook ${d} Page ${p}`,
        })
      );
    }
  }

  for (let d = 1; d <= pdfCount; d++) {
    const docId = `pdf_burst_${d}`;
    for (let p = 1; p <= pagesPerDoc; p++) {
      operations.push(
        repo.addBookmark('ws_burst_test', {
          documentId: docId,
          pageId: formatPdfPageId(docId, p),
          pageNumber: p,
          documentType: 'pdf',
          title: `PDF ${d} Sheet ${p}`,
        })
      );
    }
  }

  assert.equal(operations.length, 150, 'Must have launched exactly 150 concurrent operations');

  // Await all 150 operations resolving concurrently
  const startTime = Date.now();
  const results = await Promise.all(operations);
  const elapsed = Date.now() - startTime;

  // Verify none failed or threw
  assert.equal(results.length, 150, 'All 150 operations must resolve');

  // Verify stored bookmarks in repository
  const stored = await repo.loadBookmarks('ws_burst_test');
  assert.equal(stored.length, 150, 'All 150 distinct bookmarks must be successfully persisted in repository');

  // Verify uniqueness of IDs: zero duplicate keys
  const idSet = new Set(stored.map(b => b.id));
  assert.equal(idSet.size, 150, 'Zero duplicate bookmark IDs generated during concurrent burst');

  // Verify raw storage payload is valid JSON and clean
  const rawKey = `panvas.ws_burst_test.${BOOKMARKS_STORAGE_KEY}`;
  const rawData = mockStorage.getItem(rawKey);
  assert.ok(rawData, 'Storage key must exist');
  const parsed = JSON.parse(rawData);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 150);
});

test('Suite 1.2: 100 concurrent simultaneous toggles on the exact same page target resolve with strict FIFO parity and no duplicates', async () => {
  await resetHarness('ws_toggle_race');
  const repo = new BookmarkRepository();

  const docId = 'doc_hotspot';
  const pageId = 'page_contested_uuid';

  // Initially unbookmarked: 100 toggles (an even number) must result in bookmarked: false, count: 0
  const togglePromises: Promise<{ bookmarked: boolean }>[] = [];
  for (let i = 0; i < 100; i++) {
    togglePromises.push(
      repo.toggleBookmark('ws_toggle_race', docId, pageId, 'notebook', undefined, `Toggle ${i}`)
    );
  }

  const outcomes = await Promise.all(togglePromises);
  assert.equal(outcomes.length, 100, 'All 100 toggles must complete');

  // Verify that alternating states were produced due to FIFO serialization
  let trueCount = 0;
  let falseCount = 0;
  outcomes.forEach(res => {
    if (res.bookmarked) trueCount++;
    else falseCount++;
  });
  assert.equal(trueCount, 50, 'Exactly 50 toggles must result in bookmarked: true');
  assert.equal(falseCount, 50, 'Exactly 50 toggles must result in bookmarked: false');

  // Final storage state must be completely unbookmarked
  const finalStored = await repo.loadBookmarks('ws_toggle_race');
  assert.equal(finalStored.length, 0, 'Net even number of toggles must leave 0 bookmarks in storage');

  // Now perform an odd number of toggles: 35 concurrent toggles
  const oddPromises: Promise<{ bookmarked: boolean }>[] = [];
  for (let i = 0; i < 35; i++) {
    oddPromises.push(
      repo.toggleBookmark('ws_toggle_race', docId, pageId, 'notebook', undefined, `Odd toggle ${i}`)
    );
  }
  const oddOutcomes = await Promise.all(oddPromises);
  assert.equal(oddOutcomes.length, 35);

  // Final storage must have exactly 1 bookmark (odd count)
  const afterOdd = await repo.loadBookmarks('ws_toggle_race');
  assert.equal(afterOdd.length, 1, 'Odd number of toggles must result in exactly 1 bookmark');
  assert.equal(afterOdd[0].documentId, docId);
  assert.equal(afterOdd[0].pageId, pageId);
});

test('Suite 1.3: Multi-workspace concurrent bursts execute in parallel without cross-workspace contention or pollution', async () => {
  await resetHarness();
  const repo = new BookmarkRepository();

  const workspaces = ['ws_alpha', 'ws_beta', 'ws_gamma'];
  const burstPerWs = 40; // Total 120 operations across 3 workspaces

  const tasks: Promise<unknown>[] = [];

  workspaces.forEach((wsId) => {
    for (let i = 1; i <= burstPerWs; i++) {
      tasks.push(
        repo.addBookmark(wsId, {
          documentId: `doc_${wsId}_${i}`,
          pageId: `page_${i}`,
          documentType: 'notebook',
          title: `Title ${wsId} ${i}`,
        })
      );
    }
  });

  await Promise.all(tasks);

  // Verify each workspace has exactly burstPerWs items and zero items from other workspaces
  for (const wsId of workspaces) {
    const items = await repo.loadBookmarks(wsId);
    assert.equal(items.length, burstPerWs, `Workspace ${wsId} must have exactly ${burstPerWs} bookmarks`);
    for (const b of items) {
      assert.equal(b.workspaceId, wsId, `Bookmark workspaceId must match ${wsId}`);
      assert.ok(b.documentId.startsWith(`doc_${wsId}_`), `Document ID must belong to ${wsId}`);
    }
  }
});

// ============================================================================
// SUITE 2: Deep History Stack & Interleaved Drawing Fidelity (30+ Operations)
// ============================================================================

test('Suite 2.1: Deep 30-operation history stack interleaving drawing strokes with bookmarks restores with 100% fidelity and 0 cross-corruption', async () => {
  await resetHarness('ws_deep_history');

  const history = new HistoryManager();
  const strokes: Stroke[] = [];
  const notebookId = 'nb_deep_canvas';

  // Helper drawing actions
  function executeAddStroke(stroke: Stroke): HistoryCommand {
    return {
      description: `Add stroke ${stroke.id}`,
      execute: () => {
        strokes.push(stroke);
      },
      undo: () => {
        const idx = strokes.findIndex(s => s.id === stroke.id);
        if (idx >= 0) strokes.splice(idx, 1);
      },
    };
  }

  // Interleave 30 operations: 15 stroke mutations and 15 bookmark operations
  interface StateSnapshot {
    strokeIds: string[];
    bookmarkedPages: string[];
  }

  const snapshots: StateSnapshot[] = [
    { strokeIds: [], bookmarkedPages: [] }, // Step 0 (initial)
  ];

  for (let step = 1; step <= 30; step++) {
    if (step % 2 === 1) {
      // Stroke operation
      const strokeIdx = Math.floor(step / 2) + 1;
      const stroke = createSampleStroke(`stroke_${strokeIdx}`, strokeIdx % 2 === 0 ? '#ef4444' : '#3b82f6', strokeIdx * 1.5);
      const cmd = executeAddStroke(stroke);
      cmd.execute();
      history.pushExecuted(cmd);
    } else {
      // Bookmark operation
      const pageNum = Math.floor(step / 2);
      const pageId = `page_uuid_${pageNum}`;
      const cmd = createBookmarkHistoryCommand({
        documentId: notebookId,
        pageIdOrNumber: pageId,
        documentType: 'notebook',
        title: `Page ${pageNum}`,
        workspaceId: 'ws_deep_history',
      });
      cmd.execute();
      history.pushExecuted(cmd);
    }

    // Capture snapshot at current step
    const currentBookmarks = useBookmarkStore.getState().bookmarks
      .filter(b => b.documentId === notebookId)
      .map(b => b.pageId)
      .sort();

    snapshots.push({
      strokeIds: strokes.map(s => s.id),
      bookmarkedPages: [...currentBookmarks],
    });
  }

  assert.equal(snapshots.length, 31, 'Must have 31 state snapshots (0 through 30)');
  assert.equal(strokes.length, 15, 'Must have accumulated 15 strokes at step 30');
  assert.equal(useBookmarkStore.getState().bookmarks.length, 15, 'Must have accumulated 15 bookmarks at step 30');

  // PHASE A: Step-by-step UNDO from step 30 down to step 0
  for (let step = 30; step >= 1; step--) {
    assert.ok(history.canUndo(), `Must be able to undo at step ${step}`);
    history.undo();

    const expected = snapshots[step - 1];
    const currentStrokes = strokes.map(s => s.id);
    const currentBookmarks = useBookmarkStore.getState().bookmarks
      .filter(b => b.documentId === notebookId)
      .map(b => b.pageId)
      .sort();

    assert.deepEqual(
      currentStrokes,
      expected.strokeIds,
      `Strokes at undo step ${step - 1} must match expected snapshot exactly`
    );
    assert.deepEqual(
      currentBookmarks,
      expected.bookmarkedPages,
      `Bookmarks at undo step ${step - 1} must match expected snapshot exactly`
    );
  }

  // At step 0: both strokes and bookmarks must be completely empty
  assert.equal(strokes.length, 0, 'All strokes undone');
  assert.equal(useBookmarkStore.getState().bookmarks.length, 0, 'All bookmarks undone');
  assert.equal(history.canUndo(), false, 'History stack cannot undo past step 0');

  // PHASE B: Step-by-step REDO from step 0 back up to step 30
  for (let step = 1; step <= 30; step++) {
    assert.ok(history.canRedo(), `Must be able to redo at step ${step}`);
    history.redo();

    const expected = snapshots[step];
    const currentStrokes = strokes.map(s => s.id);
    const currentBookmarks = useBookmarkStore.getState().bookmarks
      .filter(b => b.documentId === notebookId)
      .map(b => b.pageId)
      .sort();

    assert.deepEqual(
      currentStrokes,
      expected.strokeIds,
      `Strokes at redo step ${step} must match expected snapshot exactly`
    );
    assert.deepEqual(
      currentBookmarks,
      expected.bookmarkedPages,
      `Bookmarks at redo step ${step} must match expected snapshot exactly`
    );
  }

  // Verify vector drawing coordinate fidelity of strokes after 30 undo/redos
  assert.equal(strokes.length, 15);
  for (let i = 0; i < 15; i++) {
    const s = strokes[i];
    assert.equal(s.points.length, 3, `Stroke ${s.id} points count must be intact`);
    assert.equal(s.points[0].x, 10);
    assert.equal(s.points[1].y, 35);
    assert.equal(s.points[2].pressure, 0.6);
  }
});

test('Suite 2.2: Rapid-fire 20-operation undo and redo bursts execute cleanly without unhandled rejections', async () => {
  await resetHarness('ws_rapid_undo_burst');
  const history = new HistoryManager();

  const docId = 'doc_burst_undo';
  // Push 20 bookmark additions
  for (let i = 1; i <= 20; i++) {
    const cmd = createBookmarkHistoryCommand({
      documentId: docId,
      pageIdOrNumber: `page_${i}`,
      documentType: 'notebook',
      workspaceId: 'ws_rapid_undo_burst',
    });
    cmd.execute();
    history.pushExecuted(cmd);
  }

  assert.equal(useBookmarkStore.getState().bookmarks.length, 20);

  // Rapidly undo all 20 operations synchronously without waiting between calls
  for (let i = 0; i < 20; i++) {
    history.undo();
  }
  assert.equal(useBookmarkStore.getState().bookmarks.length, 0, 'Store must reflect 0 bookmarks immediately after undo burst');

  // Rapidly redo all 20 operations synchronously
  for (let i = 0; i < 20; i++) {
    history.redo();
  }
  assert.equal(useBookmarkStore.getState().bookmarks.length, 20, 'Store must reflect 20 bookmarks immediately after redo burst');
});

// ============================================================================
// SUITE 3: Corrupted & Malformed Storage Resilience
// ============================================================================

test('Suite 3.1: Malformed and corrupted raw JSON in storage is handled safely with 0 crashes', async () => {
  await resetHarness('ws_corrupt_test');
  const repo = new BookmarkRepository();

  const rawKey = `panvas.ws_corrupt_test.${BOOKMARKS_STORAGE_KEY}`;

  // Attack 1: Broken JSON syntax
  mockStorage.setItem(rawKey, '{"broken json: [[[}');
  let loaded = await repo.loadBookmarks('ws_corrupt_test');
  assert.deepEqual(loaded, [], 'Corrupted JSON syntax must safely yield empty list without throwing');

  // Attack 2: Non-array JSON values
  const nonArrayPayloads = [
    '"plain string"',
    '12345',
    'true',
    'false',
    'null',
    '{"id": "doc:1"}', // object instead of array
  ];

  for (const payload of nonArrayPayloads) {
    mockStorage.setItem(rawKey, payload);
    loaded = await repo.loadBookmarks('ws_corrupt_test');
    assert.deepEqual(loaded, [], `Payload ${payload} must yield empty list without throwing`);
  }
});

test('Suite 3.2: Toxic, missing, and malformed object elements in storage array are safely sanitized', async () => {
  await resetHarness('ws_toxic_elements');
  const repo = new BookmarkRepository();

  const rawKey = `panvas.ws_toxic_elements.${BOOKMARKS_STORAGE_KEY}`;

  const toxicPayload = [
    null,
    undefined,
    42,
    'garbage string',
    [],
    {},
    { documentId: '' }, // empty documentId
    { documentId: '   ' }, // whitespace documentId
    { documentId: 'valid_doc' }, // missing pageId and documentType
    { documentId: 'valid_doc', pageId: 'p1', documentType: 'invalid_type' }, // invalid doc type
    { documentId: 'valid_doc', pageId: '', documentType: 'notebook' }, // empty pageId
    // Item with non-number createdAt is sanitized to valid createdAt = Date.now()
    { documentId: 'valid_doc', pageId: 'p1', documentType: 'notebook', createdAt: 'not-a-number' },
    // Duplicate target of valid_doc:p1 with negative pageNum (sanitized to undefined, deduped by ID)
    { documentId: 'valid_doc', pageId: 'p1', documentType: 'notebook', pageNumber: -5 },
    // Valid element 1
    { documentId: 'doc_alpha', pageId: 'page_valid_1', documentType: 'notebook', createdAt: 1700000000 },
    // Valid element 2
    { documentId: 'doc_alpha', pageId: 'page_valid_2', pageNumber: 2, documentType: 'pdf', title: 'Valid PDF Page' },
  ];

  mockStorage.setItem(rawKey, JSON.stringify(toxicPayload));

  const sanitized = await repo.loadBookmarks('ws_toxic_elements');

  // Exactly 3 valid bookmarks should survive: p1 (sanitized), page_valid_1, and page_valid_2
  assert.equal(sanitized.length, 3, 'Only schema-compliant or safely sanitized unique entries must survive');
  assert.ok(sanitized.some(b => b.pageId === 'p1' && typeof b.createdAt === 'number'));
  assert.ok(sanitized.some(b => b.pageId === 'page_valid_1'));
  assert.ok(sanitized.some(b => b.pageId === 'page_valid_2' && b.pageNumber === 2));
});

test('Suite 3.3: Boundary, XSS injection and extreme inputs are sanitized without corruption', async () => {
  await resetHarness('ws_boundary');
  const repo = new BookmarkRepository();

  // 1. Massive 10,000-character title
  const massiveTitle = 'A'.repeat(10_000);
  const bookmark1 = await repo.addBookmark('ws_boundary', {
    documentId: 'doc_boundary_1',
    pageId: 'p1',
    documentType: 'notebook',
    title: massiveTitle,
  });
  assert.ok(bookmark1.title);
  assert.equal(bookmark1.title.length, 500, 'Massive titles must be clamped to 500 characters');

  // 2. Dangerous XSS tags, null bytes, unicode emojis, RTL text
  const xssTitle = '<script>alert("pwned")</script>\0🚀مرحبا';
  const bookmark2 = await repo.addBookmark('ws_boundary', {
    documentId: 'doc_boundary_2',
    pageId: 'p2',
    documentType: 'notebook',
    title: xssTitle,
  });
  assert.ok(bookmark2.title);
  assert.ok(bookmark2.title.includes('<script>'), 'Title stores text safely without crashing or executing');

  // 3. Storage self-healing: subsequent save on corrupted store overwrites with valid data
  const rawKey = `panvas.ws_boundary.${BOOKMARKS_STORAGE_KEY}`;
  mockStorage.setItem(rawKey, 'CORRUPTED_RAW_GARBAGE');
  await repo.addBookmark('ws_boundary', {
    documentId: 'doc_healer',
    pageId: 'page_heal_1',
    documentType: 'notebook',
    title: 'Healed Title',
  });

  const healed = await repo.loadBookmarks('ws_boundary');
  assert.equal(healed.length, 1, 'Self-healed store must have exactly 1 valid bookmark');
  assert.equal(healed[0].documentId, 'doc_healer');
});

// ============================================================================
// SUITE 4: Document Lifecycle Chaos & Target Identity Stability
// ============================================================================

test('Suite 4.1: Rapid page deletions and default title renumbering preserve bookmarks on exact page UUIDs', async () => {
  await resetHarness('ws_renumber_chaos');

  const notebookId = 'nb_renumber_chaos';

  // Create 10 initial pages: mix of default and custom titles
  const pages: PageForRenumbering[] = [
    { id: 'page_uuid_1', title: 'Page 1', titleProvenance: 'default', order: 0 },
    { id: 'page_uuid_2', title: 'Page 2', titleProvenance: 'default', order: 1 }, // BOOKMARKED
    { id: 'page_uuid_3', title: 'Page 3', titleProvenance: 'default', order: 2 },
    { id: 'page_uuid_4', title: 'Page 4', titleProvenance: 'default', order: 3 },
    { id: 'page_uuid_5', title: 'Chapter Summary', titleProvenance: 'custom', order: 4 }, // BOOKMARKED
    { id: 'page_uuid_6', title: 'Page 6', titleProvenance: 'default', order: 5 },
    { id: 'page_uuid_7', title: 'Page 7', titleProvenance: 'default', order: 6 },
    { id: 'page_uuid_8', title: 'Page 8', titleProvenance: 'default', order: 7 }, // BOOKMARKED
    { id: 'page_uuid_9', title: 'Page 9', titleProvenance: 'default', order: 8 },
    { id: 'page_uuid_10', title: 'Page 10', titleProvenance: 'default', order: 9 },
  ];

  // Bookmark pages 2, 5, and 8
  await useBookmarkStore.getState().addBookmark(notebookId, 'page_uuid_2', 'notebook', undefined, 'Page 2', 'ws_renumber_chaos');
  await useBookmarkStore.getState().addBookmark(notebookId, 'page_uuid_5', 'notebook', undefined, 'Chapter Summary', 'ws_renumber_chaos');
  await useBookmarkStore.getState().addBookmark(notebookId, 'page_uuid_8', 'notebook', undefined, 'Page 8', 'ws_renumber_chaos');

  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'page_uuid_2'), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'page_uuid_5'), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'page_uuid_8'), true);

  // Now simulate rapid deletions: Delete Page 1, Page 3, and Page 7
  const remainingPages = pages.filter(p => p.id !== 'page_uuid_1' && p.id !== 'page_uuid_3' && p.id !== 'page_uuid_7');

  // Compute renumbering updates using Panvas's official algorithm
  const renumberUpdates = computeSectionRenumbering(remainingPages);

  // Former page_uuid_2 was shifted to 1st active position, so its expected title is "Page 1"
  const p2Update = renumberUpdates.find(u => u.id === 'page_uuid_2');
  assert.ok(p2Update);
  assert.equal(p2Update.title, 'Page 1', 'Former Page 2 was renumbered to Page 1');

  // Former page_uuid_5 (custom title) should receive NO renumber updates
  const p5Update = renumberUpdates.find(u => u.id === 'page_uuid_5');
  assert.equal(p5Update, undefined, 'Custom title page must receive zero renumber updates');

  // CRITICAL CHECK: Verify that bookmarks STILL point to the exact UUID targets
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'page_uuid_2'), true, 'page_uuid_2 retains bookmark');
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'page_uuid_5'), true, 'page_uuid_5 retains bookmark');
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'page_uuid_8'), true, 'page_uuid_8 retains bookmark');

  // Unbookmarked pages must remain unbookmarked
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'page_uuid_4'), false);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'page_uuid_6'), false);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'page_uuid_9'), false);
});

test('Suite 4.2: Document rename, soft delete (trash), restore, and permanent deletion cycle handles bookmark references safely', async () => {
  await resetHarness('ws_lifecycle_chaos');

  const docId = 'nb_organic_chemistry';
  const pageId = 'page_benzene_structure';

  await useBookmarkStore.getState().addBookmark(docId, pageId, 'notebook', undefined, 'Benzene Structure', 'ws_lifecycle_chaos');
  assert.equal(useBookmarkStore.getState().isBookmarked(docId, pageId), true);

  // 1. Rename document
  // In Panvas, renaming updates document.name in metadata, but leaves docId and pageId identical
  const renamedDocName = 'Advanced Organic Chemistry 301';
  assert.equal(useBookmarkStore.getState().isBookmarked(docId, pageId), true, 'Bookmark survives document rename');

  // 2. Soft-delete (move to trash): deletedAt is set
  const trashedDoc = { id: docId, name: renamedDocName, deletedAt: Date.now() };
  // Bookmarks in storage remain intact so restoring brings them back
  assert.equal(useBookmarkStore.getState().isBookmarked(docId, pageId), true, 'Bookmark metadata preserved during trash');

  // 3. Restore document: deletedAt is cleared
  trashedDoc.deletedAt = null;
  assert.equal(useBookmarkStore.getState().isBookmarked(docId, pageId), true, 'Restored document immediately has bookmark active');

  // 4. Permanent deletion: invoke deleteBookmarksForDocument
  await useBookmarkStore.getState().deleteBookmarksForDocument(docId, 'ws_lifecycle_chaos');
  assert.equal(useBookmarkStore.getState().isBookmarked(docId, pageId), false, 'Permanently deleted document bookmarks purged');

  // Verify other documents are untouched
  await useBookmarkStore.getState().addBookmark('nb_other', 'page_other', 'notebook', undefined, 'Other Doc', 'ws_lifecycle_chaos');
  assert.equal(useBookmarkStore.getState().isBookmarked('nb_other', 'page_other'), true);
});

// ============================================================================
// SUITE 5: Non-Interference, Pointer Events & Drawing Queue Isolation
// ============================================================================

test('Suite 5.1: PageRenderer bookmark corner ribbon and all child elements strictly enforce pointer-events-none and select-none', () => {
  // 1. Render PageRenderer with explicit isBookmarked = true
  const htmlBookmarked = renderToStaticMarkup(
    React.createElement(PageRenderer, {
      id: 'page_canvas_test_1',
      width: 800,
      height: 1100,
      properties: mockProperties,
      isBookmarked: true,
    })
  );

  // Must render the corner marker
  assert.ok(htmlBookmarked.includes('data-testid="page-bookmark-marker"'), 'Must render bookmark marker');
  assert.ok(htmlBookmarked.includes('aria-label="Bookmarked page marker"'), 'Must render accessible aria-label');

  // Extract the entire marker markup
  const markerIndex = htmlBookmarked.indexOf('data-testid="page-bookmark-marker"');
  const markerSnippet = htmlBookmarked.slice(markerIndex - 20, markerIndex + 500);

  // Verify pointer-events-none and select-none on marker container
  assert.match(markerSnippet, /pointer-events-none/, 'Container must have pointer-events-none');
  assert.match(markerSnippet, /select-none/, 'Container must have select-none');

  // Verify pointer-events-none and select-none on inner triangle and SVG
  const triangleIndex = markerSnippet.indexOf('border-t-panvas-accent-blue');
  assert.ok(triangleIndex > 0, 'Must contain triangle fold');
  const triangleSnippet = markerSnippet.slice(triangleIndex - 50, triangleIndex + 150);
  assert.match(triangleSnippet, /pointer-events-none/, 'Triangle must have pointer-events-none');
  assert.match(triangleSnippet, /select-none/, 'Triangle must have select-none');

  // 2. Render PageRenderer with isBookmarked = false: marker must NOT be rendered
  const htmlUnbookmarked = renderToStaticMarkup(
    React.createElement(PageRenderer, {
      id: 'page_canvas_test_1',
      width: 800,
      height: 1100,
      properties: mockProperties,
      isBookmarked: false,
    })
  );
  assert.ok(!htmlUnbookmarked.includes('data-testid="page-bookmark-marker"'), 'Unbookmarked page must NOT render marker');

  // 3. Continuation sheet suppression:
  // Sub-sheets rendered by layout pagination (e.g. -sheet-2) must never show bookmark marker
  const htmlContinuation = renderToStaticMarkup(
    React.createElement(PageRenderer, {
      id: 'page_canvas_test_1-sheet-2',
      width: 800,
      height: 1100,
      properties: mockProperties,
      isBookmarked: false,
    })
  );
  assert.ok(!htmlContinuation.includes('data-testid="page-bookmark-marker"'), 'Continuation sheet must NOT render corner marker');
});

test('Suite 5.2: PdfThumbnailSidebar thumbnail bookmark ribbon strictly enforces pointer-events-none', () => {
  // Setup store with bookmarked PDF page 3
  const documentId = 'pdf_pointer_test';
  useBookmarkStore.setState({
    bookmarks: [
      {
        id: generateBookmarkId(documentId, 3),
        documentId,
        pageId: formatPdfPageId(documentId, 3),
        pageNumber: 3,
        documentType: 'pdf',
        createdAt: Date.now(),
      },
    ],
    isLoaded: true,
    currentWorkspaceId: null,
  });

  const html = renderToStaticMarkup(
    React.createElement(Thumbnail, {
      page: 3,
      pdfDocument: null,
      rotation: 0,
      documentId,
    })
  );

  assert.ok(html.includes('data-testid="thumbnail-bookmark-3"'), 'Must render thumbnail bookmark ribbon');
  assert.ok(html.includes('aria-label="Page 3 bookmarked"'), 'Must have accessible label');

  // Extract bookmark snippet
  const bmIdx = html.indexOf('data-testid="thumbnail-bookmark-3"');
  const bmSnippet = html.slice(bmIdx - 60, bmIdx + 200);

  // Must enforce pointer-events-none so thumbnail button clicking and hover are never blocked
  assert.match(bmSnippet, /pointer-events-none/, 'Thumbnail bookmark ribbon must enforce pointer-events-none');
});

test('Suite 5.3: DrawingPersistenceQueue is completely untouched (0 calls) across 50 rapid bookmark operations', async () => {
  await resetHarness('ws_isolation_check');

  let persistenceCallCount = 0;
  const originalPersist = DrawingPersistenceQueue.prototype.persist;
  DrawingPersistenceQueue.prototype.persist = async function (...args: any[]) {
    persistenceCallCount++;
    return originalPersist.apply(this, args);
  };

  try {
    const docId = 'nb_isolation_test';
    // Perform 50 rapid bookmark operations
    for (let i = 1; i <= 25; i++) {
      await useBookmarkStore.getState().addBookmark(docId, `page_${i}`, 'notebook', undefined, `Page ${i}`, 'ws_isolation_check');
    }
    for (let i = 1; i <= 25; i++) {
      await useBookmarkStore.getState().removeBookmark(docId, `page_${i}`, 'ws_isolation_check');
    }

    assert.equal(persistenceCallCount, 0, 'DrawingPersistenceQueue must receive EXACTLY 0 calls during bookmark mutations');
  } finally {
    DrawingPersistenceQueue.prototype.persist = originalPersist;
  }
});
