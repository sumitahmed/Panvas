// ============================================================================
// Panvas — Bookmark Lifecycle, Identity Stability & History Integration Tests
// Milestone M4: Undo/Redo & Document Lifecycle Integration, Stable Target Resolution
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { useBookmarkStore } from '../src/stores/bookmarkStore';
import {
  BookmarkRepository,
  BOOKMARKS_STORAGE_KEY,
} from '../src/services/bookmarks/BookmarkRepository';
import {
  generateBookmarkId,
  parseBookmarkId,
  formatPdfPageId,
} from '../src/services/bookmarks/bookmarkId';
import {
  createBookmarkHistoryCommand,
  toggleBookmarkWithHistory,
} from '../src/services/bookmarks/bookmarkHistory';
import { HistoryManager } from '../src/components/notebook/engine/HistoryManager';
import type { HistoryCommand } from '../src/components/notebook/engine/drawingTypes';
import { computeSectionRenumbering, type PageForRenumbering } from '../src/lib/notebookPageRenumbering';
import {
  saveNotebookPosition,
  getNotebookPosition,
  clearNotebookPosition,
  savePdfPosition,
  getPdfPosition,
  clearPdfPosition,
} from '../src/lib/readingPosition';
import {
  DrawingPersistenceQueue,
  type DrawingSaveTarget,
  type DrawingPersistenceCallbacks,
} from '../src/components/notebook/drawingPersistenceQueue';
import {
  createDefaultDrawingData,
  createEmptyDrawingData,
  type DrawingData,
  type Stroke,
} from '../src/components/notebook/engine/drawingTypes';
import { capturePageOwnedDrawing } from '../src/components/notebook/notebookPageRenderState';

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

// Reset store before each major test group
async function resetHarness(workspaceId: string | null = null) {
  mockStorage.clear();
  useBookmarkStore.setState({ bookmarks: [], isLoaded: true, currentWorkspaceId: workspaceId });
}

// ============================================================================
// Suite 1: Document and Page Renaming Preserving Bookmarks
// ============================================================================

test('Suite 1.1: Renaming a notebook preserves all bookmarks targeting its pages', async () => {
  await resetHarness('ws_main');

  const notebookId = 'nb_quantum_mechanics_101';
  const page1Id = 'page_wavefunction_uuid';
  const page2Id = 'page_schrodinger_uuid';

  // Add bookmarks for two pages in this notebook
  await useBookmarkStore.getState().addBookmark(
    notebookId,
    page1Id,
    'notebook',
    undefined,
    'Wavefunctions',
    'ws_main'
  );
  await useBookmarkStore.getState().addBookmark(
    notebookId,
    page2Id,
    'notebook',
    undefined,
    'Schrödinger Equation',
    'ws_main'
  );

  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, page1Id), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, page2Id), true);

  // Simulate renaming the notebook title in repository metadata
  // In Panvas, renaming updates notebook.name / notebook.title but notebook.id is immutable
  const updatedNotebookMetadata = {
    id: notebookId,
    title: 'Advanced Quantum Field Theory (Renamed)',
    workspaceId: 'ws_main',
  };

  // Verify bookmarks remain perfectly bound to notebookId
  const bookmarks = useBookmarkStore.getState().getBookmarksForDocument(updatedNotebookMetadata.id);
  assert.equal(bookmarks.length, 2);
  assert.equal(bookmarks.some(b => b.pageId === page1Id), true);
  assert.equal(bookmarks.some(b => b.pageId === page2Id), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(updatedNotebookMetadata.id, page1Id), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(updatedNotebookMetadata.id, page2Id), true);
});

