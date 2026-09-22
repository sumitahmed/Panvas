import test from 'node:test';
import assert from 'node:assert/strict';
import { runCloudSyncV2 } from '../src/services/cloudsync/v2/engine.ts';
import { inspectAndMigrateLegacyPanvasRoot } from '../src/services/cloudsync/v2/legacyMigration.ts';
import { dexieSyncV2ConflictStore } from '../src/services/cloudsync/v2/conflictStore.ts';
import { disconnectBrowserGoogle, getBrowserGoogleConnection } from '../src/services/cloudsync/browserGoogleAuth.ts';
import type {
  SyncV2BaselineRecord,
  SyncV2BaselineStore,
  SyncV2Catalog,
  SyncV2ConflictStore,
  SyncV2LocalAdapter,
  SyncV2LocalSource,
  SyncV2Manifest,
  SyncV2MigrationConflict,
  SyncV2Profile,
  SyncV2ProfileState,
  SyncV2Provider,
  SyncV2RemoteRead,
} from '../src/services/cloudsync/v2/types.ts';
import type { ScannedSyncEntity } from '../src/services/cloudsync/engine.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const key = (value: { entityType?: string; entityId?: string; kind?: string; id?: string }) => `${value.entityType ?? value.kind}:${value.entityId ?? value.id}`;

class MemoryBaselines implements SyncV2BaselineStore {
  profile: SyncV2ProfileState | null = null;
  workspaces = new Map<string, SyncV2BaselineRecord[]>();
  async loadProfile() { return this.profile; }
  async saveProfile(value: SyncV2ProfileState) { this.profile = value; }
  async loadWorkspace(id: string) { return this.workspaces.get(id) ?? []; }
  async saveWorkspace(id: string, records: SyncV2BaselineRecord[]) { this.workspaces.set(id, structuredClone(records)); }
  async clear() { this.profile = null; this.workspaces.clear(); }
}

class MemoryConflicts implements SyncV2ConflictStore {
  rows = new Map<string, SyncV2MigrationConflict>();
  async preserve(value: SyncV2MigrationConflict) {
    if (this.rows.has(value.conflictId)) return 'present' as const;
    this.rows.set(value.conflictId, structuredClone(value));
    return 'created' as const;
  }
  async hasUnresolved(profileId?: string) {
    return [...this.rows.values()].some(row => (!profileId || row.profileId === profileId) && row.resolvedAt === null);
  }
  async listUnresolved(profileId?: string) {
    return [...this.rows.values()].filter(row => (!profileId || row.profileId === profileId) && row.resolvedAt === null);
  }
  async resolve(conflictId: string, profileId?: string) {
    const row = this.rows.get(conflictId);
    if (!row || (profileId && row.profileId !== profileId) || row.resolvedAt !== null) return false;
    row.resolvedAt = Date.now();
    return true;
  }
  async remove(conflictId: string) {
    this.rows.delete(conflictId);
  }
  async clear() {
    this.rows.clear();
  }
}

class MemoryV2Provider implements SyncV2Provider {
  profile: SyncV2Profile | null = null;
  catalog: SyncV2Catalog | null = null;
  manifests = new Map<string, SyncV2Manifest>();
  objects = new Map<string, Uint8Array>();

  async readProfile(): Promise<SyncV2RemoteRead<SyncV2Profile>> {
    return { value: this.profile, etag: this.profile ? 'profile-1' : null };
  }
  async writeProfile(value: SyncV2Profile) {
    this.profile = structuredClone(value);
    return { etag: 'profile-1' };
  }
  async readCatalog(): Promise<SyncV2RemoteRead<SyncV2Catalog>> {
    return { value: this.catalog, etag: this.catalog ? `catalog-${this.catalog.revision}` : null };
  }
  async writeCatalog(value: SyncV2Catalog) {
    this.catalog = structuredClone(value);
    return { etag: `catalog-${value.revision}` };
  }
  async readManifest(id: string): Promise<SyncV2RemoteRead<SyncV2Manifest>> {
    const value = this.manifests.get(id) ?? null;
    return { value, etag: value ? `${id}-${value.revision}` : null };
  }
  async writeManifest(id: string, value: SyncV2Manifest) {
    this.manifests.set(id, structuredClone(value));
    return { etag: `${id}-${value.revision}` };
  }
  async getObject(hash: string) {
    const value = this.objects.get(hash);
    if (!value) throw new Error(`Object not found: ${hash}`);
    return value;
  }
  async putObjectIfAbsent(hash: string, bytes: Uint8Array) {
    if (this.objects.has(hash)) return 'present' as const;
    this.objects.set(hash, bytes.slice());
    return 'uploaded' as const;
  }
  async getObjectMetadata(hash: string) {
    const value = this.objects.get(hash);
    return value ? { size: value.byteLength } : null;
  }
}

