import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, _electron } from 'playwright';
import { createServer } from 'vite';
import { build } from 'esbuild';

const electronMode = process.argv.includes('--electron');
const mobileOnly = process.argv.includes('--mobile-only');
const staticOnly = process.argv.includes('--static-only');
const nativeScrollOnly = process.argv.includes('--native-scroll-only');
const output = path.resolve('artifacts/performance');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-performance-'));
const bump = name => `window.__documentWork?.bump('${name}');`;
const server = await createServer({ mode: 'web', cacheDir: path.join(directory, 'vite'), server: { port: 0, open: false, hmr: false }, plugins: [{
  name: 'performance-work-counts', enforce: 'pre',
  resolveId(id) { if (id === 'virtual:static-preview-probe') return '\0virtual:static-preview-probe'; },
  load(id) { if (id === '\0virtual:static-preview-probe') return "export {createRoot} from 'react-dom/client'; export {default as React} from 'react';"; },
  async transform(code, id) {
    id = id.replaceAll('\\', '/').split('?')[0];
    if (id.endsWith('/PdfWorkspace.tsx')) {
      code = code.replace('const isPhone = useIsMobileViewport();', bump('pdfWorkspaceRenders') + '$&');
      code = code.replace('const resolveVisiblePage = () => {', '$&' + bump('activePageCalculations'));
      code = code.replace('notebookEngine.viewport.subscribe(setViewport)', `notebookEngine.viewport.subscribe(state => {${bump('viewportUpdates')}setViewport(state);})`);
    }
    if (id.endsWith('/FloatingTextEditor.tsx')) code = code.replace('const editor = useEditor({', `React.useEffect(() => {${bump('editorMounts')}window.__documentWork?.live('editors', 1);return () => {${bump('editorUnmounts')}window.__documentWork?.live('editors', -1);};}, []);$&`);
    if (id.endsWith('/PdfPageRenderer.tsx')) code = code.replace('const canvasRef = useRef', bump('pdfRendererRenders') + '$&');
    return { code, map: null };
  },
}] });
await server.listen();
let browser, app;
const errors = [];
const report = { mode: electronMode ? 'electron' : 'browser', pdf: {}, pinch: {}, mobile: [] };
const url = server.resolvedUrls.local[0] + 'tests/fixtures/document-input.html?gate0Profile=1&performancePages=50';
const frames = (page, n = 3) => page.evaluate(async n => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); }, n);
const settle = async page => { await frames(page, 3); await page.waitForTimeout(240); await frames(page, 3); };
const snapshot = page => page.evaluate(() => ({ ...window.__documentWork.report(), resources: window.__documentWork.resources(), pdfRenderers: document.querySelectorAll('[data-pdf-source-page] canvas').length, residentPages: [...document.querySelectorAll('[data-pdf-source-page]')].filter(p => p.querySelector('canvas')).length, livePage: document.querySelector('canvas.panvas-layer-canvas-decoration')?.closest('[data-pdf-source-page]')?.getAttribute('data-pdf-source-page') }));
async function prepare(page, annotations = 'rich') {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url + `&annotations=${annotations}`);
  await page.waitForFunction(() => window.documentFixture?.engine()?.drawing.getCanvasElement());
  await settle(page);
}
async function scrollTo(page, source) {
  await page.evaluate(source => {
    const scroller = document.querySelector('[aria-label="PDF document pages"]');
    const element = document.querySelector(`[data-pdf-source-page="${source}"]`);
    scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 120;
  }, source);
  await frames(page, 2);
}
async function measurePdf(page, label) {
  await page.evaluate(() => window.documentFixture.select('pdf'));
  await page.waitForSelector('[data-pdf-source-page="50"] canvas', { state: 'attached', timeout: 1 }).catch(() => {});
  await page.waitForFunction(() => window.documentFixture.engine()?.drawing.getCanvasElement()?.closest('[data-pdf-source-page]'));
  await settle(page);
  await page.evaluate(() => window.__documentWork.reset());
  const residency = [];
  const held = [];
  const hold = () => page.evaluate(() => {
    const engine = window.documentFixture.engine(); engine.tools.setMode('hand');
    const canvas = engine.drawing.getCanvasElement(), b = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', pointerId: 701, button: 0, buttons: 1, clientX: b.left + 50, clientY: b.top + 50 }));
    if (!engine.input.navigationGestures.active) throw new Error('Hand must own the scrolling gesture');
  });
  const release = () => page.evaluate(() => window.documentFixture.engine().drawing.getCanvasElement().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', pointerId: 701, button: 0, buttons: 0 })));
  if (!nativeScrollOnly) await hold();
  const scrollIntervals = [];
  for (let source = 2; source <= 50; source++) {
    if (nativeScrollOnly) {
      const stop = [5, 10, 20, 50].find(stop => stop >= source);
      const intervals = await page.evaluate(async ({ source, stop }) => {
        const scroller = document.querySelector('[aria-label="PDF document pages"]');
        const intervals = [];
        let previous = performance.now();
        for (let next = source; next <= stop; next++) {
          const element = document.querySelector(`[data-pdf-source-page="${next}"]`);
          scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 120;
          intervals.push(performance.now() - previous); previous = performance.now();
          await new Promise(requestAnimationFrame);
        }
        await new Promise(requestAnimationFrame);
        return intervals;
      }, { source, stop });
      scrollIntervals.push(...intervals); source = stop;
    } else await scrollTo(page, source);
    if ([5, 10, 20, 50].includes(source)) {
      held.push({ visited: source, ...await snapshot(page) });
      if (!nativeScrollOnly) await release();
      await settle(page);
      residency.push({ visited: source, ...await snapshot(page) });
      if (source !== 50 && !nativeScrollOnly) await hold();
    }
  }
  await settle(page);
  report.pdf[label] = { ...await snapshot(page), residency, held, ...(nativeScrollOnly ? { scrollIntervals } : {}) };
  console.log('PDF', label, JSON.stringify(report.pdf[label]));
  {
    assert.equal(report.pdf[label].livePage, '50');
    // The continuity window retains five pages on each side and can keep one
    // editing owner outside it until release. Check every checkpoint so a
    // later eviction cannot hide growth during a held navigation gesture.
    for (const checkpoint of [...held, ...residency, report.pdf[label]]) {
      assert.ok(checkpoint.residentPages <= 12, `PDF residency stays bounded at page ${checkpoint.visited ?? 50}`);
    }
    assert.ok((report.pdf[label].resources.editors ?? 0) <= 3, 'only one page owns live editors');
    if (nativeScrollOnly) {
      assert.ok(report.pdf[label].engineMounts <= 6, 'continuous scrolling promotes only at its stops');
      assert.ok(report.pdf[label].sceneLoads <= 6);
    } else {
      assert.equal(report.pdf[label].engineMounts, 4, 'only the four settled checkpoints promote editable ownership');
      assert.equal(report.pdf[label].sceneLoads, 4);
    }
    assert.equal(report.pdf[label].drawingSaves ?? 0, 0, 'scrolling never saves annotations');
    if (label === 'annotated') {
      const ids = await page.evaluate(() => window.documentFixture.engine().getDrawingData().objects.map(object => object.id));
      assert.ok(ids.includes('text-50-0') && ids.includes('text-50-2') && ids.includes('image-50'));
      await page.evaluate(() => window.documentFixture.engine().tools.setMode('text'));
      await page.locator('[data-text-object-id="text-50-0"] .ProseMirror').click();
      await page.keyboard.press('Control+End'); await page.keyboard.insertText(' page-50-edit');
      await page.evaluate(() => {
        const engine = window.documentFixture.engine(), strokes = engine.drawing.getStrokes();
        engine.drawing.setStrokes([...strokes, { ...structuredClone(strokes[0]), id: 'page-50-new-ink' }]);
        engine.images.setImages(engine.images.getImages().map(image => ({ ...image, x: 431 })));
        engine.input.notifyChange();
      });
      await page.evaluate(() => window.documentFixture.engine().tools.setMode('hand'));
      await frames(page, 3);
      await page.getByRole('button', { name: 'Previous page', exact: true }).click();
      await page.waitForFunction(() => window.documentFixture.engine().getDrawingOwnership().pageId.endsWith('_pdf_49'));
      await page.waitForFunction(async () => (await window.documentFixture.saved(`${window.documentFixture.ids.pdf}_pdf_50`))?.objects.some(object => object.id === 'page-50-new-ink'));
      const previous = await page.evaluate(() => window.documentFixture.engine().getDrawingData());
      assert.ok(previous.objects.some(object => object.id === 'image-49'));
      assert.ok(!previous.objects.some(object => object.id === 'page-50-new-ink'));
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await page.waitForFunction(() => window.documentFixture.engine().getDrawingOwnership().pageId.endsWith('_pdf_50'));
      const returned = await page.evaluate(() => window.documentFixture.engine().getDrawingData());
      assert.ok(returned.objects.some(object => object.id === 'page-50-new-ink'));
      assert.ok(JSON.stringify(returned.objects.find(object => object.id === 'text-50-0').content).includes('page-50-edit'));
      assert.equal(returned.objects.find(object => object.id === 'image-50').x, 431);
      assert.equal(returned.objects.find(object => object.id === 'text-50-2').metadata.isStickyNote, true);
      report.pdf[label].ownershipAndRealTextEdit = true;
    }
  }
}
async function measurePinch(page, label) {
  await page.evaluate(() => window.documentFixture.select('notebook'));
  await page.waitForFunction(() => window.documentFixture.engine()?.drawing.getCanvasElement()?.closest('.notebook-viewport'));
  await settle(page);
  const result = await page.evaluate(async () => {
    const engine = window.documentFixture.engine();
    const canvas = engine.drawing.getCanvasElement();
    const scroller = canvas.closest('.notebook-viewport');
    const b = canvas.getBoundingClientRect(), s = scroller.getBoundingClientRect();
    const cx = s.left + s.width / 2, cy = Math.max(s.top + 90, b.top + 100);
    const point = { x: (cx - b.left) / b.width, y: (cy - b.top) / b.height };
    const initialOwner = engine.getDrawingOwnership().pageId;
    let updates = 0;
    const unsubscribe = engine.viewport.subscribe(() => updates++);
    window.__documentWork.reset();
    const send = (type, id, x, y) => scroller.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: id, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
    send('pointerdown', 901, cx - 45, cy); send('pointerdown', 902, cx + 45, cy);
    const drift = [];
    for (let step = 1; step <= 24; step++) {
      const distance = 90 + step * 6;
      send('pointermove', 901, cx - distance / 2, cy); send('pointermove', 902, cx + distance / 2, cy);
      await new Promise(requestAnimationFrame);
      const after = canvas.getBoundingClientRect();
      drift.push(Math.hypot(after.left + point.x * after.width - cx, after.top + point.y * after.height - cy));
    }
    send('pointerup', 901, cx - 117, cy); send('pointerup', 902, cx + 117, cy);
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    unsubscribe();
    return { maxAnchorDrift: Math.max(...drift), meanAnchorDrift: drift.reduce((a,b) => a+b,0) / drift.length, updates, sameOwner: engine.getDrawingOwnership().pageId === initialOwner, ...window.__documentWork.report() };
  });
  report.pinch[label] = result;
  console.log('PINCH', label, JSON.stringify(result));
  { assert.ok(result.maxAnchorDrift <= 2, 'pinch anchor stays within 2 CSS pixels'); assert.ok(result.sameOwner); assert.ok(result.updates <= 24); }
}

async function reachable(page, locator) {
  await locator.waitFor({ state: 'visible' });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= await page.evaluate(() => innerWidth) + 1
    && box.y + box.height <= await page.evaluate(() => innerHeight) + 1, 'control fits the viewport');
}

