import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { formatLastSynced } from '../src/components/library/cloudSyncTimestamp.ts';

test('production sync panel offers one main action, clear choices and a separate recovery notice', async () => {
  const server = await createServer({ configFile: false, envFile: false, optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false }, resolve: { alias: { '@': path.resolve('src') } },
    plugins: [{ name: 'isolated-panel-state', transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/components/library/CloudSyncPanel.tsx')) return;
      return code.replace(/import \{ useCloudSyncStore \} from [^;]+;/, 'const useCloudSyncStore = () => globalThis.__syncPanelState;')
        .replace(/import \{ useUIStore \} from [^;]+;/, 'const useUIStore = selector => selector({});')
        .replace('import.meta.env.DEV', 'false');
    } }],
  });
  try {
    const { CloudSyncPanel } = await server.ssrLoadModule('/src/components/library/CloudSyncPanel.tsx');
    const state = { statusByProvider: { googledrive: 'conflict' }, connectionByProvider: { googledrive: { accountIdentifier: 'account-test' } }, lastSyncedByProvider: { googledrive: 123 }, autoSync: false, isSyncing: false, isResetting: false, resetThisDevice: async () => true,
      reviewItems: [{ conflictId: 'sync-conflict:private-id', workspaceId: 'private-workspace', entityId: 'private-entity', entityKind: 'canvasScene' }], workspaceRecoveryIssues: [],
      migrationWorkspaceIds: [], lastDiagnostic: { workspaceId: 'private-workspace', entityId: 'private-entity', throwingFunction: 'private-function' } };
    globalThis.__syncPanelState = state;
    const render = () => renderToStaticMarkup(React.createElement(CloudSyncPanel));
    const conflict = render();
    for (const text of ['Use Google Drive', 'Use this device', 'Keep both', 'This device already contains Panvas data', 'recovery copy', 'sync independently', 'Reset this device', 'Drive files and your account stay untouched']) assert.ok(conflict.includes(text), text);
    assert.equal((conflict.match(/>Sync now</g) ?? []).length, 1);
    for (const text of ['private-workspace', 'private-entity', 'private-function', 'Sync diagnostic details', '>Download<']) assert.equal(conflict.includes(text), false, text);
    state.statusByProvider.googledrive = 'synced-review'; state.reviewItems = [];
    state.workspaceRecoveryIssues = [{ workspaceId: 'private-workspace', classification: 'orphaned' }];
    const recovery = render();
    assert.match(recovery, /Synced .*some older data was preserved/);
    assert.ok(recovery.includes('Older sync data was preserved for recovery and does not affect your current workspaces.'));
    for (const text of ['Some older workspaces need recovery', 'Sync diagnostic details', 'View recovery information', 'remote root is unavailable', 'stage:', 'reason:', 'workspaceId', 'entityKind', 'entityId', 'schemaVersion', 'retryable', 'throwingFunction', 'still loading', 'private-workspace', '>Keep both<', '>Use this device<', 'cloud-sync-review-heading']) assert.equal(recovery.includes(text), false, text);
    state.statusByProvider.googledrive = 'synced'; state.workspaceRecoveryIssues = [];
    const synced = render(); assert.ok(synced.includes('>Synced<'));
    assert.ok(synced.includes(`Last synced: ${formatLastSynced(123)}`), 'the panel displays the exact calendar date and local time');
    assert.equal(synced.includes('cloud-sync-review-heading'), false);
  } finally { delete globalThis.__syncPanelState; await server.close(); }
});

test('CloudSyncPanel never renders technical diagnostics in development builds', async () => {
  const server = await createServer({ configFile: false, envFile: false, optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false }, resolve: { alias: { '@': path.resolve('src') } },
    plugins: [{ name: 'isolated-panel-state-dev', transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/components/library/CloudSyncPanel.tsx')) return;
      return code.replace(/import \{ useCloudSyncStore \} from [^;]+;/, 'const useCloudSyncStore = () => globalThis.__syncPanelStateDev;')
        .replace(/import \{ useUIStore \} from [^;]+;/, 'const useUIStore = selector => selector({});')
        .replaceAll('import.meta.env.DEV', 'true');
    } }],
  });
  try {
    const { CloudSyncPanel } = await server.ssrLoadModule('/src/components/library/CloudSyncPanel.tsx');
    globalThis.__syncPanelStateDev = {
      statusByProvider: { googledrive: 'synced-review' }, connectionByProvider: { googledrive: { accountIdentifier: 'account-test' } }, lastSyncedByProvider: { googledrive: 123 }, autoSync: false, isSyncing: false, isResetting: false,
      migrationWorkspaceIds: [], reviewItems: [], workspaceRecoveryIssues: [{ workspaceId: 'private-workspace', classification: 'orphaned' }],
      lastDiagnostic: { workspaceId: 'private-workspace', reason: 'remote-workspace-root-missing', errorMessage: 'remote root is unavailable' },
    };
    const markup = renderToStaticMarkup(React.createElement(CloudSyncPanel));
    assert.match(markup, /Synced .*some older data was preserved/);
    assert.ok(markup.includes('Older sync data was preserved for recovery and does not affect your current workspaces.'));
    for (const text of ['Sync diagnostic details', 'View recovery information', 'remote root is unavailable', 'stage:', 'reason:', 'workspaceId', 'entityKind', 'entityId', 'schemaVersion', 'retryable', 'throwingFunction', 'private-workspace']) assert.equal(markup.includes(text), false, text);
  } finally { delete globalThis.__syncPanelStateDev; await server.close(); }
});