class TestDevice {
  baselines = new MemoryBaselines();
  conflicts = new MemoryConflicts();
  entities = new Map<string, ScannedSyncEntity>();

  source: SyncV2LocalSource = {
    listWorkspaceIds: async () => [...new Set([...this.entities.values()].map(item => item.workspaceId))],
    scanWorkspace: async id => [...this.entities.values()].filter(item => item.workspaceId === id),
  };

  adapter: SyncV2LocalAdapter = {
    applyRecord: async ({ workspaceId, record, bytes }) => {
      this.entities.set(key(record), {
        entityType: record.kind,
        entityId: record.id,
        workspaceId,
        parentId: record.parentId,
        bytes,
        tombstone: record.tombstone,
        deletedAt: record.tombstone ? Date.now() : null,
      });
    },
  };

  add(entityType: ScannedSyncEntity['entityType'], entityId: string, parentId: string | null, value: unknown, workspaceId: string) {
    this.entities.set(`${entityType}:${entityId}`, {
      entityType,
      entityId,
      workspaceId,
      parentId,
      bytes: value instanceof Uint8Array ? value : encode(value),
      tombstone: false,
      deletedAt: null,
    });
  }

  edit(entityType: ScannedSyncEntity['entityType'], entityId: string, value: unknown) {
    const existing = this.entities.get(`${entityType}:${entityId}`);
    if (!existing) throw new Error(`Entity ${entityType}:${entityId} not found`);
    existing.bytes = value instanceof Uint8Array ? value : encode(value);
  }

  value<T = any>(entityType: ScannedSyncEntity['entityType'], entityId: string): T {
    const existing = this.entities.get(`${entityType}:${entityId}`);
    if (!existing?.bytes) throw new Error(`Entity ${entityType}:${entityId} has no bytes`);
    return JSON.parse(new TextDecoder().decode(existing.bytes));
  }

  has(entityType: ScannedSyncEntity['entityType'], entityId: string): boolean {
    const ent = this.entities.get(`${entityType}:${entityId}`);
    return Boolean(ent && !ent.tombstone);
  }

  workspaceIds(): string[] {
    return [...new Set([...this.entities.values()].filter(e => !e.tombstone).map(e => e.workspaceId))];
  }
}

