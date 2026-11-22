// Regression: a page may hand off from its page-owned preview to the live
// surface, but the two visual surfaces must never be visible together. Two
// stacked copies of the same translucent image look darker even when their
// coordinates agree, and stale copies look like a duplicate image.
// Usage: node tests/image-single-representation-browser.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const outDir = 'artifacts/image-single-representation';
await mkdir(outDir, { recursive: true });
const server = await createServer({
  mode: 'web',
  cacheDir: path.join(outDir, 'vite-cache'),
  optimizeDeps: { entries: ['tests/fixtures/navigation-probe.html'] },
  server: { port: 0, open: false },
});

let browser;
try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url + 'tests/fixtures/navigation-probe.html', { timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.navProbe?.engine()?.drawing?.getCanvasElement?.()), null, { timeout: 90000 });
  await page.waitForTimeout(500);

  const pageIds = await page.evaluate(() => window.navProbe.pageIds);
  await page.evaluate(async () => {
    const engine = window.navProbe.engine();
    const imageId = await window.navProbe.pasteImage(170, 180);
    const image = engine.images.getImages().find(item => item.id === imageId);
    image.opacity = 0.5;
    engine.drawing.redraw();
  });
  await page.waitForTimeout(500);

  await page.evaluate(async secondPageId => {
    await window.navProbe.setActivePage(secondPageId);
  }, pageIds[1]);
  await page.waitForTimeout(350);

  await page.evaluate(firstPageId => {
    window.__representationSamples = [];
    const sample = () => {
      const focused = document.querySelector('[data-focused-sheet="true"][data-page-id]');
      if (focused) {
        const visibility = selector => {
          const root = focused.querySelector(selector);
          if (!root) return 0;
          return [...root.querySelectorAll('canvas[data-panvas-presentation-layer]')]
            .filter(canvas => getComputedStyle(canvas).visibility !== 'hidden').length;
        };
        const staticCount = visibility('[data-stable-page-visual]');
        const liveCount = visibility('[data-live-page-visual]');
        window.__representationSamples.push({ pageId: focused.getAttribute('data-page-id'), staticCount, liveCount });
      }
      if (window.__representationSamples.length < 180) requestAnimationFrame(sample);
    };
    window.__representationSamples.length = 0;
    window.navProbe.setActivePage(firstPageId);
    requestAnimationFrame(sample);
  }, pageIds[0]);
  await page.waitForTimeout(900);

  const samples = await page.evaluate(() => window.__representationSamples);
  await page.screenshot({ path: path.join(outDir, 'returned.png') });
  const duplicates = samples.filter(sample => sample.staticCount > 0 && sample.liveCount > 0);
  assert.ok(samples.length > 10, `page handoff sampling must run (${samples.length} frames)`);
  assert.equal(duplicates.length, 0, `static and live image surfaces coexisted: ${JSON.stringify(duplicates.slice(0, 5))}`);
  assert.deepEqual(errors, [], `no page errors: ${JSON.stringify(errors)}`);
  console.log('IMAGE SINGLE REPRESENTATION REGRESSION: PASS', JSON.stringify({ frames: samples.length, duplicates: duplicates.length }));
} finally {
  if (browser) await browser.close();
  await server.close();
}
