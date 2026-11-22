import assert from 'node:assert/strict';
import test from 'node:test';
import { ImageAssetCache, selectMipTier } from '../src/components/notebook/engine/ImageAssetCache.ts';
import { ImageManager } from '../src/components/notebook/engine/ImageManager.ts';
import { ViewportManager } from '../src/components/notebook/engine/ViewportManager.ts';
import type { ImageObject } from '../src/components/notebook/engine/drawingTypes.ts';

interface MockBitmap {
  width: number;
  height: number;
  closed: boolean;
  closeCalls: number;
  close(): void;
}

function makeMockBitmap(width: number, height: number): MockBitmap {
  return {
    width,
    height,
    closed: false,
    closeCalls: 0,
    close() {
      this.closed = true;
      this.closeCalls += 1;
      this.width = 0;
      this.height = 0;
    },
  };
}

function makeSyntheticRecord(byte = 1) {
  return {
    mimeType: 'image/png',
    data: new Uint8Array([byte, 2, 3, 4]).buffer,
  };
}

async function withMockCreateImageBitmap<T>(
  impl: (blob: Blob, opts?: ImageBitmapOptions) => Promise<MockBitmap>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = (globalThis as any).createImageBitmap;
  (globalThis as any).createImageBitmap = impl;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete (globalThis as any).createImageBitmap;
    else (globalThis as any).createImageBitmap = prev;
  }
}

test('selectMipTier scales across 100%, 400%, 800% zoom and tight normalized crops', () => {
  const fullCrop = { x: 0, y: 0, width: 1, height: 1 };

  // 100% zoom on a 100x80 image -> demand 100 -> tier 128
  assert.equal(selectMipTier(100, 80, fullCrop, 2000, 1600), 128);

  // 400% zoom on a 100x80 image (400x320 px) -> demand 400 -> tier 512
  assert.equal(selectMipTier(400, 320, fullCrop, 2000, 1600), 512);

  // 800% zoom on a 200x160 image (1600x1280 px) -> demand 1600 -> tier 2048
  assert.equal(selectMipTier(1600, 1280, fullCrop, 4000, 3200), 2048);

  // Exceeding natural image size returns 'original'
  assert.equal(selectMipTier(1600, 1280, fullCrop, 1200, 960), 'original');

  // Tight normalized crop (crop.width = 0.1) at 100% zoom (150x100 px) -> demand 1500 -> tier 2048
  assert.equal(selectMipTier(150, 100, { x: 0.2, y: 0.2, width: 0.1, height: 0.1 }, 4000, 4000), 2048);

  // Very high demand (>2048) returns 'original'
  assert.equal(selectMipTier(300, 300, { x: 0, y: 0, width: 0.1, height: 0.1 }, 5000, 5000), 'original');
});

test('in-flight Promise deduplication invokes loader once across 5 concurrent callers and tier aliases', async () => {
  let loaderCalls = 0;
  let bitmapCreates = 0;
  const created: MockBitmap[] = [];

  await withMockCreateImageBitmap(async (_blob, opts) => {
    bitmapCreates += 1;
    await new Promise(r => setTimeout(r, 15));
    const w = opts?.resizeWidth ?? 512;
    const h = opts?.resizeHeight ?? 512;
    const bmp = makeMockBitmap(w, h);
    created.push(bmp);
    return bmp;
  }, async () => {
    const cache = new ImageAssetCache({
      maxBytes: 16 * 1024 * 1024,
      loader: async () => {
        loaderCalls += 1;
        await new Promise(r => setTimeout(r, 15));
        return makeSyntheticRecord();
      },
    });

    // 5 concurrent callers requesting tier 512 + 1 concurrent caller requesting 'original'
    // on a 512x512 image (where 512 aliases 'original')
    const results = await Promise.all([
      cache.preload('dedup-img', 512, 'visible'),
      cache.preload('dedup-img', 512, 'visible'),
      cache.preload('dedup-img', 512, 'prefetch'),
      cache.preload('dedup-img', 512, 'visible'),
      cache.preload('dedup-img', 512, 'visible'),
      cache.preload('dedup-img', 'original', 'visible'),
    ]);

    assert.equal(loaderCalls, 1);
    assert.equal(cache.getStats().fetchCount, 1);
    assert.equal(bitmapCreates, 1);
    assert.equal(cache.getStats().inFlightCount, 0);
    for (const item of results) {
      assert.equal(item, created[0]);
    }
    // Single 'original' entry stored without duplicate 512 bytes
    assert.equal(cache.getStats().totalBytes, 512 * 512 * 4);
  });
});

