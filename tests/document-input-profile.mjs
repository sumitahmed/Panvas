import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';
import { writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const electronMode = process.argv.includes('--electron');
const directory = await mkdtemp(path.join(tmpdir(), 'panvas-document-profile-'));
const baselineIndex = process.argv.indexOf('--baseline-ref');
const baselineRef = baselineIndex < 0 ? null : process.argv[baselineIndex + 1];
const baselineFiles = ['src/components/notebook/NotebookPageView.tsx', 'src/components/notebook/engine/DrawingEngine.ts', 'src/components/notebook/engine/WetInkSurface.ts', 'src/components/notebook/engine/InputManager.ts', 'src/components/notebook/engine/touchViewportGesture.ts', 'src/components/pdf/PdfWorkspace.tsx', 'src/components/pdf/PdfPageRenderer.tsx'];
const baselineSources = baselineRef ? baselineFiles.map(file => [file, execFileSync('git', ['show', `${baselineRef}:${file}`], { encoding: 'utf8' })]) : [];

const count = name => `window.__documentWork?.bump('${name}');`;
const server = await createServer({ mode: 'web', cacheDir: path.join(directory, 'vite-cache'), server: { port: 0, open: false }, plugins: [{
  name: 'document-work-counters', enforce: 'pre', transform(code, id) {
    id = id.replaceAll('\\', '/').split('?')[0];
    const historical = baselineSources.find(([file]) => id.endsWith('/' + file));
    if (historical) code = historical[1];
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
app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();const win=new BrowserWindow({show:false,width:1918,height:1198,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}});win.loadURL(${JSON.stringify(server.resolvedUrls.local[0]+'tests/fixtures/document-input.html?handwritingTrace=1&gate0Profile=1')});});`);
  const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_TEST_CONTEXT','NODE_TEST_WORKER_ID'])delete env[key];
  electronApp=await _electron.launch({args:[path.join(directory,'bootstrap.cjs')],env}); page=await electronApp.firstWindow();
} else {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1918, height: 1198 } });
}
page.on('pageerror', e => console.log('PAGEERROR', e.message));
page.on('console', e => { if (e.type() === 'error') console.log('ERROR', e.text()); });
const frames = n => page.evaluate(async n => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); }, n);
try {
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/document-input.html?handwritingTrace=1&gate0Profile=1');
  await page.waitForFunction(() => window.documentFixture?.engine()?.drawing.getCanvasElement());
  await frames(20);
  await page.evaluate(() => { window.documentFixture.engine().tools.setDrawingTool('pen'); });
  await frames(2);
  const noteGeometry = await page.evaluate(() => {
    const f = window.documentFixture, e = f.engine(), c = e.drawing.getCanvasElement(), b = c.getBoundingClientRect();
    return { geometry: f.geometry(), css: { width: c.clientWidth, height: c.clientHeight, styleWidth: c.style.width }, bounds: b.toJSON(), zoom: e.viewport.getState().scale };
  });
  console.log('NOTE GEOMETRY', JSON.stringify({ width: noteGeometry.geometry.width, zoom: noteGeometry.zoom }));
  const points = [];
  for (const x of [-130,-70,100,784,804,864,924]) {
    const pos = await page.evaluate(x => {
      const e = window.documentFixture.engine(), c = e.drawing.getCanvasElement(), b = c.getBoundingClientRect(), p = e.viewport.pageToCanvas(x, 100);
      const clientX = b.left + p.x * b.width / c.clientWidth, clientY = b.top + p.y * b.height / c.clientHeight;
      const hit = document.elementFromPoint(clientX, clientY);
      return { x: clientX, y: clientY, hit: hit?.outerHTML.slice(0,300), before: e.drawing.getStrokes().length };
    }, x);
    await page.mouse.move(pos.x, pos.y); await page.mouse.down(); await page.mouse.move(pos.x+8, pos.y+8); await page.mouse.up();
    points.push({canonicalX:x,...pos,after:await page.evaluate(()=>window.documentFixture.engine().drawing.getStrokes().length)});
  }
  console.log('NOTE STARTS', points.length);
  await page.waitForFunction(() => !window.documentFixture.engine().drawing.spareWetInk);
  await page.evaluate(()=>window.__documentWork.reset());
  if (!process.argv.includes('--quick')) await page.evaluate(async () => {
    const e = window.documentFixture.engine(), c = e.drawing.getCanvasElement(), b = c.getBoundingClientRect();
    e.tools.setDrawingTool('pen');
    for(let stroke=0;stroke<8;stroke++) {
      const emit=(type,j) => c.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:91,pointerType:'pen',button:0,buttons:type==='pointerup'?0:1,pressure:.5,clientX:b.left+250+j*3,clientY:b.top+350+stroke*35+Math.sin(j*.2)*12}));
      emit('pointerdown',0);
      for(let j=1;j<=60;j++) { emit('pointerrawupdate',j-.5); emit('pointermove',j); if(j%2===0) await new Promise(requestAnimationFrame); }
      emit('pointerup',60);
      await new Promise(requestAnimationFrame);
    }
  });
  await frames(4);
  const ink = await page.evaluate(()=>({work:window.__documentWork.report(),traces:window.__panvasHandwritingTraces.map(t=>({counters:t.counters,frames:t.frames.length,timings:Object.fromEntries(Object.entries(t.timings).map(([k,v])=>[k,{n:v.length,total:v.reduce((a,b)=>a+b,0),max:Math.max(...v)}]))}))}));
  console.log('INK',JSON.stringify(ink.work));
  await page.evaluate(()=>window.documentFixture.engine().tools.setMode('erase')); await frames(2);
  const eraser=[];
  for(const action of ['hover','down','move','up']) {
    if(action==='hover') await page.mouse.move(points[2].x,points[2].y);
    if(action==='down') await page.mouse.down();
    if(action==='move') await page.mouse.move(points[2].x+50,points[2].y+50);
    if(action==='up') await page.mouse.up();
    eraser.push({action, cursor:await page.evaluate(()=>getComputedStyle(window.documentFixture.engine().drawing.getCanvasElement()).cursor)});
  }
  console.log('ERASER', 'hover/down/move/up recorded');
  await frames(30);
  const notebookZoomWork = await page.evaluate(async () => {
    const e = window.documentFixture.engine(), canvas = e.drawing.getCanvasElement();
    const scroller = canvas.closest('.notebook-viewport'), bounds = scroller.getBoundingClientRect();
    const unsubscribe = e.viewport.subscribe(() => window.__documentWork.bump('viewportNotifications'));
    window.__documentWork.reset();
    for (let i = 0; i < 24; i++) {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: i < 12 ? -12 : 12, clientX: bounds.left + bounds.width * .65, clientY: bounds.top + bounds.height * .45 }));
      await new Promise(requestAnimationFrame);
    }
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    unsubscribe();
    return window.__documentWork.report();
  });
  console.log('NOTE ZOOM', JSON.stringify(notebookZoomWork));
  await page.evaluate(()=>window.documentFixture.select('pdf'));
  await page.waitForFunction(()=>window.documentFixture.engine()?.drawing.getCanvasElement()?.closest('[data-pdf-source-page]'));
  await frames(30);
  await page.evaluate(()=>window.documentFixture.engine().tools.setDrawingTool('pen')); await frames(2);
  console.log('PDF CURSOR', await page.evaluate(()=>getComputedStyle(window.documentFixture.engine().drawing.getCanvasElement()).cursor.includes('data:image/svg+xml')?'SVG':'crosshair'));
  await page.evaluate(()=>window.__documentWork.reset());
  const zoom = await page.evaluate(async () => {
    const e=window.documentFixture.engine(), scroller=document.querySelector('[aria-label="PDF document pages"]'), frame=document.querySelector('[data-pdf-source-page="1"]');
    const box=scroller.getBoundingClientRect(), clientX=box.left+box.width*.65,clientY=box.top+box.height*.45;
    const before=frame.getBoundingClientRect();
    const anchor={x:(clientX-before.left)/e.viewport.getState().scale,y:(clientY-before.top)/e.viewport.getState().scale};
    const drift=[];
    for(let i=0;i<24;i++) {
      scroller.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:i<12?-12:12,clientX,clientY}));
      await new Promise(requestAnimationFrame);
      const after=frame.getBoundingClientRect(),scale=e.viewport.getState().scale;
      drift.push({x:after.left+anchor.x*scale-clientX,y:after.top+anchor.y*scale-clientY});
    }
    for(let i=0;i<24;i++)await new Promise(requestAnimationFrame);
    return {drift,finalScale:e.viewport.getState().scale};
  });
  const pdfWork=await page.evaluate(()=>window.__documentWork.report());
  console.log('PDF ZOOM',JSON.stringify({ maxDriftX: Math.max(...zoom.drift.map(p=>Math.abs(p.x))), maxDriftY: Math.max(...zoom.drift.map(p=>Math.abs(p.y))), work:pdfWork }));
  await mkdir('artifacts/document-input', {recursive:true});
  const label=baselineRef?'fresh-baseline':'fresh-after';
  const suffix=electronMode?'-electron':'-web';
  await page.screenshot({path:`artifacts/document-input/${label}${suffix}-pdf.png`});
  await writeFile(`artifacts/document-input/${label}${suffix}.json`,JSON.stringify({noteGeometry,points,ink,eraser,notebookZoomWork,zoom,pdfWork},null,2));
} finally { await browser?.close(); await electronApp?.close(); await server.close(); }
