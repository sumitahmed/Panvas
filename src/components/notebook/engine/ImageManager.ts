import { type ImageObject, DEFAULT_PAGE_LAYER_ID } from './drawingTypes.ts';
import type { EraseBounds } from './capsuleErase.ts';
import { isEmptyBounds, objectIntersectsBounds } from './strokeSpatialIndex.ts';
import { ViewportManager } from './ViewportManager.ts';
import { LayerManager } from './LayerManager.ts';
import { getImageRenderAppearance, getImageCrop } from './imageAppearance.ts';
import { gate0Profiler } from '../../../dev/gate0Profiler.ts';
import { imageAssetCache, selectMipTier } from './ImageAssetCache.ts';

const INITIAL_PRELOAD_TIER = 1024 as const;
const gate0ImageRequests = new Map<string, number>();
let nextImageManagerScopeId = 0;

class ImageCacheCompatibilityMap extends Map<string, CanvasImageSource> {
  private readonly getOwnedImages: () => ImageObject[];

  constructor(getOwnedImages: () => ImageObject[]) {
    super();
    this.getOwnedImages = getOwnedImages;
  }

  override set(fileId: string, drawable: CanvasImageSource): this {
    super.set(fileId, drawable);
    imageAssetCache.seedExternalDrawable(fileId, drawable);
    return this;
  }

  override get(fileId: string): CanvasImageSource | undefined {
    return imageAssetCache.getBestDrawable(fileId, 'original')?.drawable ?? super.get(fileId);
  }

  override has(fileId: string): boolean {
    return imageAssetCache.hasDrawable(fileId) || super.has(fileId);
  }

  override keys(): MapIterator<string> {
    const seen = new Set<string>();
    for (const img of this.getOwnedImages()) {
      if (img.fileId && !seen.has(img.fileId) && (imageAssetCache.hasDrawable(img.fileId) || super.has(img.fileId))) {
        seen.add(img.fileId);
      }
    }
    for (const key of super.keys()) {
      if (!seen.has(key) && (imageAssetCache.hasDrawable(key) || super.has(key))) {
        seen.add(key);
      }
    }
    return seen.values();
  }
}

export class ImageManager {
  private readonly scopeId = `imgmgr-${++nextImageManagerScopeId}`;
  private images: ImageObject[] = [];
  private imageCache: Map<string, CanvasImageSource>;
  private objectUrls: Map<string, string> = new Map();
  private revokedBlobUrls = new Set<string>();
  private countedDecodedIds = new Set<string>();
  private viewport: ViewportManager;
  private redrawCallback?: () => void;
  private layerManager: LayerManager;
  private pending = new Set<string>();
  private generation = 0;
  private decodedListeners = new Set<() => void>();
  private decodedRedrawPending = false;
  private pendingUpgrades = new Set<string>();
  private upgradeRedrawPending = false;
  private upgradeMicrotaskScheduled = false;
  private upgradeFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(viewport: ViewportManager = new ViewportManager(), layerManager: LayerManager = new LayerManager()) {
    this.viewport = viewport;
    this.layerManager = layerManager;
    this.imageCache = new ImageCacheCompatibilityMap(() => this.images);
  }

  onDecodedImage(listener: () => void): () => void {
    this.decodedListeners.add(listener);
    return () => { this.decodedListeners.delete(listener); };
  }

  private markDecodedCounted(fileId: string): void {
    if (!fileId || this.countedDecodedIds.has(fileId)) return;
    this.countedDecodedIds.add(fileId);
    gate0Profiler.resource('decodedImages', 1);
  }

  private unmarkDecodedCounted(fileId: string): void {
    if (!this.countedDecodedIds.delete(fileId)) return;
    gate0Profiler.resource('decodedImages', -1);
  }

  private safeRevokeBlobUrl(url?: string): void {
    if (!url || !url.startsWith('blob:') || this.revokedBlobUrls.has(url)) return;
    if (typeof URL?.revokeObjectURL !== 'function') return;
    this.revokedBlobUrls.add(url);
    try {
      URL.revokeObjectURL(url);
      gate0Profiler.event('image-object-url-revoked');
    } catch {
      /* ignore invalid/already-revoked object URL */
    }
  }

