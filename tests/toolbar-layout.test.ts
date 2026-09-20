import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  resolveToolbarLayout,
  resolveFullscreenToolbarLayout,
  TOOLBAR_COMPACT_BREAKPOINT,
  TOOLBAR_FULL_BREAKPOINT,
  TOOLBAR_MEDIUM_BREAKPOINT,
  TOOLBAR_MINIMAL_CELL_WIDTH,
  TOOLBAR_GROUP_ORDER,
  TOOLBAR_GROUP_WIDTHS,
  recordRecentColor,
} from '../src/components/notebook/toolbarLayout.ts';
import {
  MAX_ACTIVE_CANVAS_PIXELS,
  MAX_CANVAS_DIMENSION,
  MAX_INACTIVE_PAGE_RENDER_ZOOM,
  resolveCanvasBackingScale,
} from '../src/components/notebook/engine/ViewportManager.ts';

const ALL_GROUPS = [...TOOLBAR_GROUP_ORDER];
// Smallest width at which the fit check can still show every group:
// chrome + overflow button + all group widths.
const FULL_FIT_WIDTH =
  70 + ALL_GROUPS.reduce((sum, id) => sum + TOOLBAR_GROUP_WIDTHS[id], 0);

test('unknown width (before first measurement) renders every group', () => {
  const layout = resolveToolbarLayout(null);
  assert.deepEqual(layout.visible, ['history', 'handwriting', 'primary', 'select', 'shapes']);
  assert.deepEqual(layout.overflow, ['hand', 'image', 'ruler', 'laser', 'gestures', 'format']);
  assert.equal(layout.compact, false);
});

test('desktop bracket (>= full breakpoint) keeps every group directly visible', () => {
  for (const width of [TOOLBAR_FULL_BREAKPOINT, 1200, 1600]) {
    const layout = resolveToolbarLayout(width);
    assert.deepEqual(layout.visible, ['history', 'handwriting', 'primary', 'select', 'shapes'], `width ${width}`);
    assert.deepEqual(layout.overflow, ['hand', 'image', 'ruler', 'laser', 'gestures', 'format'], `width ${width}`);
  }
});

test('half-window bracket (720-959px) keeps primary tools and select, moves secondary groups into More', () => {
  for (const width of [TOOLBAR_MEDIUM_BREAKPOINT, 800, 959]) {
    const layout = resolveToolbarLayout(width);
    assert.deepEqual(layout.visible, ['history', 'handwriting', 'primary', 'select', 'shapes'], `width ${width}`);
    assert.deepEqual(layout.overflow, ['hand', 'image', 'ruler', 'laser', 'gestures', 'format'], `width ${width}`);
    assert.equal(layout.compact, false, `width ${width}`);
  }
});

test('small desktop bracket keeps handwriting recognition and all primary writing tools direct', () => {
  for (const width of [TOOLBAR_COMPACT_BREAKPOINT, 640, 719]) {
    const layout = resolveToolbarLayout(width);
    assert.deepEqual(layout.visible.slice(0, 3), ['history', 'handwriting', 'primary'], `width ${width}`);
    if (width >= 600) assert.ok(layout.visible.includes('select'), `width ${width}`);
    assert.equal(layout.compact, false, `width ${width}`);
  }
});

test('narrow bracket (< 560px) collapses to history + active-tool + More', () => {
  for (const width of [559, 480, 360]) {
    const layout = resolveToolbarLayout(width);
    assert.equal(layout.compact, true, `width ${width}`);
    assert.deepEqual(
      layout.visible.slice(0, 3),
      ['history', 'handwriting', 'active-tool'],
      `width ${width}`,
    );
    // Select stays unless the width cannot hold it.
    if (layout.visible.length > 3) {
      assert.equal(layout.visible[3], 'select', `width ${width}`);
    }
    // Primary tools remain reachable through the overflow menu.
    assert.ok(layout.overflow.includes('primary'), `width ${width}`);
  }
});

