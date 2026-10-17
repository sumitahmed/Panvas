import assert from 'node:assert/strict';
import { chromium, _electron } from 'playwright';
import { createServer, build as buildVite, preview } from 'vite';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const native = process.argv.includes('--electron'), phase = process.argv.find(a => a.startsWith('--phase='))?.split('=')[1] ?? 'before';
const cpuProfile = !process.argv.includes('--no-cpu-profile');
const out = 'artifacts/critical-stabilization-20261016/performance'; await mkdir(out, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-populated-'));
const baseline = process.argv.includes('--baseline') ? JSON.parse(await readFile('artifacts/critical-stabilization-20261016/baseline-location.json','utf8')) : null;
const sourcePlugins = baseline ? [{
  name:'preserved-source', enforce:'pre', async transform(code,id) {
    const rel=path.relative(process.cwd(),id.split('?')[0]).replaceAll('\\','/');
    if(!rel.startsWith('src/'))return;
    try{return {code:await readFile(path.join(baseline.root,'files',rel),'utf8'),map:null};}catch{return;}
  }
}] : [];
const compiled=process.argv.includes('--production'), suppliedBuild=process.argv.find(a=>a.startsWith('--build-dir='))?.slice(12);
const buildDir=suppliedBuild??path.join(directory,'dist');
let server;
if(compiled){
  if(!suppliedBuild)await buildVite({mode:'web',base:'/',logLevel:'error',plugins:sourcePlugins,build:{outDir:buildDir,emptyOutDir:false,minify:false,rollupOptions:{input:path.resolve('tests/fixtures/populated-notebook.html')}}});
  if(process.argv.includes('--build-only')) { await writeFile(path.join(out, `${phase}-build.json`), JSON.stringify({ buildDir })); console.log(buildDir); process.exit(0); }
  server=await preview({configFile:false,build:{outDir:buildDir},preview:{port:0,open:false}});
}else{server=await createServer({mode:'web',cacheDir:path.join(directory,'vite'),optimizeDeps:{entries:['tests/fixtures/populated-notebook.html']},server:{port:0,open:false,hmr:false},plugins:sourcePlugins});await server.listen();}
const mode=native?'electron':'chromium', report={mode,phase,compiled,buildDir,profile:directory,scenarios:[],errors:[]}; let browser, app, page, session;
const frames = n => page.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);},n);
const point=()=>page.evaluate(()=>{
  const c=window.populated.engine().drawing.getCanvasElement(),b=c.getBoundingClientRect(),v=c.closest('.notebook-viewport').getBoundingClientRect();
  return{x:Math.max(b.left,v.left)+Math.min(b.width,v.width)*.4,y:Math.max(b.top,v.top)+Math.min(b.bottom,v.bottom,window.innerHeight)-Math.max(b.top,v.top)>0 ? Math.max(b.top,v.top)+Math.min(350,(Math.min(b.bottom,v.bottom)-Math.max(b.top,v.top))*.55):v.top+150};
});
async function measure(name,action){
  await frames(3); if (cpuProfile) await session.send('Profiler.start'); await page.evaluate(()=>{
    window.populated.reset();window.__reactWork={commits:0,renders:{}};window.__inputFrames=[];window.__frameTimes=[];window.__longTasks=[];window.__measuring=true;const generation=window.__generation=(window.__generation??0)+1;let last;
    const tick=t=>{if(!window.__measuring||generation!==window.__generation)return;if(last!==undefined)window.__frameTimes.push(t-last);last=t;requestAnimationFrame(tick);};requestAnimationFrame(tick);
    window.__longObserver=new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));window.__longObserver.observe({type:'longtask',buffered:false});
  }); const metricsBefore=await session.send('Performance.getMetrics');const start=performance.now();await action();await frames(3);
  const result=await page.evaluate(()=>{window.__measuring=false;window.__longObserver.disconnect();return{timings:window.populated.report(),react:window.__reactWork,inputToFrame:window.__inputFrames,frames:window.__frameTimes,longTasks:window.__longTasks,gate:window.__PANVAS_GATE0_PROFILER__?.report(),canvases:[...document.querySelectorAll('.notebook-viewport canvas')].map(c=>({width:c.width,height:c.height})),memory:performance.memory?.usedJSHeapSize};});
  result.name=name;result.elapsed=performance.now()-start;report.scenarios.push(result);
  const prior=Object.fromEntries(metricsBefore.metrics.map(m=>[m.name,m.value]));result.browserMetrics=Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value-(prior[m.name]??0)]));
  const profile=cpuProfile ? (await session.send('Profiler.stop')).profile : null;
  if (profile) await writeFile(path.join(out,`${phase}-${mode}-${name}.cpuprofile`),JSON.stringify(profile));
  const sorted=profile ? profile.nodes.map(n=>({name:n.callFrame.functionName,file:n.callFrame.url,line:n.callFrame.lineNumber,hits:n.hitCount??0})).sort((a,b)=>b.hits-a.hits).slice(0,18) : [];
  result.cpuTop=sorted;
  console.log(name,JSON.stringify({elapsed:result.elapsed,frames:result.frames.length,maxFrame:Math.max(...result.frames),longTasks:result.longTasks.map(t=>t.duration),timings:Object.fromEntries(Object.entries(result.timings).map(([k,a])=>[k,{count:a.length,total:a.reduce((x,y)=>x+y,0),max:Math.max(...a)}])),cpu:sorted.slice(0,6)}));
}
try{
  const url=server.resolvedUrls.local[0]+'tests/fixtures/populated-notebook.html?gate0Profile=1';
  if(native){
    for(const [entry,file] of [['electron/ipc/domain-handlers.ts','domain.cjs'],['electron/preload.ts','preload.cjs']])await build({entryPoints:[entry],outfile:path.join(directory,file),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'});
    await writeFile(path.join(directory,'bootstrap.cjs'),`const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=path.join(__dirname,'workspaces');process.env.VITE_DEV_SERVER_URL=${JSON.stringify(server.resolvedUrls.local[0])};app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();new BrowserWindow({show:true,width:1440,height:1000,webPreferences:{preload:path.join(__dirname,'preload.cjs'),backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}}).loadURL('about:blank');});`);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;app=await _electron.launch({args:[path.join(directory,'bootstrap.cjs')],env});page=await app.firstWindow();
  }else{browser=await chromium.launch({headless:false});page=await browser.newPage({viewport:{width:1440,height:1000}});}
  page.on('pageerror',e=>report.errors.push(e.message));report.workers=[];page.on('worker',worker=>report.workers.push(worker.url()));page.setDefaultTimeout(60000);
  await page.addInitScript(()=>{
    window.__reactWork={commits:0,renders:{}};
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject:()=>1,onCommitFiberUnmount:()=>{},onCommitFiberRoot(_id,root){
      if(!window.__measuring)return;window.__reactWork.commits++;
      const visit=f=>{if((f.flags&1)&&typeof f.type==='function'){const name=f.type.displayName||f.type.name||'anonymous';window.__reactWork.renders[name]=(window.__reactWork.renders[name]??0)+1;}for(let child=f.child;child;child=child.sibling)visit(child);};visit(root.current);
    }};
    let pending=false,last=0;
    document.addEventListener('pointermove',event=>{if(!window.__measuring||!(event.target instanceof HTMLCanvasElement))return;last=event.timeStamp;if(!pending){pending=true;requestAnimationFrame(()=>{pending=false;if(window.__measuring)window.__inputFrames.push(performance.now()-last);});}},true);
  });
  await page.goto(url);
  await page.waitForFunction(()=>window.populated && window.populated.engine()?.getDrawingOwnership().pageId===window.populated.pages[0]);
  await page.waitForFunction(()=>document.querySelectorAll('[data-rendered-page-id]').length>=2);await frames(10);
  const notebookRow=page.getByText('Populated notebook',{exact:true}).locator('xpath=ancestor::*[@role="treeitem"][1]');
  if(await notebookRow.getAttribute('aria-expanded')==='false')await notebookRow.locator('[data-tree-toggle]').first().click();
  const sectionRow=page.getByText('Section 1',{exact:true}).locator('xpath=ancestor::*[@role="treeitem"][1]');
  await sectionRow.waitFor({state:'visible'});
  if(await sectionRow.getAttribute('aria-expanded')==='false')await sectionRow.locator('[data-tree-toggle]').first().click();
  await page.locator('aside').getByText('Populated 2',{exact:true}).waitFor({state:'visible'});
  session=await page.context().newCDPSession(page);await session.send('Performance.enable');await session.send('Profiler.enable');await session.send('Profiler.setSamplingInterval',{interval:1000});
  if(process.argv.includes('--slow'))await session.send('Emulation.setCPUThrottlingRate',{rate:4});
  if(process.argv.includes('--geometry-only')){report.geometry=await page.evaluate(()=>window.populated.geometryProbe());console.log(JSON.stringify(report.geometry));}
  else {
  await page.screenshot({path:path.join(out,`${phase}-${mode}-populated.png`)});
  const viewport=page.locator('.notebook-viewport');const box=await viewport.boundingBox();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.5);
  await measure('scroll',async()=>{for(let i=0;i<36;i++){await page.mouse.wheel(0,i<18?150:-150);await frames(1);}});
  await page.getByTitle('Hand (Space)',{exact:true}).click();
  await measure('hand',async()=>{for(let i=0;i<3;i++){const p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x,p.y-210,{steps:24});await page.mouse.up();await frames(3);}});
  await page.getByTitle('Pen (P)',{exact:true}).click();await page.keyboard.press('Escape');
  const before=await page.evaluate(()=>window.populated.engine().drawing.getStrokes().length);
  await measure('draw',async()=>{for(let i=0;i<5;i++){const p=await point();const base={pointerType:'pen',button:'left',force:.6};await session.send('Input.dispatchMouseEvent',{...base,type:'mouseMoved',x:p.x,y:p.y,buttons:0});await session.send('Input.dispatchMouseEvent',{...base,type:'mousePressed',x:p.x,y:p.y,buttons:1,clickCount:1});for(let j=1;j<=45;j++)await session.send('Input.dispatchMouseEvent',{...base,type:'mouseMoved',x:p.x+j*2,y:p.y+Math.sin(j*.25+i)*16,buttons:1});await session.send('Input.dispatchMouseEvent',{...base,type:'mouseReleased',x:p.x+90,y:p.y+Math.sin(45*.25+i)*16,buttons:0,clickCount:1});await frames(3);}});
  assert.equal(await page.evaluate(()=>window.populated.engine().drawing.getStrokes().length),before+5);
  await measure('switch',async()=>{for(const i of [1,2,0,1,0]){const label=i===0?'Page 1':`Populated ${i+1}`;await page.locator('aside').getByText(label,{exact:true}).click();await page.waitForFunction(i=>window.populated.engine().getDrawingOwnership().pageId===window.populated.pages[i],i);await frames(3);}});
  await page.getByTitle('Eraser (E)',{exact:true}).click();await page.keyboard.press('Escape');
  await measure('erase',async()=>{const p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+60,p.y+40,{steps:20});await page.mouse.up();await frames(4);});
  await page.getByTitle('Undo (Ctrl+Z)',{exact:true}).click();await page.getByTitle('Redo (Ctrl+Y)',{exact:true}).click();
  await page.getByTitle('Select (V)',{exact:true}).click();
  await measure('select',async()=>{const p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+90,p.y+80,{steps:20});await page.mouse.up();});
  await page.screenshot({path:path.join(out,`${phase}-${mode}-final.png`)});
  if(process.argv.includes('--acceptance')){
    report.geometry=await page.evaluate(()=>window.populated.geometryProbe());assert.equal(report.geometry.openChannels,0,'Cached geometry retains exact pixels');
    await page.getByTitle('Text (T)',{exact:true}).click();
    const language=page.locator('[data-focused-sheet="true"] [data-live-page-visual] [aria-label="Code language"]').first();
    await language.scrollIntoViewIfNeeded();
    const beforeMenu=await page.evaluate(()=>JSON.stringify(window.populated.engine().getDrawingData()));
    report.menuTimings=[];
    await measure('menus',async()=>{
      for(let i=0;i<5;i++){const start=performance.now();await language.click();await page.getByRole('listbox',{name:'Code languages',exact:true}).waitFor({state:'visible'});report.menuTimings.push(performance.now()-start);await page.keyboard.press('Escape');}
      for(let i=0;i<5;i++){await page.getByRole('button',{name:'Highlight color',exact:true}).click();await page.getByRole('menu',{name:'Highlight color palette',exact:true}).waitFor({state:'visible'});await page.keyboard.press('Escape');}
    });
    assert.equal(await page.evaluate(()=>JSON.stringify(window.populated.engine().getDrawingData())),beforeMenu);
    report.expected=await page.evaluate(()=>{window.__expectedScene=window.populated.engine().getDrawingData();return {owner:window.populated.engine().getDrawingOwnership().pageId,objects:window.__expectedScene.objects.length};});
    let savedExactly = false;
    const saveDeadline = Date.now() + 30000;
    while (Date.now() < saveDeadline) {
      savedExactly = await page.evaluate(async()=>JSON.stringify(await window.populated.saved(window.populated.engine().getDrawingOwnership().pageId))===JSON.stringify(window.__expectedScene));
      if (savedExactly) break;
      await page.waitForTimeout(250);
    }
    assert.equal(savedExactly, true, 'Canonical storage matches the complete scene before reopening');
    const current=await page.evaluate(()=>window.populated.pages.indexOf(window.populated.engine().getDrawingOwnership().pageId));
    for(const i of [current===0?1:0,current]){await page.locator('aside').getByText(i===0?'Page 1':`Populated ${i+1}`,{exact:true}).click();await page.waitForFunction(i=>window.populated.engine().getDrawingOwnership().pageId===window.populated.pages[i],i);await frames(3);}
    assert.equal(await page.evaluate(()=>JSON.stringify(window.populated.engine().getDrawingData())===JSON.stringify(window.__expectedScene)),true,'Save/reopen retains complete ink, image and rich text scene');
    report.saveReopenExact=true;
    report.transport=await page.evaluate(()=>window.populated.transportChecks());
    assert.equal(report.transport.foreignRejected,true);assert.equal(report.transport.unchanged,true);
    if(!native){assert.equal(report.transport.rolledBack,true);assert.ok(report.workers.some(url=>url.includes('drawingSaveWorker')),'Actual worker transport must run, not silently fall back');}
  }
  assert.deepEqual(report.errors,[]);report.passed=true;
  }
}catch(error){report.failure=error.stack;console.error(error);await page?.screenshot({path:path.join(out,`${phase}-${mode}-failure.png`)}).catch(()=>{});process.exitCode=1;}finally{
 await writeFile(path.join(out,`${phase}-${mode}.json`),JSON.stringify(report,null,2));await browser?.close();await app?.close();await server.close();
}