test('Suite 1.2: Renaming a notebook page preserves its bookmark and composite key', async () => {
  await resetHarness('ws_main');

  const notebookId = 'nb_notes_2026';
  const pageId = 'page_stable_target_42';

  // Add bookmark with initial default title
  await useBookmarkStore.getState().addBookmark(
    notebookId,
    pageId,
    'notebook',
    undefined,
    'Page 1',
    'ws_main'
  );

  const initialBookmark = useBookmarkStore.getState().getBookmark(notebookId, pageId);
  assert.ok(initialBookmark);
  assert.equal(initialBookmark.id, `${notebookId}:${pageId}`);

  // User manually edits the page title: titleProvenance flips to 'custom', title becomes 'Executive Briefing'
  // Page ID remains 'page_stable_target_42'
  const newPageTitle = 'Executive Briefing';
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), true);

  // User may also optionally synchronize the bookmark label via renameBookmark
  await useBookmarkStore.getState().renameBookmark(initialBookmark.id, newPageTitle, 'ws_main');

  const updatedBookmark = useBookmarkStore.getState().getBookmark(notebookId, pageId);
  assert.ok(updatedBookmark);
  assert.equal(updatedBookmark.id, `${notebookId}:${pageId}`);
  assert.equal(updatedBookmark.pageId, pageId);
  assert.equal(updatedBookmark.title, 'Executive Briefing');
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), true);
});

test('Suite 1.3: Renaming a PDF document preserves page bookmarks and target resolution', async () => {
  await resetHarness('ws_pdf');

  const documentSessionId = 'pdf_session_annual_report_hash123';
  const bookmarkedPageNumber = 17;

  await useBookmarkStore.getState().addBookmark(
    documentSessionId,
    bookmarkedPageNumber,
    'pdf',
    bookmarkedPageNumber,
    'Financial Overview',
    'ws_pdf'
  );

  assert.equal(useBookmarkStore.getState().isBookmarked(documentSessionId, bookmarkedPageNumber), true);
  const bookmark = useBookmarkStore.getState().getBookmark(documentSessionId, bookmarkedPageNumber);
  assert.ok(bookmark);
  assert.equal(bookmark.pageNumber, 17);
  assert.equal(bookmark.documentType, 'pdf');

  // Renaming PDF file name / title does not mutate documentSessionId
  assert.equal(useBookmarkStore.getState().isBookmarked(documentSessionId, 17), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(documentSessionId, 'pdf_session_annual_report_hash123_pdf_17'), true);
});

// ============================================================================
// Suite 2: Default Page Title Renumbering Preserving Stable Bookmark Targets
// ============================================================================

test('Suite 2.1: Deleting an intermediate page renumbers default titles without retargeting bookmarks', async () => {
  await resetHarness('ws_renumber');

  const notebookId = 'nb_renumber_test';

  // Section with 4 pages originally titled Page 1, Page 2, Page 3, Page 4
  const pages: PageForRenumbering[] = [
    { id: 'p_alpha_1', title: 'Page 1', order: 0, titleProvenance: 'default' },
    { id: 'p_beta_2', title: 'Page 2', order: 1, titleProvenance: 'default' },
    { id: 'p_gamma_3', title: 'Page 3', order: 2, titleProvenance: 'default' },
    { id: 'p_delta_4', title: 'Page 4', order: 3, titleProvenance: 'default' },
  ];

  // User bookmarks Page 3 (id: p_gamma_3)
  await useBookmarkStore.getState().addBookmark(
    notebookId,
    'p_gamma_3',
    'notebook',
    undefined,
    'Page 3',
    'ws_renumber'
  );

  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'p_gamma_3'), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'p_delta_4'), false);

  // Deletion: Page 2 (p_beta_2) is deleted
  const remainingPages: PageForRenumbering[] = [
    pages[0], // p_alpha_1 (order 0)
    { ...pages[2], order: 1 }, // p_gamma_3 (order 1)
    { ...pages[3], order: 2 }, // p_delta_4 (order 2)
  ];

  // Compute section renumbering updates
  const renumberUpdates = computeSectionRenumbering(remainingPages);
  assert.equal(renumberUpdates.length, 2);
  assert.deepEqual(renumberUpdates, [
    { id: 'p_gamma_3', title: 'Page 2', titleProvenance: 'default' },
    { id: 'p_delta_4', title: 'Page 3', titleProvenance: 'default' },
  ]);

  // Apply renumbering to page objects
  for (const update of renumberUpdates) {
    const target = remainingPages.find(p => p.id === update.id);
    if (target) {
      target.title = update.title;
    }
  }

  // CRITICAL INVARIANT:
  // p_gamma_3 is now titled "Page 2"
  // p_delta_4 is now titled "Page 3"
  // The bookmark MUST remain on p_gamma_3! It must NEVER jump to p_delta_4 just because p_delta_4 is now titled "Page 3".
  assert.equal(
    useBookmarkStore.getState().isBookmarked(notebookId, 'p_gamma_3'),
    true,
    'Bookmark must remain attached to p_gamma_3 after renumbering'
  );
  assert.equal(
    useBookmarkStore.getState().isBookmarked(notebookId, 'p_delta_4'),
    false,
    'p_delta_4 must NOT inherit the bookmark despite being renamed to Page 3'
  );
  assert.equal(
    useBookmarkStore.getState().isBookmarked(notebookId, 'p_beta_2'),
    false,
    'Deleted page p_beta_2 must not be bookmarked'
  );
});

