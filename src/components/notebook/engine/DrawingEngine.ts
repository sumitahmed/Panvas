import { buildInkFamilyGeometry, inkSampleWidths } from './inkFamilyGeometry.ts';
import type { InkFamily } from './drawingTypes.ts';
// ============================================
// Panvas — Drawing Engine
// ============================================
// Renders strokes onto an HTML5 Canvas.
// No React dependency — pure TypeScript class.

import type { Stroke, StrokePoint, DrawingToolId, StrokePattern } from './drawingTypes.ts';
import { DEFAULT_PAGE_LAYER_ID } from './drawingTypes.ts';
import { ViewportManager } from './ViewportManager.ts';
import { ShapeManager } from './ShapeManager.ts';
import { ImageManager } from './ImageManager.ts';
import { SelectionEngine } from './SelectionEngine.ts';
import { getPencilRenderPoint, getStrokeRenderHalfWidth } from './strokeGeometry.ts';
import { traceInkClip, strokeRegion, eraserCapsule, regionIntersects } from './inkRegion.ts';
import { LayerManager } from './LayerManager.ts';
import { RulerManager } from './RulerManager.ts';
import { LaserManager } from './LaserManager.ts';
import { buildStrokePatternGeometry } from './strokePatternGeometry.ts';
import { gate0Profiler } from '../../../dev/gate0Profiler.ts';
import { boundsOverlap, eraseBounds, type EraseBounds } from './capsuleErase.ts';
import { PenGeometry } from './penGeometry.ts';
import { WetInkSurface } from './WetInkSurface.ts';
import type { HandwritingTrace } from '../../../dev/handwritingTrace.ts';

export class DrawingEngine {
  private strokes: Stroke[] = [];
  private ctx: CanvasRenderingContext2D | null = null;
  private viewport: ViewportManager;
  private shapeManager: ShapeManager;
  private imageManager: ImageManager;
  private selectionEngine?: SelectionEngine;
  private canvas: HTMLCanvasElement | null = null;
  private layerManager: LayerManager;
  private rulerManager: RulerManager;
  private laserManager: LaserManager;
  private _scaleMultiplier = 1;
  private canvasCssWidth = 0;
  private canvasCssHeight = 0;
  private layerCanvases = new Map<string, CanvasRenderingContext2D>();
  private liveSnapshotCanvas: HTMLCanvasElement | null = null;
  private isLiveDrawing = false;
  private wetInk: WetInkSurface | null = null;
  private liveFrame: number | null = null;
  private pendingInk: Stroke | null = null;
  private liveTrace: HandwritingTrace | null = null;
  private frameQueuedAt = 0;
  private lastFrameAt = 0;

  attachLayerCanvas(id: string, canvas: HTMLCanvasElement, width: number, height: number, scale: number): () => void {
    const ctx = this.viewport.configureCanvas(canvas, width, height, scale / Math.sqrt(Math.max(1, this.layerManager.getLayers().length)));
    this.layerCanvases.set(id, ctx);
    this.redraw();
    return () => { if (this.layerCanvases.get(id) === ctx) this.layerCanvases.delete(id); this.redraw(); };
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
    this.laserManager.setRedrawCallback(() => this.redraw());
  }

  setScaleMultiplier(mult: number) {
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
    this.canvas = canvas;
    this.canvasCssWidth = cssWidth;
    this.canvasCssHeight = cssHeight;
    this.ctx = this.viewport.configureCanvas(canvas, cssWidth, cssHeight, this._scaleMultiplier);
  }

  /** Detach from canvas element. */
  detachCanvas(): void {
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
    this.canvasCssWidth = 0;
    this.canvasCssHeight = 0;
    this.endLiveStroke();
  }

  /** Resize the canvas (e.g., on window resize). */
  resize(cssWidth: number, cssHeight: number): void {
    if (!this.canvas) return;
    this.canvasCssWidth = cssWidth;
    this.canvasCssHeight = cssHeight;
    this.ctx = this.viewport.configureCanvas(this.canvas, cssWidth, cssHeight, this._scaleMultiplier);
    this.redraw();
  }

