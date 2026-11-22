// ============================================
// Panvas — Viewport Manager
// ============================================
// Manages coordinate transforms between screen space and page space.
// Currently supports 100% zoom only, but the abstraction is designed
// so that pan, zoom, fit-width, fit-page, and multi-page support
// can be added without modifying the drawing engine.

import type { ViewportState } from './drawingTypes.ts';
import { DEFAULT_VIEWPORT_STATE } from './drawingTypes.ts';
import type { PdfPageRotation } from '@/types/notebook';
import { applyPdfRotationTransform, sourceToVisual, visualToSource, type PdfPageDimensions } from './pdfCoordinates.ts';

export type ViewportChangeListener = (state: Readonly<ViewportState>) => void;

export const MAX_CANVAS_DIMENSION = 8192;
export const MAX_ACTIVE_CANVAS_PIXELS = 28_000_000;
export const MAX_INACTIVE_PAGE_RENDER_ZOOM = 1.25;
const RENDER_WINDOW_OVERSCAN_RATIO = 0.45;
const RENDER_WINDOW_EDGE_MARGIN_RATIO = 0.15;
const RENDER_WINDOW_STEP_RATIO = 0.20;

export interface RenderWindowRect {
  left: number;
  top: number;
  width: number;
  height: number;
  windowed: boolean;
}

export interface ResolveViewportRenderWindowOptions {
  pageWidth: number;
  pageHeight: number;
  logicalBase?: number;
  isInfinite?: boolean;
  zoom: number;
  dpr: number;
  browserVisualScale?: number;
  layerCount?: number;
  viewportLocal: { left: number; top: number; width: number; height: number };
  previous?: RenderWindowRect | null;
  forceRebase?: boolean;
}

/**
 * Resolve a screen-space 2D raster window for a page. Keeps full-page backing
 * whenever the page fits inside GPU dimension & pixel budgets at target DPI,
 * and seamlessly windows around the visible viewport at high zoom or large
 * physical/Research-Space page dimensions.
 */
