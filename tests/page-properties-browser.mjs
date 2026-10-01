import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, _electron } from 'playwright';
import { createServer } from 'vite';

const electronMode = process.argv.includes('--electron');
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-page-properties-'));
const server = await createServer({ mode: 'web', server: { port: 0, open: false } });
let browser;
let electronApp;
let page;
let passed = 0;
const errors = [];
const workingTemplates = ['Blank', 'Ruled', 'Narrow ruled', 'Wide ruled', 'Small grid', 'Large grid', 'Dotted', 'Engineering', 'Cornell', 'Lecture Notes', 'Assignment', 'Checklist', 'To-do', 'Daily planner', 'Weekly planner', 'Monthly planner', 'Journal', 'Music', 'Calendar'];
const affectedTemplates = ['Double margin ruled', 'Large ruled with margin'];
const settle = page => page.evaluate(async () => {
  for (let frame = 0; frame < 5; frame++) await new Promise(requestAnimationFrame);
  await new Promise(resolve => setTimeout(resolve, 150));
});
const ready = page => page.waitForFunction(() => window.propertiesFixture && window.propertiesFixture.engine()?.getDrawingOwnership().pageId === window.propertiesFixture.ids.notes[0]
  && document.querySelector('canvas[data-render-ready="true"]'));

try {
  await server.listen();
  const base = server.resolvedUrls.local[0];
  let context;
  if (electronMode) {
    // Real production IPC handlers and preload; all disk writes are confined
    // to this temporary profile and workspace root. No installed app is used.
    await build({ entryPoints: ['electron/ipc/domain-handlers.ts'], outfile: path.join(directory, 'domain.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    await build({ entryPoints: ['electron/preload.ts'], outfile: path.join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    const bootstrap = path.join(directory, 'bootstrap.cjs');
    await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', require('node:path').join(__dirname, 'profile'));
process.env.PANVAS_GATE0_PROFILE = '1';
process.env.PANVAS_GATE0_WORKSPACE_ROOT = require('node:path').join(__dirname, 'workspaces');
process.env.VITE_DEV_SERVER_URL = ${JSON.stringify(base)};
app.whenReady().then(() => {
  require('./domain.cjs').registerDomainHandlers();
  const window = new BrowserWindow({ show: false, width: 1600, height: 1000,
    webPreferences: { preload: require('node:path').join(__dirname, 'preload.cjs'), offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.loadURL(${JSON.stringify(base + 'tests/fixtures/page-properties.html')});
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
    electronApp = await _electron.launch({ args: [bootstrap], env, timeout: 30_000 });
    context = electronApp.context();
  } else {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  }
  await context.addInitScript(() => {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    sessionStorage.setItem('panvas.cloudSyncPromptDismissed', 'true');
    localStorage.setItem('panvas-theme', 'ink');
  });
  page = electronApp ? await electronApp.firstWindow() : await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + 'tests/fixtures/page-properties.html');
  await ready(page);
  assert.equal(await page.evaluate(() => window.propertiesFixture.mode), electronMode ? 'electron' : 'web');
  const ids = await page.evaluate(() => window.propertiesFixture.ids);
  const baseline = await page.evaluate(() => window.propertiesFixture.baseline);
  const original = await page.evaluate(() => window.propertiesFixture.records());
  const excluded = [ids.pdf, ids.deleted, ids.outside];
  const originalObjects = await page.evaluate(() => window.propertiesFixture.drawingObjects());
  const picker = () => page.locator('.panvas-properties-panel select').filter({ has: page.locator('option[value="Ruled"]') });
  const clear = () => page.evaluate(() => window.propertiesFixture.clearToasts());
  const assertNoError = async () => assert.deepEqual(await page.evaluate(() => window.propertiesFixture.toasts.filter(toast => toast.type === 'error')), []);
  const checkExcluded = records => {
    for (const id of excluded) assert.deepEqual(records.pages.find(page => page.id === id), original.pages.find(page => page.id === id), 'Excluded page metadata stays unchanged');
  };
  const waitCurrent = template => page.waitForFunction(template => window.propertiesFixture.engine().getProperties().template === template, template);
  const waitSaved = async template => {
    await page.waitForFunction(async template => {
      const fixture = window.propertiesFixture;
      return (await fixture.records()).effective[fixture.ids.notes[0]].template === template;
    }, template);
    await settle(page);
    await assertNoError();
  };

  // Both UI entry points use canonical IDs; every prior template is exercised.
  for (const template of [...affectedTemplates, ...workingTemplates]) {
    await clear();
    await picker().selectOption(template);
    await waitCurrent(template); await waitSaved(template);
    const records = await page.evaluate(() => window.propertiesFixture.records());
    assert.deepEqual(records.effective[ids.notes[0]], { ...baseline, template });
    checkExcluded(records);
    passed++;
    if (affectedTemplates.includes(template)) {
      await page.reload(); await ready(page); await waitCurrent(template); await assertNoError();
      await page.evaluate(id => window.propertiesFixture.select(id), ids.notes[1]);
      await page.waitForFunction(id => window.propertiesFixture.engine().getDrawingOwnership().pageId === id, ids.notes[1]);
      await page.evaluate(id => window.propertiesFixture.select(id), ids.notes[0]);
      await ready(page); await waitCurrent(template);
      await page.evaluate(() => window.propertiesFixture.reopen());
      await ready(page); await waitCurrent(template);
      passed++;
    }
  }
  // Inspector scope confirmation and its subsequent template updates.
  await clear();
  await page.getByRole('switch', { name: 'Apply to all pages', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Apply to all pages', exact: true }).click();
  await page.waitForFunction(() => window.propertiesFixture.toasts.some(toast => toast.type === 'success'));
  await settle(page);
  for (const template of [...affectedTemplates, ...workingTemplates]) {
    await clear();
    await picker().selectOption(template);
    await page.waitForFunction(() => window.propertiesFixture.toasts.some(toast => toast.type === 'success'));
    await settle(page);
    const records = await page.evaluate(() => window.propertiesFixture.records());
    for (const id of ids.notes) assert.deepEqual(records.effective[id], { ...baseline, template });
    checkExcluded(records); await assertNoError(); passed++;
  }
  await page.getByRole('switch', { name: 'Apply to all pages', exact: true }).click();
  // Gallery current-page and all-pages controls are verified separately.
  for (const template of affectedTemplates) {
    await clear();
    await page.getByRole('button', { name: 'Browse template gallery', exact: true }).click();
    const label = await picker().locator('option[value="' + template + '"]').textContent();
    const card = page.getByRole('dialog').getByRole('button', { name: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    await card.click();
    await settle(page);
    assert.equal(await card.getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Apply to current page', exact: true }).click();
    await waitSaved(template); passed++;
    await page.getByRole('button', { name: 'Browse template gallery', exact: true }).click();
    await card.click();
    await settle(page);
    assert.equal(await card.getAttribute('aria-pressed'), 'true');
    await page.getByRole('checkbox', { name: 'All note pages in this notebook (PDF pages excluded)' }).check();
    await page.getByRole('button', { name: 'Apply to all note pages', exact: true }).click();
    await page.waitForFunction(() => window.propertiesFixture.toasts.some(toast => toast.type === 'success'));
    await page.waitForFunction(async template => {
      const fixture = window.propertiesFixture;
      const records = await fixture.records();
      return fixture.ids.notes.every(id => records.effective[id].template === template);
    }, template);
    await settle(page);
    await assertNoError();
    const records = await page.evaluate(() => window.propertiesFixture.records());
    for (const id of ids.notes) assert.deepEqual(records.effective[id], { ...baseline, template });
    checkExcluded(records);
    passed++;
    if (affectedTemplates.includes(template)) {
      await page.reload(); await ready(page); await waitCurrent(template);
      for (const id of ids.notes) {
        await page.evaluate(id => window.propertiesFixture.select(id), id);
        await page.waitForFunction(id => window.propertiesFixture.engine().getDrawingOwnership().pageId === id, id);
        assert.equal(await page.evaluate(() => window.propertiesFixture.engine().getProperties().template), template);
      }
      await page.evaluate(id => window.propertiesFixture.select(id), ids.notes[0]);
      await ready(page); await waitCurrent(template); await assertNoError();
      passed++;
    }
  }
  assert.deepEqual(await page.evaluate(() => window.propertiesFixture.drawingObjects()), originalObjects, 'Template changes never rewrite drawing objects');
  await page.screenshot({ path: path.join(directory, 'applied-all.png') });

  // Fail the real storage layer; UI must continue reporting unsuccessful saves.
  let workspaceJson;
  if (electronMode) {
    workspaceJson = path.join(directory, 'workspaces', 'Page properties regression', '.panvas', 'workspace.json');
    await readFile(workspaceJson);
    await rename(workspaceJson, workspaceJson + '.before-failure');
    await mkdir(workspaceJson);
  } else await page.evaluate(() => window.propertiesFixture.closeDatabase());
  try {
    await clear();
    await picker().selectOption(affectedTemplates[0]);
    await page.waitForFunction(() => window.propertiesFixture.toasts.some(toast => toast.type === 'error' && toast.message === 'Page properties could not be saved.'));
    passed++;
    await clear();
    await page.getByRole('button', { name: 'Browse template gallery', exact: true }).click();
    await page.getByRole('button', { name: /^Large Ruled with Margin/ }).click();
    await page.getByRole('checkbox', { name: 'All note pages in this notebook (PDF pages excluded)' }).check();
    await page.getByRole('button', { name: 'Apply to all note pages', exact: true }).click();
    await page.waitForFunction(() => window.propertiesFixture.toasts.some(toast => toast.type === 'error' && toast.message === 'Failed to apply to all pages'));
    assert.ok(!(await page.evaluate(() => window.propertiesFixture.toasts)).some(toast => toast.type === 'success'));
    passed++;
  } finally {
    if (electronMode) { await rmdir(workspaceJson); await rename(workspaceJson + '.before-failure', workspaceJson); }
    else await page.evaluate(() => window.propertiesFixture.openDatabase());
  }
  await page.reload(); await ready(page); await clear();
  await picker().selectOption(affectedTemplates[1]); await waitSaved(affectedTemplates[1]);
  passed++;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ mode: electronMode ? 'electron' : 'web', passed, errors, artifacts: directory }));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(directory, 'failure.png') });
    console.log(JSON.stringify({ errors, artifacts: directory, diagnostic: await page.evaluate(() => ({
      nativeApi: Boolean(window.panvas), fixture: Boolean(window.propertiesFixture),
      toast: window.propertiesFixture?.toasts, body: document.body.innerText.slice(0, 1000),
    })) }));
  }
  throw error;
} finally {
  await browser?.close(); await electronApp?.close(); await server.close();
}
