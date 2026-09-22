/** Optional local-first Cloud Sync coordination for Electron and browser/PWA. */
import { create } from 'zustand';
import type { CloudSyncProgress, CloudSyncProvider, CloudSyncStatus, CloudWorkspaceBinding, ProviderConnectionInfo, RemoteWorkspaceSummary, SafeCloudDiagnostic, WorkspaceCloudStatus } from '@/services/cloudsync/types';
import { GoogleDriveSyncProvider } from '@/services/cloudsync/googleDriveProvider';
import { finalizeAccountSync, runSyncCycle, type DeviceManifestState, type SyncEntryError } from '@/services/cloudsync/engine';
import { commitMigratedWorkspaceJournal, dexieSyncJournalStore, recoverStaleJournalMetadata, restoreWorkspaceJournalSnapshot } from '@/database/syncJournalDB';
import { LocalSyncPayloadSource, setCurrentBrowserUserIdReader } from '@/services/cloudsync/payloadSource';
import { applyRemoteChanges, defaultRemoteRecordLocalAdapter } from '@/services/cloudsync/applyRemoteChanges';
import { migrateWorkspaceToGoogleAccount } from '@/services/cloudsync/accountMigration';
import { attachWorkspaceReplica, replicateMissingRemoteWorkspaces } from '@/services/cloudsync/workspaceReplica';
import { accountMigrationWorkspaceIds, attachedWorkspaceIds, bindingsForAccount, loadWorkspaceBindings, moveWorkspaceBinding, reconcileWorkspaceBindings, replaceWorkspaceBindings, saveWorkspaceBinding, workspaceHasBinding, workspaceIsBoundToOtherAccount } from '@/services/cloudsync/workspaceBindings';
import { CloudOperationError, logCloudDiagnostic, presentCloudError, publicCloudMessage } from '@/services/cloudsync/errors';
import { validateRemoteManifest } from '@/services/cloudsync/manifest';
import { hasBrowserGoogleToken, preloadGis } from '@/services/cloudsync/browserGoogleAuth';
import { db, initializeDatabase } from '@/database/schema';
import { CLOUD_SYNC_V2_ENABLED } from '@/config/features';
import { runCloudSyncV2 } from '@/services/cloudsync/v2/engine';
import { LocalStorageSyncV2BaselineStore } from '@/services/cloudsync/v2/baselineStore';
import { GoogleDriveSyncV2Provider } from '@/services/cloudsync/v2/googleDriveV2Provider';
import { syncV2LocalAdapter, syncV2LocalSource } from '@/services/cloudsync/v2/localAdapter';
import { dexieSyncV2ConflictStore } from '@/services/cloudsync/v2/conflictStore';
import { SinglePendingRunner } from '@/services/cloudsync/v2/singlePendingRunner';
import { mergeWorkspaceCloudStatuses } from '@/services/cloudsync/presentation';
import { useAuthStore } from '@/stores/authStore';
import { SyncRunAuthority, guardSyncCalls } from '@/services/cloudsync/runAuthority';
import { planAccountAdoption } from '@/services/cloudsync/v2/accountAdoption';
import type { SyncV2ConflictChoice, SyncV2ConflictResolution, SyncV2ProfileState, SyncV2WorkspaceOutcome } from '@/services/cloudsync/v2/types';
import { inspectAndMigrateLegacyPanvasRoot } from '@/services/cloudsync/v2/legacyMigration';
import { migrateFromDexieToFs } from '@/lib/migration';
import { completeDeviceResetHydration, resetBrowserLocalData } from '@/services/cloudsync/deviceReset';

export type SyncProviderId = CloudSyncProvider['id'];

export interface SafeSyncMetrics {
  localEntitiesScanned: number; payloadsLoaded: number; objectsUploaded: number; objectsAlreadyPresent: number;
  manifestEntries: number; journalEntriesProcessed: number; remoteObjectsDownloaded: number; conflictsCreated: number;
  bytesUploaded: number; largeAssets: number; totalGoogleRequests: number; retries: number; backoffMs: number; timeouts: number;
  totalDurationMs: number; manifestReadMs: number; manifestWriteMs: number; manifestReadBackMs: number; hashingAndLoadMs: number; objectTransferMs: number;
}

interface CloudSyncState {
  statusByProvider: Record<SyncProviderId, CloudSyncStatus>;
  connectionByProvider: Record<SyncProviderId, ProviderConnectionInfo | null>;
  lastSyncedByProvider: Record<SyncProviderId, number | null>;
  workspaceStatusById: Record<string, WorkspaceCloudStatus>;
  lastSyncedByWorkspaceId: Record<string, number | null>;
  bindings: CloudWorkspaceBinding[];
  autoSync: boolean; isSyncing: boolean; lastError: string | null; lastDiagnostic: SafeCloudDiagnostic | null; lastMetrics: SafeSyncMetrics | null;
  isResetting: boolean;
  progress: CloudSyncProgress | null; remoteWorkspaces: RemoteWorkspaceSummary[];
  migrationWorkspaceIds: string[];
  reviewItems: Array<{ conflictId: string; workspaceId: string; entityKind: string; entityId: string }>;
  workspaceRecoveryIssues: SyncV2WorkspaceOutcome[];
  resolveReviewChanges: (choice?: SyncV2ConflictChoice) => Promise<boolean>;
  setAutoSync: (enabled: boolean) => void;
  setConnectivity: (online: boolean) => void;
  initialize: () => Promise<void>;
  requestConnect: (provider: SyncProviderId, customClientId?: string) => Promise<boolean>;
  requestDisconnect: (provider: SyncProviderId) => Promise<void>;
  triggerSync: (workspaceId?: string) => Promise<void>;
  resetThisDevice: () => Promise<boolean>;
  refreshRemoteWorkspaces: () => Promise<void>;
  attachRemoteWorkspace: (workspaceId: string) => Promise<boolean>;
  enableSyncForWorkspace: (workspaceId: string) => Promise<boolean>;
  moveSyncToCurrentGoogleAccount: (workspaceIds?: readonly string[]) => Promise<boolean>;
  loadReviewChanges: () => Promise<void>;
  openLocalWorkspace: (workspaceId: string) => Promise<boolean>;
}

const providers = ['onedrive', 'googledrive', 'dropbox'] as const;
const statuses = Object.fromEntries(providers.map(id => [id, 'disconnected'])) as Record<SyncProviderId, CloudSyncStatus>;
const connections = Object.fromEntries(providers.map(id => [id, null])) as Record<SyncProviderId, ProviderConnectionInfo | null>;
const lastSynced = Object.fromEntries(providers.map(id => [id, null])) as Record<SyncProviderId, number | null>;
const googleDriveProvider = new GoogleDriveSyncProvider();
setCurrentBrowserUserIdReader(() => useAuthStore.getState().user?.id ?? null);
const localPayloadSource = new LocalSyncPayloadSource();
const deviceStates = new Map<string, DeviceManifestState>();
let initialized = false;
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
const v2SyncRunner = new SinglePendingRunner();
const syncAuthority = new SyncRunAuthority();
let v2BaselineStore: LocalStorageSyncV2BaselineStore | null = null;
const pendingV2ConflictResolutions = new Map<string, SyncV2ConflictChoice>();
let deviceResetInProgress = false;
const conflictResolutionKey = (item: { workspaceId: string; entityKind: string; entityId: string }) => `${item.workspaceId}:${item.entityKind}:${item.entityId}`;
function getV2BaselineStore(): LocalStorageSyncV2BaselineStore {
  return v2BaselineStore ??= new LocalStorageSyncV2BaselineStore();
}

/**
 * A sync apply writes canonical metadata/payloads before the run reports
 * success. Refresh both the workspace index and the active workspace's
 * projection so a newly reconstructed tree cannot remain visually stale until
 * the next navigation or app restart.
 */
async function refreshWorkspaceProjectionAfterSync(): Promise<void> {
  const workspaceStore = await import('@/stores/workspaceStore');
  const store = workspaceStore.useWorkspaceStore.getState();
  await store.loadWorkspaces();
  const activeWorkspaceId = workspaceStore.useWorkspaceStore.getState().activeWorkspaceId;
  if (activeWorkspaceId) await workspaceStore.useWorkspaceStore.getState().loadWorkspaceContents(activeWorkspaceId);
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempts = 0;
// Browser implementations expose navigator.onLine, while Electron/SSR test
// harnesses may expose navigator without that optional property. Unknown is
// not the same as offline: only an explicit false should block a sync run.
function isOnline(): boolean { return typeof navigator === 'undefined' || navigator.onLine !== false; }
function clearRetry(): void { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; }
function invalidateSync(): void {
  syncAuthority.invalidate(); v2SyncRunner.cancelPending(); clearRetry(); retryAttempts = 0;
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = null;
}

function scheduleRetry(diagnostic: SafeCloudDiagnostic | null | undefined): void {
  if (!diagnostic?.retryable || retryAttempts >= 3 || retryTimer || !useCloudSyncStore.getState().autoSync || useCloudSyncStore.getState().statusByProvider.googledrive === 'auth-expired') return;
  const delay = Math.min(60_000, 5_000 * 2 ** retryAttempts++);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (useCloudSyncStore.getState().autoSync && isOnline()) void useCloudSyncStore.getState().triggerSync();
  }, delay);
}

