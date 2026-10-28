// ============================================
// Panvas — Canvas Store (Zustand)
// Uses CanvasRepository for data operations
// ============================================

import { create } from 'zustand';
import type { CanvasData, CustomBlock, BlockType } from '@/types/canvas';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { useAuthStore } from './authStore';
import { deriveSaveStatus, mergePageSaveStatus, type PageSaveStatus, type PageSaveStatusEntry, type SaveStatus } from './saveStatus';

interface CanvasState {
  // Current canvas data
  currentData: CanvasData | null;
  customBlocks: CustomBlock[];
  saveStatus: SaveStatus;
  /** Non-notebook writes (canvas/PDF) retain the original single status slot. */
  legacySaveStatus: SaveStatus;
  /** Per-page notebook drawing writes, ordered by immutable capture sequence. */
  saveStatusByPage: Record<string, PageSaveStatusEntry>;

  // Excalidraw API reference
  excalidrawAPI: any | null;
  setExcalidrawAPI: (api: any) => void;

  // Data loading
  loadCanvasData: (canvasFileId: string, workspaceId?: string) => Promise<void>;
  saveCanvasData: (data: Partial<CanvasData> & { canvasFileId: string }, workspaceId?: string) => Promise<void>;
  clearCurrentCanvas: () => void;

  // Custom blocks
  addBlock: (type: BlockType, x: number, y: number, content?: string) => Promise<CustomBlock>;
  updateBlock: (id: string, updates: Partial<CustomBlock>) => Promise<void>;
  deleteBlock: (id: string) => Promise<void>;
  loadBlocks: (canvasFileId: string) => Promise<void>;

  // Save status
  setSaveStatus: (status: SaveStatus) => void;
  setSaveStatusForPage: (pageId: string, sequence: number, status: PageSaveStatus) => void;
  clearSaveStatusForPage: (pageId: string) => void;
  
  reset: () => void;
}

const pageStatusExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearPageStatusTimers(): void {
  for (const timer of pageStatusExpiryTimers.values()) clearTimeout(timer);
  pageStatusExpiryTimers.clear();
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  currentData: null,
  customBlocks: [],
  saveStatus: 'idle',
  legacySaveStatus: 'idle',
  saveStatusByPage: {},
  excalidrawAPI: null,

  reset: () => {
    clearPageStatusTimers();
    set({
      currentData: null,
      customBlocks: [],
      saveStatus: 'idle',
      legacySaveStatus: 'idle',
      saveStatusByPage: {},
    });
  },

  setExcalidrawAPI: (api) => set({ excalidrawAPI: api }),

  loadCanvasData: async (canvasFileId: string, workspaceId?: string) => {
    const userId = useAuthStore.getState().user?.id ?? null;
    const data = await canvasRepository.loadData(userId, canvasFileId, workspaceId);
    const blocks = await canvasRepository.loadBlocks(userId, canvasFileId);
    clearPageStatusTimers();
    set({
      currentData: data || null,
      customBlocks: blocks,
      saveStatus: 'idle',
      legacySaveStatus: 'idle',
      saveStatusByPage: {},
    });
  },

  saveCanvasData: async (data: Partial<CanvasData> & { canvasFileId: string }, workspaceId?: string) => {
    set(state => ({ legacySaveStatus: 'saving', saveStatus: deriveSaveStatus('saving', state.saveStatusByPage) }));
    try {
      const userId = useAuthStore.getState().user?.id ?? null;
      await canvasRepository.saveData(userId, data, workspaceId);
      
      const current = get().currentData;
      set(state => ({
        legacySaveStatus: 'saved',
        saveStatus: deriveSaveStatus('saved', state.saveStatusByPage),
        currentData: {
          ...current,
          ...data,
          version: (current?.version || 0) + 1,
          updatedAt: Date.now()
        } as CanvasData
      }));
      
      // Reset to idle after 2 seconds
      setTimeout(() => {
        if (get().legacySaveStatus === 'saved') {
          set(state => ({
            legacySaveStatus: 'idle',
            saveStatus: deriveSaveStatus('idle', state.saveStatusByPage),
          }));
        }
      }, 2000);
    } catch (err) {
      console.error('[CanvasStore] Save failed:', err);
      set(state => ({ legacySaveStatus: 'error', saveStatus: deriveSaveStatus('error', state.saveStatusByPage) }));
      throw err;
    }
  },

  clearCurrentCanvas: () => {
    clearPageStatusTimers();
    set({
      currentData: null,
      customBlocks: [],
      saveStatus: 'idle',
      legacySaveStatus: 'idle',
      saveStatusByPage: {},
    });
  },

  addBlock: async (type: BlockType, x: number, y: number, content?: string) => {
    const current = get().currentData;
    if (!current) throw new Error('No active canvas');

    const defaultContent = type === 'markdown'
      ? '# New Note\n\nStart typing...'
      : type === 'latex'
        ? 'E = mc^2'
        : '';

    const userId = useAuthStore.getState().user?.id ?? null;
    const block = await canvasRepository.addBlock(userId, {
      canvasFileId: current.canvasFileId,
      type,
      x,
      y,
      width: type === 'pdf' ? 500 : 320,
      height: type === 'pdf' ? 650 : type === 'markdown' ? 250 : 120,
      content: content || defaultContent,
    });

    set({ customBlocks: [...get().customBlocks, block] });
    return block;
  },

  updateBlock: async (id: string, updates: Partial<CustomBlock>) => {
    await canvasRepository.updateBlock(id, updates);
    set({
      customBlocks: get().customBlocks.map(b =>
        b.id === id ? { ...b, ...updates, updatedAt: Date.now() } : b
      ),
    });
  },

  deleteBlock: async (id: string) => {
    await canvasRepository.deleteBlock(id);
    set({ customBlocks: get().customBlocks.filter(b => b.id !== id) });
  },

  loadBlocks: async (canvasFileId: string) => {
    const userId = useAuthStore.getState().user?.id ?? null;
    const blocks = await canvasRepository.loadBlocks(userId, canvasFileId);
    set({ customBlocks: blocks });
  },

  setSaveStatus: (status) => set(state => ({
    legacySaveStatus: status,
    saveStatus: deriveSaveStatus(status, state.saveStatusByPage),
  })),

  setSaveStatusForPage: (pageId, sequence, status) => {
    const state = get();
    const saveStatusByPage = mergePageSaveStatus(state.saveStatusByPage, pageId, sequence, status);
    if (!saveStatusByPage) return;
    set({ saveStatusByPage, saveStatus: deriveSaveStatus(state.legacySaveStatus, saveStatusByPage) });

    const existingTimer = pageStatusExpiryTimers.get(pageId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      pageStatusExpiryTimers.delete(pageId);
    }
    if (status !== 'saved') return;
    // Preserve the original "Saved" confirmation window without letting a
    // per-page entry keep the global status bar on "Saved" forever.
    pageStatusExpiryTimers.set(pageId, setTimeout(() => {
      pageStatusExpiryTimers.delete(pageId);
      set(current => {
        const entry = current.saveStatusByPage[pageId];
        if (!entry || entry.sequence !== sequence || entry.status !== 'saved') return current;
        const next = { ...current.saveStatusByPage };
        delete next[pageId];
        return {
          saveStatusByPage: next,
          saveStatus: deriveSaveStatus(current.legacySaveStatus, next),
        };
      });
    }, 2000));
  },

  clearSaveStatusForPage: (pageId) => {
    const timer = pageStatusExpiryTimers.get(pageId);
    if (timer) {
      clearTimeout(timer);
      pageStatusExpiryTimers.delete(pageId);
    }
    set(state => {
      if (!state.saveStatusByPage[pageId]) return state;
      const saveStatusByPage = { ...state.saveStatusByPage };
      delete saveStatusByPage[pageId];
      return {
        saveStatusByPage,
        saveStatus: deriveSaveStatus(state.legacySaveStatus, saveStatusByPage),
      };
    });
  },
}));
