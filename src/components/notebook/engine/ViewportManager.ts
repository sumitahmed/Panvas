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
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const zoom = Number.isFinite(currentZoomScale) && currentZoomScale > 0 ? currentZoomScale : 1;
  const visualScale = Number.isFinite(browserVisualScale) && browserVisualScale > 0 ? browserVisualScale : 1;
  const desiredScale = dpr * zoom * visualScale;
  if (!(cssWidth > 0) || !(cssHeight > 0)) return desiredScale;

  const allowedByDimension = Math.min(
    MAX_CANVAS_DIMENSION / cssWidth,
    MAX_CANVAS_DIMENSION / cssHeight,
  );
  const allowedByPixels = Math.sqrt(MAX_ACTIVE_CANVAS_PIXELS / (cssWidth * cssHeight));
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

  getCanvasBackingScale(currentZoomScale: number, cssWidth: number, cssHeight: number): number {
    return resolveCanvasBackingScale(this.dpr, currentZoomScale, cssWidth, cssHeight, getBrowserCanvasVisualScale());
  }

  /** Update DPR (e.g., when window moves between monitors). */
  updateDevicePixelRatio(): void {
    this.dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  }

  /** Get current viewport state. */
  getState(): Readonly<ViewportState> {
    return this.snapshot;
  }

  /** Set zoom level (1 = 100%). Clamped to [0.25, 4]. */
  setZoom(scale: number): void {
    this.state.scale = Math.max(0.25, Math.min(4, scale));
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
    newZoom = Math.max(0.25, Math.min(4.0, newZoom));
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
    return { x: point.x * scale + (this.renderPan ? this.state.offsetX : 0),
      y: point.y * scale + (this.renderPan ? this.state.offsetY : 0) };
  }

  canvasToPage(canvasX: number, canvasY: number): { x: number; y: number } {
    const scale = this.renderScale ? this.state.scale : 1;
    const x = (canvasX - (this.renderPan ? this.state.offsetX : 0)) / scale;
    const y = (canvasY - (this.renderPan ? this.state.offsetY : 0)) / scale;
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

  /**
   * Configure an HTML5 canvas element for HiDPI rendering.
   * Sets canvas.width/height to CSS dimensions * devicePixelRatio * bounded zoom detail,
   * and scales the context accordingly.
   *
   * Returns the 2D context.
   */
  configureCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number, currentZoomScale = 1): CanvasRenderingContext2D {
    this.updateDevicePixelRatio();
    const backingScale = this.getCanvasBackingScale(currentZoomScale, cssWidth, cssHeight);

    canvas.width = Math.floor(cssWidth * backingScale);
    canvas.height = Math.floor(cssHeight * backingScale);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.scale(backingScale, backingScale);

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
    if (this.contentOffsetX !== 0 || this.contentOffsetY !== 0) ctx.translate(this.contentOffsetX, this.contentOffsetY);
  }

  /** Get the CSS dimensions that the canvas should occupy, accounting for zoom. */
  getCanvasCSSSize(pageWidth: number, pageHeight: number): { width: number; height: number } {
    return {
      width: pageWidth * this.state.scale,
      height: pageHeight * this.state.scale,
    };
  }
}
