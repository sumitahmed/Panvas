import { ImageObject, DEFAULT_PAGE_LAYER_ID } from './drawingTypes.ts';
import { ViewportManager } from './ViewportManager.ts';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { LayerManager } from './LayerManager.ts';
import { getImageRenderAppearance, getImageCrop } from './imageAppearance.ts';
import { gate0Profiler } from '../../../dev/gate0Profiler.ts';

const gate0ImageRequests = new Map<string, number>();

export class ImageManager {
  private images: ImageObject[] = [];
  private imageCache: Map<string, HTMLImageElement> = new Map();
  private objectUrls: Map<string, string> = new Map();
  private viewport: ViewportManager;
  private redrawCallback?: () => void;
  private layerManager: LayerManager;
  private pending = new Set<string>();
  private generation = 0;
  private decodedListeners = new Set<() => void>();
  private decodedRedrawPending = false;

  onDecodedImage(listener: () => void): () => void {
    this.decodedListeners.add(listener);
    return () => { this.decodedListeners.delete(listener); };
  }

  // Share already-decoded elements only between resident page surfaces. Each
  // manager retains at most its current page's assets; no global cache exists.
  adoptDecodedImages(source: ImageManager, fileIds = this.images.map(image => image.fileId)): void {
    for (const id of fileIds) {
      const image = source.imageCache.get(id);
      if (image && !this.imageCache.has(id)) {
        this.imageCache.set(id, image);
        gate0Profiler.resource('decodedImages', 1);
      }
    }
  }

  constructor(viewport: ViewportManager, layerManager: LayerManager = new LayerManager()) {
    this.viewport = viewport;
    this.layerManager = layerManager;
  }

  setRedrawCallback(cb: () => void) {
    this.redrawCallback = cb;
  }

  getImages(): ImageObject[] {
    return this.images;
  }

  /** Object URL for a decoded image asset, for DOM-level rendering (the image
   *  overlay must stack above text DOM, which the raster canvas cannot). */
  getObjectUrl(fileId: string): string | undefined {
    return this.objectUrls.get(fileId);
  }

  // ---- DOM overlay lifecycle ----
  // The overlay is the visually authoritative on-screen representation (it
  // stacks above text DOM). During selection drags the raster canvas repaints
  // the moved image per frame while React state is intentionally quiet, so the
  // overlay is synced imperatively: hidden during resize/rotate previews and
  // translated during move previews, then reconciled at commit.

  private overlayElements = new Map<string, HTMLElement>();

  registerOverlayElement(imageId: string, element: HTMLElement | null): void {
    if (element) this.overlayElements.set(imageId, element);
    else this.overlayElements.delete(imageId);
  }

  private overlayRotationRadians(imageId: string): number {
    const object = this.getImage(imageId);
    return ((object?.rotation || 0) * Math.PI) / 180;
  }

