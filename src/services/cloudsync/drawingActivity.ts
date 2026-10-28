/**
 * Tracks renderer-side drawing contact so background Cloud Sync can avoid
 * starting a workspace scan while ink is being written. This is intentionally
 * independent of persistence: local saves and retries never consult it.
 *
 * Owners are object identities rather than a single boolean so an unmounting
 * renderer cannot clear another renderer's active gesture.
 */
const activeOwners = new Set<object>();
let lastActivityAt = 0;

export function setDrawingGestureActive(owner: object, active: boolean, now = Date.now()): void {
  if (active) activeOwners.add(owner);
  else activeOwners.delete(owner);
  lastActivityAt = now;
}

/** True during contact and for `idleMs` after the last contact boundary. */
export function isDrawingRecentlyActive(idleMs: number, now = Date.now()): boolean {
  return activeOwners.size > 0 || now - lastActivityAt < idleMs;
}
