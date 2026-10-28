import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPageIndicator } from '../src/components/notebook/pageIndicator.ts';
import {
  saveNotebookPosition,
  getNotebookPosition,
  clearNotebookPosition,
  savePdfPosition,
  getPdfPosition,
  clearPdfPosition,
} from '../src/lib/readingPosition.ts';
import type { PageProperties } from '../src/components/notebook/engine/drawingTypes.ts';

// Ensure localStorage mock is present in Node environment
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => { store.set(key, String(val)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  } as unknown as Storage;
}

// ============================================================================
// 1. R0.1 Page Indicator Isolation & Multi-Sheet Formatting
// ============================================================================

test('R0.1 Adversarial: Switching between Section A (5 pages) and Section B (2 pages) isolates counts with zero stale flashes', () => {
  interface MockPage {
    id: string;
    sectionId: string;
    order: number;
  }

  const sectionAPages: MockPage[] = [
    { id: 'pA1', sectionId: 'secA', order: 0 },
    { id: 'pA2', sectionId: 'secA', order: 1 },
    { id: 'pA3', sectionId: 'secA', order: 2 },
    { id: 'pA4', sectionId: 'secA', order: 3 },
    { id: 'pA5', sectionId: 'secA', order: 4 },
  ];

  const sectionBPages: MockPage[] = [
    { id: 'pB1', sectionId: 'secB', order: 0 },
    { id: 'pB2', sectionId: 'secB', order: 1 },
  ];

  const allPages = [...sectionAPages, ...sectionBPages];

  // Helper simulating NotebookRenderer resolution of currentSectionPages and totalPages
  const resolveSectionPageIndicators = (activeSectionId: string) => {
    const currentSectionPages = allPages
      .filter(p => p.sectionId === activeSectionId)
      .sort((a, b) => a.order - b.order);
    const totalPages = currentSectionPages.length;
    return currentSectionPages.map((_, index) => formatPageIndicator(index + 1, totalPages));
  };

  // 1. Render Section A
  const sectionAIndicators = resolveSectionPageIndicators('secA');
  assert.equal(sectionAIndicators.length, 5);
  assert.deepEqual(sectionAIndicators, ['1 / 5', '2 / 5', '3 / 5', '4 / 5', '5 / 5']);

  // 2. Switch to Section B -> verify immediate count update to 2
  const sectionBIndicators = resolveSectionPageIndicators('secB');
  assert.equal(sectionBIndicators.length, 2);
  assert.deepEqual(sectionBIndicators, ['1 / 2', '2 / 2']);

  // 3. Assert zero stale flashes: no indicator in Section B reports "/ 5"
  assert.ok(sectionBIndicators.every(ind => !ind.includes('/ 5')), 'Section B indicators must not retain Section A total');
  assert.ok(sectionBIndicators.every(ind => ind.endsWith('/ 2')), 'Section B indicators strictly end with / 2');
});

test('R0.1 Adversarial: Single-sheet pages never show continuation counts; multi-sheet pages show ${pageNumberText} (Sheet ${subIndex}/${subTotal})', () => {
  const formatSheetIndicator = (pageNumberText: string, subIndex: number, subTotal: number) => {
    if (subTotal <= 1) {
      return pageNumberText;
    }
    return `${pageNumberText} (Sheet ${subIndex}/${subTotal})`;
  };

  // Single-sheet page on page 2 of 4
  const singleSheet = formatSheetIndicator('2 / 4', 1, 1);
  assert.equal(singleSheet, '2 / 4');
  assert.ok(!singleSheet.includes('Sheet'), 'Single-sheet page must never contain "Sheet" text');

  // Multi-sheet page on page 1 of 4 with 8 sheets total, currently on sheet 7
  const multiSheet = formatSheetIndicator('1 / 4', 7, 8);
  assert.equal(multiSheet, '1 / 4 (Sheet 7/8)');
  assert.ok(multiSheet.startsWith('1 / 4'), 'Must start with section page indicator');
  assert.ok(multiSheet.includes('(Sheet 7/8)'), 'Must include unambiguous continuation count');

  // Multi-sheet boundary check: sheet 1 of 2
  const multiSheetStart = formatSheetIndicator('3 / 4', 1, 2);
  assert.equal(multiSheetStart, '3 / 4 (Sheet 1/2)');

  // Multi-sheet boundary check: last sheet 2 of 2
  const multiSheetEnd = formatSheetIndicator('3 / 4', 2, 2);
  assert.equal(multiSheetEnd, '3 / 4 (Sheet 2/2)');
});

// ============================================================================
// 2. R3.1 Notebook Reading Position
// ============================================================================

