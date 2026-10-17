import React from 'react';
import ReactDOM from 'react-dom/client';
import { Router, Route, Switch } from 'wouter';
import { usePanvasLocation, isPublicRoute, isDesktop, normalizeBrowserHash } from '@/lib/location';
import { LandingPage } from '@/components/marketing/LandingPage';
import { PrivacyPolicyPage } from '@/components/legal/PrivacyPolicyPage';
import { TermsOfServicePage } from '@/components/legal/TermsOfServicePage';
import { SecurityPage } from '@/components/legal/SecurityPage';
import { RoadmapPage } from '@/components/marketing/RoadmapPage';
import { DownloadPage } from '@/components/marketing/DownloadPage';
import { NotFoundPage } from '@/components/marketing/NotFoundPage';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { initAnalytics } from '@/lib/analytics';
import { applyThemeClasses, readAndMigrateTheme } from '@/lib/theme';
import '@/styles/index.css';

// The public page does not need editor engines, auth restoration, or sync startup.
// Keep the existing application intact and load it when the visitor enters it.
const WorkspaceApp = React.lazy(() => {
  return Promise.all([import('@/app/App'), import('@/styles/blocks.css'), import('@/styles/editor-fonts.css')])
    .then(([module]) => ({ default: module.App }));
});

function PublicSurface() {
  return (
    <Router hook={usePanvasLocation}>
      <Switch>
        <Route path="/download" component={DownloadPage} />
        <Route path="/privacy" component={PrivacyPolicyPage} />
        <Route path="/terms" component={TermsOfServicePage} />
        <Route path="/security" component={SecurityPage} />
        <Route path="/roadmap" component={RoadmapPage} />
        <Route path="/landing" component={LandingPage} />
        <Route path="/app/landing" component={LandingPage} />
        <Route path="/" component={LandingPage} />
        <Route component={NotFoundPage} />
      </Switch>
    </Router>
  );
}

function EntrySurface() {
  const [route] = usePanvasLocation();
  const isApp = isDesktop
    ? !isPublicRoute(route, true)
    : (route === '/app' || (route.startsWith('/app/') && route !== '/app/landing')) || route.startsWith('/auth') || route === '/private-beta';

  if (!isApp) {
    return <PublicSurface />;
  }
  return (
    <React.Suspense fallback={<div role="status" style={{ padding: 32 }}>Opening Panvas…</div>}>
      <WorkspaceApp />
    </React.Suspense>
  );
}

export function mountPanvas(): void {
  normalizeBrowserHash();
  // Apply the persisted theme before React paints. Restricted storage contexts
  // must still be able to start with the default theme.
  try {
    const theme = readAndMigrateTheme();
    applyThemeClasses(theme);
    void window.panvas?.settings?.setTheme(theme);
  } catch (error) {
    console.warn('[Panvas] Persisted theme is unavailable:', error);
  }

  initAnalytics();

  // In development and on localhost, ensure service workers never intercept Vite HMR or cache stale code.
  if ('serviceWorker' in navigator) {
    if (import.meta.env.DEV || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      void navigator.serviceWorker.getRegistrations().then(registrations => {
        for (const registration of registrations) {
          void registration.unregister();
        }
      });
      if ('caches' in window) {
        void caches.keys().then(keys => {
          for (const key of keys) {
            void caches.delete(key);
          }
        });
      }
    } else if (location.protocol === 'https:') {
      const registerOfflineShell = () => {
        void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`).catch(error => {
          console.warn('[Panvas] Offline shell registration failed:', error);
        });
      };
      if (document.readyState === 'complete') registerOfflineShell();
      else window.addEventListener('load', registerOfflineShell, { once: true });
    }
  }

  const root = document.getElementById('root');
  if (!root) throw new Error('Panvas root element is missing.');
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <EntrySurface />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
