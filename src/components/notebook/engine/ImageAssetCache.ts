import type { ImageFileData } from '../../../types/canvas.ts';

export type MipTier = 128 | 256 | 512 | 1024 | 2048 | 'original';
export type ImageLoadPriority = 'visible' | 'prefetch';

const NUMERIC_TIERS: readonly (128 | 256 | 512 | 1024 | 2048)[] = [128, 256, 512, 1024, 2048];
const DESKTOP_BUDGET_BYTES = 192 * 1024 * 1024;
const MOBILE_BUDGET_BYTES = 96 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 4;

export interface ImageAssetRecord {
  id?: string;
  fileName?: string;
  mimeType?: string;
  data?: ArrayBuffer | ArrayBufferView;
  blob?: Blob;
}

export interface MipEntry {
  drawable: CanvasImageSource;
  width: number;
  height: number;
  bytes: number;
  isBitmap: boolean;
  lastAccess: number;
}

export interface CacheEntry {
  blob?: Blob;
  mimeType?: string;
  naturalWidth: number;
  naturalHeight: number;
  mips: Map<MipTier, MipEntry>;
  pins: Set<string>;
  lastAccess: number;
  lastDesiredTier?: MipTier;
}

export interface BestDrawableResult {
  drawable: CanvasImageSource;
  width: number;
  height: number;
  tier: MipTier;
  needsPromotion: boolean;
}

export interface ImageAssetCacheStats {
  totalBytes: number;
  entryCount: number;
  fetchCount: number;
  inFlightCount: number;
  budgetBytes: number;
  pinnedCount: number;
}

export interface ImageAssetCacheOptions {
  maxBytes?: number;
  maxConcurrent?: number;
  loader?: (fileId: string) => Promise<ImageAssetRecord | ImageFileData | undefined>;
}

interface QueuedJob {
  key: string;
  priority: ImageLoadPriority;
  run: () => void;
}

function resolveDefaultBudgetBytes(): number {
  if (typeof navigator !== 'undefined' && /Mobi|Android/i.test(navigator.userAgent)) {
    return MOBILE_BUDGET_BYTES;
  }
  return DESKTOP_BUDGET_BYTES;
}

async function defaultImageLoader(fileId: string): Promise<ImageFileData | undefined> {
  const { canvasRepository } = await import('@/repositories/CanvasRepository');
  return canvasRepository.getImage(fileId);
}

function tierRank(tier: MipTier): number {
  return tier === 'original' ? Number.POSITIVE_INFINITY : tier;
}

function isImageBitmapLike(drawable: unknown): drawable is ImageBitmap {
  return Boolean(drawable && typeof drawable === 'object' && 'close' in drawable);
}

function getDrawableSize(drawable: unknown): { width: number; height: number } {
  if (!drawable || typeof drawable !== 'object') return { width: 0, height: 0 };
  if ('close' in drawable) {
    const bmp = drawable as ImageBitmap;
    return {
      width: Number.isFinite(bmp.width) ? bmp.width : 0,
      height: Number.isFinite(bmp.height) ? bmp.height : 0,
    };
  }
  const img = drawable as Partial<HTMLImageElement>;
  if ('complete' in img && img.complete === false) return { width: 0, height: 0 };
  const width = (typeof img.naturalWidth === 'number' && img.naturalWidth > 0)
    ? img.naturalWidth
    : (typeof (img as { width?: number }).width === 'number' ? (img as { width: number }).width : 0);
  const height = (typeof img.naturalHeight === 'number' && img.naturalHeight > 0)
    ? img.naturalHeight
    : (typeof (img as { height?: number }).height === 'number' ? (img as { height: number }).height : 0);
  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  };
}

export function isDrawableUsable(drawable: unknown): drawable is CanvasImageSource {
  if (!drawable || typeof drawable !== 'object') return false;
  if ('close' in drawable) {
    const bmp = drawable as ImageBitmap;
    return Number.isFinite(bmp.width) && bmp.width > 0 && Number.isFinite(bmp.height) && bmp.height > 0;
  }
  const { width, height } = getDrawableSize(drawable);
  return width > 0 && height > 0;
}

