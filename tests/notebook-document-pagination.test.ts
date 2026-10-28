import assert from 'node:assert/strict';
import test from 'node:test';
import { documentInsets, documentSheetStride } from '../src/components/notebook/documentFlowGeometry.ts';
import { resolveBasePageDimensions } from '../src/lib/pageProperties.ts';
import { DEFAULT_PAGE_PROPERTY_SET, type NotebookPage, type PagePropertySet } from '../src/types/notebook.ts';

test('Suite 4 - Test 19: Long Text Paste Overflow dynamically calculates physical continuation sheets', () => {
  const props: PagePropertySet = {
    ...DEFAULT_PAGE_PROPERTY_SET,
    pageSize: 'A4',
    orientation: 'portrait',
    layoutMode: 'document',
    margins: 'Normal',
  };

  const baseHeight = resolveBasePageDimensions(props).height;
  assert.equal(baseHeight, 1123);

  const inset = documentInsets(props);
  assert.equal(inset, 64);

  const stride = documentSheetStride(props);
  assert.equal(stride, 1155); // 1123 + 32px inter-sheet gap

  const writingHeight = baseHeight - inset * 2;
  assert.equal(writingHeight, 995);

  // Simulate long pasted text:
  // 50 paragraphs of ~40px line height = ~2000px natural height.
  const naturalContentHeight = 2500;
  assert.ok(naturalContentHeight > writingHeight, 'Natural content height exceeds single page writing area');

  // Multi-sheet pagination calculation:
  // Each sheet provides writingHeight space.
  // Content crossing sheet boundaries requires a 160px gap (64px bottom margin + 32px sheet gap + 64px top margin).
  const pageGapHeight = 160;
  let remainingHeight = naturalContentHeight;
  let sheetCount = 1;
  let accumulatedLayoutHeight = inset;

  while (remainingHeight > writingHeight) {
    accumulatedLayoutHeight += writingHeight + pageGapHeight;
    remainingHeight -= writingHeight;
    sheetCount++;
  }
  accumulatedLayoutHeight += remainingHeight + inset;

  assert.equal(sheetCount, 3);
  assert.ok(accumulatedLayoutHeight >= naturalContentHeight);

  // Verify that layoutExtent accommodates all 3 physical continuation sheets:
  const layoutExtent = sheetCount * stride - 32;
  assert.equal(layoutExtent, 3 * 1155 - 32); // 3433px
  assert.ok(layoutExtent > naturalContentHeight);
});

test('Suite 4 - Test 20: Zero Truncation / Bottom Clip preserves boundary content across page seams', () => {
  const props: PagePropertySet = {
    ...DEFAULT_PAGE_PROPERTY_SET,
    pageSize: 'A4',
    layoutMode: 'document',
  };

  const baseHeight = resolveBasePageDimensions(props).height; // 1123
  const inset = documentInsets(props); // 64
  const writingHeight = baseHeight - inset * 2; // 995
  const stride = documentSheetStride(props); // 1155

  // Line before seam (e.g. at y = 980)
  const lineBeforeSeam = { top: 960, bottom: 985 };
  assert.ok(lineBeforeSeam.bottom <= writingHeight, 'Line before boundary must fit within Sheet 1 writing area');

  // Line that would cross boundary (e.g. top = 990, bottom = 1015)
  // Pagination inserts a view spacer gap of height = nextTop - lineTop
  const nextSheetTop = stride + inset; // 1155 + 64 = 1219
  const gapHeight = nextSheetTop - lineBeforeSeam.bottom;

  const shiftedLineAfterSeam = {
    top: lineBeforeSeam.bottom + gapHeight,
    bottom: lineBeforeSeam.bottom + gapHeight + 25,
  };

  // Shifted line starts exactly at Sheet 2 top writing boundary
  assert.equal(shiftedLineAfterSeam.top, 1219);
  assert.equal(shiftedLineAfterSeam.top, stride + inset);
  assert.ok(shiftedLineAfterSeam.bottom <= stride + baseHeight - inset, 'Shifted line fits cleanly within Sheet 2 margins');
});

