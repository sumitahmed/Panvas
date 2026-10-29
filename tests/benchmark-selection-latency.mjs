import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'panvas-selection-bench-'));
let server, browser, page, session;

async function frames(n = 3) {
  await page.evaluate(async n => {
    for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
  }, n);
}

try {
  // Start preview server using built dist/
  server = await preview({
    configFile: false,
    build: { outDir: path.resolve('dist') },
    preview: { port: 0, open: false },
  });

  browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
  });

  page = await browser.newPage({ viewport: { width: 1580, height: 1062 } });
  await page.goto(new URL('/app', server.resolvedUrls.local[0]).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  page.setDefaultTimeout(60000);

  // Dismiss welcome/continue locally if needed
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
  const local = page.getByRole('button', { name: 'Continue locally', exact: true });
  if (await local.isVisible()) await local.click({ force: true });

  // Create notebook
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'New Notebook', exact: true }).click();
  await page.locator('#create-dialog-input').fill('Selection Benchmark');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('#create-dialog-input').waitFor({ state: 'hidden' });

  // Open notebook
  const row = page.getByRole('complementary').getByText('Selection Benchmark', { exact: true });
  if (!await row.isVisible()) {
    const toggle = page.getByRole('button', { name: 'Show library', exact: true });
    if (await toggle.isVisible()) await toggle.click();
  }
  await row.click();
  await frames(5);

  // Seed 1,200 strokes (96 points each)
  const seed = await page.evaluate(async () => {
    const engine = window.__PANVAS_GATE0_ENGINE__;
    const pageId = engine.getDrawingOwnership().pageId;
    const data = structuredClone(engine.getDrawingData());
    data.objects = Array.from({ length: 1200 }, (_, i) => ({
      id: `${pageId}-ink-${i}`,
      type: 'stroke',
      tool: 'pen',
      centerline: 'polyline',
      color: ['#1d4ed8', '#047857'][i % 2],
      thickness: 2,
      opacity: 1,
      createdAt: i,
      points: Array.from({ length: 96 }, (_, j) => ({
        x: 35 + (i % 8) * 84 + j * 0.62,
        y: 40 + Math.floor(i / 8) * 6.5 + Math.sin(j * 0.31 + i) * 3,
        pressure: 0.3 + (j % 20) / 40,
        t: j * 4,
      })),
    }));

    await new Promise((resolve, reject) => {
      const request = indexedDB.open('panvas');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['notebookPageDrawings'], 'readwrite');
        const store = tx.objectStore('notebookPageDrawings');
        store.put({ pageId, id: pageId, data });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    return { pageId };
  });

  // Reload page to load the 1,200 strokes into the engine
  await page.reload();
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
  const row2 = page.getByRole('complementary').getByText('Selection Benchmark', { exact: true });
  if (!await row2.isVisible()) {
    const toggle = page.getByRole('button', { name: 'Show library', exact: true });
    if (await toggle.isVisible()) await toggle.click();
  }
  await row2.click();
  await frames(8);

  const strokeCount = await page.evaluate(() => window.__PANVAS_GATE0_ENGINE__.drawing.getStrokes().length);
  console.log(`[BENCHMARK SETUP] Loaded ${strokeCount} strokes (96 points each) on active page`);
  assert.equal(strokeCount, 1200);

  // Switch to Select tool (V)
  const selectBtn = page.getByTitle('Select (V)', { exact: true });
  if (await selectBtn.isVisible()) {
    await selectBtn.click();
    await frames(3);
  }

  session = await page.context().newCDPSession(page);

  // Helper to measure in-browser performance
  const runProfile = async (slow = false) => {
    if (slow) await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    else await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    const results = await page.evaluate(async () => {
      const engine = window.__PANVAS_GATE0_ENGINE__;
      const strokes = engine.drawing.getStrokes();
      const canvas = engine.drawing.getCanvasElement();
      const r = canvas.getBoundingClientRect();

      const getClientPoint = (pagePt) => {
        const p = engine.viewport.pageToCanvas(pagePt.x, pagePt.y);
        return {
          x: r.left + p.x * r.width / canvas.clientWidth,
          y: r.top + p.y * r.height / canvas.clientHeight,
        };
      };

      const out = {};

      // 1. Single click selection latency
      const targetStroke = strokes[600]; // middle stroke
      const midPt = targetStroke.points[48];
      engine.selection.clearSelection();

      const t0 = performance.now();
      const hit = engine.selection.selectAt(midPt.x, midPt.y, false);
      const selectAtTime = performance.now() - t0;
      out.selectAtSingleMs = selectAtTime;
      out.singleSelected = engine.selection.getSelectedElements().length;

      // 2. Repeated selection changes across 10 different strokes
      const repeatTimes = [];
      for (let k = 100; k < 200; k += 10) {
        const s = strokes[k];
        const pt = s.points[48];
        const tStart = performance.now();
        engine.selection.selectAt(pt.x, pt.y, false);
        repeatTimes.push(performance.now() - tStart);
      }
      out.repeatSelectAtAvgMs = repeatTimes.reduce((a, b) => a + b, 0) / repeatTimes.length;
      out.repeatSelectAtMaxMs = Math.max(...repeatTimes);

      // 3. Hovering around selection handles (100 hover checks with 1 stroke selected, and with 50 strokes selected)
      const hoverSingleTimes = [];
      for (let i = 0; i < 100; i++) {
        const hx = midPt.x + (i % 20) - 10;
        const hy = midPt.y + Math.floor(i / 20) - 10;
        const ht0 = performance.now();
        engine.selection.getHandleAt(hx, hy);
        hoverSingleTimes.push(performance.now() - ht0);
      }
      out.hoverHandleSingleAvgMs = hoverSingleTimes.reduce((a, b) => a + b, 0) / hoverSingleTimes.length;
      out.hoverHandleSingleMaxMs = Math.max(...hoverSingleTimes);

      // Now select 50 strokes (multi-selection)
      for (let k = 500; k < 550; k++) {
        engine.selection.select(strokes[k].id, 'stroke', true);
      }
      out.multiCount = engine.selection.getSelectedElements().length;

      const hoverMultiTimes = [];
      for (let i = 0; i < 100; i++) {
        const hx = midPt.x + (i % 20) - 10;
        const hy = midPt.y + Math.floor(i / 20) - 10;
        const ht0 = performance.now();
        engine.selection.getHandleAt(hx, hy);
        hoverMultiTimes.push(performance.now() - ht0);
      }
      out.hoverHandleMultiAvgMs = hoverMultiTimes.reduce((a, b) => a + b, 0) / hoverMultiTimes.length;
      out.hoverHandleMultiMaxMs = Math.max(...hoverMultiTimes);

      // 4. Hit test on dense canvas (topHit lookup)
      const hitTestTimes = [];
      for (let i = 0; i < 20; i++) {
        const testPt = strokes[i * 50].points[20];
        const ht0 = performance.now();
        engine.selection.hitTest(testPt.x, testPt.y);
        hitTestTimes.push(performance.now() - ht0);
      }
      out.hitTestAvgMs = hitTestTimes.reduce((a, b) => a + b, 0) / hitTestTimes.length;
      out.hitTestMaxMs = Math.max(...hitTestTimes);

      // 5. Empty canvas hit test (miss path when starting lasso)
      const missTimes = [];
      for (let i = 0; i < 20; i++) {
        const ht0 = performance.now();
        engine.selection.hitTest(9999, 9999);
        missTimes.push(performance.now() - ht0);
      }
      out.hitTestMissAvgMs = missTimes.reduce((a, b) => a + b, 0) / missTimes.length;

      // 6. Lasso simulation (selectWithinLoop enclosing ~80 strokes)
      const lassoLoop = [
        { x: 30, y: 35 },
        { x: 700, y: 35 },
        { x: 700, y: 200 },
        { x: 30, y: 200 },
      ];
      const lt0 = performance.now();
      const enclosedCount = engine.selection.selectWithinLoop(lassoLoop);
      out.selectWithinLoopMs = performance.now() - lt0;
      out.enclosedCount = enclosedCount;

      // 7. Lasso render frame time (renderLasso during active lasso drag with 50 points)
      const lassoPoints = Array.from({ length: 50 }, (_, i) => ({ x: 30 + i * 10, y: 30 + Math.sin(i) * 20 }));
      engine.drawing.startLasso();
      const lr0 = performance.now();
      engine.drawing.renderLasso(lassoPoints);
      out.renderLassoActiveMs = performance.now() - lr0;
      engine.drawing.endLasso();

      // 8. Deselecting
      const dt0 = performance.now();
      engine.selection.clearSelection();
      out.clearSelectionMs = performance.now() - dt0;

      return out;
    });

    return results;
  };

  console.log('\n--- BASELINE MEASUREMENTS (NORMAL 1x) ---');
  for (let r = 1; r <= 3; r++) {
    const res = await runProfile(false);
    console.log(`Run ${r}:`, JSON.stringify(res, null, 2));
  }

  console.log('\n--- BASELINE MEASUREMENTS (4x CPU THROTTLED) ---');
  for (let r = 1; r <= 2; r++) {
    const res = await runProfile(true);
    console.log(`Run ${r} (4x throttled):`, JSON.stringify(res, null, 2));
  }

} finally {
  if (session) await session.detach().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
