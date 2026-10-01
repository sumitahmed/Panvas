import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ mode: 'web', server: { port: 0, open: false } });
await server.listen();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PANVAS_QA_CHROMIUM ? { executablePath: process.env.PANVAS_QA_CHROMIUM } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
let passed = 0;
const settle = page => page.evaluate(async () => {
  for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
  await new Promise(resolve => setTimeout(resolve, 170));
});
const snapshot = page => page.evaluate(() => window.navigationSnapshot());

async function prepare(page, index = 0, mode = 'hand') {
  await page.evaluate(({ index, mode }) => {
    window.navigationEngine().tools.setMode(mode);
    window.navigationSelect(index);
  }, { index, mode });
  await page.waitForFunction(index => {
    const state = window.navigationSnapshot();
    return state.owner === window.navigationIds[index] && state.focused === state.owner
      && !!document.querySelector(`canvas[data-rendered-page-id="${state.owner}"]`);
  }, index);
  await settle(page);
  await page.evaluate(() => window.navigationRemember());
}

async function assertHeld(page, ownerIndex, dominantIndex) {
  await page.waitForFunction(index => window.navigationSnapshot().active === window.navigationIds[index], dominantIndex);
  await settle(page); // Deliberately let the activePage -> focusedPage effect run.
  const state = await snapshot(page);
  const owner = await page.evaluate(index => window.navigationIds[index], ownerIndex);
  assert.equal(state.owner, owner);
  assert.equal(state.focused, owner);
  assert.equal(state.navigationActive, true);
  assert.equal(state.originalConnected, true);
  assert.equal(state.sameCanvas, true);
  assert.deepEqual(state.counts, { mount: 0, unmount: 0, attach: 0, detach: 0, load: 0 });
}

async function assertReleased(page, targetIndex, handoffs = 1) {
  await page.waitForFunction(index => {
    const state = window.navigationSnapshot();
    return !state.navigationActive && state.owner === window.navigationIds[index] && state.focused === state.owner;
  }, targetIndex);
  await settle(page);
  const state = await snapshot(page);
  assert.deepEqual(state.counts, { mount: handoffs, unmount: handoffs, attach: handoffs, detach: handoffs, load: handoffs });
}

async function driver(page, kind = 'touch') {
  const point = await page.evaluate(() => {
    const canvas = window.navigationEngine().drawing.getCanvasElement();
    const viewport = canvas.closest('.notebook-viewport');
    const bounds = canvas.getBoundingClientRect();
    const box = viewport.getBoundingClientRect();
    const x = Math.max(box.left, bounds.left) + Math.min(box.width, bounds.width) / 2;
    const top = Math.max(box.top, bounds.top);
    const bottom = Math.min(box.bottom, bounds.bottom);
    const y = top + (bottom - top) * .5;
    if (document.elementFromPoint(x, y) !== canvas) throw new Error('Gesture must begin on the LIVE interaction canvas');
    return { x, y };
  });
  const session = await page.context().newCDPSession(page);
  let points = [{ ...point, id: 71, radiusX: 1, radiusY: 1, force: 1 }];
  const touch = type => session.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const pen = (type, buttons) => session.send('Input.dispatchMouseEvent', {
    type, x: points[0].x, y: points[0].y, button: 'left', buttons,
    pointerType: 'pen', force: buttons ? .5 : 0, clickCount: 1,
  });
  if (kind === 'touch') await touch('touchStart');
  else if (kind === 'pen') {
    await pen('mouseMoved', 0);
    await pen('mousePressed', 1);
  }
  else {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down({ button: kind === 'middle' ? 'middle' : 'left' });
  }
  return {
    async promote() {
      points.push({ ...point, x: point.x + 70, id: 72, radiusX: 1, radiusY: 1, force: 1 });
      await touch('touchStart');
    },
    async pinch() {
      points[0].x -= 10;
      points[1].x += 10;
      await touch('touchMove');
      await settle(page);
    },
    async moveBy(delta) {
      points = points.map(point => ({ ...point, y: point.y - delta }));
      if (kind === 'touch') await touch('touchMove');
      else if (kind === 'pen') await pen('mouseMoved', 1);
      else await page.mouse.move(points[0].x, points[0].y);
    },
    async moveTo(index) {
      const delta = await page.evaluate(index => {
        const viewport = document.querySelector('.notebook-viewport');
        const sheet = viewport.querySelector(`[data-page-index="${index}"]`);
        const page = sheet.getBoundingClientRect();
        const box = viewport.getBoundingClientRect();
        const targetTop = Math.max(0, viewport.scrollTop + page.top - box.top + page.height / 2 - viewport.clientHeight / 2);
        return targetTop - viewport.scrollTop;
      }, index);
      await this.moveBy(delta);
    },
    async end(cancel = false) {
      if (kind === 'touch') {
        points = [];
        await touch(cancel ? 'touchCancel' : 'touchEnd');
      } else if (kind === 'pen') await pen('mouseReleased', 0);
      else await page.mouse.up({ button: kind === 'middle' ? 'middle' : 'left' });
    },
    async liftOne() {
      points.shift();
      await touch('touchEnd');
    },
  };
}

async function runCase(page, name, run) {
  try { await run(); } catch (error) {
    console.error(`FAIL: ${name}`, await snapshot(page));
    throw error;
  }
  passed++;
  console.log(`PASS: ${name}`);
}

