import { chromium, _electron } from 'playwright';
import { preview } from 'vite';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// Native color-picker audit. Computer Use operates the actual popup; this
// runner records DOM events, visible swatches and the existing preference API.
const native = process.argv.includes('--electron'), mode = native ? 'electron' : 'chromium';
const out = 'artifacts/palette-settings-20261017';
const profile = await mkdtemp(path.join(tmpdir(), 'panvas-picker-ui-'));
await mkdir(out, { recursive: true });
let app, browser, server, page, stopped = false;
process.on('SIGINT', () => { stopped = true; });
const events = [];
await writeFile(path.join(out, `picker-${mode}-command.json`), JSON.stringify({ action: 'idle' }));
try {
  if (native) {
    const env = { ...process.env, PANVAS_GATE0_PROFILE: '1', PANVAS_GATE0_USER_DATA: path.join(profile, 'profile'), PANVAS_GATE0_WORKSPACE_ROOT: path.join(profile, 'workspaces'), PANVAS_TEST_WINDOW: '1280x900' };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID', 'VITE_DEV_SERVER_URL']) delete env[key];
    app = await _electron.launch({ args: [path.resolve('.')], env }); page = await app.firstWindow();
  } else {
    server = await preview({ configFile: false, build: { outDir: path.resolve('dist') }, preview: { port: 0, open: false } });
    browser = await chromium.launchPersistentContext(path.join(profile, 'profile'), { headless: false, viewport: { width: 1280, height: 900 } });
    page = browser.pages()[0]; await page.goto(server.resolvedUrls.local[0] + 'app');
  }
  page.setDefaultTimeout(30000);
  page.on('console', message => {
    if (message.text().startsWith('PICKER_EVENT:')) { const event = JSON.parse(message.text().slice(13)); events.push(event); console.log(message.text()); }
  });
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
  const local = page.getByRole('button', { name: 'Continue locally', exact: true }); if (await local.isVisible()) await local.click();
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'New Notebook', exact: true }).click();
  await page.locator('#create-dialog-input').fill('Palette UI audit');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('aside').getByText('Palette UI audit', { exact: true }).click();
  await page.getByTitle('Text (T)', { exact: true }).click();
  await page.locator('canvas[data-render-ready="true"]').first().click({ position: { x: 150, y: 150 } });
  await page.locator('.tiptap[contenteditable="true"]').first().fill('Memory safety preserves ownership. Another sentence retains its formatting.');
  await page.evaluate(() => {
    for (const type of ['input', 'change', 'focusin', 'focusout', 'mousedown', 'click']) document.addEventListener(type, event => {
      const input = event.target instanceof HTMLInputElement && event.target.type === 'color';
      const palette = document.querySelector('[aria-label="Highlight color palette"]');
      if (input || palette && type === 'mousedown') console.log('PICKER_EVENT:' + JSON.stringify({ type, trusted: event.isTrusted, value: input ? event.target.value : null, target: event.target.tagName, connected: event.target.isConnected, swatches: [...document.querySelectorAll('[aria-label="Highlight color palette"] [data-color]')].map(el => el.dataset.color), time: performance.now() }));
    }, true);
  });
  await page.getByRole('button', { name: 'Highlight color', exact: true }).click();
  await page.evaluate(mode => { document.title = 'Panvas Palette QA ' + mode; }, mode);
  const snapshot = async () => ({ mode, profile, events: [...events], ...await page.evaluate(async () => ({
    swatches: [...document.querySelectorAll('[aria-label="Highlight color palette"] [data-color]')].map(el => el.dataset.color),
    swatchRendering: [...document.querySelectorAll('[aria-label="Highlight color palette"] [data-color]')].map(el => ({ color: el.dataset.color, background: getComputedStyle(el.querySelector('span')).backgroundColor, visible: el.getBoundingClientRect().height > 0 })),
    preference: window.panvas ? await window.panvas.settings.get(null, 'notebook_highlightPalette') : JSON.parse(localStorage.getItem('panvas_setting_notebook_highlightPalette') ?? 'null'),
    paletteOpen: Boolean(document.querySelector('[aria-label="Highlight color palette"]')),
    highlighterArmed: document.querySelector('[aria-label="Highlight color"]')?.getAttribute('aria-pressed'),
  })) });
  await writeFile(path.join(out, `picker-${mode}-ready.json`), JSON.stringify(await snapshot(), null, 2));
  console.log('READY_FOR_NATIVE_PICKER ' + mode);
  if (process.argv.includes('--event-sequence')) {
    // Reproduce the recorded lifecycle separately from native-popup acceptance:
    // picker previews emit input; the outside mouse-down can unmount the input
    // before Chromium queues change at picker close. Never use fill() here.
    const before = process.argv.includes('--before');
    const checks = [];
    for (const color of ['#9b59b6', '#27ae60', '#123456', '#654321', '#aa4411', '#44aabb', '#ab12cd', '#27ae60']) {
      if (!await page.getByRole('menu', { name: 'Highlight color palette', exact: true }).isVisible()) await page.getByRole('button', { name: 'Highlight color', exact: true }).click();
      const previous = await snapshot();
      await page.getByLabel('Custom highlight color', { exact: true }).evaluate((input, color) => {
        input.focus();
        for (const value of ['#aabbcc', '#bbccdd', color]) {
          input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        window.__pickerClosingInput = input;
      }, color);
      await page.getByRole('button', { name: process.argv.includes('--anchor-case') ? 'Highlight color' : 'Text (T)', exact: true }).click();
      await page.evaluate(() => window.__pickerClosingInput.dispatchEvent(new Event('change', { bubbles: true })));
      await page.getByRole('button', { name: 'Highlight color', exact: true }).click();
      const expected = [...previous.swatches];
      const next = previous.preference?.next ?? 0;
      const inserted = !expected.includes(color);
      if (inserted) expected[next] = color;
      if (!before) await expect.poll(async () => (await snapshot()).preference).toMatchObject({ colors: expected, next: inserted ? (next + 1) % 6 : next, selectedColor: color });
      const after = await snapshot();
      checks.push({ color, previous, after });
      if (before) break;
      assert.deepEqual(after.swatches, expected);
      assert.equal(after.swatchRendering.length, 6);
      for (const swatch of after.swatchRendering) {
        assert.ok(swatch.visible);
        assert.equal(swatch.background, `rgb(${[1,3,5].map(index => parseInt(swatch.color.slice(index,index+2),16)).join(', ')})`);
      }
      assert.equal(after.preference.next, inserted ? (next + 1) % 6 : next);
      assert.equal(after.preference.selectedColor, color);
      await page.screenshot({ path: path.join(out, `picker-${mode}-${checks.length}-swatches.png`) });
    }
    if (!before) {
      for (const action of ['None', 'Escape']) {
        const previous = await snapshot();
        await page.getByLabel('Custom highlight color', { exact: true }).evaluate(input => { input.focus(); input.value = '#aa00ff'; input.dispatchEvent(new Event('input', { bubbles: true })); window.__pickerClosingInput = input; });
        if (action === 'Escape') await page.keyboard.press('Escape');
        else await page.getByRole('menuitemradio', { name: 'None', exact: true }).click();
        await page.evaluate(() => window.__pickerClosingInput.dispatchEvent(new Event('change', { bubbles: true })));
        await page.getByRole('button', { name: 'Highlight color', exact: true }).click();
        if (action === 'None') await expect.poll(async () => (await snapshot()).preference?.selectedColor).toBe(null);
        const after = await snapshot();
        assert.deepEqual(after.swatches, previous.swatches); assert.equal(after.preference.next, previous.preference.next);
        if (action === 'None') assert.equal(after.preference.selectedColor, null);
        checks.push({ action: 'pending preview then ' + action, previous, after });
      }
      const previous = await snapshot();
      await page.getByLabel('Custom highlight color', { exact: true }).evaluate(input => { input.value = '#339988'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.getByRole('menu', { name: 'Highlight color palette', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('button', { name: 'Highlight color', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: 'Highlight color', exact: true }).click();
      const after = await snapshot(), expected = [...previous.swatches]; expected[previous.preference.next] = '#339988';
      assert.deepEqual(after.swatches, expected); assert.equal(after.preference.next, (previous.preference.next + 1) % 6);
      checks.push({ action: 'change commits once and arms chosen color', previous, after });
    }
    await writeFile(path.join(out, `picker-${mode}-event-sequence-${before ? 'before' : 'after'}${process.argv.includes('--anchor-case') ? '-anchor' : ''}.json`), JSON.stringify({ mode, profile, checks, evidenceKind: 'modeled native event ordering with actual dismissal mouse click; not native popup acceptance' }, null, 2));
    stopped = true;
  }
  let previousCommand = '';
  while (!stopped) {
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      const raw = await readFile(path.join(out, `picker-${mode}-command.json`), 'utf8');
      if (raw === previousCommand) continue;
      previousCommand = raw;
      const command = JSON.parse(raw);
      if (command.action === 'open') {
        if (!await page.getByRole('menu', { name: 'Highlight color palette', exact: true }).isVisible()) await page.getByRole('button', { name: 'Highlight color', exact: true }).click();
      }
      if (command.action === 'picker') {
        if (app) await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows().find(w => !w.isDestroyed())?.focus(); });
        await page.getByLabel('Custom highlight color', { exact: true }).click();
      }
      if (command.action === 'keys') for (const key of command.keys) await page.keyboard.press(key);
      if (command.action === 'click') await page.mouse.click(command.x, command.y);
      if (command.action === 'text') await page.keyboard.type(command.text);
      await page.screenshot({ path: path.join(out, `picker-${mode}-page.png`) });
      const cdp = await page.context().newCDPSession(page);
      if (command.action === 'inspect' || command.action === 'picker') {
        const targets = await cdp.send('Target.getTargets');
        const tree = await cdp.send('Accessibility.getFullAXTree');
        await writeFile(path.join(out, `picker-${mode}-ax.json`), JSON.stringify({targets,nodes:tree.nodes.map(n => ({id:n.nodeId,role:n.role?.value,name:n.name?.value,value:n.value?.value}))},null,2));
      }
      const view = await cdp.send('Page.captureScreenshot', { fromSurface: false });
      await writeFile(path.join(out, `picker-${mode}-view.png`), Buffer.from(view.data, 'base64'));
      await cdp.detach();
      await writeFile(path.join(out, `picker-${mode}-snapshot.json`), JSON.stringify(await snapshot(), null, 2));
      if (command.action === 'stop') break;
    } catch (error) { if (error.code !== 'ENOENT') console.log('AUDIT:', error.message); }
  }
} finally { await app?.close(); await browser?.close(); await server?.close(); }
