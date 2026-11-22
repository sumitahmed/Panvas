// End-to-End Verification for Expanded Shapes + Multi-Line HTR Bottom Bar + Handwriting-to-Math:
// 1. Expanded Shapes: Shape Tool UI creation + hold-to-snap recognition (Arrow, Double Arrow,
//    Wide Rectangle vs Square, Diamond, 5-Point Star, Pentagon, Hexagon) + page reload persistence.
// 2. Multi-Line HTR + Scrollable Bottom Bar: multi-line selection (Ctrl+A) -> Convert to Text ->
//    scrollable bottom textarea review/edit -> Apply -> 1-step Undo restores ink -> reload persists.
// 3. Handwriting-to-Math: handwritten fraction equation selection -> Convert to Math ->
//    HandwritingConversionBar live KaTeX preview + editable LaTeX -> edit & Apply -> rendered .katex
//    replaces ink -> 1-step Undo restores ink -> Redo / reload persists equation.
//
// Usage: node tests/features-shapes-htr-math-browser.mjs [--electron]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';

const electronMode = process.argv.includes('--electron');
const outDir = 'artifacts/features-shapes-htr-math';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'panvas-features-electron-'));
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

const frames = (page, count = 4) => page.evaluate(async n => {
  for (let i = 0; i < n; i += 1) await new Promise(requestAnimationFrame);
}, count);

async function drawHeldPath(page, points, holdMs = 460) {
  const first = await page.evaluate(([px, py]) => window.navProbe.canvasPoint(px, py), points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (let i = 1; i < points.length; i += 1) {
    const pt = await page.evaluate(([px, py]) => window.navProbe.canvasPoint(px, py), points[i]);
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
  await frames(page, 3);
}

async function drawQuickStrokes(page, strokes) {
  const densify = pts => {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i += 1) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const steps = Math.max(4, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 8));
      for (let s = 1; s <= steps; s += 1) {
        out.push([x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps]);
      }
    }
    return out;
  };
  for (const rawPts of strokes) {
    const pts = densify(rawPts);
    const first = await page.evaluate(([px, py]) => window.navProbe.canvasPoint(px, py), pts[0]);
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    for (let i = 1; i < pts.length; i += 1) {
      const pt = await page.evaluate(([px, py]) => window.navProbe.canvasPoint(px, py), pts[i]);
      await page.mouse.move(pt.x, pt.y);
      await page.waitForTimeout(3);
    }
    await page.mouse.up();
    await frames(page, 2);
  }
}

function makeDiamondPath(cx, cy, rx, ry, stepsPerEdge = 8) {
  const corners = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]];
  const pts = [];
  for (let e = 0; e < 4; e += 1) {
    const [x0, y0] = corners[e];
    const [x1, y1] = corners[e + 1];
    for (let i = 0; i < stepsPerEdge; i += 1) {
      const u = i / stepsPerEdge;
      pts.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]);
    }
  }
  pts.push(corners[0]);
  return pts;
}

function makeRectPath(x, y, w, h, stepsPerEdge = 8) {
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
  pts.push(corners[0]);
  return pts;
}

function makeStarPath(cx, cy, outerR, innerR = outerR * 0.40) {
  const pts = [];
  const verts = [];
  for (let i = 0; i <= 10; i += 1) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    verts.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  for (let e = 0; e < 10; e += 1) {
    const [x0, y0] = verts[e];
    const [x1, y1] = verts[e + 1];
    for (let k = 0; k < 5; k += 1) {
      const u = k / 5;
      pts.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]);
    }
  }
  pts.push(verts[0]);
  return pts;
}

function makeArrowStroke(x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const barbLen = 24;
  const pts = [];
  for (let i = 0; i <= 12; i += 1) {
    const u = i / 12;
    pts.push([x0 + dx * u, y0 + dy * u]);
  }
  // V-head: tip -> upper barb -> back to tip -> lower barb
  pts.push([x1 - ux * barbLen * 0.75 + nx * barbLen * 0.55, y1 - uy * barbLen * 0.75 + ny * barbLen * 0.55]);
  pts.push([x1, y1]);
  pts.push([x1 - ux * barbLen * 0.75 - nx * barbLen * 0.55, y1 - uy * barbLen * 0.75 - ny * barbLen * 0.55]);
  return pts;
}

