import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';

test('CLOUD_SYNC_V2_ENABLED flag defaults to true and respects explicit false', async () => {
  const evaluateFlag = (envVal: string | undefined): boolean => envVal !== 'false';
  assert.equal(evaluateFlag(undefined), true, 'undefined must default to enabled');
  assert.equal(evaluateFlag(''), true, 'empty string must default to enabled');
  assert.equal(evaluateFlag('true'), true, 'explicit true must be enabled');
  assert.equal(evaluateFlag('1'), true, 'truthy values must be enabled');
  assert.equal(evaluateFlag('false'), false, 'only explicit false disables V2');

  // Test loading through Vite server to verify CLOUD_SYNC_V2_ENABLED in real bundler context
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    resolve: { alias: { '@': path.resolve('src') } },
  });

  try {
    const features = await server.ssrLoadModule('/src/config/features.ts');
    assert.equal(features.CLOUD_SYNC_V2_ENABLED, true, 'Default Vite SSR build must enable V2');
  } finally {
    await server.close();
  }
});

test('retireLegacyV1SyncMetadata cleanly purges obsolete V1 presentation keys and root hints', async () => {
  const previousStorage = (globalThis as any).localStorage;
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    get length() { return store.size; },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  };

  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    resolve: { alias: { '@': path.resolve('src') } },
  });

  try {
    // Populate V1 and V2 keys
    store.set('panvas.cloudWorkspaceBindings.v1', JSON.stringify([{ workspaceId: 'ws-test', providerAccountId: 'acc-1' }]));
    store.set('panvas.cloudWorkspaceBindings', JSON.stringify([{ workspaceId: 'ws-old' }]));
    store.set('panvas.cloudSync.lastSuccess.v1.anonymous.acc-1', '12345');
    store.set('panvas.cloudSync.lastSuccess.v1.desktop.acc-1', '12345');
    store.set('panvas_cloud_root_acc-1', 'folder-id-123');
    store.set('panvas.cloudSync.lastSuccess.v2.anonymous.acc-1', '67890');
    store.set('panvas.cloudSync.v2.profile', JSON.stringify({ profileId: 'p-1', accountIdentifier: 'acc-1' }));
    store.set('panvas_user_preference', 'theme-dark');

    const { retireLegacyV1SyncMetadata } = await server.ssrLoadModule('/src/stores/cloudSyncStore.ts');
    retireLegacyV1SyncMetadata();

    // Stale V1 presentation keys must be removed
    assert.equal(store.has('panvas.cloudSync.lastSuccess.v1.anonymous.acc-1'), false);
    assert.equal(store.has('panvas.cloudSync.lastSuccess.v1.desktop.acc-1'), false);
    assert.equal(store.has('panvas_cloud_root_acc-1'), false);

    // Active V2 and unrelated keys must remain intact
    assert.equal(store.get('panvas.cloudSync.lastSuccess.v2.anonymous.acc-1'), '67890');
    assert.equal(store.has('panvas.cloudSync.v2.profile'), true);
    assert.equal(store.get('panvas_user_preference'), 'theme-dark');
  } finally {
    await server.close();
    (globalThis as any).localStorage = previousStorage;
  }
});