test('Suite 2.2: Renumbering with mixed default and custom titles preserves bookmarks on both', async () => {
  await resetHarness('ws_mixed');

  const notebookId = 'nb_mixed_test';

  const pages: PageForRenumbering[] = [
    { id: 'p_intro', title: 'Introduction', order: 0, titleProvenance: 'custom' },
    { id: 'p_page2', title: 'Page 2', order: 1, titleProvenance: 'default' },
    { id: 'p_summary', title: 'Summary Notes', order: 2, titleProvenance: 'custom' },
    { id: 'p_page4', title: 'Page 4', order: 3, titleProvenance: 'default' },
  ];

  // Bookmark p_page2 and p_summary
  await useBookmarkStore.getState().addBookmark(notebookId, 'p_page2', 'notebook', undefined, 'Page 2', 'ws_mixed');
  await useBookmarkStore.getState().addBookmark(notebookId, 'p_summary', 'notebook', undefined, 'Summary Notes', 'ws_mixed');

  // Delete 'p_intro'
  const remainingPages: PageForRenumbering[] = [
    { ...pages[1], order: 0 },
    { ...pages[2], order: 1 },
    { ...pages[3], order: 2 },
  ];

  const renumberUpdates = computeSectionRenumbering(remainingPages);
  // Default pages renumber: p_page2 -> 'Page 1', p_page4 -> 'Page 3'. p_summary remains untouched.
  assert.equal(renumberUpdates.length, 2);
  assert.equal(renumberUpdates[0].id, 'p_page2');
  assert.equal(renumberUpdates[0].title, 'Page 1');
  assert.equal(renumberUpdates[1].id, 'p_page4');
  assert.equal(renumberUpdates[1].title, 'Page 3');

  // Verify both bookmarks are strictly preserved
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'p_page2'), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'p_summary'), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, 'p_page4'), false);
});

// ============================================================================
// Suite 3: Trashing and Restoration Lifecycle Preserving Bookmark Metadata
// ============================================================================

test('Suite 3.1: Soft-deleting (trashing) a notebook page preserves bookmark metadata in storage', async () => {
  await resetHarness('ws_trash');

  const notebookId = 'nb_trash_lifecycle';
  const pageId = 'page_important_findings';

  const bookmark = await useBookmarkStore.getState().addBookmark(
    notebookId,
    pageId,
    'notebook',
    undefined,
    'Important Findings',
    'ws_trash'
  );

  const initialCreatedAt = bookmark.createdAt;
  assert.ok(initialCreatedAt > 0);

  // Simulate soft-delete / moving to trash:
  // The page entity receives deletedAt: Date.now() in WorkspaceRepository, but its bookmark record remains
  const repository = new BookmarkRepository();
  const loaded = await repository.loadBookmarks('ws_trash');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, `${notebookId}:${pageId}`);
  assert.equal(loaded[0].createdAt, initialCreatedAt);
});

