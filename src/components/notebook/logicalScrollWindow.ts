/** Finite CSS span; this is a viewport window, never a document length limit. */
export const LOGICAL_SCROLL_WINDOW = 1_000_000;
export function nextLogicalScrollBase(base: number, localY: number, extent: number): number {
  if (extent <= LOGICAL_SCROLL_WINDOW) return 0;
  if (localY > LOGICAL_SCROLL_WINDOW * .75 && base + LOGICAL_SCROLL_WINDOW < extent) return Math.min(extent - LOGICAL_SCROLL_WINDOW, base + LOGICAL_SCROLL_WINDOW * .5);
  if (localY < LOGICAL_SCROLL_WINDOW * .25 && base > 0) return Math.max(0, base - LOGICAL_SCROLL_WINDOW * .5);
  return base;
}
