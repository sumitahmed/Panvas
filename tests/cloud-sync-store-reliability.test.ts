import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { loadWorkspaceBindings } from '../src/services/cloudsync/workspaceBindings.ts';

test('store settles success, serial reruns, failures, reconnect and stale completion using synthetic IPC', async () => {
  const previousWindow = (globalThis as any).window;
  const previousStorage = (globalThis as any).localStorage;
  const values = new Map<string, string>();
  const connection = { provider: 'googledrive', accountIdentifier: 'synthetic-account', connectedAt: 1 };
  (globalThis as any).localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  (globalThis as any).window = { panvas: {
    workspace: { getAll: async () => [{ id: 'ws-test' }] }, trash: { getAll: async () => ({ workspaces: [] }) },
    cloudsync: { connect: async () => ({ success: true, connection }), disconnect: async () => ({ success: true }), logDiagnostic: () => {} },
  } };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  let runs = 0, active = 0, maximum = 0;
  let worker: () => Promise<any> = async () => ({ status: 'synced', uploaded: 1, downloaded: 0 });
  const runProviders: any[] = [];
  (globalThis as any).__panvasSyncTest = async (input: any) => {
    runProviders.push(input.provider);
    runs++; active++; maximum = Math.max(maximum, active);
    try { return await worker(); } finally { active--; }
  };
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, resolve: { alias: { '@': path.resolve('src') } }, plugins: [{
    name: 'synthetic-cloud-runtime', enforce: 'pre',
    transform(code, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/stores/cloudSyncStore.ts')) return code
        .replace(/import \{ runCloudSyncV2 \} from [^;]+;/, 'const runCloudSyncV2 = globalThis.__panvasSyncTest;')
        .replace(/import \{ CLOUD_SYNC_V2_ENABLED \} from [^;]+;/, 'const CLOUD_SYNC_V2_ENABLED = true;');
    },
  }] });
  let store: any;
  try {
    ({ useCloudSyncStore: store } = await server.ssrLoadModule('/src/stores/cloudSyncStore.ts'));
    store.setState({ connectionByProvider: { googledrive: connection }, autoSync: false });
    await store.getState().triggerSync();
    assert.equal(store.getState().statusByProvider.googledrive, 'synced');
    assert.ok(store.getState().lastSyncedByProvider.googledrive);
    assert.equal(store.getState().lastError, null);

    let release!: () => void;
    worker = async () => { await new Promise<void>(resolve => { release = resolve; }); return { status: 'synced', downloaded: 0 }; };
    const first = store.getState().triggerSync();
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    const second = store.getState().triggerSync();
    const third = store.getState().triggerSync();
    worker = async () => ({ status: 'synced', downloaded: 0 });
    release(); await Promise.all([first, second, third]);
    assert.equal(runs, 3, 'initial run plus one active and one coalesced rerun');
    assert.equal(maximum, 1);
    assert.ok(runProviders.every(provider => provider === runProviders[0]), 'same account retains one provider across cycles and queued reruns');

    store.setState({ reviewItems: [{ conflictId: 'sync-conflict:ws-broken:folder:folder-old', workspaceId: 'ws-broken', entityKind: 'folder', entityId: 'folder-old' }] });
    worker = async () => ({ status: 'synced-review', downloaded: 0, conflicts: [], workspaceOutcomes: [
      { workspaceId: 'ws-broken', classification: 'orphaned', status: 'orphaned' },
      { workspaceId: 'ws-test', classification: 'healthy', status: 'synced' },
    ] });
    await store.getState().triggerSync();
    assert.deepEqual(store.getState().reviewItems, [], 'quarantined roots must not retain old child conflict buttons');
    assert.equal(store.getState().workspaceRecoveryIssues[0].workspaceId, 'ws-broken');
    assert.equal(store.getState().workspaceStatusById['ws-test'], 'synced');

    worker = async () => ({ status: 'error', errorCode: 'sync', diagnostic: { stage: 'object-upload', reason: 'backendError', status: 503, retryable: true } });
    await store.getState().triggerSync();
    assert.equal(store.getState().statusByProvider.googledrive, 'error');
    const priorSuccess = store.getState().lastSyncedByProvider.googledrive;
    worker = async () => ({ status: 'synced', downloaded: 0 });
    await store.getState().triggerSync();
    assert.equal(store.getState().lastError, null);
    assert.equal(store.getState().lastDiagnostic, null);
    assert.ok(store.getState().lastSyncedByProvider.googledrive >= priorSuccess);

    let releaseOld!: () => void;
    worker = async () => { await new Promise<void>(resolve => { releaseOld = resolve; }); throw new Error('synthetic old failure'); };
    const old = store.getState().triggerSync();
    while (!releaseOld) await new Promise(resolve => setTimeout(resolve, 0));
    const disconnect = store.getState().requestDisconnect('googledrive');
    releaseOld(); await Promise.all([old, disconnect]);
    assert.equal(store.getState().statusByProvider.googledrive, 'disconnected');
    assert.equal(store.getState().lastError, null);
    worker = async () => ({ status: 'synced', downloaded: 0 });
    assert.equal(await store.getState().requestConnect('googledrive'), true);
    await store.getState().triggerSync();
    assert.equal(store.getState().statusByProvider.googledrive, 'synced');
    assert.notEqual(runProviders.at(-1), runProviders[0], 'disconnect/reconnect invalidates the previous provider');
    const reconnectedProvider = runProviders.at(-1);

    // Regression for the recorded account-adoption loop: the destination is
    // empty, local V2 metadata still belongs to account A, and the legacy V1
    // binding points at A. The complete adoption plan must be persisted in
    // one write before the first reconciliation, then remain idempotent.
    const destination = {
      // Electron's narrow bridge wraps the provider's `{ value, etag }`
      // response inside the IPC result envelope.
      readRootJson: async (_name: string) => ({ success: true as const, value: { value: null, etag: null } }),
      writeRootJson: async (_name: string, _value: unknown, _ifMatch: string | null) => ({ success: true as const, value: { etag: 'synthetic' } }),
    };
    (globalThis as any).window.panvas.cloudsync.driveV2 = destination;
    const accountB = { provider: 'googledrive', accountIdentifier: 'synthetic-account-b', connectedAt: 2 };
    values.set('panvas.cloudWorkspaceBindings.v1', JSON.stringify([{
      workspaceId: 'ws-test', provider: 'googledrive', providerAccountId: 'synthetic-account-a', remoteWorkspaceId: 'ws-test', lastKnownRemoteRevision: 4, attachedAt: 1,
    }]));
    values.set('panvas.cloudSync.v2.profile', JSON.stringify({ profileId: 'profile-a', accountIdentifier: 'synthetic-account-a' }));
    store.setState({
      connectionByProvider: { googledrive: accountB },
      statusByProvider: { googledrive: 'account-migration-required' },
      isSyncing: false,
    });
    assert.equal(await store.getState().moveSyncToCurrentGoogleAccount(), true);
    const moved = JSON.parse(values.get('panvas.cloudWorkspaceBindings.v1')!);
    assert.deepEqual(moved.map((binding: any) => binding.providerAccountId), ['synthetic-account-b']);
    assert.deepEqual(loadWorkspaceBindings().map(binding => binding.providerAccountId), ['synthetic-account-b'], 'a reload reads the adopted account from canonical storage');
    const movedProfile = JSON.parse(values.get('panvas.cloudSync.v2.profile')!);
    assert.equal(movedProfile.accountIdentifier, 'synthetic-account-b');
    assert.notEqual(movedProfile.profileId, 'profile-a', 'switching to an empty account namespace starts fresh profile metadata');
    assert.equal(store.getState().statusByProvider.googledrive, 'synced');
    assert.notEqual(runProviders.at(-1), reconnectedProvider, 'account B cannot inherit account A provider caches');
    assert.equal(await store.getState().moveSyncToCurrentGoogleAccount(), true, 'repeating adoption for the selected account is idempotent');
    assert.deepEqual(JSON.parse(values.get('panvas.cloudWorkspaceBindings.v1')!).map((binding: any) => binding.providerAccountId), ['synthetic-account-b']);
  } finally {
    store?.getState().setAutoSync(false);
    await server.close();
    (globalThis as any).window = previousWindow;
    (globalThis as any).localStorage = previousStorage;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete (globalThis as any).navigator;
    delete (globalThis as any).__panvasSyncTest;
  }
});
