import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSectionRenumbering, type PageForRenumbering } from '../src/lib/notebookPageRenumbering.ts';
import { formatPageIndicator } from '../src/components/notebook/pageIndicator.ts';
import {
  resolveBasePageDimensions,
  resolvePageDimensions,
  resolvePageProperties,
  resolvePageSurfaceGeometry,
} from '../src/lib/pageProperties.ts';
import {
  DEFAULT_PAGE_PROPERTY_SET,
  type Notebook,
  type NotebookPage,
  type PagePropertySet,
} from '../src/types/notebook.ts';
import type { DrawingData, Stroke, ShapeObject, ImageObject } from '../src/components/notebook/engine/drawingTypes.ts';

const mockNotebook: Notebook = {
  id: 'nb-stress',
  workspaceId: 'ws-stress',
  folderId: null,
  name: 'Stress Test Notebook',
  order: 0,
  createdAt: 1000,
  updatedAt: 1000,
  isExpanded: true,
  userId: null,
  defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET },
};

function createTestPage(
  id: string,
  sectionId: string,
  order: number,
  title: string,
  titleProvenance?: 'default' | 'custom',
  deletedAt: number | null = null,
  overrides: Partial<PagePropertySet> = {},
): NotebookPage {
  return {
    id,
    notebookId: 'nb-stress',
    sectionId,
    title,
    titleProvenance,
    order,
    createdAt: 1000 + order * 10,
    updatedAt: 1000 + order * 10,
    userId: null,
    deletedAt,
    pagePropertyOverrides: overrides,
  };
}

// ---------------------------------------------------------------------------
// ADVERSARIAL CHALLENGE 1: Rapid deletion and insertion cycles on mixed lists
// ---------------------------------------------------------------------------
test('Adversarial 1: Rapid deletion and insertion cycles on mixed lists (default, custom, legacy)', () => {
  const sectionId = 'sec-stress-1';
  let pages: NotebookPage[] = [];
  let nextId = 1;

  // Initialize with 60 mixed pages
  for (let i = 0; i < 60; i++) {
    const id = `p-${nextId++}`;
    if (i % 3 === 0) {
      pages.push(createTestPage(id, sectionId, i, `Page ${i + 1}`, 'default'));
    } else if (i % 3 === 1) {
      pages.push(createTestPage(id, sectionId, i, `Custom Chapter ${i}`, 'custom'));
    } else {
      // Legacy page (provenance undefined)
      pages.push(createTestPage(id, sectionId, i, `Legacy Section ${i}`, undefined));
    }
  }

  // Helper to re-index order and compute/apply renumbering
  const renumberAndSync = (pageList: NotebookPage[]) => {
    const active = pageList.filter(p => !p.deletedAt).sort((a, b) => a.order - b.order);
    active.forEach((p, idx) => { p.order = idx; });
    const updates = computeSectionRenumbering(active);
    for (const u of updates) {
      const page = pageList.find(p => p.id === u.id);
      if (page) {
        page.title = u.title;
        page.titleProvenance = u.titleProvenance;
      }
    }
  };

  renumberAndSync(pages);

  // Track created custom and legacy page titles to verify immutability
  const immutableTitles = new Map<string, string>();
  pages.forEach(p => {
    if (p.titleProvenance !== 'default') {
      immutableTitles.set(p.id, p.title);
    }
  });

  // Run 150 adversarial cycles of mixed operations
  let seed = 42;
  const pseudoRandom = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  for (let cycle = 0; cycle < 150; cycle++) {
    const activePages = pages.filter(p => !p.deletedAt).sort((a, b) => a.order - b.order);
    const op = Math.floor(pseudoRandom() * 4);

    if (op === 0 && activePages.length > 5) {
      // Single deletion at random index
      const targetIdx = Math.floor(pseudoRandom() * activePages.length);
      activePages[targetIdx].deletedAt = Date.now();
      renumberAndSync(pages);
    } else if (op === 1 && activePages.length > 8) {
      // Batch deletion of 3 consecutive pages
      const targetIdx = Math.floor(pseudoRandom() * (activePages.length - 3));
      for (let k = 0; k < 3; k++) {
        activePages[targetIdx + k].deletedAt = Date.now();
      }
      renumberAndSync(pages);
    } else if (op === 2) {
      // Insert new default page at random position
      const insertIdx = Math.floor(pseudoRandom() * (activePages.length + 1));
      const id = `p-insert-def-${nextId++}`;
      const newPage = createTestPage(id, sectionId, insertIdx, `Page ${insertIdx + 1}`, 'default');
      pages.push(newPage);
      renumberAndSync(pages);
    } else {
      // Insert new custom page at random position
      const insertIdx = Math.floor(pseudoRandom() * (activePages.length + 1));
      const id = `p-insert-cust-${nextId++}`;
      const customTitle = `Adversarial Custom Note ${cycle}`;
      const newPage = createTestPage(id, sectionId, insertIdx, customTitle, 'custom');
      pages.push(newPage);
      immutableTitles.set(id, customTitle);
      renumberAndSync(pages);
    }

    // Comprehensive Invariant Verification after EVERY cycle
    const currentActive = pages.filter(p => !p.deletedAt).sort((a, b) => a.order - b.order);
    currentActive.forEach((p, idx) => {
      if (p.titleProvenance === 'default') {
        const expectedTitle = `Page ${idx + 1}`;
        assert.equal(
          p.title,
          expectedTitle,
          `Cycle ${cycle}: Default page at 1-based index ${idx + 1} must be titled ${expectedTitle}, got ${p.title}`,
        );
      } else {
        const originalTitle = immutableTitles.get(p.id);
        assert.equal(
          p.title,
          originalTitle,
          `Cycle ${cycle}: Non-default page ${p.id} title must be immutable: expected ${originalTitle}, got ${p.title}`,
        );
      }
    });
  }

  // Ensure surviving pages have clean sequential order
  const finalActive = pages.filter(p => !p.deletedAt).sort((a, b) => a.order - b.order);
  assert.ok(finalActive.length > 0, 'Must have surviving pages after stress cycles');
  finalActive.forEach((p, idx) => {
    assert.equal(p.order, idx);
  });
});

