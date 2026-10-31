import { buildInkFamilyGeometry, inkSampleWidths } from './inkFamilyGeometry.ts';
import type { InkFamily } from './drawingTypes.ts';
// ============================================
// Panvas — Drawing Engine
// ============================================
// Renders strokes onto an HTML5 Canvas.
// No React dependency — pure TypeScript class.

import type { Stroke, StrokePoint, DrawingToolId, StrokePattern, DrawingData } from './drawingTypes.ts';
import { DEFAULT_PAGE_LAYER_ID } from './drawingTypes.ts';

/**
 * A 3 ms JS budget is not a GPU budget: once paths are warm a slice can record
 * hundreds of strokes, and rasterizing that batch blocks the renderer main
 * thread for 40-100 ms. Bound each preview slice by stroke count as well.
 */
const MAX_PREVIEW_STROKES_PER_SLICE = 32;
import { ViewportManager } from './ViewportManager.ts';
import { ShapeManager } from './ShapeManager.ts';
import type { ImageManager } from './ImageManager.ts';
import { SelectionEngine } from './SelectionEngine.ts';
import { getPencilRenderPoint, getStrokeRenderHalfWidth } from './strokeGeometry.ts';
import { traceInkClip, strokeRegion, eraserCapsule, regionIntersects } from './inkRegion.ts';
import { LayerManager } from './LayerManager.ts';
import { RulerManager } from './RulerManager.ts';
import { LaserManager } from './LaserManager.ts';
import { buildStrokePatternGeometry } from './strokePatternGeometry.ts';
import { gate0Profiler } from '../../../dev/gate0Profiler.ts';
import { boundsOverlap, eraseBounds, eraseBoundsWithHalfWidth, type EraseBounds } from './capsuleErase.ts';
import { PenGeometry } from './penGeometry.ts';
import { WetInkSurface } from './WetInkSurface.ts';
import { invalidateStrokeSnapshot as invalidateCachedStrokeSnapshot, primeStrokeSnapshot as primeCachedStrokeSnapshot } from './cloneStrokeSnapshot.ts';
import type { HandwritingTrace } from '../../../dev/handwritingTrace.ts';
import { fullDarkInkColor } from '../../../lib/fullDarkView.ts';

type InkPathEntry = {
  key: string;
  path: Path2D;
  x: number;
  y: number;
  length: number;
  firstX: number;
  firstY: number;
  firstPressure?: number;
  firstT?: number;
  lastX: number;
  lastY: number;
  lastPressure?: number;
  lastT?: number;
};

type StrokeMetricsEntry = {
  key: string;
  firstX: number;
  firstY: number;
  lastX: number;
  lastY: number;
  length: number;
  bounds: EraseBounds;
  halfWidth: number;
  pointBounds: { x: number; y: number; width: number; height: number };
};

// Committed numeric samples are immutable between explicit selection/undo
// invalidations. Page handoffs clone stroke headers but preserve the sample
// array, so key process-wide geometry by that array rather than by the header
// identity. Weak keys let entries die with the page cache instead of retaining
// evicted pages.
const sharedInkPaths = new WeakMap<StrokePoint[], InkPathEntry>();
const sharedStrokeMetrics = new WeakMap<StrokePoint[], StrokeMetricsEntry>();

export class DrawingEngine {
  private strokes: Stroke[] = [];
  private strokeMap = new Map<string, Stroke>();
  private ctx: CanvasRenderingContext2D | null = null;
  private viewport: ViewportManager;
  private shapeManager: ShapeManager;
  private imageManager: ImageManager;
  private selectionEngine?: SelectionEngine;
  private canvas: HTMLCanvasElement | null = null;
  private layerManager: LayerManager;
  private rulerManager: RulerManager;
  private laserManager: LaserManager;
  private laserCanvas: HTMLCanvasElement | null = null;
  private laserContext: CanvasRenderingContext2D | null = null;
  private _scaleMultiplier = 1;
  private canvasCssWidth = 0;
  private canvasCssHeight = 0;
  private layerCanvases = new Map<string, CanvasRenderingContext2D>();
  /** Identity of the scene payload whose pixels currently live on this surface. */
  private renderedSurfaceKey: unknown = null;
  /** Content identities used to match equivalent data snapshots without relying on wrapper identity. */
  private renderedSurfaceObjects: unknown = null;
  private renderedSurfaceLayers: unknown = null;
  private renderedSurfaceActiveLayerId: unknown = null;
  private renderedSurfaceVersion: unknown = null;
  private renderedSurfaceRevision: unknown = null;
  private pendingPaintKey: unknown = null;
  private pendingPaintObjects: unknown = null;
  private pendingPaintRevision: unknown = null;
  /** Page-owned static previews coalesce every setup redraw into one microtask. */
  private coalesceRedraws = false;
  private redrawScheduled = false;
  private redrawCompletion: (() => void) | null = null;
  private progressivePaintFrame: number | null = null;
  private progressivePaintToken = 0;
  private progressivePaintRestart = false;
  /** Pixels prepared by a page-owned preview for adoption at the next mount. */
  private pendingSurfaceSource: DrawingEngine | null = null;
  private pendingSurfaceKey: unknown = null;
  /** Listeners waiting for this engine to finish (or lose) a painted surface. */
  private surfaceChangeListeners = new Set<(current: boolean) => void>();
  /** A mount waiting for its prepared preview to finish painting. */
  private deferredSurfaceReady: ((adopted: boolean) => void) | null = null;
  private deferredSurfaceUnsubscribe: (() => void) | null = null;
  private deferredSurfaceTimer: ReturnType<typeof setTimeout> | null = null;
  private liveSnapshotCanvas: HTMLCanvasElement | null = null;
  private isLiveDrawing = false;
  private wetInk: WetInkSurface | null = null;
  private spareWetInk: WetInkSurface | null = null;
  private spareWetInkTimer: ReturnType<typeof setTimeout> | null = null;
  private liveFrame: number | null = null;
  private pendingInk: Stroke | null = null;
  private pendingLiveRevisionFrom = Infinity;
  private lastLiveInk: Stroke | null = null;
  private liveTrace: HandwritingTrace | null = null;
  private frameQueuedAt = 0;
  private lastFrameAt = 0;
  private fullDarkView = false;
  private selectionBackingCanvas: HTMLCanvasElement | null = null;
  private isSelectionDragging = false;
  private selectionBackingReady = false;
  private selectionExcludeIds = new Set<string>();
  private lassoBackingCanvas: HTMLCanvasElement | null = null;
  private isLassoActive = false;

  /**
   * Allocate and prime the selection snapshot surface outside the pointerdown
   * task. The first 1,100x1,560 backing canvas allocation plus GPU copy can
   * delay the first drag frame by tens of milliseconds; later drags reuse it.
   */
  warmSelectionBacking(): void {
    if (!this.canvas || !this.ctx || typeof document === 'undefined') return;
    if (!this.selectionBackingCanvas) {
      this.selectionBackingCanvas = document.createElement('canvas');
    }
    if (this.selectionBackingCanvas.width !== this.canvas.width || this.selectionBackingCanvas.height !== this.canvas.height) {
      this.selectionBackingCanvas.width = this.canvas.width;
      this.selectionBackingCanvas.height = this.canvas.height;
    }
    const snapCtx = this.selectionBackingCanvas.getContext('2d');
    if (!snapCtx) return;
    snapCtx.resetTransform();
    snapCtx.clearRect(0, 0, this.selectionBackingCanvas.width, this.selectionBackingCanvas.height);
    snapCtx.drawImage(this.canvas, 0, 0);
  }

  beginSelectionDrag(selectedElements: { id: string; type: string }[]): void {
    if (!this.canvas || !this.ctx || typeof document === 'undefined') return;
    this.isSelectionDragging = true;
    this.selectionBackingReady = false;
    this.selectionExcludeIds = new Set(selectedElements.map(e => e.id));
    for (const el of selectedElements) {
      if (el.type === 'stroke') {
        const stroke = this.getStrokeById(el.id);
        if (stroke) {
          const path = this.inkPaths.get(stroke) ?? this.retainedInkPaths.get(stroke.id);
          if (path) this.retainedInkPaths.set(stroke.id, path);
        }
      }
    }
  }

  /**
   * Build the drag snapshot on the first paint frame. Doing this in the
   * pointerdown task made a 1,200-stroke page block the event handler for a
   * full frame; the gesture state is already usable before the first move.
   */
  private prepareSelectionBacking(): void {
    if (!this.canvas || !this.ctx || typeof document === 'undefined') return;
    if (!this.selectionBackingCanvas) {
      this.selectionBackingCanvas = document.createElement('canvas');
    }
    if (this.selectionBackingCanvas.width !== this.canvas.width || this.selectionBackingCanvas.height !== this.canvas.height) {
      this.selectionBackingCanvas.width = this.canvas.width;
      this.selectionBackingCanvas.height = this.canvas.height;
    }
    const snapCtx = this.selectionBackingCanvas.getContext('2d');
    if (!snapCtx) return;
    const backingScale = this.canvasCssWidth > 0 ? this.canvas.width / this.canvasCssWidth : 1;

    snapCtx.resetTransform();
    snapCtx.clearRect(0, 0, this.selectionBackingCanvas.width, this.selectionBackingCanvas.height);
    snapCtx.drawImage(this.canvas, 0, 0);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of this.selectionExcludeIds) {
      const s = this.getStrokeById(id);
      if (s) {
        const b = this.getCachedEraseBounds(s);
        if (b.left < minX) minX = b.left;
        if (b.right > maxX) maxX = b.right;
        if (b.top < minY) minY = b.top;
        if (b.bottom > maxY) maxY = b.bottom;
        continue;
      }
      const shape = this.shapeManager.getShape(id);
      if (shape) {
        if (shape.x < minX) minX = shape.x;
        if (shape.x + shape.width > maxX) maxX = shape.x + shape.width;
        if (shape.y < minY) minY = shape.y;
        if (shape.y + shape.height > maxY) maxY = shape.y + shape.height;
        continue;
      }
      const img = this.imageManager.getImage(id);
      if (img) {
        if (img.x < minX) minX = img.x;
        if (img.x + img.width > maxX) maxX = img.x + img.width;
        if (img.y < minY) minY = img.y;
        if (img.y + img.height > maxY) maxY = img.y + img.height;
      }
    }

