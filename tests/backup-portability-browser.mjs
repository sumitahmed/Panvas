import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { build } from 'esbuild';
import { chromium, _electron } from 'playwright';
import { remapBackupReferences } from '../src/services/backup/backupAssets.ts';
const out = process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? 'artifacts/critical-stabilization-20261016/backup'; await mkdir(out, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-backup-proof-'));
const server = await createServer({ mode: 'web', cacheDir: path.join(directory, 'cache'), optimizeDeps: { entries: ['index.html', 'tests/fixtures/backup-portability.ts'] },
  plugins: [{ name: 'backup-proof', enforce: 'pre', transform(code, id) {
    if (id.replaceAll('\\', '/').endsWith('/src/main.tsx')) return `import '/tests/fixtures/backup-portability.ts';\n${code}`;
    if (id.replaceAll('\\', '/').endsWith('/src/services/pdf/richDocumentPdf.ts')) return code.replace("throw new Error('An embedded document image could not be decoded.');", "console.warn('PDF decode diagnostic', image.outerHTML); throw new Error('An embedded document image could not be decoded.');");
  } }], server: { port: 0, open: false, watch: { ignored: ['**/artifacts/**', '**/dist/**', '**/dist-electron/**'] } } });
await server.listen(); const url = server.resolvedUrls.local[0];
for (const [entry, file] of [['electron/ipc/domain-handlers.ts', 'domain.cjs'], ['electron/preload.ts', 'preload.cjs']]) await build({ entryPoints: [entry], outfile: path.join(directory, file), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
const reports = [], errors = []; let browser;
const pdfOnly = process.argv.includes('--pdf-only');
const productionMain = process.argv.includes('--production-main');
const platforms = process.argv.includes('--native-only') ? [true] : [false, true];
async function session(native, name) {
  let app, context;
  const root = path.join(directory, name); await mkdir(root);
  if (native) {
    await writeFile(path.join(directory, `${name}.cjs`), `const {app,BrowserWindow,dialog}=require('electron');globalThis.backupRestoreFS=require('node:fs').promises;app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=${JSON.stringify(path.join(root, 'workspaces'))};process.env.VITE_DEV_SERVER_URL=${JSON.stringify(url)};app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();new BrowserWindow({show:true,width:1440,height:1100,titleBarStyle:'hidden',titleBarOverlay:true,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}}).loadURL(${JSON.stringify(url + '#/app/library')});});`);
    if (productionMain) await writeFile(path.join(directory, `${name}.cjs`), `const {app}=require('electron');globalThis.backupRestoreFS=require('node:fs').promises;process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_USER_DATA=${JSON.stringify(path.join(root, 'profile'))};process.env.PANVAS_GATE0_WORKSPACE_ROOT=${JSON.stringify(path.join(root, 'workspaces'))};process.env.VITE_DEV_SERVER_URL=${JSON.stringify(url + '#/app/library')};process.env.PANVAS_TEST_WINDOW='1440x1100';import(${JSON.stringify(pathToFileURL(path.resolve('dist-electron/main.js')).href)});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT; app = await _electron.launch({ args: [path.join(directory, `${name}.cjs`)], env });
    app.process().stderr?.on('data', chunk => console.log(name, 'main:', String(chunk).slice(0, 2200)));
  } else context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = native ? await app.firstWindow() : await context.newPage(); if (!native) await page.goto(url + 'app/library');
  page.setDefaultTimeout(45000); page.on('pageerror', error => errors.push({ name, message: error.message })); page.on('console', message => { if (['error', 'warning'].includes(message.type()) || message.text().startsWith('backup-seed')) console.log(name, message.text()); });
  try { await page.waitForFunction(() => Boolean(window.backupProbe?.state().workspaceId)); }
  catch (error) {
    await writeFile(`${out}/${name}-startup.json`, JSON.stringify({ url: page.url(),
      state: await page.evaluate(() => ({ fixture: Boolean(window.backupProbe), body: document.body.innerText.slice(0, 3000) })),
      native: app ? await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData') })) : null }, null, 2));
    if (app) await app.close(); else await context.close();
    throw error;
  }
  const prompt = page.getByRole('button', { name: 'Continue locally', exact: true }); if (await prompt.count()) await prompt.click();
  await page.getByRole('button', { name: 'Restore Workspace Backup', exact: true }).waitFor();
  const exportUI = async label => {
    await page.evaluate(() => window.backupProbe.clearToast());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const dest = path.resolve(out, `${label}.panvas-backup.json`);
    if (native) await app.evaluate(({ dialog }, dest) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest }); }, dest);
    const download = native ? null : page.waitForEvent('download', { timeout: 20000 });
    await page.getByRole('button', { name: 'Export Workspace Backup', exact: true }).click();
    console.log(label, 'export clicked', await page.evaluate(() => window.backupProbe.state()));
    if (download) {
      const result = await Promise.race([download, page.waitForFunction(() => window.backupProbe.state().toast?.type === 'error', null, { timeout: 20000 }).then(async () => { throw new Error(JSON.stringify(await page.evaluate(() => window.backupProbe.state()))); })]);
      await result.saveAs(dest);
    } else await page.waitForFunction(() => window.backupProbe.state().toast?.message === 'Workspace backup exported.');
    await page.getByRole('button', { name: 'Export Workspace Backup', exact: true }).waitFor({ state: 'visible' });
    return JSON.parse(await readFile(dest, 'utf8'));
  };
  const importUI = async (file, success = true) => {
    await page.evaluate(() => window.backupProbe.clearToast());
    const previous = await page.evaluate(() => window.backupProbe.state().workspaceId);
    if (native) { await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.resolve(file)); await page.getByRole('button', { name: 'Restore Workspace Backup', exact: true }).click(); }
    else { const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Restore Workspace Backup', exact: true }).click(); await (await chooser).setFiles(path.resolve(file)); }
    if (success) await page.waitForFunction(previous => window.backupProbe.state().workspaceId !== previous && window.backupProbe.state().toast?.message.startsWith('Backup restored'), previous);
    else await page.waitForFunction(() => window.backupProbe.state().toast?.type === 'error');
    return page.evaluate(() => window.backupProbe.state());
  };
  return { native, name, root, app, page, exportUI, importUI, close: async () => { await writeFile(`${out}/${name}-last-ui.txt`, await page.locator('body').innerText()); await page.screenshot({ path: `${out}/${name}-last.png` }); console.log(name, await page.evaluate(() => window.backupProbe.state())); if (app) await app.close(); else await context.close(); } };
}
function compare(original, restored) {
  assert.equal(restored.header.version, 2); assert.notEqual(original.workspace.id, restored.workspace.id);
  assert.deepEqual(restored.pages.map(p => p.title).sort(), original.pages.map(p => p.title).sort());
  const idMap = new Map([[original.workspace.id, restored.workspace.id]]);
  for (const key of ['folders', 'notebooks', 'sections', 'pages', 'canvases']) original[key].forEach(item => idMap.set(item.id, restored[key].find(other => (other.title ?? other.name) === (item.title ?? item.name)).id));
  for (const [id, asset] of Object.entries(original.assets)) { const next = Object.values(restored.assets).find(other => other.sha256 === asset.sha256); assert.ok(next); assert.notEqual(next.id, id); assert.equal(next.base64, asset.base64); idMap.set(id, next.id); }
  const pairBlocks = (a, b) => { if (!a || typeof a !== 'object') return; for (const [key, child] of Object.entries(a)) { if (key === 'blockId') { assert.notEqual(child, b[key]); idMap.set(child, b[key]); } else if (child && typeof child === 'object') pairBlocks(child, b[key]); } };
  for (const page of original.pages) pairBlocks(original.pagePayloads[page.id], restored.pagePayloads[idMap.get(page.id)]);
  // Opaque drawing-object IDs and literal text are intentionally not rewritten.
  const normalize = value => remapBackupReferences(value, idMap, idMap, idMap);
  for (const page of original.pages) assert.deepEqual(restored.pagePayloads[idMap.get(page.id)], normalize(original.pagePayloads[page.id]));
  const ann = Object.values(original.annotationPayloads); assert.equal(Object.keys(restored.annotationPayloads).length, ann.length);
  for (const a of ann) assert.deepEqual(restored.annotationPayloads[`${idMap.get(a.ownerPageId)}_pdf_${a.sourcePage}`], normalize(a));
  for (const asset of Object.values(restored.assets)) assert.equal(createHash('sha256').update(Buffer.from(asset.base64, 'base64')).digest('hex'), asset.sha256);
  assert.equal(Object.values(restored.canvasPayloads)[0].customBlocks.length, 1);
  assert.equal(Object.keys(Object.values(restored.canvasPayloads)[0].files).length, 1);
}
try {
  if (platforms.includes(false)) browser = await chromium.launch({ headless: false });
  const sources = [];
  for (const native of platforms) {
    const mode = native ? 'electron' : 'chromium', s = await session(native, `source-${mode}`);
    try {
      await s.page.evaluate(() => Promise.race([window.backupProbe.seed(), new Promise((_, reject) => setTimeout(() => reject(new Error('Seed timed out: ' + window.backupSeedStep)), 30000))]));
      if (pdfOnly) {
        await s.page.evaluate(() => window.backupProbe.preparePdfCases());
        const before = await s.exportUI(`pdf-${mode}-before`);
        const workspace = s.page.getByRole('button', { name: 'Expand Asset portability proof', exact: true }); if (await workspace.count()) await workspace.click();
        const book = s.page.getByRole('treeitem', { name: 'Portable research', exact: true }); await book.waitFor();
        const expandBook = s.page.getByRole('button', { name: 'Expand Portable research', exact: true }); if (await expandBook.count()) await expandBook.click();
        await s.page.getByRole('treeitem', { name: 'Mixed notes', exact: true }).waitFor();
        const expandSection = s.page.getByRole('button', { name: 'Expand Mixed notes', exact: true }); if (await expandSection.count()) await expandSection.click();
        for (const title of ['Rich A4', 'Infinite proof', 'Infinite wide', 'Rich A3', 'Rich A5', 'Rich Letter', 'Portable research']) {
          await s.page.evaluate(() => window.backupProbe.clearToast());
          const destination = path.resolve(out, `pdf-${mode}-${title.replaceAll(' ', '-')}.pdf`);
          if (native) await s.app.evaluate(({ BrowserWindow }, destination) => {
            globalThis.pdfDownloadPromise = new Promise((resolve, reject) => BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
              item.setSavePath(destination); item.once('done', (_event, state) => state === 'completed' ? resolve(state) : reject(new Error('PDF download ' + state)));
            })); globalThis.pdfDownloadPromise.catch(() => {});
          }, destination);
          const download = native ? null : s.page.waitForEvent('download', { timeout: 60000 }); download?.catch(() => {});
          await s.page.getByRole('treeitem', { name: title, exact: true }).click({ button: 'right' });
          await s.page.getByRole('menu', { name: 'Item actions', exact: true }).getByRole('menuitem', { name: title === 'Portable research' ? 'Export Notebook to PDF' : 'Export Page to PDF', exact: true }).click();
          await s.page.waitForFunction(() => { const toast = window.backupProbe.state().toast; return toast?.type === 'error' || toast?.message.startsWith('PDF exported'); }, null, { timeout: 60000 });
          const state = await s.page.evaluate(() => window.backupProbe.state()); assert.notEqual(state.toast.type, 'error', state.toast.message);
          if (download) await (await download).saveAs(destination);
          else await s.app.evaluate(() => globalThis.pdfDownloadPromise);
          const { PDFDocument } = await import('pdf-lib'), doc = await PDFDocument.load(await readFile(destination));
          reports.push({ mode, title, file: destination, pages: doc.getPageCount(), dimensions: doc.getPages().map(p => p.getSize()), toast: state.toast });
        }
        const after = await s.exportUI(`pdf-${mode}-after`); assert.deepEqual(after.pagePayloads, before.pagePayloads);
        continue;
      }
      const backup = await s.exportUI(`source-${mode}`); assert.equal(Object.keys(backup.assets).length, 3); assert.equal(Object.keys(backup.annotationPayloads).length, 1); sources.push({ mode, backup, file: `${out}/source-${mode}.panvas-backup.json` }); await s.page.screenshot({ path: `${out}/source-${mode}.png` }); if (!native) { const rollback = await s.page.evaluate(() => window.backupProbe.browserRollback()); assert.equal(rollback.before, rollback.after); }
    }
    finally { await s.close(); }
  }
  for (const source of sources) for (const native of platforms) {
    const mode = native ? 'electron' : 'chromium', name = `${source.mode}-to-${mode}`, s = await session(native, name);
    try {
      await s.importUI(source.file); const restored = await s.exportUI(name); compare(source.backup, restored);
      await s.page.reload(); await s.page.getByRole('button', { name: 'Export Workspace Backup', exact: true }).waitFor(); const reopened = await s.exportUI(`${name}-reopen`); assert.deepEqual(reopened.pagePayloads, restored.pagePayloads); assert.deepEqual(reopened.assets, restored.assets);
      assert.deepEqual(await s.page.evaluate(() => window.backupProbe.verifyAssets()), { image: [160, 100], audioSamples: 800, pdfPages: 2, annotationStrokes: 1 });
      const expand = async label => { const toggle = s.page.getByRole('button', { name: `Expand ${label}`, exact: true }); if (await toggle.count()) await toggle.click(); };
      await expand(restored.workspace.name); await s.page.getByRole('treeitem', { name: 'Portable research', exact: true }).waitFor(); await expand('Portable research');
      await s.page.getByRole('treeitem', { name: 'Mixed notes', exact: true }).waitFor(); await expand('Mixed notes');
      await s.page.getByRole('treeitem', { name: 'Rich A4', exact: true }).click();
      await s.page.waitForFunction(() => { const root = document.querySelector('[data-document-body]'); return root?.querySelector('.katex') && root.querySelector('table') && root.querySelector('img')?.naturalWidth === 160; });
      await s.page.screenshot({ path: `${out}/${name}-restored-document.png` });
      await s.page.locator('aside.panvas-sidebar').getByRole('button', { name: 'Library', exact: true }).click();
      await s.page.getByRole('button', { name: 'Restore Workspace Backup', exact: true }).waitFor();
      await s.page.screenshot({ path: `${out}/${name}.png` });
      const corrupt = structuredClone(source.backup); Object.values(corrupt.assets)[0].sha256 = '0'.repeat(64); const corruptFile = `${out}/${name}-corrupt.json`; await writeFile(corruptFile, JSON.stringify(corrupt));
      const before = await s.page.evaluate(() => window.backupProbe.workspaces()); await s.importUI(corruptFile, false); assert.deepEqual(await s.page.evaluate(() => window.backupProbe.workspaces()), before);
      if (native && !productionMain) {
        await s.app.evaluate(() => { const fs = globalThis.backupRestoreFS, rename = fs.rename; globalThis.backupRestoreRename = rename; fs.rename = async (...args) => { if (String(args[1]).replaceAll('\\', '/').endsWith('/workspace.json')) throw new Error('Injected publication failure'); return rename(...args); }; });
        try { await s.importUI(source.file, false); assert.deepEqual(await s.page.evaluate(() => window.backupProbe.workspaces()), before); }
        finally { await s.app.evaluate(() => { globalThis.backupRestoreFS.rename = globalThis.backupRestoreRename; }); }
        const entries = await readdir(path.join(s.root, 'workspaces')); assert.ok(entries.every(entry => !entry.startsWith('.restore-')));
      }
      // Legacy packages cannot invent omitted bytes; restore must explain that.
      const legacy = structuredClone(source.backup); legacy.header.version = 1; delete legacy.assets; delete legacy.annotationPayloads;
      const legacyFile = `${out}/${name}-v1.json`; await writeFile(legacyFile, JSON.stringify(legacy));
      const legacyState = await s.importUI(legacyFile); assert.equal(legacyState.toast.type, 'info'); assert.match(legacyState.toast.message, /v1 backup omitted 3/);
      reports.push({ name, pass: true, productionMain: native && productionMain, assetHashes: Object.values(restored.assets).map(a => a.sha256), pages: restored.pages.length, annotationPayloads: 1, saveReopen: true, decodedImagePdfAudio: true, restoredDocumentVisible: true, corruptRejectedWithoutWrites: true, legacyWarning: true, nativePublicationRollback: native && !productionMain });
    } finally { await s.close(); }
  }
} finally { await writeFile(`${out}/${pdfOnly ? 'pdf-ui-results' : 'ui-results'}.json`, JSON.stringify({ directory, scope: 'Actual full app buttons; native OS file chooser responses supplied by test. Disposable profiles only.', reports, errors }, null, 2)); if (browser) await browser.close(); await server.close(); }
console.log(JSON.stringify(reports, null, 2));