const emptyMetrics = (): SafeSyncMetrics => ({ localEntitiesScanned: 0, payloadsLoaded: 0, objectsUploaded: 0, objectsAlreadyPresent: 0, manifestEntries: 0, journalEntriesProcessed: 0, remoteObjectsDownloaded: 0, conflictsCreated: 0, bytesUploaded: 0, largeAssets: 0, totalGoogleRequests: 0, retries: 0, backoffMs: 0, timeouts: 0, totalDurationMs: 0, manifestReadMs: 0, manifestWriteMs: 0, manifestReadBackMs: 0, hashingAndLoadMs: 0, objectTransferMs: 0 });

function localDeviceId(): string {
  const key = 'panvas_cloud_device_id';
  try { const existing = localStorage.getItem(key); if (existing) return existing; const id = `device-${crypto.randomUUID()}`; localStorage.setItem(key, id); return id; }
  catch { return `device-${crypto.randomUUID()}`; }
}

function lastSuccess(connection: ProviderConnectionInfo, timestamp?: number): number | null {
  const localOwner = typeof window !== 'undefined' && window.panvas ? 'desktop' : useAuthStore.getState().user?.id ?? 'anonymous';
  const key = `panvas.cloudSync.lastSuccess.${CLOUD_SYNC_V2_ENABLED ? 'v2' : 'v1'}.${encodeURIComponent(localOwner)}.${encodeURIComponent(connection.accountIdentifier)}`;
  try {
    if (timestamp !== undefined) localStorage.setItem(key, String(timestamp));
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return timestamp ?? null; } // Optional presentation metadata must not fail a completed sync.
}

/** Clear presentation-only sync metadata when the local replica is reset.
 * The verified provider connection remains intact; only the old run timestamp
 * is removed so a restart cannot display a pre-reset "Last synced" value. */
function clearLastSuccess(connection: ProviderConnectionInfo): void {
  const localOwner = typeof window !== 'undefined' && window.panvas ? 'desktop' : useAuthStore.getState().user?.id ?? 'anonymous';
  const key = `panvas.cloudSync.lastSuccess.${CLOUD_SYNC_V2_ENABLED ? 'v2' : 'v1'}.${encodeURIComponent(localOwner)}.${encodeURIComponent(connection.accountIdentifier)}`;
  try { localStorage.removeItem(key); } catch { /* optional presentation metadata */ }
}

async function localWorkspaceIds(): Promise<string[]> {
  if (typeof window !== 'undefined' && window.panvas) {
    const [active, trash] = await Promise.all([
      window.panvas.workspace.getAll(),
      window.panvas.trash.getAll(null),
    ]);
    return [...new Set([
      ...active.map(item => item.id),
      ...trash.workspaces.map(item => item.id),
    ])].filter(id => id !== 'default');
  }
  // Deleted roots remain in sync scope until their tombstones are published.
  // The normal Library projection still filters them out.
  const userId = useAuthStore.getState().user?.id ?? null;
  return (await db.workspaces.toArray())
    .filter(item => (item.userId ?? null) === userId)
    .map(item => item.id)
    .filter(id => id !== 'default');
}

function entryError(error: SyncEntryError, workspaceId: string): CloudOperationError {
  const code = error.errorClass === 'auth-expired' ? 'auth-expired'
    : error.errorClass === 'rate-limited' ? 'rate-limited'
      : error.errorClass === 'provider-conflict' || error.errorClass === 'conflict' ? 'conflict'
        : error.errorClass === 'payload-missing' || error.errorClass === 'initial-scan-empty' ? 'payload' : 'sync';
  return new CloudOperationError(code, {
    workspaceId,
    stage: error.stage,
    reason: error.providerReason ?? error.errorClass,
    status: error.providerStatus,
    entityKind: error.entityType,
    entityId: error.entityId,
    operation: error.operation,
    retryable: error.retryable ?? code === 'rate-limited',
  });
}

function bindingFor(workspaceId: string, connection: ProviderConnectionInfo, revision: number, bindings: readonly CloudWorkspaceBinding[]): CloudWorkspaceBinding {
  const prior = bindings.find(item => item.provider === 'googledrive' && item.workspaceId === workspaceId && item.providerAccountId === connection.accountIdentifier);
  return { workspaceId, provider: 'googledrive', providerAccountId: connection.accountIdentifier, remoteWorkspaceId: workspaceId, lastKnownRemoteRevision: revision, attachedAt: prior?.attachedAt ?? Date.now() };
}

function boundForCurrentAccount(state: CloudSyncState, workspaceId: string): boolean {
  const accountId = state.connectionByProvider.googledrive?.accountIdentifier;
  return Boolean(accountId && bindingsForAccount(state.bindings, accountId).some(item => item.workspaceId === workspaceId));
}

function logAccountSyncFailure(diagnostic: SafeCloudDiagnostic): void {
  logCloudDiagnostic(diagnostic);
}

