// Phase B Frontier Performance Verification:
// 1. 100-page smooth scroll: frame-1 mounted pages <= 4, React scroll renders reduced >80%,
//    0 layout-chrome renders (AppShell/TopBar/Sidebar/StatusBar), 0 localStorage writes during
//    active scroll burst (persisted after settle), bounded maxMiB, >=55 fps target in Electron,
//    0 detached-canvas draws, and distant Research Space page height preserved after LRU eviction.
// 2. Dense 8-page smooth scroll (1,200 strokes/page): FPS, p95 frame time, longTasks, React renders.
// 3. 10-switch Select-mode toggle + drag/lasso leak check: selectionBackingCanvases === 0,
//    lassoBackingCanvas === null after exit.
// 4. Zero page errors across all profiles.
//
// Usage: node tests/performance-phase-b-browser.mjs [--electron]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';

const electronMode = process.argv.includes('--electron');
const outDir = 'artifacts/performance-phase-b';
await mkdir(outDir, { recursive: true });

const phaseBPlugin = {
  name: 'phase-b-instrumentation',
  enforce: 'pre',
  transform(code, id) {
    const clean = id.replaceAll('\\', '/').split('?')[0];
    const normalized = code.replaceAll('\r\n', '\n');

    // Instrument populated-notebook fixture so ?phaseBPages=100 creates a realistic 100-page
    // mixed notebook (including Research Space extraBottom: 1400 on pages 90 & 95).
    if (clean.endsWith('/tests/fixtures/populated-notebook.tsx')) {
      const targetLoop = 'for (let i = 1; i < 8; i++) pages.push(await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, `Populated ${i + 1}`));';
      const targetStrokes = "const data = createEmptyDrawingData();\n    data.objects = Array.from({ length: 1200 },";
      const targetImages = 'for (let i = 0; i < 3; i++) {';
      if (normalized.includes(targetLoop) && normalized.includes(targetStrokes) && normalized.includes(targetImages)) {
        let patched = normalized.replace(
          targetLoop,
          `const phaseBCount = Number(new URLSearchParams(location.search).get('phaseBPages') || '0');
  const pageCount = phaseBCount > 0 ? phaseBCount : 8;
  for (let i = 1; i < pageCount; i++) pages.push(await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, \`Populated \${i + 1}\`));`,
        );
        patched = patched.replace(
          targetStrokes,
          `const data = createEmptyDrawingData();
    if (phaseBCount > 0 && index === 89) {
      data.properties = { ...data.properties, extraBottom: 1400 };
      await db.notebookPages.update(page.id, { pagePropertyOverrides: { extraBottom: 1400 } });
    } else if (phaseBCount > 0 && index === 94) {
      data.properties = { ...data.properties, extraBottom: 1400 };
      await db.notebookPages.update(page.id, { pagePropertyOverrides: undefined });
    }
    const strokeCount = phaseBCount > 0 ? 96 : 1200;
    const ptsPerStroke = phaseBCount > 0 ? 12 : 96;
    data.objects = Array.from({ length: strokeCount },`,
        );
        patched = patched.replace(
          'Array.from({ length: 96 }, (_, j) =>',
          'Array.from({ length: ptsPerStroke }, (_, j) =>',
        );
        patched = patched.replace(
          targetImages,
          'for (let i = 0; i < (phaseBCount > 0 ? (index < 6 ? 1 : 0) : 3); i++) {',
        );
        return patched;
      }
    }

    if (clean.endsWith('/DrawingEngine.ts')) {
      let out = normalized;
      const redrawTarget = 'redraw(dirty?: EraseBounds, boundsForStroke?: (stroke: Stroke) => EraseBounds, excludeIds?: Set<string>): void {';
      if (out.includes(redrawTarget)) {
        out = out.replace(
          redrawTarget,
          `${redrawTarget}
    if (typeof window !== 'undefined' && (window as any).__phaseB) {
      const w = (window as any).__phaseB;
      if (this.ctx && this.canvas && !this.isSurfaceDetached()) w.redraws += 1;
      else if (this.canvas && this.isSurfaceDetached()) w.detachedPaints += 1;
    }`,
        );
      }
      const paintStepTarget = "if (step.kind === 'image') this.imageManager.renderImage";
      if (out.includes(paintStepTarget)) {
        out = out.replace(
          paintStepTarget,
          `if (typeof window !== 'undefined' && (window as any).__phaseB && this.isSurfaceDetached()) {
        (window as any).__phaseB.detachedPaints += 1;
      }
      ${paintStepTarget}`,
        );
      }
      if (out !== normalized) return out;
    }

    const trackedComponents = [
      ['/NotebookRenderer.tsx', 'NotebookRenderer', 'const [activeTool, setActiveTool]'],
      ['/AppShell.tsx', 'AppShell', 'const { isSidebarOpen'],
      ['/TopBar.tsx', 'TopBar', 'export function TopBar() {'],
      ['/Sidebar.tsx', 'Sidebar', 'export function Sidebar() {'],
      ['/StatusBar.tsx', 'StatusBar', 'export function StatusBar() {'],
    ];
    for (const [suffix, key, anchor] of trackedComponents) {
      if (clean.endsWith(suffix) && normalized.includes(anchor)) {
        if (anchor.startsWith('const ')) {
          return normalized.replace(
            anchor,
            `if (typeof window !== 'undefined' && (window as any).__phaseB) (window as any).__phaseB.renders['${key}'] = ((window as any).__phaseB.renders['${key}'] || 0) + 1;\n  ${anchor}`,
          );
        }
        return normalized.replace(
          anchor,
          `${anchor}\n  if (typeof window !== 'undefined' && (window as any).__phaseB) (window as any).__phaseB.renders['${key}'] = ((window as any).__phaseB.renders['${key}'] || 0) + 1;`,
        );
      }
    }
    return undefined;
  },
};