async function measureMobilePdf(page, width) {
  await page.evaluate(() => { window.documentFixture.presentation(0); window.documentFixture.select('pdf'); });
  await page.waitForSelector('[aria-label="PDF document pages"] canvas'); await settle(page);
  const dock = page.locator('.panvas-mobile-tool-dock');
  const moreButton = dock.getByRole('button', { name: 'More Tools', exact: true });
  const more = page.getByRole('menu', { name: 'More Tools', exact: true });
  const openMore = async () => { if (!await more.isVisible()) await moreButton.click(); await more.waitFor(); };
  const menuAction = async name => { await openMore(); const action = more.getByRole('button', { name, exact: true }); await reachable(page, action); await action.click(); };
  const hand = dock.getByRole('button', { name: 'Hand (Space)', exact: true });
  await reachable(page, hand);
  await openMore();
  for (const name of ['PDF pages', 'PDF page controls', 'Fit PDF width', 'Open page and view inspector', 'Enter Full Page View']) {
    await reachable(page, more.getByRole('button', { name, exact: true }));
  }
  await moreButton.click();
  assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth), 'page chrome has no horizontal overflow');
  await page.screenshot({ path: path.join(output, `mobile-${width}-normal.png`) });
  await menuAction('Enter Full Page View'); await settle(page);
  assert.equal(await page.locator('[data-pdf-mobile-header]').count(), 0);
  assert.equal(await page.locator('.panvas-topbar').isVisible(), false);
  await openMore();
  await reachable(page, more.getByRole('button', { name: 'Exit Full Page View', exact: true }));
  await moreButton.click();
  await reachable(page, hand); await hand.click();
  assert.equal(await page.evaluate(() => window.documentFixture.engine().tools.getState().mode), 'hand');
  await openMore();
  await more.waitFor(); assert.equal(await more.getByRole('button', { name: 'Hand (Space)', exact: true }).count(), 0);
  await reachable(page, more);
  const directText = dock.getByRole('button', { name: 'Text (T)', exact: true });
  if (await directText.count()) { await moreButton.click(); await directText.click(); }
  else await more.getByRole('button', { name: 'Text (T)', exact: true }).click();
  await menuAction('PDF page controls');
  await reachable(page, page.getByRole('button', { name: 'Next page', exact: true }));
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.waitForFunction(() => window.documentFixture.engine()?.getDrawingOwnership().pageId.endsWith('_pdf_2'));
  const scale = await page.evaluate(() => window.documentFixture.engine().viewport.getState().scale);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await frames(page, 2);
  assert.ok(await page.evaluate(() => window.documentFixture.engine().viewport.getState().scale) > scale);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await menuAction('Open page and view inspector');
  await reachable(page, page.getByRole('button', { name: 'Close page and view inspector', exact: true }));
  await page.getByRole('button', { name: 'Close page and view inspector', exact: true }).click();
  await menuAction('PDF pages');
  await page.getByLabel('PDF page thumbnails', { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
  await page.screenshot({ path: path.join(output, `mobile-${width}-full-page.png`) });
  const controls = await dock.locator('.panvas-toolbar-surface > button').evaluateAll(buttons => buttons.map(button => ({ label: button.getAttribute('aria-label'), width: button.getBoundingClientRect().width })));
  if (width === 390) {
    await page.setViewportSize({ width: 844, height: 390 }); await settle(page);
    await openMore();
    await page.waitForFunction(async () => {
      const { resolveActivePdfPage } = await import('/src/components/pdf/pdfNavigation.ts');
      const scroller = document.querySelector('[aria-label="PDF document pages"]');
      const bounds = scroller.getBoundingClientRect();
      const frames = [...document.querySelectorAll('[data-pdf-source-page]')].map(element => {
        const rect = element.getBoundingClientRect();
        const top = scroller.scrollTop + rect.top - bounds.top;
        return { page: Number(element.getAttribute('data-pdf-source-page')), top, bottom: top + rect.height };
      });
      const indicated = Number(document.querySelector('[aria-label="PDF page controls"]').textContent.match(/^Page (\d+) of/)[1]);
      const expected = resolveActivePdfPage(frames, scroller.scrollTop, scroller.scrollTop + scroller.clientHeight, indicated);
      return indicated === expected && window.documentFixture.engine().getDrawingOwnership().pageId.endsWith(`_pdf_${expected}`);
    });
    await reachable(page, page.getByRole('button', { name: 'Exit Full Page View', exact: true }));
    await reachable(page, dock.getByRole('button', { name: 'Hand (Space)', exact: true }));
    await menuAction('PDF page controls');
    await reachable(page, page.getByRole('button', { name: 'Zoom out', exact: true }));
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'mobile-landscape-full-page.png') });
    await page.setViewportSize({ width, height: 844 }); await settle(page);
  }
  await menuAction('Exit Full Page View'); await settle(page);
  assert.equal(await page.locator('[data-pdf-mobile-header]').count(), 0);
  assert.equal(await page.locator('.panvas-pdf-fullpage-controls').count(), 0);
  assert.ok(await page.locator('.panvas-topbar').isVisible());
  report.mobile.push({ width, controls, fullPage: true, exit: true, navigation: true, zoom: true, drawers: true, noDuplicateHand: true });
  console.log('MOBILE PDF', width, 'PASS');
}

