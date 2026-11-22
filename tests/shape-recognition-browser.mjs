// Anti-fake E2E verification for live Shape & Straight-Line Recognition (Chromium & Electron):
// - Real UI toggle wiring via actual NotebookFloatingToolbar Pen button & Ink Gestures popup (zero UI bypass).
// - Case A: 100% motionless mouse holds (`page.mouse`, ZERO events during 450 ms hold) for vertical line,
//   diagonal line, 90px circle, 200x160px tilted oval, square, triangle, PLUS Trap #1 early-tick motionless
//   lockout recovery + reload persistence.
// - Case B: Noisy 240 Hz stylus holds (`pointerType: 'pen'`, `pointerrawupdate` + `pointermove`, 2-6 CSS px
//   tremor + varying pressure) across all 5 shape families, Document & Freeform layouts, stroke-width parity,
//   right triangle, and 400% zoom with Marker.
// - Case C: Dark Paper + White Ink (Full Dark View enabled with black #000000 Pen ink) verifying visibly
//   bright pixels on BOTH the live preview (`canvas[data-panvas-wet-ink]`) during hold AND committed shapes.
// - Case D: Quick non-held freehand writing (`o`, `l`, cursive) -> 0 false snaps.
// - Verifies `window.__panvasShapeDiag` ring buffer schema & outcomes and prints a sample entry.
// Usage: node tests/shape-recognition-browser.mjs [--electron]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';
import sharp from 'sharp';

const electronMode = process.argv.includes('--electron');
const outDir = 'artifacts/shape-recognition';
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

const launchElectronPage = async (url, width = 1440, height = 920) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panvas-shape-electron-'));
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

// Realistic imperfect human path generators in page coordinates
function makeWobblyLinePath(x0, y0, x1, y1, steps = 24) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const u = i / steps;
    const bow = Math.sin(u * Math.PI) * 3.0 + Math.sin(u * Math.PI * 3) * 1.1;
    return [x0 + dx * u + nx * bow, y0 + dy * u + ny * bow];
  });
}

function makeUnclosedEllipsePath(cx, cy, rx, ry, rotDeg = 0, sweepDeg = 342, steps = 42) {
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sweep = (sweepDeg * Math.PI) / 180;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * sweep;
    const wobble = 1 + Math.sin(a * 5) * 0.03 + Math.cos(a * 3) * 0.015;
    const lx = Math.cos(a) * rx * wobble;
    const ly = Math.sin(a) * ry * wobble;
    return [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
  });
}

function makeCornerPausedOvershootSquarePath(x, y, w, h, stepsPerEdge = 10) {
  const pts = [];
  pts.push([x - 10, y + 1]);
  pts.push([x - 5, y + 0.5]);
  const pushEdge = (x0, y0, x1, y1, bowAmt = 1.6, stopFrac = 1) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const count = Math.max(4, Math.round(stepsPerEdge * stopFrac));
    for (let i = 0; i < count; i += 1) {
      const u = i / stepsPerEdge;
      const bow = Math.sin(u * Math.PI) * bowAmt;
      pts.push([x0 + dx * u + nx * bow, y0 + dy * u + ny * bow]);
    }
  };
  const pushCornerPause = (cx, cy, count = 12) => {
    for (let k = 0; k < count; k += 1) {
      pts.push([cx + Math.cos(k * 0.9) * 1.4, cy + Math.sin(k * 0.9) * 1.4]);
    }
  };
  pushEdge(x, y, x + w, y - 2, 1.8);
  pushCornerPause(x + w, y - 2);
  pushEdge(x + w, y - 2, x + w + 2, y + h, -1.8);
  pushCornerPause(x + w + 2, y + h);
  pushEdge(x + w + 2, y + h, x, y + h + 1, 1.5);
  pushCornerPause(x, y + h + 1);
  pushEdge(x, y + h + 1, x + 1, y, 1.3, 0.88);
  return pts;
}

function makeCleanSquarePath(x, y, w, h, stepsPerEdge = 10) {
  const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  const pts = [];
  for (let e = 0; e < 4; e += 1) {
    const [x0, y0] = corners[e];
    const [x1, y1] = corners[e + 1];
    for (let i = 0; i < stepsPerEdge; i += 1) {
      const u = i / stepsPerEdge;
      pts.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]);
    }
  }
  pts.push([x, y]);
  return pts;
}

