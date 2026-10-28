// ============================================
// Panvas — Shared Bookmark Store (Zustand)
// ============================================

import { create } from 'zustand';
import type { Bookmark, BookmarkDocumentType } from '@/types/bookmark';
import {
  bookmarkRepository,
  isBookmarkMatch,
} from '@/services/bookmarks/BookmarkRepository';
import {
  generateBookmarkId,
  formatPdfPageId,
} from '@/services/bookmarks/bookmarkId';

export interface BookmarkStoreState {
  bookmarks: Bookmark[];
  isLoaded: boolean;
  currentWorkspaceId: string | null;

  loadBookmarks: (workspaceId?: string | null) => Promise<void>;
  isBookmarked: (documentId: string, pageIdOrNumber: string | number) => boolean;
  getBookmark: (documentId: string, pageIdOrNumber: string | number) => Bookmark | undefined;
  getBookmarksForDocument: (documentId: string) => Bookmark[];
  addBookmark: (
    documentId: string,
    pageIdOrNumber: string | number,
    documentType: BookmarkDocumentType,
    pageNumber?: number,
    title?: string,
    workspaceId?: string | null
  ) => Promise<Bookmark>;
  removeBookmark: (
    documentId: string,
    pageIdOrNumber: string | number,
    workspaceId?: string | null
  ) => Promise<void>;
  toggleBookmark: (
    documentId: string,
    pageIdOrNumber: string | number,
    documentType: BookmarkDocumentType,
    pageNumber?: number,
    title?: string,
    workspaceId?: string | null
  ) => Promise<boolean>;
  deleteBookmarksForDocument: (
    documentId: string,
    workspaceId?: string | null
  ) => Promise<void>;
  deleteBookmarkForPage: (
    documentId: string,
    pageId: string,
    workspaceId?: string | null
  ) => Promise<void>;
  renameBookmark: (
    bookmarkId: string,
    newTitle: string,
    workspaceId?: string | null
  ) => Promise<void>;
  clearBookmarks: (workspaceId?: string | null) => Promise<void>;
}

