// ============================================
// Panvas — Status Bar
// ============================================

import React, { useSyncExternalStore } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { SyncIndicator } from '../ui/SyncIndicator';
import { useCloudSyncStore } from '@/stores/cloudSyncStore';
import { CLOUD_SYNC_ENABLED } from '@/config/features';
import { getCloudSyncPresentation } from '@/services/cloudsync/presentation';
import { getBrowserStorageDurabilityState, subscribeBrowserStorageDurability } from '@/services/storage/browserStorageDurability';

export function StatusBar() {
  const { saveStatus } = useCanvasStore();
  const { activeCanvasId } = useWorkspaceStore();
  const cloudStatus = useCloudSyncStore(state => state.statusByProvider.googledrive);
  const cloudConnection = useCloudSyncStore(state => state.connectionByProvider.googledrive);
  const cloudError = useCloudSyncStore(state => state.lastError);
  const cloudReviewCount = useCloudSyncStore(state => state.reviewItems.length);
  const cloudRecoveryCount = useCloudSyncStore(state => state.workspaceRecoveryIssues.length);
  const cloudPresentation = getCloudSyncPresentation({ enabled: CLOUD_SYNC_ENABLED, status: cloudStatus, connection: cloudConnection, lastError: cloudError, recoveryOnly: cloudStatus === 'synced-review' && cloudRecoveryCount > 0 && cloudReviewCount === 0 });
  const browserStorage = useSyncExternalStore(subscribeBrowserStorageDurability, getBrowserStorageDurabilityState, getBrowserStorageDurabilityState);
  const isBrowserMode = typeof window !== 'undefined' && !window.panvas;
  const showStorageNotice = isBrowserMode && ['denied', 'unsupported', 'error'].includes(browserStorage.persistence);

  const statusConfig = {
    idle: { dot: 'bg-panvas-text-tertiary', text: 'Ready' },
    saving: { dot: 'bg-panvas-accent-amber animate-pulse', text: 'Saving...' },
    saved: { dot: 'bg-panvas-accent-emerald', text: 'Saved' },
    error: { dot: 'bg-panvas-accent-rose', text: 'Save failed' },
  };

  const status = statusConfig[saveStatus];

  return (
    <div className="h-6 flex-shrink-0 flex items-center justify-between px-3
                    border-t border-panvas-border-subtle bg-panvas-bg-secondary/30
                    text-2xs text-panvas-text-tertiary select-none">
      <div className="flex items-center gap-3">
        {activeCanvasId && <SyncIndicator />}

        {/* Canvas and notebook editors share the same local save state. Keep
            it visible on every workspace surface so failures are never only
            communicated by an expiring toast. */}
        <div
          data-testid="save-status"
          role="status"
          aria-live="polite"
          className="flex items-center gap-1.5 text-panvas-text-tertiary"
        >
          <div className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          <span>{status.text}</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {showStorageNotice && (
          <span role="status" aria-label="Browser storage durability" title={browserStorage.message} className="text-panvas-accent-amber">
            Browser storage: best effort
          </span>
        )}
        <span role="status" aria-label="Connectivity" className="text-panvas-text-tertiary">{cloudPresentation.connectivityLabel}</span>
        <span className="opacity-50">v0.1.1</span>
      </div>
    </div>
  );
}
