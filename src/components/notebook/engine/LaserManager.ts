import type { StrokePoint } from './drawingTypes.ts';

export interface LaserTrailPoint {
  x: number;
  y: number;
  timestamp: number;
}

export interface LaserManagerOptions {
  color?: string;
  radius?: number;
  decayMs?: number;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

const DEFAULT_COLOR = '#ef4444';
const DEFAULT_RADIUS = 6;
const DEFAULT_DECAY_MS = 1_000;
const MAX_TRAIL_POINTS = 512;

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function defaultRequestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return globalThis.setTimeout(() => callback(defaultNow()), 16) as unknown as number;
}

function defaultCancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else globalThis.clearTimeout(handle);
}

function rgba(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return hex;
  return `rgba(${Number.parseInt(match[1], 16)}, ${Number.parseInt(match[2], 16)}, ${Number.parseInt(match[3], 16)}, ${Math.max(0, Math.min(1, alpha))})`;
}

/**
 * Owns the notebook laser's short-lived trail. This manager deliberately has no
 * reference to page data or history, so its points cannot be serialized or undone.
 */
export class LaserManager {
  readonly color: string;
  readonly radius: number;
  readonly decayMs: number;

  private activeTrail: LaserTrailPoint[] = [];
  private animationFrame: number | null = null;
  private redrawCallback?: () => void;
  private readonly now: () => number;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(options: LaserManagerOptions = {}) {
    this.color = options.color ?? DEFAULT_COLOR;
    this.radius = Math.max(1, options.radius ?? DEFAULT_RADIUS);
    this.decayMs = Math.max(100, options.decayMs ?? DEFAULT_DECAY_MS);
    this.now = options.now ?? defaultNow;
    this.requestFrame = options.requestFrame ?? defaultRequestFrame;
    this.cancelFrame = options.cancelFrame ?? defaultCancelFrame;
  }

  setRedrawCallback(callback: (() => void) | undefined): void {
    this.redrawCallback = callback;
  }

  addPoint(point: StrokePoint, timestamp = this.now()): void {
    this.prune(timestamp);
    this.activeTrail.push({ x: point.x, y: point.y, timestamp });
    if (this.activeTrail.length > MAX_TRAIL_POINTS) {
      this.activeTrail.splice(0, this.activeTrail.length - MAX_TRAIL_POINTS);
    }
    // Pointer/raw updates can arrive several times before paint. Keep every
    // point, then present the trail once through the existing animation frame.
    this.ensureAnimation();
  }

  /** Snapshot used by rendering and focused validation. Expired points are removed. */
  getActiveTrail(now = this.now()): readonly LaserTrailPoint[] {
    this.prune(now);
    return this.activeTrail.map(point => ({ ...point }));
  }

  getPointOpacity(point: LaserTrailPoint, now = this.now()): number {
    return Math.max(0, Math.min(1, 1 - (now - point.timestamp) / this.decayMs));
  }

  isAnimating(): boolean {
    return this.animationFrame !== null;
  }

  clear(): void {
    const hadTrail = this.activeTrail.length > 0;
    this.activeTrail = [];
    if (this.animationFrame !== null) {
      this.cancelFrame(this.animationFrame);
      this.animationFrame = null;
    }
    if (hadTrail) this.redrawCallback?.();
  }

  render(ctx: CanvasRenderingContext2D, scale: number, now = this.now()): void {
    this.prune(now);
    if (this.activeTrail.length === 0) return;

    const safeScale = Math.max(0.01, scale);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = rgba(this.color, 0.9);
    ctx.shadowBlur = 12 / safeScale;

    for (let index = 1; index < this.activeTrail.length; index += 1) {
      const from = this.activeTrail[index - 1];
      const to = this.activeTrail[index];
      const fromOpacity = this.getPointOpacity(from, now);
      const toOpacity = this.getPointOpacity(to, now);
      const gradient = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
      gradient.addColorStop(0, rgba(this.color, fromOpacity * 0.72));
      gradient.addColorStop(1, rgba(this.color, toOpacity * 0.95));

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = Math.max(1.5, this.radius * (0.45 + toOpacity * 0.7)) / safeScale;
      ctx.stroke();
    }

    const head = this.activeTrail[this.activeTrail.length - 1];
    const headOpacity = this.getPointOpacity(head, now);
    const outerRadius = this.radius * 2.2 / safeScale;
    const innerRadius = this.radius / safeScale;
    const glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, outerRadius);
    glow.addColorStop(0, rgba('#ffffff', headOpacity));
    glow.addColorStop(0.22, rgba(this.color, headOpacity));
    glow.addColorStop(1, rgba(this.color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(head.x, head.y, outerRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = rgba(this.color, headOpacity);
    ctx.beginPath();
    ctx.arc(head.x, head.y, innerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private prune(now: number): void {
    const cutoff = now - this.decayMs;
    this.activeTrail = this.activeTrail.filter(point => point.timestamp > cutoff);
  }

  private ensureAnimation(): void {
    if (this.animationFrame !== null) return;
    this.animationFrame = this.requestFrame(this.stepAnimation);
  }

  private stepAnimation = (): void => {
    this.animationFrame = null;
    this.prune(this.now());
    this.redrawCallback?.();
    if (this.activeTrail.length > 0) this.ensureAnimation();
  };
}
