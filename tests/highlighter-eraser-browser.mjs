// Highlighter eraser regression: after a pixel, stroke, or highlighter-only erase, the
// dirty redraw must clear the complete square-cap footprint. The page must not
// show detached cap remnants before or after a later full redraw.
// Usage: node tests/highlighter-eraser-browser.mjs [--electron]
import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const electronMode = process.argv.includes('--electron');
const outDir = 'artifacts/highlighter-eraser';
await mkdir(outDir, { recursive: true });
const server = await createServer({
  mode: 'web',
  cacheDir: path.join(outDir, 'vite-cache'),
  optimizeDeps: { entries: ['tests/fixtures/navigation-probe.html'] },
  server: { port: 0, open: false },
});

let browser;
let electronApp;
let electronTempDir;
const launchElectronPage = async (url, width = 1400, height = 900) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panvas-hl-eraser-electron-'));
  const bootstrap = path.join(dir, 'fixture.cjs');
  await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', require('node:path').join(__dirname, 'profile'));
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: ${width},
    height: ${height},
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadURL(${JSON.stringify(url)});
});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const app = await _electron.launch({ args: [bootstrap], env, timeout: 30_000 });
  const win = await app.firstWindow();
  return { app, page: win, dir };
};

try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  let page;
  if (electronMode) {
    const launched = await launchElectronPage(url + 'tests/fixtures/navigation-probe.html');
    electronApp = launched.app;
    electronTempDir = launched.dir;
    page = launched.page;
  } else {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  }
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url + 'tests/fixtures/navigation-probe.html', { timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.navProbe?.engine()?.drawing?.getCanvasElement?.()), null, { timeout: 90000 });
  await page.waitForTimeout(400);

  const yellowComponents = async (name) => {
    const buffer = await page.screenshot();
    await sharp(buffer).toFile(path.join(outDir, `${name}.png`));
    const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const width = info.width, height = info.height;
    const mask = new Uint8Array(width * height);
    for (let y = 120; y < Math.min(height, 860); y += 1) {
      for (let x = 200; x < Math.min(width, 1150); x += 1) {
        const offset = (y * width + x) * 3;
        const r = data[offset], g = data[offset + 1], b = data[offset + 2];
        if (r > 230 && g > 230 && b < 210) mask[y * width + x] = 1;
      }
    }
    const visited = new Uint8Array(width * height);
    let components = 0;
    let largest = 0;
    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start] || visited[start]) continue;
      const stack = [start];
      visited[start] = 1;
      let size = 0;
      while (stack.length) {
        const index = stack.pop();
        size += 1;
        const x = index % width, y = Math.floor(index / width);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const next = ny * width + nx;
            if (mask[next] && !visited[next]) { visited[next] = 1; stack.push(next); }
          }
        }
      }
      if (size >= 12) { components += 1; largest = Math.max(largest, size); }
    }
    return { components, largest };
  };

  const scenarios = [
    { name: 'diagonal-pixel', mode: 'pixel', thickness: 8, points: [[120, 120], [420, 420]], after: 1 },
    { name: 'diagonal-highlighter-eraser', mode: 'highlighter', thickness: 8, points: [[120, 120], [420, 420]], after: 0 },
    { name: 'horizontal-pixel', mode: 'pixel', thickness: 8, points: [[120, 220], [420, 220]], after: 1 },
    { name: 'vertical-pixel', mode: 'pixel', thickness: 8, points: [[220, 120], [220, 420]], after: 1 },
    { name: 'midpoint-pixel', mode: 'pixel', thickness: 8, points: [[120, 220], [520, 220]], erasePoint: [320, 220], after: 2, dataCount: 2 },
    { name: 'thin-diagonal-pixel', mode: 'pixel', thickness: 0.5, points: [[120, 120], [420, 420]], after: 1 },
    { name: 'thick-diagonal-pixel', mode: 'pixel', thickness: 20, points: [[120, 120], [420, 420]], after: 1 },
  ];

  for (const scenario of scenarios) {
    await page.evaluate(({ scenario }) => {
      const engine = window.navProbe.engine();
      engine.drawing.setStrokes([]);
      engine.drawing.addStroke({
        id: `highlighter-${scenario.name}`,
        type: 'stroke',
        tool: 'highlighter',
        color: '#ffff00',
        thickness: scenario.thickness,
        opacity: 1,
        createdAt: 1,
        points: scenario.points.map(([x, y], index) => ({ x, y, pressure: .5, t: index * 20 })),
      });
      engine.drawing.redraw();
    }, { scenario });
    await page.waitForTimeout(80);
    const before = await yellowComponents(`${scenario.name}-before`);
    assert.equal(before.components, 1, `${scenario.name}: expected one highlighter component before erasing (${JSON.stringify(before)})`);

    const erasePoint = scenario.erasePoint ?? scenario.points[0];
    const erased = await page.evaluate(({ scenario, erasePoint }) => {
      const engine = window.navProbe.engine();
      engine.eraser.startErasing(scenario.mode, false);
      const changed = engine.eraser.eraseAt(erasePoint[0], erasePoint[1], scenario.mode, 12, false);
      engine.eraser.present();
      const strokes = engine.drawing.getStrokes();
      const minimumPointDistance = strokes.flatMap(stroke => stroke.points)
        .reduce((minimum, point) => Math.min(minimum, Math.hypot(point.x - erasePoint[0], point.y - erasePoint[1])), Infinity);
      return { changed, count: strokes.length, minimumPointDistance };
    }, { scenario, erasePoint });
    assert.equal(erased.changed, true, `${scenario.name}: erase must change the scene`);
    const expectedDataCount = scenario.mode === 'highlighter' ? 0 : (scenario.dataCount ?? 1);
    assert.equal(erased.count, expectedDataCount, `${scenario.name}: unexpected surviving stroke count`);
    if (scenario.mode !== 'highlighter') {
      assert.ok(erased.minimumPointDistance > 12, `${scenario.name}: surviving centerline must not remain inside the eraser radius (${erased.minimumPointDistance})`);
    }

    const dirty = await yellowComponents(`${scenario.name}-after-dirty`);
    assert.equal(dirty.components, scenario.after, `${scenario.name}: dirty redraw left ${dirty.components} highlighter components, expected ${scenario.after}`);

    await page.evaluate(() => window.navProbe.engine().drawing.redraw());
    await page.waitForTimeout(80);
    const full = await yellowComponents(`${scenario.name}-after-full`);
    assert.equal(full.components, scenario.after, `${scenario.name}: a full redraw must not reveal or retain extra components (${JSON.stringify(full)})`);
  }

  // Overlapping marks: removing one highlighter stroke must not damage or
  // resurrect the other one.
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.drawing.setStrokes([]);
    for (const [id, points] of [
      ['overlap-a', [[120, 120], [420, 420]]],
      ['overlap-b', [[120, 420], [420, 120]]],
    ]) {
      engine.drawing.addStroke({
        id, type: 'stroke', tool: 'highlighter', color: '#ffff00', thickness: 8,
        opacity: 1, createdAt: 1,
        points: points.map(([x, y], index) => ({ x, y, pressure: .5, t: index * 20 })),
      });
    }
    engine.drawing.redraw();
  });
  await page.waitForTimeout(80);
  assert.equal((await yellowComponents('overlap-before')).components, 1, 'overlapping highlights form one component before erasing');
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.eraser.startErasing('highlighter', false);
    engine.eraser.eraseAt(120, 120, 'highlighter', 12, false);
    engine.eraser.present();
  });
  assert.equal(await page.evaluate(() => window.navProbe.engine().drawing.getStrokes().length), 1, 'only the targeted overlapping highlight is removed');
  assert.equal((await yellowComponents('overlap-after-dirty')).components, 1, 'the surviving overlapping highlight remains one clean component');
  await page.evaluate(() => window.navProbe.engine().drawing.redraw());
  await page.waitForTimeout(80);
  assert.equal((await yellowComponents('overlap-after-full')).components, 1, 'the surviving overlapping highlight remains one clean component after full redraw');

  // Bug 4 regression suite across DPR [1, 1.25, 2] using Panvas default pink highlighter
  // (#f9a8d4, opacity 0.4, thickness 12) and eraser radius 10 via real pointer sweeps.
  const verifyBug4AtDpr = async (targetPage, dpr) => {
    const tag = `${electronMode ? 'electron' : 'web'}-dpr${dpr}`;
    const moveOut = async () => {
      await targetPage.mouse.move(8, 8);
      await targetPage.waitForTimeout(90);
    };
    const capturePaper = async (label) => {
      const box = await targetPage.evaluate(() => {
        const el = window.navProbe.engine().drawing.getCanvasElement();
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
      });
      const buf = await targetPage.screenshot();
      if (label) await sharp(buf).toFile(path.join(outDir, `${tag}-${label}.png`));
      const meta = await sharp(buf).metadata();
      const scale = meta.width / box.vw;
      const left = Math.max(0, Math.floor((Math.max(box.left, 0) + 12) * scale));
      const top = Math.max(0, Math.floor((Math.max(box.top + 12, 138)) * scale));
      const right = Math.min(meta.width, Math.ceil((Math.min(box.right, box.vw) - 12) * scale));
      const bottom = Math.min(meta.height, Math.ceil((Math.min(box.bottom, box.vh) - 12) * scale));
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      const { data } = await sharp(buf)
        .extract({ left, top, width, height })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { data, width, height, left, top, scale };
    };
    const countDiffRgba = (a, b) => {
      assert.equal(a.data.length, b.data.length, `${tag}: snapshot dimensions must match`);
      let diff = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) {
          diff += 1;
        }
      }
      return diff;
    };
    const countChangedFromBaseline = (snap, base) => {
      let changed = 0;
      let pink = 0;
      for (let i = 0; i < snap.data.length; i += 4) {
        const dr = Math.abs(snap.data[i] - base.data[i]);
        const dg = Math.abs(snap.data[i + 1] - base.data[i + 1]);
        const db = Math.abs(snap.data[i + 2] - base.data[i + 2]);
        if (dr > 0 || dg > 0 || db > 0) {
          changed += 1;
          if (snap.data[i] > snap.data[i + 1] + 6 && snap.data[i] > 180) pink += 1;
        }
      }
      return { changed, pink };
    };
    const checkStrokeMapIntegrity = async (contextLabel) => {
      const check = await targetPage.evaluate(() => {
        const drawing = window.navProbe.engine().drawing;
        const strokes = drawing.getStrokes();
        const strokeIds = strokes.map(s => s.id).sort();
        const mapKeys = drawing.strokeMap instanceof Map ? [...drawing.strokeMap.keys()].sort() : null;
        const metricsKeys = drawing.retainedStrokeMetrics instanceof Map ? [...drawing.retainedStrokeMetrics.keys()] : [];
        const pathKeys = drawing.retainedInkPaths instanceof Map ? [...drawing.retainedInkPaths.keys()] : [];
        const staleMetrics = metricsKeys.filter(id => !strokeIds.includes(id));
        const stalePaths = pathKeys.filter(id => !strokeIds.includes(id));
        return { strokeIds, mapKeys, staleMetrics, stalePaths };
      });
      if (check.mapKeys) {
        assert.deepEqual(check.mapKeys, check.strokeIds, `${tag} ${contextLabel}: strokeMap keys match getStrokes()`);
      }
      assert.deepEqual(check.staleMetrics, [], `${tag} ${contextLabel}: no stale retainedStrokeMetrics`);
      assert.deepEqual(check.stalePaths, [], `${tag} ${contextLabel}: no stale retainedInkPaths`);
    };
    const seedPinkStroke = async (id, points) => {
      await targetPage.evaluate(({ id, points }) => {
        const engine = window.navProbe.engine();
        engine.drawing.setStrokes([]);
        engine.drawing.addStroke({
          id,
          type: 'stroke',
          tool: 'highlighter',
          color: '#f9a8d4',
          thickness: 12,
          opacity: 0.4,
          pattern: 'solid',
          createdAt: Date.now(),
          points: points.map(([x, y], idx) => ({ x, y, pressure: 0.5, t: idx * 8 })),
        });
        engine.drawing.redraw();
      }, { id, points });
      await moveOut();
    };
    const sweepEraser = async (mode, segments, thickness = 10) => {
      await targetPage.evaluate(({ mode, thickness }) => {
        const engine = window.navProbe.engine();
        engine.tools.setMode('eraser');
        engine.tools.setEraserMode(mode);
        engine.tools.setThickness(thickness);
      }, { mode, thickness });
      for (const [x1, y1, x2, y2, steps = 18] of segments) {
        const p1 = await targetPage.evaluate(([x, y]) => window.navProbe.canvasPoint(x, y), [x1, y1]);
        const p2 = await targetPage.evaluate(([x, y]) => window.navProbe.canvasPoint(x, y), [x2, y2]);
        await targetPage.mouse.move(p1.x, p1.y);
        await targetPage.mouse.down();
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          await targetPage.mouse.move(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t);
        }
        await targetPage.mouse.up();
      }
      await moveOut();
    };

    const sampleLine = (x1, y1, x2, y2, n = 24) =>
      Array.from({ length: n + 1 }, (_, i) => [x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
    const curvedPoints = Array.from({ length: 41 }, (_, i) => {
      const t = i / 40;
      return [180 + t * 280, 290 + Math.sin(t * Math.PI * 1.5) * 48];
    });

    await targetPage.evaluate(() => {
      const engine = window.navProbe.engine();
      engine.drawing.setStrokes([]);
      engine.drawing.redraw();
    });
    await moveOut();
    const baseline = await capturePaper('baseline');

    const fullCases = [
      { name: 'pink-0deg', points: sampleLine(180, 220, 460, 220), sweep: [[160, 220, 480, 220, 24], [480, 220, 160, 220, 16]] },
      { name: 'pink-90deg', points: sampleLine(300, 190, 300, 470), sweep: [[300, 170, 300, 490, 24], [300, 490, 300, 170, 16]] },
      { name: 'pink-45deg', points: sampleLine(180, 200, 420, 440), sweep: [[165, 185, 435, 455, 24], [435, 455, 165, 185, 16]] },
      {
        name: 'pink-curved',
        points: curvedPoints,
        sweep: curvedPoints.slice(0, -1).map((pt, idx) => [pt[0], pt[1], curvedPoints[idx + 1][0], curvedPoints[idx + 1][1], 2]),
      },
    ];

    for (const item of fullCases) {
      for (const mode of ['pixel', 'highlighter']) {
        await seedPinkStroke(`${item.name}-${mode}`, item.points);
        const seeded = await capturePaper();
        assert.ok(countChangedFromBaseline(seeded, baseline).pink > 80, `${tag} ${item.name} (${mode}): pink highlight seeded`);

        if (item.name === 'pink-curved') {
          await targetPage.evaluate(({ mode }) => {
            const engine = window.navProbe.engine();
            engine.tools.setMode('eraser');
            engine.tools.setEraserMode(mode);
            engine.tools.setThickness(10);
          }, { mode });
          const screenPts = await targetPage.evaluate(pts => pts.map(([x, y]) => window.navProbe.canvasPoint(x, y)), curvedPoints);
          await targetPage.mouse.move(screenPts[0].x, screenPts[0].y);
          await targetPage.mouse.down();
          for (const sp of screenPts.slice(1)) await targetPage.mouse.move(sp.x, sp.y);
          for (const sp of [...screenPts].reverse()) await targetPage.mouse.move(sp.x, sp.y);
          await targetPage.mouse.up();
          await moveOut();
        } else {
          await sweepEraser(mode, item.sweep);
        }

        const dirtySnap = await capturePaper(`${item.name}-${mode}-dirty`);
        assert.deepEqual(
          countChangedFromBaseline(dirtySnap, baseline),
          { changed: 0, pink: 0 },
          `${tag} ${item.name} (${mode}): 0 ink pixels and 0 residual diff before full redraw`,
        );
        await checkStrokeMapIntegrity(`${item.name}-${mode}`);

        await targetPage.evaluate(() => window.navProbe.engine().drawing.redraw());
        await targetPage.waitForTimeout(90);
        const fullSnap = await capturePaper();
        assert.equal(countDiffRgba(dirtySnap, fullSnap), 0, `${tag} ${item.name} (${mode}): zero-tolerance dirty-vs-full RGBA diff`);
      }
    }

    // Partial pixel-erase leaving two clean surviving segments + ghost re-sweep check.
    for (const partial of [
      { name: 'partial-horiz', points: sampleLine(160, 240, 480, 240), cut: [[320, 210, 320, 270, 14]] },
      { name: 'partial-diag', points: sampleLine(180, 200, 440, 460), cut: [[280, 360, 340, 300, 14]] },
    ]) {
      await seedPinkStroke(partial.name, partial.points);
      await sweepEraser('pixel', partial.cut);
      const dirtySnap = await capturePaper(`${partial.name}-dirty`);
      const countAfter = await targetPage.evaluate(() => window.navProbe.engine().drawing.getStrokes().length);
      assert.ok(countAfter >= 2, `${tag} ${partial.name}: partial erase splits stroke`);
      assert.ok(countChangedFromBaseline(dirtySnap, baseline).pink > 40, `${tag} ${partial.name}: surviving segments visible`);
      await checkStrokeMapIntegrity(partial.name);

      await targetPage.evaluate(() => window.navProbe.engine().drawing.redraw());
      await targetPage.waitForTimeout(90);
      const fullSnap = await capturePaper();
      assert.equal(countDiffRgba(dirtySnap, fullSnap), 0, `${tag} ${partial.name}: zero-tolerance dirty-vs-full RGBA diff`);

      // Re-sweep the already-erased gap with radius 6: zero further change, zero un-erasable ghosts.
      await sweepEraser('pixel', partial.cut, 6);
      const resweepDirty = await capturePaper();
      assert.equal(countDiffRgba(fullSnap, resweepDirty), 0, `${tag} ${partial.name}: re-sweeping erased gap leaves zero residual ghost change`);
      await targetPage.evaluate(() => window.navProbe.engine().drawing.redraw());
      await targetPage.waitForTimeout(90);
      const resweepFull = await capturePaper();
      assert.equal(countDiffRgba(resweepDirty, resweepFull), 0, `${tag} ${partial.name}: post-resweep dirty-vs-full RGBA diff is 0`);
    }

    // Diagonal protruding square-cap corner hit in all 3 modes ('stroke', 'highlighter', 'pixel').
    // Endpoint is (400, 440), thickness 12 (halfWidth = Math.max(8, 12*6)/2 = 36).
    // Square cap corner protrudes 36 * Math.SQRT2 ~= 50.91px right to (450.91, 440).
    // Vertical sweep along x=452 passes 52px > (36+10=46px) from round centerline, but ~1.09px < 10px from square-cap corner!
    for (const mode of ['stroke', 'highlighter', 'pixel']) {
      await seedPinkStroke(`corner-${mode}`, sampleLine(200, 240, 400, 440));
      await sweepEraser(mode, [[452, 415, 452, 465, 16]]);
      const dirtySnap = await capturePaper(`corner-${mode}-dirty`);
      await checkStrokeMapIntegrity(`corner-${mode}`);
      if (mode === 'stroke' || mode === 'highlighter') {
        assert.deepEqual(
          countChangedFromBaseline(dirtySnap, baseline),
          { changed: 0, pink: 0 },
          `${tag} corner (${mode}): square-cap corner sweep erases entire highlighter stroke`,
        );
        await targetPage.evaluate(() => window.navProbe.engine().drawing.redraw());
        await targetPage.waitForTimeout(90);
        const afterFull = await capturePaper();
        assert.equal(countDiffRgba(dirtySnap, afterFull), 0, `${tag} corner (${mode}): dirty-vs-full RGBA diff is 0`);
      } else {
        // Pixel mode cuts the protruding corner without leaving an un-erasable fragment.
        await targetPage.evaluate(() => window.navProbe.engine().drawing.redraw());
        await targetPage.waitForTimeout(90);
        const fullSnap = await capturePaper();
        assert.equal(countDiffRgba(dirtySnap, fullSnap), 0, `${tag} corner (pixel): zero-tolerance dirty-vs-full RGBA diff`);
        // Verify full sweep now removes remainder cleanly with 0 ink left.
        await sweepEraser('pixel', [[185, 225, 420, 460, 24]]);
        const cleanDirty = await capturePaper();
        assert.deepEqual(
          countChangedFromBaseline(cleanDirty, baseline),
          { changed: 0, pink: 0 },
          `${tag} corner (pixel): zero residual ghost after erasing remaining body`,
        );
        await targetPage.evaluate(() => window.navProbe.engine().drawing.redraw());
        await targetPage.waitForTimeout(90);
        const cleanFull = await capturePaper();
        assert.equal(countDiffRgba(cleanDirty, cleanFull), 0, `${tag} corner (pixel): post-clean dirty-vs-full RGBA diff is 0`);
        await checkStrokeMapIntegrity('corner-pixel-clean');
      }
    }
  };

  for (const dpr of [1, 1.25, 2]) {
    if (electronApp) {
      const cdp = await electronApp.context().newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: dpr, mobile: false });
      await page.goto(url + 'tests/fixtures/navigation-probe.html', { timeout: 120000 });
      await page.waitForFunction(() => Boolean(window.navProbe?.engine()?.drawing?.getCanvasElement?.()), null, { timeout: 90000 });
      await page.waitForTimeout(300);
      assert.ok(Math.abs((await page.evaluate(() => window.devicePixelRatio)) - dpr) < 0.01, `electron DPR=${dpr}`);
      await verifyBug4AtDpr(page, dpr);
      await cdp.detach();
    } else {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dpr });
      const dprPage = await context.newPage();
      dprPage.on('pageerror', error => errors.push(error.message));
      await dprPage.goto(url + 'tests/fixtures/navigation-probe.html', { timeout: 120000 });
      await dprPage.waitForFunction(() => Boolean(window.navProbe?.engine()?.drawing?.getCanvasElement?.()), null, { timeout: 90000 });
      await dprPage.waitForTimeout(300);
      assert.ok(Math.abs((await dprPage.evaluate(() => window.devicePixelRatio)) - dpr) < 0.01, `web DPR=${dpr}`);
      await verifyBug4AtDpr(dprPage, dpr);
      await context.close();
    }
  }

  assert.deepEqual(errors, [], `no page errors: ${JSON.stringify(errors)}`);
  console.log(`HIGHLIGHTER ERASER REGRESSION (${electronMode ? 'electron' : 'browser'}): PASS (${scenarios.length} scenarios + overlap + DPR [1,1.25,2] pink suite)`);
} finally {
  if (browser) await browser.close();
  if (electronApp) await electronApp.close();
  if (electronTempDir) await rm(electronTempDir, { recursive: true, force: true }).catch(() => { });
  await server.close();
}
