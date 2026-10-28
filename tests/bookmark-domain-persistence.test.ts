// ============================================
// Panvas — Bookmark Domain & Persistence Tests
// ============================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateBookmarkId,
  parseBookmarkId,
  formatPdfPageId,
  normalizeNotebookBookmarkTarget,
  normalizePdfBookmarkTarget,
} from '../src/services/bookmarks/bookmarkId';
import {
  BookmarkRepository,
  BOOKMARKS_STORAGE_KEY,
  validateBookmark,
  isBookmarkMatch,
} from '../src/services/bookmarks/BookmarkRepository';
import { useBookmarkStore } from '../src/stores/bookmarkStore';
import {
  createBookmarkHistoryCommand,
  toggleBookmarkWithHistory,
} from '../src/services/bookmarks/bookmarkHistory';
import type { Bookmark, BookmarkDocumentType } from '../src/types/bookmark';
import type { HistoryCommand } from '../src/components/notebook/engine/drawingTypes';

// ---- Environment Harness Helpers ----

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

// ============================================
// Suite 1: Composite ID, Parsing & Normalization
// ============================================

test('Suite 1.1: generateBookmarkId generates stable composite keys', () => {
  const id1 = generateBookmarkId('notebook_abc123', 'page_xyz789');
  assert.equal(id1, 'notebook_abc123:page_xyz789');

  const id2 = generateBookmarkId('pdf_doc456', 3);
  assert.equal(id2, 'pdf_doc456:3');

  const id3 = generateBookmarkId('pdf_doc456', 'pdf_doc456_pdf_3');
  assert.equal(id3, 'pdf_doc456:pdf_doc456_pdf_3');

  // Edge cases and error handling
  assert.throws(() => generateBookmarkId('', 'page_1'), /Bookmark documentId must be a non-empty string/);
  assert.throws(() => generateBookmarkId('doc_1', ''), /Bookmark pageIdOrNumber must be a non-empty string or positive number/);
});

test('Suite 1.2: parseBookmarkId correctly deconstructs composite keys', () => {
  const parsedNotebook = parseBookmarkId('notebook_123:page_456');
  assert.deepEqual(parsedNotebook, {
    documentId: 'notebook_123',
    pageIdOrNumber: 'page_456',
  });

  const parsedPdfNumeric = parseBookmarkId('doc_pdf_1:5');
  assert.deepEqual(parsedPdfNumeric, {
    documentId: 'doc_pdf_1',
    pageIdOrNumber: '5',
    pageNumber: 5,
  });

  const parsedPdfFormatted = parseBookmarkId('doc_pdf_1:doc_pdf_1_pdf_12');
  assert.deepEqual(parsedPdfFormatted, {
    documentId: 'doc_pdf_1',
    pageIdOrNumber: 'doc_pdf_1_pdf_12',
    pageNumber: 12,
  });

  assert.equal(parseBookmarkId('invalid_no_colon'), null);
  assert.equal(parseBookmarkId(':no_doc_id'), null);
  assert.equal(parseBookmarkId('no_page_id:'), null);
});

test('Suite 1.3: formatPdfPageId produces canonical page IDs', () => {
  assert.equal(formatPdfPageId('pdf_doc1', 1), 'pdf_doc1_pdf_1');
  assert.equal(formatPdfPageId('pdf_doc1', 42), 'pdf_doc1_pdf_42');

  assert.throws(() => formatPdfPageId('doc', 0), /Invalid PDF page number/);
  assert.throws(() => formatPdfPageId('doc', -5), /Invalid PDF page number/);
  assert.throws(() => formatPdfPageId('', 1), /Document ID is required/);
});

test('Suite 1.4: Normalizers enforce stable target associations immune to title edits', () => {
  const nbTarget = normalizeNotebookBookmarkTarget('nb_100', 'page_200');
  assert.equal(nbTarget.documentId, 'nb_100');
  assert.equal(nbTarget.pageId, 'page_200');
  assert.equal(nbTarget.bookmarkId, 'nb_100:page_200');
  assert.equal(nbTarget.documentType, 'notebook');

  const pdfTargetNum = normalizePdfBookmarkTarget('pdf_doc', 4);
  assert.equal(pdfTargetNum.documentId, 'pdf_doc');
  assert.equal(pdfTargetNum.pageId, 'pdf_doc_pdf_4');
  assert.equal(pdfTargetNum.pageNumber, 4);
  assert.equal(pdfTargetNum.bookmarkId, 'pdf_doc:4');
  assert.equal(pdfTargetNum.documentType, 'pdf');

  const pdfTargetStr = normalizePdfBookmarkTarget('pdf_doc', 'pdf_doc_pdf_7');
  assert.equal(pdfTargetStr.documentId, 'pdf_doc');
  assert.equal(pdfTargetStr.pageId, 'pdf_doc_pdf_7');
  assert.equal(pdfTargetStr.pageNumber, 7);
  assert.equal(pdfTargetStr.bookmarkId, 'pdf_doc:7');
});

