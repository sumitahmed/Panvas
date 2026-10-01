import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  capturePageGeometryAnchor,
  derivePagePropertyOverrides,
  getNotebookPageDefaults,
  resolveNotebookPageLayout,
  resolvePageDimensions,
  resolvePageGeometryScrollDelta,
  resolvePageProperties,
  resolvePageRenderProperties,
  resolvePageSurfaceGeometry,
  resolvePageTemplateRenderModel,
  resolveNotebookPaperColor,
  resolveNotebookLineColor,
} from '../src/lib/pageProperties.ts';
import { formatPageIndicator } from '../src/components/notebook/pageIndicator.ts';
import { createDefaultDrawingData } from '../src/components/notebook/engine/drawingTypes.ts';
import { DEFAULT_PAGE_PROPERTY_SET, type Notebook, type NotebookPage, type PagePropertySet } from '../src/types/notebook.ts';

const notebook: Notebook = {
  id: 'notebook-test', workspaceId: 'workspace-test', folderId: null, name: 'Test',
  createdAt: 1, updatedAt: 1, order: 0, isExpanded: true, userId: null,
  defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET, template: 'Ruled', paperColor: '#fff9c4' },
};

const page: NotebookPage = {
  id: 'page-test', notebookId: notebook.id, sectionId: 'section-test', title: 'Page',
  createdAt: 1, updatedAt: 1, order: 0, userId: null,
};

for (const template of ['Double margin ruled', 'Large ruled with margin'] as const) {
  test(`${template} uses the same canonical style for current-page saves and notebook defaults`, async () => {
    const ipc = await readFile(new URL('../electron/ipc/domain-handlers.ts', import.meta.url), 'utf8');
    const accepted = new Set([...ipc.match(/const PAGE_TEMPLATES = new Set\(\[([\s\S]*?)\]\)/)![1].matchAll(/'([^']+)'/g)].map(match => match[1]));
    assert.ok(accepted.has(template), `${template} must pass Electron page-property validation`);
    const properties: PagePropertySet = { ...DEFAULT_PAGE_PROPERTY_SET, template, paperColor: '#E8F5E9', ruleLineColor: '#64748b', margins: 'No Margin', orientation: 'landscape', pageSize: 'A5' };
    const overrides = JSON.parse(JSON.stringify(derivePagePropertyOverrides(properties, notebook)));
    assert.deepEqual(resolvePageProperties(notebook, { ...page, pagePropertyOverrides: overrides }), properties);
    assert.deepEqual(resolvePageProperties({ ...notebook, defaultPageProperties: JSON.parse(JSON.stringify(properties)) }, { ...page, pagePropertyOverrides: {} }), properties);
    assert.match(ipc, /channel === 'notebook:applyPageDefaults'\) requirePagePropertyPatch/);
    assert.match(ipc, /key === 'defaultPageProperties' \|\| key === 'pagePropertyOverrides'\) requirePagePropertyPatch/);
  });
}

test('legacy pages retain persisted drawing properties until metadata inheritance is established', () => {
  const resolved = resolvePageProperties(notebook, page, {
    ...DEFAULT_PAGE_PROPERTY_SET,
    template: 'Dotted',
  });
  assert.equal(resolved.template, 'Dotted');
  assert.equal(resolved.paperColor, '#ffffff');
});

test('shared template preview emits visible representative structures at thumbnail scale', async t => {
  const [{ createServer }, React, { renderToStaticMarkup }, path] = await Promise.all([
    import('vite'), import('react'), import('react-dom/server'), import('node:path'),
  ]);
  const server = await createServer({
    configFile: false, root: process.cwd(), appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true },
    resolve: { alias: { '@': path.resolve('src') } },
  });
  t.after(() => server.close());
  const { TemplatePreview } = await server.ssrLoadModule('/src/components/notebook/templates/TemplatePreview.tsx');
  const render = (template: PagePropertySet['template']) => renderToStaticMarkup(React.createElement(TemplatePreview, {
    template, properties: { ...DEFAULT_PAGE_PROPERTY_SET, template, ruleLineColor: '#4b83c4' },
  }));
  const blank = render('Blank');
  const ruled = render('Ruled');
  const narrow = render('Narrow ruled');
  const wide = render('Wide ruled');
  const grid = render('Small grid');
  const largeGrid = render('Large grid');
  const dotted = render('Dotted');
  const engineering = render('Engineering');
  const cornell = render('Cornell');
  const music = render('Music');
  const calendar = render('Calendar');
  assert.doesNotMatch(blank, /<(?:path|line|circle|pattern)\b/);
  for (const markup of [ruled, narrow, wide, grid, largeGrid, engineering, cornell, music, calendar]) {
    assert.match(markup, /vector-effect="non-scaling-stroke"/);
    assert.match(markup, /stroke-width="(?:1\.05|[2-9]|[1-9][0-9])/);
  }
  assert.notEqual(ruled, narrow);
  assert.notEqual(narrow, wide);
  assert.notEqual(grid, largeGrid);
  assert.match(grid, /<pattern[\s\S]*<path/);
  assert.match(engineering, /engineering-minor[\s\S]*engineering-major/);
  assert.match(dotted, /<circle[^>]*r="5"/);
  assert.match(cornell, /<line/g);
  assert.match(music, /<line/g);
  assert.match(calendar, /<rect/g);
});

