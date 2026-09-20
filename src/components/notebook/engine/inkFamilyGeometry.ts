import type { InkFamily, Stroke, StrokePoint } from './drawingTypes.ts';
import { buildStrokePatternGeometry } from './strokePatternGeometry.ts';

export type InkPolygon = { x: number; y: number }[];
type Sample = { pressure: number; direction: number; distance: number; length: number; thickness: number };
/** Width strategies consume stabilized samples, never raw pointer input. */
const strategies: Record<InkFamily, (sample: Sample) => number> = {
  ballpoint: s => s.thickness * (0.7 + 0.6 * s.pressure),
  fountain: s => s.thickness * (0.3 + 2.4 * Math.abs(Math.sin(s.direction))) * (0.75 + 0.5 * s.pressure),
  brush: s => s.thickness * (0.25 + 3 * s.pressure ** 1.8) * Math.max(0.18, Math.min(1, s.distance / Math.max(1, s.thickness * 3), (s.length - s.distance) / Math.max(1, s.thickness * 4))),
  felt: s => Math.max(3, s.thickness * 2.5),
};
export const INK_FAMILIES = ['ballpoint', 'fountain', 'brush', 'felt'] as const;
/** Shared by full rendering and incremental wet ink; no trajectory filtering. */
export function inkWidthAt(family: InkFamily, sample: Sample): number {
  return Math.max(0.3, strategies[family](sample));
}
/** Conservative broad-phase width, evaluated at each strategy's maximum input.
 * Includes dotted fountain marks; no per-sample trigonometry is needed. */
export function getInkFamilyMaximumHalfWidth(stroke: Stroke): number {
  if (!stroke.inkFamily) return 0;
  const distance = Math.max(1, stroke.thickness * 4);
  return Math.max(.3, strategies[stroke.inkFamily]({pressure:1,direction:Math.PI/2,
    distance,length:distance*2,thickness:stroke.thickness})) / 2;
}
export function inkSampleWidths(stroke: Stroke, points = stroke.points): number[] {
  const family = stroke.inkFamily;
  if (!family) return points.map(() => stroke.thickness);
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  return points.map((point, i) => {
    const before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 1)];
    return Math.max(0.3, strategies[family]({ pressure: Math.max(0, Math.min(1, point.pressure ?? 0.5)), direction: Math.atan2(after.y - before.y, after.x - before.x), distance: distances[i], length: distances[distances.length - 1] ?? 0, thickness: stroke.thickness }));
  });
}
function disk(point: StrokePoint, radius: number): InkPolygon {
  return Array.from({ length: 20 }, (_, i) => ({ x: point.x + Math.cos(i * Math.PI / 10) * radius, y: point.y + Math.sin(i * Math.PI / 10) * radius }));
}
function inkMarks(stroke: Stroke) {
  const pattern = stroke.pattern ?? 'solid';
  return pattern === 'solid' ? { dashes: [stroke.points], dots: [] } : buildStrokePatternGeometry(stroke.points, pattern, stroke.thickness);
}
function inkDotWidth(stroke: Stroke, point: StrokePoint) {
  return Math.max(0.3, strategies[stroke.inkFamily!]({ pressure: point.pressure, direction: Math.PI / 2, distance: 100, length: 200, thickness: stroke.thickness }));
}
/** Same sample/mark widths as rendering; no guessed maximum for dotted/dashed nibs. */
export function getInkFamilyRenderHalfWidth(stroke: Stroke): number {
  const marks = inkMarks(stroke);
  let width = 0.3;
  for (const dash of marks.dashes) for (const sampleWidth of inkSampleWidths(stroke, dash)) width = Math.max(width, sampleWidth);
  for (const dot of marks.dots) width = Math.max(width, inkDotWidth(stroke, dot));
  return width / 2;
}

export function buildInkFamilyGeometry(stroke: Stroke): InkPolygon[] {
  if (!stroke.inkFamily || stroke.points.length < 2) return [];
  const marks = inkMarks(stroke);
  const polygons: InkPolygon[] = [];
  for (const points of marks.dashes) {
    const widths = inkSampleWidths(stroke, points);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const angle = Math.atan2(b.y - a.y, b.x - a.x), nx = -Math.sin(angle), ny = Math.cos(angle);
      const ra = widths[i - 1] / 2, rb = widths[i] / 2;
      polygons.push([{ x: a.x - nx * ra, y: a.y - ny * ra }, { x: b.x - nx * rb, y: b.y - ny * rb }, { x: b.x + nx * rb, y: b.y + ny * rb }, { x: a.x + nx * ra, y: a.y + ny * ra }]);
    }
    // Felt has flat ends; round nibs have continuous joins/caps.
    points.forEach((point, i) => { if (stroke.inkFamily !== 'felt' || (i > 0 && i < points.length - 1)) polygons.push(disk(point, widths[i] / 2)); });
  }
  for (const point of marks.dots) {
    const width = inkDotWidth(stroke, point);
    polygons.push(disk(point, Math.max(0.3, width) / 2));
  }
  return polygons;
}

export function inkPolygonsPath(polygons: InkPolygon[]): string {
  return polygons.map(polygon => polygon.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ') + ' Z').join(' ');
}