test('Sync now keeps one in-flight UI action while delegating to the existing runner', async () => {
  const source = await readFile('src/components/library/CloudSyncPanel.tsx', 'utf8');
  assert.match(source, /const syncNowInFlightRef = useRef\(false\)/);
  assert.match(source, /if \(syncNowInFlightRef\.current\) return/);
  assert.match(source, /await triggerSync\(\)/);
  assert.match(source, /syncNowInFlightRef\.current = false/);
});

test('CloudSyncPanel reliably renders all three resolution choices whenever review is active', async () => {
  const server = await createServer({ configFile: false, envFile: false, optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false }, resolve: { alias: { '@': path.resolve('src') } },
    plugins: [{ name: 'isolated-panel-state-v2', transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/components/library/CloudSyncPanel.tsx')) return;
      return code.replace(/import \{ useCloudSyncStore \} from [^;]+;/, 'const useCloudSyncStore = () => globalThis.__syncPanelStateV2;')
        .replace(/import \{ useUIStore \} from [^;]+;/, 'const useUIStore = selector => selector({});')
        .replace('import.meta.env.DEV', 'false');
    } }],
  });
  try {
    const { CloudSyncPanel } = await server.ssrLoadModule('/src/components/library/CloudSyncPanel.tsx');
    globalThis.__syncPanelStateV2 = {
      statusByProvider: { googledrive: 'conflict' },
      connectionByProvider: { googledrive: { accountIdentifier: 'account-test' } },
      lastSyncedByProvider: { googledrive: 123 },
      autoSync: false, isSyncing: false, isResetting: false,
      reviewItems: [{ conflictId: 'resolution:profile-1:workspace-1:canvas:test:deleted', workspaceId: 'ws-1', entityId: 'c-1', entityKind: 'canvasScene' }],
      workspaceRecoveryIssues: [], migrationWorkspaceIds: [], lastDiagnostic: null,
    };
    let html = renderToStaticMarkup(React.createElement(CloudSyncPanel));
    assert.ok(html.includes('Use Google Drive'), 'renders Use Google Drive for resolution: conflictId');
    assert.ok(html.includes('Use this device'), 'renders Use this device for resolution: conflictId');
    assert.ok(html.includes('Keep both'), 'renders Keep both for resolution: conflictId');

    globalThis.__syncPanelStateV2.statusByProvider.googledrive = 'synced-review';
    html = renderToStaticMarkup(React.createElement(CloudSyncPanel));
    assert.ok(html.includes('Use Google Drive'), 'renders Use Google Drive for synced-review');
    assert.ok(html.includes('Use this device'), 'renders Use this device for synced-review');
    assert.ok(html.includes('Keep both'), 'renders Keep both for synced-review');
  } finally {
    delete globalThis.__syncPanelStateV2;
    await server.close();
  }
});

test('resolveReviewChanges(device) resolves unresolved conflict, transitions status to synced, and clears review state', async () => {
  const server = await createServer({ configFile: false, envFile: false, optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false }, resolve: { alias: { '@': path.resolve('src') } },
  });
  try {
    const { useCloudSyncStore } = await server.ssrLoadModule('/src/stores/cloudSyncStore.ts');
    const { dexieSyncV2ConflictStore } = await server.ssrLoadModule('/src/services/cloudsync/v2/conflictStore.ts');
    
    // Set up an isolated unresolved conflict
    const testConflict = {
      conflictId: 'sync-conflict:test-ws:canvasScene:scene-1',
      profileId: 'test-profile',
      workspaceId: 'test-ws',
      entityKind: 'canvasScene',
      entityId: 'scene-1',
      parentId: null,
      localHash: 'hash-local-data',
      remoteHash: 'hash-remote-data',
      localBytes: new Uint8Array([1, 2, 3]),
      createdAt: Date.now(),
      resolvedAt: null,
    };
    await dexieSyncV2ConflictStore.preserve(testConflict);
    
    // Set initial store state with conflict
    useCloudSyncStore.setState({
      statusByProvider: { googledrive: 'conflict' },
      workspaceStatusById: { 'test-ws': 'conflict' },
      reviewItems: [{
        conflictId: testConflict.conflictId,
        workspaceId: testConflict.workspaceId,
        entityKind: testConflict.entityKind,
        entityId: testConflict.entityId,
      }],
      workspaceRecoveryIssues: [],
      lastError: 'Conflict detected',
    });

    const store = useCloudSyncStore.getState();
    assert.equal(store.reviewItems.length, 1);
    assert.equal(store.statusByProvider.googledrive, 'conflict');

    // Execute "Use this device"
    const resolved = await store.resolveReviewChanges('device');
    assert.equal(resolved, true, 'resolveReviewChanges(device) must return true');

    // Verify post-resolution state
    const after = useCloudSyncStore.getState();
    assert.equal(after.statusByProvider.googledrive, 'synced', 'Provider status must transition to synced');
    assert.equal(after.workspaceStatusById['test-ws'], 'synced', 'Workspace status must become synced');
    assert.equal(after.reviewItems.length, 0, 'reviewItems must be cleared');
    assert.equal(after.lastError, null, 'lastError must be cleared');

    // Verify local conflict store was marked resolved
    const unresolved = await dexieSyncV2ConflictStore.listUnresolved('test-profile');
    assert.equal(unresolved.some(item => item.conflictId === testConflict.conflictId), false, 'Conflict must be marked resolved');
  } finally {
    await server.close();
  }
});