// ============================================
// Suite 2: Schema Validation & Corruption Defense
// ============================================

test('Suite 2.1: validateBookmark enforces strict schema and sanitizes properties', () => {
  const validItem: Bookmark = {
    id: 'nb_1:page_1',
    documentId: 'nb_1',
    pageId: 'page_1',
    documentType: 'notebook',
    title: 'Chapter 1 Intro',
    createdAt: 1700000000000,
    workspaceId: 'ws_alpha',
  };

  const validated = validateBookmark(validItem);
  assert.ok(validated);
  assert.equal(validated.id, 'nb_1:page_1');
  assert.equal(validated.documentId, 'nb_1');
  assert.equal(validated.pageId, 'page_1');
  assert.equal(validated.title, 'Chapter 1 Intro');
  assert.equal(validated.workspaceId, 'ws_alpha');

  // Corrupted / missing documentId
  assert.equal(validateBookmark({ ...validItem, documentId: '' }), null);
  assert.equal(validateBookmark({ ...validItem, documentId: null }), null);

  // Corrupted documentType
  assert.equal(validateBookmark({ ...validItem, documentType: 'invalid_type' }), null);

  // Corrupted pageId
  assert.equal(validateBookmark({ ...validItem, pageId: '' }), null);

  // Missing ID gets synthesized from documentId & pageId
  const missingIdItem = {
    documentId: 'nb_2',
    pageId: 'page_2',
    documentType: 'notebook',
  };
  const synthesized = validateBookmark(missingIdItem);
  assert.ok(synthesized);
  assert.equal(synthesized.id, 'nb_2:page_2');
  assert.ok(synthesized.createdAt > 0);

  // Non-object inputs
  assert.equal(validateBookmark(null), null);
  assert.equal(validateBookmark('string'), null);
  assert.equal(validateBookmark(12345), null);
});

test('Suite 2.2: isBookmarkMatch correctly matches targets across variations', () => {
  const nbBookmark: Bookmark = {
    id: 'nb_1:page_99',
    documentId: 'nb_1',
    pageId: 'page_99',
    documentType: 'notebook',
    createdAt: 1000,
  };
  assert.ok(isBookmarkMatch(nbBookmark, 'nb_1', 'page_99'));
  assert.ok(!isBookmarkMatch(nbBookmark, 'nb_1', 'page_100'));
  assert.ok(!isBookmarkMatch(nbBookmark, 'nb_2', 'page_99'));

  const pdfBookmark: Bookmark = {
    id: 'pdf_1:3',
    documentId: 'pdf_1',
    pageId: 'pdf_1_pdf_3',
    pageNumber: 3,
    documentType: 'pdf',
    createdAt: 1000,
  };
  assert.ok(isBookmarkMatch(pdfBookmark, 'pdf_1', 3));
  assert.ok(isBookmarkMatch(pdfBookmark, 'pdf_1', '3'));
  assert.ok(isBookmarkMatch(pdfBookmark, 'pdf_1', 'pdf_1_pdf_3'));
  assert.ok(!isBookmarkMatch(pdfBookmark, 'pdf_1', 4));
  assert.ok(!isBookmarkMatch(pdfBookmark, 'other_pdf', 3));
});

// ============================================
// Suite 3: Repository Persistence & CRUD (Web / LocalStorage)
// ============================================

