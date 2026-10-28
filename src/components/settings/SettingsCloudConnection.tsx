import React from 'react';
import { useLocation } from 'wouter';
import { Cloud, ArrowUpRight } from 'lucide-react';
import { useCloudSyncStore } from '@/stores/cloudSyncStore';
import { useUIStore } from '@/stores/uiStore';
import { CLOUD_SYNC_ENABLED, CLOUD_SYNC_V2_ENABLED } from '@/config/features';
import { navigateToLibraryView } from '@/services/library/libraryRouteState';
import type { CloudSyncPresentation } from '@/services/cloudsync/presentation';

export function useSettingsCloudState() {
  const status = useCloudSyncStore(state => state.statusByProvider.googledrive);
  const connection = useCloudSyncStore(state => state.connectionByProvider.googledrive);
  const lastError = useCloudSyncStore(state => state.lastError);
  const lastSyncedAt = useCloudSyncStore(state => state.lastSyncedByProvider.googledrive);
  const recoveryOnly = useCloudSyncStore(state => state.workspaceRecoveryIssues.length > 0 && state.reviewItems.length === 0);
  return { enabled: CLOUD_SYNC_V2_ENABLED || CLOUD_SYNC_ENABLED, status, connection, lastError, lastSyncedAt, recoveryOnly };
}

export function settingsConnectionLabel(cloud: ReturnType<typeof useSettingsCloudState>, presentation: CloudSyncPresentation) {
  if (!cloud.enabled) return 'Disabled';
  if (cloud.status === 'connecting') return 'Connecting…';
  if (cloud.status === 'token-needed' || cloud.status === 'auth-expired') return 'Reconnect required';
  return presentation.settingsLabel;
}

export function SettingsCloudConnection({ cloud, presentation }: {
  cloud: ReturnType<typeof useSettingsCloudState>; presentation: CloudSyncPresentation;
}) {
  const [, navigate] = useLocation();
  const label = settingsConnectionLabel(cloud, presentation);
  const needsAuth = cloud.status === 'token-needed' || cloud.status === 'auth-expired';
  const last = typeof cloud.lastSyncedAt === 'number' && Number.isFinite(cloud.lastSyncedAt) && cloud.lastSyncedAt > 0
    ? new Date(cloud.lastSyncedAt) : null;
  const open = () => {
    useUIStore.getState().requestCloudSyncReview();
    navigateToLibraryView('cloud');
    navigate('/app/library');
  };
  return <section aria-label="Google Drive connection" className="panvas-surface overflow-hidden text-sm">
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <h3 className="flex items-center gap-2 font-medium text-panvas-text-primary"><Cloud size={16} aria-hidden="true" />Google Drive</h3>
      <span className={presentation.kind === 'ready' && !needsAuth ? 'text-panvas-text-primary' : 'text-panvas-text-secondary'}>{label}</span>
    </div>
    <div className="space-y-3 border-t border-panvas-border-subtle p-4">
      {cloud.connection?.email && <p className="break-all text-panvas-text-primary">{cloud.connection.email}</p>}
      <p className="text-xs leading-relaxed text-panvas-text-secondary">{needsAuth
        ? 'Google Drive authorization is unavailable. Reconnect to resume syncing; your local files remain available.'
        : presentation.title}</p>
      {cloud.lastError && <p role="status" className="text-xs text-panvas-text-secondary">{cloud.lastError}</p>}
      <div className="flex flex-wrap justify-between gap-1 text-xs text-panvas-text-secondary">
        <span>Last successful sync</span>
        {last ? <time dateTime={last.toISOString()}>{last.toLocaleString()}</time> : <span>No successful sync recorded</span>}
      </div>
      {last && <p className="text-xs text-panvas-text-secondary">Historical success; this does not confirm that current changes are synced.</p>}
      {cloud.enabled && <button type="button" onClick={open} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-panvas-border-default px-3 py-1.5 text-xs font-medium text-panvas-text-primary hover:bg-panvas-bg-hover focus-ring">
        {needsAuth ? 'Reconnect Google Drive' : cloud.connection ? 'Manage Google Drive' : 'Connect Google Drive'}<ArrowUpRight size={14} aria-hidden="true" />
      </button>}
    </div>
  </section>;
}
