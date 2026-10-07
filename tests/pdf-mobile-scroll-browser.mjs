import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, _electron } from 'playwright';
import { createServer } from 'vite';
import { build } from 'esbuild';

// Instrument the isolated test server without changing product files.
const electronMode = process.argv.includes('--electron');
const uiOnly = process.argv.includes('--ui-only');
const output = path.resolve('artifacts/pdf-mobile');
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-pdf-continuity-'));
await mkdir(output, { recursive: true });
const bump = name => `window.__documentWork?.bump('${name}');`;
const server = await createServer({ mode: 'web', cacheDir: path.join(directory, 'vite'), server: { port: 0, open: false, hmr: false }, plugins: [{
  name: 'pdf-continuity-counters', enforce: 'pre',
  async transform(code, id) {
    id = id.replaceAll('\\', '/').split('?')[0];
    if (id.endsWith('/PdfPageRenderer.tsx')) {
      code = code.replace('const canvasRef = useRef', `useEffect(() => {${bump('rasterMounts')}return () => {${bump('rasterUnmounts') }};}, []);const canvasRef = useRef`);
      code = code.replace("canvas.getContext('2d')?.drawImage(nextCanvas, 0, 0);", "$&canvas.dataset.testPdfReady = 'true';" + bump('rasterCompletions'));
    }
    if (id.endsWith('/PdfStaticAnnotationLayer.tsx')) code = code.replace('const canvasRef = useRef', `React.useEffect(() => {${bump('previewMounts')}return () => {${bump('previewUnmounts')}};}, []);const canvasRef = useRef`);
    if (id.endsWith('/FloatingTextEditor.tsx')) code = code.replace('const editor = useEditor({', `useEffect(() => {${bump('editorMounts')}return () => {${bump('editorUnmounts')}};}, []);$&`);
    if (id.endsWith('/ImageManager.ts')) code = code.replace('setImages(images: ImageObject[]): void {', "$&window.__documentWork?.bump('imageMounts', images.filter(image => !this.images.some(old => old.id === image.id)).length);");
    return { code, map: null };
  },
}] });
await server.listen();
const url = server.resolvedUrls.local[0] + 'tests/fixtures/document-input.html?gate0Profile=1&performancePages=50&scrollRegression=1';
let browser, app;
const errors = [];
const report = { mode: electronMode ? 'electron' : 'browser', scrolling: [], mobile: [] };
const frames = (page, count = 3) => page.evaluate(async count => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame); }, count);
const settle = async page => { await frames(page); await page.waitForTimeout(260); await frames(page); };
const owner = page => page.evaluate(() => window.documentFixture.engine()?.getDrawingOwnership().pageId);
async function prepare(page) {
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const NativeObserver = window.IntersectionObserver;
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback, options) { super((entries, observer) => { window.__documentWork?.bump('intersectionCallbacks'); callback(entries, observer); }, options); }
    };
  });
  await page.goto(url);
  await page.waitForFunction(() => window.documentFixture?.engine()?.drawing.getCanvasElement());
  report.freshNotebookTool = await page.evaluate(() => window.documentFixture.engine().tools.getState().mode);
  await page.evaluate(() => { window.documentFixture.presentation(0); window.documentFixture.select('pdf'); });
  await page.waitForFunction(() => window.documentFixture.engine()?.drawing.getCanvasElement()?.closest('[data-pdf-source-page]'));
  await settle(page);
  report.freshPdfTool = await page.evaluate(() => window.documentFixture.engine().tools.getState().mode);
  { assert.equal(report.freshNotebookTool, 'hand'); assert.equal(report.freshPdfTool, 'hand'); }
}
async function go(page, source) {
  await page.evaluate(source => {
    const scroller = document.querySelector('[aria-label="PDF document pages"]');
    const element = document.querySelector(`[data-pdf-source-page="${source}"]`);
    scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 36;
  }, source);
  await settle(page);
}
async function continuity(page, label, duration = 36000) {
  await page.evaluate(() => {
    window.documentFixture.engine().tools.setMode('hand');
    window.__documentWork.reset();
    window.__pdfContinuity = { samples: 0, visibleMissingRaster: 0, visibleMissingAnnotations: 0, visibleUnreadyRaster: 0, reentries: 0, maxResident: 0, maxLive: 0, maxEditors: 0, rasterRemounts: 0, pageEvictions: 0, transitions: [], seen: new Set(), previousResident: new Set(), previousVisible: new Set(), canvases: new Map() };
  });
  const result = await page.evaluate(async duration => {
    const scroller = document.querySelector('[aria-label="PDF document pages"]');
    const pages = [...document.querySelectorAll('[data-pdf-source-page]')];
    const bounds = scroller.getBoundingClientRect();
    const positions = pages.map(p => { const b = p.getBoundingClientRect(); return { id: Number(p.dataset.pdfSourcePage), element: p, top: scroller.scrollTop + b.top - bounds.top, bottom: scroller.scrollTop + b.bottom - bounds.top }; });
    const state = window.__pdfContinuity;
    // Check at every animation frame, including frames between scrolling and
    // observer delivery. Rendered pixels must survive re-entry and boundaries.
    function sample() {
      const resident = new Set();
      const visible = new Set();
      let missing = false;
      for (const p of positions) {
        const raster = p.element.querySelector('[data-pdf-raster]');
        if (raster) {
          resident.add(p.id);
          if (state.canvases.has(p.id) && state.canvases.get(p.id) !== raster) state.rasterRemounts++;
          state.canvases.set(p.id, raster);
        }
        if (p.bottom > scroller.scrollTop + 4 && p.top < scroller.scrollTop + scroller.clientHeight - 4) {
          visible.add(p.id);
          if (!state.previousVisible.has(p.id) && state.seen.has(p.id)) state.reentries++;
          state.seen.add(p.id);
          if (!raster) { state.visibleMissingRaster++; missing = true; }
          else if (!raster.dataset.testPdfReady) state.visibleUnreadyRaster++;
          if (p.id % 2 === 0 && !p.element.querySelector('[data-pdf-static-annotations],canvas.panvas-layer-canvas-decoration')) { state.visibleMissingAnnotations++; missing = true; }
        }
      }
      for (const id of state.previousResident) if (!resident.has(id)) state.pageEvictions++;
      state.previousResident = resident; state.previousVisible = visible;
      state.maxResident = Math.max(state.maxResident, resident.size);
      state.maxLive = Math.max(state.maxLive, document.querySelectorAll('canvas.panvas-layer-canvas-decoration').length);
      state.maxEditors = Math.max(state.maxEditors, document.querySelectorAll('[data-pdf-source-page] [data-text-object-id] .ProseMirror').length);
      state.samples++;
      if (missing && state.transitions.length < 12) state.transitions.push({ at: performance.now(), scrollTop: scroller.scrollTop, visible: [...visible], resident: [...resident] });
    }
    const first = positions[0].top - 36;
    const last = positions.at(-1).top - 36;
    const started = performance.now();
    while (performance.now() - started < duration) {
      const progress = (performance.now() - started) / duration;
      // Slow read, fast downward flicks, fast upward reversal, then repeatedly
      // cross the same page boundary. No artificial pointer lock hides native scroll.
      if (progress < .2) scroller.scrollTop = first + (last - first) * progress;
      else if (progress < .45) scroller.scrollTop = first + (last - first) * (.2 + .8 * (progress - .2) / .25);
      else if (progress < .7) scroller.scrollTop = last - (last - first) * ((progress - .45) / .25);
      else if (progress < .8) scroller.scrollTop = first + (positions[23].top - scroller.clientHeight / 2 - first) * ((progress - .7) / .1);
      else scroller.scrollTop = positions[23].top + Math.sin((progress - .8) * duration / 140) * scroller.clientHeight * .9 - scroller.clientHeight / 2;
      await new Promise(requestAnimationFrame);
      sample();
    }
    return { ...state, seen: [...state.seen], previousResident: [...state.previousResident], previousVisible: undefined, canvases: undefined };
  }, duration);
  await settle(page);
  const counts = await page.evaluate(() => ({ ...window.__documentWork.report(), residentPages: document.querySelectorAll('[data-pdf-raster]').length, liveOwner: window.documentFixture.engine().getDrawingOwnership().pageId }));
  report.scrolling.push({ label, ...result, ...counts });
  console.log('SCROLL', label, JSON.stringify(report.scrolling.at(-1)));
  {
    assert.equal(result.visibleMissingRaster, 0, 'every visible page remains resident during scrolling/reversal');
    assert.equal(result.visibleMissingAnnotations, 0, 'rich page preview never disappears');
    assert.equal(result.visibleUnreadyRaster, 0, 'visible raster pixels are ready before the page enters view');
    assert.ok(result.maxResident <= 12, 'raster residency is bounded');
    assert.equal(result.maxLive, 1, 'one live annotation owner');
    assert.ok(result.maxEditors <= 3);
    assert.ok((counts.engineMounts ?? 0) <= 3, 'continuous scroll never thrashes engine ownership');
    assert.equal(counts.drawingSaves ?? 0, 0, 'scrolling never saves content');
    assert.equal(counts.repositoryReads ?? 0, 0, 'scrolling uses loaded descriptors');
  }
}
async function nearPageReversal(page) {
  await go(page, 1);
  await go(page, 24);
  const state = await page.evaluate(async () => {
    const scroller = document.querySelector('[aria-label="PDF document pages"]');
    const before = new Map([22, 23, 24, 25, 26].map(id => [id, document.querySelector(`[data-pdf-source-page="${id}"] [data-pdf-raster]`)]));
    const start = scroller.scrollTop;
    window.__documentWork.reset();
    for (let i = 0; i < 36; i++) { scroller.scrollTop = start + (i % 2 ? -1 : 1) * scroller.clientHeight * .7; await new Promise(requestAnimationFrame); }
    return { sameRasters: [...before].every(([id, canvas]) => canvas && canvas === document.querySelector(`[data-pdf-source-page="${id}"] [data-pdf-raster]`)), ...window.__documentWork.report() };
  });
  report.reversal = state;
  { assert.ok(state.sameRasters, 'nearby raster DOM identities survive repeated reversal'); assert.equal(state.rasterMounts ?? 0, 0); }
  await page.screenshot({ path: path.join(output, `result-reversal-${report.mode}.png`) });
}
async function reachable(page, locator) {
  await locator.waitFor({ state: 'visible' });
  await frames(page, 2);
  const b = await locator.boundingBox();
  assert.ok(b && b.x >= -1 && b.y >= -1 && b.x + b.width <= await page.evaluate(() => innerWidth) + 1 && b.y + b.height <= await page.evaluate(() => innerHeight) + 1, `control is inside viewport: ${JSON.stringify(b)}`);
}
async function mobileUi(page, width, height = 844) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => window.documentFixture.presentation(0));
  await settle(page);
  const normalHeight = await page.locator('[aria-label="PDF document pages"]').evaluate(element => element.clientHeight);
  const dock = page.locator('.panvas-mobile-tool-dock');
  const moreButton = dock.getByRole('button', { name: 'More Tools', exact: true });
  const more = page.getByRole('menu', { name: 'More Tools', exact: true });
  assert.equal(await page.locator('.panvas-pdf-fullpage-controls').count(), 0);
  await reachable(page, dock);
  await moreButton.click();
  await reachable(page, more);
  assert.equal(await more.getByRole('button', { name: 'Hand (Space)', exact: true }).count(), 0);
  await more.getByRole('button', { name: 'Enter Full Page View', exact: true }).click();
  await settle(page);
  assert.equal(await page.locator('.panvas-topbar').isVisible(), false);
  assert.equal(await page.locator('[data-pdf-mobile-header]').count(), 0);
  assert.equal(await page.locator('.panvas-pdf-fullpage-controls').count(), 0);
  await reachable(page, dock);
  const fullPageHeight = await page.locator('[aria-label="PDF document pages"]').evaluate(element => element.clientHeight);
  assert.ok(fullPageHeight > normalHeight, 'Full Page expands the document viewport');
  await page.screenshot({ path: path.join(output, `mobile-${width}-${height}-full-page.png`) });
  if (await more.isVisible()) await moreButton.click();
  await moreButton.click();
  await reachable(page, more.getByRole('button', { name: 'Exit Full Page View', exact: true }));
  await more.getByRole('button', { name: 'PDF pages', exact: true }).click();
  await page.getByLabel('PDF page thumbnails', { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
  if (await more.isVisible()) await moreButton.click();
  await moreButton.click();
  await more.getByRole('button', { name: 'Exit Full Page View', exact: true }).click();
  await settle(page);
  assert.equal(await page.locator('.panvas-topbar').isVisible(), true);
  assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  report.mobile.push({ width, height, normalHeight, fullPageHeight, moreFullPage: true, drawer: true, exit: true, overflow: false });
  console.log('MOBILE PASS', width, height);
}
async function verifyEditing(page) {
  await go(page, 24);
  await page.waitForFunction(() => window.documentFixture.engine()?.getDrawingOwnership().pageId.endsWith('_pdf_24'));
  const pixels = await page.evaluate(() => {
    const engine = window.documentFixture.engine(), canvas = engine.drawing.getCanvasElement();
    const image = engine.images.getImages()[0];
    const p = engine.viewport.pageToCanvas(image.x + image.width / 2, image.y + image.height / 2);
    const pixel = [...canvas.getContext('2d').getImageData(Math.floor(p.x * canvas.width / canvas.clientWidth), Math.floor(p.y * canvas.height / canvas.clientHeight), 1, 1).data];
    return { pixel, strokes: engine.drawing.getStrokes().length, texts: engine.texts.getTexts().length };
  });
  assert.equal(pixels.strokes, 120); assert.equal(pixels.texts, 3);
  assert.ok(pixels.pixel[1] > pixels.pixel[0] && pixels.pixel[3] > 0, 'image annotation pixels are painted');
  await page.evaluate(() => window.documentFixture.engine().tools.setMode('text'));
  await page.locator('[data-text-object-id="text-24-0"] .ProseMirror').click();
  await page.keyboard.press('Control+End'); await page.keyboard.insertText(' saved-to-24');
  await page.evaluate(() => {
    const e = window.documentFixture.engine();
    e.drawing.setStrokes([...e.drawing.getStrokes(), { ...structuredClone(e.drawing.getStrokes()[0]), id: 'new-24-ink' }]);
    e.images.setImages(e.images.getImages().map(image => ({ ...image, x: 431 })));
    e.input.notifyChange();
  });
  await go(page, 25);
  await page.waitForFunction(() => window.documentFixture.engine()?.getDrawingOwnership().pageId.endsWith('_pdf_25'));
  assert.equal(await page.evaluate(() => window.documentFixture.engine().tools.getState().mode), 'text', 'same-session page navigation preserves the selected tool');
  assert.equal(await page.evaluate(() => window.documentFixture.engine().getDrawingData().objects.length), 0, 'blank next page never receives the previous page annotations');
  await page.waitForFunction(async () => (await window.documentFixture.saved(`${window.documentFixture.ids.pdf}_pdf_24`))?.objects.some(o => o.id === 'new-24-ink'));
  await go(page, 24);
  const returned = await page.evaluate(() => window.documentFixture.engine().getDrawingData());
  assert.ok(returned.objects.some(o => o.id === 'new-24-ink'));
  assert.ok(JSON.stringify(returned.objects.find(o => o.id === 'text-24-0').content).includes('saved-to-24'));
  assert.equal(returned.objects.find(o => o.id === 'image-24').x, 431);
  assert.equal(returned.objects.find(o => o.id === 'text-24-2').metadata.isStickyNote, true);
  // Real native pointer input on an inactive page must not snap the scroller,
  // and the first pen stroke must be routed to that page's new live owner.
  await page.evaluate(() => window.documentFixture.engine().tools.setMode('hand'));
  const target = await page.evaluate(() => {
    const scroller = document.querySelector('[aria-label="PDF document pages"]'), box = scroller.getBoundingClientRect();
    const canvas = window.documentFixture.engine().drawing.getCanvasElement();
    const active = canvas.closest('[data-pdf-source-page]');
    scroller.scrollTop += active.getBoundingClientRect().bottom - box.top - box.height * .45;
    for (const element of document.querySelectorAll('[data-pdf-source-page]')) {
      const b = element.getBoundingClientRect();
      const top = Math.max(box.top + 16, b.top + 16), bottom = Math.min(box.bottom - 16, b.bottom - 16);
      if (element !== active && bottom > top) return { source: Number(element.dataset.pdfSourcePage), x: Math.max(box.left + 30, b.left + b.width / 2), y: (top + bottom) / 2, scrollTop: scroller.scrollTop };
    }
  });
  assert.ok(target, 'there is a visible inactive page for input handoff');
  const session = await page.context().newCDPSession(page);
  if (!electronMode) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 77, x: target.x, y: target.y }] });
    await frames(page, 2);
    assert.equal(await page.locator('[aria-label="PDF document pages"]').evaluate(element => element.scrollTop), target.scrollTop, 'touching a nearby page with Hand does not snap it');
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await page.evaluate(() => window.documentFixture.engine().tools.setDrawingTool('pen'));
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: .6 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x + 14, y: target.y + 5, button: 'left', buttons: 1, pointerType: 'pen', force: .6 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x + 14, y: target.y + 5, button: 'left', buttons: 0, pointerType: 'pen' });
  await session.detach();
  assert.ok((await owner(page)).endsWith(`_pdf_${target.source}`));
  assert.ok(await page.evaluate(() => window.documentFixture.engine().drawing.getStrokes().length > 0), 'first stroke on an inactive page is kept');
  assert.equal(await page.locator('[aria-label="PDF document pages"]').evaluate(element => element.scrollTop), target.scrollTop, 'edit activation does not snap the document');
  const strokeId = await page.evaluate(() => window.documentFixture.engine().drawing.getStrokes().at(-1).id);
  await go(page, 24);
  await page.waitForFunction(async ({ source, strokeId }) => (await window.documentFixture.saved(`${window.documentFixture.ids.pdf}_pdf_${source}`))?.objects.some(object => object.id === strokeId), { source: target.source, strokeId });
  await page.evaluate(() => window.documentFixture.engine().tools.setMode('hand'));
  report.correctness = { ink: true, actualTextEdit: true, imagePixels: pixels.pixel, imageEdit: true, sticky: true, correctSaveDestination: true, sameSessionTool: true, firstPenStroke: true };
  console.log('PASS: annotation pixels, real text edit, save ownership, tool persistence, first pen stroke');
}
try {
  let page;
  if (electronMode) {
    for (const [entry, file] of [['electron/ipc/domain-handlers.ts', 'domain.cjs'], ['electron/preload.ts', 'preload.cjs']]) await build({ entryPoints: [entry], outfile: path.join(directory, file), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    await writeFile(path.join(directory, 'bootstrap.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=require('node:path').join(__dirname,'workspaces');process.env.VITE_DEV_SERVER_URL=${JSON.stringify(server.resolvedUrls.local[0])};app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();new BrowserWindow({show:false,width:1440,height:900,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}}).loadURL(${JSON.stringify(url)});});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ args: [path.join(directory, 'bootstrap.cjs')], env }); page = await app.firstWindow();
  } else {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  }
  await prepare(page);
  if (!uiOnly) { await continuity(page, electronMode ? 'desktop-electron' : 'mobile'); await nearPageReversal(page); }
  if (!uiOnly) await verifyEditing(page);
  if (!electronMode) {
    for (const width of [320, 360, 375, 390, 412, 430]) await mobileUi(page, width);
    await mobileUi(page, 844, 390);
  }
  {
    await page.evaluate(() => window.documentFixture.select('notebook'));
    await page.waitForFunction(() => window.documentFixture.engine()?.drawing.getCanvasElement()?.closest('.notebook-viewport'));
    await settle(page);
    report.resourcesAfterPdfClose = await page.evaluate(() => window.__documentWork.resources());
    assert.equal(report.resourcesAfterPdfClose.objectUrls ?? 0, 0, 'closing the PDF releases all image object URLs');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: PDF visual continuity and mobile controls');
} finally {
  await writeFile(path.join(output, `result-${report.mode}${uiOnly ? '-ui' : ''}.json`), JSON.stringify(report, null, 2));
  await app?.close(); await browser?.close(); await server.close();
}
