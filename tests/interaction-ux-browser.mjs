import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';
import { writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PDFDocument, rgb as pdfRgb } from 'pdf-lib';
const electronMode = process.argv.includes('--electron');
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-document-input-'));
const errors = [];
let passed = 0;
const pass = name => { passed++; console.log(`PASS: ${name}`); };
const count = name => `window.__documentWork?.bump('${name}');`;
const server = await createServer({ mode: 'web', cacheDir: path.join(directory, 'vite-cache'), server: { port: 0, open: false }, plugins: [{
  name: 'document-work-counters', enforce: 'pre', transform(code, id) {
    id = id.replaceAll('\\', '/').split('?')[0];
    if (id.endsWith('/PdfWorkspace.tsx')) {
      code = code.replace('const isPhone = useIsMobileViewport();', count('pdfWorkspaceRenders') + '$&');
      code = code.replace('const resolveVisiblePage = () => {', '$&' + count('activePageCalculations'));
      code = code.replace('notebookEngine.viewport.subscribe(setViewport)', `notebookEngine.viewport.subscribe(state => {${count('viewportNotifications')}setViewport(state);})`);
      code = code.replace(/\bsetPageDescriptors\(/g, `(window.__documentWork?.bump('descriptorMutations'), setPageDescriptors)(`);
    }
    if (id.endsWith('/PdfPageRenderer.tsx')) code = code.replace('const canvasRef = useRef', count('pdfPageRenders') + '$&');
    return { code, map: null };
  },
}] });
await server.listen();
let browser, electronApp, page;
if (electronMode) {
  for (const [entry, file] of [['electron/ipc/domain-handlers.ts', 'domain.cjs'], ['electron/preload.ts', 'preload.cjs']])
    await build({ entryPoints: [entry], outfile: path.join(directory, file), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  await writeFile(path.join(directory,'bootstrap.cjs'), `const {app,BrowserWindow}=require('electron');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=require('node:path').join(__dirname,'workspaces');
process.env.VITE_DEV_SERVER_URL=${JSON.stringify(server.resolvedUrls.local[0])};
app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();const win=new BrowserWindow({show:false,width:1918,height:1198,titleBarStyle:'hidden',titleBarOverlay:{color:'#00000000',symbolColor:'#ffffff'},webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}});win.loadURL(${JSON.stringify(server.resolvedUrls.local[0]+'tests/fixtures/document-input.html?handwritingTrace=1&gate0Profile=1')});});`);
  const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_TEST_CONTEXT','NODE_TEST_WORKER_ID'])delete env[key];
  electronApp=await _electron.launch({args:[path.join(directory,'bootstrap.cjs')],env}); page=await electronApp.firstWindow();
} else {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1918, height: 1198 } });
}
page.on('pageerror', e => errors.push(e.message));
page.on('console', e => { if (e.type() === 'error') console.log('ERROR', e.text()); });
const frames = n => page.evaluate(async n => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); }, n);
try {
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/document-input.html?handwritingTrace=1&gate0Profile=1', {waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(() => window.documentFixture?.engine()?.drawing.getCanvasElement(),null,{timeout:60000});
  await frames(20);
  assert.equal(await page.evaluate(() => window.documentFixture.mode), electronMode ? 'electron' : 'web');
  const cdp = await page.context().newCDPSession(page);
  if (!electronMode) await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  // Exercise the real selection serialization in an isolated clipboard adapter.
  // The Electron regression must leave the person's Windows clipboard alone.
  if (electronMode) await page.evaluate(()=>{let value='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{value=text;},readText:async()=>value}});});
  const nativeStroke = async (pos, pointerType, delta = 6) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, pointerType });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1, pointerType, force: .65 });
    for (let step = 1; step <= 3; step++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x + step * delta / 3, y: pos.y + step * 2, button: 'left', buttons: 1, pointerType, force: .2 + step * .2 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x + delta, y: pos.y + 6, button: 'left', buttons: 0, clickCount: 1, pointerType });
  };
  const position = async (x, y) => page.evaluate(({ x, y }) => {
    const e = window.documentFixture.engine(), c = e.drawing.getCanvasElement();
    const scroller = c.closest('.notebook-viewport, [data-panvas-scroll-viewport]');
    const p = e.viewport.pageToCanvas(x, y);
    let b = c.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    scroller.scrollLeft += b.left + p.x * b.width / c.clientWidth - box.left - box.width * .6;
    scroller.scrollTop += b.top + p.y * b.height / c.clientHeight - box.top - box.height * .55;
    b = c.getBoundingClientRect();
    const clientX = b.left + p.x * b.width / c.clientWidth, clientY = b.top + p.y * b.height / c.clientHeight;
    const hit = document.elementFromPoint(clientX, clientY);
    return { x: clientX, y: clientY, hit: hit === c, hitElement: hit?.outerHTML.slice(0, 350), before: e.drawing.getStrokes().length };
  }, { x, y });
  await page.evaluate(() => window.documentFixture.select('pdf'));
  await page.waitForFunction(() => window.documentFixture.engine()?.drawing.getCanvasElement()?.classList.contains('panvas-layer-canvas-decoration'));
  await frames(25);
  const research=[],utilityChecks=[];
  const strokeBetween=async(start,end,pointerType)=>{
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x,y:start.y,pointerType});
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:start.x,y:start.y,button:'left',buttons:1,clickCount:1,pointerType,force:.65});
    for(let i=1;i<=4;i++)await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+(end.x-start.x)*i/4,y:start.y+(end.y-start.y)*i/4,button:'left',buttons:1,pointerType,force:.65});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:end.x,y:end.y,button:'left',buttons:0,clickCount:1,pointerType});
  };
  if(!process.argv.includes('--appearance-only')) {
  for(const extent of [40,140,300])for(const rotation of [0,90,180,270]){
    await page.evaluate(async({extent,rotation})=>{
      const f=window.documentFixture,{notebookRepository}=await import('/src/repositories/NotebookRepository.ts'),{useWorkspaceStore}=await import('/src/stores/workspaceStore.ts');
      await notebookRepository.setPdfPageState(f.ids.workspace,f.ids.pdf,{version:1,pageOrder:[1,2,3],rotations:{1:rotation}});
      await useWorkspaceStore.getState().loadWorkspaceContents(f.ids.workspace);
      const e=f.engine();e.tools.setDrawingTool('pen');e.setProperties({extraLeft:extent,extraRight:extent,extraTop:extent,extraBottom:extent});e.viewport.setZoom(.85);
    },{extent,rotation});
    await page.waitForFunction(({extent,rotation})=>{
      const e=window.documentFixture.engine(),c=e?.drawing.getCanvasElement();return c&&e.viewport.pageRotation===rotation&&c.clientWidth===(rotation%180?842:595)+2*extent;
    },{extent,rotation});
    await frames(15);
    const xs=[-extent+5,585,...[10,40,70,100,130].filter(dx=>dx<extent).map(dx=>595+dx),595+extent-5];
    const starts=xs.map(x=>[x,250]);starts.push([100,-extent+5],[100,842+extent-5]);
    for(const pointerType of ['mouse','pen'])for(const [x,y]of starts){
      const pos=await position(x,y);assert.equal(pos.hit,true,`PDF actual hit ${extent}/${rotation}/${pointerType} at ${x},${y}`);
      await nativeStroke(pos,pointerType,3);
      const result=await page.evaluate(()=>{const e=window.documentFixture.engine(),c=e.drawing.getCanvasElement(),b=c.getBoundingClientRect(),w=c.closest('[data-pdf-source-page]');return{count:e.drawing.getStrokes().length,first:e.drawing.getStrokes().at(-1).points[0],canvas:b.toJSON(),wrapper:w.getBoundingClientRect().toJSON(),css:[c.style.width,c.style.height,c.clientWidth,c.clientHeight],backing:[c.width,c.height],logical:[e.drawing.canvasCssWidth,e.drawing.canvasCssHeight],input:[e.input.canvas.clientWidth,e.input.canvas.clientHeight]};});
      assert.equal(result.count,pos.before+1,'fresh PDF stroke created');assert.ok(Math.abs(result.first.x-x)<1&&Math.abs(result.first.y-y)<1,'canonical PDF start');
      assert.ok(Math.abs(result.canvas.width-result.wrapper.width)<.1);assert.ok(Math.abs(result.canvas.height-result.wrapper.height)<.1);assert.deepEqual(result.logical,result.input);
      research.push({extent,rotation,pointerType,x,y,...result});
    }
    for(const pointerType of ['mouse','pen']){
      const start=await position(585,300),end=await page.evaluate(({extent})=>{const e=window.documentFixture.engine(),c=e.drawing.getCanvasElement(),b=c.getBoundingClientRect(),p=e.viewport.pageToCanvas(595+extent-5,300);return{x:b.left+p.x*b.width/c.clientWidth,y:b.top+p.y*b.height/c.clientHeight};},{extent});
      await strokeBetween(start,end,pointerType);
      const last=await page.evaluate(()=>window.documentFixture.engine().drawing.getStrokes().at(-1).points.at(-1));assert.ok(Math.abs(last.x-(595+extent-5))<1&&Math.abs(last.y-300)<1,'captured PDF crossing stays canonical');
    }
  }
  pass(`${research.length} native PDF mouse/pen starts: 40/140/300px, all rotations, body and four Research Space sides`);
  pass('24 captured source-to-right crossings stay canonical');
  // Reset the source page, then reproduce the exact left/right-only sheet.
  // The pointer must overlap the utilities horizontally and lie below their
  // visible row; a centered geometry-only start cannot prove this regression.
  await page.evaluate(()=>window.documentFixture.select('note'));await page.waitForFunction(()=>window.documentFixture.engine()?.drawing.getCanvasElement()?.isConnected&&!window.documentFixture.engine().drawing.getCanvasElement().classList.contains('panvas-layer-canvas-decoration'));
  await page.evaluate(async()=>{const f=window.documentFixture,{notebookRepository}=await import('/src/repositories/NotebookRepository.ts'),{useWorkspaceStore}=await import('/src/stores/workspaceStore.ts');await notebookRepository.setPdfPageState(f.ids.workspace,f.ids.pdf,{version:1,pageOrder:[1,2,3],rotations:{1:0,2:0,3:0}});await useWorkspaceStore.getState().loadWorkspaceContents(f.ids.workspace);f.select('pdf');});await page.waitForFunction(()=>window.documentFixture.engine()?.drawing.getCanvasElement()?.isConnected&&window.documentFixture.engine().drawing.getCanvasElement().classList.contains('panvas-layer-canvas-decoration'));
  await page.setViewportSize({width:1280,height:950});await frames(10);await page.evaluate(()=>{const e=window.documentFixture.engine();e.setProperties({extraLeft:140,extraRight:140,extraTop:0,extraBottom:0});e.viewport.setZoom(1.6);e.tools.setDrawingTool('pen');});await page.waitForFunction(()=>{const e=window.documentFixture.engine(),c=e.drawing.getCanvasElement();return e.viewport.pageRotation===0&&c.clientWidth===875&&c.clientHeight===842;});await frames(15);
  for(const pointerType of ['mouse','pen']){
    for(const x of [-135,585,605,635,665,695,725,730]){const point=await position(x,250);assert.equal(point.hit,true);await nativeStroke(point,pointerType,2);const result=await page.evaluate(()=>{const e=window.documentFixture.engine();return{count:e.drawing.getStrokes().length,point:e.drawing.getStrokes().at(-1).points[0]};});assert.equal(result.count,point.before+1);assert.ok(Math.abs(result.point.x-x)<1&&Math.abs(result.point.y-250)<1);}
    const edge=await page.evaluate(()=>{const e=window.documentFixture.engine(),c=e.drawing.getCanvasElement(),s=c.closest('[data-panvas-scroll-viewport]'),u=document.querySelector('[aria-label="Page utilities"]').parentElement.getBoundingClientRect();let b=c.getBoundingClientRect();s.scrollLeft+=b.right-u.right+16;s.scrollTop+=b.top+b.height/2-s.getBoundingClientRect().top-s.clientHeight*.55;b=c.getBoundingClientRect();const x=b.right-8,y=b.top+b.height/2;return{x,y,utilities:u.toJSON(),hit:document.elementFromPoint(x,y)===c,before:e.drawing.getStrokes().length};});assert.ok(edge.x>=edge.utilities.left&&edge.x<=edge.utilities.right);assert.ok(edge.y>edge.utilities.top+60);assert.equal(edge.hit,true);await nativeStroke(edge,pointerType,2);assert.equal(await page.evaluate(()=>window.documentFixture.engine().drawing.getStrokes().length),edge.before+1);utilityChecks.push({pointerType,...edge});
  }
  pass('exact 875x842 Left/Right 140 sheet: 16 fresh canonical starts plus mouse/pen starts inside the formerly blocked utilities column');
  }
  await page.evaluate(async()=>{
    const f=window.documentFixture,{useUIStore}=await import('/src/stores/uiStore.ts'),{useLayoutStore}=await import('/src/stores/layoutStore.ts');useUIStore.getState().setTheme('light');useUIStore.getState().setFullDarkView(false);useLayoutStore.setState({notebookModeLevel:0});f.select('note');
  });
  await page.waitForFunction(()=>window.documentFixture.engine()?.drawing.getCanvasElement()?.dataset.liveCanvasPageId===window.documentFixture.ids.note||window.documentFixture.engine()?.drawing.getCanvasElement()?.closest('[data-page-id]')?.dataset.pageId===window.documentFixture.ids.note);
  await frames(20);
  const viewSeed=await page.evaluate(async()=>{
    const f=window.documentFixture,e=f.engine(),{createEmptyDrawingData}=await import('/src/components/notebook/engine/drawingTypes.ts'),{createStickyNote}=await import('/src/components/notebook/stickyNotes.ts'),{canvasRepository}=await import('/src/repositories/CanvasRepository.ts');
    const d=createEmptyDrawingData();Object.assign(d.properties,{template:'Ruled',paperColor:'#ffffff',ruleLineColor:'#e5e7eb',extraLeft:140,extraRight:140});
    d.objects=['#000000','#b91c1c','#1d4ed8','#c2410c','#15803d','#ffff00'].map((color,i)=>({id:'view-ink-'+i,type:'stroke',tool:i===5?'highlighter':'pen',color,thickness:6,opacity:1,createdAt:0,points:[{x:80+i*75,y:120,pressure:1,t:0},{x:110+i*75,y:140,pressure:1,t:1}]}));
    d.objects.push({...createStickyNote({id:'view-sticky',x:60,y:300}),width:200,height:120});
    d.objects.push({id:'view-text',type:'text',x:310,y:300,width:230,height:90,fontFamily:'Inter',createdAt:0,content:{type:'doc',content:[{type:'paragraph',content:['#000000','#b91c1c','#1d4ed8','#c2410c','#15803d'].map((color,i)=>({type:'text',text:['Black ','Red ','Blue ','Orange ','Green'][i],marks:[{type:'textStyle',attrs:{color}}]}))}]}});
    const c=document.createElement('canvas');c.width=80;c.height=60;const cx=c.getContext('2d');cx.fillStyle='#d76528';cx.fillRect(0,0,80,60);cx.fillStyle='#3a84d9';cx.fillRect(0,0,40,30);const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png')),bytes=await blob.arrayBuffer(),asset=await canvasRepository.storeImage(null,f.ids.note,'View photo.png','image/png',bytes);const image=new Image();image.src=c.toDataURL();await image.decode();
    d.objects.push({id:'view-image',type:'image',x:350,y:550,width:80,height:60,fileId:asset.id,rotation:0,createdAt:0});e.setDrawingData(d,f.ids.note);e.images.cacheImage(asset.id,image);e.drawing.redraw();e.input.notifyChange();
    return {data:JSON.stringify(e.getDrawingData()),image:asset.id};
  });
  await frames(20);
  const viewPixels=()=>page.evaluate(()=>{
    const e=window.documentFixture.engine(),c=e.drawing.getCanvasElement(),p=e.viewport.pageToCanvas(370,570),k=c.width/c.clientWidth,ctx=c.getContext('2d');const ink=Array.from({length:6},(_,i)=>{const point=e.viewport.pageToCanvas(95+i*75,130);return Array.from(ctx.getImageData(Math.round(point.x*k),Math.round(point.y*k),1,1).data);});return {ink,image:Array.from(ctx.getImageData(Math.round(p.x*k),Math.round(p.y*k),1,1).data),page:getComputedStyle(c.closest('[id^="page-"]')).backgroundColor,annotationFilter:getComputedStyle(c).filter,text:Array.from(document.querySelectorAll('[data-text-object-id="view-text"] .ProseMirror span[style*="color"]')).map(el=>({original:el.style.color,display:getComputedStyle(el).color})),sticky:getComputedStyle(document.querySelector('[data-text-object-id="view-sticky"] .shadow-md')).backgroundColor};
  });
  viewSeed.data=await page.evaluate(()=>JSON.stringify(window.documentFixture.engine().getDrawingData()));
  await mkdir('artifacts/interaction-ux',{recursive:true});
  const normal=await viewPixels();assert.equal(normal.page,'rgb(255, 255, 255)');
  await page.getByRole('button',{name:'Switch to ink theme',exact:true}).click();assert.equal(await page.getByRole('alertdialog').count(),0);
  await page.getByRole('button',{name:'Switch to dark theme',exact:true}).click();await page.getByRole('alertdialog',{name:'Enable Full Dark View?'}).waitFor();await page.getByRole('button',{name:'Standard Dark',exact:true}).click();
  assert.equal((await viewPixels()).page,normal.page);await page.screenshot({path:`artifacts/interaction-ux/standard-dark-${electronMode?'electron':'web'}.png`});pass('Ink to Dark offers the choice; Standard Dark preserves document appearance');
  await page.evaluate(async()=>{const{useUIStore}=await import('/src/stores/uiStore.ts');useUIStore.getState().setTheme('light');useUIStore.getState().setTheme('dark');});await page.getByRole('alertdialog',{name:'Enable Full Dark View?'}).waitFor();await page.getByRole('button',{name:'Full Dark View',exact:true}).click();await frames(20);
  const dark=await viewPixels();assert.equal(dark.page,'rgb(32, 37, 43)');assert.equal(dark.annotationFilter,'none');assert.deepEqual(dark.image,normal.image);assert.ok(dark.text[0].display!==normal.text[0].display);assert.deepEqual(dark.text.map(x=>x.original),normal.text.map(x=>x.original));assert.ok(dark.sticky!==normal.sticky);assert.equal(await page.evaluate(()=>JSON.stringify(window.documentFixture.engine().getDrawingData())),viewSeed.data);
  assert.ok(normal.ink[0][3]>0&&normal.ink[0][0]<5&&dark.ink[0][0]>200,'black ink becomes readable');assert.ok(dark.ink[1][0]>dark.ink[1][1]&&dark.ink[1][0]>dark.ink[1][2],'red remains red');assert.ok(dark.ink[2][2]>dark.ink[2][0],'blue remains blue');assert.ok(dark.ink[3][0]>dark.ink[3][1]&&dark.ink[3][1]>dark.ink[3][2],'orange retains hue');assert.ok(dark.ink[4][1]>dark.ink[4][0],'green retains hue');assert.deepEqual(dark.ink[5],normal.ink[5],'yellow highlighter is unchanged');
  await page.screenshot({path:`artifacts/interaction-ux/full-dark-notebook-${electronMode?'electron':'web'}.png`});pass('Light to Dark Full Dark View adapts paper, rules, rich text, ink and sticky hues without changing data or photo pixels');
  await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));await frames(2);assert.equal((await viewPixels()).page,normal.page);assert.deepEqual((await viewPixels()).text,normal.text);await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));await frames(20);assert.equal((await viewPixels()).page,dark.page);pass('print temporarily restores original document presentation without changing the saved preference');
  for(const theme of ['light','ink']){await page.evaluate(async theme=>{const{useUIStore}=await import('/src/stores/uiStore.ts');useUIStore.getState().setTheme(theme);},theme);await frames(20);assert.equal((await viewPixels()).page,normal.page);await page.evaluate(async()=>{const{useUIStore}=await import('/src/stores/uiStore.ts');useUIStore.getState().setTheme('dark');});await page.getByRole('alertdialog').waitFor();await frames(20);assert.equal((await viewPixels()).page,dark.page);await page.getByRole('button',{name:'Full Dark View',exact:true}).click();}
  await page.evaluate(async()=>{const{useUIStore}=await import('/src/stores/uiStore.ts');useUIStore.getState().setFullDarkView(false);});await frames(20);assert.deepEqual(await viewPixels(),normal);assert.equal(await page.evaluate(()=>localStorage.getItem('panvas-full-dark-view')),'false');
  pass('Full Dark OFF restores original appearance exactly; Light/Ink disable the effect and Dark remembers the latest local choice');
  await page.evaluate(async()=>{const{useUIStore}=await import('/src/stores/uiStore.ts');useUIStore.getState().setFullDarkView(true);window.documentFixture.select('pdf');});await page.waitForFunction(()=>window.documentFixture.engine()?.drawing.getCanvasElement()?.classList.contains('panvas-layer-canvas-decoration'));await frames(25);
  const pdfPresentation=()=>page.evaluate(async()=>{const f=window.documentFixture,{canvasRepository}=await import('/src/repositories/CanvasRepository.ts'),{useWorkspaceStore}=await import('/src/stores/workspaceStore.ts');const record=useWorkspaceStore.getState().notebookPages.find(p=>p.id===f.ids.pdf),bytes=(await canvasRepository.getPdf(null,record.pdfDataId)).data;return {hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).join(','),raster:getComputedStyle(document.querySelector('[data-pdf-source-page="1"] [data-pdf-raster]')).filter,annotations:getComputedStyle(f.engine().drawing.getCanvasElement()).filter,research:getComputedStyle(document.querySelector('[data-pdf-source-page="1"]')).backgroundColor,data:JSON.stringify(f.engine().getDrawingData())};});
  const pdfDark=await pdfPresentation();assert.match(pdfDark.raster,/invert/);assert.equal(pdfDark.annotations,'none');assert.equal(pdfDark.research,'rgb(32, 37, 43)');await page.screenshot({path:`artifacts/interaction-ux/full-dark-pdf-${electronMode?'electron':'web'}.png`});
  await page.evaluate(async()=>{const{useUIStore}=await import('/src/stores/uiStore.ts');useUIStore.getState().setFullDarkView(false);});const pdfOriginal=await pdfPresentation();assert.equal(pdfOriginal.raster,'none');assert.equal(pdfOriginal.research,'rgb(255, 255, 255)');assert.equal(pdfOriginal.hash,pdfDark.hash);assert.equal(pdfOriginal.data,pdfDark.data);
  pass('bright PDF raster and Research Space darken separately from annotations; PDF bytes and annotation data are identical');
  const darkPdf=await PDFDocument.create(),darkPdfPage=darkPdf.addPage([400,500]);darkPdfPage.drawRectangle({x:0,y:0,width:400,height:500,color:pdfRgb(.06,.07,.08)});darkPdfPage.drawText('Already dark reading page',{x:24,y:450,size:20,color:pdfRgb(.95,.95,.95)});const darkPdfBytes=Array.from(await darkPdf.save());
  const darkPdfId=await page.evaluate(async bytes=>{const f=window.documentFixture,{canvasRepository}=await import('/src/repositories/CanvasRepository.ts'),{notebookRepository}=await import('/src/repositories/NotebookRepository.ts'),{useWorkspaceStore}=await import('/src/stores/workspaceStore.ts'),{useUIStore}=await import('/src/stores/uiStore.ts');const asset=await canvasRepository.storePdf(null,f.ids.note,'Already dark.pdf',new Uint8Array(bytes).buffer),record=await notebookRepository.createPage(null,f.ids.workspace,f.ids.notebook,f.ids.section,'Already dark','pdf',asset.id);await useWorkspaceStore.getState().loadWorkspaceContents(f.ids.workspace);useWorkspaceStore.getState().setActivePage(record.id,false);useUIStore.getState().setFullDarkView(true);return record.id;},darkPdfBytes);
  await page.waitForFunction(()=>{const c=document.querySelector('[data-pdf-source-page="1"] [data-pdf-raster]');return c?.width&&c.getContext('2d').getImageData(2,2,1,1).data[0]<30&&window.documentFixture.engine()?.drawing.getCanvasElement()?.isConnected;});await frames(15);const alreadyDark=await page.locator('[data-pdf-source-page="1"] [data-pdf-raster]').evaluate(c=>({filter:getComputedStyle(c).filter,bright:c.dataset.brightDocument}));assert.equal(alreadyDark.filter,'none');assert.equal(alreadyDark.bright,'false');assert.equal(await page.getByRole('alertdialog').count(),0);pass('an actual already-dark PDF keeps its raster unchanged instead of becoming a bright negative');
  await page.evaluate(async()=>{const{mountAppearanceProbe}=await import('/tests/fixtures/document-input.tsx');mountAppearanceProbe();});
  const fullDarkSwitch=page.getByRole('switch',{name:'Full Dark View',exact:true});await fullDarkSwitch.waitFor();await fullDarkSwitch.uncheck();assert.equal(await page.evaluate(()=>localStorage.getItem('panvas-full-dark-view')),'false');await fullDarkSwitch.check();assert.equal(await page.evaluate(()=>localStorage.getItem('panvas-full-dark-view')),'true');assert.equal(await page.getByRole('alertdialog').count(),0);await page.evaluate(async()=>{const{unmountAppearanceProbe}=await import('/tests/fixtures/document-input.tsx');unmountAppearanceProbe();});pass('the existing Appearance section changes the remembered Full Dark preference without another entry prompt');
  await page.evaluate(()=>window.documentFixture.select('note'));await page.waitForFunction(()=>window.documentFixture.engine()?.drawing.getCanvasElement()?.isConnected&&!window.documentFixture.engine().drawing.getCanvasElement().classList.contains('panvas-layer-canvas-decoration'));await frames(15);
  for(const color of ['#ffffff','#fef08a','#bbf7d0','#bae6fd','#000000','#c9b7df']){
    await page.evaluate(async color=>{const{useUIStore}=await import('/src/stores/uiStore.ts');useUIStore.getState().setFullDarkView(false);window.documentFixture.engine().setProperties({paperColor:color});},color);await frames(20);const originalPage=(await viewPixels()).page,data=await page.evaluate(()=>JSON.stringify(window.documentFixture.engine().getDrawingData()));await page.evaluate(async()=>{const{useUIStore}=await import('/src/stores/uiStore.ts');useUIStore.getState().setFullDarkView(true);});await frames(20);const displayedPage=(await viewPixels()).page;assert.equal(await page.evaluate(()=>JSON.stringify(window.documentFixture.engine().getDrawingData())),data);if(color==='#000000')assert.equal(displayedPage,originalPage);else assert.notEqual(displayedPage,originalPage);await page.evaluate(async()=>{const{useUIStore}=await import('/src/stores/uiStore.ts');useUIStore.getState().setFullDarkView(false);});await frames(20);assert.equal((await viewPixels()).page,originalPage);
  }
  await page.evaluate(()=>window.documentFixture.engine().setProperties({paperColor:'#ffffff'}));await frames(20);pass('white/yellow/green/blue/black/custom notebook paper restores exactly and is never rewritten by the view preference');
  for(const mode of ['note','pdf']){
    await page.evaluate(mode=>window.documentFixture.select(mode),mode);
    await page.waitForFunction(mode=>{const c=window.documentFixture.engine()?.drawing.getCanvasElement();return c?.isConnected&&(mode==='pdf'?c.classList.contains('panvas-layer-canvas-decoration'):!c.classList.contains('panvas-layer-canvas-decoration'));},mode);await frames(20);
    await page.setViewportSize({width:1918,height:950});await frames(15);
    const bar=page.locator('.panvas-toolbar-surface').first();
    const titles=await bar.locator('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')));
    assert.equal(titles.includes('Pencil (N)'),false);assert.equal(titles.filter(t=>t==='Hand (Space)').length,1);assert.equal(titles.indexOf('Hand (Space)'),titles.indexOf('Select (V)')+1);
    const ordered=['Undo (Ctrl+Z)','Redo (Ctrl+Y)','Handwriting to Text','Pen (P)','Highlighter (H)','Marker (M)','Eraser (E)','Text (T)','Select (V)','Hand (Space)','More Tools'];assert.deepEqual(titles.filter(t=>ordered.includes(t)),ordered);
    await bar.getByRole('button',{name:'More Tools',exact:true}).click();const more=page.getByRole('menu',{name:'More Tools',exact:true});assert.equal(await more.getByRole('button',{name:'Hand (Space)',exact:true}).count(),0);await more.getByRole('button',{name:'Pencil (N)',exact:true}).click();assert.equal(await page.evaluate(()=>window.documentFixture.engine().tools.getState().drawingTool),'pencil');
    const pos=await position(100,200);await nativeStroke(pos,'pen');assert.equal(await page.evaluate(()=>window.documentFixture.engine().drawing.getStrokes().at(-1).tool),'pencil');await page.keyboard.press('n');assert.equal(await page.evaluate(()=>window.documentFixture.engine().tools.getState().drawingTool),'pencil');
    pass(`${mode} toolbar order, Pencil in More, no duplicate Hand, native Pencil stroke and N shortcut`);
    for(const width of [1280,900,680,620,480,360]){
      await page.setViewportSize({width,height:950});await frames(15);
      const bounds=await bar.boundingBox();const viewportWidth=await page.evaluate(()=>innerWidth);assert.ok(bounds.x>=-1&&bounds.x+bounds.width<=viewportWidth+1,`${mode} toolbar fits at ${width}`);
      await bar.getByRole('button',{name:'More Tools',exact:true}).click();const menu=page.getByRole('menu',{name:'More Tools',exact:true});await menu.waitFor({state:'visible'});
      // Overlay placement starts hidden; each tool's visibility transition must
      // finish before measuring whether it is accessible to a person.
      const pencilEntry=menu.locator('button[aria-label="Pencil (N)"]');if(await pencilEntry.count())await pencilEntry.waitFor({state:'visible'});
      const handEntry=menu.locator('button[aria-label="Hand (Space)"]');if(await handEntry.count())await handEntry.waitFor({state:'visible'});
      const pencils=await menu.getByRole('button',{name:'Pencil (N)',exact:true}).count(),active=await bar.locator('button[title^="Pencil"]').count();assert.equal(pencils+active,1,'Pencil remains reachable exactly once');const hands=await menu.getByRole('button',{name:'Hand (Space)',exact:true}).count()+await bar.getByRole('button',{name:'Hand (Space)',exact:true}).count();assert.equal(hands,1,'Hand remains reachable exactly once');await bar.getByRole('button',{name:'More Tools',exact:true}).click();await menu.waitFor({state:'hidden'});
    }
    pass(`${mode} toolbar and compact active Pencil stay reachable without overflow at 1280/900/680/620/480/360px`);
    await page.setViewportSize({width:1280,height:950});await page.evaluate(async()=>{const{useLayoutStore}=await import('/src/stores/layoutStore.ts');useLayoutStore.setState({notebookModeLevel:2,isToolbarCollapsed:false});});await frames(15);
    const fullscreenTools=page.locator('.panvas-floating-toolbar').first();assert.equal(await fullscreenTools.getByRole('button',{name:'Pencil (N)',exact:true}).count(),0);assert.equal(await fullscreenTools.getByRole('button',{name:'Hand (Space)',exact:true}).count(),1);await page.evaluate(async()=>{const{useLayoutStore}=await import('/src/stores/layoutStore.ts');useLayoutStore.setState({notebookModeLevel:1,isToolbarCollapsed:false});});
  }
  pass('fullscreen notebook/PDF toolbar follows the same Pencil/Hand contract');
  await page.setViewportSize({width:1280,height:950});
  await page.evaluate(async()=>{
    const f=window.documentFixture,{useLayoutStore}=await import('/src/stores/layoutStore.ts');useLayoutStore.setState({notebookModeLevel:0,isToolbarCollapsed:false});f.select('note');
  });
  await page.waitForFunction(()=>window.documentFixture.engine()?.drawing.getCanvasElement()?.isConnected&&!window.documentFixture.engine().drawing.getCanvasElement().classList.contains('panvas-layer-canvas-decoration'));await frames(15);
  await page.evaluate(async()=>{
    const e=window.documentFixture.engine(),{createEmptyDrawingData}=await import('/src/components/notebook/engine/drawingTypes.ts'),{createStickyNote}=await import('/src/components/notebook/stickyNotes.ts');const data=createEmptyDrawingData();Object.assign(data.properties,{extraLeft:140,extraRight:140,extraTop:140,extraBottom:140});data.objects=[{...createStickyNote({id:'ux-sticky',x:100,y:300}),width:200,height:120}];e.setDrawingData(data,window.documentFixture.ids.note);e.viewport.setZoom(1);e.tools.setMode('select');e.history.clear();e.selection.select('ux-sticky','text');e.input.notifyChange();
  });await frames(15);await position(100,300);await frames(4);
  const sticky=page.locator('[data-text-object-id="ux-sticky"]');await sticky.locator('.ProseMirror').waitFor();assert.equal(await sticky.locator('[data-text-resize-handle]').count(),8);
  const stickyData=()=>page.evaluate(()=>structuredClone(window.documentFixture.engine().texts.getTexts().find(t=>t.id==='ux-sticky')));
  const paintedSelection=()=>page.evaluate(()=>{let rectangles=0;const ctx=new Proxy({strokeRect:()=>{rectangles++;}},{get:(target,key)=>target[key]??(()=>{})});const e=window.documentFixture.engine();e.selection.renderSelection(ctx);return{rectangles,selected:e.selection.getSelectedElements()};});
  assert.equal((await paintedSelection()).rectangles,0);assert.equal((await paintedSelection()).selected[0].id,'ux-sticky');
  pass('single sticky has eight DOM resize handles and zero duplicate canvas selection boxes, with logical ownership retained');
  const dragStickyHandle=async(width,height,pointerType='mouse',rotation=0)=>{
    const object=await stickyData(),surface=await sticky.boundingBox(),handle=await sticky.locator('[data-text-resize-handle="br"]').boundingBox();const scale=(rotation%180?surface.height:surface.width)/object.width,start={x:handle.x+handle.width/2,y:handle.y+handle.height/2},dx=(width-object.width)*scale,dy=(height-object.height)*scale,delta=rotation===90?{x:-dy,y:dx}:rotation===180?{x:-dx,y:-dy}:rotation===270?{x:dy,y:-dx}:{x:dx,y:dy},end={x:start.x+delta.x,y:start.y+delta.y};assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.closest('[data-text-object-id]')?.dataset.textObjectId,start),'ux-sticky','resize starts on the actual selected sticky handle');await strokeBetween(start,end,pointerType);await frames(5);return stickyData();
  };
  let resized=await dragStickyHandle(20,20,'pen');assert.equal(resized.width,32);assert.equal(resized.height,32);
  await page.keyboard.press('Control+z');await frames(4);assert.equal((await stickyData()).width,200);assert.equal((await stickyData()).height,120);await page.keyboard.press('Control+y');await frames(4);assert.equal((await stickyData()).width,32);assert.equal((await stickyData()).height,32);
  await page.evaluate(()=>{const e=window.documentFixture.engine();e.tools.setMode('text');e.texts.getEditor('ux-sticky')?.commands.setContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'A deliberately long tiny note that wraps and scrolls without changing the note dimensions.'}]}]});});await frames(10);assert.equal((await stickyData()).width,32);assert.equal((await stickyData()).height,32);await page.evaluate(()=>window.documentFixture.engine().tools.setMode('select'));await frames(4);
  pass('native pen resizes to 32×32; keyboard undo/redo and long TipTap content preserve the chosen size');
  await sticky.getByRole('button',{name:'Sticky note shape',exact:true}).click();const shapePanel=page.getByRole('toolbar',{name:'Sticky note controls'});await shapePanel.getByRole('combobox',{name:'Sticky note shape'}).selectOption('rectangle');await shapePanel.getByRole('button',{name:'Close sticky note style'}).click();
  resized=await dragStickyHandle(240,40);assert.ok(Math.abs(resized.width-240)<1&&Math.abs(resized.height-40)<1);resized=await dragStickyHandle(40,240,'pen');assert.ok(Math.abs(resized.width-40)<1&&Math.abs(resized.height-240)<1);
  for(const shape of ['oval','square','circle','star','rounded-rect']){
    await sticky.getByRole('button',{name:'Sticky note shape',exact:true}).click();await shapePanel.getByRole('combobox').selectOption(shape);await shapePanel.getByRole('button',{name:'Close sticky note style'}).click();const before=await stickyData();assert.ok(before.width<=40.1&&before.height<=240.1,'shape does not enlarge note');
    resized=await dragStickyHandle(60,90,'pen');if(shape==='square'||shape==='circle')assert.equal(resized.width,resized.height);else assert.ok(Math.abs(resized.width-60)<1&&Math.abs(resized.height-90)<1);
    await dragStickyHandle(40,40);
  }
  pass('rectangle/oval support wide and tall bounds; square/circle stay equal; all six shapes avoid inflation');
  const panels=[];
  for(const zoom of [.75,1,2.5]){
    await page.evaluate(zoom=>window.documentFixture.engine().viewport.setZoom(zoom),zoom);await frames(12);await position(100,300);await frames(5);
    for(const panel of ['color','shape']){
      await sticky.getByRole('button',{name:`Sticky note ${panel}`,exact:true}).click();const controls=page.getByRole('toolbar',{name:'Sticky note controls'});await controls.waitFor({state:'visible'});const bounds=await controls.boundingBox();assert.ok(bounds.x>=11&&bounds.y>=11&&bounds.x+bounds.width<=1280-11&&bounds.y+bounds.height<=950-11);assert.ok(bounds.width<=180&&bounds.height<=115,`${panel} remains physically compact at ${zoom}×`);panels.push({zoom,panel,...bounds});await page.screenshot({path:`artifacts/interaction-ux/sticky-${panel}-${zoom}-${electronMode?'electron':'web'}.png`});
      if(panel==='color'&&zoom===1){assert.equal(await controls.locator('button[aria-label$="sticky note"]').count(),7);await controls.getByRole('button',{name:'Lavender sticky note'}).click();await controls.getByLabel('Custom color picker').fill('#238c77');const opacity=controls.getByRole('slider',{name:'Sticky note opacity'});await opacity.fill('55');await opacity.press('ArrowRight');assert.equal((await stickyData()).metadata.color,'#238c77');assert.equal((await stickyData()).metadata.opacity,.56);}
      await controls.getByRole('button',{name:'Close sticky note style'}).click();
    }
  }
  pass('color/custom/opacity and shape palettes stay within 180×115 CSS pixels at 0.75×/1×/2.5× page zoom');
  assert.equal(await page.evaluate(()=>window.documentFixture.engine().tools.getState().mode),'select','palette clicks retain Select mode');
  await page.evaluate(async()=>{const e=window.documentFixture.engine(),{createStickyNote}=await import('/src/components/notebook/stickyNotes.ts');e.viewport.setZoom(1);e.texts.addText({...createStickyNote({id:'ux-second',x:320,y:300}),width:100,height:80});e.selection.select('ux-sticky','text');e.input.notifyChange();});await frames(8);await position(300,300);await frames(4);
  const second=page.locator('[data-text-object-id="ux-second"]'),secondBounds=await second.boundingBox();await page.keyboard.down('Shift');await page.mouse.click(secondBounds.x+secondBounds.width/2,secondBounds.y+secondBounds.height/2);await page.keyboard.up('Shift');await frames(5);assert.equal((await paintedSelection()).selected.length,2);assert.equal((await paintedSelection()).rectangles,18);assert.equal(await sticky.locator('[data-text-resize-handle]').count(),0);
  const beforeGroup=await page.evaluate(()=>window.documentFixture.engine().texts.getTexts().map(t=>({id:t.id,x:t.x,y:t.y})));const sb=await sticky.boundingBox();await strokeBetween({x:sb.x+sb.width/2,y:sb.y+sb.height/2},{x:sb.x+sb.width/2+15,y:sb.y+sb.height/2+10},'mouse');const afterGroup=await page.evaluate(()=>window.documentFixture.engine().texts.getTexts().map(t=>({id:t.id,x:t.x,y:t.y})));for(let i=0;i<2;i++){assert.ok(Math.abs(afterGroup[i].x-beforeGroup[i].x-15)<1);assert.ok(Math.abs(afterGroup[i].y-beforeGroup[i].y-10)<1);}
  await page.evaluate(()=>{const e=window.documentFixture.engine();e.selection.clearSelection();e.selection.selectWithinLoop([{x:80,y:280},{x:470,y:280},{x:470,y:430},{x:80,y:430}].map((p,i)=>({...p,pressure:1,t:i})));});assert.equal((await paintedSelection()).selected.length,2);
  pass('native Shift selection and group dragging retain generic multi-selection; lasso encloses both notes');
  const copyResult=await page.evaluate(async()=>{const e=window.documentFixture.engine(),before=e.texts.getTexts().length;await e.selection.copySelection();await e.selection.pasteSelection();const pasted=e.selection.getSelectedElements().map(s=>e.texts.getTexts().find(t=>t.id===s.id));return{before,after:e.texts.getTexts().length,pasted};});assert.equal(copyResult.after,copyResult.before+2);assert.equal(copyResult.pasted.find(t=>t.metadata.color==='#238c77')?.width,40);
  await page.evaluate(async()=>{const e=window.documentFixture.engine();e.selection.select('ux-sticky','text');await e.selection.duplicateSelection();});assert.equal(await page.evaluate(()=>window.documentFixture.engine().texts.getTexts().length),5);
  await page.evaluate(()=>window.documentFixture.engine().selection.deleteSelection());assert.equal(await page.evaluate(()=>window.documentFixture.engine().texts.getTexts().length),4);await page.evaluate(()=>window.documentFixture.engine().history.undo());assert.equal(await page.evaluate(()=>window.documentFixture.engine().texts.getTexts().length),5);await page.evaluate(()=>window.documentFixture.engine().history.redo());assert.equal(await page.evaluate(()=>window.documentFixture.engine().texts.getTexts().length),4);
  await page.evaluate(()=>{const e=window.documentFixture.engine();e.selection.select('ux-sticky','text');e.selection.bringToFront();});await frames(5);await sticky.dblclick({position:{x:20,y:20}});await page.waitForFunction(()=>window.documentFixture.engine().tools.getState().mode==='text');assert.equal(await sticky.locator('.ProseMirror').evaluate(el=>el.contains(document.activeElement)||el===document.activeElement),true);await page.keyboard.press('Escape');await page.evaluate(()=>window.documentFixture.engine().tools.setMode('select'));await frames(4);
  pass('copy/paste, duplicate, delete undo/redo and single-note double-click editing preserve resized sticky metadata');
  for(const rotation of [0,90,180,270]){
    await page.evaluate(async rotation=>{const f=window.documentFixture,{notebookRepository}=await import('/src/repositories/NotebookRepository.ts'),{useWorkspaceStore}=await import('/src/stores/workspaceStore.ts');await notebookRepository.setPdfPageState(f.ids.workspace,f.ids.pdf,{version:1,pageOrder:[1,2,3],rotations:{1:rotation}});await useWorkspaceStore.getState().loadWorkspaceContents(f.ids.workspace);f.select('pdf');},rotation);
    await page.waitForFunction(rotation=>window.documentFixture.engine()?.drawing.getCanvasElement()?.isConnected&&window.documentFixture.engine().viewport.pageRotation===rotation&&window.documentFixture.engine().drawing.getCanvasElement().classList.contains('panvas-layer-canvas-decoration'),rotation);await frames(15);
    await page.evaluate(async()=>{const e=window.documentFixture.engine(),{createStickyNote}=await import('/src/components/notebook/stickyNotes.ts');e.setProperties({extraLeft:140,extraRight:140});e.viewport.setZoom(1);e.texts.removeText('ux-sticky');e.texts.addText({...createStickyNote({id:'ux-sticky',x:100,y:300}),width:200,height:120});e.tools.setMode('select');e.history.clear();e.selection.select('ux-sticky','text');e.input.notifyChange();});await frames(8);await position(100,300);await frames(5);assert.equal(await sticky.locator('[data-text-resize-handle]').count(),8);assert.equal((await paintedSelection()).rectangles,0);resized=await dragStickyHandle(40,50,'pen',rotation);assert.ok(Math.abs(resized.width-40)<1&&Math.abs(resized.height-50)<1,`rotated PDF sticky resize ${rotation}`);
    await sticky.getByRole('button',{name:'Sticky note color',exact:true}).click();const controls=page.getByRole('toolbar',{name:'Sticky note controls'});await controls.waitFor({state:'visible'});const bounds=await controls.boundingBox();assert.ok(bounds.width<=180&&bounds.height<=115);await controls.getByRole('button',{name:'Close sticky note style'}).click();
  }
  pass('PDF single-sticky chrome, native pen resize and compact palette remain correct at 0/90/180/270°');
  await page.evaluate(()=>window.documentFixture.select('note'));await page.waitForFunction(()=>window.documentFixture.engine()?.drawing.getCanvasElement()?.isConnected&&!window.documentFixture.engine().drawing.getCanvasElement().classList.contains('panvas-layer-canvas-decoration')&&window.documentFixture.engine().texts.getTexts().some(t=>t.id==='ux-sticky'));await frames(10);
  await page.evaluate(()=>{const e=window.documentFixture.engine();e.tools.setMode('select');e.selection.select('ux-sticky','text');e.selection.bringToFront();});await frames(5);await position(115,310);resized=await dragStickyHandle(20,20,'pen');assert.equal(resized.width,32);assert.equal(resized.height,32);const persistedSticky=await stickyData();const originalIds=await page.evaluate(()=>window.documentFixture.ids);
  let savedSmall=false;for(let attempt=0;attempt<120&&!savedSmall;attempt++){savedSmall=await page.evaluate(async()=>{const f=window.documentFixture,data=await f.saved(f.ids.note),object=data?.objects?.find(t=>t.id==='ux-sticky');return data?.objects?.filter(t=>t.type==='text').length===4&&object?.width===32&&object?.height===32&&object?.metadata?.color==='#238c77';});if(!savedSmall)await frames(2);}assert.equal(savedSmall,true,'the native resize reaches the real repository before reload');
  await page.evaluate(async()=>{const{useUIStore}=await import('/src/stores/uiStore.ts');useUIStore.getState().setTheme('dark');useUIStore.getState().setFullDarkView(true);});
  await page.reload();await page.waitForFunction(()=>window.documentFixture?.engine()?.drawing.getCanvasElement()?.isConnected);await frames(12);assert.equal(await page.getByRole('alertdialog').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('full-dark-view')),true);
  await page.evaluate(async ids=>{const{useWorkspaceStore}=await import('/src/stores/workspaceStore.ts');await useWorkspaceStore.getState().setActiveWorkspace(ids.workspace);await useWorkspaceStore.getState().loadWorkspaceContents(ids.workspace);useWorkspaceStore.getState().setActivePage(ids.note,false);},originalIds);await page.waitForFunction(()=>window.documentFixture.engine()?.texts.getTexts().some(t=>t.id==='ux-sticky'));await frames(15);const restoredSticky=await stickyData();assert.equal(restoredSticky.width,32);assert.equal(restoredSticky.height,32);assert.deepEqual(restoredSticky.metadata,persistedSticky.metadata);assert.deepEqual(restoredSticky.content,persistedSticky.content);assert.equal(await page.getByRole('alertdialog').count(),0);
  pass('32×32 size, shape, color, opacity and text survive actual save/reload; remembered Full Dark starts without another prompt');
  assert.deepEqual(errors,[]);
  await mkdir('artifacts/interaction-ux',{recursive:true});
  await writeFile(`artifacts/interaction-ux/regressions-${electronMode?'electron':'web'}.json`,JSON.stringify({passed,research,utilityChecks,panels,errors},null,2));
  console.log(`TOTAL: ${passed} passed`);
} finally { await electronApp?.close();await browser?.close();await server.close(); }
