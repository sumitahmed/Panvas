// ============================================
// Panvas — UI Store (Zustand)
// ============================================

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NotebookExportCommandTarget, PageExportCommandTarget, SectionExportCommandTarget } from '@/services/pdf/notebookExportTargets';
import {
  applyThemeClasses,
  readAndMigrateTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  FULL_DARK_VIEW_STORAGE_KEY,
  readFullDarkView,
  applyFullDarkViewClass,
  type PanvasTheme,
  type ResolvedTheme,
} from '@/lib/theme';

type ContextMenuExportTarget = NotebookExportCommandTarget | PageExportCommandTarget | SectionExportCommandTarget;

/** Stored theme + its resolved value, read once at store creation. */
function readStoredTheme(): { theme: PanvasTheme; resolved: ResolvedTheme } {
  const theme = readAndMigrateTheme();
  return { theme, resolved: theme };
}

const initialTheme = readStoredTheme();

interface UIState {
  // Sidebar
  isSidebarOpen: boolean;
  sidebarWidth: number;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;

  // Command palette
  isCommandPaletteOpen: boolean;
  toggleCommandPalette: () => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;

  // Modals
  isCreateDialogOpen: boolean;
  createDialogType: 'workspace' | 'folder' | 'notebook' | 'section' | 'page' | 'canvas' | null;
  createDialogParentId: string | null;
  createDialogParentType: 'folder' | 'notebook' | 'section' | null;
  openCreateDialog: (type: 'workspace' | 'folder' | 'notebook' | 'section' | 'page' | 'canvas', parentId?: string | null, parentType?: 'folder' | 'notebook' | 'section' | null) => void;
  closeCreateDialog: () => void;
  inlineCreate: { type: 'page' | 'canvas'; parentId: string | null; parentType: 'folder' | 'notebook' | 'section' | null } | null;
  closeInlineCreate: () => void;

  // Context menu
  contextMenu: {
    isOpen: boolean;
    x: number;
    y: number;
    targetId: string | null;
    targetType: 'workspace' | 'folder' | 'notebook' | 'section' | 'page' | 'canvas' | null;
    exportTarget: ContextMenuExportTarget | null;
  };
  openContextMenu: (x: number, y: number, targetId: string, targetType: 'workspace' | 'folder' | 'notebook' | 'section' | 'page' | 'canvas', exportTarget?: ContextMenuExportTarget | null) => void;
  closeContextMenu: () => void;

  // Rename
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;

  // Toast notifications
  toast: { message: string; type: 'info' | 'success' | 'error' } | null;
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void;
  clearToast: () => void;

  // Cloud Sync review deep-link. This is transient UI intent, not persisted
  // user data; it lets the top-bar action focus the review section after the
  // library route mounts.
  cloudSyncReviewRequested: boolean;
  requestCloudSyncReview: () => void;
  clearCloudSyncReviewRequest: () => void;