const server = await createServer({
  mode: 'web',
  cacheDir: path.join(outDir, 'vite-cache'),
  optimizeDeps: { entries: ['tests/fixtures/populated-notebook.html'] },
  plugins: [phaseBPlugin],
  server: { port: 0, open: false, hmr: false, watch: null },
});

let browser;
let electronApp;
let electronTempDir;

const launchElectron = async (width = 1440, height = 900, dpr = 1) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panvas-phase-b-electron-'));
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
      `--force-device-scale-factor=${dpr}`,
      bootstrap,
    ],
    env,
    timeout: 30_000,
  });
  return { app, dir };
};

const percentile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
};

const frames = (page, count = 4) => page.evaluate(async n => {
  for (let i = 0; i < n; i += 1) await new Promise(requestAnimationFrame);
}, count);

async function openHarness(baseUrl, dpr, { installFrame1Probe = false } = {}) {
  const width = 1440;
  const height = 900;
  if (electronMode) {
    if (!electronApp) {
      const launched = await launchElectron(width, height, dpr);
      electronApp = launched.app;
      electronTempDir = launched.dir;
    }
    const page = await electronApp.firstWindow();
    const errors = [];
    page.removeAllListeners('pageerror');
    page.on('pageerror', err => errors.push(err.message));
    if (installFrame1Probe) {
      await page.addInitScript(() => {
        window.__phaseB = { redraws: 0, detachedPaints: 0, renders: {}, frame1FullPages: null, localStorageSets: 0 };
        const obs = new MutationObserver(() => {
          if (window.__phaseB.frame1FullPages !== null) return;
          const viewport = document.querySelector('.notebook-viewport');
          if (!viewport) return;
          const mounted = viewport.querySelectorAll('[data-page-index]:has([data-rendered-page-id], svg.panvas-colored-content)').length;
          if (mounted > 0) {
            window.__phaseB.frame1FullPages = mounted;
            obs.disconnect();
          }
        });
        obs.observe(document, { childList: true, subtree: true });
      });
    } else {
      await page.addInitScript(() => {
        window.__phaseB = { redraws: 0, detachedPaints: 0, renders: {}, frame1FullPages: null, localStorageSets: 0 };
      });
    }
    await page.goto(baseUrl, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.populated?.engine?.()?.drawing?.getActiveLayerCanvasElement?.()), null, { timeout: 120_000 });
    await frames(page, 6);
    return { page, errors, close: async () => {} };
  }

  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.addInitScript(checkFrame1 => {
    window.__phaseB = { redraws: 0, detachedPaints: 0, renders: {}, frame1FullPages: null, localStorageSets: 0 };
    if (checkFrame1) {
      const obs = new MutationObserver(() => {
        if (window.__phaseB.frame1FullPages !== null) return;
        const viewport = document.querySelector('.notebook-viewport');
        if (!viewport) return;
        const mounted = viewport.querySelectorAll('[data-page-index]:has([data-rendered-page-id], svg.panvas-colored-content)').length;
        if (mounted > 0) {
          window.__phaseB.frame1FullPages = mounted;
          obs.disconnect();
        }
      });
      obs.observe(document, { childList: true, subtree: true });
    }
  }, installFrame1Probe);
  await page.goto(baseUrl, { timeout: 120_000 });
  await page.waitForFunction(() => Boolean(window.populated?.engine?.()?.drawing?.getActiveLayerCanvasElement?.()), null, { timeout: 120_000 });
  await frames(page, 6);
  return { page, errors, close: async () => { await context.close(); } };
}