  adoptDecodedImages(source: ImageManager, fileIds = this.images.map(image => image.fileId)): void {
    const pinSet = new Set<string>();
    for (const image of this.images) {
      if (image.fileId) pinSet.add(image.fileId);
    }
    for (const id of fileIds) {
      if (!id) continue;
      pinSet.add(id);
      if (!imageAssetCache.hasDrawable(id)) {
        const legacy = source.imageCache.get(id);
        if (legacy) imageAssetCache.seedExternalDrawable(id, legacy);
      }
      if (imageAssetCache.hasDrawable(id)) {
        this.markDecodedCounted(id);
      }
    }
    imageAssetCache.pin(this.scopeId, pinSet);
  }

  setRedrawCallback(cb: () => void) {
    this.redrawCallback = cb;
  }

  getImages(): ImageObject[] {
    return this.images;
  }

  getImage(id: string): ImageObject | undefined {
    return this.images.find(image => image.id === id);
  }

  private prunePendingUpgrades(retained: Set<string>): void {
    for (const key of this.pendingUpgrades) {
      const splitIndex = key.lastIndexOf(':');
      const keyFileId = splitIndex === -1 ? key : key.slice(0, splitIndex);
      if (!retained.has(keyFileId)) {
        this.pendingUpgrades.delete(key);
      }
    }
    if (this.pendingUpgrades.size === 0 && !this.upgradeRedrawPending && this.upgradeFallbackTimer) {
      clearTimeout(this.upgradeFallbackTimer);
      this.upgradeFallbackTimer = null;
    }
  }

  setImages(images: ImageObject[], options?: { skipPreload?: boolean }): void {
    this.images = images;
    const retained = new Set(images.map(image => image.fileId).filter(Boolean));
    imageAssetCache.pin(this.scopeId, retained);
    this.prunePendingUpgrades(retained);

    for (const id of [...this.countedDecodedIds]) {
      if (!retained.has(id)) {
        this.unmarkDecodedCounted(id);
      }
    }
    for (const [id, url] of this.objectUrls) {
      if (retained.has(id)) continue;
      this.safeRevokeBlobUrl(url);
      this.objectUrls.delete(id);
      gate0Profiler.resource('objectUrls', -1);
    }

    if (options?.skipPreload) return;

    for (const img of images) {
      this.preloadImage(img.fileId);
    }
  }

  addImage(image: ImageObject): void {
    image.layerId ??= this.layerManager.getActiveLayerId();
    this.images.push(image);
    imageAssetCache.pin(this.scopeId, this.images.map(item => item.fileId));
    this.preloadImage(image.fileId);
  }

  removeImage(id: string): ImageObject | undefined {
    const index = this.images.findIndex(i => i.id === id);
    if (index === -1) return undefined;
    const [removed] = this.images.splice(index, 1);
    const retained = new Set(this.images.map(item => item.fileId).filter(Boolean));
    imageAssetCache.pin(this.scopeId, retained);
    this.prunePendingUpgrades(retained);
    return removed;
  }

  removeImages(ids: Set<string>): ImageObject[] {
    const removed: ImageObject[] = [];
    this.images = this.images.filter(i => {
      if (ids.has(i.id)) {
        removed.push(i);
        return false;
      }
      return true;
    });
    if (removed.length > 0) {
      const retained = new Set(this.images.map(item => item.fileId).filter(Boolean));
      imageAssetCache.pin(this.scopeId, retained);
      this.prunePendingUpgrades(retained);
    }
    return removed;
  }

  cacheImage(fileId: string, img: HTMLImageElement, objectUrl?: string): void {
    if (!fileId || !img) return;
    const finalize = () => {
      imageAssetCache.seedExternalDrawable(fileId, img);
      this.markDecodedCounted(fileId);
      if (objectUrl && objectUrl.startsWith('blob:')) {
        if (typeof img.decode === 'function') {
          void img.decode().catch(() => undefined).finally(() => this.safeRevokeBlobUrl(objectUrl));
        } else {
          this.safeRevokeBlobUrl(objectUrl);
        }
      }
    };

    const isReady = 'complete' in img
      ? Boolean(img.complete && (img.naturalWidth > 0 || ((img as { width?: number }).width ?? 0) > 0))
      : Boolean((img as { naturalWidth?: number }).naturalWidth || (img as { width?: number }).width);

    if (isReady) {
      finalize();
      return;
    }

    if (typeof img.addEventListener === 'function') {
      img.addEventListener('load', finalize, { once: true });
      img.addEventListener('error', () => this.safeRevokeBlobUrl(objectUrl), { once: true });
    }
  }

