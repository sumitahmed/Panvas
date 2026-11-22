// Phase A Frontier Performance Verification:
// 1. Crisp 800% zoom (physStretch <= 1.02) across A4, multi-sheet Document,
//    Research Space (+1400 px), multi-layer (L=2 at 100%), and live WetInkSurface.
// 2. 1x1 blank base canvas + bounded active 800% VRAM (<= 55 MiB @ DPR<=1.25, <= 105 MiB @ DPR 2.0).
// 3. Zero-reallocation active Ctrl+wheel zoom (0 NR/NPV renders, 0 localStorage writes)
//    and single-pass settle (settleRedraws <= 1, 0 inactive repaints > 125%).
// 4. 800% pan window rebase + lasso selection move with zero ghosting.
// Usage: node tests/performance-phase-a-browser.mjs [--electron]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';

const electronMode = process.argv.includes('--electron');
const outDir = 'artifacts/performance-phase-a';
await mkdir(outDir, { recursive: true });

const phaseAPlugin = {
  name: 'phase-a-instrumentation',
  enforce: 'pre',
  transform(code, id) {
    const clean = id.replaceAll('\\', '/').split('?')[0];
    if (clean.endsWith('/DrawingEngine.ts')) {
      const normalized = code.replaceAll('\r\n', '\n');
      const target = 'redraw(dirty?: EraseBounds, boundsForStroke?: (stroke: Stroke) => EraseBounds, excludeIds?: Set<string>): void {';
      if (normalized.includes(target)) {
        return normalized.replace(
          target,
          `${target}\n    if (typeof window !== 'undefined' && (window as any).__phaseACounters) {\n      const c = (window as any).__phaseACounters;\n      c.totalRedraws++;\n      if (this === (window as any).__phaseAActiveDrawing) c.activeRedraws++;\n      else c.inactiveRedraws++;\n    }`,
        );
      }
    }
    if (clean.endsWith('/ViewportManager.ts')) {
      const normalized = code.replaceAll('\r\n', '\n');
      const target = 'if (dimsChanged) {\n      canvas.width = targetWidth;\n      canvas.height = targetHeight;\n    }';
      if (normalized.includes(target)) {
        return normalized.replace(
          target,
          `if (dimsChanged) {\n      canvas.width = targetWidth;\n      canvas.height = targetHeight;\n      if (typeof window !== 'undefined' && (window as any).__phaseACounters) (window as any).__phaseACounters.canvasReallocs++;\n    }`,
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
  plugins: [phaseAPlugin],
  server: { port: 0, open: false },
});

let browser;
let electronApp;
let electronTempDir;

const launchElectron = async (width = 1440, height = 900) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panvas-phase-a-electron-'));
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
  win.loadURL('about:blank');
});`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const app = await _electron.launch({ args: [bootstrap], env, timeout: 30_000 });
  const page = await app.firstWindow();
  return { app, page, dir };
};

const frames = (page, count = 6) => page.evaluate(async n => {
  for (let i = 0; i < n; i += 1) await new Promise(requestAnimationFrame);
}, count);

const percentile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
};

async function openHarness(baseUrl, { dpr, width = 1440, height = 900 }) {
  if (electronMode) {
    if (!electronApp) {
      const launched = await launchElectron(width, height);
      electronApp = launched.app;
      electronTempDir = launched.dir;
    }
    const page = await electronApp.firstWindow();
    const cdp = await electronApp.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
    const errors = [];
    page.removeAllListeners('pageerror');
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(baseUrl, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.populated?.engine?.()?.drawing?.getActiveLayerCanvasElement?.()), null, { timeout: 90_000 });
    return { page, errors, close: async () => { await cdp.detach(); } };
  }
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(baseUrl, { timeout: 120_000 });
  await page.waitForFunction(() => Boolean(window.populated?.engine?.()?.drawing?.getActiveLayerCanvasElement?.()), null, { timeout: 90_000 });
  return { page, errors, close: async () => { await context.close(); } };
}

async function installProbes(page) {
  await page.evaluate(() => {
    window.__phaseACounters = {
      totalRedraws: 0,
      activeRedraws: 0,
      inactiveRedraws: 0,
      canvasReallocs: 0,
      localStorageWrites: 0,
    };
    window.__phaseAActiveDrawing = window.populated.engine().drawing;
    if (!window.__phaseALocalStorageHooked) {
      window.__phaseALocalStorageHooked = true;
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (...args) {
        if (window.__phaseACounters) window.__phaseACounters.localStorageWrites++;
        return orig.apply(this, args);
      };
    }
    window.__phaseAReset = () => {
      const c = window.__phaseACounters;
      c.totalRedraws = 0;
      c.activeRedraws = 0;
      c.inactiveRedraws = 0;
      c.canvasReallocs = 0;
      c.localStorageWrites = 0;
      window.__PANVAS_GATE0_PROFILER__?.reset?.();
      window.populated?.reset?.();
    };
    window.__phaseAReport = () => {
      const c = { ...window.__phaseACounters };
      const g = window.__PANVAS_GATE0_PROFILER__?.report?.() ?? { resources: {} };
      return {
        ...c,
        nrRenders: g.resources['reactRenders.NotebookRenderer'] || 0,
        npvRenders: g.resources['reactRenders.NotebookPageView'] || 0,
        nrCommits: g.resources['reactCommits.NotebookRenderer'] || 0,
        npvCommits: g.resources['reactCommits.NotebookPageView'] || 0,
      };
    };
  });
}

async function setExactZoom(page, targetScale) {
  await page.evaluate(async scale => {
    const engine = window.populated.engine();
    engine.viewport.setZoom(scale);
    await new Promise(resolve => setTimeout(resolve, 260));
    for (let i = 0; i < 8; i += 1) await new Promise(requestAnimationFrame);
  }, targetScale);
}

async function inspectSurfaceMetrics(page, dpr) {
  return page.evaluate(effectiveDpr => {
    const engine = window.populated.engine();
    const base = engine.drawing.getCanvasElement();
    const activePageRoot = document.querySelector('[data-live-page-visual]');
    const layers = activePageRoot
      ? [...activePageRoot.querySelectorAll('canvas[data-panvas-presentation-layer]')]
      : [];
    const activeLayer = engine.drawing.getActiveLayerCanvasElement?.() ?? layers[0] ?? base;
    const layerMetrics = layers.map(canvas => {
      const rect = canvas.getBoundingClientRect();
      const stretchX = canvas.width > 0 ? (rect.width * effectiveDpr) / canvas.width : Infinity;
      const stretchY = canvas.height > 0 ? (rect.height * effectiveDpr) / canvas.height : Infinity;
      return {
        id: canvas.dataset.panvasPresentationLayer,
        width: canvas.width,
        height: canvas.height,
        cssWidth: rect.width,
        cssHeight: rect.height,
        stretchX,
        stretchY,
        physStretch: Math.max(stretchX, stretchY),
      };
    });
    const wet = document.querySelector('canvas[data-panvas-wet-ink="true"]');
    let wetMetric = null;
    if (wet && wet.style.opacity !== '0') {
      const wr = wet.getBoundingClientRect();
      const wsx = wet.width > 0 ? (wr.width * effectiveDpr) / wet.width : Infinity;
      const wsy = wet.height > 0 ? (wr.height * effectiveDpr) / wet.height : Infinity;
      wetMetric = {
        width: wet.width,
        height: wet.height,
        physStretch: Math.max(wsx, wsy),
        bytes: wet.width * wet.height * 4,
      };
    }
    const baseBytes = (base?.width || 0) * (base?.height || 0) * 4;
    const layerBytes = layers.reduce((sum, c) => sum + c.width * c.height * 4, 0);
    const activeRect = activeLayer?.getBoundingClientRect();
    const maxPhysStretch = layerMetrics.length
      ? Math.max(...layerMetrics.map(m => m.physStretch))
      : Infinity;
    return {
      scale: engine.viewport.getState().scale,
      basePixels: base ? base.width * base.height : 0,
      layerCount: layers.length,
      layerMetrics,
      maxPhysStretch,
      activeLayer: activeLayer ? { width: activeLayer.width, height: activeLayer.height, cssWidth: activeRect?.width ?? 0, cssHeight: activeRect?.height ?? 0 } : null,
      vramMiB: (baseBytes + layerBytes) / (1024 * 1024),
      wetMetric,
      vramWithWetMiB: (baseBytes + layerBytes + (wetMetric?.bytes ?? 0)) / (1024 * 1024),
      renderOrigin: engine.viewport.getRenderWindowOrigin(),
    };
  }, dpr);
}

async function runWheelZoomLeg(page, { deltaY, ticks }) {
  await page.evaluate(() => window.__phaseAReset());
  const activeResult = await page.evaluate(async ({ deltaY, ticks }) => {
    const viewport = document.querySelector('.notebook-viewport');
    const rect = viewport.getBoundingClientRect();
    const clientX = rect.left + rect.width * 0.5;
    const clientY = rect.top + rect.height * 0.45;
    const intervals = [];
    let lastTs = performance.now();
    for (let i = 0; i < ticks; i += 1) {
      viewport.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY,
        clientX,
        clientY,
      }));
      await new Promise(resolve => requestAnimationFrame(ts => {
        intervals.push(ts - lastTs);
        lastTs = ts;
        resolve();
      }));
    }
    return {
      activeCounters: window.__phaseAReport(),
      scaleAfterTicks: window.populated.engine().viewport.getState().scale,
      intervals,
    };
  }, { deltaY, ticks });

  const settleIntervals = await page.evaluate(async () => {
    const intervals = [];
    let last = performance.now();
    const deadline = last + 340;
    while (performance.now() < deadline) {
      await new Promise(resolve => requestAnimationFrame(now => {
        intervals.push(now - last);
        last = now;
        resolve();
      }));
    }
    for (let i = 0; i < 6; i += 1) {
      await new Promise(resolve => requestAnimationFrame(now => {
        intervals.push(now - last);
        last = now;
        resolve();
      }));
    }
    return intervals;
  });

  const settledCounters = await page.evaluate(() => window.__phaseAReport());
  return {
    scaleAfterTicks: activeResult.scaleAfterTicks,
    activeCounters: activeResult.activeCounters,
    activeMaxMs: Math.max(0, ...activeResult.intervals),
    activeP95Ms: percentile(activeResult.intervals, 0.95),
    settledCounters,
    settleRedraws: settledCounters.activeRedraws - activeResult.activeCounters.activeRedraws,
    inactiveSettleRedraws: settledCounters.inactiveRedraws - activeResult.activeCounters.inactiveRedraws,
    settleMaxMs: Math.max(0, ...settleIntervals),
  };
}

try {
  await server.listen();
  const baseUrl = `${server.resolvedUrls.local[0]}tests/fixtures/populated-notebook.html?gate0Profile=1`;
  if (!electronMode) browser = await chromium.launch({ headless: true });

  const profiles = electronMode
    ? [{ name: 'electron-dpr1.0', dpr: 1.0, maxVramMiB: 55, maxWetTotalVramMiB: 110 }]
    : [
        { name: 'chromium-dpr1.25', dpr: 1.25, maxVramMiB: 55, maxWetTotalVramMiB: 110 },
        { name: 'chromium-dpr2.0', dpr: 2.0, maxVramMiB: 105, maxWetTotalVramMiB: 205 },
      ];

  const allResults = [];
  for (const profile of profiles) {
    const { page, errors, close } = await openHarness(baseUrl, { dpr: profile.dpr });
    try {
      await frames(page, 18);
      await setExactZoom(page, 1.0);
      await installProbes(page);

      // 1. Zero-reallocation active zoom + single-pass settle on 1,200-stroke page.
      const leg100to418 = await runWheelZoomLeg(page, { deltaY: -120, ticks: 15 });
      const leg418to800 = await runWheelZoomLeg(page, { deltaY: -120, ticks: 7 });
      const leg800to100 = await runWheelZoomLeg(page, { deltaY: 120, ticks: 22 });

      for (const [label, leg, checkInactiveAbove125] of [
        ['100->418', leg100to418, true],
        ['418->800', leg418to800, true],
        ['800->100', leg800to100, false],
      ]) {
        const diag = JSON.stringify({
          profile: profile.name,
          label,
          activeMaxMs: leg.activeMaxMs,
          activeP95Ms: leg.activeP95Ms,
          activeCounters: leg.activeCounters,
          settleRedraws: leg.settleRedraws,
          inactiveSettleRedraws: leg.inactiveSettleRedraws,
          settleMaxMs: leg.settleMaxMs,
        });
        assert.equal(leg.activeCounters.nrRenders, 0, `${diag}: expected 0 NotebookRenderer renders during active ticks`);
        assert.equal(leg.activeCounters.npvRenders, 0, `${diag}: expected 0 NotebookPageView renders during active ticks`);
        assert.equal(leg.activeCounters.localStorageWrites, 0, `${diag}: expected 0 localStorage.setItem writes during active ticks`);
        assert.ok(leg.settleRedraws <= 1, `${diag}: expected <= 1 settle redraw`);
        if (checkInactiveAbove125) {
          assert.equal(leg.inactiveSettleRedraws, 0, `${diag}: expected 0 inactive repaints > 125%`);
        }
      }

      // 2. Crisp 800% (Regular A4 L=1), 1x1 base, bounded VRAM, and live WetInkSurface.
      await setExactZoom(page, 8.0);
      const regular800 = await inspectSurfaceMetrics(page, profile.dpr);
      assert.ok(regular800.scale >= 7.99, `${profile.name}: expected 800% zoom, got ${regular800.scale}`);
      assert.ok(regular800.basePixels <= 4, `${profile.name}: expected 1x1 blank base canvas, got ${regular800.basePixels} px`);
      assert.ok(regular800.maxPhysStretch <= 1.02, `${profile.name} Regular A4 800%: expected physStretch <= 1.02, got ${regular800.maxPhysStretch}`);
      assert.ok(regular800.vramMiB <= profile.maxVramMiB, `${profile.name} 800% VRAM ${regular800.vramMiB.toFixed(2)} MiB exceeded ${profile.maxVramMiB} MiB`);

      // Live WetInkSurface mid-stroke check + Task 3 pointermove->paint latency benchmark at 800%.
      const wetLatencyStats = await page.evaluate(async () => {
        const engine = window.populated.engine();
        engine.tools.setMode('draw');
        engine.tools.setDrawingTool('pen');
        engine.tools.setColor('#1d4ed8');
        engine.tools.setThickness(2.5);
        engine.tools.setOpacity(1);
        const canvas = engine.drawing.getCanvasElement();
        const scroller = document.querySelector('.notebook-viewport');
        const vr = scroller.getBoundingClientRect();
        const cx = vr.left + vr.width / 2;
        const cy = vr.top + vr.height / 2;
        const origRender = engine.drawing.renderLiveStroke.bind(engine.drawing);
        const latencies = [];
        let dispatchTs = 0;
        engine.drawing.renderLiveStroke = function (...args) {
          const out = origRender(...args);
          if (dispatchTs > 0) {
            latencies.push(performance.now() - dispatchTs);
            dispatchTs = 0;
          }
          return out;
        };
        try {
          canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 501, pointerType: 'mouse', button: 0, buttons: 1, clientX: cx - 40, clientY: cy }));
          for (let step = 1; step <= 24; step += 1) {
            dispatchTs = performance.now();
            canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 501, pointerType: 'mouse', buttons: 1, clientX: cx - 40 + step * 3, clientY: cy + Math.sin(step) * 4 }));
          }
        } finally {
          engine.drawing.renderLiveStroke = origRender;
        }
        latencies.sort((a, b) => a - b);
        const pick = q => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * q))] : 0;
        return { samples: latencies.length, p50Ms: Number(pick(0.5).toFixed(3)), p95Ms: Number(pick(0.95).toFixed(3)), maxMs: Number((latencies[latencies.length - 1] ?? 0).toFixed(3)) };
      });
      await frames(page, 2);
      assert.ok(wetLatencyStats.p95Ms < 8, `${profile.name} pointermove->WetInk p95=${wetLatencyStats.p95Ms}ms too high`);
      const wetMidStroke = await inspectSurfaceMetrics(page, profile.dpr);
      assert.ok(wetMidStroke.wetMetric, `${profile.name}: expected live WetInkSurface mid-stroke at 800%`);
      assert.ok(wetMidStroke.wetMetric.physStretch <= 1.02, `${profile.name} WetInk 800%: expected physStretch <= 1.02, got ${wetMidStroke.wetMetric.physStretch}`);
      assert.ok(wetMidStroke.vramWithWetMiB <= profile.maxWetTotalVramMiB, `${profile.name} WetInk VRAM ${wetMidStroke.vramWithWetMiB.toFixed(2)} MiB exceeded ${profile.maxWetTotalVramMiB} MiB`);
      await page.evaluate(() => {
        const engine = window.populated.engine();
        const canvas = engine.drawing.getCanvasElement();
        const vr = document.querySelector('.notebook-viewport').getBoundingClientRect();
        canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 501, pointerType: 'mouse', button: 0, buttons: 0, clientX: vr.left + vr.width / 2 + 32, clientY: vr.top + vr.height / 2 + 18 }));
      });
      await frames(page, 6);

      // Multi-sheet Document at 800%.
      await page.evaluate(() => {
        const engine = window.populated.engine();
        engine.setProperties({ layoutMode: 'document', layoutExtent: 4000 });
      });
      await frames(page, 18);
      await setExactZoom(page, 8.0);
      const doc800 = await inspectSurfaceMetrics(page, profile.dpr);
      assert.ok(doc800.maxPhysStretch <= 1.02, `${profile.name} Multi-sheet Document 800%: expected physStretch <= 1.02, got ${doc800.maxPhysStretch}`);

      // Research Space (+1400 px) at 800%.
      await page.evaluate(() => {
        const engine = window.populated.engine();
        engine.setProperties({ layoutMode: 'freeform', extraLeft: 1400, extraTop: 1400, extraRight: 1400, extraBottom: 1400 });
      });
      await frames(page, 18);
      await setExactZoom(page, 8.0);
      const research800 = await inspectSurfaceMetrics(page, profile.dpr);
      assert.ok(research800.maxPhysStretch <= 1.02, `${profile.name} Research Space 800%: expected physStretch <= 1.02, got ${research800.maxPhysStretch}`);
      await page.evaluate(() => {
        window.populated.engine().setProperties({ extraLeft: 0, extraTop: 0, extraRight: 0, extraBottom: 0 });
      });
      await frames(page, 12);

      // Multi-layer (L=2) at 100% zoom.
      await setExactZoom(page, 1.0);
      await page.evaluate(() => {
        window.populated.engine().layers.create('Layer 2');
      });
      await frames(page, 15);
      const multiLayer100 = await inspectSurfaceMetrics(page, profile.dpr);
      assert.equal(multiLayer100.layerCount, 2, `${profile.name}: expected 2 presentation layer canvases`);
      assert.ok(multiLayer100.maxPhysStretch <= 1.02, `${profile.name} 2-layer 100%: expected physStretch <= 1.02, got ${multiLayer100.maxPhysStretch}`);

      // 3. 800% pan rebase + lasso move on clean bottom-right A4 region (x: 705..755, y: 1030..1075).
      await setExactZoom(page, 8.0);
      // Scroll to bottom-right blank corner of Page 1.
      const rebaseStats = await page.evaluate(async () => {
        const engine = window.populated.engine();
        const scroller = document.querySelector('.notebook-viewport');
        const originBefore = engine.viewport.getRenderWindowOrigin();
        const pageRoot = document.querySelector('[data-page-index="0"]');
        const pageTop = pageRoot ? pageRoot.offsetTop : 0;
        const scale = engine.viewport.getState().scale;
        scroller.scrollLeft = Math.max(0, 725 * scale - scroller.clientWidth / 2);
        scroller.scrollTop = Math.max(0, (pageTop + 1052) * scale - scroller.clientHeight / 2);
        await new Promise(resolve => setTimeout(resolve, 120));
        for (let i = 0; i < 12; i += 1) await new Promise(requestAnimationFrame);
        const originAfter = engine.viewport.getRenderWindowOrigin();
        return { originBefore, originAfter };
      });
      assert.ok(
        rebaseStats.originAfter.x !== rebaseStats.originBefore.x || rebaseStats.originAfter.y !== rebaseStats.originBefore.y,
        `${profile.name}: expected 800% pan beyond overscan to rebase render window origin`,
      );
      const postPan800 = await inspectSurfaceMetrics(page, profile.dpr);
      assert.ok(postPan800.maxPhysStretch <= 1.02, `${profile.name} 800% after pan rebase: expected physStretch <= 1.02, got ${postPan800.maxPhysStretch}`);

      // Draw pure red stroke in the center of the panned 800% view, verify pixels, lasso move (+36, +24 CSS px), verify destination & zero origin ghosting.
      const lassoCheck = await page.evaluate(async () => {
        const engine = window.populated.engine();
        engine.tools.setMode('draw');
        engine.tools.setDrawingTool('pen');
        engine.tools.setColor('#ef4444');
        engine.tools.setThickness(2);
        engine.tools.setOpacity(1);
        const canvas = engine.drawing.getCanvasElement();
        const vr = document.querySelector('.notebook-viewport').getBoundingClientRect();
        const cx = vr.left + vr.width / 2;
        const cy = vr.top + vr.height / 2;
        const dx = 56;
        const dy = 48;

        canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 601, pointerType: 'mouse', button: 0, buttons: 1, clientX: cx - 22, clientY: cy - 12 }));
        for (let s = 1; s <= 5; s += 1) {
          canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 601, pointerType: 'mouse', buttons: 1, clientX: cx - 22 + s * 7, clientY: cy - 12 }));
        }
        canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 601, pointerType: 'mouse', button: 0, buttons: 0, clientX: cx + 13, clientY: cy - 12 }));
        for (let i = 0; i < 6; i += 1) await new Promise(requestAnimationFrame);

        const countRedAt = (clientX, clientY) => {
          const layer = engine.drawing.getActiveLayerCanvasElement();
          const rect = layer.getBoundingClientRect();
          const px = Math.round(((clientX - rect.left) / rect.width) * layer.width);
          const py = Math.round(((clientY - rect.top) / rect.height) * layer.height);
          const half = 18;
          const x0 = Math.max(0, px - half);
          const y0 = Math.max(0, py - half);
          const w = Math.min(layer.width - x0, half * 2 + 1);
          const h = Math.min(layer.height - y0, half * 2 + 1);
          if (w <= 0 || h <= 0) return 0;
          const data = layer.getContext('2d').getImageData(x0, y0, w, h).data;
          let count = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 180 && data[i + 1] < 110 && data[i + 2] < 110 && data[i + 3] > 80) count++;
          }
          return count;
        };

        const beforeOriginRed = countRedAt(cx - 4, cy - 12);

        // Select & drag move by (+dx, +dy) using lasso enclosure around the drawn stroke.
        engine.tools.setMode('select');
        const lassoCorners = [
          [cx - 38, cy - 28],
          [cx + 30, cy - 28],
          [cx + 30, cy + 4],
          [cx - 38, cy + 4],
          [cx - 38, cy - 28],
        ];
        canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 602, pointerType: 'mouse', button: 0, buttons: 1, clientX: lassoCorners[0][0], clientY: lassoCorners[0][1] }));
        for (let i = 1; i < lassoCorners.length; i += 1) {
          canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 602, pointerType: 'mouse', buttons: 1, clientX: lassoCorners[i][0], clientY: lassoCorners[i][1] }));
        }
        canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 602, pointerType: 'mouse', button: 0, buttons: 0, clientX: lassoCorners[lassoCorners.length - 1][0], clientY: lassoCorners[lassoCorners.length - 1][1] }));
        for (let i = 0; i < 6; i += 1) await new Promise(requestAnimationFrame);

        // Drag selected stroke from (cx - 4, cy - 12) by (+dx, +dy).
        canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 603, pointerType: 'mouse', button: 0, buttons: 1, clientX: cx - 4, clientY: cy - 12 }));
        for (let s = 1; s <= 4; s += 1) {
          await new Promise(requestAnimationFrame);
          canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 603, pointerType: 'mouse', buttons: 1, clientX: cx - 4 + (dx * s) / 4, clientY: cy - 12 + (dy * s) / 4 }));
        }
        canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 603, pointerType: 'mouse', button: 0, buttons: 0, clientX: cx - 4 + dx, clientY: cy - 12 + dy }));
        for (let i = 0; i < 8; i += 1) await new Promise(requestAnimationFrame);

        const afterOriginRed = countRedAt(cx - 4, cy - 12);
        const afterDestRed = countRedAt(cx - 4 + dx, cy - 12 + dy);
        // Also confirm overview backdrop has 0 move afterimage at origin and matches destination.
        // At 800% zoom, 1 overview pixel = 8 CSS px, so half=2 (~16 CSS px radius) matches countRedAt without overlapping the moved destination (+6 overview px).
        const countOverviewRedAt = (clientX, clientY) => {
          const ov = document.querySelector('canvas[data-panvas-overview-backdrop]');
          if (!ov) return -1;
          const rect = ov.getBoundingClientRect();
          const px = Math.round(((clientX - rect.left) / rect.width) * ov.width);
          const py = Math.round(((clientY - rect.top) / rect.height) * ov.height);
          const half = 2;
          const x0 = Math.max(0, px - half);
          const y0 = Math.max(0, py - half);
          const w = Math.min(ov.width - x0, half * 2 + 1);
          const h = Math.min(ov.height - y0, half * 2 + 1);
          if (w <= 0 || h <= 0) return 0;
          const data = ov.getContext('2d').getImageData(x0, y0, w, h).data;
          let count = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 180 && data[i + 1] < 110 && data[i + 2] < 110 && data[i + 3] > 80) count++;
          }
          return count;
        };
        const overviewOriginRed = countOverviewRedAt(cx - 4, cy - 12);
        const overviewDestRed = countOverviewRedAt(cx - 4 + dx, cy - 12 + dy);
        return { beforeOriginRed, afterOriginRed, afterDestRed, overviewOriginRed, overviewDestRed };
      });
      assert.ok(lassoCheck.beforeOriginRed > 20, `${profile.name}: expected red stroke pixels at draw origin (got ${lassoCheck.beforeOriginRed})`);
      assert.equal(lassoCheck.afterOriginRed, 0, `${profile.name}: expected 0 ghost pixels at origin after lasso move (got ${lassoCheck.afterOriginRed})`);
      assert.ok(lassoCheck.afterDestRed > 20, `${profile.name}: expected moved red stroke pixels at destination (got ${lassoCheck.afterDestRed})`);
      assert.equal(lassoCheck.overviewOriginRed, 0, `${profile.name}: expected 0 overview ghost pixels at origin after lasso move (got ${lassoCheck.overviewOriginRed})`);
      assert.ok(lassoCheck.overviewDestRed > 0, `${profile.name}: expected moved red stroke pixels in overview at destination (got ${lassoCheck.overviewDestRed})`);

      // 4. Task 2: Hole-punched 1x overview backdrop + zero-blank rapid 800%->100% zoom-out + zero lasso afterimage in overview.
      const rapidZoomOutCheck = await page.evaluate(async () => {
        const engine = window.populated.engine();
        const scroller = document.querySelector('.notebook-viewport');
        // Pan to center of Page 1 at 800% so surrounding outer quadrants have populated strokes
        const pageRoot = document.querySelector('[data-page-index="0"]');
        const pageTop = pageRoot ? pageRoot.offsetTop : 0;
        const scale = engine.viewport.getState().scale;
        scroller.scrollLeft = Math.max(0, 397 * scale - scroller.clientWidth / 2);
        scroller.scrollTop = Math.max(0, (pageTop + 560) * scale - scroller.clientHeight / 2);
        await new Promise(resolve => setTimeout(resolve, 140));
        for (let i = 0; i < 8; i += 1) await new Promise(requestAnimationFrame);

        const overview = document.querySelector('canvas[data-panvas-overview-backdrop]');
        if (!overview) return { presentAt800: false };
        const clipPathAt800 = overview.style.clipPath || '';
        const overviewPixels = overview.width * overview.height;
        const liveLayer = engine.drawing.getActiveLayerCanvasElement();
        const holeLeft = parseFloat(liveLayer?.style.left || '0') || 0;
        const holeTop = parseFloat(liveLayer?.style.top || '0') || 0;
        const holeW = parseFloat(liveLayer?.style.width || '0') || 0;
        const holeH = parseFloat(liveLayer?.style.height || '0') || 0;
        const pageCssW = parseFloat(overview.style.width || String(overview.width)) || overview.width;
        const pageCssH = parseFloat(overview.style.height || String(overview.height)) || overview.height;

        // Dispatch rapid zoom-out wheel burst (800% -> ~100%)
        const vr = scroller.getBoundingClientRect();
        const cx = vr.left + vr.width / 2;
        const cy = vr.top + vr.height / 2;
        const burstStarted = performance.now();
        for (let i = 0; i < 22; i += 1) {
          scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 120, clientX: cx, clientY: cy }));
        }
        // Sample within <50ms BEFORE the 85ms rebase settle timer fires
        await new Promise(requestAnimationFrame);
        const preSettleElapsedMs = performance.now() - burstStarted;
        const preSettleScale = engine.viewport.getState().scale;
        const preSettleOverview = document.querySelector('canvas[data-panvas-overview-backdrop]');
        const preSettleLive = engine.drawing.getActiveLayerCanvasElement();
        let quadrantsNonEmpty = { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 };
        if (preSettleOverview) {
          const ctx = preSettleOverview.getContext('2d');
          const sx = preSettleOverview.width / pageCssW;
          const sy = preSettleOverview.height / pageCssH;
          const sampleRegion = (x0, y0, x1, y1) => {
            const rx = Math.max(0, Math.floor(x0 * sx));
            const ry = Math.max(0, Math.floor(y0 * sy));
            const rw = Math.max(1, Math.min(preSettleOverview.width - rx, Math.ceil((x1 - x0) * sx)));
            const rh = Math.max(1, Math.min(preSettleOverview.height - ry, Math.ceil((y1 - y0) * sy)));
            if (rw <= 0 || rh <= 0) return 0;
            const d = ctx.getImageData(rx, ry, rw, rh).data;
            let count = 0;
            for (let k = 3; k < d.length; k += 4) if (d[k] > 10) count++;
            return count;
          };
          quadrantsNonEmpty = {
            topLeft: sampleRegion(30, 30, Math.max(40, holeLeft), Math.max(40, holeTop)),
            topRight: sampleRegion(Math.min(pageCssW - 40, holeLeft + holeW), 30, pageCssW - 30, Math.max(40, holeTop)),
            bottomLeft: sampleRegion(30, Math.min(pageCssH - 40, holeTop + holeH), Math.max(40, holeLeft), pageCssH - 30),
            bottomRight: sampleRegion(Math.min(pageCssW - 40, holeLeft + holeW), Math.min(pageCssH - 40, holeTop + holeH), pageCssW - 30, pageCssH - 30),
          };
        }
        const holeRectCoversWindow = holeW > 0 && holeH > 0 && Boolean(preSettleLive);

        // Wait for settle back to ~100% and verify overview canvas is freed (0 extra VRAM)
        await new Promise(resolve => setTimeout(resolve, 200));
        for (let i = 0; i < 6; i += 1) await new Promise(requestAnimationFrame);
        const postSettleOverviewCount = document.querySelectorAll('canvas[data-panvas-overview-backdrop]').length;
        return {
          presentAt800: true,
          clipPathAt800,
          overviewPixels,
          preSettleElapsedMs,
          preSettleScale,
          preSettlePresent: Boolean(preSettleOverview),
          quadrantsNonEmpty,
          holeRectCoversWindow,
          postSettleOverviewCount,
          settledScale: engine.viewport.getState().scale,
        };
      });
      assert.equal(rapidZoomOutCheck.presentAt800, true, `${profile.name}: expected overview backdrop canvas at 800%`);
      assert.match(rapidZoomOutCheck.clipPathAt800, /evenodd/, `${profile.name}: overview clipPath must hole-punch with evenodd`);
      assert.ok(rapidZoomOutCheck.overviewPixels <= 2_000_000, `${profile.name}: overview pixel count ${rapidZoomOutCheck.overviewPixels} exceeds 2M`);
      assert.equal(rapidZoomOutCheck.preSettlePresent, true, `${profile.name}: overview canvas must stay visible pre-settle during rapid zoom-out`);
      assert.ok(rapidZoomOutCheck.preSettleElapsedMs < 50, `${profile.name}: pre-settle sample took ${rapidZoomOutCheck.preSettleElapsedMs}ms`);
      assert.ok(rapidZoomOutCheck.holeRectCoversWindow, `${profile.name}: expected valid live hole rect`);
      for (const [qName, count] of Object.entries(rapidZoomOutCheck.quadrantsNonEmpty)) {
        assert.ok(count > 0, `${profile.name}: pre-settle outer quadrant ${qName} was blank (0 ink pixels) during rapid 800%->100% zoom-out`);
      }
      assert.equal(rapidZoomOutCheck.postSettleOverviewCount, 0, `${profile.name}: overview canvas must unmount once settled back at 100%`);

      assert.deepEqual(errors, [], `${profile.name}: expected zero page errors`);

      const summary = {
        profile: profile.name,
        dpr: profile.dpr,
        legs: { leg100to418, leg418to800, leg800to100 },
        sharpness: {
          regular800: { dims: regular800.activeLayer, physStretch: regular800.maxPhysStretch, vramMiB: regular800.vramMiB, basePixels: regular800.basePixels },
          wetMidStroke: { dims: { width: wetMidStroke.wetMetric.width, height: wetMidStroke.wetMetric.height }, physStretch: wetMidStroke.wetMetric.physStretch, totalVramMiB: wetMidStroke.vramWithWetMiB, latency: wetLatencyStats },
          doc800: { dims: doc800.activeLayer, physStretch: doc800.maxPhysStretch, vramMiB: doc800.vramMiB },
          research800: { dims: research800.activeLayer, physStretch: research800.maxPhysStretch, vramMiB: research800.vramMiB },
          multiLayer100: { layerCount: multiLayer100.layerCount, physStretch: multiLayer100.maxPhysStretch, vramMiB: multiLayer100.vramMiB },
          postPan800: { originBefore: rebaseStats.originBefore, originAfter: rebaseStats.originAfter, physStretch: postPan800.maxPhysStretch },
        },
        lassoCheck,
      };
      allResults.push(summary);
      console.log(JSON.stringify(summary));
    } finally {
      await close();
    }
  }

  await writeFile(
    path.join(outDir, `${electronMode ? 'electron' : 'chromium'}-results.json`),
    JSON.stringify(allResults, null, 2),
  );
  console.log(`PASS: performance-phase-a-browser (${electronMode ? 'electron' : 'chromium'})`);
} finally {
  if (electronApp) await electronApp.close().catch(() => {});
  if (electronTempDir) await rm(electronTempDir, { recursive: true, force: true }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await server.close();
}
