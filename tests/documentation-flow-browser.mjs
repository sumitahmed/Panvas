import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, _electron } from 'playwright';
import { createServer } from 'vite';
import { build } from 'esbuild';

const electronMode = process.argv.includes('--electron');
const performanceMode = process.argv.includes('--performance');
const filter = process.argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length);
const out = 'artifacts/documentation-flow';
await mkdir(out, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-flow-'));
const server = await createServer({ mode: 'web', cacheDir: path.join(directory, 'cache'), optimizeDeps: { entries: ['tests/fixtures/documentation-flow.html'] }, server: { port: 0, open: false } });
const errors = [], results = [], metrics = {};
let browser, app, page;
const mode = electronMode ? 'electron' : 'web';
const html = '<h1>Technical documentation</h1><p>Nested structures, Java and LaTeX.</p><ul><li><p>Outer item</p><ul><li><p>Inner item</p></li></ul></li></ul><table><tbody><tr><th>Operation</th><th>Result</th></tr><tr><td>Insert</td><td>Reflow</td></tr></tbody></table><pre><code class="language-java">public class Demo {\n  public static void main(String[] args) {\n    System.out.println("Hello");\n  }\n}</code></pre><div data-type="block-math" data-latex="E=mc^2"></div>' + Array.from({ length: 45 }, (_, i) => `<p>Paragraph ${i + 1}. ${'A technical explanation preserves every paragraph while text flows through the writing areas. '.repeat(6)}</p>`).join('');
const frames = () => page.evaluate(async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); });
const editorJson = () => page.evaluate(() => window.flowFixture.editor().getJSON());
const group = async (name, fn) => { if (filter && !filter.split('|').some(term => name.includes(term)) && !name.startsWith('Document flow is entered') && !name.startsWith('Formatted paste uses')) return; try { await fn(); results.push({ name, passed: true }); console.log('PASS:', name); } catch (error) { results.push({ name, passed: false, error: error.stack }); console.log('FAIL:', name, error.message); } };
try {
  await server.listen();
  if (electronMode) {
    for (const [entry, file] of [['electron/ipc/domain-handlers.ts', 'domain.cjs'], ['electron/preload.ts', 'preload.cjs']]) await build({ entryPoints: [entry], outfile: path.join(directory, file), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    await writeFile(path.join(directory, 'bootstrap.cjs'), `const {app,BrowserWindow}=require('electron'); app.setPath('userData',require('node:path').join(__dirname,'profile')); process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=require('node:path').join(__dirname,'workspaces');process.env.VITE_DEV_SERVER_URL=${JSON.stringify(server.resolvedUrls.local[0])};app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();new BrowserWindow({show:false,width:1440,height:1200,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}}).loadURL(${JSON.stringify(server.resolvedUrls.local[0] + 'tests/fixtures/documentation-flow.html')});});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
    app = await _electron.launch({ args: [path.join(directory, 'bootstrap.cjs')], env }); page = await app.firstWindow();
  } else { browser = await chromium.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 1200 } }); }
  page.on('pageerror', error => errors.push(error.message));
  metrics.runtime = electronMode ? await app.evaluate(({ app }) => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node })) : { chromium: browser.version(), node: process.versions.node };
  if (!electronMode) await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/documentation-flow.html');
  await page.waitForFunction(() => window.richFixture?.ready());
  await group('Document flow is entered through page properties without converting existing boxes', async () => {
    await page.getByTitle('Toggle Page Properties', { exact: true }).click();
    await page.getByRole('group', { name: 'Writing layout', exact: true }).getByRole('button', { name: 'Document', exact: true }).click();
    await page.waitForFunction(() => window.flowFixture.editor()?.view.dom.isConnected);
    assert.equal(await page.evaluate(() => window.richFixture.engine().texts.getTexts().filter(text => text.metadata?.documentRole === 'body').length), 1);
    await page.getByTitle('Toggle Page Properties', { exact: true }).click();
  });
  await group('Formatted paste uses the page writing width and automatic A4 sheets', async () => {
    await page.getByRole('textbox', { name: 'Document body', exact: true }).waitFor();
    await page.evaluate(html => {
      const editor = window.flowFixture.editor(); editor.commands.focus('start');
      const clipboardData = new DataTransfer(); clipboardData.setData('text/html', html); clipboardData.setData('text/plain', 'Technical documentation');
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, html);
    await page.waitForFunction(() => Number(document.querySelector('[data-document-sheet-count]')?.dataset.documentSheetCount) > 2);
    await frames();
    const details = await page.evaluate(() => {
      const editor = window.flowFixture.editor(), body = document.querySelector('[data-document-body]');
      return { width: body.offsetWidth, extent: window.richFixture.engine().getProperties().layoutExtent, sheets: Number(document.querySelector('[data-document-sheet-count]').dataset.documentSheetCount), text: editor.getText(), issues: editor.view.dom.dataset.layoutIssues, layoutMs: editor.view.dom.dataset.layoutMs, canvasHeights: [...document.querySelectorAll('canvas')].map(canvas => canvas.height) };
    });
    assert.equal(details.width, 666); assert.ok(details.text.includes('Paragraph 45.')); assert.equal(details.issues, '0');
    for (let i = 1; i <= 45; i++) assert.equal(details.text.split(`Paragraph ${i}.`).length - 1, 1, `Paragraph ${i} must be present exactly once`);
    await writeFile(out + '/' + mode + '-a4-metrics.json', JSON.stringify(details, null, 2));
    await page.evaluate(() => window.flowFixture.editor().commands.setTextSelection(1));
    await page.getByTitle('Hand (Space)', { exact: true }).click();
    await page.evaluate(() => { window.richFixture.engine().viewport.setZoom(.8); document.querySelector('.notebook-viewport').scrollTop = 0; });
    await frames(); await page.screenshot({ path: out + '/' + mode + '-a4.png' });
    await page.getByTitle('Text (T)', { exact: true }).click();
  });
  await group('Rendered paragraph and code lines stay inside writing areas at every sheet seam', async () => {
    const violations = await page.evaluate(() => {
      const root = window.flowFixture.editor().view.dom, origin = document.querySelector('[data-document-body]').getBoundingClientRect();
      const scale = origin.width / 666, walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), violations = [];
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (!text.textContent.trim() || text.parentElement.closest('.panvas-code-controls,.panvas-page-gap')) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        for (const rect of range.getClientRects()) {
          const y = (rect.top - origin.top) / scale + 64, bottom = y + rect.height / scale;
          const sheet = Math.floor(y / 1155), local = y - sheet * 1155;
          if (local < 63 || bottom - sheet * 1155 > 1060) violations.push({ text: text.textContent.slice(0, 45), y, bottom, local });
        }
      }
      return violations;
    });
    await writeFile(out + '/' + mode + '-seam-check.json', JSON.stringify(violations, null, 2));
    assert.equal(violations.length, 0, JSON.stringify(violations.slice(0, 4)));
  });
  await group('Native typing owns focus and undo/redo use the one editor history', async () => {
    await page.getByRole('textbox', { name: 'Document body', exact: true }).click({ position: { x: 100, y: 10 } });
    await page.keyboard.press('Control+Home');
    const before = await editorJson();
    await page.keyboard.insertText('Native input ');
    assert.ok(JSON.stringify(await editorJson()).includes('Native input'));
    await page.keyboard.press('Control+z'); assert.deepEqual(await editorJson(), before);
    await page.keyboard.press('Control+Shift+z'); assert.ok(JSON.stringify(await editorJson()).includes('Native input'));
    await page.keyboard.press('Control+z');
  });
  await group('Earlier edits add sheets and undo pulls the same content backward', async () => {
    const before = await editorJson();
    const count = await page.locator('[data-document-sheet-count]').first().getAttribute('data-document-sheet-count');
    await page.evaluate(() => {
      const editor = window.flowFixture.editor(); editor.commands.focus('start');
      const data = new DataTransfer(); data.setData('text/html', '<p>' + 'Earlier inserted content. '.repeat(400) + '</p>');
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(count => Number(document.querySelector('[data-document-sheet-count]').dataset.documentSheetCount) > Number(count), count);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(count => document.querySelector('[data-document-sheet-count]').dataset.documentSheetCount === count, count);
    assert.deepEqual(await editorJson(), before);
  });
  await group('A3 A5 and Letter use their selected writing widths and sheet dimensions', async () => {
    const before = await editorJson();
    for (const [size, width, height] of [['A3', 1123, 1587], ['A5', 595, 842], ['Letter', 816, 1056], ['A4', 794, 1123]]) {
      await page.getByTitle('Toggle Page Properties', { exact: true }).click();
      await page.getByRole('combobox', { name: 'Page Size', exact: true }).selectOption(size);
      await page.getByTitle('Toggle Page Properties', { exact: true }).click();
      await page.waitForFunction(width => document.querySelector('[data-document-body]').offsetWidth === width - 128, width);
      await frames();
      assert.equal(await page.locator('[data-document-sheet]').first().evaluate(element => element.offsetHeight), height);
      assert.deepEqual(await editorJson(), before);
    }
  });
  await group('Automatic sheets reclaim safely while annotated surplus sheets remain', async () => {
    const before = await editorJson();
    const extent = await page.evaluate(() => window.richFixture.engine().getProperties().layoutExtent);
    await page.evaluate(extent => {
      const engine = window.richFixture.engine();
      engine.shapes.addShape({ id: 'retained-annotation', type: 'shape', shapeType: 'rectangle', x: 100, y: extent - 180, width: 80, height: 60, color: '#2563eb', strokeWidth: 2, fill: null, rotation: 0, createdAt: Date.now() });
      engine.input.notifyChange();
      engine.tools.setMode('text'); engine.texts.getEditor(window.flowFixture.body().id).commands.focus('start');
    }, extent);
    await frames(); await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace');
    await frames();
    assert.equal(await page.evaluate(() => window.richFixture.engine().getProperties().layoutExtent), extent);
    assert.equal(await page.evaluate(() => window.richFixture.engine().shapes.getShapes().find(shape => shape.id === 'retained-annotation').y), extent - 180);
    await page.evaluate(() => { const engine = window.richFixture.engine(); engine.shapes.removeShape('retained-annotation'); engine.input.notifyChange(); });
    await frames();
    metrics.retention = await page.evaluate(() => ({ extent: window.richFixture.engine().getProperties().layoutExtent, body: { height: window.flowFixture.body().height, metadata: window.flowFixture.body().metadata }, domHeight: window.flowFixture.editor().view.dom.offsetHeight, nodes: window.flowFixture.editor().getJSON().content.map(node => node.type), objects: window.richFixture.engine().getDrawingData().objects.map(object => ({ id: object.id, type: object.type, y: object.y, height: object.height })), sheets: [...document.querySelectorAll('[data-document-sheet-count]')].map(element => element.dataset.documentSheetCount) }));
    await page.waitForFunction(() => document.querySelector('[data-document-sheet-count]').dataset.documentSheetCount === '1');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => Number(document.querySelector('[data-document-sheet-count]').dataset.documentSheetCount) > 1);
    assert.deepEqual(await editorJson(), before);
  });
  await group('Research Space offsets change paper seams while preserving the body JSON and writing width', async () => {
    const original = await page.evaluate(() => window.richFixture.engine().getProperties()), before = await editorJson();
    try {
      await page.evaluate(() => window.richFixture.engine().setProperties({ extraTop: 96, extraBottom: 192, extraLeft: 32 }));
      await frames();
      const result = await page.evaluate(() => {
        const editor = window.flowFixture.editor(), body = document.querySelector('[data-document-body]'), origin = body.getBoundingClientRect();
        const scale = origin.width / body.offsetWidth, walker = document.createTreeWalker(editor.view.dom, NodeFilter.SHOW_TEXT), violations = [];
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent.trim() || walker.currentNode.parentElement.closest('.panvas-code-controls,.panvas-page-gap')) continue;
          const range = document.createRange(); range.selectNodeContents(walker.currentNode);
          for (const rect of range.getClientRects()) {
            const y = (rect.top - origin.top) / scale + 160, bottom = y + rect.height / scale, sheet = Math.floor(y / 1443);
            if (y - sheet * 1443 < 159 || bottom - sheet * 1443 > 1156) violations.push({ y, bottom });
          }
        }
        return { violations, width: body.offsetWidth, left: body.offsetLeft, sheetHeight: document.querySelector('[data-document-sheet]').offsetHeight };
      });
      assert.equal(result.width, 666); assert.equal(result.left, 96); assert.equal(result.sheetHeight, 1411);
      assert.equal(result.violations.length, 0, JSON.stringify(result.violations.slice(0, 4)));
      assert.deepEqual(await editorJson(), before);
    } finally {
      await page.evaluate(properties => window.richFixture.engine().setProperties({ ...properties, extraTop: properties.extraTop ?? 0, extraBottom: properties.extraBottom ?? properties.extraHeight ?? 0, extraLeft: properties.extraLeft ?? 0, extraRight: properties.extraRight ?? 0 }), original);
      await frames();
    }
  });
  await group('Long Java code and tall merged table cells retain content across page seams', async () => {
    const original = await editorJson();
    try {
      await page.evaluate(() => {
        const editor = window.flowFixture.editor(); editor.commands.focus('start'); editor.commands.selectAll();
        const data = new DataTransfer();
        data.setData('text/html', '<h2>Boundary participants</h2><pre><code class="language-java">' + Array.from({ length: 120 }, (_, index) => `int value${index} = ${index};`).join('\n') + '</code></pre><table><tbody><tr><th>A</th><th>B</th></tr><tr><td rowspan="2"><p>' + 'Long merged cell content remains present. '.repeat(170) + '</p></td><td><p>Upper companion</p></td></tr><tr><td><p>Lower companion</p></td></tr></tbody></table><p>End marker</p>');
        editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await frames();
      const result = await page.evaluate(() => {
        const editor = window.flowFixture.editor(), body = document.querySelector('[data-document-body]'), origin = body.getBoundingClientRect(), scale = origin.width / body.offsetWidth;
        const walker = document.createTreeWalker(editor.view.dom, NodeFilter.SHOW_TEXT), violations = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim() || node.parentElement.closest('.panvas-page-gap,.panvas-code-controls')) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            const y = (rect.top - origin.top) / scale + 64, bottom = y + rect.height / scale, sheet = Math.floor(y / 1155);
            if (y - sheet * 1155 < 63 || bottom - sheet * 1155 > 1060) violations.push({ text: node.textContent.slice(0, 30), y, bottom });
          }
        }
        return { violations, json: editor.getJSON(), rows: editor.view.dom.querySelector('table').rows.length, tracks: editor.view.dom.querySelector('tbody').style.gridTemplateRows, layoutMs: editor.view.dom.dataset.layoutMs };
      });
      metrics.boundaryParticipants = { violations: result.violations.slice(0, 20), count: result.violations.length, rows: result.rows, tracks: result.tracks, layoutMs: result.layoutMs };
      assert.ok(JSON.stringify(result.json).includes('value119')); assert.ok(JSON.stringify(result.json).includes('End marker'));
      await page.getByTitle('Hand (Space)', { exact: true }).click();
      await page.evaluate(() => {
        const body = document.querySelector('[data-document-body]'), table = body.querySelector('table'), scroller = document.querySelector('.notebook-viewport');
        scroller.scrollTop += table.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 180;
      });
      await frames(); await page.screenshot({ path: out + '/' + mode + '-boundary-blocks.png' });
      await page.getByTitle('Text (T)', { exact: true }).click();
      assert.equal(result.violations.length, 0, JSON.stringify(result.violations.slice(0, 4)));
    } finally { await page.evaluate(content => window.flowFixture.editor().commands.setContent(content), original); await frames(); }
  });
  await group('Unwrapped code edits retain page spacers and newline edits still repaginate safely', async () => {
    const original = await editorJson();
    try {
      await page.evaluate(() => {
        const editor = window.flowFixture.editor(); editor.commands.focus('start'); editor.commands.selectAll();
        const data = new DataTransfer(); data.setData('text/html', '<pre><code class="language-java">' + Array.from({ length: 140 }, (_, i) => `    int value${i} = ${i}; // stable source`).join('\n') + '\n</code></pre><p>End marker</p>');
        editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }); await frames();
      await page.evaluate(() => {
        const editor = window.flowFixture.editor(); let codePos;
        editor.state.doc.descendants((node, pos) => { if (node.type.name === 'codeBlock') { codePos = pos; return false; } });
        editor.commands.setTextSelection(codePos + 12); editor.view.focus();
        window.flowFixture.spacers = window.flowFixture.gapPositions();
        window.flowFixture.codeEdits = [];
        window.flowFixture.traceCodeEdit = ({ transaction }) => window.flowFixture.codeEdits.push({ steps: transaction.steps.map(step => step.toJSON()), meta: Object.keys(transaction.meta) });
        editor.on('transaction', window.flowFixture.traceCodeEdit);
      });
      assert.ok(await page.evaluate(() => window.flowFixture.spacers.length > 1));
      for (const char of ' changed') { await page.keyboard.type(char); await frames(); }
      const retained = await page.evaluate(() => ({ previous: window.flowFixture.spacers, current: window.flowFixture.gapPositions(), paginationTransactions: window.flowFixture.codeEdits.filter(transaction => transaction.meta.some(key => key.includes('panvasDocumentPagination'))).length }));
      metrics.stableCodeEdits = retained;
      assert.equal(retained.paginationTransactions, 0);
      assert.deepEqual(retained.current, retained.previous.map(pos => pos + ' changed'.length));
      const typed = await editorJson();
      await page.keyboard.press('Enter'); await frames();
      assert.notDeepEqual(await editorJson(), typed);
      const seamViolations = () => page.evaluate(() => {
        const editor = window.flowFixture.editor(), root = editor.view.dom, origin = root.getBoundingClientRect(), scale = origin.width / root.offsetWidth;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), failures = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim() || node.parentElement.closest('.panvas-page-gap,.panvas-code-controls')) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            const y = (rect.top - origin.top) / scale + 64, bottom = y + rect.height / scale, sheet = Math.floor(y / 1155);
            if (y - sheet * 1155 < 63 || bottom - sheet * 1155 > 1060) failures.push({ y, bottom, text: node.textContent });
          }
        }
        return failures;
      });
      assert.deepEqual(await seamViolations(), []);
      await page.keyboard.press('Backspace'); await frames(); assert.deepEqual(await editorJson(), typed);
      // Preserve exact Windows CRLF and raw CR source. In an HTML DOM a raw
      // CR renders as a space; CRLF has an LF and changes the visual line count.
      for (const separator of ['\r', '\r\n']) {
        const { head, transactionCount } = await page.evaluate(separator => { const editor = window.flowFixture.editor(), head = editor.state.selection.head, transactionCount = window.flowFixture.codeEdits.length; editor.view.dispatch(editor.state.tr.insertText(separator)); return { head, transactionCount }; }, separator);
        await frames(); assert.deepEqual(await seamViolations(), []);
        const repaginated = await page.evaluate(start => window.flowFixture.codeEdits.slice(start).some(transaction => transaction.meta.some(key => key.includes('panvasDocumentPagination'))), transactionCount);
        assert.equal(repaginated, separator.includes('\n'));
        const sourceBefore = typed.content[0].content.map(node => node.text ?? '').join('');
        assert.equal(await page.evaluate(() => window.flowFixture.editor().view.dom.querySelector('pre code').textContent), sourceBefore.slice(0, head - 1) + separator + sourceBefore.slice(head - 1));
        await page.evaluate(({ head, size }) => { const editor = window.flowFixture.editor(); editor.view.dispatch(editor.state.tr.delete(head, head + size)); }, { head, size: separator.length });
        await frames(); assert.deepEqual(await editorJson(), typed);
      }
    } finally { await page.evaluate(content => { const editor = window.flowFixture.editor(); editor.off('transaction', window.flowFixture.traceCodeEdit); editor.commands.setContent(content); }, original); await frames(); }
  });
  await group('Deliberate page breaks remain canonical and undoable', async () => {
    const before = await editorJson();
    await page.evaluate(() => window.flowFixture.editor().chain().focus('start').insertDocumentPageBreak().run());
    await frames();
    assert.ok((await editorJson()).content.some(node => node.type === 'documentPageBreak'));
    assert.ok(await page.locator('.panvas-page-gap').count());
    await page.keyboard.press('Control+z'); assert.deepEqual(await editorJson(), before);
  });
  await group('Native caret and backward selection cross a derived sheet boundary without changing JSON', async () => {
    const before = await editorJson();
    await page.waitForFunction(() => {
      const editor = window.flowFixture.editor();
      return window.flowFixture.gapPositions().some(pos => pos > 1 && pos < editor.state.doc.content.size && editor.state.doc.resolve(pos).parent.isTextblock
        && editor.view.coordsAtPos(pos + 1).top - editor.view.coordsAtPos(pos - 1).top > 20);
    });
    const boundary = await page.evaluate(() => {
      const editor = window.flowFixture.editor();
      const pos = window.flowFixture.gapPositions()
        .find(pos => pos > 1 && pos < editor.state.doc.content.size && editor.state.doc.resolve(pos).parent.isTextblock
          && editor.view.coordsAtPos(pos + 1).top - editor.view.coordsAtPos(pos - 1).top > 20);
      if (pos === undefined) throw new Error('No inline text seam available for native caret crossing.');
      editor.commands.focus(pos - 1);
      return pos;
    });
    await page.waitForFunction(() => window.flowFixture.editor().isFocused);
    await frames();
    const initial = await page.evaluate(() => { const editor = window.flowFixture.editor(); return { head: editor.state.selection.head, top: editor.view.coordsAtPos(editor.state.selection.head).top - editor.view.dom.getBoundingClientRect().top }; });
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    const after = await page.evaluate(() => { const editor = window.flowFixture.editor(); return { head: editor.state.selection.head, top: editor.view.coordsAtPos(editor.state.selection.head).top - editor.view.dom.getBoundingClientRect().top, focused: editor.isFocused, native: window.getSelection()?.anchorNode?.textContent?.slice(0, 40) }; });
    metrics.selectionCrossing = { boundary, initial, after };
    assert.ok(after.head >= boundary, JSON.stringify(metrics.selectionCrossing)); assert.ok(after.top > initial.top + 20, JSON.stringify(metrics.selectionCrossing));
    await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft');
    const selection = await page.evaluate(() => { const selection = window.flowFixture.editor().state.selection; return { from: selection.from, to: selection.to, anchor: selection.anchor, head: selection.head }; });
    assert.ok(selection.head < selection.anchor); assert.ok(selection.from < boundary && selection.to >= boundary);
    await page.evaluate(pos => window.flowFixture.editor().commands.setTextSelection(pos - 1), boundary);
    await page.keyboard.press('ArrowDown');
    assert.ok(await page.evaluate(pos => window.flowFixture.editor().state.selection.head >= pos, boundary));
    metrics.selectionCrossing.down = await page.evaluate(pos => {
      const editor = window.flowFixture.editor(), selection = editor.state.selection;
      return { head: selection.head, anchor: selection.anchor, parent: selection.$head.parent.type.name, offset: selection.$head.parentOffset,
        sameParent: selection.$head.parent === editor.state.doc.resolve(pos).parent,
        headAncestors: Array.from({ length: selection.$head.depth + 1 }, (_, depth) => selection.$head.node(depth).type.name),
        before: editor.view.coordsAtPos(pos - 1), after: editor.view.coordsAtPos(pos + 1), focused: editor.isFocused, active: document.activeElement === editor.view.dom,
        beforeParent: editor.state.doc.resolve(pos - 1).parent.type.name, gapParent: editor.state.doc.resolve(pos).parent.type.name,
        afterParent: editor.state.doc.resolve(pos + 1).parent.type.name, top: editor.view.coordsAtPos(selection.head).top };
    }, boundary);
    await page.keyboard.press('Shift+ArrowUp');
    metrics.selectionCrossing.up = await page.evaluate(() => { const editor = window.flowFixture.editor(), selection = editor.state.selection; return { head: selection.head, anchor: selection.anchor, parent: selection.$head.parent.type.name, top: editor.view.coordsAtPos(selection.head).top }; });
    assert.ok(await page.evaluate(pos => window.flowFixture.editor().state.selection.head < pos && !window.flowFixture.editor().state.selection.empty, boundary));
    assert.deepEqual(await editorJson(), before);
    await page.evaluate(() => window.flowFixture.editor().commands.setTextSelection(1));
  });
  await group('Infinite retains the single canonical body and grows at A4 width', async () => {
    const before = await editorJson();
    await page.getByTitle('Toggle Page Properties', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Page Size', exact: true }).selectOption('Infinite');
    await page.getByTitle('Toggle Page Properties', { exact: true }).click();
    await page.waitForFunction(() => window.richFixture.engine().getProperties().pageSize === 'Infinite' && document.querySelector('[data-document-sheet-count]')?.dataset.documentSheetCount === '1');
    await frames(); assert.deepEqual(await editorJson(), before);
    assert.equal(await page.evaluate(() => window.flowFixture.editor().view.dom.querySelectorAll('.panvas-page-gap').length), 0);
    await page.evaluate(() => window.flowFixture.editor().commands.setTextSelection(1));
    await page.getByTitle('Hand (Space)', { exact: true }).click();
    await page.evaluate(() => document.querySelector('.notebook-viewport').scrollTop = 0);
    await frames();
    await page.screenshot({ path: out + '/' + mode + '-infinite.png' });
    await page.getByTitle('Text (T)', { exact: true }).click();
  });
  await group('Integrated language control keeps Java tokens and undoable metadata', async () => {
    await page.locator('[data-document-body] summary[aria-label="Code language"]').click();
    await page.getByRole('searchbox', { name: 'Search code languages', exact: true }).fill('Plain Text');
    await page.getByRole('option', { name: 'Plain Text', exact: true }).click();
    const code = json => json.content.find(node => node.type === 'codeBlock');
    assert.equal(code(await editorJson()).attrs.language, 'plaintext');
    await page.locator('[data-document-body] summary[aria-label="Code language"]').click();
    await page.getByRole('searchbox', { name: 'Search code languages', exact: true }).fill('Java');
    await page.getByRole('option', { name: 'Java', exact: true }).click();
    assert.equal(code(await editorJson()).attrs.language, 'java');
    assert.ok(await page.locator('[data-document-body] code .hljs-keyword').count());
    const colors = await page.evaluate(() => ({ keyword: getComputedStyle(document.querySelector('[data-document-body] .hljs-keyword')).color, code: getComputedStyle(document.querySelector('[data-document-body] code')).color, math: getComputedStyle(document.querySelector('[data-document-body] .katex-html')).color }));
    assert.notEqual(colors.keyword, colors.code); assert.notEqual(colors.math, 'rgb(232, 232, 237)');
    metrics.colors = colors;
    await page.keyboard.press('Control+z'); assert.equal(code(await editorJson()).attrs.language, 'plaintext');
    await page.keyboard.press('Control+Shift+z'); assert.equal(code(await editorJson()).attrs.language, 'java');
  });
  await group('IME composition commits through the real contenteditable', async () => {
    await page.evaluate(() => window.flowFixture.editor().commands.focus('start'));
    const session = await page.context().newCDPSession(page);
    await session.send('Input.imeSetComposition', { text: '文档', selectionStart: 2, selectionEnd: 2 });
    await session.send('Input.insertText', { text: '文档' });
    await session.detach();
    assert.ok(JSON.stringify(await editorJson()).includes('文档'));
    await page.keyboard.press('Control+z');
  });
  await group('Workspace paste in Hand mode uses the same flowing body and one native undo', async () => {
    const before = await editorJson();
    await page.getByTitle('Hand (Space)', { exact: true }).click();
    await page.locator('#fixture-outside').click();
    await page.evaluate(() => {
      const data = new DataTransfer(); data.setData('text/plain', 'Workspace paste marker');
      document.querySelector('.notebook-viewport').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => window.flowFixture.editor().getText().includes('Workspace paste marker'));
    assert.equal(await page.evaluate(() => window.richFixture.engine().texts.getTexts().length), 1);
    assert.equal(await page.evaluate(() => window.flowFixture.editor().getText().split('Workspace paste marker').length - 1), 1);
    await page.waitForFunction(() => window.flowFixture.editor().isFocused);
    await page.keyboard.press('Control+z'); assert.deepEqual(await editorJson(), before);
  });
  await group('Touch pinch over document text and pen canvas retain gesture ownership and canonical text', async () => {
    const before = await editorJson(), owner = await page.evaluate(() => window.flowFixture.location().pageId);
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    let touchActive = false;
    const startZoom = await page.evaluate(() => window.richFixture.engine().viewport.getState().scale);
    try {
      await page.evaluate(() => { window.flowFixture.editor().commands.setTextSelection(1); document.querySelector('.notebook-viewport').scrollTop = 0; });
      const point = await page.getByRole('textbox', { name: 'Document body', exact: true }).evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.left + 160, y: Math.max(rect.top + 170, 300) }; });
      for (const surface of ['text', 'pen']) {
        if (surface === 'pen') { await page.getByTitle('Pen (P)', { exact: true }).click(); await page.getByTitle('Pen (P)', { exact: true }).click(); }
        const inkBefore = await page.evaluate(() => window.richFixture.engine().drawing.getStrokes().length);
        const zoomBefore = await page.evaluate(() => window.richFixture.engine().viewport.getState().scale);
        const points = [{ x: point.x, y: point.y, id: 61, radiusX: 1, radiusY: 1, force: 1 }, { x: point.x + 100, y: point.y, id: 62, radiusX: 1, radiusY: 1, force: 1 }];
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
        touchActive = true;
        points[0].x -= 15; points[1].x += 15; points.forEach(point => point.y -= 40);
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });
        await frames();
        assert.ok(await page.evaluate(zoom => window.richFixture.engine().viewport.getState().scale > zoom, zoomBefore));
        assert.equal(await page.evaluate(() => window.richFixture.engine().getDrawingOwnership().pageId), owner);
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); touchActive = false; await frames();
        assert.equal(await page.evaluate(() => window.richFixture.engine().drawing.getStrokes().length), inkBefore);
        assert.equal(await page.evaluate(() => window.richFixture.engine().input.navigationGestures.active), false);
      }
      assert.deepEqual(await editorJson(), before);
    } finally {
      if (touchActive) await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await session.detach();
      await page.evaluate(zoom => { window.richFixture.engine().viewport.setZoom(zoom); document.querySelector('.notebook-viewport').scrollTop = 0; }, startZoom);
      await page.getByTitle('Text (T)', { exact: true }).click();
    }
  });
  await group('Canonical JSON survives page handoff and browser/Electron repository reopening', async () => {
    const before = await editorJson();
    await page.waitForFunction(async () => JSON.stringify((await window.richFixture.load())?.objects?.find(object => object.metadata?.documentRole === 'body')?.content) === JSON.stringify(window.flowFixture.editor().getJSON()));
    await page.evaluate(() => window.richFixture.reload());
    await page.waitForFunction(() => !window.richFixture.engine().texts.getTexts().some(text => text.metadata?.documentRole === 'body'));
    await page.evaluate(() => window.richFixture.returnToPage());
    await page.waitForFunction(() => window.flowFixture.editor()?.isEditable);
    assert.deepEqual(await editorJson(), before);
    metrics.save = await page.evaluate(() => window.flowFixture.saveTiming());
  });
  await group('Infinite distant coordinates retain bounded canvas pixels and screen transforms', async () => {
    await page.evaluate(() => {
      const engine = window.richFixture.engine();
      engine.shapes.addShape({ id: 'far-coordinate-shape', type: 'shape', shapeType: 'rectangle', x: 120, y: 50_000_200, width: 120, height: 80, color: '#2563eb', strokeWidth: 4, fill: '#2563eb', rotation: 0, createdAt: Date.now() });
      engine.input.notifyChange();
    });
    await page.waitForFunction(() => window.richFixture.engine().getProperties().layoutExtent > 50_000_280);
    await page.getByTitle('Toggle Page Properties', { exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Vertical position', exact: true }).fill('50000000');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await page.getByTitle('Toggle Page Properties', { exact: true }).click();
    await frames();
    const point = await page.evaluate(() => {
      const engine = window.richFixture.engine(), canvas = engine.drawing.getCanvasElement();
      const pixel = engine.viewport.pageToCanvas(150, 50_000_240), back = engine.viewport.canvasToPage(pixel.x, pixel.y);
      const scale = canvas.width / canvas.clientWidth;
      const rgba = [...canvas.getContext('2d').getImageData(Math.floor(pixel.x * scale), Math.floor(pixel.y * scale), 1, 1).data];
      return { pixel, back, rgba, width: canvas.width, height: canvas.height, logicalBase: Number(document.querySelector('[data-logical-scroll-base]').dataset.logicalScrollBase), scrollHeight: document.querySelector('.notebook-viewport').scrollHeight, extent: engine.getProperties().layoutExtent };
    });
    metrics.distant = point;
    assert.equal(point.back.y, 50_000_240); assert.ok(point.logicalBase > 49_000_000); assert.ok(point.height < 9000); assert.ok(point.width * point.height <= 16_777_216); assert.ok(point.rgba[3] > 0, JSON.stringify(point));
    await page.screenshot({ path: out + '/' + mode + '-distant.png' });
  });
  await group('Select and ink retain distant logical coordinates across a raster rebase', async () => {
    await page.getByTitle('Select (V)', { exact: true }).click();
    const center = await page.evaluate(() => {
      const engine = window.richFixture.engine(), canvas = engine.drawing.getCanvasElement(), rect = canvas.getBoundingClientRect();
      const point = engine.viewport.pageToCanvas(180, 50_000_240), scale = rect.width / canvas.clientWidth;
      return { x: rect.left + point.x * scale, y: rect.top + point.y * scale };
    });
    await page.mouse.move(center.x, center.y); await page.mouse.down(); await page.mouse.move(center.x + 20, center.y + 15, { steps: 5 }); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.richFixture.engine().selection.getSelectedElements()[0]?.id), 'far-coordinate-shape');
    const movedY = await page.evaluate(() => window.richFixture.engine().shapes.getShapes().find(shape => shape.id === 'far-coordinate-shape').y);
    assert.ok(movedY > 50_000_210); await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => window.richFixture.engine().shapes.getShapes().find(shape => shape.id === 'far-coordinate-shape').y), 50_000_200);
    await page.getByTitle('Pen (P)', { exact: true }).click();
    await page.getByTitle('Pen (P)', { exact: true }).click();
    const start = await page.evaluate(() => { const canvas = window.richFixture.engine().drawing.getCanvasElement(), rect = canvas.getBoundingClientRect(), viewport = document.querySelector('.notebook-viewport').getBoundingClientRect(); return { x: rect.left + 300 * rect.width / canvas.clientWidth, y: viewport.top + 350 }; });
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 30, start.y + 30, { steps: 8 });
    await page.mouse.wheel(0, 1400); await frames();
    await page.mouse.move(start.x + 60, start.y + 80, { steps: 8 }); await page.mouse.up(); await frames();
    const ink = await page.evaluate(() => {
      const engine = window.richFixture.engine(), stroke = engine.drawing.getStrokes().at(-1), canvas = engine.drawing.getCanvasElement();
      const point = stroke.points.at(-1), pixel = engine.viewport.pageToCanvas(point.x, point.y), scale = canvas.width / canvas.clientWidth;
      const rgba = canvas.getContext('2d').getImageData(Math.floor(pixel.x * scale) - 2, Math.floor(pixel.y * scale) - 2, 5, 5).data;
      const visibleAlpha = [...rgba].filter((_, index) => index % 4 === 3).some(alpha => alpha > 0);
      const diagnostic = { style: { clip: stroke.inkClip, color: stroke.color, thickness: stroke.thickness, opacity: stroke.opacity, layer: stroke.layerId, family: stroke.inkFamily, tool: stroke.tool, centerline: stroke.centerline }, transform: canvas.getContext('2d').getTransform().toJSON(), zoom: engine.viewport.getState().scale, layers: engine.layers.getLayers() };
      return { points: stroke.points.length, minY: Math.min(...stroke.points.map(point => point.y)), maxY: Math.max(...stroke.points.map(point => point.y)), visibleAlpha, pressure: stroke.points.every(point => Number.isFinite(point.pressure)), pixel, endpoint: point, canvas: { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight }, renderWindow: engine.viewport.getRenderWindowBounds(), diagnostic };
    });
    metrics.distantInk = ink; assert.ok(ink.points >= 10); assert.ok(ink.minY > 49_000_000); assert.ok(ink.maxY - ink.minY > 1500); assert.ok(ink.visibleAlpha); assert.ok(ink.pressure);
    await page.screenshot({ path: out + '/' + mode + '-distant-ink.png' });
    const pen = await page.context().newCDPSession(page);
    const beforePen = await page.evaluate(() => window.richFixture.engine().drawing.getStrokes().length);
    try {
      await pen.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 90, y: start.y, button: 'none', buttons: 0, pointerType: 'pen' });
      await pen.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x + 90, y: start.y, button: 'left', buttons: 1, pointerType: 'pen', force: .25, clickCount: 1 });
      for (let index = 0; index < 8; index++) await pen.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 90 + index * 4, y: start.y + index * 5, button: 'left', buttons: 1, pointerType: 'pen', force: .25 + index * .08 });
      await pen.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + 122, y: start.y + 40, button: 'left', buttons: 0, pointerType: 'pen', force: .5, clickCount: 1 });
      await frames();
      const samples = await page.evaluate(() => { const stroke = window.richFixture.engine().drawing.getStrokes().at(-1); return { minY: Math.min(...stroke.points.map(point => point.y)), points: stroke.points.length, pressures: [...new Set(stroke.points.map(point => point.pressure))] }; });
      metrics.distantPen = samples;
      assert.equal(await page.evaluate(() => window.richFixture.engine().drawing.getStrokes().length), beforePen + 1);
      assert.ok(samples.minY > 49_000_000); assert.ok(samples.pressures.length > 1);
    } finally { await pen.detach(); }
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('panvas:go-to-logical-y', { detail: { y: 0 } })));
    await frames();
  });
  await group('Distant pen paths preserve subpixel caps under damage clips and leave samples unchanged', async () => {
    const cases = await page.evaluate(() => {
      const drawing = window.richFixture.engine().drawing, origin = 50_000_832, results = [];
      for (const fraction of [.125, .5, .885]) {
        const stroke = { id: 'precision-' + fraction, type: 'stroke', tool: 'pen', color: '#000000', thickness: 2.4, opacity: 1, centerline: 'polyline', createdAt: 1, points: [{ x: 40, y: origin + 20 + fraction, pressure: .5, t: 0 }, { x: 110, y: origin + 70 + fraction, pressure: .5, t: 30 }] };
        const snapshot = JSON.stringify(stroke), local = { ...stroke, points: stroke.points.map(point => ({ ...point, y: point.y - origin })) };
        const pixels = (value, offset) => { const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 120; const ctx = canvas.getContext('2d'); ctx.rect(24, 8, 130, 80); ctx.clip(); ctx.scale(.8, .8); ctx.translate(0, -offset); drawing.renderStroke(ctx, value); return ctx.getImageData(0, 0, 200, 120).data; };
        const distant = pixels(stroke, origin), nearby = pixels(local, 0); let maximumDelta = 0, painted = 0;
        for (let index = 0; index < distant.length; index++) { maximumDelta = Math.max(maximumDelta, Math.abs(distant[index] - nearby[index])); if (index % 4 === 3 && distant[index]) painted++; }
        results.push({ fraction, maximumDelta, painted, samplesUnchanged: snapshot === JSON.stringify(stroke) });
      }
      return results;
    });
    metrics.distantPenPrecision = cases;
    assert.ok(cases.every(value => value.maximumDelta <= 1 && value.painted > 50 && value.samplesUnchanged), JSON.stringify(cases));
  });
  await group('Explicit Freeform conversion preserves its rich source and positioned ink shapes and images', async () => {
    const home = await page.evaluate(() => window.flowFixture.location());
    const second = await page.evaluate(() => window.flowFixture.pageIds().find(id => id !== window.flowFixture.location().pageId));
    await page.evaluate(id => window.flowFixture.activate(id), second);
    try {
    await page.waitForFunction(id => window.richFixture.engine().getDrawingOwnership().pageId === id, second);
    await page.evaluate(async () => {
      const engine = window.richFixture.engine(), id = engine.getDrawingOwnership().pageId;
      const fileId = await window.documentationFixture.storeImage(id);
      engine.texts.addText({ id: 'legacy-text', type: 'text', x: 70, y: 160, width: 330, height: 72, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Legacy positioned text' }] }] }, createdAt: Date.now() });
      engine.shapes.addShape({ id: 'legacy-shape', type: 'shape', shapeType: 'rectangle', x: 420, y: 260, width: 100, height: 80, color: '#2563eb', strokeWidth: 3, fill: null, rotation: 0, createdAt: Date.now() });
      engine.images.addImage({ id: 'legacy-image', type: 'image', fileId, x: 80, y: 330, width: 90, height: 90, rotation: 0, createdAt: Date.now() });
      engine.drawing.addStroke({ id: 'legacy-ink', type: 'stroke', points: [{ x: 120, y: 120, pressure: .4, t: 0 }, { x: 210, y: 140, pressure: .8, t: 50 }], tool: 'pen', color: '#000000', thickness: 4, opacity: 1, createdAt: Date.now() });
      engine.input.notifyChange();
    });
    await frames();
    metrics.legacyViewport = await page.evaluate(() => {
      const engine = window.richFixture.engine(), canvas = engine.drawing.getCanvasElement();
      return { owner: engine.getDrawingOwnership(), objects: engine.images.getImages(), cache: [...engine.images.imageCache.keys()], bounds: engine.viewport.getRenderWindowBounds(), canvas: { width: canvas.width, height: canvas.height, rect: canvas.getBoundingClientRect().toJSON() }, origin: engine.viewport.renderOriginY };
    });
    await page.getByTitle('Text (T)', { exact: true }).click();
    await page.locator('[data-text-object-id="legacy-text"] .ProseMirror').click();
    await page.waitForFunction(() => window.richFixture.engine().texts.getEditor('legacy-text')?.isFocused);
    const before = await page.evaluate(() => window.richFixture.engine().getDrawingData().objects.filter(object => object.id.startsWith('legacy-')));
    await page.getByTitle('Toggle Page Properties', { exact: true }).click();
    await page.getByRole('group', { name: 'Writing layout', exact: true }).getByRole('button', { name: 'Document', exact: true }).click();
    await page.waitForFunction(() => window.flowFixture.editor()?.view.dom.isConnected);
    await page.getByTitle('Toggle Page Properties', { exact: true }).click();
    const after = await page.evaluate(() => window.richFixture.engine().getDrawingData().objects.filter(object => object.id.startsWith('legacy-')));
    assert.deepEqual(after.filter(object => object.type !== 'text'), before.filter(object => object.type !== 'text'));
    const converted = after.find(object => object.id === 'legacy-text'), sourceText = before.find(object => object.id === 'legacy-text');
    assert.equal(converted.metadata.documentRole, 'body'); assert.deepEqual(converted.content, sourceText.content);
    assert.deepEqual(converted.metadata.documentConversionOriginal, sourceText);
    const convertedView = await editorJson();
    await page.getByTitle('Select (V)', { exact: true }).click();
    await page.evaluate(() => {
      const root = document.getElementById('page-' + window.flowFixture.location().pageId), scroller = document.querySelector('.notebook-viewport');
      scroller.scrollTop += root.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 80;
    });
    await frames();
    metrics.legacyAfterFlow = await page.evaluate(() => {
      const engine = window.richFixture.engine(), canvas = engine.drawing.getCanvasElement(), pixel = engine.viewport.pageToCanvas(100, 350), scale = canvas.width / canvas.clientWidth;
      return { owner: engine.getDrawingOwnership(), properties: engine.getProperties(), bounds: engine.viewport.getRenderWindowBounds(), origin: engine.viewport.renderOriginY, pixel, rgba: [...canvas.getContext('2d').getImageData(Math.floor(pixel.x * scale), Math.floor(pixel.y * scale), 1, 1).data], cached: [...engine.images.imageCache.keys()], canvas: { width: canvas.width, height: canvas.height, rect: canvas.getBoundingClientRect().toJSON() } };
    });
    await page.waitForFunction(() => {
      const engine = window.richFixture.engine(), canvas = engine.drawing.getCanvasElement(), pixel = engine.viewport.pageToCanvas(100, 350), scale = canvas.width / canvas.clientWidth;
      return canvas.getContext('2d').getImageData(Math.floor(pixel.x * scale), Math.floor(pixel.y * scale), 1, 1).data[3] > 0;
    });
    const textPoint = await page.evaluate(() => {
      const engine = window.richFixture.engine(), canvas = engine.drawing.getCanvasElement(), rect = canvas.getBoundingClientRect(), point = engine.viewport.pageToCanvas(460, 300), scale = rect.width / canvas.clientWidth;
      return { x: rect.left + point.x * scale, y: rect.top + point.y * scale };
    });
    await page.mouse.move(textPoint.x, textPoint.y); await page.mouse.down(); await page.mouse.move(textPoint.x + 16, textPoint.y + 8, { steps: 4 }); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.richFixture.engine().selection.getSelectedElements()[0]?.id), 'legacy-shape');
    assert.ok(await page.evaluate(() => window.richFixture.engine().shapes.getShapes().find(shape => shape.id === 'legacy-shape').x > 420));
    await page.keyboard.press('Control+z');
    assert.deepEqual(await page.evaluate(() => window.richFixture.engine().getDrawingData().objects.filter(object => object.id.startsWith('legacy-') && object.type !== 'text')), before.filter(object => object.type !== 'text'));
    assert.deepEqual(await editorJson(), convertedView);
    await page.evaluate(() => window.richFixture.engine().selection.clearSelection());
    await page.screenshot({ path: out + '/' + mode + '-legacy.png' });
    } finally {
    await page.evaluate(home => window.flowFixture.activate(home.pageId), home);
    await page.waitForFunction(id => window.richFixture.engine().getDrawingOwnership().pageId === id && window.flowFixture.editor()?.view.dom.isConnected, home.pageId);
    await page.getByTitle('Text (T)', { exact: true }).click();
    }
  });
  await group('Visible documentation controls insert and edit existing shared block types', async () => {
    const original = await editorJson();
    try {
      await page.evaluate(() => window.flowFixture.editor().commands.focus('start')); await frames();
      await page.getByRole('button', { name: 'More text formatting', exact: true }).click();
      const menu = page.getByRole('dialog', { name: 'Text formatting options', exact: true });
      await menu.getByRole('tab', { name: 'Insert', exact: true }).click();
      await menu.getByRole('button', { name: 'Insert callout', exact: true }).click();
      assert.ok(JSON.stringify(await editorJson()).includes('"callout"'));
      await menu.getByRole('button', { name: 'Insert toggle', exact: true }).click();
      assert.ok(JSON.stringify(await editorJson()).includes('"details"'));
      await menu.getByRole('tab', { name: 'Block', exact: true }).click();
      await menu.getByRole('button', { name: 'Collapse / expand', exact: true }).click();
      await menu.getByRole('tab', { name: 'Insert', exact: true }).click();
      await menu.getByRole('button', { name: 'Insert table', exact: true }).click();
      await menu.getByRole('tab', { name: 'Table', exact: true }).click();
      await menu.getByRole('button', { name: 'Add row', exact: true }).click();
      await menu.getByRole('button', { name: 'Add column', exact: true }).click();
      const beforeBreak = await editorJson();
      await menu.getByRole('tab', { name: 'Insert', exact: true }).click();
      await menu.getByRole('button', { name: 'Page break', exact: true }).click();
      assert.deepEqual(await editorJson(), beforeBreak);
      await menu.getByRole('status').filter({ hasText: 'unavailable' }).waitFor();
      await menu.getByRole('button', { name: 'Equation…', exact: true }).click();
      await menu.getByRole('textbox', { name: 'LaTeX source', exact: true }).fill('x^2+y^2=z^2');
      await menu.getByRole('button', { name: 'Block equation', exact: true }).click();
      assert.ok(JSON.stringify(await editorJson()).includes('x^2+y^2=z^2'));
      await menu.getByRole('button', { name: '← Insert tools', exact: true }).click();
      await menu.getByRole('button', { name: 'Page reference…', exact: true }).click();
      const target = await page.evaluate(() => window.flowFixture.pageIds().find(id => id !== window.flowFixture.location().pageId));
      metrics.controlTargets = { target, options: await menu.getByRole('combobox', { name: 'Internal page link', exact: true }).locator('option').evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent }))) };
      assert.ok(target, 'A second page in the current notebook is available for linking');
      await menu.getByRole('combobox', { name: 'Internal page link', exact: true }).selectOption(target);
      await menu.getByRole('button', { name: 'Insert page link', exact: true }).click();
      assert.ok(JSON.stringify(await editorJson()).includes(target));
      await menu.getByRole('button', { name: '← Insert tools', exact: true }).click();
      assert.equal(await menu.locator('textarea').count(), 0);
      await menu.getByRole('button', { name: 'Paste Markdown…', exact: true }).click();
      const markdownDialog = page.getByRole('dialog', { name: 'Paste Markdown', exact: true });
      await markdownDialog.getByRole('textbox', { name: 'Markdown source', exact: true }).fill('## Imported heading\n\n- [x] Reviewed\n- [ ] Pending');
      await markdownDialog.getByRole('button', { name: 'Insert Markdown', exact: true }).click();
      assert.ok(JSON.stringify(await editorJson()).includes('"taskList"'));
      assert.equal(await menu.getByRole('button', { name: /image/i }).count(), 0);
      await page.screenshot({ path: out + '/' + mode + '-controls.png' });
      await page.getByRole('button', { name: 'More text formatting', exact: true }).click();
    } finally { await page.evaluate(content => window.flowFixture.editor().commands.setContent(content), original); await frames(); }
  });
  await group('Reload or Electron restart preserves the complete canonical document and distant objects', async () => {
    const location = await page.evaluate(() => window.flowFixture.location()), before = await editorJson();
    await page.evaluate(() => window.flowFixture.saveTiming());
    const resumeUrl = server.resolvedUrls.local[0] + 'tests/fixtures/documentation-flow.html?resumeWorkspace=' + encodeURIComponent(location.workspaceId) + '&resumePage=' + encodeURIComponent(location.pageId);
    if (electronMode) {
      await app.close();
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
      const bootstrap = await readFile(path.join(directory, 'bootstrap.cjs'), 'utf8');
      await writeFile(path.join(directory, 'restart.cjs'), bootstrap.replace(JSON.stringify(server.resolvedUrls.local[0] + 'tests/fixtures/documentation-flow.html'), JSON.stringify(resumeUrl)));
      app = await _electron.launch({ args: [path.join(directory, 'restart.cjs')], env }); page = await app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
    } else await page.goto(resumeUrl);
    await page.waitForFunction(() => window.richFixture?.ready());
    await page.evaluate(location => window.flowFixture.resume(location.workspaceId, location.pageId), location);
    await page.waitForFunction(id => window.richFixture.engine().getDrawingOwnership().pageId === id && window.flowFixture.editor()?.view.dom.isConnected, location.pageId);
    assert.deepEqual(await editorJson(), before);
    assert.ok(await page.evaluate(() => window.richFixture.engine().shapes.getShapes().some(shape => shape.id === 'far-coordinate-shape')));
    assert.ok(await page.evaluate(() => window.richFixture.engine().getProperties().layoutExtent > 50_000_000));
    await page.getByTitle('Text (T)', { exact: true }).click();
  });
  await group('Future document payloads remain read-only and save their untouched canonical JSON', async () => {
    const original = await page.evaluate(() => window.richFixture.engine().getDrawingData());
    try {
      const future = await page.evaluate(() => {
        const engine = window.richFixture.engine(), data = engine.getDrawingData();
        const body = data.objects.find(object => object.metadata?.documentRole === 'body');
        body.id += '-future'; body.metadata.richTextSchemaVersion = 4;
        body.content.content.push({ type: 'futureWidget', attrs: { opaque: 'Retain future data' }, content: [{ type: 'text', text: 'Future content' }] });
        engine.setDrawingData(data, engine.getDrawingOwnership().pageId); engine.input.notifyChange();
        return body.content;
      });
      await page.waitForFunction(() => window.flowFixture.editor()?.view.dom.dataset.protectedContent === 'true');
      assert.equal(await page.evaluate(() => window.flowFixture.editor().isEditable), false);
      await page.locator('#fixture-outside').click();
      await page.evaluate(() => {
        const data = new DataTransfer(); data.setData('text/plain', 'Cannot overwrite future document');
        document.querySelector('.notebook-viewport').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await frames();
      assert.deepEqual(await page.evaluate(() => window.flowFixture.body().content), future);
      await page.evaluate(() => window.flowFixture.saveTiming());
      assert.deepEqual(await page.evaluate(async () => (await window.richFixture.load()).objects.find(object => object.metadata?.documentRole === 'body').content), future);
    } finally {
      await page.evaluate(data => { const engine = window.richFixture.engine(); engine.setDrawingData(data, engine.getDrawingOwnership().pageId); engine.tools.setMode('text'); engine.input.notifyChange(); }, original);
      await page.waitForFunction(() => window.flowFixture.editor()?.isEditable);
      await page.evaluate(() => window.flowFixture.saveTiming());
    }
  });
  await group('Combined technical document keeps tables links Java output lists inline code and rendered equations through A4 Infinite and reopening', async () => {
    const original = await page.evaluate(() => window.richFixture.engine().getDrawingData());
    const home = await page.evaluate(() => window.richFixture.engine().getDrawingOwnership().pageId);
    const otherPage = await page.evaluate(home => window.flowFixture.pageIds().find(id => id !== home), home);
    const java = 'public class Casting {\n  double value = 9.78;\n  int result = (int) value;\n  // Keep source separate from output\n}';
    const source = '<h1>Technical type conversion reference</h1><p>Read the <a href="https://example.com/reference">technical reference</a> and preserve <code>inline code</code> with <strong>formatted prose</strong>.</p>'
      + '<h2>Java example</h2><pre><code class="language-java">' + java + '</code></pre><h2>Program output</h2><pre data-language="plaintext"><code>9.78\n9</code></pre>'
      + '<h2>Comparison Summary</h2><table><tr>' + ['Feature', 'Implicit widening conversion', 'Explicit narrowing conversion', 'Precision', 'Input value', 'Output value', 'Conversion explanation'].map(text => `<th>${text}</th>`).join('') + '</tr><tr>'
      + ['Readable column policy', 'Automatic conversion retains a larger numeric container', 'An explicit cast acknowledges possible fractional truncation', 'Keep meaningful digits and explanatory text', 'Floating point with a fractional component', 'Integer after explicit truncation', 'Keep the table editable and scroll to additional columns'].map(text => `<td>${text}</td>`).join('') + '</tr></table>'
      + '<ul><li>Keep nested reading order<ul><li>Retain nested items</li></ul></li><li>Separate source and output</li></ul><ol><li>Read the input type</li><li>Choose the conversion</li></ol>'
      + '<p>Inline equation <span data-type="inline-math" data-latex="x^2+y^2"></span> remains part of the paragraph.</p><div data-type="block-math" data-latex="E=mc^2"></div>'
      + Array.from({ length: 32 }, (_, index) => `<p>Acceptance paragraph ${index + 1}. ${'A technical explanation preserves its complete reading order and formatting across paper boundaries. '.repeat(6)}</p>`).join('');
    try {
      await page.evaluate(() => window.richFixture.reset([])); await frames();
      await page.getByTitle('Toggle Page Properties', { exact: true }).click();
      await page.getByRole('group', { name: 'Writing layout', exact: true }).getByRole('button', { name: 'Document', exact: true }).click();
      await page.getByTitle('Toggle Page Properties', { exact: true }).click();
      await page.waitForFunction(() => window.flowFixture.editor()?.view.dom.isConnected);
      await page.evaluate(html => { const editor = window.flowFixture.editor(); editor.commands.focus('start'); const clipboardData = new DataTransfer(); clipboardData.setData('text/html', html); clipboardData.setData('text/plain', 'Technical reference'); editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })); }, source);
      await page.waitForFunction(() => Number(document.querySelector('[data-document-sheet-count]')?.dataset.documentSheetCount) > 2);
      await page.evaluate(() => document.fonts.ready); await frames();
      const canonical = await editorJson();
      const inspect = async layout => {
        const structure = await page.evaluate(() => { const editor = window.flowFixture.editor(), counts = {}; editor.state.doc.descendants(node => { counts[node.type.name] = (counts[node.type.name] ?? 0) + 1; }); return { counts, width: editor.view.dom.offsetWidth, issues: editor.view.dom.dataset.layoutIssues, text: editor.getText(), code: [...editor.view.dom.querySelectorAll('pre code')].map(code => code.textContent), math: editor.view.dom.querySelectorAll('.katex').length }; });
        assert.equal(structure.counts.table, 1); assert.equal(structure.counts.codeBlock, 2); assert.equal(structure.counts.inlineMath, 1); assert.equal(structure.counts.blockMath, 1); assert.equal(structure.counts.orderedList, 1); assert.ok(structure.counts.bulletList >= 2); assert.equal(structure.math, 2); assert.equal(structure.width, 666); assert.equal(structure.issues, '0');
        assert.deepEqual(structure.code, [java, '9.78\n9']); assert.ok(await page.locator('[data-document-body] .hljs-keyword').count());
        assert.equal(await page.getByRole('link', { name: 'technical reference', exact: true }).getAttribute('href'), 'https://example.com/reference'); assert.equal(await page.locator('[data-document-body] p code').filter({ hasText: 'inline code' }).count(), 1);
        for (let index = 1; index <= 32; index++) assert.equal(structure.text.split(`Acceptance paragraph ${index}.`).length - 1, 1);
        const region = page.locator('[data-document-body] .tableWrapper').first(); await region.evaluate(root => root.scrollIntoView({ block: 'center' })); await frames();
        const table = await region.evaluate(root => { const table = root.querySelector('table'), editor = root.closest('.ProseMirror'), scale = editor.getBoundingClientRect().width / editor.offsetWidth; return { widths: [...table.rows[0].cells].map(cell => cell.getBoundingClientRect().width / scale), overflow: root.scrollWidth > root.clientWidth }; });
        assert.ok(table.widths.every(width => width >= 119)); assert.ok(table.overflow); await region.focus(); await page.keyboard.press('ArrowRight'); await frames(); assert.ok(await region.evaluate(root => root.scrollLeft > 0));
        await page.screenshot({ path: 'artifacts/documentation-stabilization/' + mode + '-combined-' + layout + '-table.png' });
        await page.locator('[data-document-body] .katex').last().evaluate(root => root.scrollIntoView({ block: 'center' })); await frames();
        await page.screenshot({ path: 'artifacts/documentation-stabilization/' + mode + '-combined-' + layout + '-math.png' });
        return { structure, table };
      };
      const a4 = await inspect('A4'); assert.deepEqual(await editorJson(), canonical);
      await page.getByTitle('Toggle Page Properties', { exact: true }).click(); await page.getByRole('combobox', { name: 'Page Size', exact: true }).selectOption('Infinite'); await page.getByTitle('Toggle Page Properties', { exact: true }).click();
      await page.waitForFunction(() => window.richFixture.engine().getProperties().pageSize === 'Infinite' && document.querySelector('[data-document-sheet-count]')?.dataset.documentSheetCount === '1'); await frames();
      const infinite = await inspect('Infinite'); assert.deepEqual(await editorJson(), canonical);
      await page.evaluate(() => window.flowFixture.saveTiming()); await page.evaluate(() => window.richFixture.reload()); await page.waitForFunction(id => window.richFixture.engine().getDrawingOwnership().pageId === id, otherPage); await page.evaluate(() => window.richFixture.returnToPage()); await page.waitForFunction(id => window.richFixture.engine().getDrawingOwnership().pageId === id && window.flowFixture.editor()?.view.dom.isConnected, home); assert.deepEqual(await editorJson(), canonical);
      metrics.combinedAcceptance = { a4, infinite, savedExactly: true };
    } finally {
      await page.evaluate(() => window.richFixture.returnToPage());
      await page.waitForFunction(id => window.richFixture.engine().getDrawingOwnership().pageId === id, home);
      await page.evaluate(data => { const engine = window.richFixture.engine(); engine.setDrawingData(data, engine.getDrawingOwnership().pageId); engine.tools.setMode('text'); engine.input.notifyChange(); }, original);
      await page.waitForFunction(() => window.flowFixture.editor()?.view.dom.isConnected);
    }
  });
  if (electronMode) await group('Native metadata validation rejects nonfinite extent invalid width and unknown writing layout', async () => {
    const results = await page.evaluate(async () => {
      const { workspaceId, pageId } = window.flowFixture.location(), results = [];
      for (const patch of [{ layoutExtent: Infinity }, { layoutExtent: -1 }, { infiniteWidth: 0 }, { infiniteWidth: NaN }, { layoutMode: 'unknown' }]) {
        try { await window.panvas.notebookPage.update(workspaceId, pageId, { pagePropertyOverrides: patch }); results.push(false); }
        catch { results.push(true); }
      }
      return results;
    });
    assert.deepEqual(results, [true, true, true, true, true]);
  });
  if (performanceMode) await group('Measured large Infinite and fixed document input scroll canvas and save costs', async () => {
    metrics.largeDocuments = [];
    for (const { blocks, pageSize } of [{ blocks: 1000, pageSize: 'Infinite' }, { blocks: 5000, pageSize: 'Infinite' }, { blocks: 10000, pageSize: 'Infinite' }, { blocks: 1000, pageSize: 'A4' }]) {
      if (pageSize === 'A4') {
        await page.evaluate(() => { const engine = window.richFixture.engine(); engine.drawing.setStrokes([]); engine.shapes.removeShape('far-coordinate-shape'); engine.input.notifyChange(); });
        await page.getByTitle('Toggle Page Properties', { exact: true }).click();
        await page.getByRole('combobox', { name: 'Page Size', exact: true }).selectOption(pageSize);
        await page.getByTitle('Toggle Page Properties', { exact: true }).click();
      }
      const setup = await page.evaluate(blocks => {
        const editor = window.flowFixture.editor(), started = performance.now();
        editor.commands.setContent({ type: 'doc', content: Array.from({ length: blocks }, (_, index) => ({ type: 'paragraph', content: [{ type: 'text', text: `Block ${index}. A measured technical document contains structured content.` }] })) });
        return { setupMs: performance.now() - started };
      }, blocks);
      await frames();
      await page.evaluate(() => {
        const editor = window.flowFixture.editor(); editor.commands.focus('start');
        window.flowPaintSamples = [];
        if (window.flowPaintHandler) editor.view.dom.removeEventListener('beforeinput', window.flowPaintHandler, true);
        window.flowPaintHandler = () => { const started = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.flowPaintSamples.push(performance.now() - started))); };
        editor.view.dom.addEventListener('beforeinput', window.flowPaintHandler, { capture: true });
      });
      await page.waitForFunction(() => window.flowFixture.editor().isFocused);
      for (let index = 0; index < 12; index++) { await page.keyboard.insertText('a'); await frames(); }
      const scrolling = await page.evaluate(async () => {
        const scroller = document.querySelector('.notebook-viewport'), intervals = [];
        let previous = performance.now();
        for (let frame = 0; frame < 60; frame++) {
          scroller.scrollTop += 160;
          await new Promise(requestAnimationFrame);
          const now = performance.now(); intervals.push(now - previous); previous = now;
        }
        intervals.sort((a, b) => a - b);
        return { scrollFrameP95: intervals[Math.ceil(intervals.length * .95) - 1], scrollFrameMax: intervals.at(-1), scrollFrames: intervals.length, scrollTop: scroller.scrollTop };
      });
      const stats = await page.evaluate(async () => {
        const values = window.flowPaintSamples.slice(-12).sort((a, b) => a - b);
        const engine = window.richFixture.engine();
        const canvases = new Set([...document.querySelectorAll('canvas'), engine.drawing.liveSnapshotCanvas, engine.drawing.pencilSurface].filter(Boolean));
        return { inputPaintP95: values[Math.ceil(values.length * .95) - 1], samples: values.length, layoutMs: Number(window.flowFixture.editor().view.dom.dataset.layoutMs), viewportScale: engine.viewport.getState().scale, dpr: devicePixelRatio, save: await window.flowFixture.saveTiming(), canvases: [...canvases].map(canvas => ({ width: canvas.width, height: canvas.height, rgbaBytes: canvas.width * canvas.height * 4 })) };
      });
      const heapSession = await page.context().newCDPSession(page);
      try { stats.heap = await heapSession.send('Runtime.getHeapUsage'); } finally { await heapSession.detach(); }
      metrics.largeDocuments.push({ blocks, pageSize, ...setup, ...scrolling, ...stats }); assert.ok(stats.samples >= 12); assert.ok(stats.save.bytes > 100000);
    }
  });
  if (performanceMode) await group('Measured large rich clipboard paste through the mounted document editor', async () => {
    await page.getByTitle('Toggle Page Properties', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Page Size', exact: true }).selectOption('Infinite');
    await page.getByTitle('Toggle Page Properties', { exact: true }).click();
    const sample = await page.evaluate(() => {
      const editor = window.flowFixture.editor(); editor.commands.focus('start'); editor.commands.selectAll();
      const source = Array.from({ length: 10000 }, (_, index) => `<p>Clipboard block ${index}. A large technical explanation preserves its reading order.</p>`).join('');
      const data = new DataTransfer(); data.setData('text/html', source); data.setData('text/plain', 'Large technical explanation');
      const started = performance.now();
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      return { dispatchMs: performance.now() - started, paragraphs: editor.state.doc.childCount, characters: editor.getText().length, htmlBytes: new Blob([source]).size };
    });
    await frames();
    metrics.richPaste = { ...sample, save: await page.evaluate(() => window.flowFixture.saveTiming()) };
    assert.equal(sample.paragraphs, 10000); assert.ok(sample.characters > 100000);
    console.log('MEASURED rich paste:', JSON.stringify(metrics.richPaste));
  });
} catch (error) { results.push({ name: 'Runner', passed: false, error: error.stack }); console.error(error); }
finally {
  await writeFile(out + '/' + mode + (performanceMode ? '-performance' : '') + '.json', JSON.stringify({ mode, results, errors, metrics }, null, 2));
  if (app) await app.close(); if (browser) await browser.close(); await server.close();
}
if (results.some(result => !result.passed) || errors.length) process.exitCode = 1;
console.log(`${results.filter(result => result.passed).length}/${results.length} (${mode}); renderer errors ${errors.length}`);
