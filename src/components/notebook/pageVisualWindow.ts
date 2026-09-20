export interface PagePosition { id: string; x: number; y: number; width: number; height: number }

/** Geometry is in document coordinates. Retain the visible rows and one row
 * on either side; focus never removes a visible page from this window. */
export function residentPageIds(positions: PagePosition[], top: number, height: number): Set<string> {
  const visible = positions.filter(p => p.y + p.height >= top && p.y <= top + height);
  if (!visible.length) return new Set();
  const first = Math.min(...visible.map(p => p.y));
  const last = Math.max(...visible.map(p => p.y));
  const before = Math.max(-Infinity, ...positions.filter(p => p.y < first).map(p => p.y));
  const after = Math.min(Infinity, ...positions.filter(p => p.y > last).map(p => p.y));
  return new Set(positions.filter(p => p.y >= before && p.y <= after).map(p => p.id));
}

export function dominantPageId(positions: PagePosition[], center: number, currentId: string, deadband: number): string | undefined {
  const current = positions.find(p => p.id === currentId);
  if (current && center >= current.y - deadband && center <= current.y + current.height + deadband) return current.id;
  let nearest: PagePosition | undefined;
  let distance = Infinity;
  for (const page of positions) {
    const next = Math.abs(page.y + page.height / 2 - center);
    if (next < distance) { nearest = page; distance = next; }
    if (center >= page.y && center <= page.y + page.height) return page.id;
  }
  return nearest?.id;
}