export const useBookmarkStore = create<BookmarkStoreState>((set, get) => ({
  bookmarks: [],
  isLoaded: false,
  currentWorkspaceId: null,

  loadBookmarks: async (workspaceId?: string | null) => {
    const cleanWorkspaceId = workspaceId !== undefined
      ? (workspaceId ? String(workspaceId).trim() : null)
      : get().currentWorkspaceId;

    try {
      const loaded = await bookmarkRepository.loadBookmarks(cleanWorkspaceId);
      set({
        bookmarks: loaded,
        isLoaded: true,
        currentWorkspaceId: cleanWorkspaceId,
      });
    } catch (err) {
      console.error('Error loading bookmarks into store:', err);
      set({ bookmarks: [], isLoaded: true, currentWorkspaceId: cleanWorkspaceId });
    }
  },

  isBookmarked: (documentId: string, pageIdOrNumber: string | number) => {
    const { bookmarks } = get();
    return bookmarks.some(b => isBookmarkMatch(b, documentId, pageIdOrNumber));
  },

  getBookmark: (documentId: string, pageIdOrNumber: string | number) => {
    const { bookmarks } = get();
    return bookmarks.find(b => isBookmarkMatch(b, documentId, pageIdOrNumber));
  },

  getBookmarksForDocument: (documentId: string) => {
    const { bookmarks } = get();
    return bookmarks.filter(b => b.documentId === documentId);
  },

  addBookmark: async (
    documentId: string,
    pageIdOrNumber: string | number,
    documentType: BookmarkDocumentType,
    pageNumber?: number,
    title?: string,
    workspaceId?: string | null
  ) => {
    const targetWorkspace = workspaceId !== undefined ? workspaceId : get().currentWorkspaceId;
    const cleanWorkspace = targetWorkspace ? String(targetWorkspace).trim() : null;

    let canonicalPageId: string;
    let canonicalPageNum = pageNumber;

    if (documentType === 'pdf') {
      if (canonicalPageNum === undefined) {
        if (typeof pageIdOrNumber === 'number') {
          canonicalPageNum = pageIdOrNumber;
        } else {
          const match = String(pageIdOrNumber).match(/_pdf_(\d+)$/);
          canonicalPageNum = match ? parseInt(match[1], 10) : parseInt(String(pageIdOrNumber), 10);
        }
      }
      canonicalPageId = formatPdfPageId(documentId, canonicalPageNum || 1);
    } else {
      canonicalPageId = String(pageIdOrNumber);
    }

    const keySegment = canonicalPageNum !== undefined ? canonicalPageNum : canonicalPageId;
    const id = generateBookmarkId(documentId, keySegment);

    const existing = get().bookmarks;
    const found = existing.find(b => isBookmarkMatch(b, documentId, keySegment));
    if (found) return found;

    const newBookmark: Bookmark = {
      id,
      workspaceId: cleanWorkspace,
      documentId,
      pageId: canonicalPageId,
      ...(canonicalPageNum !== undefined ? { pageNumber: canonicalPageNum } : {}),
      documentType,
      ...(title ? { title: title.trim().slice(0, 500) } : {}),
      createdAt: Date.now(),
    };

    // Optimistic synchronous state update
    const nextList = [newBookmark, ...existing];
    set({ bookmarks: nextList });

    // Persist to repository
    await bookmarkRepository.saveBookmarks(cleanWorkspace, nextList);
    return newBookmark;
  },

  removeBookmark: async (
    documentId: string,
    pageIdOrNumber: string | number,
    workspaceId?: string | null
  ) => {
    const targetWorkspace = workspaceId !== undefined ? workspaceId : get().currentWorkspaceId;
    const cleanWorkspace = targetWorkspace ? String(targetWorkspace).trim() : null;

    const existing = get().bookmarks;
    const nextList = existing.filter(b => !isBookmarkMatch(b, documentId, pageIdOrNumber));

    if (nextList.length === existing.length) return;

    // Optimistic synchronous update
    set({ bookmarks: nextList });

    // Persist
    await bookmarkRepository.saveBookmarks(cleanWorkspace, nextList);
  },

  toggleBookmark: async (
    documentId: string,
    pageIdOrNumber: string | number,
    documentType: BookmarkDocumentType,
    pageNumber?: number,
    title?: string,
    workspaceId?: string | null
  ) => {
    const isCurrentlyBookmarked = get().isBookmarked(documentId, pageIdOrNumber);

    if (isCurrentlyBookmarked) {
      await get().removeBookmark(documentId, pageIdOrNumber, workspaceId);
      return false;
    } else {
      await get().addBookmark(documentId, pageIdOrNumber, documentType, pageNumber, title, workspaceId);
      return true;
    }
  },

  deleteBookmarksForDocument: async (
    documentId: string,
    workspaceId?: string | null
  ) => {
    const targetWorkspace = workspaceId !== undefined ? workspaceId : get().currentWorkspaceId;
    const cleanWorkspace = targetWorkspace ? String(targetWorkspace).trim() : null;

    const existing = get().bookmarks;
    const nextList = existing.filter(b => b.documentId !== documentId);

    if (nextList.length === existing.length) return;

    set({ bookmarks: nextList });
    await bookmarkRepository.saveBookmarks(cleanWorkspace, nextList);
  },

  deleteBookmarkForPage: async (
    documentId: string,
    pageId: string,
    workspaceId?: string | null
  ) => {
    await get().removeBookmark(documentId, pageId, workspaceId);
  },

  renameBookmark: async (
    bookmarkId: string,
    newTitle: string,
    workspaceId?: string | null
  ) => {
    const targetWorkspace = workspaceId !== undefined ? workspaceId : get().currentWorkspaceId;
    const cleanWorkspace = targetWorkspace ? String(targetWorkspace).trim() : null;

    const existing = get().bookmarks;
    const index = existing.findIndex(b => b.id === bookmarkId);
    if (index < 0) return;

    const updated: Bookmark = {
      ...existing[index],
      title: newTitle.trim().slice(0, 500),
    };

    const nextList = [...existing];
    nextList[index] = updated;

    set({ bookmarks: nextList });
    await bookmarkRepository.saveBookmarks(cleanWorkspace, nextList);
  },

  clearBookmarks: async (workspaceId?: string | null) => {
    const targetWorkspace = workspaceId !== undefined ? workspaceId : get().currentWorkspaceId;
    const cleanWorkspace = targetWorkspace ? String(targetWorkspace).trim() : null;

    set({ bookmarks: [] });
    await bookmarkRepository.saveBookmarks(cleanWorkspace, []);
  },
}));
