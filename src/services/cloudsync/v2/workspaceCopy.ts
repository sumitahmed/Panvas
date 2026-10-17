import { canonicalizeJson, sha256Bytes } from '../hash.ts';
import { decodeAssetEnvelope, encodeAssetEnvelope } from '../assetEnvelope.ts';
import { parsePdfAnnotationStorageId } from '../../../lib/pdfAnnotationStorage.ts';
import { CloudOperationError } from '../errors.ts';
import type { ScannedSyncEntity } from '../engine.ts';

/** A user-requested second replica. IDs derive from the complete snapshot so
 * a retry of the same choice reuses the same copy, including its binaries. */
export async function copyWorkspaceGraph(profileId: string, workspaceId: string, entities: readonly ScannedSyncEntity[]) {
  const encode = (value: unknown) => new TextEncoder().encode(canonicalizeJson(value));
  const root = entities.find(item => item.entityType === 'workspace' && item.entityId === workspaceId && !item.tombstone);
  if (!root?.bytes) throw new CloudOperationError('remote-workspace', { stage: 'conflict-copy', reason: 'local-workspace-root-missing', workspaceId, retryable: false });
  const identities = await Promise.all(entities.map(async item => [item.entityType, item.entityId, item.parentId, item.tombstone, item.bytes ? await sha256Bytes(item.bytes) : null]));
  identities.sort((a, b) => String(a).localeCompare(String(b)));
  const fingerprint = await sha256Bytes(encode({ profileId, workspaceId, identities }));
  const copyId = `ws-copy-${fingerprint.slice(0, 40)}`;
  const ids = new Map<string, string>([[workspaceId, copyId]]);
  for (const item of entities) {
    if (ids.has(item.entityId) || parsePdfAnnotationStorageId(item.entityId)) continue;
    const hash = await sha256Bytes(encode([fingerprint, item.entityId]));
    ids.set(item.entityId, `${item.entityType === 'asset' ? 'asset' : 'copy'}-${hash.slice(0, 40)}`);
  }
  for (const item of entities) {
    const annotation = parsePdfAnnotationStorageId(item.entityId);
    if (annotation) ids.set(item.entityId, `${ids.get(annotation.ownerPageId) ?? annotation.ownerPageId}_pdf_${annotation.sourcePage}`);
  }
  // Only structural/reference fields are rewritten. User text, URLs, and
  // drawing object IDs not present in the workspace graph are preserved.
  const references = new Set(['id', 'workspaceId', 'parentId', 'folderId', 'notebookId', 'sectionId', 'pageId', 'canvasFileId', 'canvasId', 'blockId', 'fileId', 'pdfDataId', 'audioFileId', 'imageFileId', 'ownerId', 'targetPageId', 'targetBlockId']);
  const remap = (value: any, field = ''): any => {
    if (typeof value === 'string') {
      if (references.has(field)) return ids.get(value) ?? value;
      if (field === 'href') try {
        const url = new URL(value); let changed = false;
        if (['https:', 'http:', 'file:'].includes(url.protocol)) for (const parameter of ['panvasPage', 'panvasBlock']) {
          const original = url.searchParams.get(parameter), replacement = original && ids.get(original);
          if (replacement) { url.searchParams.set(parameter, replacement); changed = true; }
        }
        if (changed) return url.href;
      } catch { /* Other links and user text are retained verbatim. */ }
      return value;
    }
    if (Array.isArray(value)) return value.map(item => remap(item, field));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [field === 'files' ? ids.get(key) ?? key : key, remap(item, key)]));
    return value;
  };
  const copied: ScannedSyncEntity[] = [];
  for (const item of entities) {
    let bytes: Uint8Array | null = null;
    if (!item.tombstone) {
      if (!item.bytes) throw new CloudOperationError('payload', { stage: 'conflict-copy', reason: 'local-payload-unavailable', workspaceId, entityKind: item.entityType, entityId: item.entityId, retryable: false });
      if (item.entityType === 'asset') {
        const envelope = decodeAssetEnvelope(item.bytes);
        if (!envelope) throw new CloudOperationError('payload', { stage: 'conflict-copy', reason: 'invalid-asset-envelope', workspaceId, entityId: item.entityId, retryable: false });
        bytes = encodeAssetEnvelope(remap(envelope.metadata), envelope.bytes);
      } else {
        const value = remap(JSON.parse(new TextDecoder().decode(item.bytes)));
        if (item.entityType === 'workspace') {
          value.name = `${value.name ?? 'Workspace'} (Device copy)`;
          value.isSystem = false;
          delete value.systemType;
          value.syncCopyOf = workspaceId;
          value.syncCopyFingerprint = fingerprint;
        }
        bytes = encode(value);
      }
    }
    copied.push({ ...item, workspaceId: copyId, entityId: ids.get(item.entityId)!, parentId: item.parentId ? ids.get(item.parentId) ?? item.parentId : null, bytes, ownership: 'current' });
  }
  return { workspaceId: copyId, fingerprint, entities: copied };
}