export const useCloudSyncStore = create<CloudSyncState>((set, get) => ({
  statusByProvider: statuses, connectionByProvider: connections, lastSyncedByProvider: lastSynced,
  workspaceStatusById: {}, lastSyncedByWorkspaceId: {}, bindings: CLOUD_SYNC_V2_ENABLED ? [] : loadWorkspaceBindings(),
  autoSync: true, isSyncing: false, isResetting: false, lastError: null, lastDiagnostic: null, lastMetrics: null, progress: null, remoteWorkspaces: [], migrationWorkspaceIds: [],
  reviewItems: [], workspaceRecoveryIssues: [],
  resolveReviewChanges: async (choice) => {
    if (!CLOUD_SYNC_V2_ENABLED) return false;
    try {
      const quarantined = new Set(get().workspaceRecoveryIssues.map(item => item.workspaceId));
      const current = get().reviewItems.filter(item => !quarantined.has(item.workspaceId));
      if (current.length === 0) return false;
      const generic = current.filter(item => item.conflictId.startsWith('sync-conflict:'));
      if (choice && generic.length > 0) {
        generic.forEach(item => pendingV2ConflictResolutions.set(conflictResolutionKey(item), choice));
        await get().triggerSync();
        const status = useCloudSyncStore.getState().statusByProvider.googledrive;
        if (status === 'synced' || status === 'synced-review') {
          generic.forEach(item => pendingV2ConflictResolutions.delete(conflictResolutionKey(item)));
          const profile = await getV2BaselineStore().loadProfile();
          for (const item of generic) {
            await dexieSyncV2ConflictStore.resolve?.(item.conflictId, profile?.profileId ?? '');
          }
          await get().loadReviewChanges();
          return true;
        }
        return false;
      }
      const profile = await getV2BaselineStore().loadProfile();
      const resolve = dexieSyncV2ConflictStore.resolve;
      if (!profile || !resolve) return false;
      await Promise.all(current.map(item => resolve(item.conflictId, profile.profileId)));
      const remaining = dexieSyncV2ConflictStore.listUnresolved
        ? await dexieSyncV2ConflictStore.listUnresolved(profile.profileId)
        : [];
      if (remaining.length > 0) {
        set({ reviewItems: remaining.map(item => ({ conflictId: item.conflictId, workspaceId: item.workspaceId, entityKind: item.entityKind, entityId: item.entityId })) });
        return false;
      }
      await get().loadReviewChanges();
      if (get().reviewItems.length > 0) return false;
      set(state => ({
        reviewItems: [],
        statusByProvider: { ...state.statusByProvider, googledrive: 'synced' },
        lastError: null,
        lastDiagnostic: null,
        progress: { stage: 'complete', completed: 1, total: 1, message: 'Up to date' },
      }));
      return true;
    } catch {
      return false;
    }
  },
  loadReviewChanges: async () => {
    if (!CLOUD_SYNC_V2_ENABLED) { set({ reviewItems: [] }); return; }
    try {
      const profile = await getV2BaselineStore().loadProfile();
      const stored = dexieSyncV2ConflictStore.listUnresolved
        ? await dexieSyncV2ConflictStore.listUnresolved(profile?.profileId)
        : [];
      // Keep archived bytes, but do not reintroduce quarantined descendants
      // into the normal conflict controls when the panel reloads its review.
      const quarantined = new Set(get().workspaceRecoveryIssues.map(item => item.workspaceId));
      const list = stored.filter(item => !quarantined.has(item.workspaceId));
      set({ reviewItems: list.map(item => ({ conflictId: item.conflictId, workspaceId: item.workspaceId, entityKind: item.entityKind, entityId: item.entityId })) });
    } catch {
      set({ reviewItems: [] });
    }
  },
  setAutoSync: enabled => { if (!enabled) clearRetry(); set({ autoSync: enabled }); },
  setConnectivity: online => {
    const state = get();
    if (!state.connectionByProvider.googledrive) return;
    if (!online) {
      if (state.statusByProvider.googledrive === 'connected' || state.statusByProvider.googledrive === 'synced') {
        set(current => ({ statusByProvider: { ...current.statusByProvider, googledrive: 'offline' } }));
      }
      return;
    }
    if (state.statusByProvider.googledrive === 'offline') {
      set(current => ({ statusByProvider: { ...current.statusByProvider, googledrive: 'connected' } }));
      if (state.autoSync) void get().triggerSync();
    }
  },

  initialize: async () => {
    if (initialized) return; initialized = true;
    const assertCurrent = syncAuthority.capture();
    void preloadGis();
    try {
      const info = await googleDriveProvider.getAccountInfo();
      if (!info) return;
      const localIds = await localWorkspaceIds();
      assertCurrent();
      if (CLOUD_SYNC_V2_ENABLED) {
        set(state => ({
          bindings: [], migrationWorkspaceIds: [],
          connectionByProvider: { ...state.connectionByProvider, googledrive: info },
          lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: lastSuccess(info) },
          statusByProvider: { ...state.statusByProvider, googledrive: isOnline() ? 'connected' : 'offline' },
          workspaceStatusById: { ...state.workspaceStatusById, ...Object.fromEntries(localIds.map(id => [id, 'connected'])) },
        }));
        await get().loadReviewChanges();
        const isElectron = typeof window !== 'undefined' && Boolean(window.panvas);
        const canBackgroundSync = isElectron || hasBrowserGoogleToken();
        if (isOnline() && get().autoSync && canBackgroundSync) void get().triggerSync();
        return;
      }
      let bindings = reconcileWorkspaceBindings(info.accountIdentifier, localIds, undefined, Date.now(), info.email ? [info.email] : []);
      for (const localId of localIds) {
        if (localId !== 'default' && !workspaceHasBinding(bindings, localId)) {
          bindings = saveWorkspaceBinding(bindingFor(localId, info, 0, bindings));
        }
      }
      const attached = attachedWorkspaceIds(bindings, info.accountIdentifier, localIds);
      const migrationWorkspaceIds = accountMigrationWorkspaceIds(bindings, localIds, info.accountIdentifier);
      const connectionStatus: CloudSyncStatus = migrationWorkspaceIds.length > 0 ? 'account-migration-required' : isOnline() ? 'connected' : 'offline';
      set(state => ({
        bindings, migrationWorkspaceIds,
        connectionByProvider: { ...state.connectionByProvider, googledrive: info },
        lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: lastSuccess(info) },
        statusByProvider: { ...state.statusByProvider, googledrive: connectionStatus },
        workspaceStatusById: {
          ...state.workspaceStatusById,
          ...Object.fromEntries(attached.map(id => [id, 'connected'])),
          ...Object.fromEntries(migrationWorkspaceIds.map(id => [id, 'account-migration-required'])),
        },
        lastError: migrationWorkspaceIds.length > 0 ? publicCloudMessage('account-migration-required') : null,
      }));
      const isElectron = typeof window !== 'undefined' && Boolean(window.panvas);
      const canBackgroundSync = isElectron || hasBrowserGoogleToken();
      if (isOnline() && get().autoSync && canBackgroundSync) void get().triggerSync();
    } catch (error) { initialized = false; const shown = presentCloudError(error, 'initialize'); logCloudDiagnostic(shown.diagnostic); }
  },

  requestConnect: async provider => {
    if (provider !== 'googledrive') return false;
    invalidateSync();
    const assertCurrent = syncAuthority.capture();
    set(state => ({ statusByProvider: { ...state.statusByProvider, googledrive: 'connecting' }, lastError: null, lastDiagnostic: null }));
    try {
      await v2SyncRunner.whenIdle();
      assertCurrent();
      googleDriveProvider.clearCaches();
      const connection = await googleDriveProvider.connect();
      const localIds = await localWorkspaceIds();
      assertCurrent();
      if (CLOUD_SYNC_V2_ENABLED) {
        set(state => ({
          bindings: [], migrationWorkspaceIds: [],
          reviewItems: [],
          connectionByProvider: { ...state.connectionByProvider, googledrive: connection },
          lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: lastSuccess(connection) },
          statusByProvider: { ...state.statusByProvider, googledrive: 'connected' },
          workspaceStatusById: { ...state.workspaceStatusById, ...Object.fromEntries(localIds.map(id => [id, 'connected'])) },
          lastError: null,
          lastDiagnostic: null,
        }));
        void get().triggerSync();
        return true;
      }
      let bindings = reconcileWorkspaceBindings(connection.accountIdentifier, localIds, undefined, Date.now(), connection.email ? [connection.email] : []);
      for (const localId of localIds) {
        if (localId !== 'default' && !workspaceHasBinding(bindings, localId)) {
          bindings = saveWorkspaceBinding(bindingFor(localId, connection, 0, bindings));
        }
      }
      const attached = attachedWorkspaceIds(bindings, connection.accountIdentifier, localIds);
      const migrationWorkspaceIds = accountMigrationWorkspaceIds(bindings, localIds, connection.accountIdentifier);
      const connectionStatus: CloudSyncStatus = migrationWorkspaceIds.length > 0 ? 'account-migration-required' : 'connected';
      set(state => ({
        bindings, migrationWorkspaceIds,
        connectionByProvider: { ...state.connectionByProvider, googledrive: connection },
        lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: lastSuccess(connection) },
        statusByProvider: { ...state.statusByProvider, googledrive: connectionStatus },
        workspaceStatusById: {
          ...state.workspaceStatusById,
          ...Object.fromEntries(attached.map(id => [id, 'connected'])),
          ...Object.fromEntries(migrationWorkspaceIds.map(id => [id, 'account-migration-required'])),
        },
        lastError: migrationWorkspaceIds.length > 0 ? publicCloudMessage('account-migration-required') : null,
        lastDiagnostic: null,
      }));
      void get().triggerSync();
      return true;
    } catch (error) {
      try { assertCurrent(); } catch { return false; }
      const shown = presentCloudError(error, 'authorization'); logCloudDiagnostic(shown.diagnostic);
      set(state => ({ statusByProvider: { ...state.statusByProvider, googledrive: shown.status }, lastError: shown.message, lastDiagnostic: shown.diagnostic })); return false;
    }
  },

  requestDisconnect: async provider => {
    if (provider !== 'googledrive') return;
    invalidateSync();
    set(state => ({ connectionByProvider: { ...state.connectionByProvider, googledrive: null }, isSyncing: false }));
    await v2SyncRunner.whenIdle();
    try { await googleDriveProvider.disconnect(); } catch { /* local data and bindings remain */ }
    const localIds = await localWorkspaceIds();
    set(state => ({ statusByProvider: { ...state.statusByProvider, googledrive: 'disconnected' }, connectionByProvider: { ...state.connectionByProvider, googledrive: null }, lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: null }, workspaceStatusById: { ...state.workspaceStatusById, ...Object.fromEntries(localIds.map(id => [id, 'local-only'])) }, lastError: null, lastDiagnostic: null, lastMetrics: null, progress: null, remoteWorkspaces: [], migrationWorkspaceIds: [], reviewItems: [], workspaceRecoveryIssues: [] }));
  },

  refreshRemoteWorkspaces: async () => {
    if (CLOUD_SYNC_V2_ENABLED) return;
    if (!get().connectionByProvider.googledrive || !googleDriveProvider.listRemoteWorkspaces) return;
    try { set({ remoteWorkspaces: await googleDriveProvider.listRemoteWorkspaces() }); }
    catch (error) { const shown = presentCloudError(error, 'workspace_discovery'); logCloudDiagnostic(shown.diagnostic); set({ lastError: shown.message, lastDiagnostic: shown.diagnostic }); }
  },

  openLocalWorkspace: async workspaceId => {
    if (!(await localWorkspaceIds()).includes(workspaceId)) return false;
    const workspaceStore = await import('@/stores/workspaceStore');
    await workspaceStore.useWorkspaceStore.getState().loadWorkspaces();
    await workspaceStore.useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
    return true;
  },

  attachRemoteWorkspace: async workspaceId => {
    if (CLOUD_SYNC_V2_ENABLED) return false;
    const connection = get().connectionByProvider.googledrive;
    if (!connection || get().isSyncing || workspaceId === 'default') return false;
    if (workspaceIsBoundToOtherAccount(get().bindings, workspaceId, connection.accountIdentifier)) return false;
    const localIds = await localWorkspaceIds();
    if (boundForCurrentAccount(get(), workspaceId) && localIds.includes(workspaceId)) return get().openLocalWorkspace(workspaceId);
    set(state => ({ isSyncing: true, statusByProvider: { ...state.statusByProvider, googledrive: 'syncing' }, workspaceStatusById: { ...state.workspaceStatusById, [workspaceId]: 'syncing' }, lastError: null, lastDiagnostic: null, progress: { stage: 'downloading', completed: 0, total: 1, message: 'Syncing workspace…' } }));
    try {
      const remote = await googleDriveProvider.readManifest(workspaceId);
      const manifest = remote.manifest ? validateRemoteManifest(remote.manifest) : null;
      if (!manifest || manifest.workspaceId !== workspaceId) throw new CloudOperationError('remote-workspace', { stage: 'workspace_attach', reason: 'manifest_unavailable', retryable: false });
      const result = await attachWorkspaceReplica({ workspaceId, records: manifest.records, remoteRevision: manifest.revision, hasLocalWorkspace: localIds.includes(workspaceId), provider: googleDriveProvider, journalStore: dexieSyncJournalStore, payloadSource: localPayloadSource, onProgress: (completed, total) => set({ progress: { stage: 'downloading', completed, total, message: `Syncing workspace ${completed} of ${total}…` } }) });
      if (result.errors > 0) throw new CloudOperationError('remote-workspace', { stage: 'workspace_reconstruction', reason: 'record_apply_failed', retryable: false });
      const bindings = saveWorkspaceBinding(bindingFor(workspaceId, connection, manifest.revision, get().bindings));
      deviceStates.set(workspaceId, { lastSeenRevision: manifest.revision });
      const status: WorkspaceCloudStatus = result.stagedConflicts > 0 ? 'conflict' : 'synced';
      const syncedAt = status === 'synced' ? Date.now() : null;
      set(state => ({ bindings, isSyncing: false, statusByProvider: { ...state.statusByProvider, googledrive: status === 'conflict' ? 'conflict' : 'synced' }, workspaceStatusById: { ...state.workspaceStatusById, [workspaceId]: status }, lastSyncedByWorkspaceId: { ...state.lastSyncedByWorkspaceId, [workspaceId]: syncedAt }, lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: syncedAt ?? state.lastSyncedByProvider.googledrive }, lastError: status === 'conflict' ? publicCloudMessage('conflict') : null, progress: { stage: 'complete', completed: 1, total: 1, message: status === 'conflict' ? 'Synchronized with conflicts to review' : 'All changes synchronized' } }));
      const workspaceStore = await import('@/stores/workspaceStore');
      await workspaceStore.useWorkspaceStore.getState().loadWorkspaces();
      return true;
    } catch (error) {
      const shown = presentCloudError(error, 'workspace_attach'); logCloudDiagnostic(shown.diagnostic);
      const status: WorkspaceCloudStatus = shown.status === 'conflict' ? 'conflict' : shown.status === 'offline' ? 'offline' : shown.status === 'auth-expired' ? 'auth-expired' : shown.status === 'rate-limited' ? 'rate-limited' : 'error';
      set(state => ({ isSyncing: false, statusByProvider: { ...state.statusByProvider, googledrive: shown.status }, workspaceStatusById: { ...state.workspaceStatusById, [workspaceId]: status }, lastError: shown.message, lastDiagnostic: shown.diagnostic, progress: null })); return false;
    }
  },

  enableSyncForWorkspace: async workspaceId => {
    if (CLOUD_SYNC_V2_ENABLED) return false;
    const connection = get().connectionByProvider.googledrive;
    if (!connection || !(await localWorkspaceIds()).includes(workspaceId) || workspaceId === 'default') return false;
    if (workspaceIsBoundToOtherAccount(get().bindings, workspaceId, connection.accountIdentifier)) return false;
    if (boundForCurrentAccount(get(), workspaceId)) { await get().triggerSync(workspaceId); return get().workspaceStatusById[workspaceId] === 'synced'; }
    try {
      const remote = await googleDriveProvider.readManifest(workspaceId);
      if (remote.manifest) return get().attachRemoteWorkspace(workspaceId);
      const bindings = saveWorkspaceBinding(bindingFor(workspaceId, connection, 0, get().bindings));
      set(state => ({ bindings, workspaceStatusById: { ...state.workspaceStatusById, [workspaceId]: 'connected' } }));
      await get().triggerSync(workspaceId);
      return get().workspaceStatusById[workspaceId] === 'synced';
    } catch (error) {
      const shown = presentCloudError(error, 'workspace_enable'); logCloudDiagnostic(shown.diagnostic);
      set({ lastError: shown.message, lastDiagnostic: shown.diagnostic }); return false;
    }
  },

  moveSyncToCurrentGoogleAccount: async selectedWorkspaceIds => {
    if (CLOUD_SYNC_V2_ENABLED) {
      const connection = get().connectionByProvider.googledrive;
      if (!connection || get().isSyncing) return false;
      if (!isOnline()) {
        set(state => ({ statusByProvider: { ...state.statusByProvider, googledrive: 'offline' }, lastError: publicCloudMessage('offline') }));
        return false;
      }

      invalidateSync();
      const userId = useAuthStore.getState().user?.id ?? null;
      const assertCurrent = syncAuthority.capture(() => get().connectionByProvider.googledrive === connection
        && (useAuthStore.getState().user?.id ?? null) === userId);
      set(state => ({
        isSyncing: true,
        statusByProvider: { ...state.statusByProvider, googledrive: 'syncing' },
        lastError: null,
        lastDiagnostic: null,
        reviewItems: [],
        progress: { stage: 'preparing', completed: 0, total: 1, message: 'Preparing this Google account…' },
      }));

      const originalBindings = loadWorkspaceBindings();
      let profileSaved = false;
      let syncStarted = false;
      let originalProfile: SyncV2ProfileState | null = null;
      let localIdsForRollback: string[] = [];
      const originalBaselines = new Map<string, Awaited<ReturnType<LocalStorageSyncV2BaselineStore['loadWorkspace']>>>();
      let baselinesReset = false;
      try {
        logCloudDiagnostic({ provider: 'googledrive', stage: 'account_adoption.start', reason: 'explicit-user-action', operation: 'adopt', retryable: false });
        await v2SyncRunner.whenIdle();
        assertCurrent();
        const provider = new GoogleDriveSyncV2Provider({ assertCurrent });
        const [remoteProfile, remoteCatalog, localProfile] = await Promise.all([
          provider.readProfile(),
          provider.readCatalog(),
          getV2BaselineStore().loadProfile(),
        ]);
        originalProfile = localProfile;
        assertCurrent();
        const localIds = await localWorkspaceIds();
        localIdsForRollback = localIds;
        assertCurrent();

        const adoption = planAccountAdoption({
          connection,
          remoteProfile: remoteProfile.value,
          remoteCatalog: remoteCatalog.value,
          localProfile,
          localWorkspaceIds: localIds,
          legacyBindings: originalBindings,
        });
        logCloudDiagnostic({ provider: 'googledrive', stage: 'account_adoption.destination_checked', reason: 'destination-namespace-safe', operation: 'adopt', retryable: false });

        // V2 still honors legacy V1 bindings as an ownership guard. The pure
        // adoption plan has already validated the destination and produced
        // the complete next binding set. Commit that set in one operation so
        // reconciliation can never observe a partially moved device (or a
        // stale foreign row between workspace writes).
        const priorBindings = adoption.bindings;
        replaceWorkspaceBindings(priorBindings);
        set({ bindings: priorBindings, migrationWorkspaceIds: [] });
        logCloudDiagnostic({ provider: 'googledrive', stage: 'account_adoption.bindings_reconciled', reason: adoption.foreignWorkspaceIds.length ? 'foreign-bindings-moved' : 'bindings-already-compatible', operation: 'adopt', retryable: false });
        // The provider above is scoped to this adoption run. A fresh provider
        // is also constructed by triggerSync, so no account-bound cache is
        // carried across the ownership boundary.
        logCloudDiagnostic({ provider: 'googledrive', stage: 'account_adoption.provider_reset', reason: 'v2-provider-recreated', operation: 'adopt', retryable: false });
        // A profile from another account cannot share its baselines with the
        // destination namespace. Keep the local content, but reset only the
        // sync metadata so the new account is initialized from this device.
        if (adoption.baselineResetRequired) {
          for (const id of localIds) {
            originalBaselines.set(id, await getV2BaselineStore().loadWorkspace(id));
            await getV2BaselineStore().saveWorkspace(id, []);
          }
          baselinesReset = true;
        }
        // A null local profile is deliberately left absent until triggerSync
        // commits its remote profile and baseline together. Existing local
        // profiles are switched before the engine's account guard runs.
        if (localProfile || adoption.baselineResetRequired) {
          await getV2BaselineStore().saveProfile(adoption.profile);
          profileSaved = true;
        }
        assertCurrent();
        syncStarted = true;
        logCloudDiagnostic({ provider: 'googledrive', stage: 'account_adoption.sync_started', reason: 'adoption-committed', operation: 'sync', retryable: false });
        await get().triggerSync();
        const finalStatus = get().statusByProvider.googledrive;
        const success = finalStatus === 'synced' || finalStatus === 'synced-review';
        if (success) logCloudDiagnostic({ provider: 'googledrive', stage: 'account_adoption.success', reason: finalStatus, operation: 'adopt', retryable: false });
        else logCloudDiagnostic({ provider: 'googledrive', stage: 'account_adoption.failure', reason: get().lastDiagnostic?.reason ?? finalStatus, operation: 'adopt', retryable: Boolean(get().lastDiagnostic?.retryable) });
        return success;
      } catch (error) {
        try { assertCurrent(); } catch { return false; }
        if (!syncStarted) {
          try {
            if (profileSaved && originalProfile) await getV2BaselineStore().saveProfile(originalProfile);
            if (baselinesReset) {
              for (const [id, records] of originalBaselines) await getV2BaselineStore().saveWorkspace(id, records);
            }
            replaceWorkspaceBindings(originalBindings);
            set({ bindings: originalBindings, migrationWorkspaceIds: accountMigrationWorkspaceIds(originalBindings, localIdsForRollback, connection.accountIdentifier) });
          } catch { /* Keep the explicit failure visible if rollback storage is unavailable. */ }
        }
        const shown = presentCloudError(error, 'account-migration');
        logCloudDiagnostic({ provider: 'googledrive', stage: 'account_adoption.failure', reason: shown.diagnostic.reason, operation: 'adopt', retryable: shown.diagnostic.retryable });
        logAccountSyncFailure(shown.diagnostic);
        set(state => ({
          isSyncing: false,
          statusByProvider: { ...state.statusByProvider, googledrive: shown.status },
          lastError: shown.message,
          lastDiagnostic: shown.diagnostic,
          reviewItems: [],
          progress: null,
        }));
        return false;
      }
    }
    const connection = get().connectionByProvider.googledrive;
    if (!connection || get().isSyncing) return false;
    const localIds = await localWorkspaceIds();
    const selected = selectedWorkspaceIds ? new Set(selectedWorkspaceIds) : null;
    const candidates = accountMigrationWorkspaceIds(get().bindings, localIds, connection.accountIdentifier)
      .filter(id => !selected || selected.has(id));
    if (candidates.length === 0) return true;

    set(state => ({
      isSyncing: true, lastError: null, lastDiagnostic: null,
      statusByProvider: { ...state.statusByProvider, googledrive: 'syncing' },
      workspaceStatusById: { ...state.workspaceStatusById, ...Object.fromEntries(candidates.map(id => [id, 'syncing'])) },
      progress: { stage: 'preparing', completed: 0, total: candidates.length, message: 'Moving sync to this Google account…' },
    }));

    let bindings = get().bindings;
    const outcomes = new Map<string, WorkspaceCloudStatus>();
    let completed = 0;
    let failedStatus: CloudSyncStatus | null = null;
    let firstDiagnostic: SafeCloudDiagnostic | null = null;
    let firstMessage: string | null = null;
    let migratedAny = false;
    let stopMigration = false;

    for (const candidate of candidates) {
      try {
        const migration = await migrateWorkspaceToGoogleAccount({
          workspaceId: candidate,
          deviceId: localDeviceId(),
          provider: googleDriveProvider,
          payloadSource: localPayloadSource,
          now: Date.now(),
          onProgress: value => set({
            progress: {
              ...value,
              completed,
              total: candidates.length,
              message: `Moving workspace ${completed + 1} of ${candidates.length}… (${value.message})`,
            },
          }),
        });

        if (migration.status !== 'synced') {
          const code = migration.status === 'conflict' ? 'conflict' : 'sync';
          const shown = migration.firstError
            ? presentCloudError(entryError(migration.firstError, candidate), 'account-migration')
            : presentCloudError(new CloudOperationError(code, { workspaceId: candidate, stage: 'account-migration', operation: 'reconcile', reason: migration.status === 'conflict' ? 'migration-conflict' : 'migration-failed', retryable: false }));
          failedStatus ??= migration.status === 'conflict' ? 'conflict' : shown.status;
          firstDiagnostic ??= shown.diagnostic;
          firstMessage ??= shown.message;
          outcomes.set(candidate, migration.status === 'conflict' ? 'conflict' : 'error');
          completed += 1;
          stopMigration = migration.firstError?.errorClass === 'auth-expired';
          if (stopMigration) break;
          continue;
        }

        const previousJournal = await commitMigratedWorkspaceJournal(candidate, migration.journalEntries);
        try {
          bindings = moveWorkspaceBinding(bindingFor(candidate, connection, migration.remoteRevision, bindings));
        } catch (error) {
          await restoreWorkspaceJournalSnapshot(candidate, previousJournal);
          throw error;
        }
        deviceStates.set(candidate, { lastSeenRevision: migration.remoteRevision });
        outcomes.set(candidate, 'synced');
        migratedAny = true;
      } catch (error) {
        const shown = presentCloudError(error, 'account-migration');
        failedStatus ??= shown.status;
        firstDiagnostic ??= shown.diagnostic;
        firstMessage ??= shown.message;
        outcomes.set(candidate, 'error');
        stopMigration = shown.status === 'auth-expired';
      }
      completed += 1;
      if (stopMigration) break;
      set({ progress: { stage: 'finalizing', completed, total: candidates.length, message: `Moved ${completed} of ${candidates.length} workspaces…` } });
    }

    const remaining = accountMigrationWorkspaceIds(bindings, localIds, connection.accountIdentifier);
    const finalStatus: CloudSyncStatus = failedStatus ?? (remaining.length > 0 ? 'account-migration-required' : 'synced');
    const syncedAt = finalStatus === 'synced' ? Date.now() : null;
    const migrationMessage = remaining.length > 0 ? publicCloudMessage('account-migration-required') : null;
    const diagnostic = firstDiagnostic ?? (remaining.length > 0
      ? new CloudOperationError('account-migration-required', { workspaceId: remaining[0], stage: 'workspace-account-isolation', operation: 'migrate', reason: 'workspace-bound-to-different-account', retryable: false }).diagnostic
      : null);
    const message = firstMessage ?? migrationMessage;
    if (diagnostic && finalStatus !== 'synced') logAccountSyncFailure(diagnostic);

    set(state => ({
      bindings, migrationWorkspaceIds: remaining, isSyncing: false,
      statusByProvider: { ...state.statusByProvider, googledrive: finalStatus },
      workspaceStatusById: {
        ...state.workspaceStatusById,
        ...Object.fromEntries(outcomes),
        ...Object.fromEntries(remaining.map(id => [id, 'account-migration-required'])),
      },
      lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: syncedAt ?? state.lastSyncedByProvider.googledrive },
      lastError: message, lastDiagnostic: diagnostic,
      progress: finalStatus === 'synced' ? { stage: 'complete', completed: 1, total: 1, message: 'All changes synchronized' } : null,
    }));

    if (migratedAny) {
      const workspaceStore = await import('@/stores/workspaceStore');
      await workspaceStore.useWorkspaceStore.getState().loadWorkspaces();
    }
    return finalStatus === 'synced';
  },

  triggerSync: async workspaceId => {
    if (deviceResetInProgress) return;
    clearRetry();
    const connection = get().connectionByProvider.googledrive;
    if (!connection || get().statusByProvider.googledrive === 'connecting' || (!CLOUD_SYNC_V2_ENABLED && get().isSyncing)) return;
    if (!isOnline()) {
      set(state => ({ statusByProvider: { ...state.statusByProvider, googledrive: 'offline' }, lastError: publicCloudMessage('offline') }));
      return;
    }

    set(state => ({ isSyncing: true, statusByProvider: { ...state.statusByProvider, googledrive: 'syncing' }, lastError: null, lastDiagnostic: null, progress: { stage: 'preparing', completed: 0, total: 1, message: 'Checking cloud…' } }));

    if (CLOUD_SYNC_V2_ENABLED) {
      await v2SyncRunner.request(async () => {
      const connection = get().connectionByProvider.googledrive;
      if (!connection || get().statusByProvider.googledrive === 'connecting') return;
      const userId = useAuthStore.getState().user?.id ?? null;
      const assertCurrent = syncAuthority.capture(() => get().connectionByProvider.googledrive === connection && (useAuthStore.getState().user?.id ?? null) === userId);
      try {
      // Electron's legacy IndexedDB import runs after the UI appears. Join
      // that one in-flight run before enumerating local workspaces so Sync now
      // cannot race a partially reconstructed workspace tree.
      set({ progress: { stage: 'preparing', completed: 0, total: 1, message: 'Preparing local workspaces…' } });
      await migrateFromDexieToFs();
      assertCurrent();
      // V2 has its own profile, but existing V1 account ownership is still
      // authoritative. Never silently migrate an already-bound workspace.
      const ownedIds = await localWorkspaceIds();
      assertCurrent();
      const priorBindings = loadWorkspaceBindings();
      const foreignIds = ownedIds.filter(id => {
        const rows = priorBindings.filter(binding => binding.workspaceId === id);
        return rows.length > 0 && !rows.some(binding => binding.providerAccountId === connection.accountIdentifier
          || Boolean(connection.email && binding.providerAccountId.toLowerCase() === connection.email.toLowerCase()));
      });
      if (foreignIds.length) throw new CloudOperationError('account-migration-required', { stage: 'workspace-account-isolation', reason: 'workspace-bound-to-different-account', workspaceId: foreignIds[0], retryable: false });
      const isElectron = typeof window !== 'undefined' && Boolean(window.panvas);
      const v2 = await runCloudSyncV2({
        accountIdentifier: connection.accountIdentifier,
        provider: new GoogleDriveSyncV2Provider({ assertCurrent }),
        source: syncV2LocalSource,
        adapter: syncV2LocalAdapter,
        baselines: getV2BaselineStore(),
        conflictStore: dexieSyncV2ConflictStore,
        environment: isElectron ? 'desktop' : 'web',
        legacyMigrator: isElectron ? async () => {
          return inspectAndMigrateLegacyPanvasRoot({
            accountIdentifier: connection.accountIdentifier,
            localWorkspaceIds: ownedIds,
            canonicalProvider: new GoogleDriveSyncV2Provider({ assertCurrent }),
            legacyDriveProvider: googleDriveProvider,
            assertCurrent,
            onProgress: message => {
              assertCurrent();
              set({ progress: { stage: 'preparing', completed: 0, total: 1, message } });
            },
          });
        } : undefined,
        resolutions: [...pendingV2ConflictResolutions.entries()].map(([key, resolution]) => {
          const [workspaceId, kind, ...idParts] = key.split(':');
          return { workspaceId, kind: kind as SyncV2ConflictResolution['kind'], id: idParts.join(':'), choice: resolution };
        }),
        assertCurrent,
        onProgress: message => { assertCurrent(); set({ progress: { stage: message.startsWith('Uploading') ? 'uploading' : message.startsWith('Downloading') ? 'downloading' : message === 'Up to date' ? 'complete' : 'preparing', completed: message === 'Up to date' ? 1 : 0, total: 1, message } }); },
      });
      const localIds = await localWorkspaceIds();
      assertCurrent();
      const rerunPending = v2SyncRunner.hasPending;
      const finalStatus: CloudSyncStatus = v2.status === 'synced' ? 'synced' : v2.status === 'synced-review' ? 'synced-review' : v2.status === 'conflict' ? 'conflict' : v2.errorCode ? presentCloudError(new CloudOperationError(v2.errorCode, v2.diagnostic ?? { stage: 'sync-v2', reason: 'sync-failed' })).status : 'error';
      const status: CloudSyncStatus = rerunPending ? 'syncing' : finalStatus;
      const workspaceOutcomes = v2.workspaceOutcomes ?? [];
      const outcomeById = new Map(workspaceOutcomes.map(outcome => [outcome.workspaceId, outcome]));
      const knownWorkspaceIds = [...new Set([...localIds, ...workspaceOutcomes.map(outcome => outcome.workspaceId)])];
      const workspaceStatus = (id: string): WorkspaceCloudStatus => {
        const outcome = outcomeById.get(id);
        if (outcome?.classification === 'conflict' || outcome?.status === 'conflict') return 'conflict';
        if (outcome?.classification === 'orphaned' || outcome?.classification === 'ambiguous') return 'synced-review';
        if (outcome?.status === 'synced' || outcome?.status === 'synced-review') return outcome.status;
        if (status === 'syncing' || status === 'offline' || status === 'auth-expired' || status === 'rate-limited' || status === 'conflict' || status === 'synced-review' || status === 'synced') return status;
        return 'error';
      };
      // Keep compatibility with the narrow synthetic/legacy runner contract;
      // the real V2 engine always supplies per-workspace outcomes.
      const successfulWorkspaceIds = workspaceOutcomes.length > 0
        ? workspaceOutcomes.filter(outcome => outcome.status === 'synced' || outcome.status === 'synced-review').map(outcome => outcome.workspaceId)
        : (finalStatus === 'synced' || finalStatus === 'synced-review' ? localIds : []);
      const syncedAt = !rerunPending && successfulWorkspaceIds.length > 0 && (finalStatus === 'synced' || finalStatus === 'synced-review') ? Date.now() : null;
      const publicMessage = v2.errorCode ? publicCloudMessage(v2.errorCode) : finalStatus === 'synced-review' ? publicCloudMessage('review') : finalStatus === 'synced' ? null : publicCloudMessage(finalStatus === 'conflict' ? 'conflict' : 'sync');
      const conflictReviewItems = (v2.conflicts ?? []).map(conflict => ({
        conflictId: `sync-conflict:${conflict.workspaceId}:${conflict.kind}:${conflict.id}`,
        workspaceId: conflict.workspaceId,
        entityKind: conflict.kind,
        entityId: conflict.id,
      }));
      if (conflictReviewItems.length > 0) {
        const profile = await getV2BaselineStore().loadProfile();
        const profileId = profile?.profileId || connection.accountIdentifier;
        for (const item of conflictReviewItems) {
          await dexieSyncV2ConflictStore.preserve({
            conflictId: item.conflictId,
            profileId,
            workspaceId: item.workspaceId,
            entityKind: item.entityKind,
            entityId: item.entityId,
            parentId: null,
            localHash: '',
            remoteHash: '',
            localBytes: new Uint8Array(),
            createdAt: Date.now(),
            resolvedAt: null,
          });
        }
      }
      if (v2.diagnostic && finalStatus !== 'synced' && finalStatus !== 'synced-review') logAccountSyncFailure(v2.diagnostic);
      if (syncedAt) {
        retryAttempts = 0;
        lastSuccess(connection, syncedAt);
        pendingV2ConflictResolutions.clear();
        const profile = await getV2BaselineStore().loadProfile();
        const unresolved = await dexieSyncV2ConflictStore.listUnresolved?.(profile?.profileId);
        if (unresolved) {
          for (const item of unresolved) {
            if (item.conflictId.startsWith('sync-conflict:')) {
              await dexieSyncV2ConflictStore.resolve?.(item.conflictId, item.profileId);
            }
          }
        }
      }
      else if (!rerunPending && finalStatus !== 'auth-expired' && finalStatus !== 'account-migration-required') scheduleRetry(v2.diagnostic);
      set(state => ({
        isSyncing: rerunPending,
        statusByProvider: { ...state.statusByProvider, googledrive: status },
        workspaceStatusById: { ...state.workspaceStatusById, ...Object.fromEntries(knownWorkspaceIds.map(id => [id, workspaceStatus(id)])) },
        lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: syncedAt ?? state.lastSyncedByProvider.googledrive },
        lastSyncedByWorkspaceId: { ...state.lastSyncedByWorkspaceId, ...Object.fromEntries(knownWorkspaceIds.map(id => [id, outcomeById.get(id)?.status === 'synced' || outcomeById.get(id)?.status === 'synced-review' ? syncedAt ?? state.lastSyncedByWorkspaceId[id] ?? null : state.lastSyncedByWorkspaceId[id] ?? null])) },
        lastError: rerunPending ? null : publicMessage,
        lastDiagnostic: rerunPending ? null : v2.diagnostic ?? null,
        workspaceRecoveryIssues: rerunPending ? [] : workspaceOutcomes.filter(outcome => outcome.classification === 'orphaned' || outcome.classification === 'ambiguous'),
        // Entity conflicts belong only to this run's eligible workspaces.
        // Retaining previous ephemeral rows made quarantined workspaces still
        // appear to offer conflict actions after their roots were rejected.
        reviewItems: conflictReviewItems,
        progress: rerunPending ? { stage: 'preparing', completed: 0, total: 1, message: 'Checking cloud...' } : finalStatus === 'synced' || finalStatus === 'synced-review' ? { stage: 'complete', completed: 1, total: 1, message: finalStatus === 'synced-review' ? 'Synced - changes need review' : 'Up to date' } : null,
        migrationWorkspaceIds: [],
      }));
      if (v2.downloaded > 0) {
        await refreshWorkspaceProjectionAfterSync();
      }
      } catch (error) {
        try { assertCurrent(); } catch { return; }
        const shown = presentCloudError(error, 'sync-v2');
        const rerunPending = v2SyncRunner.hasPending;
        logAccountSyncFailure(shown.diagnostic);
        if (!rerunPending && shown.status !== 'auth-expired' && shown.status !== 'account-migration-required') scheduleRetry(shown.diagnostic);
        set(state => ({
          isSyncing: rerunPending,
          statusByProvider: { ...state.statusByProvider, googledrive: rerunPending ? 'syncing' : shown.status },
          lastError: rerunPending ? null : shown.message,
         lastDiagnostic: rerunPending ? null : shown.diagnostic,
         workspaceRecoveryIssues: rerunPending ? state.workspaceRecoveryIssues : [],
          progress: rerunPending ? { stage: 'preparing', completed: 0, total: 1, message: 'Checking cloud...' } : null,
        }));
      }
      });
      return;
    }

    await v2SyncRunner.request(async () => {
    const userId = useAuthStore.getState().user?.id ?? null;
    const assertCurrent = syncAuthority.capture(() => get().connectionByProvider.googledrive === connection && (useAuthStore.getState().user?.id ?? null) === userId);
    const providerForRun = guardSyncCalls(new GoogleDriveSyncProvider({ assertCurrent }), assertCurrent);
    const sourceForRun = guardSyncCalls(localPayloadSource, assertCurrent);
    const journalForRun = guardSyncCalls(dexieSyncJournalStore, assertCurrent);
    const adapterForRun = guardSyncCalls(defaultRemoteRecordLocalAdapter, assertCurrent);
    let diagnosticWorkspaceId = workspaceId;
    try {
      sourceForRun.beginCycle();
      let localIds = await localWorkspaceIds();
      assertCurrent();
      let bindings = reconcileWorkspaceBindings(connection.accountIdentifier, localIds, undefined, Date.now(), connection.email ? [connection.email] : []);
      const replicatedWorkspaceIds = new Set<string>();

      // Auto-bind all normal local workspaces for this account
      for (const localId of localIds) {
        if (localId !== 'default' && !workspaceHasBinding(bindings, localId)) {
          bindings = saveWorkspaceBinding(bindingFor(localId, connection, 0, bindings));
        }
      }

      // Automatically discover remote workspaces and auto-replicate any that are missing locally on this device
      let newReplicasCreated = false;
      if (providerForRun.listRemoteWorkspaces) {
        try {
          set({ progress: { stage: 'preparing', completed: 0, total: 1, message: 'Checking cloud...' } });
          const remoteList = await providerForRun.listRemoteWorkspaces();
          set({ remoteWorkspaces: remoteList });
          const replicas = await replicateMissingRemoteWorkspaces({
            remoteWorkspaces: remoteList,
            localWorkspaceIds: localIds,
            provider: providerForRun,
            journalStore: journalForRun,
            payloadSource: sourceForRun,
            localAdapter: adapterForRun,
            onWorkspace: (completed, total, remoteWorkspaceId) => {
              diagnosticWorkspaceId = remoteWorkspaceId;
              set({ progress: { stage: 'downloading', completed: completed - 1, total, message: `Syncing workspace ${completed} of ${total}...` } });
            },
            onRecordProgress: (workspaceNumber, workspaceTotal, completed, total, remoteWorkspaceId) => {
              diagnosticWorkspaceId = remoteWorkspaceId;
              set({ progress: { stage: 'downloading', completed, total, message: `Syncing workspace ${workspaceNumber} of ${workspaceTotal}... Downloading changes ${completed} of ${total}...` } });
            },
          });
          for (const replica of replicas) {
            bindings = saveWorkspaceBinding(bindingFor(replica.workspaceId, connection, replica.remoteRevision, bindings));
            deviceStates.set(replica.workspaceId, { lastSeenRevision: replica.remoteRevision });
            replicatedWorkspaceIds.add(replica.workspaceId);
            newReplicasCreated = true;
          }
        } catch (error) { throw error; }
      }

      if (newReplicasCreated) {
        localIds = await localWorkspaceIds();
        const workspaceStore = await import('@/stores/workspaceStore');
        await workspaceStore.useWorkspaceStore.getState().loadWorkspaces();
      }

      const migrationWorkspaceIds = accountMigrationWorkspaceIds(bindings, localIds, connection.accountIdentifier);
      const allBound = attachedWorkspaceIds(bindings, connection.accountIdentifier, localIds);
      const workspaceIds = (workspaceId ? (allBound.includes(workspaceId) ? [workspaceId] : []) : allBound)
        .filter(id => !replicatedWorkspaceIds.has(id));
      const workspaceOutcomes = new Map<string, WorkspaceCloudStatus>([...replicatedWorkspaceIds].map(id => [id, 'synced']));
      for (const id of migrationWorkspaceIds) workspaceOutcomes.set(id, 'account-migration-required');

      if (workspaceIds.length === 0) {
        if (migrationWorkspaceIds.length > 0) {
          const shown = presentCloudError(new CloudOperationError('account-migration-required', {
            workspaceId: migrationWorkspaceIds[0], stage: 'workspace-account-isolation', operation: 'discover',
            reason: 'workspace-bound-to-different-account', retryable: false,
          }));
          logAccountSyncFailure(shown.diagnostic);
          set(state => ({
            bindings, migrationWorkspaceIds, isSyncing: false,
            statusByProvider: { ...state.statusByProvider, googledrive: 'account-migration-required' },
            workspaceStatusById: { ...state.workspaceStatusById, ...Object.fromEntries(workspaceOutcomes) },
            lastError: shown.message, lastDiagnostic: shown.diagnostic, progress: null,
          }));
          return;
        }
        const syncedAt = Date.now();
        set(state => ({ bindings, migrationWorkspaceIds: [], isSyncing: false, statusByProvider: { ...state.statusByProvider, googledrive: 'synced' }, workspaceStatusById: { ...state.workspaceStatusById, ...Object.fromEntries(workspaceOutcomes) }, lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: syncedAt }, lastError: null, progress: { stage: 'complete', completed: 1, total: 1, message: 'Up to date' } }));
        return;
      }

      set(state => ({ bindings, workspaceStatusById: { ...state.workspaceStatusById, ...Object.fromEntries(workspaceIds.map(id => [id, 'syncing'])) } }));

      const metrics = emptyMetrics(); let errors = 0, conflicts = 0; let firstError: SyncEntryError | null = null; let firstErrorWorkspaceId: string | undefined;
      let firstConflict: { workspaceId: string; entityId: string; reason: string } | null = null;

      for (let idx = 0; idx < workspaceIds.length; idx++) {
        assertCurrent();
        const activeWorkspaceId = workspaceIds[idx];
        diagnosticWorkspaceId = activeWorkspaceId;
        const progressPrefix = workspaceIds.length > 1 ? `Syncing workspace ${idx + 1} of ${workspaceIds.length}...` : undefined;
        const priorBinding = bindings.find(item => item.workspaceId === activeWorkspaceId && item.providerAccountId === connection.accountIdentifier);
        const deviceState = deviceStates.get(activeWorkspaceId) ?? { lastSeenRevision: priorBinding?.lastKnownRemoteRevision ?? 0 };
        deviceStates.set(activeWorkspaceId, deviceState);
        await recoverStaleJournalMetadata(activeWorkspaceId);
        assertCurrent();

        const result = await runSyncCycle({
          workspaceId: activeWorkspaceId,
          deviceId: localDeviceId(),
          journalStore: journalForRun,
          provider: providerForRun,
          payloadSource: sourceForRun,
          deviceState,
          now: Date.now(),
          objectConcurrency: 4,
          onProgress: val => { assertCurrent(); set({ progress: progressPrefix ? { ...val, message: `${progressPrefix} (${val.message})` } : val }); },
        });

        metrics.localEntitiesScanned += result.localEntitiesScanned; metrics.payloadsLoaded += result.payloadsLoaded; metrics.objectsUploaded += result.objectsUploaded; metrics.objectsAlreadyPresent += result.objectsAlreadyPresent; metrics.manifestEntries += result.manifestEntries; metrics.journalEntriesProcessed += result.journalEntriesProcessed; metrics.conflictsCreated += result.conflictsCreated; metrics.bytesUploaded += result.bytesUploaded; metrics.largeAssets += result.largeAssets; metrics.totalGoogleRequests += result.providerRequests.requests; metrics.retries += result.providerRequests.retries; metrics.backoffMs += result.providerRequests.backoffMs; metrics.timeouts += result.providerRequests.timeouts; metrics.totalDurationMs += result.stageTimingsMs.total; metrics.manifestReadMs += result.stageTimingsMs.manifestRead; metrics.manifestWriteMs += result.stageTimingsMs.manifestWrite; metrics.manifestReadBackMs += result.stageTimingsMs.manifestReadBack; metrics.hashingAndLoadMs += result.stageTimingsMs.payloadLoadAndHash; metrics.objectTransferMs += result.stageTimingsMs.objectTransfer;

        let applyErrors = 0;
        let applyFirstError: SyncEntryError | undefined;

        if (result.recordsForDownload.length) {
          const applied = await applyRemoteChanges({
            workspaceId: activeWorkspaceId,
            records: result.recordsForDownload,
            provider: providerForRun,
            journalStore: journalForRun,
            localAdapter: adapterForRun,
            onProgress: (completed, total) => set({ progress: { stage: 'downloading', completed, total, message: `Downloading changes ${completed} of ${total}...` } }),
          });
          metrics.remoteObjectsDownloaded += applied.applied;
          applyErrors = applied.errors;
          applyFirstError = applied.firstError;
        }

        // Remote application can acknowledge journal rows after runSyncCycle
        // returns. Derive the account result from the post-apply journal, so a
        // resolved stale row cannot leave the card red while the header goes
        // green. Non-journal transport/apply failures remain counted.
        const unresolvedAfterApply = await journalForRun.listUnresolved!(activeWorkspaceId);
        const unresolvedErrorsAfterApply = unresolvedAfterApply.filter(entry => entry.state !== 'conflict');
        const intrinsicErrors = result.errors.filter(error => error.stage !== 'retry-backoff');
        const workspaceErrors = Math.max(intrinsicErrors.length + applyErrors, unresolvedErrorsAfterApply.length);
        errors += workspaceErrors;
        conflicts += result.conflicts.length;
        const currentError = intrinsicErrors[0] ?? applyFirstError ?? (unresolvedAfterApply.length > 0 ? result.errors[0] : undefined);
        if (!firstError && currentError) { firstError = currentError; firstErrorWorkspaceId = activeWorkspaceId; }
        if (!firstConflict && result.conflicts[0]) firstConflict = { workspaceId: activeWorkspaceId, ...result.conflicts[0] };
        const outcome: WorkspaceCloudStatus = result.conflicts.length ? 'conflict' : workspaceErrors ? 'error' : 'synced';
        workspaceOutcomes.set(activeWorkspaceId, outcome);
        if (outcome === 'synced') bindings = saveWorkspaceBinding(bindingFor(activeWorkspaceId, connection, deviceState.lastSeenRevision, bindings));
      }

      const finalized = finalizeAccountSync(errors, conflicts, firstError, Date.now(), migrationWorkspaceIds.length);
      assertCurrent();
      const finalStatus = finalized.status;
      const syncedAt = finalized.lastSyncedAt;
      const shown = firstError
        ? presentCloudError(entryError(firstError, firstErrorWorkspaceId ?? diagnosticWorkspaceId ?? firstError.entityId), firstError.stage)
        : errors
          ? presentCloudError(new CloudOperationError('sync', { workspaceId: diagnosticWorkspaceId, stage: 'sync-cycle', operation: 'sync', reason: 'unresolved-entries', retryable: false }))
            : firstConflict
              ? presentCloudError(new CloudOperationError('conflict', { workspaceId: firstConflict.workspaceId, stage: 'conflict-resolution', operation: 'sync', reason: firstConflict.reason, entityId: firstConflict.entityId, retryable: false }))
              : finalStatus === 'account-migration-required'
                ? presentCloudError(new CloudOperationError('account-migration-required', { workspaceId: migrationWorkspaceIds[0], stage: 'workspace-account-isolation', operation: 'discover', reason: 'workspace-bound-to-different-account', retryable: false }))
                : null;
      if (shown) logAccountSyncFailure(shown.diagnostic);
      if (syncedAt) { retryAttempts = 0; lastSuccess(connection, syncedAt); } else scheduleRetry(shown?.diagnostic);
      if ((import.meta as any).env?.DEV) console.info('[CloudSync metrics]', metrics);

      set(state => ({
        bindings, migrationWorkspaceIds,
        isSyncing: false,
        statusByProvider: { ...state.statusByProvider, googledrive: finalStatus },
        workspaceStatusById: mergeWorkspaceCloudStatuses(state.workspaceStatusById, workspaceOutcomes),
        lastSyncedByWorkspaceId: { ...state.lastSyncedByWorkspaceId, ...Object.fromEntries([...workspaceOutcomes].filter(([, status]) => status === 'synced').map(([id]) => [id, syncedAt])) },
        lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: syncedAt ?? state.lastSyncedByProvider.googledrive },
        lastError: shown?.message ?? null,
        lastDiagnostic: shown?.diagnostic ?? null,
        lastMetrics: metrics,
        progress: finalStatus === 'synced' ? { stage: 'complete', completed: 1, total: 1, message: metrics.objectsUploaded ? 'All changes synchronized' : 'Up to date' } : null,
      }));
    } catch (error) {
      try { assertCurrent(); } catch { return; }
      const base = presentCloudError(error, 'sync-cycle');
      const shown = diagnosticWorkspaceId && !base.diagnostic.workspaceId
        ? presentCloudError(new CloudOperationError(base.code, { ...base.diagnostic, workspaceId: diagnosticWorkspaceId, operation: base.diagnostic.operation ?? 'sync' }), base.diagnostic.stage)
        : base;
      logAccountSyncFailure(shown.diagnostic);
      scheduleRetry(shown.diagnostic);
      set(state => ({ isSyncing: false, statusByProvider: { ...state.statusByProvider, googledrive: shown.status }, lastError: shown.message, lastDiagnostic: shown.diagnostic, progress: null }));
    } finally { localPayloadSource.endCycle(); }
    });
  },

  resetThisDevice: async (): Promise<boolean> => {
    if (deviceResetInProgress) return false;
    const connection = get().connectionByProvider.googledrive;
    if (!connection) return false;
    deviceResetInProgress = true;
    clearRetry();
    // Invalidate the active run before waiting for its single-flight promise.
    // Every guarded provider/local call then stops at its next boundary, and
    // no queued auto-sync can start while the reset gate is held.
    syncAuthority.invalidate();
    v2SyncRunner.cancelPending();
    const userId = useAuthStore.getState().user?.id ?? null;
    set(state => ({
      isResetting: true,
      isSyncing: true,
      statusByProvider: { ...state.statusByProvider, googledrive: 'syncing' },
      lastError: null,
      lastDiagnostic: null,
      progress: { stage: 'preparing', completed: 0, total: 1, message: 'Validating remote data…' },
      lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: null },
      lastSyncedByWorkspaceId: {},
      workspaceStatusById: {},
      reviewItems: [],
      workspaceRecoveryIssues: [],
      migrationWorkspaceIds: [],
    }));
    clearLastSuccess(connection);
    try {
      await v2SyncRunner.whenIdle();
      // If the first Electron migration has not completed yet, join it before
      // deletion. This prevents a deferred legacy import from repopulating a
      // freshly-reset filesystem after the reset gate is released.
      // Step 1: Pre-validate remote snapshot from canonical storage before touching local data
      const provider = new GoogleDriveSyncV2Provider();
      const [profileRead, catalogRead] = await Promise.all([provider.readProfile(), provider.readCatalog()]);
      const catalog = catalogRead.value;
      if (!catalog || !Array.isArray(catalog.workspaces) || catalog.workspaces.length === 0) {
        throw new CloudOperationError('sync', {
          stage: 'device-reset-validation',
          reason: 'remote-catalog-empty',
          operation: 'validate-remote',
          errorMessage: 'Cannot reset this device: remote Google Drive storage has no synced workspaces.',
          retryable: false,
        });
      }
      for (const entry of catalog.workspaces) {
        if (!entry.workspaceId || !entry.workspaceId.startsWith('ws-')) {
          throw new CloudOperationError('sync', {
            stage: 'device-reset-validation',
            reason: 'invalid-workspace-id',
            operation: 'validate-remote',
            errorMessage: 'Cannot reset this device: remote storage contains invalid workspace data.',
            retryable: false,
          });
        }
        const manifestRead = await provider.readManifest(entry.workspaceId);
        if (!manifestRead.value || manifestRead.value.workspaceId !== entry.workspaceId) {
          throw new CloudOperationError('sync', {
            stage: 'device-reset-validation',
            reason: 'remote-manifest-missing',
            operation: 'validate-remote',
            errorMessage: `Cannot reset this device: remote manifest for workspace ${entry.workspaceId} could not be validated.`,
            retryable: false,
          });
        }
      }

      // Step 2: Validation succeeded! Only now is local data cleared
      clearLastSuccess(connection);
      set({ progress: { stage: 'preparing', completed: 0, total: 1, message: 'Resetting local data…' } });
      if (typeof window !== 'undefined' && window.panvas) {
        await migrateFromDexieToFs();
        try { localStorage.setItem('panvas.dexieMigration.canonicalDestinations.v1', 'true'); } catch { /* optional marker */ }
        await window.panvas.cloudsync.resetLocalData();
      } else {
        await resetBrowserLocalData(userId);
      }
      pendingV2ConflictResolutions.clear();
      deviceStates.clear();
      if (dexieSyncV2ConflictStore.clear) await dexieSyncV2ConflictStore.clear();
      set({ progress: { stage: 'preparing', completed: 0, total: 1, message: 'Downloading your Google Drive work…' } });
    } catch (error) {
      const shown = presentCloudError(error, 'device-reset');
      const userMessage = (error as any)?.diagnostic?.errorMessage || shown.message;
      set(state => ({
        isResetting: false,
        isSyncing: false,
        statusByProvider: { ...state.statusByProvider, googledrive: 'error' },
        lastError: userMessage,
        lastDiagnostic: shown.diagnostic,
        progress: null,
      }));
      logAccountSyncFailure(shown.diagnostic);
      deviceResetInProgress = false;
      return false;
    }

    // Release the reset gate only after all local stores/files are gone. The
    // immediate normal V2 run now sees an empty replica and either downloads
    // the verified cloud roots or leaves the device empty when the cloud is
    // empty; it never creates a bootstrap shell first.
    // Step 3: Trigger sync to pull and apply verified remote snapshot
    deviceResetInProgress = false;
    set({ isResetting: false, isSyncing: false });
    await get().triggerSync();
    const final: CloudSyncState = get();
    const terminal = final.statusByProvider.googledrive === 'synced' || final.statusByProvider.googledrive === 'synced-review';
    if (terminal) {
      completeDeviceResetHydration();
      // An empty remote account still represents a successful reset/sync run;
      // keep the last-run indicator truthful even when no workspace outcome
      // supplied a timestamp.
      if (!get().lastSyncedByProvider.googledrive) {
        const syncedAt = Date.now();
        lastSuccess(connection, syncedAt);
        set(state => ({ lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: syncedAt }, progress: { stage: 'complete', completed: 1, total: 1, message: 'Up to date' } }));
      }
      await refreshWorkspaceProjectionAfterSync();
    }
    return terminal;
  },
}));

useAuthStore.subscribe((state, previous) => {
  if ((state.user?.id ?? null) === (previous.user?.id ?? null)) return;
  invalidateSync(); deviceStates.clear();
  useCloudSyncStore.setState(current => ({
    isSyncing: false, progress: null, lastError: null, lastDiagnostic: null,
    workspaceStatusById: {}, lastSyncedByWorkspaceId: {}, remoteWorkspaces: [],
    lastSyncedByProvider: { ...current.lastSyncedByProvider, googledrive: null },
    statusByProvider: { ...current.statusByProvider, googledrive: current.connectionByProvider.googledrive ? 'connected' : 'disconnected' },
  }));
});

export function scheduleAutoCloudSync(): void {
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => { const state = useCloudSyncStore.getState(); if (state.autoSync && state.connectionByProvider.googledrive) void state.triggerSync(); }, 8_000);
}
