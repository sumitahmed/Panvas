import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ mode: 'web', server: { port: 0, open: false } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const errors = [];
let passed = 0;
const frames = (page, count = 12) => page.evaluate(async count => {
  for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame);
}, count);
const metrics = page => page.evaluate(() => {
  const viewport = document.querySelector('.notebook-viewport');
  const paper = document.querySelector('[data-page-index="0"]');
  return {
    narrow: matchMedia('(max-width: 599px)').matches,
    coarse: matchMedia('(any-pointer: coarse)').matches,
    touch: navigator.maxTouchPoints > 0,
    touchAction: getComputedStyle(viewport).touchAction,
    width: viewport.clientWidth,
    paperWidth: paper.getBoundingClientRect().width,
    scale: window.navigationEngine().viewport.getState().scale,
    browserScale: visualViewport.scale,
    visualHeight: visualViewport.height,
    shellHeight: document.querySelector('.panvas-app-shell').getBoundingClientRect().height,
    visualVariable: document.documentElement.style.getPropertyValue('--panvas-visual-height'),
  };
});

async function stableScale(page) {
  const scales = await page.evaluate(async () => {
    const scales = [];
    for (let index = 0; index < 30; index++) {
      await new Promise(requestAnimationFrame);
      scales.push(window.navigationEngine().viewport.getState().scale);
    }
    return scales;
  });
  assert.ok(Math.max(...scales) - Math.min(...scales) < 0.000001, 'zoom must settle without oscillation');
}

async function reachable(page, locator) {
  assert.equal(await locator.count(), 1);
  assert.ok(await locator.isVisible());
  assert.equal(await locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
      && !!hit && element.contains(hit);
  }), true, 'control must be in the viewport and unobscured');
}

async function touchDriver(page, point) {
  const session = await page.context().newCDPSession(page);
  let points = point ? [point] : await page.evaluate(() => {
    const canvas = window.navigationEngine().drawing.getCanvasElement();
    const box = canvas.getBoundingClientRect();
    const viewport = canvas.closest('.notebook-viewport').getBoundingClientRect();
    const x = (Math.max(box.left, viewport.left) + Math.min(box.right, viewport.right)) / 2;
    const y = Math.max(box.top, viewport.top) + Math.min(160, (Math.min(box.bottom, viewport.bottom) - Math.max(box.top, viewport.top)) / 2);
    if (document.elementFromPoint(x, y) !== canvas) throw new Error('pan must start on the live canvas');
    return [{ id: 51, x, y }];
  });
  const send = type => session.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await send('touchStart');
  return {
    async moveTo(index) {
      const delta = await page.evaluate(index => {
        const viewport = document.querySelector('.notebook-viewport');
        const sheet = document.querySelector(`[data-page-index="${index}"]`).getBoundingClientRect();
        const box = viewport.getBoundingClientRect();
        const target = Math.max(0, viewport.scrollTop + sheet.top - box.top + sheet.height / 2 - viewport.clientHeight / 2);
        return target - viewport.scrollTop;
      }, index);
      points = points.map(point => ({ ...point, y: point.y - delta }));
      await send('touchMove');
    },
    async end() { points = []; await send('touchEnd'); await session.detach(); },
  };
}

async function panBoundaries(page, targets, handoffs) {
  await page.evaluate(() => { window.navigationEngine().tools.setMode('hand'); window.navigationSelect(0); });
  await page.waitForFunction(() => window.navigationSnapshot().owner === window.navigationIds[0]);
  await frames(page);
  await page.evaluate(() => window.navigationRemember());
  const driver = await touchDriver(page);
  for (const target of targets) {
    await driver.moveTo(target);
    await page.waitForFunction(index => window.navigationSnapshot().active === window.navigationIds[index], target);
    await frames(page);
    const state = await page.evaluate(() => window.navigationSnapshot());
    assert.equal(state.owner, await page.evaluate(() => window.navigationIds[0]));
    assert.equal(state.navigationActive, true);
    assert.equal(state.sameCanvas, true);
    assert.equal(state.originalConnected, true);
    assert.deepEqual(state.counts, { mount: 0, unmount: 0, attach: 0, detach: 0, load: 0 });
    assert.ok(state.pointerEvents.some(event => event.type === 'pointermove' && event.trusted));
  }
  await driver.end();
  await page.waitForFunction(index => !window.navigationSnapshot().navigationActive
    && window.navigationSnapshot().owner === window.navigationIds[index], targets.at(-1));
  await frames(page);
  assert.deepEqual((await page.evaluate(() => window.navigationSnapshot())).counts,
    { mount: handoffs, unmount: handoffs, attach: handoffs, detach: handoffs, load: handoffs });
  await stableScale(page);
}

