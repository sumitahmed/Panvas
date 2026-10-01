import { defaultRemoteRecordLocalAdapter } from '../applyRemoteChanges.ts';
import { LocalSyncPayloadSource } from '../payloadSource.ts';
import { db } from '../../../database/schema.ts';
import { sha256Bytes } from '../hash.ts';
import { cloudApplyFailure, CloudOperationError } from '../errors.ts';
import { contentIdentity } from './contentIdentity.ts';
import type { SyncV2LocalAdapter, SyncV2LocalSource } from './types.ts';

const payloadSource = new LocalSyncPayloadSource();

export const syncV2LocalSource: SyncV2LocalSource = {
  beginCycle: () => payloadSource.beginCycle(),
  endCycle: () => payloadSource.endCycle(),
  canRepairMissingRemoteObjects: () => typeof window !== 'undefined' && Boolean(window.panvas),
  listWorkspaceIds: () => payloadSource.listWorkspaceIds(),
  scanWorkspace: workspaceId => payloadSource.scanWorkspace(workspaceId),
  scanWorkspaceSnapshot: workspaceId => payloadSource.scanWorkspaceSnapshot(workspaceId),
  scanWorkspaceIncludingUnowned: workspaceId => payloadSource.scanWorkspaceIncludingUnowned!(workspaceId),
  scanFreshWorkspace: workspaceId => new LocalSyncPayloadSource().scanWorkspaceIncludingUnowned!(workspaceId),
  getRecoveryWorkspaceRoot: workspaceId => payloadSource.getRecoveryWorkspaceRoot(workspaceId),
};