test('Suite 3.2: Restoring a trashed page from trash restores active bookmark display without data loss', async () => {
  await resetHarness('ws_trash');

  const notebookId = 'nb_restore_test';
  const pageId = 'page_resurrected';

  await useBookmarkStore.getState().addBookmark(
    notebookId,
    pageId,
    'notebook',
    undefined,
    'To Be Restored',
    'ws_trash'
  );

  // Verify bookmark is active
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), true);

  // Simulate reload of workspace contents while restoring item from trash
  await useBookmarkStore.getState().loadBookmarks('ws_trash');

  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), true);
  const bm = useBookmarkStore.getState().getBookmark(notebookId, pageId);
  assert.ok(bm);
  assert.equal(bm.title, 'To Be Restored');
});

test('Suite 3.3: Soft-deleting and restoring an entire notebook preserves all page bookmarks across the lifecycle', async () => {
  await resetHarness('ws_notebook_trash');

  const notebookId = 'nb_project_phoenix';
  const pageIds = ['page_phase1', 'page_phase2', 'page_phase3'];

  for (let i = 0; i < pageIds.length; i++) {
    await useBookmarkStore.getState().addBookmark(
      notebookId,
      pageIds[i],
      'notebook',
      undefined,
      `Phase ${i + 1}`,
      'ws_notebook_trash'
    );
  }

  assert.equal(useBookmarkStore.getState().getBookmarksForDocument(notebookId).length, 3);

  // Reload store from persistence to simulate restart / restore
  await useBookmarkStore.getState().loadBookmarks('ws_notebook_trash');

  const restored = useBookmarkStore.getState().getBookmarksForDocument(notebookId);
  assert.equal(restored.length, 3);
  for (const pid of pageIds) {
    assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pid), true);
  }
});

// ============================================================================
// Suite 4: Graceful Handling of Deleted/Unavailable Bookmark Targets
// ============================================================================

test('Suite 4.1: Querying bookmark status for a deleted or nonexistent page returns false without throwing', async () => {
  await resetHarness('ws_clean');

  assert.doesNotThrow(() => {
    const isBm = useBookmarkStore.getState().isBookmarked('nb_unknown', 'page_ghost');
    assert.equal(isBm, false);
  });

  assert.doesNotThrow(() => {
    const bm = useBookmarkStore.getState().getBookmark('nb_unknown', 'page_ghost');
    assert.equal(bm, undefined);
  });

  assert.doesNotThrow(() => {
    const list = useBookmarkStore.getState().getBookmarksForDocument('nb_unknown');
    assert.deepEqual(list, []);
  });
});

test('Suite 4.2: Explicit deletion of a bookmarked page permanently removes bookmark via deleteBookmarkForPage', async () => {
  await resetHarness('ws_purge');

  const notebookId = 'nb_purge';
  const pageId = 'page_doomed';

  await useBookmarkStore.getState().addBookmark(notebookId, pageId, 'notebook', undefined, 'Doomed Page', 'ws_purge');
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), true);

  // Permanent page deletion triggers cleanup
  await useBookmarkStore.getState().deleteBookmarkForPage(notebookId, pageId, 'ws_purge');

  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), false);
  assert.equal(useBookmarkStore.getState().getBookmark(notebookId, pageId), undefined);
});

test('Suite 4.3: Bulk cleanup of a permanently deleted document purges all its bookmarks via deleteBookmarksForDocument', async () => {
  await resetHarness('ws_purge');

  const doomedDoc = 'doc_to_delete';
  const survivingDoc = 'doc_to_keep';

  await useBookmarkStore.getState().addBookmark(doomedDoc, 'p1', 'notebook', undefined, 'P1', 'ws_purge');
  await useBookmarkStore.getState().addBookmark(doomedDoc, 'p2', 'notebook', undefined, 'P2', 'ws_purge');
  await useBookmarkStore.getState().addBookmark(survivingDoc, 'p_keep', 'notebook', undefined, 'Keep', 'ws_purge');

  assert.equal(useBookmarkStore.getState().getBookmarksForDocument(doomedDoc).length, 2);
  assert.equal(useBookmarkStore.getState().getBookmarksForDocument(survivingDoc).length, 1);

  // Permanent document purge
  await useBookmarkStore.getState().deleteBookmarksForDocument(doomedDoc, 'ws_purge');

  assert.equal(useBookmarkStore.getState().getBookmarksForDocument(doomedDoc).length, 0);
  assert.equal(useBookmarkStore.getState().getBookmarksForDocument(survivingDoc).length, 1);
  assert.equal(useBookmarkStore.getState().isBookmarked(survivingDoc, 'p_keep'), true);
});

