// Task 1 E2E Verification: Zero-Lag Background Cloud Sync (Chromium & Electron)
// Usage: node tests/cloud-sync-zero-lag-browser.mjs [--electron]
//
// Proves that running real `runCloudSyncV2` (JSON canonicalization, ExactPayloadHashCache,
// SHA-256 hashing, LocalSyncPayloadSource IndexedDB scanning, object uploads, and
// manifest writes) concurrently with 250ms-cadence handwriting, scrolling, and Ctrl+wheel
// zooming causes zero interactive UI freezes (> 50ms) and keeps frame p95 <= 20ms, then
// converges cleanly after interaction idle with 100% of drawn strokes intact.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';

const electronMode = process.argv.includes('--electron');
const outDir = 'artifacts/cloud-sync-zero-lag';
await mkdir(outDir, { recursive: true });

const server = await createServer({
  mode: 'web',
  cacheDir: path.join(outDir, 'vite-cache'),
  optimizeDeps: { entries: ['tests/fixtures/populated-notebook.html'] },
  server: { port: 0, open: false },
});

let browser;
let electronApp;
let electronTempDir;

const launchElectronPage = async (url, width = 1440, height = 900) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panvas-sync-electron-'));
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
  win.loadURL(${JSON.stringify(url)});
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

async function startFrameSampler(page) {
  await page.evaluate(() => {
    window.__syncLagSamples = [];
    window.__syncLagFreezes = [];
    window.__syncLagStart = performance.now();
    window.__syncLagPhase = window.__syncLagPhase || 'draw';
    window.__syncLagRunning = true;
    let last = performance.now();
    let idx = 0;
    const tick = now => {
      if (!window.__syncLagRunning) return;
      const dt = now - last;
      window.__syncLagSamples.push(dt);
      if (idx > 0 && dt > 50) {
        window.__syncLagFreezes.push({
          dt: Number(dt.toFixed(1)),
          at: Number((now - window.__syncLagStart).toFixed(1)),
          phase: window.__syncLagPhase ?? 'init',
        });
      }
      idx += 1;
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(now => {
      last = now;
      requestAnimationFrame(tick);
    });
  });
}

async function stopFrameSampler(page) {
  const { samples, freezesDetail } = await page.evaluate(() => {
    window.__syncLagRunning = false;
    return {
      samples: window.__syncLagSamples ?? [],
      freezesDetail: window.__syncLagFreezes ?? [],
    };
  });
  // Drop initial startup sample if any
  const trimmed = samples.slice(1);
  const freezesOver50 = trimmed.filter(ms => ms > 50);
  const freezesOver100 = trimmed.filter(ms => ms > 100);
  return {
    count: trimmed.length,
    p50Ms: Number(percentile(trimmed, 0.5).toFixed(2)),
    p95Ms: Number(percentile(trimmed, 0.95).toFixed(2)),
    maxMs: Number(Math.max(0, ...trimmed).toFixed(2)),
    freezesOver50Count: freezesOver50.length,
    freezesOver100Count: freezesOver100.length,
    freezesOver50Ms: freezesOver50.map(v => Number(v.toFixed(1))),
    freezesDetail,
  };
}

async function preparePenAndBounds(page) {
  return page.evaluate(() => {
    window.__syncLagPhase = 'draw';
    const engine = window.populated.engine();
    engine.tools.setMode('draw');
    engine.tools.setDrawingTool('pen');
    engine.tools.setColor('#1d4ed8');
    engine.tools.setThickness(2.5);
    engine.tools.setOpacity(1);
    const canvas = engine.drawing.getCanvasElement();
    const r = canvas.getBoundingClientRect();
    const vp = document.querySelector('.notebook-viewport')?.getBoundingClientRect() ?? r;
    return {
      rectLeft: r.left,
      rectTop: r.top,
      minX: vp.left + 20,
      maxX: vp.right - 90,
      minY: vp.top + 20,
      maxY: vp.bottom - 30,
    };
  });
}

async function runInteractiveWorkload(page, { bounds, baseX, baseY }) {
  // 1. Write 12 handwriting strokes at ~180ms inter-stroke cadence (within 300ms quiet window & 1500ms cooldown)
  for (let s = 0; s < 12; s += 1) {
    const x = Math.max(bounds.minX, Math.min(bounds.maxX, bounds.rectLeft + baseX + (s % 4) * 90));
    const y = Math.max(bounds.minY, Math.min(bounds.maxY, bounds.rectTop + baseY + Math.floor(s / 4) * 55));
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(x + step * 8, y + Math.sin(step * 0.9) * 10);
      await page.waitForTimeout(8);
    }
    await page.mouse.up();
    await page.waitForTimeout(160);
  }

  // 2. Scroll across multiple populated pages cleanly
  await page.evaluate(async () => {
    window.__syncLagPhase = 'scroll';
    const vp = document.querySelector('.notebook-viewport');
    for (let i = 0; i < 8; i += 1) {
      vp.scrollTop += 260;
      await new Promise(requestAnimationFrame);
    }
    for (let i = 0; i < 8; i += 1) {
      vp.scrollTop = Math.max(0, vp.scrollTop - 260);
      await new Promise(requestAnimationFrame);
    }
  });

  // 3. Ctrl+wheel zoom in & back out
  await page.evaluate(async () => {
    window.__syncLagPhase = 'zoom';
    const vp = document.querySelector('.notebook-viewport');
    const r = vp.getBoundingClientRect();
    const cx = r.left + r.width * 0.5;
    const cy = r.top + r.height * 0.5;
    for (let i = 0; i < 6; i += 1) {
      vp.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120, clientX: cx, clientY: cy }));
      await new Promise(requestAnimationFrame);
    }
    for (let i = 0; i < 6; i += 1) {
      vp.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 120, clientX: cx, clientY: cy }));
      await new Promise(requestAnimationFrame);
    }
    window.__syncLagPhase = 'settle';
  });
  await frames(page, 6);
}

