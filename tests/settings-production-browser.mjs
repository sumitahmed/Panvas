import assert from 'node:assert/strict';
import { chromium, _electron } from 'playwright';
import { expect } from '@playwright/test';
import { preview } from 'vite';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const native = process.argv.includes('--electron'), mode = native ? 'electron' : 'chromium';
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-settings-production-'));
const out = path.resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? 'artifacts/palette-settings-20261017/production-' + mode); await mkdir(out, { recursive: true });
const webDirectory = path.resolve(process.argv.find(arg => arg.startsWith('--web-dir='))?.slice(10) ?? 'artifacts/palette-settings-20261017/web-build');
let app, browser, server, page;
const evidence = { mode, directory, checks: [], errors: [] };
const pass = name => { evidence.checks.push(name); console.log('PASS', name); };
const launch = async () => {
  if (native) {
    const env = { ...process.env, PANVAS_GATE0_PROFILE: '1', PANVAS_GATE0_USER_DATA: path.join(directory, 'profile'), PANVAS_GATE0_WORKSPACE_ROOT: path.join(directory, 'workspaces'), PANVAS_TEST_WINDOW: '1280x900' };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID', 'VITE_DEV_SERVER_URL']) delete env[key];
    app = await _electron.launch({ args: [path.resolve('.')], env }); page = await app.firstWindow();
    assert.ok((await app.evaluate(({ app }) => app.getPath('userData'))).startsWith(directory + path.sep));
  } else {
    server ??= await preview({ configFile: false, build: { outDir: webDirectory }, preview: { port: 0, open: false } });
    browser = await chromium.launchPersistentContext(path.join(directory, 'profile'), { headless: false, viewport: { width: 1280, height: 900 } });
    page = browser.pages()[0]; await page.goto(server.resolvedUrls.local[0] + 'app');
  }
  page.setDefaultTimeout(30000); page.on('pageerror', error => evidence.errors.push(error.message));
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
  const local = page.getByRole('button', { name: 'Continue locally', exact: true }); if (await local.isVisible()) await local.click({ force: true });
};
const tab = name => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name, exact: true }).click();
try {
  await launch();
  await page.getByRole('button', { name: 'New item', exact: true }).click(); await page.getByRole('button', { name: 'New Notebook', exact: true }).click();
  await page.locator('#create-dialog-input').fill('Settings production audit'); await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Local storage details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  evidence.counts = await page.locator('[data-storage-count]').evaluateAll(items => Object.fromEntries(items.map(item => [item.dataset.storageCount, Number(item.textContent)])));
  assert.deepEqual(evidence.counts, { workspaces: 1, canvases: 1, notebooks: 2, pages: 2 }); pass('actual production UI reads independent canonical counts after creating a notebook');
  const storage = page.getByRole('region', { name: 'Local storage', exact: true });
  await expect(storage).not.toContainText('Healthy'); await expect(storage).not.toContainText('Storage usedUnavailable');
  if (native) {
    evidence.overview = await page.evaluate(() => window.panvas.storage.getOverview());
    assert.ok(evidence.overview.usedBytes > 0); assert.equal(evidence.overview.health, 'accessible');
    assert.ok(evidence.overview.root.path.startsWith(directory + path.sep));
  } else await expect(storage).toContainText('About ');
  await page.screenshot({ path: path.join(out, 'workspace.png') }); pass('production native filesystem/browser estimate is genuine');
  await tab('About'); const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  await expect(page.getByRole('region', { name: 'Application information' })).toContainText('Version ' + version);
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).not.toContainText('12345');
  if (native) {
    evidence.appInfo = await page.evaluate(() => window.panvas.appInfo()); assert.equal(evidence.appInfo.version, version);
    await app.evaluate(({ shell }) => { globalThis.externalUrls = []; globalThis.originalExternal = shell.openExternal; shell.openExternal = async url => { globalThis.externalUrls.push(url); }; });
    try {
      for (const name of ['GitHub Repository', 'Privacy Policy', 'Terms of Service']) await page.getByRole('link', { name, exact: true }).click();
      await expect.poll(() => app.evaluate(() => globalThis.externalUrls)).toEqual(['https://github.com/sumitahmed/Panvas', 'https://panvas.vercel.app/privacy', 'https://panvas.vercel.app/terms']);
      evidence.externalHandler = 'actual production handler observed with shell.openExternal intercepted';
    } finally { await app.evaluate(({ shell }) => { shell.openExternal = globalThis.originalExternal; }); }
  }
  await page.screenshot({ path: path.join(out, 'about.png') }); pass('actual application version/runtime and working production external-link handler');
  await tab('Appearance'); await page.getByRole('button', { name: /^Dark / }).click();
  const full = page.getByRole('switch', { name: 'Full Dark View' }); if (!await full.isChecked()) await full.check();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeHidden(); pass('actual Close Settings mouse interaction');
  if (app) { await app.close(); app = null; } else { await browser.close(); browser = null; }
  await launch(); await page.getByRole('button', { name: 'Local storage details', exact: true }).click(); await tab('Appearance');
  await expect(page.getByRole('button', { name: /^Dark / })).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByRole('switch', { name: 'Full Dark View' })).toBeChecked();
  await page.screenshot({ path: path.join(out, 'restart-theme.png') }); pass('full application restart retains theme and Full Dark View');
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeHidden();
  assert.deepEqual(evidence.errors, []); evidence.passed = true;
} catch (error) { evidence.failure = error.stack; await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(path.join(out, 'results.json'), JSON.stringify(evidence, null, 2)); await app?.close(); await browser?.close(); await server?.close(); }