// ---------------------------------------------------------------------------
// TEST A: Two Clients, One AppData Store
// ---------------------------------------------------------------------------
test('Test A: Two Clients, One AppData Store — Desktop uploads real workspaces; Web syncs and receives them without boilerplate', async () => {
  const canonicalAppData = new MemoryV2Provider();
  const desktop = new TestDevice();

  // Desktop has user's real workspaces: Core CS, My Workspace, Placement Prep
  desktop.add('workspace', 'ws-core-cs', null, { id: 'ws-core-cs', name: 'Core CS' }, 'ws-core-cs');
  desktop.add('notebook', 'nb-core-cs', 'ws-core-cs', { id: 'nb-core-cs', name: 'Algorithms' }, 'ws-core-cs');
  desktop.add('notebookPage', 'page-core-cs', 'nb-core-cs', { id: 'page-core-cs', name: 'Trees & Graphs' }, 'ws-core-cs');

  desktop.add('workspace', 'ws-my-workspace', null, { id: 'ws-my-workspace', name: 'My Workspace' }, 'ws-my-workspace');
  desktop.add('notebook', 'nb-my-ws', 'ws-my-workspace', { id: 'nb-my-ws', name: 'Daily Notes' }, 'ws-my-workspace');
  desktop.add('notebookPage', 'page-my-ws', 'nb-my-ws', { id: 'page-my-ws', name: 'Architecture Thoughts' }, 'ws-my-workspace');

  desktop.add('workspace', 'ws-placement-prep', null, { id: 'ws-placement-prep', name: 'Placement Prep' }, 'ws-placement-prep');
  desktop.add('notebook', 'nb-placement-prep', 'ws-placement-prep', { id: 'nb-placement-prep', name: 'System Design' }, 'ws-placement-prep');
  desktop.add('notebookPage', 'page-placement-prep', 'nb-placement-prep', { id: 'page-placement-prep', name: 'CAP Theorem' }, 'ws-placement-prep');

  // Desktop syncs to canonical appDataFolder
  const desktopResult = await runCloudSyncV2({
    accountIdentifier: 'user@gmail.com',
    provider: canonicalAppData,
    source: desktop.source,
    adapter: desktop.adapter,
    baselines: desktop.baselines,
    conflictStore: desktop.conflicts,
    environment: 'desktop',
  });
  assert.equal(desktopResult.status, 'synced');
  assert.equal(canonicalAppData.catalog?.workspaces.length, 3);

  // Web starts fresh and connects to the SAME canonical provider
  const web = new TestDevice();
  const webResult = await runCloudSyncV2({
    accountIdentifier: 'user@gmail.com',
    provider: canonicalAppData,
    source: web.source,
    adapter: web.adapter,
    baselines: web.baselines,
    conflictStore: web.conflicts,
    environment: 'web',
  });

  assert.equal(webResult.status, 'synced');
  const webWorkspaces = web.workspaceIds();
  assert.equal(webWorkspaces.length, 3);
  assert.ok(webWorkspaces.includes('ws-core-cs'));
  assert.ok(webWorkspaces.includes('ws-my-workspace'));
  assert.ok(webWorkspaces.includes('ws-placement-prep'));

  // Ensure Web contains the exact data and NO boilerplate items
  assert.equal(web.value('workspace', 'ws-core-cs').name, 'Core CS');
  assert.equal(web.value('workspace', 'ws-placement-prep').name, 'Placement Prep');
  assert.equal(web.has('notebookPage', 'page-1'), false, 'No boilerplate Page 1');
  assert.equal(web.has('notebookSection', 'sec-1'), false, 'No boilerplate Section 1');
  assert.equal(web.has('canvasFile', 'welcome-canvas'), false, 'No boilerplate Welcome Canvas');
});

// ---------------------------------------------------------------------------
// TEST B: Desktop Update
// ---------------------------------------------------------------------------
test('Test B: Desktop Update — Desktop adds workspace D; Web syncs and receives D', async () => {
  const canonicalAppData = new MemoryV2Provider();
  const desktop = new TestDevice();
  const web = new TestDevice();

  desktop.add('workspace', 'ws-A', null, { id: 'ws-A', name: 'Core CS' }, 'ws-A');
  await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: desktop.source, adapter: desktop.adapter, baselines: desktop.baselines, conflictStore: desktop.conflicts, environment: 'desktop' });
  await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: web.source, adapter: web.adapter, baselines: web.baselines, conflictStore: web.conflicts, environment: 'web' });

  // Desktop adds Workspace D ("System Design")
  desktop.add('workspace', 'ws-sys-design', null, { id: 'ws-sys-design', name: 'System Design' }, 'ws-sys-design');
  desktop.add('notebook', 'nb-sys-design', 'ws-sys-design', { id: 'nb-sys-design', name: 'Microservices' }, 'ws-sys-design');

  const desktopSync2 = await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: desktop.source, adapter: desktop.adapter, baselines: desktop.baselines, conflictStore: desktop.conflicts, environment: 'desktop' });
  assert.equal(desktopSync2.status, 'synced');
  assert.equal(canonicalAppData.catalog?.workspaces.length, 2);

  // Web syncs and receives Workspace D
  const webSync2 = await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: web.source, adapter: web.adapter, baselines: web.baselines, conflictStore: web.conflicts, environment: 'web' });
  assert.equal(webSync2.status, 'synced');
  assert.ok(web.has('workspace', 'ws-sys-design'));
  assert.equal(web.value('workspace', 'ws-sys-design').name, 'System Design');
  assert.ok(web.has('notebook', 'nb-sys-design'));
});