export const syncV2LocalAdapter: SyncV2LocalAdapter = {
  async applyWorkspace({ workspaceId, expected, expectedHashes, downloads, allowStaleOwnershipRepair = false, assertCurrent = () => {} }) {
    try {
      assertCurrent();
      // Validate outside the write transaction. Chromium can return an empty
      // nested read transaction when the database is already being written.
      const fresh = await new LocalSyncPayloadSource().scanWorkspaceIncludingUnowned(workspaceId);
      const byKey = new Map(fresh.map(item => [`${item.entityType}:${item.entityId}`, item]));
      for (const item of expected) {
        const current = byKey.get(`${item.entityType}:${item.entityId}`);
        let unchanged = Boolean(current && current.tombstone === item.tombstone && item.tombstone);
        if (current && item.bytes && current.bytes && !item.tombstone && !current.tombstone) {
          const [currentHash, expectedHash] = await Promise.all([sha256Bytes(current.bytes), expectedHashes?.get(`${item.entityType}:${item.entityId}`) ?? sha256Bytes(item.bytes)]);
          unchanged = currentHash === expectedHash;
          if (!unchanged && allowStaleOwnershipRepair
            && (current.ownership === 'unowned-recovery' || current.ownership === 'foreign-recovery')
            && (item.ownership === 'unowned-recovery' || item.ownership === 'foreign-recovery')) {
            unchanged = await contentIdentity(item.entityType, current.bytes) === await contentIdentity(item.entityType, item.bytes);
          }
        }
        if (!unchanged) throw new CloudOperationError('conflict', { stage: 'local-recovery-check', reason: 'local-edit-during-sync', workspaceId, entityKind: item.entityType, entityId: item.entityId, retryable: false });
        byKey.delete(`${item.entityType}:${item.entityId}`);
      }
      if (byKey.size) {
        const item = byKey.values().next().value!;
        throw new CloudOperationError('conflict', { stage: 'local-recovery-check', reason: 'local-edit-during-sync', workspaceId, entityKind: item.entityType, entityId: item.entityId, retryable: false });
      }
      const apply = async () => {
        assertCurrent();
        downloads = [...downloads].sort((a, b) => {
          const phase = { workspace: 0, folder: 1, notebook: 2, notebookSection: 3, notebookPage: 4, canvasFile: 4, pageContent: 5, pageDrawing: 5, canvasScene: 5, customBlock: 6, asset: 7 };
          return phase[a.record.kind] - phase[b.record.kind];
        });
        const incomingRoot = downloads.find(item => item.record.kind === 'workspace' && item.record.id === workspaceId);
        const liveChildren = downloads.some(item => item.record.kind !== 'workspace' && !item.record.tombstone);
        if (liveChildren && incomingRoot?.record.tombstone) throw new CloudOperationError('remote-workspace', { stage: 'workspace-preflight', reason: 'remote-workspace-root-deleted-with-live-children', workspaceId, retryable: false });
        if (!(typeof window !== 'undefined' && window.panvas)) {
          // Check inside the same transaction that applies the graph. No
          // child reaches applyBrowserRecord unless a root exists or a valid
          // root heads this batch. A missing parent is an integrity issue.
          const currentRoot = await db.workspaces.get(workspaceId);
          if (!currentRoot && !downloads.some(item => !item.record.tombstone)) return;
          if (liveChildren && (!currentRoot || currentRoot.deletedAt)) {
            let root: any = null;
            try { root = incomingRoot?.bytes ? JSON.parse(new TextDecoder().decode(incomingRoot.bytes)) : null; } catch { /* reported below */ }
            if (!root || root.id !== workspaceId || root.deletedAt || incomingRoot?.record.tombstone) throw new CloudOperationError('remote-workspace', { stage: 'workspace-preflight', reason: 'remote-workspace-root-missing', workspaceId, entityKind: 'workspace', entityId: workspaceId, retryable: false });
          }
        }
        const nativeBatch = typeof window !== 'undefined' && window.panvas?.cloudsync?.applyRemoteRecords;
        if (nativeBatch) {
            const metadata: Array<{ kind: typeof downloads[number]['record']['kind']; id: string; parentId: string | null; payload: unknown; tombstone: boolean }> = [];
          const assets: typeof downloads = [];
          for (const download of downloads) {
            if (download.record.kind === 'asset') { assets.push(download); continue; }
            let payload: unknown = null;
            if (!download.record.tombstone) {
              try { payload = JSON.parse(new TextDecoder().decode(download.bytes ?? new Uint8Array())); }
              catch (error) {
                throw cloudApplyFailure(error, { workspaceId, entityKind: download.record.kind, entityId: download.record.id, parentId: download.record.parentId, schemaVersion: 2, stage: 'local-record-apply', operation: 'decode', throwingFunction: 'syncV2LocalAdapter.applyWorkspace' });
              }
            }
            metadata.push({ kind: download.record.kind, id: download.record.id, parentId: download.record.parentId, payload, tombstone: download.record.tombstone });
          }
          // WorkspaceService snapshots and rolls back the complete native
          // workspace directory for this metadata batch. Binary assets remain
          // last and are independently idempotent; a retry repairs an asset
          // without reapplying or corrupting the hierarchy.
          if (metadata.length) {
            const applied = await window.panvas.cloudsync.applyRemoteRecords(workspaceId, metadata);
            if (!applied.success) throw new CloudOperationError(applied.errorCode, applied.diagnostic);
          }
          for (const download of assets) {
            assertCurrent();
            await syncV2LocalAdapter.applyRecord({ workspaceId, ...download, allowStaleOwnershipRepair });
          }
        } else {
          for (const download of downloads) {
            assertCurrent();
            await syncV2LocalAdapter.applyRecord({ workspaceId, ...download, allowStaleOwnershipRepair });
          }
        }
        assertCurrent();
      };
      if (typeof window !== 'undefined' && window.panvas) await apply();
      else await db.transaction('rw', db.tables, apply);
    } catch (error) {
      throw cloudApplyFailure(error, {
        workspaceId,
        entityKind: 'workspace',
        entityId: workspaceId,
        operation: 'apply-workspace',
        stage: 'local-record-apply',
        schemaVersion: 2,
        throwingFunction: 'syncV2LocalAdapter.applyWorkspace',
      });
    }
  },
  applyRecord({ workspaceId, record, bytes, allowStaleOwnershipRepair = false }) {
    return defaultRemoteRecordLocalAdapter.applyRecord({
      workspaceId,
      pointer: {
        kind: record.kind,
        id: record.id,
        parentId: record.parentId,
        revision: 1,
        baseRevision: null,
        contentHash: record.hash ?? 'tombstone',
        tombstone: record.tombstone,
        encoding: record.encoding,
      },
      bytes,
      allowStaleOwnershipRepair,
      schemaVersion: 2,
    });
  },
};
