// Temporal pixel-stability probe for zoomed-out ink jitter diagnosis.
// READ-ONLY diagnostic: runs the ink-quality fixture and measures whether
// already-drawn ink changes over time during a live stroke, which static
// geometry checks cannot observe.
//
// Phases:
//  1. In-page temporal stability — for each zoom/stabilization/DPR: dispatch a
//     deterministic stroke one event per rAF; after each synchronous wet flush,
//     diff the composited page raster OUTSIDE the current nib neighborhood and
//     the previously-drawn filtered geometry. Stable ink must change neither.
//  2. Wet-to-dry + cached-replay pixel diff (already harness-covered; repeated
//     here per zoom for the probe matrix).
//  3. Presentation determinism — identical strokes re-drawn N times, element
//     screenshots diffed through the real compositor.
//
// Usage: node tests/ink-jitter-probe.mjs [--dpr=1,1.25,2] [--out=dir]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dprs = (process.argv.find(a => a.startsWith('--dpr='))?.split('=')[1] ?? '1,1.25,2').split(',').map(Number);
const outDir = process.argv.find(a => a.startsWith('--out='))?.split('=')[1] ?? 'artifacts/ink-jitter-probe';
await mkdir(outDir, { recursive: true });
const ZOOMS = [1, 0.75, 0.5, 0.35];
const SETTINGS = [0, 50];
const NIB_MARGIN_DEVICE_PX = 40;

const temporary = path.join(outDir, 'vite-cache');
const server = await createServer({ mode: 'web', cacheDir: temporary, optimizeDeps: { entries: ['tests/fixtures/ink-quality.html'] }, server: { port: 0, open: false } });
await server.listen();
const url = server.resolvedUrls.local[0];

const report = { zooms: ZOOMS, settings: SETTINGS, dprs, cases: [], presentation: [] };