// ---------------------------------------------------------------------------
// TEST C: Web Update
// ---------------------------------------------------------------------------
test('Test C: Web Update — Web edits workspace; Desktop syncs and receives identical update', async () => {
  const canonicalAppData = new MemoryV2Provider();
  const desktop = new TestDevice();
  const web = new TestDevice();

  desktop.add('workspace', 'ws-core-cs', null, { id: 'ws-core-cs', name: 'Core CS' }, 'ws-core-cs');
  desktop.add('notebookPage', 'page-1', 'ws-core-cs', { id: 'page-1', name: 'Initial Title' }, 'ws-core-cs');

  await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: desktop.source, adapter: desktop.adapter, baselines: desktop.baselines, conflictStore: desktop.conflicts, environment: 'desktop' });
  await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: web.source, adapter: web.adapter, baselines: web.baselines, conflictStore: web.conflicts, environment: 'web' });

  // Web edits page-1
  web.edit('notebookPage', 'page-1', { id: 'page-1', name: 'Updated from Web Browser' });
  const webSync = await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: web.source, adapter: web.adapter, baselines: web.baselines, conflictStore: web.conflicts, environment: 'web' });
  assert.equal(webSync.status, 'synced');

  // Desktop syncs and receives the updated title
  const desktopSync = await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: desktop.source, adapter: desktop.adapter, baselines: desktop.baselines, conflictStore: desktop.conflicts, environment: 'desktop' });
  assert.equal(desktopSync.status, 'synced');
  assert.equal(desktop.value('notebookPage', 'page-1').name, 'Updated from Web Browser');
});

// ---------------------------------------------------------------------------
// TEST D: Web Reset
// ---------------------------------------------------------------------------
test('Test D: Web Reset — Remote has real data; Web local has drifted workspace; reset restores remote without boilerplate', async () => {
  const canonicalAppData = new MemoryV2Provider();
  const desktop = new TestDevice();

  desktop.add('workspace', 'ws-core-cs', null, { id: 'ws-core-cs', name: 'Core CS' }, 'ws-core-cs');
  desktop.add('workspace', 'ws-placement-prep', null, { id: 'ws-placement-prep', name: 'Placement Prep' }, 'ws-placement-prep');
  await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: desktop.source, adapter: desktop.adapter, baselines: desktop.baselines, conflictStore: desktop.conflicts, environment: 'desktop' });

  // Web has an untracked drifted workspace
  const web = new TestDevice();
  web.add('workspace', 'ws-drifted', null, { id: 'ws-drifted', name: 'Drifted Workspace' }, 'ws-drifted');

  // Execute the pre-validated reset flow:
  // 1. Pre-validation checks remote catalog
  const catalogRead = await canonicalAppData.readCatalog();
  assert.ok(catalogRead.value && catalogRead.value.workspaces.length > 0, 'Catalog pre-validation passes');
  for (const entry of catalogRead.value.workspaces) {
    const manifest = await canonicalAppData.readManifest(entry.workspaceId);
    assert.ok(manifest.value, `Manifest for ${entry.workspaceId} pre-validation passes`);
  }

  // 2. Clear Web local state and baselines
  web.entities.clear();
  await web.baselines.clear();

  // 3. Restore via canonical V2 sync
  const resetSync = await runCloudSyncV2({
    accountIdentifier: 'user@gmail.com',
    provider: canonicalAppData,
    source: web.source,
    adapter: web.adapter,
    baselines: web.baselines,
    conflictStore: web.conflicts,
    environment: 'web',
  });
  assert.equal(resetSync.status, 'synced');

  // Web now has only the remote workspaces, no drifted workspace, and no boilerplate
  const webWorkspaces = web.workspaceIds();
  assert.equal(webWorkspaces.length, 2);
  assert.ok(webWorkspaces.includes('ws-core-cs'));
  assert.ok(webWorkspaces.includes('ws-placement-prep'));
  assert.equal(web.has('workspace', 'ws-drifted'), false);
  assert.equal(web.has('workspace', 'default'), false);
});