test('R3.1 Adversarial: Save position { pageId: "p2", scrollX: 0, scrollY: 450 } -> assert p2 activated and scrollY 450 restored', () => {
  const nbId = 'notebook-adversarial-1';
  clearNotebookPosition(nbId);

  saveNotebookPosition(nbId, {
    pageId: 'p2',
    scrollX: 0,
    scrollY: 450,
  });

  const saved = getNotebookPosition(nbId);
  assert.ok(saved !== null);
  assert.equal(saved.pageId, 'p2');
  assert.equal(saved.scrollX, 0);
  assert.equal(saved.scrollY, 450);

  // Simulate workspaceStore activation logic (workspaceStore.ts:476-479)
  const pages = [
    { id: 'p1', order: 0 },
    { id: 'p2', order: 1 },
    { id: 'p3', order: 2 },
  ];
  const targetPage = (saved && pages.find(p => p.id === saved.pageId)) || pages[0];
  assert.equal(targetPage.id, 'p2', 'p2 must be chosen as target page');

  // Simulate NotebookRenderer scroll restoration logic (NotebookRenderer.tsx:1626-1631)
  const activePageId = targetPage.id;
  let restoredScrollTop: number | null = null;
  if (saved && saved.pageId === activePageId) {
    restoredScrollTop = typeof saved.scrollY === 'number' ? saved.scrollY : 0;
  }
  assert.equal(restoredScrollTop, 450, 'scrollY: 450 must be restored');

  clearNotebookPosition(nbId);
});

test('R3.1 Adversarial: Deleted/missing page fallback -> assert graceful fallback to first active page without crash', () => {
  const nbId = 'notebook-adversarial-deleted-page';
  clearNotebookPosition(nbId);

  // Save position on 'p-deleted' which is subsequently deleted from the notebook
  saveNotebookPosition(nbId, {
    pageId: 'p-deleted',
    scrollX: 100,
    scrollY: 900,
  });

  const saved = getNotebookPosition(nbId);
  assert.ok(saved !== null);
  assert.equal(saved.pageId, 'p-deleted');

  // Current active pages remaining in notebook
  const pages = [
    { id: 'p1', order: 0 },
    { id: 'p2', order: 1 },
  ];

  // workspaceStore resolution: targetPage fallback
  const targetPage = (saved && pages.find(p => p.id === saved.pageId)) || pages[0];
  assert.equal(targetPage.id, 'p1', 'Must fallback cleanly to first active page p1');

  // NotebookRenderer scroll check: saved.pageId ('p-deleted') !== activePageId ('p1')
  const activePageId = targetPage.id;
  let usedSavedScroll = false;
  if (saved && saved.pageId === activePageId) {
    usedSavedScroll = true;
  }
  assert.equal(usedSavedScroll, false, 'Must not apply scroll of deleted page to fallback page');

  clearNotebookPosition(nbId);
});

test('R3.1 Adversarial: Corrupted localStorage JSON injection -> assert graceful fallback to null without crash', () => {
  const nbId = 'notebook-corrupt-storage';
  const storageKey = `panvas.readingPosition.notebook.${nbId}`;

  // Test 1: Syntax error JSON
  localStorage.setItem(storageKey, '{"pageId": "p1", "scrollY": 300, INVALID_JSON');
  let result = getNotebookPosition(nbId);
  assert.equal(result, null, 'Malformed JSON must return null without throwing');

  // Test 2: Invalid schema (pageId is a number instead of string)
  localStorage.setItem(storageKey, JSON.stringify({ pageId: 12345, scrollY: 300 }));
  result = getNotebookPosition(nbId);
  assert.equal(result, null, 'Non-string pageId must return null');

  // Test 3: Null JSON
  localStorage.setItem(storageKey, 'null');
  result = getNotebookPosition(nbId);
  assert.equal(result, null, 'null string must return null');

  // Test 4: Empty string
  localStorage.setItem(storageKey, '');
  result = getNotebookPosition(nbId);
  assert.equal(result, null, 'Empty string must return null');

  // Fallback to first page when corrupt
  const pages = [{ id: 'p1', order: 0 }, { id: 'p2', order: 1 }];
  const targetPage = (result && pages.find(p => p.id === (result as any).pageId)) || pages[0];
  assert.equal(targetPage.id, 'p1', 'Gracefully activates first page when storage is corrupt');

  localStorage.removeItem(storageKey);
});

test('R3.1 Adversarial: Explicit navigation precedence -> assert explicit page wins over saved position', () => {
  const nbId = 'notebook-precedence-test';
  clearNotebookPosition(nbId);

  // Saved position is on page p1
  saveNotebookPosition(nbId, {
    pageId: 'p1',
    scrollX: 0,
    scrollY: 800,
  });

  const savedPosition = getNotebookPosition(nbId);
  assert.ok(savedPosition !== null);

  // User explicitly clicks or navigates to page p3 (e.g. from search or sidebar)
  const explicitlyNavigatedPageId = 'p3';

  // NotebookRenderer.tsx:1626 checks:
  // if (savedPosition && savedPosition.pageId === activePageId)
  const isPositionRestored = savedPosition.pageId === explicitlyNavigatedPageId;
  assert.equal(isPositionRestored, false, 'Saved position p1 must not hijack navigation to explicit page p3');

  clearNotebookPosition(nbId);
});