test('LRU byte-budget eviction, pin ref-counting, safe .close(), and external drawable preservation', async () => {
  const createdByFile = new Map<string, MockBitmap[]>();

  await withMockCreateImageBitmap(async (blob, opts) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const key = `img-${bytes[0]}`;
    const w = opts?.resizeWidth ?? 256;
    const h = opts?.resizeHeight ?? 256;
    const bmp = makeMockBitmap(w, h);
    const list = createdByFile.get(key) ?? [];
    list.push(bmp);
    createdByFile.set(key, list);
    return bmp;
  }, async () => {
    // Budget fits exactly 2 x 256x256 RGBA bitmaps (256 * 256 * 4 * 2 = 524,288 bytes)
    const oneBitmapBytes = 256 * 256 * 4;
    const cache = new ImageAssetCache({
      maxBytes: oneBitmapBytes * 2,
      loader: async fileId => makeSyntheticRecord(Number(fileId.split('-')[1])),
    });

    await cache.preload('img-1', 'original');
    await cache.preload('img-2', 'original');
    assert.equal(cache.getStats().totalBytes, oneBitmapBytes * 2);

    // Pin img-1 in two overlapping scopes and touch img-2? No, pin img-1 ONLY so img-2 is LRU unpinned
    cache.pin('scope-a', ['img-1']);
    cache.pin('scope-b', ['img-1']);
    assert.equal(cache.getStats().pinnedCount, 1);

    // Loading img-3 pushes total over 2-bitmap budget -> must evict unpinned img-2, NOT pinned img-1!
    await cache.preload('img-3', 'original');
    assert.ok(cache.getBestDrawable('img-1', 'original') !== null, 'pinned img-1 stays cached');
    assert.equal(cache.getBestDrawable('img-2', 'original'), null, 'unpinned img-2 evicted');
    assert.equal(createdByFile.get('img-2')![0].closed, true, 'evicted unpinned bitmap was closed');
    assert.equal(createdByFile.get('img-1')![0].closed, false, 'pinned bitmap must never be closed');

    // Unpinning scope-a alone keeps img-1 pinned by scope-b
    cache.unpin('scope-a');
    assert.equal(cache.getStats().pinnedCount, 1);
    assert.equal(createdByFile.get('img-1')![0].closed, false);

    // Seed an external bitmap; img-3 (unpinned) is evicted first while img-1 remains pinned
    const externalBmp = makeMockBitmap(256, 256);
    cache.seedExternalDrawable('ext-1', externalBmp as unknown as ImageBitmap);
    assert.equal(createdByFile.get('img-3')![0].closed, true, 'unpinned img-3 evicted before pinned img-1');
    assert.equal(createdByFile.get('img-1')![0].closed, false, 'pinned img-1 still preserved');

    // Unpin scope-b -> img-1 is now eligible for LRU eviction once new demand arrives
    cache.unpin('scope-b');
    await cache.preload('img-4', 'original');
    assert.equal(createdByFile.get('img-1')![0].closed, true, 'img-1 closed once unpinned and evicted');

    // Now force ext-1 eviction by loading img-5
    await cache.preload('img-5', 'original');
    assert.equal(cache.getBestDrawable('ext-1', 'original'), null);
    assert.equal(externalBmp.closed, false, 'external seeded drawable is NEVER closed');
    assert.equal(externalBmp.closeCalls, 0);
  });
});