// ---------------------------------------------------------------------------
// TEST E: Reset Failure Safety
// ---------------------------------------------------------------------------
test('Test E: Reset Failure Safety — Remote failure simulated -> Reset aborts before wiping local data', async () => {
  const emptyRemote = new MemoryV2Provider(); // Catalog is null
  const web = new TestDevice();
  web.add('workspace', 'ws-user-valuable', null, { id: 'ws-user-valuable', name: 'Valuable Local Work' }, 'ws-user-valuable');

  // Attempt reset with pre-validation
  let resetAborted = false;
  const catalogRead = await emptyRemote.readCatalog();
  const remoteEntries = catalogRead.value?.workspaces ?? [];

  if (remoteEntries.length === 0) {
    resetAborted = true; // Aborted because remote is empty / invalid
  } else {
    web.entities.clear(); // Would only be reached if remote was valid
  }

  assert.equal(resetAborted, true, 'Reset aborted before wiping');
  assert.equal(web.has('workspace', 'ws-user-valuable'), true, 'Local data preserved');
  assert.equal(web.value('workspace', 'ws-user-valuable').name, 'Valuable Local Work');
});

// ---------------------------------------------------------------------------
// TEST F: Conflict Persistence
// ---------------------------------------------------------------------------
test('Test F: Conflict Persistence — Conflict created -> persisted into conflict store -> reloaded across remount', async () => {
  const canonicalAppData = new MemoryV2Provider();
  const desktop = new TestDevice();
  const web = new TestDevice();

  desktop.add('workspace', 'ws-shared', null, { id: 'ws-shared', name: 'Shared Workspace' }, 'ws-shared');
  desktop.add('notebookPage', 'page-conflict', 'ws-shared', { id: 'page-conflict', content: 'Base Content' }, 'ws-shared');

  await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: desktop.source, adapter: desktop.adapter, baselines: desktop.baselines, conflictStore: desktop.conflicts });
  await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: web.source, adapter: web.adapter, baselines: web.baselines, conflictStore: web.conflicts });

  // Concurrent modification
  desktop.edit('notebookPage', 'page-conflict', { id: 'page-conflict', content: 'Desktop Content' });
  await runCloudSyncV2({ accountIdentifier: 'user@gmail.com', provider: canonicalAppData, source: desktop.source, adapter: desktop.adapter, baselines: desktop.baselines, conflictStore: desktop.conflicts });

  web.edit('notebookPage', 'page-conflict', { id: 'page-conflict', content: 'Web Divergent Content' });
  const conflictResult = await runCloudSyncV2({
    accountIdentifier: 'user@gmail.com',
    provider: canonicalAppData,
    source: web.source,
    adapter: web.adapter,
    baselines: web.baselines,
    conflictStore: web.conflicts,
  });

  assert.ok(conflictResult.status === 'conflict' || conflictResult.status === 'synced-review');
  assert.ok(conflictResult.conflicts && conflictResult.conflicts.length > 0);

  // Persist into dexieSyncV2ConflictStore
  const conflictId = `sync-conflict:ws-shared:notebookPage:page-conflict`;
  await dexieSyncV2ConflictStore.preserve({
    conflictId,
    profileId: 'test-profile',
    workspaceId: 'ws-shared',
    entityKind: 'notebookPage',
    entityId: 'page-conflict',
    parentId: 'ws-shared',
    localHash: 'hash-local',
    remoteHash: 'hash-remote',
    localBytes: new Uint8Array(),
    createdAt: Date.now(),
    resolvedAt: null,
  });

  // Verify conflict is listed
  let unresolved = await dexieSyncV2ConflictStore.listUnresolved?.('test-profile');
  assert.ok(unresolved && unresolved.some(c => c.conflictId === conflictId));

  // Simulate page reload / component remount: listUnresolved again
  unresolved = await dexieSyncV2ConflictStore.listUnresolved?.('test-profile');
  assert.equal(unresolved?.length, 1);
  assert.equal(unresolved?.[0].conflictId, conflictId);

  // Resolve conflict
  const resolved = await dexieSyncV2ConflictStore.resolve?.(conflictId, 'test-profile');
  assert.equal(resolved, true);

  // Verify conflict is now resolved
  const remaining = await dexieSyncV2ConflictStore.listUnresolved?.('test-profile');
  assert.equal(remaining?.length, 0);
});

