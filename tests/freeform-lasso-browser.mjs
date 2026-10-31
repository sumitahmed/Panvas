// Freeform lasso regression: the drawn polygon is the visible and movable
// selection. Dragging from INSIDE the region must move the selected content —
// the rectangular bounding frame must not be the required drag target.
// Usage: node tests/freeform-lasso-browser.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const outDir = 'artifacts/freeform-lasso-probe';
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

await page.evaluate(() => {
  window.navProbe.setSelectTool();
  // Isolate a fresh page region: target the fixture's ink mark on page 1.
});
const strokesBefore = await page.evaluate(() => window.navProbe.strokeGeometry());
const target = strokesBefore[0];
console.log('target stroke:', JSON.stringify(target));

// 1. Freeform lasso around the target stroke.
await page.evaluate(() => window.navProbe.canvasPointer('pointerdown', 30, 30));
for (const point of [[200, 30], [200, 200], [30, 200], [30, 30]]) {
  await page.evaluate(([x, y]) => window.navProbe.canvasPointer('pointermove', x, y), point);
  await page.waitForTimeout(15);
}
await page.evaluate(() => window.navProbe.canvasPointer('pointerup', 30, 30));
await page.waitForTimeout(150);
const selected = await page.evaluate(() => [...window.navProbe.selectionIds()]);
console.log('selected after freeform lasso:', JSON.stringify(selected));
assert.ok(selected.includes(target.id), 'the enclosed stroke must be selected');
assert.equal(selected.length, 1, 'exactly the enclosed stroke is selected');

// 2. Drag from INSIDE the freeform region (empty paper, not on the stroke, not
// on the bounding frame): the selection must move.
const dragFrom = { x: 110, y: 110 }; // inside the loop, away from the stroke ink
await page.evaluate(([x, y]) => window.navProbe.canvasPointer('pointerdown', x, y), [dragFrom.x, dragFrom.y]);
for (let i = 1; i <= 8; i++) {
  await page.evaluate(([x, y, i]) => window.navProbe.canvasPointer('pointermove', x + i * 7, y + i * 5), [dragFrom.x, dragFrom.y, i]);
  await page.waitForTimeout(15);
}
await page.evaluate(([x, y]) => window.navProbe.canvasPointer('pointerup', x + 56, y + 40), [dragFrom.x, dragFrom.y]);
await page.waitForTimeout(200);
const strokesAfter = await page.evaluate(() => window.navProbe.strokeGeometry());
const moved = strokesAfter.find(stroke => stroke.id === target.id);
console.log('stroke before:', JSON.stringify(target), 'after:', JSON.stringify(moved));
assert.ok(Math.abs(moved.x - target.x - 56) < 2 && Math.abs(moved.y - target.y - 40) < 2,
  `dragging inside the freeform region must move the selection (${JSON.stringify(moved)})`);
const selectedAfter = await page.evaluate(() => [...window.navProbe.selectionIds()]);
assert.deepEqual(selectedAfter, selected, 'the selection survives the region move');

// 3. Clicking OUTSIDE the region clears it (empty-canvas click behavior).
await page.evaluate(([x, y]) => window.navProbe.canvasPointer('pointerdown', x, y), [700, 600]);
await page.evaluate(([x, y]) => window.navProbe.canvasPointer('pointerup', x, y), [700, 600]);
await page.waitForTimeout(150);
const cleared = await page.evaluate(() => window.navProbe.selectionIds().size);
assert.equal(cleared, 0, 'clicking outside the freeform region clears the selection');

// 4. Rectangle mode still produces a rectangular selection with handles.
await page.evaluate(() => {
  window.navProbe.engine().tools.setSelectionShape('rectangle');
  window.navProbe.canvasPointer('pointerdown', 30, 30);
});
for (const point of [[220, 220]]) {
  await page.evaluate(([x, y]) => window.navProbe.canvasPointer('pointermove', x, y), point);
  await page.waitForTimeout(15);
}
await page.evaluate(() => window.navProbe.canvasPointer('pointerup', 220, 220));
await page.waitForTimeout(150);
const rectSelected = await page.evaluate(() => [...window.navProbe.selectionIds()]);
assert.ok(rectSelected.includes(target.id), 'rectangle mode still selects the enclosed stroke');

assert.deepEqual(errors, [], `no page errors: ${JSON.stringify(errors)}`);
console.log('FREEFORM LASSO REGRESSION: PASS');
await page.screenshot({ path: path.join(outDir, 'final.png') });
await browser.close();
await server.close();
