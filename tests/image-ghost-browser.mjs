// Image ghost regression: pastes an image through the real storage pipeline,
// moves it with real pointer input, and asserts that only one visible
// representation exists at any moment (no stale copy at the old position).
// Usage: node tests/image-ghost-browser.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const outDir = 'artifacts/image-ghost-probe';
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

// Paste an image over the page (the reported workflow).
const imageId = await page.evaluate(async () => window.navProbe.pasteImage(120, 120));
await page.waitForTimeout(300);

const overlayState = () => page.evaluate(imageId => {
  const overlays = [...document.querySelectorAll(`[data-image-overlay="${imageId}"]`)];
  const rect = overlays[0]?.getBoundingClientRect();
  return {
    count: overlays.length,
    left: overlays[0] ? parseFloat(overlays[0].style.left) : null,
    top: overlays[0] ? parseFloat(overlays[0].style.top) : null,
    transform: overlays[0]?.style.transform ?? '',
    visibility: overlays[0] ? getComputedStyle(overlays[0]).visibility : null,
    rectX: rect ? Math.round(rect.x) : null,
    rectY: rect ? Math.round(rect.y) : null,
  };
}, imageId);

const objectState = () => page.evaluate(imageId => {
  const image = window.navProbe.engine().images.getImages().find(item => item.id === imageId);
  return { x: image?.x, y: image?.y };
}, imageId);

const before = { overlay: await overlayState(), object: await objectState() };
console.log('before move:', JSON.stringify(before));
assert.equal(before.overlay.count, 1, 'exactly one overlay per image');
assert.ok(Math.abs(before.overlay.left - 120) < 0.01);

// Move the image 180 right, 120 down with real pointer input.
const move = await page.evaluate(async ([imageId, dx, dy]) =>
  window.navProbe.selectAndMoveImage(imageId, dx, dy), [imageId, 180, 120]);
console.log('mid-drag overlay transform:', move.midTransform);
assert.ok(move.midTransform.includes('translate3d('), `overlay must track the live drag delta (${move.midTransform})`);
const midDelta = move.midTransform.match(/translate3d\(([\d.-]+)px, ([\d.-]+)px/);
assert.ok(midDelta && Math.hypot(parseFloat(midDelta[1]), parseFloat(midDelta[2])) > 50,
  `overlay must track the live drag delta substantially (${move.midTransform})`);

const after = { overlay: await overlayState(), object: await objectState() };
console.log('after move:', JSON.stringify(after));
assert.equal(after.overlay.count, 1, 'still exactly one overlay after the move');
assert.ok(Math.abs(after.object.x - 300) < 0.01, 'object committed at the new position');
assert.ok(Math.abs(after.overlay.left - 300) < 0.01, 'overlay reconciled to the committed position');
assert.ok(Math.abs(after.overlay.top - 240) < 0.01, 'overlay top reconciled');
assert.equal(after.overlay.visibility, 'visible', 'overlay restored after commit');
assert.ok(Math.abs(after.overlay.transform.replace(/rotate\([^)]*\)/, '').length < 40), 'no leftover preview translate after commit');

// The committed canvas must not paint a ghost at the OLD location.
const canvasGhost = await page.evaluate(([imageId]) => {
  const engine = window.navProbe.engine();
  const canvas = engine.drawing.getCanvasElement();
  const ctx = canvas.getContext('2d');
  const image = engine.images.getImages().find(item => item.id === imageId);
  const scale = canvas.width / canvas.clientWidth;
  const probe = (px, py) => {
    const visual = engine.viewport.pageToCanvas(px, py);
    const data = ctx.getImageData(Math.round(visual.x * scale), Math.round(visual.y * scale), 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  };
  return { oldCenter: probe(160, 140), newCenter: probe(image.x + 60, image.y + 40) };
}, [imageId]);
console.log('canvas probes:', JSON.stringify(canvasGhost));
assert.ok(canvasGhost.oldCenter[3] < 40, `old location must be blank on canvas (alpha ${canvasGhost.oldCenter[3]})`);
assert.ok(canvasGhost.newCenter[3] > 200, 'new location must contain the image');

// Move again (repeat movement), then undo and verify the overlay follows back.
await page.evaluate(async ([imageId, dx, dy]) => window.navProbe.selectAndMoveImage(imageId, dx, dy), [imageId, -60, -40]);
await page.waitForTimeout(100);
const afterSecond = await objectState();
console.log('after second move:', JSON.stringify(afterSecond));
assert.ok(Math.abs(afterSecond.x - 240) < 0.01, 'second move applies');
await page.evaluate(() => window.navProbe.engine().history.undo());
await page.waitForTimeout(150);
const afterUndo = { overlay: await overlayState(), object: await objectState() };
console.log('after undo:', JSON.stringify(afterUndo));
assert.ok(Math.abs(afterUndo.object.x - 300) < 0.01, 'undo restores the committed position');
assert.ok(Math.abs(afterUndo.overlay.left - 300) < 0.01, 'undo reconciles the overlay');
await page.evaluate(() => window.navProbe.engine().history.redo());
await page.waitForTimeout(150);
const afterRedo = await objectState();
assert.ok(Math.abs(afterRedo.x - 240) < 0.01, 'redo reapplies the move');

assert.deepEqual(errors, [], `no page errors: ${JSON.stringify(errors)}`);
console.log('IMAGE GHOST REGRESSION: PASS');
await page.screenshot({ path: path.join(outDir, 'final.png') });
await browser.close();
await server.close();
