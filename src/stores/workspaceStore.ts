// ============================================
// Panvas — Workspace Store (Zustand)
// Uses Repository layer for all operations
// ============================================

import { create } from 'zustand';
import type { Workspace, Folder, CanvasFile } from '@/types/workspace';
import type { Notebook, NotebookPage, NotebookSection, NotebookCover, PagePropertySet, PageTemplateId as PageTemplate } from '@/types/notebook';
import { workspaceRepository } from '@/repositories/WorkspaceRepository';
import { folderRepository } from '@/repositories/FolderRepository';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { notebookRepository } from '@/repositories/NotebookRepository';
import { useAuthStore } from './authStore';
import { useNotebookSettingsStore } from './notebookSettingsStore';
import { createDefaultDrawingData } from '@/components/notebook/engine/drawingTypes';
import { recordLocalChangeDetached, type LocalChangeRecord } from '@/services/cloudsync/recordLocalChange';
import { purgeEligibleRoots } from '@/services/cloudsync/trash';
import type { SyncEntityKind } from '@/services/cloudsync/types';
import type { PanvasBootstrapSnapshot } from '@/types/bootstrap';
import { getNextGeneratedPageTitle, isGeneratedPagePlaceholder } from '@/lib/notebookPageNaming';
import { computeSectionRenumbering } from '@/lib/notebookPageRenumbering';
import { cancelQueuedPageDrawing } from '@/components/notebook/drawingPersistenceQueue';
import { derivePagePropertyOverrides, getNotebookPageDefaults } from '@/lib/pageProperties';
import { generateId } from '@/lib/utils/id';
import { getNotebookPosition } from '@/lib/readingPosition';

export interface NewDocumentPageOptions {
  layoutMode?: 'document' | 'freeform';
  pageSize?: PagePropertySet['pageSize'];
  orientation?: 'portrait' | 'landscape';
  paperColor?: string;
  template?: PageTemplate;
  ruleLineColor?: string;
  margins?: PagePropertySet['margins'];
  infiniteWidth?: number;
  titleProvenance?: 'default' | 'custom';
  insertAfterPageId?: string;
}

const ACTIVE_WORKSPACE_KEY = 'panvas.activeWorkspaceId';
const ACTIVE_CANVAS_KEY = 'panvas.activeCanvasId';
const ACTIVE_PAGE_KEY = 'panvas.activePageId';

/**
 * Cloud Sync Phase 1 journaling: local save first, journal second (detached,
 * never throws into editing). Payloads are metadata representations only.
 */
function journalChange(change: LocalChangeRecord): void {
  recordLocalChangeDetached(change);
}

// Canonical reloads can overlap during startup, workspace changes, and
// mutations. Only the newest request in each stream may publish a snapshot.
let workspaceLoadSequence = 0;
let contentLoadSequence = 0;
let recentLoadSequence = 0;
let trashLoadSequence = 0;
let isSweepingTrash = false;
let pendingBootstrapSnapshot: PanvasBootstrapSnapshot | null = null;
let pendingBootstrapWorkspaceId: string | null = null;

