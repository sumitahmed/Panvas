export interface PagePosition { id: string; x: number; y: number; width: number; height: number }

/** Preserve React state identity when scrolling leaves the resident rows unchanged. */
export function reuseResidentPageIds(previous: Set<string>, next: Set<string>): Set<string> {
  return previous.size === next.size && [...next].every(id => previous.has(id)) ? previous : next;
}

/** Geometry is in document coordinates. Retain the visible rows and one row
 * on either side; focus never removes a visible page from this window. */
export function residentPageIds(positions: PagePosition[], top: number, height: number): Set<string> {
  const bottom = top + height;
  let first = Infinity;
  let last = -Infinity;
  let hasVisible = false;
  for (let i = 0; i < positions.length; i += 1) {
    const p = positions[i];
    if (p.y + p.height >= top && p.y <= bottom) {
      hasVisible = true;
      if (p.y < first) first = p.y;
      if (p.y > last) last = p.y;
    }
  }
  if (!hasVisible) return new Set();

  let before = -Infinity;
  let after = Infinity;
  for (let i = 0; i < positions.length; i += 1) {
    const y = positions[i].y;
    if (y < first && y > before) before = y;
    if (y > last && y < after) after = y;
  }

  const resident = new Set<string>();
  for (let i = 0; i < positions.length; i += 1) {
    const p = positions[i];
    if (p.y >= before && p.y <= after) resident.add(p.id);
  }
  return resident;
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