function makeCleanTrianglePath(x, y, w, h, stepsPerEdge = 10) {
  const corners = [[x + w / 2, y], [x + w, y + h], [x, y + h], [x + w / 2, y]];
  const pts = [];
  for (let e = 0; e < 3; e += 1) {
    const [x0, y0] = corners[e];
    const [x1, y1] = corners[e + 1];
    for (let i = 0; i < stepsPerEdge; i += 1) {
      const u = i / stepsPerEdge;
      pts.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]);
    }
  }
  pts.push([x + w / 2, y]);
  return pts;
}

function makeImperfectTrianglePath(x, y, w, h, rotDeg = 22, stepsPerEdge = 11) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rot = ([px, py]) => [cx + (px - cx) * cos - (py - cy) * sin, cy + (px - cx) * sin + (py - cy) * cos];
  const corners = [
    rot([x + w / 2, y]),
    rot([x + w, y + h]),
    rot([x, y + h]),
    rot([x + w / 2, y]),
  ];
  const pts = [];
  for (let e = 0; e < 3; e += 1) {
    const [x0, y0] = corners[e];
    const [x1, y1] = corners[e + 1];
    for (let i = 0; i < stepsPerEdge; i += 1) {
      const u = i / stepsPerEdge;
      const wobble = Math.sin(u * Math.PI * 2) * 1.2;
      pts.push([x0 + (x1 - x0) * u + wobble, y0 + (y1 - y0) * u - wobble * 0.5]);
    }
    if (e < 2) {
      for (let k = 0; k < 10; k += 1) {
        pts.push([x1 + Math.cos(k) * 1.2, y1 + Math.sin(k) * 1.2]);
      }
    }
  }
  const [sx, sy] = corners[0];
  const [nx, ny] = corners[1];
  const dx = nx - sx, dy = ny - sy, l = Math.hypot(dx, dy) || 1;
  pts.push([sx + (dx / l) * 6, sy + (dy / l) * 6]);
  pts.push([sx + (dx / l) * 11, sy + (dy / l) * 11]);
  return pts;
}

function makeRightTrianglePath(x, y, w, h, stepsPerEdge = 12) {
  const corners = [[x, y], [x, y + h], [x + w, y + h], [x, y]];
  const pts = [];
  for (let e = 0; e < 3; e += 1) {
    const [x0, y0] = corners[e];
    const [x1, y1] = corners[e + 1];
    for (let i = 0; i < stepsPerEdge; i += 1) {
      const u = i / stepsPerEdge;
      pts.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]);
    }
  }
  pts.push([x, y + 6]);
  return pts;
}

