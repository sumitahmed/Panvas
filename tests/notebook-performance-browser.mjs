import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const baselineIndex = process.argv.indexOf('--baseline-ref');
const baselineRef = baselineIndex >= 0 ? process.argv[baselineIndex + 1] : null;
const baselineSources = new Map(baselineRef ? [
  'src/components/notebook/NotebookRenderer.tsx', 'src/components/notebook/NotebookPageView.tsx',
  'src/components/notebook/pageVisualWindow.ts', 'src/components/notebook/engine/InputManager.ts',
  'src/components/notebook/engine/ViewportManager.ts',
].map(path => [path, execFileSync('git', ['show', `${baselineRef}:${path}`], { encoding: 'utf8' })]) : []);

// Test-only instrumentation and optional read-only historical source comparison.
// Neither path writes or checks out production source files.
const counters = {
  name: 'notebook-performance-counters', enforce: 'pre',
  transform(source, id) {
    const path = id.replaceAll('\\', '/').split('?')[0];
    const baseline = [...baselineSources].find(([file]) => path.endsWith(`/${file}`));
    if (baseline) source = baseline[1];
    if (!path.endsWith('/NotebookRenderer.tsx')) return baseline ? source : undefined;
    source = source.replaceAll('\r\n', '\n');
    return source
      .replace('const onScroll = () => {', 'const onScroll = () => { window.__notebookWork && window.__notebookWork.scrollCallbacks++;')
      .replace('scrollRafId = null;\n        observeScroll();', 'scrollRafId = null; window.__notebookWork && window.__notebookWork.scrollRafs++;\n        observeScroll();');
  },
};
const profileOnly = process.argv.includes('--profile') || !!baselineRef;
const output = process.argv.indexOf('--output');
const server = await createServer({ mode: 'web', plugins: [counters], server: { port: 0, open: false } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const results = [];
const errors = [];
const frames = (page, count = 6) => page.evaluate(async count => {
  for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame);
}, count);

async function installCounters(page) {
  await page.evaluate(() => {
    const viewport = document.querySelector('.notebook-viewport');
    const engine = window.navigationEngine();
    const c = window.__notebookWork = {
      pointermove: 0, pointerrawupdate: 0, scrollWrites: 0, scrollCallbacks: 0, scrollRafs: 0,
      residencyChanges: 0, mounts: 0, unmounts: 0, maxResident: 0, maxCanvases: 0, maxPixels: 0,
      visualEvents: 0, visualWrites: 0, zoomNotifications: 0, zoomChanges: 0, moveDurations: [],
    };
    for (const key of ['scrollTop', 'scrollLeft']) {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, key);
      Object.defineProperty(viewport, key, {
        configurable: true, get() { return descriptor.get.call(this); },
        set(value) { c.scrollWrites++; descriptor.set.call(this, value); },
      });
    }
    for (const type of ['pointermove', 'pointerrawupdate']) {
      viewport.addEventListener(type, () => c[type]++, true);
    }
    for (const type of ['resize', 'scroll']) visualViewport.addEventListener(type, () => c.visualEvents++);
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, ...args) {
      if (this === document.documentElement.style && ['--panvas-visual-height', '--panvas-keyboard-inset'].includes(name)) c.visualWrites++;
      return setProperty.call(this, name, ...args);
    };
    let zoom = engine.viewport.getState().scale;
    engine.viewport.subscribe(state => {
      c.zoomNotifications++;
      if (state.scale !== zoom) { c.zoomChanges++; zoom = state.scale; }
    });
    let resident = new Set();
    window.performanceSample = () => {
      const next = new Set([...viewport.querySelectorAll('[data-rendered-page-id]')].map(node => node.dataset.renderedPageId));
      if (next.size !== resident.size || [...next].some(id => !resident.has(id))) {
        c.residencyChanges++;
        c.mounts += [...next].filter(id => !resident.has(id)).length;
        c.unmounts += [...resident].filter(id => !next.has(id)).length;
        resident = next;
      }
      const canvases = [...viewport.querySelectorAll('canvas')];
      c.maxResident = Math.max(c.maxResident, next.size);
      c.maxCanvases = Math.max(c.maxCanvases, canvases.length);
      c.maxPixels = Math.max(c.maxPixels, canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0));
    };
    window.performanceSample();
    window.performanceReset = () => {
      for (const key of Object.keys(c)) c[key] = key === 'moveDurations' ? [] : 0;
      window.__PANVAS_GATE0_PROFILER__.reset();
      window.navigationRemember();
      window.performanceSample();
    };
    window.performanceReport = () => {
      window.performanceSample();
      const report = window.__PANVAS_GATE0_PROFILER__.report();
      const durations = name => report.events.filter(event => event.name === name).map(event => event.durationMs || 0);
      const summarize = values => ({ count: values.length, totalMs: values.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...values) });
      return { ...c, moveDurations: summarize(c.moveDurations), react: report.resources,
        scrollDuration: summarize(durations('notebook-scroll-handler')),
        reactDuration: summarize(durations('react-profiler-commit')),
        handoff: window.navigationSnapshot().counts,
        finalScroll: viewport.scrollTop, dropped: report.dropped };
    };
  });
}

