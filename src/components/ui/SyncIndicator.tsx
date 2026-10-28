// ============================================
// Panvas — Sync Indicator
// Shows current cloud sync state in TopBar
// ============================================

import React from 'react';
import { useCloudSyncStore } from '@/stores/cloudSyncStore';
import { Cloud, CloudOff, RefreshCw, AlertCircle } from 'lucide-react';
import { CLOUD_SYNC_ENABLED, CLOUD_SYNC_V2_ENABLED } from '@/config/features';
import { getCloudSyncPresentation } from '@/services/cloudsync/presentation';

export function SyncIndicator({ onOpenCloudSync }: { onOpenCloudSync?: () => void } = {}) {
  const { statusByProvider, connectionByProvider, triggerSync, lastError, reviewItems, workspaceRecoveryIssues } = useCloudSyncStore();
  const gdConnection = connectionByProvider.googledrive;
  const gdStatus = statusByProvider.googledrive;
  const recoveryOnly = gdStatus === 'synced-review' && workspaceRecoveryIssues.length > 0 && reviewItems.length === 0;

  const presentation = getCloudSyncPresentation({ enabled: CLOUD_SYNC_V2_ENABLED || CLOUD_SYNC_ENABLED, status: gdStatus, connection: gdConnection, lastError, recoveryOnly });

  let icon: React.ReactNode = <Cloud size={13} className="text-panvas-accent-green" aria-hidden="true" />;
  const label = presentation.indicatorLabel;
  const title = presentation.title;
  let color = 'text-panvas-text-secondary';
  if (presentation.kind === 'disconnected') {
    icon = <CloudOff size={13} aria-hidden="true" />;
    color = 'text-panvas-text-tertiary';
  } else if (presentation.kind === 'offline') {
    icon = <CloudOff size={13} aria-hidden="true" />;
    color = 'text-panvas-text-tertiary';
  } else if (presentation.kind === 'busy') {
    icon = <RefreshCw size={12} className="animate-spin text-panvas-accent-blue" aria-hidden="true" />;
    color = 'text-panvas-text-secondary';
  } else if (presentation.kind === 'attention') {
    icon = <AlertCircle size={13} aria-hidden="true" />;
    color = gdStatus === 'account-migration-required' || gdStatus === 'synced-review' ? 'text-panvas-accent-amber' : 'text-panvas-accent-rose';
  }

  const className = `flex items-center gap-1.5 rounded px-2 py-1 transition-colors focus-ring ${color} ${onOpenCloudSync ? 'hover:bg-panvas-bg-hover hover:text-panvas-text-primary' : ''}`;
  const handleClick = () => onOpenCloudSync ? onOpenCloudSync() : void triggerSync();
  return (
    <button type="button" onClick={handleClick} className={className} title={title} aria-label={onOpenCloudSync ? 'Open Cloud Sync' : label}>
      {icon}
      <span className="text-[10px] font-medium tracking-wide max-[599px]:sr-only">{label}</span>
    </button>
  );
}
