import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, _electron } from 'playwright';
import { preview } from 'vite';

// Production-build UI test for persistent text highlighting. No formatting commands are called directly.
// Only disposable profiles are used. All formatting is selected through UI clicks.
const native = process.argv.includes('--electron'), mode = native ? 'electron' : 'web';
const phase = process.argv.includes('--before') ? 'before' : 'after';
const out = process.argv.find(argument => argument.startsWith('--out='))?.slice(6) ?? 'artifacts/text-highlight-mode-20261015/production';
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-highlight-production-'));
await mkdir(out, { recursive: true });
let buildRoot = path.resolve('.');
if (process.argv.includes('--baseline-build')) {
  const baseline=JSON.parse(await readFile('artifacts/text-highlight-mode-20261015/baseline-location.json','utf8'));
  buildRoot=path.join(directory,'app');await cp(path.join(baseline.backup,'generated'),buildRoot,{recursive:true});
  await writeFile(path.join(buildRoot,'package.json'),JSON.stringify({name:'panvas',version:'0.1.7',type:'module',main:'dist-electron/main.js'}));
  await symlink(path.resolve('node_modules'),path.join(buildRoot,'node_modules'),'junction');
}
const recorded = JSON.parse(await readFile('artifacts/highlight-correctness-20261015/recording-document.json', 'utf8')).object;
const evidence = { mode, phase, directory, operations: [], errors: [] };
let app, browser, server, page;
const settle = () => page.evaluate(async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); });
const installObserver = async () => page.evaluate(() => {
  const engine = () => {
    for (const el of document.querySelectorAll('[data-text-object-id],canvas[data-rendered-page-id]')) {
      const key = Object.keys(el).find(key => key.startsWith('__reactFiber$'));
      for (let fiber = el[key]; fiber; fiber = fiber.return) {
        const candidate = fiber.memoizedProps?.engine ?? fiber.memoizedProps?.notebookEngine;
        if (candidate?.texts && candidate?.getDrawingOwnership) return candidate;
      }
    }
  };
  const editor = () => [...document.querySelectorAll('.tiptap')].map(el => el.editor).find(e => e?.view.dom.isConnected && e.isEditable);
  window.highlightApp = { engine, editor, transactions: [], events: [], read: () => {
    const e = editor(), s = e?.state.selection;
    return { selection: s?.toJSON(), json: e?.getJSON(), native: getSelection()?.toString(),
      viewport: document.querySelector('.notebook-viewport')?.getBoundingClientRect().toJSON(),
      owner: engine()?.getDrawingOwnership(), editorId: e?.view.dom.closest('[data-text-object-id]')?.dataset.textObjectId,
      scrollTop: document.querySelector('.notebook-viewport')?.scrollTop,
      editors: engine()?.texts.getTexts().map(t => ({ id: t.id, content: t.content })),
      active: document.activeElement?.className };
  } };
  for (const type of ['pointerdown','mousedown','focusin','focusout','selectionchange','mouseup','click']) {
    document.addEventListener(type, event => {
      window.highlightApp.events.push({ type, at: performance.now(), target: event.target instanceof Element ? event.target.tagName : null, ...window.highlightApp.read() });
    }, true);
  }
  const observe = () => {
    for (const dom of document.querySelectorAll('.tiptap')) {
      const e = dom.editor; if (!e || e.highlightObserved) continue; e.highlightObserved = true;
      e.on('transaction', ({ transaction: tr }) => window.highlightApp.transactions.push({ at: performance.now(),
        before: tr.before.toJSON(), after: tr.doc.toJSON(), selection: tr.selection.toJSON(),
        steps: tr.steps.map(step => step.toJSON()), docChanged: tr.docChanged, selectionSet: tr.selectionSet,
        storedMarks: tr.storedMarks?.map(mark => mark.toJSON()), metaKeys: Object.keys(tr.meta),
        editorId: dom.closest('[data-text-object-id]')?.dataset.textObjectId,
        owner: engine()?.getDrawingOwnership() }));
    }
  };
  observe(); new MutationObserver(observe).observe(document.body, { childList: true, subtree: true });
});
const read = () => page.evaluate(() => window.highlightApp.read());
const chars = () => page.evaluate(() => {
  const e = window.highlightApp.editor(), result = [];
  e.state.doc.descendants((node,pos) => {
    if (!node.isText) return;
    for (let i=0;i<node.text.length;i++) {
      const dom=e.view.domAtPos(pos+i,1).node, el=dom.nodeType===3?dom.parentElement:dom;
      let bg='rgba(0, 0, 0, 0)';
      for (let at=el;at&&at!==e.view.dom;at=at.parentElement) { const color=getComputedStyle(at).backgroundColor; if(color!=='rgba(0, 0, 0, 0)'&&color!=='transparent'){bg=color;break;} }
      result.push({ pos:pos+i,text:node.text[i],highlight:node.marks.find(m=>m.type.name==='highlight')?.attrs.color??null,
        marks:node.marks.filter(m=>m.type.name!=='highlight').map(m=>m.toJSON()),background:bg,foreground:getComputedStyle(el).color });
    }
  });return result;
});
const saved = () => page.evaluate(async () => {
  const id=window.highlightApp.engine().getDrawingOwnership().pageId;
  if(window.panvas){for(const ws of await window.panvas.workspace.getAll()){const pages=await window.panvas.notebookPage.getAll(ws.id),p=pages.find(p=>p.id===id);if(p)return window.panvas.notebook.loadDrawing(ws.id,p.notebookId,id);}}
  return new Promise((resolve,reject)=>{const req=indexedDB.open('panvas');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,r=db.transaction('notebookPageDrawings').objectStore('notebookPageDrawings').get(id);r.onerror=()=>reject(r.error);r.onsuccess=()=>{resolve(r.result?.data);db.close();};};});
});
const waitSaved = async json => {
  const until=Date.now()+30000;
  while(Date.now()<until){const data=await saved();if(data?.objects?.some(o=>JSON.stringify(o.content)===JSON.stringify(json)))return data;await settle();}
  throw new Error('Expected document JSON was not persisted.');
};
const select = async (start,end=start, interrupt) => {
  const local=page.getByRole('button',{name:'Continue locally',exact:true});if(await local.isVisible())await local.click();
  const range=await page.evaluate(({start,end})=>{
    const e=window.highlightApp.editor(),chars=[];e.state.doc.descendants((n,p)=>{if(n.isText)for(let i=0;i<n.text.length;i++)chars.push({text:n.text[i],pos:p+i});});
    const text=chars.map(c=>c.text).join(''),a=text.indexOf(start),b=text.indexOf(end,a);if(typeof start!=='number'&&(a<0||b<0))throw Error('Missing selection');
    const from=typeof start==='number'?start:chars[a].pos,to=typeof end==='number'?end:chars[b+end.length-1].pos+1,dom=e.view.domAtPos(from,1).node;
    (dom.nodeType===3?dom.parentElement:dom).scrollIntoView({block:'nearest'});return{from,to};
  },{start,end});await settle();
  await page.evaluate(({from,to})=>{
    const view=window.highlightApp.editor().view, scroller=view.dom.closest('.notebook-viewport'), box=scroller.getBoundingClientRect();
    const a=view.coordsAtPos(from), b=view.coordsAtPos(to);
    if(b.bottom>box.bottom-24)scroller.scrollTop+=b.bottom-box.bottom+24;
    else if(a.top<box.top+24)scroller.scrollTop+=a.top-box.top-24;
  },range);await settle();
  const before=await read();
  const points=await page.evaluate(({from,to})=>{const v=window.highlightApp.editor().view,a=v.coordsAtPos(from),b=v.coordsAtPos(to);return[{x:a.left+.1,y:(a.top+a.bottom)/2},{x:b.left+.1,y:(b.top+b.bottom)/2}];},range);
  assert.ok(points.every(p=>p.y>before.viewport.top&&p.y<before.viewport.bottom),'Both selection endpoints must be inside the paper viewport');
  await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();await page.mouse.move(points[1].x,points[1].y,{steps:12});await settle();const during=await read();if(interrupt)await interrupt();await page.mouse.up();await settle();
  let selectionSyncTimedOut = false;
  if (!interrupt) try {
    await page.waitForFunction(({from,to}) => {
      const s = window.highlightApp.editor().state.selection; return s.anchor === from && s.head === to;
    }, range, { timeout: 2000 });
  } catch { selectionSyncTimedOut = true; }
  const after=await read();
  const geometryAfter = await page.evaluate(({from,to}) => {
    const v = window.highlightApp.editor().view;
    return { from: v.coordsAtPos(from), to: v.coordsAtPos(to) };
  }, range);
  const result={start,end,range,points,before,during,after,selectionSyncTimedOut,geometryAfter,passed:after.selection.anchor===range.from&&after.selection.head===range.to};
  (evidence.selections??=[]).push(result);return result;
};
const colorButton = () => page.getByRole('button', { name: 'Highlight color', exact: true });
const arm = async name => {
  await colorButton().click();
  await page.getByRole('menu', { name: 'Highlight color palette', exact: true })
    .getByRole('menuitemradio', { name, exact: true }).click();
  await settle();
};
const resetTrace = () => page.evaluate(() => { window.highlightApp.transactions = []; window.highlightApp.events = []; });
const trace = () => page.evaluate(() => ({ transactions: window.highlightApp.transactions, events: window.highlightApp.events }));
const rgb = color => color ? `rgb(${[1,3,5].map(i => parseInt(color.slice(i,i+2),16)).join(', ')})` : 'rgba(0, 0, 0, 0)';
const gesture = async (label, start, end, color, enabled = true, keepSelection = false) => {
  const before = await read(), beforeChars = await chars();
  await resetTrace();
  const selection = await select(start, end), afterChars = await chars(), events = await trace();
  const operation = { label, color, enabled, ...selection, beforeChars, afterChars, ...events };
  evidence.operations.push(operation);
  assert.ok(selection.passed, 'Native drag must retain its exact intended range');
  assert.deepEqual(selection.during.json, before.json, 'Pointer movement must not change the document');
  const docTransactions = events.transactions.filter(tr => tr.docChanged);
  assert.equal(docTransactions.length, enabled ? 1 : 0, 'Exactly one document transaction per completed gesture');
  const from = Math.min(selection.range.from, selection.range.to), to = Math.max(selection.range.from, selection.range.to);
  const differences = beforeChars.flatMap((a,i) => {
    const b = afterChars[i], selected = enabled && a.pos >= from && a.pos < to;
    return b && a.pos === b.pos && a.text === b.text && JSON.stringify(a.marks) === JSON.stringify(b.marks)
      && a.foreground === b.foreground && (selected ? b.highlight === color && b.background === rgb(color) : JSON.stringify(a) === JSON.stringify(b))
      ? [] : [{ before: a, after: b, selected }];
  });
  operation.differences = differences; assert.deepEqual(differences, []);
  operation.saved = await waitSaved(selection.after.json);
  await page.screenshot({ path: `${out}/${phase}-${mode}-${label}-selected.png` });
  if (!keepSelection) {
    await page.keyboard.press('ArrowRight'); await settle();
    assert.deepEqual((await read()).json, selection.after.json, 'Caret movement must not highlight');
    await page.screenshot({ path: `${out}/${phase}-${mode}-${label}.png` });
  }
  console.log(JSON.stringify({ label, range: selection.range, docTransactions: docTransactions.length, passed: true }));
  return operation;
};
const createPage = async (name, layout = 'document') => {
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('menu', { name: 'Create new item', exact: true }).getByRole('button', { name: 'New Page', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Page', exact: true });
  await dialog.locator('#create-dialog-input').fill(name);
  await dialog.getByRole('button', { name: 'A4', exact: true }).click();
  await dialog.getByRole('button', { name: layout === 'document' ? 'Document' : 'Freeform', exact: false }).click();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await settle();
  if (layout === 'document') {
    await page.waitForFunction(() => [...document.querySelectorAll('[data-document-body] .tiptap')].some(el => el.editor?.isEditable));
    await installObserver(); await settle();
  }
};
const fixture = '<h2>Text highlighter gesture checks</h2>'
  + '<p>Sentence A keeps memory safety and neighboring words intact.</p>'
  + '<p>Sentence B supports repeated highlighting without another toolbar visit.</p>'
  + '<p><strong>Bold fragment</strong> and <em>italic fragment</em> and <a href="https://example.com/reference"><span style="color:#9b1c1c">colored linked fragment</span></a> remain formatted.</p>'
  + '<p><span style="background-color:#000000;color:#cccccc">Imported black background</span> beside ordinary words.</p>'
  + '<p><em style="background-color:#ff0000">Imported red background</em> keeps italic.</p>'
  + Array.from({ length: 22 }, (_,i) => `<p>Continuation paragraph ${String(i+1).padStart(2,'0')}. ${'A4 pages continue while text formatting and stable document positions remain intact. '.repeat(3)}</p>`).join('')
  + '<p>Last continuation target remains ready for another selection.</p><p>Plain editing tail.</p>';

try {
  if (native) {
    const env = { ...process.env, PANVAS_GATE0_PROFILE: '1', PANVAS_GATE0_USER_DATA: path.join(directory,'profile'),
      PANVAS_GATE0_WORKSPACE_ROOT: path.join(directory,'workspaces'), PANVAS_TEST_WINDOW: '1440x950' };
    delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    app = await _electron.launch({ args: [buildRoot, '--force-device-scale-factor=1.25'], env }); page = await app.firstWindow();
  } else {
    server = await preview({ configFile: false, preview: { port: 0, open: false }, build: { outDir: path.join(buildRoot,'dist') } });
    browser = await chromium.launch({ headless: false });
    page = await browser.newPage({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1.25 });
    await page.goto(server.resolvedUrls.local[0] + 'app');
  }
  page.setDefaultTimeout(30000); page.on('pageerror', e => evidence.errors.push(e.message));
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
  const dismiss = async () => { const b = page.getByRole('button', { name: 'Continue locally', exact: true }); if (await b.count()) await b.click(); };
  await dismiss();
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'New Notebook', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Notebook', exact: true });
  await dialog.locator('#create-dialog-input').fill('Text highlighter mode');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.locator('aside').getByText('Text highlighter mode', { exact: true }).click(); await settle();
  await page.getByTitle('Text (T)', { exact: true }).click();
  await page.locator('canvas[data-render-ready="true"]').first().click({ position: { x: 150, y: 150 } });
  await page.waitForFunction(() => [...document.querySelectorAll('.tiptap')].some(el => el.editor?.isInitialized));
  await installObserver();
  await page.evaluate(recorded => {
    const engine = window.highlightApp.engine(), current = engine.texts.getTexts()[0];
    engine.texts.replaceText({ ...structuredClone(recorded), id: current.id, layerId: current.layerId }); engine.input.notifyChange();
  }, recorded);
  await waitSaved(recorded.content); await page.reload();
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor(); await dismiss();
  await page.getByTitle('Text (T)', { exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.tiptap')].some(el => el.editor?.isEditable));
  await installObserver(); await settle();
  // Focus a collapsed cursor, then arm through the actual existing palette.
  if (phase === 'before') {
    await select('high-level constructs', 'machine code via LLVM'); await page.keyboard.press('ArrowRight'); await settle();
  }
  const beforeArm = await read(); await arm('Yellow');
  assert.deepEqual((await read()).json, beforeArm.json, 'Arming without a text range must not edit text');
  evidence.armedAfterChoice = await colorButton().getAttribute('aria-pressed');
  if (phase === 'before') {
    const selection = await select('high-level constructs', 'machine code via LLVM');
    evidence.missingMode = { before: beforeArm, after: selection.after, selection, transactions: (await trace()).transactions };
    assert.deepEqual(selection.after.json, beforeArm.json, 'Baseline should reproduce the absent automatic command');
    evidence.reproducedMissingMode = true;
  } else {
    assert.equal(evidence.armedAfterChoice, 'true');
    await gesture('yellow-A', 'high-level constructs', 'machine code via LLVM', '#fff4b8', true, true);
    await gesture('yellow-B', 'the type system prevents data races', 'safe multi-threaded code.', '#fff4b8');
    await arm('Blue');
    await gesture('blue-C', 'Memory safety without a garbage collector', 'overflows at compile time.', '#bfdbfe');
    await arm('None');
    assert.equal(await colorButton().locator('span').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    evidence.eraseModeIndicator = true;
    await gesture('erase-A', 'high-level constructs', 'machine code via LLVM', null, true, true);
    const erased = await gesture('erase-B', 'the type system prevents data races', 'safe multi-threaded code.', null);
    await page.keyboard.press('Control+z'); await settle(); assert.deepEqual((await read()).json, erased.before.json); await waitSaved(erased.before.json);
    await page.keyboard.press('Control+y'); await settle(); assert.deepEqual((await read()).json, erased.after.json); await waitSaved(erased.after.json);
    evidence.undoRedo = true;
    await page.keyboard.press('Escape'); await settle(); assert.equal(await colorButton().getAttribute('aria-pressed'), 'false');
    await gesture('normal-selection-after-escape', 'Rich type system', 'bugs early.', null, false);
    // The established select-first workflow still applies immediately.
    const selected = await select('Rich type system', 'bugs early.'); await arm('Purple');
    const selectedChars = await chars();
    assert.ok(selectedChars.filter(c => c.pos >= selected.range.from && c.pos < selected.range.to).every(c => c.highlight === '#ddd6fe'));
    evidence.selectFirst = true;
    await colorButton().click(); await settle(); assert.equal(await colorButton().getAttribute('aria-pressed'), 'false');
    await page.keyboard.press('Escape');
    await gesture('normal-selection-after-toggle', 'high-level constructs', 'machine code via LLVM', null, false);
    await arm('Yellow');
    await page.getByTitle('Hand (Space)', { exact: true }).click();
    await page.getByTitle('Text (T)', { exact: true }).click(); await settle();
    assert.equal(await colorButton().getAttribute('aria-pressed'), 'false');
    await gesture('normal-selection-after-tool-switch', 'the type system prevents data races', 'safe multi-threaded code.', null, false);
    evidence.toolSwitch = true;
    const savedState = await read(), savedChars = await chars(); await waitSaved(savedState.json);
    await page.getByTitle('Hand (Space)', { exact: true }).click(); await page.reload();
    await page.getByRole('button', { name: 'New item', exact: true }).waitFor(); await dismiss();
    await page.getByTitle('Text (T)', { exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.tiptap')].some(el => el.editor?.isEditable));
    await installObserver(); await settle();
    assert.deepEqual((await read()).json, savedState.json); assert.deepEqual(await chars(), savedChars); evidence.saveReopen = true;
    // Exercise the same mode in one logical A4 document that continues over sheets.
    await createPage('A4 text highlighter gestures');
    await page.getByRole('textbox', { name: 'Document body', exact: true }).click({ position: { x: 15, y: 12 } });
    await page.evaluate(html => {
      const editor = window.highlightApp.editor(), data = new DataTransfer();
      data.setData('text/html', html); data.setData('text/plain', 'Text highlighter gesture checks');
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, fixture);
    await page.waitForFunction(() => window.highlightApp.engine().getProperties().layoutExtent > 2300);
    await settle(); evidence.a4Properties = await page.evaluate(() => window.highlightApp.engine().getProperties());
    await page.keyboard.press('Control+Home'); await settle();
    await arm('Yellow');
    await gesture('a4-yellow-A', 'Sentence A keeps', 'neighboring words intact.', '#fff4b8', true, true);
    await gesture('a4-yellow-B', 'Sentence B supports', 'another toolbar visit.', '#fff4b8');
    await gesture('a4-mixed-marks', 'Bold fragment', 'colored linked fragment', '#fff4b8');
    const beforeLink = await read();
    await page.getByRole('button', { name: 'Edit link (Ctrl+K)', exact: true }).click();
    const linkDialog = page.getByRole('dialog', { name: 'Edit link', exact: true }); await linkDialog.waitFor();
    await page.keyboard.press('Escape'); await linkDialog.waitFor({ state: 'hidden' });
    assert.deepEqual((await read()).json, beforeLink.json); evidence.linkDialogPreserved = true;
    await arm('None');
    await gesture('a4-erase-mixed', 'Bold fragment', 'colored linked fragment', null);
    await gesture('a4-erase-black', 'Imported black background', 'Imported black background', null);
    await gesture('a4-erase-red', 'Imported red background', 'Imported red background', null);
    await arm('Blue');
    await gesture('a4-cross-paragraph', 'Sentence A keeps', 'another toolbar visit.', '#bfdbfe');
    const acrossGap = await page.evaluate(() => {
      const e = window.highlightApp.editor(), gap = e.view.dom.querySelector('.panvas-page-gap');
      if (!gap) throw Error('The fixture must have a rendered A4 continuation gap');
      const pos = e.view.posAtDOM(gap.parentNode, [...gap.parentNode.childNodes].indexOf(gap)), positions = [];
      e.state.doc.descendants((node,p) => { if (node.isText) for(let i=0;i<node.text.length;i++)positions.push(p+i); });
      const next = positions.findIndex(p => p >= pos);
      return { from: positions[next-20], to: positions[next+19]+1, gapPosition: pos };
    });
    evidence.acrossGap = acrossGap;
    await gesture('a4-across-sheet-gap', acrossGap.from, acrossGap.to, '#bfdbfe');
    await arm('None');
    await gesture('a4-backward-erase', acrossGap.to, acrossGap.from, null);
    await arm('Blue');
    await gesture('a4-later-sheet', 'Last continuation target', 'another selection.', '#bfdbfe');
    // A caret click, keyboard selection, and ordinary typing do not paint text.
    const clickBefore = await read(); await resetTrace();
    const point = await page.evaluate(() => {
      const e = window.highlightApp.editor(), p = e.view.coordsAtPos(e.state.selection.head);
      return { x: p.left + .1, y: (p.top+p.bottom)/2 };
    });
    await page.mouse.click(point.x, point.y); await settle();
    assert.deepEqual((await read()).json, clickBefore.json);
    assert.equal((await trace()).transactions.filter(t => t.docChanged).length, 0); evidence.clickDoesNotPaint = true;
    await page.keyboard.press('Control+End'); await page.keyboard.press('Shift+ArrowLeft'); await settle();
    assert.deepEqual((await read()).json, clickBefore.json); evidence.keyboardSelectionDoesNotPaint = true;
    await page.keyboard.press('ArrowRight');
    await page.keyboard.insertText(' Ordinary typing while armed.'); await page.keyboard.press('Enter');
    await page.keyboard.insertText('New continuation after editing stays plain until dragged.'); await settle();
    const typed = await chars();
    assert.ok(typed.slice(-55).every(c => c.highlight === null)); evidence.typingDoesNotPaint = true;
    await gesture('a4-after-editor-update', 'New continuation after editing', 'until dragged.', '#bfdbfe');
    // A real edit before pointerup invalidates the gesture's document snapshot.
    await resetTrace();
    const interrupted = await select('Plain editing tail.', 'Plain editing tail.', async () => {
      await page.keyboard.insertText('Interrupted edit.'); await settle();
    });
    const interruptedTrace = await trace();
    assert.ok(interruptedTrace.transactions.filter(t => t.docChanged).every(t => t.steps.every(s => s.stepType !== 'addMark' && s.stepType !== 'removeMark')));
    evidence.staleDocumentGestureCancelled = { ...interrupted, ...interruptedTrace };
    await page.keyboard.press('Control+z'); await settle(); await waitSaved(interrupted.before.json);
    assert.deepEqual((await read()).json, interrupted.before.json);
    // Escape cancels an in-flight native drag, without switching out of text editing.
    const cancelled = await select('Bold fragment', 'colored linked fragment', () => page.keyboard.press('Escape'));
    assert.deepEqual(cancelled.after.json, cancelled.before.json);
    assert.equal(await colorButton().getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => window.highlightApp.engine().tools.getState().mode), 'text');
    evidence.escapeCancelsGesture = true;
    // The chosen color is remembered after disarming, independently of caret marks.
    await select('Plain editing tail.', 'Plain editing tail.'); await page.keyboard.press('ArrowRight');
    await colorButton().click();
    assert.equal(await page.getByRole('menuitemradio', { name: 'Blue', exact: true }).getAttribute('aria-checked'), 'true');
    await page.keyboard.press('Escape'); evidence.colorRemembered = true;
    // Canvas highlighter remains an ink tool and never alters the text document.
    await page.getByRole('textbox', { name: 'Document body', exact: true }).locator('p').first().scrollIntoViewIfNeeded();
    await arm('Yellow'); const beforeInk = await read();
    await page.getByTitle('Highlighter (H)', { exact: true }).click();
    await page.keyboard.press('Escape'); await settle();
    const ink = await page.evaluate(() => {
      const e = window.highlightApp.engine();
      return { count: e.drawing.getStrokes().length, mode: e.tools.getState() };
    });
    await settle();
    const inkPoint = await page.evaluate(() => {
      const c = window.highlightApp.engine().drawing.getCanvasElement(), b = c.getBoundingClientRect(), v = c.closest('.notebook-viewport').getBoundingClientRect();
      const x=b.left+25,y=Math.max(b.top+30,v.top+35);return {x,y,hit:document.elementFromPoint(x,y)===c,canvas:b.toJSON(),viewport:v.toJSON(),target:document.elementFromPoint(x,y)?.tagName};
    });
    evidence.inkPoint = inkPoint;
    assert.ok(inkPoint.hit, 'Ink test must hit the canvas');
    await page.mouse.move(inkPoint.x, inkPoint.y); await page.mouse.down();
    await page.mouse.move(inkPoint.x+90, inkPoint.y+20, { steps: 10 }); await page.mouse.up(); await settle();
    const inkAfter = await page.evaluate(() => ({ strokes: window.highlightApp.engine().drawing.getStrokes(), mode: window.highlightApp.engine().tools.getState() }));
    assert.equal(inkAfter.strokes.length, ink.count+1); assert.equal(inkAfter.strokes.at(-1).tool, 'highlighter');
    await page.getByTitle('Text (T)', { exact: true }).click(); await settle();
    assert.equal(await colorButton().getAttribute('aria-pressed'), 'false');
    assert.deepEqual((await read()).json, beforeInk.json); evidence.canvasHighlighter = { before: ink, after: inkAfter };
    const final = await read(), finalChars = await chars(); await waitSaved(final.json);
    const pageId = final.owner.pageId;
    await page.getByTitle('Hand (Space)', { exact: true }).click(); await page.reload();
    await page.getByRole('button', { name: 'New item', exact: true }).waitFor(); await dismiss();
    await page.getByTitle('Text (T)', { exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-document-body] .tiptap')].some(el => el.editor?.isEditable));
    await installObserver(); await settle(); assert.deepEqual((await read()).json, final.json);
    assert.deepEqual(await chars(), finalChars); evidence.a4SaveReopen = true;
    await createPage('Inactive rendering holder', 'freeform'); await page.getByTitle('Hand (Space)', { exact: true }).click();
    const staticRoot = page.locator(`#page-${pageId} [data-document-body] .ProseMirror`).first();
    await staticRoot.waitFor({ state: 'attached' });
    // Scrolling a page into the viewport can activate it in the real app.
    // Inspect the retained read-only view while the holder page still owns input.
    await page.waitForFunction(id => document.querySelector(`#page-${id} [data-document-body] .ProseMirror`)?.getAttribute('contenteditable') === 'false', pageId);
    const staticChars = await staticRoot.evaluate(root => {
      const result = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node;
      while (node = walker.nextNode()) {
        let bg = 'rgba(0, 0, 0, 0)';
        for (let el=node.parentElement;el&&el!==root;el=el.parentElement) { const color=getComputedStyle(el).backgroundColor;if(color!=='rgba(0, 0, 0, 0)'&&color!=='transparent'){bg=color;break;} }
        for (const text of node.textContent) result.push({text,background:bg,foreground:getComputedStyle(node.parentElement).color});
      } return result;
    });
    assert.notEqual(await page.evaluate(() => window.highlightApp.engine().getDrawingOwnership().pageId), pageId);
    assert.deepEqual(staticChars, finalChars.map(({text,background,foreground}) => ({text,background,foreground})));
    evidence.staticMatchesActive = true;
    await page.screenshot({ path: `${out}/${phase}-${mode}-a4-static.png` });
    assert.deepEqual(evidence.errors, []);
    console.log(JSON.stringify({ mode, operations: evidence.operations.length, undoRedo: evidence.undoRedo,
      saveReopen: evidence.saveReopen, a4SaveReopen: evidence.a4SaveReopen, staticMatchesActive: evidence.staticMatchesActive,
      canvasHighlighter: Boolean(evidence.canvasHighlighter), staleGestureCancelled: Boolean(evidence.staleDocumentGestureCancelled), passed: true }));
  }
} catch (error) { evidence.failure = { message: error.message, stack: error.stack }; throw error; }
finally {
  if (page && !page.isClosed()) await page.screenshot({ path: `${out}/${phase}-${mode}-last.png` });
  await writeFile(`${out}/${phase}-${mode}.json`, JSON.stringify(evidence,null,2));
  if (app) await app.close(); if (browser) await browser.close(); if (server) await server.httpServer.close();
}