export function resolveViewportRenderWindow({
  pageWidth,
  pageHeight,
  logicalBase = 0,
  isInfinite = false,
  zoom,
  dpr,
  browserVisualScale = 1,
  layerCount = 1,
  viewportLocal,
  previous,
  forceRebase = false,
}: ResolveViewportRenderWindowOptions): RenderWindowRect {
  const safeWidth = Math.max(1, Math.round(pageWidth));
  const safeHeight = Math.max(1, Math.round(pageHeight));
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const safeVisual = Number.isFinite(browserVisualScale) && browserVisualScale > 0 ? browserVisualScale : 1;
  const targetScale = Math.max(0.25, safeDpr * safeZoom * safeVisual);
  const layerPixelBudget = Math.floor(MAX_ACTIVE_CANVAS_PIXELS / Math.max(1, layerCount));

  if (
    !isInfinite
    && safeWidth * safeHeight * targetScale * targetScale <= layerPixelBudget
    && Math.max(safeWidth, safeHeight) * targetScale <= MAX_CANVAS_DIMENSION
  ) {
    if (
      previous
      && !previous.windowed
      && previous.left === 0
      && previous.top === logicalBase
      && previous.width === safeWidth
      && previous.height === safeHeight
    ) {
      return previous;
    }
    return { left: 0, top: logicalBase, width: safeWidth, height: safeHeight, windowed: false };
  }

  const visW = Math.max(1, viewportLocal.width);
  const visH = Math.max(1, viewportLocal.height);
  const maxPageH = isInfinite ? Number.POSITIVE_INFINITY : safeHeight;
  const maxDimDoc = Math.max(64, Math.floor(MAX_CANVAS_DIMENSION / targetScale));

  let desiredW = Math.min(safeWidth, Math.max(Math.min(safeWidth, Math.ceil(visW)), Math.ceil(visW * (1 + 2 * RENDER_WINDOW_OVERSCAN_RATIO))), maxDimDoc);
  let desiredH = Math.min(maxPageH, Math.max(Math.min(maxPageH, Math.ceil(visH)), Math.ceil(visH * (1 + 2 * RENDER_WINDOW_OVERSCAN_RATIO))), maxDimDoc);

  const budgetDocArea = layerPixelBudget / (targetScale * targetScale);
  if (desiredW * desiredH > budgetDocArea && budgetDocArea > 0) {
    const shrink = Math.sqrt(budgetDocArea / (desiredW * desiredH));
    const minCoverW = Math.min(safeWidth, Math.ceil(visW * 1.05));
    const minCoverH = Math.min(maxPageH, Math.ceil(visH * 1.05));
    desiredW = Math.max(Math.min(desiredW, minCoverW), Math.floor(desiredW * shrink));
    desiredH = Math.max(Math.min(desiredH, minCoverH), Math.floor(desiredH * shrink));
  }
  desiredW = Math.max(1, Math.min(safeWidth, Math.round(desiredW)));
  desiredH = Math.max(1, Math.min(maxPageH, Math.round(desiredH)));

  const pageVisLeft = Math.max(0, Math.min(safeWidth, viewportLocal.left));
  const pageVisRight = Math.max(pageVisLeft, Math.min(safeWidth, viewportLocal.left + visW));
  const pageVisTop = Math.max(0, Math.min(maxPageH, viewportLocal.top));
  const pageVisBottom = Math.max(pageVisTop, Math.min(maxPageH, viewportLocal.top + visH));

  if (!forceRebase && previous && previous.windowed) {
    const prevRawTop = previous.top - logicalBase;
    const reqLeft = Math.max(0, pageVisLeft - visW * RENDER_WINDOW_EDGE_MARGIN_RATIO);
    const reqRight = Math.min(safeWidth, pageVisRight + visW * RENDER_WINDOW_EDGE_MARGIN_RATIO);
    const reqTop = Math.max(0, pageVisTop - visH * RENDER_WINDOW_EDGE_MARGIN_RATIO);
    const reqBottom = Math.min(maxPageH, pageVisBottom + visH * RENDER_WINDOW_EDGE_MARGIN_RATIO);
    const coversX = desiredW >= safeWidth
      ? (previous.left === 0 && previous.width === safeWidth)
      : (previous.left <= reqLeft && previous.left + previous.width >= reqRight);
    const coversY = (!isInfinite && desiredH >= safeHeight)
      ? (prevRawTop === 0 && previous.height === safeHeight)
      : (prevRawTop <= reqTop && prevRawTop + previous.height >= reqBottom);
    const sizeMatches =
      Math.abs(previous.width - desiredW) <= Math.max(16, desiredW * 0.15)
      && Math.abs(previous.height - desiredH) <= Math.max(16, desiredH * 0.15);
    if (coversX && coversY && sizeMatches) {
      return previous;
    }
  }

  const centerX = pageVisRight > pageVisLeft
    ? (pageVisLeft + pageVisRight) / 2
    : Math.max(0, Math.min(safeWidth, viewportLocal.left + visW / 2));
  const centerY = pageVisBottom > pageVisTop
    ? (pageVisTop + pageVisBottom) / 2
    : Math.max(0, Math.min(maxPageH, viewportLocal.top + visH / 2));

  const stepX = Math.max(16, Math.round(visW * RENDER_WINDOW_STEP_RATIO));
  const stepY = Math.max(16, Math.round(visH * RENDER_WINDOW_STEP_RATIO));

  let left = 0;
  if (desiredW < safeWidth) {
    const rawLeft = Math.max(0, Math.min(safeWidth - desiredW, centerX - desiredW / 2));
    left = Math.max(0, Math.min(safeWidth - desiredW, Math.round(rawLeft / stepX) * stepX));
    if (desiredW >= pageVisRight - pageVisLeft) {
      left = Math.max(0, Math.min(left, Math.floor(pageVisLeft)));
      left = Math.min(safeWidth - desiredW, Math.max(left, Math.ceil(pageVisRight - desiredW)));
    }
  }

  let rawTop = 0;
  if (isInfinite || desiredH < safeHeight) {
    const maxTop = isInfinite ? Number.POSITIVE_INFINITY : safeHeight - desiredH;
    const unclampedTop = Math.max(0, Math.min(maxTop, centerY - desiredH / 2));
    rawTop = Math.max(0, Math.min(maxTop, Math.round(unclampedTop / stepY) * stepY));
    if (desiredH >= pageVisBottom - pageVisTop) {
      rawTop = Math.max(0, Math.min(rawTop, Math.floor(pageVisTop)));
      rawTop = Math.min(maxTop, Math.max(rawTop, Math.ceil(pageVisBottom - desiredH)));
    }
  }
  const top = logicalBase + rawTop;

  if (
    previous
    && previous.windowed
    && previous.left === left
    && previous.top === top
    && previous.width === desiredW
    && previous.height === desiredH
  ) {
    return previous;
  }
  return { left, top, width: desiredW, height: desiredH, windowed: true };
}

