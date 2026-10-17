import React from 'react';
import { createRoot } from 'react-dom/client';
import { Router, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { SettingsLayout } from '../../src/components/settings/SettingsLayout';
import { useAuthStore } from '../../src/stores/authStore';
import { useCloudSyncStore } from '../../src/stores/cloudSyncStore';
import { workspaceRepository } from '../../src/repositories/WorkspaceRepository';
import { canvasRepository } from '../../src/repositories/CanvasRepository';
import { notebookRepository } from '../../src/repositories/NotebookRepository';
import { StorageService } from '../../src/services/storage/StorageService';
import { applyThemeClasses, readAndMigrateTheme } from '../../src/lib/theme';
import '../../src/styles/index.css';

// Supported fixture states, never credentials or live Google Drive acceptance.
const connection = { provider: 'googledrive' as const, accountIdentifier: 'fixture-account', email: 'drive@example.test', connectedAt: 1 };
const readWorkspaces = workspaceRepository.getAll.bind(workspaceRepository);
useAuthStore.setState({ user: null, session: null, isAuthenticated: false, isLoading: false });
const fixture = {
  async seed() {
    for (let index = 0; index < 2; index++) {
      const workspace = await workspaceRepository.create(null, `Settings workspace ${index}`);
      for (let canvas = 0; canvas <= index; canvas++) await canvasRepository.create(null, workspace.id, null, null, null, `Canvas ${canvas}`);
      const notebook = await notebookRepository.create(null, workspace.id, null, 'Notebook');
      const section = await notebookRepository.createSection(null, workspace.id, notebook.id, 'Section');
      for (let page = 0; page < 2; page++) await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, `Page ${page}`);
    }
  },
  auth(kind: 'signed-out' | 'authenticated' | 'disconnected' | 'expired' | 'token-needed' | 'failure' | 'offline' | 'connecting') {
    const account = kind === 'authenticated';
    useAuthStore.setState({ user: account ? { id: 'fixture-user', email: 'panvas@example.test', user_metadata: { full_name: 'Settings fixture' }, app_metadata: { provider: 'google' }, created_at: '2026-01-01T00:00:00Z' } as any : null, isAuthenticated: account });
    const status = ({ 'signed-out': 'disconnected', authenticated: 'synced', disconnected: 'disconnected', expired: 'auth-expired', 'token-needed': 'token-needed', failure: 'error', offline: 'offline', connecting: 'connecting' } as const)[kind];
    useCloudSyncStore.setState(state => ({
      statusByProvider: { ...state.statusByProvider, googledrive: status },
      connectionByProvider: { ...state.connectionByProvider, googledrive: ['signed-out', 'disconnected', 'connecting'].includes(kind) ? null : connection },
      lastSyncedByProvider: { ...state.lastSyncedByProvider, googledrive: kind === 'signed-out' ? null : Date.UTC(2026, 9, 9) },
      lastError: kind === 'failure' ? 'Google Drive could not complete the last sync. Try again.' : null,
    }));
  },
  metrics: () => StorageService.getMetrics(),
  readFailure(enabled: boolean) {
    workspaceRepository.getAll = enabled ? async () => { throw new Error('fixture repository unavailable'); } : readWorkspaces;
  },
};
Object.assign(window, { settingsFixture: fixture });
applyThemeClasses(readAndMigrateTheme());
if (!location.hash.startsWith('#/app/settings/')) location.hash = '/app/settings/account';
function Surface() {
  const [route] = useLocation();
  return route.startsWith('/app/settings') ? <SettingsLayout /> : <main><h1>Fixture destination: {route}</h1><a href="#/app/settings/account">Settings</a></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Router hook={useHashLocation}><Surface /></Router></React.StrictMode>);
