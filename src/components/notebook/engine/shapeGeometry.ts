import { isLinearShapeType, type ShapeType } from './drawingTypes.ts';

export interface ShapeDragGeometry { x: number; y: number; width: number; height: number }

export function constrainShapeDrag(
  shapeType: ShapeType,
  start: { x: number; y: number },
  point: { x: number; y: number },
  constrain: boolean,
): ShapeDragGeometry {
  let dx = point.x - start.x;
  let dy = point.y - start.y;
  if (isLinearShapeType(shapeType)) {
    if (constrain) {
      const length = Math.hypot(dx, dy);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
      dx = Math.cos(angle) * length;
      dy = Math.sin(angle) * length;
    }
    return { x: start.x, y: start.y, width: dx, height: dy };
  }
  if (constrain) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * size;
    dy = Math.sign(dy || 1) * size;
  }
  return {
    x: Math.min(start.x, start.x + dx),
    y: Math.min(start.y, start.y + dy),
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}