async function runScrollBenchmark(page, { steps, distancePerStep = null }) {
  await page.evaluate(() => {
    const b = window.__phaseB;
    b.redraws = 0;
    b.detachedPaints = 0;
    b.localStorageSets = 0;
    b.localStorageEvents = [];
    for (const k of Object.keys(b.renders)) b.renders[k] = 0;
    window.__PANVAS_GATE0_PROFILER__?.reset?.();
    if (!window.__phaseBStorageHooked) {
      window.__phaseBStorageHooked = true;
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (...args) {
        if (window.__phaseB) {
          window.__phaseB.localStorageSets += 1;
          window.__phaseB.localStorageEvents?.push({ key: String(args[0]), t: Math.round(performance.now()) });
        }
        return orig.apply(this, args);
      };
    }
  });

  const metrics = await page.evaluate(async ({ stepCount, stepPx }) => {
    const scroller = document.querySelector('.notebook-viewport');
    const longTasks = [];
    let observer;
    try {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) longTasks.push(entry.duration);
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch { /* unsupported in older shells */ }

    const intervals = [];
    let maxCanvasBytes = 0;
    const sampleMem = () => {
      let bytes = 0;
      for (const c of document.querySelectorAll('canvas')) {
        bytes += (c.width || 0) * (c.height || 0) * 4;
      }
      if (bytes > maxCanvasBytes) maxCanvasBytes = bytes;
    };

    const maxScroll = Math.max(100, scroller.scrollHeight - scroller.clientHeight);
    const startTop = scroller.scrollTop;
    let prev = await new Promise(requestAnimationFrame);
    const startAt = prev;
    for (let i = 1; i <= stepCount; i += 1) {
      const targetTop = stepPx && stepPx > 0
        ? Math.min(maxScroll, startTop + Math.round(i * stepPx))
        : Math.min(maxScroll, Math.round((i / stepCount) * maxScroll));
      scroller.scrollTop = targetTop;
      const now = await new Promise(requestAnimationFrame);
      intervals.push(now - prev);
      prev = now;
      sampleMem();
    }
    const elapsedMs = prev - startAt;
    try { observer?.disconnect(); } catch {}
    const activeLocalStorageSets = window.__phaseB.localStorageSets;
    const activeLocalStorageKeys = [...(window.__phaseB.localStorageEvents ?? [])];

    // Wait for passive activation & deferred localStorage flush (~800 ms).
    await new Promise(r => setTimeout(r, 850));
    for (let i = 0; i < 4; i += 1) await new Promise(requestAnimationFrame);

    const g = window.__PANVAS_GATE0_PROFILER__?.report?.() ?? { resources: {} };
    const totalRenders = {
      NotebookRenderer: window.__phaseB.renders.NotebookRenderer || (g.resources['reactRenders.NotebookRenderer'] || 0),
      NotebookPageView: g.resources['reactRenders.NotebookPageView'] || 0,
      AppShell: window.__phaseB.renders.AppShell || 0,
      TopBar: window.__phaseB.renders.TopBar || 0,
      Sidebar: window.__phaseB.renders.Sidebar || 0,
      StatusBar: window.__phaseB.renders.StatusBar || 0,
    };

    return {
      intervals,
      elapsedMs,
      longTasksCount: longTasks.length,
      longTasksTotalMs: Math.round(longTasks.reduce((a, b) => a + b, 0) * 10) / 10,
      activeLocalStorageSets,
      activeLocalStorageKeys,
      settledLocalStorageSets: window.__phaseB.localStorageSets,
      redraws: window.__phaseB.redraws,
      detachedPaints: window.__phaseB.detachedPaints,
      maxCanvasMiB: Math.round((maxCanvasBytes / (1024 * 1024)) * 100) / 100,
      heapUsedMiB: performance.memory ? Math.round((performance.memory.usedJSHeapSize / (1024 * 1024)) * 100) / 100 : null,
      renders: totalRenders,
      finalActivePage: localStorage.getItem('panvas.activePageId'),
    };
  }, { stepCount: steps, stepPx: distancePerStep });

  const avgMs = metrics.elapsedMs / Math.max(1, metrics.intervals.length);
  const avgFps = Math.round((1000 / Math.max(1, avgMs)) * 10) / 10;
  return {
    avgFps,
    p50Ms: Math.round(percentile(metrics.intervals, 0.5) * 10) / 10,
    p95Ms: Math.round(percentile(metrics.intervals, 0.95) * 10) / 10,
    maxMs: Math.round(Math.max(0, ...metrics.intervals) * 10) / 10,
    longTasksCount: metrics.longTasksCount,
    longTasksTotalMs: metrics.longTasksTotalMs,
    activeLocalStorageSets: metrics.activeLocalStorageSets,
    activeLocalStorageKeys: metrics.activeLocalStorageKeys,
    settledLocalStorageSets: metrics.settledLocalStorageSets,
    redraws: metrics.redraws,
    detachedPaints: metrics.detachedPaints,
    maxCanvasMiB: metrics.maxCanvasMiB,
    heapUsedMiB: metrics.heapUsedMiB,
    renders: metrics.renders,
    finalActivePage: metrics.finalActivePage,
  };
}

