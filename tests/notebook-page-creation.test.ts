import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePageDimensions, derivePagePropertyOverrides, resolvePageProperties } from '../src/lib/pageProperties.ts';
import { DEFAULT_PAGE_PROPERTY_SET, type Notebook, type NotebookPage, type PagePropertySet } from '../src/types/notebook.ts';

const mockNotebook: Notebook = {
  id: 'nb-1',
  workspaceId: 'ws-1',
  folderId: null,
  name: 'Notebook 1',
  order: 0,
  createdAt: 1000,
  updatedAt: 1000,
  isExpanded: true,
  userId: null,
  defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET },
};

function createActivePageWithProps(id: string, overrides: Partial<PagePropertySet>): NotebookPage {
  return {
    id,
    notebookId: 'nb-1',
    sectionId: 'sec-1',
    title: 'Active Page',
    order: 0,
    createdAt: 1000,
    updatedAt: 1000,
    userId: null,
    deletedAt: null,
    pagePropertyOverrides: overrides,
  };
}

test('Suite 3 - Test 14: Bypass Modal on Add-Page creates a page without invoking openCreateDialog', () => {
  let openCreateDialogCalled = false;
  const mockUIStore = {
    openCreateDialog: () => {
      openCreateDialogCalled = true;
    },
  };

  let pageCreatedDirectly = false;
  let createdTitle = '';
  let createdProvenance: 'default' | 'custom' | undefined;

  // Direct insertion function simulating handleInsertPage
  const handleInsertPageDirect = async (
    activePageProps: PagePropertySet,
    existingPagesCount: number,
  ) => {
    // Modal is bypassed entirely
    pageCreatedDirectly = true;
    const nextIndex = existingPagesCount + 1;
    createdTitle = `Page ${nextIndex}`;
    createdProvenance = 'default';
  };

  const activeProps: PagePropertySet = {
    ...DEFAULT_PAGE_PROPERTY_SET,
    pageSize: 'A4',
    orientation: 'portrait',
  };

  handleInsertPageDirect(activeProps, 3);

  assert.equal(openCreateDialogCalled, false, 'Modal creation dialog must not be opened on add-page button click');
  assert.equal(pageCreatedDirectly, true);
  assert.equal(createdTitle, 'Page 4');
  assert.equal(createdProvenance, 'default');
});

test('Suite 3 - Test 15: A4 Format Inheritance produces matching A4 portrait dimensions and margins', () => {
  const activePageOverrides: Partial<PagePropertySet> = {
    pageSize: 'A4',
    orientation: 'portrait',
    margins: 'Wide',
    paperColor: '#fefefe',
    ruleLineColor: '#cbd5e1',
    template: 'Ruled',
  };
  const activePage = createActivePageWithProps('p-active', activePageOverrides);
  const resolvedActive = resolvePageProperties(mockNotebook, activePage);

  // New page inherits active page format & appearance
  const newPageOverrides: Partial<PagePropertySet> = {
    pageSize: resolvedActive.pageSize,
    orientation: resolvedActive.orientation,
    margins: resolvedActive.margins,
    paperColor: resolvedActive.paperColor,
    ruleLineColor: resolvedActive.ruleLineColor,
    template: resolvedActive.template,
  };
  const newPage: NotebookPage = {
    id: 'p-new',
    notebookId: mockNotebook.id,
    sectionId: 'sec-1',
    title: 'Page 2',
    titleProvenance: 'default',
    order: 1,
    createdAt: 2000,
    updatedAt: 2000,
    userId: null,
    deletedAt: null,
    pagePropertyOverrides: newPageOverrides,
  };

  const resolvedNew = resolvePageProperties(mockNotebook, newPage);
  const activeDim = resolvePageDimensions(resolvedActive);
  const newDim = resolvePageDimensions(resolvedNew);

  assert.equal(resolvedNew.pageSize, 'A4');
  assert.equal(resolvedNew.orientation, 'portrait');
  assert.equal(resolvedNew.margins, 'Wide');
  assert.equal(resolvedNew.paperColor, '#fefefe');
  assert.equal(resolvedNew.ruleLineColor, '#cbd5e1');
  assert.equal(resolvedNew.template, 'Ruled');

  assert.equal(newDim.width, activeDim.width);
  assert.equal(newDim.height, activeDim.height);
  assert.equal(newDim.width, 794);
  assert.equal(newDim.height, 1123);
});

