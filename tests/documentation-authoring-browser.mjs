import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, _electron } from 'playwright';
import { createServer, build as buildWeb } from 'vite';
import react from '@vitejs/plugin-react';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const electronMode = process.argv.includes('--electron'), fileRenderer = electronMode && process.argv.includes('--file-renderer');
const mode = electronMode ? fileRenderer ? 'electron-file' : 'electron' : 'web';
const filter = process.argv.find(argument => argument.startsWith('--filter='))?.slice(9);
const recordingPath = process.argv.find(argument => argument.startsWith('--recorded-document='))?.slice(20);
const nativeCopyNeeded = !filter || ['Copy code uses', 'Ctrl+K edits', 'Shared context commands'].some(name => name.includes(filter));
const out = 'artifacts/documentation-flow'; await mkdir(out, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-authoring-'));
const server = await createServer({ mode: 'web', cacheDir: path.join(directory, 'cache'), optimizeDeps: { entries: ['tests/fixtures/documentation-flow.html'] }, server: { port: 0, open: false } });
const results = [], errors = [], evidence = {};
let browser, app, page;
const source = 'public class Demo {\n  Demo(int value) {\n    System.out.println("value: " + value);\n  }\n}\n\n';
const sample = '<h2><a href="https://example.com/constructor">Example: Parameterized Constructor</a></h2>'
  + '<p>Description with <strong><em><u><s>combined marks</s></u></em></strong>, <code>inline code</code> and <a href="https://example.com/explanation">embedded words</a>.</p>'
  + '<p>java</p><pre><code class="language-java">' + source.replaceAll('<', '&lt;') + '</code></pre>'
  + '<h3>Output:</h3><pre data-language="plaintext"><code>value: 42\n</code></pre>'
  + '<h3>Explanation:</h3><ol><li><p><mark data-color="#ffff00" style="background-color:#ffff00"><span style="color:#cc0000">A formatted explanation</span></mark></p></li></ol>'
  + '<table><tr><th>Input</th><th>Output</th></tr><tr><td>42</td><td>value: 42</td></tr></table><div data-type="block-math" data-latex="x^2+y^2"></div>';
const json = () => page.evaluate(() => window.flowFixture.editor().getJSON());
const frames = () => page.evaluate(async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); });
const canonical = value => {
  const copy = structuredClone(value);
  const color = value => typeof value === 'string' ? value.replace(/#[0-9a-f]{6}/gi, hex => 'rgb(' + [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ') + ')') : value;
  const walk = node => {
    if (node.attrs) { delete node.attrs.blockId; for (const key of ['color', 'blockColor', 'blockBackground']) if (key in node.attrs) node.attrs[key] = color(node.attrs[key]); }
    node.marks?.forEach(walk);
    if (node.content && node.type !== 'codeBlock') node.content = node.content.filter(child => child.type !== 'text' || child.text.trim());
    node.content?.forEach(walk);
  }; walk(copy); return copy;
};
const group = async (name, run) => { if (filter && !name.includes(filter)) return; try { await run(); results.push({ name, passed: true }); console.log('PASS:', name); } catch (error) { results.push({ name, passed: false, error: error.stack }); console.log('FAIL:', name, error.message); } finally { if (page) { const cancel = page.getByRole('dialog', { name: 'Edit link' }).getByRole('button', { name: 'Cancel' }); if (await cancel.count()) await cancel.click(); await page.keyboard.press('Escape'); } } };
const paste = async (html = sample, text = 'Technical documentation') => {
  await page.evaluate(({ html, text }) => {
    const editor = window.flowFixture.editor(); editor.commands.focus('start'); editor.commands.selectAll();
    const data = new DataTransfer(); if (html) data.setData('text/html', html); data.setData('text/plain', text);
    editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    editor.commands.focus('start');
  }, { html, text }); await frames();
};
const selectText = async text => {
  await page.evaluate(text => {
    const editor = window.flowFixture.editor(); let found = false;
    editor.state.doc.descendants((node, pos) => { if (!found && node.isText && node.text.includes(text)) { found = true; const from = pos + node.text.indexOf(text); editor.commands.setTextSelection({ from, to: from + text.length }); } });
    if (!found) throw new Error('Text unavailable: ' + text); editor.commands.focus(); editor.commands.scrollIntoView();
  }, text);
  await page.waitForFunction(() => document.activeElement === window.flowFixture.editor().view.dom);
};
const changeLanguage = async name => {
  await page.locator('[data-document-body] .panvas-code-block').first().locator('summary').click();
  await page.getByRole('searchbox', { name: 'Search code languages' }).fill(name);
  await page.getByRole('option', { name, exact: true }).click(); await frames();
};
const clipboardText = async () => electronMode ? app.evaluate(({ clipboard }) => clipboard.readText()) : page.evaluate(() => navigator.clipboard.readText());
const closeMenu = async () => { await page.keyboard.press('Escape'); await frames(); };
const transformBlock = async (menu, label) => {
  await menu.getByRole('button', { name: 'Turn into…', exact: true }).click();
  await menu.getByRole('searchbox', { name: 'Search block types', exact: true }).fill(label);
  await menu.getByRole('option', { name: label, exact: true }).click(); await frames();
};
const context = async text => {
  await selectText(text);
  await page.locator('[data-document-body]').getByText(text, { exact: true }).first().click({ button: 'right' });
  return page.getByLabel('Document block menu', { exact: true });
};
try {
  if (fileRenderer) {
    await buildWeb({ configFile: false, mode: 'web', base: './', plugins: [react()], worker: { format: 'es' }, resolve: { alias: { '@': path.resolve('src') } }, logLevel: 'warn', build: { outDir: path.join(directory, 'dist'), emptyOutDir: false, rollupOptions: { input: path.resolve('tests/fixtures/documentation-flow.html') } } });
    const html = await readFile(path.join(directory, 'dist/tests/fixtures/documentation-flow.html'), 'utf8');
    await writeFile(path.join(directory, 'dist/index.html'), html.replaceAll('../../assets/', './assets/'));
  }
  else await server.listen();
  const rendererUrl = fileRenderer ? pathToFileURL(path.join(directory, 'dist/index.html')).href : server.resolvedUrls.local[0] + 'tests/fixtures/documentation-flow.html';
  if (electronMode) {
    for (const [entry, file] of [['electron/ipc/domain-handlers.ts', 'domain.cjs'], ['electron/preload.ts', 'preload.cjs']]) await build({ entryPoints: [entry], outfile: path.join(directory, file), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    await writeFile(path.join(directory, 'bootstrap.cjs'), `const {app,BrowserWindow}=require('electron'); app.setPath('userData',require('node:path').join(__dirname,'profile'));process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=require('node:path').join(__dirname,'workspaces');${fileRenderer ? "process.env.APP_ROOT=__dirname;delete process.env.VITE_DEV_SERVER_URL;" : `process.env.VITE_DEV_SERVER_URL=${JSON.stringify(server.resolvedUrls.local[0])};`}app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();new BrowserWindow({show:false,width:1440,height:1200,titleBarStyle:'hidden',titleBarOverlay:true,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}}).loadURL(${JSON.stringify(rendererUrl)});});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
    app = await _electron.launch({ args: [path.join(directory, 'bootstrap.cjs')], env }); page = await app.firstWindow();
    // Keep the user's native clipboard in the main process and restore it after testing copy controls.
    if (nativeCopyNeeded) await app.evaluate(({ clipboard }) => { globalThis.authoringClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage(), bookmark: clipboard.readBookmark() }; });
  } else { browser = await chromium.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 1200 } }); await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); }
  page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  evidence.runtime = electronMode ? await app.evaluate(() => process.versions) : { chromium: browser.version(), node: process.versions.node };
  if (!electronMode) await page.goto(rendererUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.richFixture?.ready());
  await page.getByTitle('Toggle Page Properties', { exact: true }).click();
  await page.getByRole('group', { name: 'Writing layout', exact: true }).getByRole('button', { name: 'Document', exact: true }).click();
  await page.getByTitle('Toggle Page Properties', { exact: true }).click();
  await page.waitForFunction(() => window.flowFixture.editor()?.isEditable);
  await group('Structured HTML retains linked headings, Java source, separate output, prose label, explanations and marks', async () => {
    await paste(); const content = (await json()).content;
    assert.equal(content[0].type, 'heading'); assert.equal(content[0].attrs.level, 2); assert.equal(content[0].content[0].marks[0].attrs.href, 'https://example.com/constructor');
    assert.equal(content[2].content[0].text, 'java'); assert.equal(content[3].type, 'codeBlock'); assert.equal(content[3].attrs.language, 'java'); assert.equal(content[3].content[0].text, source);
    assert.equal(content[4].content[0].text, 'Output:'); assert.equal(content[5].attrs.language, 'plaintext'); assert.equal(content[5].content[0].text, 'value: 42\n');
    assert.equal(content[6].content[0].text, 'Explanation:'); assert.equal(content[7].type, 'orderedList'); assert.equal(content[8].type, 'table'); assert.equal(content[9].type, 'blockMath');
    assert.deepEqual(content[1].content.find(node => node.text === 'combined marks').marks.map(mark => mark.type).sort(), ['bold', 'italic', 'strike', 'underline']);
    assert.ok(content[1].content.find(node => node.text === 'inline code').marks.some(mark => mark.type === 'code'));
    await page.screenshot({ path: `${out}/${mode}-authoring-code.png` });
  });
  await group('Search lists every registered language and active/static Java highlighting matches visible token colors', async () => {
    await paste(); await page.locator('[data-document-body] .panvas-code-block').first().locator('summary').click();
    await page.getByRole('option').first().waitFor();
    const registered = await page.evaluate(() => window.documentationFixture.languages());
    assert.equal(await page.getByRole('option').count(), new Set(['plaintext', ...registered]).size);
    await page.getByRole('searchbox', { name: 'Search code languages' }).fill('C++'); await page.getByRole('option', { name: 'C++', exact: true }).click();
    assert.equal((await json()).content[3].attrs.language, 'cpp'); await changeLanguage('Java');
    await page.evaluate(() => window.richFixture.preview(window.flowFixture.editor().getJSON())); await frames();
    const tokens = await page.evaluate(() => {
      const read = selector => [...document.querySelector(selector).querySelectorAll('pre:first-of-type code [class*="hljs-"]')].map(span => ({ classes: span.className, text: span.textContent, color: getComputedStyle(span).color }));
      return { active: read('[data-document-body]'), static: read('#fixture-preview'), base: getComputedStyle(document.querySelector('[data-document-body] code')).color };
    });
    evidence.javaTokens = tokens;
    evidence.javaDom = await page.locator('[data-document-body] .panvas-code-block').first().evaluate(element => element.outerHTML);
    evidence.javaNode = (await json()).content[3];
    assert.deepEqual(tokens.active, tokens.static); assert.ok(tokens.active.length >= 5); assert.ok(tokens.active.some(token => token.color !== tokens.base));
    await changeLanguage('Plain Text'); assert.equal(await page.locator('[data-document-body] .panvas-code-block').first().locator('[class*="hljs-"]').count(), 0); await changeLanguage('Java');
    await page.locator('[data-document-body] .panvas-code-block').first().locator('summary').click(); await page.getByRole('searchbox', { name: 'Search code languages' }).fill('SQL'); await frames();
    assert.equal(await page.getByRole('searchbox', { name: 'Search code languages' }).inputValue(), 'SQL'); assert.equal(await page.getByRole('option').count(), 1);
    await page.screenshot({ path: `${out}/${mode}-authoring-language-search.png` }); await page.keyboard.press('Escape');
    await paste('<pre data-language="constructor"><code>unknown source</code></pre>'); assert.equal(await page.locator('[data-document-body] summary[aria-label="Code language"]').innerText(), 'constructor');
  });
  await group('Linked inline code retains combined bold italic underline strike color and highlight through clipboard and Markdown', async () => {
    await paste('<h4>Combined inline formatting</h4><p><a href="https://example.com/code"><strong><em><u><s><mark data-color="#ffff00" style="background-color:#ffff00"><span style="color:#cc0000"><code>combined token</code></span></mark></s></u></em></strong></a></p>');
    const before = await json(), marks = before.content[1].content[0].marks;
    assert.deepEqual(marks.map(mark => mark.type).sort(), ['bold', 'code', 'highlight', 'italic', 'link', 'strike', 'textStyle', 'underline']);
    const clipboard = await page.evaluate(() => {
      const editor = window.flowFixture.editor(); editor.commands.selectAll(); const data = new DataTransfer(); editor.view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      return { html: data.getData('text/html'), markdown: window.documentationFixture.serialize(editor.getJSON()).markdown };
    });
    await paste(clipboard.html); assert.deepEqual(canonical(await json()), canonical(before));
    const imported = await page.evaluate(source => window.documentationFixture.parse(source).content, clipboard.markdown); assert.deepEqual(canonical(imported), canonical(before));
    await selectText('combined token'); await page.keyboard.press('Control+k'); const dialog = page.getByRole('dialog', { name: 'Edit link' });
    await dialog.getByRole('textbox', { name: 'Link URL' }).fill('https://example.com/changed-code'); await dialog.getByRole('button', { name: 'Save link' }).click();
    assert.equal((await json()).content[1].content[0].marks.find(mark => mark.type === 'link').attrs.href, 'https://example.com/changed-code');
    assert.equal((await json()).content[1].content[0].marks.length, 8);
    await paste('<pre><code>source code</code></pre>'); await selectText('source code'); const blockBefore = await json(); await page.keyboard.press('Control+k');
    await dialog.getByRole('textbox', { name: 'Link URL' }).fill('https://example.com/code'); await dialog.getByRole('button', { name: 'Save link' }).click();
    await dialog.getByText('Links are unavailable for this selection.', { exact: true }).waitFor(); assert.deepEqual(await json(), blockBefore);
    assert.equal(await dialog.getByRole('textbox', { name: 'Link URL' }).evaluate(element => element === document.activeElement), true); await dialog.getByRole('button', { name: 'Cancel' }).click();
  });
  await group('Copy code uses native clipboard; wrapping and optional caption survive HTML, Markdown and static rendering', async () => {
    await paste(); const code = page.locator('[data-document-body] .panvas-code-block').first();
    await code.getByRole('button', { name: 'Copy code', exact: true }).click(); await code.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    const copiedCode = (await clipboardText()).replaceAll('\r\n', '\n');
    evidence.clipboardFocus = await page.evaluate(() => ({ focus: document.hasFocus(), active: document.activeElement.tagName, scheme: window.location.protocol }));
    evidence.clipboardFocus.systemMatches = copiedCode === source; assert.equal(copiedCode === source, true, 'Copy code must reach the native clipboard.');
    await code.getByRole('button', { name: 'Wrap lines', exact: true }).click(); assert.equal((await json()).content[3].attrs.wrap, true);
    await page.keyboard.press('Control+z'); assert.equal((await json()).content[3].attrs.wrap, false); await page.keyboard.press('Control+Shift+z'); assert.equal((await json()).content[3].attrs.wrap, true);
    await code.getByRole('button', { name: 'Caption', exact: true }).click(); await code.getByRole('textbox', { name: 'Code caption' }).fill('Parameterized constructor — Java');
    await page.keyboard.press('Control+z'); assert.equal((await json()).content[3].attrs.caption, ''); await page.keyboard.press('Control+Shift+z'); assert.equal((await json()).content[3].attrs.caption, 'Parameterized constructor — Java'); await page.keyboard.press('Enter');
    const content = await json(); assert.equal(content.content[3].attrs.caption, 'Parameterized constructor — Java');
    const roundtrip = await page.evaluate(content => {
      const exported = window.documentationFixture.serialize(content), imported = window.documentationFixture.parse(exported.markdown);
      window.richFixture.preview(content);
      const editor = window.flowFixture.editor(); editor.commands.selectAll(); const data = new DataTransfer(); editor.view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      return { markdown: exported.markdown, imported: imported.content, html: data.getData('text/html') };
    }, content); await frames();
    assert.deepEqual(canonical(roundtrip.imported), canonical(content)); assert.ok(roundtrip.html.includes('data-code-caption')); assert.ok(roundtrip.markdown.includes('data-code-wrap="true"'));
    assert.equal(await page.locator('#fixture-preview .panvas-code-caption').innerText(), 'Parameterized constructor — Java');
    assert.equal(await code.locator('code').evaluate(element => getComputedStyle(element).whiteSpace), 'pre-wrap');
    await paste(roundtrip.html); assert.deepEqual(canonical(await json()), canonical(content));
    evidence.captionMarkdown = roundtrip.markdown;
  });
  await group('Code indentation supports native Tab/Shift+Tab and one editor undo', async () => {
    await paste(); await page.evaluate(() => { const editor = window.flowFixture.editor(); editor.state.doc.descendants((node, pos) => { if (node.type.name === 'codeBlock' && node.attrs.language === 'java') editor.commands.setTextSelection(pos + 1); }); editor.commands.focus(); });
    await page.waitForFunction(() => document.activeElement === window.flowFixture.editor().view.dom);
    await page.keyboard.press('Tab'); assert.equal((await json()).content[3].content[0].text, '  ' + source);
    await page.keyboard.press('Control+z'); assert.equal((await json()).content[3].content[0].text, source);
    await page.keyboard.press('Control+Shift+z'); assert.equal((await json()).content[3].content[0].text, '  ' + source);
    await page.keyboard.press('Shift+Tab'); assert.equal((await json()).content[3].content[0].text, source);
  });
  await group('Ctrl+K edits embedded heading and paragraph links while the command palette keeps its outside-editor shortcut', async () => {
    await paste(); await selectText('Parameterized Constructor'); await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Edit link' }); await dialog.waitFor(); assert.equal(await page.evaluate(() => window.richFixture.commandPaletteOpen()), false);
    await dialog.getByRole('textbox', { name: 'Link URL' }).fill('https://example.com/edited'); await dialog.getByRole('button', { name: 'Save link' }).click();
    let content = await json(); assert.equal(content.content[0].attrs.level, 2); assert.equal(content.content[0].content.map(node => node.text).join(''), 'Example: Parameterized Constructor');
    assert.ok(content.content[0].content.some(node => node.marks?.some(mark => mark.attrs?.href === 'https://example.com/edited')));
    await selectText('embedded words'); await page.getByTitle('Edit link (Ctrl+K)', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Copy link', exact: true }).click(); await dialog.getByText('Link copied.', { exact: true }).waitFor(); assert.equal(await clipboardText(), 'https://example.com/explanation');
    await dialog.getByRole('button', { name: 'Remove link', exact: true }).click();
    content = await json(); assert.ok(content.content[1].content.some(node => node.text?.includes('embedded words'))); assert.ok(!content.content[1].content.some(node => node.text?.includes('embedded words') && node.marks?.some(mark => mark.type === 'link')));
    await selectText('Description'); await page.keyboard.press('Control+k'); await dialog.getByRole('textbox', { name: 'Link URL' }).fill('https://example.com/new'); await dialog.getByRole('button', { name: 'Save link' }).click();
    await page.locator('#fixture-outside').focus(); await page.keyboard.press('Control+k'); assert.equal(await page.evaluate(() => window.richFixture.commandPaletteOpen()), true);
    await page.keyboard.press('Control+k'); assert.equal(await page.evaluate(() => window.richFixture.commandPaletteOpen()), false);
    await selectText('Description'); await page.keyboard.press('Control+k'); await page.screenshot({ path: `${out}/${mode}-authoring-link.png` }); await dialog.getByRole('button', { name: 'Cancel' }).click();
  });
  await group('Existing right-click menu converts H1-H6 and toggle headings, duplicates, moves and reverses with native undo/redo', async () => {
    await paste('<p>First block</p><p>Second block</p><p>Third block</p>');
    for (let level = 1; level <= 6; level++) { const menu = await context('Second block'); await transformBlock(menu, `Heading ${level}`); assert.equal((await json()).content[1].attrs.level, level); await closeMenu(); }
    await selectText('Second block'); await page.keyboard.press('Control+Alt+1'); assert.equal((await json()).content[1].attrs.level, 1);
    await page.keyboard.press('Control+Shift+d'); assert.equal((await json()).content.length, 4); await page.keyboard.press('Control+z'); assert.equal((await json()).content.length, 3);
    let menu = await context('Second block'); await menu.getByRole('button', { name: 'Duplicate block', exact: true }).click(); assert.equal((await json()).content.length, 4); await closeMenu();
    const beforeMove = await json(); menu = await context('First block'); await menu.getByRole('button', { name: 'Move block down', exact: true }).click(); assert.equal((await json()).content[1].content[0].text, 'First block'); await closeMenu();
    await page.evaluate(() => window.flowFixture.editor().commands.focus()); await page.keyboard.press('Control+z'); assert.deepEqual(await json(), beforeMove);
    await page.keyboard.press('Control+Shift+z'); assert.equal((await json()).content[1].content[0].text, 'First block'); await page.keyboard.press('Control+z');
    menu = await context('First block'); await transformBlock(menu, 'Toggle heading 4'); menu = await context('First block'); await menu.getByRole('button', { name: 'Collapse / expand', exact: true }).click();
    assert.equal((await json()).content[0].type, 'details'); assert.equal((await json()).content[0].content[0].attrs.headingLevel, 4); assert.equal((await json()).content[0].attrs.open, false);
    await menu.getByRole('button', { name: 'Collapse / expand', exact: true }).click(); assert.equal((await json()).content[0].attrs.open, true);
    await page.screenshot({ path: `${out}/${mode}-authoring-block-menu.png` }); await closeMenu();
  });
  await group('Shared context commands provide lists, quote, callout, block equation, block colors, deletion and block links', async () => {
    for (const type of ['bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'callout', 'details', 'blockMath']) {
      await paste('<p>x+y</p><p>After</p>'); const menu = await context('x+y'); await transformBlock(menu, ({ bulletList: 'Bulleted list', orderedList: 'Numbered list', taskList: 'Checklist', blockquote: 'Quote', codeBlock: 'Code', callout: 'Callout', details: 'Toggle list', blockMath: 'Block equation' })[type]);
      assert.equal((await json()).content[0].type, type); if (type === 'blockMath') assert.equal((await json()).content[0].attrs.latex, 'x+y'); await closeMenu();
    }
    await paste('<p>Color target</p><p>After</p>'); const menu = await context('Color target');
    for (const [name, value] of [['Block text color', '#cc0000'], ['Block background color', '#ffeeaa']]) await menu.getByLabel(name, { exact: true }).fill(value);
    assert.equal((await json()).content[0].attrs.blockColor, '#cc0000'); assert.equal((await json()).content[0].attrs.blockBackground, '#ffeeaa');
    await menu.getByRole('button', { name: 'Copy link to block', exact: true }).click(); await menu.getByText('Block link copied.', { exact: true }).waitFor(); const copied = new URL(await clipboardText());
    assert.equal(copied.searchParams.get('panvasPage'), await page.evaluate(() => window.flowFixture.location().pageId)); assert.equal(copied.searchParams.get('panvasBlock'), (await json()).content[0].attrs.blockId);
    await menu.getByRole('button', { name: 'Delete block', exact: true }).click(); assert.equal((await json()).content.length, 1); await closeMenu();
  });
  await group('Internal links open the existing page/block navigator and linked marks survive HTML and Markdown', async () => {
    await paste(); const target = (await json()).content[0].attrs.blockId;
    await selectText('embedded words'); await page.keyboard.press('Control+k'); const dialog = page.getByRole('dialog', { name: 'Edit link' });
    await dialog.getByText('Link to a Panvas page or block', { exact: true }).click(); await dialog.getByRole('combobox', { name: 'Link target page' }).selectOption(await page.evaluate(() => window.flowFixture.location().pageId));
    await dialog.getByRole('textbox', { name: 'Link target block ID' }).fill(target); await dialog.getByRole('button', { name: 'Save link' }).click();
    const linked = await json(), href = linked.content[1].content.find(node => node.text === 'embedded words').marks.find(mark => mark.type === 'link').attrs.href;
    await page.locator('[data-document-body]').getByText('embedded words', { exact: true }).click(); await frames();
    assert.equal(await page.evaluate(() => window.flowFixture.editor().state.selection.$from.parent.attrs.blockId), target);
    await selectText('embedded words'); await page.keyboard.press('Control+k'); await dialog.getByRole('button', { name: 'Open link', exact: true }).click(); await frames();
    assert.equal(await page.evaluate(() => window.flowFixture.editor().state.selection.$from.parent.attrs.blockId), target); await dialog.getByRole('button', { name: 'Cancel' }).click();
    const imported = await page.evaluate(content => window.documentationFixture.parse(window.documentationFixture.serialize(content).markdown).content, linked);
    assert.deepEqual(canonical(imported), canonical(linked)); assert.ok(href.includes('panvasBlock='));
  });
  await group('Internal file links accept only this renderer with valid page/block IDs', async () => {
    const validation = await page.evaluate(() => {
      const base = 'file:///C:/Panvas/dist/index.html';
      return ['file:///C:/Panvas/dist/index.html?panvasPage=page-1&panvasBlock=block-1', 'file:///C:/Panvas/dist/other.html?panvasPage=page-1', 'file:///C:/Users/private.txt?panvasPage=page-1', 'file:///C:/Panvas/dist/index.html', 'file:///C:/Panvas/dist/index.html?panvasPage=invalid%2Fid', 'javascript:alert(1)'].map(value => Boolean(window.richFixture.safeLink(value, base)));
    });
    assert.deepEqual(validation, [true, false, false, false, false, false]);
    if (electronMode) assert.equal(await page.evaluate(async () => { try { await window.panvas.clipboard.writeText({ invalid: true }); return false; } catch { return true; } }), true);
    if (fileRenderer) {
      await paste('<h2>Local renderer link</h2><p>Open local block</p>'); const content = await json(), location = await page.evaluate(() => window.flowFixture.location());
      const href = await page.evaluate(({ pageId, blockId }) => window.documentationFixture.link(pageId, blockId), { pageId: location.pageId, blockId: content.content[0].attrs.blockId });
      assert.ok(href.startsWith('file:')); await selectText('Open local block'); await page.keyboard.press('Control+k'); const dialog = page.getByRole('dialog', { name: 'Edit link' });
      await dialog.getByRole('textbox', { name: 'Link URL' }).fill(href); await dialog.getByRole('button', { name: 'Save link' }).click();
      const linked = await json(); assert.equal(linked.content[1].content[0].marks[0].attrs.href, href);
      const roundtrip = await page.evaluate(content => window.documentationFixture.parse(window.documentationFixture.serialize(content).markdown).content, linked); assert.deepEqual(canonical(roundtrip), canonical(linked));
      const copied = await page.evaluate(() => { const editor = window.flowFixture.editor(); editor.commands.selectAll(); const data = new DataTransfer(); editor.view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })); return data.getData('text/html'); });
      await paste(copied); assert.equal((await json()).content[1].content[0].marks[0].attrs.href, href);
      await page.screenshot({ path: `${out}/${mode}-authoring-internal-link.png` }); evidence.rendererUrlScheme = 'file:';
    }
  });
  await group('Captured anonymous GitHub/LeetCode source HTML preserves available structure without fabricated metadata', async () => {
    let captures; try { captures = JSON.parse(await readFile(`${out}/public-source-captures.json`, 'utf8')); } catch { captures = []; }
    evidence.publicSources = [];
    for (const capture of captures) {
      if (!capture.html) { evidence.publicSources.push({ name: capture.name, unavailable: capture.unavailable }); continue; }
      const expected = await page.evaluate(html => window.richFixture.parseHtml(html), capture.html);
      await paste(capture.html, capture.text); assert.deepEqual(canonical(await json()), canonical(expected));
      const code = expected.content.filter(node => node.type === 'codeBlock');
      if (capture.name === 'GitHub') {
        assert.ok(code.length >= 3); assert.ok(code.every(node => node.attrs.language === 'xml'), 'Explicit HTML uses the installed XML/HTML grammar.');
        assert.ok(await page.locator('[data-document-body] pre .hljs-name').count(), 'Captured HTML must visibly highlight in the active editor.');
      }
      evidence.publicSources.push({ name: capture.name, url: capture.url, representation: capture.representation, capturedAt: capture.capturedAt, htmlBytes: capture.html.length, blocks: expected.content.length, codeLanguages: code.map(node => node.attrs.language) });
    }
    evidence.unavailablePrivateSources = 'No Notion or ChatGPT clipboard samples were attached. The constructor example is a labelled synthetic clipboard fixture.';
    await paste('', 'Label without language metadata\n  preserve raw text'); assert.ok((await json()).content.every(node => node.type === 'paragraph'));
  });
  await group('Slash commands and inline-code toolbar use the existing editor and undo', async () => {
    await paste('<p></p>'); await page.keyboard.insertText('/Toggle');
    await page.getByRole('option', { name: 'Toggle heading 5', exact: true }).click(); assert.equal((await json()).content[0].type, 'details'); assert.equal((await json()).content[0].content[0].attrs.headingLevel, 5);
    await paste('<p>Inline token</p>'); await selectText('Inline token'); await page.getByRole('button', { name: 'More text formatting', exact: true }).click();
    await page.getByTitle('Inline code', { exact: true }).click(); assert.ok((await json()).content[0].content[0].marks.some(mark => mark.type === 'code')); await closeMenu();
  });
  await group('Author options, links and structured content survive save/page handoff and full Chromium/Electron reopen', async () => {
    await paste(); const code = page.locator('[data-document-body] .panvas-code-block').first(); await code.getByRole('button', { name: 'Wrap lines', exact: true }).click();
    await code.getByRole('button', { name: 'Caption', exact: true }).click(); await code.getByRole('textbox', { name: 'Code caption' }).fill('Saved caption'); await page.keyboard.press('Enter');
    const before = await json(), location = await page.evaluate(() => window.flowFixture.location()); await page.evaluate(() => window.flowFixture.saveTiming());
    await page.evaluate(() => window.richFixture.reload()); await page.evaluate(() => window.richFixture.returnToPage()); await page.waitForFunction(() => window.flowFixture.editor()?.view.dom.isConnected);
    assert.deepEqual(await json(), before);
    const url = rendererUrl + (fileRenderer ? '#' : '?') + new URLSearchParams({ resumeWorkspace: location.workspaceId, resumePage: location.pageId });
    if (electronMode) await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url), url); else await page.goto(url);
    await page.waitForFunction(() => window.richFixture?.ready() && window.flowFixture?.editor()?.view.dom.isConnected); assert.deepEqual(await json(), before);
    await page.getByTitle('Text (T)', { exact: true }).click(); assert.equal(await page.locator('[data-document-body] .panvas-code-caption').first().inputValue(), 'Saved caption');
    await page.screenshot({ path: `${out}/${mode}-authoring-reopened.png` }); evidence.reopenedCanonical = before;
  });
  await group('Wrapped long code and its caption stay inside automatic A4 writing areas', async () => {
    const longSource = Array.from({ length: 120 }, (_, index) => `System.out.println("line ${index}");`).join('\n') + '\n// ' + 'a long wrapped explanation '.repeat(140);
    await paste('<h2>Wrapped Java</h2><pre data-language="java" data-code-wrap="true" data-code-caption="Caption after the final code line"><code>' + longSource + '</code></pre><p>After code</p>');
    await page.waitForFunction(() => Number(document.querySelector('[data-document-sheet-count]').dataset.documentSheetCount) >= 3); await frames();
    const violations = await page.evaluate(() => {
      const root = window.flowFixture.editor().view.dom, origin = document.querySelector('[data-document-body]').getBoundingClientRect(), scale = origin.width / 666, violations = [];
      const check = (rect, text) => { const y = (rect.top - origin.top) / scale + 64, bottom = y + rect.height / scale, sheet = Math.floor(y / 1155); if (y - sheet * 1155 < 63 || bottom - sheet * 1155 > 1060) violations.push({ text, y, bottom }); };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { const text = walker.currentNode; if (!text.textContent.trim() || text.parentElement.closest('.panvas-code-controls,.panvas-page-gap')) continue; const range = document.createRange(); range.selectNodeContents(text); for (const rect of range.getClientRects()) check(rect, text.textContent.slice(0, 35)); }
      check(root.querySelector('.panvas-code-caption').getBoundingClientRect(), 'caption'); return violations;
    });
    assert.deepEqual(violations, []); assert.equal((await json()).content[1].content[0].text, longSource);
    await page.evaluate(() => window.flowFixture.editor().commands.focus('end')); await frames(); await page.screenshot({ path: `${out}/${mode}-authoring-caption-boundary.png` });
  });
  await group('Explicit language casing and derived static code controls preserve code metadata without guessing from prose', async () => {
    for (const metadata of ['class="language-Java"', 'data-language="JAVA"']) {
      await paste('<h2>Case metadata</h2><p>java</p><pre ' + metadata + ' data-code-caption="Source caption"><code>' + source + '</code></pre>');
      const content = await json(); assert.equal(content.content[2].attrs.language, 'java'); assert.equal(content.content[1].content[0].text, 'java');
      assert.ok(await page.locator('[data-document-body] pre .hljs-keyword').count());
      const staticMarkup = await page.evaluate(content => { window.richFixture.preview(content); return content; }, content); await frames();
      const html = await page.locator('#fixture-preview .panvas-document-text').innerHTML();
      await paste(html); assert.deepEqual(canonical(await json()), canonical(staticMarkup));
    }
  });
  await group('Language picker keyboard actions preserve the code caret and avoid document writes when the language is unchanged', async () => {
    await paste();
    const original = await page.evaluate(() => {
      const editor = window.flowFixture.editor(); let position;
      editor.state.doc.descendants((node, pos) => { if (position === undefined && node.type.name === 'codeBlock') position = pos + 12; });
      editor.commands.setTextSelection(position); editor.view.focus();
      window.authoringMenuEvents = { document: 0, pagination: 0 };
      window.authoringMenuListener = ({ transaction }) => { if (transaction.docChanged) window.authoringMenuEvents.document++; if (Object.keys(transaction.meta).some(key => key.includes('panvasDocumentPagination'))) window.authoringMenuEvents.pagination++; };
      editor.on('transaction', window.authoringMenuListener); return { position, json: editor.getJSON() };
    }); await frames();
    const trigger = page.locator('[data-document-body] .panvas-code-language summary').first();
    await trigger.focus(); await page.keyboard.press('Enter'); await page.getByRole('searchbox', { name: 'Search code languages' }).waitFor();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await page.getByRole('searchbox', { name: 'Search code languages' }).fill('Java'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await frames();
    const result = await page.evaluate(() => { const editor = window.flowFixture.editor(); editor.off('transaction', window.authoringMenuListener); return { events: window.authoringMenuEvents, position: editor.state.selection.head, content: editor.getJSON(), focused: document.activeElement === editor.view.dom }; });
    assert.deepEqual(result.content, original.json); assert.equal(result.position, original.position); assert.equal(result.focused, true);
    assert.equal(result.events.document, 0); assert.equal(result.events.pagination, 0); assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  });
  if (recordingPath) await group('Recorded technical document remains readable with table overflow, light/dark code presentation and save/reopen', async () => {
    const capture = JSON.parse((await readFile(recordingPath, 'utf8')).replace(/^\uFEFF/, ''));
    const expected = await page.evaluate(content => window.richFixture.viewContent(content), capture.content);
    await page.evaluate(content => window.richFixture.preview(content, 300), capture.content); await frames();
    const html = await page.locator('#fixture-preview .panvas-document-text').innerHTML(); await paste(html);
    assert.deepEqual(canonical(await json()), canonical(expected));
    const code = page.locator('[data-document-body] .panvas-code-block').first();
    await code.locator('summary').click(); await page.getByRole('searchbox', { name: 'Search code languages' }).fill('Java'); await page.getByRole('option', { name: 'Java', exact: true }).click();
    await code.locator('summary').scrollIntoViewIfNeeded(); await frames();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.richFixture.setTheme(theme), theme); await frames();
      await page.screenshot({ path: `artifacts/documentation-stabilization/${mode}-code-${theme}.png` });
      const geometry = await code.evaluate(root => {
        const bounds = root.getBoundingClientRect(), controls = root.querySelector('.panvas-code-controls').getBoundingClientRect();
        return { bounds: bounds.toJSON(), controls: controls.toJSON(), buttons: [...root.querySelectorAll('.panvas-code-controls button,summary')].map(button => button.getBoundingClientRect().toJSON()) };
      });
      assert.ok(geometry.controls.left >= geometry.bounds.left - 1 && geometry.controls.right <= geometry.bounds.right + 1);
      assert.ok(geometry.buttons.every(rect => rect.width > 0 && rect.left >= geometry.bounds.left - 1 && rect.right <= geometry.bounds.right + 1));
    }
    await page.evaluate(() => window.richFixture.setTheme('light'));
    await selectText('Comparison Summary');
    const region = page.locator('[data-document-body] .tableWrapper').first();
    await region.evaluate(root => root.scrollIntoView({ block: 'center' })); await frames();
    const table = await region.evaluate(root => { const table = root.querySelector('table'), scale = table.getBoundingClientRect().width / table.offsetWidth; return { cells: [...table.rows[0].cells].map(cell => cell.getBoundingClientRect().width / scale), scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }; });
    assert.ok(table.cells.every(width => width >= 119));
    await page.screenshot({ path: `artifacts/documentation-stabilization/${mode}-recorded-table.png` });
    const before = await json(); await page.evaluate(() => window.richFixture.reload()); await page.evaluate(() => window.richFixture.returnToPage()); await page.waitForFunction(() => window.flowFixture.editor()?.view.dom.isConnected);
    assert.deepEqual(await json(), before);
    evidence.recordingSource = capture.provenance; evidence.recordedDocumentTable = table;
  });
} catch (error) { results.push({ name: 'Runner', passed: false, error: error.stack }); console.error(error); }
finally {
  if (app) {
    try { if (nativeCopyNeeded) { evidence.nativeClipboardRestored = await app.evaluate(({ clipboard }) => {
      const previous = globalThis.authoringClipboard;
      if (!previous) return false;
      const { bookmark, ...data } = previous;
      if (bookmark?.title) data.bookmark = bookmark.title;
      clipboard.write(data); delete globalThis.authoringClipboard;
      return clipboard.readText() === previous.text;
    }); if (!evidence.nativeClipboardRestored) errors.push('Native clipboard text was not restored.'); } }
    catch (error) { errors.push('Native clipboard restoration failed: ' + error.message); }
    await app.close();
  }
  if (browser) await browser.close(); await server.close();
  await writeFile(`${out}/${mode}-authoring${filter ? '-focused' : ''}.json`, JSON.stringify({ mode, results, errors, evidence }, null, 2));
}
console.log(`${results.filter(result => result.passed).length}/${results.length} (${mode}); renderer errors ${errors.length}`);
if (results.some(result => !result.passed) || errors.length) process.exitCode = 1;
