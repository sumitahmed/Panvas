import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, _electron } from 'playwright';
import { expect } from '@playwright/test';
import { createServer, preview } from 'vite';
import { chooseWritingLayout, closeNotebookProperties } from './helpers/notebook-properties.mjs';

// Production components and actual toolbar mouse interactions; no setWrap or
// language command substitutes. Optional --url tests the production Docker/web
// server; --executable tests the actual packaged Windows application.
const native = process.argv.includes('--electron');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length+3);
const root = await mkdtemp(path.join(tmpdir(), 'panvas-release-ui-'));
const mode = native ? 'electron' : 'chromium';
const out = path.resolve(option('out') ?? `artifacts/production-readiness-20261017/code-${mode}`);
await mkdir(out, { recursive: true });
const evidence = { mode, root, checks: [], errors: [], packaged: Boolean(option('executable')) };
let server, app, context, page;
const pass = name => { evidence.checks.push(name); console.log('PASS', name); };
const editor = () => page.locator('[data-document-body] .tiptap[contenteditable="true"]');
const json = () => page.evaluate(() => document.querySelector('[data-document-body] .tiptap')?.editor?.getJSON());
const settle = () => page.evaluate(async () => { for(let i=0;i<4;i++) await new Promise(requestAnimationFrame); });
const dismiss = async () => { const button=page.getByRole('button',{name:'Continue locally',exact:true});if(await button.isVisible())await button.click({force:true}); };
const saved = async () => page.evaluate(async () => {
  let engine;
  for(const dom of document.querySelectorAll('[data-text-object-id],canvas[data-rendered-page-id]')) {
    const key=Object.keys(dom).find(k=>k.startsWith('__reactFiber$'));
    for(let fiber=dom[key];fiber;fiber=fiber.return) { const value=fiber.memoizedProps?.engine??fiber.memoizedProps?.notebookEngine;if(value?.getDrawingOwnership&&value?.texts)engine=value; }
  }
  const pageId=engine?.getDrawingOwnership().pageId;if(!pageId)throw Error('No page owner');
  let data;
  if(window.panvas) { for(const ws of await window.panvas.workspace.getAll()) { const owner=(await window.panvas.notebookPage.getAll(ws.id)).find(p=>p.id===pageId);if(owner) {data=await window.panvas.notebook.loadDrawing(ws.id,owner.notebookId,pageId);break;} } }
  else data=await new Promise((resolve,reject)=>{const req=indexedDB.open('panvas');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const r=db.transaction('notebookPageDrawings').objectStore('notebookPageDrawings').get(pageId);r.onsuccess=()=>{resolve(r.result?.data);db.close();};r.onerror=()=>reject(r.error);};});
  return data?.objects?.find(o=>o.metadata?.documentRole==='body')?.content;
});
const owner = () => page.evaluate(() => {
  for(const dom of document.querySelectorAll('canvas[data-rendered-page-id]')) {
    const key=Object.keys(dom).find(k=>k.startsWith('__reactFiber$'));
    for(let fiber=dom[key];fiber;fiber=fiber.return){const engine=fiber.memoizedProps?.engine??fiber.memoizedProps?.notebookEngine;if(engine?.getDrawingOwnership)return engine.getDrawingOwnership().pageId;}
  }
});
const waitSaved = async () => { const expected=await json();await expect.poll(saved,{timeout:30000}).toEqual(expected);return expected; };
const paste = async html => {
  await editor().click(); await page.keyboard.press('ControlOrMeta+a');
  await page.evaluate(html => { const dom=document.querySelector('[data-document-body] .tiptap');const data=new DataTransfer();data.setData('text/html',html);data.setData('text/plain','Release regression');dom.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true})); },html);
  await settle();
};
const escape = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const source = 'public class Release {\n    String line = "'+ 'memory_safety_and_exact_source '.repeat(36)+'";\n    // '+ 'unbroken_identifier_'.repeat(45)+'\n}\n';
const codeHtml = `<p>Release <strong>bold</strong> <em>italic</em> <a href="https://example.com">link</a>.</p><pre><code class="language-java">${escape(source)}</code></pre><p>After code.</p>`;
const sustained = async () => {
  if(native)await (await app.browserWindow(page)).evaluate(win=>win.setSize(1280,900));else await page.setViewportSize({width:1280,height:900});
  await page.getByTitle('Text (T)',{exact:true}).click();
  await paste(codeHtml+Array.from({length:1000},(_,i)=>`<p>Paragraph ${i}. ${'Sustained technical writing preserves local data and formatted reading order. '.repeat(3)}</p>`).join(''));
  await waitSaved();
  const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
  const metrics=async()=>{await cdp.send('HeapProfiler.collectGarbage');return {dom:await cdp.send('Memory.getDOMCounters'),heap:(await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='JSHeapUsedSize').value};};
  const before=await metrics();const rounds=[];
  for(let round=0;round<4;round++){
    await editor().focus();await page.keyboard.press('ControlOrMeta+End');
    await page.evaluate(()=>{window.releaseInputPaint=[];window.releaseDocumentTransactions=0;const dom=document.querySelector('[data-document-body] .tiptap');window.releaseInputListener=()=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.releaseInputPaint.push(performance.now()-start)));};dom.addEventListener('beforeinput',window.releaseInputListener);window.releaseTransactionListener=({transaction})=>{if(transaction.docChanged)window.releaseDocumentTransactions++;};dom.editor.on('transaction',window.releaseTransactionListener);});
    const started=performance.now();
    for(let i=0;i<120;i++){await page.keyboard.type('x');if(i%5===0)await settle();}
    const expected=await waitSaved();await settle();
    const input=await page.evaluate(()=>{const dom=document.querySelector('[data-document-body] .tiptap');dom.removeEventListener('beforeinput',window.releaseInputListener);dom.editor.off('transaction',window.releaseTransactionListener);return {paint:window.releaseInputPaint,transactions:window.releaseDocumentTransactions,text:dom.editor.getText().slice(-500)};});
    assert.equal(input.transactions,120);assert.ok(input.text.endsWith('x'.repeat((round+1)*120)));
    const paint=input.paint.sort((a,b)=>a-b);rounds.push({round,elapsedMs:performance.now()-started,inputToPaintP50:paint[Math.floor(paint.length*.5)],inputToPaintP95:paint[Math.floor(paint.length*.95)],inputToPaintMax:Math.max(...paint),transactions:input.transactions,documentJsonBytes:Buffer.byteLength(JSON.stringify(expected)),...await metrics()});
  }
  const navigation=[],customOwner=await owner();assert.ok(customOwner);
  for(let i=0;i<12;i++){
    await page.locator('aside').getByText('My Notebook',{exact:true}).click();
    await expect.poll(owner).not.toBe(customOwner);
    await page.locator('aside').getByText('Release code regression',{exact:true}).click();await expect.poll(owner).toBe(customOwner);await editor().waitFor();await settle();
    if([0,5,11].includes(i))navigation.push({switches:(i+1)*2,...await metrics()});
  }
  await expect.poll(async()=>JSON.stringify(await saved())).toBe(JSON.stringify(await json()));
  const after=await metrics();await page.screenshot({path:path.join(out,'sustained-writing.png')});
  // Post-warm-up bounds detect accumulating owners/listeners, not JIT growth.
  assert.ok(navigation.at(-1).dom.jsEventListeners<=navigation[0].dom.jsEventListeners+50);
  assert.ok(navigation.at(-1).heap<=navigation[0].heap*1.25+8_000_000);
  evidence.performance={paragraphs:1000,typingTransactions:480,navigationSwitches:24,before,rounds,navigation,after,kind:'accelerated production-UI workload, not an hours-long manual session'};
  pass('1000-paragraph document: 480 actual typed transactions, four durable checkpoints and 24 notebook switches');
};
try {
  if(native) {
    const env={...process.env,PANVAS_GATE0_PROFILE:'1',PANVAS_GATE0_USER_DATA:path.join(root,'profile'),PANVAS_GATE0_WORKSPACE_ROOT:path.join(root,'workspaces'),PANVAS_TEST_WINDOW:option('window')??'1280x900'};
    for(const name of ['ELECTRON_RUN_AS_NODE','NODE_TEST_CONTEXT','NODE_TEST_WORKER_ID','VITE_DEV_SERVER_URL'])delete env[name];
    if(option('executable'))env.VITE_DEV_SERVER_URL='http://127.0.0.1:1';
    app=await _electron.launch({executablePath:option('executable'),args:option('executable')?[`--user-data-dir=${path.join(root,'profile')}`]:[path.resolve('.')],env});
    page=await app.firstWindow();
    const info=await app.evaluate(({app})=>({version:app.getVersion(),name:app.getName(),profile:app.getPath('userData'),packaged:app.isPackaged}));
    assert.ok(info.profile.startsWith(root+path.sep));assert.equal(info.version,JSON.parse(await readFile('package.json','utf8')).version);
    if(option('executable')){assert.equal(info.packaged,true);assert.ok(page.url().startsWith('file:'));}
    evidence.runtime=info;
    evidence.viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    if(option('executable')){
      evidence.security=await (await app.browserWindow(page)).evaluate(async win=>{const p=win.webContents.getLastWebPreferences();win.webContents.openDevTools();await new Promise(resolve=>setTimeout(resolve,150));return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,devToolsOpened:win.webContents.isDevToolsOpened()};});
      assert.deepEqual(evidence.security,{sandbox:true,contextIsolation:true,nodeIntegration:false,devToolsOpened:false});
      assert.deepEqual(await page.evaluate(()=>({require:typeof window.require,process:typeof window.process,module:typeof window.module})),{require:'undefined',process:'undefined',module:'undefined'});
    }
    await app.evaluate(({clipboard})=>{globalThis.releaseClipboard={text:clipboard.readText(),html:clipboard.readHTML(),rtf:clipboard.readRTF(),image:clipboard.readImage(),bookmark:clipboard.readBookmark()};});
  } else {
    let url=option('url');
    if(!url){
      if(option('web-dir'))server=await preview({configFile:false,build:{outDir:path.resolve(option('web-dir'))},preview:{host:'127.0.0.1',port:0,open:false}});
      else{server=await createServer({mode:'web',cacheDir:path.join(root,'vite-cache'),optimizeDeps:{entries:['index.html']},server:{host:'127.0.0.1',port:0,open:false}});await server.listen();}
      url=server.resolvedUrls.local[0];
    }
    context=await chromium.launchPersistentContext(path.join(root,'profile'),{headless:true,viewport:{width:1280,height:900}});
    await context.grantPermissions(['clipboard-read','clipboard-write']);page=context.pages()[0];await page.goto(url.replace(/\/$/,'')+'/app');
    evidence.url=url;evidence.runtime={chromium:context.browser()?.version()};
  }
  page.on('pageerror',error=>evidence.errors.push(error.message));page.setDefaultTimeout(30000);
  await page.getByRole('button',{name:'New item',exact:true}).waitFor();await dismiss();
  if(native)assert.ok((await page.evaluate(()=>window.panvas.storage.getRoot())).path.startsWith(root+path.sep));
  await page.getByRole('button',{name:'New item',exact:true}).click();await page.getByRole('button',{name:'New Notebook',exact:true}).click();
  await page.locator('#create-dialog-input').fill('Release code regression');await page.getByRole('button',{name:'Create',exact:true}).click();
  await page.locator('#create-dialog-input').waitFor({state:'hidden'});
  await page.locator('aside').getByText('Release code regression',{exact:true}).click();await dismiss();
  await chooseWritingLayout(page,'Document');await closeNotebookProperties(page);await editor().waitFor();await paste(codeHtml);
  if(process.argv.includes('--sustained-only')){await sustained();evidence.passed=true;}
  else {
  const block=()=>page.locator('[data-document-body] .panvas-code-block').first();
  const bounds=()=>block().evaluate(root=>{const pre=root.querySelector('pre');return {source:pre.textContent,wrap:pre.dataset.codeWrap,whiteSpace:getComputedStyle(pre.querySelector('code')).whiteSpace,width:pre.clientWidth,scrollWidth:pre.scrollWidth,height:pre.offsetHeight};});
  const before=await bounds();assert.equal(before.source,source);assert.equal(before.whiteSpace,'pre');assert.ok(before.scrollWidth>before.width*2);
  const originalDoc=await json(),wrappedDoc=structuredClone(originalDoc);wrappedDoc.content.find(n=>n.type==='codeBlock').attrs.wrap=true;
  await block().getByRole('button',{name:'Wrap lines',exact:true}).click();await settle();const on=await bounds();
  assert.equal(on.source,source);assert.equal(on.wrap,'true');assert.equal(on.whiteSpace,'pre-wrap');assert.ok(on.scrollWidth<=on.width+2);assert.ok(on.height>before.height*2);
  assert.deepEqual(await json(),wrappedDoc,'Wrap On changes only the wrap attribute, retaining prose, marks and links.');
  await page.screenshot({path:path.join(out,'wrap-on.png')});await waitSaved();pass('Wrap Off -> On preserves source, wraps long lines and persists the node');
  await block().getByRole('button',{name:'Wrap lines',exact:true}).click();await settle();const off=await bounds();
  assert.equal(off.source,source);assert.equal(off.wrap,'false');assert.equal(off.whiteSpace,'pre');assert.ok(off.scrollWidth>off.width*2);
  assert.deepEqual(await json(),originalDoc,'Wrap Off restores the exact original document JSON.');
  await block().locator('pre').evaluate(pre=>{pre.scrollLeft=pre.scrollWidth;});assert.ok(await block().locator('pre').evaluate(pre=>pre.scrollLeft>0));
  await page.screenshot({path:path.join(out,'wrap-off-scroll.png')});pass('Wrap On -> Off restores horizontal scrolling without altering source');
  await block().getByRole('button',{name:'Copy code',exact:true}).click();await block().getByRole('button',{name:'Copied',exact:true}).waitFor();
  const copied=native?await app.evaluate(({clipboard})=>clipboard.readText()):await page.evaluate(()=>navigator.clipboard.readText());assert.equal(copied.replaceAll('\r\n','\n'),source);pass('Copy button returns exact unwrapped source');
  await block().locator('summary').click();await page.getByRole('searchbox',{name:'Search code languages',exact:true}).fill('Plain Text');
  await page.getByRole('option',{name:'Plain Text',exact:true}).click();assert.equal((await json()).content.find(n=>n.type==='codeBlock').attrs.language,'plaintext');
  await page.keyboard.press('ControlOrMeta+z');await expect.poll(async()=> (await json()).content.find(n=>n.type==='codeBlock').attrs.language).toBe('java');
  await page.keyboard.press('ControlOrMeta+y');await expect.poll(async()=> (await json()).content.find(n=>n.type==='codeBlock').attrs.language).toBe('plaintext');
  await block().locator('summary').click();await page.getByRole('searchbox',{name:'Search code languages',exact:true}).fill('Java');await page.getByRole('option',{name:'Java',exact:true}).click();
  assert.ok(await block().locator('.hljs-keyword,.hljs-type').count());pass('Language picker and keyboard undo/redo retain source and syntax highlighting');
  if(native)await app.browserWindow(page).then(win=>win.evaluate(win=>win.setSize(800,700)));else await page.setViewportSize({width:390,height:844});
  await block().scrollIntoViewIfNeeded();await settle();
  const controls=await block().locator('.panvas-code-controls').evaluate(root=>{const box=root.getBoundingClientRect();return [...root.querySelectorAll('button')].filter(b=>!b.hidden).map(b=>{const r=b.getBoundingClientRect();return {label:b.getAttribute('aria-label'),inside:r.left>=box.left-1&&r.right<=box.right+1};});});
  assert.ok(controls.length>=3&&controls.every(c=>c.inside));await page.screenshot({path:path.join(out,'narrow-code.png')});evidence.controls=controls;pass('Code controls fit the narrow viewport');
  const expected=await waitSaved();await page.reload();await page.locator('.notebook-viewport').waitFor();await dismiss();await page.getByTitle('Text (T)',{exact:true}).click();await editor().waitFor();
  evidence.persistedJson=expected;
  assert.deepEqual(await json(),expected);assert.equal((await bounds()).source,source);pass('Reload/reopen preserves exact canonical JSON and Wrap Off');
  await page.getByTitle('Hand (Space)',{exact:true}).click();await settle();assert.equal(await block().locator('pre').getAttribute('data-code-wrap'),'false');assert.equal(await block().locator('code').evaluate(el=>getComputedStyle(el).whiteSpace),'pre');pass('Non-editing rendering preserves wrap and code content');
  evidence.bounds={before,on,off};evidence.passed=true;
  }
  assert.deepEqual(evidence.errors,[]);
} catch(error){evidence.failure=error.stack;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
finally{
  if(app){await app.evaluate(({clipboard})=>{if(!globalThis.releaseClipboard)return;const {bookmark,...data}=globalThis.releaseClipboard;clipboard.write(data);if(bookmark.url)clipboard.writeBookmark(bookmark.title,bookmark.url);}).catch(()=>{});await app.close();}
  await context?.close();await server?.close();await writeFile(path.join(out,'results.json'),JSON.stringify(evidence,null,2));
}