test('Suite 3.1: BookmarkRepository CRUD lifecycle via LocalStorage', async () => {
  const originalLocalStorage = (globalThis as any).localStorage;
  const originalWindow = (globalThis as any).window;

  const mockStorage = createMockLocalStorage();
  (globalThis as any).localStorage = mockStorage;
  delete (globalThis as any).window; // ensure web mode

  try {
    const repo = new BookmarkRepository();
    const wsId = 'ws_test_1';

    // 1. Initial state is empty
    const initial = await repo.loadBookmarks(wsId);
    assert.deepEqual(initial, []);

    // 2. Add notebook bookmark
    const bm1 = await repo.addBookmark(wsId, {
      documentId: 'notebook_alpha',
      pageId: 'page_1',
      documentType: 'notebook',
      title: 'Page 1',
    });
    assert.equal(bm1.id, 'notebook_alpha:page_1');
    assert.equal(bm1.documentId, 'notebook_alpha');
    assert.equal(bm1.title, 'Page 1');

    // 3. Add PDF bookmark
    const bm2 = await repo.addBookmark(wsId, {
      documentId: 'pdf_report',
      pageId: 'pdf_report_pdf_5',
      pageNumber: 5,
      documentType: 'pdf',
      title: 'Annual Report p.5',
    });
    assert.equal(bm2.id, 'pdf_report:5');
    assert.equal(bm2.pageNumber, 5);

    // 4. Retrieve all bookmarks
    const all = await repo.loadBookmarks(wsId);
    assert.equal(all.length, 2);

    // 5. Query bookmarks by documentId
    const nbOnly = await repo.getBookmarks(wsId, 'notebook_alpha');
    assert.equal(nbOnly.length, 1);
    assert.equal(nbOnly[0].id, 'notebook_alpha:page_1');

    const pdfOnly = await repo.getBookmarks(wsId, 'pdf_report');
    assert.equal(pdfOnly.length, 1);
    assert.equal(pdfOnly[0].id, 'pdf_report:5');

    // 6. Duplicate add is idempotent
    const duplicateAdd = await repo.addBookmark(wsId, {
      documentId: 'notebook_alpha',
      pageId: 'page_1',
      documentType: 'notebook',
    });
    assert.equal(duplicateAdd.id, bm1.id);
    const afterDup = await repo.loadBookmarks(wsId);
    assert.equal(afterDup.length, 2);

    // 7. Toggle existing bookmark -> removes it
    const toggleOff = await repo.toggleBookmark(wsId, 'notebook_alpha', 'page_1', 'notebook');
    assert.equal(toggleOff.bookmarked, false);
    const afterToggleOff = await repo.loadBookmarks(wsId);
    assert.equal(afterToggleOff.length, 1);
    assert.equal(afterToggleOff[0].id, 'pdf_report:5');

    // 8. Toggle removed bookmark -> restores/adds it
    const toggleOn = await repo.toggleBookmark(wsId, 'notebook_alpha', 'page_1', 'notebook', undefined, 'Page 1 Restored');
    assert.equal(toggleOn.bookmarked, true);
    assert.ok(toggleOn.bookmark);
    assert.equal(toggleOn.bookmark.id, 'notebook_alpha:page_1');
    assert.equal(toggleOn.bookmark.title, 'Page 1 Restored');

    // 9. Rename bookmark
    const renamed = await repo.renameBookmark(wsId, 'notebook_alpha:page_1', 'Executive Summary');
    assert.ok(renamed);
    assert.equal(renamed.title, 'Executive Summary');
    const verifyRename = await repo.getBookmarks(wsId, 'notebook_alpha');
    assert.equal(verifyRename[0].title, 'Executive Summary');

    // 10. Delete bookmark for page
    await repo.deleteBookmarkForPage(wsId, 'notebook_alpha', 'page_1');
    const afterPageDelete = await repo.getBookmarks(wsId, 'notebook_alpha');
    assert.equal(afterPageDelete.length, 0);

    // 11. Delete all bookmarks for document
    await repo.addBookmark(wsId, {
      documentId: 'doc_cleanup',
      pageId: 'doc_cleanup_pdf_1',
      pageNumber: 1,
      documentType: 'pdf',
    });
    await repo.addBookmark(wsId, {
      documentId: 'doc_cleanup',
      pageId: 'doc_cleanup_pdf_2',
      pageNumber: 2,
      documentType: 'pdf',
    });
    const beforeClean = await repo.getBookmarks(wsId, 'doc_cleanup');
    assert.equal(beforeClean.length, 2);

    await repo.deleteBookmarksForDocument(wsId, 'doc_cleanup');
    const afterClean = await repo.getBookmarks(wsId, 'doc_cleanup');
    assert.equal(afterClean.length, 0);

  } finally {
    (globalThis as any).localStorage = originalLocalStorage;
    (globalThis as any).window = originalWindow;
  }
});