async function inactivePagePinch(page) {
  await page.evaluate(() => {
    window.navigationSelect(0);
    document.querySelector('.notebook-viewport').scrollTop = 0;
  });
  await page.waitForFunction(() => window.navigationSnapshot().owner === window.navigationIds[0]);
  await frames(page);
  const initial = await metrics(page);
  // Place page 2 below the desktop toolbar but inside the viewport, without
  // changing the live scene owner. A second finger immediately acquires it.
  const points = await page.evaluate(() => {
    const viewport = document.querySelector('.notebook-viewport');
    const page = document.querySelector('[data-page-index="1"]');
    viewport.scrollTop = page.offsetTop * window.navigationEngine().viewport.getState().scale - 250;
    const rect = page.getBoundingClientRect();
    const y = rect.top + 50;
    return [{ id: 61, x: rect.left + rect.width * .3, y }, { id: 62, x: rect.left + rect.width * .6, y }];
  });
  const session = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    window.responsiveCancels = 0;
    document.querySelector('.notebook-viewport').addEventListener('pointercancel', () => window.responsiveCancels++);
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
  await page.evaluate(() => window.navigationRemember());
  const owner = await page.evaluate(() => window.navigationSnapshot().owner);
  for (let step = 0; step < 7; step++) {
    points.forEach(point => { point.y -= 10; });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });
    await frames(page, 1);
    assert.equal(await page.evaluate(() => window.navigationSnapshot().navigationActive), true);
  }
  const distance = points[1].x - points[0].x;
  for (let step = 0; step < 15; step++) {
    points[0].x -= distance / 50;
    points[1].x += distance / 50;
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });
    await frames(page, 1);
    const held = await page.evaluate(() => window.navigationSnapshot());
    assert.equal(held.navigationActive, true);
    assert.equal(held.owner, owner);
    assert.deepEqual(held.counts, { mount: 0, unmount: 0, attach: 0, detach: 0, load: 0 });
  }
  assert.equal(await page.evaluate(() => window.responsiveCancels), 0, 'browser pinch must not steal notebook pinch');
  assert.ok(Math.abs((await metrics(page)).scale - initial.scale * 1.6) < 0.01);
  assert.ok(Math.abs((await metrics(page)).browserScale - initial.browserScale) < 0.001);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => !window.navigationSnapshot().navigationActive);
  await session.detach();
  await stableScale(page);
}

async function check(page, name, run) {
  try { await run(); } catch (error) {
    console.error(`FAIL: ${name}`, await metrics(page), await page.evaluate(() => window.navigationSnapshot()));
    throw error;
  }
  passed++;
  console.log(`PASS: ${name}`);
}

