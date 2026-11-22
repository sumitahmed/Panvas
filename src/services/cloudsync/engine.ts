/** Provider-neutral local-first reconcile engine. */
import type { CloudSyncProgress, CloudSyncProvider, CloudSyncStatus, JournalOperation, ProviderRequestMetrics, RecordPointer, SyncEntityKind, SyncJournalEntry } from './types.ts';
import { createJournalEntry, isAcknowledgedByManifest, markAttempt, transitionState } from './journal.ts';
import { decideConflict, type ConflictDecision } from './conflict.ts';
import { buildManifestV1, mergeRecords, pointerFromEntry, validateRemoteManifest } from './manifest.ts';
import { sha256Bytes } from './hash.ts';

export interface SyncJournalStore {
  listPending(workspaceId: string, now: number): Promise<SyncJournalEntry[]>;
  upsert(entry: SyncJournalEntry): Promise<void>;
  latestByEntity(workspaceId: string): Promise<Map<string, SyncJournalEntry>>;
  listUnresolved?(workspaceId: string): Promise<SyncJournalEntry[]>;
}

export interface SyncPayloadSource {
  loadPayload(entry: SyncJournalEntry): Promise<Uint8Array | null>;
  parentOf(entry: SyncJournalEntry): Promise<string | null>;
  scanWorkspace?(workspaceId: string): Promise<ScannedSyncEntity[]>;
}

export interface ScannedSyncEntity {
  entityType: SyncEntityKind;
  entityId: string;
  workspaceId: string;
  parentId: string | null;
  bytes: Uint8Array | null;
  precomputedHash?: string;
  loadBytes?: () => Promise<Uint8Array | null>;
  tombstone: boolean;
  deletedAt: number | null;
  /** Stale ownership rows may be considered only during verified recovery. */
  ownership?: 'current' | 'unowned-recovery' | 'foreign-recovery';
}

export interface DeviceManifestState { lastSeenRevision: number }
export type SyncEntryErrorClass = 'conflict' | 'provider-conflict' | 'payload-missing' | 'initial-scan-empty' | 'provider-error' | 'auth-expired' | 'rate-limited';

export interface SyncEntryError {
  entityId: string;
  entityType?: SyncEntityKind;
  operation?: JournalOperation;
  payloadRef?: string | null;
  stage: string;
  errorClass: SyncEntryErrorClass;
  providerStatus?: number;
  providerReason?: string;
  retryable?: boolean;
}

export interface SyncCycleResult {
  workspaceId: string;
  published: number;
  acknowledged: number;
  conflicts: Array<{ entityId: string; reason: Extract<ConflictDecision, { kind: 'conflict' }>['reason'] }>;
  errors: SyncEntryError[];
  manifestPublished: boolean;
  upToDate: boolean;
  needsRepull: boolean;
  unresolvedEntries: number;
  localEntitiesScanned: number;
  payloadsLoaded: number;
  objectsUploaded: number;
  objectsAlreadyPresent: number;
  manifestEntries: number;
  journalEntriesProcessed: number;
  remoteObjectsDownloaded: number;
  conflictsCreated: number;
  bytesUploaded: number;
  largeAssets: number;
  stageTimingsMs: Record<'manifestRead' | 'scan' | 'payloadLoadAndHash' | 'objectTransfer' | 'manifestWrite' | 'manifestReadBack' | 'total', number>;
  providerRequests: ProviderRequestMetrics;
  recordsForDownload: RecordPointer[];
}

export function accountSyncStatus(errors: number, conflicts: number, firstError: SyncEntryError | null, accountMigrationsRequired = 0): CloudSyncStatus {
  if (conflicts > 0) return 'conflict';
  if (errors > 0) {
    if (firstError?.errorClass === 'auth-expired') return 'auth-expired';
    if (firstError?.errorClass === 'rate-limited') return 'rate-limited';
    return 'error';
  }
  if (accountMigrationsRequired > 0) return 'account-migration-required';
  return 'synced';
}

export function finalizeAccountSync(
  errors: number,
  conflicts: number,
  firstError: SyncEntryError | null,
  completedAt: number,
  accountMigrationsRequired = 0,
): { status: CloudSyncStatus; lastSyncedAt: number | null } {
  const status = accountSyncStatus(errors, conflicts, firstError, accountMigrationsRequired);
  return { status, lastSyncedAt: status === 'synced' ? completedAt : null };
}

export class ProviderConflictError extends Error {
  constructor() { super('Remote manifest moved during sync (etag mismatch).'); this.name = 'ProviderConflictError'; }
}

const clock = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
const keyOf = (value: { entityType: SyncEntityKind; entityId: string }) => `${value.entityType}:${value.entityId}`;

async function mapConcurrent<T>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const count = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: count }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  }));
}

/** A manifest is publishable only when every live content-addressed object is
 * already readable from the provider. Returns the first dangling pointer. */
