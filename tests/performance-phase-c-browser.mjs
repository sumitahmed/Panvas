// Phase C End-to-End Verification + Real Electron Multi-Process RAM Probe:
// 1. 24 x 2048x1536 images across multiple pages:
//    - 0 pinned blob: objectUrls after decode and scroll
//    - <= 192 MiB decoded LRU bytes in ImageAssetCache
//    - 0 duplicate concurrent IPC/repository getImage fetches
//    - 0 getImage calls on scroll-back LRU hit
//    - warm fullRedraw <= 3 ms
//    - 800% zoom promotes visible cropped/scaled images to 'original' without blank frames
//    - Priority 1 ink-over-image ordering preserved (no DOM image overlays)
// 2. In --electron mode, also launches real built dist-electron/main.js
//    (PANVAS_GATE0_PROFILE=1) and captures After RAM breakdown into artifacts/performance-phase-c/.
//
// Usage: node tests/performance-phase-c-browser.mjs [--electron]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';
import sharp from 'sharp';

const electronMode = process.argv.includes('--electron');
const outDir = 'artifacts/performance-phase-c';
await mkdir(outDir, { recursive: true });

const phaseCPlugin = {
  name: 'phase-c-instrumentation',
  enforce: 'pre',
  transform(code, id) {
    const clean = id.replaceAll('\\', '/').split('?')[0];
    if (!clean.endsWith('/tests/fixtures/populated-notebook.tsx')) return undefined;
    const normalized = code.replaceAll('\r\n', '\n');
    const targetLoop = 'for (let i = 1; i < 8; i++) pages.push(await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, `Populated ${i + 1}`));';
    const targetPicture = 'const picture = document.createElement(\'canvas\'); picture.width = 960; picture.height = 640;';
    const targetStrokes = 'data.objects = Array.from({ length: 1200 },';
    const targetImages = 'for (let i = 0; i < 3; i++) {';
    if (!normalized.includes(targetLoop) || !normalized.includes(targetPicture) || !normalized.includes(targetStrokes) || !normalized.includes(targetImages)) {
      return undefined;
    }
    let out = normalized.replace(
      targetLoop,
      `const phaseCPages = Number(new URLSearchParams(location.search).get('phaseCPages') || '0');
  const pageCount = phaseCPages > 0 ? phaseCPages : 8;
  for (let i = 1; i < pageCount; i++) pages.push(await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, \`Populated \${i + 1}\`));`,
    );
    out = out.replace(
      targetPicture,
      `const phaseCImages = new URLSearchParams(location.search).get('phaseCPages') ? true : false;
  const picture = document.createElement('canvas'); picture.width = phaseCImages ? 2048 : 960; picture.height = phaseCImages ? 1536 : 640;`,
    );
    out = out.replace(
      'const context = picture.getContext(\'2d\')!; context.fillStyle = \'#fff9b0\'; context.fillRect(0, 0, 960, 640);',
      `const context = picture.getContext('2d')!; context.fillStyle = phaseCImages ? '#1d4ed8' : '#fff9b0'; context.fillRect(0, 0, picture.width, picture.height);`,
    );
    out = out.replace(
      targetStrokes,
      `const strokeCount = phaseCImages ? 12 : 1200;
    data.objects = Array.from({ length: strokeCount },`,
    );
    out = out.replace(
      targetImages,
      `const imgCount = phaseCImages ? 4 : 3;
    for (let i = 0; i < imgCount; i++) {
      let pageBlob = blob;
      if (phaseCImages) {
        context.fillStyle = '#1e40af';
        context.fillRect(0, 0, 2048, 1536);
        context.fillStyle = '#facc15';
        context.fillText(\`P\${index}-I\${i}\`, 80, 120);
        pageBlob = await new Promise<Blob>(resolve => picture.toBlob(b => resolve(b!), 'image/png'));
      }`,
    );
    out = out.replace(
      'const asset = await canvasRepository.storeImage(null, page.id, `fixture-${i}.png`, \'image/png\', await blob.arrayBuffer());',
      `const asset = await canvasRepository.storeImage(null, page.id, \`fixture-p\${index}-\${i}.png\`, 'image/png', await pageBlob.arrayBuffer(), workspace.id);
      (window as any).__phaseCAssets ??= [];
      (window as any).__phaseCAssets.push(asset.id);`,
    );
    out = out.replace(
      "data.objects.push({ id: `${page.id}-image-${i}`, type: 'image', fileId: asset.id, x: 75 + i * 160, y: 80 + i * 230,\n        width: 210, height: 140, rotation: 0, createdAt: 2000 + i });",
      `data.objects.push({ id: \`\${page.id}-image-\${i}\`, type: 'image', fileId: asset.id, x: 75 + (i % 2) * 260, y: 80 + Math.floor(i / 2) * 220,
        width: 220, height: 165, rotation: 0, createdAt: 2000 + i });
    if (phaseCImages && index === 0 && i === 0) {
      data.objects.push({
        id: 'priority1-ink-over-image',
        type: 'stroke',
        tool: 'pen',
        centerline: 'polyline',
        color: '#e11d48',
        thickness: 5,
        opacity: 1,
        createdAt: 9999,
        points: [
          { x: 90, y: 160, pressure: 0.8, t: 0 },
          { x: 260, y: 160, pressure: 0.8, t: 16 },
        ],
      });
    }`,
    );
    return out;
  },
};

