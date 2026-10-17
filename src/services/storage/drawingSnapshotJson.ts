// Only detached, revision-owned snapshots opt in. Ordinary mutable repository
// callers are always encoded afresh. Weak keys do not retain old page scenes.
const encodedSnapshots = new WeakMap<object, string>();
export function rememberDrawingSnapshotJson(snapshot: object, json: string): void {
  encodedSnapshots.set(snapshot, json);
}
export function drawingSnapshotJson(data: unknown): string {
  return data !== null && typeof data === 'object'
    ? encodedSnapshots.get(data) ?? JSON.stringify(data)
    : JSON.stringify(data);
}