async function measureNativePinch(page, label) {
  await page.evaluate(() => window.documentFixture.select('notebook'));
  await page.waitForFunction(() => window.documentFixture.engine()?.drawing.getCanvasElement()?.closest('.notebook-viewport')); await settle(page);
  const initial = await page.evaluate(() => {
    const engine = window.documentFixture.engine(), canvas = engine.drawing.getCanvasElement(), viewport = canvas.closest('.notebook-viewport');
    engine.tools.setDrawingTool('pen');
    const b = canvas.getBoundingClientRect(), v = viewport.getBoundingClientRect();
    const cx = v.left + v.width / 2, cy = Math.max(v.top + 100, b.top + 110);
    window.__nativeUpdates = 0;
    window.__nativeUpdateFrames = new Map();
    window.__nativeUnsubscribe = engine.viewport.subscribe(() => {
      window.__nativeUpdates++;
      const frame = document.timeline.currentTime;
      window.__nativeUpdateFrames.set(frame, (window.__nativeUpdateFrames.get(frame) ?? 0) + 1);
    });
    window.__documentWork.reset();
    return { cx, cy, point: { x: (cx - b.left) / b.width, y: (cy - b.top) / b.height }, owner: engine.getDrawingOwnership().pageId, browserScale: visualViewport.scale };
  });
  const session = await page.context().newCDPSession(page);
  const points = [{ id: 91, x: initial.cx - 45, y: initial.cy }, { id: 92, x: initial.cx + 45, y: initial.cy }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
  const drift = [];
  for (let step = 1; step <= 24; step++) {
    const distance = 90 + step * 5;
    points[0].x = initial.cx - distance / 2; points[1].x = initial.cx + distance / 2;
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });
    await frames(page, 1);
    drift.push(await page.evaluate(({ point, cx, cy }) => {
      const b = window.documentFixture.engine().drawing.getCanvasElement().getBoundingClientRect();
      return Math.hypot(b.left + b.width * point.x - cx, b.top + b.height * point.y - cy);
    }, initial));
  }
  // A pause with fingers still down must not resize the backing canvas.
  await page.waitForTimeout(200); await frames(page, 2);
  const held = await page.evaluate(() => ({ ...window.__documentWork.report(), updates: window.__nativeUpdates,
    maxUpdatesPerFrame: Math.max(0, ...window.__nativeUpdateFrames.values()),
    owner: window.documentFixture.engine().getDrawingOwnership().pageId, browserScale: visualViewport.scale }));
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const beforeInk = await page.evaluate(() => { window.documentFixture.engine().tools.setDrawingTool('pen'); return window.documentFixture.engine().drawing.getStrokes().length; });
  const ink = [{ id: 93, x: initial.cx, y: initial.cy + 30, force: .5 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: ink });
  ink[0].x += 24; ink[0].y += 10;
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: ink });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const afterInk = await page.evaluate(() => { window.__nativeUnsubscribe(); return window.documentFixture.engine().drawing.getStrokes().length; });
  const result = { ...held, maxAnchorDrift: Math.max(...drift), sameOwner: held.owner === initial.owner, writingAfterPinch: afterInk === beforeInk + 1 };
  report.pinch[`native-${label}`] = result;
  {
    assert.ok(result.maxAnchorDrift <= 2); assert.ok(result.sameOwner); assert.ok(result.writingAfterPinch);
    // Native Chromium can deliver the two fingers on adjacent frames. The
    // contract is one update per actual frame, not one per CDP command.
    assert.equal(result.maxUpdatesPerFrame, 1); assert.ok(result.updates <= 48);
    assert.equal(result.activeCanvasResizes ?? 0, 0, 'no active backing resize while pinch ownership is held');
    assert.equal(result.browserScale, initial.browserScale);
  }
  console.log('NATIVE PINCH', label, JSON.stringify(result)); await session.detach();
}