test('compact active Select is represented once and is not duplicated in More', () => {
  for (const width of [195, 269, 360, 559]) {
    const layout = resolveToolbarLayout(width, 'select');
    assert.ok(layout.visible.includes('active-tool'), `width ${width}`);
    assert.ok(!layout.visible.includes('select'), `width ${width}`);
    assert.ok(!layout.overflow.includes('select'), `width ${width}`);
  }
});

test('fullscreen active Select is not repeated in an overflow group', () => {
  const layout = resolveFullscreenToolbarLayout(620, 'select');
  assert.ok(!layout.overflow.includes('select'));
});

test('every tool group is always either visible or in the overflow menu', () => {
  const widths = [null, 100, 150, 195, 360, 480, 559, 560, 640, 719, 720, 800, 959, 960, 1200];
  for (const width of widths) {
    const layout = resolveToolbarLayout(width);
    const accounted = new Set<string>(layout.visible);
    for (const group of layout.overflow) accounted.add(group);
    for (const group of ALL_GROUPS) {
      assert.ok(accounted.has(group), `group ${group} missing at width ${width}`);
    }
  }
});

test('the rendered toolbar never exceeds the measured container width', () => {
  const PADDING_AND_HIDE = 70;
  const MORE_BUTTON = 48;
  // Below ~172px not even the minimal tier (chrome + active-tool + More)
  // fits; that range is outside every supported target (Electron enforces
  // minWidth 680, leaving the toolbar cell >= ~195px) and is documented as a
  // browser-only floor.
  for (let width = 180; width <= 1600; width += 20) {
    const layout = resolveToolbarLayout(width);
    const inlineWidth = layout.visible.reduce(
      (sum, id) => sum + TOOLBAR_GROUP_WIDTHS[id],
      0,
    );
    const chrome = PADDING_AND_HIDE + (layout.overflow.length > 0 ? MORE_BUTTON : 0);
    assert.ok(
      chrome + inlineWidth <= width,
      `toolbar (${chrome + inlineWidth}px) exceeds container at width ${width}`,
    );
  }
});

test('minimal tier keeps recognition direct when it fits and otherwise keeps only the active tool', () => {
  // Worst case reachable in Electron: 680px window minimum with the 280px
  // sidebar open leaves the toolbar cell around 195px.
  for (const width of [100, TOOLBAR_MINIMAL_CELL_WIDTH, 195]) {
    const layout = resolveToolbarLayout(width);
    assert.equal(layout.compact, true, `width ${width}`);
    assert.deepEqual(layout.visible, ['active-tool'], `width ${width}`);
    assert.ok(layout.overflow.includes('primary'), `width ${width}`);
    assert.ok(layout.overflow.includes('history'), `width ${width}`);
  }
  const recognitionTier = resolveToolbarLayout(269);
  assert.deepEqual(recognitionTier.visible, ['handwriting', 'active-tool']);
  assert.ok(recognitionTier.overflow.includes('history'));
});

test('history is directly visible whenever the cell can hold it', () => {
  for (const width of [340, 400, 559]) {
    const layout = resolveToolbarLayout(width);
    assert.ok(layout.visible.includes('history'), `width ${width}`);
  }
  // Below the minimal cell width history moves into the overflow menu.
  const layout = resolveToolbarLayout(150);
  assert.ok(!layout.visible.includes('history'));
  assert.ok(layout.overflow.includes('history'));
});

test('group order overflows secondary tools before primary tools', () => {
  // The overflow list must be a suffix of the group order, and 'primary' may
  // never be overflowed while 'format' is still visible.
  assert.equal(TOOLBAR_GROUP_ORDER.indexOf('primary') < TOOLBAR_GROUP_ORDER.indexOf('format'), true);
  const layout = resolveToolbarLayout(720);
  assert.equal(layout.overflow.includes('format'), true);
  assert.equal(layout.overflow.includes('primary'), false);
});

