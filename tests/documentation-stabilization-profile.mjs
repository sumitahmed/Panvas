import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium, _electron } from 'playwright';
import { build as viteBuild, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { build } from 'esbuild';

const require = createRequire(import.meta.url), electron = process.argv.includes('--electron');
const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) ?? 'baseline';
const sizes = (process.argv.find(arg => arg.startsWith('--sizes='))?.slice(8) ?? '120,1000,5000').split(',').map(Number);
const layouts = (process.argv.find(arg => arg.startsWith('--layouts='))?.slice(10) ?? 'freeform,A4,Infinite').split(',');
const mode = electron ? 'electron' : 'web', out = 'artifacts/documentation-stabilization';
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-stabilization-'));
await mkdir(out, { recursive: true });
await viteBuild({ configFile: false, mode: 'web', base: '/', plugins: [react()], worker: { format: 'es' }, logLevel: 'error',
  resolve: { alias: { '@': path.resolve('src'), 'react-dom/client': require.resolve('react-dom/profiling') } },
  build: { outDir: path.join(directory, 'dist'), emptyOutDir: false, minify: false, rollupOptions: { input: path.resolve('tests/fixtures/documentation-stabilization.html') } },
});
const server = await preview({ configFile: false, root: process.cwd(), build: { outDir: path.join(directory, 'dist') }, preview: { port: 0, open: false } });
const url = server.resolvedUrls.local[0] + 'tests/fixtures/documentation-stabilization.html';
let browser, app, page, cdp;
const reports = [], errors = [];
const frames = (count = 4) => page.evaluate(async count => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame); }, count);
const java = 'double myDouble = 9.78;\nint myInt = (int) myDouble; // Manual casting\n\nSystem.out.println(myDouble);\nSystem.out.println(myInt);';
const technical = count => '<h2>Technical comparison</h2><p><a href="https://example.com">Embedded explanation</a> with <strong>formatted</strong> prose and <code>inline code</code>.</p><h3>Code example</h3><p>java</p><pre><code class="language-java">' + java + '</code></pre><h3>Output</h3><pre data-language="plaintext"><code>9.78\n9</code></pre>'
  + '<h3>Comparison Summary</h3><table><tr>' + ['Feature', 'Implicit Type Casting (Widening)', 'Explicit Type Casting (Narrowing)', 'Precision', 'Conversion', 'Source type', 'Result type'].map(text => `<th colwidth="25"><p>${text}</p></th>`).join('') + '</tr>'
  + '<tr>' + ['Conversion behaviour', 'Automatic conversion to a larger container', 'Explicit conversion acknowledges precision loss', 'Fractional value retained where supported', 'Readable comparison of type conversion', 'Floating point with fractional data', 'Integer with fractional truncation'].map(text => `<td colwidth="25"><p>${text}</p></td>`).join('') + '</tr></table><ul><li>Separate source and output</li><li>Keep nested document structure</li></ul><p>\\(x^2 + y^2\\)</p>'
  + Array.from({ length: count }, (_, index) => `<p>Paragraph ${index}: A realistic technical response retains its reading order, formatted structure and editing history. Editing this ordinary paragraph must leave the remaining document intact.</p>`).join('');
