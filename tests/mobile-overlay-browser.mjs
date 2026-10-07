import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const quick = process.argv.includes('--quick');
const sweepOnly = process.argv.includes('--sweep-only');
const output = path.resolve('artifacts/mobile-overlays');
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-mobile-overlays-'));
await mkdir(output, { recursive: true });
const server = await createServer({ mode: 'web', logLevel: 'error', cacheDir: path.join(directory, 'vite'), server: { port: 0, open: false, hmr: false }, plugins: [{
  name: 'overlay-regression-observation', enforce: 'pre',
  async transform(code, id) {
    id = id.replaceAll('\\', '/').split('?')[0];
    if (id.endsWith('/NotebookEngine.ts')) code = code.replace('mount(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): void {', '$& (window.__overlayEngines ??= new Set()).add(this);');
    return { code, map: null };
  },
}] });
await server.listen();
const origin = server.resolvedUrls.local[0];
const report = { productionApp: true, cases: [], sweep: [] };
const errors = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.on('pageerror', error => errors.push(error.message));
const frames = (count = 3) => page.evaluate(async count => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame); }, count);
const button = (name, parent = page) => parent.getByRole('button', { name, exact: true });
const more = page.getByRole('menu', { name: 'More Tools', exact: true });
const portraits = [[320, 568], [360, 640], [360, 800], [375, 667], [375, 812], [390, 844], [393, 873], [412, 915], [430, 932]];
const viewports = quick ? [[320, 568], [390, 844], [667, 375]] : [...portraits, ...portraits.map(([w, h]) => [h, w]), [360, 568], [568, 360]];

