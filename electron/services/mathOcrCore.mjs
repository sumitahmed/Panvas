import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  AutoProcessor,
  AutoTokenizer,
  VisionEncoderDecoderModel,
  RawImage,
  env,
} from '@huggingface/transformers';

export const MATH_OCR_MODEL_ID = 'onnx-community/TexTeller3-ONNX';
export const MATH_OCR_MODEL_DTYPE = 'q8';
export const MATH_OCR_APPROX_SIZE_MB = 317;
export const MATH_OCR_LICENSE = 'Apache-2.0';

const REQUIRED_ONNX_FILES = [
  path.join('onnx', 'encoder_model_quantized.onnx'),
  path.join('onnx', 'decoder_model_merged_quantized.onnx'),
];

const REQUIRED_CONFIG_FILES = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
];

function directoryBytes(dirPath) {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(full);
    } else if (entry.isFile()) {
      try {
        total += statSync(full).size;
      } catch {
        // Ignore racing temp file deletion
      }
    }
  }
  return total;
}

/**
 * Inspect whether quantized TexTeller3 ONNX weights and tokenizer/config files
 * are completely present on disk without loading ONNX Runtime or consuming RAM.
 */
export function inspectMathOcrCache(cacheDir) {
  const modelRoot = path.join(cacheDir, 'onnx-community', 'TexTeller3-ONNX');
  if (!existsSync(modelRoot)) {
    return {
      ready: false,
      modelId: MATH_OCR_MODEL_ID,
      dtype: MATH_OCR_MODEL_DTYPE,
      approxSizeMb: MATH_OCR_APPROX_SIZE_MB,
      license: MATH_OCR_LICENSE,
      cacheBytes: 0,
    };
  }

  let allPresent = true;
  for (const rel of REQUIRED_CONFIG_FILES) {
    if (!existsSync(path.join(modelRoot, rel))) {
      allPresent = false;
      break;
    }
  }
  if (allPresent) {
    for (const rel of REQUIRED_ONNX_FILES) {
      const full = path.join(modelRoot, rel);
      if (!existsSync(full) || statSync(full).size < 10_000_000) {
        allPresent = false;
        break;
      }
    }
  }

  return {
    ready: allPresent,
    modelId: MATH_OCR_MODEL_ID,
    dtype: MATH_OCR_MODEL_DTYPE,
    approxSizeMb: MATH_OCR_APPROX_SIZE_MB,
    license: MATH_OCR_LICENSE,
    cacheBytes: directoryBytes(modelRoot),
  };
}

/**
 * Clean outer math delimiters and stray internal braces whitespace produced by TexTeller3
 * so outputs render directly inside KaTeX `displayMode: true` and TipTap blockMath nodes.
 */