async function syntheticPan(page, targets, rawPerFrame = 4) {
  return page.evaluate(async ({ targets, rawPerFrame }) => {
    const engine = window.navigationEngine();
    const canvas = engine.drawing.getCanvasElement();
    const viewport = canvas.closest('.notebook-viewport');
    const box = canvas.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = Math.max(viewport.getBoundingClientRect().top, box.top) + 50;
    const start = viewport.scrollTop;
    const emit = (type, target) => {
      const t = performance.now();
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 91, pointerType: 'touch',
        clientX: x, clientY: y - (target - start), buttons: 1, button: type === 'pointerdown' ? 0 : -1 }));
      if (type === 'pointermove' || type === 'pointerrawupdate') window.__notebookWork.moveDurations.push(performance.now() - t);
    };
    emit('pointerdown', start);
    const owner = window.navigationSnapshot().owner;
    let previous = start;
    for (const target of targets) {
      await new Promise(requestAnimationFrame);
      for (let raw = 1; raw <= rawPerFrame; raw++) emit('pointerrawupdate', previous + (target - previous) * raw / rawPerFrame);
      emit('pointermove', target);
      window.performanceSample();
      const held = window.navigationSnapshot();
      if (held.owner !== owner || !held.sameCanvas || !held.originalConnected || !held.navigationActive
        || Object.values(held.counts).some(Boolean)) throw new Error('held navigation must retain the live input owner');
      previous = target;
    }
    emit('pointerup', previous);
    return { start, target: previous, actual: viewport.scrollTop };
  }, { targets, rawPerFrame });
}

async function trustedPan(page, touch) {
  const start = await page.evaluate(() => {
    const canvas = window.navigationEngine().drawing.getCanvasElement();
    const box = canvas.getBoundingClientRect();
    const view = canvas.closest('.notebook-viewport').getBoundingClientRect();
    return { x: box.left + box.width / 2, y: Math.max(box.top, view.top) + 100 };
  });
  if (touch) {
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 31, ...start }] });
    for (let step = 1; step <= 24; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 31, x: start.x, y: start.y - step * 2 }] });
      await frames(page, 1);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let step = 1; step <= 24; step++) {
      await page.mouse.move(start.x, start.y - step * 2);
      await frames(page, 1);
    }
    await page.mouse.up();
  }
  await frames(page);
}

async function pinch(page) {
  await page.evaluate(async () => {
    const viewport = document.querySelector('.notebook-viewport');
    const box = viewport.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + 180;
    const emit = (type, id, dx) => viewport.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerType: 'touch', pointerId: id, clientX: x + dx, clientY: y, buttons: 1, button: 0,
    }));
    emit('pointerdown', 101, -50); emit('pointerdown', 102, 50);
    for (let step = 1; step <= 12; step++) {
      await new Promise(requestAnimationFrame);
      emit('pointermove', 101, -50 - step * 2); emit('pointermove', 102, 50 + step * 2);
      window.performanceSample();
    }
    emit('pointerup', 101, -74); emit('pointerup', 102, 74);
  });
  // Wait for the existing 150ms raster zoom debounce before measuring detail.
  await frames(page, 30);
}