  getCanvasElement(): HTMLCanvasElement | null { return this.canvas; }

  /** Get all strokes (for serialization). */
  getStrokes(): Stroke[] {
    return this.strokes;
  }

  /** Set strokes (from deserialization). Redraws. */
  setStrokes(strokes: Stroke[]): void {
    this.strokes = strokes;
    this.redraw();
  }

  getLayerManager(): LayerManager { return this.layerManager; }

  /** Add a completed stroke. Does NOT redraw — caller should call redraw() or render incrementally. */
  addStroke(stroke: Stroke): void {
    const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    stroke.layerId ??= this.layerManager.getActiveLayerId();
    this.strokes.push(stroke);
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
    return removed;
  }

  /** Remove multiple strokes by ID. Returns removed strokes. */
  removeStrokes(ids: Set<string>): Stroke[] {
    const removed: Stroke[] = [];
    this.strokes = this.strokes.filter(s => {
      if (ids.has(s.id)) {
        removed.push(s);
        return false;
      }
      return true;
    });
    return removed;
  }

  /** Clear all strokes. Returns removed strokes for undo. */
  clearStrokes(): Stroke[] {
    const removed = this.strokes;
    this.strokes = [];
    return removed;
  }

  /** Full redraw of all strokes. */
  redraw(dirty?: EraseBounds, boundsForStroke?: (stroke: Stroke) => EraseBounds): void {
    if (!this.ctx || !this.canvas) return;
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

    // INVARIANT: Layer render order determines Z-index. Bottom layer (0) renders first.
    // Within each layer, entities render in deterministic order: Images -> Strokes -> Shapes.
    for (const layer of this.layerManager.getLayers()) {
      const layerCtx = this.layerCanvases.get(layer.id);
      if (layerCtx) layerCtx.clearRect(0, 0, this.canvasCssWidth, this.canvasCssHeight);
      if (!layer.visible) continue;
      const ctx = layerCtx ?? this.ctx;
      if (layerCtx) { ctx.save(); this.viewport.applyTransform(ctx); }
      this.imageManager.renderImages(ctx, layer.id);
      for (const stroke of this.strokes) {
        if (cullBounds && boundsForStroke && !boundsOverlap(cullBounds, boundsForStroke(stroke))) continue;
        const strokeLayerId = stroke.layerId ?? DEFAULT_PAGE_LAYER_ID;
        if (strokeLayerId === layer.id) this.renderStroke(ctx, stroke);
      }
      this.shapeManager.renderShapes(ctx, layer.id);
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
  }

  private renderTransientOverlays(): void {
    this.renderRulerOverlay();
    this.renderLaserOverlay();
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
  // Geometry-only cache. Validate samples as selection tools can edit points in
  // place; WeakMap ownership lets replaced/deleted strokes be collected.
  private inkPaths = new WeakMap<Stroke, { key: string; samples: number[]; path: Path2D }>();
  private inkPath(stroke: Stroke): Path2D | null {
    if (stroke.id === '__live__' || typeof Path2D === 'undefined') return null;
    const key = `${stroke.centerline}/${stroke.tool}/${stroke.inkFamily}/${stroke.pattern}/${stroke.thickness}`;
    const cached = this.inkPaths.get(stroke);
    if (cached?.key === key && cached.samples.length === stroke.points.length * 4
      && stroke.points.every((p,i) => cached.samples[i*4] === p.x && cached.samples[i*4+1] === p.y
        && cached.samples[i*4+2] === p.pressure && cached.samples[i*4+3] === p.t)) return cached.path;
    const path = new Path2D();
    if (stroke.centerline === 'polyline' && stroke.tool === 'pen' && (!stroke.pattern || stroke.pattern === 'solid')) {
      const geometry = new PenGeometry();
      geometry.update(stroke.points);
      geometry.trace(path, stroke);
    } else {
      for (const polygon of buildInkFamilyGeometry(stroke)) {
        polygon.forEach((p,i) => i ? path.lineTo(p.x,p.y) : path.moveTo(p.x,p.y));
        path.closePath();
      }
    }
    this.inkPaths.set(stroke, { key, path, samples: stroke.points.flatMap(p => [p.x,p.y,p.pressure,p.t]) });
    return path;
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
    const { points, color, thickness, opacity, tool } = stroke;
    if (!points || points.length === 0) return;
    if (stroke.centerline === 'polyline' && tool === 'pen' && (!stroke.pattern || stroke.pattern === 'solid')) {
      ctx.save();
      traceInkClip(ctx, stroke);
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = color;
      const path = this.inkPath(stroke);
      if (path) ctx.fill(path);
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
      ctx.fillStyle = stroke.color;
      const path = this.inkPath(stroke);
      if (path) { ctx.fill(path); ctx.restore(); return; }
      ctx.beginPath();
      for (const polygon of buildInkFamilyGeometry(stroke)) {
        polygon.forEach((point, i) => i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
        ctx.closePath();
      }
      ctx.fill(); ctx.restore(); return;
    }
    if (stroke.pattern === 'dashed'  || stroke.pattern === 'dotted') {
      this.renderPatternedStroke(ctx, stroke);
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

  /** Cancel pending presentation and release the transient surfaces. */
  endLiveStroke(): void {
    if (this.liveFrame !== null) cancelAnimationFrame(this.liveFrame);
    this.liveFrame = null;
    this.pendingInk = null;
    this.wetInk?.dispose();
    this.wetInk = null;
    this.liveTrace = null;
    this.isLiveDrawing = false;
    this.liveSnapshotCanvas = null;
  }

  /** One presentation per frame; all accepted geometry remains in points. */
  renderLiveStroke(points: StrokePoint[], tool: DrawingToolId, color: string, thickness: number,
    opacity: number, pattern: StrokePattern = 'solid', inkFamily?: InkFamily, _liveTip?: StrokePoint): void {
    if (!this.ctx || !this.canvas) return;
    this.pendingInk = { id: '__live__', type: 'stroke', points, tool, color, thickness, opacity,
      pattern, inkFamily, centerline: 'polyline', createdAt: 0 };
    if (this.liveFrame !== null) return;
    this.frameQueuedAt = performance.now();
    this.liveFrame = requestAnimationFrame(() => {
      this.liveFrame = null;
      this.flushLiveInk();
    });
  }

  private flushLiveInk(finalizing = false): void {
    const stroke = this.pendingInk;
    if (!stroke || !this.ctx || !this.canvas) return;
    this.pendingInk = null;
    const start = performance.now();
    const ctx = this.layerCanvases.get(this.layerManager.getActiveLayerId()) ?? this.ctx;
    const trace = this.liveTrace;
    if (stroke.tool === 'pen' && stroke.pattern === 'solid' && ctx.canvas.parentElement) {
      if (!this.wetInk) {
        ctx.save();
        this.viewport.applyTransform(ctx);
        const transform = ctx.getTransform();
        ctx.restore();
        this.wetInk = new WetInkSurface(ctx, transform);
      }
      const work = this.wetInk.render(stroke);
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
      if (!finalizing) sample('scheduledFrameDelayMs', start - this.frameQueuedAt);
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
    if (this.wetInk && this.wetInk.target === ctx) this.wetInk.commit(stroke);
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

  /** Render the transient freehand selection enclosure without persisting page content. */
  renderLasso(points: StrokePoint[]): void {
    if (!this.ctx || !this.canvas) return;

    this.redraw();
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
   * Find all stroke IDs that are within `radius` CSS pixels of the given point,
   * checking proximity to each line segment plus the stroke's half-thickness.
   */
  findStrokesNearPoint(x: number, y: number, radius: number): string[] {
    const hits: string[] = [];
    const active = gate0Profiler.getActive('eraser-gesture');

    for (const stroke of this.strokes) {
      gate0Profiler.increment(active, 'strokesScanned');
      if (!this.layerManager.isEditable(stroke.layerId)) continue;
      if (stroke.inkClip && !regionIntersects(strokeRegion(stroke), eraserCapsule({ x, y }, { x, y }, Math.max(radius, 0.01)))) continue;
      const effectiveRadius = radius + getStrokeRenderHalfWidth(stroke);
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