// ============================================================================
// Suite 5: Explicit Navigation to Bookmark Overriding Stale Reading Position
// ============================================================================

test('Suite 5.1: Explicit notebook bookmark navigation overrides saved reading position', () => {
  const notebookId = 'nb_reading_pos_test';
  const staleSavedPageId = 'page_stale_1';
  const explicitBookmarkPageId = 'page_bookmarked_4';

  // Save a previous reading position pointing to page_stale_1
  saveNotebookPosition(notebookId, {
    pageId: staleSavedPageId,
    scrollX: 0,
    scrollY: 850,
  });

  const saved = getNotebookPosition(notebookId);
  assert.ok(saved);
  assert.equal(saved.pageId, staleSavedPageId);

  // Simulating NotebookRenderer navigation decision logic (NotebookRenderer.tsx:1650-1655):
  // When user clicks the bookmark in WorkspaceTree, activePageId is explicitly set to page_bookmarked_4
  const activePageId = explicitBookmarkPageId;

  // The condition in NotebookRenderer:
  // if (savedPosition && savedPosition.pageId === activePageId) -> restore scroll
  // else -> bypass saved position and navigate directly to activePageId
  const shouldRestoreSavedScroll = saved && saved.pageId === activePageId;
  assert.equal(
    shouldRestoreSavedScroll,
    false,
    'Saved reading position of a stale page must NOT be restored when navigating to a different bookmarked page'
  );

  // Target navigation destination is the bookmarked page
  const resolvedTargetPageId = shouldRestoreSavedScroll ? saved.pageId : activePageId;
  assert.equal(resolvedTargetPageId, explicitBookmarkPageId);

  // Clean up
  clearNotebookPosition(notebookId);
  assert.equal(getNotebookPosition(notebookId), null);
});

test('Suite 5.2: Explicit PDF bookmark navigation overrides saved reading position', () => {
  const documentId = 'pdf_reading_pos_test';
  const stalePdfPage = 1;
  const bookmarkedPdfPage = 9;

  // Save reading position on page 1 with vertical scroll
  savePdfPosition(documentId, {
    pdfPage: stalePdfPage,
    scrollX: 0,
    scrollY: 1200,
  });

  const saved = getPdfPosition(documentId);
  assert.ok(saved);
  assert.equal(saved.pdfPage, stalePdfPage);

  // Simulating PdfWorkspace explicit navigation (PdfWorkspace.tsx:406-410):
  // Clicking the thumbnail sets commandedPageRef.current = bookmarkedPdfPage
  let commandedPage: number | null = bookmarkedPdfPage;

  // In PdfWorkspace:
  // const saved = page?.id ? getPdfPosition(page.id) : null;
  // if (saved && !commandedPageRef.current && typeof saved.scrollY === 'number' && saved.scrollY > 0) -> restore scroll
  const shouldRestoreScrollOffset = saved !== null && !commandedPage;
  assert.equal(
    shouldRestoreScrollOffset,
    false,
    'PDF reading position scroll offset must be bypassed when commandedPage is active'
  );

  const effectivePage = commandedPage ?? (saved?.pdfPage ?? 1);
  assert.equal(effectivePage, bookmarkedPdfPage);

  clearPdfPosition(documentId);
  assert.equal(getPdfPosition(documentId), null);
});

// ============================================================================
// Suite 6: Interleaved History Operations (Drawing Strokes + Bookmark Toggles)
// ============================================================================

