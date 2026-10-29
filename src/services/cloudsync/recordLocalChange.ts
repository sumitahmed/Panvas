/**
 * Local-save-first journaling entry point. Domain code calls this AFTER a
 * successful local mutation; it never throws into the caller, never performs
 * network work, and never blocks editing. Cloud traffic only ever happens
 * later via the sync engine + provider adapter.
 *
 * Payloads are journaled as references (entity id + content hash); note
 * contents and binary bytes are never included in journal records or logs.
 */
import { hashCanonical } from './hash.ts';
import { appendJournalEntry } from '@/database/syncJournalDB';
import type { SyncEntityKind, JournalOperation } from './types.ts';
import { CLOUD_SYNC_V2_ENABLED } from '@/config/features';

export interface LocalChangeRecord {
  entityType: SyncEntityKind;
  entityId: string;
  workspaceId: string;
  operation: JournalOperation;
  /** Hashable payload representation (metadata record or payload reference). */
  payload?: unknown;
  deletedAt?: number | null;
}

export async function recordLocalChange(change: LocalChangeRecord): Promise<void> {
  // If IndexedDB is not present in the runtime environment (e.g. Node test runner),
  // safely fail-closed and return immediately.
  if (typeof indexedDB === 'undefined' && typeof (globalThis as any).indexedDB === 'undefined') {
    return;
  }
  if (CLOUD_SYNC_V2_ENABLED || import.meta.env?.VITE_PANVAS_SYNC_V2 === 'true') {
    const { scheduleAutoCloudSync } = await import('@/stores/cloudSyncStore');
    scheduleAutoCloudSync();
    return;
  }
  try {
    const contentHash = change.operation === 'delete'
      ? null
      : await hashCanonical(change.payload ?? { entityId: change.entityId });
    await appendJournalEntry({
      entityType: change.entityType,
      entityId: change.entityId,
      workspaceId: change.workspaceId,
      operation: change.operation,
      contentHash,
      now: Date.now(),
      baseRevision: null,
      deletedAt: change.deletedAt ?? null,
      payloadRef: change.operation === 'delete' ? null : change.entityId,
    });
    const { scheduleAutoCloudSync } = await import('@/stores/cloudSyncStore');
    scheduleAutoCloudSync();
  } catch (error) {
    // Journaling failures must never surface into local editing flows.
    console.warn('[CloudSync] journaling skipped:', error instanceof Error ? error.name : 'unknown');
  }
}

/** Fire-and-forget variant for store/repository call sites. */
export function recordLocalChangeDetached(change: LocalChangeRecord): void {
  void recordLocalChange(change);
}