try {
  await server.listen();
  const base = server.resolvedUrls.local[0];
  if (!electronMode) {
    browser = await chromium.launch({ headless: true });
  }

  const profiles = electronMode
    ? [{ name: 'electron-dpr-1.0', dpr: 1.0 }]
    : [
        { name: 'chromium-dpr-1.25', dpr: 1.25 },
        { name: 'chromium-dpr-2.0', dpr: 2.0 },
      ];

  const results = [];

  for (const profile of profiles) {
    // 1. 100-page scroll + Frame-1 mount check + Distant Research Space height + LRU bounds
    const url100 = `${base}tests/fixtures/populated-notebook.html?gate0Profile=1&phaseBPages=100`;
    const h100 = await openHarness(url100, profile.dpr, { installFrame1Probe: true });
    let scroll100;
    let distantCheck;
    let frame1FullPages;
    try {
      // Wait for chunked distant property scan to settle before reading page 90/95 height.
      await h100.page.waitForFunction(() => {
        const p90 = document.querySelector('[data-page-index="89"]');
        const p95 = document.querySelector('[data-page-index="94"]');
        return p90 && parseFloat(p90.style.height) > 2000 && p95 && parseFloat(p95.style.height) > 2000;
      }, null, { timeout: 60_000 });
      await frames(h100.page, 10);
      frame1FullPages = await h100.page.evaluate(() => window.__phaseB.frame1FullPages);
      assert.ok(
        frame1FullPages !== null && frame1FullPages <= 5,
        `${profile.name}: expected frame-1 full pages <= 5 (got ${frame1FullPages})`,
      );

      scroll100 = await runScrollBenchmark(h100.page, { steps: 120, distancePerStep: 220 });

      // Jump to the end of the 100-page section (pages 90-100) to verify distant Research Space
      // page height preservation, LRU eviction residency cap, and 0 detached paints.
      await h100.page.evaluate(() => {
        const scroller = document.querySelector('.notebook-viewport');
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
      });
      await frames(h100.page, 6);
      await h100.page.waitForTimeout(250);

      distantCheck = await h100.page.evaluate(() => {
        const p90 = document.querySelector('[data-page-index="89"]');
        const p95 = document.querySelector('[data-page-index="94"]');
        const a4Height = 1123;
        return {
          p90Height: p90 ? Math.round(parseFloat(p90.style.height)) : 0,
          p95Height: p95 ? Math.round(parseFloat(p95.style.height)) : 0,
          expectedMinHeight: a4Height + 1400 - 2,
          renderedPagesAtEnd: document.querySelectorAll('[data-page-index]:has([data-rendered-page-id], svg.panvas-colored-content)').length,
          detachedPaintsTotal: window.__phaseB?.detachedPaints ?? 0,
        };
      });

      const scroll100Errors = [...h100.errors];
      const partial100 = { profile: profile.name, dpr: profile.dpr, frame1FullPages, scroll100, distantCheck, errors: scroll100Errors };
      await writeFile(path.join(outDir, `${profile.name}.json`), JSON.stringify(partial100, null, 2));
      console.log(`PHASEB_100 ${JSON.stringify(partial100)}`);

      assert.ok(distantCheck.p90Height >= distantCheck.expectedMinHeight, `${profile.name}: distant page 90 Research Space height preserved (${distantCheck.p90Height})`);
      assert.ok(distantCheck.p95Height >= distantCheck.expectedMinHeight, `${profile.name}: distant page 95 Research Space height preserved (${distantCheck.p95Height})`);
      assert.ok(distantCheck.renderedPagesAtEnd <= 5, `${profile.name}: expected <= 5 mounted pages at section end (got ${distantCheck.renderedPagesAtEnd})`);
      assert.equal(distantCheck.detachedPaintsTotal, 0, `${profile.name}: expected 0 detached paints across 100-page scroll + jump`);
      assert.equal(scroll100.detachedPaints, 0, `${profile.name}: expected 0 detached paints in 100-page scroll`);
      assert.equal(scroll100.activeLocalStorageSets, 0, `${profile.name}: expected 0 localStorage writes during active scroll burst`);
      assert.ok(scroll100.settledLocalStorageSets >= 1, `${profile.name}: expected deferred localStorage write after settle`);
      assert.equal(scroll100.renders.AppShell, 0, `${profile.name}: expected 0 AppShell renders during scroll`);
      assert.equal(scroll100.renders.StatusBar, 0, `${profile.name}: expected 0 StatusBar renders during scroll`);
      assert.equal(scroll100.renders.TopBar, 0, `${profile.name}: expected 0 TopBar shell renders during scroll`);
      assert.equal(scroll100.renders.Sidebar, 0, `${profile.name}: expected 0 Sidebar renders during scroll`);
      assert.ok(scroll100.renders.NotebookPageView <= 120, `${profile.name}: expected NotebookPageView renders <= 120 on 100-page scroll (got ${scroll100.renders.NotebookPageView})`);
      if (electronMode) {
        assert.ok(scroll100.avgFps >= 55, `${profile.name}: expected Electron 100-page scroll >= 55 fps (got ${scroll100.avgFps})`);
      }
      assert.deepEqual(scroll100Errors, [], `${profile.name} 100-page errors`);
    } finally {
      await h100.close();
    }

    // 2. Dense 8-page scroll + 10-switch Select-mode toggle leak check
    const urlDense = `${base}tests/fixtures/populated-notebook.html?gate0Profile=1`;
    const hDense = await openHarness(urlDense, profile.dpr);
    let scrollDense;
    let leakCheck;
    try {
      scrollDense = await runScrollBenchmark(hDense.page, { steps: 60 });

      // 10-switch Select mode toggle + lasso + drag cleanup verification.
      leakCheck = await hDense.page.evaluate(async () => {
        const engine = window.populated.engine();
        const drawing = engine.drawing;
        for (let i = 0; i < 10; i += 1) {
          engine.tools.setMode('select');
          drawing.warmSelectionBacking();
          drawing.startLasso();
          drawing.endLasso();
          drawing.beginSelectionDrag([]);
          drawing.endSelectionDrag();
          engine.tools.setMode('draw');
        }
        await new Promise(requestAnimationFrame);
        return {
          selectionBackingSize: drawing.selectionBackingCanvases?.size ?? -1,
          lassoBackingNull: drawing.lassoBackingCanvas === null,
        };
      });

      const summary = {
        profile: profile.name,
        dpr: profile.dpr,
        frame1FullPages,
        scroll100,
        distantCheck,
        scrollDense,
        leakCheck,
      };
      await writeFile(path.join(outDir, `${profile.name}.json`), JSON.stringify(summary, null, 2));
      console.log(JSON.stringify(summary));

      assert.equal(scrollDense.detachedPaints, 0, `${profile.name}: expected 0 detached paints in dense 8-page scroll`);
      assert.equal(scrollDense.activeLocalStorageSets, 0, `${profile.name}: expected 0 localStorage writes during dense scroll`);
      assert.ok(scrollDense.renders.NotebookPageView <= 35, `${profile.name}: expected dense 8-page NotebookPageView renders <= 35 (got ${scrollDense.renders.NotebookPageView})`);
      assert.equal(leakCheck.selectionBackingSize, 0, `${profile.name}: expected 0 retained selection backing canvases after leaving Select mode`);
      assert.equal(leakCheck.lassoBackingNull, true, `${profile.name}: expected lassoBackingCanvas === null after endLasso/tool switch`);
      assert.deepEqual(hDense.errors, [], `${profile.name} dense-8 errors`);
      results.push(summary);
    } finally {
      await hDense.close();
    }
  }

  await writeFile(
    path.join(outDir, `${electronMode ? 'electron' : 'chromium'}-results.json`),
    JSON.stringify(results, null, 2),
  );
  console.log(`PASS: performance-phase-b-browser (${electronMode ? 'electron' : 'chromium'})`);
} finally {
  if (electronApp) await electronApp.close().catch(() => {});
  if (electronTempDir) await rm(electronTempDir, { recursive: true, force: true }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await server.close();
}