export async function firstMissingManifestObject(
  provider: CloudSyncProvider,
  workspaceId: string,
  records: readonly RecordPointer[],
  concurrency = 4,
): Promise<RecordPointer | null> {
  const liveByHash = new Map(records.filter(pointer => !pointer.tombstone).map(pointer => [pointer.contentHash, pointer]));
  let missing: RecordPointer | null = null;
  await mapConcurrent([...liveByHash.values()], concurrency, async pointer => {
    if (!missing && !(await provider.getMetadata(workspaceId, pointer.contentHash))) missing = pointer;
  });
  return missing;
}

function remoteHeadFor(pointer: RecordPointer | undefined) {
  return pointer ? { revision: pointer.revision, baseRevision: pointer.baseRevision, contentHash: pointer.contentHash, tombstone: pointer.tombstone } : null;
}

function providerFailure(error: unknown): Pick<SyncEntryError, 'errorClass' | 'providerStatus' | 'providerReason' | 'retryable'> {
  const candidate = error as { name?: string; status?: number; reason?: string };
  const name = String(candidate?.name ?? 'Error');
  const status = typeof candidate?.status === 'number' ? candidate.status : undefined;
  const errorClass: SyncEntryErrorClass = name === 'AuthExpiredError' || status === 401 ? 'auth-expired'
    : name === 'RateLimitedError' || status === 429 ? 'rate-limited'
      : 'provider-error';
  return {
    errorClass,
    providerStatus: status,
    providerReason: String(candidate?.reason ?? name),
    retryable: errorClass === 'rate-limited' || name === 'GoogleDriveTimeoutError' || name === 'AbortError' || name === 'TypeError' || status === 408 || Boolean(status && status >= 500),
  };
}

function parentIsLocallyTombstoned(entry: SyncJournalEntry, canonical: ReadonlyMap<string, ScannedSyncEntity>): boolean {
  if (entry.entityType === 'pageContent' || entry.entityType === 'pageDrawing') return canonical.get(`notebookPage:${entry.entityId}`)?.tombstone === true;
  if (entry.entityType === 'canvasScene') return canonical.get(`canvasFile:${entry.entityId}`)?.tombstone === true;
  return false;
}

function conflictReason(localTombstone: boolean, remoteTombstone: boolean): Extract<ConflictDecision, { kind: 'conflict' }>['reason'] {
  if (localTombstone && !remoteTombstone) return 'edit-vs-delete';
  if (!localTombstone && remoteTombstone) return 'delete-vs-edit';
  return 'concurrent-edit-edit';
}

function persistedConflictReason(entry: SyncJournalEntry, localTombstone: boolean, remoteTombstone: boolean): Extract<ConflictDecision, { kind: 'conflict' }>['reason'] {
  if (entry.lastErrorClass === 'concurrent-edit-edit' || entry.lastErrorClass === 'edit-vs-delete' || entry.lastErrorClass === 'delete-vs-edit') {
    return entry.lastErrorClass;
  }
  return conflictReason(localTombstone, remoteTombstone);
}

function newResult(workspaceId: string): SyncCycleResult {
  return {
    workspaceId, published: 0, acknowledged: 0, conflicts: [], errors: [], manifestPublished: false,
    upToDate: false, needsRepull: false, unresolvedEntries: 0, localEntitiesScanned: 0, payloadsLoaded: 0,
    objectsUploaded: 0, objectsAlreadyPresent: 0, manifestEntries: 0, journalEntriesProcessed: 0,
    remoteObjectsDownloaded: 0, conflictsCreated: 0, bytesUploaded: 0, largeAssets: 0,
    stageTimingsMs: { manifestRead: 0, scan: 0, payloadLoadAndHash: 0, objectTransfer: 0, manifestWrite: 0, manifestReadBack: 0, total: 0 },
    providerRequests: { requests: 0, retries: 0, backoffMs: 0, timeouts: 0 },
    recordsForDownload: [],
  };
}