try {
  await mkdir('artifacts', { recursive: true });
  for (const config of [
    { name: 'phone DPR 3', width: 390, height: 844, mobile: true, touch: true, dpr: 3 },
    { name: 'Desktop Site DPR 3', width: 390, height: 844, mobile: true, touch: true, dpr: 3, virtual: true },
    { name: 'wide touch DPR 2', width: 980, height: 844, mobile: false, touch: true, dpr: 2 },
    { name: 'wide touch DPR 3', width: 1280, height: 800, mobile: false, touch: true, dpr: 3 },
    { name: 'hybrid laptop', width: 1280, height: 800, mobile: false, touch: true, emulatedTouch: false, dpr: 2 },
    { name: 'mouse desktop', width: 1280, height: 800, mobile: false, touch: false, dpr: 1 },
  ]) {
    const context = await browser.newContext({ viewport: { width: config.width, height: config.height },
      isMobile: config.mobile, hasTouch: config.emulatedTouch ?? config.touch, deviceScaleFactor: config.dpr });
    if (config.emulatedTouch === false) await context.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 2 });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    if (config.virtual) await page.route('**/notebook-responsive.html?*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('width=device-width, initial-scale=1', 'width=980') });
    });
    await page.goto(`${server.resolvedUrls.local[0]}tests/fixtures/notebook-responsive.html?responsive=1`);
    await page.waitForFunction(() => window.navigationReady?.() && window.navigationEngine?.()?.drawing.getCanvasElement());
    await frames(page);
    const initial = await metrics(page);
    await check(page, `${config.name}: independent layout/input classification and stable fit`, async () => {
      assert.equal(initial.narrow, config.width === 390 && !config.virtual);
      assert.equal(initial.touch, config.touch);
      if (config.emulatedTouch === false) assert.equal(initial.coarse, false, 'fine primary input can coexist with touch capability');
      assert.equal(await page.locator('.panvas-mobile-document-header').count(), initial.narrow ? 1 : 0);
      assert.ok(Math.abs(initial.paperWidth - (initial.narrow ? initial.width - 16 : initial.width * .85)) < 1);
      assert.equal(initial.touchAction, config.touch ? 'pan-x pan-y' : 'auto');
      if (config.touch) {
        assert.ok(initial.visualVariable);
        assert.ok(Math.abs(initial.shellHeight - initial.visualHeight) < 1);
      }
      if (config.virtual) assert.ok(initial.browserScale < .5, 'emulate the real phone and a 980px virtual viewport');
      await stableScale(page);
    });
    await check(page, `${config.name}: Full Page enter/exit and reachable controls`, async () => {
      await reachable(page, page.getByRole('button', { name: 'Enter Full Page View', exact: true }));
      if (initial.narrow) {
        await page.evaluate(() => window.navigationEngine().viewport.setZoom(1));
        await page.getByRole('button', { name: 'Fit page width', exact: true }).click();
        assert.ok(Math.abs((await metrics(page)).paperWidth - (initial.width - 16)) < 1);
        await reachable(page, page.getByRole('button', { name: 'Page utilities', exact: true }));
        await page.getByRole('button', { name: 'Page utilities', exact: true }).click();
        await reachable(page, page.getByRole('button', { name: 'Print page', exact: true }));
        await page.getByRole('button', { name: 'Page utilities', exact: true }).click();
      }
      await page.getByRole('button', { name: 'Enter Full Page View', exact: true }).click();
      await page.waitForFunction(() => window.navigationMode() === 2);
      await frames(page);
      assert.equal(await page.locator('.panvas-topbar').isVisible(), false);
      assert.equal(await page.locator('.panvas-mobile-document-header').count(), 0);
      await reachable(page, page.getByRole('button', { name: 'Exit Full Page View', exact: true }));
      await page.getByRole('button', { name: 'Exit Full Page View', exact: true }).click();
      await page.waitForFunction(() => window.navigationMode() === 0);
      await reachable(page, page.getByRole('button', { name: 'Enter Full Page View', exact: true }));
      await stableScale(page);
      await page.screenshot({ path: `artifacts/qa-responsive-${config.name.replaceAll(' ', '-')}.png` });
    });
    if (config.touch) {
      await check(page, `${config.name}: keyboard viewport and browser pinch guard`, async () => {
        const before = await metrics(page);
        await page.evaluate(() => {
          const viewport = visualViewport;
          Object.defineProperty(viewport, 'height', { configurable: true, value: viewport.height - 160 });
          Object.defineProperty(viewport, 'scale', { configurable: true, value: viewport.scale * 1.5 });
          viewport.dispatchEvent(new Event('resize'));
        });
        await frames(page);
        assert.ok(Math.abs((await metrics(page)).shellHeight - before.shellHeight) < 1, 'browser zoom must not resize the app shell');
        await page.evaluate(() => {
          delete visualViewport.scale;
          visualViewport.dispatchEvent(new Event('resize'));
        });
        await frames(page);
        assert.ok(Math.abs((await metrics(page)).shellHeight - (before.shellHeight - 160)) < 1, 'keyboard height works at the Desktop Site base scale too');
        assert.ok(Math.abs((await metrics(page)).scale - before.scale) < .001);
        await page.evaluate(() => {
          delete visualViewport.height;
          visualViewport.dispatchEvent(new Event('resize'));
        });
        await frames(page);
        assert.ok(Math.abs((await metrics(page)).shellHeight - before.shellHeight) < 1);
      });
      await check(page, `${config.name}: held pan across pages and reverse`, () => panBoundaries(page, [1, 3, 2, 0], 0));
      await check(page, `${config.name}: exactly one latest-target handoff`, () => panBoundaries(page, [1, 2], 1));
      await check(page, `${config.name}: inactive-page pinch keeps notebook ownership`, () => inactivePagePinch(page));
    } else {
      await check(page, 'mouse desktop: workspace inspector and fullscreen tools', async () => {
        await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click();
        await page.locator('.panvas-properties-panel').waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'Enter Full Page View', exact: true }).click();
        assert.ok(await page.getByRole('toolbar', { name: 'Fullscreen notebook tools', exact: true }).isVisible());
        await page.getByRole('button', { name: 'Exit Full Page View', exact: true }).click();
        await page.locator('.panvas-properties-panel').waitFor({ state: 'visible' });
      });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`PASS: ${passed} responsive browser regressions; no browser errors`);
} finally {
  await browser.close();
  await server.close();
}
