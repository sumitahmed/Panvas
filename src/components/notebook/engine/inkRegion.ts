import clipping from 'polygon-clipping';
import type { MultiPolygon, Pair } from 'polygon-clipping';
import type { Stroke } from './drawingTypes.ts';
import { strokeBoundsPadding } from './capsuleErase.ts';

export type InkRegion = MultiPolygon;
export type InkPoint = { x: number; y: number };

export function translateRegion(region: InkRegion, dx: number, dy: number): InkRegion {
  return region.map(polygon => polygon.map(ring => ring.map(([x, y]): Pair => [x + dx, y + dy])));
}

/** A continuous swept disk, with straight sides and sub-pixel arc approximation.
 * No interpolation gaps even if the OS sends only the two endpoints. */
export function eraserCapsule(start: InkPoint, end: InkPoint, radius: number): InkRegion {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  // Inscribed arcs differ from the disk by at most 0.025 page pixels.
  const steps = Math.max(16, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.025 / radius, 0.5))));
  const ring: Pair[] = [];
  for (const [center, initial] of [[end, angle - Math.PI / 2], [start, angle + Math.PI / 2]] as const) {
    for (let i = 0; i <= steps; i++) {
      const theta = initial + Math.PI * i / steps;
      ring.push([center.x + radius * Math.cos(theta), center.y + radius * Math.sin(theta)]);
    }
  }
  ring.push([...ring[0]]);
  return [[ring]];
}

/** Geometry is always page-local. The entire ruler, including both ends, is subtracted. */
export function exposedEraser(sweep: InkRegion, rulerBody: InkRegion): InkRegion {
  return rulerBody.length ? clipping.difference(sweep, rulerBody) : sweep;
}

export function strokeRegion(stroke: Stroke): InkRegion {
  const origin = stroke.points[0];
  if (!origin) return [];
  if (stroke.inkClip) return translateRegion(stroke.inkClip, origin.x, origin.y);
  // This domain contains the original rendered path, including pressure, grain,
  // curves and caps. Render that path once through the retained domain.
  const pad = strokeBoundsPadding(stroke);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of stroke.points) {
    left = Math.min(left, point.x - pad); right = Math.max(right, point.x + pad);
    top = Math.min(top, point.y - pad); bottom = Math.max(bottom, point.y + pad);
  }
  return [[[[left, top], [right, top], [right, bottom], [left, bottom], [left, top]]]];
}

export function regionIntersects(a: InkRegion, b: InkRegion): boolean {
  return a.length > 0 && b.length > 0 && clipping.intersection(a, b).length > 0;
}

/** Persist Boolean vector contours, not repainted fragments or a raster overlay. */
export function cutStroke(stroke: Stroke, erase: InkRegion): Stroke | null | undefined {
  const region = strokeRegion(stroke);
  if (!regionIntersects(region, erase)) return undefined;
  const remaining = clipping.difference(region, erase);
  if (!remaining.length) return null;
  const origin = stroke.points[0];
  return { ...stroke, inkClip: translateRegion(remaining, -origin.x, -origin.y) };
}

export function traceInkClip(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  if (!stroke.inkClip) return;
  const origin = stroke.points[0];
  ctx.beginPath();
  for (const polygon of stroke.inkClip) for (const ring of polygon) {
    if (!ring.length) continue;
    ctx.moveTo(ring[0][0] + origin.x, ring[0][1] + origin.y);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0] + origin.x, ring[i][1] + origin.y);
    ctx.closePath();
  }
  ctx.clip('evenodd');
}