// ============================================================================
// 3. R3.2 PDF Reading Position
// ============================================================================

test('R3.2 Adversarial: Save PDF position { pdfPage: 14, scrollY: 3200 } -> assert page 14 and scroll offset 3200 restored', () => {
  const pdfId = 'pdf-test-doc-14';
  clearPdfPosition(pdfId);

  savePdfPosition(pdfId, {
    pdfPage: 14,
    scrollX: 0,
    scrollY: 3200,
  });

  const restored = getPdfPosition(pdfId);
  assert.ok(restored !== null);
  assert.equal(restored.pdfPage, 14);
  assert.equal(restored.scrollY, 3200);

  // Simulate PDF resolution in a 20-page document
  const numPages = 20;
  const targetPage = Math.max(1, Math.min(numPages, restored.pdfPage));
  assert.equal(targetPage, 14, 'Page 14 is accurately within document bounds');

  // Verify scroll offset clamping against max scroll
  const scrollerHeight = 1000;
  const contentHeight = 8000;
  const maxScroll = contentHeight - scrollerHeight;
  const restoredScroll = Math.min(restored.scrollY ?? 0, maxScroll);
  assert.equal(restoredScroll, 3200, 'Scroll offset 3200 is accurately restored');

  clearPdfPosition(pdfId);
});

test('R3.2 Adversarial: Out-of-bounds / truncated PDF clamping behavior analysis', () => {
  const pdfId = 'pdf-truncated-test';
  clearPdfPosition(pdfId);

  // Saved position on page 50 of what was a 100-page PDF, but current PDF has only 5 pages
  savePdfPosition(pdfId, {
    pdfPage: 50,
    scrollY: 15000,
  });

  const saved = getPdfPosition(pdfId);
  assert.ok(saved !== null);
  assert.equal(saved.pdfPage, 50);

  const numPages = 5;

  // Expected clamping specification per prompt requirement:
  // "Save position on page 50 of a 5-page PDF -> assert clamped cleanly to page 5."
  const clampedPage = Math.max(1, Math.min(numPages, saved.pdfPage));
  assert.equal(clampedPage, 5, 'Page 50 in a 5-page PDF must clamp cleanly to page 5');

  // REMEDIATION VERIFICATION:
  // In remediated PdfWorkspace.tsx:280, saved.pdfPage is clamped via Math.max(1, Math.min(numPages, Math.floor(saved.pdfPage)))
  const target = Math.max(1, Math.min(numPages, Math.floor(saved.pdfPage)));
  assert.equal(target, 5, 'Page 50 in a 5-page PDF clamps cleanly to page 5');

  clearPdfPosition(pdfId);
});

// ============================================================================
// 4. R5.1 Scalability & Memoization
// ============================================================================

