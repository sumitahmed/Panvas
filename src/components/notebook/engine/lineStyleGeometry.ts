import type { Shape } from './drawingTypes.ts';
export const LINE_STYLES = ['solid', 'dashed', 'dotted', 'double', 'wavy', 'zigzag'] as const;
export type LineStyle = typeof LINE_STYLES[number];
export type LinePoint = { x: number; y: number };
export function buildLineStyleGeometry(shape: Shape) {
  const length = Math.hypot(shape.width, shape.height);
  const angle = Math.atan2(shape.height, shape.width), rotation = (shape.rotation || 0) * Math.PI / 180;
  const cx = shape.x + shape.width / 2, cy = shape.y + shape.height / 2;
  const map = (distance: number, offset = 0): LinePoint => {
    const x = shape.x + Math.cos(angle) * distance - Math.sin(angle) * offset - cx;
    const y = shape.y + Math.sin(angle) * distance + Math.cos(angle) * offset - cy;
    return { x: cx + x * Math.cos(rotation) - y * Math.sin(rotation), y: cy + x * Math.sin(rotation) + y * Math.cos(rotation) };
  };
  const paths: LinePoint[][] = [], dots: LinePoint[] = [];
  const style = shape.lineStyle ?? 'solid', width = Math.max(0.5, shape.strokeWidth);
  if (style === 'dotted') {
    for (let d = 0; d <= length; d += Math.max(5, width * 3)) dots.push(map(d));
  } else if (style === 'dashed') {
    const dash = Math.max(9, width * 4), gap = Math.max(6, width * 2);
    for (let d = 0; d < length; d += dash + gap) paths.push([map(d), map(Math.min(length, d + dash))]);
  } else if (style === 'double') {
    for (const offset of [-width, width]) paths.push([map(0, offset), map(length, offset)]);
  } else if (style === 'wavy' || style === 'zigzag') {
    const cycles = Math.max(1, Math.round(length / Math.max(20, width * 8)));
    const steps = cycles * (style === 'wavy' ? 24 : 4);
    const amplitude = Math.min(length / 8, Math.max(3, width * 1.5));
    paths.push(Array.from({ length: steps + 1 }, (_, i) => map(length * i / steps, amplitude * (style === 'wavy' ? Math.sin(i / steps * cycles * Math.PI * 2) : [0, 1, 0, -1][i % 4]))));
  } else paths.push([map(0), map(length)]);
  const barb = Math.min(15, Math.max(6, length * 0.35));
  if (shape.shapeType === 'arrow' || shape.shapeType === 'double-arrow') {
    for (const sign of [-1, 1]) paths.push([map(length), map(length - barb * Math.cos(Math.PI / 6), sign * barb * Math.sin(Math.PI / 6))]);
  }
  if (shape.shapeType === 'double-arrow') {
    for (const sign of [-1, 1]) paths.push([map(0), map(barb * Math.cos(Math.PI / 6), sign * barb * Math.sin(Math.PI / 6))]);
  }
  const all = [...paths.flat(), ...dots];
  if (!all.length) all.push(map(0));
  const xs = all.map(p => p.x), ys = all.map(p => p.y);
  return { paths, dots, radius: width / 2, bounds: { x: Math.min(...xs) - width / 2, y: Math.min(...ys) - width / 2, width: Math.max(...xs) - Math.min(...xs) + width, height: Math.max(...ys) - Math.min(...ys) + width } };
}
export function lineStyleHit(shape: Shape, point: LinePoint, tolerance: number) {
  const geometry = buildLineStyleGeometry(shape), radius = geometry.radius + tolerance;
  if (geometry.dots.some(dot => Math.hypot(dot.x - point.x, dot.y - point.y) <= radius)) return true;
  return geometry.paths.some(path => path.slice(1).some((b, i) => {
    const a = path[i], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) <= radius;
  }));
}
