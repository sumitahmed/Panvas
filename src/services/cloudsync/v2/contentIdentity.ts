import { canonicalizeJson, canonicalizeJsonAsync, sha256Bytes } from '../hash.ts';
import { decodeAssetEnvelope } from '../assetEnvelope.ts';
import type { SyncEntityKind } from '../types.ts';
import type { SyncTimeSlicer } from '../drawingActivity.ts';

/** Comparison only: keep legacy object bytes and SHA-256 addresses unchanged. */
export async function contentIdentity(kind: SyncEntityKind, bytes: Uint8Array, slicer?: SyncTimeSlicer): Promise<string | null> {
  try {
    if (slicer?.shouldYield()) await slicer.checkpoint();
    if (kind === 'asset') {
      const envelope = decodeAssetEnvelope(bytes);
      if (!envelope) return null;
      const { userId, ...metadata } = envelope.metadata;
      return canonicalizeJson({ metadata, bytesHash: await sha256Bytes(envelope.bytes) });
    }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (slicer?.shouldYield()) await slicer.checkpoint();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    // Only row-level bookkeeping is excluded. Nested document data, ordering,
    // parent IDs, deletion state and user preferences remain significant.
    const { userId, syncStatus, lastOpenedAt, updatedAt, ...content } = value;
    if (kind === 'folder' || kind === 'notebook' || kind === 'notebookSection') delete content.isExpanded;
    return slicer ? canonicalizeJsonAsync(content, slicer) : canonicalizeJson(content);
  } catch { return null; }
}