function makeCursiveWavePath(x, y) {
  const pts = [];
  for (let i = 0; i <= 40; i += 1) {
    const u = i / 40;
    pts.push([x + u * 130, y + Math.sin(u * Math.PI * 4) * 18 + Math.cos(u * Math.PI * 2) * 6]);
  }
  return pts;
}

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
    page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  }
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url + 'tests/fixtures/navigation-probe.html', { timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.navProbe?.engine()?.drawing?.getCanvasElement?.()), null, { timeout: 90000 });
  await page.waitForTimeout(400);

  // Hide the navigation-probe debug tree overlay so real page.mouse coordinates hit the notebook canvas cleanly
  await page.evaluate(() => {
    const tree = document.getElementById('nav-tree-host');
    if (tree) tree.style.display = 'none';
  });

  // =========================================================================
  // 0. REAL UI TOGGLE WIRING CHECK (no bypassing UI state!)
  // =========================================================================
  // Click the real Pen button in NotebookFloatingToolbar
  await page.locator('button[title^="Pen"]').first().click();
  await page.waitForTimeout(200);

  // Open the real Ink Gestures popup via toolbar button (or overflow More menu)
  if (await page.locator('button[title="Ink Gestures"]').count()) {
    await page.locator('button[title="Ink Gestures"]').first().click();
  } else {
    await page.locator('button[title="More Tools"], button[aria-label="More Tools"]').first().click();
    await page.waitForTimeout(150);
    await page.locator('button[title="Ink Gestures"], button[aria-label="Ink Gestures"]').first().click();
  }
  await page.waitForSelector('section[role="dialog"][aria-label="Ink Gestures"]', { state: 'visible', timeout: 10000 });

  const uiDefaultToggles = await page.evaluate(() => {
    const dlg = document.querySelector('section[role="dialog"][aria-label="Ink Gestures"]');
    const switches = [...dlg.querySelectorAll('button[role="switch"]')];
    return Object.fromEntries(switches.map(sw => [sw.getAttribute('aria-label'), sw.getAttribute('aria-checked') === 'true']));
  });
  assert.equal(uiDefaultToggles['Straight-line recognition'], true, 'UI default: Straight-line recognition ON');
  assert.equal(uiDefaultToggles['Snap line angles'], true, 'UI default: Snap line angles ON');
  assert.equal(uiDefaultToggles['Draw to shape'], true, 'UI default: Draw to shape ON');
  assert.equal(uiDefaultToggles['Snap circles and squares'], true, 'UI default: Snap circles and squares ON');

  // Enable Scribble to erase & Circle to select via REAL UI clicks (all 6 toggles ON)
  if (!uiDefaultToggles['Scribble to erase']) {
    await page.locator('button[role="switch"][aria-label="Scribble to erase"]').click();
  }
  if (!uiDefaultToggles['Circle to select']) {
    await page.locator('button[role="switch"][aria-label="Circle to select"]').click();
  }
  await page.waitForTimeout(150);

  const engineTogglesAfterUI = await page.evaluate(() => {
    const s = window.navProbe.engine().tools.getState();
    return {
      mode: s.mode,
      drawingTool: s.drawingTool,
      scribbleToErase: s.scribbleToErase,
      circleToSelect: s.circleToSelect,
      straightLineRecognition: s.straightLineRecognition,
      snapRecognizedLines: s.snapRecognizedLines,
      roughShapeRecognition: s.roughShapeRecognition,
      snapRecognizedShapes: s.snapRecognizedShapes,
    };
  });
  assert.deepEqual(engineTogglesAfterUI, {
    mode: 'draw',
    drawingTool: 'pen',
    scribbleToErase: true,
    circleToSelect: true,
    straightLineRecognition: true,
    snapRecognizedLines: true,
    roughShapeRecognition: true,
    snapRecognizedShapes: true,
  }, 'Real UI toolbar & Ink Gestures switches must drive engine ToolManager state 1:1');

  await page.locator('button[aria-label="Close Ink Gestures"]').click();
  await page.waitForTimeout(150);

  // Helpers to inspect wet-ink live preview pixels & live layer canvas pixels
  const inspectWetInkPixels = async () => page.evaluate(() => {
    const wet = document.querySelector('canvas[data-panvas-wet-ink]');
    if (!wet) return { exists: false, opacity: '0', nonZero: 0, bright: 0, dark: 0 };
    const ctx = wet.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, wet.width, wet.height).data;
    let nonZero = 0, bright = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 20) {
        nonZero += 1;
        const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (lum > 140) bright += 1;
        else dark += 1;
      }
    }
    return { exists: true, opacity: wet.style.opacity, nonZero, bright, dark };
  });

  const inspectLiveLayerPixels = async () => page.evaluate(() => {
    const liveHost = document.querySelector('[data-live-page-visual]');
    const layer = liveHost?.querySelector('canvas[data-panvas-presentation-layer]');
    if (!layer) return { exists: false, nonZero: 0, bright: 0, dark: 0 };
    const ctx = layer.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, layer.width, layer.height).data;
    let nonZero = 0, bright = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 20) {
        nonZero += 1;
        const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (lum > 140) bright += 1;
        else dark += 1;
      }
    }
    return { exists: true, nonZero, bright, dark };
  });

  const countDarkPixelsInPageBox = async (x, y, w, h, snapshotName) => {
    const rect = await page.evaluate(([px, py, pw, ph]) => {
      const p1 = window.navProbe.canvasPoint(px, py);
      const p2 = window.navProbe.canvasPoint(px + pw, py + ph);
      return {
        left: Math.min(p1.x, p2.x),
        top: Math.min(p1.y, p2.y),
        right: Math.max(p1.x, p2.x),
        bottom: Math.max(p1.y, p2.y),
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    }, [x, y, w, h]);
    const buf = await page.screenshot();
    if (snapshotName) {
      await sharp(buf).toFile(path.join(outDir, `${electronMode ? 'electron' : 'web'}-${snapshotName}.png`));
    }
    const meta = await sharp(buf).metadata();
    const scale = meta.width / rect.vw;
    const left = Math.max(0, Math.floor(rect.left * scale));
    const top = Math.max(0, Math.floor(rect.top * scale));
    const right = Math.min(meta.width, Math.ceil(rect.right * scale));
    const bottom = Math.min(meta.height, Math.ceil(rect.bottom * scale));
    const { data } = await sharp(buf)
      .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 130 && data[i + 1] < 130 && data[i + 2] < 130) dark += 1;
    }
    return dark;
  };

  // Helper: 100% real Playwright mouse draw with ZERO events during motionless hold!
  const drawMotionlessMouse = async (pagePoints, { holdMs = 450, stepDelayMs = 8 } = {}) => {
    const screenPts = await page.evaluate(pts => pts.map(([x, y]) => window.navProbe.canvasPoint(x, y)), pagePoints);
    await page.mouse.move(screenPts[0].x, screenPts[0].y);
    await page.mouse.down();
    for (let i = 1; i < screenPts.length; i += 1) {
      await page.mouse.move(screenPts[i].x, screenPts[i].y);
      if (stepDelayMs > 0) await page.waitForTimeout(stepDelayMs);
    }
    let previewDuringHold = null;
    let wetPixelsDuringHold = null;
    if (holdMs > 0) {
      // ZERO mouse events during the hold window!
      await page.waitForTimeout(holdMs);
      previewDuringHold = await page.evaluate(() => {
        const preview = window.navProbe.engine().drawing.livePreviewShape;
        return preview ? { shapeType: preview.shapeType, width: preview.width, height: preview.height, rotation: preview.rotation, strokeWidth: preview.strokeWidth } : null;
      });
      wetPixelsDuringHold = await inspectWetInkPixels();
    }
    await page.mouse.up();
    await page.waitForTimeout(80);
    const diag = await page.evaluate(() => (window.__panvasShapeDiag ?? []).at(-1) ?? null);
    return { previewDuringHold, wetPixelsDuringHold, diag };
  };

  // Helper: Noisy 240 Hz stylus driver (`pointerType: 'pen'`, `pointerrawupdate` + `pointermove`, 2-6 CSS px tremor + varying pressure)
  const drawNoisy240HzStylus = async (pagePoints, { holdMs = 450 } = {}) => {
    const screenPts = await page.evaluate(pts => pts.map(([x, y]) => window.navProbe.canvasPoint(x, y)), pagePoints);
    const pointerId = 41;
    await page.evaluate(([pt, pid]) => {
      const canvas = window.navProbe.engine().drawing.getCanvasElement();
      canvas.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: pid, pointerType: 'pen', button: 0, buttons: 1, pressure: 0.52,
        clientX: pt.x, clientY: pt.y,
      }));
    }, [screenPts[0], pointerId]);

    for (let i = 1; i < screenPts.length; i += 1) {
      await page.evaluate(([pt, pid, stepIdx]) => {
        const canvas = window.navProbe.engine().drawing.getCanvasElement();
        const pressure = 0.80 + Math.sin(stepIdx * 0.4) * 0.14;
        if ('onpointerrawupdate' in window) {
          canvas.dispatchEvent(new PointerEvent('pointerrawupdate', {
            bubbles: true, pointerId: pid, pointerType: 'pen', button: -1, buttons: 1, pressure,
            clientX: pt.x, clientY: pt.y,
          }));
        }
        canvas.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, pointerId: pid, pointerType: 'pen', button: -1, buttons: 1, pressure,
          clientX: pt.x, clientY: pt.y,
        }));
      }, [screenPts[i], pointerId, i]);
      if (i % 5 === 0) await page.waitForTimeout(8);
    }

    const last = screenPts[screenPts.length - 1];
    let previewDuringHold = null;
    let wetPixelsDuringHold = null;
    if (holdMs > 0) {
      // Continuously stream ~240 Hz noisy pointerrawupdate + ~80 Hz pointermove with 2-6 CSS px tremor + varying pressure
      previewDuringHold = await page.evaluate(async ([pt, pid, durationMs]) => {
        const canvas = window.navProbe.engine().drawing.getCanvasElement();
        const start = performance.now();
        let tick = 0;
        while (performance.now() - start < durationMs) {
          tick += 1;
          const angle = tick * 0.65;
          const radius = 2.0 + (tick % 5) * 0.95; // 2.0..5.8 CSS px tremor
          const jx = pt.x + Math.cos(angle) * radius;
          const jy = pt.y + Math.sin(angle) * radius;
          const pressure = 0.25 + ((tick * 19) % 70) / 100;
          if ('onpointerrawupdate' in window) {
            canvas.dispatchEvent(new PointerEvent('pointerrawupdate', {
              bubbles: true, pointerId: pid, pointerType: 'pen', button: -1, buttons: 1, pressure,
              clientX: jx, clientY: jy,
            }));
          }
          if (tick % 3 === 0) {
            canvas.dispatchEvent(new PointerEvent('pointermove', {
              bubbles: true, pointerId: pid, pointerType: 'pen', button: -1, buttons: 1, pressure,
              clientX: jx, clientY: jy,
            }));
          }
          await new Promise(resolve => setTimeout(resolve, 4));
        }
        const preview = window.navProbe.engine().drawing.livePreviewShape;
        return preview ? { shapeType: preview.shapeType, width: preview.width, height: preview.height, rotation: preview.rotation, strokeWidth: preview.strokeWidth } : null;
      }, [last, pointerId, holdMs]);
      wetPixelsDuringHold = await inspectWetInkPixels();
    }

    await page.evaluate(([pt, pid]) => {
      const canvas = window.navProbe.engine().drawing.getCanvasElement();
      canvas.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: pid, pointerType: 'pen', button: 0, buttons: 0, pressure: 0,
        clientX: pt.x, clientY: pt.y,
      }));
    }, [last, pointerId]);
    await page.waitForTimeout(70);
    const diag = await page.evaluate(() => (window.__panvasShapeDiag ?? []).at(-1) ?? null);
    return { previewDuringHold, wetPixelsDuringHold, diag };
  };

  // =========================================================================
  // CASE A: 100% MOTIONLESS MOUSE HOLD (`page.mouse`, ZERO events during 450 ms hold)
  // =========================================================================
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.setProperties({ layoutMode: 'freeform' });
    engine.shapes.setShapes([]);
    engine.drawing.setStrokes([]);
    engine.history.clear();
    engine.viewport.setZoom(1);
    engine.drawing.redraw();
    window.__panvasShapeDiag = [];
  });
  await page.waitForTimeout(150);

  const mouseVLine = await drawMotionlessMouse(makeWobblyLinePath(85, 80, 88, 230), { holdMs: 450 });
  assert.equal(mouseVLine.previewDuringHold?.shapeType, 'line', '[Case A] motionless mouse vertical line snaps');
  assert.ok((mouseVLine.wetPixelsDuringHold?.nonZero ?? 0) > 80, '[Case A] vertical line live preview pixels visible');
  assert.equal(mouseVLine.diag?.pointerType, 'mouse');
  assert.equal(mouseVLine.diag?.holdTimerFired, true);
  assert.equal(mouseVLine.diag?.finalOutcome, 'snapped-line');
  assert.equal(mouseVLine.diag?.rejectReason, null);

  const mouseDLine = await drawMotionlessMouse(makeWobblyLinePath(140, 85, 290, 155), { holdMs: 450 });
  assert.equal(mouseDLine.previewDuringHold?.shapeType, 'line', '[Case A] motionless mouse diagonal line snaps');

  const mouseCircle = await drawMotionlessMouse(makeUnclosedEllipsePath(400, 145, 45, 45, 0, 355), { holdMs: 450 });
  assert.equal(mouseCircle.previewDuringHold?.shapeType, 'ellipse', '[Case A] motionless mouse 90px circle snaps');
  assert.ok((mouseCircle.wetPixelsDuringHold?.nonZero ?? 0) > 150, '[Case A] circle live preview pixels visible');
  assert.equal(mouseCircle.diag?.finalOutcome, 'snapped-shape');

  const mouseOval = await drawMotionlessMouse(makeUnclosedEllipsePath(220, 300, 100, 80, 28, 352), { holdMs: 450 });
  assert.equal(mouseOval.previewDuringHold?.shapeType, 'ellipse', '[Case A] motionless mouse 200x160 tilted oval snaps');

  const mouseSquare = await drawMotionlessMouse(makeCleanSquarePath(420, 250, 115, 115), { holdMs: 450 });
  assert.equal(mouseSquare.previewDuringHold?.shapeType, 'rectangle', '[Case A] motionless mouse square snaps');

  const mouseTri = await drawMotionlessMouse(makeCleanTrianglePath(130, 430, 120, 105), { holdMs: 450 });
  assert.equal(mouseTri.previewDuringHold?.shapeType, 'triangle', '[Case A] motionless mouse triangle snaps');

  // Trap #1 lockout test on real page.mouse: draw 21px (arms timer), pause 420ms (first tick fires & fails),
  // extend 10px inside <= 14px anchor, then go 100% motionless for 300ms -> MUST re-arm and snap!
  const lockoutPts = await page.evaluate(() => [
    window.navProbe.canvasPoint(350, 480),
    window.navProbe.canvasPoint(371, 480),
    window.navProbe.canvasPoint(381, 480),
  ]);
  await page.mouse.move(lockoutPts[0].x, lockoutPts[0].y);
  await page.mouse.down();
  for (let i = 1; i <= 7; i += 1) {
    await page.mouse.move(lockoutPts[0].x + i * 3, lockoutPts[0].y);
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(420); // first timer tick fires at 21px -> fails
  await page.mouse.move(lockoutPts[2].x, lockoutPts[2].y); // +10px within <=14px anchor -> total 31px
  await page.waitForTimeout(300); // 100% motionless -> retry timer MUST fire!
  const lockoutPreview = await page.evaluate(() => window.navProbe.engine().drawing.livePreviewShape?.shapeType ?? null);
  await page.mouse.up();
  await page.waitForTimeout(80);
  assert.equal(lockoutPreview, 'line', '[Case A] Trap #1 early-tick motionless lockout recovery snaps to line');

  const caseASummary = await page.evaluate(() => {
    const e = window.navProbe.engine();
    return {
      strokes: e.drawing.getStrokes().length,
      shapes: e.shapes.getShapes().map(s => ({ shapeType: s.shapeType, rotation: Math.round(s.rotation) })),
      sampleDiag: (window.__panvasShapeDiag ?? []).find(d => d.finalOutcome === 'snapped-shape') ?? null,
    };
  });
  assert.equal(caseASummary.strokes, 0, '[Case A] 0 raw freehand strokes left behind');
  assert.deepEqual(
    caseASummary.shapes.map(s => s.shapeType),
    ['line', 'line', 'ellipse', 'ellipse', 'rectangle', 'triangle', 'line'],
    '[Case A] all 7 motionless-mouse shapes committed',
  );

  // Verify Case A persistence across Page 1 -> Page 2 -> Page 1 reload!
  const pageIds = await page.evaluate(() => window.navProbe.pageIds);
  await page.evaluate(id => window.navProbe.setActivePage(id), pageIds[1]);
  await page.waitForTimeout(450);
  await page.evaluate(id => window.navProbe.setActivePage(id), pageIds[0]);
  await page.waitForTimeout(450);
  const shapesAfterCaseAReload = await page.evaluate(() =>
    window.navProbe.engine().shapes.getShapes().map(s => ({ shapeType: s.shapeType, rotation: Math.round(s.rotation) })),
  );
  assert.deepEqual(shapesAfterCaseAReload, caseASummary.shapes, '[Case A] motionless-mouse shapes persist across page reload');

  // =========================================================================
  // CASE B: NOISY 240 HZ STYLUS HOLD (Document & Freeform, all 5 families + right triangle + 400% zoom)
  // =========================================================================
  let samplePenDiag = null;
  for (const layoutMode of ['document', 'freeform']) {
    await page.evaluate(mode => {
      const engine = window.navProbe.engine();
      engine.setProperties({ layoutMode: mode });
      engine.shapes.setShapes([]);
      engine.drawing.setStrokes([]);
      engine.history.clear();
      engine.viewport.setZoom(1);
      engine.tools.setMode('draw');
      engine.tools.setDrawingTool('pen');
      engine.tools.setColor('#0f172a');
      engine.tools.setThickness(2.4);
      engine.tools.setOpacity(1);
      engine.tools.setPressureSensitivity(true);
      engine.tools.setStabilization(0);
      engine.drawing.redraw();
    }, layoutMode);
    await page.waitForTimeout(150);

    const vLine = await drawNoisy240HzStylus(makeWobblyLinePath(85, 80, 88, 220), { holdMs: 450 });
    assert.equal(vLine.previewDuringHold?.shapeType, 'line', `[Case B/${layoutMode}] vertical line snaps during 240Hz pen hold`);
    assert.ok((vLine.diag?.maxHoldDriftCss ?? 0) >= 1.5, `[Case B/${layoutMode}] diag recorded real stylus hold drift`);

    const dLine = await drawNoisy240HzStylus(makeWobblyLinePath(140, 85, 290, 145), { holdMs: 450 });
    assert.equal(dLine.previewDuringHold?.shapeType, 'line', `[Case B/${layoutMode}] diagonal line snaps during 240Hz pen hold`);

    const penCircle = await drawNoisy240HzStylus(makeUnclosedEllipsePath(390, 145, 48, 45, 0, 295), { holdMs: 450 });
    assert.equal(penCircle.previewDuringHold?.shapeType, 'ellipse', `[Case B/${layoutMode}] 18%-unclosed pen circle snaps`);
    assert.ok(
      (penCircle.previewDuringHold?.strokeWidth ?? 0) > 3.1,
      `[Case B/${layoutMode}] stylus-snapped circle matches pressure stroke width (>3.1px), got ${penCircle.previewDuringHold?.strokeWidth}`,
    );
    if (!samplePenDiag) samplePenDiag = penCircle.diag;

    await page.evaluate(() => window.navProbe.engine().tools.setDrawingTool('pencil'));
    const pencilCircle = await drawNoisy240HzStylus(makeUnclosedEllipsePath(510, 145, 44, 42, 0, 325), { holdMs: 450 });
    assert.equal(pencilCircle.previewDuringHold?.shapeType, 'ellipse', `[Case B/${layoutMode}] pencil circle snaps`);
    await page.evaluate(() => window.navProbe.engine().tools.setDrawingTool('pen'));

    const tiltedOval = await drawNoisy240HzStylus(makeUnclosedEllipsePath(370, 290, 78, 35, 35, 385), { holdMs: 450 });
    assert.equal(tiltedOval.previewDuringHold?.shapeType, 'ellipse', `[Case B/${layoutMode}] tilted oval with overshoot snaps`);

    const pausedSquare = await drawNoisy240HzStylus(makeCornerPausedOvershootSquarePath(100, 395, 118, 112), { holdMs: 450 });
    assert.equal(pausedSquare.previewDuringHold?.shapeType, 'rectangle', `[Case B/${layoutMode}] corner-paused square snaps`);

    const rotTri = await drawNoisy240HzStylus(makeImperfectTrianglePath(350, 390, 120, 102, 22), { holdMs: 450 });
    assert.equal(rotTri.previewDuringHold?.shapeType, 'triangle', `[Case B/${layoutMode}] rotated triangle snaps`);

    const rightTri = await drawNoisy240HzStylus(makeRightTrianglePath(510, 390, 100, 95), { holdMs: 450 });
    assert.equal(rightTri.previewDuringHold?.shapeType, 'triangle', `[Case B/${layoutMode}] right triangle snaps`);

    const committed = await page.evaluate(() => {
      const e = window.navProbe.engine();
      return {
        strokes: e.drawing.getStrokes().length,
        shapes: e.shapes.getShapes().map(s => ({ shapeType: s.shapeType, width: s.width, height: s.height, rotation: s.rotation })),
      };
    });
    assert.equal(committed.strokes, 0, `[Case B/${layoutMode}] 0 raw strokes left behind`);
    assert.deepEqual(
      committed.shapes.map(s => s.shapeType),
      ['line', 'line', 'ellipse', 'ellipse', 'ellipse', 'rectangle', 'triangle', 'triangle'],
      `[Case B/${layoutMode}] all 8 noisy-stylus shapes committed`,
    );

    const pixels = await countDarkPixelsInPageBox(60, 60, 580, 460, `${layoutMode}-case-b-shapes`);
    assert.ok(pixels > 900, `[Case B/${layoutMode}] committed shapes rendered visible pixels (${pixels})`);

    // Undo / Redo check
    await page.evaluate(() => window.navProbe.engine().history.undo());
    assert.equal(await page.evaluate(() => window.navProbe.engine().shapes.getShapes().length), 7, `[Case B/${layoutMode}] Undo works`);
    await page.evaluate(() => window.navProbe.engine().history.redo());
    assert.equal(await page.evaluate(() => window.navProbe.engine().shapes.getShapes().length), 8, `[Case B/${layoutMode}] Redo works`);
  }

  // 400% zoom with Marker under 240Hz tremor
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.viewport.setZoom(4);
    engine.tools.setMode('draw');
    engine.tools.setDrawingTool('marker');
  });
  await page.waitForTimeout(150);
  const zoomedTri = await drawNoisy240HzStylus(makeImperfectTrianglePath(60, 60, 28, 24, 15), { holdMs: 450 });
  assert.equal(zoomedTri.previewDuringHold?.shapeType, 'triangle', '[Case B] 400% zoom triangle with Marker snaps');
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.viewport.setZoom(1);
    engine.tools.setDrawingTool('pen');
  });
  await page.waitForTimeout(150);

  // =========================================================================
  // CASE C: DARK PAPER + WHITE INK (Full Dark View enabled with black #000000 Pen)
  // =========================================================================
  await page.evaluate(async () => {
    const mod = await import('/src/stores/uiStore.ts');
    mod.useUIStore.getState().setTheme('dark');
    mod.useUIStore.getState().setFullDarkView(true);
    const engine = window.navProbe.engine();
    engine.shapes.setShapes([]);
    engine.drawing.setStrokes([]);
    engine.history.clear();
    engine.tools.setMode('draw');
    engine.tools.setDrawingTool('pen');
    engine.tools.setColor('#000000');
    engine.tools.setThickness(2.4);
    engine.tools.setOpacity(1);
    engine.drawing.redraw();
  });
  await page.waitForTimeout(250);

  const darkCircle = await drawMotionlessMouse(makeUnclosedEllipsePath(260, 220, 48, 48, 0, 355), { holdMs: 450 });
  assert.equal(darkCircle.previewDuringHold?.shapeType, 'ellipse', '[Case C] Full Dark View circle snaps during motionless hold');
  assert.ok((darkCircle.wetPixelsDuringHold?.bright ?? 0) > 200, `[Case C] Full Dark View live preview MUST render bright/white pixels, got ${JSON.stringify(darkCircle.wetPixelsDuringHold)}`);
  assert.equal(darkCircle.wetPixelsDuringHold?.dark, 0, '[Case C] Full Dark View live preview must not render invisible black ink');

  const darkLine = await drawMotionlessMouse(makeWobblyLinePath(420, 140, 420, 300), { holdMs: 450 });
  assert.equal(darkLine.previewDuringHold?.shapeType, 'line', '[Case C] Full Dark View vertical line snaps during motionless hold');
  assert.ok((darkLine.wetPixelsDuringHold?.bright ?? 0) > 100, `[Case C] Full Dark View line live preview MUST render bright/white pixels, got ${JSON.stringify(darkLine.wetPixelsDuringHold)}`);

  const darkCommitPixels = await inspectLiveLayerPixels();
  assert.ok(darkCommitPixels.bright > 300, `[Case C] Full Dark View committed shapes MUST render bright/white pixels, got ${JSON.stringify(darkCommitPixels)}`);
  assert.equal(darkCommitPixels.dark, 0, '[Case C] Full Dark View committed shapes must not render invisible dark ink');

  // Restore light theme
  await page.evaluate(async () => {
    const mod = await import('/src/stores/uiStore.ts');
    mod.useUIStore.getState().setFullDarkView(false);
    mod.useUIStore.getState().setTheme('light');
  });
  await page.waitForTimeout(150);

  // =========================================================================
  // CASE D: QUICK NON-HELD FREEHAND WRITING (`o`, `l`, cursive) -> 0 FALSE SNAPS
  // =========================================================================
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.shapes.setShapes([]);
    engine.drawing.setStrokes([]);
    engine.tools.setMode('draw');
    engine.tools.setDrawingTool('pen');
    engine.drawing.redraw();
  });
  await page.waitForTimeout(120);

  const quickO = await drawMotionlessMouse(makeUnclosedEllipsePath(140, 220, 26, 26, 0, 355, 16), { holdMs: 0, stepDelayMs: 4 });
  const quickL = await drawMotionlessMouse(makeWobblyLinePath(210, 175, 212, 245, 10), { holdMs: 0, stepDelayMs: 4 });
  const quickCursive = await drawNoisy240HzStylus(makeCursiveWavePath(260, 220), { holdMs: 0 });

  assert.equal(quickO.diag?.finalOutcome, 'freehand-stroke', '[Case D] quick mouse "o" stays freehand');
  assert.equal(quickO.diag?.holdTimerFired, false);
  assert.equal(quickL.diag?.finalOutcome, 'freehand-stroke', '[Case D] quick mouse "l" stays freehand');
  assert.equal(quickCursive.diag?.finalOutcome, 'freehand-stroke', '[Case D] quick stylus cursive stays freehand');

  const caseDSummary = await page.evaluate(() => {
    const e = window.navProbe.engine();
    const diag = window.__panvasShapeDiag ?? [];
    return {
      mode: e.tools.getState().mode,
      strokes: e.drawing.getStrokes().length,
      shapes: e.shapes.getShapes().length,
      diagLen: diag.length,
    };
  });
  assert.equal(caseDSummary.mode, 'draw', '[Case D] quick writing stays in draw mode (no Circle-to-select steal)');
  assert.equal(caseDSummary.shapes, 0, '[Case D] 0 false snaps on quick non-held writing');
  assert.equal(caseDSummary.strokes, 3, '[Case D] all 3 quick strokes saved as raw freehand ink');
  assert.ok(caseDSummary.diagLen > 0 && caseDSummary.diagLen <= 15, `[Case D] __panvasShapeDiag ring buffer bounded to <= 15 entries (got ${caseDSummary.diagLen})`);
  assert.deepEqual(errors, [], `Zero page errors during shape recognition E2E test: ${JSON.stringify(errors)}`);

  console.log(`SAMPLE_DIAG_MOUSE: ${JSON.stringify(caseASummary.sampleDiag)}`);
  console.log(`SAMPLE_DIAG_PEN: ${JSON.stringify(samplePenDiag)}`);
  console.log(`PASS: shape-recognition-browser (${electronMode ? 'electron' : 'chromium'}) verified UI toggles + Case A (motionless mouse + Trap #1 lockout + reload) + Case B (240Hz noisy stylus, Document & Freeform, 400% zoom) + Case C (Full Dark View white ink preview & commit) + Case D (0 false snaps on quick writing)`);
} finally {
  await browser?.close();
  await electronApp?.close();
  if (electronTempDir) await rm(electronTempDir, { recursive: true, force: true });
  await server.close();
}
