import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, _electron } from 'playwright';
import { preview } from 'vite';

// Run against npm run build output, with no source transforms or editor fixture.
// Only disposable profiles are used. All formatting is selected through UI clicks.
const native = process.argv.includes('--electron'), mode = native ? 'electron' : 'web';
const phase = process.argv.includes('--before') ? 'before' : 'after';
const out = process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? 'artifacts/highlight-selection-20261015/production';
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-highlight-production-'));
await mkdir(out, { recursive: true });
let buildRoot = path.resolve('.');
if (process.argv.includes('--baseline-build')) {
  const baseline=JSON.parse(await readFile('artifacts/highlight-selection-20261015/baseline-location.json','utf8'));
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
const select = async (start,end=start) => {
  const local=page.getByRole('button',{name:'Continue locally',exact:true});if(await local.isVisible())await local.click();
  const range=await page.evaluate(({start,end})=>{
    const e=window.highlightApp.editor(),chars=[];e.state.doc.descendants((n,p)=>{if(n.isText)for(let i=0;i<n.text.length;i++)chars.push({text:n.text[i],pos:p+i});});
    const text=chars.map(c=>c.text).join(''),a=text.indexOf(start),b=text.indexOf(end,a);if(a<0||b<0)throw Error('Missing selection');
    const from=chars[a].pos,to=chars[b+end.length-1].pos+1,dom=e.view.domAtPos(from,1).node;
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
  await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();await page.mouse.move(points[1].x,points[1].y,{steps:12});await page.mouse.up();await settle();
  const after=await read();const result={start,end,range,points,before,after,passed:after.selection.anchor===range.from&&after.selection.head===range.to};
  (evidence.selections??=[]).push(result);return result;
};
const colors={Yellow:'#fff4b8',Purple:'#ddd6fe',Blue:'#bfdbfe',None:null};
const rgb=c=>c?`rgb(${[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)).join(', ')})`:'rgba(0, 0, 0, 0)';
const choose = async (label,name) => {
  await page.evaluate(()=>{window.highlightApp.transactions=[];window.highlightApp.events=[];});
  const before=await read(),beforeChars=await chars();
  await page.getByRole('button',{name:'Highlight color',exact:true}).locator('svg').click();
  const palette=page.getByRole('menu',{name:'Highlight color palette',exact:true});await palette.waitFor();
  const opened=await read(),beforeClick=await read();
  await palette.getByRole('menuitemradio',{name,exact:true}).click();
  const immediate=await read();await palette.waitFor({state:'hidden'});await settle();
  const after=await read(),afterChars=await chars();
  const from=Math.min(before.selection.anchor,before.selection.head),to=Math.max(before.selection.anchor,before.selection.head);
  assert.ok(from<to,'The intended text selection must be nonempty.');
  const differences=beforeChars.flatMap((a,i)=>{
    const b=afterChars[i],selected=a.pos>=from&&a.pos<to;
    const ok=b&&b.text===a.text&&b.pos===a.pos&&JSON.stringify(b.marks)===JSON.stringify(a.marks)&&b.foreground===a.foreground
      &&(selected?b.highlight===colors[name]&&b.background===rgb(colors[name]):JSON.stringify(a)===JSON.stringify(b));
    return ok?[]:[{before:a,after:b,selected}];
  });
  const operation={label,name,before,opened,beforeClick,immediate,after,beforeChars,afterChars,differences,
    ...await page.evaluate(()=>({transactions:window.highlightApp.transactions,events:window.highlightApp.events}))};
  evidence.operations.push(operation);
  assert.deepEqual(opened.selection,before.selection);assert.deepEqual(after.selection,before.selection);assert.deepEqual(differences,[]);
  operation.saved=await waitSaved(after.json);
  await page.screenshot({path:`${out}/${phase}-${mode}-${label}-selected.png`});
  // These cases exercise independent select-first commands. End gesture mode
  // explicitly before the next selection; its persistent behavior has its own suite.
  if(await page.getByRole('button',{name:'Highlight color',exact:true}).getAttribute('aria-pressed')==='true')await page.keyboard.press('Escape');
  // Capture the persisted color with selection-blue removed. Then reselect
  // the same range by mouse before the next palette operation.
  await page.keyboard.press('ArrowRight');await settle();await page.screenshot({path:`${out}/${phase}-${mode}-${label}.png`});
  console.log(JSON.stringify({label,name,range:{from,to},steps:operation.transactions.filter(t=>t.docChanged).flatMap(t=>t.steps),passed:true}));
  return operation;
};
try {
  if(native){const env={...process.env,PANVAS_GATE0_PROFILE:'1',PANVAS_GATE0_USER_DATA:path.join(directory,'profile'),PANVAS_GATE0_WORKSPACE_ROOT:path.join(directory,'workspaces'),PANVAS_TEST_WINDOW:'1440x950'};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
    app=await _electron.launch({args:[buildRoot,'--force-device-scale-factor=1.25'],env});page=await app.firstWindow();
  }else{server=await preview({configFile:false,preview:{port:0,open:false},build:{outDir:path.join(buildRoot,'dist')}});browser=await chromium.launch({headless:false});page=await browser.newPage({viewport:{width:1440,height:950},deviceScaleFactor:1.25});await page.goto(server.resolvedUrls.local[0]+'app');}
  page.setDefaultTimeout(30000);page.on('pageerror',e=>evidence.errors.push(e.message));
  await page.getByRole('button',{name:'New item',exact:true}).waitFor();
  const dismiss=async()=>{const b=page.getByRole('button',{name:'Continue locally',exact:true});if(await b.count())await b.click();};await dismiss();
  await page.getByRole('button',{name:'New item',exact:true}).click();await page.getByRole('button',{name:'New Notebook',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'New Notebook',exact:true});await dialog.locator('#create-dialog-input').fill('Highlight production replay');await dialog.getByRole('button',{name:'Create',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.locator('aside').getByText('Highlight production replay',{exact:true}).click();await settle();
  await page.getByTitle('Text (T)',{exact:true}).click();const canvas=page.locator('canvas[data-render-ready="true"]').first();await canvas.waitFor();await canvas.click({position:{x:150,y:150}});
  await page.waitForFunction(()=>[...document.querySelectorAll('.tiptap')].some(el=>el.editor?.isInitialized));await installObserver();
  await page.evaluate(recorded=>{const engine=window.highlightApp.engine(),current=engine.texts.getTexts()[0];engine.texts.replaceText({...structuredClone(recorded),id:current.id,layerId:current.layerId});engine.input.notifyChange();},recorded);
  await waitSaved(recorded.content);await page.reload();await page.getByRole('button',{name:'New item',exact:true}).waitFor();await dismiss();
  await page.getByTitle('Text (T)',{exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('.tiptap')].some(el=>el.editor?.isEditable));await installObserver();await settle();
  evidence.initial=await read();evidence.firstDrag=await select('high-level constructs','machine code via LLVM');
  evidence.firstDrag.trace=await page.evaluate(()=>({events:window.highlightApp.events,transactions:window.highlightApp.transactions}));
  await page.screenshot({path:`${out}/${phase}-${mode}-first-drag.png`});
  if(phase==='after')assert.ok(evidence.firstDrag.passed,'First drag after reopening selected the wrong range');
  evidence.firstDragHighlight=await choose('first-drag-Blue','Blue');
  evidence.firstDragHighlight.intendedRange=evidence.firstDrag.range;
  evidence.firstDragHighlight.intendedRangePreserved=evidence.firstDrag.passed;
  await page.keyboard.press('Control+z');await settle();assert.deepEqual((await read()).json,evidence.firstDragHighlight.before.json);await waitSaved(evidence.firstDragHighlight.before.json);
  let last;
  for(const [label,start,end]of[['blue','high-level constructs','machine code via LLVM'],['sentence','Memory safety without a garbage collector','overflows at compile time.'],['red-green','Rich type system','bugs early.'],['black','Getting started:','Getting started:']]){
    if(label==='red-green'||label==='black'){const selected=await select(start,end);assert.ok(selected.passed);await choose(`${label}-imported-None`,'None');}
    for(const name of label==='blue'?['Blue','Purple','None']:['Yellow','Purple','None']){const selected=await select(start,end);assert.ok(selected.passed);last=await choose(`${label}-${name}`,name);}
  }
  await page.keyboard.press('Control+z');await settle();assert.deepEqual((await read()).json,last.before.json);await waitSaved(last.before.json);
  await page.keyboard.press('Control+y');await settle();assert.deepEqual((await read()).json,last.after.json);await waitSaved(last.after.json);evidence.undoRedo=true;
  await page.getByTitle('Hand (Space)',{exact:true}).click();await page.reload();await page.getByRole('button',{name:'New item',exact:true}).waitFor();await dismiss();await page.getByTitle('Text (T)',{exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('.tiptap')].some(el=>el.editor?.isEditable));await installObserver();await settle();
  evidence.reopened=await read();assert.deepEqual(evidence.reopened.json,last.after.json);evidence.reopenedChars=await chars();assert.deepEqual(evidence.reopenedChars,last.afterChars);evidence.saveReopen=true;
  assert.deepEqual(evidence.errors,[]);
}catch(error){evidence.failure={message:error.message,stack:error.stack};throw error;}
finally{if(page&&!page.isClosed())await page.screenshot({path:`${out}/${phase}-${mode}-last.png`});await writeFile(`${out}/${phase}-${mode}.json`,JSON.stringify(evidence,null,2));if(app)await app.close();if(browser)await browser.close();if(server)await server.httpServer.close();}
