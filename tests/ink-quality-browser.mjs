import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const electronMode = process.argv.includes('--electron');
const quick = process.argv.includes('--quick');
const dpr = Number(process.argv.find(arg => arg.startsWith('--dpr='))?.split('=')[1] ?? 1);
const temporary = await mkdtemp(path.join(tmpdir(), 'panvas-ink-quality-'));
const output = process.env.PANVAS_INK_QA_DIR || temporary;
await mkdir(output, { recursive: true });
const label = `${electronMode ? 'electron' : 'chromium'}-${dpr}`;
let browser, app, passed = 0;
const errors = [], report = { mode: label, synthetic: true };
const pass = message => { passed++; console.log(`PASS: ${message}`); };
const server = await createServer({ mode: 'web', cacheDir: path.join(temporary, 'cache'), server: { port: 0, open: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
try {
  let page;
  if (electronMode) {
    const bootstrap = path.join(temporary, 'bootstrap.cjs');
    await writeFile(bootstrap, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
app.commandLine.appendSwitch('force-device-scale-factor','${dpr}');
app.whenReady().then(()=>new BrowserWindow({show:false,width:1920,height:1080,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}}).loadURL(${JSON.stringify(url + 'tests/fixtures/ink-quality.html?handwritingTrace=1')}));`);
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete env[key];
    app = await _electron.launch({ args: [bootstrap], env }); page = await app.firstWindow();
    if (dpr !== 1) {
      const emulation = await page.context().newCDPSession(page);
      await emulation.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: dpr, mobile: false });
      await page.goto(url + 'tests/fixtures/ink-quality.html?handwritingTrace=1');
      report.dpiCoverage = 'renderer device metrics emulation; Windows display scaling unchanged';
    }
  } else {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: dpr });
    await page.goto(url + 'tests/fixtures/ink-quality.html?handwritingTrace=1');
  }
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => window.inkFixture);
  assert.ok(Math.abs(await page.evaluate(() => devicePixelRatio) - dpr) < .01);

  report.matrix = await page.evaluate(async quick => {
    const f = window.inkFixture, rows = [];
    for (const pointer of ['mouse', 'pen']) for (const zoom of f.zooms) for (const setting of f.settings)
      for (const kind of quick ? ['straight'] : f.cases) {
        f.configure(zoom, setting);
        const fixture = f.fixture(kind, 120, zoom), start = performance.now();
        const nativePressure = fixture.raw.map((p, i) => f.dispatch(i ? 'pointermove' : 'pointerdown', p, pointer, start + p.t).pressure);
        await f.frames(1);
        const live = JSON.stringify(f.engine.input.currentPoints);
        const physical = f.engine.input.inkRawPoints.map(p => ({ ...p }));
        f.dispatch('pointerup', fixture.raw.at(-1), pointer, start + 1001);
        const stroke = f.engine.drawing.getStrokes().at(-1), trace = window.__panvasHandwritingTraces.at(-1);
        const filter = new f.InkInputFilter();
        const filtered = physical.map(p => filter.push(p, setting, zoom));
        rows.push({ pointer, zoom, setting, kind, ...f.metrics(fixture.ideal, stroke.points, zoom),
          filteredRms: f.metrics(fixture.ideal, filtered, zoom).rmsDeviationPx,
          tipMax: Math.max(...filtered.map((p, i) => Math.hypot(p.x - physical[i].x, p.y - physical[i].y) * zoom)),
          liveFinal: live === JSON.stringify(stroke.points), physicalCount: physical.length,
          normalizedCount: trace.normalized.length, filteredCount: trace.counters.filterInputs,
          pressureExact: physical.every((p, i) => p.pressure === (pointer === 'mouse' ? .5 : nativePressure[i])),
          capturedExact: physical.every((p, i) => Math.hypot(p.x - fixture.raw[i].x, p.y - fixture.raw[i].y) < 1e-8 && Math.abs(p.t - fixture.raw[i].t) < 1e-8),
        });
      }
    return rows;
  }, quick);
  await writeFile(path.join(output, `${label}-matrix.json`), JSON.stringify(report.matrix, null, 2));
  for (const row of report.matrix) {
    assert.equal(row.liveFinal, true, `lift changes ${JSON.stringify(row)}`);
    assert.equal(row.capturedExact, true); assert.equal(row.pressureExact, true);
    assert.equal(row.physicalCount, row.normalizedCount); assert.equal(row.physicalCount, row.filteredCount);
    assert.ok(row.tipMax <= row.setting / 50 + 1e-7, 'bounded follower in CSS pixels');
  }
  for (const pointer of ['mouse', 'pen']) for (const setting of [25, 50, 75, 100]) {
    const rows = report.matrix.filter(r => r.pointer === pointer && r.setting === setting && r.kind === 'straight');
    assert.ok(Math.max(...rows.map(r => r.filteredRms)) - Math.min(...rows.map(r => r.filteredRms)) < 1e-8, 'zoom-invariant perceived jitter');
  }
  const strengths = report.matrix.filter(r => r.pointer === 'pen' && r.zoom === 1 && r.kind === 'straight');
  for (let i = 1; i < strengths.length; i++) assert.ok(strengths[i].filteredRms < strengths[i - 1].filteredRms);
  assert.ok(strengths.at(-1).filteredRms < strengths[0].filteredRms * .6);
  pass(`${report.matrix.length} actual-engine mouse/simulated-pen cases: capture, pressure, zoom, meaningful slider effect, no lift geometry change`);

  report.appearance = await page.evaluate(async () => {
    const f = window.inkFixture, rows = [];
    const styles = ['pen', 'pencil', 'highlighter', 'marker'].flatMap(tool =>
      (tool === 'pen' ? [undefined, 'ballpoint', 'fountain', 'brush', 'felt'] : [undefined]).flatMap(family =>
        ['solid', 'dashed', 'dotted'].flatMap(pattern => [false, true].map(pressure => ({ tool, family, pattern, pressure })))));
    for (const style of styles) {
      f.configure(1, 100); const t = f.engine.tools;
      t.setDrawingTool(style.tool); t.setInkFamily(style.family); t.setStrokePattern(style.pattern);
      t.setPressureSensitivity(style.pressure); t.setOpacity(.65); t.setThickness(3.2); t.setColor('#2563eb');
      const input = f.fixture('pressure').raw, start = performance.now();
      input.forEach((p, i) => f.dispatch(i ? 'pointermove' : 'pointerdown', p, 'pen', start + p.t));
      await f.frames(1); const wet = f.pixels(), geometry = JSON.stringify(f.engine.input.currentPoints);
      f.dispatch('pointerup', input.at(-1), 'pen', start + 1001);
      const dry = f.pixels(), serialized = JSON.stringify(f.engine.getDrawingData());
      const stroke = f.engine.drawing.getStrokes().at(-1);
      f.engine.setDrawingData(JSON.parse(serialized), 'reloaded'); const reopened = f.pixels();
      rows.push({ ...style, liveFinal: f.pixelDifference(wet, dry), savedReloaded: f.pixelDifference(dry, reopened),
        geometryExact: geometry === JSON.stringify(stroke.points), pressureExact: style.pressure || stroke.points.every(p => p.pressure === .5) });
    }
    return rows;
  });
  await writeFile(path.join(output, `${label}-appearance.json`), JSON.stringify(report.appearance, null, 2));
  for (const row of report.appearance) {
    assert.equal(row.geometryExact, true); assert.equal(row.pressureExact, true);
    assert.ok(row.savedReloaded.rms <= .8, `reopen pixels ${JSON.stringify(row)}`);
    // Wet pen uses an opacity group; antialiasing can differ on the group edge.
    assert.ok(row.liveFinal.rms <= .8, `live/final pixels ${JSON.stringify(row)}`);
    assert.ok(row.liveFinal.boundsDeltaPixels <= 1 && row.savedReloaded.boundsDeltaPixels <= 1, 'no cap/width/endpoint jump larger than one backing pixel');
  }
  pass(`${report.appearance.length} tool/nib/pattern/pressure cases: opacity/color/width retained, live/final/reopened pixel RMS <= .8/255`);

  report.zoomPixels = [];
  for (const zoom of [.5, 1, 2.28]) {
    const row = await page.evaluate(async zoom => {
      const f = window.inkFixture; f.configure(zoom, 100);
      const raw = f.fixture('circle', 24, zoom).raw, start = performance.now();
      raw.forEach((p, i) => f.dispatch(i ? 'pointermove' : 'pointerdown', p, 'pen', start + p.t));
      await f.frames(1); const wet = f.pixels();
      f.dispatch('pointerup', raw.at(-1), 'pen', start + 1001); const dry = f.pixels();
      f.engine.drawing.redraw(); const cached = f.pixels();
      const data = JSON.parse(JSON.stringify(f.engine.getDrawingData())); f.engine.setDrawingData(data, 'reopened');
      return { zoom, liveFinal: f.pixelDifference(wet, dry), cacheReplay: f.pixelDifference(dry, cached), savedReloaded: f.pixelDifference(dry, f.pixels()) };
    }, zoom);
    assert.ok(row.liveFinal.rms <= .8); assert.ok(row.cacheReplay.rms <= .8); assert.ok(row.savedReloaded.rms <= .8);
    report.zoomPixels.push(row);
    await page.evaluate(async zoom => {
      const f = window.inkFixture; f.configure(zoom, 100);
      for (const [j, kind] of ['straight', 'circle', 'word', 'zigzag'].entries()) {
        const input = f.fixture(kind, kind === 'circle' ? 24 : 120, zoom).raw.map(p => ({ ...p, y: p.y + j * 95 / zoom }));
        const start = performance.now(); input.forEach((p, i) => f.dispatch(i ? 'pointermove' : 'pointerdown', p, 'pen', start + p.t));
        f.dispatch('pointerup', input.at(-1), 'pen', start + 1001);
      }
      await f.frames(1);
    }, zoom);
    await page.screenshot({ path: path.join(output, `${label}-after-${zoom}.png`) });
  }
  pass('50/100/228% sparse-circle lift, cached redraw and reload pixel RMS <= .8/255');

  report.pdfCoordinates = await page.evaluate(() => {
    const f = window.inkFixture, rows = [];
    for (const zoom of f.zooms) for (const rotation of [0, 90, 180, 270]) {
      f.configure(zoom, 100);
      f.canvas.parentElement.style.transform = '';
      f.engine.viewport.setRenderTransform({ scale: true, pan: false });
      f.engine.viewport.setPageCoordinateTransform(rotation, 820, 600, 40, 60);
      f.engine.resize((rotation % 180 ? 600 : 820) * zoom, (rotation % 180 ? 820 : 600) * zoom);
      const input = f.fixture('pressure', 120, zoom).raw, start = performance.now();
      input.forEach((p, i) => f.dispatch(i ? 'pointermove' : 'pointerdown', p, 'pen', start + p.t));
      const physical = f.engine.input.inkRawPoints.map(p => ({ ...p }));
      f.dispatch('pointerup', input.at(-1), 'pen', start + 1001);
      const origin = f.engine.viewport.pageToCanvas(0, 0), axis = f.engine.viewport.pageToCanvas(1, 0), bounds = f.canvas.getBoundingClientRect();
      const cssScale = Math.hypot((axis.x - origin.x) * bounds.width / f.canvas.clientWidth, (axis.y - origin.y) * bounds.height / f.canvas.clientHeight);
      const expected = new f.InkInputFilter(), filtered = physical.map(p => expected.push(p, 100, cssScale));
      const stroke = f.engine.drawing.getStrokes().at(-1);
      rows.push({ zoom, rotation, cssScale, captureError: Math.max(...physical.map((p, i) => Math.hypot(p.x - input[i].x, p.y - input[i].y))),
        filteredEndpointsPresent: filtered.every(p => stroke.points.some(q => Math.hypot(p.x - q.x, p.y - q.y) < 1e-8 && p.t === q.t)) });
    }
    return rows;
  });
  await writeFile(path.join(output, `${label}-pdf-coordinates.json`), JSON.stringify(report.pdfCoordinates, null, 2));
  assert.ok(report.pdfCoordinates.every(r => r.captureError < 1e-8 && r.filteredEndpointsPresent), JSON.stringify(report.pdfCoordinates.filter(r => r.captureError >= 1e-8 || !r.filteredEndpointsPresent)));
  pass('28 PDF canvas zoom/rotation/Research Space transforms preserve source coordinates and the same CSS-pixel stabilization');

  report.exports = [];
  for (const family of [undefined, 'ballpoint', 'fountain', 'brush', 'felt']) {
    const row = await page.evaluate(async family => {
      const f = window.inkFixture; f.configure(1, 75); f.engine.tools.setInkFamily(family);
      const input = f.fixture('pressure').raw, start = performance.now();
      input.forEach((p, i) => f.dispatch(i ? 'pointermove' : 'pointerdown', p, 'pen', start + p.t));
      f.dispatch('pointerup', input.at(-1), 'pen', start + 1001);
      const exported = await f.exportPixels();
      return { family: family || 'classic', difference: f.pixelDifference(f.pixels(), exported.pixels), bytes: exported.bytes };
    }, family);
    await writeFile(path.join(output, `${label}-${row.family}.pdf`), Buffer.from(row.bytes));
    delete row.bytes; report.exports.push(row);
    assert.ok(row.difference.rms <= 1 && row.difference.boundsDeltaPixels <= 1, `actual PDF rasterization ${JSON.stringify(row)}`);
  }
  pass('five stabilized pressure-aware pen styles exported to real PDFs and rasterized: canvas/PDF pixel RMS <= 1/255');

  report.legacy = await page.evaluate(() => {
    const f = window.inkFixture; f.configure(1, 100);
    const old = { id: 'legacy', type: 'stroke', tool: 'pen', color: '#981b22', thickness: 2, opacity: 1, createdAt: 1, points: f.fixture('word').raw };
    f.engine.drawing.setStrokes([old]); const before = f.pixels(), points = JSON.stringify(old.points);
    const data = JSON.parse(JSON.stringify(f.engine.getDrawingData())); f.engine.setDrawingData(data, 'legacy');
    const loaded = f.engine.drawing.getStrokes()[0];
    return { geometryExact: points === JSON.stringify(loaded.points), centerlineAbsent: !loaded.centerline, pixels: f.pixelDifference(before, f.pixels()) };
  });
  assert.equal(report.legacy.geometryExact, true); assert.equal(report.legacy.centerlineAbsent, true); assert.equal(report.legacy.pixels.channels, 0);
  pass('legacy stroke coordinates and rendering remain unchanged; no saved-note reinterpretation');

  report.compatibility = await page.evaluate(async () => {
    const f = window.inkFixture, rows = [];
    for (const tool of ['pen', 'pencil', 'highlighter', 'marker']) {
      f.configure(1, 100); f.engine.tools.setDrawingTool(tool);
      const input = f.fixture('pressure').raw, start = performance.now();
      input.forEach((p, i) => f.dispatch(i ? 'pointermove' : 'pointerdown', p, 'pen', start + p.t));
      f.dispatch('pointerup', input.at(-1), 'pen', start + 1001);
      const e = f.engine;
      const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
      const get = () => canonical(e.drawing.getStrokes()), original = get();
      const body = e.drawing.getStrokes()[0].points.find(p => Math.abs(p.t - 250) < 1e-6);
      const hit = e.selection.selectAt(body.x, body.y);
      e.selection.startDrag(body.x, body.y); e.selection.dragTo(body.x + 20, body.y + 30); e.selection.finishDrag(body.x + 20, body.y + 30);
      const moved = get(); e.history.undo(); const moveUndo = get() === original; e.history.redo(); const moveRedo = get() === moved;
      e.selection.selectElement(e.drawing.getStrokes()[0].id, 'stroke');
      const selectedPoints = e.drawing.getStrokes()[0].points;
      const right = Math.max(...selectedPoints.map(p => p.x)) + 4, bottom = Math.max(...selectedPoints.map(p => p.y)) + 4;
      e.selection.startDrag(right, bottom); e.selection.dragTo(right + 20, bottom + 15); e.selection.finishDrag(right + 20, bottom + 15);
      const resized = get(); e.history.undo(); const resizeUndo = get() === moved; e.history.undo();
      e.selection.clearSelection();
      const loop = [[0, 30], [215, 30], [215, 90], [0, 90], [0, 30]].map(([x, y], t) => ({ x, y, pressure: .5, t }));
      const lasso = e.selection.selectWithinLoop(loop); e.selection.clearSelection();
      const beforeEraseOriginal = get() === original;
      const erasePoint = { ...e.drawing.getStrokes()[0].points.find(p => Math.abs(p.t - 500) < 1e-6) };
      const wholePoint = { ...e.drawing.getStrokes()[0].points.find(p => Math.abs(p.t - 100) < 1e-6) };
      e.tools.setMode('erase'); e.tools.setEraserMode('pixel'); e.tools.setThickness(12);
      f.dispatch('pointerdown', erasePoint);
      f.dispatch('pointerup', erasePoint);
      const cut = get(), partialErase = cut !== original && e.drawing.getStrokes().length > 0;
      const persisted = JSON.parse(JSON.stringify(e.getDrawingData()));
      e.history.undo(); const eraseUndo = get() === original; e.history.redo(); const eraseRedo = get() === cut;
      e.setDrawingData(persisted, 'clipped'); const partialReloaded = get() === cut;
      const beforeWhole = e.drawing.getStrokes().length;
      e.tools.setEraserMode('stroke');
      f.dispatch('pointerdown', wholePoint);
      f.dispatch('pointerup', wholePoint);
      const wholeErase = e.drawing.getStrokes().length === beforeWhole - 1; e.history.undo(); const wholeUndo = get() === cut;
      rows.push({ tool, hit, moved: moved !== original, moveUndo, moveRedo, resized: resized !== moved, resizeUndo,
        lasso: lasso === 1, beforeEraseOriginal, partialErase, eraseUndo, eraseRedo, partialReloaded, wholeErase, wholeUndo });
    }
    return rows;
  });
  await writeFile(path.join(output, `${label}-compatibility.json`), JSON.stringify(report.compatibility, null, 2));
  for (const row of report.compatibility) assert.ok(Object.entries(row).every(([key, value]) => key === 'tool' || value === true), JSON.stringify(row));
  pass('new stabilized Pen/Pencil/Highlighter/Marker strokes: hit/lasso, move/resize, pixel/stroke erasing, partial-erase persistence and exact Undo/Redo');

  report.ruler = await page.evaluate(() => {
    const f = window.inkFixture, rows = [];
    for (const zoom of f.zooms) for (const setting of f.settings) for (const angle of [0, Math.PI / 4, Math.PI / 2, -Math.PI / 3]) {
      f.configure(zoom, setting); const e = f.engine;
      e.tools.setRulerEnabled(true); e.ruler.setCenter(400, 300); e.ruler.setWidth(400); e.ruler.setAngle(angle, false);
      const state = e.ruler.getState(), edge = -state.height / 2;
      const toPage = (x, y, t) => ({ x: state.center.x + x * Math.cos(angle) - y * Math.sin(angle),
        y: state.center.y + x * Math.sin(angle) + y * Math.cos(angle), pressure: .5, t });
      const input = [[-120, edge - 8], [-40, edge - 4], [30, edge - 48], [-20, edge - 4]].map(([x, y], i) => toPage(x, y, i * 8));
      const expected = [[-120, edge], [-40, edge], [30, edge - 48], [-20, edge]].map(([x, y], i) => toPage(x, y, i * 8));
      const start = performance.now(); input.forEach((p, i) => f.dispatch(i ? 'pointermove' : 'pointerdown', p, 'pen', start + p.t));
      const live = JSON.stringify(e.input.currentPoints);
      f.dispatch('pointerup', input.at(-1), 'pen', start + 100);
      const points = e.drawing.getStrokes().at(-1).points;
      rows.push({ zoom, setting, angle, exact: points.length === expected.length && points.every((p, i) => Math.hypot(p.x - expected[i].x, p.y - expected[i].y) < 1e-8),
        liveFinal: live === JSON.stringify(points) });
    }
    f.configure(1, 100); f.engine.tools.setRulerEnabled(true); f.engine.ruler.setCenter(500, 400);
    const raw = f.fixture('straight').raw, start = performance.now();
    raw.forEach((p, i) => f.dispatch(i ? 'pointermove' : 'pointerdown', p, 'pen', start + p.t));
    const visible = f.engine.input.currentPoints;
    if (!visible.some(p => raw.some(q => p.t === q.t && Math.hypot(p.x - q.x, p.y - q.y) > .1))) throw new Error('freehand stabilization outside the ruler must remain active');
    f.dispatch('pointerup', raw.at(-1), 'pen', start + 1001);
    f.engine.tools.setRulerEnabled(false);
    return rows;
  });
  assert.ok(report.ruler.every(row => row.exact && row.liveFinal), JSON.stringify(report.ruler.filter(row => !row.exact || !row.liveFinal)));
  pass('140 ruler zoom/strength/rotation cases retain exact edge and entry/exit joins; freehand stabilization remains active away from the ruler');

  const cdp = await page.context().newCDPSession(page);
  report.native = [];
  for (const zoom of [.25, .5, .75, 1, 1.5, 2.28, 3]) for (const pointer of ['mouse', 'pen']) {
    await page.evaluate(zoom => window.inkFixture.configure(zoom, 100), zoom);
    const bounds = await page.locator('#ink').boundingBox();
    const x = bounds.x + 20, y = bounds.y + 60;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: pointer });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: pointer, force: .65 });
    for (let i = 1; i <= 30; i++) await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: x + i * 5, y: y + Math.sin(i * 2.37) * .8, button: 'left', buttons: 1, pointerType: pointer, force: .65 });
    await page.evaluate(() => window.inkFixture.frames(1));
    const before = await page.evaluate(() => JSON.stringify(window.inkFixture.engine.input.currentPoints));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 150, y: y + Math.sin(30 * 2.37) * .8, button: 'left', buttons: 0, clickCount: 1, pointerType: pointer });
    const row = await page.evaluate(() => {
      const f = window.inkFixture, trace = window.__panvasHandwritingTraces.at(-1);
      return { count: f.engine.drawing.getStrokes().length, outcome: trace.outcome, captured: trace.mapped.length,
        points: JSON.stringify(f.engine.drawing.getStrokes().at(-1).points), pressure: trace.mapped.map(p => p.pressure) };
    });
    assert.equal(row.count, 1); assert.equal(row.outcome, 'complete'); assert.equal(row.points, before);
    assert.ok(row.pressure.every(p => Math.abs(p - (pointer === 'mouse' ? .5 : .65)) < 1e-6));
    delete row.points; delete row.pressure; report.native.push({ zoom, pointer, ...row });
  }
  pass('14 Chromium input-dispatch mouse/pen strokes across all zooms retain ownership, native pressure and lift geometry');

  for (const setting of [0, 50, 100]) {
    await page.evaluate(async setting => {
      const f = window.inkFixture; f.configure(2.28, setting);
      for (const { points } of f.letters(1)) {
        const start = performance.now(); points.forEach((p, i) => f.dispatch(i ? 'pointermove' : 'pointerdown', p, 'pen', start + p.t));
        f.dispatch('pointerup', points.at(-1), 'pen', start + (points.at(-1).t || 0) + 1);
      }
      await f.frames(1);
    }, setting);
    await page.screenshot({ path: path.join(output, `${label}-synthetic-letters-${setting}.png`) });
  }
  pass('designed lowercase i/l/t/m/n/e/a/s/k fixture captured at 0/50/100%; physical legibility remains for owner verification');

  if (!quick) {
    report.sustained = await page.evaluate(async () => {
      const f = window.inkFixture; f.configure(1, 100);
      let redraws = 0, snapshots = 0;
      const redraw = f.engine.drawing.redraw.bind(f.engine.drawing), snapshot = f.engine.getDrawingData.bind(f.engine);
      f.engine.drawing.redraw = (...args) => { redraws++; return redraw(...args); };
      f.engine.getDrawingData = (...args) => { snapshots++; return snapshot(...args); };
      const input = f.fixture('word', 240, 1, true, 10000).raw;
      const start = performance.now(); f.dispatch('pointerdown', input[0], 'pen', start);
      let i = 1, frames = 0, largestBurst = 0, handlerMs = [];
      while (i < input.length) {
        await f.frames(1); frames++;
        const due = Math.min(input.length - 1, Math.floor((performance.now() - start) * .24));
        const begin = performance.now(), first = i;
        for (; i <= due; i++) {
          f.dispatch('pointerrawupdate', input[i], 'pen', start + input[i].t);
          f.dispatch('pointermove', input[i], 'pen', start + input[i].t);
        }
        handlerMs.push(performance.now() - begin); largestBurst = Math.max(largestBurst, i - first);
      }
      await f.frames(1); const live = JSON.stringify(f.engine.input.currentPoints);
      f.dispatch('pointerup', input.at(-1), 'pen', performance.now());
      const trace = window.__panvasHandwritingTraces.at(-1);
      const percentile = (a, p) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] || 0;
      return { physical: trace.normalized.length, output: trace.committed.length, duplicate: trace.counters.exactDuplicates,
        elapsedMs: performance.now() - start, frames, largestBurst, geometryExact: live === JSON.stringify(trace.committed),
        handlerP95Ms: percentile(handlerMs, .95), renderP95Ms: percentile(trace.timings.wetRenderMs || [], .95),
        eventToFrameP95Ms: percentile(trace.timings.eventToFrameMs || [], .95), frameDelayP95Ms: percentile(trace.timings.scheduledFrameDelayMs || [], .95),
        wetRebuilds: trace.counters.wetRebuilds || 0, renderFrames: trace.frames.length, redraws, snapshots };
    });
    assert.equal(report.sustained.physical, 2401); assert.equal(report.sustained.duplicate, 2400);
    assert.equal(report.sustained.geometryExact, true); assert.ok(report.sustained.handlerP95Ms < 8);
    assert.ok(report.sustained.renderP95Ms < 8); assert.ok(report.sustained.wetRebuilds <= 1);
    assert.equal(report.sustained.redraws, 0); assert.equal(report.sustained.snapshots, 0);
    pass('10-second synthetic 240 Hz stroke: raw/move overlap deduplicated, no dropped samples, handler/render p95 < 8ms, incremental wet ink');
  }

  if (!electronMode && !quick) {
    await page.goto(url + 'tests/fixtures/document-input.html?handwritingTrace=1');
    await page.waitForFunction(() => window.documentFixture?.engine()?.drawing.getCanvasElement());
    await page.evaluate(async () => {
      const { useLayoutStore } = await import('/src/stores/layoutStore.ts');
      const { useUIStore } = await import('/src/stores/uiStore.ts');
      const { createEmptyDrawingData } = await import('/src/components/notebook/engine/drawingTypes.ts');
      useLayoutStore.setState({ notebookModeLevel: 0, isToolbarCollapsed: false });
      useUIStore.setState({ isPropertiesPanelOpen: true });
      const f = window.documentFixture; f.engine().setDrawingData(createEmptyDrawingData(), f.ids.note);
    });
    await page.getByTitle('Pen (P)', { exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Pen settings', exact: true });
    const slider = dialog.locator('input[type=range][min="0"][max="100"]');
    await slider.focus(); await slider.press('Home');
    assert.equal(await page.evaluate(() => window.documentFixture.engine().tools.getState().stabilization), 0);
    await slider.press('End');
    assert.equal(await page.evaluate(() => window.documentFixture.engine().tools.getState().stabilization), 100);
    await page.screenshot({ path: path.join(output, `${label}-real-ui-slider.png`) });
    await page.getByRole('button', { name: 'Close Pen settings', exact: true }).click();
    report.realUI = [];
    for (const zoom of [.5, 1, 2.28]) {
      const before = await page.evaluate(async zoom => {
        const { createEmptyDrawingData } = await import('/src/components/notebook/engine/drawingTypes.ts');
        const f = window.documentFixture; f.engine().setDrawingData(createEmptyDrawingData(), f.ids.note);
        f.engine().viewport.setZoom(zoom);
        for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
        return window.__documentWork.report();
      }, zoom);
      const result = await page.evaluate(async zoom => {
        const { handwritingLetters } = await import('/tests/fixtures/inkQuality.ts');
        const e = window.documentFixture.engine(), c = e.drawing.getCanvasElement();
        let liveEqual = true;
        for (const { points } of handwritingLetters(zoom)) {
          const b = c.getBoundingClientRect(), start = performance.now();
          const emit = (type, point) => {
            const p = e.viewport.pageToCanvas(point.x + 90 / zoom, point.y + 240 / zoom);
            const event = new PointerEvent(type, { bubbles: true, pointerId: 314, pointerType: 'pen', button: type === 'pointerdown' ? 0 : -1,
              buttons: type === 'pointerup' ? 0 : 1, pressure: type === 'pointerup' ? 0 : .5,
              clientX: b.left + p.x * b.width / c.clientWidth, clientY: b.top + p.y * b.height / c.clientHeight });
            Object.defineProperty(event, 'timeStamp', { value: start + point.t }); c.dispatchEvent(event);
          };
          points.forEach((p, i) => emit(i ? 'pointermove' : 'pointerdown', p));
          await new Promise(requestAnimationFrame); const live = JSON.stringify(e.input.currentPoints);
          emit('pointerup', points.at(-1)); liveEqual &&= live === JSON.stringify(e.drawing.getStrokes().at(-1).points);
        }
        for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
        return { liveEqual, strokes: e.drawing.getStrokes().length, stabilization: e.tools.getState().stabilization, work: window.__documentWork.report() };
      }, zoom);
      assert.equal(result.liveEqual, true); assert.equal(result.stabilization, 100); assert.ok(result.strokes >= 9);
      report.realUI.push({ zoom, before, ...result });
      await page.screenshot({ path: path.join(output, `${label}-real-ui-${zoom}.png`) });
    }
    pass('actual React notebook toolbar slider controls 0/100%; live/committed synthetic letters captured in real UI at 50/100/228%');
  }

  assert.deepEqual(errors, []);
  report.passed = passed; report.errors = errors;
  await writeFile(path.join(output, `${label}-quality.json`), JSON.stringify(report, null, 2));
  console.log(`RESULT: ${passed} passed; 0 failed; synthetic ${label}. Evidence: ${output}`);
} finally {
  await app?.close(); await browser?.close(); await server.close();
}