  clearImages(): ImageObject[] {
    const removed = [...this.images];
    this.setImages([]);
    return removed;
  }

  private clearUpgradeState(): void {
    this.pendingUpgrades.clear();
    this.upgradeRedrawPending = false;
    this.upgradeMicrotaskScheduled = false;
    if (this.upgradeFallbackTimer) {
      clearTimeout(this.upgradeFallbackTimer);
      this.upgradeFallbackTimer = null;
    }
  }

  private flushUpgradeRedraw(expectedGeneration: number): void {
    if (this.upgradeFallbackTimer) {
      clearTimeout(this.upgradeFallbackTimer);
      this.upgradeFallbackTimer = null;
    }
    if (expectedGeneration !== this.generation || !this.upgradeRedrawPending) {
      this.upgradeRedrawPending = false;
      return;
    }
    this.upgradeRedrawPending = false;
    this.redrawCallback?.();
  }

  private onUpgradePromoted(upgradeKey: string, fileId: string): void {
    this.pendingUpgrades.delete(upgradeKey);
    if (!this.images.some(image => image.fileId === fileId)) {
      if (this.pendingUpgrades.size === 0 && !this.upgradeRedrawPending && this.upgradeFallbackTimer) {
        clearTimeout(this.upgradeFallbackTimer);
        this.upgradeFallbackTimer = null;
      }
      return;
    }
    this.upgradeRedrawPending = true;
    const generation = this.generation;
    if (this.pendingUpgrades.size === 0) {
      if (this.upgradeFallbackTimer) {
        clearTimeout(this.upgradeFallbackTimer);
        this.upgradeFallbackTimer = null;
      }
      if (!this.upgradeMicrotaskScheduled) {
        this.upgradeMicrotaskScheduled = true;
        queueMicrotask(() => {
          this.upgradeMicrotaskScheduled = false;
          this.flushUpgradeRedraw(generation);
        });
      }
      return;
    }
    if (!this.upgradeFallbackTimer) {
      this.upgradeFallbackTimer = setTimeout(() => {
        this.upgradeFallbackTimer = null;
        this.flushUpgradeRedraw(generation);
      }, 40);
    }
  }

  private async preloadImage(fileId: string) {
    if (!fileId) return;
    const existing = imageAssetCache.getBestDrawable(fileId, INITIAL_PRELOAD_TIER);
    if (existing && !existing.needsPromotion) {
      this.markDecodedCounted(fileId);
      gate0Profiler.event('image-cache-hit', undefined, { fileId });
      return;
    }

    if (this.pending.has(fileId)) return;
    this.pending.add(fileId);
    const generation = this.generation;
    const isCurrent = () => generation === this.generation && this.images.some(image => image.fileId === fileId);

    const loadStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    const simultaneous = (gate0ImageRequests.get(fileId) ?? 0) + 1;
    gate0ImageRequests.set(fileId, simultaneous);
    gate0Profiler.event('image-load-start', undefined, { fileId, simultaneous });

    const finishLoadProfile = () => {
      if (generation === this.generation) this.pending.delete(fileId);
      const remaining = Math.max(0, (gate0ImageRequests.get(fileId) ?? 1) - 1);
      if (remaining) gate0ImageRequests.set(fileId, remaining);
      else gate0ImageRequests.delete(fileId);
      if (loadStartedAt) gate0Profiler.event('image-load-request', performance.now() - loadStartedAt, { fileId, simultaneous });
      this.flushDecodedRedraw();
    };

    try {
      const decodeStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
      gate0Profiler.event('image-decode-attempt', undefined, { fileId });
      const drawable = await imageAssetCache.preload(fileId, INITIAL_PRELOAD_TIER, 'visible');
      if (drawable && isCurrent()) {
        this.markDecodedCounted(fileId);
        gate0Profiler.event('image-decode-success', decodeStartedAt ? performance.now() - decodeStartedAt : undefined, { fileId });
        this.decodedRedrawPending = true;
      }
    } catch (err) {
      console.error('Failed to load image:', err);
    } finally {
      finishLoadProfile();
    }
  }