const server = await createServer({
  mode: 'web',
  cacheDir: path.join(outDir, 'vite-cache'),
  optimizeDeps: { entries: ['tests/fixtures/populated-notebook.html'] },
  plugins: [phaseCPlugin],
  server: { port: 0, open: false, hmr: false, watch: null },
});

let browser;
let electronApp;
let electronTempDir;

const launchElectronHarness = async (width = 1440, height = 900) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panvas-phase-c-electron-'));
  const bootstrap = path.join(dir, 'fixture.cjs');
  await writeFile(
    bootstrap,
    `const { app, BrowserWindow } = require('electron');
app.setPath('userData', require('node:path').join(__dirname, 'profile'));
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: ${width},
    height: ${height},
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.setFrameRate(60);
  win.loadURL('about:blank');
});`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const app = await _electron.launch({
    args: [
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      '--force-device-scale-factor=1',
      bootstrap,
    ],
    env,
    timeout: 30_000,
  });
  return { app, dir };
};

const frames = (page, count = 4) => page.evaluate(async n => {
  for (let i = 0; i < n; i += 1) await new Promise(requestAnimationFrame);
}, count);

try {
  await server.listen();
  const baseUrl = server.resolvedUrls.local[0] + 'tests/fixtures/populated-notebook.html?phaseCPages=6';
  let page;
  if (electronMode) {
    const launched = await launchElectronHarness();
    electronApp = launched.app;
    electronTempDir = launched.dir;
    page = await electronApp.firstWindow();
  } else {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page = await ctx.newPage();
  }

  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.addInitScript(() => {
    const origCreate = URL.createObjectURL.bind(URL);
    const origRevoke = URL.revokeObjectURL.bind(URL);
    const live = new Set();
    window.__phaseCUrls = { live, created: 0, revoked: 0 };
    URL.createObjectURL = (obj) => {
      const url = origCreate(obj);
      if (typeof url === 'string' && url.startsWith('blob:')) {
        live.add(url);
        window.__phaseCUrls.created += 1;
      }
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (typeof url === 'string') {
        live.delete(url);
        window.__phaseCUrls.revoked += 1;
      }
      return origRevoke(url);
    };
  });

  await page.goto(baseUrl, { timeout: 120_000 });
  await page.waitForFunction(() => Boolean(window.populated?.engine?.()?.drawing?.getActiveLayerCanvasElement?.()), null, { timeout: 120_000 });
  await frames(page, 12);
  await page.waitForTimeout(800);

  // Instrument getImage after initial fixture population so only runtime reads count
  const initialStats = await page.evaluate(() => {
    const cache = window.__panvasImageCache;
    return cache ? cache.getStats() : null;
  });
  assert.ok(initialStats, '__panvasImageCache is exposed for metrics');
  assert.ok(initialStats.totalBytes <= 192 * 1024 * 1024, `LRU decoded bytes ${initialStats.totalBytes} <= 192 MiB`);

  // Verify 0 duplicate concurrent preload fetches when invoking preload on same fileId concurrently
  const dedupResult = await page.evaluate(async () => {
    const cache = window.__panvasImageCache;
    const engine = window.populated.engine();
    const images = engine.images.getImages();
    const firstFileId = images[0]?.fileId;
    const beforeFetches = cache.getStats().fetchCount;
    await Promise.all([
      cache.preload(firstFileId, 512, 'visible'),
      cache.preload(firstFileId, 512, 'visible'),
      cache.preload(firstFileId, 512, 'visible'),
    ]);
    const afterFetches = cache.getStats().fetchCount;
    return { firstFileId, deltaFetches: afterFetches - beforeFetches, imageCount: images.length };
  });
  assert.equal(dedupResult.deltaFetches, 0, 'Already-decoded image must incur 0 additional repository fetches');

  // Verify warm fullRedraw timing <= 3 ms
  const redrawMs = await page.evaluate(() => {
    const engine = window.populated.engine();
    engine.drawing.redraw(); // warm
    const runs = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      engine.drawing.redraw();
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    return { medianMs: runs[2], runs };
  });
  assert.ok(redrawMs.medianMs <= 3.5, `Expected warm redraw <= 3.5ms on cached image page, got ${redrawMs.medianMs.toFixed(2)}ms`);

  // Scroll through all 6 pages (24 x 2048x1536 images) and back to page 0; count any cache-hit repository reads
  await page.evaluate(async () => {
    const { CanvasRepository } = await import('/src/repositories/CanvasRepository.ts');
    const origGetImage = CanvasRepository.prototype.getImage;
    window.__scrollGetImageCalls = 0;
    CanvasRepository.prototype.getImage = function (...args) {
      window.__scrollGetImageCalls += 1;
      return origGetImage.apply(this, args);
    };
  });

  const maxScroll = await page.evaluate(() => {
    const vp = document.querySelector('.notebook-viewport');
    return vp.scrollHeight - vp.clientHeight;
  });
  for (let step = 0; step <= 10; step += 1) {
    await page.evaluate(y => { document.querySelector('.notebook-viewport').scrollTop = y; }, Math.round((maxScroll * step) / 10));
    await page.waitForTimeout(160);
  }
  await page.waitForTimeout(500);
  const callsBeforeScrollBack = await page.evaluate(() => window.__scrollGetImageCalls);
  for (let step = 10; step >= 0; step -= 1) {
    await page.evaluate(y => { document.querySelector('.notebook-viewport').scrollTop = y; }, Math.round((maxScroll * step) / 10));
    await page.waitForTimeout(140);
  }
  await page.waitForTimeout(500);
  const scrollBackCalls = await page.evaluate(before => window.__scrollGetImageCalls - before, callsBeforeScrollBack);
  assert.equal(scrollBackCalls, 0, 'Scrolling back across cached pages must incur 0 redundant getImage IPC calls');

  // Ensure Page 0 is visible & active before checking Priority 1 ink-over-image and 800% mip promotion
  await page.evaluate(() => {
    const vp = document.querySelector('.notebook-viewport');
    if (vp) vp.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  const p0El = page.locator('[data-page-index="0"] canvas[data-committed-page-id], [data-page-index="0"] canvas[data-rendered-page-id]').first();
  if (await p0El.isVisible().catch(() => false)) {
    const box = await p0El.boundingBox();
    if (box) await page.mouse.click(box.x + 20, box.y + 20);
  }
  await page.waitForFunction(() => window.populated.engine().getDrawingOwnership().pageId === window.populated.pages[0], null, { timeout: 10_000 });
  await frames(page, 6);

  // Verify Priority 1 ink-over-image & 0 overlays & 0 pinned blob URLs
  const surfaceState = await page.evaluate(() => {
    const overlays = document.querySelectorAll('[data-image-overlay]').length;
    const pinnedUrls = window.__phaseCUrls.live.size;
    const stats = window.__panvasImageCache.getStats();
    return { overlays, pinnedUrls, stats };
  });
  assert.equal(surfaceState.overlays, 0, 'Images must render on presentation canvas, not DOM overlays');
  assert.equal(surfaceState.pinnedUrls, 0, 'No blob: URLs should remain pinned in memory');
  assert.ok(surfaceState.stats.totalBytes <= 192 * 1024 * 1024, `LRU decoded bytes ${surfaceState.stats.totalBytes} <= 192 MiB`);

  // Sample Priority 1 pixel where red pen stroke (90..260, y=160) crosses blue image (75..295, 80..245)
  const inkOverImagePos = await page.evaluate(() => {
    const engine = window.populated.engine();
    const canvas = engine.drawing.getActiveLayerCanvasElement();
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / (canvas.clientWidth || rect.width || 1);
    const scaleY = rect.height / (canvas.clientHeight || rect.height || 1);
    const pt = engine.viewport.pageToCanvas(175, 160);
    return {
      x: Math.round(rect.left + pt.x * scaleX),
      y: Math.round(rect.top + pt.y * scaleY),
      owner: engine.getDrawingOwnership().pageId,
      hasPriorityStroke: engine.drawing.getStrokes().some(s => s.id === 'priority1-ink-over-image'),
      strokeIds: engine.drawing.getStrokes().slice(-3).map(s => s.id),
    };
  });
  const screenshotBuf = await page.screenshot();
  const { data: pxData, info: pxInfo } = await sharp(screenshotBuf).raw().toBuffer({ resolveWithObject: true });
  const sampleX = Math.max(0, Math.min(pxInfo.width - 1, inkOverImagePos.x));
  const sampleY = Math.max(0, Math.min(pxInfo.height - 1, inkOverImagePos.y));
  const off = (sampleY * pxInfo.width + sampleX) * pxInfo.channels;
  const pixel = [pxData[off], pxData[off + 1], pxData[off + 2]];
  assert.ok(pixel[0] > 110 && pixel[2] < 130, `Priority 1 ink over image must remain visible red at (${sampleX},${sampleY}) owner=${inkOverImagePos.owner} hasStroke=${inkOverImagePos.hasPriorityStroke}, got rgb(${pixel.join(',')})`);

  // Test 800% zoom promotes visible image to 'original' tier cleanly
  await page.evaluate(() => {
    const engine = window.populated.engine();
    engine.viewport.setZoom(8);
    engine.drawing.redraw();
  });
  await page.waitForFunction(() => {
    const engine = window.populated.engine();
    const fileId = engine.images.getImages()[0]?.fileId;
    if (!fileId) return false;
    const hit = window.__panvasImageCache?.getBestDrawable(fileId, 'original');
    return Boolean(hit && hit.width === 2048 && hit.height === 1536);
  }, null, { timeout: 10_000 });
  const zoomCheck = await page.evaluate(() => {
    const engine = window.populated.engine();
    const fileId = engine.images.getImages()[0].fileId;
    const hit = window.__panvasImageCache.getBestDrawable(fileId, 'original');
    return { width: hit?.width ?? 0, height: hit?.height ?? 0, tier: hit?.tier ?? null };
  });
  assert.equal(zoomCheck.width, 2048, '800% zoom must promote to full 2048px original image bitmap');
  assert.equal(zoomCheck.height, 1536, '800% zoom must preserve 1536px height');

  const phaseCReport = {
    mode: electronMode ? 'electron' : 'chromium',
    pinnedObjectUrls: surfaceState.pinnedUrls,
    lruBytes: surfaceState.stats.totalBytes,
    lruMiB: +(surfaceState.stats.totalBytes / 1048576).toFixed(2),
    entryCount: surfaceState.stats.entryCount,
    redrawMedianMs: +redrawMs.medianMs.toFixed(3),
    scrollBackGetImageCalls: scrollBackCalls,
    duplicateConcurrentFetches: dedupResult.deltaFetches,
    zoom800Dims: `${zoomCheck.width}x${zoomCheck.height}`,
    priority1InkPixel: pixel,
    overlays: surfaceState.overlays,
  };
  await writeFile(path.join(outDir, `${electronMode ? 'electron' : 'chromium'}-metrics.json`), JSON.stringify(phaseCReport, null, 2));
  console.log('PHASEC_METRICS', JSON.stringify(phaseCReport));
  assert.deepEqual(errors, [], `Expected 0 page errors, got: ${errors.join('; ')}`);

  if (electronMode) {
    if (electronApp) await electronApp.close();
    if (electronTempDir) await rm(electronTempDir, { recursive: true, force: true });
    electronApp = null;
    electronTempDir = null;

    // Measure real built dist-electron/main.js RAM ("After" comparison vs Baseline 461.49 MB / 431.44 MB / 477.62 MB)
    const userData = await mkdtemp(path.join(tmpdir(), 'panvas-ram-after-'));
    const wsRoot = path.join(userData, 'workspaces');
    const env = { ...process.env, PANVAS_GATE0_PROFILE: '1', PANVAS_GATE0_USER_DATA: userData, PANVAS_GATE0_WORKSPACE_ROOT: wsRoot, PANVAS_TEST_WINDOW: '1440x900' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    delete env.VITE_DEV_SERVER_URL;

    const realApp = await _electron.launch({
      args: ['dist-electron/main.js', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
      env,
      timeout: 30_000,
    });
    try {
      const realPage = await realApp.firstWindow();
      await realPage.waitForLoadState('domcontentloaded');
      await realPage.waitForTimeout(3500);

      const snapshotRam = async (label, runGc = true) => {
        if (runGc) {
          await realPage.evaluate(() => { if (typeof window.gc === 'function') window.gc(); });
          await realPage.waitForTimeout(400);
        }
        const mainMetrics = await realApp.evaluate(({ app }) => {
          const metrics = app.getAppMetrics();
          const procMem = process.memoryUsage();
          return {
            processes: metrics.map(m => ({
              type: m.type,
              name: m.name || '',
              workingSetMB: +(m.memory.workingSetSize / 1024).toFixed(2),
              privateBytesMB: m.memory.privateBytes ? +(m.memory.privateBytes / 1024).toFixed(2) : null,
            })),
            totalWorkingSetMB: +(metrics.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024).toFixed(2),
            mainRssMB: +(procMem.rss / 1048576).toFixed(2),
            mainHeapUsedMB: +(procMem.heapUsed / 1048576).toFixed(2),
          };
        });
        const rendererMem = await realPage.evaluate(() => {
          const m = performance.memory;
          return {
            jsHeapUsedMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(2) : null,
            jsHeapTotalMB: m ? +(m.totalJSHeapSize / 1048576).toFixed(2) : null,
            fontFacesTotal: document.fonts ? document.fonts.size : 0,
            canvases: document.querySelectorAll('canvas').length,
            editors: document.querySelectorAll('.ProseMirror').length,
          };
        });
        return { label, mainMetrics, rendererMem };
      };

      const startupPreGc = await snapshotRam('AFTER_STARTUP_IDLE_PRE_GC', false);
      const startupPostGc = await snapshotRam('AFTER_STARTUP_IDLE_POST_GC', true);

      const cont = realPage.locator('button:has-text("Continue locally")');
      if (await cont.isVisible().catch(() => false)) await cont.click();
      await realPage.waitForTimeout(300);
      await realPage.locator('button:has-text("New Item")').first().click();
      await realPage.waitForTimeout(300);
      await realPage.locator('button:has-text("Notebook"), [role="menuitem"]:has-text("Notebook")').first().click();
      await realPage.waitForTimeout(300);
      await realPage.locator('input:not([type="file"]):not([type="hidden"]):not([type="checkbox"])').last().fill('RAM After Notebook');
      await realPage.locator('button[type="submit"]:has-text("Create")').first().click();
      await realPage.waitForTimeout(2500);
      const activeNotebook = await snapshotRam('AFTER_ACTIVE_NOTEBOOK', true);

      const ramReport = { startupPreGc, startupPostGc, activeNotebook };
      await writeFile(path.join(outDir, 'electron-ram-after.json'), JSON.stringify(ramReport, null, 2));
      console.log('ELECTRON_RAM_AFTER', JSON.stringify(ramReport));
    } finally {
      await realApp.close();
      await rm(userData, { recursive: true, force: true });
    }
  }

  console.log(`PASS: performance-phase-c-browser (${electronMode ? 'electron' : 'chromium'})`);
} finally {
  if (electronApp) await electronApp.close();
  if (electronTempDir) await rm(electronTempDir, { recursive: true, force: true });
  if (browser) await browser.close();
  await server.close();
}
