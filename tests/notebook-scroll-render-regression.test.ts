import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createEmptyDrawingData, type DrawingData } from '../src/components/notebook/engine/drawingTypes.ts';
import { resolvePageRenderProperties } from '../src/lib/pageProperties.ts';
import { DEFAULT_PAGE_PROPERTY_SET, type Notebook, type NotebookPage, type PagePropertySet } from '../src/types/notebook.ts';
import {
  mayApplyPageLoadToEngine,
  mergeLoadedPageData,
  isPaperColorOnlyUpdate,
  mayPersistPagePropertyChange,
  resolveNotebookPageRenderData,
} from '../src/components/notebook/notebookPageRenderState.ts';

function pageData(pageId: string, objectIds: string[]): DrawingData {
  const data = createEmptyDrawingData();
  data.objects = objectIds.map(id => ({
    id,
    type: id.includes('drawing') ? 'stroke' : id.includes('image') ? 'image' : id.includes('shape') ? 'shape' : 'text',
    createdAt: 1,
    x: 0,
    y: 0,
    metadata: { pageId, stickyNote: id.includes('sticky') },
  })) as DrawingData['objects'];
  return data;
}

function ids(data: DrawingData | undefined): string[] {
  return (data?.objects ?? []).map(object => object.id);
}

const appearance = (paperColor: string, ruleLineColor: string, template: PagePropertySet['template']): PagePropertySet => ({
  ...DEFAULT_PAGE_PROPERTY_SET,
  paperColor,
  ruleLineColor,
  template,
});

test('page appearance is identical across active and inactive scroll transitions', () => {
  const notebook = {
    id: 'notebook', workspaceId: 'workspace', folderId: null, name: 'Notebook', createdAt: 1, updatedAt: 1,
    order: 0, isExpanded: true, userId: null,
    defaultPageProperties: appearance('#171717', '#525252', 'Large grid'),
  } satisfies Notebook;
  const pages = ['A', 'B', 'C'].map((id, order) => ({
    id, notebookId: notebook.id, sectionId: 'section', title: id, createdAt: 1, updatedAt: 1, order,
    userId: null, pagePropertyOverrides: {},
  } satisfies NotebookPage));
  const cached = {
    A: appearance('#ffffff', '#94a3b8', 'Ruled'),
    B: appearance('#fff4cc', '#b45309', 'Dotted'),
    C: appearance('#e0f2fe', '#0369a1', 'Small grid'),
  };
  const sequence = ['A', 'B', 'B', 'C', 'C', 'A'];

  for (const activePageId of sequence) {
    for (const page of pages) {
      const resolved = resolvePageRenderProperties(notebook, page, cached[page.id as keyof typeof cached]);
      assert.deepEqual(
        { paperColor: resolved.paperColor, ruleLineColor: resolved.ruleLineColor, template: resolved.template },
        { paperColor: cached[page.id as keyof typeof cached].paperColor, ruleLineColor: cached[page.id as keyof typeof cached].ruleLineColor, template: cached[page.id as keyof typeof cached].template },
        `Page ${page.id} appearance changed while active page was ${activePageId}`,
      );
    }
  }
});

test('persisted page objects survive active, inactive, offscreen, visible and active transitions', () => {
  const pageA = pageData('A', ['A-sticky', 'A-drawing', 'A-text', 'A-image', 'A-shape']);
  const pageB = pageData('B', ['B-text', 'B-drawing']);
  const pageC = pageData('C', ['C-text', 'C-image']);
  const cache = { A: pageA, B: pageB, C: pageC };
  const expectedA = ids(pageA);

  const transitions = [
    { focused: 'A', visible: true },
    { focused: 'B', visible: true },
    { focused: 'B', visible: false },
    { focused: 'B', visible: true },
    { focused: 'A', visible: true },
  ];

  for (const transition of transitions) {
    const resolved = resolveNotebookPageRenderData(
      'A',
      transition.focused,
      cache,
      transition.focused === 'A' ? pageA : undefined,
    );
    assert.deepEqual(ids(resolved), expectedA, `Page A changed while focused=${transition.focused}, visible=${transition.visible}`);
  }

  assert.deepEqual(ids(resolveNotebookPageRenderData('B', 'A', cache, pageA)), ['B-text', 'B-drawing']);
  assert.deepEqual(ids(resolveNotebookPageRenderData('C', 'B', cache, pageB)), ['C-text', 'C-image']);
  assert.deepEqual(ids(cache.A), expectedA, 'visibility transitions must not mutate canonical page data');
});