test('non-blank mip promotion serves lower tier immediately with needsPromotion=true and upgrades async', async () => {
  const created: Record<number, MockBitmap> = {};
  let fetchCount = 0;

  await withMockCreateImageBitmap(async (_blob, opts) => {
    const dim = opts?.resizeWidth ?? 2048;
    await new Promise(r => setTimeout(r, 10));
    const bmp = makeMockBitmap(dim, dim);
    created[dim] = bmp;
    return bmp;
  }, async () => {
    const cache = new ImageAssetCache({
      maxBytes: 32 * 1024 * 1024,
      loader: async () => {
        fetchCount += 1;
        return makeSyntheticRecord(7);
      },
    });

    await cache.preload('promo-1', 128);
    assert.equal(fetchCount, 1);
    assert.ok(created[128]);

    let promotedCalls = 0;
    let resolvePromoted!: () => void;
    const promotedDone = new Promise<void>(resolve => {
      resolvePromoted = resolve;
    });

    const immediate = cache.getBestDrawable('promo-1', 1024, () => {
      promotedCalls += 1;
      resolvePromoted();
    });

    // Synchronously returns 128 mip with needsPromotion = true (no blank frame)
    assert.ok(immediate);
    assert.equal(immediate.tier, 128);
    assert.equal(immediate.drawable, created[128]);
    assert.equal(immediate.needsPromotion, true);

    // Subsequent calls before decode finishes keep returning 128 and coalesce promotion
    const secondSync = cache.getBestDrawable('promo-1', 1024, () => {
      promotedCalls += 1;
    });
    assert.equal(secondSync?.tier, 128);
    assert.equal(secondSync?.needsPromotion, true);

    await promotedDone;
    assert.equal(promotedCalls, 2);
    // Blob cached in entry -> zero extra repository fetch for promotion
    assert.equal(fetchCount, 1);

    const upgraded = cache.getBestDrawable('promo-1', 1024);
    assert.ok(upgraded);
    assert.equal(upgraded.tier, 1024);
    assert.equal(upgraded.drawable, created[1024]);
    assert.equal(upgraded.needsPromotion, false);
  });
});