test('notebook document colors are stable across application themes and legacy defaults', () => {
  assert.equal(resolveNotebookPaperColor(undefined), '#ffffff');
  assert.equal(resolveNotebookPaperColor('default'), '#ffffff');
  assert.equal(resolveNotebookPaperColor('#232323'), '#232323');
  assert.equal(resolveNotebookPaperColor('#FFF9C4'), '#FFF9C4');
  assert.equal(resolveNotebookLineColor(undefined), '#e0e0e0');
  assert.equal(resolveNotebookLineColor('default'), '#e0e0e0');
  assert.equal(resolveNotebookLineColor('#67e8f9'), '#67e8f9');
});

test('page renderer consumes literal paper and line colors instead of UI theme tokens', async () => {
  const [renderer, registry] = await Promise.all([
    readFile(new URL('../src/components/notebook/PageRenderer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/templates/TemplateRegistry.tsx', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(renderer, /useUIStore|theme === 'dark'|theme === 'ink'/);
  assert.match(renderer, /const renderModel = resolvePageTemplateRenderModel\(properties\)/);
  assert.match(renderer, /renderSVG\(geometry\.width, geometry\.height, effectiveLineColor, false, templateResourceScope\)/);
  assert.match(registry, /'Large grid'[\s\S]*<path[\s\S]*stroke=\{color\}/);
  assert.match(registry, /Dotted[\s\S]*<circle[\s\S]*fill=\{color\}/);
  assert.match(registry, /Engineering[\s\S]*stroke=\{color\}[\s\S]*opacity="0\.6"/);
  assert.doesNotMatch(registry, /id="pat-(?:small-grid|large-grid|dotted|eng-minor|eng-major)"/);
});

test('final page SVG painter scopes pattern resources and paints every supported grid with the selected hue', async t => {
  const [{ createServer }, React, { renderToStaticMarkup }, path] = await Promise.all([
    import('vite'),
    import('react'),
    import('react-dom/server'),
    import('node:path'),
  ]);
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: { '@': path.resolve('src') } },
  });
  t.after(() => server.close());
  const { PageRenderer } = await server.ssrLoadModule('/src/components/notebook/PageRenderer.tsx');

  const renderPage = (template: PagePropertySet['template'], ruleLineColor: string, id = 'paint-test', extra: Partial<PagePropertySet> = {}) =>
    renderToStaticMarkup(React.createElement(PageRenderer, {
      id,
      width: 794,
      height: 1123,
      properties: { ...DEFAULT_PAGE_PROPERTY_SET, paperColor: '#232323', template, ruleLineColor, ...extra },
    }));

  const red = renderPage('Large grid', '#ff0000');
  const green = renderPage('Large grid', '#00ff00');
  const purple = renderPage('Large grid', '#8000ff');
  assert.match(red, /background-color:#232323/);
  assert.match(red, /stroke="#ff0000"/);
  assert.match(green, /stroke="#00ff00"/);
  assert.match(purple, /stroke="#8000ff"/);
  assert.notEqual(red, green);
  assert.notEqual(green, purple);

  for (const theme of ['light', 'dark', 'system']) {
    const themed = renderToStaticMarkup(React.createElement('div', { 'data-theme': theme },
      React.createElement(PageRenderer, {
        id: `theme-${theme}`,
        width: 794,
        height: 1123,
        properties: { ...DEFAULT_PAGE_PROPERTY_SET, paperColor: '#fff4cc', template: 'Dotted', ruleLineColor: '#b45309' },
      }),
    ));
    assert.match(themed, /background-color:#fff4cc/);
    assert.match(themed, /fill="#b45309"/);
  }

  const simultaneousPages = renderToStaticMarkup(React.createElement('div', null,
    React.createElement(PageRenderer, {
      id: 'red-page', width: 794, height: 1123,
      properties: { ...DEFAULT_PAGE_PROPERTY_SET, template: 'Large grid', ruleLineColor: '#ff0000' },
    }),
    React.createElement(PageRenderer, {
      id: 'green-page', width: 794, height: 1123,
      properties: { ...DEFAULT_PAGE_PROPERTY_SET, template: 'Large grid', ruleLineColor: '#00ff00' },
    }),
  ));
  const largeGridIds = [...simultaneousPages.matchAll(/<pattern id="([^"]+-large-grid)"/g)].map(match => match[1]);
  assert.equal(largeGridIds.length, 2);
  assert.equal(new Set(largeGridIds).size, 2, 'each mounted page must own a distinct SVG paint server');
  for (const id of largeGridIds) assert.match(simultaneousPages, new RegExp(`fill="url\\(#${id}\\)"`));

  assert.match(renderPage('Small grid', '#ef4444'), /stroke="#ef4444"/);
  assert.match(renderPage('Ruled', '#22c55e'), /stroke="#22c55e"/);
  assert.match(renderPage('Dotted', '#a855f7'), /fill="#a855f7"/);
  const engineering = renderPage('Engineering', '#14b8a6');
  assert.equal((engineering.match(/stroke="#14b8a6"/g) ?? []).length, 2);
  assert.match(renderPage('Large grid', '#12abef'), /stroke="#12abef"/);

  const researchSpace = renderPage('Large grid', '#dc2626', 'research-space', {
    extraTop: 80, extraRight: 40, extraBottom: 120, extraLeft: 60,
  });
  assert.match(researchSpace, /viewBox="0 0 894 1323"/);
  assert.match(researchSpace, /<rect width="894" height="1323" fill="url\(#[^"]+-large-grid\)"/);
  assert.match(researchSpace, /stroke="#dc2626"/);

  const reloaded = resolvePageProperties(notebook, {
    ...page,
    pagePropertyOverrides: { template: 'Large grid', paperColor: '#232323', ruleLineColor: '#7c3aed' },
  });
  const reloadedMarkup = renderToStaticMarkup(React.createElement(PageRenderer, {
    id: 'reloaded-page', width: 794, height: 1123, properties: reloaded,
  }));
  assert.match(reloadedMarkup, /stroke="#7c3aed"/);

  const [pageView, inactivePreview] = await Promise.all([
    readFile(new URL('../src/components/notebook/NotebookPageView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/InactivePagePreview.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(pageView, /<PageRenderer[\s\S]*properties=\{properties\}/);
  assert.match(inactivePreview, /<PageRenderer[\s\S]*properties=\{properties\}/);
  assert.match(inactivePreview, /resolvePageProperties\(notebook, page, resolved\.properties\)/);
  assert.doesNotMatch(inactivePreview, /useNotebookSettingsStore/);
});

test('final page template render model changes with line color and preserves custom literals', () => {
  const base = { ...DEFAULT_PAGE_PROPERTY_SET, template: 'Large grid' as const };
  const red = resolvePageTemplateRenderModel({ ...base, ruleLineColor: '#ff0000' });
  const blue = resolvePageTemplateRenderModel({ ...base, ruleLineColor: '#0000ff' });
  const custom = resolvePageTemplateRenderModel({ ...base, ruleLineColor: 'rgb(255, 0, 170)' });

  assert.equal(red.lineColor, '#ff0000');
  assert.equal(blue.lineColor, '#0000ff');
  assert.equal(custom.lineColor, 'rgb(255, 0, 170)');
  assert.notEqual(red.lineColor, blue.lineColor);
  assert.equal(red.template, 'Large grid');
  assert.equal(red.width, 794);
  assert.equal(red.height, 1123);
});

test('active and inactive render properties prefer the newer cache over stale metadata overrides', () => {
  const staleMetadataPage = {
    ...page,
    pagePropertyOverrides: { ruleLineColor: '#67e8f9', template: 'Large grid' as const },
  };
  const cached = { ...DEFAULT_PAGE_PROPERTY_SET, template: 'Large grid' as const, ruleLineColor: '#ff0000' };
  const visible = resolvePageRenderProperties(notebook, staleMetadataPage, cached);
  const inactive = resolvePageRenderProperties(notebook, staleMetadataPage, cached);
  const uncached = resolvePageRenderProperties(notebook, staleMetadataPage, undefined);

  assert.equal(visible.ruleLineColor, '#ff0000');
  assert.equal(visible.template, 'Large grid');
  assert.equal(inactive.ruleLineColor, '#ff0000');
  assert.equal(uncached.ruleLineColor, '#67e8f9');
});

test('new pages inherit notebook defaults and store only differences', () => {
  const inheritedPage = { ...page, pagePropertyOverrides: {} };
  const inherited = resolvePageProperties(notebook, inheritedPage, {
    ...DEFAULT_PAGE_PROPERTY_SET,
    template: 'Dotted',
  });
  assert.deepEqual(inherited, getNotebookPageDefaults(notebook));

  const edited = { ...inherited, margins: 'Wide' as const, paperColor: '#ffffff' };
  assert.deepEqual(derivePagePropertyOverrides(edited, notebook), {
    paperColor: '#ffffff',
    margins: 'Wide',
  });
});

test('page overrides win over notebook defaults deterministically', () => {
  const resolved = resolvePageProperties(notebook, {
    ...page,
    pagePropertyOverrides: { orientation: 'landscape', template: 'Engineering' },
  });
  assert.equal(resolved.paperColor, '#fff9c4');
  assert.equal(resolved.orientation, 'landscape');
  assert.equal(resolved.template, 'Engineering');
});

test('editable template field values are page-specific persisted overrides', () => {
  const properties = {
    ...getNotebookPageDefaults(notebook),
    template: 'Journal' as const,
    templateFields: { date: '8 September', 'mood-weather': 'Clear' },
  };
  const overrides = derivePagePropertyOverrides(properties, notebook);
  assert.deepEqual(overrides.templateFields, { date: '8 September', 'mood-weather': 'Clear' });
  assert.deepEqual(resolvePageProperties(notebook, { ...page, pagePropertyOverrides: overrides }).templateFields, properties.templateFields);
});

test('A3, A4, A5, and Letter source dimensions resolve independently in both orientations', () => {
  assert.deepEqual(resolvePageDimensions({ ...DEFAULT_PAGE_PROPERTY_SET, pageSize: 'A3' }), { width: 1123, height: 1587 });
  assert.deepEqual(resolvePageDimensions({ ...DEFAULT_PAGE_PROPERTY_SET, pageSize: 'A3', orientation: 'landscape' }), { width: 1587, height: 1123 });
  assert.deepEqual(resolvePageDimensions({ ...DEFAULT_PAGE_PROPERTY_SET, pageSize: 'A4' }), { width: 794, height: 1123 });
  assert.deepEqual(resolvePageDimensions({ ...DEFAULT_PAGE_PROPERTY_SET, pageSize: 'A4', orientation: 'landscape' }), { width: 1123, height: 794 });
  assert.deepEqual(resolvePageDimensions({ ...DEFAULT_PAGE_PROPERTY_SET, pageSize: 'A5' }), { width: 595, height: 842 });
  assert.deepEqual(resolvePageDimensions({ ...DEFAULT_PAGE_PROPERTY_SET, pageSize: 'A5', orientation: 'landscape' }), { width: 842, height: 595 });
  assert.deepEqual(resolvePageDimensions({ ...DEFAULT_PAGE_PROPERTY_SET, pageSize: 'Letter' }), { width: 816, height: 1056 });
  assert.deepEqual(resolvePageDimensions({ ...DEFAULT_PAGE_PROPERTY_SET, pageSize: 'Letter', orientation: 'landscape' }), { width: 1056, height: 816 });
});

test('four-sided research space preserves the source frame and persists as page overrides', () => {
  const properties = { ...DEFAULT_PAGE_PROPERTY_SET, extraTop: 120, extraRight: 80, extraBottom: 240, extraLeft: 60 };
  assert.deepEqual(resolvePageSurfaceGeometry(properties), {
    width: 934,
    height: 1483,
    source: { left: 60, top: 120, width: 794, height: 1123 },
    noteSpace: { top: 120, right: 80, bottom: 240, left: 60 },
  });
  const overrides = derivePagePropertyOverrides(properties);
  assert.deepEqual({ extraTop: overrides.extraTop, extraRight: overrides.extraRight, extraBottom: overrides.extraBottom, extraLeft: overrides.extraLeft }, { extraTop: 120, extraRight: 80, extraBottom: 240, extraLeft: 60 });
});

test('expanded page height is persisted geometry and participates in section layout', () => {
  const expanded = { ...DEFAULT_PAGE_PROPERTY_SET, extraHeight: 560 };
  assert.deepEqual(resolvePageDimensions(expanded), { width: 794, height: 1683 });
  const layout = resolveNotebookPageLayout([
    { id: 'expanded', properties: expanded },
    { id: 'normal', properties: DEFAULT_PAGE_PROPERTY_SET },
  ]);
  assert.equal(layout.positions[1].y, 32 + 1683 + 32);
  const notebook = { id: 'n', defaultPageProperties: DEFAULT_PAGE_PROPERTY_SET } as any;
  const overrides = derivePagePropertyOverrides(expanded, notebook);
  assert.equal(overrides.extraHeight, 560);
  assert.equal(resolvePageProperties(notebook, { id: 'p', pagePropertyOverrides: overrides } as any).extraHeight, 560);
});

test('page counters stay deterministic and wide enough for large page counts', async () => {
  assert.equal(formatPageIndicator(1, 1), '1 / 1');
  assert.equal(formatPageIndicator(12, 12), '12 / 12');
  assert.equal(formatPageIndicator(99, 120), '99 / 120');
  assert.equal(formatPageIndicator(999, 1200), '999 / 1200');
  const renderer = await readFile(new URL('../src/components/notebook/PageRenderer.tsx', import.meta.url), 'utf8');
  assert.match(renderer, /whitespace-nowrap/);
  assert.match(renderer, /minWidth: 84/);
});

test('Portrait/Landscape/Portrait pages retain heterogeneous centered vertical geometry', () => {
  const pages = [
    { id: 'portrait-1', properties: { ...DEFAULT_PAGE_PROPERTY_SET } },
    { id: 'landscape', properties: { ...DEFAULT_PAGE_PROPERTY_SET, orientation: 'landscape' as const } },
    { id: 'portrait-2', properties: { ...DEFAULT_PAGE_PROPERTY_SET } },
  ];
  const layout = resolveNotebookPageLayout(pages);

  assert.deepEqual(layout.positions, [
    { id: 'portrait-1', x: 164.5, y: 32, width: 794, height: 1123 },
    { id: 'landscape', x: 0, y: 1187, width: 1123, height: 794 },
    { id: 'portrait-2', x: 164.5, y: 2013, width: 794, height: 1123 },
  ]);
  assert.equal(layout.totalWidth, 1123);
  assert.equal(layout.totalHeight, 3168);
});

test('switching focused page cannot change section geometry or per-page renderer dimensions', async () => {
  const pages = [
    { id: 'portrait', properties: { ...DEFAULT_PAGE_PROPERTY_SET } },
    { id: 'landscape', properties: { ...DEFAULT_PAGE_PROPERTY_SET, orientation: 'landscape' as const } },
  ];
  const geometryBeforeFocusChange = resolveNotebookPageLayout(pages);
  const geometryAfterFocusChange = resolveNotebookPageLayout(pages);
  assert.deepEqual(geometryAfterFocusChange.positions, geometryBeforeFocusChange.positions);

  const renderer = await readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8');
  assert.match(renderer, /width=\{pos\.width\}/);
  assert.match(renderer, /height=\{pos\.height\}/);
  assert.match(renderer, /properties=\{resolvedSectionProperties\.get\(pos\.id\)!\}/);
  assert.doesNotMatch(renderer, /resolveNotebookPageLayout\([^)]*focusedPageId/s);
});

test('orientation geometry resolves to one stable focal-position transition', async () => {
  const portrait = { left: 100, top: 50, width: 794, height: 1123 };
  const viewportCenter = { x: 497, y: 611.5 };
  const anchor = capturePageGeometryAnchor(portrait, viewportCenter);
  const landscapeBeforeCorrection = { left: 100, top: 50, width: 1123, height: 794 };
  const delta = resolvePageGeometryScrollDelta(anchor, landscapeBeforeCorrection);
  assert.deepEqual(delta, { x: 164.5, y: -164.5 });

  const landscapeAfterCorrection = {
    ...landscapeBeforeCorrection,
    left: landscapeBeforeCorrection.left - delta.x,
    top: landscapeBeforeCorrection.top - delta.y,
  };
  assert.deepEqual(resolvePageGeometryScrollDelta(anchor, landscapeAfterCorrection), { x: 0, y: 0 });

  const [renderer, pageView] = await Promise.all([
    readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/NotebookPageView.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(renderer, /pageGeometryTransitionRef\.current/);
  assert.match(renderer, /capturePageGeometryAnchor/);
  assert.match(renderer, /resolvePageGeometryScrollDelta/);
  assert.doesNotMatch(pageView, /\[isFocused, notebookEngine, width, height, page\.type, page\.id, renderScale\]/);
  assert.match(pageView, /notebookEngine\.resize\(width, height\)/);
});

test('desktop persistence accepts note-space fields and page/canvas creation stays inline', async () => {
  const [ipc, uiStore, tree] = await Promise.all([
    readFile(new URL('../electron/ipc/domain-handlers.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/stores/uiStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/workspace/WorkspaceTree.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(ipc, /'templateFields', 'extraHeight', 'extraTop', 'extraRight', 'extraBottom', 'extraLeft'/);
  assert.match(uiStore, /type === 'page' \|\| type === 'canvas'[\s\S]*inlineCreate: \{ type, parentId, parentType \}/);
  assert.match(tree, /function InlineCreateRow/);
  assert.match(tree, /event\.key === 'Enter'/);
  assert.match(tree, /event\.key === 'Escape'/);
  assert.match(tree, /onBlur=\{\(\) => \{ if \(!committingRef\.current\) closeInlineCreate\(\); \}\}/);
});

test('createDefaultDrawingData preserves all page properties including ruleLineColor and margins', () => {
  const customSettings: Partial<PagePropertySet> = {
    paperColor: '#ffffff',
    template: 'Large grid',
    ruleLineColor: '#86efac',
    orientation: 'portrait',
    pageSize: 'A4',
    margins: 'No Margin',
  };
  const data = createDefaultDrawingData(customSettings);
  assert.equal(data.properties.template, 'Large grid');
  assert.equal(data.properties.ruleLineColor, '#86efac');
  assert.equal(data.properties.margins, 'No Margin');
  assert.equal(data.properties.paperColor, '#ffffff');
  assert.equal(data.properties.orientation, 'portrait');
  assert.equal(data.properties.pageSize, 'A4');
});

test('applying page defaults to notebook propagates template, line color, margins to new pages while research space remains page-specific', async () => {
  const updatedNotebook: Notebook = {
    ...notebook,
    defaultPageProperties: {
      ...DEFAULT_PAGE_PROPERTY_SET,
      template: 'Large grid',
      ruleLineColor: '#86efac',
      margins: 'No Margin',
      paperColor: '#ffffff',
      orientation: 'portrait',
      pageSize: 'A4',
    },
  };

  // Newly created page with empty overrides inherits the notebook's updated defaults
  const newPage: NotebookPage = {
    id: 'page-4',
    notebookId: updatedNotebook.id,
    sectionId: 'section-test',
    title: 'Page 4',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: 3,
    userId: null,
    pagePropertyOverrides: {},
  };
  const resolvedNewPage = resolvePageProperties(updatedNotebook, newPage);
  assert.equal(resolvedNewPage.template, 'Large grid');
  assert.equal(resolvedNewPage.ruleLineColor, '#86efac');
  assert.equal(resolvedNewPage.margins, 'No Margin');

  // Page with research space keeps its extra margins while inheriting the updated defaults
  const pageWithResearchSpace: NotebookPage = {
    id: 'page-with-space',
    notebookId: updatedNotebook.id,
    sectionId: 'section-test',
    title: 'Page with space',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: 4,
    userId: null,
    pagePropertyOverrides: {
      extraTop: 140,
      extraRight: 140,
    },
  };
  const resolvedResearchPage = resolvePageProperties(updatedNotebook, pageWithResearchSpace);
  assert.equal(resolvedResearchPage.template, 'Large grid');
  assert.equal(resolvedResearchPage.ruleLineColor, '#86efac');
  assert.equal(resolvedResearchPage.margins, 'No Margin');
  assert.equal(resolvedResearchPage.extraTop, 140);
  assert.equal(resolvedResearchPage.extraRight, 140);

  // Verify properties panel source isolates NoteSpaceControl from batch apply
  const panelSource = await readFile(new URL('../src/components/notebook/NotebookToolPropertiesPanel.tsx', import.meta.url), 'utf8');
  assert.match(panelSource, /<NoteSpaceControl properties=\{properties\} onChange=\{onUpdateProperties\} \/>/);
  assert.match(panelSource, /executeBatchApply\(applicableUpdates\)/);
});
