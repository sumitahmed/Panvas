// Real-app temporal stability probe for zoomed-out ink jitter.
// Runs the REAL React notebook tree (document-input fixture), draws with
// high-frequency synthetic pen events, and measures:
//  - frame pacing during drawing (rAF deltas)
//  - prefix raster stability (composited page canvases outside the nib box)
//  - prefix geometry stability (filtered points never revised)
//  - wet rebuilds / rebaseLiveSurface calls / React commits during the stroke
//  - presented-frame stability via CDP screencast (consecutive captured frames
//    diffed outside the mapped nib region) — proxy for what the user sees.
//
// Usage: node tests/ink-jitter-real-probe.mjs [--out=dir]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outDir = process.argv.find(a => a.startsWith('--out='))?.split('=')[1] ?? 'artifacts/ink-jitter-real-probe';
await mkdir(outDir, { recursive: true });
const ZOOMS = [1, 0.75, 0.5, 0.35];
const report = { cases: [], screencast: [] };

const server = await createServer({ mode: 'web', cacheDir: path.join(outDir, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/document-input.html'] }, server: { port: 0, open: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto(url + 'tests/fixtures/document-input.html?handwritingTrace=1');
await page.waitForFunction(() => window.documentFixture?.engine()?.drawing.getCanvasElement(), null, { timeout: 60000 });

// Instrument rebase + wet rebuild counters for the probe session.
await page.evaluate(() => {
  const { WetInkSurface } = window.__probeModules ?? {};
  const w = window.__documentWork;
  window.__probeState = { rebuilds: 0, rebases: 0 };
  const drawingProto = Object.getPrototypeOf(window.documentFixture.engine().drawing);
  const origRebase = drawingProto.rebaseLiveSurface;
  drawingProto.rebaseLiveSurface = function (...args) { window.__probeState.rebases++; return origRebase.apply(this, args); };
});

async function drawStrokeWithTelemetry(zoom, setting, baselineShots) {
  return page.evaluate(async ({ zoom, setting }) => {
    const e = window.documentFixture.engine();
    const canvas = e.drawing.getCanvasElement();
    e.tools.setStabilization(setting);
    e.tools.setMode('draw');
    e.viewport.setZoom(zoom);
    for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame); // debounce settle
    const work0 = window.__documentWork.report();
    const state0 = { ...window.__probeState };
    const rect = canvas.getBoundingClientRect();
    const host = canvas.closest('[data-panvas-wet-ink], canvas')?.parentElement;
    const target = canvas;
    const kx = target.width / target.clientWidth, ky = target.height / target.clientHeight;
    // Deterministic slow diagonal word-like stroke in PAGE coordinates.
    const samples = [];
    for (let i = 0; i <= 180; i++) {
      const u = i / 180;
      samples.push({ x: 60 + 240 * u + 9 * Math.sin(10 * Math.PI * u), y: 90 + 60 * u + 14 * Math.sin(10 * Math.PI * u), pressure: .5, t: i * 1000 / 240 });
    }
    const emit = (type, p, ts) => {
      const event = new PointerEvent(type, { bubbles: true, pointerId: 314, pointerType: 'pen', button: type === 'pointerdown' ? 0 : -1, buttons: type === 'pointerup' ? 0 : 1, pressure: type === 'pointerup' ? 0 : p.pressure, clientX: rect.left + p.x * rect.width / target.clientWidth, clientY: rect.top + p.y * rect.height / target.clientHeight });
      Object.defineProperty(event, 'timeStamp', { value: ts });
      target.dispatchEvent(event);
    };
    const composited = () => {
      const c = document.createElement('canvas'); c.width = target.width; c.height = target.height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(target, 0, 0);
      const wet = target.parentElement?.querySelector('[data-panvas-wet-ink]');
      if (wet) { ctx.globalAlpha = Number(wet.style.opacity || 1); ctx.drawImage(wet, 0, 0); }
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    let prevPixels = null, prevPointsJson = null, prevCount = 0, prevSampleIdx = 0;
    let prefixRasterFrames = 0, prefixRasterPixels = 0, prefixRasterPerceptible = 0, prefixRasterMaxDelta = 0;
    let prefixGeomFrames = 0, prefixGeomMaxMove = 0;
    const frameDeltas = [];
    let lastFrame = performance.now();
    const start = performance.now();
    const margin = 40;
    for (let i = 0; i < samples.length; i++) {
      if (i % 4 === 0) {
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        frameDeltas.push(now - lastFrame);
        lastFrame = now;
      }
      // 240 Hz equivalent: rawupdate + move pairs between frames.
      if (i) { emit('pointerrawupdate', samples[i], start + samples[i].t); emit('pointermove', samples[i], start + samples[i].t); }
      else emit('pointerdown', samples[i], start + samples[i].t);
      const points = e.input.currentPoints;
      const count = points.length;
      if (prevPointsJson !== null && count > prevCount) {
        if (JSON.stringify(points.slice(0, prevCount)) !== prevPointsJson) {
          prefixGeomFrames++;
          const prev = JSON.parse(prevPointsJson);
          for (let j = 0; j < prevCount; j++) {
            const d = Math.hypot(points[j].x - prev[j].x, points[j].y - prev[j].y) * zoom;
            if (d > prefixGeomMaxMove) prefixGeomMaxMove = d;
          }
        }
      }
      prevPointsJson = JSON.stringify(points);
      prevCount = count;
      if (i % 4 === 3) {
        const data = composited();
        if (prevPixels) {
          const last = points[points.length - 1];
          const box = last ? e.viewport.pageToCanvas(last.x, last.y) : { x: -1e4, y: -1e4 };
          const nx = box.x * kx, ny = box.y * ky;
          const bx0 = Math.max(0, Math.floor(nx - margin)), by0 = Math.max(0, Math.floor(ny - margin));
          const bx1 = Math.min(target.width, Math.ceil(nx + margin)), by1 = Math.min(target.height, Math.ceil(ny + margin));
          let changed = 0, perceptible = 0, maxDelta = 0;
          for (let y = 0; y < target.height; y++) {
            const inNibY = y >= by0 && y < by1, row = y * target.width * 4;
            for (let x = 0; x < target.width; x++) {
              const o = row + x * 4;
              const d = Math.max(Math.abs(data[o] - prevPixels[o]), Math.abs(data[o + 1] - prevPixels[o + 1]), Math.abs(data[o + 2] - prevPixels[o + 2]));
              if (!d || (inNibY && x >= bx0 && x < bx1)) continue;
              changed++;
              if (d >= 8) perceptible++;
              if (d > maxDelta) maxDelta = d;
            }
          }
          if (changed) { prefixRasterFrames++; prefixRasterPixels += changed; prefixRasterPerceptible += perceptible; if (maxDelta > prefixRasterMaxDelta) prefixRasterMaxDelta = maxDelta; }
        }
        prevPixels = data;
      }
    }
    await new Promise(requestAnimationFrame);
    const livePixels = prevPixels;
    emit('pointerup', samples[samples.length - 1], start + 1001);
    await new Promise(requestAnimationFrame);
    const dry = composited();
    const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] ?? 0;
    const wetDiff = (() => {
      const tip = e.input.currentPoints[e.input.currentPoints.length - 1];
      const box = tip ? e.viewport.pageToCanvas(tip.x, tip.y) : { x: -1e4, y: -1e4 };
      const tx = box.x * kx, ty = box.y * ky;
      const bx0 = Math.max(0, Math.floor(tx - margin)), by0 = Math.max(0, Math.floor(ty - margin));
      const bx1 = Math.min(target.width, Math.ceil(tx + margin)), by1 = Math.min(target.height, Math.ceil(ty + margin));
      let changed = 0, maxDelta = 0;
      for (let y = 0; y < target.height; y++) {
        const inNibY = y >= by0 && y < by1, row = y * target.width * 4;
        for (let x = 0; x < target.width; x++) {
          const o = row + x * 4;
          const d = Math.max(Math.abs(dry[o] - livePixels[o]), Math.abs(dry[o + 1] - livePixels[o + 1]), Math.abs(dry[o + 2] - livePixels[o + 2]));
          if (!d || (inNibY && x >= bx0 && x < bx1)) continue;
          changed++;
          if (d > maxDelta) maxDelta = d;
        }
      }
      return { changed, maxDelta };
    })();
    const work1 = window.__documentWork.report();
    const state1 = { ...window.__probeState };
    const trace = window.__panvasHandwritingTraces?.at(-1);
    return {
      zoom, setting,
      prefixRasterFrames, prefixRasterPixels, prefixRasterPerceptible, prefixRasterMaxDelta,
      prefixGeomFrames, prefixGeomMaxMove: Number(prefixGeomMaxMove.toFixed(4)),
      frameP50: Number(pct(frameDeltas, .5).toFixed(2)), frameP95: Number(pct(frameDeltas, .95).toFixed(2)), frameMax: Number(Math.max(...frameDeltas).toFixed(2)),
      wetRebuilds: (work1.wetRebuildsDelta ?? 0) + (state1.rebuilds - state0.rebuilds),
      rebases: state1.rebases - state0.rebases,
      reactCommits: (work1.notebookCommits ?? 0) - (work0.notebookCommits ?? 0),
      wetDraws: (work1.wetDraws ?? 0) - (work0.wetDraws ?? 0),
      liveFinalChangedPx: wetDiff.changed, liveFinalMaxDelta: wetDiff.maxDelta,
      handlerP95: Number(pct(trace?.timings.pointerHandlerMs ?? [], .95).toFixed(3)),
      samplesCommitted: trace?.counters.committedPoints ?? 0,
    };
  }, { zoom, setting });
}

for (const zoom of ZOOMS) {
  for (const setting of [50, 0]) {
    const r = await drawStrokeWithTelemetry(zoom, setting);
    report.cases.push(r);
    console.log(`zoom=${zoom} stab=${setting} | prefixRaster ${r.prefixRasterFrames}f/${r.prefixRasterPixels}px (>=8: ${r.prefixRasterPerceptible}, max ${r.prefixRasterMaxDelta}) | prefixGeom ${r.prefixGeomFrames}f max ${r.prefixGeomMaxMove} | frames p50/p95/max ${r.frameP50}/${r.frameP95}/${r.frameMax}ms | rebuilds ${r.wetRebuilds} rebases ${r.rebases} commits ${r.reactCommits} wetDraws ${r.wetDraws} | liftΔ ${r.liveFinalChangedPx}px max${r.liveFinalMaxDelta} | handlerP95 ${r.handlerP95}ms`);
  }
}

// Presented-frame capture via screencast while drawing at zoom 1 vs 0.5.
const cdp = await page.context().newCDPSession(page);
for (const zoom of [1, 0.5]) {
  const setup = await page.evaluate(async zoom => {
    const e = window.documentFixture.engine();
    const canvas = e.drawing.getCanvasElement();
    e.tools.setStabilization(50); e.tools.setMode('draw');
    e.viewport.setZoom(zoom);
    for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame);
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top, w: rect.width, h: rect.height, clientW: canvas.clientWidth };
  }, zoom);
  const frames = [];
  cdp.on('Page.screencastFrame', f => { frames.push(f); void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
  await cdp.send('Page.startScreencast', { format: 'png', everyFrame: true });
  const nibLog = await page.evaluate(async zoom => {
    const e = window.documentFixture.engine();
    const canvas = e.drawing.getCanvasElement();
    const rect = canvas.getBoundingClientRect();
    const samples = [];
    for (let i = 0; i <= 150; i++) { const u = i / 150; samples.push({ x: 60 + 240 * u + 9 * Math.sin(10 * Math.PI * u), y: 90 + 60 * u, pressure: .5, t: i * 1000 / 120 }); }
    const emit = (type, p, ts) => {
      const event = new PointerEvent(type, { bubbles: true, pointerId: 77, pointerType: 'pen', button: type === 'pointerdown' ? 0 : -1, buttons: type === 'pointerup' ? 0 : 1, pressure: p.pressure, clientX: rect.left + p.x * rect.width / canvas.clientWidth, clientY: rect.top + p.y * rect.height / canvas.clientHeight });
      Object.defineProperty(event, 'timeStamp', { value: ts });
      canvas.dispatchEvent(event);
    };
    window.__nibLog = [];
    const log = window.__nibLog;
    const start = performance.now();
    for (let i = 0; i < samples.length; i++) {
      if (i) { emit('pointerrawupdate', samples[i], start + samples[i].t); emit('pointermove', samples[i], start + samples[i].t); }
      else emit('pointerdown', samples[i], start + samples[i].t);
      await new Promise(requestAnimationFrame);
      const tip = e.input.currentPoints[e.input.currentPoints.length - 1];
      const box = tip ? e.viewport.pageToCanvas(tip.x, tip.y) : { x: -1e4, y: -1e4 };
      log.push({ cssX: rect.left + box.x * rect.width / canvas.clientWidth, cssY: rect.top + box.y * rect.height / canvas.clientHeight });
    }
    emit('pointerup', samples[samples.length - 1], start + 1001);
    await new Promise(r => setTimeout(r, 300));
    return log;
  }, zoom);
  await cdp.send('Page.stopScreencast');
  cdp.removeAllListeners('Page.screencastFrame');
  const analysis = await page.evaluate(async ({ frames, setup, zoom, NIB_LOG }) => {
    const images = await Promise.all(frames.filter(f => f.data).map(f => new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve({ img, ts: f.metadata.timestamp });
      img.onerror = () => resolve(null);
      img.src = 'data:image/png;base64,' + f.data;
    })));
    const ok = images.filter(Boolean);
    if (ok.length < 3) return { frames: ok.length, pairs: [] };
    const vw = ok[0].img.naturalWidth;
    const scale = vw / 1400;
    const load = img => {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const nibCss = null;
    // Frame-to-nib alignment: one nib log entry per rAF; screencast frames are
    // also per presented frame. Log entries start after the first captured
    // frames, so offset by the difference and clamp at both ends.
    const log = NIB_LOG;
    const pairs = [];
    const logOffset = Math.max(0, ok.length - 2 - log.length);
    for (let i = 1; i < ok.length; i++) {
      const a = load(ok[i - 1].img), b = load(ok[i].img);
      const w = ok[i].img.naturalWidth, h = ok[i].img.naturalHeight;
      const entry = log[Math.min(log.length - 1, Math.max(0, i - 1 - logOffset))];
      const nx = (entry ? entry.cssX : setup.left) * scale, ny = (entry ? entry.cssY : setup.top) * scale;
      const m = 45 * scale;
      const bx0 = Math.max(0, Math.floor(nx - m)), by0 = Math.max(0, Math.floor(ny - m));
      const bx1 = Math.min(w, Math.ceil(nx + m)), by1 = Math.min(h, Math.ceil(ny + m));
      let changed = 0, perceptible = 0, maxDelta = 0;
      for (let y = 0; y < h; y++) {
        const inNibY = y >= by0 && y < by1, row = y * w * 4;
        for (let x = 0; x < w; x++) {
          const o = row + x * 4;
          const d = Math.max(Math.abs(b[o] - a[o]), Math.abs(b[o + 1] - a[o + 1]), Math.abs(b[o + 2] - a[o + 2]));
          if (!d || (inNibY && x >= bx0 && x < bx1)) continue;
          changed++;
          if (d >= 8) perceptible++;
          if (d > maxDelta) maxDelta = d;
        }
      }
      pairs.push({ changed, perceptible, maxDelta });
    }
    return { frames: ok.length, pairs, summary: { pairsWithChanges: pairs.filter(p => p.changed).length, totalChanged: pairs.reduce((s, p) => s + p.changed, 0), totalPerceptible: pairs.reduce((s, p) => s + p.perceptible, 0), maxDelta: Math.max(0, ...pairs.map(p => p.maxDelta)) } };
  }, { frames: frames.map(f => ({ data: f.data, metadata: f.metadata })), setup, zoom, NIB_LOG: nibLog });
  report.screencast.push({ zoom, ...analysis });
  console.log(`screencast zoom=${zoom}: frames=${analysis.frames} pairsWithChanges=${analysis.summary?.pairsWithChanges}/${(analysis.pairs ?? []).length} totalChanged=${analysis.summary?.totalChanged} perceptible=${analysis.summary?.totalPerceptible} maxDelta=${analysis.summary?.maxDelta}`);
}

await browser.close();
await server.close();
await writeFile(path.join(outDir, 'real-probe-report.json'), JSON.stringify(report, null, 2));
console.log('REAL PROBE DONE. Evidence: ' + outDir);
