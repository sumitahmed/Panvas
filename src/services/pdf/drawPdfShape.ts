import { rgb, type PDFPage } from 'pdf-lib';
import { isLinearShapeType, type Shape } from '../../components/notebook/engine/drawingTypes.ts';
import { getShapePolygonVertices } from '../../components/notebook/engine/shapePolygonGeometry.ts';
import { drawPdfLine } from './drawPdfLine.ts';
export function drawPdfShape(page: PDFPage, shape: Shape, sx = 1, sy = 1) {
  if (isLinearShapeType(shape.shapeType)) { drawPdfLine(page, shape, sx, sy); return; }
  const cx = shape.x + shape.width / 2, cy = shape.y + shape.height / 2;
  const polyVertices = getShapePolygonVertices(shape.shapeType, shape.x, shape.y, shape.width, shape.height);
  let points: { x: number; y: number }[];
  if (polyVertices) points = polyVertices;
  else if (shape.shapeType === 'ellipse') points = Array.from({ length: 96 }, (_, i) => ({ x: cx + Math.cos(i * Math.PI / 48) * shape.width / 2, y: cy + Math.sin(i * Math.PI / 48) * shape.height / 2 }));
  else if (shape.shapeType === 'rounded-rectangle') {
    const r = Math.min(16, Math.abs(shape.width) / 4, Math.abs(shape.height) / 4);
    const corners = [[shape.x + shape.width - r, shape.y + r, -Math.PI / 2], [shape.x + shape.width - r, shape.y + shape.height - r, 0], [shape.x + r, shape.y + shape.height - r, Math.PI / 2], [shape.x + r, shape.y + r, Math.PI]];
    points = corners.flatMap(([x, y, angle]) => Array.from({ length: 13 }, (_, i) => ({ x: x + r * Math.cos(angle + i * Math.PI / 24), y: y + r * Math.sin(angle + i * Math.PI / 24) })));
  } else points = [{ x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y }, { x: shape.x + shape.width, y: shape.y + shape.height }, { x: shape.x, y: shape.y + shape.height }];
  const angle = (shape.rotation || 0) * Math.PI / 180;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${(cx + (p.x - cx) * Math.cos(angle) - (p.y - cy) * Math.sin(angle)) * sx} ${(cy + (p.x - cx) * Math.sin(angle) + (p.y - cy) * Math.cos(angle)) * sy}`).join(' ') + ' Z';
  const color = (value: string) => { const hex = /^#[\da-f]{6}$/i.test(value) ? value.slice(1) : '20242a'; return rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4), 16) / 255); };
  page.drawSvgPath(path, { x: 0, y: page.getHeight(), color: shape.fill ? color(shape.fill) : undefined, borderColor: color(shape.color), borderWidth: shape.strokeWidth * (sx + sy) / 2, opacity: shape.opacity ?? 1, borderOpacity: shape.opacity ?? 1 });
}
