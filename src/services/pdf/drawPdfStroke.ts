import { getPencilRenderPoint } from '../../components/notebook/engine/strokeGeometry.ts';
import { BlendMode, setLineJoin, clipEvenOdd, closePath, endPath, lineTo, moveTo, popGraphicsState, pushGraphicsState, rgb, type PDFPage } from 'pdf-lib';
import type { Stroke } from '../../components/notebook/engine/drawingTypes.ts';
import { buildInkFamilyGeometry, inkPolygonsPath } from '../../components/notebook/engine/inkFamilyGeometry.ts';
import { buildStrokePatternGeometry } from '../../components/notebook/engine/strokePatternGeometry.ts';
import { penGeometrySvg } from '../../components/notebook/engine/penGeometry.ts';

export function drawPdfStroke(page: PDFPage, stroke: Stroke, sx = 1, sy = 1) {
  const hex = /^#[\da-f]{6}$/i.test(stroke.color) ? stroke.color.slice(1) : '20242a';
  const color = rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4), 16) / 255);
  const h = page.getHeight(), alpha = Math.max(0, Math.min(1, stroke.opacity));
  page.pushOperators(pushGraphicsState());
  if (stroke.inkClip && stroke.points[0]) {
    const origin = stroke.points[0];
    for (const polygon of stroke.inkClip) for (const ring of polygon) {
      ring.forEach(([x, y], i) => page.pushOperators(i === 0 ? moveTo((x + origin.x) * sx, h - (y + origin.y) * sy) : lineTo((x + origin.x) * sx, h - (y + origin.y) * sy)));
      page.pushOperators(closePath());
    }
    page.pushOperators(clipEvenOdd(), endPath());
  }
  if (stroke.centerline === 'polyline' && stroke.tool === 'pen' && (stroke.pattern ?? 'solid') === 'solid') {
    const path = penGeometrySvg(stroke, sx, sy);
    if (path) page.drawSvgPath(path, { x: 0, y: h, color, opacity: alpha });
  } else if (stroke.inkFamily) {
    const polygons = buildInkFamilyGeometry(stroke).map(polygon => polygon.map(p => ({ x: p.x * sx, y: p.y * sy })));
    page.drawSvgPath(inkPolygonsPath(polygons), { x: 0, y: h, color, opacity: alpha });
  } else {
    const pattern = stroke.pattern ?? 'solid';
    const geometry = pattern === 'solid' ? { dots: [], dashes: [stroke.points] } : buildStrokePatternGeometry(stroke.points, pattern, stroke.thickness);
    const width = (pressure: number) => (stroke.tool === 'highlighter' ? Math.max(8, stroke.thickness * 6) : stroke.tool === 'marker' ? Math.max(4, stroke.thickness * 3) : Math.max(0.5, stroke.thickness * pressure * (stroke.tool === 'pencil' ? 1.5 : 2))) * (sx + sy) / 2;
    const opacity = alpha * (stroke.tool === 'highlighter' ? 0.4 : stroke.tool === 'pencil' ? 0.75 : 1);
    const blendMode = stroke.tool === 'highlighter' ? BlendMode.Multiply : BlendMode.Normal;
    const path = (points: { x: number; y: number }[]) => points.map((p, i) => `${i ? 'L' : 'M'}${p.x * sx} ${p.y * sy}`).join(' ');
    const draw = (path: string, borderWidth: number, cap: 0 | 1 | 2 = 1) => page.drawSvgPath(path, { x: 0, y: h, borderColor: color, borderWidth, borderOpacity: opacity, borderLineCap: cap, blendMode });
    page.pushOperators(setLineJoin(stroke.tool === 'marker' && pattern === 'solid' ? 2 : 1));
    for (const dot of geometry.dots) page.drawCircle({ x: dot.x * sx, y: h - dot.y * sy, size: width(dot.pressure) / 2, color, opacity, blendMode });
    if (pattern !== 'solid') {
      for (const dash of geometry.dashes) draw(path(dash), width(dash.reduce((sum, p) => sum + p.pressure, 0) / dash.length));
    } else if (stroke.tool === 'pen') {
      for (let i = 1; i < stroke.points.length; i++) {
        const a = stroke.points[i - 1], b = stroke.points[i], next = stroke.points[i + 1];
        draw(`M${a.x * sx} ${a.y * sy} ` + (next ? `Q${b.x * sx} ${b.y * sy} ${(b.x + next.x) / 2 * sx} ${(b.y + next.y) / 2 * sy}` : `L${b.x * sx} ${b.y * sy}`), width(b.pressure));
      }
    } else if (stroke.tool === 'pencil') {
      for (let pass = 0; pass < 2; pass++) draw(path(stroke.points.map(p => getPencilRenderPoint(p, pass))), Math.max(0.3, stroke.thickness * (stroke.points[stroke.points.length - 1]?.pressure ?? 0.5) * 0.75) * (sx + sy) / 2);
    } else if (stroke.points.length > 1) draw(path(stroke.points), width(1), stroke.tool === 'highlighter' ? 2 : 0);

  }
  page.pushOperators(popGraphicsState());
}