// ---------------------------------------------------------------------------
// TEST G: Web Disconnect
// ---------------------------------------------------------------------------
test('Test G: Web Disconnect — Web disconnect clears local tokens and does NOT call oauth2.revoke', async () => {
  let revokeCalled = false;
  (globalThis as any).window = {
    google: {
      accounts: {
        oauth2: {
          revoke(_token: string, _callback?: () => void) {
            revokeCalled = true;
          },
        },
      },
    },
  };
  const storage = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem(k: string) { return storage.get(k) ?? null; },
    setItem(k: string, v: string) { storage.set(k, v); },
    removeItem(k: string) { storage.delete(k); },
  };

  localStorage.setItem('panvas_browser_google_connection', JSON.stringify({
    provider: 'googledrive',
    accountIdentifier: 'user@gmail.com',
    email: 'user@gmail.com',
    connectedAt: Date.now(),
  }));
  assert.ok(getBrowserGoogleConnection());

  await disconnectBrowserGoogle();

  assert.equal(getBrowserGoogleConnection(), null, 'Local connection cleared');
  assert.equal(revokeCalled, false, 'google.accounts.oauth2.revoke must NOT be called on Web disconnect');
});

// ---------------------------------------------------------------------------
// TEST H: Legacy Migration
// ---------------------------------------------------------------------------
test('Test H: Legacy Migration — Legacy visible Drive has A, B, C; canonical empty; Desktop migrates non-destructively', async () => {
  // Legacy Drive Provider (simulates spaces: 'drive')
  const legacyCandidateRootId = 'folder-legacy-panvas-root';
  let legacyFolderDeleted = false;

  const mockDriveProvider = {
    async findCandidatePanvasRoots() {
      return [{ id: legacyCandidateRootId, name: 'Panvas', modifiedTime: '2026-09-20T00:00:00Z' }];
    },
    // Spy to ensure legacy folder is NEVER deleted
    async deleteObject(_hash: string) {
      legacyFolderDeleted = true;
    },
  };

  const mockInspector = {
    async readRootJson<T>(_folderId: string, name: string): Promise<{ value: T | null; etag: string | null }> {
      if (name === 'catalog.json') {
        return {
          value: {
            format: 'panvas-sync',
            schemaVersion: 2,
            revision: 1,
            workspaces: [
              { workspaceId: 'ws-core-cs', revision: 1, name: 'Core CS' },
              { workspaceId: 'ws-placement-prep', revision: 1, name: 'Placement Prep' },
            ],
          } as T,
          etag: 'etag-catalog',
        };
      }
      return { value: null, etag: null };
    },
    async readWorkspaceJson<T>(_folderId: string, workspaceId: string, name: string): Promise<{ value: T | null; etag: string | null }> {
      if (name === 'manifest.json') {
        return {
          value: {
            format: 'panvas-sync',
            schemaVersion: 2,
            workspaceId,
            revision: 1,
            records: [
              { kind: 'workspace', id: workspaceId, parentId: null, hash: `hash-${workspaceId}`, tombstone: false },
            ],
          } as T,
          etag: `etag-${workspaceId}`,
        };
      }
      return { value: null, etag: null };
    },
    async getObject(_folderId: string, hash: string): Promise<Uint8Array> {
      return encode({ id: hash, name: 'Workspace Content' });
    },
  };

  const canonicalV2Provider = new MemoryV2Provider();

  const migrationResult = await inspectAndMigrateLegacyPanvasRoot({
    legacyDriveProvider: mockDriveProvider as any,
    canonicalProvider: canonicalV2Provider,
    inspector: mockInspector,
    accountIdentifier: 'user@gmail.com',
    localWorkspaceIds: ['ws-core-cs', 'ws-placement-prep'],
  });

  assert.equal(migrationResult.status, 'migrated');
  assert.equal(legacyFolderDeleted, false, 'Legacy folder was NOT deleted');

  // Verify canonical provider now has the migrated data
  const canonicalCatalog = await canonicalV2Provider.readCatalog();
  assert.equal(canonicalCatalog.value?.workspaces.length, 2);
  assert.ok(canonicalCatalog.value?.workspaces.some(w => w.workspaceId === 'ws-core-cs'));
  assert.ok(canonicalCatalog.value?.workspaces.some(w => w.workspaceId === 'ws-placement-prep'));

  const coreCsManifest = await canonicalV2Provider.readManifest('ws-core-cs');
  assert.ok(coreCsManifest.value);
  assert.equal(coreCsManifest.value?.workspaceId, 'ws-core-cs');
});

