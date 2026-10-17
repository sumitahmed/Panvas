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
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-rich-text-'));
const server = await createServer({ mode: 'web', cacheDir: path.join(directory, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/rich-text-pipeline.html'] }, server: { port: 0, open: false } });
const errors = [], results = [], resourceRequests = [];
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
  // IDs are intentionally regenerated on paste. Their stability is exercised
  // separately by the Stage 2 runtime suite; retain all formatting comparisons.
  const normalize = node => {
    if (node.attrs) {
      delete node.attrs.blockId;
      for (const key of ['blockColor', 'blockBackground']) if (node.attrs[key] === null) delete node.attrs[key];
      if (node.type === 'codeBlock') { if (node.attrs.wrap === false) delete node.attrs.wrap; if (node.attrs.caption === '') delete node.attrs.caption; }
    }
    node.content?.forEach(normalize);
  };
  normalize(copy);
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
app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}});win.loadURL(${JSON.stringify(server.resolvedUrls.local[0] + 'tests/fixtures/rich-text-pipeline.html')});});`);
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete env[key];
    electronApp = await _electron.launch({ args: [path.join(directory, 'bootstrap.cjs')], env });
    page = await electronApp.firstWindow();
  } else {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  }
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('clipboard.invalid')) resourceRequests.push(request.url());
  });
  if (electronMode) await page.waitForLoadState('domcontentloaded');
  else await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/rich-text-pipeline.html', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.richFixture?.ready());
  assert.equal(await page.evaluate(() => window.richFixture.mode), electronMode ? 'electron' : 'web');

  await group('combined CSS formatting survives HTML import as simultaneous marks', async () => {
    const json = await page.evaluate(html => window.richFixture.parseHtml(html), styleHtml);
    const marks = findText(json, 'combined').marks;
    for (const type of ['bold', 'italic', 'underline', 'strike', 'textStyle', 'highlight']) assert.ok(marks.some(mark => mark.type === type), type);
    assert.equal(marks.find(mark => mark.type === 'textStyle').attrs.color, 'rgb(204, 0, 0)');
    assert.equal(marks.find(mark => mark.type === 'textStyle').attrs.fontSize, '20px');
  });
  await group('workspace and active-editor HTML paste retain the same supported structure and language', async () => {
    const html = '<h2>Title</h2>' + styleHtml + '<ul><li>outer<ul><li>inner</li></ul></li></ul><blockquote><p>quote</p></blockquote><hr><table><tr><th>key</th><th>value</th></tr><tr><td>a</td><td>b</td></tr></table>' + codeHtml;
    await reset();
    await paste({ html, text: 'Title combined outer inner quote key value a b print(42)', target: 'workspace' });
    const workspace = await page.evaluate(() => window.richFixture.texts().at(-1).content);
    await reset();
    await paste({ html, text: 'Title combined outer inner quote key value a b print(42)' });
    assert.deepEqual(canonical(await editorJson()), canonical(workspace));
  });
  await group('adjacent prose cannot become a guessed code language', async () => {
    const json = await page.evaluate(() => window.richFixture.parseHtml('<p>warning</p><pre><code>ordinary text</code></pre>'));
    assert.equal(json.content[1].attrs.language, 'plaintext');
  });
  await group('explicit language attributes, aliases, unknown labels and code whitespace survive', async () => {
    for (const [html, language, text] of [
      ['<pre data-language="py"><code>  print(42)\n\n</code></pre>', 'python', '  print(42)\n\n'],
      ['<pre class="lang-js"><code>const x = 1;</code></pre>', 'javascript', 'const x = 1;'],
      ['<pre><code class="language-customLANG">a &lt; b</code></pre>', 'customLANG', 'a < b'],
      ['<pre data-language="constructor"><code>unknown label</code></pre>', 'constructor', 'unknown label'],
      ['<pre data-language="__proto__"><code>unknown label</code></pre>', '__proto__', 'unknown label'],
    ]) {
      await reset(); await paste({ html });
      const node = (await editorJson()).content[0];
      assert.equal(node.attrs.language, language);
      assert.equal(node.content[0].text, text);
    }
  });
  await group('existing fenced-code text paste works in workspace and active editor', async () => {
    await reset(); await paste({ text: fenced, target: 'workspace' });
    const workspace = await page.evaluate(() => window.richFixture.texts().at(-1).content);
    await reset(); await paste({ text: fenced });
    assert.deepEqual(canonical(await editorJson()), canonical(workspace));
    assert.equal((await editorJson()).content[0].attrs.language, 'python');
  });
  await group('mixed fenced paste preserves prose, links and punctuation in both destinations', async () => {
    const text = 'Intro https://example.com/docs.\n\n```py\nprint(42)\n```\n\nEnd.';
    const documents = [];
    for (const target of ['workspace', 'editor']) {
      await reset(); await paste({ text, target });
      const actual = await page.evaluate(target => {
        const id = target === 'workspace' ? window.richFixture.texts().at(-1).id : 'rich-text-0';
        const editor = window.richFixture.editor(id);
        return { json: editor.getJSON(), text: editor.getText() };
      }, target);
      assert.ok(actual.text.includes('https://example.com/docs.'), 'sentence punctuation must remain');
      assert.ok(actual.text.includes('Intro') && actual.text.includes('End.'));
      assert.equal(actual.json.content.find(node => node.type === 'codeBlock').attrs.language, 'python');
      documents.push(canonical(actual.json));
    }
    assert.deepEqual(documents[1], documents[0]);
  });
  await group('HTML paste replaces only the selected range and is one undoable editor action', async () => {
    await reset([doc([paragraph('before TARGET after')])]); await focus();
    await page.evaluate(() => window.richFixture.editor().commands.setTextSelection({ from: 8, to: 14 }));
    await paste({ html: '<span style="font-weight:bold;font-style:italic">replacement</span>', text: 'replacement' });
    assert.equal(await page.evaluate(() => window.richFixture.editor().getText()), 'before replacement after');
    assert.ok(findText(await editorJson(), 'replacement').marks.some(mark => mark.type === 'italic'));
    assert.equal(await page.evaluate(() => window.richFixture.editor().commands.undo()), true);
    assert.equal(await page.evaluate(() => window.richFixture.editor().getText()), 'before TARGET after');
    assert.equal(await page.evaluate(() => window.richFixture.editor().commands.redo()), true);
    assert.equal(await page.evaluate(() => window.richFixture.editor().getText()), 'before replacement after');
  });
  await group('plain-text mode and code-block context preserve literal clipboard text', async () => {
    await reset(); await paste({ html: '<h1>fancy</h1>', text: fenced, plain: true });
    assert.ok(!(await editorJson()).content.some(node => node.type === 'codeBlock' || node.type === 'heading'));
    assert.ok((await page.evaluate(() => window.richFixture.editor().getText())).includes('```python'));
    await reset([doc([{ type: 'codeBlock', attrs: { language: 'plaintext' }, content: [{ type: 'text', text: 'prefix ' }] }])]);
    await focus();
    await page.evaluate(() => window.richFixture.editor().commands.setTextSelection(8));
    await paste({ html: '<h1>fancy</h1>', text: fenced });
    assert.equal((await editorJson()).content[0].type, 'codeBlock');
    assert.equal((await editorJson()).content[0].content[0].text, 'prefix ' + fenced);
  });
  await group('native cross-editor copy/paste keeps open-slice metadata and combined marks', async () => {
    const source = doc([paragraph('prefix '), { type: 'paragraph', content: [{ type: 'text', text: 'formatted', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }] }] }]);
    await reset([source, empty]); await focus();
    const clipboard = await page.evaluate(() => {
      const editor = window.richFixture.editor();
      editor.commands.setTextSelection({ from: 10, to: 19 });
      const clipboardData = new DataTransfer();
      editor.view.dom.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
      return { html: clipboardData.getData('text/html'), text: clipboardData.getData('text/plain') };
    });
    assert.ok(clipboard.html.includes('data-pm-slice'));
    await page.evaluate(() => window.richFixture.editor('rich-text-1').commands.focus());
    await page.evaluate(({ html, text }) => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/html', html); clipboardData.setData('text/plain', text);
      window.richFixture.editor('rich-text-1').view.dom.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    }, clipboard);
    await frames();
    const json = await page.evaluate(() => window.richFixture.editor('rich-text-1').getJSON());
    assert.equal(json.content.length, 1);
    assert.equal(json.content[0].content[0].text, 'formatted');
    assert.equal(json.content[0].content[0].marks.length, 3);
  });
  await group('native whole-document copy preserves formatting, tasks, table widths and language', async () => {
    const source = await page.evaluate(html => window.richFixture.parseHtml(html),
      '<h2 style="text-align:center">Title</h2>' + styleHtml
      + '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li></ul>'
      + '<table><tr><td colwidth="140"><p>cell</p></td></tr></table>' + codeHtml);
    await reset([source]); await focus();
    await page.evaluate(() => window.richFixture.editor().commands.selectAll());
    const before = canonical(await editorJson());
    const clipboard = await copySelection('rich-text-0');
    assert.ok(clipboard.html.includes('data-pm-slice'));
    await reset(); await paste(clipboard);
    assert.deepEqual(canonical(await editorJson()), before);
  });
  await group('native table-cell context survives sanitization and unsafe context attributes are rejected', async () => {
    const source = await page.evaluate(() => window.richFixture.parseHtml('<table><tr><td colwidth="140"><p>first TARGET last</p></td></tr></table>'));
    await reset([source]); await focus();
    await page.evaluate(() => {
      const editor = window.richFixture.editor();
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text.includes('TARGET')) {
          const from = pos + node.text.indexOf('TARGET');
          editor.commands.setTextSelection({ from, to: from + 6 });
        }
      });
    });
    const clipboard = await copySelection('rich-text-0');
    const metadata = await page.evaluate(html => {
      const read = html => new DOMParser().parseFromString(html, 'text/html').querySelector('[data-pm-slice]')?.getAttribute('data-pm-slice');
      return { before: read(html), after: read(window.richFixture.sanitize(html)) };
    }, clipboard.html);
    assert.ok(metadata.before.includes('colwidth'));
    assert.equal(metadata.after, metadata.before);
    await reset(); await paste(clipboard);
    assert.equal(await page.evaluate(() => window.richFixture.editor().getText()), 'TARGET');
    for (const attrs of [
      { align: 'left; background-image:url(https://clipboard.invalid/context.png)' },
      { colwidth: ['140; background-image:url(https://clipboard.invalid/context.png)'] },
    ]) {
      const html = await page.evaluate(attrs => {
        const paragraph = document.createElement('p'); paragraph.textContent = 'safe';
        paragraph.setAttribute('data-pm-slice', '1 1 ' + JSON.stringify(['table', null, 'tableRow', null, 'tableCell', attrs]));
        return paragraph.outerHTML;
      }, attrs);
      const sanitized = await page.evaluate(html => window.richFixture.sanitize(html), html);
      assert.ok(!sanitized.includes('data-pm-slice'), 'unsafe schema attributes cannot be restored from clipboard context');
      await reset(); await paste({ html, text: 'safe' });
      assert.equal(await page.evaluate(() => window.richFixture.editor().getText()), 'safe');
    }
    assert.deepEqual(resourceRequests, []);
  });
  await group('active-editor plain paste retains caret marks and unfinished fences stay literal', async () => {
    await reset([doc([{ type: 'paragraph', content: [{ type: 'text', text: 'start', marks: [{ type: 'bold' }, { type: 'italic' }] }] }])]);
    await focus();
    await page.evaluate(() => window.richFixture.editor().commands.setTextSelection(6));
    await paste({ text: ' continued' });
    const node = (await editorJson()).content[0].content[0];
    assert.equal(node.text, 'start continued');
    assert.deepEqual(node.marks.map(mark => mark.type).sort(), ['bold', 'italic']);
    await reset(); await paste({ text: '```python\nunfinished' });
    assert.ok(!(await editorJson()).content.some(node => node.type === 'codeBlock'));
    await reset(); await paste({ text: '```customLANG\r\na < b\r\n```' });
    assert.equal((await editorJson()).content[0].attrs.language, 'customLANG');
    assert.equal((await editorJson()).content[0].content[0].text, 'a < b');
  });
  await group('active and static syntax tokens match; unknown languages use plaintext', async () => {
    await reset([doc([{ type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: 'print(42)' }] }])]);
    const json = await editorJson();
    await page.evaluate(content => window.richFixture.preview(content), json); await frames();
    const tokens = await page.evaluate(() => {
      const collect = root => [...root.querySelectorAll('pre code span')].map(el => ({ text: el.textContent, className: el.className }));
      return { active: collect(window.richFixture.editor().view.dom), preview: collect(document.getElementById('fixture-preview')) };
    });
    assert.ok(tokens.active.length > 0);
    assert.deepEqual(tokens.preview, tokens.active);
    await reset([doc([{ type: 'codeBlock', attrs: { language: 'customLANG' }, content: [{ type: 'text', text: 'const number = 42;' }] }])]);
    assert.equal(await page.evaluate(() => window.richFixture.editor().view.dom.querySelectorAll('pre code span').length), 0);
  });
  await group('long code Wrap ON and OFF and pasted LaTeX agree in active and real static components', async () => {
    const source='public class LongLine {\n    String value = "'+'long_code_identifier_with_spaces '.repeat(60)+'";\n}\n';
    await reset();
    await paste({html:'<p>Inline \\(n\\).</p><p>\\[ T(n)=3n^2+5n+10 \\]</p><p>\\[ \\boxed{T(n)=O(n^2)} \\]</p><pre><code class="language-java">'+source+'</code></pre>'});
    const active=page.locator('[data-text-object-id="rich-text-0"] .panvas-code-block');
    let offHeight;
    for(const wrap of [false,true]) {
      if(wrap)await active.getByRole('button',{name:'Wrap lines',exact:true}).click();
      const content=await editorJson();await page.evaluate(content=>window.richFixture.preview(content,470),content);await frames();
      const views=await page.evaluate(()=>{
        const collect=root=>{const pre=root.querySelector('pre');return {text:pre.textContent,whiteSpace:getComputedStyle(pre.querySelector('code')).whiteSpace,width:pre.clientWidth,scrollWidth:pre.scrollWidth,height:pre.offsetHeight,math:[...root.querySelectorAll('.katex')].map(math=>({source:math.querySelector('annotation').textContent.trim(),render:math.querySelector('.katex-html').outerHTML}))};};
        return {active:collect(window.richFixture.editor().view.dom),static:collect(document.getElementById('fixture-preview'))};
      });
      for(const view of Object.values(views)){assert.equal(view.text,source);assert.equal(view.whiteSpace,wrap?'pre-wrap':'pre');assert.equal(view.math.length,3);if(wrap)assert.ok(view.scrollWidth<=view.width+2);else assert.ok(view.scrollWidth>view.width*2);}
      assert.deepEqual(views.active.math,views.static.math);assert.deepEqual(await editorJson(),content);
      if(wrap)assert.ok(views.static.height>offHeight*2);else offHeight=views.static.height;
    }
  });
  await group('explicit legacy math conversion preserves marks, block identities and one-step undo', async () => {
    const recurrence = String.raw`\[ T(n)=2T(n/2)+O(n) \]`;
    const source = doc([
      { ...paragraph(recurrence), attrs: { blockId: 'legacy-equation', blockColor: '#123456' } },
      paragraph(String.raw`\[ \boxed{T(n)=O(n\log n)} \]`),
      { type: 'paragraph', content: [{ type: 'text', text: 'Styled ' }, { type: 'text', text: String.raw`\(x+1\)`, marks: [{ type: 'highlight', attrs: { color: '#000000' } }, { type: 'bold' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: String.raw`\(literal\)`, marks: [{ type: 'code' }] }] },
      { type: 'codeBlock', attrs: { language: 'sql' }, content: [{ type: 'text', text: recurrence }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(recurrence)] }] },
      paragraph('Price $5 and $10. Unmatched \\(source'),
    ]);
    await reset([source]); await focus();
    await page.evaluate(() => window.richFixture.editor().commands.ensureDocumentationBlockIds());
    const original = await editorJson();
    assert.equal(await page.evaluate(() => window.richFixture.editor().view.dom.querySelectorAll('.katex').length), 0);
    assert.equal(await page.evaluate(() => window.richFixture.editor().commands.convertExistingNotebookMath()), true); await frames();
    const converted = await editorJson();
    assert.equal(converted.content[0].type, 'blockMath'); assert.equal(converted.content[0].attrs.blockId, 'legacy-equation'); assert.equal(converted.content[0].attrs.blockColor, '#123456');
    const inline = converted.content[2].content[1]; assert.equal(inline.type, 'inlineMath'); assert.deepEqual(inline.marks, original.content[2].content[1].marks);
    for (const i of [3, 4, 5, 6]) assert.deepEqual(converted.content[i], original.content[i]);
    assert.equal(await page.evaluate(() => window.richFixture.editor().commands.convertExistingNotebookMath()), false);
    await page.evaluate(content => window.richFixture.preview(content, 470), converted); await frames();
    const backgrounds = await page.evaluate(() => [...document.querySelectorAll('#fixture-preview .tiptap-mathematics-render')].map(node => getComputedStyle(node).backgroundColor));
    assert.ok(backgrounds.length === 3 && backgrounds.every(color => color === 'rgba(0, 0, 0, 0)'));
    await page.keyboard.press('Control+z'); await frames(); assert.deepEqual(await editorJson(), original);
    await page.keyboard.press('Control+Shift+z'); await frames(); assert.deepEqual(await editorJson(), converted);
    assert.equal(await page.evaluate(() => { const editor = window.richFixture.editor(); editor.setEditable(false); const changed = editor.commands.convertExistingNotebookMath(); editor.setEditable(true); return changed; }), false);
  });
  await group('nested syntax tokens and escaped code are identical in active and static views', async () => {
    for (const [language, text] of [
      ['javascript', 'const greet = name => `hello ${name}`; // greeting'],
      ['python', 'def value(x):\n    return f"value={x}"'],
      ['customLANG', '<script>window.richTextXss=9</script>'],
    ]) {
      await reset([doc([{ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text }] }])]);
      await page.evaluate(content => window.richFixture.preview(content), await editorJson()); await frames();
      const views = await page.evaluate(() => {
        const code = root => {
          const node = root.querySelector('pre code');
          return { text: node.textContent, tokens: [...node.querySelectorAll('span')].map(el => ({ text: el.textContent, className: el.className })) };
        };
        return { active: code(window.richFixture.editor().view.dom), preview: code(document.getElementById('fixture-preview')), xss: window.richTextXss };
      });
      assert.equal(views.active.text, text);
      assert.deepEqual(views.preview, views.active);
      assert.equal(views.xss, undefined);
    }
  });
  await group('sanitization removes executable markup, unsafe URLs and resource-loading styles', async () => {
    const malicious = '<script>window.richTextXss=1</script><p onclick="window.richTextXss=2" style="color:#cc0000;background-image:url(https://clipboard.invalid/style.png)">safe<a href="javascript:window.richTextXss=3">bad</a><img src="https://clipboard.invalid/image.png" onerror="window.richTextXss=4"></p><svg onload="window.richTextXss=5"></svg><iframe src="https://clipboard.invalid/frame"></iframe>';
    const sanitized = await page.evaluate(html => window.richFixture.sanitize(html), malicious);
    assert.ok(!/on(?:click|error|load)=|javascript:|<script|<iframe|<svg|<img|background-image|url\(/i.test(sanitized));
    await reset(); await paste({ html: malicious, text: 'safebad' });
    assert.equal(await page.evaluate(() => window.richTextXss), undefined);
    assert.equal(await page.evaluate(() => window.richFixture.editor().getText()), 'safebad');
    const safe = await page.evaluate(() => window.richFixture.parseHtml('<p><a href="https://example.com/path">link</a></p>'));
    assert.equal(findText(safe, 'link').marks[0].attrs.href, 'https://example.com/path');
    assert.deepEqual(resourceRequests, [], 'sanitized clipboard content initiates no resource loads');
  });
  await group('sanitization fails closed without a DOM parser and preserves safe styled semantic tags', async () => {
    const closed = await page.evaluate(() => {
      const parser = window.DOMParser;
      try { window.DOMParser = undefined; return window.richFixture.sanitize('<img src=x onerror=alert(1)>unsafe'); }
      finally { window.DOMParser = parser; }
    });
    assert.equal(closed, '');
    const json = await page.evaluate(() => window.richFixture.parseHtml(
      '<p><b style="color:#cc0000;font-size:18px;font-style:italic;text-decoration-line:underline line-through">styled</b></p>',
    ));
    const node = findText(json, 'styled');
    assert.ok(['bold', 'italic', 'underline', 'strike', 'textStyle'].every(type => node.marks.some(mark => mark.type === type)));
    assert.equal(node.marks.find(mark => mark.type === 'textStyle').attrs.fontSize, '18px');
  });
  await group('highlight metadata cannot inject CSS and static table widths remain intact', async () => {
    const html = '<p><mark data-color="red; background-image:url(https://clipboard.invalid/mark.png)">safe</mark></p>';
    const sanitized = await page.evaluate(html => window.richFixture.sanitize(html), html);
    assert.ok(!/background-image|url\(/i.test(sanitized), 'highlight metadata is a CSS value, not declarations');
    await reset(); await paste({ html });
    assert.equal(await page.evaluate(() => window.richFixture.editor().view.dom.querySelector('mark').style.backgroundImage), '');
    const source = await page.evaluate(() => window.richFixture.parseHtml('<table><tr><td colwidth="140"><p>cell</p></td></tr></table>'));
    await reset([source]);
    await page.evaluate(content => window.richFixture.preview(content), source); await frames();
    assert.equal(await page.evaluate(() => document.querySelector('#fixture-preview col').style.width), '140px');
    assert.deepEqual(resourceRequests, []);
  });
  await group('divider, empty table, checklist and empty code remain on blur', async () => {
    for (const node of [
      { type: 'horizontalRule' },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('')] }] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph('')] }] },
      { type: 'codeBlock', attrs: { language: 'python' } },
    ]) {
      await reset([doc([node])]); await focus(); await page.locator('#fixture-outside').focus(); await frames();
      assert.equal((await page.evaluate(() => window.richFixture.texts())).length, 1, node.type);
    }
  });
  await group('blank-object cleanup is undoable and preserves object order, bounds and metadata', async () => {
    await reset([doc([paragraph('first')]), empty, doc([paragraph('last')])]);
    const before = await page.evaluate(() => {
      const text = window.richFixture.engine().texts.getTexts()[1];
      text.metadata = { source: 'runtime-fixture', placement: { x: 70, y: 380 } };
      return structuredClone(text);
    });
    await focus('rich-text-1'); await page.locator('#fixture-outside').focus(); await frames();
    assert.equal((await page.evaluate(() => window.richFixture.texts())).length, 2);
    await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click(); await frames();
    const restored = await page.evaluate(() => window.richFixture.texts());
    assert.equal(restored.length, 3);
    assert.deepEqual(restored[1], before);
    await page.locator('#fixture-outside').focus();
    await page.getByRole('button', { name: 'Redo (Ctrl+Y)', exact: true }).click(); await frames();
    assert.equal((await page.evaluate(() => window.richFixture.texts())).length, 2);
  });
  await group('unsupported stored representations remain read-only and are preserved on blur', async () => {
    for (const node of [
      { type: 'image', attrs: { src: 'data:image/png;base64,fixture', alt: 'stored image' } },
      { type: 'inlineMath', attrs: { latex: 'x^2' } },
    ]) {
      const source = doc([paragraph(''), node]);
      await reset([source]);
      assert.equal(await page.evaluate(() => window.richFixture.editor().isEditable), false);
      await page.locator('#fixture-outside').focus(); await frames();
      const texts = await page.evaluate(() => window.richFixture.texts());
      assert.equal(texts.length, 1, node.type);
      assert.deepEqual(texts[0].content, source, 'blur preserves the original payload');
    }
  });
  await group('deferred blur cleanup cannot delete a refocused editor or clear another selection', async () => {
    await reset();
    await page.evaluate(() => {
      const editor = window.richFixture.editor(); editor.commands.focus(); editor.commands.blur(); editor.commands.focus();
    });
    await frames();
    assert.equal((await page.evaluate(() => window.richFixture.texts())).length, 1);
    await reset([empty, doc([paragraph('second')])]); await focus();
    await page.evaluate(() => {
      const engine = window.richFixture.engine();
      engine.selection.select('rich-text-1', 'text');
      window.richFixture.editor('rich-text-1').commands.focus();
    });
    await frames();
    assert.deepEqual(await page.evaluate(() => window.richFixture.engine().selection.getSelectedElements()), [{ id: 'rich-text-1', type: 'text' }]);
  });
  await group('deferred cleanup rechecks content added after blur', async () => {
    await reset(); await focus();
    await page.evaluate(() => {
      const editor = window.richFixture.editor(); editor.commands.blur();
      editor.commands.insertContent({ type: 'horizontalRule' });
    });
    await frames();
    assert.equal((await page.evaluate(() => window.richFixture.texts())).length, 1);
    assert.ok((await editorJson()).content.some(node => node.type === 'horizontalRule'));
  });
  await group('explicit text deletion restores content, bounds, metadata and order on undo and redo', async () => {
    await reset([doc([paragraph('first')]), doc([paragraph('middle')]), doc([paragraph('last')])]);
    const before = await page.evaluate(() => {
      const engine = window.richFixture.engine();
      engine.texts.getTexts()[1].metadata = { source: 'explicit-delete', custom: { value: 42 } };
      engine.tools.setMode('select');
      return structuredClone(engine.texts.getTexts());
    });
    await page.evaluate(() => {
      const engine = window.richFixture.engine();
      engine.selection.select('rich-text-1', 'text'); engine.selection.deleteSelection();
      engine.input.notifyChange();
    }); await frames();
    assert.equal((await page.evaluate(() => window.richFixture.texts())).length, 2);
    await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click(); await frames();
    assert.deepEqual(await page.evaluate(() => window.richFixture.texts()), before);
    await page.getByRole('button', { name: 'Redo (Ctrl+Y)', exact: true }).click(); await frames();
    assert.deepEqual((await page.evaluate(() => window.richFixture.texts())).map(text => text.id), ['rich-text-0', 'rich-text-2']);
  });
  await group('rich formatting and language survive real repository save, page handoff and reopen', async () => {
    await reset(); await paste({ html: styleHtml + codeHtml, text: 'combined print(42)' });
    const before = await editorJson();
    await page.evaluate(() => window.richFixture.reload());
    await page.waitForFunction(() => window.richFixture.engine().getDrawingOwnership().pageId !== undefined && !window.richFixture.ready());
    // Native writes are asynchronous; an earlier reset's blank text object can
    // already exist on disk. Require this revision before testing reopen.
    await page.waitForFunction(async expected => {
      const saved = await window.richFixture.load();
      return JSON.stringify(saved?.objects?.find(object => object.id === 'rich-text-0')?.content) === JSON.stringify(expected);
    }, before);
    const saved = await page.evaluate(() => window.richFixture.load());
    assert.deepEqual(saved.objects.find(object => object.id === 'rich-text-0').content, before);
    await page.evaluate(() => window.richFixture.returnToPage());
    await page.waitForFunction(() => window.richFixture.ready() && window.richFixture.editor()?.view.dom.isConnected);
    assert.deepEqual(await editorJson(), before);
  });
  const output = 'artifacts/rich-text-pipeline';
  await mkdir(output, { recursive: true });
  const suffix = filter ? '-' + filter.replace(/[^a-z0-9]+/gi, '-') : '';
  await writeFile(`${output}/${baseline ? 'baseline-' : ''}${electronMode ? 'electron' : 'web'}${suffix}.json`, JSON.stringify({ results, errors, resourceRequests }, null, 2));
  assert.ok(results.length > 0, 'the filter must select at least one regression group');
  assert.deepEqual(errors, [], 'no renderer errors');
  const failed = results.filter(result => !result.passed);
  console.log(`${results.length - failed.length}/${results.length} runtime regression groups passed (${electronMode ? 'Electron' : 'browser'})`);
  if (failed.length) throw new AggregateError(failed.map(result => new Error(result.name)), 'Rich-text pipeline regression failures');
} catch (error) {
  console.error({ rendererErrors: errors, fixture: await page?.evaluate(() => ({
    hasPreview: Boolean(document.getElementById('fixture-preview')),
    ready: window.richFixture?.ready(), body: document.body.innerText.slice(0, 500),
  })).catch(() => null) });
  throw error;
} finally {
  await browser?.close(); await electronApp?.close(); await server.close();
}
