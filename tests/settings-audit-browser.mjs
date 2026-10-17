import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { build } from 'esbuild';
import { chromium, _electron } from 'playwright';
import { expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const native = process.argv.includes('--electron'), mode = native ? 'electron' : 'chromium';
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-settings-ui-'));
const out = path.resolve('artifacts/palette-settings-20261017/settings-' + mode);
await mkdir(out, { recursive: true });
const server = await createServer({ mode: 'web', cacheDir: path.join(directory, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/settings-audit.html'] }, server: { port: 0, open: false } });
await server.listen();
const url = server.resolvedUrls.local[0] + 'tests/fixtures/settings-audit.html';
let app, browser, page;
const results = { mode, directory, checks: [], mockedAuthStates: [], errors: [] };
const pass = name => { results.checks.push(name); console.log('PASS', name); };
const frames = async () => page.evaluate(async () => {
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
});
try {
  if (native) {
    for (const [entry, file] of [['electron/ipc/domain-handlers.ts', 'domain.cjs'], ['electron/preload.ts', 'preload.cjs']]) await build({ entryPoints: [entry], outfile: path.join(directory, file), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    const version = JSON.parse(await readFile('package.json', 'utf8')).version;
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'panvas-settings-fixture', version, main: 'bootstrap.cjs' }));
    await writeFile(path.join(directory, 'bootstrap.cjs'), `const {app,BrowserWindow}=require('electron');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=require('node:path').join(__dirname,'workspaces');
require('node:fs').mkdirSync(process.env.PANVAS_GATE0_WORKSPACE_ROOT,{recursive:true});
process.env.VITE_DEV_SERVER_URL=${JSON.stringify(server.resolvedUrls.local[0])};
app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();const win=new BrowserWindow({width:1280,height:900,titleBarStyle:'hidden',titleBarOverlay:true,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});win.loadURL(${JSON.stringify(url)});});`);
    const env = { ...process.env }; for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete env[key];
    app = await _electron.launch({ args: [directory], env }); page = await app.firstWindow();
  } else {
    browser = await chromium.launchPersistentContext(path.join(directory, 'profile'), { headless: true, viewport: { width: 1280, height: 900 } });
    page = browser.pages()[0]; await page.goto(url);
  }
  page.setDefaultTimeout(20000); page.on('pageerror', error => results.errors.push(error.message));
  await page.waitForFunction(() => window.settingsFixture);
  const tab = async name => { await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name, exact: true }).click(); await frames(); };
  await tab('Workspace');
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  const counts = () => page.locator('[data-storage-count]').evaluateAll(items => Object.fromEntries(items.map(item => [item.dataset.storageCount, Number(item.textContent)])));
  assert.deepEqual(await counts(), { workspaces: 0, canvases: 0, notebooks: 0, pages: 0 }); pass('fresh empty profile counts are measured independently');
  await page.evaluate(() => window.settingsFixture.seed());
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  assert.deepEqual(await counts(), { workspaces: 2, canvases: 3, notebooks: 2, pages: 4 }); pass('independent canonical workspace, canvas, notebook and page counts');
  results.metrics = await page.evaluate(() => window.settingsFixture.metrics());
  assert.notEqual(results.metrics.usedBytes, null);
  assert.ok(results.metrics.usedBytes > 0);
  assert.equal(results.metrics.usageKind, native ? 'measured' : 'estimated'); pass('genuine filesystem measurement or explicitly estimated browser-origin usage');
  const checked = results.metrics.measuredAt;
  await tab('About'); await tab('Workspace');
  assert.equal((await page.evaluate(() => window.settingsFixture.metrics())).measuredAt, checked); pass('tab reopening uses settled measurement cache');
  if (native) {
    const root = path.join(directory, 'workspaces'); assert.ok(root.startsWith(directory + path.sep));
    await mkdir(path.join(root, 'Assets', 'image-store'), { recursive: true });
    await writeFile(path.join(root, 'Assets', 'image-store', 'usage-probe.bin'), Buffer.alloc(12345));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    const updated = await page.evaluate(() => window.settingsFixture.metrics());
    assert.equal(updated.usedBytes, results.metrics.usedBytes + 12345); pass('explicit Refresh includes exact new asset bytes');
    const beforeRoot = await page.evaluate(() => window.panvas.storage.getRoot());
    await app.evaluate(({ dialog }) => { globalThis.originalFolderDialog = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await page.getByRole('button', { name: 'Change folder', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Change folder', exact: true })).toBeEnabled();
    assert.deepEqual(await page.evaluate(() => window.panvas.storage.getRoot()), beforeRoot);
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.originalFolderDialog; }); pass('mocked native chooser cancellation preserves root');
    await rename(root, root + '-offline');
    try {
      await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
      const unavailable = await page.evaluate(() => window.settingsFixture.metrics());
      assert.equal(unavailable.health, 'unavailable'); assert.equal(unavailable.usedBytes, null);
      await expect(page.getByRole('region', { name: 'Local storage', exact: true })).toContainText('Unavailable'); pass('real unavailable disposable root never displays Healthy or fake zero');
    } finally { await rename(root + '-offline', root); }
    await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  } else {
    await page.evaluate(() => { window.originalEstimate = navigator.storage.estimate; navigator.storage.estimate = async () => { throw new Error('fixture estimate rejected'); }; });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    assert.equal((await page.evaluate(() => window.settingsFixture.metrics())).usedBytes, null);
    await expect(page.getByRole('region', { name: 'Local storage', exact: true })).toContainText('Unavailable');
    await page.evaluate(() => { navigator.storage.estimate = window.originalEstimate; }); pass('rejected browser estimate is Unavailable, not zero');
  }
  // A failed forced refresh must invalidate both settled cache layers. Opening
  // Settings again must keep the error, rather than resurrect an old success.
  const settingsFile = path.join(directory, 'profile', 'panvas', 'settings.json');
  let settingsBytes;
  if (native) { assert.ok(settingsFile.startsWith(directory + path.sep)); settingsBytes = await readFile(settingsFile); await writeFile(settingsFile, '{fixture unreadable'); }
  else await page.evaluate(() => window.settingsFixture.readFailure(true));
  try {
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Local storage', exact: true }).getByRole('alert')).toContainText('could not be read');
    await tab('About'); await tab('Workspace');
    await expect(page.getByRole('region', { name: 'Local storage', exact: true }).getByRole('alert')).toContainText('could not be read');
  } finally {
    if (native) await writeFile(settingsFile, settingsBytes);
    else await page.evaluate(() => window.settingsFixture.readFailure(false));
  }
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  pass('failed Refresh invalidates old success; reopen remains honest and recovery works');
  await tab('Account');
  for (const [state, label] of [['signed-out', 'Not connected'], ['authenticated', 'Synced'], ['disconnected', 'Not connected'], ['expired', 'Reconnect required'], ['token-needed', 'Reconnect required'], ['failure', 'Sync issue'], ['offline', 'Offline'], ['connecting', 'Connecting']]) {
    await page.evaluate(state => window.settingsFixture.auth(state), state); await frames();
    const panel = page.getByRole('region', { name: 'Google Drive connection', exact: true });
    await expect(panel).toContainText(label);
    if (state !== 'signed-out') { await expect(panel).toContainText('Historical success'); assert.equal(await panel.locator('time').getAttribute('datetime'), '2026-10-09T00:00:00.000Z'); }
    const account = page.getByRole('region', { name: 'Panvas account', exact: true });
    await expect(account).toContainText(state === 'authenticated' ? 'Settings fixture' : 'not signed in');
    results.mockedAuthStates.push({ state, label, historyRetained: state !== 'signed-out' });
  }
  pass('eight mocked auth/Drive states separate current connection from historical success');
  await page.evaluate(() => window.settingsFixture.auth('expired')); await frames();
  await page.getByRole('button', { name: 'Reconnect Google Drive', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fixture destination: /app/library' })).toBeVisible();
  assert.equal(await page.evaluate(() => localStorage.getItem('panvas.libraryView')), 'cloud');
  await page.getByRole('link', { name: 'Settings', exact: true }).click(); pass('Reconnect routes to the existing Cloud Sync library view (no auth performed)');
  await page.evaluate(() => window.settingsFixture.auth('disconnected')); await tab('About');
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  await expect(page.getByRole('region', { name: 'Application information' })).toContainText('Version ' + version);
  await expect(page.getByRole('region', { name: 'Application information' })).not.toContainText('12345');
  if (native) { results.appInfo = await page.evaluate(() => window.panvas.appInfo()); await expect(page.getByRole('region', { name: 'Application information' })).toContainText('Electron ' + results.appInfo.electron); }
  results.links = await page.getByRole('region', { name: 'Links and legal' }).locator('a').evaluateAll(items => items.map(item => ({ label: item.textContent, href: item.href })));
  assert.deepEqual(results.links.map(item => item.href), ['https://github.com/sumitahmed/Panvas', 'https://panvas.vercel.app/privacy', 'https://panvas.vercel.app/terms']); pass('package/native version, actual runtime and HTTPS legal/repository destinations');
  for (const theme of ['Light', 'Ink', 'Dark']) {
    await tab('Appearance');
    const button = page.getByRole('button', { name: new RegExp('^' + theme + ' ') }); await button.focus(); await page.keyboard.press('Space');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    if (theme === 'Dark') { const toggle = page.getByRole('switch', { name: 'Full Dark View' }); await toggle.focus(); await page.keyboard.press('Space'); await expect(toggle).toBeChecked(); }
    for (const section of ['Account', 'Appearance', 'Workspace', 'About']) {
      await tab(section); await page.screenshot({ path: path.join(out, theme.toLowerCase() + '-' + section.toLowerCase() + '.png') });
      const contrast = await page.getByRole('dialog', { name: 'Settings', exact: true }).evaluate(dialog => {
        const rgba = color => { const values = color.match(/[\d.]+/g)?.map(Number) ?? [0,0,0]; return [...values.slice(0,3), values[3] ?? 1]; };
        const blend = (a,b) => a.slice(0,3).map((v,i) => v*a[3]+b[i]*(1-a[3]));
        const luminance = rgb => rgb.map(v => { v/=255; return v<=.04045 ? v/12.92 : ((v+.055)/1.055)**2.4; }).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);
        const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT), values=[];
        for(let node=walker.nextNode();node;node=walker.nextNode()) {
          const element=node.parentElement, text=node.textContent.trim();
          if(text.length<3 || !element.getClientRects().length || element.closest(':disabled'))continue;
          const layers=[];for(let el=element;el;el=el.parentElement)layers.push(rgba(getComputedStyle(el).backgroundColor));
          const bg=layers.reverse().reduce((under,over)=>blend(over,under),[255,255,255]);
          const style=getComputedStyle(element),fg=blend(rgba(style.color),bg),a=luminance(fg),b=luminance(bg);
          values.push({text:text.slice(0,80),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});
        }
        return values.sort((a,b)=>a.ratio-b.ratio).slice(0,3);
      });
      (results.contrast ??= []).push({theme,section,lowest:contrast});
      assert.ok(contrast.every(item=>item.ratio>=4.5),JSON.stringify({theme,section,contrast}));
    }
    pass(theme + ' selected through keyboard and all Settings sections rendered');
  }
  await page.reload(); await page.waitForFunction(() => window.settingsFixture); await tab('Appearance');
  await expect(page.getByRole('button', { name: /^Dark / })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('switch', { name: 'Full Dark View' })).toBeChecked(); pass('theme and Full Dark View persist across reload');
  for (const width of [800, 390, 320]) {
    if (app) await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 800), width);
    else await page.setViewportSize({ width, height: 800 });
    for (const section of ['Account', 'Appearance', 'Workspace', 'About']) {
      await tab(section);
      const layout = await page.getByRole('dialog', { name: 'Settings', exact: true }).evaluate(el => {
        const main = el.querySelector('main'); return { client: main.clientWidth, scroll: main.scrollWidth, viewport: innerWidth };
      });
      assert.ok(layout.scroll <= layout.client + 1, JSON.stringify({ width, section, layout }));
    }
    await page.screenshot({ path: path.join(out, 'narrow-' + width + '.png') });
  }
  pass('800, 390 and 320 pixel windows have no content overflow');
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const first = dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('link').first();
  const last = dialog.getByRole('region', { name: 'Links and legal' }).getByRole('link').last();
  await last.focus(); await page.keyboard.press('Tab'); await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(last).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('heading', { name: 'Fixture destination: /app' })).toBeVisible(); pass('dialog Tab containment and Escape close');
  assert.deepEqual(results.errors, []);
  results.passed = true;
} catch (error) {
  results.failure = error.stack; await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error;
} finally {
  await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  await app?.close(); await browser?.close(); await server.close();
}