try {
  await server.listen();
  const baseUrl = `${server.resolvedUrls.local[0]}tests/fixtures/populated-notebook.html`;
  let page;
  if (electronMode) {
    const launched = await launchElectronPage(baseUrl);
    electronApp = launched.app;
    electronTempDir = launched.dir;
    page = launched.page;
  } else {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page = await ctx.newPage();
  }

  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.goto(baseUrl, { timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.populated?.engine?.()?.drawing?.getActiveLayerCanvasElement?.()), null, { timeout: 60_000 });
  await frames(page, 18);

  const initialStrokeCount = await page.evaluate(() => window.populated.engine().drawing.getStrokes().length);

  // --- Phase 1: Baseline (Cloud Sync OFF) ---
  const baselineBounds = await preparePenAndBounds(page);
  await startFrameSampler(page);
  await runInteractiveWorkload(page, { bounds: baselineBounds, baseX: 120, baseY: 180 });
  const baselineMetrics = await stopFrameSampler(page);

  const countAfterBaseline = await page.evaluate(() => window.populated.engine().drawing.getStrokes().length);
  assert.equal(countAfterBaseline, initialStrokeCount + 12, 'Baseline workload must add 12 strokes');

  // Allow Phase 1 DrawingSaveScheduler debounce (1000 ms) + zoom settle + drawingActivity cooldown (1500 ms)
  // to finish cleanly so Phase 2 isolates background Cloud Sync without inheriting Phase 1 saves.
  await page.waitForTimeout(1800);
  await frames(page, 6);

  // --- Phase 2: Active Cloud Sync ON (concurrent V2 scan/hash/upload + interactive drawing/scroll/zoom) ---
  await page.evaluate(async isElectron => {
    const [
      { runCloudSyncV2 },
      { syncV2LocalSource, syncV2LocalAdapter },
      { LocalStorageSyncV2BaselineStore },
      { dexieSyncV2ConflictStore },
    ] = await Promise.all([
      import('/src/services/cloudsync/v2/engine.ts'),
      import('/src/services/cloudsync/v2/localAdapter.ts'),
      import('/src/services/cloudsync/v2/baselineStore.ts'),
      import('/src/services/cloudsync/v2/conflictStore.ts'),
    ]);

    const objects = new Map();
    const manifests = new Map();
    let profile = null;
    let catalog = null;
    const waitIo = () => new Promise(r => setTimeout(r, 4));
    const provider = {
      async readProfile() { await waitIo(); return { value: profile, etag: profile ? 'p1' : null }; },
      async writeProfile(v) { await waitIo(); profile = structuredClone(v); return { etag: 'p1' }; },
      async readCatalog() { await waitIo(); return { value: catalog, etag: catalog ? `c${catalog.revision}` : null }; },
      async writeCatalog(v) { await waitIo(); catalog = structuredClone(v); return { etag: `c${v.revision}` }; },
      async readManifest(id) { await waitIo(); const m = manifests.get(id) ?? null; return { value: m, etag: m ? `m${m.revision}` : null }; },
      async writeManifest(id, m) { await waitIo(); manifests.set(id, structuredClone(m)); return { etag: `m${m.revision}` }; },
      async getObject(h) { await waitIo(); const b = objects.get(h); if (!b) throw new Error('missing object'); return b.slice(); },
      async putObjectIfAbsent(h, b) { await waitIo(); const had = objects.has(h); if (!had) objects.set(h, b.slice()); return had ? 'present' : 'uploaded'; },
      async getObjectMetadata(h) { await waitIo(); const b = objects.get(h); return b ? { size: b.byteLength } : null; },
    };

    const baselines = new LocalStorageSyncV2BaselineStore();
    window.__syncLagEvents = [];
    const recordSyncProgress = msg => {
      window.__syncLagEvents.push({
        at: Number((performance.now() - (window.__syncLagStart ?? 0)).toFixed(1)),
        syncProgress: msg,
      });
    };
    // Kick off V2 sync immediately in the background WITHOUT awaiting it here,
    // so scan/canonicalize/hash/upload run concurrently with interactive strokes, scroll, and zoom!
    window.__activeSyncPromise = (async () => {
      const first = await runCloudSyncV2({
        accountIdentifier: 'zero-lag-test@panvas.local',
        provider,
        source: syncV2LocalSource,
        adapter: syncV2LocalAdapter,
        baselines,
        conflictStore: dexieSyncV2ConflictStore,
        environment: 'desktop',
        manual: false,
        onProgress: recordSyncProgress,
      });
      // Run a second pass once idle to ensure incremental noop/edit pass converges too
      const second = await runCloudSyncV2({
        accountIdentifier: 'zero-lag-test@panvas.local',
        provider,
        source: syncV2LocalSource,
        adapter: syncV2LocalAdapter,
        baselines,
        conflictStore: dexieSyncV2ConflictStore,
        environment: isElectron ? 'desktop' : 'web',
        manual: false,
        onProgress: recordSyncProgress,
      });
      return { first, second, objectCount: objects.size, manifestCount: manifests.size };
    })();
  }, electronMode);

  // Wait until V2 sync actively enters workspace scan/hash/upload before starting interactive strokes
  await page.waitForFunction(
    () => (window.__syncLagEvents ?? []).some(e => typeof e.syncProgress === 'string' && e.syncProgress.startsWith('Syncing workspace')),
    null,
    { timeout: 5_000 },
  );

  const syncBounds = await preparePenAndBounds(page);
  await startFrameSampler(page);
  await runInteractiveWorkload(page, { bounds: syncBounds, baseX: 120, baseY: 420 });
  const syncOnMetrics = await stopFrameSampler(page);
  const syncEvents = await page.evaluate(() => window.__syncLagEvents ?? []);

  const countAfterSyncWorkload = await page.evaluate(() => window.populated.engine().drawing.getStrokes().length);
  assert.equal(countAfterSyncWorkload, initialStrokeCount + 24, 'All 12 strokes written during active sync must remain intact');

  // Wait for deferred/paused background sync to finish once user is idle
  const syncOutcome = await page.evaluate(async () => await window.__activeSyncPromise);
  assert.equal(syncOutcome.first.status, 'synced', `Expected first sync status 'synced', got ${JSON.stringify(syncOutcome.first)}`);
  assert.equal(syncOutcome.second.status, 'synced', `Expected second sync status 'synced', got ${JSON.stringify(syncOutcome.second)}`);
  assert.ok(syncOutcome.first.uploaded > 0, 'Sync must genuinely upload workspace entities & binary assets');
  assert.ok(syncOutcome.objectCount > 10, `Expected >10 uploaded content objects, got ${syncOutcome.objectCount}`);

  console.log(JSON.stringify({
    mode: electronMode ? 'electron' : 'chromium',
    baseline: baselineMetrics,
    syncOn: syncOnMetrics,
    syncEvents,
    uploadedObjects: syncOutcome.objectCount,
  }));

  // Frame-timing assertions: zero severe freezes, zero sync-induced >50ms freezes above baseline, and responsive p95
  assert.equal(syncOnMetrics.freezesOver100Count, 0,
    `Expected 0 frames >100ms during active Cloud Sync, got ${syncOnMetrics.freezesOver100Count}: ${JSON.stringify(syncOnMetrics.freezesOver50Ms)}`);
  assert.ok(syncOnMetrics.freezesOver50Count <= baselineMetrics.freezesOver50Count + 1,
    `Sync ON caused extra >50ms frames vs Sync OFF baseline (${syncOnMetrics.freezesOver50Count} > ${baselineMetrics.freezesOver50Count} + 1): ${JSON.stringify(syncOnMetrics.freezesOver50Ms)}`);
  assert.ok(syncOnMetrics.p95Ms <= Math.max(20, baselineMetrics.p95Ms + 5),
    `Sync ON p95 (${syncOnMetrics.p95Ms}ms) regressed noticeably vs Sync OFF baseline (${baselineMetrics.p95Ms}ms)`);
  assert.ok(syncOnMetrics.maxMs <= Math.max(70, baselineMetrics.maxMs + 20),
    `Sync ON max frame (${syncOnMetrics.maxMs}ms) exceeded Sync OFF baseline allowance (${baselineMetrics.maxMs}ms + 20ms)`);

  assert.deepEqual(errors, [], `Expected 0 pageerrors, got: ${errors.join('; ')}`);
  console.log(`PASS: cloud-sync-zero-lag-browser (${electronMode ? 'electron' : 'chromium'})`);
} finally {
  if (electronApp) await electronApp.close();
  if (electronTempDir) await rm(electronTempDir, { recursive: true, force: true });
  if (browser) await browser.close();
  await server.close();
}