test('Suite 3.2: Move bookmark between workspaces', async () => {
  const originalLocalStorage = (globalThis as any).localStorage;
  const mockStorage = createMockLocalStorage();
  (globalThis as any).localStorage = mockStorage;

  try {
    const repo = new BookmarkRepository();
    const ws1 = 'ws_source';
    const ws2 = 'ws_target';

    const bm = await repo.addBookmark(ws1, {
      documentId: 'doc_transfer',
      pageId: 'page_42',
      documentType: 'notebook',
      title: 'Transferred Page',
    });

    const moved = await repo.moveBookmark(ws1, bm.id, ws2);
    assert.ok(moved);
    assert.equal(moved.workspaceId, ws2);

    const fromWs1 = await repo.loadBookmarks(ws1);
    assert.equal(fromWs1.length, 0);

    const fromWs2 = await repo.loadBookmarks(ws2);
    assert.equal(fromWs2.length, 1);
    assert.equal(fromWs2[0].id, 'doc_transfer:page_42');
    assert.equal(fromWs2[0].title, 'Transferred Page');
  } finally {
    (globalThis as any).localStorage = originalLocalStorage;
  }
});

// ============================================
// Suite 4: Corrupted Data Recovery
// ============================================

test('Suite 4.1: Corrupted or malformed storage recovery without crashes', async () => {
  const originalLocalStorage = (globalThis as any).localStorage;
  const mockStorage = createMockLocalStorage();
  (globalThis as any).localStorage = mockStorage;

  try {
    const repo = new BookmarkRepository();
    const storageKey = `panvas.ws_corrupt.${BOOKMARKS_STORAGE_KEY}`;

    // Case 1: Malformed JSON syntax
    mockStorage.setItem(storageKey, '{"invalid_json": true, [malformed');
    const res1 = await repo.loadBookmarks('ws_corrupt');
    assert.deepEqual(res1, [], 'Must return empty array on invalid JSON syntax');

    // Case 2: Array containing corrupted, non-object, and missing-field records
    const mixedData = [
      null,
      'just a string',
      42,
      { title: 'No documentId or pageId' },
      { documentId: 'valid_doc', pageId: 'page_1', documentType: 'notebook', title: 'Survivor 1' },
      { documentId: 'bad_type', pageId: 'page_2', documentType: 'spreadsheet' },
      { documentId: 'valid_doc', pageId: 'valid_doc_pdf_3', pageNumber: 3, documentType: 'pdf', title: 'Survivor 2' },
    ];
    mockStorage.setItem(storageKey, JSON.stringify(mixedData));

    const survivors = await repo.loadBookmarks('ws_corrupt');
    assert.equal(survivors.length, 2, 'Only the 2 valid bookmarks must survive');
    assert.equal(survivors[0].title, 'Survivor 1');
    assert.equal(survivors[1].title, 'Survivor 2');

    // Case 3: Saving cleanses the stored JSON completely
    await repo.saveBookmarks('ws_corrupt', survivors);
    const reloaded = await repo.loadBookmarks('ws_corrupt');
    assert.equal(reloaded.length, 2);
  } finally {
    (globalThis as any).localStorage = originalLocalStorage;
  }
});

// ============================================
// Suite 5: Electron IPC Settings Persistence Path
// ============================================

test('Suite 5.1: Electron window.panvas.settings bridge integration', async () => {
  const originalWindow = (globalThis as any).window;
  const electronStore = new Map<string, any>();

  (globalThis as any).window = {
    panvas: {
      settings: {
        get: async (workspaceId: string | null, key: string) => {
          const storeKey = `${workspaceId ?? 'global'}:${key}`;
          return electronStore.get(storeKey) ?? null;
        },
        set: async (workspaceId: string | null, key: string, value: any) => {
          const storeKey = `${workspaceId ?? 'global'}:${key}`;
          electronStore.set(storeKey, JSON.parse(JSON.stringify(value)));
        },
      },
    },
  };

  try {
    const repo = new BookmarkRepository();
    const wsId = 'ws_electron_1';

    await repo.addBookmark(wsId, {
      documentId: 'doc_electron',
      pageId: 'page_elec_1',
      documentType: 'notebook',
      title: 'Electron Bookmark',
    });

    const storeKey = `${wsId}:${BOOKMARKS_STORAGE_KEY}`;
    assert.ok(electronStore.has(storeKey), 'Must store payload under settings key in Electron');
    const stored = electronStore.get(storeKey);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, 'doc_electron:page_elec_1');

    const loaded = await repo.loadBookmarks(wsId);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].title, 'Electron Bookmark');
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

// ============================================
// Suite 6: Isolation from Drawings and PDF Binaries
// ============================================

