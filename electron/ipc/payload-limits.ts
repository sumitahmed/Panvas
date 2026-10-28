export const MAX_JSON_PAYLOAD_BYTES = 10 * 1024 * 1024;
// Page drawings legitimately grow past the generic JSON bound: a 629-object
// handwriting page can exceed 10 MiB in compact form while the pretty-printed
// file on disk is ~18 MB. Keep a firm ceiling, but give drawings their own
// headroom so a single dense page cannot block every subsequent save.
export const MAX_DRAWING_PAYLOAD_BYTES = 64 * 1024 * 1024;

export function requireJsonPayload(value: unknown, label: string, maxBytes = MAX_JSON_PAYLOAD_BYTES): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error(`Invalid ${label}.`);
}

export function requireDrawingPayload(value: unknown): void {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_DRAWING_PAYLOAD_BYTES) throw new Error('Invalid content payload.');
    return;
  }
  requireJsonPayload(value, 'drawing payload', MAX_DRAWING_PAYLOAD_BYTES);
}

/** Cloud Sync applies page drawings through the same expanded ceiling. */
export function payloadLimitForEntityKind(kind: unknown): number {
  return kind === 'pageDrawing' ? MAX_DRAWING_PAYLOAD_BYTES : MAX_JSON_PAYLOAD_BYTES;
}

/** Per-record validation used by both single and batched remote apply. */
export function requireRemoteRecordPayload(record: { kind: unknown; tombstone: boolean; payload: unknown }): void {
  if (!record.tombstone) requireJsonPayload(record.payload, 'remote sync payload', payloadLimitForEntityKind(record.kind));
}
