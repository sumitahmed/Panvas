import Dexie from 'dexie';
import { db } from '../../database/schema.ts';
import { currentBrowserUserId } from './payloadSource.ts';
import { decodeAssetEnvelope } from './assetEnvelope.ts';
import { cloudApplyFailure, CloudOperationError, type CloudErrorCode } from './errors.ts';
import { parsePdfAnnotationStorageId } from '../../lib/pdfAnnotationStorage.ts';
import type { RecordPointer } from './types.ts';

/** A remote identity may create a replica, and may repair a stale ownership
 * stamp only after the V2 engine has proved that the cloud copy is canonical
 * and the local bytes were unchanged. */
export async function applyBrowserRecord(workspaceId: string, pointer: RecordPointer, bytes: Uint8Array | null, options: { allowStaleOwnershipRepair?: boolean; schemaVersion?: string | number } = {}): Promise<void> {
  const userId = currentBrowserUserId();
  const tables = {
    workspace: db.workspaces, folder: db.folders, notebook: db.notebooks,
    notebookSection: db.notebookSections, notebookPage: db.notebookPages,
    pageContent: db.notebookPageContents, pageDrawing: db.notebookPageDrawings,
    canvasFile: db.canvasFiles, canvasScene: db.canvasData, customBlock: db.customBlocks,
  };
  let appliedSchemaVersion: string | number | undefined;
  // Account migration is an explicit, device-level ownership action. A
  // record that cannot be applied because its local owner/parent is
  // incompatible is a data conflict (or malformed payload), not evidence
  // that the Google account changed. Mapping these failures to
  // account-migration-required made a normal reconciliation failure reopen
  // the same "Use this account" loop.
  const fail = (reason: string): never => { throw new CloudOperationError(browserRecordApplyFailureCode(reason), {
    stage: 'browser-record-apply', reason, workspaceId, entityKind: pointer.kind, entityId: pointer.id,
    operation: pointer.tombstone ? 'delete' : 'apply', throwingFunction: 'applyBrowserRecord', errorMessage: reason, retryable: false,
  }); };
  const owned = (row: any) => {
    const ownerMatches = row && ((row.userId || null) === userId && (!row.workspaceId || row.workspaceId === workspaceId));
    const staleOwnershipRecovery = row && options.allowStaleOwnershipRepair === true && (!row.workspaceId || row.workspaceId === workspaceId);
    if (row && !ownerMatches && !staleOwnershipRecovery) fail('local-owner-mismatch');
    return row;
  };
  const apply = async () => {
    if (currentBrowserUserId() !== userId) fail('local-user-changed');
    const root = owned(await db.workspaces.get(workspaceId));
    if (pointer.kind !== 'workspace' && !root) fail('workspace-unavailable');
    if (pointer.kind === 'workspace' && pointer.id !== workspaceId) fail('workspace-identity-mismatch');
    const asset = pointer.kind === 'asset';
    const target: any = asset ? null : tables[pointer.kind as keyof typeof tables];
    if (!asset && !target) fail('unsupported-record-kind');
    const pdf = asset ? owned(await db.pdfFiles.get(pointer.id)) : null;
    const image = asset ? owned(await db.imageFiles.get(pointer.id)) : null;
    const existing = asset ? pdf ?? image : owned(await target.get(pointer.id));
    const checkOwner = async (ownerId: string) => {
      const canonicalId = parsePdfAnnotationStorageId(ownerId)?.ownerPageId ?? ownerId;
      const owner = canonicalId === workspaceId ? root
        : owned(await db.canvasFiles.get(canonicalId)) ?? owned(await db.notebookPages.get(canonicalId)) ?? owned(await db.notebooks.get(canonicalId));
      if (!owner) fail('parent-unavailable');
    };
    if (pointer.tombstone) {
      if (!existing) return;
      if (asset) { await db.pdfFiles.delete(pointer.id); await db.imageFiles.delete(pointer.id); }
      else if (['workspace', 'folder', 'notebook', 'notebookSection', 'notebookPage', 'canvasFile'].includes(pointer.kind)) await target.update(pointer.id, { deletedAt: Date.now() });
      else await target.delete(pointer.id);
      return;
    }
    // A delete is idempotent and must not require a parent that may already
    // have been deleted. Live records still require their canonical owner.
    // Asset rows live in global tables and survive workspace loss, so an
    // existing asset row's previous parent can be stale (its page or canvas
    // no longer exists) even when the incoming remote asset is fully valid.
    // That stale relationship must not block replacement: the incoming
    // record's canonical owner is validated below, and the replaced bytes
    // stay recoverable through the engine's recovery copy.
    if (!asset) {
      if (existing?.canvasFileId) await checkOwner(existing.canvasFileId);
      if (existing?.pageId) await checkOwner(existing.pageId);
    }
    if (!bytes) fail('payload-unavailable');
    const envelope = asset ? decodeAssetEnvelope(bytes!) : null;
    if (asset && !envelope) fail('invalid-asset-envelope');
    let value = asset ? { ...envelope!.metadata, canvasFileId: envelope!.metadata.ownerId } : JSON.parse(new TextDecoder().decode(bytes!));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-payload');
    appliedSchemaVersion = options.schemaVersion ?? value.schemaVersion ?? value.version ?? (asset ? 'asset-envelope-v1' : 'legacy-v2');
    value = await normalizeLegacyBrowserPayload(pointer, workspaceId, value, existing, tables, fail);
    const identity = pointer.kind === 'canvasScene' ? value.canvasFileId : pointer.kind === 'pageContent' || pointer.kind === 'pageDrawing' ? value.pageId : value.id;
    if (identity !== pointer.id || (value.workspaceId && value.workspaceId !== workspaceId)) fail('payload-identity-mismatch');
    // Validate the canonical owner, independently of untrusted remote userId.
    if (pointer.kind !== 'workspace') {
      const ownerId = asset || pointer.kind === 'canvasScene' || pointer.kind === 'customBlock' ? value.canvasFileId
        : pointer.kind === 'pageContent' || pointer.kind === 'pageDrawing' ? parsePdfAnnotationStorageId(value.pageId)?.ownerPageId ?? value.pageId
        : pointer.kind === 'notebookSection' || pointer.kind === 'notebookPage' ? value.notebookId
        : workspaceId;
      if (typeof ownerId !== 'string') fail('parent-unavailable');
      await checkOwner(ownerId);
    }
    if (currentBrowserUserId() !== userId) fail('local-user-changed');
    if (asset) {
      const metadata = envelope!.metadata;
      const row = { id: pointer.id, canvasFileId: metadata.ownerId, fileName: metadata.fileName, data: envelope!.bytes.slice().buffer, createdAt: metadata.createdAt, userId };
      if (metadata.assetKind === 'pdf') await db.pdfFiles.put(row);
      else await db.imageFiles.put({ ...row, mimeType: metadata.mimeType });
    } else await target.put({ ...value, userId });
  };

  try {
    // applyWorkspace deliberately wraps all browser writes in one Dexie
    // transaction. Do not open a nested transaction here: a nested write can
    // become inactive after an awaited read on Chromium and used to surface
    // as the opaque `reason: Error` at local-record-apply. Reuse the active
    // transaction when present; standalone record application still gets its
    // own durable transaction.
    if (Dexie.currentTransaction?.db === db) await apply();
    else await db.transaction('rw', [...Object.values(tables), db.pdfFiles, db.imageFiles], apply);
  } catch (error) {
    throw cloudApplyFailure(error, {
      workspaceId,
      entityKind: pointer.kind,
      entityId: pointer.id,
      parentId: pointer.parentId,
      stage: 'browser-record-apply',
      operation: pointer.tombstone ? 'delete' : 'apply',
      throwingFunction: 'applyBrowserRecord',
      schemaVersion: appliedSchemaVersion ?? pointer.encoding ?? undefined,
    });
  }
}