for (const dpr of dprs) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dpr });
  await page.goto(url + 'tests/fixtures/ink-quality.html?handwritingTrace=1');
  await page.waitForFunction(() => window.inkFixture);
  const label = `dpr${dpr}`;

  for (const zoom of ZOOMS) {
    for (const setting of SETTINGS) {
      const result = await page.evaluate(async ({ zoom, setting, margin }) => {
        const f = window.inkFixture;
        f.configure(zoom, setting);
        const canvas = f.canvas;
        const kx = canvas.width / canvas.clientWidth, ky = canvas.height / canvas.clientHeight;
        const fixture = f.fixture('word', 120, zoom);
        const start = performance.now();
        const handlerMs = [];
        let prevPixels = null, prevPointsJson = null, prevCount = 0;
        let prefixRasterFrames = 0, prefixRasterPixels = 0, prefixRasterPerceptible = 0, prefixRasterMaxDelta = 0;
        let nibPixels = 0;
        let prefixGeomFrames = 0, prefixGeomMaxMove = 0;
        const nibBox = (px) => {
          const nx = px.x * kx, ny = px.y * ky, w = canvas.width, h = canvas.height;
          return [Math.max(0, Math.floor(nx - margin)), Math.max(0, Math.floor(ny - margin)),
            Math.min(w, Math.ceil(nx + margin)), Math.min(h, Math.ceil(ny + margin))];
        };
        for (let i = 0; i < fixture.raw.length; i++) {
          const t0 = performance.now();
          f.dispatch(i ? 'pointermove' : 'pointerdown', fixture.raw[i], 'pen', start + fixture.raw[i].t);
          handlerMs.push(performance.now() - t0);
          const points = f.engine.input.currentPoints;
          const count = points.length;
          if (prevPointsJson !== null && count > prevCount) {
            const prefixNow = JSON.stringify(points.slice(0, prevCount));
            if (prefixNow !== prevPointsJson) {
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
          // Raster diff outside the current nib neighborhood.
          const data = f.pixels();
          const w = canvas.width, h = canvas.height;
          const last = points[points.length - 1];
          const [bx0, by0, bx1, by1] = last ? nibBox(last) : [0, 0, 0, 0];
          if (prevPixels) {
            let changed = 0, perceptible = 0, maxDelta = 0, nibChanged = 0;
            for (let y = 0; y < h; y++) {
              const inNibY = y >= by0 && y < by1;
              const row = y * w * 4;
              for (let x = 0; x < w; x++) {
                const o = row + x * 4;
                const inNib = inNibY && x >= bx0 && x < bx1;
                const d = Math.max(Math.abs(data[o] - prevPixels[o]), Math.abs(data[o + 1] - prevPixels[o + 1]), Math.abs(data[o + 2] - prevPixels[o + 2]));
                if (!d) continue;
                if (inNib) { nibChanged++; continue; }
                changed++;
                if (d >= 8) perceptible++;
                if (d > maxDelta) maxDelta = d;
              }
            }
            if (changed) { prefixRasterFrames++; prefixRasterPixels += changed; prefixRasterPerceptible += perceptible; if (maxDelta > prefixRasterMaxDelta) prefixRasterMaxDelta = maxDelta; }
            nibPixels += nibChanged;
          }
          prevPixels = data;
          if (i % 4 === 3) await f.frames(1);
        }
        await f.frames(1);
        const wet = prevPixels;
        f.dispatch('pointerup', fixture.raw[fixture.raw.length - 1], 'pen', start + 1001);
        const dry = f.pixels();
        f.engine.drawing.redraw();
        const cached = f.pixels();
        const trace = window.__panvasHandwritingTraces.at(-1);
        const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] ?? 0;
        const diff = f.pixelDifference(wet, dry), cacheDiff = f.pixelDifference(dry, cached);
        return {
          zoom, setting,
          samples: fixture.raw.length,
          prefixRasterFrames, prefixRasterPixels, prefixRasterPerceptible, prefixRasterMaxDelta,
          prefixGeomFrames, prefixGeomMaxMove: Number(prefixGeomMaxMove.toFixed(4)),
          nibPixels,
          wetRenderP95: Number(pct(trace?.timings.wetRenderMs ?? [], .95).toFixed(3)),
          handlerP95: Number(pct(handlerMs, .95).toFixed(3)),
          rebuilds: trace?.counters.wetRebuilds ?? 0,
          liveFinalRms: Number(diff.rms.toFixed(4)), liveFinalMax: diff.max,
          cacheReplayRms: Number(cacheDiff.rms.toFixed(4)), cacheReplayMax: cacheDiff.max,
          canvasBacking: `${canvas.width}x${canvas.height}`,
        };
      }, { zoom, setting, margin: NIB_MARGIN_DEVICE_PX });
      report.cases.push({ dpr, ...result });
      console.log(`[${label}] zoom=${zoom} stab=${setting} | prefixRaster: ${result.prefixRasterFrames}f/${result.prefixRasterPixels}px (>=8: ${result.prefixRasterPerceptible}, max ${result.prefixRasterMaxDelta}) | prefixGeom: ${result.prefixGeomFrames}f max ${result.prefixGeomMaxMove}pg | wetP95 ${result.wetRenderP95}ms handlerP95 ${result.handlerP95}ms | live/final ${result.liveFinalRms} cache ${result.cacheReplayRms} | backing ${result.canvasBacking}`);
    }
  }

  // Phase 2b: realistic coalesced-history pen stream with out-of-order samples
  // (forces InkSamples rebuilds -> full wet re-raster). Prefix must stay stable.
  for (const zoom of [1, 0.5, 0.35]) {
  const coalesced = await page.evaluate(async ({ zoom, setting }) => {
    const f = window.inkFixture;
    f.configure(zoom, setting);
    const canvas = f.canvas;
    const kx = canvas.width / canvas.clientWidth, ky = canvas.height / canvas.clientHeight;
    const fixture = f.fixture('word', 240, zoom);
    const raw = fixture.raw;
    // Group samples into dispatches of 3 with coalesced history; every 9th
    // dispatch replays one NEW sample with a regressed timestamp (rebuild).
    const dispatches = [];
    let i = 1;
    let injectAt = 9;
    while (i < raw.length) {
      const group = raw.slice(i, i + 3);
      const dispatch = { type: 'pointermove', history: group.slice(0, -1), event: group[group.length - 1], regress: null };
      if (i > 12 && i >= injectAt && i + 3 < raw.length) {
        // A held-back sample older than the last processed sample: forces a
        // chronological rebuild inside InkSamples.
        dispatch.regress = { x: (raw[i - 1].x + raw[i - 2].x) / 2, y: (raw[i - 1].y + raw[i - 2].y) / 2 + .4, pressure: .5, t: raw[i - 1].t - (raw[i].t - raw[i - 1].t) * .5 };
        injectAt += 9;
      }
      dispatches.push(dispatch);
      i += 3;
    }
    const start = performance.now();
    const samples = [];
    let prevPixels = null, prevPointsJson = null, prevCount = 0;
    let prefixRasterFrames = 0, prefixRasterPixels = 0, prefixRasterMaxDelta = 0;
    let prefixGeomFrames = 0, prefixGeomMaxMove = 0, prefixGeomFirstRevisedIndex = Infinity;
    const margin = 40;
    const dispatch = (type, p, history, ts) => {
      const b = canvas.getBoundingClientRect();
      const vp = f.engine.viewport.pageToCanvas(p.x, p.y);
      const event = new PointerEvent(type, { pointerId: 21, pointerType: 'pen', bubbles: true, button: type === 'pointerdown' ? 0 : -1, buttons: type === 'pointerup' ? 0 : 1, pressure: p.pressure, clientX: b.left + vp.x * b.width / canvas.clientWidth, clientY: b.top + vp.y * b.height / canvas.clientHeight });
      Object.defineProperty(event, 'timeStamp', { value: ts });
      // InkSamples reads clientX/clientY/timeStamp/pressure from coalesced
      // entries directly, so give each history entry real values.
      if (history) Object.defineProperty(event, 'getCoalescedEvents', { value: () => history.map(h => {
        const v = f.engine.viewport.pageToCanvas(h.x, h.y);
        const e2 = new PointerEvent('pointermove', { pointerId: 21, pointerType: 'pen', pressure: h.pressure, clientX: b.left + v.x * b.width / canvas.clientWidth, clientY: b.top + v.y * b.height / canvas.clientHeight });
        Object.defineProperty(e2, 'timeStamp', { value: h.t + start });
        return e2;
      }) });
      canvas.dispatchEvent(event);
    };
    for (let d = 0; d < dispatches.length; d++) {
      const item = dispatches[d];
      if (d === 0) {
        dispatch('pointerdown', raw[0], [item.event], start + raw[0].t);
      } else {
        const history = item.regress ? [...item.history, item.regress] : item.history;
        dispatch('pointermove', item.event, history, start + item.event.t);
      }
      const points = f.engine.input.currentPoints;
      const count = points.length;
      if (prevPointsJson !== null && count >= prevCount) {
        if (JSON.stringify(points.slice(0, prevCount)) !== prevPointsJson) {
          prefixGeomFrames++;
          const prev = JSON.parse(prevPointsJson);
          let firstRevised = prevCount;
          for (let j = 0; j < Math.min(prevCount, points.length); j++) {
            const dx = points[j].x - prev[j].x, dy = points[j].y - prev[j].y;
            if (dx !== 0 || dy !== 0) { firstRevised = Math.min(firstRevised, j); }
            const dd = Math.hypot(dx, dy) * zoom;
            if (dd > prefixGeomMaxMove) prefixGeomMaxMove = dd;
          }
          if (firstRevised < prefixGeomFirstRevisedIndex) prefixGeomFirstRevisedIndex = firstRevised;
        }
      }
      prevPointsJson = JSON.stringify(points);
      prevCount = count;
      if (d % 4 === 3) {
        const data = f.pixels();
        if (prevPixels) {
          const last = points[points.length - 1];
          const nx = last.x * kx, ny = last.y * ky;
          const bx0 = Math.max(0, Math.floor(nx - margin)), by0 = Math.max(0, Math.floor(ny - margin));
          const bx1 = Math.min(canvas.width, Math.ceil(nx + margin)), by1 = Math.min(canvas.height, Math.ceil(ny + margin));
          let changed = 0, maxDelta = 0;
          for (let y = 0; y < canvas.height; y++) {
            const inNibY = y >= by0 && y < by1, row = y * canvas.width * 4;
            for (let x = 0; x < canvas.width; x++) {
              const o = row + x * 4;
              const dd = Math.max(Math.abs(data[o] - prevPixels[o]), Math.abs(data[o + 1] - prevPixels[o + 1]), Math.abs(data[o + 2] - prevPixels[o + 2]));
              if (!dd || (inNibY && x >= bx0 && x < bx1)) continue;
              changed++;
              if (dd > maxDelta) maxDelta = dd;
            }
          }
          if (changed) { prefixRasterFrames++; prefixRasterPixels += changed; if (maxDelta > prefixRasterMaxDelta) prefixRasterMaxDelta = maxDelta; }
        }
        prevPixels = data;
        await f.frames(1);
      }
    }
    const pointsBeforeUp = f.engine.input.currentPoints.length;
    const rawBeforeUp = f.engine.input.inkRawPoints.length;
    const samplesBeforeUp = f.engine.input.inkSamples?.samples.length ?? -1;
    dispatch('pointerup', raw[raw.length - 1], [], start + 1001);
    const trace = window.__panvasHandwritingTraces.at(-1);
    return {
      zoom, setting, dispatches: dispatches.length,
      outcome: trace?.outcome ?? 'none',
      pointsBeforeUp, rawBeforeUp, samplesBeforeUp,
      strokes: f.engine.drawing.getStrokes().length,
      rebuilds: trace?.counters.rebuilds ?? 0,
      duplicates: trace?.counters.exactDuplicates ?? 0,
      committed: trace?.counters.committedPoints ?? 0,
      prefixRasterFrames, prefixRasterPixels, prefixRasterMaxDelta,
      prefixGeomFrames, prefixGeomMaxMove: Number(prefixGeomMaxMove.toFixed(4)),
      prefixGeomFirstRevisedIndex: Number.isFinite(prefixGeomFirstRevisedIndex) ? prefixGeomFirstRevisedIndex : -1,
    };
  }, { zoom, setting: 50 });
  report.cases.push({ dpr, coalescedStream: coalesced });
  console.log(`[${label}] coalesced zoom=${coalesced.zoom}: outcome=${coalesced.outcome} strokes=${coalesced.strokes} pts=${coalesced.pointsBeforeUp} raw=${coalesced.rawBeforeUp} samples=${coalesced.samplesBeforeUp} rebuilds=${coalesced.rebuilds} committed=${coalesced.committed} | prefixRaster ${coalesced.prefixRasterFrames}f/${coalesced.prefixRasterPixels}px max ${coalesced.prefixRasterMaxDelta} | prefixGeom ${coalesced.prefixGeomFrames}f max ${coalesced.prefixGeomMaxMove} firstRevised=${coalesced.prefixGeomFirstRevisedIndex}`);
  if (coalesced.outcome !== 'complete' || coalesced.strokes < 1 || coalesced.rebuilds < 5) {
    throw new Error(`coalesced probe sanity failed at zoom=${coalesced.zoom}: ${JSON.stringify(coalesced)}`);
  }
  }

  // Phase 3: presentation determinism — identical strokes through the real compositor.
  for (const zoom of [1, 0.5]) {
    const shots = [];
    for (let rep = 0; rep < 3; rep++) {
      await page.evaluate(async zoom => {
        const f = window.inkFixture;
        f.configure(zoom, 50);
        const fixture = f.fixture('word', 120, zoom), start = performance.now();
        for (let i = 0; i < fixture.raw.length; i++) {
          f.dispatch(i ? 'pointermove' : 'pointerdown', fixture.raw[i], 'pen', start + fixture.raw[i].t);
          if (i % 4 === 3) await f.frames(1);
        }
        f.dispatch('pointerup', fixture.raw[fixture.raw.length - 1], 'pen', start + 1001);
        await f.frames(2);
      }, zoom);
      shots.push(await page.locator('#host').screenshot({ type: 'png' }));
    }
    const diffs = await page.evaluate(async buffers => {
      const images = await Promise.all(buffers.map(b => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = 'data:image/png;base64,' + b;
      })));
      const w = images[0].width, h = images[0].height;
      const canvases = images.map(img => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.getContext('2d').getImageData(0, 0, w, h).data;
      });
      const pairwise = [];
      for (let i = 1; i < canvases.length; i++) {
        let changed = 0, perceptible = 0, maxDelta = 0;
        for (let o = 0; o < canvases[i].length; o += 4) {
          const d = Math.max(Math.abs(canvases[i][o] - canvases[i - 1][o]), Math.abs(canvases[i][o + 1] - canvases[i - 1][o + 1]), Math.abs(canvases[i][o + 2] - canvases[i - 1][o + 2]));
          if (!d) continue;
          changed++;
          if (d >= 8) perceptible++;
          if (d > maxDelta) maxDelta = d;
        }
        pairwise.push({ changed, perceptible, maxDelta });
      }
      return { w, h, pairwise };
    }, shots.map(s => s.toString('base64')));
    report.presentation.push({ dpr, zoom, ...diffs });
    console.log(`[${label}] presentation zoom=${zoom}: ${JSON.stringify(diffs.pairwise)}`);
    await writeFile(path.join(outDir, `${label}-presentation-zoom${zoom}.png`), shots[0]);
  }

  await page.screenshot({ path: path.join(outDir, `${label}-final.png`) });
  await browser.close();
}

await server.close();
await writeFile(path.join(outDir, 'probe-report.json'), JSON.stringify(report, null, 2));
const worst = report.cases.reduce((m, c) => Math.max(m, c.prefixRasterFrames ? 1 : 0, c.prefixGeomFrames ? 1 : 0), 0);
console.log(`PROBE DONE: ${report.cases.length} cases; temporal instability detected: ${worst ? 'YES' : 'none'}. Evidence: ${outDir}`);