  /** Move-preview: translate the overlay by the live drag delta. */
  previewImageOverlay(imageId: string, dx: number, dy: number): void {
    const element = this.overlayElements.get(imageId);
    if (!element) return;
    element.style.visibility = 'visible';
    element.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${this.overlayRotationRadians(imageId)}rad)`;
  }

  /** Resize/rotate preview: the overlay cannot express the changing geometry,
   *  so hide it and let the raster canvas carry the preview. */
  hideImageOverlay(imageId: string): void {
    const element = this.overlayElements.get(imageId);
    if (element) element.style.visibility = 'hidden';
  }

  /** Commit: snap the overlay to the object's committed geometry and restore it. */
  commitImageOverlay(imageId: string): void {
    const element = this.overlayElements.get(imageId);
    const object = this.getImage(imageId);
    if (!element || !object) return;
    element.style.visibility = 'visible';
    element.style.left = `${object.x}px`;
    element.style.top = `${object.y}px`;
    element.style.width = `${object.width}px`;
    element.style.height = `${object.height ?? 0}px`;
    element.style.transform = `rotate(${this.overlayRotationRadians(imageId)}rad)`;
  }

  clearImageOverlayPreview(imageId: string): void {
    const element = this.overlayElements.get(imageId);
    if (element) {
      element.style.visibility = 'visible';
      element.style.transform = `rotate(${this.overlayRotationRadians(imageId)}rad)`;
    }
  }

  getImage(id: string): ImageObject | undefined {
    return this.images.find(image => image.id === id);
  }

  setImages(images: ImageObject[]): void {
    this.images = images;
    const retained = new Set(images.map(image => image.fileId));
    for (const id of this.imageCache.keys()) {
      if (retained.has(id)) continue;
      this.imageCache.delete(id);
      gate0Profiler.resource('decodedImages', -1);
    }
    for (const [id, url] of this.objectUrls) {
      if (retained.has(id)) continue;
      URL.revokeObjectURL(url);
      this.objectUrls.delete(id);
      gate0Profiler.resource('objectUrls', -1);
    }
    // Preload newly set images
    for (const img of images) {
      this.preloadImage(img.fileId);
    }
  }

  addImage(image: ImageObject): void {
    image.layerId ??= this.layerManager.getActiveLayerId();
    this.images.push(image);
    this.preloadImage(image.fileId);
  }

  removeImage(id: string): ImageObject | undefined {
    const index = this.images.findIndex(i => i.id === id);
    if (index === -1) return undefined;
    const [removed] = this.images.splice(index, 1);
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
    return removed;
  }

  cacheImage(fileId: string, img: HTMLImageElement, objectUrl?: string): void {
    if (!this.imageCache.has(fileId)) gate0Profiler.resource('decodedImages', 1);
    this.imageCache.set(fileId, img);
    if (objectUrl) {
      this.objectUrls.set(fileId, objectUrl);
    }
  }

  clearImages(): ImageObject[] {
    const removed = [...this.images];
    this.setImages([]);
    return removed;
  }

  private async preloadImage(fileId: string) {
    if (this.imageCache.has(fileId)) {
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
    // Decode every image in a page batch before repainting. Each individual
    // load used to schedule its own full page preview paint, and on a dense
    // page that turned three loads into three 1,200-stroke raster passes.
    const requestDecodedRedraw = () => {
      this.decodedRedrawPending = true;
    };
    try {
      const fileData = await canvasRepository.getImage(fileId);
      if (!fileData || !isCurrent() || this.imageCache.has(fileId)) { finishLoadProfile(); return; }

      const blob = new Blob([fileData.data], { type: fileData.mimeType });
      const url = URL.createObjectURL(blob);
      this.objectUrls.set(fileId, url);
      gate0Profiler.resource('objectUrls', 1);
      gate0Profiler.event('image-object-url-created', undefined, { fileId });

      const img = new Image();
      const decodeStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
      gate0Profiler.event('image-decode-attempt', undefined, { fileId });
      img.onload = () => {
        if (!isCurrent()) { finishLoadProfile(); return; }
        if (!this.imageCache.has(fileId)) gate0Profiler.resource('decodedImages', 1);
        this.imageCache.set(fileId, img);
        gate0Profiler.event('image-decode-success', decodeStartedAt ? performance.now() - decodeStartedAt : undefined, { fileId });
        requestDecodedRedraw();
        finishLoadProfile();
      };
      img.onerror = () => finishLoadProfile();
      img.src = url;
    } catch (err) {
      console.error('Failed to load image:', err);
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

  renderImages(ctx: CanvasRenderingContext2D, layerId?: string, excludeIds?: Set<string>): void {
    for (const imgObj of this.images) {
      if (excludeIds && excludeIds.has(imgObj.id)) continue;
      if (!this.viewport.intersectsRenderWindow(imgObj)) continue;
      if (layerId && imgObj.layerId !== layerId) continue;
      const imgLayerId = imgObj.layerId ?? DEFAULT_PAGE_LAYER_ID;
      if (layerId && imgLayerId !== layerId) continue;
      this.renderImage(ctx, imgObj);
    }
  }

  renderImage(ctx: CanvasRenderingContext2D, imgObj: ImageObject): void {
    const imgElem = this.imageCache.get(imgObj.fileId);
    if (!imgElem) return;

    ctx.save();
    // Ensure high quality bicubic/lanczos filtering across any zoom and display dimensions
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const appearance = getImageRenderAppearance(imgObj);
    ctx.globalAlpha *= appearance.opacity;

    // Move to center of image to apply rotation
    ctx.translate(imgObj.x + imgObj.width / 2, imgObj.y + imgObj.height / 2);
    ctx.rotate(appearance.rotationRadians);
    
    // Draw image centered at the translated coordinate using original full-resolution source
    const crop = getImageCrop(imgObj);
    ctx.drawImage(
      imgElem,
      crop.x * imgElem.naturalWidth, crop.y * imgElem.naturalHeight, crop.width * imgElem.naturalWidth, crop.height * imgElem.naturalHeight,
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

  // Cleanup object URLs to prevent memory leaks when manager is destroyed
  destroy() {
    this.generation += 1;
    this.redrawCallback = undefined;
    this.pending.clear();
    this.decodedRedrawPending = false;
    this.decodedListeners.clear();
    for (const url of this.objectUrls.values()) {
      URL.revokeObjectURL(url);
      gate0Profiler.resource('objectUrls', -1);
      gate0Profiler.event('image-object-url-revoked');
    }
    gate0Profiler.resource('decodedImages', -this.imageCache.size);
    this.objectUrls.clear();
    this.imageCache.clear();
    this.overlayElements.clear();
  }
}