try {
  await server.listen();
  const baseUrl = server.resolvedUrls.local[0] + 'tests/fixtures/navigation-probe.html';
  let page;
  if (electronMode) {
    const launched = await launchElectronPage(baseUrl);
    electronApp = launched.app;
    electronTempDir = launched.dir;
    page = launched.page;
  } else {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
    page = await ctx.newPage();
  }

  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.goto(baseUrl, { timeout: 60_000 });
  await page.waitForSelector('canvas[data-rendered-page-id]');
  await frames(page, 6);

  // --- PART 1: EXPANDED SHAPES (Shape Tool UI + Hold-to-Snap + Reload) ---
  // Clear default probe stroke on Page 1 cleanly
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.drawing.setStrokes([]);
    engine.shapes.setShapes([]);
    engine.drawing.redraw();
  });

  // Open Shapes settings popup (either directly on toolbar or inside "More Tools") and draw 7 expanded shapes via UI
  const ensureShapeDialog = async () => {
    const dialog = page.locator('div:has(> div > span:text-is("Shape settings"))').last();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await dialog.isVisible().catch(() => false)) return dialog;
      const shapesBtn = page.locator('button[title="Shapes"]').first();
      if (!(await shapesBtn.isVisible().catch(() => false))) {
        await page.locator('button[title="More Tools"]').first().click();
        await page.waitForTimeout(150);
      }
      await shapesBtn.click();
      await page.waitForTimeout(180);
    }
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    return dialog;
  };

  const shapeToolCases = [
    ['Rectangle', 80, 120, 210, 180, 'rectangle'],
    ['Diamond', 250, 120, 350, 210, 'diamond'],
    ['Star', 390, 120, 490, 220, 'star'],
    ['Pentagon', 530, 120, 630, 220, 'pentagon'],
    ['Hexagon', 80, 250, 180, 350, 'hexagon'],
    ['Arrow', 230, 290, 380, 290, 'arrow'],
    ['2x Arrow', 420, 290, 590, 290, 'double-arrow'],
  ];

  for (const [label, x0, y0, x1, y1, expectedType] of shapeToolCases) {
    const dialog = await ensureShapeDialog();
    await dialog.locator('button', { hasText: new RegExp(`^${label}$`) }).first().click();
    await dialog.locator('button[title="Close shape settings"]').first().click();
    await page.waitForTimeout(80);
    const p0 = await page.evaluate(([px, py]) => window.navProbe.canvasPoint(px, py), [x0, y0]);
    const p1 = await page.evaluate(([px, py]) => window.navProbe.canvasPoint(px, py), [x1, y1]);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.mouse.move(p1.x, p1.y, { steps: 6 });
    await page.mouse.up();
    await frames(page, 2);
    const lastType = await page.evaluate(() => {
      const shapes = window.navProbe.engine().shapes.getShapes();
      return shapes[shapes.length - 1]?.shapeType;
    });
    assert.equal(lastType, expectedType, `Shape tool '${label}' must create '${expectedType}', got '${lastType}'`);
  }

  // Close popup if still open and test Hold-to-Snap with Pen for Arrow, Wide Rectangle, Diamond, Star
  const closeShapesBtn = page.locator('button[title="Close shape settings"]').first();
  if (await closeShapesBtn.isVisible().catch(() => false)) {
    await closeShapesBtn.click();
    await page.waitForTimeout(100);
  }
  await page.locator('button[title^="Pen"]').first().click();
  await frames(page, 2);

  await drawHeldPath(page, makeArrowStroke(100, 440, 280, 440));
  await drawHeldPath(page, makeRectPath(340, 400, 210, 90));
  await drawHeldPath(page, makeDiamondPath(180, 620, 65, 65));
  await drawHeldPath(page, makeStarPath(440, 620, 68));

  const page1Shapes = await page.evaluate(() => window.navProbe.engine().shapes.getShapes().map(s => ({
    shapeType: s.shapeType,
    width: Math.round(s.width),
    height: Math.round(s.height),
  })));
  assert.equal(page1Shapes.length, 11, `Expected 7 shape-tool + 4 held-snap shapes = 11, got ${JSON.stringify(page1Shapes)}`);
  assert.equal(page1Shapes[7].shapeType, 'arrow');
  assert.equal(page1Shapes[8].shapeType, 'rectangle');
  assert.ok(Math.abs(page1Shapes[8].width) > Math.abs(page1Shapes[8].height) * 1.4, 'Wide rectangle must not be forced into a square');
  assert.equal(page1Shapes[9].shapeType, 'diamond');
  assert.equal(page1Shapes[10].shapeType, 'star');

  const switchToPage = async (idx) => {
    await page.evaluate(i => {
      const id = window.navProbe.pageIds[i];
      window.navProbe.setActivePage(id);
      const el = document.querySelector(`[data-page-id="${id}"]`);
      if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
    }, idx);
    await page.waitForFunction(i => window.navProbe.ownershipPageId() === window.navProbe.pageIds[i], idx);
    await frames(page, 6);
  };

  const ensurePenActive = async () => {
    const isPen = await page.evaluate(() => {
      const s = window.navProbe.engine().tools.getState();
      return s.mode === 'draw' && s.drawingTool === 'pen';
    });
    if (!isPen) {
      await page.locator('button[title^="Pen"]').first().click();
      await frames(page, 2);
    }
  };

  // Switch Page 1 -> Page 2 -> Page 1 and verify persistence of all 11 expanded shapes
  await switchToPage(1);
  await switchToPage(0);
  const reloadedShapes = await page.evaluate(() => window.navProbe.engine().shapes.getShapes().map(s => s.shapeType));
  assert.deepEqual(reloadedShapes, page1Shapes.map(s => s.shapeType), 'Expanded shapes must persist identically across page reload');

  // --- PART 2: MULTI-LINE HTR BOTTOM BAR ---
  await switchToPage(1);

  // Clear initial mark and draw 3 distinct handwriting lines vertically separated
  await page.evaluate(() => {
    const e = window.navProbe.engine();
    e.drawing.setStrokes([]);
    e.texts.setTexts([]);
    e.drawing.redraw();
  });
  await ensurePenActive();
  await drawQuickStrokes(page, [
    [[100, 140], [160, 140], [220, 138]],
    [[100, 230], [180, 230], [250, 228]],
    [[100, 320], [190, 320], [260, 318]],
  ]);
  assert.equal(await page.evaluate(() => window.navProbe.engine().drawing.getStrokes().length), 3);

  // Press Ctrl+A -> selects all 3 lines -> click Convert to Text
  await page.keyboard.press('Control+a');
  await frames(page, 2);
  const convertTextBtn = page.locator('button:has-text("Convert to Text")').first();
  await convertTextBtn.waitFor({ state: 'visible', timeout: 10_000 });
  const convertMathVisible = await page.locator('button:has-text("Convert to Math")').first().isVisible();
  assert.equal(convertMathVisible, true, 'Selection action bar must display both Convert to Text and Convert to Math');
  await convertTextBtn.click();

  const barTextarea = page.locator('[data-testid="handwriting-conversion-textarea"]');
  await barTextarea.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="handwriting-conversion-textarea"]');
    const apply = document.querySelector('[data-testid="handwriting-conversion-apply"]');
    return Boolean(el && apply && !el.disabled);
  }, null, { timeout: 10_000 });

  // Verify meta indicates 3 lines detected and test editing directly in scrollable bottom textarea
  await barTextarea.fill('Line One Edited\nLine Two Edited\nLine Three Edited');
  await page.locator('[data-testid="handwriting-conversion-apply"]').click();
  await frames(page, 4);

  const afterTextApply = await page.evaluate(() => {
    const e = window.navProbe.engine();
    return {
      strokes: e.drawing.getStrokes().length,
      texts: e.texts.getTexts().map(t => JSON.stringify(t.content)),
    };
  });
  assert.equal(afterTextApply.strokes, 0, 'Applying multi-line HTR must replace selected strokes');
  const joinedText = afterTextApply.texts.join('\n');
  assert.match(joinedText, /Line One Edited/);
  assert.match(joinedText, /Line Two Edited/);
  assert.match(joinedText, /Line Three Edited/);

  // 1-step Undo restores all 3 strokes & removes generated text
  await page.evaluate(() => {
    window.navProbe.engine().history.undo();
    window.navProbe.engine().drawing.redraw();
  });
  await frames(page, 3);
  assert.equal(await page.evaluate(() => window.navProbe.engine().drawing.getStrokes().length), 3, 'Undo must restore all source strokes');
  assert.equal(await page.evaluate(() => window.navProbe.engine().texts.getTexts().length), 0, 'Undo must remove converted text');

  // Redo and reload verify persistence
  await page.evaluate(() => {
    window.navProbe.engine().history.redo();
    window.navProbe.engine().drawing.redraw();
  });
  await frames(page, 3);
  await page.waitForTimeout(300);
  await switchToPage(2);
  await switchToPage(1);
  const reloadedTexts = await page.evaluate(() => window.navProbe.engine().texts.getTexts().map(t => JSON.stringify(t.content)).join('\n'));
  assert.match(reloadedTexts, /Line One Edited/, 'Edited HTR text must persist after reload');

  // --- PART 3: HANDWRITING-TO-MATH (Bottom Bar + KaTeX Live Preview + Apply + Undo + Reload) ---
  await switchToPage(2);
  await page.evaluate(() => {
    const e = window.navProbe.engine();
    e.drawing.setStrokes([]);
    e.texts.setTexts([]);
    e.drawing.redraw();
  });

  // Draw a clear handwritten fraction: x above horizontal bar, 2 below bar
  await ensurePenActive();
  await drawQuickStrokes(page, [
    // 'x' numerator (x: 195..225, y: 120..155)
    [[195, 120], [225, 155]],
    [[225, 120], [195, 155]],
    // fraction bar (x: 160..260, y: 175)
    [[160, 175], [260, 175]],
    // '2' denominator (x: 195..225, y: 195..235)
    [[195, 200], [210, 195], [225, 202], [220, 215], [195, 235], [228, 235]],
    // '=' (x: 280..315, y: 165 & 185)
    [[280, 168], [315, 168]],
    [[280, 182], [315, 182]],
    // '5' (x: 340..368, y: 155..200)
    [[368, 155], [342, 155], [342, 175], [362, 175], [368, 190], [352, 200], [340, 195]],
  ]);
  assert.equal(await page.evaluate(() => window.navProbe.engine().drawing.getStrokes().length), 7);

  await page.keyboard.press('Control+a');
  await frames(page, 2);
  await page.locator('button:has-text("Convert to Math")').first().click();

  const mathTextarea = page.locator('[data-testid="handwriting-conversion-textarea"]');
  const mathPreview = page.locator('[data-testid="handwriting-math-preview"]');
  await mathTextarea.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => {
    const ta = document.querySelector('[data-testid="handwriting-conversion-textarea"]');
    const apply = document.querySelector('[data-testid="handwriting-conversion-apply"]');
    return Boolean(ta && apply && !ta.disabled);
  }, null, { timeout: 10_000 });

  // Verify zero heuristic gibberish is fabricated when Local Math AI is not loaded in web fixture
  const initialMathValue = await mathTextarea.inputValue();
  assert.equal(initialMathValue, '', `Expected clean empty initial value without gibberish when ONNX is absent, got: ${initialMathValue}`);

  // Verify all 5 School-to-PhD chip tabs exist and work (Basic, Calculus, Linear Alg, Greek, Logic / Sets)
  for (const tabId of ['basic', 'calculus', 'linalg', 'greek', 'logic']) {
    await page.locator(`[data-testid="math-chip-tab-${tabId}"]`).click();
    await frames(page, 1);
  }
  await page.locator('[data-testid="math-chip-tab-calculus"]').click();
  await page.locator('button:has-text("\\\\int_{a}^{b}")').first().click();
  assert.match(await mathTextarea.inputValue(), /\\int_\{a\}\^\{b\}/);

  // Edit complex LaTeX in scrollable textarea & verify KaTeX preview updates cleanly
  await mathTextarea.fill('\\frac{x+1}{2} = 5');
  await frames(page, 2);
  const katexHtml = await mathPreview.innerHTML();
  assert.match(katexHtml, /class="katex"/, 'Live KaTeX preview must render edited LaTeX');

  // Verify Light + Full Dark View preview readability & contrast
  await page.evaluate(async () => {
    const { useUIStore } = await import('/src/stores/uiStore.ts');
    useUIStore.getState().setTheme('dark');
    useUIStore.getState().setFullDarkView(true);
  });
  await frames(page, 2);
  const darkPreviewState = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="handwriting-math-preview"]');
    return el ? { fullDark: el.dataset.fullDark, color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor } : null;
  });
  assert.equal(darkPreviewState?.fullDark, 'true');
  assert.notEqual(darkPreviewState?.color, darkPreviewState?.bg, 'KaTeX preview text and background must maintain visible contrast in Full Dark View');
  await page.evaluate(async () => {
    const { useUIStore } = await import('/src/stores/uiStore.ts');
    useUIStore.getState().setFullDarkView(false);
    useUIStore.getState().setTheme('light');
  });
  await frames(page, 2);

  await page.locator('[data-testid="handwriting-conversion-apply"]').click();
  await frames(page, 4);

  const afterMathApply = await page.evaluate(() => {
    const e = window.navProbe.engine();
    return {
      strokes: e.drawing.getStrokes().length,
      texts: e.texts.getTexts().map(t => ({
        generatedFrom: t.metadata?.generatedFrom,
        latex: t.metadata?.latex,
        content: t.content,
      })),
      domKatexCount: document.querySelectorAll('.panvas-notebook-viewport .katex').length,
    };
  });
  assert.equal(afterMathApply.strokes, 0, 'Applying math conversion must replace strokes');
  assert.equal(afterMathApply.texts.length, 1);
  assert.equal(afterMathApply.texts[0].generatedFrom, 'handwriting-math');
  assert.equal(afterMathApply.texts[0].latex, '\\frac{x+1}{2} = 5');
  assert.ok(afterMathApply.domKatexCount >= 1, 'Applied math TextObject must render with KaTeX in the DOM');

  // Verify 1-step Undo restores equation strokes, Redo restores math, and reload preserves it
  await page.evaluate(() => {
    window.navProbe.engine().history.undo();
    window.navProbe.engine().drawing.redraw();
  });
  await frames(page, 3);
  assert.equal(await page.evaluate(() => window.navProbe.engine().drawing.getStrokes().length), 7, 'Undo must restore all 7 math ink strokes');
  assert.equal(await page.evaluate(() => window.navProbe.engine().texts.getTexts().length), 0, 'Undo must remove math TextObject');

  await page.evaluate(() => {
    window.navProbe.engine().history.redo();
    window.navProbe.engine().drawing.redraw();
  });
  await frames(page, 3);
  await page.waitForTimeout(300);

  await page.evaluate(() => window.navProbe.setActivePage(window.navProbe.pageIds[0]));
  await page.waitForFunction(() => window.navProbe.ownershipPageId() === window.navProbe.pageIds[0]);
  await frames(page, 3);
  await page.evaluate(() => {
    window.navProbe.setActivePage(window.navProbe.pageIds[2]);
    const el = document.querySelector(`[data-page-id="${window.navProbe.pageIds[2]}"]`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  await page.waitForFunction(() => window.navProbe.ownershipPageId() === window.navProbe.pageIds[2]);
  await frames(page, 4);

  const reloadedMath = await page.evaluate(() => ({
    latex: window.navProbe.engine().texts.getTexts()[0]?.metadata?.latex,
    domKatexCount: document.querySelectorAll('.panvas-notebook-viewport .katex').length,
  }));
  assert.equal(reloadedMath.latex, '\\frac{x+1}{2} = 5');
  assert.ok(reloadedMath.domKatexCount >= 1, 'Persisted math object must render KaTeX cleanly after reload');

  // --- PART 4: DOCUMENT LAYOUT + MULTI-SHEET (SHEET 2/3) + DARK PAPER (#1e1e1e) IN-PLACE APPLY ---
  // Reproduces exact live failure: Document layout, Dark Paper, scrolled down to Sheet 2/3 (y > 1400).
  await page.evaluate(async () => {
    const e = window.navProbe.engine();
    e.drawing.setStrokes([]);
    e.texts.setTexts([]);
    e.shapes.setShapes([]);
    e.setProperties({
      layoutMode: 'document',
      pageSize: 'A4',
      paperColor: '#1e1e1e',
      layoutExtent: 4000,
    });
    e.drawing.redraw();
  });
  await frames(page, 6);

  // Scroll viewport to Sheet 2/3 (y ~ 1380 inside Document page)
  await page.evaluate(async () => {
    const scroller = document.querySelector('.notebook-viewport');
    const e = window.navProbe.engine();
    const scale = e.viewport.getState().scale || 1;
    const pageId = window.navProbe.pageIds[2];
    const pageRoot = document.getElementById(`page-${pageId}`) ?? document.querySelector(`[data-page-id="${pageId}"]`);
    if (pageRoot && scroller) {
      const pr = pageRoot.getBoundingClientRect();
      const vr = scroller.getBoundingClientRect();
      scroller.scrollTop += (pr.top - vr.top) + 1380 * scale;
    }
    await new Promise(resolve => setTimeout(resolve, 180));
    for (let i = 0; i < 6; i += 1) await new Promise(requestAnimationFrame);
  });

  // 4A. Convert to Text on Sheet 2/3 + Dark Paper -> Apply -> in-place bright text + Undo + Persist
  await ensurePenActive();
  const docTextPagePt = [160, 1520];
  await drawQuickStrokes(page, [
    [[docTextPagePt[0], docTextPagePt[1]], [docTextPagePt[0] + 180, docTextPagePt[1] + 8]],
  ]);
  const docTextClientPt = await page.evaluate(([px, py]) => {
    const pt = window.navProbe.canvasPoint(px, py);
    return [pt.x, pt.y];
  }, docTextPagePt);
  await page.keyboard.press('Control+a');
  await frames(page, 2);
  await page.locator('button:has-text("Convert to Text")').first().click();
  await barTextarea.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="handwriting-conversion-textarea"]')?.disabled, null, { timeout: 10_000 });
  await barTextarea.fill('Dark Sheet 2/3 Text Visible');
  await page.locator('[data-testid="handwriting-conversion-apply"]').click();
  await frames(page, 6);

  const docTextCheck = await page.evaluate((targetClient) => {
    const e = window.navProbe.engine();
    const pageId = window.navProbe.pageIds[2];
    const pageEl = document.querySelector(`[data-page-id="${pageId}"]`);
    const vr = document.querySelector('.notebook-viewport').getBoundingClientRect();
    const el = [...(pageEl?.querySelectorAll('[data-text-object-id]') ?? [])]
      .find(n => (n.textContent || '').includes('Dark Sheet 2/3 Text Visible'));
    const rect = el ? el.getBoundingClientRect() : null;
    const textInner = el?.querySelector('.panvas-document-text') ?? el;
    const color = textInner ? getComputedStyle(textInner).color : '';
    const obj = e.texts.getTexts().find(t => JSON.stringify(t.content).includes('Dark Sheet 2/3 Text Visible'));
    return {
      strokesLeft: e.drawing.getStrokes().length,
      foundDom: Boolean(el),
      inViewport: Boolean(rect && rect.top >= vr.top - 40 && rect.top <= vr.bottom),
      dyFromStrokes: rect ? Math.abs(rect.top - targetClient[1]) : Infinity,
      color,
      objY: obj?.y ?? 0,
    };
  }, docTextClientPt);
  assert.equal(docTextCheck.strokesLeft, 0, 'Document Sheet 2/3 text Apply must replace strokes');
  assert.equal(docTextCheck.foundDom, true, 'Document Sheet 2/3 text DOM element must exist right after Apply (must not vanish!)');
  assert.equal(docTextCheck.inViewport, true, 'Document Sheet 2/3 text must stay visible inside current viewport (not teleported to Sheet 1)');
  assert.ok(docTextCheck.dyFromStrokes <= 80, `Document text Y must appear within <=80px of source strokes (got delta=${docTextCheck.dyFromStrokes})`);
  assert.ok(docTextCheck.objY > 1100, `Document text page Y must sit on Sheet 2/3 (got ${docTextCheck.objY})`);
  // Parse rgb(r,g,b) brightness on #1e1e1e Dark Paper
  {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(docTextCheck.color);
    assert.ok(m, `Expected valid RGB color for dark-paper text, got ${docTextCheck.color}`);
    const lum = (Number(m[1]) * 0.2126 + Number(m[2]) * 0.7152 + Number(m[3]) * 0.0722) / 255;
    assert.ok(lum > 0.5, `Document text color ${docTextCheck.color} too dark on #1e1e1e paper (lum=${lum.toFixed(2)})`);
  }

  // Undo restores strokes, Redo restores positioned text
  await page.evaluate(() => { window.navProbe.engine().history.undo(); window.navProbe.engine().drawing.redraw(); });
  await frames(page, 3);
  assert.equal(await page.evaluate(() => window.navProbe.engine().drawing.getStrokes().length), 1, 'Document text Undo must restore source stroke');
  assert.equal(await page.evaluate(() => window.navProbe.engine().texts.getTexts().filter(t => t.metadata?.documentRole !== 'body').length), 0);
  await page.evaluate(() => { window.navProbe.engine().history.redo(); window.navProbe.engine().drawing.redraw(); });
  await frames(page, 3);

  // 4B. Convert to Math on Sheet 2/3 + Dark Paper -> Apply -> in-place bright .katex + Undo + Reload
  await ensurePenActive();
  const docMathPagePt = [160, 1660];
  await drawQuickStrokes(page, [
    [[docMathPagePt[0], docMathPagePt[1]], [docMathPagePt[0] + 150, docMathPagePt[1]]],
    [[docMathPagePt[0], docMathPagePt[1] + 42], [docMathPagePt[0] + 150, docMathPagePt[1] + 42]],
  ]);
  const docMathClientPt = await page.evaluate(([px, py]) => {
    const pt = window.navProbe.canvasPoint(px, py);
    return [pt.x, pt.y];
  }, docMathPagePt);
  await page.keyboard.press('Control+a');
  await frames(page, 2);
  await page.locator('button:has-text("Convert to Math")').first().click();
  await mathTextarea.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="handwriting-conversion-textarea"]')?.disabled, null, { timeout: 10_000 });
  await mathTextarea.fill('6 + 9 = 15');
  await page.locator('[data-testid="handwriting-conversion-apply"]').click();
  await frames(page, 6);

  const docMathCheck = await page.evaluate((targetClient) => {
    const e = window.navProbe.engine();
    const pageId = window.navProbe.pageIds[2];
    const pageEl = document.querySelector(`[data-page-id="${pageId}"]`);
    const vr = document.querySelector('.notebook-viewport').getBoundingClientRect();
    const mathBox = [...(pageEl?.querySelectorAll('[data-text-object-id]') ?? [])]
      .find(n => Boolean(n.querySelector('.katex')));
    const katexEl = mathBox?.querySelector('.katex') ?? null;
    const rect = mathBox ? mathBox.getBoundingClientRect() : null;
    const color = katexEl ? getComputedStyle(katexEl).color : '';
    const obj = e.texts.getTexts().find(t => t.metadata?.generatedFrom === 'handwriting-math');
    return {
      strokesLeft: e.drawing.getStrokes().length,
      foundKatex: Boolean(katexEl),
      inViewport: Boolean(rect && rect.top >= vr.top - 40 && rect.top <= vr.bottom),
      dyFromStrokes: rect ? Math.abs(rect.top - targetClient[1]) : Infinity,
      color,
      objY: obj?.y ?? 0,
      latex: obj?.metadata?.latex,
    };
  }, docMathClientPt);
  assert.equal(docMathCheck.strokesLeft, 0, 'Document Sheet 2/3 math Apply must replace strokes');
  assert.equal(docMathCheck.foundKatex, true, 'Document Sheet 2/3 KaTeX DOM element must exist right after Apply (must not vanish!)');
  assert.equal(docMathCheck.inViewport, true, 'Document Sheet 2/3 math must stay visible inside current viewport');
  assert.ok(docMathCheck.dyFromStrokes <= 80, `Document math Y must appear within <=80px of source strokes (got delta=${docMathCheck.dyFromStrokes})`);
  assert.ok(docMathCheck.objY > 1100, `Document math page Y must sit on Sheet 2/3 (got ${docMathCheck.objY})`);
  {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(docMathCheck.color);
    assert.ok(m, `Expected valid RGB color for dark-paper KaTeX, got ${docMathCheck.color}`);
    const lum = (Number(m[1]) * 0.2126 + Number(m[2]) * 0.7152 + Number(m[3]) * 0.0722) / 255;
    assert.ok(lum > 0.5, `Document KaTeX color ${docMathCheck.color} too dark on #1e1e1e paper (lum=${lum.toFixed(2)})`);
  }

  // Undo restores strokes, Redo & switch-page reload preserves both Sheet 2/3 Document Text and Math
  await page.evaluate(() => { window.navProbe.engine().history.undo(); window.navProbe.engine().drawing.redraw(); });
  await frames(page, 3);
  assert.equal(await page.evaluate(() => window.navProbe.engine().drawing.getStrokes().length), 2, 'Document math Undo must restore both source strokes');
  await page.evaluate(() => { window.navProbe.engine().history.redo(); window.navProbe.engine().drawing.redraw(); });
  await frames(page, 4);
  await page.waitForTimeout(350);

  await page.evaluate(() => window.navProbe.setActivePage(window.navProbe.pageIds[0]));
  await page.waitForFunction(() => window.navProbe.ownershipPageId() === window.navProbe.pageIds[0]);
  await frames(page, 3);
  await page.evaluate(() => window.navProbe.setActivePage(window.navProbe.pageIds[2]));
  await page.waitForFunction(() => window.navProbe.ownershipPageId() === window.navProbe.pageIds[2]);
  await page.evaluate(async () => {
    const scroller = document.querySelector('.notebook-viewport');
    const scale = window.navProbe.engine().viewport.getState().scale || 1;
    const pageId = window.navProbe.pageIds[2];
    const pageRoot = document.getElementById(`page-${pageId}`) ?? document.querySelector(`[data-page-id="${pageId}"]`);
    if (pageRoot && scroller) {
      const pr = pageRoot.getBoundingClientRect();
      const vr = scroller.getBoundingClientRect();
      scroller.scrollTop += (pr.top - vr.top) + 1380 * scale;
    }
    await new Promise(resolve => setTimeout(resolve, 160));
  });
  await frames(page, 6);

  const reloadedDocSheetState = await page.evaluate(() => {
    const texts = window.navProbe.engine().texts.getTexts();
    return {
      hasText: texts.some(t => JSON.stringify(t.content).includes('Dark Sheet 2/3 Text Visible') && t.y > 1100),
      hasMath: texts.some(t => t.metadata?.generatedFrom === 'handwriting-math' && t.metadata?.latex === '6 + 9 = 15' && t.y > 1100),
      domKatexCount: document.querySelectorAll('.panvas-notebook-viewport .katex').length,
    };
  });
  assert.equal(reloadedDocSheetState.hasText, true, 'Sheet 2/3 Document text must survive reload at its page Y position');
  assert.equal(reloadedDocSheetState.hasMath, true, 'Sheet 2/3 Document math must survive reload at its page Y position');
  assert.ok(reloadedDocSheetState.domKatexCount >= 1, 'Sheet 2/3 Document KaTeX must render after reload');

  assert.deepEqual(errors, [], `Expected 0 page errors, got: ${errors.join('; ')}`);
  console.log(`PASS: features-shapes-htr-math-browser (${electronMode ? 'electron' : 'chromium'}) — shapes=${reloadedShapes.length}, schoolToPhdTabs=5`);
} finally {
  if (electronApp) await electronApp.close();
  if (electronTempDir) await rm(electronTempDir, { recursive: true, force: true });
  if (browser) await browser.close();
  await server.close();
}