try {
  for (const config of [
    { name: 'phone', width: 390, height: 844, mobile: true, touch: true, dpr: 3 },
    { name: 'desktop-site-phone', width: 390, height: 844, mobile: true, touch: true, dpr: 3, virtual: true },
    { name: 'desktop', width: 1280, height: 800, mobile: false, touch: false, dpr: 1 },
  ]) {
    const context = await browser.newContext({ viewport: { width: config.width, height: config.height },
      isMobile: config.mobile, hasTouch: config.touch, deviceScaleFactor: config.dpr });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    if (config.virtual) await page.route('**/notebook-responsive.html?*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('width=device-width, initial-scale=1', 'width=980') });
    });
    await page.goto(`${server.resolvedUrls.local[0]}tests/fixtures/notebook-responsive.html?responsive=1&performance=1&gate0Profile=1`);
    await page.waitForFunction(() => window.navigationReady?.() && window.navigationEngine?.()?.drawing.getCanvasElement());
    await frames(page, 20);
    assert.equal(await page.evaluate(() => window.navigationEngine().drawing.getStrokes().length), 80,
      'the performance fixture must actually load its canonical ink objects');
    await page.evaluate(() => document.fonts.ready);
    // Gestures below run offline: server/network latency cannot produce these counts.
    await context.setOffline(true);
    await installCounters(page);
    const geometry = await page.evaluate(() => ({ innerWidth, clientWidth: document.documentElement.clientWidth,
      screenWidth: screen.width, dpr: devicePixelRatio, visualWidth: visualViewport.width, visualScale: visualViewport.scale,
      panvasScale: window.navigationEngine().viewport.getState().scale, coarse: matchMedia('(any-pointer: coarse)').matches,
      canvases: [...document.querySelectorAll('.notebook-viewport canvas')].map(canvas => ({
        width: canvas.width, height: canvas.height, cssWidth: canvas.style.width, cssHeight: canvas.style.height,
      })), pixels: [...document.querySelectorAll('.notebook-viewport canvas')].reduce((n, c) => n + c.width * c.height, 0) }));
    await page.evaluate(() => window.performanceReset());
    await trustedPan(page, config.touch);
    const trusted = await page.evaluate(() => window.performanceReport());
    assert.ok(trusted.finalScroll >= 47, 'trusted Hand input must actually scroll');
    const settle = async () => {
      await page.evaluate(() => { window.navigationSelect(0); document.querySelector('.notebook-viewport').scrollTop = 0; });
      await page.waitForFunction(() => window.navigationSnapshot().owner === window.navigationIds[0]);
      await frames(page, 12);
      await page.evaluate(() => window.performanceReset());
    };
    await settle();
    // A controlled 5-sample/frame stream isolates duplicate raw transport work. It is
    // deliberately synthetic, separate from the trusted Chromium input counts above.
    const stableTargets = Array.from({ length: 120 }, (_, i) => 30 + (i < 60 ? i : 119 - i) * 2);
    const movement = await syntheticPan(page, stableTargets);
    await frames(page);
    const stable = await page.evaluate(() => window.performanceReport());
    assert.ok(Math.abs(movement.actual - movement.target) < 1, 'final movement must not be lost');
    assert.equal(stable.residencyChanges, 0, 'workload must stay within one resident set');
    if (!profileOnly) {
      assert.equal(stable.scrollWrites, 240, 'four raw samples must add no Hand scroll writes');
      assert.ok((stable.react['reactCommits.NotebookRenderer'] || 0) <= 2, 'stable residency must not commit per scroll frame');
    }
    await settle();
    const boundaryTargets = await page.evaluate(() => {
      const scale = window.navigationEngine().viewport.getState().scale;
      const sheets = [...document.querySelectorAll('[data-page-index]')];
      return Array.from({ length: 3 }, () => [1, 4, 8, 12, 18, 12, 8, 4, 1, 0, 4, 12])
        .flat().flatMap(index => Array(4).fill(sheets[index].offsetTop * scale));
    });
    await syntheticPan(page, boundaryTargets);
    await frames(page, 12);
    const boundaries = await page.evaluate(() => window.performanceReport());
    assert.equal(boundaries.handoff.mount, 1, 'crossing and reversing pages must finish with exactly one handoff');
    assert.equal(boundaries.handoff.detach, 1);
    await page.evaluate(() => window.performanceReset());
    const zoomBefore = await page.evaluate(() => window.navigationEngine().viewport.getState().scale);
    await pinch(page);
    const zoomAfter = await page.evaluate(() => window.navigationEngine().viewport.getState().scale);
    assert.ok(zoomAfter > zoomBefore * 1.4, 'pinch must actually zoom');
    const zoom = await page.evaluate(() => window.performanceReport());
    const activeRasterAfterPinch = await page.evaluate(() => {
      const canvas = window.navigationEngine().drawing.getCanvasElement();
      return { width: canvas.width, height: canvas.height, cssWidth: canvas.style.width, cssHeight: canvas.style.height };
    });
    // Continue panning after pinch, including reversals, to catch accumulating work.
    await page.evaluate(() => window.performanceReset());
    const continuation = await page.evaluate(() => {
      const start = document.querySelector('.notebook-viewport').scrollTop;
      return Array.from({ length: 120 }, (_, i) => start + (i < 60 ? i : 119 - i) * 2);
    });
    const continuedMovement = await syntheticPan(page, continuation);
    await frames(page);
    assert.ok(Math.abs(continuedMovement.actual - continuedMovement.target) < 1);
    const postPinch = await page.evaluate(() => window.performanceReport());
    if (!profileOnly) {
      const effective = config.dpr * geometry.panvasScale * geometry.visualScale;
      const first = geometry.canvases.find(c => c.width === Math.max(...geometry.canvases.map(c => c.width)));
      assert.ok(first, 'fixture must render its paper');
      assert.ok(Math.abs(first.width - Math.floor(parseFloat(first.cssWidth) * effective)) <= 1, 'raster must follow effective physical scale');
      assert.ok(Math.abs(activeRasterAfterPinch.width - Math.floor(parseFloat(activeRasterAfterPinch.cssWidth)
        * config.dpr * zoomAfter * geometry.visualScale)) <= 1, 'active raster must regain full effective detail after pinch settles');
    }
    const result = { name: config.name, offline: true, geometry, trusted, stable, boundaries,
      pinch: zoom, activeRasterAfterPinch, postPinch };
    results.push(result);
    console.log(JSON.stringify(result));
    await context.close();
  }
  assert.deepEqual(errors, [], 'no browser errors');
  if (output >= 0) await writeFile(process.argv[output + 1], JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} performance profiles; trusted input, stable residency, held boundary reversals and pinch`);
} finally {
  await browser.close();
  await server.close();
}
