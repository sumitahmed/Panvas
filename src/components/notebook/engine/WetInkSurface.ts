import type { Stroke } from './drawingTypes.ts';
import { PenGeometry, unionInkBounds, type InkBounds } from './penGeometry.ts';

/** An opaque stable prefix plus a small replaceable nib tail. Opacity is applied
 * once by the compositor, avoiding dark seams at sample/frame boundaries. The
 * committed page is never copied or cleared during movement. */
export class WetInkSurface {
  readonly canvas: HTMLCanvasElement;
  private prefix: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private prefixCtx: CanvasRenderingContext2D;
  private geometry = new PenGeometry();
  private stable = 0;
  private oldTail: InkBounds | null = null;
  private bounds: InkBounds | null = null;
  constructor(readonly target: CanvasRenderingContext2D, private transform: DOMMatrix) {
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
    Object.assign(this.canvas.style, { position: 'absolute', left: target.canvas.style.left || '0px',
      top: target.canvas.style.top || '0px', width: target.canvas.style.width,
      height: target.canvas.style.height, pointerEvents: 'none',
      zIndex: getComputedStyle(target.canvas).zIndex });
    target.canvas.insertAdjacentElement('afterend', this.canvas);
  }
  private pixels(bounds: InkBounds): InkBounds {
    const m = this.transform;
    const corners = [[bounds.left, bounds.top], [bounds.right, bounds.top], [bounds.right, bounds.bottom], [bounds.left, bounds.bottom]]
      .map(([x,y]) => ({ x: m.a*x + m.c*y + m.e, y: m.b*x + m.d*y + m.f }));
    return { left: Math.max(0, Math.floor(Math.min(...corners.map(p => p.x)) - 2)),
      top: Math.max(0, Math.floor(Math.min(...corners.map(p => p.y)) - 2)),
      right: Math.min(this.canvas.width, Math.ceil(Math.max(...corners.map(p => p.x)) + 2)),
      bottom: Math.min(this.canvas.height, Math.ceil(Math.max(...corners.map(p => p.y)) + 2)) };
  }
  render(stroke: Stroke): { primitives: number; dirtyPixels: number; rebuilt: boolean } {
    const rebuilt = this.geometry.update(stroke.points);
    if (rebuilt) {
      this.prefixCtx.resetTransform();
      this.prefixCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.resetTransform();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.stable = 0;
      this.oldTail = null;
      this.bounds = null;
    }
    const n = stroke.points.length;
    if (!n) return { primitives: 0, dirtyPixels: 0, rebuilt };
    const nextStable = this.geometry.stableEnd(stroke);
    const changed = this.geometry.bounds(stroke, this.stable, n)!;
    const dirty = this.pixels(this.oldTail ? unionInkBounds(this.oldTail, changed) : changed);
    this.bounds = unionInkBounds(this.bounds, changed);
    const primitives = n - this.stable;
    if (nextStable > this.stable) {
      this.prefixCtx.setTransform(this.transform);
      this.prefixCtx.fillStyle = stroke.color;
      this.prefixCtx.beginPath();
      this.geometry.trace(this.prefixCtx, stroke, this.stable, nextStable);
      this.prefixCtx.fill();
    }
    this.stable = nextStable;
    this.oldTail = this.geometry.bounds(stroke, this.stable, n);
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
      this.ctx.fill();
      this.ctx.restore();
    }
    this.canvas.style.opacity = String(stroke.opacity);
    return { primitives, dirtyPixels: Math.max(0, width) * Math.max(0, height), rebuilt };
  }
  commit(stroke: Stroke): void {
    if (!this.bounds) return;
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
