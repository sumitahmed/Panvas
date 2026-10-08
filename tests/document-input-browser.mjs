import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';
import { writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
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
app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();const win=new BrowserWindow({show:false,width:1918,height:1198,webPreferences:{preload:require('node:path').join(__dirname,'preload.cjs'),offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false}});win.loadURL(${JSON.stringify(server.resolvedUrls.local[0]+'tests/fixtures/document-input.html?handwritingTrace=1&gate0Profile=1')});});`);
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
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/document-input.html?handwritingTrace=1&gate0Profile=1');
  await page.waitForFunction(() => window.documentFixture?.engine()?.drawing.getCanvasElement());
  await frames(20);
  assert.equal(await page.evaluate(() => window.documentFixture.mode), electronMode ? 'electron' : 'web');
  const cdp = await page.context().newCDPSession(page);
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
  await page.evaluate(() => { window.documentFixture.engine().tools.setDrawingTool('pen'); });
  await frames(2);
  const noteGeometry = await page.evaluate(() => {
    const f = window.documentFixture, e = f.engine(), c = e.drawing.getCanvasElement(), b = c.getBoundingClientRect();
    return { geometry: f.geometry(), css: { width: c.clientWidth, height: c.clientHeight, styleWidth: c.style.width }, bounds: b.toJSON(), zoom: e.viewport.getState().scale };
  });
  console.log('NOTE GEOMETRY', JSON.stringify({ width: noteGeometry.geometry.width, height: noteGeometry.geometry.height, zoom: noteGeometry.zoom }));
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
  assert.ok(points.every(point => point.after === point.before + 1));
  pass('native pointerdown starts across left, source and full right Research Space');
  await page.keyboard.press('F11');
  await page.getByRole('button', { name: 'Hide fullscreen tools', exact: true }).click();
  await frames(2);
  const research = [];
  for (const extent of [40, 140, 300]) {
    await page.evaluate(extent => window.documentFixture.engine().setProperties({ extraLeft: extent, extraRight: extent, extraTop: extent, extraBottom: extent }), extent);
    for (const scale of [.85, 1.25]) {
      await page.evaluate(scale => window.documentFixture.engine().viewport.setZoom(scale), scale);
      await page.waitForFunction(({ extent, scale }) => {
        const f = window.documentFixture, c = f.engine().drawing.getCanvasElement();
        return f.geometry().width === 794 + 2 * extent && c.clientWidth === 794 + 2 * extent && Math.abs(c.width - Math.floor(c.clientWidth * scale * devicePixelRatio)) <= 1;
      }, { extent, scale });
      const geometry = await page.evaluate(() => window.documentFixture.geometry());
      assert.equal(geometry.width, geometry.noteSpace.left + geometry.source.width + geometry.noteSpace.right);
      const starts = [-extent + 5, -extent / 2, 100, 789, 799, 794 + extent / 2, 794 + extent - 5].map(x => [x, 100]);
      // Use the outer right corner for top/bottom starts so the real floating
      // toolbar does not legitimately cover the tested document point.
      starts.push([794 + extent - 5, -extent + 5], [794 + extent - 5, 1123 + extent - 5]);
      for (const pointerType of ['mouse', 'pen']) for (const [x, y] of starts) {
        const pos = await position(x, y);
        if (!pos.hit) console.log('HIT DIAGNOSTIC', JSON.stringify({ extent, scale, x, y, pos }));
        assert.equal(pos.hit, true, `actual DOM hit at ${extent}px, zoom ${scale}, ${x},${y}`);
        await nativeStroke(pos, pointerType);
        const result = await page.evaluate(() => {
          const strokes = window.documentFixture.engine().drawing.getStrokes();
          return { count: strokes.length, point: strokes.at(-1).points[0] };
        });
        if (result.count !== pos.before + 1) console.log('INPUT DIAGNOSTIC', JSON.stringify({ extent, scale, pos, result, detail: await page.evaluate(() => ({ events: window.__documentPointerEvents, trace: window.__panvasHandwritingTraces?.at(-1), tool: window.documentFixture.engine().tools.getState(), ink: Boolean(window.documentFixture.engine().input.inkSamples) })) }));
        assert.equal(result.count, pos.before + 1, `${pointerType} pointerdown at ${x},${y}`);
        assert.ok(Math.abs(result.point.x - x) < 1 && Math.abs(result.point.y - y) < 1, 'canonical coordinate mapping');
        if (pointerType === 'pen') assert.ok(Math.abs(result.point.pressure - .65) < .001, 'native pen pressure survives');
        research.push({ extent, scale, pointerType, x, y, point: result.point });
      }
    }
  }
  pass('108 native mouse/pen starts after Research Space changes: 40/140/300px, two zooms, all four sides');
  await page.evaluate(async () => { const { useLayoutStore } = await import('/src/stores/layoutStore.ts'); useLayoutStore.setState({ notebookModeLevel: 1, isToolbarCollapsed: false }); });
  await page.evaluate(() => { const e = window.documentFixture.engine(); e.setProperties({ extraLeft: 140, extraRight: 140, extraTop: 140, extraBottom: 140 }); e.viewport.setZoom(1); });
  await frames(20);
  const crossingResearch = [];
  for (const pointerType of ['mouse', 'pen']) {
    const pos = await position(784, 450);
    assert.equal(pos.hit, true);
    const delta = await page.evaluate(() => {
      const c = window.documentFixture.engine().drawing.getCanvasElement();
      return 140 * c.getBoundingClientRect().width / c.clientWidth;
    });
    await nativeStroke(pos, pointerType, delta);
    const crossing = await page.evaluate(() => {
      const strokes = window.documentFixture.engine().drawing.getStrokes();
      return { count: strokes.length, first: strokes.at(-1).points[0], last: strokes.at(-1).points.at(-1) };
    });
    assert.equal(crossing.count, pos.before + 1);
    assert.ok(Math.abs(crossing.first.x - 784) < 1 && Math.abs(crossing.last.x - 924) < 1, 'captured source-to-right stroke stays canonical');
    const outer = await position(924, 500);
    assert.equal(outer.hit, true);
    await nativeStroke(outer, pointerType);
    assert.equal(await page.evaluate(() => window.documentFixture.engine().drawing.getStrokes().length), outer.before + 1, 'lift then start directly in the far-right region');
    crossingResearch.push({ pointerType, ...crossing });
  }
  pass('mouse and pen cross from source into far-right space, then start a new stroke after lifting');
  await page.waitForFunction(() => window.documentFixture.engine().drawing.spareWetInk === null);
  await page.evaluate(()=>window.__documentWork.reset());
  await page.evaluate(async () => {
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
  const ink = await page.evaluate(()=>({work:window.__documentWork.report(),traces:window.__panvasHandwritingTraces.slice(-8).map(t=>({counters:t.counters,frames:t.frames.length,timings:Object.fromEntries(Object.entries(t.timings).map(([k,v])=>[k,{n:v.length,total:v.reduce((a,b)=>a+b,0),max:Math.max(...v)}]))}))}));
  console.log('INK',JSON.stringify(ink.work));
  assert.equal(ink.work.sceneSnapshots, 8, 'one scene snapshot per committed stroke');
  assert.equal(ink.work.redraws ?? 0, 0, 'focused page must not replay hidden committed scenes');
  assert.ok(ink.work.canvasResizes <= 48, 'idle expiry may release buffers between display-paced strokes');
  assert.ok(ink.traces.every(trace => trace.counters.normalizedSamples === 121 && trace.counters.committedPoints >= 121), 'all 121 physical samples retained; rendered curves may add interior points');
  pass('eight rapid pen strokes preserve samples without hidden full-scene replay');
  await page.waitForFunction(() => window.documentFixture.engine().drawing.spareWetInk === null);
  assert.equal(await page.locator('[data-panvas-wet-ink]').count(), 0, 'idle releases transient wet surfaces');
  // Keep one synchronous burst within the idle window. Its allocation budget
  // is deterministic even when a loaded CI host delays animation frames.
  const rapidBuffers = await page.evaluate(() => {
    const e = window.documentFixture.engine(), c = e.drawing.getCanvasElement(), b = c.getBoundingClientRect();
    window.__documentWork.reset();
    for (let stroke = 0; stroke < 16; stroke++) {
      const emit = (type, point) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 400, pointerType: 'pen', button: 0, buttons: type === 'pointerup' ? 0 : 1, pressure: .3 + point * .02, clientX: b.left + 180 + point * 3, clientY: b.top + 250 + stroke * 10 + Math.sin(point) * 5 }));
      emit('pointerdown', 0); for (let i = 1; i <= 20; i++) emit('pointermove', i); emit('pointerup', 20);
    }
    return window.__documentWork.report();
  });
  assert.ok(rapidBuffers.canvasResizes <= 4, '16 adjacent commits allocate only two backing buffers');
  assert.equal(rapidBuffers.sceneSnapshots, 16);
  await page.waitForFunction(() => window.documentFixture.engine().drawing.spareWetInk === null);
  pass('16 immediate strokes reuse two backing buffers and release them after idle');
  const wetPixels = await page.evaluate(async () => {
    const { WetInkSurface } = await import('/src/components/notebook/engine/WetInkSurface.ts');
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-10000px;top:0'; document.body.append(host);
    const make = () => { const c = document.createElement('canvas'); c.width = c.height = 480; c.style.width = c.style.height = '480px'; host.append(c); return c.getContext('2d'); };
    const target = make(), reference = make();
    let reuse;
    let comparisons = 0, mismatched = 0;
    for (let run = 0; run < 8; run++) {
      const transform = run % 2 ? new DOMMatrix().translate(450, 20).rotate(90).scale(1.25) : new DOMMatrix().translate(12, 14).scale(1.1);
      const fresh = new WetInkSurface(reference, transform);
      if (reuse) reuse.resume(transform); else reuse = new WetInkSurface(target, transform);
      const all = Array.from({ length: 90 }, (_, i) => ({ x: 8 + i * 3.5, y: 40 + run * 25 + Math.sin(i * .2) * 9, pressure: .1 + (i % 11) * .08, t: i * 4 }));
      const stroke = { id: String(run), type: 'stroke', tool: 'pen', pattern: 'solid', centerline: 'polyline', color: run % 2 ? '#dc2626' : '#2563eb', opacity: run % 3 ? .55 : 1, thickness: 3 + run, inkFamily: run % 3 === 0 ? 'felt' : run % 3 === 1 ? 'fountain' : undefined, createdAt: run, points: [] };
      for (const count of [1, 5, 17, 55, 90]) {
        stroke.points.push(...all.slice(stroke.points.length, count));
        reuse.render(stroke); fresh.render(stroke);
        const a = reuse.canvas.getContext('2d').getImageData(0, 0, 480, 480).data;
        const b = fresh.canvas.getContext('2d').getImageData(0, 0, 480, 480).data;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) mismatched++;
        comparisons++;
      }
      reuse.commit(stroke); fresh.commit(stroke); reuse.pause(); fresh.dispose();
    }
    const a = target.getImageData(0, 0, 480, 480).data, b = reference.getImageData(0, 0, 480, 480).data;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) mismatched++;
    reuse.dispose(); host.remove();
    return { comparisons, mismatched };
  });
  assert.equal(wetPixels.mismatched, 0);
  pass('40 wet frames and final commits match fresh buffers pixel-for-pixel across pressure, opacity, nib, and rotation changes');
  await page.evaluate(()=>window.documentFixture.engine().tools.setMode('erase')); await frames(2);
  const eraserPos = await position(100, 100);
  assert.equal(eraserPos.hit, true);
  const eraser=[];
  for(const action of ['hover','down','move','up']) {
    if(action==='hover') await page.mouse.move(eraserPos.x,eraserPos.y);
    if(action==='down') await page.mouse.down();
    if(action==='move') await page.mouse.move(eraserPos.x+50,eraserPos.y+50);
    if(action==='up') await page.mouse.up();
    eraser.push({action, cursor:await page.evaluate(()=>getComputedStyle(window.documentFixture.engine().drawing.getCanvasElement()).cursor)});
  }
  console.log('ERASER', 'hover/down/move/up checked');
  assert.ok(eraser.every(state => state.cursor === eraser[0].cursor && state.cursor.includes('data:image/svg+xml')));
  pass('eraser CSS cursor survives hover/down/move/up');
  const cursorCases = [
    { tool: 'pen', color: '#22c55e' }, { tool: 'pen', color: '#dc2626' },
    { tool: 'pencil', color: '#2563eb' }, { tool: 'highlighter', color: '#eab308' },
    { tool: 'pen', color: '#dc2626', handwriting: true }, { mode: 'erase' },
  ];
  const readCursor = async config => {
    await page.evaluate(config => {
      const t = window.documentFixture.engine().tools;
      t.setHandwritingToTextEnabled(Boolean(config.handwriting));
      t.setHandwritingInkStyle('#0d9488', 3);
      if (config.tool) t.setDrawingTool(config.tool);
      if (config.color) t.setColor(config.color);
      if (config.mode) t.setMode(config.mode);
    }, config);
    await frames(2);
    return page.evaluate(() => getComputedStyle(window.documentFixture.engine().drawing.getCanvasElement()).cursor);
  };
  const notebookCursors = [];
  for (const config of cursorCases) notebookCursors.push(await readCursor(config));
  assert.notEqual(notebookCursors[0], notebookCursors[1], 'pen color updates the cursor');
  assert.ok(decodeURIComponent(notebookCursors[4]).includes('#0d9488'), 'H2T cursor uses handwriting ink');
  await page.evaluate(() => window.documentFixture.engine().tools.setHandwritingToTextEnabled(false));
  const eraseStates = [];
  const checkErase = async label => {
    for (const pointerType of ['mouse', 'pen']) for (const mode of ['stroke', 'pixel']) {
      await page.evaluate(() => window.documentFixture.engine().tools.setDrawingTool('pen'));
      await frames(2);
      const pos = await position(200, 300);
      assert.equal(pos.hit, true);
      await nativeStroke(pos, pointerType);
      await page.evaluate(mode => { const t = window.documentFixture.engine().tools; t.setEraserMode(mode); t.setMode('erase'); }, mode);
      await frames(2);
      const cursor = await readCursor({ mode: 'erase' });
      const before = await page.evaluate(() => JSON.stringify(window.documentFixture.engine().drawing.getStrokes()));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, pointerType });
      for (const type of ['mousePressed', 'mouseMoved', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: pos.x + (type === 'mousePressed' ? 0 : 6), y: pos.y + (type === 'mousePressed' ? 0 : 6), pointerType, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1, force: .5 });
        assert.equal(await page.evaluate(() => getComputedStyle(window.documentFixture.engine().drawing.getCanvasElement()).cursor), cursor, `${label}: cursor during actual ${pointerType} ${mode} erase`);
      }
      await frames(2);
      assert.notEqual(await page.evaluate(() => JSON.stringify(window.documentFixture.engine().drawing.getStrokes())), before, 'gesture actually erased ink');
      eraseStates.push({ label, pointerType, mode, cursorRetained: true });
    }
    pass(`${label}: native mouse/pen stroke and pixel erasing retain the CSS cursor`);
  };
  await checkErase('notebook');
  await page.evaluate(()=>window.documentFixture.select('pdf'));
  await page.waitForFunction(()=>window.documentFixture.engine()?.drawing.getCanvasElement()?.closest('[data-pdf-source-page]'));
  await frames(30);
  for (let index = 0; index < cursorCases.length; index++) assert.equal(await readCursor(cursorCases[index]), notebookCursors[index], 'PDF/notebook cursor parity');
  await page.evaluate(() => window.documentFixture.engine().tools.setHandwritingToTextEnabled(false));
  pass('PDF pen/pencil/highlighter/eraser cursors match notebook, including color and H2T ink');
  await checkErase('PDF');
  await page.evaluate(()=>window.documentFixture.engine().tools.setDrawingTool('pen')); await frames(2);
  console.log('PDF CURSOR', 'shared resolver checked');
  await page.waitForFunction(() => window.documentFixture.engine().drawing.spareWetInk === null);
  await page.waitForFunction(async () => {
    const f = window.documentFixture, saved = await f.saved(`${f.ids.pdf}_pdf_1`);
    return JSON.stringify(saved?.objects) === JSON.stringify(f.engine().getDrawingData().objects);
  });
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
  console.log('PDF ZOOM',JSON.stringify({ maxDriftX: Math.max(...zoom.drift.map(p => Math.abs(p.x))), maxDriftY: Math.max(...zoom.drift.map(p => Math.abs(p.y))), work: pdfWork }));
  assert.ok(Math.max(...zoom.drift.map(point => Math.abs(point.x))) < 2);
  assert.ok(Math.max(...zoom.drift.map(point => Math.abs(point.y))) < 2);
  assert.equal(pdfWork.engineMounts ?? 0, 0, 'zoom never remounts the input engine');
  assert.equal(pdfWork.engineUnmounts ?? 0, 0);
  assert.equal(pdfWork.pdfRasterStarts ?? 0, 0, 'returning to the settled scale needs no replacement raster');
  assert.equal(pdfWork.canvasResizes ?? 0, 0);
  pass('24-frame zoom reversal preserves page anchor and annotation engine without raster/canvas churn');
  // Events that arrive within one display frame produce one visible update.
  await page.evaluate(() => window.__documentWork.reset());
  await page.evaluate(() => {
    const target = document.querySelector('[aria-label="PDF document pages"]'), b = target.getBoundingClientRect();
    for (let i = 0; i < 12; i++) target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -12, clientX: b.left + b.width * .6, clientY: b.top + b.height * .4 }));
  });
  await frames(1);
  const burst = await page.evaluate(() => window.__documentWork.report());
  assert.equal(burst.viewportNotifications, 1, 'wheel burst coalesces before React');
  await page.waitForFunction(() => {
    const f = window.documentFixture, e = f.engine(), frame = document.querySelector('[data-pdf-source-page="1"]');
    const raster = frame.querySelector('canvas');
    return raster.width === Math.floor(595 * devicePixelRatio * e.viewport.getState().scale);
  });
  const settled = await page.evaluate(() => window.__documentWork.report());
  const residentRasters = await page.locator('[data-pdf-source-page] [data-pdf-raster]').count();
  assert.ok((settled.pdfRasterStarts ?? 0) <= residentRasters, 'each retained PDF raster restarts at most once after the wheel burst');
  assert.equal(settled.engineMounts ?? 0, 0);
  pass('one update for a 12-event burst; final PDF raster regains full bounded detail');
  // Real Hand drags must scroll the document, without changing the unused camera offset.
  await page.evaluate(() => window.documentFixture.engine().tools.setMode('hand'));
  await frames(2);
  const objectsBeforeCommands = await page.evaluate(() => JSON.stringify(window.documentFixture.engine().getDrawingData().objects));
  const commandZoom = [];
  for (const command of ['Zoom in', 'Zoom out', 'Control+Equal', 'Control+Minus']) {
    const anchor = await page.evaluate(() => {
      const s = document.querySelector('[aria-label="PDF document pages"]'), b = s.getBoundingClientRect();
      const f = document.querySelector('[data-pdf-source-page="1"]').getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      return { x, y, fractionX: (x - f.left) / f.width, fractionY: (y - f.top) / f.height };
    });
    if (command.startsWith('Zoom')) await page.getByRole('button', { name: command, exact: true }).click();
    else await page.keyboard.press(command);
    await frames(3);
    const drift = await page.evaluate(a => {
      const f = document.querySelector('[data-pdf-source-page="1"]').getBoundingClientRect();
      return { x: f.left + a.fractionX * f.width - a.x, y: f.top + a.fractionY * f.height - a.y };
    }, anchor);
    assert.ok(Math.abs(drift.x) < 2 && Math.abs(drift.y) < 2, `${command} keeps the actual page center anchored`);
    commandZoom.push({ command, drift });
  }
  assert.equal(await page.evaluate(() => JSON.stringify(window.documentFixture.engine().getDrawingData().objects)), objectsBeforeCommands);
  pass('PDF zoom buttons and keyboard preserve the page center and canonical annotations');
  const panPos = await position(200, 300);
  const panBefore = await page.evaluate(() => {
    const s = document.querySelector('[aria-label="PDF document pages"]');
    return { left: s.scrollLeft, top: s.scrollTop, viewport: window.documentFixture.engine().viewport.getState(), count: window.documentFixture.engine().drawing.getStrokes().length };
  });
  await page.mouse.move(panPos.x, panPos.y); await page.mouse.down(); await page.mouse.move(panPos.x - 70, panPos.y - 80, { steps: 10 }); await page.mouse.up();
  const panAfter = await page.evaluate(() => { const s = document.querySelector('[aria-label="PDF document pages"]'); return { left: s.scrollLeft, top: s.scrollTop, viewport: window.documentFixture.engine().viewport.getState(), count: window.documentFixture.engine().drawing.getStrokes().length }; });
  assert.ok(Math.abs(panAfter.left - panBefore.left - 70) <= 1 && Math.abs(panAfter.top - panBefore.top - 80) <= 1);
  assert.deepEqual(panAfter.viewport, panBefore.viewport);
  assert.equal(panAfter.count, panBefore.count);
  pass('PDF Hand pan moves native scroll by the drag delta without viewport notifications or drawing');
  const pinch = await page.evaluate(async () => {
    const e = window.documentFixture.engine(), c = e.drawing.getCanvasElement(), frame = c.closest('[data-pdf-source-page]');
    const scroller = c.closest('[data-panvas-scroll-viewport]'), b = scroller.getBoundingClientRect();
    const center = { x: b.left + b.width * .6, y: b.top + b.height * .5 };
    const before = frame.getBoundingClientRect();
    const anchor = { x: (center.x - before.left) / before.width, y: (center.y - before.top) / before.height };
    const count = e.drawing.getStrokes().length;
    const emit = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: id, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
    emit('pointerdown', 101, center.x - 50, center.y); emit('pointerdown', 102, center.x + 50, center.y);
    emit('pointermove', 101, center.x - 70, center.y + 20); emit('pointermove', 102, center.x + 70, center.y + 20);
    await new Promise(requestAnimationFrame);
    const after = frame.getBoundingClientRect();
    const drift = { x: after.left + anchor.x * after.width - center.x, y: after.top + anchor.y * after.height - center.y - 20 };
    emit('pointerup', 101, center.x - 70, center.y + 20); emit('pointerup', 102, center.x + 70, center.y + 20);
    return { drift, drawingUnchanged: count === e.drawing.getStrokes().length, released: !e.input.navigationGestures.active };
  });
  assert.ok(Math.abs(pinch.drift.x) < 2 && Math.abs(pinch.drift.y) < 2);
  assert.equal(pinch.drawingUnchanged, true); assert.equal(pinch.released, true);
  pass('PDF two-finger pan/pinch preserves the page anchor and releases gesture ownership');
  await frames(20);
  const persistedPdf = await page.evaluate(() => JSON.stringify(window.documentFixture.engine().getDrawingData().objects));
  const crossing = await position(200, 300);
  await page.evaluate(() => window.__documentWork.reset());
  await page.mouse.move(crossing.x, crossing.y); await page.mouse.down(); await page.mouse.move(crossing.x, crossing.y - 4300, { steps: 12 });
  await frames(2);
  const held = await page.evaluate(() => ({ page: window.documentFixture.engine().drawing.getCanvasElement().closest('[data-pdf-source-page]').dataset.pdfSourcePage, work: window.__documentWork.report() }));
  assert.equal(held.page, '1', 'crossing pages must retain the captured PDF canvas');
  assert.equal(held.work.engineUnmounts ?? 0, 0);
  await page.mouse.up();
  await page.waitForFunction(() => window.documentFixture.engine()?.drawing.getCanvasElement()?.closest('[data-pdf-source-page]')?.dataset.pdfSourcePage === '2');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await page.waitForFunction(() => window.documentFixture.engine()?.drawing.getCanvasElement()?.closest('[data-pdf-source-page]')?.dataset.pdfSourcePage === '1');
  assert.equal(await page.evaluate(() => JSON.stringify(window.documentFixture.engine().getDrawingData().objects)), persistedPdf);
  pass('PDF page-crossing Hand drag retains its engine until release; annotations persist on return');
  await mkdir('artifacts/document-input', {recursive:true});
  const label='regressions';
  const suffix=electronMode?'-electron':'-web';
  await page.screenshot({path:`artifacts/document-input/${label}${suffix}-pdf.png`});
  assert.deepEqual(errors, []);
  await writeFile(`artifacts/document-input/${label}${suffix}.json`,JSON.stringify({passed,noteGeometry,points,research,crossingResearch,ink,rapidBuffers,wetPixels,eraser,eraseStates,zoom,pdfWork,burst,settled,commandZoom,panBefore,panAfter,pinch,held},null,2));
  console.log(`PASS: ${passed} document input regression groups (${electronMode ? 'Windows Electron' : 'web'})`);
} finally { await browser?.close(); await electronApp?.close(); await server.close(); }
