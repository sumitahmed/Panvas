import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build, preview } from 'vite';
import { build as bundle } from 'esbuild';
import { chromium, _electron } from 'playwright';
import { runDocumentationPolish } from './documentation-polish-cases.mjs';
import { runDocumentationFinal } from './documentation-final-cases.mjs';
import { runEditingCorrective } from './documentation-editing-cases.mjs';
import { runToolbarUX } from './formatting-toolbar-cases.mjs';
import { runHighlightCorrectness } from './highlight-correctness-cases.mjs';
import { openNotebookProperties, closeNotebookProperties, chooseWritingLayout } from './helpers/notebook-properties.mjs';

const require = createRequire(import.meta.url), native = process.argv.includes('--electron');
const headed = process.argv.includes('--headed');
const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) ?? 'baseline';
const inspectOnly = process.argv.includes('--inspect-only'), mode = native ? 'electron' : 'web';
const appShell = process.argv.includes('--app-shell');
const productionEntry = process.argv.includes('--production-entry') || appShell;
const beforeRendering = process.argv.includes('--before-rendering');
const beforePolish = process.argv.includes('--before-polish'), polish = process.argv.includes('--polish');
const polishSources = new Map(), restoredPolishSources = new Set();
const baselineDirectory = name => {
  const value = process.env[name];
  assert.ok(value && path.isAbsolute(value), `${name} must point to an absolute historical snapshot directory.`);
  return value;
};
if (beforePolish) for (const file of ['src/components/notebook/notebookClipboard.ts', 'src/components/notebook/notebookCodeBlockView.ts', 'src/components/notebook/NotebookWorkspaceControls.tsx', 'src/components/notebook/NotebookWritingModeControl.tsx', 'src/components/notebook/NotebookToolPropertiesPanel.tsx', 'src/components/notebook/NotebookRenderer.tsx', 'src/styles/index.css']) polishSources.set('/' + file, await readFile(path.join(baselineDirectory('PANVAS_POLISH_BASELINE'), file), 'utf8'));
let beforeRenderingApplied = false;
const beforeControls = process.argv.includes('--before-controls'), firstRun = process.argv.includes('--first-run');
const dpr = Number(process.argv.find(arg => arg.startsWith('--dpr='))?.slice(6) ?? '1');
const previousSources = new Map();
if (process.argv.includes('--stabilization-before')) {
  const baseline = JSON.parse(await readFile('artifacts/critical-stabilization-20261016/baseline-location.json', 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(baseline.root, 'manifest.json'), 'utf8'));
  for (const { path: file } of [...manifest, { path: 'src/components/notebook/engine/penGeometry.ts' }, { path: 'src/components/notebook/engine/cloneStrokeSnapshot.ts' }]) {
    if (file.startsWith('src/') && /\.(ts|tsx|css)$/.test(file)) previousSources.set('/' + file, await readFile(path.join(baseline.root, 'files', file), 'utf8'));
  }
}
if (process.argv.includes('--before-highlight')) {
  const { directory: baseline } = JSON.parse(await readFile('artifacts/highlight-correctness-20261015/baseline-location.json', 'utf8'));
  for (const file of ['src/components/notebook/FloatingTextEditor.tsx', 'src/components/notebook/textFormatting.ts']) previousSources.set('/' + file, await readFile(path.join(baseline, 'baseline', file), 'utf8'));
}
if (process.argv.includes('--before-editing')) for (const file of ['src/components/notebook/notebookBlockCommands.ts', 'src/components/notebook/notebookDocumentationNodes.ts', 'src/components/notebook/textFormatting.ts', 'src/components/notebook/DocumentationControls.tsx', 'src/components/notebook/SlashMenuList.tsx', 'src/components/notebook/NotebookFloatingToolbar.tsx', 'src/components/ui/OverlayManager.tsx']) previousSources.set('/' + file, await readFile(path.join(baselineDirectory('PANVAS_EDITING_BASELINE'), file), 'utf8'));
if (beforeControls) for (const file of ['DocumentationControls.tsx', 'NotebookFloatingToolbar.tsx', 'documentPagination.ts']) previousSources.set(`/src/components/notebook/${file}`, await readFile(path.join(baselineDirectory('PANVAS_WORKFLOW_BASELINE'), 'src/components/notebook', file), 'utf8'));
const out = process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? 'artifacts/documentation-workflow-repair', directory = await mkdtemp(path.join(tmpdir(), 'panvas-workflow-'));
const restoreDirectory = process.argv.find(arg => arg.startsWith('--restore-directory='))?.slice(20);
if (restoreDirectory) {
  assert.ok(path.resolve(restoreDirectory).startsWith(path.join(tmpdir(), 'panvas-workflow-')), 'Restore diagnostics accept only this test suite disposable directories.');
  for (const folder of ['profile', 'workspaces']) await cp(path.join(restoreDirectory, folder), path.join(directory, folder), { recursive: true });
}
await mkdir(out, { recursive: true });
const entry = productionEntry ? 'index.html' : 'tests/fixtures/documentation-workflow.html';
await build({ mode: 'web', base: './', logLevel: 'error', plugins: [{ name: 'workflow-profiler', enforce: 'pre', transform(code, id) { const normalized = id.replaceAll('\\', '/'); for (const [file, previous] of previousSources) if (normalized.endsWith(file)) return previous; for (const [file, previous] of polishSources) if (normalized.endsWith(file)) { code = previous; restoredPolishSources.add(file); } if (polish && normalized.endsWith('/src/components/notebook/notebookCodeBlockView.ts')) code = code.replace('return ({ editor, node, getPos, HTMLAttributes, view }) => {', '$& (window as any).workflowProbe?.nodeView("create");').replace('update: next => {', '$& (window as any).workflowProbe?.nodeView("update");').replace('destroy: () => {', '$& (window as any).workflowProbe?.nodeView("destroy");'); if (beforeRendering && normalized.endsWith('/src/components/notebook/DocumentFlowEditor.tsx')) { const next = code.replace("engine.input.notifyChange('document-text')", 'engine.input.notifyChange()'); beforeRenderingApplied = next !== code; return next; } if (productionEntry && normalized.endsWith('/src/main.tsx')) return `import '/tests/fixtures/documentation-workflow.tsx';\n${code}`; if (normalized.endsWith('/src/bootstrap.tsx')) code = code.replace('<EntrySurface />', '<React.Profiler id="Panvas application" onRender={(_id,phase,duration) => (window as any).workflowProbe?.commit(phase,duration)}><EntrySurface /></React.Profiler>'); return code; } }],
  resolve: { alias: { 'react-dom/client': require.resolve('react-dom/profiling') } }, build: { outDir: path.join(directory, 'dist'), emptyOutDir: false, minify: false, rollupOptions: { input: path.resolve(entry) } } });