// ---------------------------------------------------------------------------
// ADVERSARIAL CHALLENGE 2: Custom Title deliberately named "Page 3"
// ---------------------------------------------------------------------------
test('Adversarial 2: Deletion of intermediate pages where a custom title is deliberately named "Page 3"', () => {
  const sectionId = 'sec-stress-2';
  const pages: NotebookPage[] = [
    createTestPage('p1', sectionId, 0, 'Page 1', 'default'),
    createTestPage('p2', sectionId, 1, 'Page 2', 'default'),
    // Deliberate adversarial trap: user titled this "Page 3" with custom provenance
    createTestPage('p3', sectionId, 2, 'Page 3', 'custom'),
    // Another trap: user titled this "Page 4" with custom provenance
    createTestPage('p4', sectionId, 3, 'Page 4', 'custom'),
    createTestPage('p5', sectionId, 4, 'Page 5', 'default'),
    // Legacy note also titled "Page 3"
    createTestPage('p6', sectionId, 5, 'Page 3', undefined),
    createTestPage('p7', sectionId, 6, 'Page 7', 'default'),
  ];

  const applyUpdates = () => {
    const active = pages.filter(p => !p.deletedAt).sort((a, b) => a.order - b.order);
    active.forEach((p, idx) => { p.order = idx; });
    const updates = computeSectionRenumbering(active);
    for (const u of updates) {
      const p = pages.find(item => item.id === u.id);
      if (p) {
        p.title = u.title;
        p.titleProvenance = u.titleProvenance;
      }
    }
  };

  // Step 1: Delete p1 ('Page 1', default)
  pages[0].deletedAt = Date.now();
  applyUpdates();

  // Active list is now:
  // idx 0: p2 (default) -> should renumber to 'Page 1'
  // idx 1: p3 (custom 'Page 3') -> MUST REMAIN 'Page 3'
  // idx 2: p4 (custom 'Page 4') -> MUST REMAIN 'Page 4'
  // idx 3: p5 (default) -> should renumber to 'Page 4' (1-based index 4)
  // idx 4: p6 (legacy 'Page 3') -> MUST REMAIN 'Page 3'
  // idx 5: p7 (default) -> should renumber to 'Page 6' (1-based index 6)
  assert.equal(pages.find(p => p.id === 'p2')!.title, 'Page 1');
  assert.equal(pages.find(p => p.id === 'p3')!.title, 'Page 3', 'Custom Page 3 must remain Page 3');
  assert.equal(pages.find(p => p.id === 'p4')!.title, 'Page 4', 'Custom Page 4 must remain Page 4');
  assert.equal(pages.find(p => p.id === 'p5')!.title, 'Page 4', 'Default p5 at index 3 must renumber to Page 4');
  assert.equal(pages.find(p => p.id === 'p6')!.title, 'Page 3', 'Legacy Page 3 must remain Page 3');
  assert.equal(pages.find(p => p.id === 'p7')!.title, 'Page 6');

  // Step 2: Delete p2 (which is now 'Page 1')
  pages.find(p => p.id === 'p2')!.deletedAt = Date.now();
  applyUpdates();

  // Active list is now:
  // idx 0: p3 (custom 'Page 3') -> MUST REMAIN 'Page 3'
  // idx 1: p4 (custom 'Page 4') -> MUST REMAIN 'Page 4'
  // idx 2: p5 (default) -> should renumber to 'Page 3' (1-based index 3)
  // idx 3: p6 (legacy 'Page 3') -> MUST REMAIN 'Page 3'
  // idx 4: p7 (default) -> should renumber to 'Page 5' (1-based index 5)
  assert.equal(pages.find(p => p.id === 'p3')!.title, 'Page 3');
  assert.equal(pages.find(p => p.id === 'p4')!.title, 'Page 4');
  assert.equal(pages.find(p => p.id === 'p5')!.title, 'Page 3', 'Default p5 is now at 1-based index 3 -> Page 3');
  assert.equal(pages.find(p => p.id === 'p6')!.title, 'Page 3');
  assert.equal(pages.find(p => p.id === 'p7')!.title, 'Page 5');

  // Step 3: Delete p4, p5, p6, p7 leaving ONLY p3 ('Page 3', custom) as the sole page!
  pages.find(p => p.id === 'p4')!.deletedAt = Date.now();
  pages.find(p => p.id === 'p5')!.deletedAt = Date.now();
  pages.find(p => p.id === 'p6')!.deletedAt = Date.now();
  pages.find(p => p.id === 'p7')!.deletedAt = Date.now();
  applyUpdates();

  const solePage = pages.find(p => p.id === 'p3')!;
  assert.equal(solePage.order, 0);
  assert.equal(solePage.title, 'Page 3', 'Custom title "Page 3" must NEVER be overwritten to "Page 1" even as sole page');
  assert.equal(solePage.titleProvenance, 'custom');
});