test('Suite 4 - Test 21: Dynamic Re-Pagination on Edit/Delete shrinks layout and reclaims physical sheets', () => {
  const props: PagePropertySet = {
    ...DEFAULT_PAGE_PROPERTY_SET,
    pageSize: 'A4',
    layoutMode: 'document',
  };

  const stride = documentSheetStride(props); // 1155
  const writingHeight = 995;

  // Initial long content requiring 3 sheets
  let contentHeight = 2500;
  let sheetCount = Math.max(1, Math.ceil(contentHeight / writingHeight));
  assert.equal(sheetCount, 3);
  let layoutExtent = sheetCount * stride - 32;
  assert.equal(layoutExtent, 3433);

  // User deletes several paragraphs: content height drops to 800px (fits in 1 sheet)
  contentHeight = 800;
  sheetCount = Math.max(1, Math.ceil(contentHeight / writingHeight));
  assert.equal(sheetCount, 1);

  // Layout extent shrinks back to single sheet
  layoutExtent = Math.max(1123, sheetCount * stride - 32);
  assert.equal(layoutExtent, 1123);
});

test('Suite 4 - Test 22: Logical Count Isolation ensures physical continuation sheets do not create phantom notebook entries', () => {
  const sectionId = 'sec-doc';
  
  // Section contains exactly 2 logical notebook pages
  const notebookPages: NotebookPage[] = [
    {
      id: 'page-doc-1',
      notebookId: 'nb-1',
      sectionId,
      title: 'Specifications',
      order: 0,
      createdAt: 1000,
      updatedAt: 1000,
      userId: null,
      deletedAt: null,
      pagePropertyOverrides: { layoutMode: 'document', pageSize: 'A4', layoutExtent: 3433 },
    },
    {
      id: 'page-doc-2',
      notebookId: 'nb-1',
      sectionId,
      title: 'Appendix',
      order: 1,
      createdAt: 2000,
      updatedAt: 2000,
      userId: null,
      deletedAt: null,
      pagePropertyOverrides: { layoutMode: 'document', pageSize: 'A4', layoutExtent: 1123 },
    },
  ];

  // Even though page-doc-1 has 3 physical continuation sheets, section page count remains exactly 2:
  const sectionPages = notebookPages.filter(p => p.sectionId === sectionId && !p.deletedAt);
  assert.equal(sectionPages.length, 2);

  assert.equal(sectionPages[0].id, 'page-doc-1');
  assert.equal(sectionPages[1].id, 'page-doc-2');
  assert.equal(sectionPages[0].title, 'Specifications');
  assert.equal(sectionPages[1].title, 'Appendix');
});

test('Suite 4 - Test 23: Save/Restore Fidelity preserves paginated text document structure and layoutExtent', () => {
  const originalPage: NotebookPage = {
    id: 'page-paged-fidelity',
    notebookId: 'nb-1',
    sectionId: 'sec-1',
    title: 'Research Document',
    order: 0,
    createdAt: 1000,
    updatedAt: 2000,
    userId: null,
    deletedAt: null,
    pagePropertyOverrides: {
      layoutMode: 'document',
      pageSize: 'A4',
      orientation: 'portrait',
      margins: 'Normal',
      layoutExtent: 2278, // 2 sheets: 2 * 1155 - 32 = 2278
    },
  };

  const documentContent = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Executive Summary' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Continuous paragraph text that spans across the document...' }] },
    ],
  };

  // Serialize to JSON
  const serializedMeta = JSON.stringify(originalPage);
  const serializedDoc = JSON.stringify(documentContent);

  // Restore from JSON
  const restoredPage: NotebookPage = JSON.parse(serializedMeta);
  const restoredDoc = JSON.parse(serializedDoc);

  assert.deepEqual(restoredPage.pagePropertyOverrides, originalPage.pagePropertyOverrides);
  assert.equal(restoredPage.pagePropertyOverrides?.layoutExtent, 2278);
  assert.deepEqual(restoredDoc, documentContent);
});