test('Suite 6.1: Bookmark operations remain strictly separated from drawing strokes and PDF binaries', async () => {
  const originalLocalStorage = (globalThis as any).localStorage;
  const mockStorage = createMockLocalStorage();
  (globalThis as any).localStorage = mockStorage;

  try {
    const repo = new BookmarkRepository();
    const wsId = 'ws_isolation';

    // Simulate pre-existing drawing stroke key and PDF binary key in storage
    const drawingKey = 'page_draw_101.drawing.json';
    const contentKey = 'page_draw_101.content.json';
    const pdfBinaryKey = 'pdf_binary_blob_sample';

    mockStorage.setItem(drawingKey, JSON.stringify({ strokes: [{ id: 'stroke_1', points: [0, 0, 10, 10] }] }));
    mockStorage.setItem(contentKey, JSON.stringify({ type: 'doc', content: ['rich text'] }));
    mockStorage.setItem(pdfBinaryKey, 'BINARY_BLOB_CONTENT_BYTES');

    // Perform multiple bookmark operations
    await repo.addBookmark(wsId, {
      documentId: 'notebook_iso',
      pageId: 'page_draw_101',
      documentType: 'notebook',
      title: 'Drawing Page',
    });
    await repo.toggleBookmark(wsId, 'notebook_iso', 'page_draw_101', 'notebook');
    await repo.addBookmark(wsId, {
      documentId: 'notebook_iso',
      pageId: 'page_draw_101',
      documentType: 'notebook',
      title: 'Re-added Drawing Page',
    });

    // Verify drawing strokes and content files are 100% byte-for-byte untouched
    const drawingAfter = mockStorage.getItem(drawingKey);
    assert.equal(drawingAfter, JSON.stringify({ strokes: [{ id: 'stroke_1', points: [0, 0, 10, 10] }] }));

    const contentAfter = mockStorage.getItem(contentKey);
    assert.equal(contentAfter, JSON.stringify({ type: 'doc', content: ['rich text'] }));

    const pdfAfter = mockStorage.getItem(pdfBinaryKey);
    assert.equal(pdfAfter, 'BINARY_BLOB_CONTENT_BYTES');
  } finally {
    (globalThis as any).localStorage = originalLocalStorage;
  }
});

// ============================================
// Suite 7: Zustand BookmarkStore Reactive Behavior
// ============================================

test('Suite 7.1: useBookmarkStore provides immediate reactive state and query operations', async () => {
  const originalLocalStorage = (globalThis as any).localStorage;
  const mockStorage = createMockLocalStorage();
  (globalThis as any).localStorage = mockStorage;

  try {
    const store = useBookmarkStore.getState();
    const wsId = 'ws_store_test';

    // Reset store
    await store.clearBookmarks(wsId);
    assert.equal(store.bookmarks.length, 0);

    // Add notebook bookmarks across different pages
    await store.addBookmark('nb_math', 'page_geom_1', 'notebook', undefined, 'Geometry Page 1', wsId);
    await store.addBookmark('nb_math', 'page_calc_2', 'notebook', undefined, 'Calculus Page 2', wsId);

    // Add PDF bookmarks
    await store.addBookmark('pdf_textbook', 15, 'pdf', 15, 'Chapter 3 Intro', wsId);
    await store.addBookmark('pdf_textbook', 42, 'pdf', 42, 'Formula Reference', wsId);

    // In-memory instant lookup checks
    assert.equal(useBookmarkStore.getState().isBookmarked('nb_math', 'page_geom_1'), true);
    assert.equal(useBookmarkStore.getState().isBookmarked('nb_math', 'page_calc_2'), true);
    assert.equal(useBookmarkStore.getState().isBookmarked('nb_math', 'page_unmarked'), false);

    assert.equal(useBookmarkStore.getState().isBookmarked('pdf_textbook', 15), true);
    assert.equal(useBookmarkStore.getState().isBookmarked('pdf_textbook', 'pdf_textbook_pdf_15'), true);
    assert.equal(useBookmarkStore.getState().isBookmarked('pdf_textbook', 42), true);
    assert.equal(useBookmarkStore.getState().isBookmarked('pdf_textbook', 99), false);

    // Document filtered queries
    const mathBookmarks = useBookmarkStore.getState().getBookmarksForDocument('nb_math');
    assert.equal(mathBookmarks.length, 2);

    const pdfBookmarks = useBookmarkStore.getState().getBookmarksForDocument('pdf_textbook');
    assert.equal(pdfBookmarks.length, 2);

    // Toggle off
    const toggledOff = await useBookmarkStore.getState().toggleBookmark('nb_math', 'page_geom_1', 'notebook', undefined, undefined, wsId);
    assert.equal(toggledOff, false);
    assert.equal(useBookmarkStore.getState().isBookmarked('nb_math', 'page_geom_1'), false);

    // Toggle on
    const toggledOn = await useBookmarkStore.getState().toggleBookmark('nb_math', 'page_geom_1', 'notebook', undefined, 'Geometry Page 1 Restored', wsId);
    assert.equal(toggledOn, true);
    assert.equal(useBookmarkStore.getState().isBookmarked('nb_math', 'page_geom_1'), true);

    // Simulate reload from storage
    useBookmarkStore.setState({ bookmarks: [], isLoaded: false });
    assert.equal(useBookmarkStore.getState().bookmarks.length, 0);

    await useBookmarkStore.getState().loadBookmarks(wsId);
    assert.equal(useBookmarkStore.getState().isLoaded, true);
    assert.equal(useBookmarkStore.getState().bookmarks.length, 4);

    // Clean up
    await store.clearBookmarks(wsId);
  } finally {
    (globalThis as any).localStorage = originalLocalStorage;
  }
});