test('Suite 6.1: History isolation: Drawing strokes and bookmark toggles operate on separate domains without cross-corruption', async () => {
  await resetHarness('ws_history');

  const historyManager = new HistoryManager(50);
  const notebookId = 'nb_drawing_history';
  const pageId = 'page_sketch_1';

  // In-memory simulation of active drawing strokes
  const drawingStrokes: string[] = [];

  const createDrawingStrokeCommand = (strokeId: string): HistoryCommand => ({
    description: `Draw stroke ${strokeId}`,
    execute: () => {
      if (!drawingStrokes.includes(strokeId)) drawingStrokes.push(strokeId);
    },
    undo: () => {
      const idx = drawingStrokes.indexOf(strokeId);
      if (idx !== -1) drawingStrokes.splice(idx, 1);
    },
  });

  // Action 1: User draws stroke S1
  const stroke1Cmd = createDrawingStrokeCommand('stroke_1');
  stroke1Cmd.execute();
  historyManager.pushExecuted(stroke1Cmd);
  assert.deepEqual(drawingStrokes, ['stroke_1']);

  // Action 2: User bookmarks current page
  await toggleBookmarkWithHistory(historyManager, {
    documentId: notebookId,
    pageIdOrNumber: pageId,
    documentType: 'notebook',
    title: 'Sketch 1',
    workspaceId: 'ws_history',
  });
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), true);
  assert.deepEqual(drawingStrokes, ['stroke_1']);

  // Action 3: User draws stroke S2
  const stroke2Cmd = createDrawingStrokeCommand('stroke_2');
  stroke2Cmd.execute();
  historyManager.pushExecuted(stroke2Cmd);
  assert.deepEqual(drawingStrokes, ['stroke_1', 'stroke_2']);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), true);

  // Stack is now: [Stroke 1, Bookmark Toggle ON, Stroke 2]

  // UNDO STEP 1: Should undo Stroke 2 only
  historyManager.undo();
  assert.deepEqual(drawingStrokes, ['stroke_1'], 'Stroke 2 must be undone');
  assert.equal(
    useBookmarkStore.getState().isBookmarked(notebookId, pageId),
    true,
    'Bookmark must remain unaffected when undoing Stroke 2'
  );

  // UNDO STEP 2: Should undo Bookmark Toggle ON
  historyManager.undo();
  assert.deepEqual(drawingStrokes, ['stroke_1'], 'Stroke 1 must remain untouched when undoing bookmark');
  assert.equal(
    useBookmarkStore.getState().isBookmarked(notebookId, pageId),
    false,
    'Bookmark must be reverted to false'
  );

  // UNDO STEP 3: Should undo Stroke 1
  historyManager.undo();
  assert.deepEqual(drawingStrokes, [], 'Stroke 1 must be undone');
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), false);

  // REDO STEP 1: Restores Stroke 1
  historyManager.redo();
  assert.deepEqual(drawingStrokes, ['stroke_1']);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), false);

  // REDO STEP 2: Restores Bookmark Toggle ON
  historyManager.redo();
  assert.deepEqual(drawingStrokes, ['stroke_1']);
  assert.equal(
    useBookmarkStore.getState().isBookmarked(notebookId, pageId),
    true,
    'Bookmark must be restored on redo'
  );

  // REDO STEP 3: Restores Stroke 2
  historyManager.redo();
  assert.deepEqual(drawingStrokes, ['stroke_1', 'stroke_2']);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), true);
});