/** Select the smallest mip tier that covers the target on-screen pixel demand. */
export function selectMipTier(
  drawWidthPx: number,
  drawHeightPx: number,
  crop: { width: number; height: number },
  naturalWidth?: number,
  naturalHeight?: number,
): MipTier {
  const safeCropW = Number.isFinite(crop?.width) ? Math.max(0.01, crop.width) : 1;
  const safeCropH = Number.isFinite(crop?.height) ? Math.max(0.01, crop.height) : 1;
  const safeW = Number.isFinite(drawWidthPx) ? Math.abs(drawWidthPx) : 0;
  const safeH = Number.isFinite(drawHeightPx) ? Math.abs(drawHeightPx) : 0;
  const reqW = Math.ceil(safeW / safeCropW);
  const reqH = Math.ceil(safeH / safeCropH);
  const demand = Math.max(reqW, reqH);
  if (naturalWidth && naturalHeight && demand >= Math.max(naturalWidth, naturalHeight)) {
    return 'original';
  }
  for (const tier of NUMERIC_TIERS) {
    if (tier >= demand) return tier;
  }
  return 'original';
}

function readUint16BE(view: DataView, offset: number): number {
  return view.getUint16(offset, false);
}

function readUint16LE(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUint32BE(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function readUint32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Fast header dimension read for PNG/GIF/WebP (and plain non-EXIF JPEG) without allocating bitmaps. */
async function probeBlobHeaderDimensions(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    if (typeof blob.slice !== 'function' || blob.size < 16) return null;
    const headSize = Math.min(blob.size, 65_536);
    const buf = await blob.slice(0, headSize).arrayBuffer();
    if (buf.byteLength < 16) return null;
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);

    // PNG: 89 50 4E 47 0D 0A 1A 0A ... IHDR
    if (
      bytes.length >= 24 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52
    ) {
      const width = readUint32BE(view, 16);
      const height = readUint32BE(view, 20);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    // GIF87a / GIF89a
    if (
      bytes.length >= 10 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
    ) {
      const width = readUint16LE(view, 6);
      const height = readUint16LE(view, 8);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    // WebP (RIFF....WEBP)
    if (
      bytes.length >= 30 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      const c0 = bytes[12], c1 = bytes[13], c2 = bytes[14], c3 = bytes[15];
      if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x20 && bytes.length >= 30) {
        if (bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
          const width = readUint16LE(view, 26) & 0x3fff;
          const height = readUint16LE(view, 28) & 0x3fff;
          return width > 0 && height > 0 ? { width, height } : null;
        }
      } else if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x4c && bytes.length >= 25 && bytes[20] === 0x2f) {
        const b = readUint32LE(view, 21);
        const width = (b & 0x3fff) + 1;
        const height = ((b >> 14) & 0x3fff) + 1;
        return width > 0 && height > 0 ? { width, height } : null;
      } else if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x58 && bytes.length >= 30) {
        const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
        const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
        return width > 0 && height > 0 ? { width, height } : null;
      }
    }

    // JPEG without EXIF orientation (skip shortcut if APP1 EXIF marker is present)
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) break;
        while (offset < bytes.length && bytes[offset] === 0xff) offset++;
        if (offset >= bytes.length) break;
        const marker = bytes[offset++];
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x00) continue;
        if (marker === 0xe1) return null; // APP1/EXIF may carry orientation rotation
        if (offset + 2 > bytes.length) break;
        const segLen = readUint16BE(view, offset);
        if (segLen < 2 || offset + segLen > bytes.length) break;
        const isSof = (marker >= 0xc0 && marker <= 0xc3)
          || (marker >= 0xc5 && marker <= 0xc7)
          || (marker >= 0xc9 && marker <= 0xcb)
          || (marker >= 0xcd && marker <= 0xcf);
        if (isSof && segLen >= 7) {
          const height = readUint16BE(view, offset + 3);
          const width = readUint16BE(view, offset + 5);
          return width > 0 && height > 0 ? { width, height } : null;
        }
        offset += segLen;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function decodeViaHtmlImage(blob: Blob): Promise<HTMLImageElement> {
  if (typeof Image === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    throw new Error('Image decode unavailable in this runtime.');
  }
  const url = URL.createObjectURL(blob);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      resolve(img);
    };
    img.onerror = () => {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      reject(new Error('Failed to decode image via HTMLImageElement fallback.'));
    };
    img.src = url;
  });
}