  // Theme
  theme: PanvasTheme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: PanvasTheme) => void;
  fullDarkView: boolean;
  isFullDarkViewChoiceOpen: boolean;
  isPrinting: boolean;
  setFullDarkView: (enabled: boolean) => void;

  // New UI states
  // Deprecated: use layoutStore instead
  // isFullscreen: boolean;
  // toggleFullscreen: () => void;
  isPropertiesPanelOpen: boolean;
  togglePropertiesPanel: () => void;
  // Wall-clock ms of the last explicit panel toggle. The notebook renderer
  // auto-closes the properties drawer when the notebook area gets too narrow
  // to hold it plus the minimal toolbar; this timestamp gives explicit user
  // opens a grace period so the auto-close never fights the user.
  lastPropertiesPanelToggleAt: number;
  isToolbarExpanded: boolean;
  toggleToolbar: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
  // Sidebar
  isSidebarOpen: true,
  sidebarWidth: 280,
  toggleSidebar: () => set(s => ({ isSidebarOpen: !s.isSidebarOpen })),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(220, Math.min(480, width)) }),

  // Command palette
  isCommandPaletteOpen: false,
  toggleCommandPalette: () => set(s => ({ isCommandPaletteOpen: !s.isCommandPaletteOpen })),
  openCommandPalette: () => set({ isCommandPaletteOpen: true }),
  closeCommandPalette: () => set({ isCommandPaletteOpen: false }),

  // Create dialog
  isCreateDialogOpen: false,
  createDialogType: null,
  createDialogParentId: null,
  createDialogParentType: null,
  inlineCreate: null,
  openCreateDialog: (type, parentId = null, parentType = null) => type === 'page' || type === 'canvas'
    ? set({ isSidebarOpen: true, isCreateDialogOpen: false, createDialogType: null, createDialogParentId: null, createDialogParentType: null, inlineCreate: { type, parentId, parentType } })
    : set({ isCreateDialogOpen: true, createDialogType: type, createDialogParentId: parentId, createDialogParentType: parentType, inlineCreate: null }),
  closeCreateDialog: () => set({ isCreateDialogOpen: false, createDialogType: null, createDialogParentId: null, createDialogParentType: null }),
  closeInlineCreate: () => set({ inlineCreate: null }),

  // Context menu

  // Context menu
  contextMenu: {
    isOpen: false,
    x: 0,
    y: 0,
    targetId: null,
    targetType: null,
    exportTarget: null,
  },
  openContextMenu: (x, y, targetId, targetType, exportTarget = null) => set({
    contextMenu: { isOpen: true, x, y, targetId, targetType, exportTarget },
  }),
  closeContextMenu: () => set({
    contextMenu: { isOpen: false, x: 0, y: 0, targetId: null, targetType: null, exportTarget: null },
  }),

  // Rename
  renamingId: null,
  setRenamingId: (id) => set({ renamingId: id }),

  // Toast
  toast: null,
  showToast: (message, type = 'info') => {
    set({ toast: { message, type } });
    setTimeout(() => {
      if (get().toast?.message === message) {
        set({ toast: null });
      }
    }, 3000);
  },
  clearToast: () => set({ toast: null }),

  cloudSyncReviewRequested: false,
  requestCloudSyncReview: () => set({ cloudSyncReviewRequested: true }),
  clearCloudSyncReviewRequest: () => set({ cloudSyncReviewRequested: false }),

  // Theme
  theme: initialTheme.theme,
  resolvedTheme: initialTheme.resolved,
  fullDarkView: readFullDarkView(),
  isFullDarkViewChoiceOpen: false,
  isPrinting: false,
  setFullDarkView: (enabled) => {
    try { localStorage.setItem(FULL_DARK_VIEW_STORAGE_KEY, String(enabled)); } catch { /* Session preference still works. */ }
    set({ fullDarkView: enabled, isFullDarkViewChoiceOpen: false });
    applyFullDarkViewClass(get().theme, enabled && !get().isPrinting);
  },
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Persisting is best-effort; the session theme still applies.
    }
    const resolvedTheme = resolveTheme(theme);
    const enteringDark = get().theme !== 'dark' && theme === 'dark';
    set({ theme, resolvedTheme, isFullDarkViewChoiceOpen: enteringDark });
    applyThemeClasses(resolvedTheme, get().fullDarkView && !get().isPrinting);

    if (typeof window !== 'undefined' && window.panvas?.settings?.setTheme) {
      window.panvas.settings.setTheme(resolvedTheme);
    }
  },

  // New UI States
  // isFullscreen: false,
  // toggleFullscreen: () => set(s => ({ isFullscreen: !s.isFullscreen })),
    isPropertiesPanelOpen: false,
  lastPropertiesPanelToggleAt: 0,
  togglePropertiesPanel: () => set(s => ({
    isPropertiesPanelOpen: !s.isPropertiesPanelOpen,
    lastPropertiesPanelToggleAt: Date.now(),
  })),
  isToolbarExpanded: true,
  toggleToolbar: () => set(s => ({ isToolbarExpanded: !s.isToolbarExpanded })),
}),
{
  name: 'panvas-ui-store',
  partialize: (state) => ({
    isSidebarOpen: state.isSidebarOpen,
    sidebarWidth: state.sidebarWidth,
    isPropertiesPanelOpen: state.isPropertiesPanelOpen,
    isToolbarExpanded: state.isToolbarExpanded,
  }),
}));
