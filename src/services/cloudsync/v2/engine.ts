import { sha256Bytes } from '../hash.ts';
import { contentIdentity } from './contentIdentity.ts';
import { copyWorkspaceGraph } from './workspaceCopy.ts';
import type { ScannedSyncEntity } from '../engine.ts';
import { CloudOperationError, presentCloudError, sanitizeCloudDiagnostic, type CloudErrorCode } from '../errors.ts';
import { semanticSystemBootstrapBytes } from '../payloadSource.ts';
import type { SafeCloudDiagnostic, SyncEntityKind } from '../types.ts';
import type { SyncV2BaselineRecord, SyncV2BaselineStore, SyncV2Catalog, SyncV2ConflictResolution, SyncV2ConflictStore, SyncV2LocalAdapter, SyncV2LocalSource, SyncV2Manifest, SyncV2Profile, SyncV2Provider, SyncV2Record, SyncV2WorkspaceClassification, SyncV2WorkspaceOutcome } from './types.ts';
import type { LegacyMigrationResult } from './legacyMigration.ts';

const keyOf = (value: { kind?: SyncEntityKind; entityType?: SyncEntityKind; id?: string; entityId?: string }) => `${value.kind ?? value.entityType}:${value.id ?? value.entityId}`;
const phase: Record<SyncEntityKind, number> = { workspace: 0, folder: 1, notebook: 2, notebookSection: 3, notebookPage: 4, canvasFile: 4, pageContent: 5, pageDrawing: 5, canvasScene: 5, customBlock: 6, asset: 7 };

