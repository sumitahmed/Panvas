import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, _electron } from 'playwright';
import { expect } from '@playwright/test';
import { preview } from 'vite';

// Production application, real UI clicks and native text drags, disposable profiles only.
// Read-only editor observations are kept outside palette performance measurements.
const native = process.argv.includes('--electron'), mode = native ? 'electron' : 'web';
const phase = process.argv.includes('--before') ? 'before' : 'after';
const largeTree = process.argv.includes('--large-tree');
const out = process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? 'artifacts/documentation-release-prep-20261016/checkpoint1' + (largeTree ? '/large-tree' : '');
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-release-checkpoint1-'));
await mkdir(out, { recursive: true });
let buildRoot = path.resolve('.');
if (process.argv.includes('--baseline-build')) {
  const baseline=JSON.parse(await readFile('artifacts/documentation-release-prep-20261016/baseline-location.json','utf8'));
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
      editors: engine()?.texts.getTexts().map(t => ({ id: t.id, content: t.content })),
      active: document.activeElement?.className };
  } };
  const observe = () => {
    for (const dom of document.querySelectorAll('.tiptap')) {
      const e = dom.editor; if (!e || e.highlightObserved) continue; e.highlightObserved = true;
      e.on('transaction', ({ transaction: tr }) => window.highlightApp.transactions.push({ docChanged: tr.docChanged, selection: tr.selection.toJSON(), steps: tr.steps.map(step => step.toJSON()) }));
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
  const after=await read();const result={start,end,range,points,before,during,after,passed:after.selection.anchor===range.from&&after.selection.head===range.to};
  (evidence.selections??=[]).push(result);return result;
};
const colorButton = () => page.getByRole('button', { name: 'Highlight color', exact: true });
const palette = () => page.getByRole('menu', { name: 'Highlight color palette', exact: true });
const dismiss = async () => {
  const button = page.getByRole('button', { name: 'Continue locally', exact: true });
  if (await button.isVisible()) await button.click({ force: true });
};
const launch = async () => {
  if (native) {
    const env = { ...process.env, PANVAS_GATE0_PROFILE: '1', PANVAS_GATE0_USER_DATA: path.join(directory, 'profile'),
      PANVAS_GATE0_WORKSPACE_ROOT: path.join(directory, 'workspaces'), PANVAS_TEST_WINDOW: '1440x950' };
    delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    app = await _electron.launch({ args: [buildRoot, '--force-device-scale-factor=1.25'], env });
    page = await app.firstWindow();
  } else {
    server ??= await preview({ configFile: false, preview: { port: 0, open: false }, build: { outDir: path.join(buildRoot, 'dist') } });
    browser = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
      headless: false, viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1.25,
    });
    page = browser.pages()[0]; await page.goto(server.resolvedUrls.local[0] + 'app');
  }
  page.setDefaultTimeout(30000); page.on('pageerror', error => evidence.errors.push(error.message));
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor(); await dismiss();
};
const createNotebook = async name => {
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'New Notebook', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Notebook', exact: true });
  await dialog.locator('#create-dialog-input').fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.locator('aside').getByText(name, { exact: true }).click(); await settle();
};
const focusEditor = async () => {
  await page.getByTitle('Text (T)', { exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.tiptap')].some(el => el.editor?.isEditable));
  await installObserver(); await settle();
};
const setTheme = async dark => {
  for (let i = 0; i < 4; i++) {
    const active = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    if (active === dark) return;
    await page.getByRole('button', { name: /^Switch to .* theme$/ }).click(); await settle();
    const prompt = page.getByRole('button', { name: 'Standard Dark', exact: true });
    if (await prompt.isVisible()) await prompt.click();
    await dismiss();
  }
  throw Error('Theme did not change through UI');
};
const captureSidebar = async suffix => {
  await page.screenshot({ path: `${out}/${phase}-${mode}-${suffix}-full.png` });
  await page.locator('aside.panvas-sidebar').screenshot({ path: `${out}/${phase}-${mode}-${suffix}-sidebar.png` });
};
const preferences = () => page.evaluate(async () => window.panvas
  ? window.panvas.settings.get(null, 'notebook_highlightPalette')
  : JSON.parse(localStorage.getItem('panvas_setting_notebook_highlightPalette') ?? 'null'));
const swatches = () => palette().locator('[role="menuitemradio"][data-color]').evaluateAll(items => items.map(item => item.dataset.color));
const openPalette = async () => { if (!await palette().isVisible()) await colorButton().click(); await palette().waitFor(); };
const choose = async name => {
  await openPalette(); await palette().getByRole('menuitemradio', { name, exact: true }).click(); await settle();
};
const custom = async color => {
  await openPalette(); await palette().getByLabel('Custom highlight color', { exact: true }).fill(color); await settle();
  await palette().waitFor({ state: 'hidden' });
};
const checkPalette = async (colors, next) => {
  await openPalette(); assert.deepEqual(await swatches(), colors); await page.keyboard.press('Escape');
  await expect.poll(preferences, { timeout: 30000 }).toMatchObject({ colors, next });
  evidence.operations.push({ colors, next, persisted: await preferences() });
};
const palettePerformance = async () => {
  await page.keyboard.press('Escape'); await page.keyboard.press('ArrowRight'); await settle();
  const initial = await read();
  await page.evaluate(() => {
    const e = window.highlightApp.editor(), original = e.getJSON.bind(e);
    window.palettePerformance = { jsonCalls: 0, changes: 0, original };
    e.getJSON = (...args) => { window.palettePerformance.jsonCalls++; return original(...args); };
    window.palettePerformance.observer = new MutationObserver(records => { window.palettePerformance.changes += records.length; });
    window.palettePerformance.observer.observe(e.view.dom, { childList: true, subtree: true });
  });
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const start = await page.evaluate(() => performance.now());
    await colorButton().click(); await palette().waitFor();
    samples.push(await page.evaluate(start => performance.now() - start, start));
    await palette().getByRole('menuitemradio', { name: i % 2 ? 'Green' : 'Blue', exact: true }).click(); await settle();
  }
  const counters = await page.evaluate(() => {
    const p = window.palettePerformance; p.observer.disconnect(); window.highlightApp.editor().getJSON = p.original;
    return { jsonCalls: p.jsonCalls, editorDOMMutations: p.changes };
  });
  assert.deepEqual((await read()).json, initial.json);
  assert.equal(counters.jsonCalls, 0); assert.equal(counters.editorDOMMutations, 0);
  const ordered = [...samples].sort((a,b) => a-b);
  return { samples, medianMs: (ordered[4] + ordered[5]) / 2, ...counters };
};
const gesture = async (start, end, color) => {
  const before = await read(), beforeChars = await chars();
  await page.evaluate(() => { window.highlightApp.transactions = []; });
  const selection = await select(start, end), afterChars = await chars();
  assert.ok(selection.passed, 'Native drag retains the intended exact range');
  assert.deepEqual(selection.during.json, before.json);
  const transactions = await page.evaluate(() => window.highlightApp.transactions.filter(tr => tr.docChanged));
  assert.equal(transactions.length, 1);
  const rgb = color ? `rgb(${[1,3,5].map(i => parseInt(color.slice(i,i+2),16)).join(', ')})` : 'rgba(0, 0, 0, 0)';
  for (const [i, prior] of beforeChars.entries()) {
    const after = afterChars[i];
    assert.equal(after.text, prior.text); assert.deepEqual(after.marks, prior.marks); assert.equal(after.foreground, prior.foreground);
    if (prior.pos >= selection.range.from && prior.pos < selection.range.to) {
      assert.equal(after.highlight, color); assert.equal(after.background, rgb);
    } else assert.deepEqual(after, prior);
  }
  await waitSaved(selection.after.json); await page.keyboard.press('ArrowRight'); await settle();
  evidence.operations.push({ gesture: { start, end, color, range: selection.range, transactions, before: before.json, after: selection.after.json } });
  return selection;
};
const sidebarCases = async () => {
  const tree = page.getByRole('tree', { name: 'Workspaces', exact: true });
  const activeSection = tree.locator('[role="treeitem"][aria-level="3"][data-state="ancestor"]');
  if (await activeSection.getAttribute('aria-expanded') === 'false') {
    await activeSection.locator('[data-tree-toggle]').click(); await expect(activeSection).toHaveAttribute('aria-expanded', 'true');
  }
  const current = tree.getByRole('treeitem', { selected: true }); await current.waitFor();
  assert.equal(await current.count(), 1);
  evidence.treeMetrics = await tree.getByRole('treeitem').evaluateAll(items => items.map(el => ({
    name: el.getAttribute('aria-label'), level: Number(el.getAttribute('aria-level')), height: el.getBoundingClientRect().height,
    left: parseFloat(getComputedStyle(el).paddingLeft), background: getComputedStyle(el).backgroundColor,
    selected: el.getAttribute('aria-selected'), title: el.querySelector('[title]')?.title,
  })));
  for (const row of evidence.treeMetrics) { assert.equal(row.height, 28); assert.equal(row.left, (row.level - 1) * 16 + 6); }
  await page.keyboard.press('Tab'); await current.focus();
  assert.equal(await current.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-level')), '3');
  const section = tree.locator('[role="treeitem"][aria-level="3"][data-state="ancestor"]');
  await page.keyboard.press('ArrowLeft'); await expect(section).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight'); await expect(section).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight'); assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-level')), '4');
  await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-level')), '1');
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+F10'); await page.getByRole('menu', { name: 'Item actions', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  // Existing create / rename / delete paths, without replacing sidebar data semantics.
  await current.click();
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'New Page', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Page', exact: true });
  const longName = 'A long research page title that must truncate gracefully without hiding its full name';
  await dialog.locator('#create-dialog-input').fill(longName);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  let row = tree.getByRole('treeitem', { name: longName, exact: true }); await row.waitFor();
  assert.equal(await row.locator('span[title]').getAttribute('title'), longName);
  assert.ok(await row.locator('span[title]').evaluate(el => el.scrollWidth > el.clientWidth));
  // Reorder through the existing HTML drag-and-drop handlers.
  const rowId = await row.getAttribute('data-tree-id');
  const pageOne = row.locator('..').getByRole('treeitem', { name: 'Page 1', exact: true });
  await row.dragTo(pageOne, { targetPosition: { x: 110, y: 2 } });
  await expect.poll(() => row.locator('..').getByRole('treeitem').evaluateAll(items => items.map(item => item.dataset.treeId))).toEqual([rowId, await pageOne.getAttribute('data-tree-id')]);
  await row.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Item actions', exact: true }).getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const rename = tree.locator('input'); await rename.fill('Renamed field notes'); await rename.press('Enter');
  row = tree.getByRole('treeitem', { name: 'Renamed field notes', exact: true }); await row.waitFor();
  await row.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Item actions', exact: true }).getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await row.waitFor({ state: 'hidden' });
  const canvas = tree.getByRole('treeitem', { name: 'Welcome Canvas', exact: true });
  const originalScene = await page.evaluate(async id => {
    const scene = { canvasFileId: id, elements: [{ id: 'copy-test-shape', type: 'rectangle', x: 10, y: 20, width: 80, height: 40 }],
      files: {}, appState: { viewBackgroundColor: '#ffffff' }, version: 1, updatedAt: Date.now(), userId: null,
      customBlocks: [{ id: 'copy-test-block', canvasFileId: id, type: 'markdown', content: '# Copy this note', x: 30, y: 60, width: 200, height: 100, createdAt: 1, updatedAt: 1, userId: null }] };
    if (window.panvas) {
      const ws = (await window.panvas.workspace.getAll())[0]; await window.panvas.canvas.save(ws.id, id, scene); return scene;
    }
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('panvas'); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['canvasData','customBlocks'], 'readwrite');
        tx.objectStore('canvasData').put(scene); tx.objectStore('customBlocks').put(scene.customBlocks[0]);
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    }); return scene;
  }, await canvas.getAttribute('data-tree-id'));
  await canvas.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Item actions', exact: true }).getByRole('menuitem', { name: 'Duplicate Canvas', exact: true }).click();
  const duplicate = tree.getByRole('treeitem', { name: /Welcome Canvas.*copy/i }); await duplicate.waitFor();
  const duplicatedScene = await page.evaluate(async id => {
    if (window.panvas) return window.panvas.canvas.load((await window.panvas.workspace.getAll())[0].id, id);
    return new Promise((resolve, reject) => { const req = indexedDB.open('panvas'); req.onsuccess = () => {
      const db = req.result, r = db.transaction('canvasData').objectStore('canvasData').get(id);
      r.onsuccess = () => { db.close(); resolve(r.result); }; r.onerror = () => reject(r.error);
    }; });
  }, await duplicate.getAttribute('data-tree-id'));
  assert.deepEqual(duplicatedScene.elements, originalScene.elements); assert.deepEqual(duplicatedScene.files, originalScene.files);
  if (native) {
    assert.equal(duplicatedScene.customBlocks.length, 1);
    assert.equal(duplicatedScene.customBlocks[0].content, originalScene.customBlocks[0].content);
    assert.notEqual(duplicatedScene.customBlocks[0].id, originalScene.customBlocks[0].id);
    assert.equal(duplicatedScene.customBlocks[0].canvasFileId, duplicatedScene.canvasFileId);
  }
  await duplicate.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Item actions', exact: true }).getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await duplicate.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Local storage details', exact: true }).click();
  await page.getByRole('heading', { name: 'Workspace & Storage', exact: true }).waitFor();
  await expect(page.getByRole('region', { name: 'Local storage', exact: true })).toBeVisible();
  await expect(page.locator('[data-storage-count]')).toHaveCount(4);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click(); await tree.waitFor(); await dismiss();
  await page.getByRole('button', { name: 'Hide library', exact: true }).click(); await expect(tree).toBeHidden();
  await page.getByRole('button', { name: 'Show library', exact: true }).click(); await expect(tree).toBeVisible();
  const resize = async (width, height) => native
    ? app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0].setSize(width, height), { width, height })
    : page.setViewportSize({ width, height });
  await resize(780, 760); await settle();
  const showLibrary = page.getByRole('button', { name: 'Show library', exact: true });
  if (await showLibrary.isVisible()) await showLibrary.click(); await expect(tree).toBeVisible();
  assert.ok((await page.locator('aside.panvas-sidebar').boundingBox()).width <= 224);
  await captureSidebar('narrow');
  await page.getByRole('button', { name: 'Close library sidebar', exact: true }).click(); await expect(tree).toBeHidden();
  await page.getByRole('button', { name: 'Show library', exact: true }).click(); await expect(tree).toBeVisible();
  await resize(1440, 950); await settle();
  if (await showLibrary.isVisible()) await showLibrary.click();
  await page.locator('aside').getByText('Research notes', { exact: true }).click(); await focusEditor(); await choose('Yellow');
  const workspace = tree.getByRole('treeitem', { name: 'My Workspace', exact: true });
  await workspace.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Item actions', exact: true }).getByRole('menuitem', { name: 'Rename', exact: true }).click();
  let workspaceName = tree.getByRole('textbox', { name: 'Workspace name', exact: true });
  await workspaceName.fill('Cancelled workspace name'); await workspaceName.press('Escape');
  await expect(workspaceName).toBeHidden();
  assert.equal(await colorButton().getAttribute('aria-pressed'), 'false');
  await workspace.waitFor();
  await workspace.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Item actions', exact: true }).getByRole('menuitem', { name: 'Rename', exact: true }).click();
  workspaceName = tree.getByRole('textbox', { name: 'Workspace name', exact: true });
  await workspaceName.fill('Field research'); await workspaceName.press('Enter');
  await tree.getByRole('treeitem', { name: 'Field research', exact: true }).waitFor();
  evidence.sidebarCases = { keyboard: true, createRenameTrash: true, dragReorder: true, duplicateCanvas: true,
    truncationTooltip: true, storageDetails: true, collapseAndNarrowWindow: true, workspaceRenameAndCancel: true };
};
const auditDocumentPdfGate = async () => {
  await page.getByRole('button', { name: 'New item', exact: true }).click();
  await page.getByRole('button', { name: 'New Page', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Page', exact: true });
  await dialog.locator('#create-dialog-input').fill('Document PDF audit');
  await dialog.getByRole('button', { name: 'A4', exact: true }).click();
  await dialog.getByRole('button', { name: /^Document/ }).click();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('[data-document-body] .tiptap')?.editor?.isEditable);
  await page.locator('[data-document-body] .tiptap').click(); await page.keyboard.insertText('Document export audit: retain all content.');
  await page.getByRole('treeitem', { name: 'Document PDF audit', exact: true }).click({ button: 'right' });
  const destination = path.resolve(out, `${phase}-${mode}-document.pdf`);
  if (app) await app.evaluate(({ BrowserWindow }, destination) => {
    globalThis.pdfAuditDownload = new Promise((resolve, reject) => BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(destination); item.once('done', (_event, state) => state === 'completed' ? resolve(state) : reject(new Error(state)));
    })); globalThis.pdfAuditDownload.catch(() => {});
  }, destination);
  const download = app ? null : page.waitForEvent('download');
  await page.getByRole('menu', { name: 'Item actions', exact: true }).getByRole('menuitem', { name: 'Export Page to PDF', exact: true }).click();
  if (download) await (await download).saveAs(destination); else await app.evaluate(() => globalThis.pdfAuditDownload);
  const { PDFDocument } = await import('pdf-lib'), pdf = await PDFDocument.load(await readFile(destination));
  assert.equal(pdf.getPageCount(), 1);
  evidence.documentPdfGate = { supported: true, pages: pdf.getPageCount(), file: destination };
  await page.screenshot({ path: `${out}/${phase}-${mode}-document-pdf-gate.png` });
};
const largeTreeCases = async () => {
  const buildRows = original => {
    const notebooks = [], sections = [], pages = [];
    for (let i = 0; i < 100; i++) {
      const suffix = String(i + 1).padStart(3, '0'), notebookId = `load-book-${suffix}`, sectionId = `load-section-${suffix}`;
      notebooks.push({ ...original.notebooks[0], id: notebookId, name: `Load notebook ${suffix}`, folderId: null, isSystem: false, systemType: undefined, isExpanded: true });
      sections.push({ ...original.sections[0], id: sectionId, notebookId, name: `Load section ${suffix}`, isExpanded: true });
      for (let p = 0; p < 8; p++) pages.push({ ...original.pages[0], id: `load-page-${suffix}-${p}`, notebookId, sectionId, title: `Research page ${suffix}.${p + 1}`, isSystem: false, systemType: undefined });
    }
    return { notebooks, sections, pages };
  };
  if (native) {
    const metadataPath = path.join(directory, 'workspaces', 'My Workspace', '.panvas', 'workspace.json');
    assert.ok(path.resolve(metadataPath).startsWith(path.resolve(directory) + path.sep));
    await app.close(); app = null;
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const fixture = buildRows({ notebooks: metadata.notebooks, sections: metadata.notebookSections, pages: metadata.notebookPages });
    metadata.notebooks.push(...fixture.notebooks); metadata.notebookSections.push(...fixture.sections); metadata.notebookPages.push(...fixture.pages);
    await writeFile(metadataPath, JSON.stringify(metadata)); await launch();
  } else {
    const original = await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('panvas'); req.onsuccess = async () => {
        const db = req.result, stores = ['notebooks','notebookSections','notebookPages'];
        const data = await Promise.all(stores.map(store => new Promise((resolve,reject) => {
          const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
        }))); db.close(); resolve({ notebooks: data[0], sections: data[1], pages: data[2] });
      }; req.onerror = () => reject(req.error);
    }));
    await page.evaluate(fixture => new Promise((resolve,reject) => {
      const req = indexedDB.open('panvas'); req.onsuccess = () => {
        const db = req.result, tx = db.transaction(['notebooks','notebookSections','notebookPages'], 'readwrite');
        for (const [store, rows] of [['notebooks',fixture.notebooks], ['notebookSections',fixture.sections], ['notebookPages',fixture.pages]]) for (const row of rows) tx.objectStore(store).put(row);
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      }; req.onerror = () => reject(req.error);
    }), buildRows(original));
    await page.reload(); await page.getByRole('button', { name: 'New item', exact: true }).waitFor(); await dismiss();
  }
  await page.getByRole('button', { name: 'Collapse Load notebook 001', exact: true }).waitFor();
  const rows = await page.locator('[data-tree-id]').count(); assert.ok(rows >= 1000);
  await page.evaluate(() => {
    window.treeLongTasks = []; window.treeObserver = new PerformanceObserver(list => window.treeLongTasks.push(...list.getEntries().map(item => ({ start: item.startTime, duration: item.duration }))));
    window.treeObserver.observe({ type: 'longtask' });
  });
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const collapse = i % 2 === 0, start = await page.evaluate(() => performance.now());
    await page.getByRole('button', { name: `${collapse ? 'Collapse' : 'Expand'} Load notebook 001`, exact: true }).click();
    if (collapse) await page.locator('[data-tree-id="load-section-001"]').waitFor({ state: 'detached' });
    else await page.waitForFunction(() => document.querySelector('[data-tree-id="load-book-001"]')?.nextElementSibling?.getBoundingClientRect().height >= 251);
    samples.push({ operation: collapse ? 'collapse' : 'expand', elapsedMs: await page.evaluate(start => performance.now() - start, start) });
  }
  const longTasks = await page.evaluate(() => { window.treeObserver.disconnect(); return window.treeLongTasks; });
  const ordered = samples.map(item => item.elapsedMs).sort((a,b) => a-b);
  evidence.largeTree = { notebooks: 100, pages: 800, rows, samples, longTasks, medianSettleMs: (ordered[2] + ordered[3]) / 2 };
  await page.screenshot({ path: `${out}/${phase}-${mode}-1000-rows.png` });
};
try {
  await launch(); await createNotebook('Research notes');
  await page.getByTitle('Text (T)', { exact: true }).click();
  await page.locator('canvas[data-render-ready="true"]').first().click({ position: { x: 150, y: 150 } });
  await page.waitForFunction(() => [...document.querySelectorAll('.tiptap')].some(el => el.editor?.isInitialized));
  await installObserver();
  await page.evaluate(recorded => {
    const engine = window.highlightApp.engine(), current = engine.texts.getTexts()[0];
    engine.texts.replaceText({ ...structuredClone(recorded), id: current.id, layerId: current.layerId }); engine.input.notifyChange();
  }, recorded);
  await waitSaved(recorded.content); await page.reload();
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor(); await dismiss(); await focusEditor();
  await setTheme(false); await captureSidebar('light');
  await colorButton().click(); await palette().waitFor();
  evidence.paletteBefore = await palette().boundingBox();
  evidence.swatchesBefore = await palette().getByRole('menuitemradio').allTextContents();
  await page.screenshot({ path: `${out}/${phase}-${mode}-palette.png` });
  await page.keyboard.press('Escape'); await setTheme(true); await captureSidebar('dark'); await setTheme(false);
  evidence.palettePerformance = await palettePerformance();
  if (largeTree) await largeTreeCases();
  if (phase === 'after' && !largeTree) {
    const defaults = ['#fff4b8','#bbf7d0','#bfdbfe','#fbcfe8','#fed7aa','#ddd6fe'];
    const initial = await read();
    await custom('#9b59b6'); await checkPalette(['#9b59b6', ...defaults.slice(1)], 1);
    await custom('#8bc34a'); const firstTwo = ['#9b59b6','#8bc34a',...defaults.slice(2)]; await checkPalette(firstTwo, 2);
    await choose('#9B59B6'); await checkPalette(firstTwo, 2);
    await custom('#8bc34a'); await checkPalette(firstTwo, 2);
    assert.deepEqual((await read()).json, initial.json, 'Palette-only changes do not touch existing highlights');
    await choose('#9B59B6');
    await gesture('high-level constructs', 'machine code via LLVM', '#9b59b6');
    await gesture('the type system prevents data races', 'safe multi-threaded code.', '#9b59b6');
    await choose('Blue'); const blue = await gesture('high-level constructs', 'machine code via LLVM', '#bfdbfe');
    await choose('None'); const erased = await gesture('high-level constructs', 'machine code via LLVM', null);
    await page.keyboard.press('Control+z'); await settle(); assert.deepEqual((await read()).json, erased.before.json);
    await page.keyboard.press('Control+y'); await settle(); assert.deepEqual((await read()).json, erased.after.json);
    await page.keyboard.press('Escape'); await page.keyboard.press('ArrowRight'); await settle();
    const selectFirst = await select('high-level constructs', 'machine code via LLVM'); assert.ok(selectFirst.passed);
    await choose('#9B59B6'); await page.keyboard.press('ArrowRight'); await settle();
    const final = await read(); await waitSaved(final.json);
    assert.deepEqual(final.json, blue.before.json); evidence.selectFirst = true;
    const remaining = ['#123456','#654321','#abcdef','#fedcba','#135790'];
    for (let i = 0; i < remaining.length; i++) await custom(remaining[i]);
    const rolled = ['#135790','#8bc34a','#123456','#654321','#abcdef','#fedcba'];
    await checkPalette(rolled, 1); assert.deepEqual((await read()).json, final.json);
    // Switch notebooks, then actually close/relaunch the app using the same disposable profile.
    await createNotebook('Palette persistence holder');
    await page.getByTitle('Text (T)', { exact: true }).click(); await checkPalette(rolled, 1);
    if (app) { await app.close(); app = null; } else { await browser.close(); browser = null; }
    await launch(); await page.locator('aside').getByText('Palette persistence holder', { exact: true }).click();
    await page.getByTitle('Text (T)', { exact: true }).click(); await checkPalette(rolled, 1);
    await openPalette(); assert.equal(await palette().getByRole('menuitemradio', { checked: true }).getAttribute('data-color'), '#135790');
    await page.keyboard.press('Escape');
    await page.locator('aside').getByText('Research notes', { exact: true }).click(); await focusEditor();
    assert.deepEqual((await read()).json, final.json); evidence.restartAndNotebookSwitch = true;
    await custom('#246802'); await checkPalette(['#135790','#246802',...rolled.slice(2)], 2);
    await openPalette(); await palette().getByRole('button', { name: 'Highlight palette options', exact: true }).click();
    await page.getByRole('menu', { name: 'Highlight palette options', exact: true }).getByRole('menuitem', { name: 'Restore default colors', exact: true }).click();
    assert.deepEqual(await swatches(), defaults); await page.keyboard.press('Escape'); await checkPalette(defaults, 0);
    assert.equal((await preferences()).selectedColor, '#246802', 'Reset does not change the remembered color');
    assert.deepEqual((await read()).json, final.json);
    await sidebarCases();
    await auditDocumentPdfGate();
  }
  evidence.sidebar = await page.locator('aside.panvas-sidebar').innerText();
  assert.deepEqual(evidence.errors, []);
  evidence.passed = true;
  console.log(JSON.stringify({ mode, phase, passed: true, directory }));
} catch (error) { evidence.failure = { message: error.message, stack: error.stack }; throw error; }
finally {
  if (page && !page.isClosed()) await page.screenshot({ path: `${out}/${phase}-${mode}-last.png` });
  await writeFile(`${out}/${phase}-${mode}.json`, JSON.stringify(evidence, null, 2));
  if (app) await app.close(); if (browser) await browser.close(); if (server) await server.httpServer.close();
}
