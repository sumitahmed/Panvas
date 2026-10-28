// ============================================
// Panvas — Main App Component
// ============================================

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { WorkspaceContent } from '@/components/workspace/WorkspaceContent';
import { CommandPalette } from '@/components/ui/CommandPalette';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { Toast } from '@/components/ui/Toast';
import { CreateDialog } from '@/components/workspace/CreateDialog';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useAuthStore } from '@/stores/authStore';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { initializeDatabase } from '@/database/schema';
import { migrateFromDexieToFs, needsDexieToFsMigration } from '@/lib/migration';
import { Redirect, Route, Switch, Router, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { usePanvasLocation, isDesktop } from '@/lib/location';
import { LandingPage } from '@/components/marketing/LandingPage';
import { ComingSoonPage } from '@/components/marketing/ComingSoonPage';
import { RoadmapPage } from '@/components/marketing/RoadmapPage';
import { DownloadPage } from '@/components/marketing/DownloadPage';
import { NotFoundPage } from '@/components/marketing/NotFoundPage';
import { PrivacyPolicyPage } from '@/components/legal/PrivacyPolicyPage';
import { TermsOfServicePage } from '@/components/legal/TermsOfServicePage';
import { SecurityPage } from '@/components/legal/SecurityPage';
// Auth Pages
import { AuthGuard } from '@/components/auth/AuthGuard';
import { AuthCallbackHandler } from '@/components/auth/AuthCallbackHandler';
import { VerifyEmailPage } from '@/components/auth/VerifyEmailPage';
import { SettingsLayout } from '@/components/settings/SettingsLayout';
import { LibraryWorkspace } from '@/components/library/LibraryWorkspace';
import { KnowledgeWorkspace } from '@/components/knowledge/KnowledgeWorkspace';
import { CLOUD_SYNC_ENABLED, CLOUD_SYNC_V2_ENABLED } from '@/config/features';
import { useCloudSyncStore } from '@/stores/cloudSyncStore';
import { rememberAppRoute } from '@/services/library/libraryRouteState';
import { PANVAS_LOGO_SRC } from '@/lib/brand';
import { scheduleDeferredLocalModelPreparation } from '@/services/recognition/modelPreparation';
import { ViewportErrorBoundary } from '@/components/ui/ErrorBoundary';

function AppRouteMemory() {
  const [location] = useLocation();
  useEffect(() => rememberAppRoute(location), [location]);
  return null;
}

// Developer-only handwriting-fallback benchmark lab; lazy so the model-facing
// harness code never touches the startup bundle.
const HandwritingBenchmarkLab = import.meta.env.DEV ? React.lazy(() => import('@/dev/HandwritingBenchmarkLab')) : null;

// These account forms are retained for existing deep links and session flows,
// but are not part of the local-first workspace startup bundle.
const LoginPage = React.lazy(() => import('@/components/auth/LoginPage').then(({ LoginPage }) => ({ default: LoginPage })));
const SignUpPage = React.lazy(() => import('@/components/auth/SignUpPage').then(({ SignUpPage }) => ({ default: SignUpPage })));
const ForgotPasswordPage = React.lazy(() => import('@/components/auth/ForgotPasswordPage').then(({ ForgotPasswordPage }) => ({ default: ForgotPasswordPage })));
const ResetPasswordPage = React.lazy(() => import('@/components/auth/ResetPasswordPage').then(({ ResetPasswordPage }) => ({ default: ResetPasswordPage })));

function LegacyAuthFallback() {
  return <div role="status" aria-live="polite" className="min-h-screen grid place-content-center p-8 text-sm text-panvas-text-secondary">Opening account page…</div>;
}

export function App() {
  const [isReady, setIsReady] = useState(false);
  const { loadWorkspaces, loadRecentFiles, loadTrash } = useWorkspaceStore();
  const { initAuth } = useAuthStore();

  // Register keyboard shortcuts
  useKeyboardShortcuts();

  // In desktop Electron (hash location), ensure unhashed /landing routes into #/landing.
  useEffect(() => {
    if (!isDesktop) return;
    const pathname = window.location.pathname;
    if (pathname.includes('/landing')) {
      if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/') {
        window.location.hash = '#/landing';
      }
    }
  }, []);

  // Initialize on mount
  useEffect(() => {
    async function init() {
      try {
        // 1. Initialize Auth (restores session if logged in)
        await initAuth();
        const currentUserId = useAuthStore.getState().user?.id ?? null;

        // 2. Initialize IndexedDB schema strictly for this user context
        // If it fails (e.g. QuotaDatabase corrupted in Electron), we gracefully proceed
        try {
          await initializeDatabase(currentUserId);
        } catch (e) {
          console.warn('[App] Dexie init failed. This is fine if using Electron IPC.', e);
        }
        
        // 3. Load workspace data strictly scoped to this user
        const bootstrapSnapshot = await loadWorkspaces();
        // 3.1 Restore the persisted active document through the canonical
        // workspace-content path: it hydrates the active workspace's records
        // first, validates the stored page/canvas ids against them, and
        // never records a new user-open event.
        const { activeWorkspaceId: restoredWorkspaceId, loadWorkspaceContents } = useWorkspaceStore.getState();
        if (restoredWorkspaceId) {
          await loadWorkspaceContents(restoredWorkspaceId);
        }
        await loadRecentFiles();
        await loadTrash();

        // 3.5 Load global settings
        const { useNotebookSettingsStore } = await import('@/stores/notebookSettingsStore');
        if (!bootstrapSnapshot) await useNotebookSettingsStore.getState().loadSettings();

        // The default-landing decision may fall back to the Library only
        // after the restore pass above has settled.
        useWorkspaceStore.getState().markInitialDocumentRestoreComplete();
        setIsReady(true);
        // Legacy Dexie import can be substantial on long-lived profiles. It
        // is recovery work, not a prerequisite for rendering the existing
        // filesystem library, so it must never hold the startup splash open.
        // Cloud Sync joins this same single-flight run before reading local
        // workspace IDs, which prevents migration/sync races.
        if (needsDexieToFsMigration()) {
          window.setTimeout(() => {
            void migrateFromDexieToFs()
              .then(() => useWorkspaceStore.getState().loadWorkspaces())
              .catch(error => console.warn('[App] Deferred legacy import did not complete.', error instanceof Error ? error.name : 'Error'));
          }, 0);
        }
        // Background local-model preparation (dormant while the neural
        // fallback is disabled): never blocks startup, only runs when no
        // native handwriting provider exists, and only at idle.
        scheduleDeferredLocalModelPreparation();
      } catch (err) {
        console.error('Failed to initialize Panvas:', err);
        // Local-first: still show the app; the landing decision treats the
        // restore pass as settled and falls through to the Library.
        useWorkspaceStore.getState().markInitialDocumentRestoreComplete();
        setIsReady(true); // Show app anyway, it's local-first
      }
    }

    init();

  }, [loadWorkspaces, loadRecentFiles, loadTrash, initAuth]);

  useEffect(() => {
    if ((!CLOUD_SYNC_ENABLED && !CLOUD_SYNC_V2_ENABLED) || !isReady) return;
    const cloudSync = useCloudSyncStore.getState();
    void cloudSync.initialize();
    const updateConnectivity = () => useCloudSyncStore.getState().setConnectivity(navigator.onLine);
    updateConnectivity();
    window.addEventListener('online', updateConnectivity);
    window.addEventListener('offline', updateConnectivity);
    return () => {
      window.removeEventListener('online', updateConnectivity);
      window.removeEventListener('offline', updateConnectivity);
    };
  }, [isReady]);

  // Loading screen — Panvas brand mark, compact wordmark, one restrained
  // progress hairline. It renders only while bootstrap awaits and vanishes
  // as soon as `isReady` flips; no artificial delay is added.
  if (!isReady) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-panvas-bg-primary">
        <div className="flex flex-col items-center gap-3 animate-fade-in">
          <img src={PANVAS_LOGO_SRC} alt="" className="w-14 h-14 rounded-2xl shadow-glass-sm" aria-hidden="true" />
          <p className="text-sm font-semibold tracking-tight text-panvas-text-primary">Panvas</p>
          <div className="w-24 h-0.5 rounded-full bg-panvas-bg-tertiary overflow-hidden" aria-hidden="true">
            <div className="h-full w-2/5 rounded-full bg-panvas-text-secondary/70 animate-[slideInRight_1.4s_ease-in-out_infinite]" />
          </div>
          <p className="text-xs text-panvas-text-tertiary" role="status">Starting…</p>
        </div>
      </div>
    );
  }

  return (
      <Router hook={usePanvasLocation}>
      <AppRouteMemory />
      <Switch>
        {/* Normal Panvas builds open the workspace at the bare origin. The
            marketing shell remains available at /landing and is still the
            root only for explicitly marketing-only builds. */}
        <Route path="/">
          {import.meta.env.VITE_MARKETING_ONLY === 'true' ? <LandingPage /> : <Redirect to="/app/library" />}
        </Route>
        <Route path="/landing" component={LandingPage} />
        <Route path="/app/landing" component={LandingPage} />
        <Route path="/download" component={DownloadPage} />
        <Route path="/privacy" component={PrivacyPolicyPage} />
        <Route path="/terms" component={TermsOfServicePage} />
        <Route path="/security" component={SecurityPage} />
        <Route path="/roadmap" component={RoadmapPage} />
        {/* Auth routes */}
        <Route path="/auth/login"><React.Suspense fallback={<LegacyAuthFallback />}><LoginPage /></React.Suspense></Route>
        <Route path="/auth/signup"><React.Suspense fallback={<LegacyAuthFallback />}><SignUpPage /></React.Suspense></Route>
        <Route path="/auth/verify-email" component={VerifyEmailPage} />
        <Route path="/auth/forgot-password"><React.Suspense fallback={<LegacyAuthFallback />}><ForgotPasswordPage /></React.Suspense></Route>
        <Route path="/auth/reset-password"><React.Suspense fallback={<LegacyAuthFallback />}><ResetPasswordPage /></React.Suspense></Route>
        <Route path="/auth/callback" component={AuthCallbackHandler} />
        <Route path="/private-beta" component={ComingSoonPage} />
        <Route path="/app/settings/:tab*">
          <AuthGuard>
            <SettingsLayout />
          </AuthGuard>
        </Route>
        <Route path="/app/knowledge">
          <AuthGuard>
            <AppShell>
              <KnowledgeWorkspace />
            </AppShell>
          </AuthGuard>
        </Route>
        {HandwritingBenchmarkLab && <Route path="/app/dev/handwriting-benchmark">
          <AuthGuard>
            <React.Suspense fallback={null}>
              <HandwritingBenchmarkLab />
            </React.Suspense>
          </AuthGuard>
        </Route>}
        <Route path="/app/library">
          <AuthGuard>
            <AppShell>
              <ViewportErrorBoundary surface="Library workspace">
                <LibraryWorkspace />
              </ViewportErrorBoundary>
            </AppShell>
          </AuthGuard>
        </Route>
        <Route path="/app">
          <AuthGuard>
            <AppShell>
              <WorkspaceContent />
            </AppShell>
          </AuthGuard>
        </Route>
        <Route component={NotFoundPage} />
      </Switch>

      {/* Overlays */}
      <CommandPalette />
      <CreateDialog />
      <ContextMenu />
      <Toast />
      </Router>
  );
}
