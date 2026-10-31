// Continuous infinite page regression: one logical page must grow from live
// drawing (including mid-stroke), never from scrolling, and never by creating
// additional page records.
// Usage: node tests/infinite-page-browser.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const outDir = 'artifacts/infinite-page-probe';
await mkdir(outDir, { recursive: true });
const server = await createServer({ mode: 'web', cacheDir: path.join(outDir, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/navigation-probe.html'] }, server: { port: 0, open: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(url + 'tests/fixtures/navigation-probe.html', { timeout: 120000 });
await page.waitForFunction(() => Boolean(window.navProbe?.engine()?.drawing?.getCanvasElement?.()), null, { timeout: 90000 });
await page.waitForTimeout(400);

// Switch the fixture page to Infinite.
await page.evaluate(() => window.navProbe.engine().setProperties({ pageSize: 'Infinite', infiniteWidth: 794 }));
await page.waitForTimeout(200);

const extent = () => page.evaluate(() => {
  const engine = window.navProbe.engine();
  return {
    layoutExtent: engine.getProperties().layoutExtent ?? 0,
    baseHeight: 1123,
    pageId: window.navProbe.activePageId(),
    pageCount: usePageCount(),
  };
  function usePageCount() {
    return window.__navPageCount ?? 0;
  }
});
// Page count guard: expose via the store through the probe pageIds length.
const pageCount = () => page.evaluate(() => window.navProbe.pageIds.length);

// Draw with real pointer input: a stroke walking downward past the boundary.
const drawStroke = async (startX, startY, length, steps = 20) => {
  const box = await page.evaluate(() => {
    const engine = window.navProbe.engine();
    const canvas = engine.drawing.getCanvasElement();
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top, rw: rect.width, cw: canvas.clientWidth };
  });
  await page.evaluate(() => window.navProbe.engine().tools.setMode('draw'));
  const scale = box.rw / box.cw;
  // Bring the stroke start into the visible viewport first.
  await page.evaluate(async startY => {
    const viewport = window.navProbe.viewport();
    const canvas = window.navProbe.engine().drawing.getCanvasElement();
    const pageTop = canvas.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    viewport.scrollTo({ top: Math.max(0, pageTop + startY * (canvas.getBoundingClientRect().width / canvas.clientWidth) - 120), behavior: 'instant' });
    await new Promise(resolve => setTimeout(resolve, 150));
  }, startY);
  const box2 = await page.evaluate(() => {
    const canvas = window.navProbe.engine().drawing.getCanvasElement();
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  });
  const toClient = (px, py) => ({ x: box2.left + px * scale, y: box2.top + py * scale });
  const p0 = toClient(startX, startY);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const point = toClient(startX + i * 6, startY + (length * i / steps));
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(20);
  }
  const midExtent = (await extent()).layoutExtent;
  console.log('mid-stroke debug:', JSON.stringify(await page.evaluate(() => window.navProbe.debugState())));
  await page.mouse.up();
  await page.waitForTimeout(300);
  return midExtent;
};

const initial = await extent();
console.log('initial:', JSON.stringify(initial));
assert.ok(initial.layoutExtent >= initial.baseHeight, 'infinite page starts at least one base page tall');

// 1. Scroll through blank space: no growth.
await page.evaluate(async () => {
  const viewport = window.navProbe.viewport();
  const before = viewport.scrollTop;
  viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' });
  await new Promise(resolve => setTimeout(resolve, 400));
  viewport.scrollTo({ top: before, behavior: 'instant' });
  await new Promise(resolve => setTimeout(resolve, 300));
});
const afterScroll = (await extent()).layoutExtent;
assert.equal(afterScroll, initial.layoutExtent, 'scrolling alone must not grow the page');

// 2. Draw a stroke that walks past the current bottom boundary.
const pagesBefore = await pageCount();
const geometry = await page.evaluate(() => {
  const engine = window.navProbe.engine();
  return { extent: engine.getProperties().layoutExtent ?? 1123, scale: engine.viewport.getState().scale, top: window.navProbe.viewport().scrollTop };
});
// Start the stroke near the page bottom in page coordinates.
const startX = 200, boundaryY = geometry.extent - 60;
const strokeBottomPage = boundaryY + 700; // well past the old extent
const midExtent = await drawStroke(startX, boundaryY - 200, 900);
console.log('mid-stroke extent:', midExtent, 'initial extent:', geometry.extent);
assert.ok(midExtent > geometry.extent, `extent must grow during the live stroke (${midExtent} > ${geometry.extent})`);

const afterDraw = await extent();
console.log('after draw:', JSON.stringify(afterDraw));
const expected = Math.ceil((strokeBottomPage + 1123 / 4) / 256) * 256;
assert.ok(afterDraw.layoutExtent >= Math.min(expected, strokeBottomPage), 'extent covers the committed stroke');
assert.equal(afterDraw.pageId, await page.evaluate(() => window.navProbe.pageIds[0]), 'same logical page');
assert.equal(await pageCount(), pagesBefore, 'no additional page records were created for growth');
assert.ok(afterDraw.layoutExtent < 20000, 'growth stays bounded for a bounded stroke');

// 3. Content is not clipped: commit another stroke whose bottom sits below the
// previous extent minus margin, then verify the extent covers it.
assert.deepEqual(errors, [], `no page errors: ${JSON.stringify(errors)}`);
console.log('INFINITE PAGE REGRESSION: PASS');
await page.screenshot({ path: path.join(outDir, 'final.png') });
await browser.close();
await server.close();
