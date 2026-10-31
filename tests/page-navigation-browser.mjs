// Page navigation regression: drives the REAL NotebookRenderer through scroll,
// passive activation, sidebar-style clicks, and zoom, asserting actual rendered
// viewport behavior (not source text).
// Usage: node tests/page-navigation-browser.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const outDir = 'artifacts/page-navigation-probe';
await mkdir(outDir, { recursive: true });
const server = await createServer({ mode: 'web', cacheDir: path.join(outDir, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/navigation-probe.html'] }, server: { port: 0, open: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(url + 'tests/fixtures/navigation-probe.html', { timeout: 120000 });
await page.waitForFunction(() => {
  const probe = window.navProbe;
  return Boolean(probe?.engine()?.drawing?.getCanvasElement?.());
}, null, { timeout: 90000 });

const pages = await page.evaluate(() => window.navProbe.pageIds);
const snapshot = () => page.evaluate(() => ({
  active: window.navProbe.activePageId(),
  owner: window.navProbe.ownershipPageId(),
  dominant: window.navProbe.dominantPageIdAtViewportCenter(),
  scrollTop: window.navProbe.viewport()?.scrollTop ?? -1,
}));

// Scroll the real viewport with genuine wheel input so the observer sees
// live scrolling, then let the passive handoff fire.
const wheelScrollTo = async pageId => {
  const box = await page.evaluate(() => {
    const viewport = window.navProbe.viewport();
    const rect = viewport.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, 140);
    await page.waitForTimeout(30);
  }
  const target = await page.evaluate(pageId => window.navProbe.pageTop(pageId), pageId);
  await page.evaluate(({ pageId, target }) => {
    window.navProbe.viewport().scrollTo({ top: Math.max(0, target), behavior: 'instant' });
  }, { pageId, target });
  await page.waitForTimeout(700); // > 140ms handoff
};
await wheelScrollTo(pages[2]);

let state = await snapshot();
console.log('after scroll to page 3:', JSON.stringify(state));
console.log('geometry:', JSON.stringify(await page.evaluate(() => window.navProbe.pageGeometry())));
assert.equal(state.active, pages[2], 'passive scroll must commit the visible page as active');
assert.equal(state.owner, pages[2], 'the engine must own the visible page after the handoff');

// INTERMEDIATE-PAGE regression: stop ORGANICALLY (no force-align) with each
// intermediate page filling the viewport; the store and the real left-tree
// highlight must follow through page 2 and page 3, not only first/last.
const organicScrollTo = async pageId => {
  await page.evaluate(async pageId => {
    const viewport = window.navProbe.viewport();
    const target = window.navProbe.pageTop(pageId) + 200;
    const step = (target - viewport.scrollTop) / 10;
    for (let i = 1; i <= 10; i++) {
      viewport.scrollTop += step;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }, pageId);
  await page.waitForTimeout(700); // settle + passive handoff
  return page.evaluate(() => ({
    active: window.navProbe.activePageId(),
    tree: window.navProbe.highlightedTreePage(),
    dominant: window.navProbe.dominantPageIdAtViewportCenter(),
  }));
};
for (const pageId of [pages[1], pages[2]]) {
  const organic = await organicScrollTo(pageId);
  console.log(`organic stop on ${pageId}:`, JSON.stringify(organic));
  assert.equal(organic.active, pageId, `intermediate page ${pageId} must become active after an organic scroll`);
  assert.equal(organic.tree, pageId, `left navigation highlight must follow intermediate page ${pageId}`);
}
const upward = await organicScrollTo(pages[1]);
assert.equal(upward.active, pages[1], 'upward scrolling must commit intermediate pages');
assert.equal(upward.tree, pages[1], 'upward highlight follows');

// REGRESSION (the reported navigation defect): click a previously active page
// in the sidebar — the viewport must actually navigate back to it.
await page.evaluate(pageId => { window.navProbe.setActivePage(pageId); }, pages[0]);
await page.waitForTimeout(400);
state = await snapshot();
console.log('after sidebar click to page 1:', JSON.stringify(state));
assert.equal(state.active, pages[0], 'sidebar click must change the active page');
const page1Top = await page.evaluate(pageId => window.navProbe.pageTop(pageId), pages[0]);
assert.ok(Math.abs(state.scrollTop - page1Top) < 120,
  `viewport must scroll to the clicked page (scrollTop ${state.scrollTop} vs page top ${page1Top})`);

// Scroll to page 2, then zoom: the visible page must not snap back to page 1.
await wheelScrollTo(pages[1]);
state = await snapshot();
assert.equal(state.active, pages[1], 'scroll to page 2 must commit page 2 as active');

// Zoom with the real user gesture (Ctrl+wheel -> applyZoom), which preserves
// the viewport anchor; a raw engine setZoom would bypass the UI zoom path.
const zoomWithGesture = async steps => {
  await page.keyboard.down('Control');
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(60); }
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);
};
await zoomWithGesture(6);
console.log('scale after gesture zoom:', await page.evaluate(() => window.navProbe.engine().viewport.getState().scale));
state = await snapshot();
console.log('after zoom at page 2:', JSON.stringify(state));
assert.equal(state.active, pages[1], 'zoom after scrolling must keep the scrolled page active');
assert.equal(state.dominant, pages[1], 'zoom must not jump the viewport back to a stale page');

// Upward scroll to page 4? (wrap check) — scroll upward from page 2 to page 1.
await page.keyboard.down('Control');
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(50); }
await page.keyboard.up('Control');
await page.waitForTimeout(400);
await wheelScrollTo(pages[3]);
state = await snapshot();
console.log('after scroll to page 4:', JSON.stringify(state));
assert.equal(state.active, pages[3], 'scrolling to the last page must commit it as active');

assert.deepEqual(errors, [], `no page errors: ${JSON.stringify(errors)}`);
console.log('PAGE NAVIGATION REGRESSION: PASS');
await page.screenshot({ path: path.join(outDir, 'final.png') });
await browser.close();
await server.close();
