// ============================================
// Panvas — Notebook Bookmark Navigation Tests
// Milestone M2: Notebook Navigation Indicators & Controls
// ============================================

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

import { useBookmarkStore } from '../src/stores/bookmarkStore';
import { createBookmarkHistoryCommand, toggleBookmarkWithHistory } from '../src/services/bookmarks/bookmarkHistory';
import { HistoryManager } from '../src/components/notebook/engine/HistoryManager';
import { LayerManager } from '../src/components/notebook/engine/LayerManager';
import type { PageProperties } from '../src/components/notebook/engine/drawingTypes';

// ---- Environment Polyfill ----

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    length: 0,
  } as unknown as Storage;
}

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis;
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

test('Milestone M2: Notebook Bookmark Navigation & Page Markers Test Suite', async (t) => {
  // Setup Vite SSR server with targeted module transform for isolated UI testing
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: { '@': path.resolve('src') } },
    plugins: [
      {
        name: 'test-isolation-transform',
        transform(code, id) {
          const normalized = id.replaceAll('\\', '/');

          // Prevent external Supabase client from throwing on undefined import.meta.env
          if (normalized.includes('services/supabase/client')) {
            return {
              code: 'export const supabase = null; export const isSupabaseConfigured = false; export const supabaseConfigError = null;',
              map: null,
            };
          }

          // In WorkspaceTree, connect directly to global test mock states and mock useLocation to avoid SSR errors
          if (normalized.includes('components/workspace/WorkspaceTree.tsx')) {
            return {
              code: code
                .replace(
                  /import \{ useLocation \} from [^;]+;/,
                  'const useLocation = () => ["/app", () => {}];'
                )
                .replace(
                  /import \{ useWorkspaceStore \} from [^;]+;/,
                  'const useWorkspaceStore = Object.assign((sel) => sel ? sel(globalThis.__mockWsState) : globalThis.__mockWsState, { getState: () => globalThis.__mockWsState });'
                )
                .replace(
                  /import \{ useBookmarkStore \} from [^;]+;/,
                  'const useBookmarkStore = Object.assign((sel) => sel ? sel(globalThis.__mockBmState) : globalThis.__mockBmState, { getState: () => globalThis.__mockBmState });'
                ),
              map: null,
            };
          }

          // In PageRenderer, connect to global bookmark state
          if (normalized.includes('components/notebook/PageRenderer.tsx')) {
            return {
              code: code.replace(
                /import \{ useBookmarkStore \} from [^;]+;/,
                'const useBookmarkStore = Object.assign((sel) => sel ? sel(globalThis.__mockBmState) : globalThis.__mockBmState, { getState: () => globalThis.__mockBmState });'
              ),
              map: null,
            };
          }

          // In NotebookPageUtilities, connect to global bookmark state
          if (normalized.includes('components/notebook/NotebookPageUtilities.tsx')) {
            return {
              code: code.replace(
                /import \{ useBookmarkStore \} from [^;]+;/,
                'const useBookmarkStore = Object.assign((sel) => sel ? sel(globalThis.__mockBmState) : globalThis.__mockBmState, { getState: () => globalThis.__mockBmState });'
              ),
              map: null,
            };
          }
        },
      },
    ],
  });

  t.after(async () => {
    await server.close();
  });

  // Load components through Vite SSR
  const { WorkspaceTree } = await server.ssrLoadModule('/src/components/workspace/WorkspaceTree.tsx');
  const { NotebookPageUtilities } = await server.ssrLoadModule('/src/components/notebook/NotebookPageUtilities.tsx');
  const { PageRenderer } = await server.ssrLoadModule('/src/components/notebook/PageRenderer.tsx');

  interface MockWorkspaceState {
    workspaces: Array<{ id: string; name: string }>;
    notebooks: Array<{ id: string; workspaceId: string; folderId: string | null; name: string; isPinned?: boolean; isExpanded?: boolean }>;
    notebookSections: Array<{ id: string; notebookId: string; name: string; isExpanded: boolean }>;
    notebookPages: Array<{ id: string; notebookId: string; sectionId: string; title: string }>;
    folders: any[];
    canvasFiles: any[];
    activePageId: string;
    activeNotebookId: string;
    setActivePage: (id: string) => void;
  }

  interface MockBookmarkState {
    bookmarks: Array<{ id: string; documentId: string; pageId: string; documentType: 'notebook' | 'pdf'; title?: string }>;
    isBookmarked: (documentId: string, pageId: string) => boolean;
    addBookmark: (documentId: string, pageId: string, type: 'notebook' | 'pdf', pageNum?: number, title?: string) => Promise<any>;
    removeBookmark: (documentId: string, pageId: string) => Promise<void>;
    toggleBookmark: (documentId: string, pageId: string, type: 'notebook' | 'pdf', pageNum?: number, title?: string) => Promise<boolean>;
  }

  function resetMockState() {
    const bookmarkedSet = new Set<string>();

    const bmState: MockBookmarkState = {
      bookmarks: [],
      isBookmarked: (docId: string, pageId: string) => bookmarkedSet.has(`${docId}:${pageId}`),
      addBookmark: async (docId: string, pageId: string, type: 'notebook' | 'pdf', pageNum?: number, title?: string) => {
        bookmarkedSet.add(`${docId}:${pageId}`);
        const record = { id: `${docId}:${pageId}`, documentId: docId, pageId, documentType: type, title };
        bmState.bookmarks = [record, ...bmState.bookmarks.filter(b => b.id !== record.id)];
        return record;
      },
      removeBookmark: async (docId: string, pageId: string) => {
        bookmarkedSet.delete(`${docId}:${pageId}`);
        bmState.bookmarks = bmState.bookmarks.filter(b => b.id !== `${docId}:${pageId}`);
      },
      toggleBookmark: async (docId: string, pageId: string, type: 'notebook' | 'pdf', pageNum?: number, title?: string) => {
        if (bookmarkedSet.has(`${docId}:${pageId}`)) {
          await bmState.removeBookmark(docId, pageId);
          return false;
        } else {
          await bmState.addBookmark(docId, pageId, type, pageNum, title);
          return true;
        }
      },
    };

    const wsState: MockWorkspaceState = {
      workspaces: [{ id: 'ws_alpha', name: 'Alpha Workspace' }],
      notebooks: [
        { id: 'nb_std', workspaceId: 'ws_alpha', folderId: null, name: 'Standard Notebook', isPinned: false, isExpanded: true },
        { id: 'nb_fav', workspaceId: 'ws_alpha', folderId: null, name: 'Favorite Notebook', isPinned: true, isExpanded: true },
      ],
      notebookSections: [
        { id: 'sec_1', notebookId: 'nb_std', name: 'Section 1', isExpanded: true },
        { id: 'sec_fav', notebookId: 'nb_fav', name: 'Section Fav', isExpanded: true },
      ],
      notebookPages: [
        { id: 'page_1', notebookId: 'nb_std', sectionId: 'sec_1', title: 'Page One' },
        { id: 'page_2', notebookId: 'nb_std', sectionId: 'sec_1', title: 'Page Two' },
        { id: 'page_fav_child', notebookId: 'nb_fav', sectionId: 'sec_fav', title: 'Fav Child Page' },
      ],
      folders: [],
      canvasFiles: [],
      activePageId: 'page_1',
      activeNotebookId: 'nb_std',
      setActivePage: (id: string) => {
        wsState.activePageId = id;
      },
    };

    (globalThis as any).__mockWsState = wsState;
    (globalThis as any).__mockBmState = bmState;

    return { wsState, bmState };
  }

  function renderTree(workspaceId: string) {
    return renderToStaticMarkup(
      React.createElement(WorkspaceTree, { workspaceId })
    );
  }

  function createMockEngine() {
    return {
      history: new HistoryManager(),
      layers: new LayerManager(),
      audio: {
        getAll: () => [],
      },
    } as any;
  }

  // ============================================
  // Suite 1: Left Navigation Tree Bookmark Indicator (WorkspaceTree.tsx)
  // ============================================

  await t.test('Suite 1.1: PageNode renders no bookmark indicator when page is unbookmarked', () => {
    resetMockState();
    const html = renderTree('ws_alpha');

    assert.match(html, /Page One/);
    assert.match(html, /Page Two/);
    assert.doesNotMatch(html, /aria-label="Bookmarked page"/);
    assert.doesNotMatch(html, /text-panvas-accent-blue/);
  });

  await t.test('Suite 1.2: PageNode renders compact blue Bookmark trailing indicator when bookmarked', async () => {
    const { bmState } = resetMockState();
    await bmState.addBookmark('nb_std', 'page_1', 'notebook', undefined, 'Page One');

    const html = renderTree('ws_alpha');

    assert.match(html, /aria-label="Bookmarked page"/);
    assert.match(html, /text-panvas-accent-blue/);
    assert.match(html, /fill-panvas-accent-blue/);
    assert.match(html, /shrink-0/);
  });

  await t.test('Suite 1.3: Unbookmarked pages remain visually identical to original UI', async () => {
    const { bmState } = resetMockState();
    await bmState.addBookmark('nb_std', 'page_1', 'notebook', undefined, 'Page One');

    const html = renderTree('ws_alpha');

    // Exactly 1 bookmarked page indicator
    const matches = html.match(/aria-label="Bookmarked page"/g);
    assert.equal(matches?.length, 1);

    // Page Two does not have the bookmark indicator
    const pageTwoIndex = html.indexOf('Page Two');
    assert.ok(pageTwoIndex > 0);
    const pageTwoSnippet = html.slice(pageTwoIndex, pageTwoIndex + 300);
    assert.doesNotMatch(pageTwoSnippet, /aria-label="Bookmarked page"/);
  });

  await t.test('Suite 1.4: Multiple pages in same section can be bookmarked independently in tree', async () => {
    const { bmState } = resetMockState();
    await bmState.addBookmark('nb_std', 'page_1', 'notebook');
    await bmState.addBookmark('nb_std', 'page_2', 'notebook');

    const html = renderTree('ws_alpha');
    const matches = html.match(/aria-label="Bookmarked page"/g);
    assert.equal(matches?.length, 2);

    await bmState.removeBookmark('nb_std', 'page_2');
    const htmlAfter = renderTree('ws_alpha');
    const matchesAfter = htmlAfter.match(/aria-label="Bookmarked page"/g);
    assert.equal(matchesAfter?.length, 1);
  });

  // ============================================
  // Suite 2: Independence of Page Bookmarks and Notebook Favorites
  // ============================================

  await t.test('Suite 2.1: Favorites use amber Star while page bookmarks use blue Bookmark', async () => {
    const { bmState } = resetMockState();
    await bmState.addBookmark('nb_std', 'page_1', 'notebook');

    const html = renderTree('ws_alpha');

    // Amber star on Favorite notebook
    assert.match(html, /text-panvas-accent-amber fill-panvas-accent-amber/);
    // Blue bookmark on Bookmarked page
    assert.match(html, /text-panvas-accent-blue fill-panvas-accent-blue shrink-0/);
  });

  await t.test('Suite 2.2: Toggling notebook Favorite does not change page bookmark state', async () => {
    const { wsState, bmState } = resetMockState();
    await bmState.addBookmark('nb_std', 'page_1', 'notebook');
    assert.equal(bmState.isBookmarked('nb_std', 'page_1'), true);

    // Toggle favorite on nb_std
    wsState.notebooks = wsState.notebooks.map(nb => nb.id === 'nb_std' ? { ...nb, isPinned: true } : nb);
    assert.equal(bmState.isBookmarked('nb_std', 'page_1'), true);

    // Unpin nb_fav
    wsState.notebooks = wsState.notebooks.map(nb => nb.id === 'nb_fav' ? { ...nb, isPinned: false } : nb);
    assert.equal(bmState.isBookmarked('nb_std', 'page_1'), true);
  });

  await t.test('Suite 2.3: Bookmarking a page inside a favorite notebook preserves distinct state', async () => {
    const { bmState } = resetMockState();
    await bmState.addBookmark('nb_fav', 'page_fav_child', 'notebook');

    assert.equal(bmState.isBookmarked('nb_fav', 'page_fav_child'), true);
    assert.equal(bmState.isBookmarked('nb_std', 'page_1'), false);

    const html = renderTree('ws_alpha');
    // Both amber star and blue bookmark appear
    assert.match(html, /text-panvas-accent-amber fill-panvas-accent-amber/);
    assert.match(html, /aria-label="Bookmarked page"/);
  });

  // ============================================
  // Suite 3: Discoverable Bookmark Toggle Control (NotebookPageUtilities.tsx)
  // ============================================

  await t.test('Suite 3.1: Bookmark toggle button renders with Bookmark this page when unbookmarked', () => {
    resetMockState();
    const mockEngine = createMockEngine();

    const html = renderToStaticMarkup(
      React.createElement(NotebookPageUtilities, {
        engine: mockEngine,
        workspaceId: 'ws_alpha',
        notebookId: 'nb_std',
        ownerId: 'page_1',
        onChange: () => {},
      })
    );

    assert.match(html, /aria-label="Bookmark this page"/);
    assert.match(html, /title="Bookmark this page"/);
    assert.match(html, /text-panvas-text-tertiary hover:text-panvas-text-primary/);
    assert.doesNotMatch(html, /bg-panvas-accent-blue\/10/);
  });

  await t.test('Suite 3.2: Toggling bookmark updates button to Remove bookmark with active styling', async () => {
    const { bmState } = resetMockState();
    const mockEngine = createMockEngine();

    await bmState.toggleBookmark('nb_std', 'page_1', 'notebook', undefined, 'Page One');
    assert.equal(bmState.isBookmarked('nb_std', 'page_1'), true);

    const html = renderToStaticMarkup(
      React.createElement(NotebookPageUtilities, {
        engine: mockEngine,
        workspaceId: 'ws_alpha',
        notebookId: 'nb_std',
        ownerId: 'page_1',
        onChange: () => {},
      })
    );

    assert.match(html, /aria-label="Remove bookmark"/);
    assert.match(html, /title="Remove bookmark"/);
    assert.match(html, /text-panvas-accent-blue bg-panvas-accent-blue\/10/);
    assert.match(html, /fill-current/);
  });

  await t.test('Suite 3.3: Toggle bookmark with history registers undoable action in HistoryManager', async () => {
    const { bmState } = resetMockState();
    const history = new HistoryManager();

    assert.equal(bmState.isBookmarked('nb_std', 'page_1'), false);
    assert.equal(history.canUndo(), false);

    // Create history command for bookmark addition
    const wasBookmarked = bmState.isBookmarked('nb_std', 'page_1');
    await bmState.toggleBookmark('nb_std', 'page_1', 'notebook');

    const command = {
      description: 'Add bookmark on notebook page page_1',
      execute: () => { bmState.addBookmark('nb_std', 'page_1', 'notebook'); },
      undo: () => { bmState.removeBookmark('nb_std', 'page_1'); },
    };
    history.pushExecuted(command);

    assert.equal(bmState.isBookmarked('nb_std', 'page_1'), true);
    assert.equal(history.canUndo(), true);

    // Undo operation
    history.undo();
    assert.equal(bmState.isBookmarked('nb_std', 'page_1'), false);
    assert.equal(history.canRedo(), true);

    // Redo operation
    history.redo();
    assert.equal(bmState.isBookmarked('nb_std', 'page_1'), true);
  });

  await t.test('Suite 3.4: Compact utility menu trigger renders with proper aria and title attributes', async () => {
    const { bmState } = resetMockState();
    const mockEngine = createMockEngine();

    await bmState.addBookmark('nb_std', 'page_1', 'notebook');

    const html = renderToStaticMarkup(
      React.createElement(NotebookPageUtilities, {
        engine: mockEngine,
        workspaceId: 'ws_alpha',
        notebookId: 'nb_std',
        ownerId: 'page_1',
        onChange: () => {},
        compact: true,
      })
    );

    assert.match(html, /title="Page utilities"/);
    assert.match(html, /aria-label="Page utilities"/);
    assert.match(html, /aria-expanded="false"/);
  });

  // ============================================
  // Suite 4: Non-Obstructive Page Canvas Marker (PageRenderer.tsx)
  // ============================================

  await t.test('Suite 4.1: PageRenderer renders no corner marker when page is unbookmarked', () => {
    resetMockState();

    const html = renderToStaticMarkup(
      React.createElement(PageRenderer, {
        id: 'page_2',
        width: 800,
        height: 1100,
        properties: mockProperties,
        pageNumberText: '1 / 2',
      })
    );

    assert.match(html, /id="page-page_2"/);
    assert.match(html, /1 \/ 2/);
    assert.doesNotMatch(html, /data-testid="page-bookmark-marker"/);
    assert.doesNotMatch(html, /aria-label="Bookmarked page marker"/);
  });

  await t.test('Suite 4.2: PageRenderer renders corner marker when page is bookmarked in store', async () => {
    const { bmState } = resetMockState();
    await bmState.addBookmark('nb_std', 'page_1', 'notebook');

    const html = renderToStaticMarkup(
      React.createElement(PageRenderer, {
        id: 'page_1',
        width: 800,
        height: 1100,
        properties: mockProperties,
        pageNumberText: '1 / 2',
      })
    );

    assert.match(html, /data-testid="page-bookmark-marker"/);
    assert.match(html, /aria-label="Bookmarked page marker"/);
    assert.match(html, /border-t-panvas-accent-blue/);
    assert.match(html, /text-white fill-white/);
  });

  await t.test('Suite 4.3: Corner marker strictly enforces pointer-events-none and user-select-none', async () => {
    const { bmState } = resetMockState();
    await bmState.addBookmark('nb_std', 'page_1', 'notebook');

    const html = renderToStaticMarkup(
      React.createElement(PageRenderer, {
        id: 'page_1',
        width: 800,
        height: 1100,
        properties: mockProperties,
      })
    );

    const markerStart = html.indexOf('data-testid="page-bookmark-marker"');
    assert.ok(markerStart > 0, 'Marker must exist in HTML');
    const markerSnippet = html.slice(markerStart - 10, markerStart + 350);

    assert.match(markerSnippet, /pointer-events-none/);
    assert.match(markerSnippet, /select-none/);
    assert.match(markerSnippet, /absolute top-0 right-0/);
  });

  await t.test('Suite 4.4: Explicit isBookmarked prop overrides store state in PageRenderer', () => {
    resetMockState();

    const htmlTrue = renderToStaticMarkup(
      React.createElement(PageRenderer, {
        id: 'page_2',
        width: 800,
        height: 1100,
        properties: mockProperties,
        isBookmarked: true,
      })
    );
    assert.match(htmlTrue, /data-testid="page-bookmark-marker"/);

    const htmlFalse = renderToStaticMarkup(
      React.createElement(PageRenderer, {
        id: 'page_2',
        width: 800,
        height: 1100,
        properties: mockProperties,
        isBookmarked: false,
      })
    );
    assert.doesNotMatch(htmlFalse, /data-testid="page-bookmark-marker"/);
  });

  await t.test('Suite 4.5: Continuation overflow sheets suppress duplicate corner ribbons', async () => {
    const { bmState } = resetMockState();
    await bmState.addBookmark('nb_std', 'page_1', 'notebook');

    // Sheet 1 (primary sheet) displays marker
    const htmlSheet1 = renderToStaticMarkup(
      React.createElement(PageRenderer, {
        id: 'page_1-sheet-1',
        width: 800,
        height: 1100,
        properties: mockProperties,
      })
    );
    assert.match(htmlSheet1, /data-testid="page-bookmark-marker"/);

    // Sheet 2 (continuation overflow) suppresses marker
    const htmlSheet2 = renderToStaticMarkup(
      React.createElement(PageRenderer, {
        id: 'page_1-sheet-2',
        width: 800,
        height: 1100,
        properties: mockProperties,
      })
    );
    assert.doesNotMatch(htmlSheet2, /data-testid="page-bookmark-marker"/);
  });

  // ============================================
  // Suite 5: Page Navigation Click Target Preservation
  // ============================================

  await t.test('Suite 5.1: Clicking page row in tree preserves normal navigation to exact page', async () => {
    const { wsState, bmState } = resetMockState();
    await bmState.addBookmark('nb_std', 'page_2', 'notebook');

    assert.equal(wsState.activePageId, 'page_1');

    // Navigation action triggered by clicking page row
    wsState.setActivePage('page_2');
    assert.equal(wsState.activePageId, 'page_2');
  });

  await t.test('Suite 5.2: TreeRow attributes reflect active and bookmarked state simultaneously', async () => {
    const { wsState, bmState } = resetMockState();
    wsState.activePageId = 'page_1';
    await bmState.addBookmark('nb_std', 'page_1', 'notebook');

    const html = renderTree('ws_alpha');

    assert.match(html, /data-tree-id="page_1"/);
    assert.match(html, /aria-current="page"/);
    assert.match(html, /aria-label="Bookmarked page"/);
  });
});
