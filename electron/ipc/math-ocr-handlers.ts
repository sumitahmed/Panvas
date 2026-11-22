import { app, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess, type WebContents } from 'electron';
import path from 'node:path';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireTrustedSender } from './security.js';

export interface MathOcrStatus {
  ready: boolean;
  modelId: string;
  dtype: 'q8';
  approxSizeMb: number;
  license: string;
  cacheBytes: number;
}

export interface MathOcrProgressEvent {
  phase: 'downloading' | 'loading' | 'ready';
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  file?: string;
}

export interface MathOcrRecognizeResult {
  latex: string;
  rawLatex: string;
  elapsedMs: number;
}

const MATH_OCR_MODEL_ID = 'onnx-community/TexTeller3-ONNX';
const MATH_OCR_MODEL_DTYPE = 'q8' as const;
const MATH_OCR_APPROX_SIZE_MB = 317;
const MATH_OCR_LICENSE = 'Apache-2.0';
const WORKER_IDLE_TIMEOUT_MS = 90 * 1000;
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let worker: UtilityProcess | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let progressTargetSender: WebContents | null = null;
let requestCounter = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();

function getCacheDir(): string {
  return path.join(app.getPath('userData'), 'models', 'math-ocr');
}

function directoryBytes(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else if (entry.isFile()) {
      try { total += statSync(full).size; } catch { /* ignore temp files */ }
    }
  }
  return total;
}

export function getMathOcrStatusSync(): MathOcrStatus {
  const modelRoot = path.join(getCacheDir(), 'onnx-community', 'TexTeller3-ONNX');
  const required = [
    path.join(modelRoot, 'config.json'),
    path.join(modelRoot, 'preprocessor_config.json'),
    path.join(modelRoot, 'tokenizer.json'),
    path.join(modelRoot, 'tokenizer_config.json'),
  ];
  const onnxRequired = [
    path.join(modelRoot, 'onnx', 'encoder_model_quantized.onnx'),
    path.join(modelRoot, 'onnx', 'decoder_model_merged_quantized.onnx'),
  ];
  const ready = required.every(p => existsSync(p))
    && onnxRequired.every(p => existsSync(p) && statSync(p).size >= 10_000_000);
  return {
    ready,
    modelId: MATH_OCR_MODEL_ID,
    dtype: MATH_OCR_MODEL_DTYPE,
    approxSizeMb: MATH_OCR_APPROX_SIZE_MB,
    license: MATH_OCR_LICENSE,
    cacheBytes: directoryBytes(modelRoot),
  };
}

function resetIdleTimer(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void shutdownMathOcrWorker();
  }, WORKER_IDLE_TIMEOUT_MS);
}

function broadcastProgress(progress: MathOcrProgressEvent): void {
  if (progressTargetSender && !progressTargetSender.isDestroyed()) {
    progressTargetSender.send('mathOcr:progress', progress);
  }
}

function ensureWorker(): UtilityProcess {
  if (worker) {
    resetIdleTimer();
    return worker;
  }
  const workerPath = path.join(__dirname, 'mathOcrWorker.mjs');
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: 'panvas-math-ocr',
    env: {
      ...process.env,
      PANVAS_MATH_OCR_CACHE_DIR: getCacheDir(),
    },
  });
  worker = child;

  child.on('message', (msg: any) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'progress' && msg.progress) {
      broadcastProgress(msg.progress as MathOcrProgressEvent);
      return;
    }
    if (msg.type === 'response' && typeof msg.requestId === 'number') {
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      pending.delete(msg.requestId);
      resetIdleTimer();
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(typeof msg.error === 'string' ? msg.error : 'Math OCR worker error'));
    }
  });

  child.on('exit', () => {
    if (worker === child) worker = null;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    for (const entry of pending.values()) {
      entry.reject(new Error('Math OCR worker exited before responding.'));
    }
    pending.clear();
  });

  resetIdleTimer();
  return child;
}

function callWorker<T>(action: string, payload?: unknown): Promise<T> {
  const child = ensureWorker();
  const requestId = ++requestCounter;
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    child.postMessage({ requestId, action, payload });
  });
}

function validatePngBytes(input: unknown): Uint8Array {
  if (!(input instanceof Uint8Array)) {
    throw new Error('mathOcr:recognizeImage requires a Uint8Array PNG payload.');
  }
  if (input.byteLength <= PNG_MAGIC.length || input.byteLength > MAX_PNG_BYTES) {
    throw new Error(`Invalid PNG payload size: ${input.byteLength} bytes.`);
  }
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (input[i] !== PNG_MAGIC[i]) {
      throw new Error('Invalid PNG header signature.');
    }
  }
  return input;
}

export async function handleMathOcrGetStatus(event: IpcMainInvokeEvent): Promise<MathOcrStatus> {
  requireTrustedSender(event);
  return getMathOcrStatusSync();
}

export async function handleMathOcrDownloadModel(event: IpcMainInvokeEvent): Promise<MathOcrStatus> {
  requireTrustedSender(event);
  progressTargetSender = event.sender;
  return callWorker<MathOcrStatus>('download');
}

export async function handleMathOcrRecognizeImage(event: IpcMainInvokeEvent, pngBytes: unknown): Promise<MathOcrRecognizeResult> {
  requireTrustedSender(event);
  const validPng = validatePngBytes(pngBytes);
  return callWorker<MathOcrRecognizeResult>('recognize', { pngBytes: validPng });
}

export async function handleMathOcrCancel(event: IpcMainInvokeEvent): Promise<{ cancelled: boolean }> {
  requireTrustedSender(event);
  if (!worker) return { cancelled: true };
  return callWorker<{ cancelled: boolean }>('cancel');
}

export async function handleMathOcrRemoveModel(event: IpcMainInvokeEvent): Promise<MathOcrStatus> {
  requireTrustedSender(event);
  if (worker) {
    return callWorker<MathOcrStatus>('clearCache');
  }
  const modelRoot = path.join(getCacheDir(), 'onnx-community', 'TexTeller3-ONNX');
  if (existsSync(modelRoot)) {
    rmSync(modelRoot, { recursive: true, force: true });
  }
  return getMathOcrStatusSync();
}

export async function shutdownMathOcrWorker(): Promise<void> {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const child = worker;
  worker = null;
  if (!child) return;
  try {
    child.kill();
  } catch {
    // Worker already terminated
  }
}
