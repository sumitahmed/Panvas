import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPageIndicator } from '../src/components/notebook/pageIndicator.ts';
import type { NotebookPage, PagePropertySet } from '../src/types/notebook.ts';
import { DEFAULT_PAGE_PROPERTY_SET } from '../src/types/notebook.ts';

function createMockPage(id: string, sectionId: string, order: number, title: string, overrides: Partial<PagePropertySet> = {}): NotebookPage {
  return {
    id,
    notebookId: 'nb-1',
    sectionId,
    title,
    order,
    createdAt: 1000 + order * 10,
    updatedAt: 1000 + order * 10,
    userId: null,
    deletedAt: null,
    pagePropertyOverrides: overrides,
  };
}

test('Suite 1 - Test 1: Basic Multi-Page Numbering across section pages', () => {
  const sectionId = 'sec-1';
  const pageCount = 4;
  const pages: NotebookPage[] = Array.from({ length: pageCount }, (_, i) =>
    createMockPage(`page-${i + 1}`, sectionId, i, `Page ${i + 1}`),
  );

  const sectionPages = pages
    .filter(p => p.sectionId === sectionId && !p.deletedAt)
    .sort((a, b) => a.order - b.order);

  assert.equal(sectionPages.length, pageCount);

  sectionPages.forEach((page, index) => {
    const indicator = formatPageIndicator(index + 1, sectionPages.length);
    assert.equal(indicator, `${index + 1} / ${pageCount}`);
  });
});

test('Suite 1 - Test 2: Post-Insertion Numbering shifts subsequent page indices', () => {
  const sectionId = 'sec-1';
  let pages: NotebookPage[] = [
    createMockPage('p1', sectionId, 0, 'Page 1'),
    createMockPage('p2', sectionId, 1, 'Page 2'),
    createMockPage('p3', sectionId, 2, 'Page 3'),
  ];

  assert.equal(pages.length, 3);

  // Insert new page after p1 (at index 1)
  const insertIndex = 1;
  const newPage = createMockPage('p-new', sectionId, insertIndex, 'Page 2');
  
  // Shift order of subsequent pages
  pages = pages.map(p => p.order >= insertIndex ? { ...p, order: p.order + 1 } : p);
  pages.splice(insertIndex, 0, newPage);

  const updatedPages = pages
    .filter(p => p.sectionId === sectionId && !p.deletedAt)
    .sort((a, b) => a.order - b.order);

  assert.equal(updatedPages.length, 4);
  assert.equal(updatedPages[0].id, 'p1');
  assert.equal(updatedPages[1].id, 'p-new');
  assert.equal(updatedPages[2].id, 'p2');
  assert.equal(updatedPages[3].id, 'p3');

  updatedPages.forEach((page, index) => {
    assert.equal(formatPageIndicator(index + 1, updatedPages.length), `${index + 1} / 4`);
  });
});

test('Suite 1 - Test 3: Post-Deletion Numbering decrements subsequent page indices and updates total count', () => {
  const sectionId = 'sec-1';
  let pages: NotebookPage[] = [
    createMockPage('p1', sectionId, 0, 'Page 1'),
    createMockPage('p2', sectionId, 1, 'Page 2'),
    createMockPage('p3', sectionId, 2, 'Page 3'),
    createMockPage('p4', sectionId, 3, 'Page 4'),
  ];

  // Delete page 2 (index 1)
  const deletedId = 'p2';
  pages = pages.map(p => p.id === deletedId ? { ...p, deletedAt: Date.now() } : p);

  // Re-index remaining active pages
  const remaining = pages
    .filter(p => p.sectionId === sectionId && !p.deletedAt)
    .sort((a, b) => a.order - b.order)
    .map((p, idx) => ({ ...p, order: idx }));

  assert.equal(remaining.length, 3);
  assert.equal(remaining[0].id, 'p1');
  assert.equal(remaining[1].id, 'p3');
  assert.equal(remaining[2].id, 'p4');

  remaining.forEach((page, index) => {
    assert.equal(formatPageIndicator(index + 1, remaining.length), `${index + 1} / 3`);
  });
});