export async function runSyncCycle(input: {
  workspaceId: string;
  deviceId: string;
  journalStore: SyncJournalStore;
  provider: CloudSyncProvider;
  payloadSource: SyncPayloadSource;
  deviceState: DeviceManifestState;
  now: number;
  objectConcurrency?: number;
  verifyObjectsBeforeManifest?: boolean;
  onProgress?: (progress: CloudSyncProgress) => void;
}): Promise<SyncCycleResult> {
  const { workspaceId, deviceId, journalStore, provider, payloadSource, deviceState, now, onProgress } = input;
  const concurrency = Math.min(5, Math.max(1, input.objectConcurrency ?? 4));
  const startedAt = clock();
  const result = newResult(workspaceId);
  const acknowledgedThisCycle = new Set<string>();
  provider.resetRequestMetrics?.();
  const progress = (stage: CloudSyncProgress['stage'], completed: number, total: number, message: string) => onProgress?.({ stage, completed, total, message });
  const finish = async () => {
    // The caller applies only remote state that this device did not just
    // publish/acknowledge. Genuinely remote records remain eligible for the
    // normal journal-aware apply pass below the engine boundary.
    result.recordsForDownload = result.recordsForDownload.filter(pointer => !acknowledgedThisCycle.has(`${pointer.kind}:${pointer.id}`));
    const unresolved = journalStore.listUnresolved ? await journalStore.listUnresolved(workspaceId) : [];
    result.unresolvedEntries = journalStore.listUnresolved ? unresolved.length : result.errors.length + result.conflicts.length;
    for (const entry of unresolved) {
      if (entry.state !== 'conflict' || result.conflicts.some(conflict => conflict.entityId === entry.entityId)) continue;
      const reason = entry.lastErrorClass === 'edit-vs-delete' || entry.lastErrorClass === 'delete-vs-edit'
        ? entry.lastErrorClass
        : 'concurrent-edit-edit';
      result.conflicts.push({ entityId: entry.entityId, reason });
    }
    if (result.errors.length === 0 && result.conflicts.length === 0) {
      // Never hide an unresolved entry behind a generic account-level error.
      // Older journal rows may have no lastErrorClass at all; their state is
      // still enough evidence that this workspace is not synchronized.
      const blocked = unresolved.find(entry => entry.lastErrorClass) ?? unresolved[0];
      if (blocked) {
        const errorClass: SyncEntryErrorClass = blocked.lastErrorClass === 'payload-missing' ? 'payload-missing' : blocked.lastErrorClass === 'auth-expired' ? 'auth-expired' : blocked.lastErrorClass === 'rate-limited' ? 'rate-limited' : 'provider-error';
        result.errors.push({ entityId: blocked.entityId, entityType: blocked.entityType, operation: blocked.operation, payloadRef: blocked.payloadRef, stage: 'retry-backoff', errorClass });
      }
    }
    result.upToDate = result.errors.length === 0 && result.conflicts.length === 0 && result.unresolvedEntries === 0;
    result.stageTimingsMs.total = Math.round(clock() - startedAt);
    result.providerRequests = provider.getRequestMetrics?.() ?? result.providerRequests;
    if (result.upToDate) progress('complete', 1, 1, result.published > 0 ? 'All changes synchronized' : 'Up to date');
    return result;
  };

  progress('preparing', 0, 1, 'Preparing sync…');
  const manifestReadAt = clock();
  const remoteRead = await provider.readManifest(workspaceId);
  result.stageTimingsMs.manifestRead = Math.round(clock() - manifestReadAt);
  const remoteManifest = remoteRead.manifest ? validateRemoteManifest(remoteRead.manifest) : null;
  if (remoteRead.manifest && !remoteManifest) {
    result.errors.push({ entityId: 'manifest', stage: 'manifest-read', errorClass: 'provider-error' });
    result.needsRepull = true;
    return finish();
  }
  if (remoteManifest) deviceState.lastSeenRevision = Math.max(deviceState.lastSeenRevision, remoteManifest.revision);
  const remoteRecords = remoteManifest?.records ?? [];
  result.recordsForDownload = remoteRecords;
  const bootstrapRequired = !remoteManifest || remoteRecords.length === 0;

  let scanned: ScannedSyncEntity[] | null = null;
  if (bootstrapRequired) {
    const scanAt = clock();
    scanned = payloadSource.scanWorkspace ? await payloadSource.scanWorkspace(workspaceId) : [];
    result.stageTimingsMs.scan += Math.round(clock() - scanAt);
    result.localEntitiesScanned = scanned.length;
    const latest = await journalStore.latestByEntity(workspaceId);
    for (const entity of scanned) {
      const existing = latest.get(keyOf(entity));
      if (existing && (existing.state === 'pending' || existing.state === 'syncing')) continue;
      if (!entity.tombstone && !entity.bytes) {
        result.errors.push({ entityId: entity.entityId, entityType: entity.entityType, operation: 'create', payloadRef: entity.entityId, stage: 'bootstrap-payload-load', errorClass: 'payload-missing' });
        continue;
      }
      const contentHash = entity.tombstone ? null : await sha256Bytes(entity.bytes!);
      await journalStore.upsert(createJournalEntry({
        entityType: entity.entityType, entityId: entity.entityId, workspaceId,
        operation: entity.tombstone ? 'delete' : 'create', currentLocalRevision: existing?.localRevision ?? 0,
        contentHash, baseRevision: null, deletedAt: entity.deletedAt, payloadRef: entity.tombstone ? null : entity.entityId,
        now, entryId: `bootstrap:${entity.entityType}:${entity.entityId}:${(existing?.localRevision ?? 0) + 1}`,
      }));
    }
  }

  // Objects uploaded before asset envelopes existed cannot reconstruct their
  // metadata on a fresh device. A device that still owns those assets performs
  // a one-time, explicit pointer migration; the old immutable object remains.
  const legacyAssetPointers = remoteRecords.filter(pointer => pointer.kind === 'asset' && !pointer.tombstone && pointer.encoding !== 'asset-envelope-v1');
  if (!bootstrapRequired && legacyAssetPointers.length > 0 && payloadSource.scanWorkspace) {
    const scanAt = clock();
    scanned = await payloadSource.scanWorkspace(workspaceId);
    result.stageTimingsMs.scan += Math.round(clock() - scanAt);
    result.localEntitiesScanned = scanned.length;
    const latest = await journalStore.latestByEntity(workspaceId);
    for (const pointer of legacyAssetPointers) {
      const entity = scanned.find(item => item.entityType === 'asset' && item.entityId === pointer.id && item.bytes);
      const existing = latest.get(`asset:${pointer.id}`);
      if (!entity?.bytes || (existing && (existing.state === 'pending' || existing.state === 'syncing'))) continue;
      await journalStore.upsert(createJournalEntry({ entityType: 'asset', entityId: pointer.id, workspaceId, operation: 'update', currentLocalRevision: Math.max(existing?.localRevision ?? 0, pointer.revision), contentHash: await sha256Bytes(entity.bytes), baseRevision: pointer.revision, payloadRef: pointer.id, now, entryId: `asset-envelope-migration:${pointer.id}:${pointer.revision + 1}` }));
    }
  }

  // Reconcile the canonical snapshot even when an older/detached journal write
  // was lost. A remote pointer is not authority merely because no local
  // pending row exists: that rule allowed a stale browser profile to replace
  // richer same-ID Electron entities. Unknown or divergent ancestry is now a
  // durable conflict, while proven one-sided descendants remain applicable.
  if (!bootstrapRequired && payloadSource.scanWorkspace) {
    if (!scanned) {
      const scanAt = clock();
      scanned = await payloadSource.scanWorkspace(workspaceId);
      result.stageTimingsMs.scan += Math.round(clock() - scanAt);
      result.localEntitiesScanned = scanned.length;
    }
    const latest = await journalStore.latestByEntity(workspaceId);
    const remoteByKey = new Map(remoteRecords.map(pointer => [`${pointer.kind}:${pointer.id}`, pointer]));
    const localKeys = new Set(scanned.map(keyOf));
    const unresolvedByKey = new Map<string, SyncJournalEntry[]>();
    if (journalStore.listUnresolved) {
      for (const entry of await journalStore.listUnresolved(workspaceId)) {
        const key = keyOf(entry);
        const rows = unresolvedByKey.get(key) ?? [];
        rows.push(entry);
        unresolvedByKey.set(key, rows);
      }
    }
    const supersedeUnresolved = async (key: string, predicate: (entry: SyncJournalEntry) => boolean = () => true) => {
      const rows = unresolvedByKey.get(key) ?? [];
      const remaining: SyncJournalEntry[] = [];
      for (const entry of rows) {
        if (predicate(entry)) await journalStore.upsert(transitionState(entry, 'superseded', now));
        else remaining.push(entry);
      }
      if (remaining.length) unresolvedByKey.set(key, remaining);
      else unresolvedByKey.delete(key);
    };

    // A previously attempted live upload with no canonical entity cannot be
    // retried: the bytes no longer exist. This is not treated as a deletion.
    // Superseding only an evidenced payload-missing retry leaves any remote
    // live record eligible for download and leaves any remote tombstone intact.
    for (const [key, rows] of unresolvedByKey) {
      if (localKeys.has(key) || !rows.some(entry => !entry.tombstone && entry.lastErrorClass === 'payload-missing')) continue;
      await supersedeUnresolved(key, entry => !entry.tombstone && entry.lastErrorClass === 'payload-missing');
      const current = latest.get(key);
      if (current && !current.tombstone && current.lastErrorClass === 'payload-missing') latest.delete(key);
    }

    for (const entity of scanned) {
      const key = keyOf(entity);
      if (!entity.tombstone && !entity.bytes) {
        result.errors.push({ entityId: entity.entityId, entityType: entity.entityType, operation: 'create', payloadRef: entity.entityId, stage: 'reconcile-payload-load', errorClass: 'payload-missing' });
        continue;
      }
      const localHash = entity.tombstone ? null : await sha256Bytes(entity.bytes!);
      const pointer = remoteByKey.get(key);
      const existing = latest.get(key);

      if (!pointer) {
        if (existing?.state === 'conflict') {
          result.conflicts.push({ entityId: entity.entityId, reason: persistedConflictReason(existing, entity.tombstone, false) });
          continue;
        }
        if (existing && (existing.state === 'pending' || existing.state === 'syncing' || existing.state === 'error')) continue;
        // Absence is not deletion. Re-publish the canonical local entity even
        // if an older synced baseline says it used to exist remotely.
        await journalStore.upsert(createJournalEntry({
          entityType: entity.entityType, entityId: entity.entityId, workspaceId,
          operation: entity.tombstone ? 'delete' : 'create', currentLocalRevision: existing?.localRevision ?? 0,
          contentHash: localHash, baseRevision: null,
          deletedAt: entity.deletedAt, payloadRef: entity.tombstone ? null : entity.entityId,
          now, entryId: `reconcile:${entity.entityType}:${entity.entityId}:${(existing?.localRevision ?? 0) + 1}`,
        }));
        continue;
      }

      const localMatchesRemote = entity.tombstone === pointer.tombstone
        && (entity.tombstone || localHash === pointer.contentHash);
      if (localMatchesRemote) {
        // Exact current canonical/remote equality is positive evidence that
        // every older retry/conflict row for this entity is obsolete. Keep the
        // rows as history, but remove them from unresolved account state.
        await supersedeUnresolved(key);
        const baseline: SyncJournalEntry = {
          entryId: `remote:${workspaceId}:${pointer.kind}:${pointer.id}:${pointer.revision}`,
          entityType: pointer.kind, entityId: pointer.id, workspaceId,
          operation: pointer.tombstone ? 'delete' : 'create', localRevision: pointer.revision,
          contentHash: pointer.tombstone ? null : pointer.contentHash, baseRevision: pointer.baseRevision,
          updatedAt: now, deletedAt: pointer.tombstone ? now : null, tombstone: pointer.tombstone,
          state: 'synced', attempts: 0, nextAttemptAt: null, lastErrorClass: null,
          payloadRef: pointer.tombstone ? null : pointer.id,
        };
        await journalStore.upsert(baseline);
        latest.set(key, baseline);
        continue;
      }

      if (existing?.state === 'conflict') {
        // A still-divergent persisted conflict is genuine. Surface it on every
        // run instead of silently skipping it and later reporting a fabricated
        // generic retry-backoff failure.
        result.conflicts.push({ entityId: entity.entityId, reason: persistedConflictReason(existing, entity.tombstone, pointer.tombstone) });
        continue;
      }
      if (existing && (existing.state === 'pending' || existing.state === 'syncing' || existing.state === 'error')) continue;

      const baseline = existing?.state === 'synced' ? existing : null;
      const localMatchesBaseline = Boolean(baseline)
        && entity.tombstone === baseline!.tombstone
        && (entity.tombstone || localHash === baseline!.contentHash);
      const remoteMatchesBaseline = Boolean(baseline)
        && pointer.tombstone === baseline!.tombstone
        && (pointer.tombstone || pointer.contentHash === baseline!.contentHash);
      const remoteDirectlyDescends = Boolean(baseline)
        && pointer.baseRevision === baseline!.localRevision
        && pointer.revision > baseline!.localRevision;

      if (localMatchesBaseline && remoteDirectlyDescends) {
        // Only the remote side changed, directly from the locally known base.
        await supersedeUnresolved(key, entry => entry.localRevision <= baseline!.localRevision);
        continue;
      }
      if (baseline && !localMatchesBaseline && remoteMatchesBaseline) {
        // Only the local side changed. Rebase onto an equivalent remote head
        // (which may have a higher revision but the same immutable hash).
        const operation: JournalOperation = entity.tombstone ? 'delete' : baseline.tombstone ? 'restore' : 'update';
        await journalStore.upsert(createJournalEntry({
          entityType: entity.entityType, entityId: entity.entityId, workspaceId,
          operation, currentLocalRevision: Math.max(baseline.localRevision, pointer.revision),
          contentHash: localHash, baseRevision: pointer.revision,
          deletedAt: entity.deletedAt, payloadRef: entity.tombstone ? null : entity.entityId,
          now, entryId: `reconcile-local:${entity.entityType}:${entity.entityId}:${Math.max(baseline.localRevision, pointer.revision) + 1}`,
        }));
        await supersedeUnresolved(key, entry => entry.localRevision <= baseline.localRevision);
        continue;
      }

      // No common base can be proven, or both sides changed. Keep the local
      // payload untouched and keep the remote immutable object referenced by
      // its manifest; the conflict journal makes the account remain non-green.
      const reason = conflictReason(entity.tombstone, pointer.tombstone);
      const protective = createJournalEntry({
        entityType: entity.entityType, entityId: entity.entityId, workspaceId,
        operation: entity.tombstone ? 'delete' : pointer.tombstone ? 'restore' : 'update',
        currentLocalRevision: Math.max(existing?.localRevision ?? 0, pointer.revision),
        contentHash: localHash,
        baseRevision: baseline ? baseline.localRevision : Math.max(0, pointer.revision - 1),
        deletedAt: entity.deletedAt, payloadRef: entity.tombstone ? null : entity.entityId,
        now, entryId: `reconcile-conflict:${entity.entityType}:${entity.entityId}:${Math.max(existing?.localRevision ?? 0, pointer.revision) + 1}`,
      });
      await journalStore.upsert({ ...protective, state: 'conflict', lastErrorClass: reason });
      result.conflicts.push({ entityId: entity.entityId, reason });
      result.conflictsCreated += 1;
    }
    for (const pointer of remoteRecords) {
      const key = `${pointer.kind}:${pointer.id}`;
      if (!pointer.tombstone || localKeys.has(key)) continue;
      const existing = latest.get(key);
      if (existing && ['pending', 'syncing', 'conflict', 'error'].includes(existing.state)) continue;
      const baseline: SyncJournalEntry = {
        entryId: `remote:${workspaceId}:${pointer.kind}:${pointer.id}:${pointer.revision}`,
        entityType: pointer.kind, entityId: pointer.id, workspaceId,
        operation: 'delete', localRevision: pointer.revision,
        contentHash: null, baseRevision: pointer.baseRevision,
        updatedAt: now, deletedAt: now, tombstone: true,
        state: 'synced', attempts: 0, nextAttemptAt: null, lastErrorClass: null, payloadRef: null,
      };
      await journalStore.upsert(baseline);
      latest.set(key, baseline);
    }
  }

  let pending = await journalStore.listPending(workspaceId, now);
  // A prior payload-missing attempt may still be in backoff. Reconcile the
  // current canonical snapshot before deciding whether it should remain
  // blocked: metadata writes and payload writes can legitimately finish in
  // different turns, so an entry that was missing bytes earlier must be
  // re-armed as soon as the bytes now exist. Deleted descendants are instead
  // superseded; they must not keep the whole workspace red forever.
  if (journalStore.listUnresolved) {
    const unresolved = await journalStore.listUnresolved(workspaceId);
    const delayedPayloadMissing = unresolved.filter(entry => entry.lastErrorClass === 'payload-missing');
    if (delayedPayloadMissing.length > 0) {
      if (!scanned && payloadSource.scanWorkspace) {
        const scanAt = clock();
        scanned = await payloadSource.scanWorkspace(workspaceId);
        result.stageTimingsMs.scan += Math.round(clock() - scanAt);
        result.localEntitiesScanned = scanned.length;
      }
      const recoveryCanonical = new Map((scanned ?? []).map(entity => [keyOf(entity), entity]));
      const workspaceTombstone = recoveryCanonical.get(`workspace:${workspaceId}`)?.tombstone === true;
      for (const entry of delayedPayloadMissing) {
        const local = recoveryCanonical.get(keyOf(entry));
        if (workspaceTombstone && entry.entityType !== 'workspace') {
          await journalStore.upsert(transitionState(entry, 'superseded', now));
          pending = pending.filter(candidate => candidate.entryId !== entry.entryId);
          continue;
        }
        if (parentIsLocallyTombstoned(entry, recoveryCanonical)) {
          await journalStore.upsert(transitionState(entry, 'superseded', now));
          pending = pending.filter(candidate => candidate.entryId !== entry.entryId);
          continue;
        }
        if (!local) {
          // A completed canonical rescan still cannot find the payload that a
          // prior attempt reported missing. Preserve absence as absence: retire
          // only this impossible upload; never synthesize a delete.
          await journalStore.upsert(transitionState(entry, 'superseded', now));
          pending = pending.filter(candidate => candidate.entryId !== entry.entryId);
          continue;
        }
        if (local?.tombstone === true || local?.bytes) {
          // Reset transport retry metadata: this is a deterministic repair
          // after a canonical rescan, not a blind retry of the same failure.
          const rearmed: SyncJournalEntry = {
            ...entry,
            state: 'pending',
            attempts: 0,
            nextAttemptAt: null,
            lastErrorClass: null,
            updatedAt: now,
          };
          await journalStore.upsert(rearmed);
          const pendingIndex = pending.findIndex(candidate => candidate.entryId === entry.entryId);
          if (pendingIndex >= 0) pending[pendingIndex] = rearmed;
          else pending.push(rearmed);
        }
      }
    }
  }
  if (bootstrapRequired && pending.length === 0) {
    if (result.errors.length === 0) result.errors.push({ entityId: workspaceId, stage: 'bootstrap-scan', errorClass: 'initial-scan-empty' });
    return finish();
  }

  const selected = new Map<string, SyncJournalEntry>();
  for (const entry of pending) {
    const key = keyOf(entry);
    const current = selected.get(key);
    if (!current || entry.localRevision > current.localRevision || (entry.localRevision === current.localRevision && entry.updatedAt > current.updatedAt)) selected.set(key, entry);
  }
  for (const entry of pending) if (selected.get(keyOf(entry))?.entryId !== entry.entryId) await journalStore.upsert(transitionState(entry, 'superseded', now));
  pending = [...selected.values()].sort((left, right) => left.updatedAt - right.updatedAt);
  if (pending.length === 0) return finish();

  if (!scanned && payloadSource.scanWorkspace) {
    const scanAt = clock();
    scanned = await payloadSource.scanWorkspace(workspaceId);
    result.stageTimingsMs.scan += Math.round(clock() - scanAt);
    result.localEntitiesScanned = scanned.length;
  }
  const canonical = new Map((scanned ?? []).map(entity => [keyOf(entity), entity]));
  const prepared = new Map<string, { entry: SyncJournalEntry; bytes: Uint8Array | null; parentId: string | null }>();
  const loadAt = clock();
  progress('preparing', 0, pending.length, 'Loading local changes…');
  await mapConcurrent(pending, concurrency, async (originalEntry, index) => {
    let entry = originalEntry;
    const local = canonical.get(keyOf(entry));
    // Detached journal writes can finish out of order. If an older metadata
    // update lands after the entity was deleted, the canonical tombstone is
    // authoritative and must be published instead of requesting live bytes
    // that deliberately no longer exist in the scan.
    if (!entry.tombstone && local?.tombstone) {
      entry = { ...entry, operation: 'delete', contentHash: null, payloadRef: null, deletedAt: local.deletedAt ?? now, tombstone: true };
      await journalStore.upsert(entry);
    } else if (!entry.tombstone && parentIsLocallyTombstoned(entry, canonical)) {
      // Page/canvas payload updates are subordinate to their metadata root.
      // Preserve the remote payload for a later restore, but do not let a
      // stale detached child update block synchronization of the tombstone.
      await journalStore.upsert(transitionState(entry, 'superseded', now));
      progress('preparing', index + 1, pending.length, 'Loading local changes…');
      return;
    }
    const pointer = remoteRecords.find(candidate => candidate.kind === entry.entityType && candidate.id === entry.entityId);
    if (pointer && isAcknowledgedByManifest(entry, remoteRecords)) {
      prepared.set(entry.entryId, { entry, bytes: null, parentId: pointer.parentId });
      progress('preparing', index + 1, pending.length, 'Loading local changes…');
      return;
    }
    let bytes: Uint8Array | null = null;
    if (!entry.tombstone) {
      // A complete scan is the fast path. Targeted fallback preserves pending
      // operations for entities created after that snapshot and gives custom
      // adapters a chance to resolve the opaque payload reference.
      bytes = local?.bytes ?? await payloadSource.loadPayload(entry);
      if (!bytes) {
        const failed = markAttempt(entry, 'payload-missing', now);
        await journalStore.upsert(failed);
        result.errors.push({ entityId: entry.entityId, entityType: entry.entityType, operation: entry.operation, payloadRef: entry.payloadRef, stage: entry.operation === 'restore' ? 'restore-payload-load' : 'payload-load', errorClass: 'payload-missing' });
        progress('preparing', index + 1, pending.length, 'Loading local changes…');
        return;
      }
      result.payloadsLoaded += 1;
      const actualHash = await sha256Bytes(bytes);
      if (actualHash !== entry.contentHash) {
        entry = { ...entry, contentHash: actualHash };
        await journalStore.upsert(entry);
      }
    }
    const parentId = local?.parentId ?? await payloadSource.parentOf(entry);
    prepared.set(entry.entryId, { entry, bytes, parentId });
    progress('preparing', index + 1, pending.length, 'Loading local changes…');
  });
  result.stageTimingsMs.payloadLoadAndHash = Math.round(clock() - loadAt);

  const knownRemoteHashes = new Set(remoteRecords.filter(pointer => !pointer.tombstone).map(pointer => pointer.contentHash));
  const publishable: Array<{ entry: SyncJournalEntry; bytes: Uint8Array | null; parentId: string | null }> = [];
  for (const value of prepared.values()) {
    const { entry } = value;
    result.journalEntriesProcessed += 1;
    const remotePointer = remoteRecords.find(candidate => candidate.kind === entry.entityType && candidate.id === entry.entityId);
    if (remotePointer && isAcknowledgedByManifest(entry, remoteRecords)) {
      await journalStore.upsert(transitionState(entry, 'synced', now));
      acknowledgedThisCycle.add(keyOf(entry));
      result.acknowledged += 1;
      continue;
    }
    let decision = decideConflict({ baseRevision: entry.baseRevision, contentHash: entry.contentHash, tombstone: entry.tombstone }, remoteHeadFor(remotePointer));
    if (entry.operation === 'restore' && remotePointer?.tombstone && entry.baseRevision === remotePointer.revision) decision = { kind: 'replace-base' };
    if (decision.kind === 'conflict') {
      await journalStore.upsert(transitionState(markAttempt(entry, decision.reason, now), 'conflict', now));
      result.conflicts.push({ entityId: entry.entityId, reason: decision.reason });
      result.conflictsCreated += 1;
      continue;
    }
    publishable.push(value);
  }

  const transferred: typeof publishable = [];
  const transferAt = clock();
  progress('uploading', 0, publishable.length, publishable.length ? `Uploading 0 of ${publishable.length}…` : 'No uploads needed');
  await mapConcurrent(publishable, concurrency, async (value, index) => {
    const { entry, bytes } = value;
    try {
      if (!entry.tombstone && bytes) {
        if (knownRemoteHashes.has(entry.contentHash!)) result.objectsAlreadyPresent += 1;
        else {
          const putResult = await provider.putObjectIfAbsent(workspaceId, { hash: entry.contentHash!, bytes });
          if (putResult === 'present') result.objectsAlreadyPresent += 1;
          else {
            result.objectsUploaded += 1;
            result.bytesUploaded += bytes.byteLength;
            if (bytes.byteLength >= 5 * 1024 * 1024) result.largeAssets += 1;
          }
          knownRemoteHashes.add(entry.contentHash!);
        }
      }
      transferred.push(value);
    } catch (error) {
      const failure = providerFailure(error);
      await journalStore.upsert(markAttempt(entry, failure.errorClass, now));
      result.errors.push({ entityId: entry.entityId, entityType: entry.entityType, operation: entry.operation, payloadRef: entry.payloadRef, stage: 'object-transfer', ...failure });
    }
    progress('uploading', index + 1, publishable.length, `Uploading ${index + 1} of ${publishable.length}…`);
  });
  result.stageTimingsMs.objectTransfer = Math.round(clock() - transferAt);

  if (transferred.length === 0) return finish();
  const pointers = transferred.map(value => pointerFromEntry(value.entry, value.parentId));
  const nextRevision = Math.max(deviceState.lastSeenRevision, remoteManifest?.revision ?? 0) + 1;
  const manifest = buildManifestV1({ workspaceId, revision: nextRevision, previousRevision: remoteManifest?.revision ?? null, writerDeviceId: deviceId, records: mergeRecords(remoteRecords, pointers), generatedAt: new Date(now).toISOString() });
  result.manifestEntries = manifest.records.length;
  if (input.verifyObjectsBeforeManifest) {
    const missingObject = await firstMissingManifestObject(provider, workspaceId, manifest.records, concurrency);
    if (missingObject) {
      result.errors.push({
        entityId: missingObject.id, entityType: missingObject.kind,
        stage: 'object-verification', errorClass: 'provider-error',
        providerReason: 'remote-object-missing', retryable: true,
      });
      return finish();
    }
  }
  for (const value of transferred) await journalStore.upsert(transitionState(value.entry, 'syncing', now));

  try {
    progress('updating-manifest', 0, 1, 'Updating workspace…');
    const writeAt = clock();
    await provider.writeManifest(workspaceId, manifest, remoteRead.etag);
    result.stageTimingsMs.manifestWrite = Math.round(clock() - writeAt);
    progress('finalizing', 0, 1, 'Finalizing…');
    // The successful conditional provider write is the publication
    // acknowledgement. Re-downloading the same manifest doubled manifest
    // traffic and made this device reconsider its own freshly published data.
    deviceState.lastSeenRevision = manifest.revision;
    result.recordsForDownload = manifest.records;
    const acknowledgedKeys = new Set<string>();
    for (const value of transferred) {
      if (isAcknowledgedByManifest(value.entry, manifest.records)) {
        await journalStore.upsert(transitionState(value.entry, 'synced', now));
        acknowledgedThisCycle.add(keyOf(value.entry));
        acknowledgedKeys.add(keyOf(value.entry));
        result.acknowledged += 1;
      } else {
        await journalStore.upsert(markAttempt(value.entry, 'manifest-ack-mismatch', now));
        result.errors.push({ entityId: value.entry.entityId, entityType: value.entry.entityType, operation: value.entry.operation, payloadRef: value.entry.payloadRef, stage: 'manifest-read-back', errorClass: 'provider-error' });
      }
    }
    // The conditional manifest write and exact pointer acknowledgment prove
    // that the current canonical entity is now remote. Historical unresolved
    // rows for the same entity are therefore obsolete, not active failures.
    if (acknowledgedKeys.size > 0 && journalStore.listUnresolved) {
      for (const stale of await journalStore.listUnresolved(workspaceId)) {
        if (acknowledgedKeys.has(keyOf(stale))) await journalStore.upsert(transitionState(stale, 'superseded', now));
      }
    }
    result.published = pointers.length;
    result.manifestPublished = true;
  } catch (error) {
    const providerConflict = error instanceof ProviderConflictError;
    const failure = providerConflict
      ? { errorClass: 'provider-conflict' as const, providerReason: 'etag-mismatch', retryable: true }
      : providerFailure(error);
    result.needsRepull = providerConflict;
    for (const value of transferred) {
      await journalStore.upsert(markAttempt(value.entry, failure.errorClass, now));
      result.errors.push({ entityId: value.entry.entityId, entityType: value.entry.entityType, operation: value.entry.operation, payloadRef: value.entry.payloadRef, stage: providerConflict ? 'manifest-conflict' : 'manifest-publication', ...failure });
    }
  }
  return finish();
}