const ensureOwner = async () => {
  if (!await page.evaluate(() => window.richFixture.ready() && window.stabilizationProfile.editor()?.view.dom.isConnected)) {
    await page.evaluate(() => { document.querySelector('.notebook-viewport').scrollTop = 0; return window.richFixture.returnToPage(); });
    await page.waitForFunction(() => window.richFixture.ready() && window.stabilizationProfile.editor()?.view.dom.isConnected);
  }
};
const editorSetup = async text => {
  await ensureOwner();
  await page.evaluate(text => {
    const editor = window.stabilizationProfile.editor(); let pos;
    editor.state.doc.descendants((node, at) => { if (pos === undefined && node.isText && node.text.includes(text)) pos = at + node.text.length; });
    if (pos === undefined) throw new Error('Text target missing: ' + text);
    editor.commands.setTextSelection(pos); editor.view.focus(); editor.commands.scrollIntoView();
  }, text); await frames();
};
const begin = async () => {
  await ensureOwner();
  await cdp.send('Profiler.start');
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  await page.evaluate(() => window.stabilizationProfile.begin()); return { metrics, started: performance.now() };
};
const end = async (name, started) => {
  await frames(4);
  const runtime = await page.evaluate(() => ({ ...window.stabilizationProfile.end(), originalPageOwnsEngine: window.richFixture.ready() }));
  const { profile } = await cdp.send('Profiler.stop');
  const current = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  const delta = Object.fromEntries(['LayoutCount', 'LayoutDuration', 'RecalcStyleCount', 'RecalcStyleDuration', 'ScriptDuration'].map(key => [key, current[key] - started.metrics[key]]));
  const file = `${phase}-${mode}-${name.replace(/[^a-z0-9]+/gi, '-')}.cpuprofile`;
  await writeFile(path.join(out, file), JSON.stringify(profile));
  const top = profile.nodes.filter(node => node.hitCount).sort((a, b) => b.hitCount - a.hitCount).slice(0, 14).map(node => ({ name: node.callFrame.functionName, url: node.callFrame.url.split('/').at(-1), hits: node.hitCount }));
  return { name, elapsedMs: performance.now() - started.started, ...runtime, browser: delta, heapBytes: current.JSHeapUsedSize, cpuFile: file, top };
};
const workload = async (name, run) => { const start = await begin(); await run(); const result = await end(name, start); console.log(JSON.stringify({ name, inputPaint: result.inputPaint, metrics: result.metrics, browser: result.browser })); return result; };
try {
  if (electron) {
    for (const [entry, file] of [['electron/ipc/domain-handlers.ts', 'domain.cjs'], ['electron/preload.ts', 'preload.cjs']]) await build({ entryPoints: [entry], outfile: path.join(directory, file), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    await writeFile(path.join(directory, 'bootstrap.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=require('node:path').join(__dirname,'workspaces');process.env.VITE_DEV_SERVER_URL=${JSON.stringify(server.resolvedUrls.local[0])};app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}}).loadURL(${JSON.stringify(url)});});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
    app = await _electron.launch({ args: [path.join(directory, 'bootstrap.cjs')], env }); page = await app.firstWindow();
  } else { browser = await chromium.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); await page.goto(url); }
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.richFixture?.ready()); await page.evaluate(() => document.fonts.ready);
  cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable'); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  const hardware = { cpu: cpus()[0].model, logicalCpus: cpus().length, ramBytes: totalmem(), windows: release(), runtime: electron ? await app.evaluate(() => process.versions) : { chromium: browser.version() } };
  if (process.argv.includes('--diagnostics-only')) {
    const content = await page.evaluate(() => {
      const value = window.richFixture.parseHtml('<h2>Comparison Summary</h2><table><tr><th>Feature</th><th>Implicit Type Casting (Widening)</th><th>Explicit Type Casting (Narrowing)</th></tr><tr><td>Conversion</td><td>Automatic conversion to a larger container</td><td>Explicit conversion acknowledges precision loss</td></tr></table>');
      value.content[1].content.forEach(row => row.content.forEach(cell => { cell.attrs.colspan = 'undefined'; }));
      return value;
    });
    await page.evaluate(content => {
      const target = document.getElementById('fixture-preview'); Object.assign(target.style, { left: '200px', top: '110px', width: '300px', zIndex: '9998', background: 'white' });
      window.richFixture.preview(content, 300);
    }, content); await frames();
    const staticTable = await page.evaluate(() => {
      const table = document.querySelector('#fixture-preview table');
      return { width: table.getBoundingClientRect().width, style: table.getAttribute('style'), columns: [...table.rows[0].cells].map(cell => cell.getBoundingClientRect().width) };
    });
    await page.screenshot({ path: `${out}/${phase}-${mode}-malformed-static-table.png` });
    if (phase !== 'baseline') {
      const region = page.locator('#fixture-preview .panvas-table-scroll'); await region.focus();
      await page.keyboard.press('ArrowRight'); await frames(6);
      assert.ok(await region.evaluate(root => root.scrollLeft > 0), 'The static table must be readable with keyboard horizontal scrolling.');
      await region.evaluate(root => { root.scrollLeft = root.scrollWidth; });
      await page.screenshot({ path: `${out}/${phase}-${mode}-table-horizontal-scroll.png` });
    }
    await page.evaluate(() => { document.getElementById('fixture-preview').style.left = '-2000px'; });
    await page.evaluate(content => window.stabilizationProfile.prepareFreeform(content, 300), content);
    await page.waitForFunction(() => window.stabilizationProfile.editor()?.view.dom.isConnected); await frames();
    const activeTable = await page.evaluate(() => window.stabilizationProfile.table());
    await page.screenshot({ path: `${out}/${phase}-${mode}-malformed-active-table.png` });
    const engine = await page.evaluate(() => {
      const engine = window.richFixture.engine(); engine.shapes.addShape({ id: 'profile-existing-shape', type: 'shape', shapeType: 'rectangle', x: 25, y: 80, width: 32, height: 40, color: '#2563eb', fill: '#2563eb', strokeWidth: 2, rotation: 0, createdAt: 1 }); engine.input.notifyChange();
      return window.flowFixture.location();
    });
    await page.getByTitle('Select (V)', { exact: true }).click();
    await page.evaluate(() => { document.querySelector('.notebook-viewport').scrollTop = 0; }); await frames();
    const point = await page.evaluate(() => { const engine = window.richFixture.engine(), canvas = engine.drawing.getCanvasElement(), rect = canvas.getBoundingClientRect(), point = engine.viewport.pageToCanvas(41, 100), scale = rect.width / canvas.clientWidth; return { x: rect.left + point.x * scale, y: rect.top + point.y * scale }; });
    const movement = await workload('existing-object-movement', async () => { await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 35, point.y + 20, { steps: 12 }); await page.mouse.up(); });
    const shape = await page.evaluate(() => { const shape = window.richFixture.engine().shapes.getShapes().find(shape => shape.id === 'profile-existing-shape'); return { x: shape.x, y: shape.y }; });
    const responsive = [];
    if (phase !== 'baseline') {
      const content = { type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'Java', wrap: true }, content: [{ type: 'text', text: java }] }] };
      await page.evaluate(content => window.stabilizationProfile.prepareFreeform(content, 200), content);
      await page.getByTitle('Text (T)', { exact: true }).click();
      await page.waitForFunction(() => window.stabilizationProfile.editor()?.view.dom.isConnected); await frames();
      const initial = await page.evaluate(() => { const text = window.richFixture.engine().texts.getTexts()[0]; return { rawLanguage: text.content.content[0].attrs.language, version: text.metadata?.richTextSchemaVersion }; });
      assert.equal(initial.rawLanguage, 'Java', 'Opening must preserve source JSON.');
      assert.ok(await page.locator('.ProseMirror .hljs-type').count(), 'Java primitive types must receive the installed grammar token classes.');
      const widget = page.locator('.ProseMirror .panvas-code-block').first();
      const bounds = await widget.evaluate(root => { const width = root.getBoundingClientRect(); return [...root.querySelectorAll('summary,button')].map(button => ({ left: button.getBoundingClientRect().left - width.left, right: button.getBoundingClientRect().right - width.left, width: width.width })); });
      assert.ok(bounds.every(rect => rect.left >= -1 && rect.right <= rect.width + 1));
      await widget.getByRole('button', { name: 'Caption', exact: true }).click(); await widget.getByRole('textbox', { name: 'Code caption' }).fill('Freeform caption'); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => window.richFixture.engine().texts.getTexts()[0].metadata.richTextSchemaVersion), 3);
      await page.screenshot({ path: `${out}/${phase}-${mode}-narrow-code.png` });
      for (const width of [800, 1440]) {
        if (electron) await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 1100), width);
        else await page.setViewportSize({ width, height: 1100 });
        await page.waitForFunction(width => innerWidth === width, width);
        for (const zoom of [.75, 1.5]) {
          await page.evaluate(zoom => window.richFixture.engine().viewport.setZoom(zoom), zoom); await frames();
          await widget.evaluate(root => root.scrollIntoView({ block: 'center', inline: 'center' })); await frames();
          const bounds = await widget.evaluate(root => { const rect = root.getBoundingClientRect(); return [...root.querySelectorAll('summary,button')].map(button => ({ left: button.getBoundingClientRect().left - rect.left, right: button.getBoundingClientRect().right - rect.left, width: rect.width })); });
          assert.ok(bounds.every(rect => rect.left >= -1 && rect.right <= rect.width + 1));
          await widget.locator('summary').click(); const menu = page.getByRole('searchbox', { name: 'Search code languages' }); await menu.waitFor(); await frames();
          const popup = await menu.evaluate(input => { const rect = input.parentElement.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight }; });
          assert.ok(popup.left >= -1 && popup.right <= popup.viewportWidth + 1 && popup.top >= -1 && popup.bottom <= popup.viewportHeight + 1);
          await page.screenshot({ path: `${out}/${phase}-${mode}-code-menu-${width}-${zoom}.png` });
          responsive.push({ width, zoom, bounds, popup }); await page.keyboard.press('Escape');
        }
      }
    }
    await writeFile(`${out}/${phase}-${mode}-diagnostics.json`, JSON.stringify({ hardware, staticTable, activeTable, movement, shape, engine, responsive, errors }, null, 2));
    if (phase !== 'baseline') { assert.ok(staticTable.columns.every(width => width >= 110)); assert.ok(activeTable[0].columns.every(cell => cell.width >= 110)); assert.ok(shape.x > 25); assert.deepEqual(errors, []); }
    console.log(JSON.stringify({ staticTable, activeTable, shape, errors }));
  } else {
  for (const layout of layouts) for (const count of layout === 'freeform' ? [sizes[0]] : sizes) {
    if (layout === 'A4' && count > 1000) continue;
    if (layout === 'freeform') {
      const parsed = await page.evaluate(html => window.richFixture.parseHtml(html), technical(count));
      await page.evaluate(content => window.stabilizationProfile.prepareFreeform(content), parsed);
      await page.waitForFunction(() => window.richFixture.editor()?.view.dom.isConnected);
    } else {
      await page.evaluate(() => window.richFixture.reset([])); await frames();
      await page.getByTitle('Toggle Page Properties', { exact: true }).click();
      await page.getByRole('combobox', { name: 'Writing layout', exact: true }).selectOption('document');
      await page.getByRole('combobox', { name: 'Page Size', exact: true }).selectOption(layout);
      await page.getByTitle('Toggle Page Properties', { exact: true }).click();
      await page.waitForFunction(() => window.flowFixture.editor()?.isEditable);
    }
    const prefix = `${layout}-${count}`, results = [];
    const html = technical(count);
    results.push(await workload(prefix + '-paste', async () => {
      await page.evaluate(html => {
        const editor = window.stabilizationProfile.editor(); editor.view.focus(); editor.commands.selectAll();
        const data = new DataTransfer(); data.setData('text/html', html); data.setData('text/plain', 'Technical comparison');
        editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      }, html);
    }));
    await editorSetup('Technical comparison');
    results.push(await workload(prefix + '-idle', () => frames(30)));
    await editorSetup('Paragraph 0:');
    results.push(await workload(prefix + '-typing', async () => { for (let index = 0; index < 12; index++) { await page.keyboard.insertText('x'); await frames(2); } }));
    await editorSetup('myDouble);');
    results.push(await workload(prefix + '-code-edit', async () => { for (let index = 0; index < 8; index++) { await page.keyboard.insertText(' '); await frames(2); } }));
    const block = page.locator('.ProseMirror[contenteditable="true"] .panvas-code-block').first();
    results.push(await workload(prefix + '-language-open', async () => { for (let index = 0; index < 3; index++) { await block.locator('summary').click(); await page.getByRole('searchbox', { name: 'Search code languages' }).waitFor(); await frames(8); await page.keyboard.press('Escape'); } }));
    results.push(await workload(prefix + '-language-change', async () => { for (const language of ['SQL', 'C++', 'Java']) { await block.locator('summary').click(); await page.getByRole('searchbox', { name: 'Search code languages' }).fill(language); await page.getByRole('option', { name: language, exact: true }).click(); await frames(3); } }));
    await editorSetup('Conversion behaviour');
    const tables = await page.evaluate(() => window.stabilizationProfile.table());
    await page.screenshot({ path: `${out}/${phase}-${mode}-${prefix}-table.png` });
    results.push(await workload(prefix + '-table-edit', async () => { for (let index = 0; index < 6; index++) { await page.keyboard.insertText(' '); await frames(2); } }));
    const scroll = [];
    results.push(await workload(prefix + '-scroll', async () => {
      await page.evaluate(() => window.richFixture.engine().tools.setMode('hand'));
      scroll.push(...await page.evaluate(async () => {
        const element = document.querySelector('.notebook-viewport'), intervals = []; let previous = performance.now();
        for (let index = 0; index < 60; index++) { element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, index * 160); await new Promise(requestAnimationFrame); const now = performance.now(); intervals.push(now - previous); previous = now; } return intervals;
      }));
    }));
    results.push(await workload(prefix + '-tools', async () => { for (const title of ['Select (V)', 'Hand (Space)', 'Text (T)']) await page.getByTitle(title, { exact: true }).click(); }));
    await editorSetup('Technical comparison');
    await page.screenshot({ path: `${out}/${phase}-${mode}-${prefix}-code.png` });
    const before = await page.evaluate(() => JSON.stringify(window.stabilizationProfile.editor().getJSON()));
    results.push(await workload(prefix + '-save-reopen', async () => {
      await page.evaluate(() => window.richFixture.reload());
      await page.waitForFunction(() => !window.richFixture.ready());
      await page.evaluate(() => window.richFixture.returnToPage());
      await page.waitForFunction(() => window.richFixture.ready() && window.stabilizationProfile.editor()?.view.dom.isConnected);
    }));
    const after = await page.evaluate(() => JSON.stringify(window.stabilizationProfile.editor().getJSON()));
    assert.equal(after, before, 'Save/reopen must preserve canonical content.');
    reports.push({ layout, paragraphs: count, htmlBytes: Buffer.byteLength(html), results, tables, scroll, savedExactly: true });
    await writeFile(`${out}/${phase}-${mode}.json`, JSON.stringify({ hardware, profilingBuild: true, phase, reports, errors }, null, 2));
  }
  }
  assert.deepEqual(errors, []); console.log(`${mode}: ${reports.length} document profiles complete.`);
} finally { await browser?.close(); await app?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