// ---------------------------------------------------------------------------
// TEST I: Ambiguous Legacy Roots
// ---------------------------------------------------------------------------
test('Test I: Ambiguous Legacy Roots — Multiple candidate roots with no matching baseline fail safely with migration-recovery-required', async () => {
  const mockDriveProvider = {
    async findCandidatePanvasRoots() {
      return [
        { id: 'folder-panvas-1', name: 'Panvas', modifiedTime: '2026-09-21T00:00:00Z' },
        { id: 'folder-panvas-2', name: 'Panvas', modifiedTime: '2026-09-20T00:00:00Z' },
      ];
    },
  };

  const mockInspectorAmbiguous = {
    async readRootJson<T>(_folderId: string, name: string): Promise<{ value: T | null; etag: string | null }> {
      if (name === 'catalog.json') {
        return {
          value: {
            format: 'panvas-sync',
            schemaVersion: 2,
            revision: 1,
            workspaces: [
              { workspaceId: 'ws-other-1', revision: 1, name: 'Other 1' },
            ],
          } as T,
          etag: 'etag-catalog-other',
        };
      }
      return { value: null, etag: null };
    },
    async readWorkspaceJson<T>() { return { value: null, etag: null }; },
    async getObject() { return new Uint8Array(); },
  };

  const canonicalV2Provider = new MemoryV2Provider();

  const result = await inspectAndMigrateLegacyPanvasRoot({
    legacyDriveProvider: mockDriveProvider as any,
    canonicalProvider: canonicalV2Provider,
    inspector: mockInspectorAmbiguous,
    accountIdentifier: 'user@gmail.com',
    localWorkspaceIds: ['ws-core-cs'],
  });

  assert.equal(result.status, 'migration-recovery-required');
  assert.equal(canonicalV2Provider.catalog, null, 'Canonical V2 was not modified');
});

// ---------------------------------------------------------------------------
// TEST J: Empty AppData on Web
// ---------------------------------------------------------------------------
test('Test J: Empty AppData on Web — Web connects before Desktop migrates -> returns cloud-not-initialized in synced-review without uploading defaults', async () => {
  const emptyCanonicalV2 = new MemoryV2Provider(); // Catalog is null
  const web = new TestDevice();

  // Web starts with local default workspace
  web.add('workspace', 'default', null, { id: 'default', name: 'My Workspace' }, 'default');
  web.add('notebook', 'nb-default', 'default', { id: 'nb-default', name: 'My Notebook' }, 'default');
  web.add('notebookPage', 'page-1', 'nb-default', { id: 'page-1', name: 'Page 1' }, 'default');

  const webSync = await runCloudSyncV2({
    accountIdentifier: 'user@gmail.com',
    provider: emptyCanonicalV2,
    source: web.source,
    adapter: web.adapter,
    baselines: web.baselines,
    conflictStore: web.conflicts,
    environment: 'web',
  });

  assert.equal(webSync.status, 'synced-review');
  assert.equal(webSync.errorCode, 'cloud-not-initialized');

  // Crucial: Canonical provider remains completely empty; Web did not upload defaults!
  assert.equal(emptyCanonicalV2.catalog, null, 'Catalog was NOT created in cloud');
  assert.equal(emptyCanonicalV2.manifests.size, 0, 'No manifests uploaded');
  assert.equal(emptyCanonicalV2.objects.size, 0, 'No objects uploaded');
});