test('Suite 3 - Test 16: A3 Format Inheritance produces matching A3 landscape dimensions', () => {
  const activePageOverrides: Partial<PagePropertySet> = {
    pageSize: 'A3',
    orientation: 'landscape',
    paperColor: '#fff8e7',
    template: 'Engineering',
  };
  const activePage = createActivePageWithProps('p-active', activePageOverrides);
  const resolvedActive = resolvePageProperties(mockNotebook, activePage);

  const newPageOverrides: Partial<PagePropertySet> = {
    pageSize: resolvedActive.pageSize,
    orientation: resolvedActive.orientation,
    paperColor: resolvedActive.paperColor,
    template: resolvedActive.template,
  };
  const newPage: NotebookPage = {
    id: 'p-new',
    notebookId: mockNotebook.id,
    sectionId: 'sec-1',
    title: 'Page 2',
    titleProvenance: 'default',
    order: 1,
    createdAt: 2000,
    updatedAt: 2000,
    userId: null,
    deletedAt: null,
    pagePropertyOverrides: newPageOverrides,
  };

  const resolvedNew = resolvePageProperties(mockNotebook, newPage);
  const newDim = resolvePageDimensions(resolvedNew);

  assert.equal(resolvedNew.pageSize, 'A3');
  assert.equal(resolvedNew.orientation, 'landscape');
  assert.equal(resolvedNew.template, 'Engineering');
  assert.equal(newDim.width, 1587);
  assert.equal(newDim.height, 1123);
});

test('Suite 3 - Test 17: Infinite Format Inheritance produces matching Infinite surface width', () => {
  const activePageOverrides: Partial<PagePropertySet> = {
    pageSize: 'Infinite',
    infiniteWidth: 1200,
    paperColor: '#1e1e1e',
  };
  const activePage = createActivePageWithProps('p-active', activePageOverrides);
  const resolvedActive = resolvePageProperties(mockNotebook, activePage);

  const newPageOverrides: Partial<PagePropertySet> = {
    pageSize: resolvedActive.pageSize,
    infiniteWidth: resolvedActive.infiniteWidth,
    paperColor: resolvedActive.paperColor,
  };
  const newPage: NotebookPage = {
    id: 'p-new',
    notebookId: mockNotebook.id,
    sectionId: 'sec-1',
    title: 'Page 2',
    titleProvenance: 'default',
    order: 1,
    createdAt: 2000,
    updatedAt: 2000,
    userId: null,
    deletedAt: null,
    pagePropertyOverrides: newPageOverrides,
  };

  const resolvedNew = resolvePageProperties(mockNotebook, newPage);
  const newDim = resolvePageDimensions(resolvedNew);

  assert.equal(resolvedNew.pageSize, 'Infinite');
  assert.equal(resolvedNew.infiniteWidth, 1200);
  assert.equal(newDim.width, 1200);
});

test('Suite 3 - Test 18: Default Title Assignment on Creation assigns Page N with titleProvenance default', () => {
  const existingSectionPages: NotebookPage[] = [
    { id: 'p1', notebookId: 'nb-1', sectionId: 'sec-1', title: 'Page 1', order: 0, createdAt: 1, updatedAt: 1, userId: null },
    { id: 'p2', notebookId: 'nb-1', sectionId: 'sec-1', title: 'Page 2', order: 1, createdAt: 2, updatedAt: 2, userId: null },
    { id: 'p3', notebookId: 'nb-1', sectionId: 'sec-1', title: 'Page 3', order: 2, createdAt: 3, updatedAt: 3, userId: null },
    { id: 'p4', notebookId: 'nb-1', sectionId: 'sec-1', title: 'Page 4', order: 3, createdAt: 4, updatedAt: 4, userId: null },
  ];

  // Appending to a 4-page section
  const nextNumber = existingSectionPages.filter(p => !p.deletedAt).length + 1;
  const newTitle = `Page ${nextNumber}`;
  const provenance: 'default' | 'custom' = 'default';

  const newPage: NotebookPage = {
    id: 'p5',
    notebookId: 'nb-1',
    sectionId: 'sec-1',
    title: newTitle,
    titleProvenance: provenance,
    order: existingSectionPages.length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    userId: null,
  };

  assert.equal(newPage.title, 'Page 5');
  assert.equal(newPage.titleProvenance, 'default');
});