test('late repository snapshots fill gaps without replacing newer page data', () => {
  const currentA = pageData('A', ['A-sticky', 'A-drawing', 'A-text', 'A-image']);
  const staleEmptyA = pageData('A', []);
  const loadedB = pageData('B', ['B-shape']);
  const merged = mergeLoadedPageData({ A: currentA }, { A: staleEmptyA, B: loadedB });

  assert.equal(merged.A, currentA);
  assert.deepEqual(ids(merged.A), ['A-sticky', 'A-drawing', 'A-text', 'A-image']);
  assert.equal(merged.B, loadedB);
});

test('stale focused-page loads cannot write into another page engine', () => {
  assert.equal(mayApplyPageLoadToEngine('A', 'B', 1, 2), false);
  assert.equal(mayApplyPageLoadToEngine('B', 'B', 1, 2), false);
  assert.equal(mayApplyPageLoadToEngine('B', 'B', 2, 2), true);
});

test('scroll focus detaches interaction but engine destruction remains owner-only', async () => {
  const [renderer, pageView, engine] = await Promise.all([
    readFile('src/components/notebook/NotebookRenderer.tsx', 'utf8'),
    readFile('src/components/notebook/NotebookPageView.tsx', 'utf8'),
    readFile('src/components/notebook/engine/NotebookEngine.ts', 'utf8'),
  ]);

  assert.equal((renderer.match(/notebookEngine\.destroy\(\)/g) ?? []).length, 1);
  assert.match(renderer, /return \(\) => notebookEngine\.destroy\(\)/);
  assert.doesNotMatch(pageView, /notebookEngine\.destroy\(\)/);
  assert.match(pageView, /notebookEngine\.unmount\(\)/);
  assert.match(renderer, /key=\{pos\.id\}/);
  assert.match(renderer, /const incomingData = sectionDataCacheRef\.current\[targetPageId\];/);
  assert.match(renderer, /if \(!incomingData\)[\s\S]*setActivePage\(targetPageId\);[\s\S]*return;/);
  assert.doesNotMatch(renderer, /sectionDataCacheRef\.current\[targetPageId\] \|\| \{/);
  assert.match(renderer, /notebookEngine\.unmount\(\);[\s\S]*notebookEngine\.setDrawingData\(incomingData, targetPageId\);/);
  assert.match(engine, /mount\([\s\S]*if \(!this\.unsubscribeDrawingRevision\)[\s\S]*if \(!this\.unsubscribeHistoryRevision\)/);
});

test('shared interaction handoff preserves page-owned visual and ownership guards', async () => {
  const [renderer, pageView] = await Promise.all([
    readFile('src/components/notebook/NotebookRenderer.tsx', 'utf8'),
    readFile('src/components/notebook/NotebookPageView.tsx', 'utf8'),
  ]);
  assert.match(renderer, /key=\{pos\.id\}/);
  assert.match(renderer, /sceneOwnerPageId=\{isFocused \? notebookEngine\.getDrawingOwnership\(\)\.pageId/);
  assert.doesNotMatch(pageView, /clearCanvasSurface/);
  assert.match(pageView, /data-stable-page-visual=\{page.id\}/);
  assert.match(pageView, /data-committed-page-id=\{page.id\}/);
  assert.match(renderer, /residentIds.has\(pos.id\) \|\| isFocused/);
  assert.doesNotMatch(renderer, /<InactivePagePreview/);
  assert.match(renderer, /if \(backing\) backing.style.visibility = 'visible'/);
  assert.match(pageView, /data-rendered-page-id=\{page\.id\}/);
  assert.match(pageView, /data-scene-owner-page-id=\{sceneOwnerPageId\}/);
  assert.match(pageView, /visibility: liveSceneReady \? 'visible' : 'hidden'/);
  assert.match(pageView, /const liveSceneReady = isFocused && sceneReady/);
  assert.match(pageView, /\{liveSceneReady && layeredDrawing && orderedLayers\.map/);
  assert.match(pageView, /\{liveSceneReady && liveTextObjects\.map/);
  assert.match(pageView, /if \(!liveSceneReady/);
  assert.match(pageView, /getCanvasElement\(\) === canvas/);
});

test('paper color updates keep the retained scene surface and persistence path metadata-only', async () => {
  const [pageView, renderer, engine] = await Promise.all([
    readFile('src/components/notebook/NotebookPageView.tsx', 'utf8'),
    readFile('src/components/notebook/NotebookRenderer.tsx', 'utf8'),
    readFile('src/components/notebook/engine/NotebookEngine.ts', 'utf8'),
  ]);

  assert.equal(isPaperColorOnlyUpdate({ paperColor: '#232323' }), true);
  assert.equal(isPaperColorOnlyUpdate({ paperColor: '#232323', template: 'Ruled' }), false);
  assert.equal(mayPersistPagePropertyChange('appearance'), false);

  // The retained-canvas effect tracks scene identities, not the data wrapper
  // whose properties field is replaced by a palette click.
  assert.match(pageView, /data\?\.objects/);
  assert.match(pageView, /data\?\.strokes/);
  assert.match(pageView, /data\?\.shapes/);
  assert.match(pageView, /data\?\.layers/);
  assert.doesNotMatch(pageView, /\}, \[data, width, height, page\.type/);

  assert.match(renderer, /notebookEngine\.setProperties\(properties, isPaperColorOnlyChange \? 'appearance' : 'user'\)/);
  assert.match(engine, /setProperties\(updates: Partial<PageProperties>, source: PagePropertyChangeSource = 'user'\)/);
  assert.match(engine, /if \(source !== 'appearance'\) this\.drawingRevision \+= 1/);
});


test('resident window stays bounded over repeated 5/10/20/50-page traversal, reorder and restore', async () => {
  const { residentPageIds } = await import('../src/components/notebook/pageVisualWindow.ts');
  for (const count of [5, 10, 20, 50]) {
    const pages = Array.from({ length: count }, (_, i) => ({ id: `page-${i}`, x: 0, y: i * 1020, width: 700, height: 1000 }));
    for (let pass = 0; pass < 4; pass++) for (let index = 0; index < count; index++) {
      const top = index * 1020 + 600;
      const resident = residentPageIds(pages, top, 800);
      assert.ok(resident.size <= 4);
      for (const page of pages.filter(p => p.y + p.height >= top && p.y <= top + 800)) assert.ok(resident.has(page.id));
    }
    const reordered = pages.map((p, i) => ({ ...p, id: pages[count - i - 1].id }));
    assert.ok(residentPageIds(reordered, 0, 800).has(pages[count - 1].id));
    assert.ok(!residentPageIds(pages.filter(p => p.id !== 'page-0'), 0, 800).has('page-0'));
    assert.ok(residentPageIds(pages, 0, 800).has('page-0'));
  }
});

test('seam deadband prevents repeated ownership churn and follows a fast jump', async () => {
  const { dominantPageId } = await import('../src/components/notebook/pageVisualWindow.ts');
  const pages = Array.from({ length: 10 }, (_, i) => ({ id: String(i), x: 0, y: i * 1020, width: 700, height: 1000 }));
  let focus = '0';
  for (const center of [998, 1005, 1015, 1002, 1020, 1010]) {
    focus = dominantPageId(pages, center, focus, 24)!;
    assert.equal(focus, '0');
  }
  focus = dominantPageId(pages, 1045, focus, 24)!;
  assert.equal(focus, '1');
  for (const center of [1015, 1005, 1010]) assert.equal(dominantPageId(pages, center, focus, 24), '1');
  assert.equal(dominantPageId(pages, 9500, focus, 24), '9');
});