async function verifyStaticLayers(page) {
  const result = await page.evaluate(async () => {
    const [{ createRoot, React }, { PdfStaticAnnotationLayer }, { pdfSurroundingGeometry }, { createEmptyDrawingData, DEFAULT_PAGE_LAYER_ID }] = await Promise.all([
      import('/@id/__x00__virtual:static-preview-probe'),
      import('/src/components/pdf/PdfStaticAnnotationLayer.tsx'),
      import('/src/components/notebook/engine/pdfCoordinates.ts'),
      import('/src/components/notebook/engine/drawingTypes.ts'),
    ]);
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-10000px;width:200px;height:200px'; document.body.append(host);
    const root = createRoot(host), data = createEmptyDrawingData();
    const text = { id: 'legacy-text', type: 'text', x: 10, y: 10, width: 100, height: 50, createdAt: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Legacy layer' }] }] } };
    data.objects = [text, { ...text, id: 'orphan-text', layerId: 'orphan' }];
    data.layers = [{ id: 'hidden-first', name: 'Hidden', order: 0, visible: false, locked: false }];
    const props = { drawing: data, geometry: pdfSurroundingGeometry({ width: 200, height: 200 }, 0), rotation: 0, scale: 1, rasterScale: 1,
      sourcePage: 0, decodedSource: window.documentFixture.engine().images, onImagesReady() {} };
    const render = async drawing => { root.render(React.createElement(PdfStaticAnnotationLayer, { ...props, drawing })); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return host.querySelectorAll('.panvas-document-text').length; };
    try {
      const hidden = await render(data);
      const defaultVisible = await render({ ...data, layers: [...data.layers, { id: DEFAULT_PAGE_LAYER_ID, name: 'Default', order: 1, visible: true, locked: false }] });
      const legacyV1 = await render({ ...data, version: 1 });
      return { hidden, defaultVisible, legacyV1 };
    } finally { root.unmount(); host.remove(); }
  });
  assert.deepEqual(result, { hidden: 0, defaultVisible: 2, legacyV1: 0 });
  report.staticLayerVisibility = result; console.log('STATIC LAYER VISIBILITY PASS');
}
try {
  let page;
  if (electronMode) {
    for (const [entry, file] of [['electron/ipc/domain-handlers.ts', 'domain.cjs'], ['electron/preload.ts', 'preload.cjs']]) await build({ entryPoints: [entry], outfile: path.join(directory, file), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    await writeFile(path.join(directory, 'bootstrap.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=require('node:path').join(__dirname,'workspaces');process.env.VITE_DEV_SERVER_URL=${JSON.stringify(server.resolvedUrls.local[0])};app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();new BrowserWindow({show:false,width:1918,height:1198,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}}).loadURL(${JSON.stringify(url)});});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ args: [path.join(directory, 'bootstrap.cjs')], env });
    page = await app.firstWindow();
  } else { browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1918, height: 1198 } }); }
  await prepare(page);
  if (!mobileOnly && !staticOnly) await measurePdf(page, 'annotated');
  await verifyStaticLayers(page);
  if (!electronMode && !staticOnly && !nativeScrollOnly) {
    if (!mobileOnly) { await prepare(page, 'blank'); await measurePdf(page, 'blank'); }
    for (const width of [360, 375, 390, 412, 430, 980]) {
      const mobile = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
      await prepare(mobile);
      await measurePinch(mobile, String(width));
      if (width < 600) await measureMobilePdf(mobile, width);
      if (width === 390) await measureNativePinch(mobile, 'phone');
      await mobile.close();
    }
    const desktopSite = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
    await desktopSite.route('**/document-input.html?*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('width=device-width, initial-scale=1', 'width=980') });
    });
    await prepare(desktopSite); await measureNativePinch(desktopSite, 'desktop-site'); await desktopSite.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: deterministic Panvas performance flows');
} finally {
  await writeFile(path.join(output, `result-${report.mode}${mobileOnly ? '-mobile' : staticOnly ? '-static' : nativeScrollOnly ? '-scroll' : ''}.json`), JSON.stringify(report, null, 2));
  await app?.close(); await browser?.close(); await server.close();
}
