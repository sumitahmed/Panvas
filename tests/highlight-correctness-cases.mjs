import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = `<h2>Highlight reference</h2>
<p>Ordinary alpha beta gamma delta. A sentence for exact selections.</p>
<p>Second paragraph keeps its neighboring text intact across multiple lines.</p>
<p><strong>Bold words</strong> + <em>italic words</em> + <a href="https://example.com/reference"><span style="color:#9b1c1c">linked red words</span></a>.</p>
<p><span style="background-color:#000000;color:#cccccc"><strong>Imported black background</strong> with a colored foreground.</span> Plain neighbor.</p>
<p style="background-color:rgb(255,0,0)"><em>Imported red background</em> retains italic styling.</p>
<p><mark data-color="#BFDBFE">Equivalent </mark><mark data-color="rgb(191, 219, 254)">blue colors</mark></p>
<p><span style="font-family:serif">Final ordinary</span> sentence stays unchanged.</p>`;
const colors = { Yellow: '#fff4b8', Green: '#bbf7d0', Blue: '#bfdbfe', Pink: '#fbcfe8', Orange: '#fed7aa', Purple: '#ddd6fe', None: null };

export async function runHighlightCorrectness({ page, app, native, phase, mode, out, evidence, createDocument, settle }) {
  const layout = process.argv.find(arg => arg.startsWith('--highlight-layout='))?.split('=')[1] ?? 'freeform';
  const checks = evidence.highlightCorrectness = { layout, operations: [] };
  const beforeRun = phase === 'before';
  const selectionReplay = process.argv.includes('--highlight-selection-replay');
  const recorded = process.argv.includes('--recorded-content') ? JSON.parse(await readFile('artifacts/highlight-correctness-20261015/recording-document.json', 'utf8')).object : null;
  if (layout === 'document' || process.argv.includes('--fresh-highlight-page')) await createDocument('Highlight correctness', 'A4', layout);
  else await page.waitForFunction(() => window.workflowProbe.ready() && (window.workflowProbe.snapshot().properties.layoutMode ?? 'freeform') === 'freeform');
  const local = page.getByRole('button', { name: 'Continue locally', exact: true });
  if (await local.count()) await local.click();
  let pageId = await page.evaluate(() => window.workflowProbe.location().pageId);
  if (layout === 'freeform') {
    await page.getByTitle('Text (T)', { exact: true }).click();
    const canvas = page.locator(`canvas[data-rendered-page-id="${pageId}"][data-render-ready="true"]`);
    await canvas.waitFor(); await canvas.scrollIntoViewIfNeeded();
    await canvas.click({ position: { x: 150, y: 120 } });
    await page.waitForFunction(() => window.workflowProbe.editor()?.isFocused);
  }
  await page.evaluate(html => {
    const editor = window.workflowProbe.editor(), data = new DataTransfer();
    data.setData('text/html', html); data.setData('text/plain', 'Highlight reference');
    editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, html);
  await settle();
  if (recorded) {
    await page.evaluate(recorded => {
      const engine = window.workflowProbe.engine(), editor = window.workflowProbe.editor(), object = engine.texts.getFocusedText();
      engine.texts.updateTextBounds(object.id, recorded.width, recorded.height); object.rotation = recorded.rotation; object.metadata = recorded.metadata;
      editor.commands.setContent(recorded.content); engine.input.notifyChange();
    }, recorded); await settle();
    if (selectionReplay) {
      // Load the copied object through storage, so its original bounds and
      // rotation are established at mount (rather than inherited from the
      // temporary text box used to create this disposable page).
      await page.evaluate(recorded => {
        const engine = window.workflowProbe.engine(), current = engine.texts.getTexts()[0];
        engine.texts.replaceText({ ...structuredClone(recorded), id: current.id, layerId: current.layerId });
        engine.input.notifyChange();
      }, recorded);
      const revision = await page.evaluate(() => window.workflowProbe.engine().getDrawingOwnership().revision);
      const deadline = performance.now() + 30000;
      while (true) {
        const ready = await page.evaluate(async ({ revision, recorded }) => {
          const saved = await window.workflowProbe.saved(), pageId = window.workflowProbe.location().pageId;
          const writes = window.workflowProbe.writes().filter(write => write.pageId === pageId);
          return writes.some(write => write.complete && write.revision >= revision) && writes.every(write => write.complete)
            && saved?.objects?.some(object => object.width === recorded.width && JSON.stringify(object.content) === JSON.stringify(recorded.content));
        }, { revision, recorded });
        if (ready) break;
        if (performance.now() >= deadline) throw new Error('The copied recording object did not finish saving.');
        await settle();
      }
      await page.reload(); await page.waitForFunction(() => window.workflowProbe?.ready() && Boolean(window.workflowProbe.editor()));
      if (await local.count()) await local.click();
      await page.getByTitle('Text (T)', { exact: true }).click(); await settle();
      checks.loadedObject = await page.evaluate(() => window.workflowProbe.snapshot().texts[0]);
      assert.equal(checks.loadedObject.width, recorded.width);
      assert.deepEqual(checks.loadedObject.content, recorded.content);
    }
  }
  await page.evaluate(() => {
    window.highlightBoundaryTrace = [];
    window.highlightTransactions = [];
    window.highlightViewportFocusCount = 0;
    const read = type => {
      const e = window.workflowProbe.editor(), s = e.state.selection, n = getSelection();
      let nativeRange;
      try { if (n?.anchorNode && n.focusNode && e.view.dom.contains(n.anchorNode) && e.view.dom.contains(n.focusNode)) nativeRange = { anchor: e.view.posAtDOM(n.anchorNode,n.anchorOffset), head: e.view.posAtDOM(n.focusNode,n.focusOffset) }; } catch {}
      window.highlightBoundaryTrace.push({ type, at: performance.now(), pm: { from:s.from,to:s.to }, native: nativeRange, text:n?.toString(), active: document.activeElement?.className,
        viewport: document.querySelector('.notebook-viewport')?.getBoundingClientRect().toJSON(), scrollTop: document.querySelector('.notebook-viewport')?.scrollTop });
      if (window.highlightBoundaryTrace.length > 350) window.highlightBoundaryTrace.shift();
    };
    for (const type of ['pointerdown','pointerup','mousedown','mouseup','click']) document.addEventListener(type,event=>{
      if (event.target instanceof Element && (event.target.closest('.ProseMirror') || event.target.closest('[aria-label="Highlight color"]') || event.target.closest('[role="menuitemradio"]'))) read(type + ':' + (event.target.closest('[aria-label]')?.getAttribute('aria-label') ?? event.target.tagName));
    },true);
    document.addEventListener('selectionchange',()=>read('selectionchange'));
    for (const type of ['focusin','focusout']) document.addEventListener(type,event=>{
      const viewport = event.target instanceof Element && event.target.matches('.notebook-viewport');
      if (type === 'focusin' && viewport) window.highlightViewportFocusCount++;
      read(type+':'+(viewport?'viewport':event.target.tagName));
    },true);
    window.workflowProbe.editor().on('selectionUpdate',()=>read('pm-selection'));
    window.workflowProbe.editor().on('transaction', ({ transaction: tr }) => {
      const editor = window.workflowProbe.editor();
      window.highlightTransactions.push({ at: performance.now(), before: tr.before.toJSON(), after: tr.doc.toJSON(),
        selection: tr.selection.toJSON(), selectionSet: tr.selectionSet, docChanged: tr.docChanged,
        storedMarks: tr.storedMarks?.map(mark => mark.toJSON()), steps: tr.steps.map(step => step.toJSON()),
        meta: Object.fromEntries(Object.entries(tr.meta).map(([key,value]) => [key, value instanceof Event ? value.type : value])),
        editorId: window.workflowProbe.engine().texts.getActiveTextId(), owner: window.workflowProbe.engine().getDrawingOwnership(),
        connected: editor.view.dom.isConnected });
    });
    window.highlightMutations = [];
    window.workflowProbe.engine().onSceneMutation(reason => {
      const engine = window.workflowProbe.engine(), editor = window.workflowProbe.editor();
      window.highlightMutations.push({ reason, revision: engine.getDrawingOwnership().revision, editor: editor.getJSON(), objects: structuredClone(engine.texts.getTexts()) });
      if (window.highlightMutations.length > 25) window.highlightMutations.shift();
    });
  });
  checks.schema = await page.evaluate(() => ({ highlight: window.workflowProbe.editor().schema.marks.highlight.spec.attrs, textStyle: window.workflowProbe.editor().schema.marks.textStyle.spec.attrs }));
  const snapshot = () => page.evaluate(() => {
    const editor = window.workflowProbe.editor(), chars = [], blocks = [], cache = new Map();
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock) blocks.push({ pos, type: node.type.name, attrs: node.attrs });
      if (!node.isText) return;
      for (let i = 0; i < node.text.length; i++) {
        const dom = editor.view.domAtPos(pos + i, 1), element = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node;
        if (!cache.has(element)) {
          let background = 'rgba(0, 0, 0, 0)', current = element;
          while (current && current !== editor.view.dom) {
            const value = getComputedStyle(current).backgroundColor;
            if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') { background = value; break; }
            current = current.parentElement;
          }
          cache.set(element, { background, foreground: getComputedStyle(element).color });
        }
        const highlight = node.marks.find(mark => mark.type.name === 'highlight');
        chars.push({ pos: pos + i, text: node.text[i], highlight: highlight ? highlight.attrs.color ?? 'default' : null,
          marks: node.marks.filter(mark => mark.type.name !== 'highlight').map(mark => mark.toJSON()), ...cache.get(element) });
      }
    });
    const s = editor.state.selection;
    return { chars, blocks, json: editor.getJSON(), selection: { from: s.from, to: s.to, anchor: s.anchor, head: s.head }, nativeSelection: getSelection()?.toString(), focused: editor.isFocused };
  });
  const findRange = (start, end = start) => page.evaluate(({ start, end }) => {
    const editor = window.workflowProbe.editor(), chars = [];
    editor.state.doc.descendants((node, pos) => { if (node.isText) [...node.text].forEach((text, index) => chars.push({ text, pos: pos + index })); });
    const text = chars.map(c => c.text).join(''), first = text.indexOf(start), last = text.indexOf(end, first);
    if (first < 0 || last < 0) throw new Error(`Missing selection text: ${start} / ${end}`);
    const from = chars[first].pos, to = chars[last + end.length - 1].pos + 1;
    const target = editor.view.domAtPos(from).node;
    (target.nodeType === Node.TEXT_NODE ? target.parentElement : target).scrollIntoView({ block: 'nearest' });
    return { from, to };
  }, { start, end });
  let pendingMouseSnapshot;
  const mouseSelect = async (start, end = start, backward = false, fast = false) => {
    const previous = fast ? await snapshot() : null;
    const range = await findRange(start, end); await settle();
    await page.evaluate(({ from, to }) => {
      const view = window.workflowProbe.editor().view, scroller = view.dom.closest('.notebook-viewport'), box = scroller.getBoundingClientRect();
      const a = view.coordsAtPos(from), b = view.coordsAtPos(to);
      if (b.bottom > box.bottom - 24) scroller.scrollTop += b.bottom - box.bottom + 24;
      else if (a.top < box.top + 24) scroller.scrollTop += a.top - box.top - 24;
    }, range); await settle();
    const points = await page.evaluate(({ from, to }) => {
      const view = window.workflowProbe.editor().view, a = view.coordsAtPos(from), b = view.coordsAtPos(to);
      return [{ x: a.left + .1, y: (a.top + a.bottom) / 2 }, { x: b.left + .1, y: (b.top + b.bottom) / 2 }];
    }, range);
    if (selectionReplay) checks.lastMouseStart = await page.evaluate(points => ({ points, targets: points.map(p => document.elementFromPoint(p.x,p.y)?.outerHTML), viewport: document.querySelector('.notebook-viewport')?.getBoundingClientRect().toJSON(), scrollTop: document.querySelector('.notebook-viewport')?.scrollTop }), points);
    if (backward) points.reverse();
    await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: fast ? 1 : 12 }); await page.mouse.up();
    if (fast) { pendingMouseSnapshot = { ...previous, selection: { ...range, anchor: backward ? range.to : range.from, head: backward ? range.from : range.to } }; return range; }
    try { await page.waitForFunction(({ from, to }) => { const s = window.workflowProbe.editor().state.selection; return s.from === from && s.to === to; }, range); }
    catch (error) { checks.mouseFailure = { start, end, range, points, actual: await snapshot(), trace: await page.evaluate(() => window.highlightBoundaryTrace), transactions: await page.evaluate(() => window.highlightTransactions) }; throw error; }
    return range;
  };
  const rgb = color => color ? `rgb(${[1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)).join(', ')})` : 'rgba(0, 0, 0, 0)';
  const normalize = color => color === null || color === 'default' ? color : color.startsWith('#') ? rgb(color) : color;
  const choose = async (label, name) => {
    const before = pendingMouseSnapshot ?? await snapshot(); pendingMouseSnapshot = null;
    const operation = { label, name, range: before.selection, before }; checks.operations.push(operation);
    await page.evaluate(() => { window.highlightTransactions = []; window.highlightBoundaryTrace = []; });
    const trigger = page.getByRole('toolbar', { name: 'Text formatting', exact: true }).getByRole('button', { name: 'Highlight color', exact: true });
    if (selectionReplay) await trigger.locator('svg').click(); else await trigger.click();
    const palette = page.getByRole('menu', { name: 'Highlight color palette', exact: true }); await palette.waitFor();
    operation.open = await snapshot(); operation.openSelection = operation.open.selection;
    operation.checked = await palette.getByRole('menuitemradio', { checked: true }).allTextContents();
    const selectedColors = new Set(before.chars.filter(char => char.pos >= before.selection.from && char.pos < before.selection.to).map(char => normalize(char.highlight)));
    const unambiguous = selectedColors.size === 1 ? [...selectedColors][0] : undefined;
    const expectedChecked = unambiguous === undefined ? [] : Object.keys(colors).filter(name => normalize(colors[name]) === unambiguous);
    operation.statePassed = JSON.stringify(operation.checked) === JSON.stringify(expectedChecked);
    operation.beforeClick = await snapshot();
    const choice = palette.getByRole('menuitemradio', { name, exact: true });
    if (selectionReplay && name !== 'None') await choice.locator('span').click(); else await choice.click();
    operation.immediateAfterClick = await snapshot();
    await palette.waitFor({ state: 'hidden' }); await settle();
    const after = await snapshot(), targetColor = colors[name];
    const differences = [];
    for (let index = 0; index < before.chars.length; index++) {
      const a = before.chars[index], b = after.chars[index], selected = a.pos >= before.selection.from && a.pos < before.selection.to;
      const expected = selected ? targetColor : a.highlight;
      if (!b || b.pos !== a.pos || b.text !== a.text || JSON.stringify(a.marks) !== JSON.stringify(b.marks)
        || normalize(b.highlight) !== normalize(expected) || (selected && b.background !== rgb(targetColor)) || (!selected && b.background !== a.background)) {
        differences.push({ before: a, after: b, expected });
      }
    }
    operation.differences = differences.slice(0, 8); operation.passed = !differences.length && JSON.stringify(before.blocks) === JSON.stringify(after.blocks) && JSON.stringify(before.selection) === JSON.stringify(after.selection);
    operation.afterSelection = after.selection;
    operation.afterJSON = after.json;
    operation.after = after;
    operation.transactions = await page.evaluate(() => window.highlightTransactions);
    operation.boundaryTrace = await page.evaluate(() => window.highlightBoundaryTrace);
    // Keep these select-first cases independent of the optional persistent mode.
    if (await trigger.getAttribute('aria-pressed') === 'true') await page.keyboard.press('Escape');
    if (!selectionReplay) { await page.keyboard.press('ArrowRight'); await settle(); }
    await page.screenshot({ path: `${out}/${phase}-${mode}-${layout}-${label}.png` });
    if (selectionReplay) console.log(JSON.stringify({ label, name, range: operation.range, open: operation.openSelection, after: operation.afterSelection, passed: operation.passed, statePassed: operation.statePassed }));
    if (!beforeRun) { assert.equal(operation.passed, true, JSON.stringify(operation.differences)); assert.equal(operation.statePassed, true, JSON.stringify({ expectedChecked, actual: operation.checked })); }
    return { before, after };
  };
  checks.imported = await snapshot();
  let history;
  if (selectionReplay) {
    const cases = recorded ? [
      ['high-level constructs', 'machine code via LLVM', ['Blue', 'Purple', 'None']],
      ['Memory safety without a garbage collector', 'overflows at compile time.', ['Yellow', 'Purple', 'None']],
      ['Rich type system', 'bugs early.', ['Yellow', 'Purple', 'None']],
      ['Getting started:', 'Getting started:', ['Yellow', 'Purple', 'None']],
    ] : [
      ['A sentence for exact selections.', 'A sentence for exact selections.', ['Yellow', 'Purple', 'None']],
      ['Bold words', 'linked red words', ['Yellow', 'Purple', 'None']],
      ['Imported black background', 'Imported black background', ['Yellow', 'Purple', 'None']],
      ['Imported red background', 'Imported red background', ['Yellow', 'Purple', 'None']],
      ['A sentence', 'neighboring text intact', ['Yellow', 'Purple', 'None']],
    ];
    for (const [start, end, choices] of cases) {
      await mouseSelect(start, end);
      for (const name of choices) history = await choose(`sequence-${checks.operations.length}-${name}`, name);
    }
  } else if (recorded) {
    for (const [start, end, name] of [
      ['without a garbage', 'without a garbage', 'Yellow'],
      ['without a garbage', 'without a garbage', 'Blue'],
      ['without a garbage', 'without a garbage', 'None'],
      ['high-level constructs', 'machine code via LLVM', 'Blue'],
      ['high-level constructs', 'machine code via LLVM', 'None'],
      ['Memory safety without a garbage collector', 'overflows at compile time.', 'Yellow'],
      ['Memory safety without a garbage collector', 'overflows at compile time.', 'None'],
      ['Rich type system', 'bugs early.', 'None'],
      ['Getting started:', 'Getting started:', 'None'],
    ]) {
      await mouseSelect(start, end, false, true); history = await choose('recorded-' + checks.operations.length, name);
    }
    checks.boundaryTrace = await page.evaluate(() => window.highlightBoundaryTrace);
    checks.selectionFocusInterruptions = await page.evaluate(() => window.highlightViewportFocusCount);
    if (!beforeRun) assert.equal(checks.selectionFocusInterruptions, 0);
    const stress = Number(process.argv.find(arg => arg.startsWith('--highlight-stress='))?.split('=')[1] ?? '0');
    for (let index = 0; index < stress; index++) {
      const text = index % 2 ? 'without a garbage' : 'high-level constructs';
      await mouseSelect(text, text, Boolean(index % 2), true); history = await choose('rapid-' + index, index % 3 ? 'None' : 'Blue');
    }
    await mouseSelect('high-level constructs', 'machine code via LLVM', false, true); history = await choose('recorded-persist-green', 'Green');
  } else {
  await mouseSelect('alpha'); await choose('apply-yellow', 'Yellow');
  await mouseSelect('alpha'); await choose('replace-blue', 'Blue');
  await mouseSelect('alpha'); await choose('remove-none', 'None');
  await mouseSelect('beta gamma delta'); await choose('different-word-green', 'Green');
  await mouseSelect('Imported black background'); await choose('imported-black-none', 'None');
  await mouseSelect('Imported red background'); await choose('imported-red-none', 'None');
  await mouseSelect('Equivalent blue colors'); await choose('equivalent-blue-none', 'None');
  await mouseSelect('Final ordinary sentence'); await choose('sentence-pink', 'Pink');
  await mouseSelect('Final ordinary sentence'); await choose('sentence-orange', 'Orange');
  await mouseSelect('Final ordinary sentence'); await choose('sentence-none', 'None');
  await mouseSelect('Final ordinary sentence'); await page.getByRole('button', { name: 'Text color', exact: true }).click();
  const foreground = page.getByRole('menu', { name: 'Text color palette', exact: true });
  assert.equal(await foreground.getByRole('menuitemradio', { name: 'Default', exact: true }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Escape'); await foreground.waitFor({ state: 'hidden' }); checks.defaultForegroundAcrossFonts = true;
  await mouseSelect('A sentence', 'neighboring text intact'); await choose('cross-paragraph-purple', 'Purple');
  await mouseSelect('Bold words', 'linked red words', true); await choose('mixed-marks-blue', 'Blue');
  await mouseSelect('Bold words', 'linked red words', true); history = await choose('mixed-marks-none', 'None');
  }
  await page.keyboard.press('Control+z'); await settle(); const undone = await snapshot();
  await page.keyboard.press('Control+y'); await settle(); const redone = await snapshot();
  checks.undoRedo = JSON.stringify(undone.json) === JSON.stringify(history.before.json) && JSON.stringify(redone.json) === JSON.stringify(history.after.json);
  if (!beforeRun) assert.ok(checks.undoRedo);
  const final = (await snapshot()).json;
  const revision = await page.evaluate(() => window.workflowProbe.engine().getDrawingOwnership().revision);
  const deadline = performance.now() + 30000;
  while (true) {
    const saved = await page.evaluate(async ({ final, revision }) => {
      const saved = await window.workflowProbe.saved(), pageId = window.workflowProbe.location().pageId;
      const writes = window.workflowProbe.writes().filter(write => write.pageId === pageId);
      return writes.some(write => write.complete && write.revision >= revision) && writes.every(write => write.complete)
        && saved.objects.some(object => JSON.stringify(object.content) === JSON.stringify(final));
    }, { final, revision });
    if (saved) break;
    if (performance.now() >= deadline) throw new Error('Latest highlight revision did not finish saving.');
    await settle();
  }
  checks.savedExact = true;
  const persistence = () => page.evaluate(async () => ({ objects: structuredClone(window.workflowProbe.engine().texts.getTexts()), saved: await window.workflowProbe.saved(), mutations: window.highlightMutations, writes: window.workflowProbe.writes() }));
  checks.beforeBlur = await persistence();
  // Blur and reopen the actual persisted page. Read-only rendering is compared
  // against the active view rather than mistaking selection blue for a mark.
  await page.getByTitle('Hand (Space)', { exact: true }).click(); await settle();
  checks.afterBlur = await persistence();
  checks.blurred = await snapshot(); await page.screenshot({ path: `${out}/${phase}-${mode}-${layout}-blurred.png` });
  checks.boundaryTrace = await page.evaluate(() => window.highlightBoundaryTrace);
  checks.selectionFocusInterruptions = await page.evaluate(() => window.highlightViewportFocusCount);
  if (!beforeRun) assert.equal(checks.selectionFocusInterruptions, 0);
  await page.reload(); await page.waitForFunction(() => window.workflowProbe?.ready() && Boolean(window.workflowProbe.editor())); await settle();
  pageId = await page.evaluate(() => window.workflowProbe.location().pageId);
  checks.reopened = await snapshot(); checks.reopenExact = JSON.stringify(checks.reopened.json) === JSON.stringify(final);
  if (!beforeRun) assert.ok(checks.reopenExact, 'Highlight JSON changed after save/reopen');
  {
    await createDocument('Static rendering holder', 'A4', 'freeform');
    await page.getByTitle('Hand (Space)', { exact: true }).click();
    const staticRoot = page.locator(layout === 'freeform' ? `#page-${pageId} [data-stable-page-visual] .ProseMirror` : `#page-${pageId} [data-document-body] .ProseMirror`).first();
    await staticRoot.waitFor({ state: 'attached' }); await staticRoot.scrollIntoViewIfNeeded(); await staticRoot.waitFor({ state: 'visible' });
    assert.notEqual(await page.evaluate(() => window.workflowProbe.location().pageId), pageId, 'The original page must actually be inactive for static-rendering verification');
    const readStatic = () => staticRoot.evaluate(root => {
      const output = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let text;
      while (text = walker.nextNode()) {
        if (text.parentElement.closest('.panvas-code-controls,.panvas-code-caption')) continue;
        let background = 'rgba(0, 0, 0, 0)', element = text.parentElement;
        while (element && element !== root) {
          const value = getComputedStyle(element).backgroundColor;
          if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') { background = value; break; } element = element.parentElement;
        }
        for (let index = 0; index < text.textContent.length; index++) output.push({ text: text.textContent[index], background });
      }
      return output;
    });
    const liveChars = checks.reopened.chars.map(({ text, background }) => ({ text, background }));
    const staticStarted = performance.now(); let staticChars = await readStatic();
    while (JSON.stringify(staticChars) !== JSON.stringify(liveChars) && performance.now() - staticStarted < 5000) { await settle(); staticChars = await readStatic(); }
    checks.staticWaitMs = performance.now() - staticStarted;
    checks.staticMatchesActive = JSON.stringify(staticChars) === JSON.stringify(liveChars);
    checks.staticLengths = { live: liveChars.length, inactive: staticChars.length };
    checks.staticDifferences = liveChars.flatMap((char,index) => JSON.stringify(char) === JSON.stringify(staticChars[index]) ? [] : [{ index, live:char, inactive:staticChars[index] }]).slice(0,8);
    if (!beforeRun) assert.ok(checks.staticMatchesActive, 'Active and actual static-preview backgrounds disagree');
    await page.screenshot({ path: `${out}/${phase}-${mode}-${layout}-static.png` });
  }
  await page.screenshot({ path: `${out}/${phase}-${mode}-${layout}-reopened.png` });
  console.log(JSON.stringify({ mode, layout, operations: checks.operations.map(({ label, passed }) => ({ label, passed })), undoRedo: checks.undoRedo, reopenExact: checks.reopenExact }));
}