export function normalizeTexTellerLatex(raw) {
  if (typeof raw !== 'string') return '';
  let latex = raw.trim();
  if (!latex) return '';

  // Strip outer display / inline TeX delimiters.
  if (latex.startsWith('\\[') && latex.endsWith('\\]')) {
    latex = latex.slice(2, -2).trim();
  } else if (latex.startsWith('$$') && latex.endsWith('$$')) {
    latex = latex.slice(2, -2).trim();
  } else if (latex.startsWith('$') && latex.endsWith('$') && latex.length >= 2) {
    latex = latex.slice(1, -1).trim();
  }

  // Collapse stray whitespace right after opening braces (e.g. `^{ \infty}` -> `^{\infty}`).
  latex = latex
    .replace(/\{\s+([\\A-Za-z0-9(])/g, '{$1')
    .replace(/\s+\}/g, '}')
    .replace(/\r\n/g, '\n')
    .trim();

  return latex;
}

/**
 * Two-pass sharp preprocessing required for TexTeller3 ViT+TrOCR:
 * 1) flatten onto #ffffff, trim margins, resize inside 420x420;
 * 2) read dimensions, center-pad to exact 448x448 #ffffff, 1-channel greyscale RawImage.
 * Note: sharp applies extend() after resize() if chained in one pass, so two passes are mandatory.
 */
export async function preprocessImageToGray448(pngBytes) {
  const input = Buffer.isBuffer(pngBytes) ? pngBytes : Buffer.from(pngBytes);
  let trimmed;
  try {
    trimmed = await sharp(input)
      .flatten({ background: '#ffffff' })
      .trim({ threshold: 15 })
      .toBuffer();
  } catch {
    return null;
  }

  const trimmedMeta = await sharp(trimmed).metadata();
  if (!trimmedMeta.width || !trimmedMeta.height) return null;

  const resized = await sharp(trimmed)
    .resize({ width: 420, height: 420, fit: 'inside', kernel: sharp.kernel.cubic, background: '#ffffff' })
    .toBuffer();
  const resizedMeta = await sharp(resized).metadata();
  const rw = resizedMeta.width || 1;
  const rh = resizedMeta.height || 1;

  const padLeft = Math.max(0, Math.floor((448 - rw) / 2));
  const padRight = Math.max(0, 448 - rw - padLeft);
  const padTop = Math.max(0, Math.floor((448 - rh) / 2));
  const padBottom = Math.max(0, 448 - rh - padTop);

  const gray = await sharp(resized)
    .extend({ top: padTop, bottom: padBottom, left: padLeft, right: padRight, background: '#ffffff' })
    .greyscale()
    .linear(1.22, -48)
    .raw()
    .toBuffer({ resolveWithObject: true });

  return new RawImage(
    new Uint8ClampedArray(gray.data),
    gray.info.width,
    gray.info.height,
    gray.info.channels,
  );
}

/**
 * Manage on-demand loading, download, inference, and disposal for TexTeller3-ONNX (q8).
 */
export function createMathOcrSession({ cacheDir, onProgress } = {}) {
  if (!cacheDir) throw new Error('cacheDir is required for Math OCR session');

  let processor = null;
  let tokenizer = null;
  let model = null;
  let loadPromise = null;

  const configureEnv = allowRemote => {
    env.cacheDir = cacheDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = Boolean(allowRemote);
  };

  async function ensureLoaded({ allowDownload, signal } = {}) {
    if (processor && tokenizer && model) return;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      configureEnv(allowDownload);
      const fileSizes = new Map();
      let lastPercent = -1;

      const emitProgress = info => {
        if (signal?.aborted) {
          throw new Error('Math OCR download cancelled');
        }
        if (!info || typeof info !== 'object') return;
        if (typeof info.file === 'string' && typeof info.total === 'number' && info.total > 0) {
          fileSizes.set(info.file, {
            loaded: Math.min(info.total, Math.max(0, Number(info.loaded) || 0)),
            total: info.total,
          });
        }
        let sumLoaded = 0;
        let sumTotal = 0;
        for (const entry of fileSizes.values()) {
          sumLoaded += entry.loaded;
          sumTotal += entry.total;
        }
        const baselineTotal = Math.max(sumTotal, MATH_OCR_APPROX_SIZE_MB * 1024 * 1024);
        const percent = Math.min(99, Math.max(0, Math.floor((sumLoaded / baselineTotal) * 100)));
        if (percent !== lastPercent || info.status === 'ready') {
          lastPercent = percent;
          onProgress?.({
            phase: allowDownload ? 'downloading' : 'loading',
            percent: info.status === 'ready' ? 100 : percent,
            downloadedBytes: sumLoaded,
            totalBytes: baselineTotal,
            file: typeof info.file === 'string' ? info.file : undefined,
          });
        }
      };

      const [nextProcessor, nextTokenizer] = await Promise.all([
        AutoProcessor.from_pretrained(MATH_OCR_MODEL_ID),
        AutoTokenizer.from_pretrained(MATH_OCR_MODEL_ID),
      ]);
      if (signal?.aborted) throw new Error('Math OCR download cancelled');

      const threadBudget = Math.min(4, Math.max(1, Math.floor((os.cpus()?.length || 2) / 2)));
      const nextModel = await VisionEncoderDecoderModel.from_pretrained(MATH_OCR_MODEL_ID, {
        dtype: MATH_OCR_MODEL_DTYPE,
        session_options: {
          intraOpNumThreads: threadBudget,
          interOpNumThreads: 1,
        },
        progress_callback: emitProgress,
      });
      if (signal?.aborted) {
        await nextModel.dispose?.();
        throw new Error('Math OCR download cancelled');
      }

      processor = nextProcessor;
      tokenizer = nextTokenizer;
      model = nextModel;
      onProgress?.({
        phase: 'ready',
        percent: 100,
        downloadedBytes: MATH_OCR_APPROX_SIZE_MB * 1024 * 1024,
        totalBytes: MATH_OCR_APPROX_SIZE_MB * 1024 * 1024,
      });
    })();

    try {
      await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  async function recognizeImage(pngBytes, signal) {
    if (signal?.aborted) throw new Error('Math OCR recognition cancelled');
    const cached = inspectMathOcrCache(cacheDir);
    if (!cached.ready && !(processor && tokenizer && model)) {
      throw new Error('Local Math OCR model is not downloaded yet.');
    }

    await ensureLoaded({ allowDownload: false, signal });
    if (signal?.aborted) throw new Error('Math OCR recognition cancelled');

    const startedAt = performance.now();
    const grayImg = await preprocessImageToGray448(pngBytes);
    if (!grayImg) {
      return { latex: '', rawLatex: '', elapsedMs: Math.round(performance.now() - startedAt) };
    }

    const inputs = await processor(grayImg);
    if (signal?.aborted) throw new Error('Math OCR recognition cancelled');

    // TexTeller3-ONNX config.json leaves decoder_start_token_id unset; explicit 0 is critical.
    const output = await model.generate({
      ...inputs,
      max_new_tokens: 384,
      decoder_start_token_id: 0,
      do_sample: false,
    });
    const rawLatex = tokenizer.batch_decode(output, { skip_special_tokens: true })[0] ?? '';
    return {
      latex: normalizeTexTellerLatex(rawLatex),
      rawLatex,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  }

  async function downloadModel(signal) {
    await ensureLoaded({ allowDownload: true, signal });
    return inspectMathOcrCache(cacheDir);
  }

  async function dispose() {
    loadPromise = null;
    const activeModel = model;
    model = null;
    processor = null;
    tokenizer = null;
    if (activeModel?.dispose) {
      await activeModel.dispose();
    }
  }

  async function clearCache() {
    await dispose();
    const modelRoot = path.join(cacheDir, 'onnx-community', 'TexTeller3-ONNX');
    if (existsSync(modelRoot)) {
      rmSync(modelRoot, { recursive: true, force: true });
    }
    return inspectMathOcrCache(cacheDir);
  }

  return {
    getStatus: () => inspectMathOcrCache(cacheDir),
    downloadModel,
    recognizeImage,
    clearCache,
    dispose,
  };
}