async function geometry(locator) {
  return locator.evaluate(element => {
    const b = element.getBoundingClientRect(), v = visualViewport;
    const dock = document.querySelector('.panvas-mobile-tool-dock')?.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      viewport: { left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, width: v?.width ?? innerWidth, height: v?.height ?? innerHeight },
      dockTop: dock?.top, dockInset: document.documentElement.style.getPropertyValue('--panvas-tool-dock-inset'), computedBottom: getComputedStyle(element).bottom, maxHeight: getComputedStyle(element).maxHeight, overflowY: getComputedStyle(element).overflowY };
  });
}
function inside(box, name) {
  assert.ok(box.x >= box.viewport.left - 1 && box.y >= box.viewport.top - 1
    && box.right <= box.viewport.left + box.viewport.width + 1 && box.bottom <= box.viewport.top + box.viewport.height + 1, `${name} fits visual viewport: ${JSON.stringify(box)}`);
  if (box.dockTop != null) assert.ok(box.bottom <= box.dockTop - 3, `${name} is above dock: ${JSON.stringify(box)}`);
  assert.ok(box.scrollWidth <= box.clientWidth + 1, `${name} has no horizontal overflow`);
}
async function openMore() {
  if (!await more.isVisible()) await button('More Tools').click();
  await frames();
}
async function reachable(locator, name) {
  await locator.scrollIntoViewIfNeeded(); await frames(2);
  inside(await geometry(locator), name);
  assert.ok(await locator.evaluate(element => {
    const b = element.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return hit && element.contains(hit);
  }), `${name} is unobscured and receives pointer input`);
}
async function currentEngineState() {
  return page.evaluate(() => {
    const e = [...window.__overlayEngines].find(e => e.drawing.getCanvasElement()?.isConnected);
    return { objects: e.getDrawingData().objects.length, owner: e.getDrawingOwnership().pageId };
  });
}
async function resetTool() {
  await page.evaluate(() => [...window.__overlayEngines].find(e => e.drawing.getCanvasElement()?.isConnected).tools.setMode('hand'));
  await frames();
}
async function inspectPanel(panel, name, kind, width, height, fullPage) {
  const root = panel.locator('xpath=ancestor-or-self::*[@data-panvas-overlay-id][1]');
  const box = await geometry(await root.count() ? root : panel);
  report.sweep.push({ name, kind, width, height, fullPage, box });
  inside(box, name);
  const controls = panel.locator('button, select, input:not([type=hidden])');
  if (await controls.count()) {
    await reachable(controls.first(), `${name} first control`);
    await reachable(controls.last(), `${name} last control`);
  }
}
async function sweep(kind, width, height, fullPage) {
  const check = (panel, name) => inspectPanel(panel, name, kind, width, height, fullPage);
  if (kind === 'notebook') {
    const utilities = await openUtilities();
    const exportTrigger = button('Export and print', utilities);
    await reachable(exportTrigger, 'Export and print'); await exportTrigger.click(); await frames();
    await check(page.getByRole('menu', { name: 'Export and print', exact: true }), 'Export and print menu');
    assert.ok(await more.isVisible(), 'the export submenu keeps its parent More menu open');
    await exportTrigger.click(); await closeOverlays();
  }
  for (const name of ['Layers', 'Local Elements']) {
    const utilities = await openUtilities();
    await reachable(button(name, utilities), name); await button(name, utilities).click(); await frames();
    await check(page.getByRole('dialog', { name, exact: true }), name);
    await closeOverlays();
  }
  await openMore(); await reachable(button('Sticky notes', more), 'Sticky notes'); await button('Sticky notes', more).click(); await frames();
  await check(page.getByLabel('Sticky note gallery', { exact: true }), 'Sticky note gallery');
  await page.locator('button[aria-label="Sticky notes"][aria-expanded="true"]').click(); await closeOverlays();
  await openMore(); await reachable(button('Pencil (N)', more), 'Pencil'); await button('Pencil (N)', more).click(); await frames();
  const pencil = page.getByRole('dialog', { name: 'Pencil settings', exact: true });
  await check(pencil, 'Pencil settings');
  await button('Close Pencil settings', pencil).click();
  await openMore(); await reachable(button('Shapes', more), 'Shapes'); await button('Shapes', more).click(); await frames();
  const shapes = button('Close shape settings').locator('..').locator('..');
  await check(shapes, 'Shape settings'); await button('Close shape settings').click();
  await openMore(); await reachable(button('Ink Gestures', more), 'Ink Gestures'); await button('Ink Gestures', more).click(); await frames();
  const gestures = page.getByRole('dialog', { name: 'Ink Gestures', exact: true });
  await check(gestures, 'Ink Gestures'); await button('Close Ink Gestures', gestures).click();
  await openMore(); await reachable(button('Handwriting to Text', more), 'Handwriting to Text'); await button('Handwriting to Text', more).click(); await frames();
  if (await button('Dismiss notification').isVisible()) await button('Dismiss notification').click();
  const strip = page.getByLabel('Handwriting to Text settings', { exact: true });
  if (await strip.count()) await check(strip, 'H2T settings');
  await openMore();
  const paletteTrigger = button('Open Handwriting palette', more);
  await reachable(paletteTrigger, 'H2T color palette'); await paletteTrigger.click(); await frames();
  const palette = page.getByRole('dialog', { name: 'Handwriting to Text palette', exact: true });
  await check(palette, 'H2T color palette'); await button('Close Handwriting to Text palette', palette).click(); await openMore();
  const textOutput = button('Text output settings');
  assert.equal(await textOutput.count(), 1, 'H2T output controls remain reachable on compact screens');
  await reachable(textOutput, 'H2T text output'); await textOutput.click(); await frames();
  const outputSettings = page.getByRole('dialog', { name: 'Text output settings', exact: true });
  await check(outputSettings, 'H2T text output settings');
  await button('Output font', outputSettings).click(); await frames();
  const fonts = page.getByRole('listbox', { name: 'Output font', exact: true });
  await check(fonts, 'Font choices');
  await reachable(fonts.getByRole('option').last(), 'Last font');
  await fonts.getByRole('option').filter({ hasText: 'Inter' }).first().click(); await frames();
  assert.ok(await outputSettings.isVisible(), 'choosing a font keeps the parent H2T settings open');
  await closeOverlays(); await resetTool();
  await openMore(); await reachable(button('Open page and view inspector', more), 'Page and view');
  await button('Open page and view inspector', more).click(); await frames();
  const properties = page.locator(kind === 'pdf' ? '.panvas-view-inspector' : '.panvas-properties-panel');
  await check(properties, 'Page and view / Page Properties');
  if (kind === 'notebook') {
    await properties.locator('select:has(option[value="Ruled"])').selectOption('Ruled');
    await frames(4);
    const lineColor = button('Choose line color', properties);
    await reachable(lineColor, 'Line color'); await lineColor.click(); await frames();
    const linePalette = page.getByRole('dialog', { name: 'Line color choices', exact: true });
    await check(linePalette, 'Page line color palette');
    const sheetClose = button('Close panel', linePalette.locator('..'));
    if (await sheetClose.count()) await sheetClose.click(); else await lineColor.click();
    await button('Close Page Properties', properties).click();
  } else {
    await button('Close page and view inspector', properties).click();
    await openMore(); await reachable(button('PDF pages', more), 'PDF pages'); await button('PDF pages', more).click(); await frames();
    const drawer = page.getByLabel('PDF page thumbnails', { exact: true });
    await check(drawer.locator('..'), 'PDF pages drawer');
    await button('Toggle Sidebar').click();
    await openMore(); await reachable(button('PDF page controls', more), 'PDF page controls'); await button('PDF page controls', more).click(); await frames();
    const controls = page.locator('.panvas-pdf-controls-sheet');
    await check(controls, 'PDF zoom and export'); await button('Done', controls).click();
  }
  await frames(); console.log('SWEEP PASS', kind, `${width}x${height}`, fullPage ? 'Full Page' : 'normal');
}
async function viewportChanges() {
  await chooseDocument('pdf'); await page.setViewportSize({ width: 390, height: 844 }); await frames(5);
  await openMore();
  for (const height of [568, 844, 320, 844]) {
    await page.setViewportSize({ width: 390, height }); await frames(5);
    inside(await geometry(more), 'More after browser chrome resize');
    await reachable(more.locator('button').last(), 'Last item after browser chrome resize');
  }
  await page.evaluate(() => {
    const mock = { width: 370, height: 300, offsetLeft: 10, offsetTop: 24 };
    window.__overlayViewportMock = mock;
    for (const key of Object.keys(mock)) Object.defineProperty(visualViewport, key, { configurable: true, get: () => mock[key] });
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await frames(5);
  const keyboard = await geometry(more);
  inside(keyboard, 'More after keyboard-only VisualViewport resize');
  assert.equal(await page.evaluate(() => innerHeight), 844, 'only VisualViewport changed, not the layout viewport');
  await reachable(more.locator('button').first(), 'First item above keyboard');
  await reachable(more.locator('button').last(), 'Last item above keyboard');
  await page.evaluate(() => { window.__overlayViewportMock.offsetTop = 52; visualViewport.dispatchEvent(new Event('scroll')); });
  await frames(5); inside(await geometry(more), 'More after VisualViewport offset changes');
  await page.evaluate(() => {
    for (const key of Object.keys(window.__overlayViewportMock)) delete visualViewport[key];
    delete window.__overlayViewportMock; visualViewport.dispatchEvent(new Event('resize'));
  });
  const safeArea = await page.addStyleTag({ content: '.panvas-anchored-overlay{--panvas-overlay-safe-top:20px!important;--panvas-overlay-safe-left:12px!important;--panvas-overlay-safe-right:16px!important}.panvas-mobile-tool-dock{padding-bottom:34px!important}' });
  await frames(5); await page.evaluate(() => visualViewport.dispatchEvent(new Event('resize'))); await frames(5);
  const safe = await geometry(more); inside(safe, 'More with safe area and larger dock');
  assert.ok(safe.y >= 32 && safe.x >= 24 && safe.right <= 390 - 28, 'safe-area margins are retained');
  await reachable(more.locator('button').last(), 'Last item with safe-area dock padding');
  await safeArea.evaluate(element => element.remove()); await closeOverlays();
  report.viewportChanges = { browserChrome: true, keyboardOnly: true, visualViewportScroll: true, safeArea: true, keyboard, safe };
  console.log('PASS VisualViewport resize, offsets, keyboard simulation and safe areas');
}
async function stickyControls() {
  await chooseDocument('notebook'); await page.setViewportSize({ width: 320, height: 568 }); await frames(5);
  await openMore(); await reachable(button('Sticky notes', more), 'Sticky notes'); await button('Sticky notes', more).click(); await frames();
  const gallery = page.getByLabel('Sticky note gallery', { exact: true });
  await gallery.locator('button').first().click(); await closeOverlays(); await frames(5);
  const sticky = page.locator('[data-text-object-id]').last();
  await sticky.scrollIntoViewIfNeeded(); await frames(5);
  const data = await page.evaluate(() => [...window.__overlayEngines].find(e => e.drawing.getCanvasElement()?.isConnected).getDrawingData());
  for (const name of ['Sticky note color', 'Sticky note shape']) {
    await sticky.getByRole('button', { name, exact: true }).click(); await frames();
    const controls = page.getByRole('toolbar', { name: 'Sticky note controls', exact: true });
    await inspectPanel(controls, name, 'notebook', 320, 568, false);
    await reachable(button('Close sticky note style', controls), 'Close sticky note controls');
    await button('Close sticky note style', controls).click();
  }
  assert.deepEqual(await page.evaluate(() => [...window.__overlayEngines].find(e => e.drawing.getCanvasElement()?.isConnected).getDrawingData()), data, 'opening contextual controls preserves the sticky and ink');
  console.log('PASS sticky color and shape controls');
}
async function exportDismissal() {
  await chooseDocument('notebook'); await page.setViewportSize({ width: 320, height: 568 }); await frames(5);
  const initialState = await currentEngineState();
  for (const method of ['Escape', 'outside pointer']) {
    const utilities = await openUtilities();
    await button('Export and print', utilities).click(); await frames();
    const menu = page.getByRole('menu', { name: 'Export and print', exact: true });
    inside(await geometry(menu.locator('..')), 'Export menu before dismissal');
    if (method === 'Escape') await page.keyboard.press('Escape'); else await page.mouse.click(12, 2);
    await frames();
    assert.equal(await menu.isVisible(), false, `${method} dismisses the export submenu`);
    assert.equal(await more.isVisible(), false, `${method} dismisses the parent More menu`);
    assert.deepEqual(await currentEngineState(), initialState, `${method} does not interact with the document`);
  }
  report.exportDismissal = { escape: true, outsidePointer: true, noClickThrough: true };
  console.log('PASS export submenu Escape and outside-pointer dismissal');
}
async function openUtilities() {
  await openMore();
  const trigger = button('Page utilities', more);
  if (await trigger.count()) {
    await reachable(trigger, 'Page utilities'); await trigger.click(); await frames();
    const utilities = page.getByRole('menu', { name: 'Page utilities', exact: true });
    inside(await geometry(utilities), 'Page utilities');
    return utilities;
  }
  return more;
}
async function verifyMenu(kind, width, height, fullPage) {
  await resetTool(); await openMore();
  const initialState = await currentEngineState();
  const menu = await geometry(more);
  inside(menu, 'More Tools');
  assert.equal(await more.getByRole('button', { name: 'Hand (Space)', exact: true }).count(), 0, 'no duplicate Hand in More');
  assert.equal(await button('Hand (Space)').count(), 1, 'direct Hand remains available');
  assert.equal(menu.overflowY, 'auto');
  const buttons = more.locator('button');
  for (let i = 0; i < await buttons.count(); i++) await reachable(buttons.nth(i), `More item ${i}`);
  await reachable(button('Pencil (N)', more), 'Pencil');
  await reachable(button('Handwriting to Text', more), 'Handwriting to text');
  await reachable(button(fullPage ? 'Exit Full Page View' : 'Enter Full Page View', more), 'Full Page');
  assert.deepEqual(await currentEngineState(), initialState, 'scrolling the menu does not edit or change document ownership');
  if ([320, 390, 667, 812].includes(width)) await page.screenshot({ path: path.join(output, `${kind}-${width}-${height}-${fullPage ? 'full' : 'normal'}-more.png`) });
  const utilities = await openUtilities();
  const voice = button('Voice notes', utilities);
  await reachable(voice, 'Voice notes'); await voice.click(); await frames();
  const panel = page.getByRole('dialog', { name: 'Voice notes', exact: true });
  const bounds = await geometry(panel.locator('..'));
  inside(bounds, 'Voice notes panel');
  await reachable(button('Import', panel), 'Voice notes Import');
  await reachable(button('Record', panel), 'Voice notes Record');
  assert.deepEqual(await currentEngineState(), initialState, 'Voice notes controls do not click through into the document');
  if ([320, 390, 667, 812].includes(width)) await page.screenshot({ path: path.join(output, `${kind}-${width}-${height}-${fullPage ? 'full' : 'normal'}-voice.png`) });
  await closeOverlays();
  report.cases.push({ kind, width, height, fullPage, menu, voice: bounds, allActionsReachable: true, noClickThrough: true });
}
async function closeOverlays() {
  for (const label of ['Voice notes', 'Layers', 'Local Elements', 'Page utilities']) {
    const expanded = page.locator(`button[aria-label="${label}"][aria-expanded="true"]`);
    if (await expanded.count()) await expanded.click();
  }
  const trigger = button('More Tools');
  if (await trigger.count()) {
    if (!await more.isVisible() && await page.locator('.panvas-anchored-overlay').count()) await trigger.click();
    if (await more.isVisible()) await trigger.click();
  }
  await frames();
}
async function chooseDocument(kind) {
  await closeOverlays();
  await page.evaluate(async kind => {
    const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
    const { useLayoutStore } = await import('/src/stores/layoutStore.ts');
    const { useUIStore } = await import('/src/stores/uiStore.ts');
    useUIStore.setState({ isSidebarOpen: false, isPropertiesPanelOpen: false });
    useLayoutStore.getState().setNotebookModeLevel(0);
    useWorkspaceStore.getState().setActivePage(window.__overlayIds[kind === 'pdf' ? 'pdf' : 'note'], false);
  }, kind);
  await page.waitForFunction(kind => [...window.__overlayEngines].some(e => e.drawing.getCanvasElement()?.isConnected && (kind === 'pdf') === !!e.drawing.getCanvasElement()?.closest('[data-pdf-source-page]')), kind);
  await frames(5);
}

try {
  // Seed local data through the real repositories, then navigate to the actual
  // /app entry point. The assertions exercise App + WorkspaceContent, rather
  // than a replacement toolbar or isolated menu component.
  await page.goto(origin + 'tests/fixtures/document-input.html?performancePages=6&scrollRegression=1');
  await page.waitForFunction(() => window.documentFixture?.engine()?.drawing.getCanvasElement());
  const ids = await page.evaluate(() => window.documentFixture.ids);
  await page.goto(origin + 'app');
  await page.waitForFunction(() => [...(window.__overlayEngines ?? [])].some(e => e.drawing.getCanvasElement()?.isConnected));
  await button('Continue locally').waitFor({ state: 'visible' });
  await button('Continue locally').click();
  await page.evaluate(ids => { window.__overlayIds = ids; }, ids);
  await chooseDocument('pdf');
  await exportDismissal();

  if (!sweepOnly) for (const kind of ['notebook', 'pdf']) {
    await chooseDocument(kind);
    assert.equal(await page.evaluate(() => [...window.__overlayEngines].find(e => e.drawing.getCanvasElement()?.isConnected).tools.getState().mode), 'hand', 'fresh document tool stays Hand');
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height }); await frames(5); await page.waitForTimeout(230);
      await verifyMenu(kind, width, height, false);
      await openMore(); await reachable(button('Enter Full Page View', more), 'Enter Full Page');
      await button('Enter Full Page View', more).click(); await frames(4);
      assert.equal(await more.isVisible(), false, 'entering Full Page closes More safely');
      assert.equal(await page.locator('.panvas-topbar').isVisible(), false);
      await verifyMenu(kind, width, height, true);
      await openMore(); await reachable(button('Exit Full Page View', more), 'Exit Full Page');
      await button('Exit Full Page View', more).click(); await frames(4);
      assert.equal(await more.isVisible(), false, 'leaving Full Page closes More safely');
      assert.equal(await page.locator('.panvas-topbar').isVisible(), true);
      assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth), 'no horizontal UI overflow');
      console.log('PASS', kind, `${width}x${height}`, 'normal + Full Page + all More items + Voice notes');
    }
  }
  for (const kind of ['notebook', 'pdf']) {
    await chooseDocument(kind);
    for (const [width, height] of [[320, 568], [390, 844], [667, 375]]) for (const fullPage of [false, true]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async fullPage => {
        const { useLayoutStore } = await import('/src/stores/layoutStore.ts');
        useLayoutStore.getState().setNotebookModeLevel(fullPage ? 2 : 0);
      }, fullPage);
      await frames(5); await page.waitForTimeout(230); await resetTool();
      await sweep(kind, width, height, fullPage);
    }
  }
  { await viewportChanges(); await stickyControls(); }
  assert.deepEqual(errors, [], 'no runtime errors');
  console.log('PASS mobile overlay geometry:', report.cases.length, 'document/view/mode cases;', report.sweep.length, 'overlay checks');
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') });
  report.failure = String(error); throw error;
} finally {
  await writeFile(path.join(output, `result-geometry.json`), JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
