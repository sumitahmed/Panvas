// Regression: ink over an opaque image must be visible while it is being
// drawn and after it is committed. This intentionally samples the composited
// screenshot, not just the canvas, so an opaque DOM image overlay cannot hide
// the stroke while the canvas underneath contains the correct pixels.
// Usage: node tests/image-ink-layer-browser.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const outDir = 'artifacts/image-ink-layer';
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
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    engine.tools.setDrawingTool('pen');
    engine.tools.setColor('#e11d48');
    engine.tools.setThickness(10);
    engine.tools.setOpacity(1);
    engine.tools.setStabilization(0);
  });

  const initialStrokes = await page.evaluate(() => window.navProbe.engine().drawing.getStrokes().length);
  const imageId = await page.evaluate(async () => window.navProbe.pasteImage(120, 120));
  await page.waitForTimeout(700);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const geometry = await page.evaluate(imageId => {
    const engine = window.navProbe.engine();
    const image = engine.images.getImages().find(item => item.id === imageId);
    const canvas = engine.drawing.getCanvasElement();
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const toClient = (pageX, pageY) => {
      const visual = engine.viewport.pageToCanvas(pageX, pageY);
      return {
        x: rect.left + visual.x * rect.width / canvas.clientWidth,
        y: rect.top + visual.y * rect.height / canvas.clientHeight,
      };
    };
    const start = toClient(image.x + 8, image.y + 12);
    const end = toClient(image.x + image.width - 8, image.y + 12);
    const midpoint = toClient(image.x + image.width / 2, image.y + 12);
    return { image, start, end, midpoint, scaleX, scaleY };
  }, imageId);

  const pointer = async (type, point) => page.evaluate(({ type, point }) => {
    const canvas = window.navProbe.engine().drawing.getCanvasElement();
    canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      pointerId: 91,
      pointerType: 'pen',
      button: type === 'pointerdown' ? 0 : type === 'pointerup' ? 0 : -1,
      buttons: type === 'pointerup' ? 0 : 1,
      pressure: 0.5,
      clientX: point.x,
      clientY: point.y,
    }));
  }, { type, point });

  const sampleScreenshot = async (name, point) => {
    const buffer = await page.screenshot();
    const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const x = Math.max(0, Math.min(info.width - 1, Math.round(point.x)));
    const y = Math.max(0, Math.min(info.height - 1, Math.round(point.y)));
    const offset = (y * info.width + x) * info.channels;
    const pixel = [data[offset], data[offset + 1], data[offset + 2]];
    await sharp(buffer).toFile(path.join(outDir, `${name}.png`));
    return { pixel, x, y };
  };

  await pointer('pointerdown', geometry.start);
  for (let step = 1; step <= 12; step += 1) {
    const t = step / 12;
    await pointer('pointermove', {
      x: geometry.start.x + (geometry.end.x - geometry.start.x) * t,
      y: geometry.start.y + (geometry.end.y - geometry.start.y) * t + Math.sin(t * Math.PI) * 2,
    });
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const live = await sampleScreenshot('live-over-image', geometry.midpoint);
  const liveIsInk = live.pixel[0] > 110 && live.pixel[0] > live.pixel[1] * 1.35 && live.pixel[0] > live.pixel[2] * 1.1;
  assert.ok(liveIsInk, `live ink must be visible over the opaque image; sampled ${JSON.stringify(live.pixel)} at ${live.x},${live.y}`);

  await pointer('pointerup', geometry.end);
  await page.waitForTimeout(180);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const committed = await sampleScreenshot('committed-over-image', geometry.midpoint);
  const committedIsInk = committed.pixel[0] > 110 && committed.pixel[0] > committed.pixel[1] * 1.35 && committed.pixel[0] > committed.pixel[2] * 1.1;
  assert.ok(committedIsInk, `committed ink must remain visible over the opaque image; sampled ${JSON.stringify(committed.pixel)} at ${committed.x},${committed.y}`);

  const state = await page.evaluate(({ imageId }) => {
    const engine = window.navProbe.engine();
    return {
      strokes: engine.drawing.getStrokes().length,
      imageCount: engine.images.getImages().filter(image => image.id === imageId).length,
      overlays: document.querySelectorAll(`[data-image-overlay="${imageId}"]`).length,
      liveOpacity: document.querySelector('canvas[data-panvas-wet-ink="true"]')?.style.opacity ?? null,
    };
  }, { imageId });
  assert.equal(state.strokes, initialStrokes + 1, 'exactly one new committed stroke');
  assert.equal(state.imageCount, 1, 'exactly one image object');
  assert.equal(state.overlays, 0, 'the presentation canvas is the sole image representation');
  assert.ok(state.liveOpacity === null || state.liveOpacity === '0', 'retained wet-ink spare must be visually empty');
  assert.deepEqual(errors, [], `no page errors: ${JSON.stringify(errors)}`);
  console.log('IMAGE INK LAYER REGRESSION: PASS', JSON.stringify({ live, committed, state }));
} finally {
  if (browser) await browser.close();
  await server.close();
}
