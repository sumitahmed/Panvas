import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, _electron } from 'playwright';
import { createServer } from 'vite';

const profileOnly = process.argv.includes('--profile');
const electronMode = process.argv.includes('--electron');
const output = process.argv.indexOf('--output');
const server = await createServer({ mode: 'web', server: { port: 0, open: false } });
let browser;
let electronApp;
const results = [];
const errors = [];
const frames = page => page.evaluate(async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); });

async function measure(page) {
  return page.evaluate(() => {
    const pageBox = document.querySelector('#placement-page').getBoundingClientRect();
    const zoom = pageBox.width / 1000;
    const rect = box => ({ x: (box.left - pageBox.left) / zoom, y: (box.top - pageBox.top) / zoom, width: box.width / zoom, height: box.height / zoom });
    return [...document.querySelectorAll('[data-placement-id]')].map(wrapper => {
      const object = window.placementEngine.texts.getTexts().find(text => text.id === wrapper.dataset.placementId);
      const editor = wrapper.querySelector('.ProseMirror');
      const paragraph = editor.querySelector('p');
      const node = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode();
      const range = document.createRange(); range.selectNodeContents(node);
      const style = getComputedStyle(node.parentElement);
      const context = document.createElement('canvas').getContext('2d');
      context.font = `${style.fontSize} ${style.fontFamily}`;
      const metrics = context.measureText(node.textContent);
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline';
      paragraph.append(probe);
      const baseline = rect(probe.getBoundingClientRect()).y;
      probe.remove();
      const text = rect(range.getBoundingClientRect());
      return {
        source: object.metadata?.sourceBounds, object: { x: object.x, y: object.y, width: object.width, height: object.height },
        text: node.textContent, range: text, baseline, fontSize: parseFloat(style.fontSize),
        glyph: { x: text.x - metrics.actualBoundingBoxLeft, y: baseline - metrics.actualBoundingBoxAscent,
          height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent },
        editor: rect(editor.getBoundingClientRect()), outer: rect(wrapper.firstElementChild.getBoundingClientRect()),
        paragraph: { marginTop: getComputedStyle(paragraph).marginTop, marginBottom: getComputedStyle(paragraph).marginBottom },
        editorPadding: getComputedStyle(editor).padding, font: context.font, fontLoaded: document.fonts.check(context.font),
        fontMetrics: { ascent: metrics.actualBoundingBoxAscent, descent: metrics.actualBoundingBoxDescent,
          fontAscent: metrics.fontBoundingBoxAscent, fontDescent: metrics.fontBoundingBoxDescent },
      };
    });
  });
}

try {
  await server.listen();
  if (electronMode) {
    // Exercise the shared renderer in the installed Electron runtime without
    // touching real Panvas workspaces, IPC, or the user's running app.
    const directory = await mkdtemp(path.join(tmpdir(), 'panvas-h2t-electron-'));
    const bootstrap = path.join(directory, 'fixture.cjs');
    await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', require('node:path').join(__dirname, 'profile'));
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.loadURL(${JSON.stringify(`${server.resolvedUrls.local[0]}tests/fixtures/handwriting-placement.html`)});
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    electronApp = await _electron.launch({ args: [bootstrap], env, timeout: 30_000 });
  } else browser = await chromium.launch({ headless: true });
  for (const dpr of [1, 2, 3]) {
    const context = electronApp ? electronApp.context() : await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: dpr });
    const page = electronApp ? await electronApp.firstWindow() : await context.newPage();
    const cdp = electronApp ? await context.newCDPSession(page) : null;
    if (cdp) await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: dpr, mobile: false });
    page.setDefaultTimeout(20_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls.local[0]}tests/fixtures/handwriting-placement.html`);
    await page.waitForFunction(() => window.placementReady);
    assert.ok(Math.abs(await page.evaluate(() => devicePixelRatio) - dpr) < .001);
    for (const mode of ['manual', 'realtime']) {
      await page.evaluate(mode => window.placementConvert([
        { text: 'Hi', x: 100, y: 100, width: 60, height: 30 },
        { text: 'going', x: 200, y: 100, width: 150, height: 40 },
        { text: 'A long phrase with multiple words', x: 106, y: 138, width: 300, height: 32 },
        { text: 'Close line', x: 115, y: 168, width: 180, height: 34 },
      ], mode), mode);
      for (const zoom of [.65, 1, 1.8]) {
        await page.evaluate(zoom => window.placementZoom(zoom), zoom);
        for (const active of [true, false]) {
          await page.evaluate(active => window.placementFocus(active), active);
          await frames(page);
          const rows = await measure(page);
          results.push({ dpr, mode, zoom, active, rows });
          if (!profileOnly) for (const row of rows) {
            assert.equal(row.object.x, row.source.x, 'source X must not be aligned to an earlier line');
            assert.equal(row.fontLoaded, true, 'measure the selected font after it has loaded');
            assert.ok(Math.abs(row.glyph.x - row.source.x) <= 3, `visible X ${JSON.stringify(row)}`);
            assert.ok(Math.abs(row.glyph.y - row.source.y) <= 2, `visible Y ${JSON.stringify(row)}`);
            assert.ok(Math.abs(row.glyph.height - row.source.height) <= 2, `visible height ${JSON.stringify(row)}`);
            assert.deepEqual(row.paragraph, { marginTop: '0px', marginBottom: '0px' });
            assert.equal(row.editorPadding, '0px');
          }
        }
      }
    }
    await page.evaluate(() => { window.placementZoom(1); window.placementFocus(true); window.placementManualText(); });
    await frames(page);
    results.push({ dpr, mode: 'ordinary', active: true, rows: await measure(page) });
    await page.evaluate(() => window.placementFocus(false)); await frames(page);
    results.push({ dpr, mode: 'ordinary', active: false, rows: await measure(page) });
    if (cdp) await cdp.detach();
    else await context.close();
  }
  if (!profileOnly) for (const result of results) {
    if (result.mode === 'ordinary') {
      const row = result.rows[0];
      assert.deepEqual(row.object, { x: 100, y: 100, width: 240, height: 72 });
      assert.equal(row.glyph.x, 104);
      assert.ok(Math.abs(row.glyph.y - (result.active ? 125.984375 : 110)) <= .1, 'ordinary manual text retains its existing placement');
      continue;
    }
    const inactive = results.find(item => item.dpr === result.dpr && item.mode === result.mode && item.zoom === result.zoom && !item.active);
    const realtime = results.find(item => item.dpr === result.dpr && item.mode === 'realtime' && item.zoom === result.zoom && item.active === result.active);
    for (let index = 0; index < result.rows.length; index++) {
      const row = result.rows[index];
      assert.deepEqual(row.object, realtime.rows[index].object, 'manual/bulk and realtime use identical source placement');
      assert.equal(row.fontSize, realtime.rows[index].fontSize);
      for (const key of ['x', 'y', 'height']) assert.ok(Math.abs(row.glyph[key] - inactive.rows[index].glyph[key]) <= .1, `focus must not change visible ${key}`);
    }
  }
  assert.deepEqual(errors, []);
  if (output >= 0) await writeFile(process.argv[output + 1], JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} ${electronMode ? 'Electron' : 'browser'} geometry scenarios; source placement, height, focus parity, path parity, ordinary text; no renderer errors`);
} finally { if (electronApp) await electronApp.close(); if (browser) await browser.close(); await server.close(); }