/**
 * Resolve the highest useful backing-store scale that stays within browser/GPU
 * dimension and memory budgets. CSS dimensions remain logical page dimensions;
 * neither zoom nor DPR enters persisted drawing coordinates.
 */
export function resolveCanvasBackingScale(
  devicePixelRatio: number,
  currentZoomScale: number,
  cssWidth: number,
  cssHeight: number,
  browserVisualScale = 1,
  maxPixels = MAX_ACTIVE_CANVAS_PIXELS,
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const zoom = Number.isFinite(currentZoomScale) && currentZoomScale > 0 ? currentZoomScale : 1;
  const visualScale = Number.isFinite(browserVisualScale) && browserVisualScale > 0 ? browserVisualScale : 1;
  const budget = Number.isFinite(maxPixels) && maxPixels > 0 ? maxPixels : MAX_ACTIVE_CANVAS_PIXELS;
  const desiredScale = dpr * zoom * visualScale;
  if (!(cssWidth > 0) || !(cssHeight > 0)) return desiredScale;

  const allowedByDimension = Math.min(
    MAX_CANVAS_DIMENSION / cssWidth,
    MAX_CANVAS_DIMENSION / cssHeight,
  );
  const allowedByPixels = Math.sqrt(budget / (cssWidth * cssHeight));
  return Math.min(desiredScale, allowedByDimension, allowedByPixels);
}

/** A phone's Desktop Site layout is visually shrunk before reaching screen pixels.
 * Apply that scale only to raster detail; document and pointer coordinates stay logical. */
