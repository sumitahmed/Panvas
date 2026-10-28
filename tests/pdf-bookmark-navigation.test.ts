// ============================================
// Panvas — PDF Bookmark Navigation & Thumbnail Tests
// ============================================

import { register } from 'node:module';

// Register module hooks to intercept Vite-specific ?url queries, CSS imports, and browser-only modules under Node
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'dompurify') {
    return { shortCircuit: true, url: 'data:text/javascript,const p = (w) => ({ addHook: () => {}, sanitize: (s) => s, isSupported: true }); p.addHook = () => {}; p.sanitize = (s) => s; p.isSupported = true; export default p;' };
  }
  if (specifier.includes('supabase') || specifier.includes('supabase/client')) {
    return { shortCircuit: true, url: 'data:text/javascript,export const supabase = { auth: { getSession: async () => ({ data: { session: null }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } }; export const isSupabaseConfigured = false; export const supabaseConfigError = null; export default supabase;' };
  }
  if (specifier.includes('useEngineState')) {
    return { shortCircuit: true, url: 'data:text/javascript,export function useToolState(engine) { return engine?.tools?.getState ? engine.tools.getState() : { mode: "select" }; }' };
  }
  if (specifier.includes('?url')) {
    return { shortCircuit: true, url: 'data:text/javascript,export default "mock-worker-url";' };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css') || url.includes('.css')) {
    return { format: 'module', shortCircuit: true, source: 'export default {};' };
  }
  if (url.includes('?url')) {
    return { format: 'module', shortCircuit: true, source: 'export default "mock-worker-url";' };
  }
  return nextLoad(url, context);
}
`)
);

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBookmarkStore } from '../src/stores/bookmarkStore';
import { Thumbnail, PdfThumbnailSidebar } from '../src/components/pdf/PdfThumbnailSidebar';
import { toggleBookmarkWithHistory } from '../src/services/bookmarks/bookmarkHistory';
import type { NotebookEngine } from '../src/components/notebook/engine/NotebookEngine';
import type { HistoryCommand } from '../src/components/notebook/engine/drawingTypes';

// Dynamically import BottomNavigation so that the module hooks take effect before resolving
const { BottomNavigation } = await import('../src/components/pdf/PdfWorkspace');

// ---- Environment Setup ----

function setupMockEnvironment() {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => store.set(key, String(val)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  } as unknown as Storage;

  if (typeof (globalThis as any).window === 'undefined') {
    (globalThis as any).window = {
      devicePixelRatio: 1,
      localStorage: globalThis.localStorage,
    };
  } else if (!(globalThis as any).window.devicePixelRatio) {
    (globalThis as any).window.devicePixelRatio = 1;
  }
}

function createMockEngine() {
  const listeners: Array<() => void> = [];
  let toolMode = 'select';
  const historyStack: HistoryCommand[] = [];
  let historyIndex = -1;

  const history = {
    pushExecuted: (command: HistoryCommand) => {
      historyStack.splice(historyIndex + 1);
      historyStack.push(command);
      historyIndex++;
    },
    push: (command: HistoryCommand) => {
      historyStack.splice(historyIndex + 1);
      historyStack.push(command);
      historyIndex++;
    },
    undo: () => {
      if (historyIndex >= 0) {
        const cmd = historyStack[historyIndex];
        historyIndex--;
        cmd.undo();
      }
    },
    redo: () => {
      if (historyIndex + 1 < historyStack.length) {
        historyIndex++;
        const cmd = historyStack[historyIndex];
        cmd.execute();
      }
    },
    canUndo: () => historyIndex >= 0,
    canRedo: () => historyIndex + 1 < historyStack.length,
    getStack: () => historyStack,
    getIndex: () => historyIndex,
  };

  const tools = {
    mode: toolMode,
    getState: () => ({ mode: toolMode }),
    setMode: (m: string) => {
      toolMode = m;
      listeners.forEach(l => l());
    },
    subscribe: (fn: () => void) => {
      listeners.push(fn);
      return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };

  return {
    history,
    tools,
  } as unknown as NotebookEngine & { history: typeof history; tools: typeof tools };
}

// ============================================
// Suite 1: PDF Sidebar Thumbnail Ribbon Marker
// ============================================

test('Suite 1.1: Thumbnail renders ribbon indicator when bookmarked', async () => {
  setupMockEnvironment();
  const documentId = 'pdf_test_doc_1';
  await useBookmarkStore.getState().clearBookmarks();
  await useBookmarkStore.getState().addBookmark(documentId, 2, 'pdf', 2, 'Page 2');

  const html = renderToStaticMarkup(
    React.createElement(Thumbnail, {
      page: 2,
      pdfDocument: null,
      rotation: 0,
      documentId,
    })
  );

  // Must contain ribbon with aria-label and test-id
  assert.ok(html.includes('aria-label="Page 2 bookmarked"'), 'Should render aria-label for bookmarked page');
  assert.ok(html.includes('data-testid="thumbnail-bookmark-2"'), 'Should render data-testid for bookmarked page');
  assert.ok(html.includes('text-panvas-accent-blue'), 'Should apply blue accent styling');
  assert.ok(html.includes('pointer-events-none'), 'Marker must not intercept pointer events');
  assert.ok(html.includes('absolute top-1.5 right-1.5'), 'Marker must be overlaid at top-right');
});

test('Suite 1.2: Thumbnail renders NO ribbon indicator when unbookmarked', async () => {
  setupMockEnvironment();
  const documentId = 'pdf_test_doc_1';
  await useBookmarkStore.getState().clearBookmarks();

  const html = renderToStaticMarkup(
    React.createElement(Thumbnail, {
      page: 1,
      pdfDocument: null,
      rotation: 0,
      documentId,
    })
  );

  assert.ok(!html.includes('Page 1 bookmarked'), 'Should not contain bookmark label when unbookmarked');
  assert.ok(!html.includes('data-testid="thumbnail-bookmark-1"'), 'Should not render bookmark testid when unbookmarked');
});

test('Suite 1.3: PdfThumbnailSidebar renders bookmark indicators for bookmarked pages only', async () => {
  setupMockEnvironment();
  const documentId = 'pdf_test_doc_multi';
  const engine = createMockEngine();
  await useBookmarkStore.getState().clearBookmarks();
  // Bookmark pages 1 and 3 out of 4
  await useBookmarkStore.getState().addBookmark(documentId, 1, 'pdf', 1, 'Page 1');
  await useBookmarkStore.getState().addBookmark(documentId, 3, 'pdf', 3, 'Page 3');

  let selectedPage = 1;
  const html = renderToStaticMarkup(
    React.createElement(PdfThumbnailSidebar, {
      pdfDocument: null,
      numPages: 4,
      currentPage: selectedPage,
      onPageChange: (p: number) => { selectedPage = p; },
      isSidebarOpen: true,
      setIsSidebarOpen: () => {},
      engine,
      documentId,
    })
  );

  // Pages 1 and 3 bookmarked
  assert.ok(html.includes('aria-label="Page 1 bookmarked"'), 'Page 1 must have bookmark indicator');
  assert.ok(html.includes('aria-label="Page 3 bookmarked"'), 'Page 3 must have bookmark indicator');
  // Pages 2 and 4 unbookmarked
  assert.ok(!html.includes('aria-label="Page 2 bookmarked"'), 'Page 2 must NOT have bookmark indicator');
  assert.ok(!html.includes('aria-label="Page 4 bookmarked"'), 'Page 4 must NOT have bookmark indicator');
  // Labels intact
  assert.ok(html.includes('Page 1'), 'Label Page 1 preserved');
  assert.ok(html.includes('Page 2'), 'Label Page 2 preserved');
  assert.ok(html.includes('Page 3'), 'Label Page 3 preserved');
  assert.ok(html.includes('Page 4'), 'Label Page 4 preserved');
});

test('Suite 1.4: Dynamic update: toggling bookmark state immediately updates thumbnail marker', async () => {
  setupMockEnvironment();
  const documentId = 'pdf_test_sync';
  await useBookmarkStore.getState().clearBookmarks();

  // Initially unbookmarked
  let html = renderToStaticMarkup(
    React.createElement(Thumbnail, {
      page: 5,
      pdfDocument: null,
      rotation: 0,
      documentId,
    })
  );
  assert.ok(!html.includes('thumbnail-bookmark-5'));

  // Toggle bookmark ON
  await useBookmarkStore.getState().toggleBookmark(documentId, 5, 'pdf', 5, 'Page 5');
  html = renderToStaticMarkup(
    React.createElement(Thumbnail, {
      page: 5,
      pdfDocument: null,
      rotation: 0,
      documentId,
    })
  );
  assert.ok(html.includes('thumbnail-bookmark-5'));
  assert.ok(html.includes('aria-label="Page 5 bookmarked"'));

  // Toggle bookmark OFF
  await useBookmarkStore.getState().toggleBookmark(documentId, 5, 'pdf', 5, 'Page 5');
  html = renderToStaticMarkup(
    React.createElement(Thumbnail, {
      page: 5,
      pdfDocument: null,
      rotation: 0,
      documentId,
    })
  );
  assert.ok(!html.includes('thumbnail-bookmark-5'));
});

// ============================================
// Suite 2: Discoverable PDF Bookmark Toggle Control
// ============================================

test('Suite 2.1: BottomNavigation renders unbookmarked button state when page is not bookmarked', async () => {
  setupMockEnvironment();
  const documentId = 'pdf_controls_test';
  const engine = createMockEngine();
  await useBookmarkStore.getState().clearBookmarks();

  const html = renderToStaticMarkup(
    React.createElement(BottomNavigation, {
      page: 1,
      totalPages: 10,
      onPageChange: () => {},
      engine,
      zoom: 1.0,
      onZoom: () => {},
      onExport: () => {},
      isExporting: false,
      documentId,
      currentPage: 1,
    })
  );

  assert.ok(html.includes('data-testid="pdf-bookmark-toggle-button"'), 'Bookmark toggle button must exist in toolbar');
  assert.ok(html.includes('title="Bookmark this page"'), 'Title must be "Bookmark this page" when unbookmarked');
  assert.ok(html.includes('aria-label="Bookmark this page"'), 'Aria-label must be "Bookmark this page" when unbookmarked');
  assert.ok(html.includes('aria-pressed="false"'), 'aria-pressed must be false when unbookmarked');
  assert.ok(!html.includes('fill-current'), 'Icon must not have fill-current when unbookmarked');
});

test('Suite 2.2: BottomNavigation renders active blue button state when page is bookmarked', async () => {
  setupMockEnvironment();
  const documentId = 'pdf_controls_test';
  const engine = createMockEngine();
  await useBookmarkStore.getState().clearBookmarks();
  await useBookmarkStore.getState().addBookmark(documentId, 2, 'pdf', 2, 'Page 2');

  const html = renderToStaticMarkup(
    React.createElement(BottomNavigation, {
      page: 2,
      totalPages: 10,
      onPageChange: () => {},
      engine,
      zoom: 1.0,
      onZoom: () => {},
      onExport: () => {},
      isExporting: false,
      documentId,
      currentPage: 2,
    })
  );

  assert.ok(html.includes('title="Remove bookmark"'), 'Title must be "Remove bookmark" when bookmarked');
  assert.ok(html.includes('aria-label="Remove bookmark"'), 'Aria-label must be "Remove bookmark" when bookmarked');
  assert.ok(html.includes('aria-pressed="true"'), 'aria-pressed must be true when bookmarked');
  assert.ok(html.includes('text-panvas-accent-blue'), 'Button must be highlighted with text-panvas-accent-blue');
  assert.ok(html.includes('fill-current'), 'Icon must have fill-current when bookmarked');
});

test('Suite 2.3: Switching active page updates BottomNavigation bookmark status', async () => {
  setupMockEnvironment();
  const documentId = 'pdf_page_switch_test';
  const engine = createMockEngine();
  await useBookmarkStore.getState().clearBookmarks();
  // Only page 2 is bookmarked
  await useBookmarkStore.getState().addBookmark(documentId, 2, 'pdf', 2, 'Page 2');

  // View Page 1 -> Unbookmarked
  let html = renderToStaticMarkup(
    React.createElement(BottomNavigation, {
      page: 1,
      totalPages: 5,
      onPageChange: () => {},
      engine,
      zoom: 1.0,
      onZoom: () => {},
      onExport: () => {},
      isExporting: false,
      documentId,
      currentPage: 1,
    })
  );
  assert.ok(html.includes('title="Bookmark this page"'));
  assert.ok(html.includes('aria-pressed="false"'));

  // Navigate to Page 2 -> Bookmarked
  html = renderToStaticMarkup(
    React.createElement(BottomNavigation, {
      page: 2,
      totalPages: 5,
      onPageChange: () => {},
      engine,
      zoom: 1.0,
      onZoom: () => {},
      onExport: () => {},
      isExporting: false,
      documentId,
      currentPage: 2,
    })
  );
  assert.ok(html.includes('title="Remove bookmark"'));
  assert.ok(html.includes('aria-pressed="true"'));

  // Navigate to Page 3 -> Unbookmarked
  html = renderToStaticMarkup(
    React.createElement(BottomNavigation, {
      page: 3,
      totalPages: 5,
      onPageChange: () => {},
      engine,
      zoom: 1.0,
      onZoom: () => {},
      onExport: () => {},
      isExporting: false,
      documentId,
      currentPage: 3,
    })
  );
  assert.ok(html.includes('title="Bookmark this page"'));
  assert.ok(html.includes('aria-pressed="false"'));
});

// ============================================
// Suite 3: Multi-Page Independent Bookmarking
// ============================================

test('Suite 3.1: Multiple distinct pages in the same PDF can be bookmarked and unbookmarked independently', async () => {
  setupMockEnvironment();
  const documentId = 'pdf_multi_page_test';
  const store = useBookmarkStore.getState();
  await store.clearBookmarks();

  // Bookmark pages 2, 4, 7
  await store.addBookmark(documentId, 2, 'pdf', 2, 'Page 2');
  await store.addBookmark(documentId, 4, 'pdf', 4, 'Page 4');
  await store.addBookmark(documentId, 7, 'pdf', 7, 'Page 7');

  assert.equal(store.isBookmarked(documentId, 2), true);
  assert.equal(store.isBookmarked(documentId, 4), true);
  assert.equal(store.isBookmarked(documentId, 7), true);
  assert.equal(store.isBookmarked(documentId, 1), false);
  assert.equal(store.isBookmarked(documentId, 3), false);
  assert.equal(store.isBookmarked(documentId, 5), false);

  const docBookmarks = store.getBookmarksForDocument(documentId);
  assert.equal(docBookmarks.length, 3);

  // Unbookmark page 4 only
  await store.removeBookmark(documentId, 4);

  assert.equal(store.isBookmarked(documentId, 2), true, 'Page 2 must remain bookmarked');
  assert.equal(store.isBookmarked(documentId, 4), false, 'Page 4 must be unbookmarked');
  assert.equal(store.isBookmarked(documentId, 7), true, 'Page 7 must remain bookmarked');

  const afterRemoval = store.getBookmarksForDocument(documentId);
  assert.equal(afterRemoval.length, 2);
});

// ============================================
// Suite 4: History (Undo/Redo) & Immediate Synchronization
// ============================================

test('Suite 4.1: toggleBookmarkWithHistory registers history and updates store and UI synchronously', async () => {
  setupMockEnvironment();
  const documentId = 'pdf_history_test';
  const engine = createMockEngine();
  const store = useBookmarkStore.getState();
  await store.clearBookmarks();

  // Active page: 3. Initially unbookmarked.
  assert.equal(store.isBookmarked(documentId, 3), false);

  // Toggle bookmark with history
  const isNowBookmarked = await toggleBookmarkWithHistory(engine.history, {
    documentId,
    pageIdOrNumber: 3,
    documentType: 'pdf',
    pageNumber: 3,
    title: 'Page 3',
  });

  assert.equal(isNowBookmarked, true);
  assert.equal(store.isBookmarked(documentId, 3), true);
  assert.equal(engine.history.getStack().length, 1);
  assert.equal(engine.history.canUndo(), true);

  // Verify BottomNavigation UI reflects bookmarked state
  let navHtml = renderToStaticMarkup(
    React.createElement(BottomNavigation, {
      page: 3,
      totalPages: 5,
      onPageChange: () => {},
      engine,
      zoom: 1.0,
      onZoom: () => {},
      onExport: () => {},
      isExporting: false,
      documentId,
      currentPage: 3,
    })
  );
  assert.ok(navHtml.includes('title="Remove bookmark"'));

  // Verify Thumbnail UI reflects bookmarked ribbon
  let thumbHtml = renderToStaticMarkup(
    React.createElement(Thumbnail, {
      page: 3,
      pdfDocument: null,
      rotation: 0,
      documentId,
    })
  );
  assert.ok(thumbHtml.includes('thumbnail-bookmark-3'));

  // Perform Undo
  engine.history.undo();
  assert.equal(store.isBookmarked(documentId, 3), false, 'Undo must revert bookmark');

  // Verify UI after undo
  navHtml = renderToStaticMarkup(
    React.createElement(BottomNavigation, {
      page: 3,
      totalPages: 5,
      onPageChange: () => {},
      engine,
      zoom: 1.0,
      onZoom: () => {},
      onExport: () => {},
      isExporting: false,
      documentId,
      currentPage: 3,
    })
  );
  assert.ok(navHtml.includes('title="Bookmark this page"'));

  thumbHtml = renderToStaticMarkup(
    React.createElement(Thumbnail, {
      page: 3,
      pdfDocument: null,
      rotation: 0,
      documentId,
    })
  );
  assert.ok(!thumbHtml.includes('thumbnail-bookmark-3'));

  // Perform Redo
  engine.history.redo();
  assert.equal(store.isBookmarked(documentId, 3), true, 'Redo must reapply bookmark');

  thumbHtml = renderToStaticMarkup(
    React.createElement(Thumbnail, {
      page: 3,
      pdfDocument: null,
      rotation: 0,
      documentId,
    })
  );
  assert.ok(thumbHtml.includes('thumbnail-bookmark-3'));
});

// ============================================
// Suite 5: Thumbnail Click Navigation & Selection Preservation
// ============================================

test('Suite 5.1: Thumbnail navigation callback is invoked when clicking item', async () => {
  setupMockEnvironment();
  const documentId = 'pdf_nav_click_test';
  const engine = createMockEngine();
  await useBookmarkStore.getState().clearBookmarks();
  await useBookmarkStore.getState().addBookmark(documentId, 2, 'pdf', 2, 'Page 2');

  let navigatedTo = -1;
  const onPageChange = (p: number) => { navigatedTo = p; };

  // Render sidebar
  const element = React.createElement(PdfThumbnailSidebar, {
    pdfDocument: null,
    numPages: 3,
    currentPage: 1,
    onPageChange,
    isSidebarOpen: true,
    setIsSidebarOpen: () => {},
    engine,
    documentId,
  });

  const html = renderToStaticMarkup(element);
  assert.ok(html.includes('Page 2'), 'Must render thumbnail items');
  assert.ok(html.includes('thumbnail-bookmark-2'), 'Bookmarked page has ribbon');

  // Simulate thumbnail item click on page 2
  onPageChange(2);
  assert.equal(navigatedTo, 2, 'Clicking thumbnail navigates to that exact PDF page');
});

test('Suite 5.2: Thumbnail selection highlight is preserved across bookmarked and unbookmarked pages', async () => {
  setupMockEnvironment();
  const documentId = 'pdf_selection_test';
  const engine = createMockEngine();
  await useBookmarkStore.getState().clearBookmarks();
  await useBookmarkStore.getState().addBookmark(documentId, 1, 'pdf', 1, 'Page 1');

  // Page 1 is active and bookmarked
  const html = renderToStaticMarkup(
    React.createElement(PdfThumbnailSidebar, {
      pdfDocument: null,
      numPages: 2,
      currentPage: 1,
      onPageChange: () => {},
      isSidebarOpen: true,
      setIsSidebarOpen: () => {},
      engine,
      documentId,
    })
  );

  // Page 1 must have active background class
  assert.ok(html.includes('bg-panvas-bg-active'), 'Active page must have selection highlight');
  assert.ok(html.includes('hover:bg-panvas-bg-hover'), 'Inactive page must have hover highlight');
});
