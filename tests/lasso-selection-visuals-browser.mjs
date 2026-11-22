// Regression test for Bug 1 (Lasso Selection & Transform Visuals) in browser and Electron:
// 1. Zero afterimage on Page 1 -> Page 2 -> Page 1 return + lasso move (static LayerCanvas hidden + pixels).
// 2. No opaque solid-blue fill accumulation across 40 incremental move steps during rectangle lasso drag.
// 3. Zero stale blue markings after shrinking selection rect before pointerup.
// 4. Mixed shape + handwriting selection renders one collective 8+1 handle set (no per-element handles).
// 5. Switching from Lasso/Select to Pen clears visual selection and blue markings immediately.
// Usage: node tests/lasso-selection-visuals-browser.mjs [--electron]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';
import sharp from 'sharp';

const electronMode = process.argv.includes('--electron');
const outDir = 'artifacts/lasso-selection-visuals';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'panvas-lasso-electron-'));
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
  const page = await app.firstWindow();
  return { app, page, dir };
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

  const parkMouse = async () => {
    await page.mouse.move(8, 8);
    await page.waitForTimeout(90);
  };

  const snapRegion = async (name, x1, y1, x2, y2) => {
    const rect = await page.evaluate(([a, b, c, d]) => {
      const p1 = window.navProbe.canvasPoint(a, b);
      const p2 = window.navProbe.canvasPoint(c, d);
      return {
        left: Math.min(p1.x, p2.x),
        top: Math.min(p1.y, p2.y),
        right: Math.max(p1.x, p2.x),
        bottom: Math.max(p1.y, p2.y),
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    }, [x1, y1, x2, y2]);
    const buf = await page.screenshot();
    if (name) await sharp(buf).toFile(path.join(outDir, `${electronMode ? 'electron' : 'web'}-${name}.png`));
    const meta = await sharp(buf).metadata();
    const scale = meta.width / rect.vw;
    const left = Math.max(0, Math.floor(rect.left * scale));
    const top = Math.max(0, Math.floor(rect.top * scale));
    const right = Math.min(meta.width, Math.ceil(rect.right * scale));
    const bottom = Math.min(meta.height, Math.ceil(rect.bottom * scale));
    const { data, info } = await sharp(buf)
      .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  };

  const countDarkInk = (snap) => {
    let dark = 0;
    for (let i = 0; i < snap.data.length; i += 4) {
      if (snap.data[i] < 95 && snap.data[i + 1] < 95 && snap.data[i + 2] < 95) dark += 1;
    }
    return dark;
  };

  const countBlueSelection = (snap) => {
    let blue = 0;
    for (let i = 0; i < snap.data.length; i += 4) {
      const r = snap.data[i], g = snap.data[i + 1], b = snap.data[i + 2];
      if (b > 170 && b > r + 25 && b > g + 5) blue += 1;
    }
    return blue;
  };

  const pageIds = await page.evaluate(() => window.navProbe.pageIds);
  assert.ok(pageIds.length >= 2, 'fixture provides at least 2 pages');

  // 1. Page 1 -> Page 2 -> Page 1 return + lasso move leaves ZERO afterimage at original location.
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.tools.setMode('draw');
    engine.tools.setDrawingTool('pen');
    engine.tools.setColor('#0f172a');
    engine.tools.setThickness(4);
    engine.tools.setOpacity(1);
    engine.tools.setStabilization(0);
  });
  const drawStroke = async (pts) => {
    const screenPts = await page.evaluate(arr => arr.map(([x, y]) => window.navProbe.canvasPoint(x, y)), pts);
    await page.mouse.move(screenPts[0].x, screenPts[0].y);
    await page.mouse.down();
    for (const sp of screenPts.slice(1)) await page.mouse.move(sp.x, sp.y);
    await page.mouse.up();
  };
  await drawStroke([[205, 225], [255, 245], [305, 275]]);
  await drawStroke([[210, 275], [255, 250], [295, 225]]);
  await parkMouse();
  await page.waitForTimeout(300);

  await page.evaluate(id => window.navProbe.setActivePage(id), pageIds[1]);
  await page.waitForTimeout(400);
  await page.evaluate(id => window.navProbe.setActivePage(id), pageIds[0]);
  await page.waitForTimeout(400);
  assert.ok((await page.evaluate(() => window.navProbe.strokeGeometry().length)) >= 2, 'drawn strokes persisted across Page 1 -> Page 2 -> Page 1');

  const staticLayerVisibility = await page.evaluate(id => {
    const container = document.querySelector(`[data-stable-page-visual="${id}"]`);
    if (!container) return null;
    const containerVis = getComputedStyle(container).visibility;
    const canvasVis = [...container.querySelectorAll('canvas')].map(c => getComputedStyle(c).visibility);
    return { containerVis, canvasVis };
  }, pageIds[0]);
  assert.ok(staticLayerVisibility, 'stable page visual wrapper exists');
  assert.equal(staticLayerVisibility.containerVis, 'hidden', 'stable page visual wrapper is hidden on Page 1 return');
  assert.ok(staticLayerVisibility.canvasVis.every(v => v === 'hidden'), `every static LayerCanvas is hidden: ${JSON.stringify(staticLayerVisibility.canvasVis)}`);

  await page.evaluate(() => {
    window.navProbe.setSelectTool();
    const engine = window.navProbe.engine();
    engine.tools.setMode('select');
    engine.tools.setSelectionShape('rectangle');
  });

  // Drag rectangle lasso over (175, 195) -> (335, 305)
  const lassoStart = await page.evaluate(() => window.navProbe.canvasPoint(175, 195));
  const lassoEnd = await page.evaluate(() => window.navProbe.canvasPoint(335, 305));
  await page.mouse.move(lassoStart.x, lassoStart.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    const t = i / 10;
    await page.mouse.move(lassoStart.x + (lassoEnd.x - lassoStart.x) * t, lassoStart.y + (lassoEnd.y - lassoStart.y) * t);
  }
  await page.mouse.up();
  await page.waitForTimeout(80);
  assert.equal((await page.evaluate(() => window.navProbe.selectionIds().size)), 2, 'both seeded strokes selected by rectangle lasso');

  // Move selection by (+220, +160)
  const dragFrom = await page.evaluate(() => window.navProbe.canvasPoint(255, 250));
  const dragTo = await page.evaluate(() => window.navProbe.canvasPoint(475, 410));
  await page.mouse.move(dragFrom.x, dragFrom.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    const t = i / 12;
    await page.mouse.move(dragFrom.x + (dragTo.x - dragFrom.x) * t, dragFrom.y + (dragTo.y - dragFrom.y) * t);
  }
  await page.mouse.up();
  await parkMouse();

  const originAfterMove = await snapRegion('after-move-origin', 190, 210, 320, 290);
  const destAfterMove = await snapRegion('after-move-dest', 410, 370, 540, 450);
  assert.equal(countDarkInk(originAfterMove), 0, 'zero afterimage pixels remain at original stroke position after Page1->Page2->Page1 + move');
  assert.ok(countDarkInk(destAfterMove) >= 40, 'moved strokes are visibly painted at destination');

  // 2. No solid opaque blue fill accumulation over 40 incremental move steps during active drag.
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.selection.clearSelection();
    engine.shapes.setShapes([]);
    engine.drawing.setStrokes([]);
    engine.drawing.redraw();
    engine.tools.setMode('select');
    engine.tools.setSelectionShape('rectangle');
  });
  await parkMouse();
  const blankOuter = await snapRegion('blank-outer', 310, 310, 450, 410);

  const rectA = await page.evaluate(() => window.navProbe.canvasPoint(180, 200));
  const rectB = await page.evaluate(() => window.navProbe.canvasPoint(460, 420));
  await page.mouse.move(rectA.x, rectA.y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i += 1) {
    const t = i / 40;
    await page.mouse.move(rectA.x + (rectB.x - rectA.x) * t, rectA.y + (rectB.y - rectA.y) * t);
  }
  await page.waitForTimeout(80);

  const interiorFill = await snapRegion('rect-40-steps-interior', 220, 240, 420, 380);
  let sumR = 0, sumG = 0, sumB = 0, saturatedBlueCount = 0;
  const pxCount = interiorFill.data.length / 4;
  for (let i = 0; i < interiorFill.data.length; i += 4) {
    const r = interiorFill.data[i], g = interiorFill.data[i + 1], b = interiorFill.data[i + 2];
    sumR += r; sumG += g; sumB += b;
    if (r < 150 || g < 175) saturatedBlueCount += 1;
  }
  const avgR = sumR / pxCount, avgG = sumG / pxCount, avgB = sumB / pxCount;
  assert.ok(avgR > 185 && avgG > 200 && avgB > 235 && avgB > avgR + 8, `light translucent blue fill preserved after 40 moves (avg rgb=${avgR.toFixed(1)},${avgG.toFixed(1)},${avgB.toFixed(1)})`);
  assert.equal(saturatedBlueCount, 0, 'zero opaque/saturated blue accumulation inside active lasso rectangle');

  // 3. Shrinking rectangle before pointerup leaves zero stale blue markings in abandoned outer area.
  const rectShrunk = await page.evaluate(() => window.navProbe.canvasPoint(280, 280));
  for (let i = 1; i <= 12; i += 1) {
    const t = i / 12;
    await page.mouse.move(rectB.x + (rectShrunk.x - rectB.x) * t, rectB.y + (rectShrunk.y - rectB.y) * t);
  }
  await page.waitForTimeout(80);
  const outerAfterShrink = await snapRegion('after-shrink-outer', 310, 310, 450, 410);
  assert.equal(Buffer.compare(outerAfterShrink.data, blankOuter.data), 0, 'shrinking rectangle selection clears abandoned region pixel-for-pixel before pointerup');
  await page.mouse.up();
  await parkMouse();

  // Capture clean unselected baseline of mixed shape + stroke scene BEFORE Check 4/5.
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.selection.clearSelection();
    engine.shapes.setShapes([
      {
        id: 'bug1-mixed-line',
        type: 'shape',
        shapeType: 'line',
        x: 200,
        y: 220,
        width: 0,
        height: 160,
        color: '#0f172a',
        strokeWidth: 3,
        fill: null,
        rotation: 0,
        opacity: 1,
        createdAt: Date.now(),
      },
    ]);
    engine.drawing.setStrokes([
      {
        id: 'bug1-mixed-stroke',
        type: 'stroke',
        tool: 'pen',
        color: '#0f172a',
        thickness: 3,
        opacity: 1,
        pattern: 'solid',
        createdAt: Date.now() + 1,
        points: [
          { x: 245, y: 245, pressure: 0.5, t: 0 },
          { x: 300, y: 295, pressure: 0.5, t: 10 },
          { x: 345, y: 345, pressure: 0.5, t: 20 },
        ],
      },
    ]);
    engine.drawing.redraw();
  });
  await parkMouse();
  const mixedBaseline = await snapRegion('mixed-unselected-baseline', 170, 170, 385, 415);

  // 4. Mixed shape + handwriting unified 8+1 handle set.
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.tools.setMode('select');
    engine.tools.setSelectionShape('rectangle');
  });
  const mixStart = await page.evaluate(() => window.navProbe.canvasPoint(180, 200));
  const mixEnd = await page.evaluate(() => window.navProbe.canvasPoint(365, 395));
  await page.mouse.move(mixStart.x, mixStart.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    const t = i / 8;
    await page.mouse.move(mixStart.x + (mixEnd.x - mixStart.x) * t, mixStart.y + (mixEnd.y - mixStart.y) * t);
  }
  await page.mouse.up();
  await parkMouse();

  assert.equal((await page.evaluate(() => window.navProbe.selectionIds().size)), 2, 'mixed line shape + stroke selected together');
  const handleAudit = await page.evaluate(() => {
    const engine = window.navProbe.engine();
    const sel = engine.selection;
    const box = sel.getCollectiveSelectionBox();
    const pad = 6; // SELECTION_FRAME_EXPANSION
    const fx = box.x - pad, fy = box.y - pad, fw = box.width + pad * 2, fh = box.height + pad * 2;
    const midX = fx + fw / 2, midY = fy + fh / 2;
    const anchors = [
      ['tl', fx, fy], ['tc', midX, fy], ['tr', fx + fw, fy],
      ['ml', fx, midY], ['mr', fx + fw, midY],
      ['bl', fx, fy + fh], ['bc', midX, fy + fh], ['br', fx + fw, fy + fh],
    ];
    const hitResults = anchors.map(([expected, x, y]) => ({ expected, got: sel.getHandleAt(x, y)?.handle ?? null }));
    // Find rotation handle along vertical centerline above tc
    let rotHit = null;
    for (let dy = 14; dy <= 34; dy += 2) {
      const hit = sel.getHandleAt(midX, fy - dy);
      if (hit?.handle) { rotHit = hit.handle; break; }
    }
    // Check that per-element interior endpoints of line (x=200, y=220 & 380) and stroke top-right (345, 245) are NOT separate resize handles.
    const lineBottomEndpointHandle = sel.getHandleAt(200, 380);
    const strokeCornerHandle = sel.getHandleAt(245, 245);

    // Spy renderSelection draw primitives on a real 2D context to confirm 9 rectangles (1 collective frame + 8 handles) + >= 1 rotation circle.
    let rectCount = 0;
    let arcCount = 0;
    const spyCtx = document.createElement('canvas').getContext('2d');
    const origStrokeRect = spyCtx.strokeRect.bind(spyCtx);
    const origArc = spyCtx.arc.bind(spyCtx);
    spyCtx.strokeRect = (...args) => { rectCount += 1; return origStrokeRect(...args); };
    spyCtx.arc = (...args) => { arcCount += 1; return origArc(...args); };
    sel.renderSelection(spyCtx);
    return { hitResults, rotHit, lineBottomEndpointHandle, strokeCornerHandle, rectCount, arcCount };
  });
  for (const h of handleAudit.hitResults) {
    assert.equal(h.got, h.expected, `collective handle ${h.expected} hit-tested cleanly`);
  }
  assert.ok(handleAudit.rotHit !== null, `unified rotation handle detected above top-center (got ${handleAudit.rotHit})`);
  assert.equal(handleAudit.lineBottomEndpointHandle, null, 'no individual line endpoint handle rendered inside collective box');
  assert.equal(handleAudit.strokeCornerHandle, null, 'no individual stroke handle rendered inside collective box');
  assert.equal(handleAudit.rectCount, 9, 'mixed selection draws exactly 1 frame + 8 handles (9 rectangles)');
  assert.ok(handleAudit.arcCount >= 1, 'mixed selection draws rotation handle circle');

  const mixedSelectedSnap = await snapRegion('mixed-selected', 170, 170, 385, 415);
  assert.ok(countBlueSelection(mixedSelectedSnap) > 30, 'selected mixed group displays blue selection frame/handles in screenshot');

  // 5. Tool switch Lasso -> Pen clears visual selection and blue pixels immediately.
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.tools.setMode('draw');
    engine.tools.setDrawingTool('pen');
  });
  await parkMouse();
  assert.equal((await page.evaluate(() => window.navProbe.selectionIds().size)), 0, 'switching from Select to Pen clears SelectionEngine state');
  const afterToolSwitchSnap = await snapRegion('after-tool-switch', 170, 170, 385, 415);
  assert.equal(countBlueSelection(afterToolSwitchSnap), 0, 'switching from Select to Pen leaves zero blue selection pixels on screen');
  assert.equal(Buffer.compare(afterToolSwitchSnap.data, mixedBaseline.data), 0, 'screen matches unselected baseline pixel-for-pixel immediately after tool switch');

  assert.deepEqual(errors, [], `no page errors: ${JSON.stringify(errors)}`);
  console.log(`LASSO SELECTION VISUALS REGRESSION (${electronMode ? 'electron' : 'browser'}): PASS`);
} finally {
  if (browser) await browser.close();
  if (electronApp) await electronApp.close();
  if (electronTempDir) await rm(electronTempDir, { recursive: true, force: true }).catch(() => {});
  await server.close();
}