function toBlob(record: ImageAssetRecord | ImageFileData): Blob | null {
  if ('blob' in record && record.blob instanceof Blob) return record.blob;
  if (record.data === undefined || record.data === null) return null;
  const mimeType = typeof record.mimeType === 'string' && record.mimeType ? record.mimeType : 'image/png';
  if (record.data instanceof ArrayBuffer) {
    return new Blob([record.data], { type: mimeType });
  }
  if (ArrayBuffer.isView(record.data)) {
    const view = new Uint8Array(record.data.buffer, record.data.byteOffset, record.data.byteLength);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return new Blob([copy.buffer], { type: mimeType });
  }
  return null;
}

export class ImageAssetCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly scopePins = new Map<string, Set<string>>();
  private readonly ownedBitmaps = new WeakSet<object>();
  private readonly fileVersions = new Map<string, number>();

  private readonly fetchPromises = new Map<string, Promise<CacheEntry | null>>();
  private readonly inFlightPreloads = new Map<string, Promise<CanvasImageSource | null>>();
  private readonly inFlightDecodes = new Map<string, Promise<CanvasImageSource | null>>();
  private readonly inFlightProbes = new Map<string, Promise<{ bitmap: ImageBitmap; refs: number } | null>>();
  private readonly promotionCallbacks = new Map<string, Set<() => void>>();

  private readonly queue: QueuedJob[] = [];
  private activeJobs = 0;

  private readonly maxBytes: number;
  private readonly maxConcurrent: number;
  private readonly loader: (fileId: string) => Promise<ImageAssetRecord | ImageFileData | undefined>;

  private totalBytes = 0;
  private fetchCount = 0;
  private accessClock = 0;

  constructor(options: ImageAssetCacheOptions = {}) {
    this.maxBytes = typeof options.maxBytes === 'number' && options.maxBytes >= 0
      ? options.maxBytes
      : resolveDefaultBudgetBytes();
    this.maxConcurrent = typeof options.maxConcurrent === 'number' && options.maxConcurrent >= 1
      ? Math.floor(options.maxConcurrent)
      : DEFAULT_MAX_CONCURRENT;
    this.loader = options.loader ?? defaultImageLoader;

    if (typeof window !== 'undefined') {
      (window as any).__panvasImageCache ??= this;
    }
  }

  private nextAccess(): number {
    return ++this.accessClock;
  }

  private fileVersion(fileId: string): number {
    return this.fileVersions.get(fileId) ?? 0;
  }

  private collectPinsForFile(fileId: string): Set<string> {
    const pins = new Set<string>();
    for (const [scopeId, fileIds] of this.scopePins) {
      if (fileIds.has(fileId)) pins.add(scopeId);
    }
    return pins;
  }

  private getOrCreateEntry(fileId: string): CacheEntry {
    let entry = this.entries.get(fileId);
    if (!entry) {
      entry = {
        naturalWidth: 0,
        naturalHeight: 0,
        mips: new Map(),
        pins: this.collectPinsForFile(fileId),
        lastAccess: this.nextAccess(),
      };
      this.entries.set(fileId, entry);
    }
    return entry;
  }

  private resolveEffectiveTier(desiredTier: MipTier, naturalWidth: number, naturalHeight: number): MipTier {
    if (desiredTier === 'original') return 'original';
    const naturalMax = Math.max(naturalWidth, naturalHeight);
    if (naturalMax > 0 && desiredTier >= naturalMax) return 'original';
    return desiredTier;
  }

  private safeCloseOwned(drawable: unknown): void {
    if (isImageBitmapLike(drawable) && this.ownedBitmaps.has(drawable)) {
      this.ownedBitmaps.delete(drawable);
      try {
        drawable.close();
      } catch {
        /* ignore already-closed bitmap */
      }
    }
  }

  private setMip(entry: CacheEntry, tier: MipTier, drawable: CanvasImageSource, owned: boolean): MipEntry {
    const existing = entry.mips.get(tier);
    if (existing) {
      if (existing.drawable === drawable) {
        existing.lastAccess = this.nextAccess();
        return existing;
      }
      entry.mips.delete(tier);
      this.totalBytes = Math.max(0, this.totalBytes - existing.bytes);
      this.safeCloseOwned(existing.drawable);
    }

    const { width, height } = getDrawableSize(drawable);
    const bytes = width > 0 && height > 0 ? width * height * 4 : 0;
    const isBitmap = isImageBitmapLike(drawable);
    if (isBitmap && owned) {
      this.ownedBitmaps.add(drawable);
    }
    const mip: MipEntry = {
      drawable,
      width,
      height,
      bytes,
      isBitmap,
      lastAccess: this.nextAccess(),
    };
    entry.mips.set(tier, mip);
    this.totalBytes += bytes;
    if (width > entry.naturalWidth) entry.naturalWidth = width;
    if (height > entry.naturalHeight) entry.naturalHeight = height;
    entry.lastAccess = mip.lastAccess;
    return mip;
  }

  private deleteMip(entry: CacheEntry, tier: MipTier): void {
    const mip = entry.mips.get(tier);
    if (!mip) return;
    entry.mips.delete(tier);
    this.totalBytes = Math.max(0, this.totalBytes - mip.bytes);
    this.safeCloseOwned(mip.drawable);
  }

  private pruneBrokenMips(entry: CacheEntry): void {
    for (const [tier, mip] of entry.mips) {
      if (!isDrawableUsable(mip.drawable)) {
        entry.mips.delete(tier);
        this.totalBytes = Math.max(0, this.totalBytes - mip.bytes);
        this.ownedBitmaps.delete(mip.drawable as object);
      }
    }
  }

  /** Atomically replace the set of fileIds pinned by `scopeId`. */
  pin(scopeId: string, fileIds: Iterable<string>): void {
    const prev = this.scopePins.get(scopeId);
    const next = new Set<string>();
    for (const id of fileIds) {
      if (typeof id === 'string' && id) next.add(id);
    }
    this.scopePins.set(scopeId, next);

    if (prev) {
      for (const oldId of prev) {
        if (!next.has(oldId)) {
          this.entries.get(oldId)?.pins.delete(scopeId);
        }
      }
    }
    for (const id of next) {
      const entry = this.entries.get(id);
      if (entry) {
        entry.pins.add(scopeId);
        entry.lastAccess = this.nextAccess();
      }
    }
  }

  /** Release all pins held by `scopeId` and trim cache if over budget. */
  unpin(scopeId: string): void {
    const prev = this.scopePins.get(scopeId);
    this.scopePins.delete(scopeId);
    if (prev) {
      for (const id of prev) {
        this.entries.get(id)?.pins.delete(scopeId);
      }
    } else {
      for (const entry of this.entries.values()) {
        entry.pins.delete(scopeId);
      }
    }
    this.evictIfNeeded();
  }

  hasDrawable(fileId: string): boolean {
    const entry = this.entries.get(fileId);
    if (!entry) return false;
    this.pruneBrokenMips(entry);
    return entry.mips.size > 0;
  }

  getNaturalSize(fileId: string): { width: number; height: number } | null {
    const entry = this.entries.get(fileId);
    if (!entry || !(entry.naturalWidth > 0 && entry.naturalHeight > 0)) return null;
    return { width: entry.naturalWidth, height: entry.naturalHeight };
  }

  /** Synchronously choose the best available mip tier and kick off background promotion if needed. */
  getBestDrawable(
    fileId: string,
    desiredTier: MipTier,
    onPromoted?: () => void,
  ): BestDrawableResult | null {
    const entry = this.entries.get(fileId);
    if (!entry) return null;

    this.pruneBrokenMips(entry);
    if (entry.mips.size === 0) return null;

    const effectiveDesired = this.resolveEffectiveTier(desiredTier, entry.naturalWidth, entry.naturalHeight);
    entry.lastDesiredTier = effectiveDesired;

    let chosenTier: MipTier | null = null;
    let chosenMip: MipEntry | null = null;
    let needsPromotion = false;

    const exact = entry.mips.get(effectiveDesired);
    if (exact) {
      chosenTier = effectiveDesired;
      chosenMip = exact;
    } else {
      const targetRank = tierRank(effectiveDesired);
      let bestLargerRank = Number.POSITIVE_INFINITY;
      let bestSmallerRank = -1;
      let largerTier: MipTier | null = null;
      let smallerTier: MipTier | null = null;

      for (const [tier] of entry.mips) {
        const rank = tierRank(tier);
        if (rank > targetRank) {
          if (rank < bestLargerRank || (rank === Number.POSITIVE_INFINITY && largerTier === null)) {
            bestLargerRank = rank;
            largerTier = tier;
          }
        } else if (rank < targetRank && rank > bestSmallerRank) {
          bestSmallerRank = rank;
          smallerTier = tier;
        }
      }

      if (largerTier !== null) {
        chosenTier = largerTier;
        chosenMip = entry.mips.get(largerTier)!;
        needsPromotion = false;
      } else if (smallerTier !== null) {
        chosenTier = smallerTier;
        chosenMip = entry.mips.get(smallerTier)!;
        needsPromotion = true;
      } else if (entry.mips.has('original')) {
        chosenTier = 'original';
        chosenMip = entry.mips.get('original')!;
        needsPromotion = false;
      }
    }

    if (!chosenMip || chosenTier === null) return null;

    const stamp = this.nextAccess();
    chosenMip.lastAccess = stamp;
    entry.lastAccess = stamp;

    if (needsPromotion) {
      const promoKey = `${fileId}:${effectiveDesired}`;
      if (onPromoted) {
        let callbacks = this.promotionCallbacks.get(promoKey);
        if (!callbacks) {
          callbacks = new Set();
          this.promotionCallbacks.set(promoKey, callbacks);
        }
        callbacks.add(onPromoted);
      }
      void this.preload(fileId, effectiveDesired, 'visible');
    }

    return {
      drawable: chosenMip.drawable,
      width: chosenMip.width,
      height: chosenMip.height,
      tier: chosenTier,
      needsPromotion,
    };
  }

  private firePromotionCallbacks(fileId: string, tier: MipTier): void {
    const key = `${fileId}:${tier}`;
    const callbacks = this.promotionCallbacks.get(key);
    if (!callbacks || callbacks.size === 0) return;
    this.promotionCallbacks.delete(key);
    for (const cb of callbacks) {
      try {
        cb();
      } catch (err) {
        console.error('[ImageAssetCache] onPromoted callback failed:', err);
      }
    }
  }

  private runWithConcurrency<T>(key: string, priority: ImageLoadPriority, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = () => {
        this.activeJobs++;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.activeJobs = Math.max(0, this.activeJobs - 1);
            this.pumpQueue();
          });
      };

      if (this.activeJobs < this.maxConcurrent) {
        execute();
        return;
      }

      this.queue.push({ key, priority, run: execute });
    });
  }

  private upgradeQueuedPriority(key: string, priority: ImageLoadPriority): void {
    if (priority !== 'visible') return;
    for (const item of this.queue) {
      if (item.key === key) {
        item.priority = 'visible';
      }
    }
  }

  private pumpQueue(): void {
    while (this.activeJobs < this.maxConcurrent && this.queue.length > 0) {
      let index = this.queue.findIndex(item => item.priority === 'visible');
      if (index === -1) index = 0;
      const [next] = this.queue.splice(index, 1);
      next.run();
    }
  }

  private ensureEntryBlob(fileId: string, version: number): Promise<CacheEntry | null> {
    const existing = this.entries.get(fileId);
    if (existing?.blob) {
      return Promise.resolve(existing);
    }

    const activeFetch = this.fetchPromises.get(fileId);
    if (activeFetch) return activeFetch;

    const promise = (async () => {
      this.fetchCount += 1;
      const record = await this.loader(fileId);
      if (this.fileVersion(fileId) !== version || !record) return null;
      const blob = toBlob(record);
      if (!blob) return null;
      const entry = this.getOrCreateEntry(fileId);
      entry.blob = blob;
      entry.mimeType = record.mimeType || blob.type || entry.mimeType;
      entry.lastAccess = this.nextAccess();
      return entry;
    })().finally(() => {
      if (this.fetchPromises.get(fileId) === promise) {
        this.fetchPromises.delete(fileId);
      }
    });

    this.fetchPromises.set(fileId, promise);
    return promise;
  }

  private async acquireOriginalProbe(
    fileId: string,
    entry: CacheEntry,
    version: number,
  ): Promise<{ bitmap: ImageBitmap; release: (kept: boolean) => void } | null> {
    if (!entry.blob || typeof createImageBitmap !== 'function') return null;

    let probePromise = this.inFlightProbes.get(fileId);
    if (!probePromise) {
      const blob = entry.blob;
      probePromise = (async () => {
        try {
          const bitmap = await createImageBitmap(blob);
          if (this.fileVersion(fileId) !== version || !isDrawableUsable(bitmap)) {
            try { bitmap.close(); } catch { /* ignore */ }
            return null;
          }
          if (bitmap.width > entry.naturalWidth) entry.naturalWidth = bitmap.width;
          if (bitmap.height > entry.naturalHeight) entry.naturalHeight = bitmap.height;
          return { bitmap, refs: 0 };
        } catch {
          return null;
        }
      })().finally(() => {
        if (this.inFlightProbes.get(fileId) === probePromise) {
          this.inFlightProbes.delete(fileId);
        }
      });
      this.inFlightProbes.set(fileId, probePromise);
    }

    const holder = await probePromise;
    if (!holder) return null;
    holder.refs += 1;
    let released = false;
    return {
      bitmap: holder.bitmap,
      release: (kept: boolean) => {
        if (released) return;
        released = true;
        holder.refs = Math.max(0, holder.refs - 1);
        if (holder.refs === 0 && !kept) {
          const currentEntry = this.entries.get(fileId);
          const stored = currentEntry?.mips.get('original');
          if (stored?.drawable !== holder.bitmap && !this.ownedBitmaps.has(holder.bitmap)) {
            try { holder.bitmap.close(); } catch { /* ignore */ }
          }
        }
      },
    };
  }

  private decodeTierFromBlob(
    fileId: string,
    entry: CacheEntry,
    effectiveTier: MipTier,
    version: number,
    preDecodedOriginal?: ImageBitmap,
  ): Promise<CanvasImageSource | null> {
    const existingMip = entry.mips.get(effectiveTier);
    if (existingMip && isDrawableUsable(existingMip.drawable)) {
      existingMip.lastAccess = this.nextAccess();
      entry.lastAccess = existingMip.lastAccess;
      return Promise.resolve(existingMip.drawable);
    }

    const decodeKey = `${fileId}:${effectiveTier}`;
    const inFlight = this.inFlightDecodes.get(decodeKey);
    if (inFlight) return inFlight;

    const promise = (async (): Promise<CanvasImageSource | null> => {
      if (!entry.blob || this.fileVersion(fileId) !== version) return null;
      const blob = entry.blob;
      let drawable: CanvasImageSource | null = null;

      if (typeof createImageBitmap === 'function') {
        try {
          if (effectiveTier === 'original') {
            drawable = preDecodedOriginal ?? await createImageBitmap(blob);
          } else {
            const natMax = Math.max(entry.naturalWidth, entry.naturalHeight);
            const scale = natMax > 0 ? effectiveTier / natMax : 1;
            const resizeWidth = Math.max(1, Math.min(entry.naturalWidth || effectiveTier, Math.round((entry.naturalWidth || effectiveTier) * scale)));
            const resizeHeight = Math.max(1, Math.min(entry.naturalHeight || effectiveTier, Math.round((entry.naturalHeight || effectiveTier) * scale)));
            drawable = await createImageBitmap(blob, {
              resizeWidth,
              resizeHeight,
              resizeQuality: 'high',
            });
          }
        } catch {
          // Fallback for formats (such as SVG in Chromium) where createImageBitmap rejects
          drawable = null;
        }
      }

      if (!drawable && typeof Image !== 'undefined' && typeof URL?.createObjectURL === 'function') {
        drawable = await decodeViaHtmlImage(blob).catch(() => null);
        if (drawable && this.fileVersion(fileId) === version && isDrawableUsable(drawable)) {
          const fallbackSize = getDrawableSize(drawable);
          if (fallbackSize.width > entry.naturalWidth) entry.naturalWidth = fallbackSize.width;
          if (fallbackSize.height > entry.naturalHeight) entry.naturalHeight = fallbackSize.height;
          this.setMip(entry, 'original', drawable, false);
          this.evictIfNeeded();
          this.firePromotionCallbacks(fileId, 'original');
          if (effectiveTier !== 'original') this.firePromotionCallbacks(fileId, effectiveTier);
          return drawable;
        }
      }

      const rawDrawable: unknown = drawable;
      if (!drawable || !isDrawableUsable(drawable)) {
        if (isImageBitmapLike(rawDrawable) && rawDrawable !== preDecodedOriginal) {
          try { rawDrawable.close(); } catch { /* ignore */ }
        }
        return null;
      }

      if (this.fileVersion(fileId) !== version) {
        if (isImageBitmapLike(drawable)) {
          try { drawable.close(); } catch { /* ignore */ }
        }
        return null;
      }

      this.setMip(entry, effectiveTier, drawable, isImageBitmapLike(drawable));
      this.evictIfNeeded();
      this.firePromotionCallbacks(fileId, effectiveTier);
      return drawable;
    })().finally(() => {
      if (this.inFlightDecodes.get(decodeKey) === promise) {
        this.inFlightDecodes.delete(decodeKey);
      }
    });

    this.inFlightDecodes.set(decodeKey, promise);
    return promise;
  }

  /** Fetch (if needed) and decode the requested mip tier with concurrency bounds and deduplication. */
  preload(
    fileId: string,
    desiredTier: MipTier = 512,
    priority: ImageLoadPriority = 'visible',
  ): Promise<CanvasImageSource | null> {
    if (!fileId) return Promise.resolve(null);

    const existingEntry = this.entries.get(fileId);
    if (existingEntry) {
      this.pruneBrokenMips(existingEntry);
      const effectiveCached = this.resolveEffectiveTier(
        desiredTier,
        existingEntry.naturalWidth,
        existingEntry.naturalHeight,
      );
      const cachedMip = existingEntry.mips.get(effectiveCached) ?? existingEntry.mips.get('original');
      if (cachedMip) {
        cachedMip.lastAccess = this.nextAccess();
        existingEntry.lastAccess = cachedMip.lastAccess;
        return Promise.resolve(cachedMip.drawable);
      }
    }

    const requestKey = `${fileId}:${desiredTier}`;
    const existingPreload = this.inFlightPreloads.get(requestKey);
    if (existingPreload) {
      this.upgradeQueuedPriority(requestKey, priority);
      return existingPreload;
    }

    const startVersion = this.fileVersion(fileId);
    const promise = this.runWithConcurrency(requestKey, priority, async (): Promise<CanvasImageSource | null> => {
      try {
        if (this.fileVersion(fileId) !== startVersion) return null;
        const entry = await this.ensureEntryBlob(fileId, startVersion);
        if (!entry || !entry.blob || this.fileVersion(fileId) !== startVersion) return null;

        if (!(entry.naturalWidth > 0 && entry.naturalHeight > 0)) {
          const headerDims = await probeBlobHeaderDimensions(entry.blob);
          if (headerDims && this.fileVersion(fileId) === startVersion) {
            entry.naturalWidth = headerDims.width;
            entry.naturalHeight = headerDims.height;
          }
        }

        if (!(entry.naturalWidth > 0 && entry.naturalHeight > 0) && typeof createImageBitmap === 'function') {
          const probe = await this.acquireOriginalProbe(fileId, entry, startVersion);
          if (probe) {
            const effectiveTier = this.resolveEffectiveTier(desiredTier, entry.naturalWidth, entry.naturalHeight);
            let keptOriginal = false;
            try {
              if (effectiveTier === 'original') {
                const stored = entry.mips.get('original');
                if (stored && isDrawableUsable(stored.drawable)) {
                  keptOriginal = stored.drawable === probe.bitmap;
                  stored.lastAccess = this.nextAccess();
                  entry.lastAccess = stored.lastAccess;
                  this.firePromotionCallbacks(fileId, desiredTier);
                  return stored.drawable;
                }
                const decoded = await this.decodeTierFromBlob(fileId, entry, 'original', startVersion, probe.bitmap);
                keptOriginal = decoded === probe.bitmap;
                if (desiredTier !== 'original') this.firePromotionCallbacks(fileId, desiredTier);
                return decoded;
              }
              const decoded = await this.decodeTierFromBlob(fileId, entry, effectiveTier, startVersion);
              return decoded;
            } finally {
              probe.release(keptOriginal);
            }
          }
        }

        const effectiveTier = this.resolveEffectiveTier(desiredTier, entry.naturalWidth, entry.naturalHeight);
        const decoded = await this.decodeTierFromBlob(fileId, entry, effectiveTier, startVersion);
        if (decoded && desiredTier !== effectiveTier) {
          this.firePromotionCallbacks(fileId, desiredTier);
        } else if (!decoded) {
          this.promotionCallbacks.delete(requestKey);
        }
        return decoded;
      } catch (err) {
        this.promotionCallbacks.delete(requestKey);
        console.error('[ImageAssetCache] preload failed:', err);
        return null;
      }
    }).finally(() => {
      if (this.inFlightPreloads.get(requestKey) === promise) {
        this.inFlightPreloads.delete(requestKey);
      }
    });

    this.inFlightPreloads.set(requestKey, promise);
    return promise;
  }

  /** Ensure the full-resolution `'original'` tier is decoded and cached. */
  ensureOriginalLoaded(fileId: string): Promise<CanvasImageSource | null> {
    return this.preload(fileId, 'original', 'visible');
  }

  /** Seed an externally decoded drawable (HTMLImageElement or ImageBitmap); never closed by LRU eviction. */
  seedExternalDrawable(fileId: string, drawable: CanvasImageSource, mimeType?: string): void {
    if (!fileId || !isDrawableUsable(drawable)) return;
    const entry = this.getOrCreateEntry(fileId);
    if (mimeType && !entry.mimeType) entry.mimeType = mimeType;
    this.setMip(entry, 'original', drawable, false);
    this.evictIfNeeded();
  }

  /** Explicitly remove an asset (e.g. deleted from repository) and close any cache-owned bitmaps. */
  evictFile(fileId: string): void {
    this.fileVersions.set(fileId, this.fileVersion(fileId) + 1);
    for (const key of [...this.promotionCallbacks.keys()]) {
      if (key.startsWith(`${fileId}:`)) this.promotionCallbacks.delete(key);
    }
    const entry = this.entries.get(fileId);
    if (!entry) return;
    this.entries.delete(fileId);
    for (const tier of [...entry.mips.keys()]) {
      this.deleteMip(entry, tier);
    }
    entry.blob = undefined;
  }

  private evictIfNeeded(): void {
    if (this.totalBytes <= this.maxBytes) return;

    // Pass 1: evict completely unpinned entries in LRU order
    const unpinned = [...this.entries.entries()]
      .filter(([, entry]) => entry.pins.size === 0)
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

    for (const [fileId, entry] of unpinned) {
      if (this.totalBytes <= this.maxBytes) break;
      this.entries.delete(fileId);
      for (const tier of [...entry.mips.keys()]) {
        this.deleteMip(entry, tier);
      }
      entry.blob = undefined;
    }

    if (this.totalBytes <= this.maxBytes) return;

    // Pass 2: strictly over budget with pinned entries — trim surplus unused mip tiers
    // while keeping at least the highest/currently needed tier per pinned entry.
    const surplus: Array<{ entry: CacheEntry; tier: MipTier; lastAccess: number }> = [];
    for (const entry of this.entries.values()) {
      if (entry.mips.size <= 1) continue;
      let preservedTier: MipTier | null = null;
      if (entry.lastDesiredTier !== undefined && entry.mips.has(entry.lastDesiredTier)) {
        preservedTier = entry.lastDesiredTier;
      } else {
        let highestRank = -1;
        for (const tier of entry.mips.keys()) {
          const rank = tierRank(tier);
          if (rank > highestRank) {
            highestRank = rank;
            preservedTier = tier;
          }
        }
      }
      for (const [tier, mip] of entry.mips) {
        if (tier !== preservedTier) {
          surplus.push({ entry, tier, lastAccess: mip.lastAccess });
        }
      }
    }

    surplus.sort((a, b) => a.lastAccess - b.lastAccess);
    for (const item of surplus) {
      if (this.totalBytes <= this.maxBytes) break;
      if (item.entry.mips.size <= 1) continue;
      this.deleteMip(item.entry, item.tier);
    }
  }

  getStats(): ImageAssetCacheStats {
    let pinnedCount = 0;
    for (const entry of this.entries.values()) {
      if (entry.pins.size > 0) pinnedCount++;
    }
    return {
      totalBytes: this.totalBytes,
      entryCount: this.entries.size,
      fetchCount: this.fetchCount,
      inFlightCount: this.inFlightPreloads.size,
      budgetBytes: this.maxBytes,
      pinnedCount,
    };
  }
}

export const imageAssetCache = new ImageAssetCache();
