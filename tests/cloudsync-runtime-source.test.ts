import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { getCloudSyncPresentation } from '../src/services/cloudsync/presentation.ts';
import { publicCloudMessage } from '../src/services/cloudsync/errors.ts';

const activeRuntimeFiles = [
  'src/app/App.tsx',
  'src/components/layout/StatusBar.tsx',
  'src/components/settings/sections/WorkspaceSection.tsx',
  'src/stores/authStore.ts',
  'src/stores/canvasStore.ts',
  'src/stores/workspaceStore.ts',
];

test('active production state paths have no quarantined sync wiring', async () => {
  const sources = await Promise.all(activeRuntimeFiles.map(file => readFile(file, 'utf8')));
  for (let index = 0; index < sources.length; index += 1) {
    assert.doesNotMatch(sources[index], /useSyncStore|services\/sync|incrementPending|pendingChanges/, activeRuntimeFiles[index]);
  }
  assert.match(sources[0], /useCloudSyncStore\.getState\(\)/);
  assert.match(sources[0], /\.initialize\(\)/);
  assert.match(sources[1], /getCloudSyncPresentation/);
  assert.match(sources[2], /getCloudSyncPresentation/);
});

test('canonical Google Drive presentation preserves local mode and current cloud states', () => {
  const connection = { provider: 'googledrive' as const, accountIdentifier: 'account-1', connectedAt: 1 };
  assert.equal(getCloudSyncPresentation({ enabled: false, status: 'disconnected', connection: null }).connectivityLabel, 'Local only');
  assert.equal(getCloudSyncPresentation({ enabled: true, status: 'disconnected', connection: null }).settingsLabel, 'Not connected');
  assert.equal(getCloudSyncPresentation({ enabled: true, status: 'offline', connection }).connectivityLabel, 'Offline · saved locally');
  assert.equal(getCloudSyncPresentation({ enabled: true, status: 'auth-expired', connection }).indicatorLabel, 'Reconnect');
  assert.equal(getCloudSyncPresentation({ enabled: true, status: 'conflict', connection }).kind, 'attention');
  assert.equal(getCloudSyncPresentation({ enabled: true, status: 'synced', connection }).indicatorLabel, 'Synced');
  assert.equal(getCloudSyncPresentation({ enabled: true, status: 'synced-review', connection, recoveryOnly: true }).indicatorLabel, 'Synced');
  assert.equal(getCloudSyncPresentation({ enabled: true, status: 'synced-review', connection, recoveryOnly: true }).kind, 'ready');
});

test('CloudSyncPanel never exposes technical diagnostics in any build', async () => {
  const panel = await readFile('src/components/library/CloudSyncPanel.tsx', 'utf8');
  for (const technical of ['showDeveloperDiagnostics', 'import.meta.env.DEV', 'lastDiagnostic', 'Sync diagnostic details', 'View recovery information', 'remote root is unavailable', 'workspaceId', 'entityKind', 'entityId', 'schemaVersion', 'throwingFunction', 'retryable']) {
    const escaped = technical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.doesNotMatch(panel, new RegExp(`\\b${escaped}\\b`, 'i'), technical);
  }
  assert.match(panel, /Older sync data was preserved for recovery and does not affect your current workspaces/);
  assert.match(panel, /changes need your review/);
  assert.doesNotMatch(panel, /console\.error\('\[CloudSyncPanel\] Account migration failed/);
});

test('existing local token-needed and Resume sync work remains available', async () => {
  const [types, panel] = await Promise.all([
    readFile('src/services/cloudsync/types.ts', 'utf8'),
    readFile('src/components/library/CloudSyncPanel.tsx', 'utf8'),
  ]);
  assert.match(types, /\| 'token-needed'/);
  assert.match(panel, /'token-needed': 'Resume sync'/);
});

test('public Cloud Sync copy is concise while recovery choices remain explicit', () => {
  assert.equal(publicCloudMessage('conflict'), 'This workspace changed both here and in Google Drive. Choose which version to keep. Your local work is safe.');
  assert.equal(publicCloudMessage('review'), 'Some changes need review. Your work was preserved.');
  assert.match(publicCloudMessage('remote-workspace'), /workspace needs recovery/);
});
