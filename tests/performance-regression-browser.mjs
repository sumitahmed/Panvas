import assert from 'node:assert/strict';
import { chromium, _electron } from 'playwright';
import { expect } from '@playwright/test';
import { preview, createServer } from 'vite';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';

const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const native = process.argv.includes('--electron');
const visibleNative = native && (!process.argv.includes('--checks-only') || process.argv.includes('--headful'));
const out = path.resolve(option('out') ?? 'artifacts/performance-regression-20261017/runtime');
await mkdir(out, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'panvas-performance-regression-'));
const evidence = { root, native, production: !!option('web-dir') || !!option('base') || native, scenarios: [], errors: [] };
let server, browser, app, page, session;
const installReactProbe = () => {
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject(renderer) { this.renderers.set(1, renderer); return 1; }, onCommitFiberUnmount() {}, onCommitFiberRoot() { if (window.regressionWork) window.regressionWork.reactCommits++; } };
};
const frames = (n = 3) => page.evaluate(async n => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); }, n);
const owner = () => page.evaluate(() => window.regressionEngine()?.getDrawingOwnership().pageId);
async function initializeProbe() {
  await page.evaluate(() => {
    window.regressionEngine = () => {
      if (window.__PANVAS_GATE0_ENGINE__?.getDrawingOwnership) return window.__PANVAS_GATE0_ENGINE__;
      for (const dom of document.querySelectorAll('[data-rendered-page-id], [data-page-id]')) {
        const key = Object.keys(dom).find(k => k.startsWith('__reactFiber$'));
        for (let fiber = dom?.[key]; fiber; fiber = fiber.return) {
          const engine = fiber.memoizedProps?.engine ?? fiber.memoizedProps?.notebookEngine;
          if (engine?.getDrawingOwnership) return engine;
        }
      }
    };
  });
}
async function sceneHash(stored = false) {
  return page.evaluate(async ({ workload, stored }) => {
    let data;
    const id = window.regressionEngine().getDrawingOwnership().pageId;
    if (!stored) data = window.regressionEngine().getDrawingData();
    else if (window.panvas) data = await window.panvas.notebook.loadDrawing(workload.workspaceId, workload.notebookId, id);
    else data = await new Promise((resolve, reject) => { const request = indexedDB.open('panvas'); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, get = db.transaction('notebookPageDrawings').objectStore('notebookPageDrawings').get(id); get.onsuccess = () => { db.close(); resolve(get.result?.data); }; get.onerror = () => reject(get.error); }; });
    const bytes = new TextEncoder().encode(JSON.stringify(data?.objects));
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  }, { workload: evidence.workload, stored });
}
async function resize(width, height = 1000) {
  if (native) await (await app.browserWindow(page)).evaluate((win, { width, height }) => win.setSize(width, height), { width, height });
  else await page.setViewportSize({ width, height });
}
async function openBook() {
  const toggle = page.getByRole('button', { name: 'Show library', exact: true });
  const row = page.getByRole('complementary').getByText('Performance regression', { exact: true });
  if (!await row.isVisible() && await toggle.isVisible()) await toggle.click();
  await row.click(); await initializeProbe(); await expect.poll(owner).toBeTruthy(); await frames(8);
}
async function measure(name, action) {
  await frames();
  await page.evaluate(() => {
    const engine = window.regressionEngine();
    window.__regressionLiveDrawing = engine.drawing;
    window.regressionWork = { frames: [], inputToFrame: [], longTasks: [], longTaskDetails: [], redraw: [], boundaries: {}, methods: {}, surface: [], replayedStrokes: 0, staticReplayedStrokes: 0, staticRedraws: [], laserPoints: 0, reactCommits: 0 };
    const work = window.regressionWork;
    const drawingProto = Object.getPrototypeOf(engine.drawing);
    if (!drawingProto.__regressionSurfaceProbed) {
      drawingProto.__regressionSurfaceProbed = true;
      const wrapSurface = (name, record) => {
        const original = drawingProto[name];
        if (typeof original !== 'function') return;
        drawingProto[name] = function (...args) {
          const result = original.apply(this, args);
          const current = window.regressionWork;
          if (current) (current.surface ??= []).push(record(this, args, result));
          return result;
        };
      };
      const dimensions = target => [target?.canvas?.width ?? 0, target?.canvas?.height ?? 0, target?.layerCanvases?.size ?? 0];
      wrapSurface('copySurfacesTo', (self, args, result) => ({ op: 'copy', ok: result, source: dimensions(self), target: dimensions(args[0]) }));
      wrapSurface('adoptPendingSurface', (self, _args, result) => ({
        op: 'adopt',
        ok: result,
        deferred: self.isSurfaceAdoptionDeferred?.() ?? false,
        target: dimensions(self),
      }));
      wrapSurface('prepareSurfaceAdoption', (self, args) => ({
        op: 'prepare',
        source: dimensions(args[0]),
        target: dimensions(self),
        current: args[0] ? args[0].isSurfaceCurrent(args[1]) : false,
        keyed: args[1] !== undefined,
      }));
      wrapSurface('markSurfaceCurrent', (self, args) => ({ op: 'mark', target: dimensions(self), keyed: args[0] !== undefined }));
      const wrapProto = (name, record) => {
        const original = drawingProto[name];
        if (typeof original !== 'function') return;
        drawingProto[name] = function (...args) {
          const result = original.apply(this, args);
          const current = window.regressionWork;
          if (current) record(this, args, result, current);
          return result;
        };
      };
      wrapProto('redraw', (self, _args, _result, current) => {
        // Timing is added by the wrapper below so the live engine keeps its
        // historical `redraw` sample while static preview paints are captured
        // separately.
      });
      const redraw = drawingProto.redraw;
      drawingProto.redraw = function (...args) {
        const t = performance.now();
        try { return redraw.apply(this, args); }
        finally {
          const current = window.regressionWork;
          if (current) {
            const ms = performance.now() - t;
            const live = this === window.__regressionLiveDrawing;
            current.staticRedraws.push({ live, strokes: this.strokes?.length ?? 0, ms });
            if (live) current.redraw.push(ms);
          }
        }
      };
      wrapProto('renderStroke', (self, _args, _result, current) => {
        if (self === window.__regressionLiveDrawing) current.replayedStrokes++;
        else current.staticReplayedStrokes++;
      });
    }
    const timeMethod = (target, method) => {
      const original = target[method];
      if (typeof original !== 'function') return;
      target[method] = function (...args) {
        const t = performance.now();
        try { return original.apply(this, args); }
        finally { if (window.regressionWork) (window.regressionWork.methods[method] ??= []).push(performance.now() - t); }
      };
    };
    if (!engine.drawing.__regressionWrapped) {
      engine.drawing.__regressionWrapped = true;
      const add = engine.laser.addPoint;
      engine.laser.addPoint = function (...args) { if (window.regressionWork) window.regressionWork.laserPoints++; return add.apply(this, args); };
      for (const method of ['setDrawingData', 'getDrawingData', 'mount', 'unmount']) {
        const original = engine[method];
        engine[method] = function (...args) { const t = performance.now(); try { return original.apply(this, args); } finally { if (window.regressionWork) (window.regressionWork.boundaries[method] ??= []).push(performance.now() - t); } };
      }
      for (const method of ['selectAt', 'hitTest', 'startDrag', 'dragTo', 'finishDrag', 'getHandleAt', 'getBoundingBox', 'renderSelection']) timeMethod(engine.selection, method);
      for (const method of ['beginSelectionDrag', 'endSelectionDrag', 'renderTransformingStroke', 'renderSceneToContext', 'findStrokesNearPoint']) timeMethod(engine.drawing, method);
    }
    let last, pending = false, eventTime;
    const tick = t => { if (window.regressionWork !== work) return; if (last !== undefined) work.frames.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.regressionPointerListener = e => { if (!(e.target instanceof HTMLCanvasElement)) return; eventTime = e.timeStamp; if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; work.inputToFrame.push(performance.now() - eventTime); }); } };
    document.addEventListener('pointermove', window.regressionPointerListener, true);
    window.regressionObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        work.longTasks.push(entry.duration);
        work.longTaskDetails.push({ duration: entry.duration, startTime: entry.startTime, name: entry.name, attribution: entry.attribution?.map(a => ({ name: a.name, containerType: a.containerType, containerId: a.containerId, containerName: a.containerName, containerSrc: a.containerSrc })) ?? [] });
      }
    });
    window.regressionObserver.observe({ type: 'longtask', buffered: false });
    try {
      window.regressionLoafObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) (work.loaf ??= []).push({ duration: entry.duration, startTime: entry.startTime, blockingDuration: entry.blockingDuration, renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart, scripts: entry.scripts?.map(s => ({ duration: s.duration, invoker: s.invoker, invokerType: s.invokerType, sourceFunctionName: s.sourceFunctionName, sourceURL: s.sourceURL, sourceCharPosition: s.sourceCharPosition })) ?? [] });
      });
      window.regressionLoafObserver.observe({ type: 'long-animation-frame', buffered: false });
    } catch { /* LoAF is not available in every Chromium build. */ }
  });
  if (process.argv.includes('--profile')) await session.send('Profiler.start');
  const traceThis = process.argv.includes('--trace') && name === (option('trace-name') ?? 'selection-drag-1');
  let traceEvents = [];
  let traceComplete;
  if (traceThis) {
    session.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value));
    traceComplete = new Promise(resolve => session.once('Tracing.tracingComplete', resolve));
    await session.send('Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,cc,gpu,viz,benchmark',
      transferMode: 'ReportEvents',
    });
  }
  const started = performance.now(); await action(); await frames(5);
  const result = await page.evaluate(() => { document.removeEventListener('pointermove', window.regressionPointerListener, true); window.regressionObserver.disconnect(); window.regressionLoafObserver?.disconnect(); const result = window.regressionWork; window.regressionWork = null; return result; });
  const summarize = values => { const a = [...values].sort((a, b) => a - b); return { count: a.length, p50: a[Math.floor(a.length * .5)] ?? 0, p95: a[Math.floor(a.length * .95)] ?? 0, p99: a[Math.floor(a.length * .99)] ?? 0, max: a.at(-1) ?? 0, total: a.reduce((s, n) => s + n, 0) }; };
  if (process.argv.includes('--profile')) { const { profile } = await session.send('Profiler.stop'); await writeFile(path.join(out, `${name}.cpuprofile`), JSON.stringify(profile)); }
  if (traceThis) {
    await session.send('Tracing.end');
    await traceComplete;
    await writeFile(path.join(out, `${name}.trace.json`), JSON.stringify(traceEvents));
    traceEvents = [];
  }
  const methodSummaries = Object.fromEntries(Object.entries(result.methods ?? {}).map(([k, v]) => [k, summarize(v)]));
  const staticRedrawSummary = summarize((result.staticRedraws ?? []).filter(r => !r.live).map(r => r.ms));
  const liveRedrawSummary = summarize((result.staticRedraws ?? []).filter(r => r.live).map(r => r.ms));
  const staticRedrawDetails = (result.staticRedraws ?? []).filter(r => !r.live).map(r => ({ strokes: r.strokes, ms: r.ms }));
  const surface = (result.surface ?? []).reduce((counts, entry) => {
    // A preview that is still painting is a deferred handoff, not a failed
    // one. The follow-up copy event proves whether its pixels arrived.
    const key = entry.op === 'adopt' && entry.deferred
      ? 'adopt:deferred'
      : `${entry.op}:${entry.ok === undefined ? (entry.current ? 'current' : 'stale') : entry.ok ? 'ok' : 'fail'}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  evidence.scenarios.push({ name, elapsedMs: performance.now() - started, ...result, staticRedrawSummary, liveRedrawSummary, staticRedrawDetails, surface, surfaceEvents: result.surface, summary: Object.fromEntries(['frames', 'inputToFrame', 'longTasks', 'redraw'].map(k => [k, summarize(result[k])])), methodSummaries });
  console.log(name, JSON.stringify(evidence.scenarios.at(-1).summary), 'replayed', result.replayedStrokes, 'staticReplayed', result.staticReplayedStrokes, 'staticRedraw', JSON.stringify(staticRedrawSummary), 'surface', JSON.stringify(surface));
}
async function drag(duration = 2200) {
  const b = await page.locator('[data-focused-sheet="true"] canvas[data-rendered-page-id]').boundingBox();
  assert.ok(b); const viewport = await page.locator('.notebook-viewport').boundingBox();
  const x = Math.max(b.x, viewport.x) + 80, y = Math.max(b.y, viewport.y) + 220;
  const before = await page.evaluate(({ x, y }) => {
    const e = window.regressionEngine(), c = e.drawing.getCanvasElement(), r = c.getBoundingClientRect();
    return { owner: e.getDrawingOwnership().pageId, count: e.drawing.getStrokes().length, tool: e.tools.getState(),
      target: document.elementFromPoint(x, y) === c,
      point: e.viewport.canvasToPage((x - r.left) * c.clientWidth / r.width, (y - r.top) * c.clientHeight / r.height) };
  }, { x, y });
  assert.ok(before.target, 'The injected gesture starts on the real interaction canvas');
  const base = { pointerType: 'mouse', button: 'left', clickCount: 1 };
  await session.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', x, y, buttons: 1 });
  const pending = [], start = performance.now();
  for (let i = 0; performance.now() - start < duration; i++) {
    const t = (performance.now() - start) / duration;
    pending.push(session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', x: x + 300 * t, y: y + Math.sin(t * 30) * 90, buttons: 1 }));
    await new Promise(resolve => setTimeout(resolve, 8));
  }
  await Promise.all(pending);
  await session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', x: x + 300, y, buttons: 0 });
  if (before.tool.mode === 'draw' && before.tool.drawingTool === 'pen') {
    const after = await page.evaluate(() => { const e = window.regressionEngine(); return { owner: e.getDrawingOwnership().pageId, count: e.drawing.getStrokes().length, first: e.drawing.getStrokes().at(-1)?.points[0] }; });
    (evidence.gestures ??= []).push({ before, after });
    assert.equal(after.owner, before.owner, 'Drawing retains its page owner');
    assert.equal(after.count, before.count + 1, 'One controlled gesture creates one stroke');
    assert.ok(Math.hypot(after.first.x - before.point.x, after.first.y - before.point.y) < .01, 'Pointer-to-page mapping stays exact');
  }
}
async function mobilePan() {
  await page.getByTitle('Hand (Space)', { exact: true }).click();
  const viewport = page.locator('.notebook-viewport');
  const b = await viewport.boundingBox();
  const x = b.x + Math.min(160, b.width / 2), y = b.y + 210;
  const startingScale = await page.evaluate(() => window.regressionEngine().viewport.getState().scale);
  await page.evaluate(() => {
    window.regressionZoom = [];
    window.regressionZoomStop = window.regressionEngine().viewport.subscribe(s => { const v = document.querySelector('.notebook-viewport'); window.regressionZoom.push({ scale: s.scale, width: v.clientWidth, height: v.clientHeight }); });
    window.regressionWheels = [];
    window.regressionWheelListener = e => window.regressionWheels.push({ ctrl: e.ctrlKey, trusted: e.isTrusted, prevented: e.defaultPrevented, x: e.clientX, y: e.clientY });
    document.addEventListener('wheel', window.regressionWheelListener);
  });
  await page.mouse.move(x, y);
  // Actual wheel zoom establishes room to pan on both axes.
  for (let i = 0; i < 12; i++) { await session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -100, modifiers: 2 }); await frames(1); }
  await frames(20);
  await page.evaluate(() => { const v = document.querySelector('.notebook-viewport'); v.scrollLeft = 90; v.scrollTop = 140; }); await frames(4);
  const anchor = await page.evaluate(() => { const v = document.querySelector('.notebook-viewport'); return { left: v.scrollLeft, top: v.scrollTop, scale: window.regressionEngine().viewport.getState().scale }; });
  const samples = [];
  const panStart = await page.evaluate(() => ({ commits: window.regressionWork.reactCommits, frame: window.regressionWork.frames.length }));
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 11, x, y }] });
  for (let i = 1; i <= 50; i++) {
    const dx = Math.sin(i / 8) * 80, dy = -Math.sin(i / 12) * 120;
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 11, x: x + dx, y: y + dy }] }); await frames(1);
    samples.push(await page.evaluate(({ anchor, dx, dy }) => { const v = document.querySelector('.notebook-viewport'); return { x: v.scrollLeft, y: v.scrollTop, expectedX: Math.max(0, Math.min(v.scrollWidth - v.clientWidth, anchor.left - dx)), expectedY: Math.max(0, Math.min(v.scrollHeight - v.clientHeight, anchor.top - dy)), scale: window.regressionEngine().viewport.getState().scale, owner: window.regressionEngine().getDrawingOwnership().pageId }; }, { anchor, dx, dy }));
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await frames(4);
  evidence.touchPan = { anchor, samples, maxError: Math.max(...samples.flatMap(s => [Math.abs(s.x - s.expectedX), Math.abs(s.y - s.expectedY)])), zoom: await page.evaluate(() => { window.regressionZoomStop(); document.removeEventListener('wheel', window.regressionWheelListener); return { changes: window.regressionZoom, wheels: window.regressionWheels, visual: { scale: visualViewport.scale, width: visualViewport.width, innerWidth } }; }) };
  evidence.touchPan.zoom.expectedScale = Math.min(4, startingScale * 1.1 ** 12);
  evidence.touchPan.zoom.actualScale = anchor.scale;
  evidence.touchPan.reactCommitsDuringPan = await page.evaluate(start => window.regressionWork.reactCommits - start.commits, panStart);
  assert.ok(Math.abs(anchor.scale - evidence.touchPan.zoom.expectedScale) < .001, 'User zoom must survive scrollbar appearance; panning must have real scroll range');
  assert.ok(evidence.touchPan.maxError < 1, 'Touch pan follows the finger without position feedback');
  assert.ok(evidence.touchPan.reactCommitsDuringPan <= 2, 'Hand movement does not repeatedly commit React');
  console.log('TOUCH PAN', JSON.stringify({ maxError: evidence.touchPan.maxError, scaleChanges: new Set(samples.map(s => s.scale)).size }));
}
async function touchPinchAndCancel() {
  const b = await page.locator('.notebook-viewport').boundingBox();
  const center = { x: b.x + 195, y: b.y + 280 };
  const point = async () => page.evaluate(center => { const engine = window.regressionEngine(), dom = document.querySelector(`[data-page-id="${engine.getDrawingOwnership().pageId}"][data-page-index]`), box = dom.getBoundingClientRect(), scale = engine.viewport.getState().scale; return { x: (center.x - box.left) / scale, y: (center.y - box.top) / scale, scale, owner: engine.getDrawingOwnership().pageId }; }, center);
  const before = await point();
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 21, x: center.x - 45, y: center.y }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 21, x: center.x - 45, y: center.y }, { id: 22, x: center.x + 45, y: center.y }] });
  for (let i = 1; i <= 24; i++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 21, x: center.x - 45 - i, y: center.y }, { id: 22, x: center.x + 45 + i, y: center.y }] }); await frames(1);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await frames(8);
  const after = await point();
  const drift = Math.hypot(after.x - before.x, after.y - before.y) * after.scale;
  assert.equal(after.owner, before.owner); assert.ok(after.scale > before.scale * 1.45);
  assert.ok(drift < 1.5, `Pinch retains its document anchor: ${drift}`);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 31, x: center.x, y: center.y }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 31, x: center.x - 25, y: center.y - 40 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await frames(4);
  assert.equal(await page.evaluate(() => window.regressionEngine().input.navigationGestures.active), false);
  evidence.pinch = { before, after, anchorDriftCssPx: drift, trustedTouch: true, cancellationReleased: true };
  console.log('PINCH', JSON.stringify(evidence.pinch));
}
async function notebookResizes() {
  const samples = [];
  for (let round = 0; round < 2; round++) for (const width of [634, 590, 620, 390, 980, 634]) {
    await resize(width, 1000); await frames(20);
    const positions = await page.evaluate(async () => {
      const positions = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(requestAnimationFrame);
        const page = document.querySelector('[data-focused-sheet="true"][data-page-index]'), box = page.getBoundingClientRect();
        positions.push({ left: box.left, top: box.top, width: box.width, scale: window.regressionEngine().viewport.getState().scale });
      }
      return positions;
    });
    for (const key of ['left', 'top', 'width']) assert.ok(Math.max(...positions.map(p => p[key])) - Math.min(...positions.map(p => p[key])) < .5, `Page position settles after resize: ${width}/${key}`);
    samples.push({ width, positions });
  }
  evidence.viewportTransitions = { count: samples.length, samples };
}
async function extendedUsage() {
  const pages = evidence.workload.pages;
  assert.ok(pages.length >= 8, '--extended requires --large');
  const group = await page.getByRole('treeitem', { name: 'Performance regression', exact: true }).getAttribute('aria-owns');
  const expandSection = page.locator(`[id="${group}"]`).getByRole('button', { name: 'Expand Section 1', exact: true });
  if (await expandSection.isVisible()) await expandSection.click();
  const metrics = async () => { await session.send('HeapProfiler.collectGarbage'); const m = await session.send('Performance.getMetrics'); return { heap: m.metrics.find(m => m.name === 'JSHeapUsedSize').value, dom: await session.send('Memory.getDOMCounters') }; };
  const visit = async index => {
    await page.locator(`[data-tree-id="${pages[index]}"]`).click();
    await expect.poll(owner).toBe(pages[index]);
    await page.locator(`canvas[data-rendered-page-id="${pages[index]}"][data-render-ready="true"]`).waitFor({ state: 'visible' }); await frames(4);
  };
  const navigation = [];
  await measure('navigation-warmup', async () => { for (let i = 0; i < 8; i++) { const start = performance.now(); await visit(i); navigation.push({ page: i, elapsedMs: performance.now() - start }); } });
  if (process.argv.includes('--navigation-only')) {
    await measure('navigation-repeat', async () => { for (let i = 0; i < 16; i++) await visit(i % 8); });
    await measure('navigation-cached-pair', async () => { for (let i = 0; i < 16; i++) await visit(i % 2 ? 6 : 7); });
    evidence.navigation = navigation; return;
  }
  await visit(0); const before = await metrics(); const checkpoints = [];
  const started = performance.now();
  await measure('extended-editing-with-assertions', async () => {
    for (let i = 0; i < 24; i++) {
      await visit(i % 8);
      await page.getByTitle('Pen (P)', { exact: true }).click(); await page.keyboard.press('Escape'); await drag(800);
      await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click(); await page.getByTitle('Redo (Ctrl+Y)', { exact: true }).click();
      const hash = await sceneHash(); await expect.poll(() => sceneHash(true), { timeout: 30000, intervals: [300, 500] }).toBe(hash);
      if (i % 8 === 7) checkpoints.push({ edits: i + 1, ...await metrics() });
    }
  });
  await visit(0); const after = await metrics();
  evidence.extended = { seconds: (performance.now() - started) / 1000, durableCheckpoints: 24, navigation, before, checkpoints, after, accelerated: true, timingIncludesAssertionsAndExplicitGC: true };
  // The first edit on each page initializes its immutable save snapshot and
  // fingerprint. Compare repeated passes after those per-page caches are warm.
  assert.ok(after.heap < checkpoints[0].heap * 1.2 + 16_000_000, 'Repeated editing retains bounded heap after per-page save caches warm');
  assert.ok(after.dom.jsEventListeners < checkpoints[0].dom.jsEventListeners + 60, 'Navigation does not accumulate gesture listeners');
  console.log('EXTENDED', JSON.stringify(evidence.extended));
}
async function memoryProbe() {
  const heap = async () => { await session.send('HeapProfiler.collectGarbage'); return (await session.send('Performance.getMetrics')).metrics.find(m => m.name === 'JSHeapUsedSize').value; };
  const samples = [{ phase: 'start', heap: await heap() }];
  for (const stored of [false, true]) {
    for (let i = 0; i < 12; i++) await sceneHash(stored);
    samples.push({ phase: stored ? 'stored-reads' : 'engine-reads', heap: await heap() });
  }
  await page.getByTitle('Pen (P)', { exact: true }).click(); await page.keyboard.press('Escape');
  for (let i = 0; i < 12; i++) {
    if (process.argv.includes('--navigate')) {
      const index = i % evidence.workload.pages.length;
      await page.locator(`[data-tree-id="${evidence.workload.pages[index]}"]`).click();
      await expect.poll(owner).toBe(evidence.workload.pages[index]); await frames(5);
    }
    await drag(100); const h = await sceneHash(); await expect.poll(() => sceneHash(true), { timeout: 30000, intervals: [500] }).toBe(h);
    if (i % 4 === 3) samples.push({ phase: `edits-${i + 1}`, heap: await heap() });
  }
  evidence.memoryProbe = samples; console.log('MEMORY PROBE', JSON.stringify(samples));
  if (process.argv.includes('--heap-snapshot')) {
    const file = path.join(root, 'retainers.heapsnapshot'), stream = createWriteStream(file);
    const chunk = ({ chunk }) => stream.write(chunk);
    session.on('HeapProfiler.addHeapSnapshotChunk', chunk);
    await session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    session.off('HeapProfiler.addHeapSnapshotChunk', chunk);
    await new Promise((resolve, reject) => { stream.once('error', reject); stream.end(resolve); });
    evidence.heapSnapshot = file; console.log('HEAP SNAPSHOT', file);
  }
}
async function canvasTransitions() {
  const showLibrary = async () => { const show = page.getByRole('button', { name: 'Show library', exact: true }); if (await show.isVisible()) await show.click(); };
  const reopen = async () => { await showLibrary(); await page.getByRole('complementary').getByText('Welcome Canvas', { exact: true }).click(); await page.locator('.excalidraw canvas').first().waitFor({ state: 'visible' }); await frames(4); };
  const timings = [];
  for (let i = 0; i < 4; i++) {
    const start = performance.now(); await reopen(); timings.push({ cold: i === 0, elapsedMs: performance.now() - start });
    await page.evaluate(() => { window.regressionCanvasNode = document.querySelector('.excalidraw'); });
    for (const width of [634, 590, 620, 390, 980, 634]) {
      await resize(width); await frames(6);
      assert.equal(await page.evaluate(() => document.querySelector('.excalidraw') === window.regressionCanvasNode), true, 'Resize must retain the mounted canvas editor');
      await expect(page.getByText('Loading canvas...', { exact: true })).toHaveCount(0);
    }
    await resize(1580, 1062); await frames(4); await openBook();
  }
  evidence.canvasLoading = { timings, retainedAcrossResizes: 24 };
  console.log('CANVAS LOADING', JSON.stringify(evidence.canvasLoading));
}
async function toolChecks() {
  const initial = await sceneHash();
  const point = await page.evaluate(() => {
    const engine = window.regressionEngine(), canvas = engine.drawing.getCanvasElement(), b = canvas.getBoundingClientRect();
    const p = engine.viewport.pageToCanvas(720, 240);
    return { x: b.left + p.x * b.width / canvas.clientWidth, y: b.top + p.y * b.height / canvas.clientHeight };
  });
  await page.getByRole('button', { name: 'More Tools', exact: true }).click(); await page.getByTitle('Laser Pointer', { exact: true }).click();
  await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 18, point.y + 25, { steps: 3 }); await frames(2);
  await expect(page.locator('[data-panvas-laser-overlay]')).toHaveCount(1);
  evidence.visibleLaser = await page.locator('[data-panvas-laser-overlay]').evaluate((canvas, point) => {
    const b = canvas.getBoundingClientRect(), x = Math.round((point.x + 18 - b.left) * canvas.width / b.width), y = Math.round((point.y + 25 - b.top) * canvas.height / b.height);
    return { head: [...canvas.getContext('2d').getImageData(x, y, 1, 1).data], width: canvas.width, height: canvas.height };
  }, point);
  assert.ok(evidence.visibleLaser.head[3] > 100, 'Laser head appears at the actual pointer, with the same page/DPR transform');
  await page.screenshot({ path: path.join(out, 'laser-visible.png') }); await page.mouse.up(); await page.waitForTimeout(1200);
  await expect(page.locator('[data-panvas-laser-overlay]')).toHaveCount(0); assert.equal(await sceneHash(), initial);
  await page.getByTitle('Pen (P)', { exact: true }).click();
  await page.keyboard.press('Escape'); // Close settings before using the exposed quick swatch.
  await page.getByRole('button', { name: 'Pen color #2563eb', exact: true }).click(); await page.keyboard.press('Escape');
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  for (let i = 1; i <= 24; i++) { await page.mouse.move(point.x + i, point.y + Math.sin(i / 4) * 20); await frames(1); }
  await page.mouse.up(); await frames(3);
  const stroke = await page.evaluate(() => window.regressionEngine().drawing.getStrokes().at(-1));
  assert.equal(stroke.color.toLowerCase(), '#2563eb'); assert.ok(stroke.points.length >= 24);
  assert.ok(Math.hypot(stroke.points[0].x - 720, stroke.points[0].y - 240) < .01, 'Actual pointer coordinates map to the intended page point');
  const ink = await sceneHash();
  await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click(); assert.equal(await sceneHash(), initial);
  await page.getByTitle('Redo (Ctrl+Y)', { exact: true }).click(); assert.equal(await sceneHash(), ink);
  await page.getByTitle('Select (V)', { exact: true }).click();
  await page.mouse.click(point.x + 10, point.y + Math.sin(10 / 4) * 20);
  assert.ok(await page.evaluate(id => window.regressionEngine().selection.getSelectedElements().some(e => e.id === id), stroke.id), 'Actual selection tool hits the new stroke');
  await page.getByTitle('Eraser (E)', { exact: true }).click();
  await page.getByRole('button', { name: 'Stroke', exact: true }).click(); await page.keyboard.press('Escape');
  await page.mouse.click(point.x + 10, point.y + Math.sin(10 / 4) * 20); await frames(3);
  assert.equal(await sceneHash(), initial, 'Stroke eraser removes exactly the isolated new ink');
  await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click(); assert.equal(await sceneHash(), ink);
  await page.getByTitle('Redo (Ctrl+Y)', { exact: true }).click(); assert.equal(await sceneHash(), initial);
  await expect.poll(() => sceneHash(true), { timeout: 30000 }).toBe(initial);
  await page.reload(); await page.getByRole('button', { name: 'New item', exact: true }).waitFor(); await openBook(); assert.equal(await sceneHash(), initial);
  evidence.toolChecks = { actualToolbarAndPointer: true, bluePen: true, coordinatesExact: true, selection: true, strokeErase: true, exactUndoRedo: true, exactReopen: true };
}
async function runSelectionDrag(name, all = false) {
  const selectBtn = page.getByTitle('Select (V)', { exact: true });
  if (await selectBtn.isVisible()) {
    await selectBtn.click();
    await frames(2);
  }
  if (all) { await page.keyboard.press('Control+A'); await frames(2); }
  const target = await page.evaluate(({ all }) => {
    const engine = window.regressionEngine(), canvas = engine.drawing.getCanvasElement(), r = canvas.getBoundingClientRect();
    const strokes = engine.drawing.getStrokes();
    const stroke = all ? strokes[0] : strokes[Math.floor(strokes.length * .5)];
    const point = stroke.points[Math.floor(stroke.points.length / 2)];
    const p = engine.viewport.pageToCanvas(point.x, point.y);
    return {
      id: stroke.id,
      x: r.left + p.x * r.width / canvas.clientWidth,
      y: r.top + p.y * r.height / canvas.clientHeight,
      before: stroke.points.map(({ x, y, pressure, t }) => ({ x, y, pressure, t })),
      beforeInkClip: stroke.inkClip ? structuredClone(stroke.inkClip) : null,
      owner: engine.getDrawingOwnership().pageId,
      selectedCount: engine.selection.getSelectedElements().length,
    };
  }, { all });
  const targetIsCanvas = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === window.regressionEngine().drawing.getCanvasElement(), target);
  assert.ok(targetIsCanvas, 'Selection gesture starts on the real interaction canvas');
  if (!all) {
    await session.send('Input.dispatchMouseEvent', { pointerType: 'mouse', button: 'left', clickCount: 1, type: 'mousePressed', x: target.x, y: target.y, buttons: 1 });
    await session.send('Input.dispatchMouseEvent', { pointerType: 'mouse', button: 'left', clickCount: 1, type: 'mouseReleased', x: target.x, y: target.y, buttons: 0 });
    await frames(4);
  }
  await page.evaluate(() => {
    window.regressionGestureLatency = {};
    document.addEventListener('pointerdown', () => {
      const downAt = performance.now();
      requestAnimationFrame(() => { window.regressionGestureLatency.downToFrame = performance.now() - downAt; });
    }, { capture: true, once: true });
    document.addEventListener('pointerup', () => {
      const upAt = performance.now();
      requestAnimationFrame(() => { window.regressionGestureLatency.upToFrame = performance.now() - upAt; });
    }, { capture: true, once: true });
  });
  const base = { pointerType: 'mouse', button: 'left', clickCount: 1 };
  const duration = 1400, dx = 170, dy = 55;
  await measure(name, async () => {
    await session.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', x: target.x, y: target.y, buttons: 1 });
    const pending = [], start = performance.now();
    for (let i = 0; performance.now() - start < duration; i++) {
      const t = (performance.now() - start) / duration;
      pending.push(session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', x: target.x + dx * t, y: target.y + dy * t, buttons: 1 }));
      await new Promise(resolve => setTimeout(resolve, 8));
    }
    await Promise.all(pending);
    await session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', x: target.x + dx, y: target.y + dy, buttons: 0 });
    await frames(4);
  });
  const after = await page.evaluate(({ id, owner }) => {
    const engine = window.regressionEngine();
    const stroke = engine.drawing.getStrokes().find(s => s.id === id);
    return {
      owner: engine.getDrawingOwnership().pageId,
      selected: engine.selection.getSelectedElements().some(e => e.id === id),
      points: stroke?.points.map(({ x, y, pressure, t }) => ({ x, y, pressure, t })),
      inkClip: stroke?.inkClip ? structuredClone(stroke.inkClip) : null,
      latency: window.regressionGestureLatency,
    };
  }, target);
  assert.equal(after.owner, target.owner, 'Selection drag retains page ownership');
  assert.ok(after.selected, 'The dragged stroke remains selected');
  assert.ok(after.points?.length === target.before.length, 'Selection drag preserves the exact point count');
  const moved = Math.hypot(after.points[0].x - target.before[0].x, after.points[0].y - target.before[0].y);
  assert.ok(moved > 1, 'Selection drag moves canonical stroke geometry');
  assert.ok(after.points.every((p, i) => p.pressure === target.before[i].pressure && p.t === target.before[i].t), 'Selection drag preserves pressure and timestamps');
  evidence.selectionDrag = { targetId: target.id, moved, latency: after.latency, before: target.before.length, after: after.points.length };
  await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click(); await frames(3);
  const undone = await page.evaluate(({ id }) => {
    const stroke = window.regressionEngine().drawing.getStrokes().find(s => s.id === id);
    return { points: stroke?.points.map(({ x, y, pressure, t }) => ({ x, y, pressure, t })), inkClip: stroke?.inkClip ? structuredClone(stroke.inkClip) : null };
  }, target);
  assert.deepEqual(undone.points, target.before, 'Undo restores every dragged point exactly');
  assert.deepEqual(undone.inkClip, target.beforeInkClip, 'Undo restores the original ink clip exactly');
  evidence.selectionDrag.undoExact = true;
}

async function selectionDrag(all = false) {
  return runSelectionDrag('selection-drag', all);
}
async function scrollNotebook() {
  await page.evaluate(() => {
    const engine = window.regressionEngine(), viewport = document.querySelector('.notebook-viewport');
    viewport.scrollTop = 0;
    window.regressionScrollSamples = [];
    window.regressionScrollActive = true;
    let frameCount = 0;
    let lastDominant = null;
    const tick = () => {
      if (!window.regressionScrollActive) return;
      frameCount++;
      if (frameCount % 6 === 1 || !lastDominant) {
        const rect = viewport.getBoundingClientRect();
        lastDominant = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          ?.closest('[data-page-id]')?.getAttribute('data-page-id') ?? lastDominant;
      }
      window.regressionScrollSamples.push({ t: performance.now(), top: viewport.scrollTop, owner: engine.getDrawingOwnership().pageId, active: engine.getWorkspaceStore?.()?.activePageId, dominant: lastDominant });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await frames(4);
  const box = await page.locator('.notebook-viewport').boundingBox();
  assert.ok(box);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const range = await page.evaluate(() => { const v = document.querySelector('.notebook-viewport'); return v.scrollHeight - v.clientHeight; });
  assert.ok(range > 2000, 'Dense notebook has a multi-page scroll range');
  const slow = process.argv.includes('--slow');
  const step = Math.max(80, Math.ceil(range / 100));
  const wheel = async (deltaY, steps) => {
    for (let i = 0; i < steps; i++) {
      await session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: 0 });
      await new Promise(resolve => setTimeout(resolve, 18));
    }
  };
  await wheel(step, 55);
  // Pause long enough for the coalesced passive handoff to run at an
  // intermediate page, then keep scrolling. Without this, a fast continuous
  // fling never settles and the gate would not exercise page-boundary work.
  await page.waitForTimeout(slow ? 400 : 240);
  await wheel(step, 55);
  await frames(4);
  await wheel(-step, 55);
  await page.waitForTimeout(slow ? 400 : 240);
  await wheel(-step, 55);
  await frames(6);
  // Passive focus transfer is intentionally coalesced until motion settles.
  await page.waitForTimeout(slow ? 450 : 220);
  const scroll = await page.evaluate(() => {
    window.regressionScrollActive = false;
    const viewport = document.querySelector('.notebook-viewport');
    const rect = viewport.getBoundingClientRect();
    const finalDominant = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      ?.closest('[data-page-id]')?.getAttribute('data-page-id') ?? null;
    const samples = window.regressionScrollSamples; window.regressionScrollSamples = null;
    if (samples?.length && finalDominant) samples[samples.length - 1].dominant = finalDominant;
    const finalOwner = window.regressionEngine().getDrawingOwnership().pageId;
    const owners = [...new Set([...samples.map(s => s.owner), finalOwner])];
    const dominantPages = [...new Set(samples.map(s => s.dominant).filter(Boolean))];
    const active = [...new Set(samples.map(s => s.active).filter(Boolean))];
    return { samples: samples.length, owners, dominantPages, finalOwner, finalDominant: samples.at(-1)?.dominant, active, minTop: Math.min(...samples.map(s => s.top)), maxTop: Math.max(...samples.map(s => s.top)), finalTop: samples.at(-1)?.top };
  });
  assert.ok(scroll.dominantPages.length >= 4, `Scroll crosses real page boundaries: ${scroll.dominantPages.length} dominant pages`);
  assert.equal(scroll.finalOwner, scroll.finalDominant, 'Passive scroll settles focus on the visible page');
  assert.ok(scroll.maxTop > range * .8, 'Scroll reaches the bottom of the dense notebook');
  evidence.scroll = { range, step, ...scroll };
}
function assertInteractionBudgets() {
  const slow = process.argv.includes('--slow');
  const selection = evidence.scenarios.filter(s => s.name.startsWith('selection-drag'));
  const scroll = evidence.scenarios.filter(s => s.name.startsWith('page-scroll'));
  assert.ok(selection.length > 0 && scroll.length > 0, 'Interaction gate records both selection and scroll scenarios');
  for (const s of selection) {
    assert.ok(s.summary.frames.p95 <= (slow ? 33.3 : 20), `${s.name} selection p95 ${s.summary.frames.p95}ms exceeds the cadence-aware ${slow ? '33.3' : '20'}ms budget`);
    assert.ok(s.summary.frames.p99 <= (slow ? 280 : 45), `${s.name} selection p99 ${s.summary.frames.p99}ms exceeds ${slow ? '280' : '45'}ms`);
    assert.ok(s.summary.frames.max <= (slow ? 280 : 55), `${s.name} selection max frame ${s.summary.frames.max}ms exceeds ${slow ? '280' : '55'}ms`);
    assert.ok(s.summary.longTasks.count <= (slow ? 2 : 1), `${s.name} selection must not produce repeated long tasks`);
    assert.ok(s.replayedStrokes <= 400, `${s.name} selection replayed ${s.replayedStrokes} strokes`);
    assert.ok(s.summary.redraw.max <= (slow ? 40 : 8), `${s.name} selection dirty redraw ${s.summary.redraw.max}ms exceeds ${slow ? '40' : '8'}ms`);
  }
  for (const s of scroll) {
    // 60 Hz rAF cadence measures ~17.6ms p50 and ~18.4ms p95 on this host.
    // The gate therefore budgets cadence plus headroom, not a theoretical 16.7.
    assert.ok(s.summary.frames.p95 <= (slow ? 180 : 20), `${s.name} scroll p95 ${s.summary.frames.p95}ms exceeds ${slow ? '180' : '20'}ms`);
    assert.ok(s.summary.frames.p99 <= (slow ? 320 : 35), `${s.name} scroll p99 ${s.summary.frames.p99}ms exceeds ${slow ? '320' : '35'}ms`);
    assert.ok(s.summary.frames.max <= (slow ? 750 : 130), `${s.name} scroll max frame ${s.summary.frames.max}ms is unbounded`);
    const long = s.longTaskDetails ?? [];
    assert.ok(long.filter(t => t.duration > 100).length <= (slow ? 70 : 2), `${s.name} has repeated >100ms app-caused long tasks`);
    assert.ok(s.summary.longTasks.max <= (slow ? 750 : 130), `${s.name} long task ${s.summary.longTasks.max}ms exceeds the single cold-preview budget`);
    assert.ok(s.replayedStrokes <= (slow ? 10000 : 4000), `${s.name} replayed ${s.replayedStrokes} strokes`);
    assert.ok((s.surface['adopt:fail'] ?? 0) <= (slow ? 8 : 1), `${s.name} has repeated surface adoption failures`);
  }
  evidence.budgets = {
    selectionP95: 20, selectionP99: 35,
    scrollP95: slow ? 180 : 20, scrollP99: slow ? 320 : 35,
    longTaskMax: slow ? 500 : 130, repeatedLongTasks: 0,
  };
}

async function interactionReps(reps = 5) {
  if (process.argv.includes('--diagnose-hit')) {
    const hit = await page.evaluate(() => {
      const engine = window.regressionEngine(), strokes = engine.drawing.getStrokes(), stroke = strokes[Math.floor(strokes.length * .5)];
      const point = stroke.points[Math.floor(stroke.points.length / 2)];
      const t0 = performance.now();
      for (const s of strokes) engine.drawing.getStrokeBounds(s);
      const bounds = performance.now() - t0;
      const t1 = performance.now(); const first = engine.drawing.findStrokesNearPoint(point.x, point.y, 5); const cold = performance.now() - t1;
      const t2 = performance.now(); const second = engine.drawing.findStrokesNearPoint(point.x, point.y, 5); const warm = performance.now() - t2;
      return { boundsMs: bounds, coldMs: cold, warmMs: warm, first: first.length, second: second.length };
    });
    console.log('HIT DIAGNOSE', JSON.stringify(hit));
    evidence.hitDiagnose = hit;
  }
  for (let i = 0; i < reps; i++) {
    if (process.argv.includes('--all-select') && i === 0) {
      await runSelectionDrag('selection-drag-all-1', true);
    }
    await runSelectionDrag(`selection-drag-${i + 1}`, false);
    await measure(`page-scroll-${i + 1}`, scrollNotebook);
  }
}
try {
  if (native) {
    const env = { ...process.env, PANVAS_GATE0_PROFILE: '1', PANVAS_GATE0_USER_DATA: path.join(root, 'profile'), PANVAS_GATE0_WORKSPACE_ROOT: path.join(root, 'workspaces'), PANVAS_TEST_WINDOW: '1580x1062' };
    for (const k of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete env[k];
    app = await _electron.launch({ executablePath: option('executable'), args: [...(option('executable') ? [`--user-data-dir=${path.join(root, 'profile')}`] : [path.resolve('.')]), ...(option('dpr') ? [`--force-device-scale-factor=${option('dpr')}`] : []), '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'], env });
    page = await app.firstWindow(); assert.ok((await app.evaluate(({ app }) => app.getPath('userData'))).startsWith(root));
    // Functional captures can be isolated from physical desktop pointer input.
    // Use --headful for native display pacing: Windows can throttle offscreen
    // windows despite Chromium's background settings.
    await (await app.browserWindow(page)).evaluate((win, headful) => {
      win.webContents.setBackgroundThrottling(false);
      if (headful) { win.setPosition(0, 0); win.show(); win.focus(); }
      else win.setPosition(-10000, -10000);
    }, visibleNative);
    await page.addInitScript(installReactProbe); await page.reload();
  } else {
    if (!option('base')) {
      server = option('web-dir') ? await preview({ configFile: false, build: { outDir: path.resolve(option('web-dir')) }, preview: { port: 0, open: false } }) : await createServer({ mode: 'web', cacheDir: path.join(root, 'vite'), optimizeDeps: { entries: ['index.html'] }, server: { port: 0, open: false, hmr: false } });
      if (!option('web-dir')) await server.listen();
    }
    // Use the full browser in both modes. Playwright's separate headless shell
    // forces a different software graphics backend on this Windows host.
    browser = await chromium.launch({ channel: 'chromium', headless: !process.argv.includes('--headful') });
    const graphics = (await (await browser.newBrowserCDPSession()).send('SystemInfo.getInfo')).gpu;
    evidence.graphics = { renderer: graphics.auxAttributes?.glRenderer, devices: graphics.devices, features: graphics.featureStatus };
    page = await browser.newPage({ viewport: { width: 1580, height: 1062 }, hasTouch: process.argv.includes('--touch') || process.argv.includes('--mobile-only'), isMobile: process.argv.includes('--mobile-device') });
    await page.addInitScript(installReactProbe);
    await page.goto(new URL('/app', option('base') ?? server.resolvedUrls.local[0]).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  page.setDefaultTimeout(60000); page.on('pageerror', e => evidence.errors.push(e.message));
  evidence.runtime = await page.evaluate(() => ({ userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  evidence.presentation = native ? visibleNative ? 'visible Electron window' : 'offscreen-positioned Electron window' : process.argv.includes('--headful') ? 'visible Chromium window' : 'headless Chromium full UI';
  evidence.simulatedCpuSlowdown = process.argv.includes('--slow') ? 4 : 1;
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
  const local = page.getByRole('button', { name: 'Continue locally', exact: true }); if (await local.isVisible()) await local.click({ force: true });
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'New Notebook', exact: true }).click();
  await page.locator('#create-dialog-input').fill('Performance regression');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.locator('#create-dialog-input').waitFor({ state: 'hidden' });
  await openBook();
  const seed = await page.evaluate(() => ({ pageId: window.regressionEngine().getDrawingOwnership().pageId, data: window.regressionEngine().getDrawingData() }));
  // Unmount before preparing the disposable populated scene: no stale autosave
  // may overwrite it. All subsequent measured input uses the real application.
  const appUrl = page.url(); await page.goto(native ? appUrl.split('#')[0] + '#/privacy' : new URL('/privacy', appUrl).href);
  await page.locator('h1').waitFor();
  evidence.workload = await page.evaluate(async seed => {
    const picture = document.createElement('canvas'); picture.width = 960; picture.height = 640;
    const c = picture.getContext('2d'); c.fillStyle = '#fff9b0'; c.fillRect(0, 0, 960, 640);
    for (let i = 0; i < 60; i++) { c.fillStyle = i % 2 ? '#1e3a8a' : '#047857'; c.fillRect(i * 16, 30 + i % 7 * 30, 12, 320); }
    const bytes = await (await new Promise(resolve => picture.toBlob(resolve, 'image/png'))).arrayBuffer();
    const makeData = id => {
      const data = structuredClone(seed.data);
      data.objects = Array.from({ length: 1200 }, (_, i) => ({ id: `${id}-ink-${i}`, type: 'stroke', tool: 'pen', centerline: 'polyline', color: ['#1d4ed8', '#047857'][i % 2], thickness: 2, opacity: 1, createdAt: i, points: Array.from({ length: 96 }, (_, j) => ({ x: 35 + (i % 8) * 84 + j * .62, y: 40 + Math.floor(i / 8) * 6.5 + Math.sin(j * .31 + i) * 3, pressure: .3 + (j % 20) / 40, t: j * 4 })) }));
      data.objects.push({ id: `${id}-rich-text`, type: 'text', x: 85, y: 650, width: 540, height: 150, opacity: 1, createdAt: 3000, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Populated performance workload', marks: [{ type: 'bold' }, { type: 'italic' }] }] }] } });
      if (seed.large) for (let i = 0; i < 3; i++) data.objects.push({ id: `${id}-image-${i}`, type: 'image', fileId: `${id}-asset-${i}`, x: 70 + i * 180, y: 110 + i * 200, width: 160, height: 110, rotation: 0, opacity: 1, createdAt: 3001 + i });
      return data;
    };
    if (window.panvas) {
      for (const ws of await window.panvas.workspace.getAll()) {
        const p = (await window.panvas.notebookPage.getAll(ws.id)).find(p => p.id === seed.pageId); if (!p) continue;
        const pages = [p]; if (seed.large) for (let i = 1; i < 8; i++) pages.push(await window.panvas.notebookPage.create(ws.id, p.notebookId, p.sectionId, `Performance page ${i + 1}`));
        for (const item of pages) {
          const data = makeData(item.id);
          for (const image of data.objects.filter(o => o.type === 'image')) await window.panvas.binary.storeImage(image.fileId, 'workload.png', 'image/png', bytes);
          await window.panvas.notebook.saveDrawing(ws.id, item.notebookId, item.id, data);
        }
        return { pages: pages.map(p => p.id), workspaceId: ws.id, notebookId: p.notebookId, sectionId: p.sectionId, strokesPerPage: 1200, pointsPerStroke: 96, imagesPerPage: seed.large ? 3 : 0 };
      }
      throw Error('Disposable native owner missing');
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('panvas'); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['notebookPages', 'notebookPageDrawings', 'imageFiles'], 'readwrite');
        const get = tx.objectStore('notebookPages').get(seed.pageId); let pages;
        get.onsuccess = () => {
          if (!get.result) { tx.abort(); return; }
          pages = [get.result]; if (seed.large) for (let i = 1; i < 8; i++) pages.push({ ...get.result, id: `qa-page-${i}`, title: `Performance page ${i + 1}`, order: i });
          const drawing = tx.objectStore('notebookPageDrawings').get(seed.pageId);
          drawing.onsuccess = () => {
            if (!drawing.result) { tx.abort(); return; }
            for (const item of pages) {
              tx.objectStore('notebookPages').put(item);
              const data = makeData(item.id);
              tx.objectStore('notebookPageDrawings').put({ ...drawing.result, pageId: item.id, id: item.id, data });
              for (const image of data.objects.filter(o => o.type === 'image')) tx.objectStore('imageFiles').put({ id: image.fileId, canvasFileId: item.id, fileName: 'workload.png', mimeType: 'image/png', data: bytes, createdAt: 1, userId: '' });
            }
          };
        };
        tx.oncomplete = () => { db.close(); resolve({ pages: pages.map(p => p.id), notebookId: pages[0].notebookId, sectionId: pages[0].sectionId, strokesPerPage: 1200, pointsPerStroke: 96, imagesPerPage: seed.large ? 3 : 0 }); };
        tx.onabort = () => { db.close(); reject(tx.error ?? Error('Disposable fixture preparation aborted')); };
      };
    });
  }, { ...seed, large: process.argv.includes('--large') });
  await page.goto(appUrl);
  // A native hash-route change retains the workspace store. Reload after IPC
  // fixture preparation so the real sidebar and section preload see all pages.
  if (native) await page.reload();
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor(); await openBook();
  await expect(page.locator(`[data-tree-id="${evidence.workload.sectionId}"]`)).toContainText(String(evidence.workload.pages.length));
  assert.equal(await page.evaluate(() => window.regressionEngine().drawing.getStrokes().length), 1200);
  if (process.argv.includes('--large')) await expect.poll(() => page.evaluate(() => window.regressionEngine().images.imageCache.size)).toBe(3);
  await page.waitForTimeout(350); await frames(4); // Let the existing backing-scale debounce settle.
  session = await page.context().newCDPSession(page); await session.send('Profiler.enable'); await session.send('Performance.enable');
  if (process.argv.includes('--slow')) await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  if (process.argv.includes('--memory-probe')) {
    await memoryProbe();
  } else if (process.argv.includes('--checks-only')) {
    await toolChecks();
  } else if (process.argv.includes('--navigation-only')) {
    await extendedUsage();
  } else if (process.argv.includes('--canvas-only')) {
    await canvasTransitions();
  } else if (process.argv.includes('--mobile-only')) {
    await resize(390, 844); await frames(20);
    await measure('touch-hand', mobilePan);
    await measure('touch-pinch-cancel', touchPinchAndCancel);
    await notebookResizes();
    await page.screenshot({ path: path.join(out, 'touch.png') });
  } else if (process.argv.includes('--interaction-only')) {
    await page.waitForTimeout(process.argv.includes('--slow') ? 800 : 300); await frames(6);
    await interactionReps(Number(option('reps') ?? 5));
    assertInteractionBudgets();
  } else {
  await page.getByRole('button', { name: 'More Tools', exact: true }).click(); await page.getByTitle('Laser Pointer', { exact: true }).click();
  const beforeLaser = await sceneHash();
  const dryPixels = await page.locator('[data-focused-sheet="true"] canvas[data-rendered-page-id]').evaluate(c => c.toDataURL());
  await measure('laser', async () => { await drag(); await page.waitForTimeout(1200); });
  assert.equal(await page.evaluate(() => window.regressionEngine().drawing.getStrokes().length), 1200);
  assert.equal(await sceneHash(), beforeLaser, 'Laser does not change any persisted scene object');
  const afterPixels = await page.locator('[data-focused-sheet="true"] canvas[data-rendered-page-id]').evaluate(c => c.toDataURL());
  if (afterPixels !== dryPixels) {
    await writeFile(path.join(out, 'dry-before.png'), Buffer.from(dryPixels.split(',')[1], 'base64'));
    await writeFile(path.join(out, 'dry-after.png'), Buffer.from(afterPixels.split(',')[1], 'base64'));
  }
  evidence.laserPixels = { beforeHash: createHash('sha256').update(dryPixels).digest('hex'), afterHash: createHash('sha256').update(afterPixels).digest('hex'), unchanged: afterPixels === dryPixels };
  evidence.laserState = await page.evaluate(() => {
    const engine = window.regressionEngine(), canvas = engine.drawing.getCanvasElement();
    return { now: performance.now(), points: engine.laser.getActiveTrail(), animating: engine.laser.isAnimating(), pointerActive: engine.input.laserPointerActive,
      owner: engine.getDrawingOwnership(), canvas: { width: canvas.width, height: canvas.height, dpr: devicePixelRatio, connected: canvas.isConnected },
      overlays: [...document.querySelectorAll('[data-panvas-laser-overlay]')].map(c => ({ width: c.width, height: c.height, parent: c.parentElement?.outerHTML.slice(0, 250), tracked: c === engine.drawing.laserCanvas })) };
  });
  await expect(page.locator('[data-panvas-laser-overlay]')).toHaveCount(0);
  await page.getByTitle('Pen (P)', { exact: true }).click(); await page.keyboard.press('Escape');
  evidence.beforePenCount = await page.evaluate(() => window.regressionEngine().drawing.getStrokes().length);
  await measure('pen', async () => { await drag(); });
  evidence.newInk = await page.evaluate(() => window.regressionEngine().drawing.getStrokes().filter(s => !/-ink-\d+$/.test(s.id)).map(s => ({ id: s.id, points: s.points.length, first: s.points[0], last: s.points.at(-1), tool: s.tool })));
  assert.equal(await page.evaluate(() => window.regressionEngine().drawing.getStrokes().length), 1201);
  const expected = await sceneHash();
  evidence.persistence = { expectedHash: expected, expectedOwner: await owner() };
  await expect.poll(() => sceneHash(true), { timeout: 30000, intervals: [300, 500, 1000] }).toBe(expected);
  await page.reload(); await page.getByRole('button', { name: 'New item', exact: true }).waitFor(); await openBook();
  evidence.persistence.reopenedOwner = await owner(); evidence.persistence.reopenedHash = await sceneHash();
  assert.equal(evidence.persistence.reopenedHash, expected, 'All ink points, rich text and image references survive reopen exactly');
  evidence.exactPersistence = true;
  if (process.argv.includes('--extended')) await extendedUsage();
  if (process.argv.includes('--checks')) await toolChecks();
  }
  await page.screenshot({ path: path.join(out, 'populated.png') });
  assert.deepEqual(evidence.errors, []);
  assert.notEqual(evidence.laserPixels?.unchanged, false, 'Committed scene pixels remain exact after laser decay');
  if (process.argv.includes('--expect-responsive')) {
    const laser = evidence.scenarios.find(s => s.name === 'laser');
    assert.ok(laser, 'Responsive check requires the actual laser workload');
    assert.equal(laser.replayedStrokes, 0, 'Laser motion and decay must not replay committed handwriting');
    assert.ok(laser.summary.frames.p95 < 34, 'Laser frame p95 stays below two display frames on this test host');
  }
  evidence.passed = true;
} catch (e) { evidence.failure = e.stack; if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw e; }
finally { if (app) await app.close(); if (browser) await browser.close(); if (server) await server.close(); await writeFile(path.join(out, 'results.json'), JSON.stringify(evidence, null, 2)); }
