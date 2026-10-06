import { buildLineStyleGeometry, lineStyleHit } from './lineStyleGeometry.ts';
// ============================================
// Panvas — Shape Manager
// ============================================
// Handles drawing and rendering of vector shapes (rectangle, ellipse, etc).

import type { Shape, ShapeType } from './drawingTypes.ts';
import { DEFAULT_PAGE_LAYER_ID } from './drawingTypes.ts';
import type { ViewportManager } from './ViewportManager.ts';
import { LayerManager } from './LayerManager.ts';
import { fullDarkInkColor } from '../../../lib/fullDarkView.ts';

export class ShapeManager {
  private shapes: Shape[] = [];
  private viewport: ViewportManager;
  private layerManager: LayerManager;
  private fullDarkView = false;
  setFullDarkView(enabled: boolean): void { this.fullDarkView = enabled; }

  constructor(viewport: ViewportManager, layerManager: LayerManager = new LayerManager()) {
    this.viewport = viewport;
    this.layerManager = layerManager;
  }

  getShapes(): Shape[] {
    return this.shapes;
  }

  setShapes(shapes: Shape[]): void {
    this.shapes = shapes;
  }

  addShape(shape: Shape): void {
    shape.layerId ??= this.layerManager.getActiveLayerId();
    this.shapes.push(shape);
  }

  removeShape(id: string): Shape | undefined {
    const index = this.shapes.findIndex(s => s.id === id);
    if (index === -1) return undefined;
    const [removed] = this.shapes.splice(index, 1);
    return removed;
  }

  removeShapes(ids: Set<string>): Shape[] {
    const removed: Shape[] = [];
    this.shapes = this.shapes.filter(s => {
      if (ids.has(s.id)) {
        removed.push(s);
        return false;
      }
      return true;
    });
    return removed;
  }

  clearShapes(): Shape[] {
    const removed = this.shapes;
    this.shapes = [];
    return removed;
  }

  /** Render all shapes onto the given context. */
  renderShapes(ctx: CanvasRenderingContext2D, layerId?: string): void {
    for (const shape of this.shapes) {
      if (layerId && shape.layerId !== layerId) continue;
      const shapeLayerId = shape.layerId ?? DEFAULT_PAGE_LAYER_ID;
      if (layerId && shapeLayerId !== layerId) continue;
      this.renderShape(ctx, shape);
    }
  }

  /** Render a single shape (used for final rendering and live preview). */
  renderShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
    if (this.fullDarkView) shape = { ...shape, color: fullDarkInkColor(shape.color), fill: shape.fill ? fullDarkInkColor(shape.fill) : shape.fill };
    ctx.save();
    
    if (shape.shapeType === 'line' || shape.shapeType === 'arrow') {
      const geometry = buildLineStyleGeometry(shape);
      ctx.strokeStyle = shape.color; ctx.fillStyle = shape.color; ctx.lineWidth = shape.strokeWidth;
      ctx.globalAlpha = Math.max(0, Math.min(1, shape.opacity ?? 1)); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
      ctx.beginPath();
      for (const path of geometry.paths) path.forEach((point, i) => i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
      ctx.stroke(); ctx.beginPath();
      for (const dot of geometry.dots) { ctx.moveTo(dot.x + geometry.radius, dot.y); ctx.arc(dot.x, dot.y, geometry.radius, 0, Math.PI * 2); }
      ctx.fill(); ctx.restore(); return;
    }
    // Apply rotation around center
    const cx = shape.x + shape.width / 2;
    const cy = shape.y + shape.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((shape.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);

    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.strokeWidth;
    ctx.globalAlpha = Math.max(0, Math.min(1, shape.opacity ?? 1));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (shape.fill) {
      ctx.fillStyle = shape.fill;
    }

    ctx.beginPath();

    switch (shape.shapeType) {
      case 'rectangle':
        ctx.rect(shape.x, shape.y, shape.width, shape.height);
        break;
      case 'rounded-rectangle': {
        const radius = Math.min(16, Math.abs(shape.width) / 4, Math.abs(shape.height) / 4);
        ctx.roundRect(shape.x, shape.y, shape.width, shape.height, radius);
        break;
      }
      case 'ellipse':
        ctx.ellipse(cx, cy, Math.abs(shape.width) / 2, Math.abs(shape.height) / 2, 0, 0, 2 * Math.PI);
        break;
      case 'triangle':
        ctx.moveTo(cx, shape.y);
        ctx.lineTo(shape.x + shape.width, shape.y + shape.height);
        ctx.lineTo(shape.x, shape.y + shape.height);
        ctx.closePath();
        break;
      case 'diamond':
        ctx.moveTo(cx, shape.y);
        ctx.lineTo(shape.x + shape.width, cy);
        ctx.lineTo(cx, shape.y + shape.height);
        ctx.lineTo(shape.x, cy);
        ctx.closePath();
        break;

    }

    if (shape.fill) {
      ctx.fill();
    }
    ctx.stroke();
    
    ctx.restore();
  }

  // ---- Hit Testing ----

  findShapesNearPoint(x: number, y: number, radius: number): string[] {
    const hits: string[] = [];
    const radiusSq = radius * radius;

    for (const shape of this.shapes) {
      if (!this.layerManager.isEditable(shape.layerId)) continue;
      if (shape.shapeType === 'line' || shape.shapeType === 'arrow') {
        if (lineStyleHit(shape, { x, y }, radius)) hits.push(shape.id);
        continue;
      }
      // Very basic hit testing for now (bounding box + radius)
      // For precise selection, we'd need type-specific geometry math.
      const minX = Math.min(shape.x, shape.x + shape.width) - radius;
      const maxX = Math.max(shape.x, shape.x + shape.width) + radius;
      const minY = Math.min(shape.y, shape.y + shape.height) - radius;
      const maxY = Math.max(shape.y, shape.y + shape.height) + radius;

      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        hits.push(shape.id);
      }
    }
    return hits;
  }
}
