import type { Stroke, StrokePoint } from './drawingTypes.ts';
import { PenGeometry, unionInkBounds, type InkBounds } from './penGeometry.ts';

function combineBounds(a: InkBounds | null, b: InkBounds | null): InkBounds | null {
  if (a && b) return unionInkBounds(a, b);
  return a ?? b;
}

/** An opaque stable prefix plus a small replaceable nib tail. Opacity is applied
 * once by the compositor, avoiding dark seams at sample/frame boundaries. The
 * committed page is never copied or cleared during movement. */
export class WetInkSurface {
  readonly canvas: HTMLCanvasElement;
  readonly target: CanvasRenderingContext2D;
  private transform: DOMMatrix;
  private prefix: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private prefixCtx: CanvasRenderingContext2D;
  private geometry = new PenGeometry();
  private predictedGeometry = new PenGeometry();
  private predictedPointsScratch: StrokePoint[] = [];
  private predictedStrokeScratch: Stroke = {
    id: '__predicted__',
    type: 'stroke',
    points: this.predictedPointsScratch,
    tool: 'pen',
    color: '#000000',
    thickness: 2,
    opacity: 1,
    centerline: 'polyline',
    createdAt: 0,
  };
  private hasEphemeralPrediction = false;
  private stable = 0;
  private oldTail: InkBounds | null = null;
  private bounds: InkBounds | null = null;
  private previewBounds: InkBounds | null = null;
  private prefixDirty = false;
  private readonly zIndex: string;
  private lastOpacity = '';
  private fullClearOnPause = false;
  constructor(target: CanvasRenderingContext2D, transform: DOMMatrix) {
    this.target = target;
    this.transform = transform;
    this.canvas = document.createElement('canvas');
    this.prefix = document.createElement('canvas');
    for (const canvas of [this.canvas, this.prefix]) {
      canvas.width = target.canvas.width;
      canvas.height = target.canvas.height;
    }
    this.ctx = this.canvas.getContext('2d')!;
    this.prefixCtx = this.prefix.getContext('2d')!;
    this.canvas.dataset.panvasWetInk = 'true';
    this.canvas.setAttribute('aria-hidden', 'true');
    // Using inline z-index or default 10 avoids forced synchronous style
    // recalculation via getComputedStyle during pen interaction.
    this.zIndex = target.canvas.style.zIndex || '10';
    Object.assign(this.canvas.style, { position: 'absolute', left: target.canvas.style.left || '0px',
      top: target.canvas.style.top || '0px', width: target.canvas.style.width || '100%',
      height: target.canvas.style.height || '100%', pointerEvents: 'none',
      zIndex: this.zIndex });
    target.canvas.insertAdjacentElement('afterend', this.canvas);
  }
  /** Retain a clean buffer briefly between adjacent handwriting strokes. */
  pause(): void {
    if (this.fullClearOnPause && !this.bounds && !this.previewBounds) {
      this.ctx.resetTransform();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (this.prefixDirty) {
        this.prefixCtx.resetTransform();
        this.prefixCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    } else {
      const clearTarget = combineBounds(combineBounds(this.bounds, this.oldTail), this.previewBounds);
      if (clearTarget) {
        const b = this.pixels(clearTarget);
        if (b.right > b.left && b.bottom > b.top) {
          this.ctx.resetTransform();
          this.ctx.clearRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
        }
      }
      if (this.prefixDirty) {
        this.prefixCtx.resetTransform();
        if (this.bounds) {
          const b = this.pixels(this.bounds);
          if (b.right > b.left && b.bottom > b.top) this.prefixCtx.clearRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
        } else {
          this.prefixCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
      }
    }
    // Keep the transparent spare connected during the short burst window.
    // Removing and reinserting it on the next pen-down invalidates style and
    // compositing for the whole page; opacity zero keeps the cleared surface
    // invisible even if a stale pixel ever fell outside the tracked bounds.
    if (this.lastOpacity !== '0') {
      this.canvas.style.opacity = '0';
      this.lastOpacity = '0';
    }
    this.fullClearOnPause = false;
    this.hasEphemeralPrediction = false;
    this.predictedPointsScratch.length = 0;
    this.predictedGeometry.points = [];
    this.predictedGeometry.distances.length = 0;
    this.geometry = new PenGeometry();
    this.stable = 0;
    this.oldTail = this.bounds = this.previewBounds = null;
    this.prefixDirty = false;
  }

  /** Replace wet ink with a transient vector preview (e.g. hold-to-snap shape). */
  renderPreview(draw: (ctx: CanvasRenderingContext2D) => void, bounds?: InkBounds | null): void {
    if (this.prefixDirty) {
      this.prefixCtx.resetTransform();
      if (this.bounds) {
        const b = this.pixels(this.bounds);
        if (b.right > b.left && b.bottom > b.top) {
          this.prefixCtx.clearRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
        }
      } else {
        this.prefixCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
      this.prefixDirty = false;
    }

    const dirtyTarget = combineBounds(combineBounds(this.bounds, this.oldTail), this.previewBounds);
    this.ctx.resetTransform();
    if (dirtyTarget) {
      const b = this.pixels(dirtyTarget);
      if (b.right > b.left && b.bottom > b.top) {
        this.ctx.clearRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
      }
    } else if (this.fullClearOnPause || this.bounds || this.previewBounds) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    this.ctx.save();
    this.ctx.setTransform(this.transform);
    draw(this.ctx);
    this.ctx.restore();
    if (this.lastOpacity !== '1') {
      this.canvas.style.opacity = '1';
      this.lastOpacity = '1';
    }
    this.previewBounds = bounds ?? null;
    this.fullClearOnPause = !bounds;
    this.hasEphemeralPrediction = false;
    this.predictedPointsScratch.length = 0;
    this.predictedGeometry.points = [];
    this.predictedGeometry.distances.length = 0;
    this.geometry = new PenGeometry();
    this.stable = 0;
    this.oldTail = this.bounds = null;
  }
  resume(transform: DOMMatrix): void {
    this.transform = transform;
    Object.assign(this.canvas.style, {
      left: this.target.canvas.style.left || '0px',
      top: this.target.canvas.style.top || '0px',
      width: this.target.canvas.style.width || '100%',
      height: this.target.canvas.style.height || '100%',
    });
    if (!this.canvas.isConnected) this.target.canvas.insertAdjacentElement('afterend', this.canvas);
  }
  matches(target: CanvasRenderingContext2D): boolean {
    return target === this.target && this.canvas.width === target.canvas.width
      && this.canvas.height === target.canvas.height;
  }
  private pixels(bounds: InkBounds): InkBounds {
    const m = this.transform;
    const x0 = bounds.left;
    const y0 = bounds.top;
    const x1 = bounds.right;
    const y1 = bounds.bottom;
    const px0 = m.a * x0 + m.c * y0 + m.e;
    const py0 = m.b * x0 + m.d * y0 + m.f;
    const px1 = m.a * x1 + m.c * y0 + m.e;
    const py1 = m.b * x1 + m.d * y0 + m.f;
    const px2 = m.a * x1 + m.c * y1 + m.e;
    const py2 = m.b * x1 + m.d * y1 + m.f;
    const px3 = m.a * x0 + m.c * y1 + m.e;
    const py3 = m.b * x0 + m.d * y1 + m.f;
    return {
      left: Math.max(0, Math.floor(Math.min(px0, px1, px2, px3) - 2)),
      top: Math.max(0, Math.floor(Math.min(py0, py1, py2, py3) - 2)),
      right: Math.min(this.canvas.width, Math.ceil(Math.max(px0, px1, px2, px3) + 2)),
      bottom: Math.min(this.canvas.height, Math.ceil(Math.max(py0, py1, py2, py3) + 2)),
    };
  }
  render(
    stroke: Stroke,
    revisedFrom = Infinity,
    predictedPoints?: readonly StrokePoint[],
  ): { primitives: number; dirtyPixels: number; rebuilt: boolean } {
    const geometryChanged = this.geometry.update(stroke.points, true, revisedFrom);
    // An in-place revision of already-traced primitives must re-derive the
    // prefix raster through the clear-and-retrace path: re-tracing over
    // existing fill is not idempotent for antialiased edges.
    const rebuilt = geometryChanged || revisedFrom < this.stable;
    if (rebuilt) {
      if (this.prefixDirty) {
        this.prefixCtx.resetTransform();
        this.prefixCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.prefixDirty = false;
      }
      if (this.bounds || this.oldTail || this.previewBounds || this.fullClearOnPause) {
        this.ctx.resetTransform();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
      this.stable = 0;
      this.oldTail = null;
      this.bounds = null;
      this.previewBounds = null;
      this.fullClearOnPause = false;
      this.hasEphemeralPrediction = false;
    }
    const n = stroke.points.length;
    if (!n) return { primitives: 0, dirtyPixels: 0, rebuilt };
    const nextStable = this.geometry.stableEnd(stroke);
    const changed = this.geometry.bounds(stroke, this.stable, n);

    // Ephemeral predicted extension (1-2 tail samples): never enters prefix,
    // stroke.points, or this.bounds — tracked only in oldTail so cleared next frame.
    let predBounds: InkBounds | null = null;
    this.predictedPointsScratch.length = 0;
    if (predictedPoints && predictedPoints.length > 0 && stroke.tool === 'pen') {
      if (n >= 2) this.predictedPointsScratch.push(stroke.points[n - 2]);
      this.predictedPointsScratch.push(stroke.points[n - 1]);
      for (let i = 0; i < predictedPoints.length; i += 1) {
        this.predictedPointsScratch.push(predictedPoints[i]);
      }
      this.predictedStrokeScratch.color = stroke.color;
      this.predictedStrokeScratch.thickness = stroke.thickness;
      this.predictedStrokeScratch.opacity = stroke.opacity;
      this.predictedStrokeScratch.inkFamily = stroke.inkFamily;
      this.predictedGeometry.update(this.predictedPointsScratch, true, 0);
      predBounds = this.predictedGeometry.bounds(this.predictedStrokeScratch, 0, this.predictedPointsScratch.length);
    }
    this.hasEphemeralPrediction = Boolean(predBounds);

    if (!changed && !predBounds && !this.oldTail) {
      return { primitives: 0, dirtyPixels: 0, rebuilt };
    }
    const frameBounds = combineBounds(changed, predBounds);
    const dirtyArea = combineBounds(this.oldTail, frameBounds);
    if (!dirtyArea) return { primitives: 0, dirtyPixels: 0, rebuilt };
    const dirty = this.pixels(dirtyArea);
    if (changed) this.bounds = unionInkBounds(this.bounds, changed);
    const primitives = n - this.stable;
    if (nextStable > this.stable) {
      this.prefixDirty = true;
      this.prefixCtx.setTransform(this.transform);
      this.prefixCtx.fillStyle = stroke.color;
      this.prefixCtx.beginPath();
      this.geometry.trace(this.prefixCtx, stroke, this.stable, nextStable);
      this.prefixCtx.fill();
    }
    this.stable = nextStable;
    this.oldTail = combineBounds(this.geometry.bounds(stroke, this.stable, n), predBounds);
    const width = dirty.right - dirty.left, height = dirty.bottom - dirty.top;
    if (width > 0 && height > 0) {
      this.ctx.save();
      this.ctx.resetTransform();
      this.ctx.beginPath();
      this.ctx.rect(dirty.left, dirty.top, width, height);
      this.ctx.clip();
      this.ctx.clearRect(dirty.left, dirty.top, width, height);
      this.ctx.drawImage(this.prefix, dirty.left, dirty.top, width, height, dirty.left, dirty.top, width, height);
      this.ctx.setTransform(this.transform);
      this.ctx.fillStyle = stroke.color;
      this.ctx.beginPath();
      this.geometry.trace(this.ctx, stroke, this.stable, n);
      if (predBounds && this.predictedPointsScratch.length >= 2) {
        this.predictedGeometry.trace(this.ctx, this.predictedStrokeScratch, 0, this.predictedPointsScratch.length);
      }
      this.ctx.fill();
      this.ctx.restore();
    }
    const opacity = String(stroke.opacity);
    if (this.lastOpacity !== opacity) {
      this.canvas.style.opacity = opacity;
      this.lastOpacity = opacity;
    }
    return { primitives, dirtyPixels: Math.max(0, width) * Math.max(0, height), rebuilt };
  }
  commit(stroke: Stroke): void {
    if (!this.bounds) return;
    if (this.hasEphemeralPrediction) {
      // Strip any ephemeral predicted pixels before blitting committed ink.
      this.render(stroke, Infinity, undefined);
    }
    const b = this.pixels(this.bounds), w = b.right - b.left, h = b.bottom - b.top;
    if (!(w > 0 && h > 0)) return;
    this.target.save();
    this.target.resetTransform();
    this.target.globalAlpha = stroke.opacity;
    this.target.globalCompositeOperation = 'source-over';
    this.target.drawImage(this.canvas, b.left, b.top, w, h, b.left, b.top, w, h);
    this.target.restore();
  }
  dispose(): void {
    this.canvas.remove();
    this.canvas.width = this.prefix.width = 0;
  }
}