test('Shapes family is direct at medium and wide widths, overflowed when narrow, and never duplicated', () => {
  for (const width of [720, 960, TOOLBAR_FULL_BREAKPOINT, 1600]) {
    const layout = resolveToolbarLayout(width, 'shapes');
    assert.ok(layout.visible.includes('shapes'), `width ${width}`);
    assert.ok(!layout.overflow.includes('shapes'), `width ${width}`);
  }
  for (const width of [195, 480, 640]) {
    const layout = resolveToolbarLayout(width);
    assert.ok(layout.overflow.includes('shapes'), `width ${width}`);
    assert.ok(!layout.visible.includes('shapes'), `width ${width}`);
  }
});

test('desktop primary sequence fits before the More button', () => {
  const layout = resolveToolbarLayout(TOOLBAR_FULL_BREAKPOINT);
  const directWidth = 70 + 48 + layout.visible.reduce((sum, id) => sum + TOOLBAR_GROUP_WIDTHS[id], 0);
  assert.ok(directWidth <= TOOLBAR_FULL_BREAKPOINT);
  assert.ok(FULL_FIT_WIDTH > directWidth);
});

test('primary toolbar source order is Undo, Redo, Handwriting, Pencil, Pen, Marker, Highlighter, Eraser, Text, Select', async () => {
  const toolbar = await readFile(new URL('../src/components/notebook/NotebookFloatingToolbar.tsx', import.meta.url), 'utf8');
  const keys = ['key="undo"', 'key="redo"', 'key="handwriting-to-text"', 'key="pencil"', 'key="pen"', 'key="marker"', 'key="highlighter"', 'key="eraser"', 'key="text"', 'key="select"'];
  const positions = keys.map(key => toolbar.indexOf(key));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test('toolbar exposes one Shapes family trigger backed by the complete existing picker', async () => {
  const toolbar = await readFile(new URL('../src/components/notebook/NotebookFloatingToolbar.tsx', import.meta.url), 'utf8');
  assert.equal((toolbar.match(/key="shapes-family"/g) ?? []).length, 1);
  for (const shape of ['rectangle', 'rounded-rectangle', 'ellipse', 'triangle', 'diamond', 'line', 'arrow']) {
    assert.match(toolbar, new RegExp(`id: '${shape}'`));
  }
});

test('fullscreen notebook chrome is one hideable drawing-tool header', async () => {
  const [renderer, toolbar] = await Promise.all([
    readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/NotebookFloatingToolbar.tsx', import.meta.url), 'utf8'),
  ]);
  const start = renderer.indexOf('aria-label="Fullscreen notebook tools"');
  // Stop before the normal-mode utility header so the assertions only inspect
  // the fullscreen branch itself.
  const end = renderer.indexOf("{!isMobileViewport && workspaceViewMode !== 'present' && notebookModeLevel !== 2", start);
  assert.ok(start >= 0 && end > start, 'fullscreen toolbar block should be present');
  const fullscreen = renderer.slice(start, end);
  assert.match(renderer, /aria-label="Fullscreen notebook tools"/);
  assert.match(fullscreen, /<NotebookFloatingToolbar[^>]+embedded[^>]+hideCollapseButton[^>]+fullscreenToolOnly/);
  assert.doesNotMatch(fullscreen, /<NotebookPageUtilities/);
  assert.match(fullscreen, /<NotebookWorkspaceControls focusOnly embedded/);
  assert.match(fullscreen, /aria-label="Hide fullscreen tools"/);
  assert.match(renderer, /aria-label="Show fullscreen tools and exit control"/);
  assert.match(toolbar, /embedded \? 'px-1 py-1' : 'panvas-toolbar-surface panvas-floating-surface px-3 py-2 max-\[599px\]:px-1\.5 max-\[599px\]:py-1'/);
  assert.match(toolbar, /resolveFullscreenToolbarLayout/);
  assert.match(toolbar, /WritingPresetStrip/);
});

test('fullscreen layout prioritizes history, writing tools, and select before secondary tools', () => {
  const layout = resolveFullscreenToolbarLayout(820);
  assert.deepEqual(layout.visible, ['history', 'handwriting', 'primary', 'select']);
  assert.ok(layout.overflow.includes('hand'));
  assert.ok(layout.overflow.includes('gestures'));

  const narrow = resolveFullscreenToolbarLayout(620);
  assert.ok(narrow.visible.includes('primary'));
  assert.ok(narrow.overflow.includes('shapes'));
});

test('fullscreen desktop host exposes all writing tools from available host width', async () => {
  const renderer = await readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8');
  const layout = resolveFullscreenToolbarLayout(900);
  assert.deepEqual(layout.visible, ['history', 'handwriting', 'primary', 'select']);
  assert.match(renderer, /left-3 right-3 top-3[^\"]*min-w-0/);
  assert.match(renderer, /availableWidth=\{fullscreenToolbarHostWidth/);
  assert.doesNotMatch(renderer, /aria-label="Fullscreen notebook tools"[^>]+left-1\/2/);
});

test('fullscreen measurement host is full-width but the painted toolbar surface is content-width', async () => {
  const [renderer, toolbar] = await Promise.all([
    readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/NotebookFloatingToolbar.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(renderer, /panvas-fullscreen-toolbar-host[^\"]*left-3 right-3[^\"]*justify-center/);
  assert.match(renderer, /panvas-layer-toolbar panvas-floating-surface flex w-fit max-w-full/);
  assert.doesNotMatch(renderer, /panvas-layer-toolbar panvas-floating-surface absolute left-3 right-3/);
  assert.match(toolbar, /fullscreenToolOnly \? 'w-auto max-w-full' : 'w-full'/);
});

test('fullscreen exit remains beside the expanded toolbar and reachable after restore', async () => {
  const renderer = await readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8');
  const start = renderer.indexOf("notebookModeLevel === 2");
  const end = renderer.indexOf("notebookModeLevel !== 2", start);
  const fullscreen = renderer.slice(start, end);
  assert.match(fullscreen, /NotebookWorkspaceControls focusOnly embedded/);
  assert.match(fullscreen, /aria-label="Hide fullscreen tools"/);
  assert.match(fullscreen, /aria-label="Show fullscreen tools and exit control"/);
});

test('writing presets are outside the primary toolbar flex flow', async () => {
  const toolbar = await readFile(new URL('../src/components/notebook/NotebookFloatingToolbar.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(toolbar, /groupId === 'primary' && showInlineWritingPresets/);
  assert.match(toolbar, /panvas-writing-preset-host[^\"]*absolute[^\"]*top-full/);
});

test('text formatting and writing presets are mutually exclusive contextual surfaces', async () => {
  const toolbar = await readFile(new URL('../src/components/notebook/NotebookFloatingToolbar.tsx', import.meta.url), 'utf8');
  assert.match(toolbar, /<TextFormattingStrip editor=\{editor\} engine=\{engine\} enabled=\{activeTool === 'text'\}/);
  assert.match(toolbar, /if \(!enabled \|\| !resolvedEditor\) return null/);
});

test('Select exposes the existing freehand lasso behavior contextually without adding a primary tool', async () => {
  const toolbar = await readFile(new URL('../src/components/notebook/NotebookFloatingToolbar.tsx', import.meta.url), 'utf8');
  assert.match(toolbar, /showSelectionGuide = !isPhone && activeTool === 'select'/);
  assert.match(toolbar, /aria-label="Select tool options"/);
  assert.match(toolbar, /Lasso Select/);
  assert.match(toolbar, /Click an object, or drag a freeform boundary/);
  assert.equal((toolbar.match(/key="select"/g) ?? []).length, 1);
});

test('recent writing colors stay tool-local, unique, and capped at five', () => {
  const pen = recordRecentColor(['#000000', '#2563eb', '#dc2626', '#16a34a', '#7c3aed'], '#F97316');
  const pencil = recordRecentColor(['#333333', '#2563eb'], '#333333');
  assert.deepEqual(pen, ['#F97316', '#000000', '#2563eb', '#dc2626', '#16a34a']);
  assert.deepEqual(pencil, ['#333333', '#2563eb']);
  assert.notDeepEqual(pen, pencil);
});

test('A5 at 400% and DPR1 renders at native 400% backing resolution', () => {
  const scale = resolveCanvasBackingScale(1, 4, 595, 842);
  assert.equal(scale, 4);
  assert.equal(Math.floor(595 * scale), 2380);
  assert.equal(Math.floor(842 * scale), 3368);
});

test('canvas backing dimensions never exceed dimension or pixel budgets', () => {
  for (const [width, height, dpr, zoom] of [
    [794, 1123, 1, 4],
    [1123, 794, 2, 4],
    [595, 842, 3, 4],
    [4000, 3000, 2, 4],
  ]) {
    const scale = resolveCanvasBackingScale(dpr, zoom, width, height);
    const backingWidth = Math.floor(width * scale);
    const backingHeight = Math.floor(height * scale);
    assert.ok(backingWidth <= MAX_CANVAS_DIMENSION);
    assert.ok(backingHeight <= MAX_CANVAS_DIMENSION);
    assert.ok(backingWidth * backingHeight <= MAX_ACTIVE_CANVAS_PIXELS);
  }
});

test('high-DPR 400% backing remains bounded and active pages exceed inactive previews', async () => {
  const active = resolveCanvasBackingScale(3, 4, 595, 842);
  const inactive = resolveCanvasBackingScale(3, Math.min(4, MAX_INACTIVE_PAGE_RENDER_ZOOM), 595, 842);
  assert.ok(active < 12);
  assert.ok(active > inactive);
  assert.ok(Math.floor(595 * active) * Math.floor(842 * active) <= MAX_ACTIVE_CANVAS_PIXELS);

  const pageView = await readFile(new URL('../src/components/notebook/NotebookPageView.tsx', import.meta.url), 'utf8');
  assert.match(pageView, /notebookEngine.drawing.setScaleMultiplier\(renderScale\)/);
  assert.match(pageView, /Math\.min\(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM\)/);
  assert.match(pageView, /drawing\.setScaleMultiplier\(Math\.min\(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM\)\)/);
});

test('fullscreen utility controls remain toggle buttons rather than drawing-tool state', async () => {
  const utilities = await readFile(new URL('../src/components/notebook/NotebookPageUtilities.tsx', import.meta.url), 'utf8');
  const layers = await readFile(new URL('../src/components/notebook/NotebookLayersControl.tsx', import.meta.url), 'utf8');
  const elements = await readFile(new URL('../src/components/notebook/NotebookElementsControl.tsx', import.meta.url), 'utf8');
  assert.match(utilities, /setIsPdfMenuOpen\(value => !value\)/);
  assert.match(layers, /setIsOpen\(value => !value\)/);
  assert.match(elements, /setIsOpen\(value => !value\)/);
  assert.doesNotMatch(utilities, /setMode|setDrawingTool/);
});

test('insert-page affordance is page-anchored fully outside the paper bounds', async () => {
  const renderer = await readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8');
  assert.match(renderer, /isFocused && workspaceViewMode === 'edit'/);
  assert.match(renderer, /panvas-insert-page-button[^\"]*absolute bottom-0 left-full ml-3[^\"]*h-8 w-8 rounded-full/);
  assert.doesNotMatch(renderer, /<span>Insert page<\/span>/);
  const headerBeforeViewport = renderer.slice(renderer.indexOf('Responsive Floating Header'), renderer.indexOf('Native Scrolling Viewport'));
  assert.doesNotMatch(headerBeforeViewport, /aria-label="Insert page after current page"/);
});
