import React, { useEffect, useRef, useState } from 'react';
import { Cloud, ShieldCheck, RefreshCw, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react';
import { useCloudSyncStore } from '@/stores/cloudSyncStore';
import { useUIStore } from '@/stores/uiStore';
import type { CloudSyncStatus } from '@/services/cloudsync/types';
import { isBrowserGoogleConfigured } from '@/services/cloudsync/browserGoogleAuth';
import { logCloudDiagnostic, presentCloudError } from '@/services/cloudsync/errors';
import { CLOUD_SYNC_V2_ENABLED } from '@/config/features';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { SyncV2ConflictChoice } from '@/services/cloudsync/v2/types';

/** Official Google Drive brand icon using canonical Google brand vectors and colors */
export function GoogleDriveIcon({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066DA" />
      <path d="M43.65 25 29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44A9.06 9.06 0 0 0 0 53h27.5z" fill="#00AC47" />
      <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 11.45z" fill="#EA4335" />
      <path d="M43.65 25 57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" fill="#00832D" />
      <path d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684FC" />
      <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 59.8 53h27.5c0-1.55-.4-3.1-1.2-4.5z" fill="#FFBA00" />
    </svg>
  );
}

const STATUS_LABELS: Record<CloudSyncStatus, string> = {
  disconnected: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  syncing: 'Syncing…',
  synced: 'Synced',
  'synced-review': 'Review changes',
  'account-migration-required': 'Account action needed',
  offline: 'Offline',
  conflict: 'Review changes',
  'auth-expired': 'Reconnect Google Drive',
  'rate-limited': 'Google Drive is busy — retry later',
  error: "Couldn't sync right now",
};

function formatLastSynced(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  const elapsedSec = Math.floor((Date.now() - timestamp) / 1000);
  if (elapsedSec < 30) return 'Just now';
  if (elapsedSec < 60) return `${elapsedSec} seconds ago`;
  const elapsedMin = Math.floor(elapsedSec / 60);
  if (elapsedMin < 60) return `${elapsedMin} minute${elapsedMin > 1 ? 's' : ''} ago`;
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function CloudSyncPanel() {
  const {
    statusByProvider,
    connectionByProvider,
    lastSyncedByProvider,
    autoSync,
    setAutoSync,
    requestConnect,
    requestDisconnect,
    triggerSync,
    isSyncing,
    initialize,
    progress,
    lastError,
    migrationWorkspaceIds,
    moveSyncToCurrentGoogleAccount,
    reviewItems,
    workspaceRecoveryIssues,
    loadReviewChanges,
    resolveReviewChanges,
    resetThisDevice,
    isResetting,
  } = useCloudSyncStore();

  const showToast = useUIStore(state => state.showToast);
  const clearToast = useUIStore(state => state.clearToast);
  const cloudSyncReviewRequested = useUIStore(state => state.cloudSyncReviewRequested);
  const clearCloudSyncReviewRequest = useUIStore(state => state.clearCloudSyncReviewRequest);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isAccountMigrationDialogOpen, setIsAccountMigrationDialogOpen] = useState(false);
  const [isDeviceResetDialogOpen, setIsDeviceResetDialogOpen] = useState(false);
  const [showReviewDetails, setShowReviewDetails] = useState(() => statusByProvider.googledrive === 'conflict');
  const [isResolvingReview, setIsResolvingReview] = useState(false);
  // React may not commit the disabled syncing state before a second pointer
  // event arrives. Keep the existing V2 runner as the single action for one
  // user gesture instead of queuing a duplicate run in that small window.
  const syncNowInFlightRef = useRef(false);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (!cloudSyncReviewRequested) return;
    setShowReviewDetails(true);
    clearCloudSyncReviewRequest();
    // The review section is conditionally mounted. Wait until the state update
    // has committed before trying to scroll, otherwise the top-bar action looks
    // like it did nothing when the panel is already open.
    let frame = 0;
    let secondFrame = 0;
    frame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => document.getElementById('cloud-sync-review')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    });
    return () => { window.cancelAnimationFrame(frame); window.cancelAnimationFrame(secondFrame); };
  }, [clearCloudSyncReviewRequest, cloudSyncReviewRequested]);

  const gdStatus = statusByProvider.googledrive;
  const gdConnection = connectionByProvider.googledrive;
  const gdConnected = Boolean(gdConnection && gdStatus !== 'disconnected');
  const hasResolvableReview = reviewItems.some(item => !item.conflictId.startsWith('sync-conflict:'));
  const hasConcurrentConflict = reviewItems.some(item => item.conflictId.startsWith('sync-conflict:'));
  const hasConnectedProvider = gdConnected;
  const isElectron = typeof window !== 'undefined' && Boolean(window.panvas);
  const browserConfigured = isElectron || isBrowserGoogleConfigured();
  const hasRecoveryOnly = gdStatus === 'synced-review' && workspaceRecoveryIssues.length > 0 && reviewItems.length === 0;
  const publicStatusLabel = hasRecoveryOnly ? 'Synced — some older data was preserved' : STATUS_LABELS[gdStatus];

  useEffect(() => {
    if (gdStatus === 'synced-review' || (gdStatus === 'conflict' && reviewItems.length > 0)) {
      if (reviewItems.length > 0) setShowReviewDetails(true);
      void loadReviewChanges();
    }
  }, [gdStatus, loadReviewChanges, reviewItems.length]);

  const handleGoogleConnect = async () => {
    if (!browserConfigured) {
      showToast('Google Drive connection is not configured in this build.', 'error');
      return;
    }
    clearToast();
    setIsConnecting(true);
    try {
      const success = await requestConnect('googledrive');
      if (success) {
        clearToast();
      } else {
        const err = useCloudSyncStore.getState().lastError;
        showToast(err || "Google Drive couldn't be connected. Please try again.", 'error');
      }
    } finally {
      setIsConnecting(false);
    }
  };

  const handleGoogleDisconnect = async () => {
    await requestDisconnect('googledrive');
    showToast('Google Drive disconnected. Local data preserved.', 'info');
  };

  const handleSyncNow = async () => {
    if (syncNowInFlightRef.current) return;
    syncNowInFlightRef.current = true;
    try {
      await triggerSync();
      const { statusByProvider, lastError } = useCloudSyncStore.getState();
      const finalStatus = statusByProvider.googledrive;
      if (finalStatus === 'synced') {
        showToast('Up to date', 'success');
      } else if ((finalStatus === 'synced-review' || finalStatus === 'conflict') && useCloudSyncStore.getState().reviewItems.length > 0) {
        setShowReviewDetails(true);
      } else if (finalStatus === 'account-migration-required') {
        // The persistent account-action panel below is the source of truth for
        // this state; avoid covering it with a transient toast.
      } else if (finalStatus === 'auth-expired') {
        showToast('Google Drive needs to be reconnected.', 'error');
      } else if (finalStatus === 'offline') {
        showToast("You're offline. Changes will sync when you're back online.", 'error');
      } else if (finalStatus === 'rate-limited') {
        showToast("Couldn't sync right now. Your local work is safe.", 'error');
      } else if (finalStatus === 'error') {
        showToast(lastError || "Couldn't sync right now. Your local work is safe.", 'error');
      }
    } finally {
      syncNowInFlightRef.current = false;
    }
  };

  const handleKeepGoogleDriveVersion = async () => {
    if (isResolvingReview || reviewItems.length === 0) return;
    setIsResolvingReview(true);
    try {
      const resolved = await resolveReviewChanges();
      if (resolved) {
        setShowReviewDetails(false);
        showToast('Google Drive version kept. Sync is up to date.', 'success');
      } else {
        showToast('Some review items could not be acknowledged yet.', 'error');
      }
    } finally {
      setIsResolvingReview(false);
    }
  };

  const handleResolveConcurrentConflict = async (choice: SyncV2ConflictChoice) => {
    if (isResolvingReview || !hasConcurrentConflict) return;
    setIsResolvingReview(true);
    try {
      const resolved = await resolveReviewChanges(choice);
      if (resolved) {
        setShowReviewDetails(false);
        const label = choice === 'cloud' ? 'Google Drive version' : choice === 'device' ? 'This device version' : 'Both versions';
        showToast(`${label} kept safely. Sync is up to date.`, 'success');
      } else {
        showToast('The conflict is still present. Your data remains safe.', 'error');
      }
    } finally {
      setIsResolvingReview(false);
    }
  };

  const handleAccountMigration = async () => {
    setIsAccountMigrationDialogOpen(true);
  };

  const confirmAccountMigration = async () => {
    // The confirmation only authorizes the handoff. Close it immediately so a
    // large first upload never traps the user behind a modal; progress and the
    // final result remain visible in the Cloud Sync card.
    setIsAccountMigrationDialogOpen(false);
    try {
      const success = await moveSyncToCurrentGoogleAccount();
      const state = useCloudSyncStore.getState();
      if (success) showToast('Workspace sync moved to this Google account.', 'success');
      else showToast(state.lastError || "Couldn't move workspace sync right now. Your local work is safe.", 'error');
    } catch (error) {
      logCloudDiagnostic(presentCloudError(error, 'account-adoption').diagnostic);
      showToast("Couldn't move workspace sync right now. Your local work is safe.", 'error');
    }
  };

  const confirmDeviceReset = async () => {
    setIsDeviceResetDialogOpen(false);
    const success = await resetThisDevice();
    const state = useCloudSyncStore.getState();
    if (success) showToast('This device was reset and Google Drive work was restored.', 'success');
    else showToast(state.lastError || "Couldn't reset this device. Your local data remains unchanged.", 'error');
  };

  return (
    <section className="w-full max-w-3xl pb-8" aria-labelledby="cloud-sync-heading">
      <div className="mb-7 flex items-start gap-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-panvas-border-default bg-panvas-bg-elevated shadow-sm">
          <Cloud size={20} className="text-panvas-accent-blue" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="mb-1 text-2xs font-semibold uppercase tracking-[0.16em] text-panvas-text-tertiary">Storage</p>
          <h1 id="cloud-sync-heading" className="text-2xl sm:text-[28px] font-semibold tracking-tight text-panvas-text-primary">
            Cloud Sync
          </h1>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-panvas-text-secondary">
            Keep your Panvas work available across devices with your own Google Drive account.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Google Drive Card */}
        <div className="overflow-hidden rounded-2xl border border-panvas-border-default bg-panvas-bg-elevated shadow-sm transition-colors hover:border-panvas-border-strong/40">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-panvas-border-subtle bg-panvas-bg-primary shadow-xs">
                <GoogleDriveIcon size={24} />
              </span>
              <div className="min-w-0">
                <div className="text-base font-semibold text-panvas-text-primary truncate">Google Drive</div>
                <div className="mt-0.5 text-xs text-panvas-text-tertiary truncate">
                  {gdConnected ? gdConnection?.email || gdConnection?.displayName || 'Connected' : 'Continue locally or connect your Google account'}
                </div>
              </div>
            </div>

            {gdConnected ? (
              <div className="flex w-full items-center gap-2 sm:w-auto sm:self-auto">
                <button
                  type="button"
                  // V2's SinglePendingRunner deliberately coalesces a second
                  // request while an automatic run is active. Keep the button
                  // clickable so Sync now is never a dead control during that
                  // window; only the connection transition must block input.
                  disabled={isConnecting}
                  onClick={gdStatus === 'auth-expired' ? handleGoogleConnect : handleSyncNow}
                  className="panvas-action-button panvas-action-button--secondary min-w-0 flex-1 text-xs focus-ring sm:flex-none"
                  title="Sync all changes immediately"
                >
                  <RefreshCw size={13} className={isSyncing || gdStatus === 'syncing' ? 'animate-spin' : ''} />
                  <span>{gdStatus === 'auth-expired' ? 'Reconnect' : isSyncing || gdStatus === 'syncing' ? 'Syncing…' : 'Sync now'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleGoogleDisconnect}
                  className="panvas-action-button panvas-action-button--secondary text-xs text-panvas-accent-rose hover:bg-panvas-accent-rose/10 focus-ring"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={isConnecting || gdStatus === 'connecting'}
                onClick={handleGoogleConnect}
                className="panvas-action-button panvas-action-button--primary w-full self-start focus-ring sm:w-auto sm:self-auto shrink-0"
              >
                {isConnecting || gdStatus === 'connecting' ? 'Connecting…' : 'Connect Google Drive'}
              </button>
            )}
          </div>

          {gdConnected && (
            <div className="mx-5 mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-panvas-border-subtle bg-panvas-bg-secondary/45 px-3.5 py-3 text-xs">
              <div className="flex items-center gap-1.5">
                {gdStatus === 'synced' || hasRecoveryOnly ? (
                  <CheckCircle2 size={13} className="text-panvas-accent-green" />
                ) : gdStatus === 'synced-review' ? (
                  <AlertCircle size={13} className="text-panvas-accent-amber" />
                ) : gdStatus === 'syncing' ? (
                  <RefreshCw size={13} className="animate-spin text-panvas-accent-blue" />
                ) : gdStatus === 'account-migration-required' ? (
                  <AlertCircle size={13} className="text-panvas-accent-amber" />
                ) : gdStatus === 'error' || gdStatus === 'conflict' || gdStatus === 'auth-expired' || gdStatus === 'rate-limited' ? (
                  <AlertCircle size={13} className="text-panvas-accent-rose" />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-panvas-text-tertiary" />
                )}
                <span className="font-medium text-panvas-text-secondary">{publicStatusLabel}</span>
              </div>
              <div className="text-2xs text-panvas-text-tertiary">
                Last synced: {formatLastSynced(lastSyncedByProvider.googledrive)}
              </div>
            </div>
          )}
          {!gdConnected && !browserConfigured && (
            <p className="mx-5 mb-5 border-t border-panvas-border-subtle pt-3 text-2xs text-panvas-text-tertiary">
              Google Drive connection is not configured in this build.
            </p>
          )}
          {gdConnected && progress && (
            <div className="mx-5 mb-5" aria-live="polite">
              <div className="mb-1 flex justify-between text-2xs text-panvas-text-tertiary">
                <span>{progress.message}</span>
                {progress.total > 1 && <span>{Math.round((progress.completed / progress.total) * 100)}%</span>}
              </div>
              {progress.total > 1 && <div className="h-1 overflow-hidden rounded bg-panvas-bg-secondary"><div className="h-full bg-panvas-accent-blue transition-[width]" style={{ width: `${Math.min(100, progress.completed / progress.total * 100)}%` }} /></div>}
            </div>
          )}
          {gdConnected && lastError && workspaceRecoveryIssues.length === 0 && !hasConcurrentConflict && gdStatus !== 'account-migration-required' && gdStatus !== 'synced-review' && <p className="mx-5 mb-5 text-xs leading-5 text-panvas-accent-rose">{lastError}</p>}
          {hasRecoveryOnly && (
            <p className="mx-5 mb-5 text-2xs leading-5 text-panvas-text-tertiary">
              Older sync data was preserved for recovery and does not affect your current workspaces.
            </p>
          )}
          {gdConnected && reviewItems.length > 0 && (gdStatus === 'synced-review' || gdStatus === 'conflict') && showReviewDetails && (
            <div id="cloud-sync-review" className="mx-5 mb-5 rounded-xl border border-panvas-accent-amber/45 bg-panvas-accent-amber/10 p-4" role="region" aria-labelledby="cloud-sync-review-heading" aria-live="polite">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panvas-accent-amber/15 text-panvas-accent-amber">
                  <AlertCircle size={17} aria-hidden="true" />
                </span>
                 <div className="min-w-0">
                   <h3 id="cloud-sync-review-heading" className="text-sm font-semibold text-panvas-text-primary">Review changes</h3>
                   <p className="mt-1 text-xs leading-5 text-panvas-text-secondary">
                     {hasConcurrentConflict ? 'This device already contains Panvas data, and Google Drive also contains synced work. Choose which version to use for the affected workspace.' : 'Some changes need your review. Your work was preserved.'}
                   </p>
                  {reviewItems.length > 0 ? (
                    <>
                      <p className="mt-2 text-2xs text-panvas-text-secondary">{reviewItems.length === 1 ? 'One change needs your review.' : `${reviewItems.length} changes need your review.`}</p>
                      {hasConcurrentConflict ? <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={isResolvingReview}
                          onClick={() => void handleResolveConcurrentConflict('cloud')}
                          className="panvas-action-button panvas-action-button--secondary text-xs focus-ring disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Use Google Drive
                        </button>
                        <button
                          type="button"
                          disabled={isResolvingReview}
                          onClick={() => void handleResolveConcurrentConflict('device')}
                          className="panvas-action-button panvas-action-button--secondary text-xs focus-ring disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Use this device
                        </button>
                        <button
                          type="button"
                          disabled={isResolvingReview}
                          onClick={() => void handleResolveConcurrentConflict('both')}
                          className="panvas-action-button panvas-action-button--primary text-xs focus-ring disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Keep both
                        </button>
                        <div className="basis-full space-y-2 text-2xs text-panvas-text-secondary">
                          <p><strong>Use Google Drive:</strong> Replace the active Panvas data on this device with the version from Google Drive. Your current device data will be preserved as a recovery copy.</p>
                          <p><strong>Use this device:</strong> Use the Panvas data currently on this device as the synced version. A recovery copy of the previous cloud version will be preserved.</p>
                          <p><strong>Keep both:</strong> Keep the Drive workspace and create a second normal workspace named “Device copy”. Both workspaces sync independently. Recovery copies are retained too.</p>
                        </div>
                      </div> : hasResolvableReview ? <div className="mt-3 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          disabled={isResolvingReview}
                          onClick={() => void handleKeepGoogleDriveVersion()}
                          className="panvas-action-button panvas-action-button--secondary text-xs focus-ring disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isResolvingReview ? 'Savingâ€¦' : 'Keep Google Drive version'}
                        </button>
                        <span className="text-2xs text-panvas-text-tertiary">Your preserved local copy remains in recovery storage.</span>
                      </div> : <p className="mt-3 text-2xs text-panvas-text-tertiary">Panvas kept your local copy while the review record is loading.</p>}
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          )}
          {gdConnected && CLOUD_SYNC_V2_ENABLED && gdStatus === 'account-migration-required' && (
            <div className="mx-5 mb-5 rounded-xl border border-panvas-accent-amber/45 bg-panvas-accent-amber/10 p-4" role="alert" aria-live="polite">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panvas-accent-amber/15 text-panvas-accent-amber">
                  <AlertCircle size={17} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-panvas-text-primary">This device is linked to another Google account</p>
                  <p className="mt-1 text-xs leading-5 text-panvas-text-secondary">
                    Sync is paused to protect your local work. You are signed in as <span className="font-medium text-panvas-text-primary">{gdConnection?.email || 'this account'}</span>.
                  </p>
                  <p className="mt-1 text-xs leading-5 text-panvas-text-secondary">
                    Panvas has paused before changing this account’s files. You can reconnect the account that owns this sync, or create a separate sync here if its Panvas space is empty.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isSyncing || isConnecting}
                      onClick={handleAccountMigration}
                      className="panvas-action-button panvas-action-button--primary text-xs focus-ring"
                    >
                      Use this account <ArrowRight size={14} aria-hidden="true" />
                    </button>
                    <span className="text-2xs text-panvas-text-tertiary">Existing Drive files are not deleted.</span>
                  </div>
                </div>
              </div>
            </div>
          )}
          {gdConnected && !CLOUD_SYNC_V2_ENABLED && migrationWorkspaceIds.length > 0 && (
            <div className="mx-5 mb-5 rounded-xl border border-panvas-accent-amber/45 bg-panvas-accent-amber/10 p-4">
              <p className="text-sm font-semibold text-panvas-text-primary">Some workspaces are linked to another Google account.</p>
              <p className="mt-1 text-xs leading-5 text-panvas-text-secondary">
                Nothing will be uploaded until you explicitly move sync. Files in the previous Google account will remain untouched.
              </p>
              <button
                type="button"
                disabled={isSyncing}
                onClick={handleAccountMigration}
                className="panvas-action-button panvas-action-button--primary mt-3 text-xs focus-ring"
              >
                Move sync to this Google account <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>



        {/* OneDrive Card (Coming Later) */}
        <div className="rounded-xl border border-panvas-border-default/70 bg-panvas-bg-elevated/60 p-4 opacity-75">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-panvas-border-subtle bg-panvas-bg-primary text-panvas-text-tertiary">
                <Cloud size={20} />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-panvas-text-primary truncate">OneDrive</div>
                <div className="text-2xs text-panvas-text-tertiary truncate">Connect your Microsoft account</div>
              </div>
            </div>
            <span className="self-start sm:self-auto rounded-full bg-panvas-bg-secondary px-3 py-1 text-2xs font-medium text-panvas-text-tertiary border border-panvas-border-subtle">
              Coming later
            </span>
          </div>
        </div>
      </div>

      {/* Security & Settings card */}
      <div className="mt-6 rounded-xl border border-panvas-border-subtle bg-panvas-bg-elevated/60 p-4 text-xs text-panvas-text-secondary">
        <div className="flex items-start gap-2.5">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-panvas-accent-green" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-medium text-panvas-text-primary">
              Cloud sync is optional. Panvas works fully offline without an account.
            </p>
            <p className="text-panvas-text-tertiary text-2xs leading-relaxed">
              Storage mode: Local + Google Drive. Browser authorization uses Google Identity Services; Electron uses desktop OAuth PKCE.
              Panvas never receives or stores your password.
            </p>
          </div>
        </div>

        <div className="mt-4 border-t border-panvas-border-subtle/80 pt-3">
          <label className={`flex items-center justify-between gap-3 text-xs ${hasConnectedProvider ? 'text-panvas-text-secondary' : 'opacity-60 cursor-not-allowed'}`}>
            <div>
              <span className="font-medium">Auto Sync</span>
              <span className="block text-2xs text-panvas-text-tertiary">
                Automatically sync local edits when connected to your Google Drive
              </span>
            </div>
            <input
              type="checkbox"
              disabled={!hasConnectedProvider}
              checked={autoSync && hasConnectedProvider}
              onChange={event => setAutoSync(event.target.checked)}
              className="h-4 w-4 rounded accent-panvas-accent-blue disabled:cursor-not-allowed"
              aria-label="Auto Sync"
            />
          </label>
        </div>

        {hasConnectedProvider && (
          <div className="mt-4 border-t border-panvas-border-subtle/80 pt-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <span className="font-medium text-panvas-text-primary">Reset this device</span>
                <span className="block text-2xs leading-relaxed text-panvas-text-tertiary">
                  Remove local Panvas data and download the current Google Drive copy again. Drive files and your account stay untouched.
                </span>
              </div>
              <button
                type="button"
                disabled={isSyncing || isResetting}
                onClick={() => setIsDeviceResetDialogOpen(true)}
                className="panvas-action-button panvas-action-button--secondary shrink-0 text-xs text-panvas-accent-rose focus-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isResetting ? 'Resetting…' : 'Reset this device'}
              </button>
            </div>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={isAccountMigrationDialogOpen}
        title={CLOUD_SYNC_V2_ENABLED ? 'Use this Google account for sync?' : 'Move workspace sync?'}
        description={CLOUD_SYNC_V2_ENABLED
          ? 'Panvas will create a separate sync space in this account and upload your local work there. Existing Drive files will not be deleted.'
          : 'Move these local workspaces to the currently connected Google account. Files in the previous Google account will not be deleted.'}
        confirmLabel={CLOUD_SYNC_V2_ENABLED ? 'Use this account' : 'Move sync'}
        tone={CLOUD_SYNC_V2_ENABLED ? 'neutral' : 'danger'}
        dismissibleWhileSubmitting
        onCancel={() => setIsAccountMigrationDialogOpen(false)}
        onConfirm={confirmAccountMigration}
      />
      <ConfirmDialog
        open={isDeviceResetDialogOpen}
        title="Reset this device and restore from Google Drive?"
        description="Panvas will make a local recovery snapshot when supported, remove this device’s workspaces and sync metadata, then download the current Google Drive work again. Google Drive files, your account, and OAuth credentials will not be changed."
        confirmLabel="Reset and restore"
        tone="danger"
        onCancel={() => setIsDeviceResetDialogOpen(false)}
        onConfirm={confirmDeviceReset}
      />
    </section>
  );
}