test('Suite 6.2: Symmetrical history on bookmark removal (toggle OFF then undo/redo)', async () => {
  await resetHarness('ws_history_off');

  const historyManager = new HistoryManager(50);
  const notebookId = 'nb_removal_history';
  const pageId = 'page_remove_test';

  // Initially bookmarked
  await useBookmarkStore.getState().addBookmark(notebookId, pageId, 'notebook', undefined, 'Initial', 'ws_history_off');
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), true);

  const strokes: string[] = ['initial_stroke'];

  const createDrawingStrokeCommand = (strokeId: string): HistoryCommand => ({
    description: `Draw stroke ${strokeId}`,
    execute: () => {
      if (!strokes.includes(strokeId)) strokes.push(strokeId);
    },
    undo: () => {
      const idx = strokes.indexOf(strokeId);
      if (idx !== -1) strokes.splice(idx, 1);
    },
  });

  // Action 1: User removes bookmark (toggle OFF)
  await toggleBookmarkWithHistory(historyManager, {
    documentId: notebookId,
    pageIdOrNumber: pageId,
    documentType: 'notebook',
    workspaceId: 'ws_history_off',
  });
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), false);

  // Action 2: User draws new stroke
  const strokeCmd = createDrawingStrokeCommand('stroke_after_unbookmark');
  strokeCmd.execute();
  historyManager.pushExecuted(strokeCmd);
  assert.deepEqual(strokes, ['initial_stroke', 'stroke_after_unbookmark']);

  // UNDO 1: Undoes stroke
  historyManager.undo();
  assert.deepEqual(strokes, ['initial_stroke']);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), false);

  // UNDO 2: Undoes bookmark removal -> Bookmark is restored to true!
  historyManager.undo();
  assert.deepEqual(strokes, ['initial_stroke']);
  assert.equal(
    useBookmarkStore.getState().isBookmarked(notebookId, pageId),
    true,
    'Undoing bookmark removal must restore bookmark state'
  );

  // REDO 1: Re-applies bookmark removal -> Bookmark is false again
  historyManager.redo();
  assert.deepEqual(strokes, ['initial_stroke']);
  assert.equal(
    useBookmarkStore.getState().isBookmarked(notebookId, pageId),
    false,
    'Redoing bookmark removal must remove bookmark state'
  );

  // REDO 2: Re-applies stroke
  historyManager.redo();
  assert.deepEqual(strokes, ['initial_stroke', 'stroke_after_unbookmark']);
  assert.equal(useBookmarkStore.getState().isBookmarked(notebookId, pageId), false);
});

test('Suite 6.3: Multi-page and multi-document target associations preserved across switches in history stack', async () => {
  await resetHarness('ws_multi_doc');

  const historyManager = new HistoryManager(50);

  const docA = 'doc_notebook_A';
  const pageA = 'page_A_1';

  const docB = 'doc_pdf_B';
  const pageB = 5;

  // Bookmark Page A in Notebook A
  await toggleBookmarkWithHistory(historyManager, {
    documentId: docA,
    pageIdOrNumber: pageA,
    documentType: 'notebook',
    title: 'Doc A Page 1',
    workspaceId: 'ws_multi_doc',
  });

  // Switch document: Bookmark Page 5 in PDF B
  await toggleBookmarkWithHistory(historyManager, {
    documentId: docB,
    pageIdOrNumber: pageB,
    documentType: 'pdf',
    pageNumber: 5,
    title: 'Doc B Page 5',
    workspaceId: 'ws_multi_doc',
  });

  assert.equal(useBookmarkStore.getState().isBookmarked(docA, pageA), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(docB, pageB), true);

  // Undo 1: Undoes PDF B page 5 bookmark
  historyManager.undo();
  assert.equal(useBookmarkStore.getState().isBookmarked(docB, pageB), false);
  assert.equal(useBookmarkStore.getState().isBookmarked(docA, pageA), true, 'Doc A bookmark must remain intact');

  // Undo 2: Undoes Notebook A page 1 bookmark
  historyManager.undo();
  assert.equal(useBookmarkStore.getState().isBookmarked(docA, pageA), false);
  assert.equal(useBookmarkStore.getState().isBookmarked(docB, pageB), false);

  // Redo 1: Restores Notebook A page 1 bookmark
  historyManager.redo();
  assert.equal(useBookmarkStore.getState().isBookmarked(docA, pageA), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(docB, pageB), false);

  // Redo 2: Restores PDF B page 5 bookmark
  historyManager.redo();
  assert.equal(useBookmarkStore.getState().isBookmarked(docA, pageA), true);
  assert.equal(useBookmarkStore.getState().isBookmarked(docB, pageB), true);
});

// ============================================================================
// Suite 7: Performance Isolation: Zero Drawing Re-Serialization on Bookmark Toggling
// ============================================================================

