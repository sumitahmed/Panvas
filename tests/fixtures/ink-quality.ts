import { NotebookEngine } from '../../src/components/notebook/engine/NotebookEngine';
import { createEmptyDrawingData, type StrokePoint } from '../../src/components/notebook/engine/drawingTypes';
import { inkFixture, qualityMetrics, handwritingLetters, INK_CASES, INK_ZOOMS, INK_STABILIZATION } from './inkQuality';
import { PenGeometry } from '../../src/components/notebook/engine/penGeometry';
import { InkInputFilter } from '../../src/components/notebook/engine/inkInput';

const canvas = document.querySelector<HTMLCanvasElement>('#ink')!;
const host = document.querySelector<HTMLDivElement>('#host')!;
const engine = new NotebookEngine();
engine.setDrawingData(createEmptyDrawingData(), 'ink-quality');
engine.mount(canvas, 820, 600);
engine.tools.setMode('draw');
engine.tools.setColor('#981b22');
engine.tools.setThickness(2);
engine.tools.setStabilization(0);
engine.tools.setPressureSensitivity(true);
const frames = async (n = 2) => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); };

function configure(zoom: number, setting: number) {
  engine.setDrawingData(createEmptyDrawingData(), 'ink-quality');
  engine.tools.setMode('draw');
  engine.tools.setDrawingTool('pen');
  engine.tools.setInkFamily(undefined);
  engine.tools.setStrokePattern('solid');
  engine.tools.setPressureSensitivity(true);
  engine.tools.setThickness(2);
  engine.tools.setOpacity(1);
  engine.tools.setColor('#981b22');
  engine.tools.setRoughShapeRecognition(false);
  engine.tools.setStraightLineRecognition(false);
  engine.tools.setCircleToSelect(false);
  engine.tools.setScribbleToErase(false);
  engine.tools.setRulerEnabled(false);
  engine.tools.setStabilization(setting);
  engine.viewport.setZoom(zoom);
  engine.viewport.setRenderTransform({ scale: false, pan: false });
  engine.viewport.setPageCoordinateTransform(0, 820, 600, 0, 0);
  engine.drawing.setScaleMultiplier(zoom);
  engine.resize(820, 600);
  host.style.transform = `scale(${zoom})`;
}

function pixels() {
  const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(canvas, 0, 0);
  const wet = host.querySelector<HTMLCanvasElement>('[data-panvas-wet-ink]');
  if (wet) { ctx.globalAlpha = Number(wet.style.opacity || 1); ctx.drawImage(wet, 0, 0); }
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

function pixelDifference(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let channels = 0, max = 0, squared = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]); if (d) channels++; max = Math.max(max, d); squared += d * d;
  }
  const bounds = (data: Uint8ClampedArray) => {
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (let i = 0; i < data.length; i += 4) if (Math.min(data[i], data[i + 1], data[i + 2]) < 250) {
      const x = i / 4 % canvas.width, y = Math.floor(i / 4 / canvas.width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return [left, top, right, bottom];
  };
  const aa = bounds(a), bb = bounds(b);
  return { channels, max, rms: Math.sqrt(squared / a.length), boundsDeltaPixels: Math.max(...aa.map((v, i) => v === bb[i] ? 0 : Math.abs(v - bb[i]))) };
}

function dispatch(type: string, point: StrokePoint, pointerType = 'pen', time = performance.now()) {
  const b = canvas.getBoundingClientRect();
  const p = engine.viewport.pageToCanvas(point.x, point.y);
  const event = new PointerEvent(type, { pointerId: 13, pointerType,
    clientX: b.left + p.x * b.width / canvas.clientWidth, clientY: b.top + p.y * b.height / canvas.clientHeight,
    pressure: type === 'pointerup' ? 0 : point.pressure, button: type === 'pointerdown' ? 0 : -1,
    buttons: type === 'pointerup' ? 0 : 1, bubbles: true });
  Object.defineProperty(event, 'timeStamp', { value: time });
  canvas.dispatchEvent(event);
  return event;
}

async function exportPixels() {
  const { PDFDocument } = await import('pdf-lib');
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const { drawPdfStroke } = await import('../../src/services/pdf/drawPdfStroke');
  const pdf = await PDFDocument.create(), page = pdf.addPage([820, 600]);
  for (const stroke of engine.drawing.getStrokes()) drawPdfStroke(page, stroke);
  const bytes = await pdf.save();
  const reopened = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  try {
    const sheet = await reopened.getPage(1), viewport = sheet.getViewport({ scale: canvas.width / 820 });
    const target = document.createElement('canvas'); target.width = canvas.width; target.height = canvas.height;
    const context = target.getContext('2d')!;
    await sheet.render({ canvasContext: context, viewport }).promise;
    return { pixels: context.getImageData(0, 0, target.width, target.height).data, bytes: Array.from(bytes) };
  } finally { await reopened.destroy(); }
}

Object.assign(window, { inkFixture: { engine, canvas, configure, dispatch, frames,
  pixels, pixelDifference, exportPixels, letters: handwritingLetters, InkInputFilter,
  fixture: inkFixture, metrics: qualityMetrics, cases: INK_CASES, zooms: INK_ZOOMS, settings: INK_STABILIZATION, PenGeometry } });