type BrowserTables = {
  workspace: typeof db.workspaces; folder: typeof db.folders; notebook: typeof db.notebooks;
  notebookSection: typeof db.notebookSections; notebookPage: typeof db.notebookPages;
  pageContent: typeof db.notebookPageContents; pageDrawing: typeof db.notebookPageDrawings;
  canvasFile: typeof db.canvasFiles; canvasScene: typeof db.canvasData; customBlock: typeof db.customBlocks;
};

/**
 * Normalize only known pre-V2 shapes. This is intentionally narrow: unknown
 * payloads still fail the identity/relationship checks below instead of being
 * accepted as arbitrary records.
 */
async function normalizeLegacyBrowserPayload(
  pointer: RecordPointer,
  workspaceId: string,
  raw: any,
  existing: any,
  tables: BrowserTables,
  fail: (reason: string) => never,
): Promise<any> {
  const value = { ...raw };
  const legacyVersion = value.schemaVersion ?? value.version ?? 1;
  if (pointer.kind === 'workspace') {
    if (value.id === undefined) value.id = pointer.id;
    return value;
  }
  if (pointer.kind === 'folder') {
    if (value.id === undefined) value.id = pointer.id;
    if (value.workspaceId === undefined) value.workspaceId = workspaceId;
    return value;
  }
  if (pointer.kind === 'notebook') {
    if (value.id === undefined) value.id = pointer.id;
    if (value.workspaceId === undefined) value.workspaceId = workspaceId;
    return value;
  }
  if (pointer.kind === 'notebookSection') {
    if (value.id === undefined) value.id = pointer.id;
    if (value.notebookId === undefined) value.notebookId = pointer.parentId;
    if (typeof value.notebookId !== 'string') fail('parent-unavailable');
    return value;
  }
  if (pointer.kind === 'notebookPage') {
    if (value.id === undefined) value.id = pointer.id;
    const section = typeof pointer.parentId === 'string' ? await tables.notebookSection.get(pointer.parentId) : undefined;
    if (value.notebookId === undefined) value.notebookId = existing?.notebookId ?? section?.notebookId;
    if (value.sectionId === undefined) value.sectionId = existing?.sectionId ?? pointer.parentId ?? value.notebookId;
    if (typeof value.notebookId !== 'string' || typeof value.sectionId !== 'string') fail('parent-unavailable');
    const canonicalSection = await tables.notebookSection.get(value.sectionId);
    if (!canonicalSection && value.sectionId !== value.notebookId) fail('parent-unavailable');
    if (canonicalSection && canonicalSection.notebookId !== value.notebookId) fail('invalid-relationship');
    return value;
  }
  if (pointer.kind === 'pageContent' || pointer.kind === 'pageDrawing') {
    const isWrapped = typeof value.pageId === 'string' && Object.prototype.hasOwnProperty.call(value, 'data');
    if (!isWrapped) {
      const page = await tables.notebookPage.get(pointer.id);
      value.pageId = pointer.id;
      value.workspaceId = value.workspaceId ?? workspaceId;
      value.notebookId = value.notebookId ?? page?.notebookId;
      value.data = raw;
      value.version = 1;
    }
    if (value.pageId === undefined) value.pageId = pointer.id;
    if (value.workspaceId === undefined) value.workspaceId = workspaceId;
    if (value.notebookId === undefined) {
      const page = await tables.notebookPage.get(pointer.id);
      value.notebookId = page?.notebookId;
    }
    if (typeof value.notebookId !== 'string') fail('parent-unavailable');
    return value;
  }
  if (pointer.kind === 'canvasFile') {
    if (value.id === undefined) value.id = pointer.id;
    if (value.workspaceId === undefined) value.workspaceId = workspaceId;
    return value;
  }
  if (pointer.kind === 'canvasScene') {
    if (value.canvasFileId === undefined) value.canvasFileId = value.id ?? pointer.id;
    return value;
  }
  if (pointer.kind === 'customBlock') {
    if (value.id === undefined) value.id = value.blockId ?? pointer.id;
    if (value.canvasFileId === undefined) value.canvasFileId = value.canvasId ?? pointer.parentId;
    if (typeof value.canvasFileId !== 'string') fail('parent-unavailable');
    return value;
  }
  // The version value is used only for diagnostics; asset bytes are validated
  // by decodeAssetEnvelope before this helper is called.
  void legacyVersion;
  return value;
}

/** Maps a guarded browser apply failure to the UI state that describes it.
 * Kept pure so the account-adoption regression can prove that ownership
 * collisions never masquerade as another-account migration. */
export function browserRecordApplyFailureCode(reason: string): CloudErrorCode {
  if (reason === 'local-owner-mismatch' || reason === 'workspace-unavailable' || reason === 'parent-unavailable') return 'conflict';
  if (reason === 'local-user-changed') return 'sync';
  return 'payload';
}
