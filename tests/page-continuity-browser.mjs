import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
// Isolated component fixture: never opens the app or any real notebook.
const server = await createServer({ mode: 'web', server: { port: 0, open: false } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`${server.resolvedUrls.local[0]}tests/fixtures/page-continuity.html`);
  await page.waitForFunction(() => window.continuityMove && document.querySelectorAll('[data-committed-page-id]').length >= 3);
  await page.waitForFunction(() => window.continuityStats().activeCache === 1);
  // Let inactive image decoding finish, then retain actual DOM references.
  await page.waitForFunction(() => [...document.querySelectorAll('[data-committed-page-id]')].every(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, i) => i % 4 === 0 && value > 200 && pixels[i + 1] < 30 && pixels[i + 3] > 0);
  }));
  await page.evaluate(() => { window.originalCanvases = [...document.querySelectorAll('[data-committed-page-id]')]; window.initialLoads = window.continuityStats().loads; });
  for (const focus of [1, 0, 1, 0]) {
    const result = await page.evaluate(focus => {
      window.continuityMove(5, 0, focus);
      return {
        retained: window.originalCanvases.every(c => c.isConnected && c === document.querySelector(`[data-committed-page-id="${c.dataset.committedPageId}"]`)),
        text: [...document.querySelectorAll('[data-stable-page-visual]')].every(el => el.textContent.includes(`Page ${el.dataset.stablePageVisual}`)),
        loads: window.continuityStats().loads,
        initialLoads: window.initialLoads,
        liveOwner: document.querySelector('[data-live-page-visual]')?.dataset.livePageVisual,
      };
    }, focus);
    assert.equal(result.retained, true);
    assert.equal(result.text, true);
    assert.equal(result.loads, result.initialLoads, 'focus must reuse already decoded images');
    assert.equal(result.liveOwner, String(focus));
  }
  await page.evaluate(() => window.continuityEdit());
  const before = await page.locator('[data-committed-page-id="0"]').evaluate(c => c.toDataURL());
  await page.evaluate(() => window.continuityMove(5, 0, 1));
  assert.equal(await page.locator('[data-committed-page-id="0"]').evaluate(c => c.toDataURL()), before, 'outgoing committed ink/image/shape bitmap is unchanged');
  const results = [];
  for (const count of [5, 10, 20, 50]) {
    let maxCanvases = 0;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < count; i++) {
        const index = pass % 2 ? count - i - 1 : i;
        const stats = await page.evaluate(({ count, index }) => {
          window.continuityMove(count, index * 700, index);
          if (index % 7 === 0) window.continuityEdit();
          return { canvases: document.querySelectorAll('canvas').length, live: document.querySelectorAll('[data-live-page-visual]').length, editors: document.querySelectorAll('[contenteditable="true"]').length, cache: window.continuityStats().activeCache, managers: window.continuityStats().residentManagers, decoded: window.continuityStats().decodedReferences };
        }, { count, index });
        maxCanvases = Math.max(maxCanvases, stats.canvases);
        assert.ok(stats.canvases <= 5, JSON.stringify(stats));
        assert.equal(stats.live, 1);
        assert.ok(stats.editors <= 1);
        assert.ok(stats.cache <= 1);
        assert.ok(stats.managers <= 4);
        assert.ok(stats.decoded <= 5);
      }
    }
    results.push({ pages: count, traversals: 3, maxCanvases });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, results }));
} finally { await browser.close(); await server.close(); }