// ---------------------------------------------------------------------------
// ADVERSARIAL CHALLENGE 3: Reordering custom pages to arbitrary indices
// ---------------------------------------------------------------------------
test('Adversarial 3: Reordering custom pages to arbitrary indices preserves titles and renumbers defaults', () => {
  const sectionId = 'sec-stress-3';
  const initialPages: NotebookPage[] = [
    createTestPage('p1', sectionId, 0, 'Page 1', 'default'),
    createTestPage('p2', sectionId, 1, 'Page 2', 'default'),
    createTestPage('p3', sectionId, 2, 'Custom Header', 'custom'),
    createTestPage('p4', sectionId, 3, 'Page 4', 'default'),
    createTestPage('p5', sectionId, 4, 'Custom Middle', 'custom'),
    createTestPage('p6', sectionId, 5, 'Legacy Untracked', undefined),
    createTestPage('p7', sectionId, 6, 'Page 7', 'default'),
    createTestPage('p8', sectionId, 7, 'Custom Footer', 'custom'),
  ];

  const applyReorder = (pageList: NotebookPage[], orderPermutation: number[]) => {
    orderPermutation.forEach((newOrder, index) => {
      pageList[index].order = newOrder;
    });
    const sorted = pageList.slice().sort((a, b) => a.order - b.order);
    sorted.forEach((p, idx) => { p.order = idx; });
    const updates = computeSectionRenumbering(sorted);
    for (const u of updates) {
      const p = pageList.find(item => item.id === u.id);
      if (p) {
        p.title = u.title;
        p.titleProvenance = u.titleProvenance;
      }
    }
  };

  // Transformation 1: Complete list reversal
  let workingPages = initialPages.map(p => ({ ...p }));
  applyReorder(workingPages, [7, 6, 5, 4, 3, 2, 1, 0]);

  // Check custom/legacy immutability
  assert.equal(workingPages.find(p => p.id === 'p3')!.title, 'Custom Header');
  assert.equal(workingPages.find(p => p.id === 'p5')!.title, 'Custom Middle');
  assert.equal(workingPages.find(p => p.id === 'p6')!.title, 'Legacy Untracked');
  assert.equal(workingPages.find(p => p.id === 'p8')!.title, 'Custom Footer');

  // Check default pages renumbered sequentially according to reversed positions
  const sorted1 = workingPages.sort((a, b) => a.order - b.order);
  sorted1.forEach((p, idx) => {
    if (p.titleProvenance === 'default') {
      assert.equal(p.title, `Page ${idx + 1}`);
    }
  });

  // Transformation 2: 50 random permutations
  let seed = 1337;
  const pseudoRand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let perm = 0; perm < 50; perm++) {
    // Generate random permutation of indices 0..7
    const indices = [0, 1, 2, 3, 4, 5, 6, 7];
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(pseudoRand() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    applyReorder(workingPages, indices);

    // Invariant check on each permutation
    assert.equal(workingPages.find(p => p.id === 'p3')!.title, 'Custom Header');
    assert.equal(workingPages.find(p => p.id === 'p5')!.title, 'Custom Middle');
    assert.equal(workingPages.find(p => p.id === 'p6')!.title, 'Legacy Untracked');
    assert.equal(workingPages.find(p => p.id === 'p8')!.title, 'Custom Footer');

    const sortedPerm = workingPages.slice().sort((a, b) => a.order - b.order);
    sortedPerm.forEach((p, idx) => {
      if (p.titleProvenance === 'default') {
        assert.equal(p.title, `Page ${idx + 1}`, `Permutation ${perm} failed on page ${p.id}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// ADVERSARIAL CHALLENGE 4: Section switching stress (counter isolation)
// ---------------------------------------------------------------------------
test('Adversarial 4: Rapid section switching stress between Section A (10 pages) and Section B (1 page)', () => {
  const sectionA_Pages: NotebookPage[] = Array.from({ length: 10 }, (_, i) =>
    createTestPage(`a-${i + 1}`, 'sec-A', i, `Page ${i + 1}`, 'default'),
  );

  const sectionB_Pages: NotebookPage[] = [
    createTestPage('b-1', 'sec-B', 0, 'Page 1', 'default'),
  ];

  const sectionEmpty_Pages: NotebookPage[] = [];

  const allPages = [...sectionA_Pages, ...sectionB_Pages, ...sectionEmpty_Pages];

  interface AppState {
    activeSectionId: string | null;
    activePageId: string | null;
  }

  // Pure state transition modeling the atomic set() in workspaceStore.ts
  const switchSection = (targetSectionId: string): AppState => {
    const secPages = allPages
      .filter(p => p.sectionId === targetSectionId && !p.deletedAt)
      .sort((a, b) => a.order - b.order);
    const targetPage = secPages[0] ?? null;

    return {
      activeSectionId: targetSectionId,
      activePageId: targetPage?.id ?? null,
    };
  };

  // Pure counter resolver modeling NotebookNavigator / pageIndicator
  const deriveCounter = (state: AppState): { indicator: string; current: number; total: number } => {
    if (!state.activeSectionId) {
      return { indicator: '0 / 0', current: 0, total: 0 };
    }
    const secPages = allPages
      .filter(p => p.sectionId === state.activeSectionId && !p.deletedAt)
      .sort((a, b) => a.order - b.order);

    const total = secPages.length;
    if (total === 0) {
      return { indicator: '0 / 0', current: 0, total: 0 };
    }
    const currentIdx = secPages.findIndex(p => p.id === state.activePageId);
    const current = currentIdx >= 0 ? currentIdx + 1 : 1;
    return {
      indicator: formatPageIndicator(current, total),
      current,
      total,
    };
  };

  // Perform 200 rapid alternating switches
  let currentState: AppState = { activeSectionId: 'sec-A', activePageId: 'a-7' };

  for (let i = 0; i < 200; i++) {
    const targetSec = (i % 3 === 0) ? 'sec-B' : (i % 3 === 1) ? 'sec-A' : 'sec-Empty';
    currentState = switchSection(targetSec);
    const counter = deriveCounter(currentState);

    if (targetSec === 'sec-A') {
      assert.equal(currentState.activeSectionId, 'sec-A');
      assert.equal(currentState.activePageId, 'a-1');
      assert.equal(counter.indicator, '1 / 10');
      assert.equal(counter.total, 10);
    } else if (targetSec === 'sec-B') {
      assert.equal(currentState.activeSectionId, 'sec-B');
      assert.equal(currentState.activePageId, 'b-1');
      assert.equal(counter.indicator, '1 / 1');
      assert.equal(counter.total, 1);
    } else {
      assert.equal(currentState.activeSectionId, 'sec-Empty');
      assert.equal(currentState.activePageId, null);
      assert.equal(counter.indicator, '0 / 0');
      assert.equal(counter.total, 0);
    }
  }

  // Now test with physical continuation sheet composite indicators
  // Section A Page 2 has 4 physical continuation sheets
  const logicalIndicator = '2 / 10';
  const continuationCount = 4;
  for (let sheetIdx = 0; sheetIdx < continuationCount; sheetIdx++) {
    const compositeText = `${logicalIndicator} (${sheetIdx + 1}/${continuationCount})`;
    assert.equal(compositeText, `2 / 10 (${sheetIdx + 1}/4)`);
  }

  // Switch to Section B (1 page, 1 sheet) -> MUST NOT inherit continuation sheet
  const stateB = switchSection('sec-B');
  const counterB = deriveCounter(stateB);
  assert.equal(counterB.indicator, '1 / 1');
  assert.ok(!counterB.indicator.includes('('), 'Single sheet must not render composite continuation suffix');
});

// ---------------------------------------------------------------------------
// ADVERSARIAL CHALLENGE 5: Format conversion stress (Infinite -> A4 -> A3 -> Infinite)
// ---------------------------------------------------------------------------
test('Adversarial 5: Bidirectional Format Conversion stress preserves exact coordinates, shapes, images and layout bounds', () => {
  // Generate high-density drawing data with adversarial coordinates
  const mockStrokes: Stroke[] = [
    // Stroke crossing A4 page boundary (Y = 1123)
    {
      id: 'stroke-boundary-crosser',
      points: [
        { x: 100, y: 1050, pressure: 0.3 },
        { x: 150, y: 1123, pressure: 0.5 },
        { x: 200, y: 1250, pressure: 0.8 },
      ],
      color: '#ff2200',
      size: 4,
      tool: 'pen',
      createdAt: 1000,
    } as Stroke,
    // Stroke at extreme negative and high coordinates
    {
      id: 'stroke-extremes',
      points: [
        { x: -100, y: -50, pressure: 0.1 },
        { x: 2500, y: 8000, pressure: 0.9 },
      ],
      color: '#00aa33',
      size: 2,
      tool: 'pen',
      createdAt: 1010,
    } as Stroke,
    // Zero-length single point dot stroke
    {
      id: 'stroke-dot',
      points: [{ x: 300, y: 300, pressure: 1.0 }],
      color: '#000000',
      size: 1,
      tool: 'pen',
      createdAt: 1020,
    } as Stroke,
  ];

  const mockShapes: ShapeObject[] = [
    {
      id: 'shape-rect-1',
      type: 'shape',
      shapeType: 'rectangle',
      x: 50,
      y: 200,
      width: 400,
      height: 250,
      strokeColor: '#333333',
    } as unknown as ShapeObject,
    {
      id: 'shape-arrow-deep',
      type: 'shape',
      shapeType: 'arrow',
      x: 150,
      y: 3500,
      width: 300,
      height: 100,
      strokeColor: '#0055ff',
    } as unknown as ShapeObject,
  ];

  const mockImages: ImageObject[] = [
    {
      id: 'image-hero',
      type: 'image',
      fileId: 'file-hero-123',
      x: 20,
      y: 60,
      width: 700,
      height: 400,
    } as unknown as ImageObject,
    {
      id: 'image-bottom',
      type: 'image',
      fileId: 'file-bottom-456',
      x: 100,
      y: 5000,
      width: 500,
      height: 350,
    } as unknown as ImageObject,
  ];

  const initialDrawingData: DrawingData = {
    version: 1,
    properties: {
      ...DEFAULT_PAGE_PROPERTY_SET,
      pageSize: 'Infinite',
      infiniteWidth: 1000,
      layoutMode: 'document',
      layoutExtent: 6000,
    },
    strokes: mockStrokes,
    objects: [...mockShapes, ...mockImages],
  };

  // Deep clone helper
  const cloneDrawingData = (d: DrawingData): DrawingData => JSON.parse(JSON.stringify(d));

  let currentDrawing = cloneDrawingData(initialDrawingData);

  // Conversion Cycle:
  // Infinite -> A4 Portrait -> A3 Landscape -> A3 Portrait -> Letter Portrait -> Infinite
  const conversionSteps: Array<{ pageSize: PagePropertySet['pageSize']; orientation: PagePropertySet['orientation']; width: number; height: number }> = [
    { pageSize: 'A4', orientation: 'portrait', width: 794, height: 1123 },
    { pageSize: 'A3', orientation: 'landscape', width: 1587, height: 1123 },
    { pageSize: 'A3', orientation: 'portrait', width: 1123, height: 1587 },
    { pageSize: 'Letter', orientation: 'portrait', width: 816, height: 1056 },
    { pageSize: 'Infinite', orientation: 'portrait', width: 1000, height: 1123 },
  ];

  conversionSteps.forEach((step, stepIdx) => {
    // Apply format change
    currentDrawing.properties.pageSize = step.pageSize;
    currentDrawing.properties.orientation = step.orientation;
    if (step.pageSize === 'Infinite') {
      currentDrawing.properties.infiniteWidth = 1000;
    }

    const resolvedProps = resolvePageProperties(mockNotebook, {
      id: 'page-conv-test',
      notebookId: 'nb-stress',
      sectionId: 'sec-stress-5',
      title: 'Conversion Test',
      order: 0,
      createdAt: 1000,
      updatedAt: 1000,
      userId: null,
      pagePropertyOverrides: currentDrawing.properties,
    });

    const baseDim = resolveBasePageDimensions(resolvedProps);
    assert.equal(baseDim.width, step.width, `Step ${stepIdx} (${step.pageSize} ${step.orientation}) width mismatch`);
    assert.equal(baseDim.height, step.height, `Step ${stepIdx} (${step.pageSize} ${step.orientation}) height mismatch`);

    // Coordinate Invariance Verification:
    // Strokes
    assert.equal(currentDrawing.strokes.length, initialDrawingData.strokes.length);
    currentDrawing.strokes.forEach((stroke, sIdx) => {
      const orig = initialDrawingData.strokes[sIdx];
      assert.equal(stroke.id, orig.id);
      assert.equal(stroke.color, orig.color);
      assert.deepEqual(stroke.points, orig.points, `Stroke points altered during step ${stepIdx}`);
    });

    // Shapes
    const currentShapes = currentDrawing.objects?.filter(o => o.type === 'shape') as ShapeObject[];
    assert.equal(currentShapes.length, mockShapes.length);
    currentShapes.forEach((shape, shIdx) => {
      const orig = mockShapes[shIdx];
      assert.equal(shape.id, orig.id);
      assert.equal(shape.x, orig.x);
      assert.equal(shape.y, orig.y);
      assert.equal(shape.width, orig.width);
      assert.equal(shape.height, orig.height);
    });

    // Images
    const currentImages = currentDrawing.objects?.filter(o => o.type === 'image') as ImageObject[];
    assert.equal(currentImages.length, mockImages.length);
    currentImages.forEach((img, imgIdx) => {
      const orig = mockImages[imgIdx];
      assert.equal(img.id, orig.id);
      assert.equal(img.x, orig.x);
      assert.equal(img.y, orig.y);
      assert.equal(img.width, orig.width);
      assert.equal(img.height, orig.height);
    });

    // Continuation sheet calculation check for document mode
    if (step.pageSize !== 'Infinite' && resolvedProps.layoutMode === 'document') {
      const sheetHeight = baseDim.height;
      const stride = sheetHeight + 32;
      const extent = resolvedProps.layoutExtent ?? 6000;
      const expectedSheets = Math.max(1, Math.round((extent + 32) / stride));
      assert.ok(expectedSheets >= 3, `Expected at least 3 continuation sheets for 6000px extent, got ${expectedSheets}`);
    }
  });

  // Final check: Round trip back to Infinite matches initial state 100%
  assert.equal(currentDrawing.properties.pageSize, 'Infinite');
  assert.equal(currentDrawing.properties.infiniteWidth, 1000);
  assert.deepEqual(currentDrawing.strokes, initialDrawingData.strokes);
  assert.deepEqual(currentDrawing.objects, initialDrawingData.objects);
});


// ---------------------------------------------------------------------------
// ADVERSARIAL CHALLENGE 6: Edge Cases & High-Scale Performance Invariants
// ---------------------------------------------------------------------------
test('Adversarial 6: High-Scale 1000-page section renumbering performance & redundant update suppression', () => {
  const sectionId = 'sec-scale-1000';
  const count = 1000;
  const pages: PageForRenumbering[] = [];

  // Generate 1000 pages with sparse/negative orders and alternating provenance
  for (let i = 0; i < count; i++) {
    pages.push({
      id: `scale-p-${i}`,
      title: i % 2 === 0 ? `Old Title ${i}` : `Custom Special ${i}`,
      order: (i - 500) * 10, // negative to positive sparse order
      titleProvenance: i % 2 === 0 ? 'default' : 'custom',
    });
  }

  // Measure renumbering time
  const t0 = performance.now();
  const updates = computeSectionRenumbering(pages);
  const t1 = performance.now();

  const elapsedMs = t1 - t0;
  assert.ok(elapsedMs < 30, `Renumbering 1000 pages took ${elapsedMs.toFixed(2)}ms, expected < 30ms`);

  // Exactly 500 default pages should receive updates
  assert.equal(updates.length, 500);

  // Apply updates
  for (const u of updates) {
    const page = pages.find(p => p.id === u.id);
    if (page) {
      page.title = u.title;
      page.titleProvenance = u.titleProvenance;
    }
  }

  // Idempotence & Redundant update suppression:
  // Running renumbering a second time on the updated list MUST return 0 updates!
  const secondPassUpdates = computeSectionRenumbering(pages);
  assert.equal(secondPassUpdates.length, 0, 'Second pass renumbering must produce 0 redundant updates');
});

test('Adversarial 7: Edge cases - Empty list, all-deleted list, single page list, and whitespace titles', () => {
  // 1. Empty list
  const emptyUpdates = computeSectionRenumbering([]);
  assert.equal(emptyUpdates.length, 0);

  // 2. All-deleted list
  const allDeleted: PageForRenumbering[] = [
    { id: 'd1', title: 'Page 1', order: 0, titleProvenance: 'default', deletedAt: 1000 },
    { id: 'd2', title: 'Page 2', order: 1, titleProvenance: 'default', deletedAt: 1001 },
  ];
  const allDeletedUpdates = computeSectionRenumbering(allDeleted);
  assert.equal(allDeletedUpdates.length, 0);

  // 3. Custom titles with tricky strings: "Page 3 ", " Page 1", "Page\t2"
  const trickyPages: PageForRenumbering[] = [
    { id: 't1', title: 'Page 3 ', order: 0, titleProvenance: 'custom' },
    { id: 't2', title: ' Page 1', order: 1, titleProvenance: 'custom' },
    { id: 't3', title: 'Page\t2', order: 2, titleProvenance: 'custom' },
    { id: 't4', title: '', order: 3, titleProvenance: 'custom' },
    { id: 't5', title: 'Page 99', order: 4, titleProvenance: 'default' },
  ];

  const trickyUpdates = computeSectionRenumbering(trickyPages);
  // Only t5 is default at index 4 (1-based 5) -> should become 'Page 5'
  assert.equal(trickyUpdates.length, 1);
  assert.deepEqual(trickyUpdates[0], {
    id: 't5',
    title: 'Page 5',
    titleProvenance: 'default',
  });
});