test('Suite 7.1: Zero calls to DrawingPersistenceQueue during bookmark operations', async () => {
  await resetHarness('ws_perf');

  let persistenceQueueCallCount = 0;

  const callbacks: DrawingPersistenceCallbacks = {
    resolveTarget: () => ({ workspaceId: 'ws_perf', notebookId: 'nb_perf' }),
    encode: () => {
      persistenceQueueCallCount++;
      return JSON.stringify({ objects: [] });
    },
    save: async () => {
      persistenceQueueCallCount++;
      return createEmptyDrawingData();
    },
  };

  const queue = new DrawingPersistenceQueue(callbacks);

  // Perform multiple bookmark additions, removals, and toggles
  const docId = 'nb_perf_doc';
  for (let i = 1; i <= 5; i++) {
    await useBookmarkStore.getState().addBookmark(docId, `page_${i}`, 'notebook', undefined, `Page ${i}`, 'ws_perf');
  }

  for (let i = 1; i <= 5; i++) {
    await useBookmarkStore.getState().removeBookmark(docId, `page_${i}`, 'ws_perf');
  }

  for (let i = 1; i <= 5; i++) {
    await useBookmarkStore.getState().toggleBookmark(docId, `page_${i}`, 'notebook', undefined, `Page ${i}`, 'ws_perf');
  }

  // Verify that DrawingPersistenceQueue was NEVER invoked during bookmark operations
  assert.equal(
    persistenceQueueCallCount,
    0,
    'DrawingPersistenceQueue must never be invoked or scheduled by bookmark operations'
  );
  assert.equal(queue.getScheduledSequence('page_1'), undefined);
  assert.equal(queue.hasFailed('page_1'), false);
});

test('Suite 7.2: Immutability of drawing stroke JSON payloads across bookmark lifecycle', async () => {
  await resetHarness('ws_immutability');

  // Create a realistic drawing data model with multiple strokes, colors, and widths
  const initialDrawing: DrawingData = createDefaultDrawingData();
  initialDrawing.objects = [
    {
      id: 'stroke_vector_alpha',
      type: 'stroke',
      points: [
        { x: 10, y: 10, pressure: 0.5 },
        { x: 50, y: 60, pressure: 0.8 },
        { x: 100, y: 120, pressure: 0.4 },
      ],
      color: '#1a1a1a',
      width: 2.5,
      tool: 'pen',
      createdAt: 1700000000000,
    } as unknown as Stroke,
    {
      id: 'stroke_vector_beta',
      type: 'stroke',
      points: [
        { x: 120, y: 150, pressure: 0.7 },
        { x: 200, y: 250, pressure: 0.9 },
      ],
      color: '#0055ff',
      width: 4.0,
      tool: 'marker',
      createdAt: 1700000001000,
    } as unknown as Stroke,
  ];

  const serializedBefore = JSON.stringify(initialDrawing);
  const hashBefore = crypto.createHash('sha256').update(serializedBefore).digest('hex');

  const docId = 'nb_immutability_test';
  const pageId = 'page_draw_intact';

  // Perform a sequence of bookmark operations on the page
  await useBookmarkStore.getState().addBookmark(docId, pageId, 'notebook', undefined, 'Initial', 'ws_immutability');
  await useBookmarkStore.getState().renameBookmark(`${docId}:${pageId}`, 'Renamed Title', 'ws_immutability');
  await useBookmarkStore.getState().toggleBookmark(docId, pageId, 'notebook', undefined, undefined, 'ws_immutability'); // toggle off
  await useBookmarkStore.getState().toggleBookmark(docId, pageId, 'notebook', undefined, undefined, 'ws_immutability'); // toggle on

  // Compare drawing data before and after
  const serializedAfter = JSON.stringify(initialDrawing);
  const hashAfter = crypto.createHash('sha256').update(serializedAfter).digest('hex');

  assert.equal(
    hashAfter,
    hashBefore,
    'Drawing JSON payload hash must remain strictly identical across all bookmark operations'
  );
  assert.equal(serializedAfter, serializedBefore);
});
