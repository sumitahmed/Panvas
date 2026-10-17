import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, _electron } from 'playwright';
import { createServer } from 'vite';
import { build } from 'esbuild';

const electronMode = process.argv.includes('--electron');
const baseline = process.argv.includes('--baseline');
const filter = process.argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length);
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-documentation-'));
const server = await createServer({ mode: 'web', cacheDir: path.join(directory, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/documentation-engine.html'] }, server: { port: 0, open: false } });
const errors = [], results = [], resourceRequests = [];
let currentGroup = 'startup';
let browser, electronApp, page;
const doc = content => ({ type: 'doc', content });
const paragraph = text => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
const empty = doc([paragraph('')]);
const styleHtml = '<p><span style="font-weight:700;font-style:italic;text-decoration:underline line-through;color:#cc0000;font-size:20px;font-family:serif;background-color:#ffee00">combined</span></p>';
const codeHtml = '<pre><code class="hljs-python">print(42)</code></pre>';
const fenced = '```python\nprint(42)\n```';
const frames = (count = 4) => page.evaluate(async count => {
  for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
}, count);
const canonical = value => {
  const copy = structuredClone(value);
  while (copy.content?.length > 1 && copy.content.at(-1).type === 'paragraph' && !copy.content.at(-1).content?.length) copy.content.pop();
  return copy;
};
const findText = (value, text) => {
  if (value?.type === 'text' && value.text === text) return value;
  for (const child of value?.content ?? []) { const found = findText(child, text); if (found) return found; }
};
const reset = async (contents = [empty]) => {
  await page.evaluate(contents => window.richFixture.reset(contents), contents);
  await page.waitForFunction(count => window.richFixture.engine().texts.getTexts().length === count
    && window.richFixture.engine().texts.getTexts().every(text => window.richFixture.editor(text.id)?.view.dom.isConnected), contents.length);
  await frames();
};
const focus = async (id = 'rich-text-0') => {
  await page.evaluate(id => {
    const editor = window.richFixture.editor(id);
    if (!editor.isFocused) editor.commands.focus();
  }, id);
  await page.waitForFunction(id => window.richFixture.editor(id)?.isFocused, id);
};
const paste = async ({ html = '', text = '', target = 'editor', plain = false } = {}) => {
  if (target === 'editor') await focus();
  else await page.locator('#fixture-outside').focus();
  await page.evaluate(({ html, text, target, plain }) => {
    const clipboardData = new DataTransfer();
    if (html) clipboardData.setData('text/html', html);
    if (text) clipboardData.setData('text/plain', text);
    const element = target === 'editor' ? window.richFixture.editor().view.dom : document.querySelector('.notebook-viewport');
    // ProseMirror reads the live Shift state for paste-as-plain-text.
    if (plain) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, bubbles: true }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    if (plain) element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  }, { html, text, target, plain });
  await frames();
};
const editorJson = () => page.evaluate(() => window.richFixture.editor().getJSON());
const group = async (name, run) => {
  if (filter && !name.includes(filter)) return;
  currentGroup = name;
  try { await run(); results.push({ name, passed: true }); console.log(`PASS: ${name}`); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); console.log(`FAIL: ${name}: ${error.message}`); }
};
const copySelection = id => page.evaluate(id => {
  const editor = window.richFixture.editor(id);
  const clipboardData = new DataTransfer();
  editor.view.dom.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
  return { html: clipboardData.getData('text/html'), text: clipboardData.getData('text/plain') };
}, id);

try {
  await server.listen();
  if (electronMode) {
    for (const [entry, file] of [['electron/ipc/domain-handlers.ts', 'domain.cjs'], ['electron/preload.ts', 'preload.cjs']]) {
      await build({ entryPoints: [entry], outfile: path.join(directory, file), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    }
    await writeFile(path.join(directory, 'bootstrap.cjs'), `const {app,BrowserWindow}=require('electron');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=require('node:path').join(__dirname,'workspaces');
process.env.VITE_DEV_SERVER_URL=${JSON.stringify(server.resolvedUrls.local[0])};
app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}});win.loadURL(${JSON.stringify(server.resolvedUrls.local[0] + 'tests/fixtures/documentation-engine.html')});});`);
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete env[key];
    electronApp = await _electron.launch({ args: [path.join(directory, 'bootstrap.cjs')], env });
    page = await electronApp.firstWindow();
  } else {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  }
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(`${currentGroup}: ${error.stack ?? error.message}`));
  page.on('request', request => {
    if (request.url().includes('clipboard.invalid')) resourceRequests.push(request.url());
  });
  if (electronMode) await page.waitForLoadState('domcontentloaded');
  else await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/documentation-engine.html', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.richFixture?.ready());
  assert.equal(await page.evaluate(() => window.richFixture.mode), electronMode ? 'electron' : 'web');

  const parse = source => page.evaluate(source => window.documentationFixture.parse(source), source);
  const serialize = content => page.evaluate(content => window.documentationFixture.serialize(content), content);
  const semantic = value => {
    const copy = structuredClone(value);
    const walk = node => {
      if (node.attrs) {
        delete node.attrs.blockId;
        for (const key of Object.keys(node.attrs)) if (node.attrs[key] === null) delete node.attrs[key];
        if (!Object.keys(node.attrs).length) delete node.attrs;
      }
      if (node.content?.length) node.content.forEach(walk); else delete node.content;
      if (node.marks) {
        node.marks.forEach(mark => { if (mark.attrs) for (const key of Object.keys(mark.attrs)) if (mark.attrs[key] === null) delete mark.attrs[key]; });
        node.marks.sort((a, b) => a.type.localeCompare(b.type));
      }
    };
    walk(copy);
    return copy;
  };
  const nodesOf = (value, type) => {
    const nodes = [];
    const walk = node => { if (node.type === type) nodes.push(node); node.content?.forEach(walk); };
    walk(value); return nodes;
  };
  const command = (name, ...args) => page.evaluate(({ name, args }) => window.richFixture.editor().commands[name](...args), { name, args });
  const selectEnd = () => page.evaluate(() => {
    const editor = window.richFixture.editor();
    editor.commands.setTextSelection(editor.state.selection.constructor.atEnd(editor.state.doc).to);
  });
  const ensureIds = async () => { await command('ensureDocumentationBlockIds'); return (await editorJson()).content.map(node => node.attrs.blockId); };
  const coreMarkdown = '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n\nParagraph **bold** *italic* ~~strike~~ and `code` with [link](https://example.com/docs).\n\n- outer\n  - nested\n\n3. numbered\n4. next\n\n- [x] done\n  - [ ] nested task\n- [ ] pending\n\n> quote\n\n---\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```customLANG\n  a < b\n\n  trailing\n```\n';

  await group('Markdown core semantic round trip retains H1-H6 marks lists tasks tables links code and language', async () => {
    const first = await parse(coreMarkdown), exported = await serialize(first.content), second = await parse(exported.markdown);
    assert.deepEqual(semantic(second.content), semantic(first.content));
    assert.equal(nodesOf(first.content, 'heading').length, 6);
    assert.equal(nodesOf(first.content, 'taskItem').length, 3);
    assert.ok(exported.markdown.includes('| A'));
    assert.equal(nodesOf(second.content, 'codeBlock')[0].attrs.language, 'customLANG');
    assert.equal(nodesOf(second.content, 'codeBlock')[0].content[0].text, '  a < b\n\n  trailing');
    await reset([first.content]); await focus(); assert.deepEqual(semantic(await editorJson()), semantic(first.content));
  });
  await group('Markdown math preserves LaTeX source while currency stays ordinary text', async () => {
    const source = 'Equation $x^2$; costs $5 and $10 today.\n\n$$\n\\frac{a}{b} = c\n$$\n\nInline \\(\\frac{1}{2}\\) and display \\[x+y\\].';
    const first = await parse(source), second = await parse((await serialize(first.content)).markdown);
    assert.deepEqual(semantic(second.content), semantic(first.content));
    assert.equal(nodesOf(first.content, 'inlineMath').length, 2); // display delimiters embedded in prose stay literal
    assert.equal(nodesOf(first.content, 'blockMath')[0].attrs.latex, '\\frac{a}{b} = c');
    await reset([first.content]); await focus();
    assert.ok((await page.evaluate(() => window.richFixture.editor().getText())).includes('$5 and $10'));
    const prices = await parse('Price $5, next $10, final $20. Also $10$ is a price. Sum $5 + $10; costs $1/day and $2/day.');
    assert.equal(nodesOf(prices.content, 'inlineMath').length, 0);
  });
  await group('Markdown file APIs read and write actual .md File and Blob objects', async () => {
    const result = await page.evaluate(async source => {
      const imported = await window.documentationFixture.importFile('sample.MD', source);
      const exported = await window.documentationFixture.exportFile(imported.content, 'sample.md');
      const reopened = await window.documentationFixture.importFile(exported.fileName, exported.markdown);
      let invalid = false;
      try { await window.documentationFixture.importFile('sample.txt', source); } catch { invalid = true; }
      return { imported, exported, reopened, invalid };
    }, coreMarkdown);
    assert.equal(result.exported.fileName, 'sample.md'); assert.equal(result.invalid, true);
    assert.deepEqual(semantic(result.reopened.content), semantic(result.imported.content));
  });
  await group('Markdown HTML fallback retains combined formatting colors alignment and merged multi-paragraph tables', async () => {
    const original = await page.evaluate(() => window.richFixture.parseHtml('<p style="text-align:center"><span style="font-weight:bold;font-style:italic;text-decoration:underline;color:red;font-size:20px">styled</span></p><table><tr><td colspan="2" colwidth="120,140"><p>first</p><p>second</p></td></tr></table>'));
    const exported = await serialize(original), imported = await parse(exported.markdown);
    assert.ok(exported.warnings.some(message => message.includes('HTML')));
    assert.deepEqual(semantic(imported.content), semantic(original));
    assert.equal(nodesOf(imported.content, 'tableCell')[0].content.length, 2);
  });
  await group('Markdown sanitizes embedded HTML and unsafe links without external resource requests', async () => {
    const imported = await parse('<p onclick="alert(1)">safe<script>alert(1)</script><img src="https://clipboard.invalid/x.png" onerror="alert(1)" alt="image"></p>\n\n[unsafe](javascript:alert) and [safe](https://example.com).');
    await reset([imported.content]); await focus(); await frames();
    const rendered = await page.evaluate(() => ({ html: window.richFixture.editor().view.dom.innerHTML, text: window.richFixture.editor().getText() }));
    assert.ok(!rendered.html.includes('onclick=') && !rendered.html.includes('onerror=') && !rendered.html.includes('javascript:'));
    assert.equal(await page.locator('.ProseMirror img[src^="https:"]').count(), 0);
    assert.ok(imported.warnings.length);
    assert.deepEqual(resourceRequests, []);
  });
  await group('Unsupported Markdown JSON recovery retains unknown nodes and marks without truncation', async () => {
    const original = doc([{ type: 'futureDiagram', attrs: { raw: { coordinates: [1, 2], source: 'keep me' } } }, paragraph('known')]);
    const exported = await serialize(original), imported = await parse(exported.markdown);
    assert.ok(exported.markdown.includes('panvas-json')); assert.ok(exported.warnings.length);
    assert.deepEqual(imported.content, original);
    await reset([imported.content]);
    assert.equal(await page.evaluate(() => window.richFixture.editor().isEditable), false);
    await command('insertContent', 'must not replace data'); await frames();
    assert.deepEqual((await page.evaluate(() => window.richFixture.texts()))[0].content, original);
    assert.ok((await page.evaluate(() => window.richFixture.editor().getText())).includes('Unsupported content'));
  });
  await group('Unsupported marks and newer schema metadata protect original content from editor transactions', async () => {
    const content = doc([{ type: 'paragraph', content: [{ type: 'text', text: 'keep', marks: [{ type: 'futureMark', attrs: { payload: 42 } }] }] }]);
    await reset([content]);
    await command('setContent', doc([paragraph('replacement')])); await frames();
    assert.deepEqual((await page.evaluate(() => window.richFixture.texts()))[0].content, content);
    const futureAttributes = doc([{ type: 'paragraph', content: [{ type: 'text', text: 'future attribute', marks: [{ type: 'bold', attrs: { future: 'retain' } }] }] }]);
    await reset([futureAttributes]);
    assert.equal(await page.evaluate(() => window.richFixture.editor().isEditable), false);
    assert.deepEqual((await page.evaluate(() => window.richFixture.texts()))[0].content, futureAttributes);
    const known = doc([paragraph('newer format with known nodes')]);
    await reset([known]);
    await page.evaluate(() => window.documentationFixture.protectVersion(99));
    await page.waitForFunction(() => window.richFixture.editor()?.view.dom.isConnected && !window.richFixture.editor().isEditable);
    await command('setContent', doc([paragraph('must not overwrite')]));
    await page.locator('#fixture-outside').focus(); await frames();
    const stored = (await page.evaluate(() => window.richFixture.texts()))[0];
    assert.deepEqual(stored.content, known); assert.equal(stored.metadata.richTextSchemaVersion, 99);
    assert.equal(await page.evaluate(() => window.richFixture.editor().isEditable), false);
    assert.equal(await command('pasteDocumentationMarkdown', '**unsafe replacement**'), false);
    assert.deepEqual((await page.evaluate(() => window.richFixture.texts()))[0].content, known);
  });
  await group('Legacy positioned text opens and blurs without rewriting its JSON coordinates or metadata', async () => {
    const legacy = doc([paragraph('legacy notebook text'), { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'old heading' }] }]);
    await reset([legacy]); const before = await page.evaluate(() => window.richFixture.texts());
    await focus(); await page.locator('#fixture-outside').focus(); await frames();
    const after = await page.evaluate(() => window.richFixture.texts());
    assert.deepEqual(after[0].content, legacy);
    for (const key of ['x', 'y', 'width', 'rotation', 'layerId', 'createdAt']) assert.deepEqual(after[0][key], before[0][key]);
    assert.equal(await page.evaluate(() => window.richFixture.editor().isEditable), true);
  });
  await group('Stable block IDs are lazy unique persistent and regenerated for duplicate or pasted blocks', async () => {
    await reset([doc([paragraph('first'), paragraph('second')])]); await focus();
    assert.equal((await page.evaluate(() => window.richFixture.texts()))[0].content.content[0].attrs, undefined);
    const ids = await ensureIds(); assert.equal(new Set(ids).size, 2); ids.forEach(id => assert.ok(id));
    assert.equal(await command('duplicateDocumentationBlock', ids[0]), true); await frames();
    const duplicated = await editorJson(), newId = duplicated.content[1].attrs.blockId;
    assert.ok(!ids.includes(newId));
    assert.equal(duplicated.content[0].attrs.blockId, ids[0]);
    assert.equal(await command('undo'), true);
    assert.deepEqual((await editorJson()).content.map(node => node.attrs.blockId), ids);
    assert.equal(await command('redo'), true);
    assert.equal((await editorJson()).content[1].attrs.blockId, newId);
  });
  await group('Core insertion commands insert callout toggle equation divider code and table-of-contents blocks', async () => {
    for (const [type, options] of [['callout', {}], ['details', { headingLevel: 2 }], ['blockMath', { latex: 'x+y' }], ['horizontalRule', {}], ['codeBlock', { language: 'ts' }], ['tableOfContents', {}]]) {
      await reset([doc([paragraph('existing')])]); await focus(); await selectEnd();
      assert.equal(await command('insertDocumentationBlock', type, options), true, type); await frames();
      assert.ok(nodesOf(await editorJson(), type).length, type);
      assert.equal(await command('undo'), true, type); assert.equal(nodesOf(await editorJson(), type).length, 0, type);
      assert.equal(await command('redo'), true, type); assert.ok(nodesOf(await editorJson(), type).length, type);
    }
  });
  await group('Block conversion retains identity text and formatting across headings lists callouts quotes and toggles', async () => {
    for (const type of ['heading', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'callout', 'details']) {
      await reset([doc([{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: 'convert me', marks: [{ type: 'bold' }] }] }])]); await focus();
      const [id] = await ensureIds();
      await command('setTextSelection', { from: 2, to: 5 });
      assert.equal(await command('turnDocumentationBlockInto', type, { id, level: 6 }), true, type);
      const result = await editorJson(); assert.equal(result.content[0].attrs.blockId, id, type);
      assert.equal(result.content[0].type, type, type); assert.ok(findText(result, 'convert me').marks.some(mark => mark.type === 'bold'), type);
      const aligned = [...nodesOf(result, 'paragraph'), ...nodesOf(result, 'heading'), ...nodesOf(result, 'detailsSummary')];
      assert.ok(aligned.some(node => node.attrs.textAlign === 'center'), type);
      assert.equal(await page.evaluate(() => {
        const editor = window.richFixture.editor();
        return editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to);
      }), 'onv', type);
      assert.equal(await command('undo'), true, type);
      assert.equal((await editorJson()).content[0].type, 'paragraph');
      assert.equal((await editorJson()).content[0].attrs.blockId, id);
    }
  });
  await group('Block movement and reordering preserve caret selected text and IDs with one action per undo', async () => {
    await reset([doc([paragraph('alpha'), paragraph('bravo'), paragraph('charlie')])]); await focus();
    const ids = await ensureIds(); await command('setTextSelection', { from: 9, to: 12 });
    const selected = await page.evaluate(() => { const editor = window.richFixture.editor(); return editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to); });
    assert.equal(await command('moveDocumentationBlock', 'up', ids[1]), true);
    assert.deepEqual((await editorJson()).content.map(node => node.attrs.blockId), [ids[1], ids[0], ids[2]]);
    assert.equal(await page.evaluate(() => { const editor = window.richFixture.editor(); return editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to); }), selected);
    assert.equal(await command('undo'), true); assert.deepEqual((await editorJson()).content.map(node => node.attrs.blockId), ids);
    assert.equal(await command('redo'), true);
    assert.equal(await command('reorderDocumentationBlocks', [ids[2], ids[0], ids[1]]), true);
    assert.deepEqual((await editorJson()).content.map(node => node.attrs.blockId), [ids[2], ids[0], ids[1]]);
    assert.equal(await command('undo'), true); assert.deepEqual((await editorJson()).content.map(node => node.attrs.blockId), [ids[1], ids[0], ids[2]]);
  });
  await group('Duplicate containers remap descendant IDs and their internal self references', async () => {
    await reset([doc([{ type: 'callout', attrs: { blockId: 'callout-original' }, content: [
      { type: 'heading', attrs: { level: 2, blockId: 'heading-original' }, content: [{ type: 'text', text: 'target' }] },
      { type: 'paragraph', attrs: { blockId: 'paragraph-original' }, content: [{ type: 'pageReference', attrs: { targetBlockId: 'heading-original', label: 'self link' } }] },
    ] }])]); await focus();
    assert.equal(await command('duplicateDocumentationBlock', 'callout-original'), true);
    const result = await editorJson(), duplicate = result.content[1];
    assert.notEqual(duplicate.attrs.blockId, 'callout-original');
    assert.notEqual(duplicate.content[0].attrs.blockId, 'heading-original');
    assert.equal(duplicate.content[1].content[0].attrs.targetBlockId, duplicate.content[0].attrs.blockId);
    assert.equal(result.content[0].content[1].content[0].attrs.targetBlockId, 'heading-original');
  });
  await group('Native rich paste regenerates block identity and remaps references to copied targets', async () => {
    await reset([doc([
      { type: 'heading', attrs: { blockId: 'copied-heading', level: 2 }, content: [{ type: 'text', text: 'Copied target' }] },
      { type: 'paragraph', attrs: { blockId: 'copied-reference' }, content: [{ type: 'pageReference', attrs: { targetPageId: 'source-page', targetBlockId: 'copied-heading', label: 'Copied link' } }] },
    ])]); await focus(); await command('selectAll');
    const clipboard = await copySelection('rich-text-0');
    await reset(); await paste(clipboard);
    const copied = await editorJson(), heading = nodesOf(copied, 'heading')[0], reference = nodesOf(copied, 'pageReference')[0];
    assert.notEqual(heading.attrs.blockId, 'copied-heading');
    assert.equal(reference.attrs.targetBlockId, heading.attrs.blockId);
    assert.equal(reference.attrs.targetPageId, null);
    assert.equal(await command('undo'), true);
    assert.equal(nodesOf(await editorJson(), 'heading').length, 0);
    assert.equal(await command('redo'), true);
    assert.equal(nodesOf(await editorJson(), 'pageReference')[0].attrs.targetBlockId, heading.attrs.blockId);
  });
  await group('Block delete and undo restore exact node content and stable identity', async () => {
    await reset([doc([paragraph('before'), { type: 'blockMath', attrs: { latex: 'E=mc^2' } }, paragraph('after')])]); await focus();
    const ids = await ensureIds(), before = await editorJson();
    assert.equal(await command('deleteDocumentationBlock', ids[1]), true);
    assert.equal(nodesOf(await editorJson(), 'blockMath').length, 0);
    assert.equal(await command('undo'), true); assert.deepEqual(await editorJson(), before);
    assert.equal(await command('redo'), true); assert.equal(nodesOf(await editorJson(), 'blockMath').length, 0);
  });
  await group('Toggle summary actions resolve the complete toggle and undo restores its structure', async () => {
    await reset([doc([{ type: 'details', attrs: { open: true }, content: [
      { type: 'detailsSummary', content: [{ type: 'text', text: 'Required title' }] },
      { type: 'detailsContent', content: [paragraph('Required body')] },
    ] }])]); await focus(); await ensureIds();
    const before = await editorJson(), summary = before.content[0].content[0].attrs.blockId;
    assert.equal(await command('duplicateDocumentationBlock', summary), true);
    assert.equal(nodesOf(await editorJson(), 'details').length, 2);
    assert.equal(await command('undo'), true); assert.deepEqual(await editorJson(), before);
    assert.equal(await command('deleteDocumentationBlock', summary), true);
    assert.equal(nodesOf(await editorJson(), 'details').length, 0);
    assert.equal(await command('undo'), true); assert.deepEqual(await editorJson(), before);
    assert.equal(await command('moveDocumentationBlock', 'down', summary), false);
    assert.deepEqual(await editorJson(), before);
  });
  await group('Nested code actions retain the code target instead of modifying its callout', async () => {
    await reset([doc([{ type: 'callout', content: [paragraph('Keep this text'), { type: 'codeBlock', attrs: { language: 'rust' }, content: [{ type: 'text', text: 'fn main() {}' }] }] }])]);
    await focus(); await ensureIds(); const before = await editorJson(), code = before.content[0].content[1].attrs.blockId;
    assert.equal(await command('setDocumentationCodeOptions', { wrap: true }, code), true);
    assert.equal((await editorJson()).content[0].content[1].attrs.wrap, true);
    assert.equal(await command('undo'), true); assert.deepEqual(await editorJson(), before);
    assert.equal(await command('deleteDocumentationBlock', code), true);
    assert.equal((await editorJson()).content[0].content[0].content[0].text, 'Keep this text');
    assert.equal(await command('undo'), true); assert.deepEqual(await editorJson(), before);
  });
  await group('Nested list conversions retain descendant identity and backward selections survive movement', async () => {
    const content = (await parse('- parent\n  - nested\n- second')).content;
    await reset([content]); await focus(); const [listId] = await ensureIds();
    const before = await editorJson(), nestedId = nodesOf(before, 'bulletList')[1].attrs.blockId;
    assert.equal(await command('turnDocumentationBlockInto', 'taskList', { id: listId }), true);
    assert.equal(nodesOf(await editorJson(), 'bulletList')[0].attrs.blockId, nestedId);
    assert.equal(await command('undo'), true); assert.deepEqual(await editorJson(), before);
    await reset([doc([paragraph('alpha'), paragraph('bravo')])]); await focus(); const ids = await ensureIds();
    await page.evaluate(() => {
      const editor = window.richFixture.editor();
      const SelectionType = editor.state.selection.constructor;
      editor.view.dispatch(editor.state.tr.setSelection(SelectionType.create(editor.state.doc, 12, 9)));
    });
    assert.equal(await command('moveDocumentationBlock', 'up', ids[1]), true);
    assert.equal(await page.evaluate(() => {
      const selection = window.richFixture.editor().state.selection;
      return selection.anchor > selection.head;
    }), true);
  });
  await group('Block colors and backgrounds are validated persisted and undoable without changing IDs', async () => {
    await reset([doc([paragraph('color')])]); await focus(); const [id] = await ensureIds();
    assert.equal(await command('setDocumentationBlockColor', '#112233', id), true);
    assert.equal(await command('setDocumentationBlockBackground', '#ffeedd', id), true);
    assert.equal(await command('setDocumentationBlockBackground', 'red;background-image:url(https://clipboard.invalid/a)', id), false);
    const before = await editorJson(), reimported = await parse((await serialize(before)).markdown);
    assert.deepEqual(semantic(reimported.content), semantic(before));
    assert.equal(await command('undo'), true); assert.equal((await editorJson()).content[0].attrs.blockBackground, null);
    assert.equal((await editorJson()).content[0].attrs.blockId, id);
  });
  await group('Native collapsible headings keep content IDs state selection and undo in active and static views', async () => {
    await reset([doc([{ type: 'details', attrs: { open: true }, content: [
      { type: 'detailsSummary', attrs: { headingLevel: 2 }, content: [{ type: 'text', text: 'Section' }] },
      { type: 'detailsContent', content: [paragraph('inside')] },
    ] }])]); await focus(); const [id] = await ensureIds();
    await page.locator('.ProseMirror[contenteditable="true"] details summary').click(); await frames();
    const collapsed = await editorJson(); assert.equal(collapsed.content[0].attrs.open, false); assert.equal(collapsed.content[0].attrs.blockId, id);
    assert.ok(nodesOf(collapsed, 'paragraph').some(node => node.content?.[0]?.text === 'inside'));
    await page.evaluate(content => window.richFixture.preview(content), collapsed); await frames();
    assert.equal(await page.locator('#fixture-preview details').evaluate(element => element.open), false);
    assert.equal(await command('undo'), true); assert.equal((await editorJson()).content[0].attrs.open, true);
    assert.equal(await command('toggleDocumentationCollapse', id, false), true);
    assert.equal((await editorJson()).content[0].attrs.blockId, id);
  });
  await group('Inline and block math can be inserted edited and undone with original LaTeX intact', async () => {
    await reset([doc([paragraph('formula ')])]); await focus(); await selectEnd();
    assert.equal(await command('insertInlineMath', { latex: '\\frac{a}{b}' }), true);
    const position = await page.evaluate(() => { let pos; window.richFixture.editor().state.doc.descendants((node, at) => { if (node.type.name === 'inlineMath') pos = at; }); return pos; });
    assert.equal(await command('updateInlineMath', { pos: position, latex: 'x^2+y^2' }), true);
    assert.equal(nodesOf(await editorJson(), 'inlineMath')[0].attrs.latex, 'x^2+y^2');
    await reset([doc([{ type: 'blockMath', attrs: { latex: 'x' } }])]); await focus(); await ensureIds();
    assert.equal(await command('updateBlockMath', { pos: 0, latex: '\\int_0^1 x\\,dx' }), true);
    assert.equal(nodesOf(await editorJson(), 'blockMath')[0].attrs.latex, '\\int_0^1 x\\,dx');
    assert.equal(await command('undo'), true); assert.equal(nodesOf(await editorJson(), 'blockMath')[0].attrs.latex, 'x');
  });
  await group('Active and static KaTeX rendering agree and disallow remote images links and executable math', async () => {
    const content = doc([paragraph('math'), { type: 'blockMath', attrs: { latex: '\\frac{a}{b}+x^2' } },
      { type: 'paragraph', content: [{ type: 'inlineMath', attrs: { latex: '\\href{https://clipboard.invalid/math}{click}\\includegraphics{https://clipboard.invalid/a.png}' } }] }]);
    await reset([content]); await focus();
    await page.evaluate(content => window.richFixture.preview(content), content); await frames();
    const views = await page.evaluate(() => {
      const editor = window.richFixture.editor().view.dom, preview = document.getElementById('fixture-preview');
      return { active: editor.querySelector('[data-type="block-math"] .katex').outerHTML, static: preview.querySelector('[data-type="block-math"] .katex').outerHTML,
        unsafe: [...editor.querySelectorAll('a[href*="clipboard.invalid"], img[src]'), ...preview.querySelectorAll('a[href*="clipboard.invalid"], img[src]')].length };
    });
    assert.equal(views.active, views.static); assert.equal(views.unsafe, 0); assert.deepEqual(resourceRequests, []);
  });
  await group('Rich clipboard recovers source-backed KaTeX and keeps native math callout and toggle structure', async () => {
    const html = '<p>inline <span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html">duplicate rendered math</span></span></p>';
    await reset(); await paste({ html });
    assert.equal(nodesOf(await editorJson(), 'inlineMath')[0].attrs.latex, 'x^2');
    assert.ok(!(await page.evaluate(() => window.richFixture.editor().getText())).includes('duplicate rendered math'));
    const source = doc([{ type: 'callout', attrs: { icon: '!', tone: 'warning' }, content: [paragraph('native callout')] },
      { type: 'details', attrs: { open: false }, content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'Summary' }] }, { type: 'detailsContent', content: [{ type: 'blockMath', attrs: { latex: 'a+b' } }] }] }]);
    await reset([source]); await focus(); await ensureIds(); await command('selectAll');
    const before = await editorJson(), clipboard = await copySelection('rich-text-0');
    await reset(); await paste(clipboard);
    assert.deepEqual(semantic(canonical(await editorJson())), semantic(canonical(before)));
  });
  await group('Explicit Markdown paste replaces only the selected range and preserves native undo redo', async () => {
    await reset([doc([paragraph('before TARGET after')])]); await focus(); await ensureIds();
    await command('setTextSelection', { from: 8, to: 14 });
    assert.equal(await command('pasteDocumentationMarkdown', '**replacement**'), true);
    assert.equal(await page.evaluate(() => window.richFixture.editor().getText()), 'before replacement after');
    assert.ok(findText(await editorJson(), 'replacement').marks.some(mark => mark.type === 'bold'));
    assert.equal(await command('undo'), true); assert.equal(await page.evaluate(() => window.richFixture.editor().getText()), 'before TARGET after');
    assert.equal(await command('redo'), true); assert.equal(await page.evaluate(() => window.richFixture.editor().getText()), 'before replacement after');
  });
  await group('Native Markdown typing rules and explicit math delimiters work without converting currency', async () => {
    await reset(); await focus(); await page.keyboard.type('###### '); await frames();
    assert.equal((await editorJson()).content[0].type, 'heading'); assert.equal((await editorJson()).content[0].attrs.level, 6);
    await reset(); await focus(); await page.keyboard.type('Price $5 and $10'); await frames();
    assert.equal(nodesOf(await editorJson(), 'inlineMath').length, 0);
    await reset(); await focus(); await page.keyboard.type('\\(x^2\\)'); await frames();
    assert.equal(nodesOf(await editorJson(), 'inlineMath')[0].attrs.latex, 'x^2');
  });
  await group('Keyboard block commands move duplicate and convert using the same editor transactions', async () => {
    await reset([doc([paragraph('alpha'), paragraph('bravo')])]); await focus(); const ids = await ensureIds();
    await command('setTextSelection', 9);
    await page.keyboard.press('Control+Alt+ArrowUp'); await frames();
    assert.deepEqual((await editorJson()).content.map(node => node.attrs.blockId), [ids[1], ids[0]]);
    await page.keyboard.press('Control+Shift+D'); await frames();
    assert.equal((await editorJson()).content.length, 3);
    await page.keyboard.press('Control+Alt+6'); await frames(); assert.equal((await editorJson()).content[0].type, 'heading');
  });
  await group('Code language changes preserve whitespace IDs undo and highlighting across supported languages', async () => {
    const cases = [
      ['javascript', 'const value = 42;'], ['typescript', 'let value: number = 42;'],
      ['python', 'def f():\n  return 42'], ['java', 'class Test { int n = 42; }'],
      ['c', 'int main() { return 42; }'], ['cpp', 'std::string value = "text";'],
      ['html', '<div class="test">text</div>'], ['xml', '<item id="42" />'],
      ['css', '.test { color: red; }'], ['sql', 'SELECT id FROM items;'],
      ['json', '{"value":42}'], ['customLANG', 'value = 42;'],
    ];
    for (const [language, source] of cases) {
      const code = '  ' + source + '\n\n';
      await reset([doc([{ type: 'codeBlock', attrs: { language: 'plaintext' }, content: [{ type: 'text', text: code }] }])]); await focus();
      const [id] = await ensureIds(); assert.equal(await command('setDocumentationCodeLanguage', language, id), true);
      const result = await editorJson(); assert.equal(result.content[0].attrs.language, language === 'html' ? 'xml' : language); assert.equal(result.content[0].attrs.blockId, id);
      assert.equal(result.content[0].content[0].text, code);
      await page.evaluate(content => window.richFixture.preview(content), result); await frames();
      const tokens = await page.evaluate(() => {
        const collect = root => [...root.querySelectorAll('pre code span')].map(element => ({ text: element.textContent, className: element.className }));
        return { active: collect(window.richFixture.editor().view.dom), static: collect(document.getElementById('fixture-preview')) };
      });
      assert.deepEqual(tokens.active, tokens.static, language);
      assert.equal(tokens.active.length > 0, language !== 'customLANG', language);
      assert.equal(await command('undo'), true); assert.equal((await editorJson()).content[0].attrs.language, 'plaintext');
    }
  });
  await group('Table of contents derives all six heading levels and stable targets without storing duplicate labels', async () => {
    const content = (await parse('# One\n\n###### Six')).content;
    content.content[0].content.push({ type: 'text', text: ' ' }, { type: 'inlineMath', attrs: { latex: 'x^2' } },
      { type: 'text', text: ' ' }, { type: 'pageReference', attrs: { targetPageId: 'other-page', label: 'Ref' } });
    content.content.push({ type: 'tableOfContents' });
    await reset([content]); await focus(); await ensureIds(); await frames();
    const current = await editorJson(), headings = await page.evaluate(() => window.documentationFixture.headings(window.richFixture.editor().state.doc));
    assert.equal(headings.length, 2); assert.equal(headings[1].level, 6);
    assert.equal(headings[0].title, 'One x^2 Ref');
    assert.equal(await page.locator('.ProseMirror[contenteditable="true"] nav[data-type="table-of-contents"] li').count(), 2);
    assert.equal(nodesOf(current, 'tableOfContents')[0].content, undefined);
    await page.evaluate(content => window.richFixture.preview(content), current); await frames();
    assert.deepEqual(await page.locator('#fixture-preview nav li').allTextContents(), ['One x^2 Ref', 'Six']);
    assert.deepEqual(await page.locator('.ProseMirror[contenteditable="true"] nav[data-type="table-of-contents"] li').allTextContents(), ['One x^2 Ref', 'Six']);
  });
  await group('Internal block links resolve existing editor targets and copying uses the native clipboard API', async () => {
    if (electronMode) await electronApp.evaluate(({ clipboard }) => {
      globalThis.documentationClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage(), bookmark: clipboard.readBookmark() };
    });
    try {
      await reset([doc([paragraph('target'), paragraph('reference')])]); await focus(); const ids = await ensureIds();
      const result = await page.evaluate(async ids => {
        const editor = window.richFixture.editor(), pageId = window.richFixture.engine().getDrawingOwnership().pageId;
        const native = Boolean(window.panvas?.clipboard?.writeText), previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
        let copied = null, cancel;
        if (!native) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
        const completion = new Promise((resolve, reject) => {
          const clean = () => { clearTimeout(timer); document.removeEventListener('panvas:document-command-result', success); document.removeEventListener('panvas:document-command-error', failure); };
          const success = () => { clean(); resolve(); }, failure = () => { clean(); reject(new Error('Block link clipboard write failed.')); };
          const timer = setTimeout(() => { clean(); reject(new Error('Block link clipboard write timed out.')); }, 5000);
          document.addEventListener('panvas:document-command-result', success);
          document.addEventListener('panvas:document-command-error', failure);
          cancel = clean;
        });
        try {
          const copiedOk = editor.commands.copyDocumentationBlockLink(pageId, ids[0]);
          if (copiedOk) await completion; else cancel();
          editor.commands.setTextSelection(editor.state.selection.constructor.atEnd(editor.state.doc).to);
          const inserted = editor.commands.insertDocumentationReference({ targetBlockId: ids[0], label: 'Go to target' });
          return { copied, copiedOk, inserted, pageId, native };
        } finally {
          cancel();
          if (!native) { if (previous) Object.defineProperty(navigator, 'clipboard', previous); else delete navigator.clipboard; }
        }
      }, ids);
      assert.equal(result.native, electronMode); assert.equal(result.copiedOk, true); assert.equal(result.inserted, true);
      const copied = electronMode ? await electronApp.evaluate(({ clipboard }) => clipboard.readText()) : result.copied;
      const url = new URL(copied); assert.equal(url.searchParams.get('panvasPage'), result.pageId); assert.equal(url.searchParams.get('panvasBlock'), ids[0]);
      await page.locator('.ProseMirror[contenteditable="true"] span[data-type="page-reference"]').click(); await frames();
      assert.equal(await page.evaluate(() => window.richFixture.editor().state.selection.$from.parent.textContent), 'target');
    } finally {
      if (electronMode) assert.equal(await electronApp.evaluate(({ clipboard }) => {
        const previous = globalThis.documentationClipboard, { bookmark, ...data } = previous;
        if (bookmark?.title) data.bookmark = bookmark.title;
        clipboard.write(data); delete globalThis.documentationClipboard;
        return clipboard.readText() === previous.text;
      }), true, 'Native clipboard text must be restored.');
    }
  });
  await group('Internal references retain Markdown targets and navigate across real page handoffs', async () => {
    await reset([doc([{ type: 'heading', attrs: { level: 2, blockId: 'md-target' }, content: [{ type: 'text', text: 'Target heading' }] },
      { type: 'paragraph', content: [{ type: 'pageReference', attrs: { targetBlockId: 'md-target', label: 'Target link' } }] },
      { type: 'tableOfContents' }])]); await focus(); await ensureIds();
    const original = await editorJson(), exported = await serialize(original), imported = await parse(exported.markdown);
    assert.equal(nodesOf(imported.content, 'heading')[0].attrs.blockId, 'md-target');
    assert.deepEqual(semantic(imported.content), semantic(original));
    const pageId = await page.evaluate(() => window.richFixture.engine().getDrawingOwnership().pageId);
    await page.evaluate(() => window.richFixture.reload());
    await page.waitForFunction(() => !window.richFixture.ready());
    assert.equal(await page.evaluate(reference => window.documentationFixture.follow(reference), { targetPageId: pageId, targetBlockId: 'md-target' }), true);
    await page.waitForFunction(pageId => window.richFixture.engine().getDrawingOwnership().pageId === pageId
      && window.richFixture.editor()?.isFocused && window.richFixture.editor().state.selection.$from.parent.textContent === 'Target heading', pageId);
    assert.equal((await editorJson()).content[0].attrs.blockId, 'md-target');
    assert.equal(await page.evaluate(() => window.documentationFixture.follow({ targetPageId: '../unsafe' })), false);
  });
  await group('Markdown preserves empty paragraphs headerless tables and image dimensions through HTML fallback', async () => {
    const original = await page.evaluate(() => window.richFixture.parseHtml('<p>before</p><p></p><p></p><table><tr><td><p>no header</p></td></tr></table><div data-type="asset-image" data-file-id="missing-image" data-alt="Sized" data-width="120" data-height="60"></div>'));
    const exported = await serialize(original), imported = await parse(exported.markdown);
    assert.deepEqual(semantic(imported.content), semantic(original));
    assert.equal(nodesOf(imported.content, 'image')[0].attrs.width, 120);
    assert.equal(nodesOf(imported.content, 'tableCell').length, 1);
    assert.equal(nodesOf(imported.content, 'tableHeader').length, 0);
  });
  await group('Native code exit and table gap cursor remain available without automatic legacy rewriting', async () => {
    await reset([doc([{ type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: 'print(42)' }] }])]); await focus();
    await selectEnd(); await page.keyboard.press('Control+Enter'); await frames();
    assert.equal((await editorJson()).content[1].type, 'paragraph');
    await reset([doc([{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('cell')] }] }] }])]); await focus();
    await selectEnd();
    await page.keyboard.press('ArrowDown'); await frames();
    const gap = await page.evaluate(() => {
      const editor = window.richFixture.editor();
      return { type: editor.state.selection.toJSON().type, defaultType: editor.state.schema.nodes.doc.contentMatch.defaultType.name };
    });
    assert.equal(gap.type, 'gapcursor', JSON.stringify(gap));
    await page.keyboard.type('after table'); await frames();
    assert.equal((await editorJson()).content[1].type, 'paragraph');
    assert.equal((await editorJson()).content[1].content[0].text, 'after table');
    assert.equal(nodesOf(await editorJson(), 'tableCell')[0].content[0].content[0].text, 'cell');
  });
  await group('Image nodes preserve local asset IDs or portable source references without fetching external images', async () => {
    const first = await parse('![local](panvas-asset/local-image-id)\n\nText ![remote](https://clipboard.invalid/image.png) end.');
    assert.equal(nodesOf(first.content, 'image')[0].attrs.fileId, 'local-image-id');
    assert.equal(nodesOf(first.content, 'image')[0].attrs.alt, 'local');
    assert.equal(nodesOf(first.content, 'inlineImage')[0].attrs.source, 'https://clipboard.invalid/image.png');
    assert.equal(nodesOf(first.content, 'inlineImage')[0].attrs.alt, 'remote');
    assert.ok(first.warnings.length);
    const exported = await serialize(first.content), second = await parse(exported.markdown);
    assert.deepEqual(semantic(second.content), semantic(first.content));
    await reset([first.content]); await focus(); await frames();
    assert.equal(await page.locator('.ProseMirror img[src^="https:"]').count(), 0);
    assert.deepEqual(resourceRequests, []);
  });
  await group('Existing repository image bytes resolve identically in active and static structural image views', async () => {
    const id = await page.evaluate(() => window.documentationFixture.storeImage(window.richFixture.engine().getDrawingOwnership().pageId));
    const content = doc([{ type: 'image', attrs: { fileId: id, alt: 'local fixture image' } }]);
    await reset([content]); await focus();
    await page.waitForFunction(() => window.richFixture.editor().view.dom.querySelector('img')?.naturalWidth > 0);
    await page.evaluate(content => window.richFixture.preview(content), content);
    await page.waitForFunction(() => document.querySelector('#fixture-preview img')?.naturalWidth > 0);
    assert.equal(await page.locator('#fixture-preview img').getAttribute('alt'), 'local fixture image');
    await page.locator('#fixture-outside').focus(); await frames();
    assert.equal((await page.evaluate(() => window.richFixture.texts())).length, 1);
    assert.equal((await page.evaluate(() => window.richFixture.texts()))[0].content.content[0].attrs.fileId, id);
  });
  await group('Search extraction includes equations image alt text reference labels and collapsed content', async () => {
    const content = doc([{ type: 'blockMath', attrs: { latex: 'searchEquation' } }, { type: 'image', attrs: { fileId: 'missing', alt: 'searchImage' } },
      { type: 'paragraph', content: [{ type: 'pageReference', attrs: { targetBlockId: 'target', label: 'searchReference' } }] },
      { type: 'details', attrs: { open: false }, content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'summary' }] }, { type: 'detailsContent', content: [paragraph('searchCollapsed')] }] }]);
    const value = await page.evaluate(content => window.documentationFixture.search(content), content);
    for (const token of ['searchEquation', 'searchImage', 'searchReference', 'searchCollapsed']) assert.ok(value.includes(token), token);
  });
  await group('All new nodes and IDs persist through actual repository save page handoff and reopen', async () => {
    const content = doc([{ type: 'callout', attrs: { icon: '!', tone: 'warning' }, content: [paragraph('callout')] },
      { type: 'details', attrs: { open: false }, content: [{ type: 'detailsSummary', attrs: { headingLevel: 3 }, content: [{ type: 'text', text: 'Section' }] }, { type: 'detailsContent', content: [paragraph('collapsed content')] }] },
      { type: 'paragraph', content: [{ type: 'inlineMath', attrs: { latex: '\\frac{x}{y}' } }, { type: 'pageReference', attrs: { targetBlockId: 'known-target', label: 'reference' } }] },
      { type: 'blockMath', attrs: { latex: 'x^2' } }, { type: 'image', attrs: { fileId: 'missing-local-image', alt: 'retain missing image' } },
      { type: 'tableOfContents' }, { type: 'codeBlock', attrs: { language: 'customLANG' }, content: [{ type: 'text', text: '  keep\n\n' }] }]);
    await reset([content]); await focus(); await ensureIds();
    const before = await editorJson();
    assert.equal((await page.evaluate(() => window.richFixture.texts()))[0].metadata.richTextSchemaVersion, 3);
    await page.evaluate(() => window.richFixture.reload());
    await page.waitForFunction(() => !window.richFixture.ready());
    await page.waitForFunction(async expected => {
      const stored = await window.richFixture.load();
      return JSON.stringify(stored?.objects?.find(object => object.id === 'rich-text-0')?.content) === JSON.stringify(expected);
    }, before);
    await page.evaluate(() => window.richFixture.returnToPage());
    await page.waitForFunction(() => window.richFixture.ready() && window.richFixture.editor()?.view.dom.isConnected);
    assert.deepEqual(await editorJson(), before);
    assert.equal((await page.evaluate(() => window.richFixture.texts()))[0].metadata.richTextSchemaVersion, 3);
  });
  const output = process.argv.find(argument => argument.startsWith('--out='))?.slice(6) ?? 'artifacts/documentation-stage-2';
  await mkdir(output, { recursive: true });
  const suffix = filter ? '-' + filter.replace(/[^a-z0-9]+/gi, '-') : '';
  await writeFile(`${output}/${baseline ? 'baseline-' : ''}${electronMode ? 'electron' : 'web'}${suffix}.json`, JSON.stringify({ results, errors, resourceRequests }, null, 2));
  assert.ok(results.length > 0, 'the filter must select at least one regression group');
  assert.deepEqual(errors, [], 'no renderer errors');
  const failed = results.filter(result => !result.passed);
  console.log(`${results.length - failed.length}/${results.length} runtime regression groups passed (${electronMode ? 'Electron' : 'browser'})`);
  if (failed.length) throw new AggregateError(failed.map(result => new Error(result.name)), 'Documentation engine regression failures');
} catch (error) {
  console.error({ rendererErrors: errors, fixture: await page?.evaluate(() => ({
    hasPreview: Boolean(document.getElementById('fixture-preview')),
    ready: window.richFixture?.ready(), body: document.body.innerText.slice(0, 500),
  })).catch(() => null) });
  throw error;
} finally {
  await browser?.close(); await electronApp?.close(); await server.close();
}