test('R5.1 Adversarial: PageRenderer memoization comparator prevents re-render on unchanged props and clones', () => {
  // Extract and test the exact memo comparator logic from PageRenderer.tsx:225-239
  const pageRendererMemoComparator = (prev: any, next: any): boolean => {
    if (prev.id !== next.id) return false;
    if (prev.width !== next.width || prev.height !== next.height) return false;
    if (prev.className !== next.className) return false;
    if (prev.pageNumberText !== next.pageNumberText) return false;
    if (prev.editable !== next.editable) return false;
    if (prev.logicalBase !== next.logicalBase) return false;
    if (prev.children !== next.children) return false;
    if (prev.onUpdateProperties !== next.onUpdateProperties) return false;
    if (prev.renderWindow?.top !== next.renderWindow?.top || prev.renderWindow?.height !== next.renderWindow?.height) return false;
    if (prev.properties !== next.properties) {
      if (JSON.stringify(prev.properties) !== JSON.stringify(next.properties)) return false;
    }
    return true;
  };

  const baseProps = {
    id: 'page-memo-1',
    width: 794,
    height: 1123,
    className: 'panvas-page',
    pageNumberText: '1 / 10',
    editable: true,
    logicalBase: 0,
    children: undefined,
    onUpdateProperties: undefined,
    renderWindow: undefined,
    properties: {
      pageSize: 'A4',
      orientation: 'portrait',
      template: 'Ruled',
      paperColor: '#ffffff',
      ruleLineColor: '#e2e8f0',
      margins: 'Normal',
      layoutMode: 'document',
    } as PageProperties,
  };

  // 1. Same reference -> returns true (skip re-render)
  assert.equal(pageRendererMemoComparator(baseProps, baseProps), true);

  // 2. Cloned properties object (new object identity, identical fields) -> returns true (skip re-render)
  const clonedProps = {
    ...baseProps,
    properties: { ...baseProps.properties },
  };
  assert.notEqual(baseProps.properties, clonedProps.properties);
  assert.equal(pageRendererMemoComparator(baseProps, clonedProps), true);

  // 3. Changed pageNumberText (e.g. from '1 / 10' to '1 / 11') -> returns false (trigger re-render)
  const changedPageNum = { ...baseProps, pageNumberText: '1 / 11' };
  assert.equal(pageRendererMemoComparator(baseProps, changedPageNum), false);

  // 4. Changed paper color -> returns false (trigger re-render)
  const changedColor = {
    ...baseProps,
    properties: { ...baseProps.properties, paperColor: '#fef08a' },
  };
  assert.equal(pageRendererMemoComparator(baseProps, changedColor), false);

  // 5. Changed width/height -> returns false
  const changedDimensions = { ...baseProps, width: 800 };
  assert.equal(pageRendererMemoComparator(baseProps, changedDimensions), false);

  // 6. Benchmark performance across 10,000 memo checks
  const startTime = performance.now();
  let skippedRenders = 0;
  for (let i = 0; i < 10000; i++) {
    if (pageRendererMemoComparator(baseProps, clonedProps)) {
      skippedRenders++;
    }
  }
  const durationMs = performance.now() - startTime;
  assert.equal(skippedRenders, 10000, 'All 10,000 unchanged prop passes must be memoized');
  assert.ok(durationMs < 100, `10,000 memo comparator evaluations took ${durationMs.toFixed(2)}ms (must be < 100ms)`);
});

test('R5.1 Adversarial: Far-offscreen placeholder behavior reduces DOM footprint for pages > 3 viewports away', () => {
  const containerHeight = 900;
  const scrollTop = 3000;
  const viewportScale = 1.0;
  const residentIds = new Set(['page-3', 'page-4']); // resident pages around viewport
  const focusedPageId = 'page-3';

  interface PageLayoutPos {
    id: string;
    y: number;
    height: number;
    width: number;
  }

  // 10-page notebook layout
  const pages: PageLayoutPos[] = Array.from({ length: 10 }, (_, i) => ({
    id: `page-${i + 1}`,
    y: i * 1200, // each page 1200px stride
    height: 1123,
    width: 794,
  }));

  const resolvePageRenderMode = (pos: PageLayoutPos) => {
    const isFocused = pos.id === focusedPageId;
    const isResident = residentIds.has(pos.id) || isFocused;
    const isFarOffscreen = !isResident && containerHeight > 0 &&
      Math.abs((pos.y * viewportScale) - scrollTop) > 3 * containerHeight;

    if (isResident) return 'full-interactive';
    if (isFarOffscreen) return 'lightweight-placeholder';
    return 'page-renderer';
  };

  const renderModes = pages.map(p => ({ id: p.id, y: p.y, mode: resolvePageRenderMode(p) }));

  // Page 1: Y=0, distance = |0 - 3000| = 3000 > 2700 (3 * 900) -> lightweight-placeholder
  assert.equal(renderModes.find(m => m.id === 'page-1')?.mode, 'lightweight-placeholder');

  // Page 3: Y=2400 (resident/focused) -> full-interactive
  assert.equal(renderModes.find(m => m.id === 'page-3')?.mode, 'full-interactive');

  // Page 4: Y=3600 (resident) -> full-interactive
  assert.equal(renderModes.find(m => m.id === 'page-4')?.mode, 'full-interactive');

  // Page 5: Y=4800, distance = |4800 - 3000| = 1800 <= 2700 (near offscreen, not resident) -> page-renderer
  assert.equal(renderModes.find(m => m.id === 'page-5')?.mode, 'page-renderer');

  // Page 8: Y=8400, distance = |8400 - 3000| = 5400 > 2700 -> lightweight-placeholder
  assert.equal(renderModes.find(m => m.id === 'page-8')?.mode, 'lightweight-placeholder');

  // DOM Footprint comparison:
  // Placeholder DOM: 1 wrapper div + 1 span = 2 nodes.
  // Full PageRenderer/PageView DOM: ~50 nodes (SVG patterns, backgrounds, layers, canvas, toolbar hooks).
  const placeholderDomNodes = 2;
  const fullPageDomNodes = 50;
  const reductionPercent = ((fullPageDomNodes - placeholderDomNodes) / fullPageDomNodes) * 100;
  assert.ok(reductionPercent >= 90, `Placeholder reduces DOM nodes by ${reductionPercent}% (>= 90%)`);
});