assert.ok(!beforeRendering || beforeRenderingApplied, 'The before run must use the previous scene publication path.');
assert.equal(restoredPolishSources.size, polishSources.size, 'Every before source must come from the preserved snapshot.');
const server = await preview({ configFile: false, plugins: [{ name: 'workflow-routes', configurePreviewServer(server) { server.middlewares.use((request, _response, next) => { if (request.url === '/app' || request.url?.startsWith('/app/')) request.url = `/${entry}`; next(); }); } }], build: { outDir: path.join(directory, 'dist') }, preview: { port: 0, open: false } });
const url = server.resolvedUrls.local[0] + entry + (firstRun ? '?firstRun=1' : '') + (native ? '#/app' : '');
let browser, app, page, cdp; const errors = [], reports = [], evidence = {};
const settle = (count = 4) => page.evaluate(async count => { for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame); }, count);
const scrollDocument = async (logicalY = 0) => { await page.evaluate(logicalY => {
  const root = window.workflowProbe.editor().view.dom.closest('[data-rendered-page-id]'), scroller = root.closest('.notebook-viewport');
  scroller.scrollTop += root.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 96 + logicalY * (root.getBoundingClientRect().width / root.offsetWidth);
}, logicalY); await settle(); };
const waitSaved = async expected => {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    const saved = await page.evaluate(async () => { const data = await window.workflowProbe.saved(); return data?.objects?.find(object => object.metadata?.documentRole === 'body')?.content; });
    if (JSON.stringify(saved) === JSON.stringify(expected)) return;
    await settle();
  }
  throw new Error('Canonical body did not finish autosaving.');
};
const createPage = async name => createDocument(name, 'A4', 'freeform');
const createDocument = async (name, paper = 'A4', writing = 'document') => {
  await page.getByRole('button', { name: 'New item', exact: true }).click(); await page.getByRole('menu', { name: 'Create new item', exact: true }).getByRole('button', { name: 'New Page', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Page', exact: true });
  await dialog.getByRole('button', { name: 'Document', exact: false, pressed: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Document', exact: false }).getAttribute('aria-pressed'), 'true'); assert.equal(await dialog.getByRole('button', { name: 'A4', exact: true }).getAttribute('aria-pressed'), 'true');
  await dialog.locator('#create-dialog-input').fill(name); await dialog.getByRole('button', { name: paper, exact: true }).click(); await dialog.getByRole('button', { name: writing === 'document' ? 'Document' : 'Freeform', exact: false }).click();
  if (writing === 'document') await page.screenshot({ path: `${out}/${phase}-${mode}-new-page.png` });
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction(name => window.workflowProbe.ready() && window.workflowProbe.snapshot().pages.some(page => page.title === name && page.id === window.workflowProbe.location().pageId), name);
  if (writing === 'document') await page.waitForFunction(() => window.workflowProbe.editor()?.isFocused && window.workflowProbe.editor().isEditable);
  await settle();
};
const source = '<h1>Technical reference</h1><p>Read the <a href="https://example.com/reference">linked explanation</a> and retain <strong>formatted</strong> prose with <code>inline code</code>.</p><h2>Code</h2><pre><code class="language-rust">fn main() {\n    println!("Hello, world!");\n}</code></pre><h2>Output</h2><pre data-language="plaintext"><code>Hello, world!</code></pre><table><tr><th>Concept</th><th>Description</th><th>Reading policy</th></tr><tr><td>Ownership</td><td>Keep long explanations intact while editing and saving the document.</td><td>Readable columns retain their structure and scroll when necessary.</td></tr></table><ul><li>Bulleted explanation</li></ul><ol><li>Numbered step</li></ol><div data-type="block-math" data-latex="E=mc^2"></div>' + Array.from({ length: 60 }, (_, index) => `<p>Paragraph ${index + 1}. ${'A long technical document must retain its reading order as paragraphs continue onto the next sheet. '.repeat(5)}</p>`).join('');
const pasteHTML = html => page.evaluate(html => { const editor = window.workflowProbe.editor(); const clipboardData = new DataTransfer(); clipboardData.setData('text/html', html); clipboardData.setData('text/plain', 'Technical reference'); editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })); }, html);
const paste = () => pasteHTML(source);
const workload = async (name, run) => { if (process.argv.includes('--acceptance-only')) { await run(); await settle(); return; } await cdp.send('Profiler.start'); const started = performance.now(), before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(value => [value.name, value.value])); await page.evaluate(() => window.workflowProbe.begin()); await run(); await settle(); const measured = await page.evaluate(() => window.workflowProbe.end()); const { profile } = await cdp.send('Profiler.stop'), after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(value => [value.name, value.value])); const cpuFile = `${phase}-${mode}-${name}.cpuprofile`; await writeFile(`${out}/${cpuFile}`, JSON.stringify(profile)); reports.push({ name, elapsedMs: performance.now() - started, ...measured, heapBytes: after.JSHeapUsedSize, layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000, styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000, scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000, cpuFile }); };
try {
  if (native) {
    if (appShell) {
      await mkdir(path.join(directory, 'dist-electron')); await symlink(path.resolve('node_modules'), path.join(directory, 'node_modules'), 'junction');
      await bundle({ entryPoints: ['electron/preload.ts'], outfile: path.join(directory, 'dist-electron/preload.mjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
      const mainSource = (await readFile('electron/main.ts', 'utf8')).replace('new BrowserWindow({', `new BrowserWindow({show: ${headed},`).replace('webPreferences: {', `webPreferences: {backgroundThrottling: false, offscreen: ${!headed},`);
      await bundle({ stdin: { contents: mainSource, resolveDir: path.resolve('electron'), sourcefile: 'main.ts', loader: 'ts' }, outfile: path.join(directory, 'dist-electron/main.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
      await writeFile(path.join(directory, 'bootstrap.cjs'), `const {app}=require('electron');app.commandLine.appendSwitch('force-device-scale-factor',${JSON.stringify(String(dpr))});process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_USER_DATA=require('node:path').join(__dirname,'profile');app.setPath('userData',process.env.PANVAS_GATE0_USER_DATA);process.env.PANVAS_GATE0_WORKSPACE_ROOT=require('node:path').join(__dirname,'workspaces');process.env.PANVAS_TEST_WINDOW='1440x1100';import('./dist-electron/main.mjs');`);
    } else {
      for (const [entry, file] of [['electron/ipc/domain-handlers.ts', 'domain.cjs'], ['electron/preload.ts', 'preload.cjs']]) await bundle({ entryPoints: [entry], outfile: path.join(directory, file), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
      await writeFile(path.join(directory, 'bootstrap.cjs'), `const {app,BrowserWindow}=require('electron');app.commandLine.appendSwitch('force-device-scale-factor',${JSON.stringify(String(dpr))});app.setPath('userData',require('node:path').join(__dirname,'profile'));process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=require('node:path').join(__dirname,'workspaces');process.env.VITE_DEV_SERVER_URL=${JSON.stringify(server.resolvedUrls.local[0])};app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();new BrowserWindow({show:false,width:1440,height:1100,titleBarStyle:'hidden',titleBarOverlay:true,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}}).loadURL(${JSON.stringify(url)});});`);
    }
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; if (appShell) delete env.VITE_DEV_SERVER_URL; app = await _electron.launch({ args: [path.join(directory, 'bootstrap.cjs')], env }); page = await app.firstWindow();
  } else { browser = await chromium.launch({ headless: !headed }); page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: dpr }); await page.goto(url); }
  page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') console.log('renderer:', message.text()); });
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
  await page.waitForFunction(() => Boolean(window.workflowProbe.location().workspaceId) && window.workflowProbe.snapshot().pages.length > 0); await settle();
  const localPrompt = page.getByRole('button', { name: 'Continue locally', exact: true });
  if (await localPrompt.count()) await localPrompt.click();
  if (inspectOnly) {
    if (restoreDirectory) { await page.locator('aside.panvas-sidebar').getByText('Conversion proof', { exact: true }).click(); await page.waitForFunction(() => window.workflowProbe?.ready()); await settle(); await page.reload(); }
    await page.waitForFunction(() => window.workflowProbe?.ready() && Boolean(window.workflowProbe.editor())).catch(() => {}); await settle(); console.log((await page.locator('body').innerText()).slice(0, 300)); await page.screenshot({ path: `${out}/${phase}-${mode}-startup.png` });
  }
  else {
    cdp = await page.context().newCDPSession(page); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdp.send('Performance.enable');
    await page.getByRole('button', { name: 'New item', exact: true }).click(); await page.getByRole('menu', { name: 'Create new item', exact: true }).getByRole('button', { name: 'New Notebook', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New Notebook', exact: true }); await dialog.locator('#create-dialog-input').fill('Documentation workflow'); await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('aside.panvas-sidebar').getByText('Documentation workflow', { exact: true }).click();
    await page.getByRole('button', { name: 'Collapse Documentation workflow', exact: true }).waitFor(); await settle();
    if (process.argv.includes('--highlight-correctness') || process.argv.includes('--toolbar-ux') || process.argv.includes('--editing') || process.argv.includes('--polish') || process.argv.includes('--final')) {
      if (process.argv.includes('--highlight-correctness')) await runHighlightCorrectness({ page, app, native, phase, mode, out, evidence, workload, createDocument, settle, waitSaved });
      if (process.argv.includes('--toolbar-ux')) await runToolbarUX({ page, app, native, phase, mode, out, evidence, workload, createDocument, settle, waitSaved });
      if (process.argv.includes('--editing')) await runEditingCorrective({ page, app, native, phase, mode, out, evidence, workload, createDocument, settle, waitSaved });
      if (process.argv.includes('--polish')) await runDocumentationPolish({ page, app, native, phase, mode, out, evidence, workload, createDocument, settle, waitSaved });
      if (process.argv.includes('--final')) await runDocumentationFinal({ page, app, native, phase, mode, out, evidence, workload, createDocument, settle, waitSaved });
    } else {
    await createPage('Workflow page');
    await page.getByTitle('Text (T)', { exact: true }).click();
    const canvas = page.locator('[data-live-page-visual] canvas').first(); const box = await canvas.boundingBox(); await page.mouse.click(box.x + box.width * .35, Math.max(180, box.y + 120));
    await page.waitForFunction(() => window.workflowProbe.editor()?.view.dom.isConnected); await workload('freeform-paste', paste);
    evidence.ordinary = await page.evaluate(() => window.workflowProbe.snapshot()); await page.screenshot({ path: `${out}/${phase}-${mode}-ordinary-paste.png` });
    assert.equal(evidence.ordinary.properties.layoutMode ?? 'freeform', 'freeform'); assert.ok(evidence.ordinary.texts[0].width < 500);
    await page.locator('.ProseMirror[contenteditable="true"] h1').first().click(); await page.keyboard.press('Control+Home');
    await workload('freeform-typing', async () => { for (const value of 'abcdefghijkl') { await page.keyboard.type(value); await settle(2); } });
    const legacy = await page.evaluate(() => window.workflowProbe.snapshot()); evidence.freeformBeforeFlow = legacy;
    await page.getByRole('button', { name: 'More text formatting', exact: true }).click(); await settle(); const menu = page.getByRole('dialog', { name: 'Text formatting options', exact: true }); evidence.menu = await menu.evaluate(root => ({ bounds: root.getBoundingClientRect().toJSON(), controls: root.querySelectorAll('button,input,select,textarea').length, textarea: !!root.querySelector('textarea') })); await page.screenshot({ path: `${out}/${phase}-${mode}-formatting.png` }); await page.keyboard.press('Escape');
    if (phase === 'baseline') {
      await createPage('Explicit document flow');
      await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click();
      await page.getByRole('combobox', { name: 'Writing layout', exact: true }).selectOption('document');
      await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click();
      await page.getByRole('textbox', { name: 'Document body', exact: true }).click();
    } else await createDocument('Explicit document flow');
    await workload('a4-paste', paste); await page.waitForFunction(() => Number(document.querySelector('[data-document-sheet-count]')?.dataset.documentSheetCount) >= 3);
    evidence.explicitFlow = await page.evaluate(() => {
      const root = window.workflowProbe.editor().view.dom, rect = root.getBoundingClientRect(), scale = rect.width / root.offsetWidth, stride = window.workflowProbe.sheetStride(), filled = new Set();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let text;
      while (text = walker.nextNode()) { if (!text.textContent.trim()) continue; const range = document.createRange(); range.selectNodeContents(text); for (const box of range.getClientRects()) if (box.height > 0) filled.add(1 + Math.floor((box.top - rect.top) / scale / stride)); }
      return { snapshot: window.workflowProbe.snapshot(), sheets: Number(root.closest('[data-rendered-page-id]').querySelector('[data-document-sheet-count]')?.dataset.documentSheetCount ?? document.querySelector('[data-document-sheet-count]').dataset.documentSheetCount), width: root.offsetWidth, filledSheets: [...filled].sort((a,b) => a-b) };
    });
    assert.ok([1,2,3].every(sheet => evidence.explicitFlow.filledSheets.includes(sheet)), 'The first three physical sheets must contain rendered text, not just empty frames.');
    await scrollDocument(); await page.screenshot({ path: `${out}/${phase}-${mode}-explicit-flow.png` });
    await page.getByRole('textbox', { name: 'Document body', exact: true }).locator('h1').click(); await page.keyboard.press('Control+Home');
    await workload('a4-typing', async () => { for (const value of 'abcdefghijkl') { await page.keyboard.type(value); await settle(2); } });
    await page.getByRole('textbox', { name: 'Document body', exact: true }).locator('pre').first().click(); await page.keyboard.press('End');
    await workload('a4-code', async () => { for (const value of ' codeedit') { await page.keyboard.type(value); await settle(2); } });
    await page.getByRole('textbox', { name: 'Document body', exact: true }).locator('p').filter({ hasText: 'Paragraph 1.' }).first().click(); await page.keyboard.press('Home');
    await workload('a4-selection', async () => { for (let index = 0; index < 40; index++) { await page.keyboard.press('Shift+ArrowDown'); await settle(2); } });
    await page.keyboard.press('ArrowLeft'); await page.locator('.notebook-viewport').hover();
    await workload('a4-scroll', async () => { for (let index = 0; index < 10; index++) { await page.mouse.wheel(0, 800); await settle(3); } });
    await workload('a4-autosave', async () => { await waitSaved(await page.evaluate(() => window.workflowProbe.editor().getJSON())); });
    const flowId = await page.evaluate(() => window.workflowProbe.location().pageId);
    const expandSection = page.getByRole('button', { name: 'Expand Section 1', exact: true });
    if (await expandSection.count()) { await expandSection.click(); await page.getByRole('button', { name: 'Collapse Section 1', exact: true }).waitFor(); }
    await workload('page-transitions', async () => { for (const title of ['Workflow page', 'Explicit document flow']) { await page.locator('aside.panvas-sidebar').getByText(title, { exact: true }).click(); await page.waitForFunction(() => window.workflowProbe.ready()); await settle(); if (title === 'Workflow page') { const current = await page.evaluate(() => window.workflowProbe.snapshot()); assert.equal(current.properties.layoutMode ?? 'freeform', 'freeform'); assert.deepEqual(current.texts, legacy.texts); } } });
    assert.equal(await page.evaluate(() => window.workflowProbe.location().pageId), flowId);
    if (phase !== 'baseline' && !phase.startsWith('measure')) {
      const bodyJSON = () => page.evaluate(() => window.workflowProbe.editor().getJSON());
      const laterPosition = () => page.getByRole('textbox', { name: 'Document body', exact: true }).locator('p').filter({ hasText: 'Paragraph 40.' }).evaluate(node => node.offsetTop);
      const original = await bodyJSON(), initialSheets = await page.locator('[data-document-sheet-count]').first().getAttribute('data-document-sheet-count'), initialLater = await laterPosition();
      await page.getByTitle('Text (T)', { exact: true }).click(); await page.getByRole('textbox', { name: 'Document body', exact: true }).locator('h1').click(); await page.keyboard.press('Control+Home');
      await pasteHTML(Array.from({ length: 12 }, (_, index) => `<p>Early addition ${index + 1}. ${'Early reflow demonstration. '.repeat(20)}</p>`).join('')); await settle();
      const addedLater = await laterPosition(), addedSheets = Number(await page.locator('[data-document-sheet-count]').first().getAttribute('data-document-sheet-count'));
      assert.ok(addedLater > initialLater + 1123); assert.ok(addedSheets > Number(initialSheets));
      // Separate these two human edits by ProseMirror's 500ms undo-group window.
      const expanded = await bodyJSON(); await page.waitForTimeout(600); await page.keyboard.press('Control+Home');
      for (let index = 0; index < 10; index++) { await page.keyboard.press('Control+Shift+ArrowDown'); await settle(2); }
      assert.ok(await page.evaluate(() => window.workflowProbe.editor().state.selection.to - window.workflowProbe.editor().state.selection.from) > 1500);
      await page.keyboard.press('Backspace'); await settle();
      const deletedLater = await laterPosition(); assert.ok(deletedLater < addedLater);
      await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await bodyJSON(), expanded);
      await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await bodyJSON(), original);
      await page.keyboard.press('Control+Shift+z'); await settle(); assert.deepEqual(await bodyJSON(), expanded);
      await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await bodyJSON(), original);
      evidence.reflow = { initialSheets: Number(initialSheets), addedSheets, initialLater, addedLater, deletedLater, undoRedoExact: true };
      await scrollDocument(850); await page.screenshot({ path: `${out}/${phase}-${mode}-a4-continuation.png` });
      assert.equal(evidence.explicitFlow.snapshot.texts.filter(text => text.metadata?.documentRole === 'body').length, 1);
      assert.equal(evidence.explicitFlow.snapshot.pages.filter(item => item.id === flowId).length, 1);
      for (let index = 1; index <= 60; index++) assert.equal(await page.getByRole('textbox', { name: 'Document body', exact: true }).locator('p').filter({ hasText: `Paragraph ${index}.` }).count(), 1);
      const savedJSON = await bodyJSON();
      await waitSaved(savedJSON);
      await page.reload(); await page.waitForFunction(() => window.workflowProbe?.ready() && Boolean(window.workflowProbe.editor())); await settle(); assert.deepEqual(await bodyJSON(), savedJSON);
      evidence.reopen = { pageId: await page.evaluate(() => window.workflowProbe.location().pageId), exactBody: true, bodies: (await page.evaluate(() => window.workflowProbe.snapshot())).texts.filter(text => text.metadata?.documentRole === 'body').length };
      if (phase.startsWith('verify')) {
        await page.getByTitle('Text (T)', { exact: true }).click();
        const documentId = await page.evaluate(() => window.workflowProbe.editor().view.dom.closest('[data-document-body]').dataset.documentBody);
        const body = page.locator(`[data-document-body="${documentId}"] .ProseMirror`);
        const beforeTools = await bodyJSON();
        await page.getByTitle('Select (V)', { exact: true }).click();
        await page.locator('[data-live-page-visual] canvas').first().evaluate(canvas => { const clipboardData = new DataTransfer(); clipboardData.setData('text/html', '<p>Canvas paste reaches the document body</p>'); clipboardData.setData('text/plain', 'Canvas paste reaches the document body'); canvas.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })); });
        await page.waitForFunction(() => window.workflowProbe.editor()?.getText().includes('Canvas paste reaches the document body')); assert.equal((await page.evaluate(() => window.workflowProbe.snapshot().texts)).length, 1);
        await page.keyboard.press('Control+z'); assert.deepEqual(await bodyJSON(), beforeTools); evidence.canvasPaste = { bodyTarget: true, noNewTextBox: true, undoExact: true };
        await body.locator('p').filter({ hasText: 'Paragraph 1.' }).first().click(); await page.keyboard.press('Home');
        for (let index = 0; index < 40; index++) { await page.keyboard.press('Shift+ArrowDown'); await settle(2); }
        const selected = await page.evaluate(() => { const editor = window.workflowProbe.editor(); return { from: editor.state.selection.from, to: editor.state.selection.to, first: editor.view.coordsAtPos(editor.state.selection.from).top, last: editor.view.coordsAtPos(editor.state.selection.to).top }; });
        assert.ok(selected.to - selected.from > 1500); assert.ok(selected.last - selected.first > 1000);
        await page.keyboard.press('Control+b'); assert.equal(await page.evaluate(() => window.workflowProbe.editor().isActive('bold')), true); await page.keyboard.press('Control+z'); assert.deepEqual(await bodyJSON(), beforeTools);
        // A native-looking select is replaced by the shared font catalog inside
        // this same compact panel. Keyboard font choice retains the live range.
        const formatting = page.getByRole('dialog', { name: 'Text formatting options', exact: true });
        await page.getByRole('button', { name: 'More text formatting', exact: true }).click();
        await formatting.getByRole('button', { name: 'Text font', exact: true }).click();
        assert.equal(await page.getByRole('dialog', { name: 'Text formatting options', exact: true }).count(), 1); assert.equal(await page.locator('[data-panvas-overlay-id]').count(), 1);
        await page.screenshot({ path: `${out}/${phase}-${mode}-font-panel.png` });
        const selectedFont = formatting.getByRole('option', { name: 'Caveat', exact: true }); await selectedFont.waitFor(); await page.waitForFunction(() => document.querySelector('[role="option"][aria-selected]') && Array.from(document.querySelectorAll('[role="option"]')).some(option => option.textContent.trim() === 'Caveat' && option.getAttribute('aria-disabled') === 'false'));
        await selectedFont.focus(); await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => window.workflowProbe.editor().state.selection.to - window.workflowProbe.editor().state.selection.from), selected.to - selected.from);
        assert.ok(JSON.stringify(await bodyJSON()).includes('Caveat')); await page.keyboard.press('Escape'); await page.keyboard.press('Control+z'); assert.deepEqual(await bodyJSON(), beforeTools);
        evidence.fontRange = { keyboard: true, retainedCharacters: selected.to - selected.from, undoExact: true, singlePanel: true };
        await body.getByRole('cell', { name: 'Ownership', exact: true }).click(); await page.keyboard.press('End'); await page.keyboard.insertText(' cell edit'); assert.ok(JSON.stringify(await bodyJSON()).includes('Ownership cell edit')); await page.keyboard.press('Control+z'); assert.deepEqual(await bodyJSON(), beforeTools);
        await body.getByRole('cell', { name: 'Ownership', exact: true }).click();
        await page.getByRole('button', { name: 'More text formatting', exact: true }).click(); const tools = page.getByRole('dialog', { name: 'Text formatting options', exact: true });
        await page.screenshot({ path: `${out}/${phase}-${mode}-document-formatting.png` });
        const textTab = tools.getByRole('tab', { name: 'Text', exact: true }); await textTab.focus(); await textTab.press('ArrowRight');
        const paragraphTab = tools.getByRole('tab', { name: 'Paragraph', exact: true }); assert.equal(await paragraphTab.getAttribute('aria-selected'), 'true'); await paragraphTab.press('ArrowRight'); assert.equal(await tools.getByRole('tab', { name: 'Insert', exact: true }).getAttribute('aria-selected'), 'true');
        await tools.getByRole('tab', { name: 'Table', exact: true }).click(); await tools.getByRole('button', { name: 'Add row', exact: true }).click(); assert.equal((await bodyJSON()).content.find(node => node.type === 'table').content.length, beforeTools.content.find(node => node.type === 'table').content.length + 1);
        await page.keyboard.press('Escape'); await page.keyboard.press('Control+z'); assert.deepEqual(await bodyJSON(), beforeTools);
        await body.locator('p').filter({ hasText: 'Paragraph 1.' }).first().click(); await page.keyboard.press('Home');
        const openMarkdown = async () => { await page.getByRole('button', { name: 'More text formatting', exact: true }).click(); await tools.getByRole('tab', { name: 'Insert', exact: true }).click(); assert.equal(await tools.locator('textarea').count(), 0); await tools.getByRole('button', { name: 'Paste Markdown…', exact: true }).click(); };
        await openMarkdown(); const markdown = page.getByRole('dialog', { name: 'Paste Markdown', exact: true });
        await markdown.getByRole('textbox', { name: 'Markdown source', exact: true }).fill('# Cancelled source'); await page.keyboard.press('Escape'); assert.deepEqual(await bodyJSON(), beforeTools);
        if (await tools.count()) await page.keyboard.press('Escape');
        await openMarkdown(); await markdown.getByRole('textbox', { name: 'Markdown source', exact: true }).fill('## Markdown proof\n\n- [x] Reviewed'); await page.screenshot({ path: `${out}/${phase}-${mode}-markdown.png` }); await markdown.getByRole('button', { name: 'Insert Markdown', exact: true }).click(); assert.ok(JSON.stringify(await bodyJSON()).includes('Markdown proof')); assert.ok(JSON.stringify(await bodyJSON()).includes('"taskList"'));
        await page.keyboard.press('Control+z'); assert.deepEqual(await bodyJSON(), beforeTools);
        if (await tools.count()) await page.keyboard.press('Escape');
        await body.locator('p').filter({ hasText: 'Paragraph 1.' }).first().click();
        await page.getByRole('button', { name: 'More text formatting', exact: true }).click(); await tools.getByRole('tab', { name: 'Block', exact: true }).click(); await tools.getByRole('button', { name: 'Turn into…', exact: true }).click();
        await tools.getByRole('searchbox', { name: 'Search block types', exact: true }).fill('Heading 2'); await page.screenshot({ path: `${out}/${phase}-${mode}-block-search.png` }); await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => window.workflowProbe.editor().isActive('heading', { level: 2 })), true); await page.keyboard.press('Control+z'); assert.deepEqual(await bodyJSON(), beforeTools);
        // Start from a new document's visible, focused empty body for slash keys.
        await createDocument('Slash command proof');
        await page.keyboard.type('/heading'); await page.getByRole('listbox', { name: 'Block commands', exact: true }).waitFor(); await page.keyboard.press('ArrowDown'); await page.screenshot({ path: `${out}/${phase}-${mode}-slash-commands.png` }); await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => window.workflowProbe.editor().isActive('heading', { level: 2 })), true); await page.keyboard.insertText('Slash keyboard proof');
        // Remove the new block with native keyboard selection; undo remains the editor's.
        const slashPageId = await page.evaluate(() => window.workflowProbe.location().pageId);
        const slashBody = page.locator(`#page-${slashPageId}`).getByRole('textbox', { name: 'Document body', exact: true });
        await slashBody.getByText('Slash keyboard proof', { exact: true }).click({ button: 'right' });
        const context = page.getByLabel('Document block menu', { exact: true }); await context.getByRole('button', { name: 'Delete block', exact: true }).click(); await page.keyboard.press('Escape'); await settle();
        assert.equal((await slashBody.innerText()).trim(), '');
        await page.locator('aside.panvas-sidebar').getByText('Explicit document flow', { exact: true }).click(); await page.waitForFunction(() => window.workflowProbe.ready()); await settle(); assert.deepEqual(await bodyJSON(), beforeTools);
        evidence.blockSearchAndSlash = { searchedTransformation: true, keyboardSlash: true };
        const latePrompt = page.getByRole('button', { name: 'Continue locally', exact: true }); if (await latePrompt.count()) await latePrompt.click();
        await scrollDocument(); await page.screenshot({ path: `${out}/${phase}-${mode}-readable-code-table.png` });
        await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click();
        for (let index = 0; index < 20 && await page.evaluate(() => window.workflowProbe.engine().viewport.getState().scale) > .251; index++) { await page.getByRole('button', { name: 'Out', exact: true }).click(); await settle(2); }
        await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click(); await scrollDocument(); await page.screenshot({ path: `${out}/${phase}-${mode}-three-sheets.png` });
        await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click(); await page.getByRole('button', { name: '100%', exact: true }).click(); await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click();
        evidence.visibleControls = { crossSheetFormatting: selected, tableEdit: true, tableRowUndoExact: true, keyboardTabs: true, markdownCancelAndUndoExact: true };

        // Use the sidebar to switch this same logical document.
        await (await openNotebookProperties(page)).getByRole('combobox', { name: 'Page Size', exact: true }).selectOption('Infinite');
        await closeNotebookProperties(page);
        await page.waitForFunction(() => window.workflowProbe.snapshot().properties.pageSize === 'Infinite' && document.querySelectorAll('[data-infinite-document="true"] .panvas-page-gap').length === 0); await settle();
        assert.deepEqual(await bodyJSON(), beforeTools);
        evidence.switchInfinite = await page.evaluate(() => ({ pageId: window.workflowProbe.location().pageId, width: window.workflowProbe.editor().view.dom.offsetWidth, height: window.workflowProbe.editor().view.dom.offsetHeight }));
        assert.equal(evidence.switchInfinite.pageId, flowId); assert.equal(evidence.switchInfinite.width, 666); assert.ok(evidence.switchInfinite.height > 5000);
        await scrollDocument(2500); await page.screenshot({ path: `${out}/${phase}-${mode}-switched-infinite.png` });
        await (await openNotebookProperties(page)).getByRole('combobox', { name: 'Page Size', exact: true }).selectOption('A4');
        await closeNotebookProperties(page); await settle(); assert.deepEqual(await bodyJSON(), beforeTools);

        // Convert a real pasted, positioned object while leaving a second box and a shape intact.
        await createPage('Conversion proof');
        const conversionPageId = await page.evaluate(() => window.workflowProbe.location().pageId);
        await page.locator(`#page-${conversionPageId}`).scrollIntoViewIfNeeded(); await page.getByTitle('Text (T)', { exact: true }).click();
        const conversionCanvas = page.locator('[data-live-page-visual] canvas').first(), conversionBox = await conversionCanvas.boundingBox();
        await page.mouse.click(conversionBox.x + conversionBox.width * .08, Math.max(200, conversionBox.y + 150));
        await page.waitForFunction(() => window.workflowProbe.editor()?.isFocused); await paste(); await settle();
        const sourceId = await page.evaluate(() => window.workflowProbe.snapshot().texts[0].id);
        await conversionCanvas.scrollIntoViewIfNeeded(); await settle();
        const noteBox = await conversionCanvas.boundingBox();
        await page.mouse.click(noteBox.x + noteBox.width * .62, Math.max(200, noteBox.y + 150));
        await page.waitForFunction(() => window.workflowProbe.snapshot().texts.length === 2 && window.workflowProbe.engine().texts.getFocusedText()?.id !== window.workflowProbe.snapshot().texts[0].id);
        await page.keyboard.insertText('Keep this positioned note');
        await page.getByTitle('Select (V)', { exact: true }).click(); await page.keyboard.press('r');
        await page.mouse.move(noteBox.x + noteBox.width * .68, Math.max(400, noteBox.y + 440)); await page.mouse.down(); await page.mouse.move(noteBox.x + noteBox.width * .8, Math.max(460, noteBox.y + 500)); await page.mouse.up();
        await page.waitForFunction(() => window.workflowProbe.positioned().shapes.length === 1); await settle();
        await page.getByTitle('Text (T)', { exact: true }).click(); await page.locator(`[data-text-object-id="${sourceId}"] .ProseMirror h1`).click();
        const originalTexts = await page.evaluate(() => window.workflowProbe.snapshot().texts), positioned = await page.evaluate(() => window.workflowProbe.positioned()), sourceText = originalTexts.find(text => text.id === sourceId);
        evidence.focusBeforeConversion = await page.evaluate(() => ({ focused: window.workflowProbe.engine().texts.getFocusedText()?.id, active: window.workflowProbe.engine().texts.getActiveTextId(), mode: window.workflowProbe.engine().tools.getState().mode, selected: window.workflowProbe.engine().selection.getSelectedElements().map(object => ({ id: object.id, type: object.type })) }));
        const modes = await openNotebookProperties(page);
        await page.screenshot({ path: `${out}/${phase}-${mode}-conversion-action.png` }); await modes.getByRole('button', { name: 'Convert selected text to document', exact: true }).click();
        await page.waitForFunction(() => window.workflowProbe.editor()?.isFocused && document.querySelector('[data-document-body] [contenteditable="true"]'));
        await page.waitForFunction(() => Number(document.querySelector('[data-document-sheet-count]')?.dataset.documentSheetCount) >= 3); await settle();
        assert.deepEqual(await bodyJSON(), sourceText.content); assert.deepEqual(await page.evaluate(() => window.workflowProbe.positioned()), positioned);
        let converted = await page.evaluate(() => window.workflowProbe.snapshot()); assert.equal(converted.texts.filter(text => text.metadata?.documentRole === 'body').length, 1);
        assert.deepEqual(converted.texts.find(text => text.id === sourceId).metadata.documentConversionOriginal, sourceText); assert.deepEqual(converted.texts.filter(text => text.id !== sourceId), originalTexts.filter(text => text.id !== sourceId));
        await scrollDocument(); await page.screenshot({ path: `${out}/${phase}-${mode}-converted-document.png` });
        await page.keyboard.press('Control+z'); await page.waitForFunction(() => window.workflowProbe.snapshot().properties.layoutMode === 'freeform'); await settle();
        assert.deepEqual(await page.evaluate(() => window.workflowProbe.snapshot().texts), originalTexts); assert.deepEqual(await page.evaluate(() => window.workflowProbe.positioned()), positioned);
        await page.locator(`[data-text-object-id="${sourceId}"] .ProseMirror h1`).click(); await page.keyboard.press('Control+y');
        await page.waitForFunction(() => window.workflowProbe.snapshot().properties.layoutMode === 'document' && window.workflowProbe.editor()?.isFocused); await settle(); assert.deepEqual(await bodyJSON(), sourceText.content);
        await waitSaved(sourceText.content); await page.reload(); await page.waitForFunction(() => window.workflowProbe?.ready() && Boolean(window.workflowProbe.editor())); await settle();
        converted = await page.evaluate(() => window.workflowProbe.snapshot()); assert.deepEqual(await bodyJSON(), sourceText.content);
        assert.deepEqual(converted.texts.find(text => text.id === sourceId).metadata.documentConversionOriginal, sourceText); assert.deepEqual(converted.texts.filter(text => text.id !== sourceId), originalTexts.filter(text => text.id !== sourceId)); assert.deepEqual(JSON.parse(JSON.stringify(await page.evaluate(() => window.workflowProbe.positioned()))), JSON.parse(JSON.stringify(positioned)));
        evidence.conversion = { pageId: conversionPageId, sourceId, originalTexts, positioned, undoExact: true, redoExact: true, reopenExact: true, originalBackupExact: true, otherObjectsExact: true, sheets: Number(await page.locator('[data-document-sheet-count]').last().getAttribute('data-document-sheet-count')) };
        await chooseWritingLayout(page, 'Freeform'); await closeNotebookProperties(page); await settle();
        const positionedBody = (await page.evaluate(() => window.workflowProbe.snapshot().texts)).find(text => text.id === sourceId);
        for (const key of ['x', 'y', 'width']) assert.equal(positionedBody[key], sourceText[key]); assert.deepEqual(positionedBody.content, sourceText.content);
        await chooseWritingLayout(page, 'Document'); await closeNotebookProperties(page); await settle(); assert.deepEqual(await bodyJSON(), sourceText.content);
        evidence.conversion.switchRoundTripExact = true;
      }
      await createDocument('Infinite document', 'Infinite'); await workload('infinite-paste', paste); await settle();
      evidence.infinite = await page.evaluate(() => ({ snapshot: window.workflowProbe.snapshot(), editorWidth: window.workflowProbe.editor().view.dom.offsetWidth, height: window.workflowProbe.editor().view.dom.offsetHeight, pageBreaks: document.querySelectorAll('[data-infinite-document="true"] .panvas-page-gap').length, canvases: Array.from(document.querySelectorAll('canvas')).map(canvas => ({ width: canvas.width, height: canvas.height, pixels: canvas.width * canvas.height })) }));
      assert.equal(evidence.infinite.snapshot.properties.pageSize, 'Infinite'); assert.equal(evidence.infinite.editorWidth, 666); assert.ok(evidence.infinite.height > 5000); assert.equal(evidence.infinite.pageBreaks, 0); assert.ok(evidence.infinite.canvases.every(canvas => canvas.pixels <= 16_000_000));
      await page.keyboard.press('Control+End'); await page.keyboard.insertText('Infinite ending edit'); await settle(); await page.screenshot({ path: `${out}/${phase}-${mode}-infinite.png` });
      const infiniteJSON = await bodyJSON(); await waitSaved(infiniteJSON);
      evidence.infinite.beforeReload = await page.evaluate(async () => ({ snapshot: window.workflowProbe.snapshot(), editor: window.workflowProbe.editor().getJSON(), saved: await window.workflowProbe.saved(), writes: window.workflowProbe.writes() }));
      await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click();
      // Opening the drawer changes viewport width and triggers the existing
      // auto-fit. Playwright's click waits for a stable button; sample the base
      // zoom after that same layout boundary rather than during the transition.
      await page.getByRole('button', { name: 'In', exact: true }).hover(); await settle();
      const startingZoom = await page.evaluate(() => window.workflowProbe.engine().viewport.getState().scale);
      await page.getByRole('button', { name: 'In', exact: true }).click(); await settle();
      const firstZoom = await page.evaluate(() => window.workflowProbe.engine().viewport.getState().scale);
      await page.getByRole('button', { name: 'In', exact: true }).click(); await settle();
      const secondZoom = await page.evaluate(() => window.workflowProbe.engine().viewport.getState().scale);
      evidence.infinite.zoom = { startingZoom, firstZoom, secondZoom };
      assert.ok(Math.abs(firstZoom - startingZoom * 1.1) < .001); assert.ok(Math.abs(secondZoom - firstZoom * 1.1) < .001, 'Repeated zoom-in must increase the current zoom.');
      await page.getByRole('button', { name: '100%', exact: true }).click(); await page.getByRole('button', { name: 'Open page and view inspector', exact: true }).click(); await settle();
      await page.reload(); await page.waitForFunction(() => window.workflowProbe?.ready() && Boolean(window.workflowProbe.editor())); await settle(); assert.deepEqual(await bodyJSON(), infiniteJSON); evidence.infinite.reopenExact = true;
      await createDocument('Explicit Freeform alternative', 'A4', 'freeform'); const alternative = await page.evaluate(() => window.workflowProbe.snapshot()); assert.equal(alternative.properties.layoutMode, 'freeform'); assert.equal(alternative.texts.length, 0); evidence.freeformAlternative = alternative;
      if (phase.startsWith('verify')) {
        // The canvas footer uses the same chooser and inserts immediately after its current page.
        await page.locator('aside.panvas-sidebar').getByText('Workflow page', { exact: true }).click(); await page.waitForFunction(() => window.workflowProbe.ready()); await settle();
        const previousId = await page.evaluate(() => window.workflowProbe.location().pageId);
        await page.getByRole('button', { name: 'Insert page after current page', exact: true }).click();
        const insertDialog = page.getByRole('dialog', { name: 'New Page', exact: true });
        await insertDialog.getByRole('button', { name: 'Document', pressed: true }).waitFor();
        await insertDialog.locator('#create-dialog-input').fill('Inserted document proof');
        await insertDialog.getByRole('button', { name: 'Create', exact: true }).click();
        await insertDialog.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => window.workflowProbe.ready() && window.workflowProbe.snapshot().properties.layoutMode === 'document' && window.workflowProbe.editor()?.isFocused);
        const inserted = await page.evaluate(previousId => {
          const state = window.workflowProbe.snapshot(), pages = state.pages.filter(page => page.sectionId === state.pages.find(page => page.id === previousId).sectionId).sort((a,b) => a.order-b.order);
          return { mode: state.properties.layoutMode, paper: state.properties.pageSize, followsPrevious: pages[pages.findIndex(page => page.id === previousId)+1]?.id === state.location.pageId };
        }, previousId);
        assert.equal(inserted.paper, 'A4'); assert.equal(inserted.followsPrevious, true); evidence.insertAfter = inserted;
        // Reopen the persisted Freeform page after the flowing-document work.
        await page.locator('aside.panvas-sidebar').getByText('Workflow page', { exact: true }).click(); await page.waitForFunction(() => window.workflowProbe.ready()); await settle();
        await page.reload(); await page.waitForFunction(() => window.workflowProbe.ready() && window.workflowProbe.snapshot().texts.length > 0); await settle();
        const reopenedFreeform = await page.evaluate(() => window.workflowProbe.snapshot());
        assert.equal(reopenedFreeform.properties.layoutMode ?? 'freeform', 'freeform');
        assert.deepEqual(JSON.parse(JSON.stringify(reopenedFreeform.texts)), JSON.parse(JSON.stringify(legacy.texts))); evidence.freeformReopenExact = true;
        await page.screenshot({ path: `${out}/${phase}-${mode}-freeform-reopened.png` });
      }
    }
    console.log(JSON.stringify({ ordinary: { mode: evidence.ordinary.properties.layoutMode ?? 'freeform', width: evidence.ordinary.texts[0].width }, menu: evidence.menu, explicit: { width: evidence.explicitFlow.width, sheets: evidence.explicitFlow.sheets }, errors }));
    }
  }
  assert.deepEqual(errors, []);
} catch (error) { evidence.runFailure = { message: error.message, stack: error.stack }; throw error;
} finally { if (page && !page.isClosed()) { evidence.finalSnapshot = await page.evaluate(() => window.workflowProbe?.snapshot()); evidence.lifecycle = await page.evaluate(() => window.workflowProbe?.lifecycle()); await writeFile(`${out}/${phase}-${mode}-ui.txt`, await page.locator('body').innerText()); await page.screenshot({ path: `${out}/${phase}-${mode}-last.png` }); } await writeFile(`${out}/${phase}-${mode}.json`, JSON.stringify({ phase, mode, directory, beforeControls, beforeRendering, beforePolish, acceptanceOnly: process.argv.includes('--acceptance-only'), restoredPolishSources: [...restoredPolishSources], productionEntry, appShell, firstRun, dpr, reports, evidence, errors }, null, 2)); if (cdp) await cdp.detach(); if (app) await app.close(); if (browser) await browser.close(); await server.httpServer.close(); }