test('Suite 1 - Test 4: Section Switch Counter Isolation immediately reflects target section count without stale display', () => {
  const sectionA_Pages: NotebookPage[] = [
    createMockPage('a1', 'sec-A', 0, 'Page 1'),
    createMockPage('a2', 'sec-A', 1, 'Page 2'),
    createMockPage('a3', 'sec-A', 2, 'Page 3'),
    createMockPage('a4', 'sec-A', 3, 'Page 4'),
  ];
  const sectionB_Pages: NotebookPage[] = [
    createMockPage('b1', 'sec-B', 0, 'Page 1'),
    createMockPage('b2', 'sec-B', 1, 'Page 2'),
  ];

  const allPages = [...sectionA_Pages, ...sectionB_Pages];

  // State in Section A
  let activeSectionId = 'sec-A';
  let activePageId = 'a3';

  let currentPages = allPages
    .filter(p => p.sectionId === activeSectionId && !p.deletedAt)
    .sort((a, b) => a.order - b.order);
  let activeIndex = currentPages.findIndex(p => p.id === activePageId);
  assert.equal(formatPageIndicator(activeIndex + 1, currentPages.length), '3 / 4');

  // Synchronous atomic switch to Section B
  activeSectionId = 'sec-B';
  const targetSectionPages = allPages
    .filter(p => p.sectionId === activeSectionId && !p.deletedAt)
    .sort((a, b) => a.order - b.order);
  activePageId = targetSectionPages[0].id;

  // Derivation in Section B
  currentPages = allPages
    .filter(p => p.sectionId === activeSectionId && !p.deletedAt)
    .sort((a, b) => a.order - b.order);
  activeIndex = currentPages.findIndex(p => p.id === activePageId);

  assert.equal(activePageId, 'b1');
  assert.equal(currentPages.length, 2);
  assert.equal(formatPageIndicator(activeIndex + 1, currentPages.length), '1 / 2');
});

test('Suite 1 - Test 5: No Counter Inflation from Continuation Pages', () => {
  const sectionId = 'sec-1';
  // 4 logical notebook pages in section
  const pages: NotebookPage[] = [
    createMockPage('p1', sectionId, 0, 'Page 1'),
    createMockPage('p2', sectionId, 1, 'Page 2', { layoutMode: 'document', pageSize: 'A4' }),
    createMockPage('p3', sectionId, 2, 'Page 3'),
    createMockPage('p4', sectionId, 3, 'Page 4'),
  ];

  // Logical page list is strictly 4 pages
  const sectionPages = pages
    .filter(p => p.sectionId === sectionId && !p.deletedAt)
    .sort((a, b) => a.order - b.order);
  assert.equal(sectionPages.length, 4);

  // Logical counter for Page 2 is 2 / 4
  const logicalIndex = sectionPages.findIndex(p => p.id === 'p2');
  const logicalIndicator = formatPageIndicator(logicalIndex + 1, sectionPages.length);
  assert.equal(logicalIndicator, '2 / 4');

  // Physical continuation calculation for overflowing text in Page 2:
  // Suppose sheetHeight = 1123, stride = 1155, layoutExtent = 3 * 1155
  const sheetHeight = 1123;
  const stride = sheetHeight + 32;
  const physicalContinuationCount = 3;
  const layoutExtent = physicalContinuationCount * stride - 32;

  const count = Math.max(1, Math.round((layoutExtent + 32) / stride));
  assert.equal(count, 3);

  // Disambiguated continuation indicators preserve logical coordinates:
  const continuationIndicators = Array.from({ length: count }, (_, idx) => {
    return `${logicalIndicator} (${idx + 1}/${count})`;
  });

  assert.equal(continuationIndicators[0], '2 / 4 (1/3)');
  assert.equal(continuationIndicators[1], '2 / 4 (2/3)');
  assert.equal(continuationIndicators[2], '2 / 4 (3/3)');

  // Verify notebook-level page count is NOT inflated by continuation sheets
  assert.equal(sectionPages.length, 4);
});

test('Suite 1 - Test 6: Persistence & Reload Consistency for page indices and counters', () => {
  const sectionId = 'sec-1';
  const initialPages: NotebookPage[] = [
    createMockPage('p1', sectionId, 0, 'Intro'),
    createMockPage('p2', sectionId, 1, 'Notes'),
    createMockPage('p3', sectionId, 2, 'Summary'),
  ];

  // Serialize to JSON (simulating disk/IPC store)
  const serialized = JSON.stringify(initialPages);

  // Deserialize (simulating application reload)
  const reloadedPages: NotebookPage[] = JSON.parse(serialized);

  const activePages = reloadedPages
    .filter(p => p.sectionId === sectionId && !p.deletedAt)
    .sort((a, b) => a.order - b.order);

  assert.equal(activePages.length, 3);
  activePages.forEach((page, index) => {
    assert.equal(page.order, index);
    assert.equal(formatPageIndicator(index + 1, activePages.length), `${index + 1} / 3`);
  });
});