  /** Fire one redraw/listener pass after the page's pending decodes settle. */
  private flushDecodedRedraw(): void {
    if (this.pending.size > 0 || !this.decodedRedrawPending) return;
    this.decodedRedrawPending = false;
    if (this.redrawCallback) {
      this.redrawCallback();
      gate0Profiler.event('image-completion-redraw');
    }
    for (const listener of this.decodedListeners) listener();
  }

  renderImages(
    ctx: CanvasRenderingContext2D,
    layerId?: string,
    excludeIds?: Set<string>,
    cullBounds?: EraseBounds | null
  ): void {
    if (cullBounds && isEmptyBounds(cullBounds)) return;
    for (const imgObj of this.images) {
      if (excludeIds && excludeIds.has(imgObj.id)) continue;
      const imgLayerId = imgObj.layerId ?? DEFAULT_PAGE_LAYER_ID;
      if (layerId && imgLayerId !== layerId) continue;
      if (!this.viewport.intersectsRenderWindow(imgObj)) continue;
      if (cullBounds && !objectIntersectsBounds(imgObj, cullBounds)) continue;
      this.renderImage(ctx, imgObj);
    }
  }

  renderImage(ctx: CanvasRenderingContext2D, imgObj: ImageObject): void {
    const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const fallbackScale = this.viewport
      ? this.viewport.getState().scale * this.viewport.getDevicePixelRatio()
      : 1;
    const scaleX = m ? Math.hypot(m.a, m.b) : fallbackScale;
    const scaleY = m ? Math.hypot(m.c, m.d) : scaleX;

    const crop = getImageCrop(imgObj);
    const nat = imageAssetCache.getNaturalSize(imgObj.fileId);
    const desiredTier = selectMipTier(
      imgObj.width * scaleX,
      imgObj.height * scaleY,
      crop,
      nat?.width,
      nat?.height,
    );

    const upgradeKey = `${imgObj.fileId}:${desiredTier}`;
    const hit = imageAssetCache.getBestDrawable(
      imgObj.fileId,
      desiredTier,
      () => this.onUpgradePromoted(upgradeKey, imgObj.fileId),
    );
    if (!hit) {
      void this.preloadImage(imgObj.fileId);
      return;
    }
    if (hit.needsPromotion) {
      this.pendingUpgrades.add(upgradeKey);
    }

    if ('close' in hit.drawable) {
      const bmp = hit.drawable as ImageBitmap;
      if (!(bmp.width > 0 && bmp.height > 0)) return;
    } else if (!(hit.width > 0 && hit.height > 0)) {
      return;
    }

    const sx = Math.max(0, Math.min(hit.width - 1, crop.x * hit.width));
    const sy = Math.max(0, Math.min(hit.height - 1, crop.y * hit.height));
    const sw = Math.max(1, Math.min(hit.width - sx, crop.width * hit.width));
    const sh = Math.max(1, Math.min(hit.height - sy, crop.height * hit.height));

    ctx.save();
    // Ensure high quality bicubic/lanczos filtering across any zoom and display dimensions
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const appearance = getImageRenderAppearance(imgObj);
    ctx.globalAlpha *= appearance.opacity;

    // Move to center of image to apply rotation
    ctx.translate(imgObj.x + imgObj.width / 2, imgObj.y + imgObj.height / 2);
    ctx.rotate(appearance.rotationRadians);

    // Draw image centered at the translated coordinate using selected mip tier
    ctx.drawImage(
      hit.drawable,
      sx, sy, sw, sh,
      -imgObj.width / 2,
      -imgObj.height / 2,
      imgObj.width,
      imgObj.height
    );

    ctx.restore();
  }

  isEditable(image: ImageObject): boolean {
    return this.layerManager.isEditable(image.layerId);
  }

  // Unpin this manager's asset scope and release transient resources without closing shared bitmaps
  destroy() {
    this.generation += 1;
    this.redrawCallback = undefined;
    this.pending.clear();
    this.decodedRedrawPending = false;
    this.clearUpgradeState();
    this.decodedListeners.clear();
    imageAssetCache.unpin(this.scopeId);
    for (const url of this.objectUrls.values()) {
      this.safeRevokeBlobUrl(url);
      gate0Profiler.resource('objectUrls', -1);
    }
    this.objectUrls.clear();
    if (this.countedDecodedIds.size > 0) {
      gate0Profiler.resource('decodedImages', -this.countedDecodedIds.size);
      this.countedDecodedIds.clear();
    }
    this.imageCache.clear();
  }
}
