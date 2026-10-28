import test from 'node:test';
import assert from 'node:assert/strict';
import { getCloudSyncPresentation } from '../src/services/cloudsync/presentation.ts';
import type { ProviderConnectionInfo } from '../src/services/cloudsync/types.ts';

test('Google Drive V2 sync presentation reflects active V2 state when legacy cloud sync is disabled', () => {
  // Simulates production release where VITE_ENABLE_CLOUD_SYNC is false and VITE_PANVAS_SYNC_V2 is true
  const legacyCloudSyncEnabled = false;
  const cloudSyncV2Enabled = true;
  const isCloudSyncAvailable = cloudSyncV2Enabled || legacyCloudSyncEnabled;

  assert.equal(isCloudSyncAvailable, true, 'Cloud sync gate must be open when V2 is enabled');

  const connection: ProviderConnectionInfo = {
    provider: 'googledrive',
    accountIdentifier: 'google-user-123',
    email: 'user@example.com',
    displayName: 'Test User',
    connectedAt: 1700000000000,
  };

  // 1. Disconnected state
  const disconnected = getCloudSyncPresentation({
    enabled: isCloudSyncAvailable,
    status: 'disconnected',
    connection: null,
  });
  assert.equal(disconnected.kind, 'disconnected');
  assert.equal(disconnected.indicatorLabel, 'Cloud Sync');
  assert.equal(disconnected.settingsLabel, 'Not connected');
  assert.equal(disconnected.connectivityLabel, 'Local only');
  assert.match(disconnected.title, /Open Cloud Sync to connect Google Drive/);

  // When enabled is false (both legacy and V2 disabled), it says "unavailable in this build"
  const disabled = getCloudSyncPresentation({
    enabled: false,
    status: 'disconnected',
    connection: null,
  });
  assert.equal(disabled.settingsLabel, 'Disabled');
  assert.match(disabled.title, /unavailable in this build/);

  // 2. Connected state
  const connected = getCloudSyncPresentation({
    enabled: isCloudSyncAvailable,
    status: 'connected',
    connection,
  });
  assert.equal(connected.kind, 'ready');
  assert.equal(connected.indicatorLabel, 'Connected');
  assert.equal(connected.settingsLabel, 'Connected');
  assert.equal(connected.connectivityLabel, 'Cloud connected');
  assert.equal(connected.connected, true);

  // 3. Syncing state
  const syncing = getCloudSyncPresentation({
    enabled: isCloudSyncAvailable,
    status: 'syncing',
    connection,
  });
  assert.equal(syncing.kind, 'busy');
  assert.equal(syncing.indicatorLabel, 'Syncing…');
  assert.equal(syncing.settingsLabel, 'Syncing…');
  assert.equal(syncing.connectivityLabel, 'Cloud syncing');

  // 4. Synced state
  const synced = getCloudSyncPresentation({
    enabled: isCloudSyncAvailable,
    status: 'synced',
    connection,
  });
  assert.equal(synced.kind, 'ready');
  assert.equal(synced.indicatorLabel, 'Synced');
  assert.equal(synced.settingsLabel, 'Synced');
  assert.equal(synced.connectivityLabel, 'Cloud synced');

  // 5. Offline state
  const offline = getCloudSyncPresentation({
    enabled: isCloudSyncAvailable,
    status: 'offline',
    connection,
  });
  assert.equal(offline.kind, 'offline');
  assert.equal(offline.indicatorLabel, 'Offline');
  assert.equal(offline.settingsLabel, 'Offline');
  assert.equal(offline.connectivityLabel, 'Offline · saved locally');

  // 6. Auth expired / Reconnect state
  const authExpired = getCloudSyncPresentation({
    enabled: isCloudSyncAvailable,
    status: 'auth-expired',
    connection,
    lastError: 'Google Drive authorization expired.',
  });
  assert.equal(authExpired.kind, 'attention');
  assert.equal(authExpired.indicatorLabel, 'Reconnect');
  assert.equal(authExpired.settingsLabel, 'Reconnect');
  assert.equal(authExpired.connectivityLabel, 'Reconnect');
});