export function getBrowserCanvasVisualScale(): number {
  if (typeof window === 'undefined') return 1;
  const touch = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
    || window.matchMedia?.('(pointer: coarse)').matches
    || window.matchMedia?.('(any-pointer: coarse)').matches;
  const scale = touch ? window.visualViewport?.scale : 1;
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export class ViewportManager {
  private state: ViewportState;
  // Same contract as ToolManager.snapshot: frozen, and its identity changes only when the
  // state does. getState() previously returned `this.state`, so React's viewport mirror was
  // seeded with an alias the engine mutated in place.
  private snapshot: Readonly<ViewportState>;
  private dpr: number;
  private listeners: Set<ViewportChangeListener> = new Set();
  private renderPan = true;
  private renderScale = false;
  private pageRotation: PdfPageRotation = 0;
  private pageWidth = 0;
  private pageHeight = 0;
  private contentOffsetX = 0;
  private contentOffsetY = 0;

  constructor() {
    this.state = { ...DEFAULT_VIEWPORT_STATE };
    this.snapshot = Object.freeze({ ...this.state });
    this.dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  }

  /** Subscribe to viewport state changes. Returns unsubscribe function. */
  subscribe(listener: ViewportChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.snapshot = Object.freeze({ ...this.state });
    const snapshot = this.snapshot;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }


  /** Current device pixel ratio. */
  getDevicePixelRatio(): number {
    return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  }

  getCanvasBackingScale(
    currentZoomScale: number,
    cssWidth: number,
    cssHeight: number,
    maxPixels = MAX_ACTIVE_CANVAS_PIXELS,
  ): number {
    return resolveCanvasBackingScale(this.dpr, currentZoomScale, cssWidth, cssHeight, getBrowserCanvasVisualScale(), maxPixels);
  }

  /** Update DPR (e.g., when window moves between monitors). */
  updateDevicePixelRatio(): void {
    this.dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  }

  /** Get current viewport state. */
  getState(): Readonly<ViewportState> {
    return this.snapshot;
  }

  /** Set zoom level (1 = 100%). Clamped to [0.25, 8]. The canvas backing budget
   *  (resolveCanvasBackingScale) bounds raster detail at high zoom. */
  setZoom(scale: number): void {
    this.state.scale = Math.max(0.25, Math.min(8, scale));
    this.notify();
  }


  /** Set pan offset. */
  setPan(offsetX: number, offsetY: number): void {
    this.state.offsetX = offsetX;
    this.state.offsetY = offsetY;
    this.notify();
  }

  /**
   * PDF pages are positioned and scaled by their DOM wrapper. Keep canvas
   * rendering in the same coordinate space without changing notebook defaults.
   */
  setRenderTransform(options: { pan?: boolean; scale?: boolean }): void {
    if (options.pan !== undefined) this.renderPan = options.pan;
    if (options.scale !== undefined) this.renderScale = options.scale;
  }

  /** Apply a non-destructive PDF page rotation around the source-page origin. */
  setPdfPageRotation(rotation: PdfPageRotation, pageWidth: number, pageHeight: number): void {
    this.setPageCoordinateTransform(rotation, pageWidth, pageHeight, 0, 0);
  }

  /** Place canonical source coordinates inside a larger writable surface. */
  setPageCoordinateTransform(rotation: PdfPageRotation, pageWidth: number, pageHeight: number, offsetX = 0, offsetY = 0): void {
    this.pageRotation = rotation;
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    this.contentOffsetX = offsetX;
    this.contentOffsetY = offsetY;
    if (rotation !== 0) {
      this.renderOriginX = 0;
      this.renderOriginY = 0;
      this.renderWindowWidth = undefined;
      this.renderWindowHeight = undefined;
    }
  }
  private renderOriginX = 0;
  private renderOriginY = 0;
  private renderWindowWidth?: number;
  private renderWindowHeight?: number;
  private canvasBackingSignatures = new WeakMap<
    HTMLCanvasElement,
    { width: number; height: number; backingScale: number; cssWidth: number; cssHeight: number; originX: number; originY: number }
  >();

  /** Transient 2D raster window; persisted coordinates always remain logical. */
  setRenderWindowRect(rect: { left?: number; top?: number; width?: number; height?: number } | null): void {
    if (!rect || this.pageRotation !== 0) {
      this.renderOriginX = 0;
      this.renderOriginY = 0;
      this.renderWindowWidth = undefined;
      this.renderWindowHeight = undefined;
      return;
    }
    this.renderOriginX = typeof rect.left === 'number' && Number.isFinite(rect.left) ? rect.left : 0;
    this.renderOriginY = typeof rect.top === 'number' && Number.isFinite(rect.top) ? rect.top : 0;
    this.renderWindowWidth = typeof rect.width === 'number' && Number.isFinite(rect.width) ? rect.width : undefined;
    this.renderWindowHeight = typeof rect.height === 'number' && Number.isFinite(rect.height) ? rect.height : undefined;
  }

  /** Transient raster window; persisted coordinates always remain logical. */
  setRenderWindowOrigin(y: number, height?: number): void {
    if (height === undefined && (!Number.isFinite(y) || y === 0)) {
      this.setRenderWindowRect(null);
      return;
    }
    this.setRenderWindowRect({ left: 0, top: Number.isFinite(y) ? y : 0, width: undefined, height });
  }

  getRenderWindowOrigin(): { x: number; y: number } {
    return { x: this.renderOriginX, y: this.renderOriginY };
  }

  getRenderWindowBounds(): { left: number; top: number; right: number; bottom: number } | null {
    if (this.renderWindowWidth === undefined && this.renderWindowHeight === undefined) return null;
    const width = this.renderWindowWidth ?? this.pageWidth;
    const height = this.renderWindowHeight ?? this.pageHeight;
    return {
      left: this.renderOriginX - this.contentOffsetX,
      top: this.renderOriginY - this.contentOffsetY,
      right: this.renderOriginX + width - this.contentOffsetX,
      bottom: this.renderOriginY + height - this.contentOffsetY,
    };
  }
  intersectsRenderWindow(object: { x: number; y: number; width: number; height: number; rotation?: number; strokeWidth?: number }): boolean {
    const bounds = this.getRenderWindowBounds();
    if (!bounds) return true;
    const radius = Math.hypot(object.width, object.height) / 2 + (object.strokeWidth ?? 0) / 2;
    const x = object.x + object.width / 2, y = object.y + object.height / 2;
    return y + radius >= bounds.top && y - radius <= bounds.bottom && x + radius >= bounds.left && x - radius <= bounds.right;
  }

  /**
   * Translates the viewport by dx, dy (in screen pixels).
   */
  pan(dx: number, dy: number): void {
    this.state.offsetX += dx;
    this.state.offsetY += dy;
    this.notify();
  }

  /**
   * Zooms the viewport by a scale factor, centered on screen coordinates (originX, originY).
   */
  zoomBy(factor: number, originX: number, originY: number): void {
    const oldZoom = this.state.scale;
    let newZoom = this.state.scale * factor;
    newZoom = Math.max(0.25, Math.min(8.0, newZoom));
    if (newZoom === oldZoom) return;
    this.state.scale = newZoom;
    this.notify();
  }


  /** Reset to default viewport (no pan, 100% zoom). */
  reset(): void {
    this.state = { ...DEFAULT_VIEWPORT_STATE };
    this.notify();
  }


  /**
   * Convert a screen-space coordinate (from a PointerEvent relative to the canvas element)
   * to page-space coordinate (used by the drawing engine).
   *
   * This accounts for zoom, pan, and device pixel ratio.
   */
  screenToPage(screenX: number, screenY: number): { x: number; y: number } {
    const { scale } = this.state;
    return {
      x: screenX / scale,
      y: screenY / scale,
    };
  }

  /**
   * Convert coordinates measured in the canvas's CSS box to document coordinates.
   * PDF canvases are sized in zoomed CSS pixels and also apply the viewport scale while
   * rendering; notebook canvases are rendered at base size and zoomed by their DOM parent.
   */
  pageToCanvas(x: number, y: number): { x: number; y: number } {
    const point = sourceToVisual({ x: x + this.contentOffsetX, y: y + this.contentOffsetY }, { width: this.pageWidth, height: this.pageHeight }, this.pageRotation);
    const scale = this.renderScale ? this.state.scale : 1;
    return {
      x: (point.x - this.renderOriginX) * scale + (this.renderPan ? this.state.offsetX : 0),
      y: (point.y - this.renderOriginY) * scale + (this.renderPan ? this.state.offsetY : 0),
    };
  }

  canvasToPage(canvasX: number, canvasY: number): { x: number; y: number } {
    const scale = this.renderScale ? this.state.scale : 1;
    const x = (canvasX - (this.renderPan ? this.state.offsetX : 0)) / scale + this.renderOriginX;
    const y = (canvasY - (this.renderPan ? this.state.offsetY : 0)) / scale + this.renderOriginY;
    const dimensions: PdfPageDimensions = { width: this.pageWidth, height: this.pageHeight };
    const point = visualToSource({ x, y }, dimensions, this.pageRotation);
    return { x: point.x - this.contentOffsetX, y: point.y - this.contentOffsetY };
  }

  /**
   * Convert a page-space coordinate to screen-space coordinate.
   * Used for rendering selection handles, tooltips, etc.
   */
  pageToScreen(pageX: number, pageY: number): { x: number; y: number } {
    const { scale } = this.state;
    return {
      x: pageX * scale,
      y: pageY * scale,
    };
  }

  /** Return true when `canvas` is already configured with identical dims, backingScale, CSS box, and render origin. */
  isCanvasBackingUnchanged(
    canvas: HTMLCanvasElement,
    cssWidth: number,
    cssHeight: number,
    currentZoomScale = 1,
    maxPixels = MAX_ACTIVE_CANVAS_PIXELS,
  ): boolean {
    this.updateDevicePixelRatio();
    const backingScale = this.getCanvasBackingScale(currentZoomScale, cssWidth, cssHeight, maxPixels);
    const targetWidth = Math.max(1, Math.floor(cssWidth * backingScale));
    const targetHeight = Math.max(1, Math.floor(cssHeight * backingScale));
    const prev = this.canvasBackingSignatures.get(canvas);
    return Boolean(
      prev
      && canvas.width === targetWidth
      && canvas.height === targetHeight
      && prev.width === targetWidth
      && prev.height === targetHeight
      && Math.abs(prev.backingScale - backingScale) < 1e-6
      && prev.cssWidth === cssWidth
      && prev.cssHeight === cssHeight
      && prev.originX === this.renderOriginX
      && prev.originY === this.renderOriginY,
    );
  }

  /**
   * Configure an HTML5 canvas element for HiDPI rendering.
   * Sets canvas.width/height to CSS dimensions * devicePixelRatio * bounded zoom detail,
   * and scales the context accordingly without reallocating if dimensions are unchanged.
   *
   * Returns the 2D context.
   */
  configureCanvas(
    canvas: HTMLCanvasElement,
    cssWidth: number,
    cssHeight: number,
    currentZoomScale = 1,
    maxPixels = MAX_ACTIVE_CANVAS_PIXELS,
  ): CanvasRenderingContext2D {
    this.updateDevicePixelRatio();
    const backingScale = this.getCanvasBackingScale(currentZoomScale, cssWidth, cssHeight, maxPixels);
    const targetWidth = Math.max(1, Math.floor(cssWidth * backingScale));
    const targetHeight = Math.max(1, Math.floor(cssHeight * backingScale));

    const dimsChanged = canvas.width !== targetWidth || canvas.height !== targetHeight;
    if (dimsChanged) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    const cssWidthStr = `${cssWidth}px`;
    const cssHeightStr = `${cssHeight}px`;
    if (canvas.style.width !== cssWidthStr) canvas.style.width = cssWidthStr;
    if (canvas.style.height !== cssHeightStr) canvas.style.height = cssHeightStr;

    const ctx = canvas.getContext('2d')!;
    if (dimsChanged) {
      ctx.scale(backingScale, backingScale);
    } else if (typeof ctx.setTransform === 'function') {
      ctx.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    } else {
      ctx.scale(backingScale, backingScale);
    }

    this.canvasBackingSignatures.set(canvas, {
      width: targetWidth,
      height: targetHeight,
      backingScale,
      cssWidth,
      cssHeight,
      originX: this.renderOriginX,
      originY: this.renderOriginY,
    });

    return ctx;
  }

  /**
   * Apply viewport transform to a canvas context before drawing.
   * In the CSS-transform camera architecture, the canvas backing store renders
   * in 1:1 base document coordinates (with DPR scaling managed by configureCanvas),
   * while visual magnification is handled by the parent CSS transform.
   */
  applyTransform(ctx: CanvasRenderingContext2D): void {
    if (this.renderPan && (this.state.offsetX !== 0 || this.state.offsetY !== 0)) {
      ctx.translate(this.state.offsetX, this.state.offsetY);
    }
    if (this.renderScale && this.state.scale !== 1) {
      ctx.scale(this.state.scale, this.state.scale);
    }
    applyPdfRotationTransform(ctx, this.pageRotation, { width: this.pageWidth, height: this.pageHeight });
    if (this.renderOriginX || this.renderOriginY) ctx.translate(-this.renderOriginX, -this.renderOriginY);
    if (this.contentOffsetX !== 0 || this.contentOffsetY !== 0) ctx.translate(this.contentOffsetX, this.contentOffsetY);
  }

  /** Apply full-page document transform (without 2D render-window crop) for overview backdrops. */
  applyFullPageTransform(ctx: CanvasRenderingContext2D): void {
    if (this.renderPan && (this.state.offsetX !== 0 || this.state.offsetY !== 0)) {
      ctx.translate(this.state.offsetX, this.state.offsetY);
    }
    if (this.renderScale && this.state.scale !== 1) {
      ctx.scale(this.state.scale, this.state.scale);
    }
    applyPdfRotationTransform(ctx, this.pageRotation, { width: this.pageWidth, height: this.pageHeight });
    if (this.contentOffsetX !== 0 || this.contentOffsetY !== 0) ctx.translate(this.contentOffsetX, this.contentOffsetY);
  }

  hasRenderWindow(): boolean {
    return this.renderWindowWidth !== undefined || this.renderWindowHeight !== undefined;
  }

  /** Get the CSS dimensions that the canvas should occupy, accounting for zoom. */
  getCanvasCSSSize(pageWidth: number, pageHeight: number): { width: number; height: number } {
    return {
      width: pageWidth * this.state.scale,
      height: pageHeight * this.state.scale,
    };
  }
}