    this.selectionBackingReady = true;
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      return;
    }

    const scale = this.viewport.getState().scale;
    const padding = 48 / Math.max(0.05, scale);
    const damage: EraseBounds = {
      left: minX - padding,
      top: minY - padding,
      right: maxX + padding,
      bottom: maxY + padding,
    };

    snapCtx.save();
    snapCtx.scale(backingScale, backingScale);
    this.viewport.applyTransform(snapCtx);
    const transform = snapCtx.getTransform();

    const corners = [
      [damage.left, damage.top],
      [damage.right, damage.top],
      [damage.right, damage.bottom],
      [damage.left, damage.bottom],
    ].map(([x, y]) => ({
      x: transform.a * x + transform.c * y + transform.e,
      y: transform.b * x + transform.d * y + transform.f,
    }));
    const left = Math.floor(Math.min(...corners.map(p => p.x)));
    const top = Math.floor(Math.min(...corners.map(p => p.y)));
    const right = Math.ceil(Math.max(...corners.map(p => p.x)));
    const bottom = Math.ceil(Math.max(...corners.map(p => p.y)));

    snapCtx.resetTransform();
    snapCtx.clearRect(left, top, right - left, bottom - top);

    snapCtx.scale(backingScale, backingScale);
    this.viewport.applyTransform(snapCtx);

    for (const layer of this.layerManager.getLayers()) {
      if (!layer.visible) continue;
      for (const img of this.imageManager.getImages()) {
        const imgLayerId = img.layerId ?? DEFAULT_PAGE_LAYER_ID;
        if (imgLayerId !== layer.id) continue;
        if (this.selectionExcludeIds.has(img.id)) continue;
        if (img.x > damage.right || img.x + img.width < damage.left || img.y > damage.bottom || img.y + img.height < damage.top) continue;
        this.imageManager.renderImage(snapCtx, img);
      }
      for (const stroke of this.strokes) {
        const strokeLayerId = stroke.layerId ?? DEFAULT_PAGE_LAYER_ID;
        if (strokeLayerId !== layer.id) continue;
        if (this.selectionExcludeIds.has(stroke.id)) continue;
        if (!boundsOverlap(damage, this.getCachedEraseBounds(stroke))) continue;
        this.renderStroke(snapCtx, stroke);
      }
      for (const shape of this.shapeManager.getShapes()) {
        const shapeLayerId = shape.layerId ?? DEFAULT_PAGE_LAYER_ID;
        if (shapeLayerId !== layer.id) continue;
        if (this.selectionExcludeIds.has(shape.id)) continue;
        if (shape.x > damage.right || shape.x + shape.width < damage.left || shape.y > damage.bottom || shape.y + shape.height < damage.top) continue;
        this.shapeManager.renderShape(snapCtx, shape);
      }
    }
    snapCtx.restore();
  }

  isSelectionDragActive(): boolean {
    return this.isSelectionDragging;
  }

  endSelectionDrag(): void {
    this.isSelectionDragging = false;
    this.selectionBackingReady = false;
    this.selectionExcludeIds.clear();
  }

  private renderSceneToContext(targetCtx: CanvasRenderingContext2D, excludeIds?: Set<string>): void {
    targetCtx.save();
    this.viewport.applyTransform(targetCtx);
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = 'high';
    const windowBounds = this.viewport.getRenderWindowBounds();
    for (const layer of this.layerManager.getLayers()) {
      if (!layer.visible) continue;
      this.imageManager.renderImages(targetCtx, layer.id, excludeIds);
      for (const stroke of this.strokes) {
        if (excludeIds && excludeIds.has(stroke.id)) continue;
        if (windowBounds && !boundsOverlap(windowBounds, this.getCachedEraseBounds(stroke))) continue;
        const strokeLayerId = stroke.layerId ?? DEFAULT_PAGE_LAYER_ID;
        if (strokeLayerId === layer.id) this.renderStroke(targetCtx, stroke);
      }
      this.shapeManager.renderShapes(targetCtx, layer.id, excludeIds);
    }
    targetCtx.restore();
  }

  setFullDarkView(enabled: boolean): void {
    if (enabled === this.fullDarkView) return;
    this.fullDarkView = enabled;
    this.invalidateRenderedSurface();
    this.shapeManager.setFullDarkView(enabled);
    this.requestRedraw();
  }

  private displayStroke(stroke: Stroke): Stroke {
    return this.fullDarkView ? { ...stroke, color: fullDarkInkColor(stroke.color) } : stroke;
  }

  attachLayerCanvas(id: string, canvas: HTMLCanvasElement, width: number, height: number, scale: number): () => void {
    const ctx = this.viewport.configureCanvas(canvas, width, height, scale / Math.sqrt(Math.max(1, this.layerManager.getLayers().length)));
    this.layerCanvases.set(id, ctx);
    const source = this.pendingSurfaceSource?.layerCanvases.get(id);
    if (source && source.canvas.width === canvas.width && source.canvas.height === canvas.height) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source.canvas, 0, 0);
      ctx.restore();
    } else {
      this.requestRedraw();
    }
    return () => { if (this.layerCanvases.get(id) === ctx) this.layerCanvases.delete(id); this.requestRedraw(); };
  }

  constructor(
    viewport: ViewportManager,
    shapeManager: ShapeManager,
    imageManager: ImageManager,
    layerManager: LayerManager = new LayerManager(),
    rulerManager: RulerManager = new RulerManager(),
    laserManager: LaserManager = new LaserManager(),
  ) {
    this.viewport = viewport;
    this.shapeManager = shapeManager;
    this.imageManager = imageManager;
    this.layerManager = layerManager;
    this.rulerManager = rulerManager;
    this.laserManager = laserManager;
    this.laserManager.setRedrawCallback(() => this.redrawLaserFrame());
  }

  setScaleMultiplier(mult: number) {
    if (mult !== this._scaleMultiplier) this.invalidateRenderedSurface();
    this._scaleMultiplier = mult;
  }

  getRulerManager(): RulerManager {
    return this.rulerManager;
  }

  getLaserManager(): LaserManager {
    return this.laserManager;
  }
  
  setSelectionEngine(selectionEngine: SelectionEngine) {
    this.selectionEngine = selectionEngine;
  }

  /** Bind to a canvas element. Call after mount. */
  setCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): void {
    this.releaseLaserSurface();
    this.releaseSpareWetInk();
    this.cancelPaint();
    this.canvas = canvas;
    this.canvasCssWidth = cssWidth;
    this.canvasCssHeight = cssHeight;
    this.invalidateRenderedSurface();
    this.ctx = this.viewport.configureCanvas(canvas, cssWidth, cssHeight, this._scaleMultiplier);
    // Any deferred mount must not copy pixels into a different backing surface.
    this.notifySurfaceChange(false);
  }

  /** Detach from canvas element. */
  detachCanvas(): void {
    this.laserManager.clear();
    this.releaseLaserSurface();
    this.cancelPaint();
    // Clear the currently owned surface before releasing it. Page activation
    // can replace the engine scene before React commits the next page shell;
    // leaving these pixels alive would expose the outgoing scene for one
    // compositor frame on the incoming page.
    if (this.ctx && this.canvas) {
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.restore();
    }
    for (const context of this.layerCanvases.values()) {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, context.canvas.width, context.canvas.height);
      context.restore();
    }
    this.layerCanvases.clear();
    this.canvas = null;
    this.ctx = null;
    this.invalidateRenderedSurface();
    this.cancelDeferredSurfaceAdoption();
    this.pendingSurfaceSource = null;
    this.pendingSurfaceKey = null;
    this.canvasCssWidth = 0;
    this.canvasCssHeight = 0;
    this.pencilSurface = undefined;
    this.endLiveStroke();
    this.releaseSpareWetInk();
    this.notifySurfaceChange(false);
  }

  /** Resize the canvas (e.g., on window resize). */
  resize(cssWidth: number, cssHeight: number): void {
    if (!this.canvas) return;
    this.releaseLaserSurface();
    this.releaseSpareWetInk();
    this.invalidateRenderedSurface();
    this.canvasCssWidth = cssWidth;
    this.canvasCssHeight = cssHeight;
    this.ctx = this.viewport.configureCanvas(this.canvas, cssWidth, cssHeight, this._scaleMultiplier);
    this.requestRedraw();
  }

  getCanvasElement(): HTMLCanvasElement | null { return this.canvas; }

  /** Record that the attached surfaces currently represent this scene payload. */
  markSurfaceCurrent(key: unknown): void {
    this.renderedSurfaceKey = key;
    const data = key as any;
    this.renderedSurfaceObjects = data?.objects ?? null;
    this.renderedSurfaceLayers = data?.layers ?? null;
    this.renderedSurfaceActiveLayerId = data?.activeLayerId ?? null;
    this.renderedSurfaceVersion = data?.version ?? null;
    this.renderedSurfaceRevision = data?.drawingRevision ?? data?.revision ?? null;
    this.pendingPaintKey = null;
    this.pendingPaintObjects = null;
    this.pendingPaintRevision = null;
    this.notifySurfaceChange(true);
  }

  /** Notify a waiting mount when this surface becomes current or is torn down. */
  onSurfaceChange(listener: (current: boolean) => void): () => void {
    this.surfaceChangeListeners.add(listener);
    return () => { this.surfaceChangeListeners.delete(listener); };
  }

  private notifySurfaceChange(current: boolean): void {
    for (const listener of [...this.surfaceChangeListeners]) listener(current);
  }

  /** True while a redraw is queued, slicing, or waiting to report completion. */
  isSurfacePaintPending(): boolean {
    return this.redrawScheduled || this.progressivePaintFrame !== null || this.redrawCompletion !== null;
  }

  hasPendingSurfaceAdoption(): boolean {
    return this.pendingSurfaceSource !== null;
  }

  isSurfaceAdoptionDeferred(): boolean {
    return this.deferredSurfaceUnsubscribe !== null;
  }

  /** Complete a pending handoff before a user gesture needs live pixels. */
  ensureSurfaceReadyForInteraction(): void {
    if (!this.deferredSurfaceReady) return;
    // The source may be most of the way through its sliced paint. Finishing
    // only the remaining slices is cheaper than replaying the whole page here,
    // and the source's completion callback copies its pixels synchronously.
    const source = this.pendingSurfaceSource;
    if (source?.finishProgressivePaintNow?.() && !this.deferredSurfaceReady) return;
    this.redraw();
  }

  private invalidateRenderedSurface(): void {
    this.renderedSurfaceKey = null;
    this.renderedSurfaceObjects = null;
    this.renderedSurfaceLayers = null;
    this.renderedSurfaceActiveLayerId = null;
    this.renderedSurfaceVersion = null;
    this.renderedSurfaceRevision = null;
    this.pendingPaintKey = null;
    this.pendingPaintObjects = null;
    this.pendingPaintRevision = null;
    this.redrawCompletion = null;
  }

  isSurfaceCurrent(key: unknown): boolean {
    if (this.canvas === null) return false;
    if (this.renderedSurfaceKey === key) return true;
    // The renderer can hand the same content through different wrapper objects
    // (a live capture, a save snapshot, and a resolved cache entry). The pixels
    // are current when the content-bearing arrays are unchanged, even if the
    // outer DrawingData identity differs.
    const data = key as any;
    if (!data) return false;
    if (this.renderedSurfaceRevision !== null && (data.drawingRevision ?? data.revision) !== undefined) {
      if (this.renderedSurfaceRevision === (data.drawingRevision ?? data.revision)) return true;
    }
    if (this.renderedSurfaceObjects === (data.objects ?? null)
      && this.renderedSurfaceLayers === (data.layers ?? null)
      && this.renderedSurfaceActiveLayerId === (data.activeLayerId ?? null)
      && this.renderedSurfaceVersion === (data.version ?? null)) {
      return true;
    }
    const currentObjs = this.renderedSurfaceObjects as any[] | null;
    const nextObjs = data.objects as any[] | null;
    if (currentObjs && nextObjs && currentObjs.length === nextObjs.length
      && this.renderedSurfaceLayers === (data.layers ?? null)
      && this.renderedSurfaceActiveLayerId === (data.activeLayerId ?? null)
      && this.renderedSurfaceVersion === (data.version ?? null)) {
      if (currentObjs.length === 0) return true;
      if (currentObjs[0]?.id === nextObjs[0]?.id && currentObjs[currentObjs.length - 1]?.id === nextObjs[nextObjs.length - 1]?.id) {
        return true;
      }
    }
    return false;
  }

  /**
   * Record that a page-owned static preview is painting this payload.
   * If re-renders happen while slices yield to animation frames, callers
   * can recognize that the current work already represents this scene.
   */
  schedulePreviewPaint(data: unknown, onComplete?: () => void): void {
    this.pendingPaintKey = data;
    const d = data as any;
    this.pendingPaintObjects = d?.objects ?? null;
    this.pendingPaintRevision = d?.drawingRevision ?? d?.revision ?? null;
    this.scheduleRedraw(() => {
      this.markSurfaceCurrent(data);
      onComplete?.();
    });
  }

  isSurfacePaintCurrent(key: unknown): boolean {
    if (!this.isSurfacePaintPending()) return false;
    if (this.pendingPaintKey === key) return true;
    const data = key as any;
    if (!data) return false;
    if (this.pendingPaintRevision !== null && (data.drawingRevision ?? data.revision) !== undefined) {
      if (this.pendingPaintRevision === (data.drawingRevision ?? data.revision)) return true;
    }
    if (this.pendingPaintObjects === (data.objects ?? null)) return true;
    const currentObjs = this.pendingPaintObjects as any[] | null;
    const nextObjs = data.objects as any[] | null;
    if (currentObjs && nextObjs && currentObjs.length === nextObjs.length) {
      if (currentObjs.length === 0) return true;
      if (currentObjs[0]?.id === nextObjs[0]?.id && currentObjs[currentObjs.length - 1]?.id === nextObjs[nextObjs.length - 1]?.id) {
        return true;
      }
    }
    return false;
  }

  /** Page-owned static previews can batch setup redraws into a single paint. */
  setCoalesceRedraws(enabled: boolean): void {
    this.coalesceRedraws = enabled;
  }

  /** Coalesce all redraws requested in the current task into one microtask. */
  scheduleRedraw(onComplete?: () => void): void {
    if (onComplete) this.redrawCompletion = onComplete;
    // Do not tear down a paint that is already yielding between slices. Dense
    // pages repaint in dozens of slices; cancelling for every image decode
    // restarts the raster from scratch and multiplies GPU work. Mark the pass
    // dirty and repaint once more after it completes instead.
    if (this.progressivePaintFrame !== null) {
      this.progressivePaintRestart = true;
      return;
    }
    this.cancelProgressivePaint();
    if (this.redrawScheduled) return;
    this.redrawScheduled = true;
    queueMicrotask(() => {
      if (!this.redrawScheduled) return;
      this.redrawScheduled = false;
      if (this.coalesceRedraws) {
        this.paintStaticPreview();
        return;
      }
      this.redraw();
      const complete = this.redrawCompletion;
      this.redrawCompletion = null;
      complete?.();
    });
  }

  /** Stop any queued or sliced paint without repainting this surface. */
  cancelPaint(): void {
    this.cancelProgressivePaint();
    this.redrawScheduled = false;
    this.redrawCompletion = null;
    this.progressivePaintRestart = false;
  }

  /**
   * Paint a live surface in the same bounded slices as a page preview. Used
   * when a handoff preview missed the mount deadline: replaying 1,200 strokes
   * synchronously there blocks scroll frames for hundreds of milliseconds.
   */
  paintProgressive(onComplete?: () => void): void {
    this.cancelDeferredSurfaceAdoption();
    if (onComplete) this.redrawCompletion = onComplete;
    this.paintStaticPreview();
  }

  private progressivePaintFlush: (() => void) | null = null;

  private cancelProgressivePaint(): void {
    this.progressivePaintToken++;
    this.progressivePaintRestart = false;
    this.progressivePaintFlush = null;
    if (this.progressivePaintFrame !== null) {
      cancelAnimationFrame(this.progressivePaintFrame);
      this.progressivePaintFrame = null;
    }
  }

  /**
   * Complete the current sliced paint synchronously. A first user gesture can
   * arrive while a page preview is still painting; finishing its remaining
   * slices and copying the finished surface avoids replaying the whole scene
   * on the live canvas inside the pointerdown task.
   */
  finishProgressivePaintNow(): boolean {
    const flush = this.progressivePaintFlush;
    if (!flush) return false;
    if (this.progressivePaintFrame !== null) {
      cancelAnimationFrame(this.progressivePaintFrame);
      this.progressivePaintFrame = null;
    }
    flush();
    return true;
  }

  /**
   * Paint a page-owned static preview in small slices. A cold 1,200-stroke page
   * needs ~90 ms to build every Path2D, so keeping that work inside a React
   * commit or image onload task blocks scrolling. Each slice draws for a few
   * milliseconds and yields to the next animation frame; the final pixels are
   * identical to redraw().
   */
  private paintStaticPreview(): void {
    if (!this.ctx || !this.canvas) {
      const complete = this.redrawCompletion;
      this.redrawCompletion = null;
      complete?.();
      return;
    }
    this.cancelProgressivePaint();
    const completion = this.redrawCompletion;
    this.invalidateRenderedSurface();
    this.redrawCompletion = completion;
    const token = ++this.progressivePaintToken;
    const mainCtx = this.ctx;
    for (const ctx of [mainCtx, ...this.layerCanvases.values()]) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.restore();
    }
    type PaintStep =
      | { kind: 'images' | 'shapes'; layerId: string; ctx: CanvasRenderingContext2D }
      | { kind: 'stroke'; stroke: Stroke; ctx: CanvasRenderingContext2D }
      | { kind: 'overlays' };
    const steps: PaintStep[] = [];
    const windowBounds = this.viewport.getRenderWindowBounds();
    for (const layer of this.layerManager.getLayers()) {
      if (!layer.visible) continue;
      const ctx = this.layerCanvases.get(layer.id) ?? mainCtx;
      steps.push({ kind: 'images', layerId: layer.id, ctx });
      for (const stroke of this.strokes) {
        if ((stroke.layerId ?? DEFAULT_PAGE_LAYER_ID) !== layer.id) continue;
        if (windowBounds && !boundsOverlap(windowBounds, this.getCachedEraseBounds(stroke))) continue;
        steps.push({ kind: 'stroke', stroke, ctx });
      }
      steps.push({ kind: 'shapes', layerId: layer.id, ctx });
    }
    steps.push({ kind: 'overlays' });
    let index = 0;
    const finish = () => {
      this.progressivePaintFrame = null;
      this.progressivePaintFlush = null;
      if (this.progressivePaintRestart) {
        this.progressivePaintRestart = false;
        // Keep the completion callback for the pass that includes the new
        // request; this pass is already stale. Restart in slices even on the
        // live engine: a coalesced redraw here would replay the whole scene
        // synchronously inside the finishing animation frame.
        this.paintStaticPreview();
        return;
      }
      if (this.pendingPaintKey) {
        this.markSurfaceCurrent(this.pendingPaintKey);
      }
      const complete = this.redrawCompletion;
      this.redrawCompletion = null;
      complete?.();
    };
    const paintStep = (step: PaintStep) => {
      if (step.kind === 'overlays') {
        this.renderTransientOverlays();
        return;
      }
      const ctx = step.ctx;
      ctx.save();
      this.viewport.applyTransform(ctx);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (step.kind === 'images') this.imageManager.renderImages(ctx, step.layerId);
      else if (step.kind === 'shapes') this.shapeManager.renderShapes(ctx, step.layerId);
      else if (step.kind === 'stroke') this.renderStroke(ctx, step.stroke);
      ctx.restore();
    };
    const flush = () => {
      if (token !== this.progressivePaintToken) return;
      this.progressivePaintFrame = null;
      this.progressivePaintFlush = null;
      while (index < steps.length) paintStep(steps[index++]);
      finish();
    };
    this.progressivePaintFlush = flush;
    const run = () => {
      if (token !== this.progressivePaintToken) return;
      this.progressivePaintFrame = null;
      const started = performance.now();
      let strokesThisSlice = 0;
      do {
        const step = steps[index++];
        if (!step) { finish(); return; }
        if (step.kind === 'stroke') strokesThisSlice++;
        paintStep(step);
      } while (strokesThisSlice < MAX_PREVIEW_STROKES_PER_SLICE
        && performance.now() - started < 3
        && index < steps.length);
      if (index >= steps.length) { finish(); return; }
      this.progressivePaintFrame = requestAnimationFrame(run);
    };
    // Paint the first slice immediately so a mounted page has ink before its
    // first composited frame; the remaining slices yield to animation frames.
    run();
  }

  private requestRedraw(): void {
    if (this.coalesceRedraws) this.scheduleRedraw();
    else this.redraw();
  }

  /** Offer page-owned preview pixels to the next canvas mount. */
  prepareSurfaceAdoption(source: DrawingEngine | null, key?: unknown): void {
    this.cancelDeferredSurfaceAdoption();
    this.pendingSurfaceSource = source;
    this.pendingSurfaceKey = key;
  }

  /**
   * Adopt prepared preview pixels after setCanvas(). Returns true when pixels
   * were copied. A preview that is still painting keeps the adoption pending
   * instead of forcing the caller into a synchronous full-scene replay; the
   * deferred callback receives true once those pixels arrive, or false when
   * the source cannot complete and the caller should paint progressively.
   */
  adoptPendingSurface(onDeferred?: (adopted: boolean) => void): boolean {
    const source = this.pendingSurfaceSource;
    const key = this.pendingSurfaceKey;
    if (!source) return false;
    if (source.isSurfaceCurrent(key)) {
      this.pendingSurfaceSource = null;
      this.pendingSurfaceKey = null;
      return source.copySurfacesTo(this, key);
    }
    if (source.isSurfacePaintPending()) {
      this.beginDeferredSurfaceAdoption(source, onDeferred);
      return false;
    }
    this.pendingSurfaceSource = null;
    this.pendingSurfaceKey = null;
    return false;
  }

  private beginDeferredSurfaceAdoption(
    source: DrawingEngine,
    onDeferred?: (adopted: boolean) => void,
  ): void {
    this.clearDeferredSurfaceAdoption();
    this.deferredSurfaceReady = onDeferred ?? null;
    const settle = (adopted: boolean) => {
      if (this.pendingSurfaceSource !== source) return;
      const ready = this.deferredSurfaceReady;
      this.clearDeferredSurfaceAdoption();
      this.pendingSurfaceSource = null;
      this.pendingSurfaceKey = null;
      ready?.(adopted);
    };
    const tryAdopt = () => {
      if (this.pendingSurfaceSource !== source) return;
      const key = this.pendingSurfaceKey;
      if (source.isSurfaceCurrent(key)) {
        settle(source.copySurfacesTo(this, key));
        return;
      }
      if (!source.isSurfacePaintPending() && !source.getCanvasElement()) {
        settle(false);
      }
    };
    this.deferredSurfaceUnsubscribe = source.onSurfaceChange(current => {
      if (!current) {
        // A replaced/detached source can only recover if it queued another
        // paint. Otherwise the caller must paint this canvas itself.
        if (!source.isSurfacePaintPending()) settle(false);
        return;
      }
      tryAdopt();
    });
    // A preview that never reports completion must not leave the live canvas
    // blank forever. Fall back to the caller's sliced live paint.
    this.deferredSurfaceTimer = setTimeout(() => {
      this.deferredSurfaceTimer = null;
      if (this.pendingSurfaceSource !== source) return;
      settle(false);
    }, 1200);
  }

  private clearDeferredSurfaceAdoption(): void {
    this.deferredSurfaceUnsubscribe?.();
    this.deferredSurfaceUnsubscribe = null;
    if (this.deferredSurfaceTimer !== null) {
      clearTimeout(this.deferredSurfaceTimer);
      this.deferredSurfaceTimer = null;
    }
    this.deferredSurfaceReady = null;
  }

  private cancelDeferredSurfaceAdoption(): void {
    this.clearDeferredSurfaceAdoption();
    this.pendingSurfaceSource = null;
    this.pendingSurfaceKey = null;
  }

  /**
   * Copy the complete rendered surface (main canvas plus every attached layer)
   * into another engine. Page-owned previews may be rasterized at a lower
   * backing scale than the focused live surface, so compatible aspect ratios
   * are resampled instead of forcing a full scene replay. A genuinely
   * different page geometry returns false and the caller redraws normally.
   */
  copySurfacesTo(target: DrawingEngine, key?: unknown): boolean {
    if (!this.canvas || !target.canvas || !target.ctx) return false;

    const pairs: Array<[HTMLCanvasElement, CanvasRenderingContext2D]> = [[this.canvas, target.ctx]];
    for (const [id, targetLayer] of target.layerCanvases) {
      const sourceLayer = this.layerCanvases.get(id);
      if (!sourceLayer) return false;
      pairs.push([sourceLayer.canvas, targetLayer]);
    }

    const compatible = ([source, destination]: [HTMLCanvasElement, CanvasRenderingContext2D]) => {
      const width = source.width, height = source.height;
      const targetWidth = destination.canvas.width, targetHeight = destination.canvas.height;
      if (!width || !height || !targetWidth || !targetHeight) return false;
      return Math.abs(width / height - targetWidth / targetHeight) <= 0.01;
    };
    if (!pairs.every(compatible)) return false;

    for (const [source, destination] of pairs) {
      const width = source.width, height = source.height;
      const targetWidth = destination.canvas.width, targetHeight = destination.canvas.height;
      destination.save();
      destination.setTransform(1, 0, 0, 1, 0, 0);
      destination.clearRect(0, 0, targetWidth, targetHeight);
      if (width === targetWidth && height === targetHeight) destination.drawImage(source, 0, 0);
      else destination.drawImage(source, 0, 0, width, height, 0, 0, targetWidth, targetHeight);
      destination.restore();
    }
    target.cancelPaint();
    target.markSurfaceCurrent(key);
    return true;
  }

  /** Get all strokes (for serialization). */
  getStrokes(): Stroke[] {
    return this.strokes;
  }

  getStrokeById(id: string): Stroke | undefined {
    return this.strokeMap.get(id);
  }

  getStrokeBounds(stroke: Stroke): EraseBounds {
    return this.getCachedEraseBounds(stroke);
  }

  getStrokePointBounds(stroke: Stroke): { x: number; y: number; width: number; height: number } | null {
    if (!stroke || stroke.points.length === 0) return null;
    return this.getCachedStrokeMetrics(stroke).pointBounds;
  }

  /** Set strokes (from deserialization). Redraws. */
  setStrokes(strokes: Stroke[], pathSource?: DrawingEngine, repaint = true): void {
    // Snapshot cloning deliberately detaches mutable scene data. Retain only
    // validated geometry across those clones, bounded to the incoming page.
    this.retainStrokePaths(this);
    if (pathSource) this.retainStrokePaths(pathSource);
    const ids = new Set(strokes.map(stroke => stroke.id));
    for (const id of this.retainedInkPaths.keys()) if (!ids.has(id)) this.retainedInkPaths.delete(id);
    for (const id of this.retainedStrokeMetrics.keys()) if (!ids.has(id)) this.retainedStrokeMetrics.delete(id);
    this.strokes = strokes;
    this.strokeMap.clear();
    for (const stroke of strokes) {
      this.strokeMap.set(stroke.id, stroke);
      // Incoming strokes are already detached from persisted/page-cache data.
      // Register the detached header now so the first autosave does not walk
      // every sample of a dense page.
      primeCachedStrokeSnapshot(stroke);
    }
    this.invalidateRenderedSurface();
    if (repaint) this.requestRedraw();
  }

  retainStrokePaths(source: DrawingEngine): void {
    for (const stroke of source.strokes) {
      const path = source.inkPaths.get(stroke) ?? source.retainedInkPaths.get(stroke.id) ?? sharedInkPaths.get(stroke.points);
      if (path) this.retainedInkPaths.set(stroke.id, path);
      const metrics = source.strokeBoundsCache.get(stroke)
        ?? source.retainedStrokeMetrics.get(stroke.id)
        ?? sharedStrokeMetrics.get(stroke.points);
      if (metrics) this.retainedStrokeMetrics.set(stroke.id, metrics);
    }
  }

  /** Drop geometry caches for one stroke after an in-place point/clip edit. */
  invalidateStrokeGeometry(id: string): void {
    const stroke = this.strokeMap.get(id);
    if (!stroke) return;
    this.inkPaths.delete(stroke);
    this.retainedInkPaths.delete(id);
    this.strokeBoundsCache.delete(stroke);
    this.retainedStrokeMetrics.delete(id);
    sharedInkPaths.delete(stroke.points);
    sharedStrokeMetrics.delete(stroke.points);
    invalidateCachedStrokeSnapshot(stroke);
  }

  /** Drop the persistence snapshot after an appearance-only stroke edit. */
  invalidateStrokeSnapshot(id: string): void {
    const stroke = this.strokeMap.get(id);
    if (stroke) invalidateCachedStrokeSnapshot(stroke);
  }

  /** Register a just-replaced, detached stroke as its own snapshot. */
  primeStrokeSnapshot(id: string): void {
    const stroke = this.strokeMap.get(id);
    if (stroke) primeCachedStrokeSnapshot(stroke);
  }

  getLayerManager(): LayerManager { return this.layerManager; }

  /** Add a completed stroke. Does NOT redraw — caller should call redraw() or render incrementally. */
  addStroke(stroke: Stroke): void {
    const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    stroke.layerId ??= this.layerManager.getActiveLayerId();
    this.strokes.push(stroke);
    this.strokeMap.set(stroke.id, stroke);
    // A completed stroke is detached from page-cache/persistence data. Sharing
    // its numeric arrays with the next snapshot avoids re-cloning every sample.
    primeCachedStrokeSnapshot(stroke);
    this.invalidateRenderedSurface();
    if (startedAt) gate0Profiler.event('add-stroke', performance.now() - startedAt, { points: stroke.points.length });
  }

  canEditActiveLayer(): boolean {
    return this.layerManager.isEditable(this.layerManager.getActiveLayerId());
  }

  /** Place reusable content in the visible part of this mounted page. */
  getInsertionPoint(width = 220, height = 180): { x: number; y: number } {
    if (!this.canvas) return { x: 40, y: 40 };
    const rect = this.canvas.getBoundingClientRect();
    const x = (Math.max(0, rect.left) + Math.min(window.innerWidth, rect.right)) / 2 - rect.left;
    const y = (Math.max(0, rect.top) + Math.min(window.innerHeight, rect.bottom)) / 2 - rect.top;
    const point = this.viewport.canvasToPage(x * this.canvasCssWidth / rect.width, y * this.canvasCssHeight / rect.height);
    return { x: Math.max(20, point.x - width / 2), y: Math.max(20, point.y - height / 2) };
  }

  /** Remove a stroke by ID. Returns the removed stroke or undefined. */
  removeStroke(id: string): Stroke | undefined {
    const index = this.strokes.findIndex(s => s.id === id);
    if (index === -1) return undefined;
    const [removed] = this.strokes.splice(index, 1);
    this.strokeMap.delete(id);
    this.retainedInkPaths.delete(id);
    this.retainedStrokeMetrics.delete(id);
    this.invalidateRenderedSurface();
    return removed;
  }

  /** Remove multiple strokes by ID. Returns removed strokes. */
  removeStrokes(ids: Set<string>): Stroke[] {
    const removed: Stroke[] = [];
    this.strokes = this.strokes.filter(s => {
      if (ids.has(s.id)) {
        this.strokeMap.delete(s.id);
        this.retainedInkPaths.delete(s.id);
        this.retainedStrokeMetrics.delete(s.id);
        removed.push(s);
        return false;
      }
      return true;
    });
    if (removed.length) this.invalidateRenderedSurface();
    return removed;
  }

  /** Clear all strokes. Returns removed strokes for undo. */
  clearStrokes(): Stroke[] {
    const removed = this.strokes;
    this.strokes = [];
    this.strokeMap.clear();
    this.retainedInkPaths.clear();
    this.retainedStrokeMetrics.clear();
    this.invalidateRenderedSurface();
    return removed;
  }

  private strokeBoundsCache = new WeakMap<Stroke, StrokeMetricsEntry>();
  private retainedStrokeMetrics = new Map<string, StrokeMetricsEntry>();
  private getCachedStrokeMetrics(stroke: Stroke): StrokeMetricsEntry {
    const first = stroke.points[0];
    const last = stroke.points[stroke.points.length - 1];
    const key = this.strokeGeometryKey(stroke);
    const cached = this.strokeBoundsCache.get(stroke)
      ?? this.retainedStrokeMetrics.get(stroke.id)
      ?? sharedStrokeMetrics.get(stroke.points);
    if (cached && cached.key === key && first && last
      && cached.firstX === first.x && cached.firstY === first.y
      && cached.lastX === last.x && cached.lastY === last.y
      && cached.length === stroke.points.length) {
      return cached;
    }
    const halfWidth = getStrokeRenderHalfWidth(stroke);
    const bounds = eraseBoundsWithHalfWidth(stroke, halfWidth);
    const pad = halfWidth + 2;
    const minX = bounds.left + pad;
    const maxX = bounds.right - pad;
    const minY = bounds.top + pad;
    const maxY = bounds.bottom - pad;
    const pointBounds = {
      x: minX,
      y: minY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };
    const metrics: StrokeMetricsEntry = {
      key,
      firstX: first?.x ?? 0, firstY: first?.y ?? 0,
      lastX: last?.x ?? 0, lastY: last?.y ?? 0,
      length: stroke.points.length, bounds, halfWidth, pointBounds,
    };
    if (first) {
      this.strokeBoundsCache.set(stroke, metrics);
      this.retainedStrokeMetrics.set(stroke.id, metrics);
      sharedStrokeMetrics.set(stroke.points, metrics);
    }
    return metrics;
  }
  private getCachedEraseBounds(stroke: Stroke): EraseBounds {
    return this.getCachedStrokeMetrics(stroke).bounds;
  }
  private getCachedRenderHalfWidth(stroke: Stroke): number {
    return this.getCachedStrokeMetrics(stroke).halfWidth;
  }

  /** Full redraw of all strokes. */
  redraw(dirty?: EraseBounds, boundsForStroke?: (stroke: Stroke) => EraseBounds, excludeIds?: Set<string>): void {
    const deferredReady = this.deferredSurfaceReady;
    const completion = this.redrawCompletion;
    this.redrawCompletion = null;
    if (deferredReady) {
      // Interaction arrived before the preview finished. The live surface has
      // no pixels yet, so a dirty-only repaint would leave it mostly blank.
      this.clearDeferredSurfaceAdoption();
      this.pendingSurfaceSource = null;
      this.pendingSurfaceKey = null;
      dirty = undefined;
      boundsForStroke = undefined;
    }
    this.cancelProgressivePaint();
    if (!this.ctx || !this.canvas) {
      deferredReady?.(false);
      completion?.();
      return;
    }

    if (this.isSelectionDragging && !dirty) {
      if (!this.selectionBackingReady) this.prepareSelectionBacking();
      if (this.selectionBackingCanvas) {
      this.ctx.save();
      this.ctx.resetTransform();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(this.selectionBackingCanvas, 0, 0);
      this.ctx.restore();
      this.ctx.save();
      this.viewport.applyTransform(this.ctx);
      const t = this.selectionEngine?.getCurrentDragTransform();
      for (const id of this.selectionExcludeIds) {
        const stroke = this.getStrokeById(id);
        if (stroke) {
          this.renderTransformingStroke(this.ctx, stroke, t);
          continue;
        }
        const shape = this.shapeManager.getShape(id);
        if (shape) {
          this.shapeManager.renderShape(this.ctx, shape);
          continue;
        }
        const image = this.imageManager.getImage(id);
        if (image) {
          this.imageManager.renderImage(this.ctx, image);
          continue;
        }
      }
      this.ctx.restore();
      if (this.selectionEngine) {
        this.selectionEngine.renderSelection(this.ctx);
      }
      this.renderTransientOverlays();
      deferredReady?.(true);
      completion?.();
      return;
      }
    }

    const profileStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    const historicalPoints = profileStartedAt
      ? this.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0)
      : 0;
    // Clip every backing surface in page space, keeping its existing DPR transform.
    // Repaint all contributors inside the damage, preserving transparency and z-order.
    const surfaces = dirty ? [this.ctx, ...this.layerCanvases.values()] : [];
    let cullBounds = dirty;
    for (const surface of surfaces) {
      surface.save();
      const transform = surface.getTransform();
      this.viewport.applyTransform(surface);
      const pageTransform = surface.getTransform();
      const corners = [[dirty!.left,dirty!.top],[dirty!.right,dirty!.top],[dirty!.right,dirty!.bottom],[dirty!.left,dirty!.bottom]]
        .map(([x,y]) => ({x:pageTransform.a*x+pageTransform.c*y+pageTransform.e,y:pageTransform.b*x+pageTransform.d*y+pageTransform.f}));
      const left = Math.floor(Math.min(...corners.map(p=>p.x))), top = Math.floor(Math.min(...corners.map(p=>p.y)));
      const right = Math.ceil(Math.max(...corners.map(p=>p.x))), bottom = Math.ceil(Math.max(...corners.map(p=>p.y)));
      const inverse = pageTransform.inverse();
      const pageCorners = [[left,top],[right,top],[right,bottom],[left,bottom]].map(([x,y]) => ({
        x:inverse.a*x+inverse.c*y+inverse.e,y:inverse.b*x+inverse.d*y+inverse.f,
      }));
      cullBounds = {left:Math.min(cullBounds!.left,...pageCorners.map(p=>p.x)),top:Math.min(cullBounds!.top,...pageCorners.map(p=>p.y)),
        right:Math.max(cullBounds!.right,...pageCorners.map(p=>p.x)),bottom:Math.max(cullBounds!.bottom,...pageCorners.map(p=>p.y))};
      surface.resetTransform();
      surface.beginPath();
      surface.rect(left,top,right-left,bottom-top);
      surface.clip();
      surface.setTransform(transform);
    }
    this.ctx.clearRect(0, 0, this.canvasCssWidth, this.canvasCssHeight);
    
    // Save context state before applying viewport transform
    // INVARIANT: All stroke points, shape bounds, and image rectangles exist strictly in Page Space.
    // Viewport zoom, pan offsets, and device pixel ratio (DPR) are applied via viewport.applyTransform(ctx).
    this.ctx.save();
    this.viewport.applyTransform(this.ctx);

    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    const windowBounds = this.viewport.getRenderWindowBounds();
    const getBounds = boundsForStroke ?? (s => this.getCachedEraseBounds(s));

    // INVARIANT: Layer render order determines Z-index. Bottom layer (0) renders first.
    // Within each layer, entities render in deterministic order: Images -> Strokes -> Shapes.
    for (const layer of this.layerManager.getLayers()) {
      const layerCtx = this.layerCanvases.get(layer.id);
      if (layerCtx) layerCtx.clearRect(0, 0, this.canvasCssWidth, this.canvasCssHeight);
      if (!layer.visible) continue;
      const ctx = layerCtx ?? this.ctx;
      if (layerCtx) { ctx.save(); this.viewport.applyTransform(ctx); }
      this.imageManager.renderImages(ctx, layer.id, excludeIds);
      for (const stroke of this.strokes) {
        if (excludeIds && excludeIds.has(stroke.id)) continue;
        if (windowBounds && !boundsOverlap(windowBounds, this.getCachedEraseBounds(stroke))) continue;
        if (cullBounds && !boundsOverlap(cullBounds, getBounds(stroke))) continue;
        const strokeLayerId = stroke.layerId ?? DEFAULT_PAGE_LAYER_ID;
        if (strokeLayerId === layer.id) this.renderStroke(ctx, stroke);
      }
      this.shapeManager.renderShapes(ctx, layer.id, excludeIds);
      if (layerCtx) ctx.restore();
    }

    // Restore context to undo viewport transform before rendering selection boxes
    // Actually SelectionEngine handles viewport transform internally, so we restore first.
    this.ctx.restore();
    
    if (this.selectionEngine) {
      this.selectionEngine.renderSelection(this.ctx);
    }
    this.renderTransientOverlays();
    for (const surface of surfaces) surface.restore();
    if (profileStartedAt) {
      const duration = performance.now() - profileStartedAt;
      gate0Profiler.event('drawing-redraw', duration, {
        strokes: this.strokes.length,
        points: historicalPoints,
        layers: this.layerManager.getLayers().length,
      });
      const active = gate0Profiler.getActive('ink-gesture') ?? gate0Profiler.getActive('eraser-gesture');
      gate0Profiler.increment(active, 'redrawCount');
      gate0Profiler.sample(active, 'redrawDurationMs', duration);
      gate0Profiler.increment(active, 'historicalStrokesTraversed', this.strokes.length);
      gate0Profiler.increment(active, 'historicalPointsTraversed', historicalPoints);
    }
    deferredReady?.(true);
    completion?.();
  }

  private renderTransientOverlays(): void {
    this.renderRulerOverlay();
    this.renderLaserOverlay();
  }

  private redrawLaserFrame(): void {
    if (!this.ctx || !this.canvas) return;
    // Like wet ink, a DOM-backed laser owns a temporary presentation surface.
    // The committed scene stays untouched throughout motion and decay. Bare
    // canvas/export callers keep their existing composite rendering path.
    if (!this.canvas.parentElement || typeof document === 'undefined') {
      this.redraw();
      return;
    }
    if (!this.laserManager.getActiveTrail().length) {
      this.releaseLaserSurface();
      return;
    }
    if (!this.laserCanvas) {
      const canvas = document.createElement('canvas');
      canvas.width = this.canvas.width;
      canvas.height = this.canvas.height;
      canvas.setAttribute('aria-hidden', 'true');
      canvas.dataset.panvasLaserOverlay = '';
      Object.assign(canvas.style, { position: 'absolute', left: this.canvas.style.left || '0px',
        top: this.canvas.style.top || '0px', width: this.canvas.style.width || '100%',
        height: this.canvas.style.height || '100%', pointerEvents: 'none',
        zIndex: getComputedStyle(this.canvas).zIndex });
      this.laserContext = canvas.getContext('2d');
      this.laserCanvas = canvas;
      this.canvas.insertAdjacentElement('afterend', canvas);
    }
    const context = this.laserContext;
    if (!context) return;
    context.resetTransform();
    context.clearRect(0, 0, this.laserCanvas.width, this.laserCanvas.height);
    context.setTransform(this.ctx.getTransform());
    this.viewport.applyTransform(context);
    this.laserManager.render(context, this.viewport.getState().scale);
  }

  private releaseLaserSurface(): void {
    if (this.laserCanvas) {
      this.laserCanvas.remove();
      this.laserCanvas.width = this.laserCanvas.height = 0;
    }
    this.laserCanvas = null;
    this.laserContext = null;
  }

  private renderRulerOverlay(): void {
    if (!this.ctx || !this.rulerManager.getState().enabled) return;
    const themeMode = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light';
    this.ctx.save();
    this.viewport.applyTransform(this.ctx);
    this.rulerManager.render(this.ctx, this.viewport.getState().scale, themeMode);
    this.ctx.restore();
  }

  private renderLaserOverlay(): void {
    if (this.canvas?.parentElement) {
      this.redrawLaserFrame();
      return;
    }
    if (!this.ctx || this.laserManager.getActiveTrail().length === 0) return;
    this.ctx.save();
    this.viewport.applyTransform(this.ctx);
    this.laserManager.render(this.ctx, this.viewport.getState().scale);
    this.ctx.restore();
  }

  /**
   * Render a single stroke onto a context.
   * Used for both full redraws and live drawing previews.
   */
  private pencilSurface?: HTMLCanvasElement;
  // Geometry-only cache. Validation is O(1): selection commits and undo call
  // invalidateStrokeGeometry(), while every other scene edit replaces stroke
  // objects. Sampling every point here used to dominate dense-page redraws.
  private inkPaths = new WeakMap<Stroke, InkPathEntry>();
  private retainedInkPaths = new Map<string, InkPathEntry>();
  private strokeGeometryKey(stroke: Stroke): string {
    return `${stroke.centerline}/${stroke.tool}/${stroke.inkFamily}/${stroke.pattern}/${stroke.thickness}`;
  }
  private inkPath(stroke: Stroke): { path: Path2D; x: number; y: number } | null {
    if (stroke.id === '__live__' || typeof Path2D === 'undefined') return null;
    const key = this.strokeGeometryKey(stroke);
    const cached = this.inkPaths.get(stroke)
      ?? this.retainedInkPaths.get(stroke.id)
      ?? sharedInkPaths.get(stroke.points);
    if (cached && this.inkPathMatches(cached, stroke, key)) {
      this.inkPaths.set(stroke, cached);
      return cached;
    }
    // Path2D retains large coordinates with insufficient precision for narrow
    // pen caps, especially when intersecting a damage clip. Keep distant paths
    // local to their first sample; the existing viewport applies their origin.
    // Ordinary notebook paths retain their exact established rendering.
    const x = Math.abs(stroke.points[0].x) >= 2 ** 20 ? Math.trunc(stroke.points[0].x) : 0;
    const y = Math.abs(stroke.points[0].y) >= 2 ** 20 ? Math.trunc(stroke.points[0].y) : 0;
    const path = new Path2D();
    if (stroke.centerline === 'polyline' && stroke.tool === 'pen' && (!stroke.pattern || stroke.pattern === 'solid')) {
      const geometry = new PenGeometry();
      geometry.update(x || y ? stroke.points.map(point => ({ ...point, x: point.x - x, y: point.y - y })) : stroke.points, stroke.inkFamily === 'brush');
      geometry.trace(path, stroke, 0, stroke.points.length, false);
    } else {
      for (const polygon of buildInkFamilyGeometry(stroke)) {
        polygon.forEach((p,i) => i ? path.lineTo(p.x - x,p.y - y) : path.moveTo(p.x - x,p.y - y));
        path.closePath();
      }
    }
    const first = stroke.points[0];
    const last = stroke.points[stroke.points.length - 1];
    const entry: InkPathEntry = {
      key, path, x, y,
      length: stroke.points.length,
      firstX: first.x, firstY: first.y, firstPressure: first.pressure, firstT: first.t,
      lastX: last.x, lastY: last.y, lastPressure: last.pressure, lastT: last.t,
    };
    this.inkPaths.set(stroke, entry);
    sharedInkPaths.set(stroke.points, entry);
    // The path traversal already touched every sample. Warm the hit-testing
    // metrics here so the first selection/erase click does not pay a second
    // full-page scan after a page mount.
    this.getCachedStrokeMetrics(stroke);
    return { path, x, y };
  }
  private inkPathMatches(cached: InkPathEntry, stroke: Stroke, key: string): boolean {
    if (cached.key !== key || cached.length !== stroke.points.length) return false;
    const first = stroke.points[0];
    const last = stroke.points[stroke.points.length - 1];
    return cached.firstX === first.x && cached.firstY === first.y
      && cached.firstPressure === first.pressure && cached.firstT === first.t
      && cached.lastX === last.x && cached.lastY === last.y
      && cached.lastPressure === last.pressure && cached.lastT === last.t;
  }
  private fillInkPath(ctx: CanvasRenderingContext2D, path: { path: Path2D; x: number; y: number }): void {
    if (path.x || path.y) {
      // Compose the cancelling origins in double precision before sending the
      // small final matrix to the canvas rasterizer.
      const transform = ctx.getTransform();
      transform.translateSelf(path.x, path.y);
      ctx.setTransform(transform);
    }
    ctx.fill(path.path);
  }

  private renderTransformingStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, t?: any): void {
    const cached = this.retainedInkPaths.get(stroke.id) ?? this.inkPaths.get(stroke);
    const color = this.fullDarkView ? fullDarkInkColor(stroke.color) : stroke.color;
    ctx.save();
    if (t) {
      if (t.mode === 'move') {
        ctx.translate(t.dx, t.dy);
      } else if (t.mode === 'rotate' && t.center && t.cos !== undefined && t.sin !== undefined) {
        const deltaRad = Math.atan2(t.sin, t.cos);
        ctx.translate(t.center.x, t.center.y);
        ctx.rotate(deltaRad);
        ctx.translate(-t.center.x, -t.center.y);
      } else if (t.mode === 'scale' && t.scaleX !== undefined && t.scaleY !== undefined && t.transX !== undefined && t.transY !== undefined) {
        ctx.translate(t.transX, t.transY);
        ctx.scale(t.scaleX, t.scaleY);
        ctx.translate(-t.transX, -t.transY);
      }
    }
    if (!cached) {
      this.renderStroke(ctx, stroke);
      ctx.restore();
      return;
    }
    traceInkClip(ctx, stroke);
    ctx.globalAlpha = stroke.opacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    this.fillInkPath(ctx, cached);
    ctx.restore();
  }

  private renderDot(
    ctx: CanvasRenderingContext2D,
    point: StrokePoint,
    tool: DrawingToolId,
    color: string,
    thickness: number,
    opacity: number,
    _inkFamily?: InkFamily,
  ): void {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    if (tool === 'highlighter') {
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha *= 0.4;
      const size = Math.max(8, thickness * 6);
      ctx.fillRect(point.x - size / 2, point.y - size / 2, size, size);
    } else if (tool === 'pencil') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha *= 0.75;
      const radius = Math.max(0.3, thickness * (point.pressure ?? 0.5) * 0.75);
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    } else if (tool === 'marker') {
      ctx.globalCompositeOperation = 'source-over';
      const radius = Math.max(2, thickness * 1.5);
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.globalCompositeOperation = 'source-over';
      const radius = Math.max(0.5, thickness * (point.pressure ?? 0.5));
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  renderStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
    const { points, thickness, opacity, tool } = stroke;
    const color = this.fullDarkView ? fullDarkInkColor(stroke.color) : stroke.color;
    if (!points || points.length === 0) return;
    if (stroke.centerline === 'polyline' && tool === 'pen' && (!stroke.pattern || stroke.pattern === 'solid')) {
      ctx.save();
      traceInkClip(ctx, stroke);
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = color;
      const path = this.inkPath(stroke);
      if (path) this.fillInkPath(ctx, path);
      else {
        const geometry = new PenGeometry();
        geometry.update(points);
        ctx.beginPath();
        geometry.trace(ctx, stroke);
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    if (points.length === 1) {
      ctx.save();
      traceInkClip(ctx, stroke);
      if (stroke.inkFamily) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = opacity;
        ctx.fillStyle = color;
        const width = inkSampleWidths(stroke)[0];
        const point = points[0];
        if (stroke.inkFamily === 'felt') ctx.fillRect(point.x - width / 2, point.y - width / 2, width, width);
        else {
          ctx.beginPath();
          ctx.arc(point.x, point.y, width / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      } else this.renderDot(ctx, points[0], tool, color, thickness, opacity);
      ctx.restore();
      return;
    }

    ctx.save();
    traceInkClip(ctx, stroke);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = opacity;
    ctx.setLineDash([]);

    if (stroke.inkFamily) {
      ctx.fillStyle = color;
      const path = this.inkPath(stroke);
      if (path) { this.fillInkPath(ctx, path); ctx.restore(); return; }
      ctx.beginPath();
      for (const polygon of buildInkFamilyGeometry(stroke)) {
        polygon.forEach((point, i) => i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
        ctx.closePath();
      }
      ctx.fill(); ctx.restore(); return;
    }
    if (stroke.pattern === 'dashed'  || stroke.pattern === 'dotted') {
      this.renderPatternedStroke(ctx, this.displayStroke(stroke));
      ctx.restore();
      return;
    }

    switch (tool) {
      case 'pen':
        this.renderPenStroke(ctx, points, color, thickness);
        break;
      case 'pencil':
        // Rasterize the original grain before applying the retained vector domain.
        // Skia clips stroked thin lines before rasterizing, changing their grain
        // even far inside a clip. This transient surface keeps that coverage stable;
        // only vector contours (never this bitmap) are persisted.
        this.pencilSurface ??= document.createElement('canvas');
        if (this.pencilSurface.width !== ctx.canvas.width) this.pencilSurface.width = ctx.canvas.width;
        if (this.pencilSurface.height !== ctx.canvas.height) this.pencilSurface.height = ctx.canvas.height;
        {
          const pencil = this.pencilSurface.getContext('2d')!;
          pencil.resetTransform();
          pencil.clearRect(0, 0, pencil.canvas.width, pencil.canvas.height);
          pencil.save();
          pencil.setTransform(ctx.getTransform());
          pencil.globalAlpha = opacity;
          pencil.lineCap = 'round';
          pencil.lineJoin = 'round';
          this.renderPencilStroke(pencil, points, color, thickness);
          pencil.restore();
          ctx.resetTransform();
          ctx.globalAlpha = 1;
          ctx.drawImage(this.pencilSurface, 0, 0);
        }
        break;
      case 'highlighter':
        this.renderHighlighterStroke(ctx, points, color, thickness);
        break;
      case 'marker':
        this.renderMarkerStroke(ctx, points, color, thickness);
        break;
      case 'eraser':
        this.renderEraserStroke(ctx, points, thickness);
        break;
      case 'laser':
        // Laser trails are rendered only by LaserManager and are never strokes.
        break;
    }

    ctx.restore();
  }

  private renderPatternedStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
    const pattern = stroke.pattern as Exclude<StrokePattern, 'solid'>;
    const geometry = buildStrokePatternGeometry(stroke.points, pattern, stroke.thickness);
    const pressureAware = stroke.tool === 'pen' || stroke.tool === 'pencil';
    const widthMultiplier = stroke.tool === 'highlighter' ? 6 : stroke.tool === 'marker' ? 3 : stroke.tool === 'pencil' ? 1.5 : 2;
    const minimumWidth = stroke.tool === 'highlighter' ? 8 : stroke.tool === 'marker' ? 4 : 0.5;
    const renderedWidth = (pressure: number) => Math.max(
      minimumWidth,
      stroke.thickness * widthMultiplier * (pressureAware ? pressure : 1),
    );

    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.globalCompositeOperation = stroke.tool === 'highlighter' ? 'multiply' : 'source-over';
    if (stroke.tool === 'highlighter') ctx.globalAlpha *= 0.4;
    if (stroke.tool === 'pencil') ctx.globalAlpha *= 0.75;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (pattern === 'dotted') {
      for (const point of geometry.dots) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, renderedWidth(point.pressure) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    for (const dash of geometry.dashes) {
      if (dash.length < 2) continue;
      ctx.beginPath();
      ctx.lineWidth = renderedWidth(dash.reduce((sum, point) => sum + point.pressure, 0) / dash.length);
      ctx.moveTo(dash[0].x, dash[0].y);
      for (let index = 1; index < dash.length; index += 1) ctx.lineTo(dash[index].x, dash[index].y);
      ctx.stroke();
    }
  }

  // ---- Pen: smooth pressure-variable strokes ----

  private renderPenStroke(ctx: CanvasRenderingContext2D, points: StrokePoint[], color: string, baseThickness: number): void {
    ctx.strokeStyle = color;
    ctx.globalCompositeOperation = 'source-over';

    // Draw variable-width segments
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const width = baseThickness * curr.pressure * 2;

      ctx.beginPath();
      ctx.lineWidth = Math.max(0.5, width);
      ctx.moveTo(prev.x, prev.y);

      // Use quadratic curve for smoothness if we have a next point
      if (i + 1 < points.length) {
        const next = points[i + 1];
        const midX = (curr.x + next.x) / 2;
        const midY = (curr.y + next.y) / 2;
        ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
      } else {
        ctx.lineTo(curr.x, curr.y);
      }

      ctx.stroke();
    }
  }

  // ---- Pencil: jittered edges, slightly grainy ----

  private renderPencilStroke(ctx: CanvasRenderingContext2D, points: StrokePoint[], color: string, baseThickness: number): void {
    ctx.strokeStyle = color;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha *= 0.75; // Pencil is slightly transparent

    // Draw multiple thin overlapping lines for grainy effect
    const passes = 2;
    for (let pass = 0; pass < passes; pass++) {
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const width = baseThickness * p.pressure * 1.5;
        ctx.lineWidth = Math.max(0.3, width / passes);

        // Point identity, not the local array index, owns the grain. Splitting a stroke
        // therefore cannot change the appearance of points outside the erased region.
        const jittered = getPencilRenderPoint(p, pass);

        if (i === 0) {
          ctx.moveTo(jittered.x, jittered.y);
        } else {
          ctx.lineTo(jittered.x, jittered.y);
        }
      }
      ctx.stroke();
    }
  }

  // ---- Highlighter: multiply blending, wide semi-transparent ----

  private renderHighlighterStroke(ctx: CanvasRenderingContext2D, points: StrokePoint[], color: string, baseThickness: number): void {
    ctx.strokeStyle = color;
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha *= 0.4;
    ctx.lineWidth = Math.max(8, baseThickness * 6);
    ctx.lineCap = 'square';

    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) {
        ctx.moveTo(p.x, p.y);
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
  }

  // ---- Marker: solid wide strokes, flat caps, no pressure ----

  private renderMarkerStroke(ctx: CanvasRenderingContext2D, points: StrokePoint[], color: string, baseThickness: number): void {
    ctx.strokeStyle = color;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = Math.max(4, baseThickness * 3);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'bevel';

    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) {
        ctx.moveTo(p.x, p.y);
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
  }

  // ---- Eraser: pixel punch-out ----

  private renderEraserStroke(ctx: CanvasRenderingContext2D, points: StrokePoint[], baseThickness: number): void {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = Math.max(2, baseThickness * 3);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 1;

    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) {
        ctx.moveTo(p.x, p.y);
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
  }

  // ---- Live Drawing Preview ----

  /** Start a wet-ink session. Solid pens leave the committed scene untouched;
   * patterned/non-pen previews allocate their legacy snapshot lazily. */
  beginLiveStroke(trace: HandwritingTrace | null = null): void {
    this.endLiveStroke();
    this.isLiveDrawing = true;
    this.liveTrace = trace;
    this.lastFrameAt = 0;
  }

  private ensureLegacySnapshot(): void {
    if (!this.canvas || !this.ctx) return;
    if (this.liveSnapshotCanvas) return;
    const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    this.isLiveDrawing = true;
    const targetCtx = this.layerCanvases.get(this.layerManager.getActiveLayerId()) ?? this.ctx;
    const targetCanvas = targetCtx.canvas;
    if (!this.liveSnapshotCanvas) {
      this.liveSnapshotCanvas = document.createElement('canvas');
    }
    if (this.liveSnapshotCanvas.width !== targetCanvas.width || this.liveSnapshotCanvas.height !== targetCanvas.height) {
      this.liveSnapshotCanvas.width = targetCanvas.width;
      this.liveSnapshotCanvas.height = targetCanvas.height;
    }
    const snapCtx = this.liveSnapshotCanvas.getContext('2d');
    if (snapCtx) {
      snapCtx.resetTransform();
      const clearStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
      snapCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
      const clearMs = clearStartedAt ? performance.now() - clearStartedAt : 0;
      const drawStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
      snapCtx.drawImage(targetCanvas, 0, 0);
      const active = gate0Profiler.getActive('ink-gesture');
      gate0Profiler.sample(active, 'beginSnapshotClearMs', clearMs);
      gate0Profiler.sample(active, 'beginSnapshotDrawImageMs', drawStartedAt ? performance.now() - drawStartedAt : 0);
      gate0Profiler.increment(active, 'snapshotPixelsCopied', targetCanvas.width * targetCanvas.height);
      gate0Profiler.annotate(active, {
        canvasBackingWidth: targetCanvas.width,
        canvasBackingHeight: targetCanvas.height,
        canvasBackingPixels: targetCanvas.width * targetCanvas.height,
        effectiveDpr: window.devicePixelRatio || 1,
        layerCount: this.layerManager.getLayers().length,
        beginLiveStrokeMs: startedAt ? performance.now() - startedAt : 0,
      });
    }
  }

  private releaseSpareWetInk(): void {
    if (this.spareWetInkTimer !== null) clearTimeout(this.spareWetInkTimer);
    this.spareWetInkTimer = null;
    this.spareWetInk?.dispose();
    this.spareWetInk = null;
  }

  /** Remove wet presentation immediately; reuse its buffers only during a
   * short handwriting burst, then release the backing memory when idle. */
  endLiveStroke(): void {
    if (this.liveFrame !== null) cancelAnimationFrame(this.liveFrame);
    this.liveFrame = null;
    this.pendingInk = null;
    this.lastLiveInk = null;
    if (this.wetInk) {
      this.releaseSpareWetInk();
      if (this.wetInk.target.canvas.isConnected) {
        this.wetInk.pause();
        this.spareWetInk = this.wetInk;
        this.spareWetInkTimer = setTimeout(() => this.releaseSpareWetInk(), 30000);
      } else this.wetInk.dispose();
    }
    this.wetInk = null;
    this.liveTrace = null;
    this.isLiveDrawing = false;
    this.liveSnapshotCanvas = null;
  }

  /** One presentation per frame; all accepted geometry remains in points. */
  renderLiveStroke(points: StrokePoint[], tool: DrawingToolId, color: string, thickness: number,
    opacity: number, pattern: StrokePattern = 'solid', inkFamily?: InkFamily, _liveTip?: StrokePoint, revisedFrom = Infinity): void {
    if (!this.ctx || !this.canvas) return;
    this.pendingInk = { id: '__live__', type: 'stroke', points, tool, color, thickness, opacity,
      pattern, inkFamily, centerline: 'polyline', createdAt: 0 };
    this.pendingLiveRevisionFrom = revisedFrom;
    this.lastLiveInk = this.pendingInk;
    const ctx = this.layerCanvases.get(this.layerManager.getActiveLayerId()) ?? this.ctx;
    const isFastWetInk = tool === 'pen' && pattern === 'solid' && Boolean(ctx.canvas.parentElement);
    if (isFastWetInk) {
      if (this.liveFrame !== null) {
        cancelAnimationFrame(this.liveFrame);
        this.liveFrame = null;
      }
      this.frameQueuedAt = 0;
      this.flushLiveInk();
      return;
    }
    if (this.liveFrame !== null) return;
    this.frameQueuedAt = performance.now();
    this.liveFrame = requestAnimationFrame(() => {
      this.liveFrame = null;
      this.flushLiveInk();
    });
  }
  /** Rebuild presentation atomically; logical samples and pointer capture stay owned. */
  rebaseLiveSurface(): void {
    const stroke = this.lastLiveInk, trace = this.liveTrace;
    this.endLiveStroke(); this.releaseSpareWetInk(); this.redraw();
    if (!stroke) return;
    this.liveTrace = trace;
    this.renderLiveStroke(stroke.points, stroke.tool, stroke.color, stroke.thickness, stroke.opacity, stroke.pattern, stroke.inkFamily);
    this.flushLiveInk();
  }

  private flushLiveInk(finalizing = false): void {
    const stroke = this.pendingInk;
    if (!stroke || !this.ctx || !this.canvas) return;
    this.pendingInk = null;
    const revisedFrom = this.pendingLiveRevisionFrom;
    this.pendingLiveRevisionFrom = Infinity;
    const start = performance.now();
    const ctx = this.layerCanvases.get(this.layerManager.getActiveLayerId()) ?? this.ctx;
    const trace = this.liveTrace;
    if (stroke.tool === 'pen' && stroke.pattern === 'solid' && ctx.canvas.parentElement) {
      if (!this.wetInk) {
        ctx.save();
        this.viewport.applyTransform(ctx);
        const transform = ctx.getTransform();
        ctx.restore();
        if (this.spareWetInk?.matches(ctx)) {
          if (this.spareWetInkTimer !== null) clearTimeout(this.spareWetInkTimer);
          this.spareWetInkTimer = null;
          this.wetInk = this.spareWetInk;
          this.spareWetInk = null;
          this.wetInk.resume(transform);
        } else {
          this.releaseSpareWetInk();
          this.wetInk = new WetInkSurface(ctx, transform);
        }
      }
      const work = this.wetInk.render(this.displayStroke(stroke), revisedFrom);
      if (trace) {
        trace.counters.wetPrimitives = (trace.counters.wetPrimitives ?? 0) + work.primitives;
        trace.counters.wetDirtyPixels = (trace.counters.wetDirtyPixels ?? 0) + work.dirtyPixels;
        trace.counters.wetRebuilds = (trace.counters.wetRebuilds ?? 0) + Number(work.rebuilt);
      }
    } else {
      // Patterned and non-pen tools retain their existing appearance, but share
      // frame scheduling. Their geometry is outside the solid-pen prefix path.
      this.ensureLegacySnapshot();
      this.paintLegacyLiveStroke(stroke.points, stroke.tool, stroke.color, stroke.thickness,
        stroke.opacity, stroke.pattern, stroke.inkFamily);
    }
    if (trace) {
      const sample = (name: string, value: number) => (trace.timings[name] ??= []).push(value);
      sample('wetRenderMs', performance.now() - start);
      if (!finalizing) sample('scheduledFrameDelayMs', this.frameQueuedAt ? start - this.frameQueuedAt : 0);
      const raw = trace.raw[trace.raw.length - 1];
      if (raw && start >= raw.timeStamp) sample('eventToFrameMs', start - raw.timeStamp);
      if (this.lastFrameAt && !finalizing) sample('activeFrameIntervalMs', start - this.lastFrameAt);
      trace.frames.push({ time: start, phase: finalizing ? 'commit' : 'frame', points: stroke.points.length,
        terminal: { ...stroke.points[stroke.points.length - 1] } });
      // Preserve exactly what the renderer consumed, including chronological rebuilds.
      if (trace.renderedSource !== stroke.points) trace.rendered = [];
      trace.renderedSource = stroke.points;
      for (let i = trace.rendered.length; i < stroke.points.length; i++) trace.rendered.push({ ...stroke.points[i] });
    }
    this.lastFrameAt = start;
  }

  /** Commit the new mark once. Existing page pixels remain authoritative. */
  commitLiveStroke(stroke: Stroke): void {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.layerCanvases.get(stroke.layerId ?? this.layerManager.getActiveLayerId()) ?? this.ctx;
    // Legacy previews modify the dry surface.
    if (stroke.tool !== 'pen' || (stroke.pattern && stroke.pattern !== 'solid') || !ctx.canvas.parentElement
      || this.liveSnapshotCanvas) {
      this.redraw();
      return;
    }
    // Shapes sit above strokes. Repaint just the new stroke's damage through the
    // existing clipped redraw path, rather than compositing above those shapes.
    if (this.shapeManager.getShapes().some(shape =>
      (shape.layerId ?? DEFAULT_PAGE_LAYER_ID) === (stroke.layerId ?? DEFAULT_PAGE_LAYER_ID))) {
      this.redraw(eraseBounds(stroke), eraseBounds);
      return;
    }
    this.pendingInk = stroke;
    this.flushLiveInk(true);
    if (this.wetInk && this.wetInk.target === ctx) this.wetInk.commit(this.displayStroke(stroke));
    else {
      ctx.save();
      this.viewport.applyTransform(ctx);
      this.renderStroke(ctx, stroke);
      ctx.restore();
    }
    this.renderTransientOverlays();
  }

  /**
   * Draw a stroke-in-progress onto the canvas without adding it to the stroke list.
   * Call this during pointerdown and pointermove for immediate live feedback.
   * After pointerup, call addStroke() and redraw().
   */
  private paintLegacyLiveStroke(
    points: StrokePoint[],
    tool: DrawingToolId,
    color: string,
    thickness: number,
    opacity: number,
    pattern: StrokePattern = 'solid',
    inkFamily?: InkFamily,
    liveTip?: StrokePoint,
  ): void {
    if (!this.ctx || !this.canvas) return;
    const active = gate0Profiler.getActive('ink-gesture');
    const liveStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;

    const ctx = this.layerCanvases.get(this.layerManager.getActiveLayerId()) ?? this.ctx;

    if (this.isLiveDrawing && this.liveSnapshotCanvas) {
      ctx.save();
      ctx.resetTransform();
      const clearStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      const clearMs = clearStartedAt ? performance.now() - clearStartedAt : 0;
      const drawStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
      ctx.drawImage(this.liveSnapshotCanvas, 0, 0);
      const drawMs = drawStartedAt ? performance.now() - drawStartedAt : 0;
      ctx.restore();
      gate0Profiler.sample(active, 'liveSnapshotClearMs', clearMs);
      gate0Profiler.sample(active, 'liveSnapshotDrawImageMs', drawMs);
      gate0Profiler.increment(active, 'snapshotPixelsCopied', ctx.canvas.width * ctx.canvas.height);
    } else {
      this.redraw();
    }

    // Then draw the live stroke on top
    ctx.save();
    this.viewport.applyTransform(ctx);
    const strokePoints = liveTip && points.length > 0 && (points[points.length - 1].x !== liveTip.x || points[points.length - 1].y !== liveTip.y)
      ? [...points, liveTip]
      : points;
    const geometryStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    this.renderStroke(ctx, {
      id: '__live__',
      type: 'stroke',
      tool,
      points: strokePoints,
      color,
      thickness,
      opacity,
      pattern,
      inkFamily,
      createdAt: 0,
    });
    if (geometryStartedAt) gate0Profiler.sample(active, 'liveStrokeGeometryRenderMs', performance.now() - geometryStartedAt);
    gate0Profiler.increment(active, 'renderStrokeCalls');
    gate0Profiler.increment(active, 'renderStrokePointIterations', strokePoints.length);
    ctx.restore();
    this.renderTransientOverlays();
    if (liveStartedAt) {
      gate0Profiler.sample(active, 'liveRenderDurationMs', performance.now() - liveStartedAt);
      gate0Profiler.sample(active, 'liveRenderPointCount', strokePoints.length);
    }
  }

  startLasso(): void {
    if (!this.canvas || !this.ctx || typeof document === 'undefined') return;
    if (!this.lassoBackingCanvas) {
      this.lassoBackingCanvas = document.createElement('canvas');
    }
    if (this.lassoBackingCanvas.width !== this.canvas.width || this.lassoBackingCanvas.height !== this.canvas.height) {
      this.lassoBackingCanvas.width = this.canvas.width;
      this.lassoBackingCanvas.height = this.canvas.height;
    }
    const snapCtx = this.lassoBackingCanvas.getContext('2d');
    if (!snapCtx) return;
    snapCtx.resetTransform();
    snapCtx.clearRect(0, 0, this.lassoBackingCanvas.width, this.lassoBackingCanvas.height);
    snapCtx.drawImage(this.canvas, 0, 0);
    this.isLassoActive = true;
  }

  endLasso(): void {
    this.isLassoActive = false;
  }

  /** Render the transient freehand selection enclosure without persisting page content. */
  renderLasso(points: StrokePoint[]): void {
    if (!this.ctx || !this.canvas) return;

    if (this.isLassoActive && this.lassoBackingCanvas) {
      this.ctx.save();
      this.ctx.resetTransform();
      this.ctx.drawImage(this.lassoBackingCanvas, 0, 0);
      this.ctx.restore();
    } else {
      this.redraw();
    }
    if (points.length < 2) return;

    const scale = this.viewport.getState().scale;
    this.ctx.save();
    this.viewport.applyTransform(this.ctx);
    this.ctx.beginPath();
    this.ctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) {
      this.ctx.lineTo(point.x, point.y);
    }
    this.ctx.closePath();
    this.ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
    this.ctx.strokeStyle = '#3b82f6';
    this.ctx.lineWidth = 1.5 / scale;
    this.ctx.setLineDash([4 / scale, 4 / scale]);
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.restore();
    this.renderTransientOverlays();
  }

  // ---- Hit Testing (for eraser and selection) ----

  /**
   * Find topmost stroke ID near point in reverse z-order, early exiting on first hit.
   */
  findTopmostStrokeNearPoint(x: number, y: number, radius: number, layerId?: string): string | null {
    const strokes = this.strokes;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i];
      const strokeLayer = stroke.layerId ?? DEFAULT_PAGE_LAYER_ID;
      if (layerId !== undefined && strokeLayer !== layerId) continue;
      if (!this.layerManager.isEditable(stroke.layerId)) continue;

      const effectiveRadius = radius + this.getCachedRenderHalfWidth(stroke);
      const bounds = this.getCachedEraseBounds(stroke);
      if (
        x + effectiveRadius < bounds.left ||
        x - effectiveRadius > bounds.right ||
        y + effectiveRadius < bounds.top ||
        y - effectiveRadius > bounds.bottom
      ) {
        continue;
      }

      if (stroke.inkClip && !regionIntersects(strokeRegion(stroke), eraserCapsule({ x, y }, { x, y }, Math.max(radius, 0.01)))) {
        continue;
      }

      const effRadiusSq = effectiveRadius * effectiveRadius;
      const pts = stroke.points;
      if (!pts || pts.length === 0) continue;

      if (pts.length === 1) {
        const dx = pts[0].x - x;
        const dy = pts[0].y - y;
        if (dx * dx + dy * dy <= effRadiusSq) {
          return stroke.id;
        }
        continue;
      }

      for (let j = 0; j < pts.length - 1; j++) {
        const p1 = pts[j];
        const p2 = pts[j + 1];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const lenSq = dx * dx + dy * dy;

        let dpx: number;
        let dpy: number;

        if (lenSq === 0) {
          dpx = x - p1.x;
          dpy = y - p1.y;
        } else {
          let t = ((x - p1.x) * dx + (y - p1.y) * dy) / lenSq;
          t = Math.max(0, Math.min(1, t));
          dpx = x - (p1.x + t * dx);
          dpy = y - (p1.y + t * dy);
        }

        if (dpx * dpx + dpy * dpy <= effRadiusSq) {
          return stroke.id;
        }
      }
    }
    return null;
  }

  /**
   * Find all stroke IDs that are within `radius` CSS pixels of the given point,
   * checking proximity to each line segment plus the stroke's half-thickness.
   */
  findStrokesNearPoint(x: number, y: number, radius: number): string[] {
    const hits: string[] = [];
    const active = gate0Profiler.getActive('eraser-gesture');

    for (const stroke of this.strokes) {
      gate0Profiler.increment(active, 'strokesScanned');
      if (!this.layerManager.isEditable(stroke.layerId)) continue;
      const effectiveRadius = radius + this.getCachedRenderHalfWidth(stroke);
      // Fast AABB rejection using cached stroke bounds
      const bounds = this.getCachedEraseBounds(stroke);
      if (
        x + effectiveRadius < bounds.left ||
        x - effectiveRadius > bounds.right ||
        y + effectiveRadius < bounds.top ||
        y - effectiveRadius > bounds.bottom
      ) {
        continue;
      }
      if (stroke.inkClip && !regionIntersects(strokeRegion(stroke), eraserCapsule({ x, y }, { x, y }, Math.max(radius, 0.01)))) continue;
      const effRadiusSq = effectiveRadius * effectiveRadius;
      const pts = stroke.points;
      gate0Profiler.increment(active, 'strokePointsInspected', pts?.length ?? 0);
      if (!pts || pts.length === 0) continue;

      if (pts.length === 1) {
        const dx = pts[0].x - x;
        const dy = pts[0].y - y;
        if (dx * dx + dy * dy <= effRadiusSq) {
          hits.push(stroke.id);
        }
        continue;
      }

      let hit = false;
      for (let i = 0; i < pts.length - 1; i++) {
        gate0Profiler.increment(active, 'strokeSegmentsInspected');
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const lenSq = dx * dx + dy * dy;

        let dpx: number;
        let dpy: number;

        if (lenSq === 0) {
          dpx = x - p1.x;
          dpy = y - p1.y;
        } else {
          let t = ((x - p1.x) * dx + (y - p1.y) * dy) / lenSq;
          t = Math.max(0, Math.min(1, t));
          dpx = x - (p1.x + t * dx);
          dpy = y - (p1.y + t * dy);
        }

        if (dpx * dpx + dpy * dpy <= effRadiusSq) {
          hit = true;
          break;
        }
      }

      if (hit) {
        hits.push(stroke.id);
        gate0Profiler.increment(active, 'candidateHits');
      }
    }

    return hits;
  }

  /**
   * Find all stroke IDs that have any point inside the given bounding box.
   */
  findStrokesInRect(x: number, y: number, width: number, height: number): string[] {
    const x2 = x + width;
    const y2 = y + height;
    const hits: string[] = [];

    for (const stroke of this.strokes) {
      if (!this.layerManager.isEditable(stroke.layerId)) continue;
      for (const point of stroke.points) {
        if (point.x >= x && point.x <= x2 && point.y >= y && point.y <= y2) {
          hits.push(stroke.id);
          break;
        }
      }
    }

    return hits;
  }
}