test('bitmap.width === 0 safety guard skips closed bitmaps in ImageAssetCache and ImageManager.renderImage', async () => {
  const cache = new ImageAssetCache({ maxBytes: 1024 * 1024 });
  const closedBmp = makeMockBitmap(256, 256);
  cache.seedExternalDrawable('closed-id', closedBmp as unknown as ImageBitmap);
  assert.ok(cache.getBestDrawable('closed-id', 256));

  // Simulate external close zeroing bitmap dimensions
  closedBmp.close();
  assert.equal(closedBmp.width, 0);
  assert.equal(cache.getBestDrawable('closed-id', 256), null, 'closed bitmap must never be returned');

  // Verify ImageManager.renderImage clamps mip crops and skips zero-sized bitmaps safely
  const viewport = new ViewportManager();
  const manager = new ImageManager(viewport);
  let drawImageCalls: Array<{ sx: number; sy: number; sw: number; sh: number }> = [];
  const ctx = {
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    drawImage(_img: unknown, sx: number, sy: number, sw: number, sh: number) {
      drawImageCalls.push({ sx, sy, sw, sh });
    },
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;

  const usableBmp = makeMockBitmap(256, 128);
  (manager as any).imageCache.set('cropped-file', usableBmp);

  const imgObj: ImageObject = {
    id: 'img-obj-1',
    type: 'image',
    fileId: 'cropped-file',
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    rotation: 0,
    createdAt: 1,
    crop: { x: 0.5, y: 0.25, width: 0.500001, height: 0.750001 },
  };
  manager.setImages([imgObj], { skipPreload: true });
  manager.renderImage(ctx, imgObj);

  assert.equal(drawImageCalls.length, 1);
  assert.ok(drawImageCalls[0].sx + drawImageCalls[0].sw <= 256, 'sx + sw clamped to bitmap width');
  assert.ok(drawImageCalls[0].sy + drawImageCalls[0].sh <= 128, 'sy + sh clamped to bitmap height');

  // Now close usableBmp externally -> renderImage must not invoke drawImage
  drawImageCalls = [];
  usableBmp.close();
  // Stub preload so the global singleton does not hit Vite-aliased CanvasRepository in Node
  const origPreload = (await import('../src/components/notebook/engine/ImageAssetCache.ts')).imageAssetCache.preload;
  const globalCache = (await import('../src/components/notebook/engine/ImageAssetCache.ts')).imageAssetCache;
  globalCache.preload = async () => null;
  try {
    manager.renderImage(ctx, imgObj);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(drawImageCalls.length, 0, 'closed bitmap skipped safely without drawImage');
  } finally {
    globalCache.preload = origPreload;
    globalCache.evictFile('cropped-file');
    globalCache.evictFile('closed-id');
    manager.destroy();
  }
});

test('bounded concurrency queue caps active jobs at 4 and prioritizes visible over prefetch', async () => {
  let active = 0;
  let maxObservedActive = 0;
  const order: string[] = [];
  let releaseFirstWave!: () => void;
  const firstWaveGate = new Promise<void>(resolve => {
    releaseFirstWave = resolve;
  });

  await withMockCreateImageBitmap(async (_blob, opts) => {
    return makeMockBitmap(opts?.resizeWidth ?? 128, opts?.resizeHeight ?? 128);
  }, async () => {
    const cache = new ImageAssetCache({
      maxBytes: 16 * 1024 * 1024,
      maxConcurrent: 4,
      loader: async fileId => {
        active += 1;
        maxObservedActive = Math.max(maxObservedActive, active);
        order.push(fileId);
        if (order.length <= 4) {
          await firstWaveGate;
        } else {
          await new Promise(r => setTimeout(r, 5));
        }
        active -= 1;
        return makeSyntheticRecord(1);
      },
    });

    const p1 = cache.preload('v1', 'original', 'visible');
    const p2 = cache.preload('v2', 'original', 'visible');
    const p3 = cache.preload('v3', 'original', 'visible');
    const p4 = cache.preload('v4', 'original', 'visible');
    const p5 = cache.preload('pref1', 'original', 'prefetch');
    const p6 = cache.preload('pref2', 'original', 'prefetch');
    const p7 = cache.preload('vis-urgent', 'original', 'visible');

    await new Promise(r => setTimeout(r, 20));
    assert.equal(maxObservedActive, 4, 'at most 4 concurrent jobs run');
    releaseFirstWave();
    await Promise.all([p1, p2, p3, p4, p5, p6, p7]);

    assert.equal(maxObservedActive, 4);
    assert.ok(order.indexOf('vis-urgent') < order.indexOf('pref1'), 'visible job jumps ahead of queued prefetch');
  });
});

test('pinned surplus mip eviction preserves needed tier and HTMLImageElement fallback revokes blob URLs', async () => {
  await withMockCreateImageBitmap(async (_blob, opts) => {
    const dim = opts?.resizeWidth ?? 1024;
    return makeMockBitmap(dim, dim);
  }, async () => {
    // Budget 1.2 MB: holds 1024x1024 (4 MB) or 512x512 (1 MB) — surplus 128 mip should be trimmed while 512/desired stays
    const cache = new ImageAssetCache({
      maxBytes: 1_200_000,
      loader: async () => makeSyntheticRecord(9),
    });

    cache.pin('pin-1', ['surplus']);
    await cache.preload('surplus', 128);
    await cache.preload('surplus', 512);
    // Demand tier 512 via getBestDrawable so 512 becomes lastDesiredTier
    const hit = cache.getBestDrawable('surplus', 512);
    assert.equal(hit?.tier, 512);
    // Total bytes (128^2*4 + 512^2*4 = 65536 + 1048576 = 1114112 <= 1200000).
    // Now request 256 -> exceeds 1200000? Wait: 1114112 + 262144 = 1376256 > 1200000.
    // Surplus 128 mip should be trimmed while 256/512 stay under 1.2MB? Wait: 256 + 512 = 1310720 > 1200000,
    // so both 128 and 512 get trimmed leaving lastDesiredTier (or remaining) pinned!
    await cache.preload('surplus', 256);
    const after = cache.getBestDrawable('surplus', 512);
    assert.ok(after !== null, 'pinned entry always retains at least one mip');
    assert.equal(after.tier, 512, 'lastDesiredTier is preserved');
  });

  // HTMLImageElement fallback when createImageBitmap is unavailable
  const prevCreateBitmap = (globalThis as any).createImageBitmap;
  const prevImage = (globalThis as any).Image;
  const prevCreateUrl = URL.createObjectURL;
  const prevRevokeUrl = URL.revokeObjectURL;
  const revoked: string[] = [];
  let seq = 0;

  delete (globalThis as any).createImageBitmap;
  URL.createObjectURL = () => `blob:test-${++seq}`;
  URL.revokeObjectURL = (u: string) => { revoked.push(u); };
  (globalThis as any).Image = class FakeImage {
    complete = false;
    naturalWidth = 0;
    naturalHeight = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_val: string) {
      queueMicrotask(() => {
        this.complete = true;
        this.naturalWidth = 320;
        this.naturalHeight = 240;
        this.onload?.();
      });
    }
  };

  try {
    const fallbackCache = new ImageAssetCache({
      maxBytes: 10 * 1024 * 1024,
      loader: async () => makeSyntheticRecord(3),
    });
    const img = await fallbackCache.preload('fallback-1', 256);
    assert.ok(img);
    assert.deepEqual(revoked, ['blob:test-1'], 'temporary blob URL revoked immediately after fallback decode');

    // ImageManager.cacheImage: data: URL must NOT revoke, blob: URL must revoke once
    const mgr = new ImageManager(new ViewportManager());
    mgr.setImages([], { skipPreload: true });
    mgr.cacheImage('data-img', { complete: true, naturalWidth: 16, naturalHeight: 16 } as any, 'data:image/png;base64,AAAA');
    assert.deepEqual(revoked, ['blob:test-1'], 'data: URL never passed to URL.revokeObjectURL');

    mgr.cacheImage('blob-img', { complete: true, naturalWidth: 16, naturalHeight: 16 } as any, 'blob:manual-1');
    mgr.cacheImage('blob-img', { complete: true, naturalWidth: 16, naturalHeight: 16 } as any, 'blob:manual-1');
    assert.deepEqual(revoked, ['blob:test-1', 'blob:manual-1'], 'blob: URL revoked at most once');

    mgr.destroy();
    const { imageAssetCache } = await import('../src/components/notebook/engine/ImageAssetCache.ts');
    imageAssetCache.evictFile('data-img');
    imageAssetCache.evictFile('blob-img');
  } finally {
    if (prevCreateBitmap === undefined) delete (globalThis as any).createImageBitmap;
    else (globalThis as any).createImageBitmap = prevCreateBitmap;
    if (prevImage === undefined) delete (globalThis as any).Image;
    else (globalThis as any).Image = prevImage;
    URL.createObjectURL = prevCreateUrl;
    URL.revokeObjectURL = prevRevokeUrl;
  }
});

test('PNG header dimension probe resizes directly without allocating original bitmap', async () => {
  const calls: Array<ImageBitmapOptions | undefined> = [];
  // Minimal 24-byte PNG signature + IHDR chunk declaring 2048x1024
  const pngHeader = new Uint8Array(24);
  pngHeader.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  pngHeader.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(pngHeader.buffer);
  view.setUint32(16, 2048, false);
  view.setUint32(20, 1024, false);

  await withMockCreateImageBitmap(async (_blob, opts) => {
    calls.push(opts);
    return makeMockBitmap(opts?.resizeWidth ?? 2048, opts?.resizeHeight ?? 1024);
  }, async () => {
    const cache = new ImageAssetCache({
      maxBytes: 16 * 1024 * 1024,
      loader: async () => ({ mimeType: 'image/png', data: pngHeader.buffer }),
    });
    const bmp = await cache.preload('png-big', 512);
    assert.ok(bmp);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { resizeWidth: 512, resizeHeight: 256, resizeQuality: 'high' });
  });
});

