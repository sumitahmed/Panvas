import type { Shape, ShapeType } from './drawingTypes.ts';

export interface PolygonPoint {
  x: number;
  y: number;
}

function buildRadialPolygon(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  sides: number,
): PolygonPoint[] {
  const step = (Math.PI * 2) / sides;
  return Array.from({ length: sides }, (_, i) => {
    const angle = -Math.PI / 2 + i * step;
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });
}

/** Returns true for closed polygon shape types rendered from ordered vertices. */
export function isPolygonShapeType(shapeType: ShapeType): boolean {
  return (
    shapeType === 'triangle'
    || shapeType === 'diamond'
    || shapeType === 'pentagon'
    || shapeType === 'hexagon'
    || shapeType === 'star'
  );
}

/**
 * Compute ordered local (unrotated) polygon vertices for polygon shapes,
 * or null for rectangles, rounded rectangles, ellipses, and linear shapes.
 */
export function getShapePolygonVertices(
  shapeType: ShapeType,
  x: number,
  y: number,
  width: number,
  height: number,
): PolygonPoint[] | null {
  const cx = x + width / 2;
  const cy = y + height / 2;
  const rx = Math.abs(width) / 2;
  const ry = Math.abs(height) / 2;

  switch (shapeType) {
    case 'triangle':
      return [
        { x: cx, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
      ];
    case 'diamond':
      return [
        { x: cx, y },
        { x: x + width, y: cy },
        { x: cx, y: y + height },
        { x, y: cy },
      ];
    case 'pentagon':
      return buildRadialPolygon(cx, cy, rx, ry, 5);
    case 'hexagon':
      return buildRadialPolygon(cx, cy, rx, ry, 6);
    case 'star': {
      const step = Math.PI / 5;
      return Array.from({ length: 10 }, (_, i) => {
        const angle = -Math.PI / 2 + i * step;
        const scale = i % 2 === 0 ? 1.0 : 0.40;
        return {
          x: cx + Math.cos(angle) * rx * scale,
          y: cy + Math.sin(angle) * ry * scale,
        };
      });
    }
    default:
      return null;
  }
}

/**
 * Hit-test a rotated polygon shape by rotating the query point into the shape's
 * local frame and checking interior containment or proximity to any boundary edge.
 */
export function hitTestPolygonShape(shape: Shape, x: number, y: number, radius: number): boolean {
  const vertices = getShapePolygonVertices(shape.shapeType, shape.x, shape.y, shape.width, shape.height);
  if (!vertices || vertices.length < 3) return false;

  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const angle = -((shape.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = x - cx;
  const dy = y - cy;
  const px = cx + dx * cos - dy * sin;
  const py = cy + dx * sin + dy * cos;

  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x;
    const yi = vertices[i].y;
    const xj = vertices[j].x;
    const yj = vertices[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  if (inside) return true;

  const pad = radius + (shape.strokeWidth || 2) / 2;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const lenSq = ex * ex + ey * ey;
    const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((px - a.x) * ex + (py - a.y) * ey) / lenSq)) : 0;
    if (Math.hypot(px - (a.x + t * ex), py - (a.y + t * ey)) <= pad) {
      return true;
    }
  }
  return false;
}