try {
  for (const dpr of [2, 3]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls.local[0]}tests/fixtures/notebook-navigation.html`);
    await page.waitForFunction(() => window.navigationReady?.() && window.navigationEngine?.()?.drawing.getCanvasElement());

    for (const [name, start, targets] of [
      ['A to B', 0, [1]], ['B to A', 1, [0]],
      ['latest target across multiple boundaries', 0, [1, 3, 2]],
      ['return to original owner cancels pending handoff', 0, [1, 0]],
    ]) await runCase(page, `DPR ${dpr}: ${name}`, async () => {
      await prepare(page, start);
      const pan = await driver(page);
      for (const target of targets) {
        await pan.moveTo(target);
        await assertHeld(page, start, target);
      }
      const last = targets.at(-1);
      const before = (await snapshot(page)).scrollTop;
      await pan.moveBy(25);
      await assertHeld(page, start, last);
      assert.notEqual((await snapshot(page)).scrollTop, before, 'the same captured pointer must keep scrolling');
      const events = (await snapshot(page)).pointerEvents;
      assert.ok(events.some(event => event.type === 'pointermove' && event.trusted));
      assert.equal(new Set(events.map(event => event.id)).size, 1, 'one pointer ID must survive the page crossing');
      await pan.end();
      await assertReleased(page, last, start === last ? 0 : 1);
    });

    for (const termination of ['pointercancel', 'capture loss', 'blur', 'tool change']) await runCase(page, `DPR ${dpr}: ${termination}`, async () => {
      await prepare(page);
      const pan = await driver(page);
      await pan.moveTo(1);
      await assertHeld(page, 0, 1);
      if (termination === 'pointercancel') await pan.end(true);
      else if (termination === 'capture loss') {
        await page.evaluate(() => {
          const engine = window.navigationEngine();
          const id = window.navigationSnapshot().pointerEvents.find(event => event.type === 'pointerdown').id;
          const canvas = engine.drawing.getCanvasElement();
          if (!canvas.hasPointerCapture(id)) throw new Error('The original canvas must own capture before testing capture loss');
          canvas.releasePointerCapture(id);
        });
        await pan.moveBy(1);
      } else if (termination === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      else await page.evaluate(() => window.navigationEngine().tools.setMode('select'));
      await assertReleased(page, 1);
      if (termination !== 'pointercancel') await pan.end();
    });

    await runCase(page, `DPR ${dpr}: active-page synchronization cannot bypass the guard`, async () => {
      await prepare(page);
      const pan = await driver(page);
      await page.evaluate(() => window.navigationSelect(1));
      await assertHeld(page, 0, 1);
      await pan.end();
      await assertReleased(page, 1);
    });

    await runCase(page, `DPR ${dpr}: final move and release in one task use the latest page`, async () => {
      await prepare(page);
      const pan = await driver(page);
      await pan.moveTo(1);
      await assertHeld(page, 0, 1);
      // Use the held native pointer ID through the real InputManager path, but
      // dispatch the final move/up in one task so no scroll rAF can intervene.
      await page.evaluate(() => {
        const engine = window.navigationEngine();
        const canvas = engine.drawing.getCanvasElement();
        const viewport = canvas.closest('.notebook-viewport');
        const page = viewport.querySelector('[data-page-index="2"]').getBoundingClientRect();
        const box = viewport.getBoundingClientRect();
        const dy = page.top - box.top + page.height / 2 - viewport.clientHeight / 2;
        const id = window.navigationSnapshot().pointerEvents.find(event => event.type === 'pointerdown').id;
        // The fixture remembers the preceding pointer event's coordinates.
        const position = window.navigationLastPointer;
        const init = { pointerId: id, pointerType: 'touch', isPrimary: true, button: 0, clientX: position.x, clientY: position.y - dy, bubbles: true };
        canvas.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 1 }));
        canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
      });
      await pan.end();
      await assertReleased(page, 2);
    });

    for (const promoteAfterCrossing of [false, true]) await runCase(page, `DPR ${dpr}: ${promoteAfterCrossing ? 'one-finger promotion' : 'two-finger pan/pinch'}`, async () => {
      await prepare(page, 0, promoteAfterCrossing ? 'hand' : 'select');
      const pan = await driver(page);
      if (promoteAfterCrossing) {
        await pan.moveTo(1);
        await assertHeld(page, 0, 1);
      }
      await pan.promote();
      await settle(page);
      assert.equal((await snapshot(page)).counts.unmount, 0, 'promotion must not expose an idle handoff gap');
      if (!promoteAfterCrossing) await pan.pinch();
      await pan.moveTo(2);
      await assertHeld(page, 0, 2);
      await pan.liftOne();
      await assertHeld(page, 0, 2);
      await pan.end();
      await assertReleased(page, 2);
    });

    await runCase(page, `DPR ${dpr}: renderer teardown discards pending activation`, async () => {
      await prepare(page);
      const pan = await driver(page);
      await pan.moveTo(1);
      await assertHeld(page, 0, 1);
      await page.evaluate(() => window.navigationUnmount());
      const state = await snapshot(page);
      assert.equal(state.navigationActive, false);
      assert.equal(state.counts.load, 0, 'teardown must not load the pending scene');
      await pan.end();
    });
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}tests/fixtures/notebook-navigation.html`);
  await page.waitForFunction(() => window.navigationReady?.() && window.navigationEngine?.()?.drawing.getCanvasElement());
  for (const kind of ['hand', 'middle', 'pen']) await runCase(page, `desktop ${kind} pan`, async () => {
    await prepare(page, 0, kind === 'middle' ? 'select' : 'hand');
    const pan = await driver(page, kind);
    await pan.moveTo(1);
    await assertHeld(page, 0, 1);
    await pan.end();
    await assertReleased(page, 1);
  });
  await context.close();
  assert.deepEqual(errors, []);
  console.log(`PASS: ${passed} real-renderer navigation regressions; browser ${browser.version()}`);
} finally {
  await browser.close();
  await server.close();
}