function readStoredId(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredId(key: string, value: string | null): void {
  try {
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

interface WorkspaceState {
  // Data
  workspaces: Workspace[];
  folders: Folder[];
  canvasFiles: CanvasFile[];
  notebooks: Notebook[];
  notebookSections: NotebookSection[];
  notebookPages: NotebookPage[];
  recentFiles: CanvasFile[];
  
  // Trash
  deletedWorkspaces: Workspace[];
  deletedFolders: Folder[];
  deletedCanvases: CanvasFile[];
  deletedNotebooks: Notebook[];
  deletedSections: NotebookSection[];
  deletedPages: NotebookPage[];

  // Selection
  activeWorkspaceId: string | null;
  activeCanvasId: string | null;
  activePageId: string | null;
  activeNotebookId: string | null;
  activeNotebookSectionId: string | null;
  expandedWorkspaceIds: Set<string>;

  // Loading
  isLoading: boolean;

  // Startup. True once the bootstrap pass has finished loading the canonical
  // workspace contents and restoring the persisted active document, so the
  // /app → Library fallback may trust null active ids.
  initialDocumentRestoreComplete: boolean;

  // Actions
  loadWorkspaces: () => Promise<PanvasBootstrapSnapshot | null>;
  loadWorkspaceContents: (workspaceId: string) => Promise<void>;
  loadRecentFiles: () => Promise<void>;
  markInitialDocumentRestoreComplete: () => void;
  setActiveWorkspace: (id: string | null) => Promise<void>;
  setActiveCanvas: (id: string | null, recordOpen?: boolean) => Promise<void>;
  setActivePage: (id: string | null, recordOpen?: boolean) => Promise<void>;
  setActiveNotebook: (id: string | null) => Promise<void>;
  setActiveNotebookSection: (id: string | null) => Promise<void>;
  toggleWorkspaceExpanded: (id: string) => void;
  expandWorkspace: (id: string) => void;
  reset: () => void;
  
  // Trash Actions
  loadTrash: () => Promise<void>;
  restoreItem: (id: string, type: 'workspace' | 'folder' | 'canvas' | 'notebook' | 'section' | 'page') => Promise<void>;
  permanentlyDeleteItem: (id: string, type: 'workspace' | 'folder' | 'canvas' | 'notebook' | 'section' | 'page') => Promise<void>;
  permanentlyDeleteAllTrash: () => Promise<{ deleted: number; failed: number }>;
  sweepExpiredTrash: () => Promise<number>;

  // CRUD
  createWorkspace: (name: string) => Promise<Workspace>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  togglePinWorkspace: (id: string) => Promise<void>;

  createFolder: (parentId: string | null, name: string) => Promise<Folder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  updateFolderAppearance: (id: string, appearance: Pick<Folder, 'color' | 'icon'>) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  toggleFolderExpanded: (id: string) => Promise<void>;
  moveFolder: (id: string, newWorkspaceId: string, newParentId?: string | null) => Promise<void>;

  createCanvas: (folderId: string | null, notebookId: string | null, sectionId: string | null, name: string) => Promise<CanvasFile>;
  renameCanvas: (id: string, name: string) => Promise<void>;
  deleteCanvas: (id: string) => Promise<void>;
  togglePinCanvas: (id: string) => Promise<void>;
  duplicateCanvas: (id: string) => Promise<CanvasFile | null>;
  moveCanvas: (id: string, newWorkspaceId: string, newFolderId: string | null, newNotebookId: string | null, newSectionId: string | null) => Promise<void>;

  createNotebook: (folderId: string | null, name: string, cover?: NotebookCover, template?: PageTemplate) => Promise<Notebook>;
  createNotebookSection: (notebookId: string, name: string) => Promise<NotebookSection>;
  createNotebookPage: (sectionId: string, title: string, options?: NewDocumentPageOptions) => Promise<NotebookPage>;
  reorderPages: (itemIds: string[]) => Promise<void>;
  toggleNotebookExpanded: (id: string) => Promise<void>;
  toggleNotebookSectionExpanded: (id: string) => Promise<void>;
  togglePinNotebook: (id: string) => Promise<void>;
  renameNotebook: (id: string, name: string) => Promise<void>;
  updateNotebookCover: (id: string, cover: NotebookCover) => Promise<void>;
  renameNotebookSection: (id: string, name: string) => Promise<void>;
  renameNotebookPage: (id: string, title: string) => Promise<void>;
  deleteNotebook: (id: string) => Promise<void>;
  deleteNotebookSection: (id: string) => Promise<void>;
  deleteNotebookPage: (id: string) => Promise<void>;
  moveNotebook: (id: string, newWorkspaceId: string, newFolderId: string | null) => Promise<void>;
  moveNotebookSection: (id: string, newWorkspaceId: string, newNotebookId: string) => Promise<void>;
  moveNotebookPage: (id: string, newWorkspaceId: string, newSectionId: string) => Promise<void>;
  reorderItems: (type: 'folder' | 'notebook' | 'canvas' | 'section' | 'page', itemIds: string[]) => Promise<void>;
}

function getExpandedWorkspaces(): Set<string> {
  try {
    const stored = window.localStorage.getItem('panvas.expandedWorkspaces');
    if (stored) return new Set(JSON.parse(stored));
  } catch {}
  return new Set();
}

function saveExpandedWorkspaces(set: Set<string>) {
  try {
    window.localStorage.setItem('panvas.expandedWorkspaces', JSON.stringify(Array.from(set)));
  } catch {}
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  folders: [],
  canvasFiles: [],
  notebooks: [],
  notebookSections: [],
  notebookPages: [],
  recentFiles: [],
  deletedWorkspaces: [],
  deletedFolders: [],
  deletedCanvases: [],
  deletedNotebooks: [],
  deletedSections: [],
  deletedPages: [],
  activeWorkspaceId: null,
  activeCanvasId: null,
  activePageId: null,
  activeNotebookId: null,
  activeNotebookSectionId: null,
  expandedWorkspaceIds: getExpandedWorkspaces(),
  isLoading: true,
  initialDocumentRestoreComplete: false,

  markInitialDocumentRestoreComplete: () => {
    set({ initialDocumentRestoreComplete: true });
  },

  reset: () => {
    workspaceLoadSequence += 1;
    contentLoadSequence += 1;
    recentLoadSequence += 1;
    trashLoadSequence += 1;
    pendingBootstrapSnapshot = null;
    pendingBootstrapWorkspaceId = null;
    set({
      workspaces: [],
      folders: [],
      canvasFiles: [],
      notebooks: [],
      notebookSections: [],
      notebookPages: [],
      recentFiles: [],
      deletedWorkspaces: [],
      deletedFolders: [],
      deletedCanvases: [],
      deletedNotebooks: [],
      deletedSections: [],
      deletedPages: [],
      activeWorkspaceId: null,
      activeCanvasId: null,
      activePageId: null,
      activeNotebookId: null,
      activeNotebookSectionId: null,
      expandedWorkspaceIds: new Set(),
      isLoading: true,
    });
  },

  loadWorkspaces: async () => {
    const requestId = ++workspaceLoadSequence;
    set({ isLoading: true });
    const userId = useAuthStore.getState().user?.id ?? null;
    let snapshot: PanvasBootstrapSnapshot | null = null;
    const bootstrapApi = typeof window !== 'undefined' ? window.panvas?.bootstrap : undefined;

    if (bootstrapApi) {
      try {
        snapshot = await bootstrapApi.getSnapshot();
      } catch (error) {
        // A failed snapshot must not clear an already loaded projection. Fall
        // back to the pre-existing repository reads, which remain safe and
        // keep browser mode entirely unchanged.
        console.warn('[WorkspaceStore] Desktop bootstrap snapshot unavailable; using fallback reads.', error);
      }
    }

    const data = snapshot ?? await (async () => {
      const [workspaces, folders, canvasFiles, notebooks, notebookSections, notebookPages] = await Promise.all([
        workspaceRepository.getAll(userId),
        folderRepository.getAll(userId),
        canvasRepository.getAll(userId),
        notebookRepository.getAll(userId),
        notebookRepository.getSections(userId),
        notebookRepository.getPages(userId),
      ]);
      return { workspaces, folders, canvasFiles, notebooks, notebookSections, notebookPages };
    })();
    if (requestId !== workspaceLoadSequence) return snapshot;

    const currentActiveId = get().activeWorkspaceId;
    const storedWorkspaceId = readStoredId(ACTIVE_WORKSPACE_KEY);
    const activeWorkspaceId = data.workspaces.some(item => item.id === currentActiveId)
      ? currentActiveId
      : data.workspaces.find(item => item.id === storedWorkspaceId)?.id ?? data.workspaces[0]?.id ?? null;
    if (snapshot) {
      // The startup snapshot can serve startup reads only. A later workspace
      // refresh (including deferred legacy import) must not cache mutable
      // metadata across creations and edits.
      pendingBootstrapSnapshot = get().initialDocumentRestoreComplete ? null : snapshot;
      pendingBootstrapWorkspaceId = pendingBootstrapSnapshot ? activeWorkspaceId : null;
      useNotebookSettingsStore.getState().hydrateSettings(snapshot.settings);
    } else {
      pendingBootstrapSnapshot = null;
      pendingBootstrapWorkspaceId = null;
    }
    set({
      workspaces: data.workspaces,
      folders: data.folders,
      canvasFiles: data.canvasFiles,
      notebooks: data.notebooks,
      notebookSections: data.notebookSections,
      notebookPages: data.notebookPages,
      activeWorkspaceId,
      isLoading: false,
    });
    writeStoredId(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
    if (activeWorkspaceId) get().expandWorkspace(activeWorkspaceId);
    return snapshot;
  },

  loadWorkspaceContents: async (workspaceId: string) => {
    const requestId = ++contentLoadSequence;
    if (pendingBootstrapSnapshot && pendingBootstrapWorkspaceId === workspaceId) {
      const snapshot = pendingBootstrapSnapshot;
      if (requestId !== contentLoadSequence) return;
      set({
        folders: snapshot.folders,
        canvasFiles: snapshot.canvasFiles,
        notebooks: snapshot.notebooks,
        notebookSections: snapshot.notebookSections,
        notebookPages: snapshot.notebookPages,
      });
      const storedCanvasId = readStoredId(ACTIVE_CANVAS_KEY);
      const storedPageId = readStoredId(ACTIVE_PAGE_KEY);
      const activeCanvasId = get().activeCanvasId;
      const activePageId = get().activePageId;
      if (!activeCanvasId && !activePageId && storedCanvasId && snapshot.canvasFiles.some(canvas => canvas.id === storedCanvasId && canvas.workspaceId === workspaceId)) {
        await get().setActiveCanvas(storedCanvasId, false);
      } else if (!activeCanvasId && !activePageId && storedPageId) {
        const storedPage = snapshot.notebookPages.find(page => page.id === storedPageId);
        const owner = storedPage ? snapshot.notebooks.find(notebook => notebook.id === storedPage.notebookId) : undefined;
        if (owner?.workspaceId === workspaceId) await get().setActivePage(storedPageId, false);
      }
      return;
    }
    const userId = useAuthStore.getState().user?.id ?? null;
    const [folders, canvasFiles, notebooks, notebookSections, notebookPages] = await Promise.all([
      folderRepository.getAll(userId),
      canvasRepository.getAll(userId),
      notebookRepository.getAll(userId),
      notebookRepository.getSections(userId),
      notebookRepository.getPages(userId),
    ]);
    if (requestId !== contentLoadSequence) return;
    set({ folders, canvasFiles, notebooks, notebookSections, notebookPages });

    const storedCanvasId = readStoredId(ACTIVE_CANVAS_KEY);
    const storedPageId = readStoredId(ACTIVE_PAGE_KEY);
    const activeCanvasId = get().activeCanvasId;
    const activePageId = get().activePageId;

    if (!activeCanvasId && !activePageId && storedCanvasId && canvasFiles.some(canvas => canvas.id === storedCanvasId && canvas.workspaceId === workspaceId)) {
      await get().setActiveCanvas(storedCanvasId, false);
    } else if (!activeCanvasId && !activePageId && storedPageId) {
      const storedPage = notebookPages.find(page => page.id === storedPageId);
      const owner = storedPage ? notebooks.find(notebook => notebook.id === storedPage.notebookId) : undefined;
      if (owner?.workspaceId === workspaceId) await get().setActivePage(storedPageId, false);
    }
  },

  loadRecentFiles: async () => {
    const requestId = ++recentLoadSequence;
    if (pendingBootstrapSnapshot) {
      if (requestId === recentLoadSequence) set({ recentFiles: pendingBootstrapSnapshot.recentFiles });
      return;
    }
    const userId = useAuthStore.getState().user?.id ?? null;
    const recentFiles = await canvasRepository.getRecent(userId, 8);
    if (requestId !== recentLoadSequence) return;
    set({ recentFiles });
  },

  setActiveWorkspace: async (id: string | null) => {
    set({ activeWorkspaceId: id });
    writeStoredId(ACTIVE_WORKSPACE_KEY, id);
    if (id) {
      await Promise.all([get().loadWorkspaceContents(id), get().loadTrash()]);
    }
  },

  expandWorkspace: (id: string) => {
    set(state => {
      const nextSet = new Set(state.expandedWorkspaceIds);
      nextSet.add(id);
      saveExpandedWorkspaces(nextSet);
      return { expandedWorkspaceIds: nextSet };
    });
  },

  toggleWorkspaceExpanded: (id: string) => {
    set(state => {
      const nextSet = new Set(state.expandedWorkspaceIds);
      if (nextSet.has(id)) {
        // If it's the active workspace, we might not want to let them collapse it,
        // but Notion lets you collapse everything. Let's just toggle.
        nextSet.delete(id);
      } else {
        nextSet.add(id);
      }
      saveExpandedWorkspaces(nextSet);
      return { expandedWorkspaceIds: nextSet };
    });
  },

  setActiveCanvas: async (id: string | null, recordOpen = true) => {
    const previousWorkspaceId = get().activeWorkspaceId;
    const canvas = id
      ? get().canvasFiles.find(c => c.id === id) ?? get().recentFiles.find(c => c.id === id)
      : null;

    set({
      activeCanvasId: id,
      activePageId: null,
      activeNotebookId: null,
      activeWorkspaceId: canvas?.workspaceId ?? get().activeWorkspaceId,
    });
    writeStoredId(ACTIVE_CANVAS_KEY, id);

    if (canvas?.workspaceId && canvas.workspaceId !== previousWorkspaceId) {
      writeStoredId(ACTIVE_WORKSPACE_KEY, canvas.workspaceId);
      await get().loadWorkspaceContents(canvas.workspaceId);
    }

    if (id && canvas && recordOpen) {
      const now = Date.now();
      await canvasRepository.updateLastOpened(canvas.workspaceId, id, now);
      set(state => ({
        canvasFiles: state.canvasFiles.map(c => c.id === id ? { ...c, lastOpenedAt: now } : c),
        recentFiles: state.recentFiles.map(c => c.id === id ? { ...c, lastOpenedAt: now } : c),
      }));
      await get().loadRecentFiles();
    }
  },

  setActivePage: async (id: string | null, recordOpen = true) => {
    const page = id ? get().notebookPages.find(item => item.id === id) : null;
    const notebook = page ? get().notebooks.find(item => item.id === page.notebookId) : null;
    const wsId = notebook?.workspaceId ?? get().activeWorkspaceId;

    set({
      activePageId: id,
      activeCanvasId: null,
      activeNotebookId: notebook?.id ?? get().activeNotebookId,
      activeNotebookSectionId: page?.sectionId ?? get().activeNotebookSectionId,
      activeWorkspaceId: wsId,
    });
    writeStoredId(ACTIVE_PAGE_KEY, id);
    writeStoredId(ACTIVE_CANVAS_KEY, null);
    if (notebook?.workspaceId) writeStoredId(ACTIVE_WORKSPACE_KEY, notebook.workspaceId);
    if (page && notebook && wsId && recordOpen) {
      const now = Date.now();
      await Promise.all([
        notebookRepository.updateLastOpened(wsId, notebook.id, now),
        notebookRepository.updatePageLastOpened(wsId, page.id, now),
      ]);
      set(state => ({
        notebooks: state.notebooks.map(item => item.id === notebook.id ? { ...item, lastOpenedAt: now } : item),
        notebookPages: state.notebookPages.map(item => item.id === page.id ? { ...item, lastOpenedAt: now } : item),
      }));
    }
  },

  setActiveNotebook: async (id: string | null) => {
    if (!id) {
      set({ activeNotebookId: null, activeNotebookSectionId: null });
      return;
    }
    const notebook = get().notebooks.find(item => item.id === id);
    if (!notebook) return;
    const wsId = notebook.workspaceId;
    set({ activeNotebookId: id, activeNotebookSectionId: null, activeWorkspaceId: wsId });
    writeStoredId(ACTIVE_WORKSPACE_KEY, wsId);
    const pages = get().notebookPages
      .filter(page => page.notebookId === id && !page.deletedAt)
      .sort((left, right) => left.order - right.order);
    if (pages.length > 0) {
      const saved = getNotebookPosition(id);
      const targetPage = (saved && pages.find(p => p.id === saved.pageId)) || pages[0];
      await get().setActivePage(targetPage.id);
    } else {
      const now = Date.now();
      await notebookRepository.updateLastOpened(wsId, id, now);
      set(state => ({ notebooks: state.notebooks.map(item => item.id === id ? { ...item, lastOpenedAt: now } : item) }));
    }
  },

  setActiveNotebookSection: async (id: string | null) => {
    if (!id) {
      set({ activeNotebookSectionId: null, activePageId: null });
      writeStoredId(ACTIVE_PAGE_KEY, null);
      return;
    }
    const section = get().notebookSections.find(item => item.id === id);
    const notebook = section ? get().notebooks.find(item => item.id === section.notebookId) : undefined;
    if (!section || !notebook) return;

    const pages = get().notebookPages
      .filter(page => page.sectionId === id && !page.deletedAt)
      .sort((left, right) => left.order - right.order);
    const targetPage = pages[0] ?? null;

    set({
      activeNotebookSectionId: id,
      activeNotebookId: section.notebookId,
      activeWorkspaceId: notebook.workspaceId,
      activePageId: targetPage?.id ?? null,
      activeCanvasId: null,
    });
    writeStoredId(ACTIVE_PAGE_KEY, targetPage?.id ?? null);
    writeStoredId(ACTIVE_CANVAS_KEY, null);
    writeStoredId(ACTIVE_WORKSPACE_KEY, notebook.workspaceId);

    if (targetPage) {
      await get().setActivePage(targetPage.id);
    } else {
      const now = Date.now();
      await notebookRepository.updateLastOpened(notebook.workspaceId, notebook.id, now);
      set(state => ({ notebooks: state.notebooks.map(item => item.id === notebook.id ? { ...item, lastOpenedAt: now } : item) }));
    }
  },

  // ---- Trash Actions ----
  loadTrash: async () => {
    const requestId = ++trashLoadSequence;
    const userId = useAuthStore.getState().user?.id ?? null;
    const wsId = get().activeWorkspaceId;
    if (pendingBootstrapSnapshot) {
      const snapshot = pendingBootstrapSnapshot;
      if (requestId !== trashLoadSequence) return;
      set({
        deletedWorkspaces: snapshot.trash.workspaces as Workspace[],
        deletedFolders: snapshot.trash.folders as Folder[],
        deletedCanvases: snapshot.trash.canvasFiles as CanvasFile[],
        deletedNotebooks: snapshot.trash.notebooks as Notebook[],
        deletedSections: snapshot.trash.sections as NotebookSection[],
        deletedPages: snapshot.trash.pages as NotebookPage[],
      });
      pendingBootstrapSnapshot = null;
      pendingBootstrapWorkspaceId = null;
      void get().sweepExpiredTrash();
      return;
    }
    let roots;
    try {
      if (typeof window !== 'undefined' && window.panvas) {
        const trash = await window.panvas.trash.getAll(null);
        roots = {
          workspaces: trash.workspaces,
          folders: trash.folders,
          canvasFiles: trash.canvasFiles,
          notebooks: trash.notebooks,
          sections: trash.sections,
          pages: trash.pages,
        };
      } else {
        roots = await import('@/database/workspaceDB').then(module => module.getDeletedItems(userId));
      }
    } catch (error) {
      // A failed read must not masquerade as an empty Trash and erase a newer
      // canonical projection from memory.
      if (requestId === trashLoadSequence) console.warn('[WorkspaceStore] Could not refresh Trash:', error);
      return;
    }
    if (requestId !== trashLoadSequence || wsId !== get().activeWorkspaceId) return;
    if (requestId !== trashLoadSequence) return;

    const notebookById = new Map([...get().notebooks, ...roots.notebooks].map(item => [item.id, item]));
    const sectionById = new Map([...get().notebookSections, ...roots.sections].map(item => [item.id, item]));
    const inWorkspace = (record: { workspaceId?: string | null; notebookId?: string | null; sectionId?: string | null }) => {
      if (!wsId) return false;
      if (record.workspaceId) return record.workspaceId === wsId;
      if (record.notebookId) return notebookById.get(record.notebookId)?.workspaceId === wsId;
      if (record.sectionId) {
        const section = sectionById.get(record.sectionId);
        return section ? notebookById.get(section.notebookId ?? '')?.workspaceId === wsId : false;
      }
      return false;
    };

    set({
      deletedWorkspaces: roots.workspaces as Workspace[],
      deletedFolders: roots.folders as Folder[],
      deletedCanvases: roots.canvasFiles as CanvasFile[],
      deletedNotebooks: roots.notebooks as Notebook[],
      deletedSections: roots.sections as NotebookSection[],
      deletedPages: roots.pages as NotebookPage[],
    });
    // 30-day retention sweep (detached — never delays the Trash projection).
    void get().sweepExpiredTrash();
  },

  restoreItem: async (id: string, type: 'workspace' | 'folder' | 'canvas' | 'notebook' | 'section' | 'page') => {
    const userId = useAuthStore.getState().user?.id ?? null;
    const state = get();
    const allNotebooks = [...state.notebooks, ...state.deletedNotebooks];
    const allSections = [...state.notebookSections, ...state.deletedSections];
    const allFolders = [...state.folders, ...state.deletedFolders];
    const notebookById = new Map(allNotebooks.map(item => [item.id, item]));
    const sectionById = new Map(allSections.map(item => [item.id, item]));

    let wsId: string | null | undefined;
    let parentFolderId: string | null | undefined;
    let parentNotebookId: string | null | undefined;
    let parentSectionId: string | null | undefined;

    if (type === 'workspace') {
      wsId = id;
    } else if (type === 'folder') {
      const folder = allFolders.find(item => item.id === id);
      wsId = folder?.workspaceId;
      parentFolderId = folder?.parentId;
    } else if (type === 'canvas') {
      const canvas = [...state.canvasFiles, ...state.deletedCanvases].find(item => item.id === id);
      wsId = canvas?.workspaceId;
      parentFolderId = canvas?.folderId;
    } else if (type === 'notebook') {
      const notebook = notebookById.get(id);
      wsId = notebook?.workspaceId;
      parentFolderId = notebook?.folderId;
    } else if (type === 'section') {
      const section = sectionById.get(id);
      parentNotebookId = section?.notebookId;
      const notebook = parentNotebookId ? notebookById.get(parentNotebookId) : undefined;
      wsId = notebook?.workspaceId;
      parentFolderId = notebook?.folderId;
    } else if (type === 'page') {
      const page = [...state.notebookPages, ...state.deletedPages].find(item => item.id === id);
      parentNotebookId = page?.notebookId;
      parentSectionId = page?.sectionId;
      const notebook = parentNotebookId ? notebookById.get(parentNotebookId) : undefined;
      wsId = notebook?.workspaceId;
      parentFolderId = notebook?.folderId;
    }

    if (!wsId && type !== 'workspace') {
      wsId = state.activeWorkspaceId;
    }

    // Gracefully restore parent chain if parents are also deleted
    if (wsId && state.deletedWorkspaces.some(w => w.id === wsId)) {
      await workspaceRepository.restore(userId, wsId);
      await get().loadWorkspaces();
    }
    if (parentFolderId && wsId && state.deletedFolders.some(f => f.id === parentFolderId)) {
      await folderRepository.restore(userId, wsId, parentFolderId);
    }
    if (parentNotebookId && wsId && state.deletedNotebooks.some(n => n.id === parentNotebookId)) {
      await notebookRepository.restoreEntity(wsId, parentNotebookId, 'notebook');
    }
    if (parentSectionId && wsId && state.deletedSections.some(s => s.id === parentSectionId)) {
      await notebookRepository.restoreEntity(wsId, parentSectionId, 'section');
    }

    if (type === 'workspace') {
      await workspaceRepository.restore(userId, id);
      await get().loadWorkspaces();
    } else if (type === 'folder' && wsId) {
      await folderRepository.restore(userId, wsId, id);
      await get().loadWorkspaceContents(wsId);
    } else if (type === 'canvas' && wsId) {
      await canvasRepository.restore(wsId, id);
      await get().loadWorkspaceContents(wsId);
      await get().loadRecentFiles();
    } else if ((type === 'notebook' || type === 'section' || type === 'page') && wsId) {
      await notebookRepository.restoreEntity(wsId, id, type);
      await get().loadWorkspaceContents(wsId);
    }
    const restoredKind = type === 'section' ? 'notebookSection' : type === 'page' ? 'notebookPage' : type === 'canvas' ? 'canvasFile' : type;
    if (wsId || type === 'workspace') {
      journalChange({ entityType: restoredKind, entityId: id, workspaceId: wsId ?? id, operation: 'restore' });
    }
    await get().loadTrash();
  },

  permanentlyDeleteItem: async (id: string, type: 'workspace' | 'folder' | 'canvas' | 'notebook' | 'section' | 'page') => {
    const userId = useAuthStore.getState().user?.id ?? null;
    const state = get();
    const allNotebooks = [...state.notebooks, ...state.deletedNotebooks];
    const allSections = [...state.notebookSections, ...state.deletedSections];
    const notebookById = new Map(allNotebooks.map(item => [item.id, item]));
    const sectionById = new Map(allSections.map(item => [item.id, item]));
    const wsId =
      type === 'workspace'
        ? id
        : type === 'folder'
          ? [...state.folders, ...state.deletedFolders].find(item => item.id === id)?.workspaceId
          : type === 'canvas'
            ? [...state.canvasFiles, ...state.deletedCanvases].find(item => item.id === id)?.workspaceId
            : type === 'notebook'
              ? notebookById.get(id)?.workspaceId
              : type === 'section'
                ? notebookById.get(sectionById.get(id)?.notebookId ?? '')?.workspaceId
                : type === 'page'
                  ? notebookById.get([...state.notebookPages, ...state.deletedPages].find(item => item.id === id)?.notebookId ?? '')?.workspaceId
                  : state.activeWorkspaceId;

    if (type === 'workspace') {
      await workspaceRepository.permanentlyDelete(id);
    } else if (type === 'folder' && wsId) {
      await folderRepository.permanentlyDelete(userId, wsId, id);
    } else if (type === 'canvas' && wsId) {
      await canvasRepository.permanentlyDelete(wsId, id);
    } else if ((type === 'notebook' || type === 'section' || type === 'page') && wsId) {
      await notebookRepository.permanentlyDeleteEntity(wsId, id, type);
    } else {
      throw new Error('Trash item owner workspace could not be resolved.');
    }
    // Payload is purged, but the sync tombstone persists so an offline
    // device cannot resurrect the item (SYNC-0 delete rule).
    const entityType: SyncEntityKind = type === 'canvas' ? 'canvasFile' : type === 'section' ? 'notebookSection' : type === 'page' ? 'notebookPage' : type;
    journalChange({
      entityType,
      entityId: id,
      workspaceId: type === 'workspace' ? id : wsId ?? '',
      operation: 'delete',
      deletedAt: Date.now(),
    });
    await get().loadTrash();
  },

  permanentlyDeleteAllTrash: async () => {
    // Delete descendants before their roots so each provider can clean up
    // payloads without relying on a parent record that may already be gone.
    const state = get();
    const items: Array<{ id: string; type: 'workspace' | 'folder' | 'canvas' | 'notebook' | 'section' | 'page' }> = [
      ...state.deletedPages.map(item => ({ id: item.id, type: 'page' as const })),
      ...state.deletedSections.map(item => ({ id: item.id, type: 'section' as const })),
      ...state.deletedNotebooks.map(item => ({ id: item.id, type: 'notebook' as const })),
      ...state.deletedCanvases.map(item => ({ id: item.id, type: 'canvas' as const })),
      ...state.deletedFolders.map(item => ({ id: item.id, type: 'folder' as const })),
      ...state.deletedWorkspaces.map(item => ({ id: item.id, type: 'workspace' as const })),
    ];
    let deleted = 0;
    let failed = 0;
    for (const item of items) {
      try {
        await get().permanentlyDeleteItem(item.id, item.type);
        deleted += 1;
      } catch (error) {
        failed += 1;
        console.warn('[WorkspaceStore] permanent trash purge failed:', error instanceof Error ? error.name : 'unknown');
      }
    }
    await get().loadTrash();
    return { deleted, failed };
  },

  /**
   * 30-day Trash lifecycle: permanently purges payloads whose retention has
   * elapsed, through the existing explicit permanent-delete path (which
   * journals the durable sync tombstone). Runs opportunistically after Trash
   * loads; user-visible countdowns come from trashCountdown().
   */
  sweepExpiredTrash: async () => {
    if (isSweepingTrash) return 0;
    isSweepingTrash = true;
    try {
      const now = Date.now();
      const expired: Array<{ id: string; type: 'workspace' | 'folder' | 'canvas' | 'notebook' | 'section' | 'page' }> = [
        ...purgeEligibleRoots(get().deletedWorkspaces, now).map(id => ({ id, type: 'workspace' as const })),
        ...purgeEligibleRoots(get().deletedFolders, now).map(id => ({ id, type: 'folder' as const })),
        ...purgeEligibleRoots(get().deletedCanvases, now).map(id => ({ id, type: 'canvas' as const })),
        ...purgeEligibleRoots(get().deletedNotebooks, now).map(id => ({ id, type: 'notebook' as const })),
        ...purgeEligibleRoots(get().deletedSections, now).map(id => ({ id, type: 'section' as const })),
        ...purgeEligibleRoots(get().deletedPages, now).map(id => ({ id, type: 'page' as const })),
      ];
      for (const item of expired) {
        try {
          await get().permanentlyDeleteItem(item.id, item.type);
        } catch (error) {
          console.warn('[WorkspaceStore] expired trash purge failed:', error instanceof Error ? error.name : 'unknown');
        }
      }
      return expired.length;
    } finally {
      isSweepingTrash = false;
    }
  },

  // ---- CRUD: Workspaces ----
  createWorkspace: async (name: string) => {
    const userId = useAuthStore.getState().user?.id ?? null;
    const workspace = await workspaceRepository.create(userId, name);
    journalChange({ entityType: 'workspace', entityId: workspace.id, workspaceId: workspace.id, operation: 'create', payload: { name: workspace.name } });
    await get().loadWorkspaces();
    return workspace;
  },

  renameWorkspace: async (id: string, name: string) => {
    const userId = useAuthStore.getState().user?.id ?? null;
    await workspaceRepository.rename(userId, id, name);
    await get().loadWorkspaces();
  },

  deleteWorkspace: async (id: string) => {
    await workspaceRepository.delete(id);
    journalChange({ entityType: 'workspace', entityId: id, workspaceId: id, operation: 'delete', deletedAt: Date.now() });
    if (get().activeWorkspaceId === id) {
      set({ activeWorkspaceId: null, activeCanvasId: null });
      writeStoredId(ACTIVE_WORKSPACE_KEY, null);
      writeStoredId(ACTIVE_CANVAS_KEY, null);
    }
    await get().loadWorkspaces();
    await get().loadTrash();
  },

  togglePinWorkspace: async (id: string) => {
    const userId = useAuthStore.getState().user?.id ?? null;
    await workspaceRepository.togglePin(userId, id);
    await get().loadWorkspaces();
  },

  // ---- CRUD: Folders ----
  createFolder: async (parentId: string | null, name: string) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) throw new Error('No active workspace');
    const userId = useAuthStore.getState().user?.id ?? null;
    const folder = await folderRepository.create(userId, wsId, parentId, name);
    journalChange({ entityType: 'folder', entityId: folder.id, workspaceId: wsId, operation: 'create', payload: { name: folder.name, parentId } });
    await get().loadWorkspaceContents(wsId);
    return folder;
  },

  renameFolder: async (id: string, name: string) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    const userId = useAuthStore.getState().user?.id ?? null;
    await folderRepository.rename(userId, wsId, id, name);
    await get().loadWorkspaceContents(wsId);
  },

  updateFolderAppearance: async (id: string, appearance: Pick<Folder, 'color' | 'icon'>) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    const userId = useAuthStore.getState().user?.id ?? null;
    await folderRepository.updateAppearance(userId, wsId, id, appearance);
    await get().loadWorkspaceContents(wsId);
  },

  deleteFolder: async (id: string) => {
    const wsId = get().folders.find(item => item.id === id)?.workspaceId;
    if (!wsId) return;
    const userId = useAuthStore.getState().user?.id ?? null;
    await folderRepository.delete(userId, wsId, id);
    journalChange({ entityType: 'folder', entityId: id, workspaceId: wsId, operation: 'delete', deletedAt: Date.now() });
    await get().loadWorkspaceContents(wsId);
    await get().loadTrash();
  },

  toggleFolderExpanded: async (id: string) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    const folder = get().folders.find(f => f.id === id);
    if (!folder) return;
    await folderRepository.toggleExpanded(wsId, id, !folder.isExpanded);
    await get().loadWorkspaceContents(wsId);
  },

  moveFolder: async (id: string, newWorkspaceId: string, newParentId: string | null = null) => {
    const userId = useAuthStore.getState().user?.id ?? null;
    await folderRepository.move(userId, id, newWorkspaceId, newParentId);
    const currentWsId = get().activeWorkspaceId;
    if (currentWsId) await get().loadWorkspaceContents(currentWsId);
  },

  // ---- CRUD: Canvases ----
  createCanvas: async (folderId: string | null, notebookId: string | null, sectionId: string | null, name: string) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) throw new Error('No active workspace');
    const userId = useAuthStore.getState().user?.id ?? null;
    const canvas = await canvasRepository.create(userId, wsId, folderId, notebookId, sectionId, name);
    journalChange({ entityType: 'canvasFile', entityId: canvas.id, workspaceId: wsId, operation: 'create', payload: { name: canvas.name, folderId, notebookId, sectionId } });
    await get().loadWorkspaceContents(wsId);
    await get().loadRecentFiles();
    return canvas;
  },

  renameCanvas: async (id: string, name: string) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    const userId = useAuthStore.getState().user?.id ?? null;
    await canvasRepository.rename(userId, wsId, id, name);
    await get().loadWorkspaceContents(wsId);
  },

  deleteCanvas: async (id: string) => {
    const wsId = get().canvasFiles.find(item => item.id === id)?.workspaceId;
    if (!wsId) return;
    await canvasRepository.delete(wsId, id);
    journalChange({ entityType: 'canvasFile', entityId: id, workspaceId: wsId, operation: 'delete', deletedAt: Date.now() });
    if (get().activeCanvasId === id) {
      set({ activeCanvasId: null });
      writeStoredId(ACTIVE_CANVAS_KEY, null);
    }
    await get().loadWorkspaceContents(wsId);
    await get().loadRecentFiles();
    await get().loadTrash();
  },

  togglePinCanvas: async (id: string) => {
    const canvas = get().canvasFiles.find(c => c.id === id);
    if (!canvas) return;
    const wsId = canvas.workspaceId;
    await canvasRepository.togglePin(wsId, id, !canvas.isPinned);
    journalChange({ entityType: 'canvasFile', entityId: id, workspaceId: wsId, operation: 'update', payload: { isPinned: !canvas.isPinned } });
    await get().loadWorkspaceContents(wsId);
  },

  duplicateCanvas: async (id: string) => {
    const userId = useAuthStore.getState().user?.id ?? null;
    const canvas = await canvasRepository.duplicate(userId, id);
    const wsId = get().activeWorkspaceId;
    if (wsId) await get().loadWorkspaceContents(wsId);
    await get().loadRecentFiles();
    return canvas;
  },

  moveCanvas: async (id: string, newWorkspaceId: string, newFolderId: string | null, newNotebookId: string | null, newSectionId: string | null) => {
    const userId = useAuthStore.getState().user?.id ?? null;
    await canvasRepository.move(userId, id, newWorkspaceId, newFolderId, newNotebookId, newSectionId);
    const wsId = get().activeWorkspaceId;
    if (wsId) await get().loadWorkspaceContents(wsId);
    await get().loadRecentFiles();
  },

  // ---- Notebook foundation ----
  createNotebook: async (folderId: string | null, name: string, cover?: NotebookCover, template?: PageTemplate) => {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) throw new Error('No active workspace');
    const userId = useAuthStore.getState().user?.id ?? null;
    const notebook = await notebookRepository.create(userId, workspaceId, folderId, name);
    journalChange({ entityType: 'notebook', entityId: notebook.id, workspaceId, operation: 'create', payload: { name: notebook.name, folderId } });
    const settings = useNotebookSettingsStore.getState();
    const defaults = {
      paperColor: settings.paperColor,
      template: template ?? settings.template,
      ruleLineColor: '#e0e0e0',
      orientation: settings.orientation.toLowerCase() as 'portrait' | 'landscape',
      pageSize: settings.pageSize,
      margins: settings.margins,
    };
    await notebookRepository.setNotebookPageDefaults(workspaceId, notebook.id, defaults);
    notebook.defaultPageProperties = defaults;
    if (cover) {
      await notebookRepository.updateCover(workspaceId, notebook.id, cover);
      notebook.cover = cover;
    }
    // A notebook is only useful once it has an addressable first page. Keep
    // this creation path equivalent to creating the section and page manually:
    // initialize the canonical drawing payload before exposing the notebook.
    const section = await notebookRepository.createSection(userId, workspaceId, notebook.id, 'Section 1');
    const page = await notebookRepository.createPage(userId, workspaceId, notebook.id, section.id, 'Page 1');
    const initialDrawingData = createDefaultDrawingData(defaults);
    initialDrawingData.properties.layoutMode = 'document';
    initialDrawingData.objects!.push({
      id: generateId('document'),
      type: 'text',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      createdAt: Date.now(),
      metadata: { documentRole: 'body', richTextSchemaVersion: 3 },
    });
    await notebookRepository.saveDrawingData(
      workspaceId,
      notebook.id,
      page.id,
      initialDrawingData,
    );
    await get().loadWorkspaceContents(workspaceId);
    get().setActivePage(page.id);
    return notebook;
  },

  createNotebookSection: async (notebookId: string, name: string) => {
    const userId = useAuthStore.getState().user?.id ?? null;
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) throw new Error('No active workspace');
    const section = await notebookRepository.createSection(userId, workspaceId, notebookId, name);
    journalChange({ entityType: 'notebookSection', entityId: section.id, workspaceId, operation: 'create', payload: { name: section.name, notebookId } });
    await get().loadWorkspaceContents(workspaceId);
    return section;
  },

  createNotebookPage: async (sectionId: string, title: string, options?: NewDocumentPageOptions) => {
    const section = get().notebookSections.find(item => item.id === sectionId);
    if (!section) throw new Error('Notebook section not found');
    const userId = useAuthStore.getState().user?.id ?? null;
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) throw new Error('No active workspace');
    const sectionPages = get().notebookPages
      .filter(page => page.sectionId === sectionId && !page.deletedAt)
      .sort((a, b) => a.order - b.order);

    const isPlaceholder = isGeneratedPagePlaceholder(title);
    let finalTitle = title.trim();
    let provenance: 'default' | 'custom' = options?.titleProvenance ?? (isPlaceholder ? 'default' : 'custom');

    if (isPlaceholder) {
      let insertIndex = sectionPages.length;
      if (options?.insertAfterPageId) {
        const afterIdx = sectionPages.findIndex(p => p.id === options.insertAfterPageId);
        if (afterIdx !== -1) {
          insertIndex = afterIdx + 1;
        }
      }
      finalTitle = `Page ${insertIndex + 1}`;
      provenance = 'default';
    }

    const page = await notebookRepository.createPage(
      userId,
      workspaceId,
      section.notebookId,
      sectionId,
      finalTitle,
      'default',
      undefined,
      provenance,
    );
    page.titleProvenance = provenance;
    
    // Immediately initialize with canonical default settings to avoid black/missing page contents
    const owningNotebook = get().notebooks.find(item => item.id === section.notebookId);
    const defaults = getNotebookPageDefaults(owningNotebook);
    const defaultData = createDefaultDrawingData(defaults);
    const layoutMode = options?.layoutMode ?? 'document';
    defaultData.properties.layoutMode = layoutMode;
    if (layoutMode === 'document') {
      defaultData.objects!.push({
        id: generateId('document'),
        type: 'text',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        createdAt: Date.now(),
        metadata: { documentRole: 'body', richTextSchemaVersion: 3 },
      });
    }
    if (options) {
      if (options.layoutMode) defaultData.properties.layoutMode = options.layoutMode;
      if (options.pageSize) defaultData.properties.pageSize = options.pageSize;
      if (options.orientation) defaultData.properties.orientation = options.orientation;
      if (options.paperColor) defaultData.properties.paperColor = options.paperColor;
      if (options.template) defaultData.properties.template = options.template;
      if (options.ruleLineColor) defaultData.properties.ruleLineColor = options.ruleLineColor;
      if (options.margins) defaultData.properties.margins = options.margins;
      if (options.infiniteWidth !== undefined) defaultData.properties.infiniteWidth = options.infiniteWidth;
      else if (options.pageSize === 'Infinite') defaultData.properties.infiniteWidth = 794;

      if (options.layoutMode === 'document') defaultData.objects!.push({
        id: generateId('document'), type: 'text', x: 0, y: 0, width: 0, height: 0,
        content: { type: 'doc', content: [{ type: 'paragraph' }] }, createdAt: Date.now(),
        metadata: { documentRole: 'body', richTextSchemaVersion: 3 },
      });
      const overrides = derivePagePropertyOverrides(defaultData.properties, owningNotebook);
      await notebookRepository.setPagePropertyOverrides(workspaceId, page.id, overrides);
      page.pagePropertyOverrides = overrides;
    }
    await notebookRepository.saveDrawingData(workspaceId, section.notebookId, page.id, defaultData);
    journalChange({
      entityType: 'notebookPage',
      entityId: page.id,
      workspaceId,
      operation: 'create',
      payload: { title: page.title, notebookId: section.notebookId, sectionId, titleProvenance: provenance },
    });

    if (options?.insertAfterPageId) {
      const currentOrderedIds = sectionPages.map(p => p.id);
      const afterIdx = currentOrderedIds.indexOf(options.insertAfterPageId);
      if (afterIdx !== -1 && afterIdx < currentOrderedIds.length - 1) {
        currentOrderedIds.splice(afterIdx + 1, 0, page.id);
        await workspaceRepository.reorderItems(workspaceId, 'page', currentOrderedIds);
        const updatedSectionPages = [
          ...sectionPages.slice(0, afterIdx + 1),
          page,
          ...sectionPages.slice(afterIdx + 1),
        ];
        updatedSectionPages.forEach((p, idx) => { p.order = idx; });
        const renumberUpdates = computeSectionRenumbering(updatedSectionPages);
        for (const update of renumberUpdates) {
          await notebookRepository.renamePage(workspaceId, update.id, update.title, update.titleProvenance);
          journalChange({
            entityType: 'notebookPage',
            entityId: update.id,
            workspaceId,
            operation: 'update',
            payload: { title: update.title, titleProvenance: update.titleProvenance },
          });
        }
      }
    }

    if (workspaceId) await get().loadWorkspaceContents(workspaceId);
    get().setActivePage(page.id);
    return page;
  },

  reorderPages: async (itemIds: string[]) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    
    set(state => {
      const newPages = [...state.notebookPages];
      itemIds.forEach((id, index) => {
        const page = newPages.find(p => p.id === id);
        if (page) page.order = index;
      });
      return { notebookPages: newPages };
    });
    
    await workspaceRepository.reorderItems(wsId, 'page', itemIds);

    const affectedSectionIds = new Set(
      get().notebookPages.filter(p => itemIds.includes(p.id)).map(p => p.sectionId),
    );
    for (const sectionId of affectedSectionIds) {
      const sectionPages = get().notebookPages
        .filter(p => p.sectionId === sectionId && !p.deletedAt)
        .sort((a, b) => a.order - b.order);
      const renumberUpdates = computeSectionRenumbering(sectionPages);
      for (const update of renumberUpdates) {
        await notebookRepository.renamePage(wsId, update.id, update.title, update.titleProvenance);
        set(state => ({
          notebookPages: state.notebookPages.map(p => p.id === update.id ? { ...p, title: update.title, titleProvenance: update.titleProvenance } : p),
        }));
        journalChange({
          entityType: 'notebookPage',
          entityId: update.id,
          workspaceId: wsId,
          operation: 'update',
          payload: { title: update.title, titleProvenance: update.titleProvenance },
        });
      }
    }

    await get().loadWorkspaceContents(wsId);
  },

  toggleNotebookExpanded: async (id: string) => {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) return;
    const notebook = get().notebooks.find(n => n.id === id);
    if (!notebook) return;
    await notebookRepository.toggleExpanded(workspaceId, id, !notebook.isExpanded);
    await get().loadWorkspaceContents(workspaceId);
  },

  toggleNotebookSectionExpanded: async (id: string) => {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) return;
    const section = get().notebookSections.find(s => s.id === id);
    if (!section) return;
    await notebookRepository.toggleSectionExpanded(workspaceId, id, !section.isExpanded);
    await get().loadWorkspaceContents(workspaceId);
  },

  togglePinNotebook: async (id: string) => {
    const notebook = get().notebooks.find(n => n.id === id);
    if (!notebook) return;
    const wsId = notebook.workspaceId;
    const nextPinned = !notebook.isPinned;
    await notebookRepository.togglePin(wsId, id, nextPinned);
    journalChange({ entityType: 'notebook', entityId: id, workspaceId: wsId, operation: 'update', payload: { isPinned: nextPinned } });
    await get().loadWorkspaceContents(wsId);
  },

  renameNotebook: async (id: string, name: string) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    await notebookRepository.rename(wsId, id, name);
    await get().loadWorkspaceContents(wsId);
  },
  updateNotebookCover: async (id: string, cover: NotebookCover) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    await notebookRepository.updateCover(wsId, id, cover);
    await get().loadWorkspaceContents(wsId);
  },
  renameNotebookSection: async (id: string, name: string) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    await notebookRepository.renameSection(wsId, id, name);
    await get().loadWorkspaceContents(wsId);
  },
  renameNotebookPage: async (id: string, title: string) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    await notebookRepository.renamePage(wsId, id, title, 'custom');
    set(state => ({
      notebookPages: state.notebookPages.map(p => p.id === id ? { ...p, title, titleProvenance: 'custom', updatedAt: Date.now() } : p),
    }));
    journalChange({
      entityType: 'notebookPage',
      entityId: id,
      workspaceId: wsId,
      operation: 'update',
      payload: { title, titleProvenance: 'custom' },
    });
    await get().loadWorkspaceContents(wsId);
  },
  deleteNotebook: async (id: string) => {
    const wsId = get().notebooks.find(item => item.id === id)?.workspaceId;
    if (!wsId) return;
    await notebookRepository.delete(wsId, id);
    journalChange({ entityType: 'notebook', entityId: id, workspaceId: wsId, operation: 'delete', deletedAt: Date.now() });
    if (get().activeNotebookId === id) {
      set({ activeNotebookId: null, activePageId: null });
    }
    await get().loadWorkspaceContents(wsId);
    await get().loadTrash();
  },
  deleteNotebookSection: async (id: string) => {
    const section = get().notebookSections.find(item => item.id === id);
    const wsId = section ? get().notebooks.find(item => item.id === section.notebookId)?.workspaceId : undefined;
    if (!wsId) return;
    await notebookRepository.deleteSection(wsId, id);
    journalChange({ entityType: 'notebookSection', entityId: id, workspaceId: wsId, operation: 'delete', deletedAt: Date.now() });
    await get().loadWorkspaceContents(wsId);
    await get().loadTrash();
  },
  deleteNotebookPage: async (id: string) => {
    const page = get().notebookPages.find(item => item.id === id);
    const wsId = page ? get().notebooks.find(item => item.id === page.notebookId)?.workspaceId : undefined;
    if (!wsId || !page) return;

    cancelQueuedPageDrawing(id);

    await notebookRepository.deletePage(wsId, id);
    journalChange({ entityType: 'notebookPage', entityId: id, workspaceId: wsId, operation: 'delete', deletedAt: Date.now() });

    const remainingPages = get().notebookPages
      .filter(p => p.sectionId === page.sectionId && p.id !== id && !p.deletedAt)
      .sort((a, b) => a.order - b.order);

    const renumberUpdates = computeSectionRenumbering(remainingPages);
    for (const update of renumberUpdates) {
      await notebookRepository.renamePage(wsId, update.id, update.title, update.titleProvenance);
      set(state => ({
        notebookPages: state.notebookPages.map(p => p.id === update.id ? { ...p, title: update.title, titleProvenance: update.titleProvenance } : p),
      }));
      journalChange({
        entityType: 'notebookPage',
        entityId: update.id,
        workspaceId: wsId,
        operation: 'update',
        payload: { title: update.title, titleProvenance: update.titleProvenance },
      });
    }

    if (get().activePageId === id) {
      set({ activePageId: null });
    }
    await get().loadWorkspaceContents(wsId);
    await get().loadTrash();
  },
  moveNotebook: async (id: string, newWorkspaceId: string, newFolderId: string | null) => {
    await notebookRepository.move(id, newWorkspaceId, newFolderId);
    const wsId = get().activeWorkspaceId;
    if (wsId) await get().loadWorkspaceContents(wsId);
  },
  moveNotebookSection: async (id: string, newWorkspaceId: string, newNotebookId: string) => {
    await notebookRepository.moveSection(id, newWorkspaceId, newNotebookId);
    const wsId = get().activeWorkspaceId;
    if (wsId) await get().loadWorkspaceContents(wsId);
  },
  moveNotebookPage: async (id: string, newWorkspaceId: string, newSectionId: string) => {
    await notebookRepository.movePage(id, newWorkspaceId, newSectionId);
    const wsId = get().activeWorkspaceId;
    if (wsId) await get().loadWorkspaceContents(wsId);
  },
  reorderItems: async (type: 'folder' | 'notebook' | 'canvas' | 'section' | 'page', itemIds: string[]) => {
    const wsId = get().activeWorkspaceId;
    if (!wsId) return;
    await workspaceRepository.reorderItems(wsId, type, itemIds);
    await get().loadWorkspaceContents(wsId);
  },
}));
