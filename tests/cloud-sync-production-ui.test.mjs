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