// ============================================
// Suite 8: History Integration (Undo/Redo)
// ============================================

test('Suite 8.1: History command allows symmetric undo and redo without drawing corruption', async () => {
  const originalLocalStorage = (globalThis as any).localStorage;
  const mockStorage = createMockLocalStorage();
  (globalThis as any).localStorage = mockStorage;

  try {
    const store = useBookmarkStore.getState();
    const wsId = 'ws_history_test';
    await store.clearBookmarks(wsId);

    // Simulated history stack
    const undoStack: HistoryCommand[] = [];
    const redoStack: HistoryCommand[] = [];
    const historyManager = {
      pushExecuted: (cmd: HistoryCommand) => {
        undoStack.push(cmd);
        redoStack.length = 0;
      },
      undo: () => {
        const cmd = undoStack.pop();
        if (cmd) {
          cmd.undo();
          redoStack.push(cmd);
        }
      },
      redo: () => {
        const cmd = redoStack.pop();
        if (cmd) {
          cmd.execute();
          undoStack.push(cmd);
        }
      },
    };

    // 1. User bookmarks page 1 -> toggled on
    const isBookmarked = await toggleBookmarkWithHistory(historyManager, {
      documentId: 'nb_history_doc',
      pageIdOrNumber: 'page_1',
      documentType: 'notebook',
      title: 'Page 1',
      workspaceId: wsId,
    });
    assert.equal(isBookmarked, true);
    assert.equal(useBookmarkStore.getState().isBookmarked('nb_history_doc', 'page_1'), true);
    assert.equal(undoStack.length, 1);

    // 2. User presses Undo (Ctrl+Z)
    historyManager.undo();
    assert.equal(useBookmarkStore.getState().isBookmarked('nb_history_doc', 'page_1'), false, 'Bookmark must be removed after undo');
    assert.equal(redoStack.length, 1);

    // 3. User presses Redo (Ctrl+Y)
    historyManager.redo();
    assert.equal(useBookmarkStore.getState().isBookmarked('nb_history_doc', 'page_1'), true, 'Bookmark must be restored after redo');
    assert.equal(undoStack.length, 1);

    // 4. User unbookmarks page 1 -> toggled off
    const isBookmarked2 = await toggleBookmarkWithHistory(historyManager, {
      documentId: 'nb_history_doc',
      pageIdOrNumber: 'page_1',
      documentType: 'notebook',
      title: 'Page 1',
      workspaceId: wsId,
    });
    assert.equal(isBookmarked2, false);
    assert.equal(useBookmarkStore.getState().isBookmarked('nb_history_doc', 'page_1'), false);
    assert.equal(undoStack.length, 2);

    // 5. Undo unbookmark -> restores bookmark
    historyManager.undo();
    assert.equal(useBookmarkStore.getState().isBookmarked('nb_history_doc', 'page_1'), true, 'Undo of removal restores bookmark');

    // 6. Redo unbookmark -> removes bookmark
    historyManager.redo();
    assert.equal(useBookmarkStore.getState().isBookmarked('nb_history_doc', 'page_1'), false, 'Redo of removal removes bookmark');

    // Clean up
    await store.clearBookmarks(wsId);
  } finally {
    (globalThis as any).localStorage = originalLocalStorage;
  }
});
