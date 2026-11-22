// Image ghost regression: pastes an image through the real storage pipeline,
// moves it with real pointer input, and asserts that the composited page shows
// exactly one image: the old location is blank and the new location is not.
// Usage: node tests/image-ghost-browser.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const outDir = 'artifacts/image-ghost-probe';
await mkdir(outDir, { recursive: true });
const server = await createServer({ mode: 'web', cacheDir: path.join(outDir, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/navigation-probe.html'] }, server: { port: 0, open: false } });

let browser;
try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + 'tests/fixtures/navigation-probe.html', { timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.navProbe?.engine()?.drawing?.getCanvasElement?.()), null, { timeout: 90000 });
  await page.waitForTimeout(400);

  const imageId = await page.evaluate(async () => window.navProbe.pasteImage(120, 120));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.navProbe.setSelectTool());

  const objectState = () => page.evaluate(imageId => {
    const image = window.navProbe.engine().images.getImages().find(item => item.id === imageId);
    return image ? { x: image.x, y: image.y, width: image.width, height: image.height } : null;
  }, imageId);

  const representationState = () => page.evaluate(imageId => {
    const focused = document.querySelector('[data-focused-sheet="true"][data-page-id]');
    const liveRoot = focused?.querySelector('[data-live-page-visual]');
    const liveLayers = liveRoot
      ? [...liveRoot.querySelectorAll('canvas[data-panvas-presentation-layer]')].filter(canvas => getComputedStyle(canvas).visibility !== 'hidden')
      : [];
    return {
      overlays: document.querySelectorAll(`[data-image-overlay="${imageId}"]`).length,
      liveLayers: liveLayers.length,
      imageObjects: window.navProbe.engine().images.getImages().filter(image => image.id === imageId).length,
    };
  }, imageId);

  const pointerAt = async (type, pageX, pageY) => page.evaluate(({ type, pageX, pageY }) => {
    const engine = window.navProbe.engine();
    const canvas = engine.drawing.getCanvasElement();
    const point = window.navProbe.canvasPoint(pageX, pageY);
    canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      pointerId: 55,
      pointerType: 'pen',
      button: type === 'pointerdown' ? 0 : type === 'pointerup' ? 0 : -1,
      buttons: type === 'pointerup' ? 0 : 1,
      pressure: .5,
      clientX: point.x,
      clientY: point.y,
    }));
  }, { type, pageX, pageY });

  const sampleScreenshot = async (name, pageX, pageY) => {
    const point = await page.evaluate(([pageX, pageY]) => window.navProbe.canvasPoint(pageX, pageY), [pageX, pageY]);
    const buffer = await page.screenshot();
    const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const x = Math.max(0, Math.min(info.width - 1, Math.round(point.x)));
    const y = Math.max(0, Math.min(info.height - 1, Math.round(point.y)));
    const offset = (y * info.width + x) * info.channels;
    const pixel = [data[offset], data[offset + 1], data[offset + 2]];
    await sharp(buffer).toFile(path.join(outDir, `${name}.png`));
    return { pixel, x, y };
  };
  const isImageBlue = pixel => pixel[2] > 140 && pixel[2] > pixel[0] * 1.5 && pixel[2] > pixel[1] * 1.2;

  const before = await objectState();
  const beforeState = await representationState();
  const beforePixel = await sampleScreenshot('before', before.x + 10, before.y + 10);
  assert.deepEqual(beforeState, { overlays: 0, liveLayers: 1, imageObjects: 1 }, 'one image object and one visible presentation layer');
  assert.ok(isImageBlue(beforePixel.pixel), `image must be visible before the move (${beforePixel.pixel})`);

  // Hold real pointer input mid-drag so the composited page can be inspected
  // before commit.
  const start = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  const dx = 180, dy = 120;
  await pointerAt('pointerdown', start.x, start.y);
  for (let step = 1; step <= 8; step += 1) {
    await pointerAt('pointermove', start.x + dx * step / 8, start.y + dy * step / 8);
    await page.waitForTimeout(16);
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const midState = await objectState();
  console.log('mid-drag state:', JSON.stringify(midState), 'representations:', JSON.stringify(await representationState()));
  const midOld = await sampleScreenshot('mid-old', before.x + 10, before.y + 10);
  const midNew = await sampleScreenshot('mid-new', midState.x + 10, midState.y + 10);
  assert.ok(Math.abs(midState.x - 300) < 0.01, `image must move during the drag (${midState.x})`);
  assert.ok(!isImageBlue(midOld.pixel), `old position must be blank during the drag (${midOld.pixel})`);
  assert.ok(isImageBlue(midNew.pixel), `new position must contain the image during the drag (${midNew.pixel})`);

  await pointerAt('pointerup', start.x + dx, start.y + dy);
  await page.waitForTimeout(180);
  const after = await objectState();
  assert.ok(Math.abs(after.x - 300) < 0.01, `object committed at the new position (${after.x})`);
  const afterOld = await sampleScreenshot('after-old', before.x + 10, before.y + 10);
  const afterNew = await sampleScreenshot('after-new', after.x + 10, after.y + 10);
  assert.ok(!isImageBlue(afterOld.pixel), `old position must stay blank after commit (${afterOld.pixel})`);
  assert.ok(isImageBlue(afterNew.pixel), `new position must contain the image after commit (${afterNew.pixel})`);
  assert.equal((await representationState()).overlays, 0, 'no legacy DOM image overlay may represent a page image');

  // Move again, then undo and redo; each state must still have one visible copy.
  await page.evaluate(async ([imageId, dx, dy]) => window.navProbe.selectAndMoveImage(imageId, dx, dy), [imageId, -60, -40]);
  await page.waitForTimeout(100);
  const afterSecond = await objectState();
  assert.ok(Math.abs(afterSecond.x - 240) < 0.01, 'second move applies');
  await page.evaluate(() => window.navProbe.engine().history.undo());
  await page.waitForTimeout(150);
  const afterUndo = await objectState();
  const undoOld = await sampleScreenshot('undo-old', 250, 210);
  const undoNew = await sampleScreenshot('undo-new', 310, 250);
  assert.ok(Math.abs(afterUndo.x - 300) < 0.01, `undo restores the committed position (${afterUndo.x})`);
  assert.ok(!isImageBlue(undoOld.pixel), `second-move position must be blank after undo (${undoOld.pixel})`);
  assert.ok(isImageBlue(undoNew.pixel), `restored position must contain the image after undo (${undoNew.pixel})`);

  await page.evaluate(() => window.navProbe.engine().history.redo());
  await page.waitForTimeout(150);
  const afterRedo = await objectState();
  assert.ok(Math.abs(afterRedo.x - 240) < 0.01, 'redo reapplies the move');
  const redoOld = await sampleScreenshot('redo-old', 310, 250);
  const redoNew = await sampleScreenshot('redo-new', 250, 210);
  assert.ok(!isImageBlue(redoOld.pixel), `pre-redo position must be blank after redo (${redoOld.pixel})`);
  assert.ok(isImageBlue(redoNew.pixel), `redo position must contain the image (${redoNew.pixel})`);

  // Multi-layer smoke: a stroke on the upper layer must survive an image drag
  // on the lower layer, and the image must still have one visible copy.
  await page.evaluate(() => {
    const engine = window.navProbe.engine();
    const layer = engine.layers.create('Upper layer');
    engine.layers.setActive(layer.id);
    engine.drawing.addStroke({
      id: 'upper-layer-stroke',
      type: 'stroke',
      tool: 'pen',
      color: '#15803d',
      thickness: 7,
      opacity: 1,
      centerline: 'polyline',
      createdAt: 1,
      layerId: layer.id,
      points: [
        { x: 90, y: 540, pressure: .5, t: 0 },
        { x: 260, y: 540, pressure: .5, t: 20 },
      ],
    });
    engine.drawing.redraw();
  });
  await page.waitForTimeout(250);
  const beforeMulti = await objectState();
  await page.evaluate(async ([imageId, dx, dy]) => window.navProbe.selectAndMoveImage(imageId, dx, dy), [imageId, 40, 20]);
  await page.waitForTimeout(180);
  const afterMulti = await objectState();
  const multiOld = await sampleScreenshot('multi-old', beforeMulti.x + 10, beforeMulti.y + 10);
  const multiNew = await sampleScreenshot('multi-new', afterMulti.x + 10, afterMulti.y + 10);
  const upperLayer = await sampleScreenshot('multi-upper-layer', 150, 540);
  assert.ok(!isImageBlue(multiOld.pixel), `lower-layer image old position must be blank (${multiOld.pixel})`);
  assert.ok(isImageBlue(multiNew.pixel), `lower-layer image must remain visible (${multiNew.pixel})`);
  assert.ok(upperLayer.pixel[1] > 90 && upperLayer.pixel[1] > upperLayer.pixel[0] * 1.2, `upper-layer stroke must survive (${upperLayer.pixel})`);

  assert.deepEqual(errors, [], `no page errors: ${JSON.stringify(errors)}`);
  console.log('IMAGE GHOST REGRESSION: PASS');
} finally {
  if (browser) await browser.close();
  await server.close();
}
