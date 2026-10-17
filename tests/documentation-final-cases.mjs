import assert from 'node:assert/strict';
import { clearNotebookHighlight } from './helpers/notebook-formatting.mjs';

const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const legacy = String.raw`\[ T(n)=2T(n/2)+O(n) \]

\[ \boxed{T(n)=O(n\log n)} \]

Inline \(x+1\), price $5 and $10, and unmatched \(source.

Code literal: ` + '`\\(code\\)`';

export async function runDocumentationFinal({ page, phase, mode, out, evidence, createDocument, settle, waitSaved, workload }) {
  const checks = evidence.finalStabilization = {};
  let body;
  const activeBody = async () => page.locator(`#page-${await page.evaluate(() => window.workflowProbe.location().pageId)} [data-document-body]`);
  const json = () => page.evaluate(() => window.workflowProbe.editor().getJSON());
  const paste = async (text, html = '') => {
    await page.evaluate(({ text, html }) => {
      const editor = window.workflowProbe.editor(); editor.commands.focus('start'); editor.commands.selectAll();
      const data = new DataTransfer(); data.setData('text/plain', text); if (html) data.setData('text/html', html);
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, { text, html }); await settle();
  };
  const format = async () => {
    if (!await page.getByRole('button', { name: 'More text formatting', exact: true }).count()) {
      await page.getByTitle('Text (T)', { exact: true }).click();
      await body.locator('p').first().click();
    }
    await page.getByRole('button', { name: 'More text formatting', exact: true }).click();
    return page.getByRole('dialog', { name: 'Text formatting options', exact: true });
  };
  await createDocument('Existing LaTeX compatibility');
  body = await activeBody();
  // Seed legacy content through PM commands, bypassing paste-time conversion.
  // Actual persistence, reopen, conversion and undo use the application paths.
  await page.evaluate(source => {
    const editor = window.workflowProbe.editor();
    editor.commands.insertContent({ type: 'doc', content: source.split('\n\n').map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });
  }, legacy);
  const original = await json(); await waitSaved(original); await page.reload();
  await page.waitForFunction(() => window.workflowProbe?.ready() && Boolean(window.workflowProbe.editor())); await settle();
  assert.deepEqual(await json(), original); assert.equal(await body.locator('.katex').count(), 0);
  checks.legacyReopensLiteral = true;
  const menu = await format(); await menu.getByRole('tab', { name: 'Insert', exact: true }).click();
  await menu.getByRole('button', { name: 'Equation…', exact: true }).click();
  await menu.getByRole('button', { name: 'Convert existing LaTeX', exact: true }).click();
  await menu.getByRole('status').filter({ hasText: 'Undo restores' }).waitFor();
  await page.keyboard.press('Escape'); const converted = await json();
  const math = converted.content.filter(node => node.type === 'blockMath');
  assert.deepEqual(math.map(node => node.attrs.latex), [' T(n)=2T(n/2)+O(n) ', String.raw` \boxed{T(n)=O(n\log n)} `]);
  for (let i = 0; i < 2; i++) assert.equal(math[i].attrs.blockId, original.content[i].attrs.blockId);
  assert.equal(await body.locator('.katex').count(), 3);
  assert.ok(JSON.stringify(converted).includes('$5 and $10')); assert.ok(JSON.stringify(converted).includes('code'));
  await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await json(), original);
  await page.keyboard.press('Control+Shift+z'); await settle(); assert.deepEqual(await json(), converted);
  checks.legacyConversionUndoExact = true;
  await waitSaved(converted); await page.reload(); await page.waitForFunction(() => window.workflowProbe?.ready() && Boolean(window.workflowProbe.editor())); await settle();
  assert.deepEqual(await json(), converted);
  checks.convertedReopenExact = true;
  await page.getByTitle('Text (T)', { exact: true }).click(); await page.waitForFunction(() => window.workflowProbe.editor().isEditable);
  await body.locator('p').first().click({ position: { x: 8, y: 10 } }); await page.waitForFunction(() => window.workflowProbe.editor().isFocused);
  await page.waitForFunction(() => {
    const selection = window.workflowProbe.editor().state.selection;
    return selection.toJSON().type === 'text' && selection.$from.parent.textContent.startsWith('Inline ');
  });
  checks.mathUnselected = await body.locator('[data-type="block-math"]').first().evaluate(root => ({ background: getComputedStyle(root).backgroundColor, margin: getComputedStyle(root).margin, color: getComputedStyle(root.querySelector('.katex')).color }));
  checks.mathSelectionProbe = await page.evaluate(() => {
    const editor = window.workflowProbe.editor(), root = editor.view.dom;
    return { selection: editor.state.selection.toJSON(), selectedText: editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to),
      native: getSelection()?.toString(), focused: editor.isFocused, json: editor.getJSON(),
      paragraphs: [...root.querySelectorAll('p')].map(p => ({ text: p.textContent, bounds: p.getBoundingClientRect().toJSON(), html: p.outerHTML.slice(0, 300) })),
      maths: [...root.querySelectorAll('[data-type="block-math"]')].map(m => ({ classes: m.className, bounds: m.getBoundingClientRect().toJSON() })) };
  });
  assert.equal(checks.mathUnselected.background, 'rgba(0, 0, 0, 0)');
  assert.equal(await body.locator('[data-type="block-math"]').first().evaluate(root => root.classList.contains('ProseMirror-selectednode')), false);
  await page.screenshot({ path: `${out}/${phase}-${mode}-legacy-converted.png` });
  await body.locator('[data-type="block-math"]').first().click(); await settle();
  assert.equal(await body.locator('[data-type="block-math"]').first().evaluate(root => root.classList.contains('ProseMirror-selectednode')), true);
  assert.equal(await body.locator('[data-type="block-math"]').first().evaluate(root => getComputedStyle(root).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: `${out}/${phase}-${mode}-math-selected.png` });
  for (const theme of ['light', 'standard-dark', 'light', 'full-dark']) {
    const target = theme === 'light' ? 'light' : 'dark';
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await page.locator('html').evaluate(root => root.classList.contains('dark') ? 'dark' : root.classList.contains('theme-ink') ? 'ink' : 'light');
      if (current === target) break;
      await page.getByRole('button', { name: /^Switch to .* theme$/ }).click(); await settle();
      const choice = page.getByRole('alertdialog', { name: 'Enable Full Dark View?', exact: true });
      if (await choice.count()) await choice.getByRole('button', { name: theme === 'full-dark' ? 'Full Dark View' : 'Standard Dark', exact: true }).click();
    }
    await body.locator('p').first().click(); await body.locator('[data-type="block-math"]').first().scrollIntoViewIfNeeded(); await settle();
    checks['math-' + theme] = await body.locator('[data-type="block-math"]').first().evaluate(root => ({ classes: document.documentElement.className, background: getComputedStyle(root).backgroundColor, color: getComputedStyle(root.querySelector('.katex')).color, height: root.offsetHeight }));
    assert.equal(checks['math-' + theme].background, 'rgba(0, 0, 0, 0)'); assert.deepEqual(await json(), converted);
    await page.screenshot({ path: `${out}/${phase}-${mode}-math-${theme}.png` });
  }

  await paste('Highlighted equation', '<p>Highlighted <mark style="background-color:#000000">\\(x+1\\)</mark> equation.</p>');
  const marked = await json();
  assert.ok(JSON.stringify(marked).includes('highlight'));
  checks.authorHighlightBeforeClear = await body.locator('[data-type="inline-math"]').evaluate(root => ({ container: getComputedStyle(root).backgroundColor, highlight: getComputedStyle(root.closest('mark')).backgroundColor }));
  assert.deepEqual(checks.authorHighlightBeforeClear, { container: 'rgba(0, 0, 0, 0)', highlight: 'rgb(0, 0, 0)' });
  await page.keyboard.press('Control+a');
  await clearNotebookHighlight(page); await page.keyboard.press('Escape');
  const cleared = await json(); assert.equal(JSON.stringify(cleared).includes('highlight'), false); assert.equal(await body.locator('.katex').count(), 1);
  await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await json(), marked); checks.clearHighlightUndoExact = true;

  await createDocument('SQL and output semantics');
  body = await activeBody();
  const source = "SELECT customer_id, '" + 'long SQL value with preserved spaces '.repeat(30) + "' AS result\nFROM customers\nWHERE id = 42;\n";
  const output = 'customer_id | result\n42 | plain program output\n';
  await paste(source + output, `<pre data-language="sql"><code>${escape(source)}</code></pre><p>Output</p><pre data-language="plaintext"><code>${escape(output)}</code></pre>`);
  const card = body.locator('.panvas-code-block').first();
  const bounds = () => card.locator('pre').evaluate(pre => ({ width: pre.clientWidth, scroll: pre.scrollWidth, height: pre.offsetHeight, text: pre.textContent, whiteSpace: getComputedStyle(pre.querySelector('code')).whiteSpace, pageOverflow: pre.closest('.ProseMirror').scrollWidth > pre.closest('.ProseMirror').clientWidth + 2 }));
  const chooseLanguage = async language => { await card.locator('summary').click(); await page.getByRole('searchbox', { name: 'Search code languages', exact: true }).fill(language); await page.getByRole('option', { name: language, exact: true }).click(); await settle(); };
  checks.sqlWrapOff = await bounds();
  await card.getByRole('button', { name: 'Wrap lines', exact: true }).click(); await settle(); checks.sqlWrapOn = await bounds();
  assert.equal(await card.getByRole('button', { name: 'Wrap lines', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await card.getByRole('button', { name: 'Wrap lines', exact: true }).textContent(), 'Wrap On');
  await chooseLanguage('Plain Text'); assert.equal((await json()).content[0].attrs.wrap, true);
  await chooseLanguage('SQL'); const onJSON = await json();
  await card.scrollIntoViewIfNeeded(); await settle(); await page.screenshot({ path: `${out}/${phase}-${mode}-sql-wrap-on.png` });
  await waitSaved(onJSON); await page.reload();
  await page.waitForFunction(() => window.workflowProbe?.ready() && Boolean(window.workflowProbe.editor())); await settle(); assert.deepEqual(await json(), onJSON);
  assert.equal((await bounds()).whiteSpace, 'pre-wrap');
  await page.getByTitle('Text (T)', { exact: true }).click();
  await card.getByRole('button', { name: 'Wrap lines', exact: true }).click(); await settle();
  await chooseLanguage('Plain Text'); assert.equal((await json()).content[0].attrs.wrap, false); await chooseLanguage('SQL');
  await card.locator('pre').hover(); await page.mouse.wheel(1000, 0); await settle(); assert.ok(await card.locator('pre').evaluate(pre => pre.scrollLeft > 0));
  const offJSON = await json(); await waitSaved(offJSON); await page.reload();
  await page.waitForFunction(() => window.workflowProbe?.ready() && Boolean(window.workflowProbe.editor())); await settle(); assert.deepEqual(await json(), offJSON);
  checks.sqlWrapOffReopened = await bounds();
  assert.ok(checks.sqlWrapOn.height > checks.sqlWrapOff.height * 2); assert.ok(checks.sqlWrapOn.scroll <= checks.sqlWrapOn.width + 2);
  for (const result of [checks.sqlWrapOff, checks.sqlWrapOn, checks.sqlWrapOffReopened]) { assert.equal(result.text, source); assert.equal(result.pageOverflow, false); }
  assert.ok(checks.sqlWrapOffReopened.scroll > checks.sqlWrapOffReopened.width * 2);
  assert.deepEqual(offJSON.content.filter(node => node.type === 'codeBlock').map(node => node.attrs.language), ['sql', 'plaintext']);
  checks.explicitLanguagesPersist = true;
  await card.scrollIntoViewIfNeeded(); await settle(); await page.screenshot({ path: `${out}/${phase}-${mode}-sql-output.png` });
  // Opening the actual font catalog still resolves previews after lazy loading.
  await page.getByTitle('Text (T)', { exact: true }).click();
  await page.waitForFunction(() => window.workflowProbe.editor().isEditable);
  await body.locator('p').filter({ hasText: 'Output' }).click({ position: { x: 8, y: 10 } });
  await page.waitForFunction(() => window.workflowProbe.editor().isFocused);
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
  await settle();
  checks.fontSelectionState = await page.evaluate(() => { const editor = window.workflowProbe.editor(); return { from: editor.state.selection.from, to: editor.state.selection.to, focused: editor.isFocused, editable: editor.isEditable, domSelection: getSelection()?.toString(), active: document.activeElement?.outerHTML.slice(0, 300), editor: editor.view.dom.outerHTML.slice(0, 300) }; });
  checks.fontSelection = await page.evaluate(() => { const { doc, selection } = window.workflowProbe.editor().state; return doc.textBetween(selection.from, selection.to); });
  assert.equal(checks.fontSelection, 'Output');
  const fonts = await format(); await fonts.getByRole('button', { name: 'Text font', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[role="listbox"] [role="option"]')].some(option => option.textContent.includes('JetBrains Mono') && option.getAttribute('aria-disabled') === 'false'));
  await fonts.getByRole('option', { name: /JetBrains Mono/ }).click(); await page.keyboard.press('Escape'); await settle();
  assert.ok(JSON.stringify(await json()).includes('JetBrains Mono')); checks.fontCatalogLoadsOnDemand = true;
  console.log(JSON.stringify({ finalStabilization: mode, checks: Object.keys(checks), sqlHeights: [checks.sqlWrapOff.height, checks.sqlWrapOn.height], sqlWidths: [checks.sqlWrapOff.scroll, checks.sqlWrapOn.scroll] }));
}
