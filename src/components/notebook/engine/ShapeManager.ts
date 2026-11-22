import { buildLineStyleGeometry, lineStyleHit } from './lineStyleGeometry.ts';
// ============================================
// Panvas — Shape Manager
// ============================================
// Handles drawing and rendering of vector shapes (rectangle, ellipse, etc).

import type { Shape, ShapeType } from './drawingTypes.ts';
import { DEFAULT_PAGE_LAYER_ID, isLinearShapeType } from './drawingTypes.ts';
import { getShapePolygonVertices, hitTestPolygonShape, isPolygonShapeType } from './shapePolygonGeometry.ts';
import type { EraseBounds } from './capsuleErase.ts';
import { isEmptyBounds, objectIntersectsBounds } from './strokeSpatialIndex.ts';
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

  getShape(id: string): Shape | undefined {
    return this.shapes.find(shape => shape.id === id);
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
  renderShapes(
    ctx: CanvasRenderingContext2D,
    layerId?: string,
    excludeIds?: Set<string>,
    cullBounds?: EraseBounds | null
  ): void {
    if (cullBounds && isEmptyBounds(cullBounds)) return;
    for (const shape of this.shapes) {
      if (excludeIds && excludeIds.has(shape.id)) continue;
      const shapeLayerId = shape.layerId ?? DEFAULT_PAGE_LAYER_ID;
      if (layerId && shapeLayerId !== layerId) continue;
      if (!this.viewport.intersectsRenderWindow(shape)) continue;
      if (cullBounds && !objectIntersectsBounds(shape, cullBounds)) continue;
      this.renderShape(ctx, shape);
    }
  }

  /** Render a single shape (used for final rendering and live preview). */
  renderShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
    if (this.fullDarkView) shape = { ...shape, color: fullDarkInkColor(shape.color), fill: shape.fill ? fullDarkInkColor(shape.fill) : shape.fill };
    ctx.save();

    if (isLinearShapeType(shape.shapeType)) {
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
      case 'diamond':
      case 'pentagon':
      case 'hexagon':
      case 'star': {
        const vertices = getShapePolygonVertices(shape.shapeType, shape.x, shape.y, shape.width, shape.height);
        if (vertices && vertices.length > 0) {
          ctx.moveTo(vertices[0].x, vertices[0].y);
          for (let i = 1; i < vertices.length; i += 1) {
            ctx.lineTo(vertices[i].x, vertices[i].y);
          }
          ctx.closePath();
        }
        break;
      }

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

    for (const shape of this.shapes) {
      if (!this.layerManager.isEditable(shape.layerId)) continue;
      if (isLinearShapeType(shape.shapeType)) {
        if (lineStyleHit(shape, { x, y }, radius)) hits.push(shape.id);
        continue;
      }
      if (isPolygonShapeType(shape.shapeType)) {
        if (hitTestPolygonShape(shape, x, y, radius)) hits.push(shape.id);
        continue;
      }
      const x0 = Math.min(shape.x, shape.x + shape.width);
      const w = Math.abs(shape.width);
      const y0 = Math.min(shape.y, shape.y + shape.height);
      const h = Math.abs(shape.height);
      const cx = x0 + w / 2;
      const cy = y0 + h / 2;
      const angle = -(shape.rotation || 0) * Math.PI / 180;
      const dx = x - cx;
      const dy = y - cy;
      const lx = dx * Math.cos(angle) - dy * Math.sin(angle);
      const ly = dx * Math.sin(angle) + dy * Math.cos(angle);
      const pad = radius + (shape.strokeWidth || 2) / 2;

      if (shape.shapeType === 'ellipse') {
        const rx = w / 2 + pad;
        const ry = h / 2 + pad;
        if (rx > 0 && ry > 0 && (lx / rx) ** 2 + (ly / ry) ** 2 <= 1) {
          hits.push(shape.id);
        }
      } else if (Math.abs(lx) <= w / 2 + pad && Math.abs(ly) <= h / 2 + pad) {
        hits.push(shape.id);
      }
    }
    return hits;
  }
}
