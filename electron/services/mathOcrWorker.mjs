import { createMathOcrSession } from './mathOcrCore.mjs';

const port = process.parentPort;
if (!port) {
  throw new Error('mathOcrWorker must run inside Electron utilityProcess');
}

const cacheDir = process.env.PANVAS_MATH_OCR_CACHE_DIR;
if (!cacheDir) {
  throw new Error('PANVAS_MATH_OCR_CACHE_DIR environment variable is required');
}

let activeController = null;
const session = createMathOcrSession({
  cacheDir,
  onProgress: progress => {
    port.postMessage({ type: 'progress', progress });
  },
});

port.on('message', async event => {
  const msg = event?.data;
  if (!msg || typeof msg !== 'object') return;
  const { requestId, action, payload } = msg;

  try {
    if (action === 'status') {
      port.postMessage({ type: 'response', requestId, ok: true, result: session.getStatus() });
      return;
    }

    if (action === 'cancel') {
      activeController?.abort(new Error('Cancelled by user'));
      activeController = null;
      port.postMessage({ type: 'response', requestId, ok: true, result: { cancelled: true } });
      return;
    }

    if (action === 'clearCache') {
      activeController?.abort(new Error('Cache cleared'));
      activeController = null;
      const status = await session.clearCache();
      port.postMessage({ type: 'response', requestId, ok: true, result: status });
      return;
    }

    if (action === 'shutdown') {
      activeController?.abort(new Error('Worker shutting down'));
      activeController = null;
      await session.dispose();
      port.postMessage({ type: 'response', requestId, ok: true, result: { shutdown: true } });
      process.exit(0);
    }

    if (action === 'download') {
      activeController?.abort(new Error('Superseded by new download request'));
      const controller = new AbortController();
      activeController = controller;
      try {
        const status = await session.downloadModel(controller.signal);
        port.postMessage({ type: 'response', requestId, ok: true, result: status });
      } finally {
        if (activeController === controller) activeController = null;
      }
      return;
    }

    if (action === 'recognize') {
      activeController?.abort(new Error('Superseded by new recognition request'));
      const controller = new AbortController();
      activeController = controller;
      try {
        const result = await session.recognizeImage(payload?.pngBytes, controller.signal);
        port.postMessage({ type: 'response', requestId, ok: true, result });
      } finally {
        if (activeController === controller) activeController = null;
      }
      return;
    }

    port.postMessage({
      type: 'response',
      requestId,
      ok: false,
      error: `Unknown mathOcrWorker action: ${String(action)}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    port.postMessage({ type: 'response', requestId, ok: false, error: message });
  }
});