async function mapBounded<T>(items: readonly T[], worker: (item: T) => Promise<void>, concurrency = 8): Promise<void> {
  let next = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
  const failed = settled.find(item => item.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

export interface SyncV2Result {
  status: 'synced' | 'synced-review' | 'conflict' | 'blocked' | 'error';
  uploaded: number;
  downloaded: number;
  preservedConflicts: number;
  conflicts: Array<{ workspaceId: string; kind: SyncEntityKind; id: string }>;
  error?: string;
  errorCode?: CloudErrorCode;
  diagnostic?: SafeCloudDiagnostic;
  workspaceOutcomes: SyncV2WorkspaceOutcome[];
}

// SECURITY: Cloud Sync reconciliation must remain scoped to the authenticated Google account and verified local baseline.
function validProfile(value: SyncV2Profile | null): value is SyncV2Profile {
  return Boolean(value && value.format === 'panvas-sync-v2-profile' && value.schemaVersion === 2 && typeof value.profileId === 'string' && value.profileId && typeof value.accountIdentifier === 'string' && value.accountIdentifier);
}
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const revisionValid = (value: number) => Number.isSafeInteger(value) && value >= 0;
function validCatalog(value: SyncV2Catalog | null): value is SyncV2Catalog {
  return Boolean(value && value.format === 'panvas-sync-v2-catalog' && value.schemaVersion === 2 && revisionValid(value.revision) && Array.isArray(value.workspaces)
    && value.workspaces.every(item => item && safeId(item.workspaceId) && item.workspaceId.startsWith('ws-') && revisionValid(item.manifestRevision))
    && new Set(value.workspaces.map(item => item.workspaceId)).size === value.workspaces.length);
}
function validManifest(value: SyncV2Manifest | null, workspaceId: string): value is SyncV2Manifest {
  return Boolean(value && value.format === 'panvas-sync-v2-manifest' && value.schemaVersion === 2 && value.workspaceId === workspaceId && revisionValid(value.revision) && Array.isArray(value.records)
    && value.records.every(record => record && safeId(record.id) && Object.prototype.hasOwnProperty.call(phase, record.kind) && (record.parentId === null || safeId(record.parentId))
      && typeof record.tombstone === 'boolean' && (record.tombstone ? record.hash === null : /^[a-f0-9]{64}$/.test(record.hash ?? ''))
      && (record.kind !== 'workspace' || (record.id === workspaceId && record.parentId === null)))
    && new Set(value.records.map(keyOf)).size === value.records.length);
}

async function localRecord(entity: ScannedSyncEntity): Promise<{ entity: ScannedSyncEntity; hash: string | null; bootstrapIdentityHash: string | null }> {
  const bootstrapIdentity = !entity.tombstone && entity.bytes
    ? semanticSystemBootstrapBytes(entity.entityType, entity.entityId, entity.bytes)
    : null;
  const [hash, bootstrapIdentityHash] = await Promise.all([
    entity.tombstone ? null : entity.bytes ? sha256Bytes(entity.bytes) : null,
    bootstrapIdentity ? sha256Bytes(bootstrapIdentity) : null,
  ]);
  return { entity, hash, bootstrapIdentityHash };
}

function baselineFor(record: SyncV2Record, localHash: string | null, revision: number): SyncV2BaselineRecord {
  return { entityId: record.id, entityKind: record.kind, baseHash: record.hash, localHash, remoteHash: record.hash, remoteRevision: revision, tombstone: record.tombstone };
}

function v2Failure(stage: string, reason: string, operation: string, entityKind?: SyncEntityKind): CloudOperationError {
  return new CloudOperationError('sync', { stage, reason, operation, entityKind, retryable: false });
}

/**
 * A previously interrupted V2 publication can leave a manifest containing
 * children while its workspace root record was never published.  A root may
 * only be reconstructed when the local canonical root is present and every
 * live remote child has an unambiguous parent chain back to that workspace.
 * Display names are deliberately not consulted here; the stable workspace ID
 * and relationship graph are the authority.
 */
function hasUnambiguousRemoteChildren(workspaceId: string, records: Iterable<SyncV2Record>): boolean {
  const active = [...records].filter(record => !record.tombstone && record.kind !== 'workspace');
  // Content/drawing/scene/block/asset records intentionally reuse their
  // owner's ID. They are leaves, never structural parents, so including them
  // in the parent lookup would make an otherwise valid page ID appear
  // ambiguous.
  const structuralKinds = new Set<SyncEntityKind>([
    'folder', 'notebook', 'notebookSection', 'notebookPage', 'canvasFile',
  ]);
  const byId = new Map<string, SyncV2Record[]>();
  for (const record of active.filter(record => structuralKinds.has(record.kind))) {
    const bucket = byId.get(record.id) ?? [];
    bucket.push(record);
    byId.set(record.id, bucket);
  }
  for (const record of active) {
    let parentId = record.parentId;
    const visited = new Set<string>();
    while (parentId !== workspaceId) {
      if (!parentId || visited.has(parentId)) return false;
      visited.add(parentId);
      const parents = byId.get(parentId);
      if (!parents || parents.length !== 1) return false;
      parentId = parents[0].parentId;
    }
  }
  return true;
}

function canonicalLocalWorkspaceRoot(
  workspaceId: string,
  localByKey: Map<string, { entity: ScannedSyncEntity; hash: string | null; bootstrapIdentityHash: string | null }>,
  trustedRecoveryRoot?: ScannedSyncEntity | null,
): { entity: ScannedSyncEntity; hash: string; bytes: Uint8Array } | null {
  const local = localByKey.get(`workspace:${workspaceId}`);
  if (!local || local.entity.tombstone || !local.entity.bytes || !local.hash) return null;
  // A stale foreign-ownership row is not sufficient authority to create a
  // remote root. It remains eligible for the normal conflict/recovery flow.
  // The one exception is the exact root returned by the native recovery
  // bridge: that artifact was validated by canonical workspace ID and bounded
  // Panvas metadata before it entered this map. Electron may not have an
  // optional Panvas session, so its historical userId stamp is not proof of a
  // different Google Drive account.
  if (local.entity.ownership === 'foreign-recovery' && local.entity !== trustedRecoveryRoot) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(local.entity.bytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.id !== workspaceId || payload.deletedAt || payload.parentId !== undefined && payload.parentId !== null) return null;
  } catch {
    return null;
  }
  return { entity: local.entity, hash: local.hash, bytes: local.entity.bytes };
}

/**
 * Providers historically surfaced a missing content-addressed object as a
 * plain Error. Keep that provider detail out of the UI, but retain the exact
 * entity that could not be reconstructed so recovery can be diagnosed and
 * repaired without weakening conflict protection.
 */
async function readRemoteObject(
  provider: SyncV2Provider,
  hash: string,
  context: { workspaceId: string; entityKind: SyncEntityKind; entityId: string },
): Promise<Uint8Array> {
  try {
    return await provider.getObject(hash);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const missing = error instanceof CloudOperationError && error.diagnostic.reason === 'remote-object-missing'
      || /remote\s+object\s+not\s+found|missing\s+object|object\s+not\s+found/i.test(message);
    if (missing) {
      throw new CloudOperationError('sync', {
        stage: 'object-download',
        reason: 'remote-object-missing',
        operation: 'download',
        workspaceId: context.workspaceId,
        entityKind: context.entityKind,
        entityId: context.entityId,
        retryable: false,
      });
    }
    throw error;
  }
}

/**
 * Restore a broken immutable object only when this replica already has the
 * exact bytes named by the manifest. The hash match proves this repairs an
 * interrupted upload; a stale local object with a different hash is never
 * uploaded here.
 */
async function readRemoteObjectWithExactReplica(
  provider: SyncV2Provider,
  hash: string,
  context: { workspaceId: string; entityKind: SyncEntityKind; entityId: string },
  local?: { entity: ScannedSyncEntity; hash: string | null },
): Promise<Uint8Array> {
  try {
    return await readRemoteObject(provider, hash, context);
  } catch (error) {
    const missing = error instanceof CloudOperationError && error.diagnostic.reason === 'remote-object-missing';
    if (!missing || !local || local.entity.tombstone || local.hash !== hash || !local.entity.bytes) throw error;
    await provider.putObjectIfAbsent(hash, local.entity.bytes);
    const metadata = await provider.getObjectMetadata(hash);
    if (!metadata || metadata.size !== local.entity.bytes.byteLength) throw error;
    return readRemoteObject(provider, hash, context);
  }
}

function blocked(result: SyncV2Result, reason: string): SyncV2Result {
  const shown = presentCloudError(new CloudOperationError('account-migration-required', { stage: 'profile-validation', reason, operation: 'adopt', retryable: false }));
  return { ...result, status: 'blocked', error: shown.message, errorCode: shown.code, diagnostic: shown.diagnostic };
}

export async function runCloudSyncV2(input: {
  accountIdentifier: string;
  provider: SyncV2Provider;
  source: SyncV2LocalSource;
  adapter: SyncV2LocalAdapter;
  baselines: SyncV2BaselineStore;
  conflictStore: SyncV2ConflictStore;
  /** Explicit choices are supplied only after the user resolves a real conflict. */
  resolutions?: readonly SyncV2ConflictResolution[];
  onProgress?: (message: string) => void;
  assertCurrent?: () => void;
  environment?: 'desktop' | 'web';
  legacyMigrator?: () => Promise<LegacyMigrationResult>;
}): Promise<SyncV2Result> {
  const result: SyncV2Result = { status: 'error', uploaded: 0, downloaded: 0, preservedConflicts: 0, conflicts: [], workspaceOutcomes: [] };
  const workspaceOutcomeById = new Map<string, SyncV2WorkspaceOutcome>();
  const recordWorkspaceOutcome = (workspaceId: string, classification: SyncV2WorkspaceClassification, status: SyncV2WorkspaceOutcome['status'], diagnostic?: SafeCloudDiagnostic) => {
    const outcome: SyncV2WorkspaceOutcome = { workspaceId, classification, status, ...(diagnostic ? { diagnostic } : {}) };
    workspaceOutcomeById.set(workspaceId, outcome);
    result.workspaceOutcomes = [...workspaceOutcomeById.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
  };
  const assertCurrent = input.assertCurrent ?? (() => {});
  let currentWorkspaceId: string | undefined;
  let currentEntity: { kind: SyncEntityKind; id: string } | undefined;
  let currentStage = 'profile-read';
  try {
    assertCurrent();
    input.source.beginCycle?.();
    input.onProgress?.('Checking cloud…');
    const localProfile = await input.baselines.loadProfile();
    if (localProfile && localProfile.accountIdentifier !== input.accountIdentifier) return blocked(result, 'local-account-mismatch');

    let [profileRead, catalogRead] = await Promise.all([input.provider.readProfile(), input.provider.readCatalog()]);
    assertCurrent();

    if (!catalogRead.value || catalogRead.value.workspaces.length === 0) {
      if (input.legacyMigrator) {
        input.onProgress?.('Checking for legacy data to migrate…');
        const migrationResult = await input.legacyMigrator();
        if (migrationResult.status === 'migrated') {
          [profileRead, catalogRead] = await Promise.all([input.provider.readProfile(), input.provider.readCatalog()]);
          assertCurrent();
        } else if (migrationResult.status === 'migration-recovery-required') {
          const shown = presentCloudError(new CloudOperationError('account-migration-required', {
            stage: 'legacy-migration',
            reason: migrationResult.reason,
            operation: 'migrate',
            retryable: false,
          }));
          return { ...result, status: 'synced-review', error: shown.message, errorCode: shown.code, diagnostic: shown.diagnostic };
        }
      } else if (input.environment === 'web') {
        const shown = presentCloudError(new CloudOperationError('cloud-not-initialized', {
          stage: 'cloud-validation',
          reason: 'cloud-not-initialized',
          operation: 'initialize-cloud',
          retryable: false,
        }));
        return { ...result, status: 'synced-review', error: shown.message, errorCode: 'cloud-not-initialized', diagnostic: shown.diagnostic };
      }
    }
    if (profileRead.value && !validProfile(profileRead.value)) throw v2Failure('profile-validation', 'invalid-cloud-profile', 'read-profile');
    if (catalogRead.value && !validCatalog(catalogRead.value)) throw v2Failure('catalog-validation', 'invalid-cloud-catalog', 'read-catalog');
    if (profileRead.value && profileRead.value.accountIdentifier !== input.accountIdentifier) return blocked(result, 'remote-account-mismatch');
    if (!profileRead.value && catalogRead.value && catalogRead.value.workspaces.length > 0) return blocked(result, 'remote-account-ambiguous');
    const profile = profileRead.value ?? { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: localProfile?.profileId ?? crypto.randomUUID(), accountIdentifier: input.accountIdentifier };
    if (!profileRead.value) await input.provider.writeProfile(profile, profileRead.etag);
    const sameAccountProfileReplacement = Boolean(localProfile
      && localProfile.accountIdentifier === input.accountIdentifier
      && localProfile.profileId !== profile.profileId);
    if (localProfile && localProfile.profileId !== profile.profileId && !sameAccountProfileReplacement) return blocked(result, 'profile-id-mismatch');

    const catalog: SyncV2Catalog = catalogRead.value ?? { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 0, workspaces: [] };
    const localIds = (await input.source.listWorkspaceIds()).filter(id => id !== 'default');
    if (localIds.some(id => !safeId(id) || !id.startsWith('ws-'))) throw v2Failure('local-scan', 'invalid-workspace-id', 'list-workspaces');
    const remoteIds = catalog.workspaces.map(item => item.workspaceId);
    const workspaceIds = [...new Set([...localIds, ...remoteIds])].sort();
    if (sameAccountProfileReplacement) {
      // The remote profile is the canonical sync space for this verified
      // Google account. Existing baselines belong to the old local profile;
      // reset only that metadata so the normal first-reconciliation path can
      // preserve divergent local bytes and download the canonical remote
      // records. No workspace content is deleted here.
      await Promise.all(localIds.map(workspaceId => input.baselines.saveWorkspace(workspaceId, [])));
    }
    const stagedBaselines = new Map<string, SyncV2BaselineRecord[]>();
    const nextCatalog = new Map(catalog.workspaces.map(item => [item.workspaceId, item]));
    let catalogChanged = !catalogRead.value;
    const copiedWorkspaces = new Map<string, ScannedSyncEntity[]>();

    for (let workspaceIndex = 0; workspaceIndex < workspaceIds.length; workspaceIndex += 1) {
      const workspaceId = workspaceIds[workspaceIndex];
      let workspaceClassification: SyncV2WorkspaceClassification = 'healthy';
      try {
      assertCurrent();
      currentWorkspaceId = workspaceId;
      currentEntity = undefined;
      currentStage = 'workspace-read';
      input.onProgress?.(`Syncing workspace ${workspaceIndex + 1} of ${workspaceIds.length}…`);
      const [manifestRead, initialScanned] = await Promise.all([input.provider.readManifest(workspaceId), copiedWorkspaces.has(workspaceId) ? Promise.resolve(copiedWorkspaces.get(workspaceId)!) : input.source.scanWorkspace(workspaceId)]);
      // A returning browser may contain rows stamped by an older local auth
      // identity (or no identity at all). Once the Drive profile is verified,
      // inspect the complete workspace so content/base proofs can distinguish
      // stale ownership metadata from a genuine edit. Rows are still guarded
      // at apply time unless this cycle proves the cloud copy is canonical.
      let scanned = !copiedWorkspaces.has(workspaceId) && manifestRead.value && input.source.scanWorkspaceIncludingUnowned
        ? await input.source.scanWorkspaceIncludingUnowned(workspaceId)
        : initialScanned;
      if (manifestRead.value && !validManifest(manifestRead.value, workspaceId)) throw v2Failure('manifest-validation', 'invalid-manifest', 'read-manifest');
      const manifest = manifestRead.value;
      const remoteByKey = new Map((manifest?.records ?? []).map(record => [keyOf(record), record]));
      let recoveryRoot: ScannedSyncEntity | null = null;
      if (input.source.getRecoveryWorkspaceRoot && (!manifest || !remoteByKey.has(`workspace:${workspaceId}`))) {
        recoveryRoot = await input.source.getRecoveryWorkspaceRoot(workspaceId);
        if (recoveryRoot) {
          scanned = [...scanned.filter(entity => keyOf(entity) !== `workspace:${workspaceId}`), recoveryRoot];
          workspaceClassification = 'repairable';
        }
      }
      if (!manifest && remoteIds.includes(workspaceId) && !scanned.some(entity => keyOf(entity) === `workspace:${workspaceId}` && !entity.tombstone)) {
        // A catalog pointer without a readable manifest is a per-workspace
        // orphan. Preserve the catalog and every remote object, but do not
        // let one damaged workspace abort healthy workspaces in this account.
        workspaceClassification = 'orphaned';
        const diagnostic = sanitizeCloudDiagnostic({ stage: 'remote-recovery', reason: 'catalog-manifest-unavailable', operation: 'quarantine-workspace', workspaceId, entityKind: 'workspace', entityId: workspaceId, retryable: false });
        recordWorkspaceOutcome(workspaceId, 'orphaned', 'orphaned', diagnostic);
        continue;
      }
      if (!manifest && localIds.includes(workspaceId) && scanned.length === 0) throw v2Failure('local-scan', 'local-workspace-unavailable', 'scan-workspace');
      const localPairs = await Promise.all(scanned.map(localRecord));
      const localByKey = new Map(localPairs.map(pair => [keyOf(pair.entity), pair]));
      const currentOwnedKeys = new Set(initialScanned.filter(entity => entity.ownership === 'current').map(keyOf));
      const baselineRecords = await input.baselines.loadWorkspace(workspaceId);
      const baselineByKey = new Map(baselineRecords.map(record => [`${record.entityKind}:${record.entityId}`, record]));
      let repairedMissingRecords = 0;
      let repairedWorkspaceRoot: { record: SyncV2Record; bytes: Uint8Array } | null = null;

      // A missing root is remote-state integrity damage, not a two-sided edit.
      // Repair only the incomplete-commit shape (children are present, the
      // canonical local root is present, and the child graph is unambiguous).
      // The root is staged through the ordinary upload path below, then added
      // to the apply batch so native reconstruction can enforce root-first
      // ordering without allocating a second workspace directory.
      if (manifest && !remoteByKey.has(`workspace:${workspaceId}`)) {
        const localRoot = canonicalLocalWorkspaceRoot(workspaceId, localByKey, recoveryRoot);
        const childrenUnambiguous = hasUnambiguousRemoteChildren(workspaceId, remoteByKey.values());
        if (localRoot && childrenUnambiguous) {
          workspaceClassification = 'repairable';
          repairedWorkspaceRoot = {
            record: {
              kind: 'workspace',
              id: workspaceId,
              parentId: null,
              hash: localRoot.hash,
              baseHash: baselineByKey.get(`workspace:${workspaceId}`)?.baseHash ?? null,
              tombstone: false,
            },
            bytes: localRoot.bytes,
          };
          input.onProgress?.('Repairing incomplete workspace rootâ€¦');
        } else {
          // Do not fabricate identity for a remote-only/incomplete workspace.
          // Quarantine it as a unit and keep syncing every other workspace.
          workspaceClassification = localRoot ? 'ambiguous' : 'orphaned';
          const diagnostic = sanitizeCloudDiagnostic({
            stage: 'remote-recovery',
            reason: localRoot ? 'remote-workspace-root-ambiguous' : 'remote-workspace-root-missing',
            operation: 'quarantine-workspace',
            workspaceId,
            entityKind: 'workspace',
            entityId: workspaceId,
            retryable: false,
          });
          recordWorkspaceOutcome(workspaceId, workspaceClassification, workspaceClassification === 'ambiguous' ? 'error' : 'orphaned', diagnostic);
          continue;
        }
      }

      // A pointer is not proof of a usable root. In particular, old manifests
      // can retain live descendants underneath a workspace tombstone. Never
      // reconcile those descendants (even when the user supplied a choice).
      const remoteRoot = remoteByKey.get(`workspace:${workspaceId}`);
      if (remoteRoot) {
        let rootProblem: string | null = null;
        if (remoteRoot.tombstone) {
          if ([...remoteByKey.values()].some(record => record.kind !== 'workspace' && !record.tombstone)) rootProblem = 'remote-workspace-root-deleted-with-live-children';
        } else {
          try {
            const rootWasMissing = !(await input.provider.getObjectMetadata(remoteRoot.hash!));
            const bytes = await readRemoteObjectWithExactReplica(input.provider, remoteRoot.hash!, { workspaceId, entityKind: 'workspace', entityId: workspaceId }, localByKey.get(`workspace:${workspaceId}`));
            if (rootWasMissing) result.uploaded += 1;
            if (await sha256Bytes(bytes) !== remoteRoot.hash) rootProblem = 'remote-workspace-root-integrity-failed';
            else {
              const root = JSON.parse(new TextDecoder().decode(bytes));
              if (!root || Array.isArray(root) || root.id !== workspaceId || root.deletedAt
                || (root.parentId != null) || (root.workspaceId != null && root.workspaceId !== workspaceId)) rootProblem = 'remote-workspace-root-invalid';
            }
          } catch (error) {
            if (error instanceof SyntaxError) rootProblem = 'remote-workspace-root-invalid';
            else if (error instanceof CloudOperationError && error.diagnostic.reason === 'remote-object-missing') rootProblem = 'remote-workspace-root-object-missing';
            else throw error;
          }
        }
        if (rootProblem) {
          recordWorkspaceOutcome(workspaceId, 'orphaned', 'orphaned', sanitizeCloudDiagnostic({ stage: 'workspace-preflight', reason: rootProblem, operation: 'quarantine-workspace', workspaceId, entityKind: 'workspace', entityId: workspaceId, retryable: false }));
          continue;
        }
      }

      // Old/interrupted releases could publish a manifest containing hashes
      // whose immutable objects never reached Drive. Any exact byte replica
      // can restore that pointer safely; only a durable desktop replica may
      // replace a broken pointer with a different hash.
      if (manifest) {
        currentStage = 'missing-object-repair';
        await mapBounded(manifest.records.filter(record => !record.tombstone), async remote => {
          assertCurrent();
          if (await input.provider.getObjectMetadata(remote.hash!)) return;
          currentEntity = remote;
          const local = localByKey.get(keyOf(remote));
          // Any device may restore an interrupted upload when it has the
          // exact immutable bytes named by the manifest. This is safe even
          // for a browser replica because the hash proves it is not making a
          // stale copy authoritative.
          if (local && !local.entity.tombstone && local.hash === remote.hash && local.entity.bytes) {
            const put = await input.provider.putObjectIfAbsent(local.hash!, local.entity.bytes);
            if (put === 'uploaded') result.uploaded += 1;
            const metadata = await input.provider.getObjectMetadata(local.hash!);
            if (!metadata || metadata.size !== local.entity.bytes.byteLength) {
              throw new CloudOperationError('sync', {
                stage: 'object-upload',
                reason: 'missing-object-repair-failed',
                operation: 'verify-exact-repair',
                workspaceId,
                entityKind: remote.kind,
                entityId: remote.id,
                retryable: false,
              });
            }
            return;
          }
          if (!input.source.canRepairMissingRemoteObjects?.()) {
            throw new CloudOperationError('sync', {
              stage: 'object-download',
              reason: 'remote-object-missing',
              operation: 'download',
              workspaceId,
              entityKind: remote.kind,
              entityId: remote.id,
              retryable: false,
            });
          }
          if (!local || local.entity.tombstone || !local.hash || !local.entity.bytes) {
            throw new CloudOperationError('sync', {
              stage: 'object-download',
              reason: 'remote-object-missing',
              operation: 'repair-missing-object',
              workspaceId,
              entityKind: remote.kind,
              entityId: remote.id,
              retryable: false,
            });
          }

          const put = await input.provider.putObjectIfAbsent(local.hash, local.entity.bytes);
          if (put === 'uploaded') result.uploaded += 1;
          const metadata = await input.provider.getObjectMetadata(local.hash);
          if (!metadata || metadata.size !== local.entity.bytes.byteLength) {
            throw new CloudOperationError('sync', {
              stage: 'object-upload',
              reason: 'missing-object-repair-failed',
              operation: 'verify-repair-upload',
              workspaceId,
              entityKind: remote.kind,
              entityId: remote.id,
              retryable: false,
            });
          }

          // If the desktop still has the exact immutable bytes, restoring the
          // object is sufficient and the existing manifest/history stays valid.
          if (local.hash === remote.hash) return;

          // The old base hash is unusable because its object is absent. The
          // repaired local bytes become both current and base for this one
          // record, so future devices never chase the broken pointer again.
          remoteByKey.set(keyOf(remote), {
            ...remote,
            parentId: local.entity.parentId,
            hash: local.hash,
            baseHash: local.hash,
            ...(remote.kind === 'asset' ? { encoding: 'asset-envelope-v1' as const } : {}),
          });
          repairedMissingRecords += 1;
        });
      }
      // A profile may already have been persisted by the explicit account
      // adoption handoff before its first baseline commits. An empty baseline
      // is therefore the reliable signal for first reconciliation; requiring a
      // null profile would turn an interrupted handoff into false conflicts.
      const initialAdoption = baselineRecords.length === 0;
      const keys = [...new Set([...localByKey.keys(), ...remoteByKey.keys()])].sort();
      const downloads: Array<{ record: SyncV2Record; bytes: Uint8Array }> = [];
      const preservedDuringAdoption = new Set<string>();
      const uploads: Array<{ record: SyncV2Record; bytes: Uint8Array | null }> = [];
      const nextRecords = new Map(remoteByKey);
      const nextBaselines = new Map<string, SyncV2BaselineRecord>();

      // A button chooses the workspace graph, including entities present on
      // only one side. It is considered only after this workspace's root
      // preflight, and cannot admit records from a quarantined workspace.
      const workspaceResolutions = input.resolutions?.filter(item => item.workspaceId === workspaceId) ?? [];
      const choice = workspaceResolutions[0]?.choice;
      let hasSelectedDivergence = false;
      for (const selected of workspaceResolutions) {
        const local = localByKey.get(keyOf(selected));
        const remote = remoteByKey.get(keyOf(selected));
        if (!local || !remote || local.entity.tombstone !== remote.tombstone) { hasSelectedDivergence = true; break; }
        if (!local.entity.tombstone && local.hash !== remote.hash) {
          const bytes = await readRemoteObjectWithExactReplica(input.provider, remote.hash!, { workspaceId, entityKind: remote.kind, entityId: remote.id }, local);
          if (await sha256Bytes(bytes) !== remote.hash) throw v2Failure('object-download', 'object-integrity-failed', 'download', remote.kind);
          const localContent = await contentIdentity(remote.kind, local.entity.bytes!);
          const remoteContent = await contentIdentity(remote.kind, bytes);
          if (localContent === null || remoteContent === null || localContent !== remoteContent) { hasSelectedDivergence = true; break; }
        }
      }
      if (choice && hasSelectedDivergence && manifest && workspaceResolutions.every(item => item.choice === choice)) {
        if (choice === 'both') {
          const copy = await copyWorkspaceGraph(profile.profileId, workspaceId, scanned);
          const existing = input.source.scanFreshWorkspace
            ? await input.source.scanFreshWorkspace(copy.workspaceId) : await input.source.scanWorkspace(copy.workspaceId);
          if (existing.length) {
            const root = existing.find(item => item.entityType === 'workspace' && item.entityId === copy.workspaceId);
            const value = root?.bytes ? JSON.parse(new TextDecoder().decode(root.bytes)) : null;
            if (value?.syncCopyFingerprint !== copy.fingerprint) throw v2Failure('conflict-copy', 'copy-identity-collision', 'copy-workspace', 'workspace');
            copiedWorkspaces.set(copy.workspaceId, existing);
          } else {
            const records = await Promise.all(copy.entities.map(async entity => ({ record: { kind: entity.entityType, id: entity.entityId, parentId: entity.parentId, hash: entity.bytes ? await sha256Bytes(entity.bytes) : null, baseHash: null, tombstone: entity.tombstone, ...(entity.entityType === 'asset' ? { encoding: 'asset-envelope-v1' as const } : {}) }, bytes: entity.bytes })));
            records.sort((a, b) => phase[a.record.kind] - phase[b.record.kind]);
            assertCurrent();
            if (input.adapter.applyWorkspace) await input.adapter.applyWorkspace({ workspaceId: copy.workspaceId, expected: [], downloads: records, assertCurrent });
            else for (const record of records) { assertCurrent(); await input.adapter.applyRecord({ workspaceId: copy.workspaceId, ...record }); }
            result.downloaded += records.length;
            copiedWorkspaces.set(copy.workspaceId, input.source.scanFreshWorkspace ? await input.source.scanFreshWorkspace(copy.workspaceId) : copy.entities);
          }
          // This graph was explicitly created by this choice (or identified
          // by its exact retry fingerprint). A logged-out local-first browser
          // reports its null-owner rows as recovery candidates on a fresh scan;
          // those newly created rows are normal local work, not an adoption.
          copiedWorkspaces.set(copy.workspaceId, copiedWorkspaces.get(copy.workspaceId)!.map(entity => ({
            ...entity, ownership: entity.ownership === 'unowned-recovery' ? 'current' : entity.ownership,
          })));
          if (!workspaceIds.includes(copy.workspaceId)) workspaceIds.push(copy.workspaceId);
        }
        for (const key of keys) {
          const local = localByKey.get(key);
          const remote = remoteByKey.get(key);
          // Missing root metadata is integrity repair, never a deletion on
          // the chosen cloud side. All choices retain the proven canonical
          // root and publish it before any descendant objects.
          if (repairedWorkspaceRoot && key === `workspace:${workspaceId}`) {
            uploads.push({ record: repairedWorkspaceRoot.record, bytes: repairedWorkspaceRoot.bytes });
            continue;
          }
          const remoteBytes = remote && !remote.tombstone
            ? await readRemoteObjectWithExactReplica(input.provider, remote.hash!, { workspaceId, entityKind: remote.kind, entityId: remote.id }, local) : new Uint8Array();
          if (remote && !remote.tombstone && await sha256Bytes(remoteBytes) !== remote.hash) throw v2Failure('object-download', 'object-integrity-failed', 'download', remote.kind);
          await input.conflictStore.preserve({
            conflictId: `resolution:${profile.profileId}:${workspaceId}:${key}:${local?.hash ?? 'absent'}:${remote?.hash ?? 'deleted'}`,
            profileId: profile.profileId, workspaceId, entityKind: remote?.kind ?? local!.entity.entityType,
            entityId: remote?.id ?? local!.entity.entityId, parentId: remote?.parentId ?? local?.entity.parentId ?? null,
            localHash: local?.hash ?? 'tombstone', remoteHash: remote?.hash ?? 'tombstone',
            localBytes: local?.entity.bytes ?? new Uint8Array(), remoteBytes: choice === 'cloud' ? undefined : remoteBytes,
            resolution: choice, createdAt: Date.now(), resolvedAt: Date.now(),
          });
          preservedDuringAdoption.add(key);
          if (choice === 'device') {
            const record: SyncV2Record = local
              ? { kind: local.entity.entityType, id: local.entity.entityId, parentId: local.entity.parentId, hash: local.hash, baseHash: remote?.hash ?? null, tombstone: local.entity.tombstone, ...(local.entity.entityType === 'asset' ? { encoding: 'asset-envelope-v1' as const } : {}) }
              : { ...remote!, hash: null, baseHash: remote!.hash, tombstone: true };
            uploads.push({ record, bytes: local?.entity.bytes ?? null });
          } else if (remote && (!remote.tombstone || local)) downloads.push({ record: remote, bytes: remoteBytes });
          else if (local) downloads.push({ record: { kind: local.entity.entityType, id: local.entity.entityId, parentId: local.entity.parentId, hash: null, baseHash: null, tombstone: true }, bytes: new Uint8Array() });
        }
      } else {

      for (const key of keys) {
        assertCurrent();
        const local = localByKey.get(key);
        const remote = remoteByKey.get(key);
        const base = baselineByKey.get(key);
        currentEntity = remote ?? (local ? { kind: local.entity.entityType, id: local.entity.entityId } : undefined);
        currentStage = 'record-reconciliation';
        if (local && !local.entity.tombstone && !local.hash) throw v2Failure('local-scan', 'local-payload-unavailable', 'hash-local', local.entity.entityType);

        if (local && !remote) {
          if (local.entity.tombstone) continue;
          if (manifest && initialAdoption && !repairedWorkspaceRoot && !local.bootstrapIdentityHash) {
            result.conflicts.push({ workspaceId, kind: local.entity.entityType, id: local.entity.entityId });
            continue;
          }
          const trustedRecoveryRoot = local.entity.entityType === 'workspace'
            && local.entity.entityId === workspaceId
            && Boolean(recoveryRoot || repairedWorkspaceRoot);
          // The normal scan already proved ownership of newly created local
          // rows. Do not let the broader recovery scan turn those into false
          // conflicts on an established workspace. Foreign rows remain gated.
          const provenNewLocalRecord = !initialAdoption && currentOwnedKeys.has(key);
          if (!trustedRecoveryRoot && !provenNewLocalRecord && (local.entity.ownership === 'unowned-recovery' || local.entity.ownership === 'foreign-recovery')) {
            // A stale-owned row that is absent from the verified cloud
            // manifest must never be uploaded merely because recovery made it
            // visible. Its ancestry is not proven, so keep the local row and
            // surface an exact review item instead of mixing accounts.
            result.conflicts.push({ workspaceId, kind: local.entity.entityType, id: local.entity.entityId });
            continue;
          }
          uploads.push({ record: { kind: local.entity.entityType, id: local.entity.entityId, parentId: local.entity.parentId, hash: local.hash, baseHash: base?.baseHash ?? null, tombstone: false, ...(local.entity.entityType === 'asset' ? { encoding: 'asset-envelope-v1' as const } : {}) }, bytes: local.entity.bytes });
          continue;
        }
        if (!local && remote) {
          if (remote.tombstone) { nextBaselines.set(key, baselineFor(remote, null, manifest!.revision)); continue; }
          const bytes = await readRemoteObjectWithExactReplica(input.provider, remote.hash!, { workspaceId, entityKind: remote.kind, entityId: remote.id }, local);
          if (await sha256Bytes(bytes) !== remote.hash) throw v2Failure('object-download', 'object-integrity-failed', 'download', remote.kind);
          downloads.push({ record: remote, bytes });
          continue;
        }
        if (!local || !remote) continue;
        const localMatchesRemote = local.entity.tombstone === remote.tombstone && (remote.tombstone || local.hash === remote.hash);
        if (localMatchesRemote) { nextBaselines.set(key, baselineFor(remote, local.hash, manifest!.revision)); continue; }

        // Even with an incomplete baseline, identical document content is
        // proof of convergence. Browser ownership/bookkeeping bytes need not
        // match the desktop wire hash. Do this BEFORE the missing-base branch.
        if (!base && !local.bootstrapIdentityHash && !local.entity.tombstone && local.entity.bytes && !remote.tombstone) {
          const bytes = await readRemoteObjectWithExactReplica(input.provider, remote.hash!, { workspaceId, entityKind: remote.kind, entityId: remote.id }, local);
          if (await sha256Bytes(bytes) !== remote.hash) throw v2Failure('object-download', 'object-integrity-failed', 'download', remote.kind);
          const localContent = await contentIdentity(remote.kind, local.entity.bytes);
          if (localContent !== null && localContent === await contentIdentity(remote.kind, bytes)) {
            nextBaselines.set(key, baselineFor(remote, local.hash, manifest!.revision));
            continue;
          }
        }

        // A prior interrupted/rejected sync can leave a browser with content
        // but without a complete local baseline. The remote record retains the
        // hash it was based on; compare that immutable historical object before
        // treating the missing baseline as a two-sided edit. This is the
        // returning-browser case: local content is unchanged, so the remote
        // device version can be downloaded safely.
        if (!base && remote.baseHash && !local.entity.tombstone && local.entity.bytes
          && await input.provider.getObjectMetadata(remote.baseHash)) {
          const localContent = await contentIdentity(remote.kind, local.entity.bytes);
          const historicalBytes = await readRemoteObjectWithExactReplica(input.provider, remote.baseHash, { workspaceId, entityKind: remote.kind, entityId: remote.id }, local);
          if (await sha256Bytes(historicalBytes) !== remote.baseHash) throw v2Failure('object-download', 'object-integrity-failed', 'download', remote.kind);
          const historicalContent = await contentIdentity(remote.kind, historicalBytes);
          if (localContent !== null && historicalContent !== null && localContent === historicalContent) {
            if (remote.tombstone) downloads.push({ record: remote, bytes: new Uint8Array() });
            else {
              const bytes = await readRemoteObjectWithExactReplica(input.provider, remote.hash!, { workspaceId, entityKind: remote.kind, entityId: remote.id }, local);
              if (await sha256Bytes(bytes) !== remote.hash) throw v2Failure('object-download', 'object-integrity-failed', 'download', remote.kind);
              downloads.push({ record: remote, bytes });
            }
            continue;
          }
        }

        if (!base && local.bootstrapIdentityHash && !remote.tombstone) {
          const bytes = await readRemoteObjectWithExactReplica(input.provider, remote.hash!, { workspaceId, entityKind: remote.kind, entityId: remote.id }, local);
          if (await sha256Bytes(bytes) !== remote.hash) throw v2Failure('object-download', 'object-integrity-failed', 'download', remote.kind);
          downloads.push({ record: remote, bytes });
          continue;
        }

        if (initialAdoption && !base && !local.entity.tombstone && !remote.tombstone) {
          // Without a common BASE, neither version has authority. Leave the
          // entire workspace untouched until an explicit workspace choice.
          result.conflicts.push({ workspaceId, kind: local.entity.entityType, id: local.entity.entityId });
          continue;
        }

        let localMatchesBase = Boolean(base) && local.entity.tombstone === base!.tombstone && (local.entity.tombstone || local.hash === base!.localHash || local.hash === base!.baseHash);
        let remoteMatchesBase = Boolean(base) && remote.tombstone === base!.tombstone && (remote.tombstone || remote.hash === base!.baseHash);
        // Existing replicas have exact-byte baselines. Reading the immutable
        // baseline object lets us distinguish a real offline edit from local
        // bookkeeping without discarding those baselines or overwriting edits.
        if (base && !base.tombstone && base.baseHash && !local.entity.tombstone && local.entity.bytes
          && await input.provider.getObjectMetadata(base.baseHash)) {
          const localContent = await contentIdentity(remote.kind, local.entity.bytes);
          const readContent = async (hash: string) => {
            const bytes = await readRemoteObjectWithExactReplica(input.provider, hash, { workspaceId, entityKind: remote.kind, entityId: remote.id }, local);
            if (await sha256Bytes(bytes) !== hash) throw v2Failure('object-download', 'object-integrity-failed', 'download', remote.kind);
            return contentIdentity(remote.kind, bytes);
          };
          if (localContent !== null) {
            if (base.localContentHash) localMatchesBase ||= await sha256Bytes(new TextEncoder().encode(localContent)) === base.localContentHash;
            const baseContent = await readContent(base.baseHash);
            localMatchesBase ||= baseContent !== null && localContent === baseContent;
            if (!remote.tombstone && remote.hash) {
              const remoteContent = remoteMatchesBase ? baseContent : await readContent(remote.hash);
              remoteMatchesBase ||= baseContent !== null && remoteContent === baseContent;
              if (localContent === remoteContent) {
                nextBaselines.set(key, baselineFor(remote, local.hash, manifest!.revision));
                continue;
              }
            }
          }
        }
        if (base && localMatchesBase && !remoteMatchesBase) {
          if (remote.tombstone) {
            if (remote.baseHash !== base.baseHash) result.conflicts.push({ workspaceId, kind: remote.kind, id: remote.id });
            else downloads.push({ record: remote, bytes: new Uint8Array() });
          } else {
            const bytes = await readRemoteObjectWithExactReplica(input.provider, remote.hash!, { workspaceId, entityKind: remote.kind, entityId: remote.id }, local);
            if (await sha256Bytes(bytes) !== remote.hash) throw v2Failure('object-download', 'object-integrity-failed', 'download', remote.kind);
            downloads.push({ record: remote, bytes });
          }
        } else if (base && !localMatchesBase && remoteMatchesBase) {
          const tombstoneValid = !local.entity.tombstone || base.baseHash !== null;
          if (!tombstoneValid) result.conflicts.push({ workspaceId, kind: local.entity.entityType, id: local.entity.entityId });
          else uploads.push({ record: { kind: local.entity.entityType, id: local.entity.entityId, parentId: local.entity.parentId, hash: local.hash, baseHash: base.baseHash, tombstone: local.entity.tombstone, ...(local.entity.entityType === 'asset' && !local.entity.tombstone ? { encoding: 'asset-envelope-v1' as const } : {}) }, bytes: local.entity.bytes });
        } else {
          result.conflicts.push({ workspaceId, kind: local.entity.entityType, id: local.entity.entityId });
        }
      }
      }

      if (result.conflicts.some(conflict => conflict.workspaceId === workspaceId)) {
        const conflict = result.conflicts.find(item => item.workspaceId === workspaceId)!;
        workspaceClassification = 'conflict';
        const diagnostic = presentCloudError(new CloudOperationError('conflict', { stage: 'record-reconciliation', reason: 'unproven-local-or-simultaneous-edit', operation: 'compare', workspaceId, entityKind: conflict.kind, entityId: conflict.id, retryable: false })).diagnostic;
        recordWorkspaceOutcome(workspaceId, 'conflict', 'conflict', diagnostic);
        continue;
      }
      input.onProgress?.(uploads.length ? 'Uploading changes…' : downloads.length ? 'Downloading changes…' : `Syncing workspace ${workspaceIndex + 1} of ${workspaceIds.length}…`);
      // Dependency order is part of the remote commit invariant.  A lexical
      // key order can place a notebook/asset before its workspace root, so
      // always stage roots before descendants and keep deterministic ordering
      // within each phase.
      uploads.sort((left, right) => phase[left.record.kind] - phase[right.record.kind]
        || keyOf(left.record).localeCompare(keyOf(right.record)));
      for (const upload of uploads) {
        currentEntity = upload.record;
        currentStage = 'object-upload';
        assertCurrent();
        if (!upload.record.tombstone) {
          const put = await input.provider.putObjectIfAbsent(upload.record.hash!, upload.bytes!);
          if (put === 'uploaded') result.uploaded += 1;
          const metadata = await input.provider.getObjectMetadata(upload.record.hash!);
          if (!metadata || metadata.size !== upload.bytes!.byteLength) throw v2Failure('object-upload', 'uploaded-object-unavailable', 'verify-upload', upload.record.kind);
        }
        nextRecords.set(keyOf(upload.record), upload.record);
      }

      if (repairedWorkspaceRoot) {
        const uploadedRoot = uploads.find(upload => keyOf(upload.record) === `workspace:${workspaceId}`);
        if (!uploadedRoot) {
          throw new CloudOperationError('remote-workspace', {
            stage: 'remote-recovery',
            reason: 'remote-workspace-root-repair-unavailable',
            operation: 'upload-workspace-root',
            workspaceId,
            entityKind: 'workspace',
            entityId: workspaceId,
            retryable: false,
          });
        }
        // Native reconstruction requires a root in the same transaction as
        // child deltas when the filesystem registry has not yet been warmed.
        // Applying the exact local canonical bytes is idempotent and cannot
        // allocate a duplicate directory; the upload above has already
        // verified the immutable object before this batch is applied.
        downloads.unshift({ record: uploadedRoot.record, bytes: repairedWorkspaceRoot.bytes });
      }

      const manifestChanged = repairedMissingRecords > 0 || uploads.length > 0 || (!manifest && scanned.some(entity => !entity.tombstone));
      let committedManifest = manifest;
      if (manifestChanged) {
        const revision = (manifest?.revision ?? 0) + 1;
        committedManifest = { format: 'panvas-sync-v2-manifest', schemaVersion: 2, workspaceId, revision, records: [...nextRecords.values()] };
      }

      if (committedManifest) {
        currentStage = 'manifest-validation';
        await mapBounded(committedManifest.records.filter(record => !record.tombstone), async record => {
          assertCurrent();
          if (await input.provider.getObjectMetadata(record.hash!)) return;

          // A previous run may have published a manifest immediately before
          // its content upload completed. Repair only when this device can
          // prove it has the exact bytes named by the manifest. Anything else
          // remains a hard failure; guessing would overwrite a newer remote
          // version or hide a genuine multi-device conflict.
          const local = localByKey.get(keyOf(record));
          if (!local || local.entity.tombstone || local.hash !== record.hash || !local.entity.bytes) {
            throw new CloudOperationError('sync', { stage: 'manifest-validation', reason: 'manifest-object-unavailable', operation: 'verify-object', workspaceId, entityKind: record.kind, entityId: record.id, retryable: false });
          }
          currentStage = 'object-upload';
          const put = await input.provider.putObjectIfAbsent(record.hash!, local.entity.bytes);
          if (put === 'uploaded') result.uploaded += 1;
          if (!(await input.provider.getObjectMetadata(record.hash!))) throw new CloudOperationError('sync', { stage: 'manifest-validation', reason: 'manifest-object-repair-failed', operation: 'verify-object', workspaceId, entityKind: record.kind, entityId: record.id, retryable: false });
        });
      }

      if (manifestChanged && committedManifest) {
        currentEntity = undefined;
        currentStage = 'manifest-write';
        assertCurrent();
        await input.provider.writeManifest(workspaceId, committedManifest, manifestRead.etag);
        nextCatalog.set(workspaceId, { workspaceId, manifestRevision: committedManifest.revision });
        catalogChanged = true;
      }

      if (committedManifest) {
        const catalogEntry = nextCatalog.get(workspaceId);
        if (!catalogEntry || catalogEntry.manifestRevision !== committedManifest.revision) {
          nextCatalog.set(workspaceId, { workspaceId, manifestRevision: committedManifest.revision });
          catalogChanged = true;
        }
      }

      for (const download of downloads.sort((a, b) => phase[a.record.kind] - phase[b.record.kind])) {
        currentEntity = download.record;
        currentStage = 'local-recovery-backup';
        assertCurrent();
        const local = localByKey.get(keyOf(download.record));
        if (local?.entity.bytes && local.hash && !local.entity.tombstone && !preservedDuringAdoption.has(keyOf(download.record))) {
          // Durable recovery copy BEFORE replacement. Proven unchanged bytes
          // are not a user conflict, so this archive does not block syncing.
          await input.conflictStore.preserve({ conflictId: `recovery:${profile.profileId}:${workspaceId}:${keyOf(download.record)}:${local.hash}:${download.record.hash ?? 'deleted'}`, profileId: profile.profileId, workspaceId, entityKind: local.entity.entityType, entityId: local.entity.entityId, parentId: local.entity.parentId, localHash: local.hash, remoteHash: download.record.hash ?? 'tombstone', localBytes: local.entity.bytes, createdAt: Date.now(), resolvedAt: Date.now() });
        }
      }
      currentStage = 'local-record-apply';
      const workspaceHasConflicts = result.conflicts.some(conflict => conflict.workspaceId === workspaceId);
      const hasStaleOwnershipDownload = downloads.some(download => {
        const local = localByKey.get(keyOf(download.record));
        return local?.entity.ownership === 'unowned-recovery' || local?.entity.ownership === 'foreign-recovery';
      });
      // The per-workspace proof matters here. A conflict preserved in an
      // earlier workspace must not disable safe ownership repair for a later
      // workspace, which was the source of the returning-browser loop.
      const allowStaleOwnershipRepair = !workspaceHasConflicts && hasStaleOwnershipDownload;
      if (input.adapter.applyWorkspace && downloads.length) {
        currentEntity = undefined;
        // A recovery root is synthetic input, not an existing local edit. It
        // must not participate in the optimistic edit check before native
        // reconstruction creates the canonical workspace directory.
        const expected = recoveryRoot ? scanned.filter(entity => entity !== recoveryRoot) : scanned;
        await input.adapter.applyWorkspace({ workspaceId, expected, downloads: downloads.map(item => ({ record: item.record, bytes: item.record.tombstone ? null : item.bytes })), allowStaleOwnershipRepair, assertCurrent });
        result.downloaded += downloads.length;
      } else for (const download of downloads) {
        currentEntity = download.record;
        assertCurrent();
        await input.adapter.applyRecord({ workspaceId, record: download.record, bytes: download.record.tombstone ? null : download.bytes, allowStaleOwnershipRepair });
        result.downloaded += 1;
      }
      if (committedManifest) {
        currentStage = 'local-baseline-rebuild';
        const applied = input.source.scanFreshWorkspace ? new Map((await input.source.scanFreshWorkspace(workspaceId)).map(entity => [keyOf(entity), entity])) : null;
        for (const record of committedManifest.records) {
          const local = localByKey.get(keyOf(record));
          const uploaded = uploads.find(item => keyOf(item.record) === keyOf(record));
          const downloaded = downloads.find(item => keyOf(item.record) === keyOf(record));
          const baseline = baselineFor(record, uploaded?.record.hash ?? (downloaded ? record.hash : record.tombstone ? null : local?.hash ?? record.hash), committedManifest.revision);
          const replica = applied?.get(keyOf(record));
          // Capture transformed download bytes, never bless an edit made
          // during upload as already synchronized.
          if (downloaded && replica?.bytes && !replica.tombstone) {
            const identity = await contentIdentity(record.kind, replica.bytes);
            if (identity !== null && identity === await contentIdentity(record.kind, downloaded.bytes)) {
              baseline.localHash = await sha256Bytes(replica.bytes);
              baseline.localContentHash = await sha256Bytes(new TextEncoder().encode(identity));
            }
          }
          nextBaselines.set(keyOf(record), baseline);
        }
        stagedBaselines.set(workspaceId, [...nextBaselines.values()]);
        // A returning device already has a verified profile. A read-only
        // workspace recovery needs no remote publication: checkpoint it now
        // so an unrelated later failure does not erase its successful baseline.
        // Uploading/new-profile runs still commit only after catalog publication.
        if (!manifestChanged && localProfile?.profileId === profile.profileId) {
          assertCurrent();
          await input.baselines.saveWorkspace(workspaceId, [...nextBaselines.values()]);
        }
      }
      recordWorkspaceOutcome(workspaceId, workspaceClassification, 'synced');
      } catch (error) {
        // Provider/account failures must still stop the run. Workspace-scoped
        // integrity, relationship, and local-apply failures are quarantined so
        // healthy workspaces can finish and report their own outcomes.
        if (!(error instanceof CloudOperationError)
          || ['configuration', 'connection', 'offline', 'auth-expired', 'rate-limited', 'remote-account-conflict', 'account-migration-required'].includes(error.code)) throw error;
        const shown = presentCloudError(error, currentStage);
        const workspaceScopedReason = new Set([
          'catalog-manifest-unavailable',
          'remote-workspace-root-missing',
          'remote-workspace-root-ambiguous',
          'remote-workspace-root-repair-unavailable',
          'invalid-relationship',
          'local-edit-during-sync',
        ]).has(shown.diagnostic.reason);
        if (shown.code !== 'remote-workspace' && !workspaceScopedReason) throw error;
        const diagnostic = sanitizeCloudDiagnostic({ ...shown.diagnostic, workspaceId: shown.diagnostic.workspaceId ?? workspaceId, entityKind: shown.diagnostic.entityKind ?? currentEntity?.kind ?? 'workspace', entityId: shown.diagnostic.entityId ?? currentEntity?.id ?? workspaceId });
        const classification: SyncV2WorkspaceClassification = shown.code === 'conflict' ? 'conflict' : shown.code === 'remote-workspace' ? 'orphaned' : 'ambiguous';
        recordWorkspaceOutcome(workspaceId, classification, classification === 'conflict' ? 'conflict' : 'error', diagnostic);
        continue;
      }
    }

    if (result.conflicts.length) {
      // A conflict is scoped to its workspace. Any other workspace that
      // completed the BASE/LOCAL/REMOTE proof may already have published a
      // manifest; commit its catalog entry and baseline now so one unresolved
      // workspace cannot roll back or re-block unrelated workspaces.
      assertCurrent();
      currentStage = 'baseline-commit';
      if (catalogChanged) await input.provider.writeCatalog({ ...catalog, revision: catalog.revision + 1, workspaces: [...nextCatalog.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)) }, catalogRead.etag);
      assertCurrent();
      await input.baselines.saveProfile({ profileId: profile.profileId, accountIdentifier: input.accountIdentifier });
      for (const [workspaceId, records] of stagedBaselines) { assertCurrent(); await input.baselines.saveWorkspace(workspaceId, records); }
      const conflict = result.conflicts[0];
      const shown = presentCloudError(new CloudOperationError('conflict', { stage: 'record-reconciliation', reason: 'unproven-local-or-simultaneous-edit', operation: 'compare', workspaceId: conflict.workspaceId, entityKind: conflict.kind, entityId: conflict.id, retryable: false }));
      return { ...result, status: 'conflict', error: shown.message, errorCode: shown.code, diagnostic: shown.diagnostic };
    }
    assertCurrent();
    currentWorkspaceId = undefined;
    currentEntity = undefined;
    currentStage = 'baseline-commit';
    if (catalogChanged) await input.provider.writeCatalog({ ...catalog, revision: catalog.revision + 1, workspaces: [...nextCatalog.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)) }, catalogRead.etag);
    assertCurrent();
    await input.baselines.saveProfile({ profileId: profile.profileId, accountIdentifier: input.accountIdentifier });
    for (const [workspaceId, records] of stagedBaselines) { assertCurrent(); await input.baselines.saveWorkspace(workspaceId, records); }
    const reviewRequired = await input.conflictStore.hasUnresolved(profile.profileId);
    const workspaceReviewRequired = result.workspaceOutcomes.some(outcome => outcome.classification === 'orphaned' || outcome.classification === 'ambiguous' || outcome.classification === 'conflict');
    input.onProgress?.(reviewRequired || workspaceReviewRequired ? 'Synced - changes need review' : 'Up to date');
    const firstIssue = result.workspaceOutcomes.find(outcome => outcome.diagnostic)?.diagnostic;
    const firstWorkspaceConflict = result.workspaceOutcomes.find(outcome => outcome.classification === 'conflict');
    // Keep the aggregate status reviewable when other workspaces completed,
    // while retaining the conflict code for callers that need to distinguish
    // a genuine two-sided edit from an orphan/recovery warning.

    // Post-sync convergence check: verify local workspaces match remote catalog
    const postSyncLocalIds = (await input.source.listWorkspaceIds()).filter(id => id !== 'default').sort();
    const postSyncRemoteIds = [...nextCatalog.values()].map(w => w.workspaceId).sort();
    const converged = postSyncLocalIds.length === postSyncRemoteIds.length && postSyncLocalIds.every((id, idx) => id === postSyncRemoteIds[idx]);
    if (!converged && !reviewRequired && !workspaceReviewRequired) {
      const diagnostic = sanitizeCloudDiagnostic({ stage: 'convergence-check', reason: 'convergence-check-failed', operation: 'verify-convergence', retryable: false });
      return {
        ...result,
        status: 'synced-review',
        errorCode: 'sync',
        diagnostic,
      };
    }

    return {
      ...result,
      status: reviewRequired || workspaceReviewRequired ? 'synced-review' : 'synced',
      errorCode: firstWorkspaceConflict ? 'conflict' : result.errorCode,
      diagnostic: firstIssue ?? result.diagnostic,
    };
  } catch (error) {
    const shown = presentCloudError(error, currentStage);
    return { ...result, status: 'error', error: shown.message, errorCode: shown.code, diagnostic: sanitizeCloudDiagnostic({ ...shown.diagnostic, workspaceId: shown.diagnostic.workspaceId ?? currentWorkspaceId, entityKind: shown.diagnostic.entityKind ?? currentEntity?.kind, entityId: shown.diagnostic.entityId ?? currentEntity?.id }) };
  } finally {
    input.source.endCycle?.();
  }
}
