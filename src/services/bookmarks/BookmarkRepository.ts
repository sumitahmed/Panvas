// ============================================
// Panvas — Shared Bookmark Repository
// ============================================

import type { Bookmark, BookmarkDocumentType } from '@/types/bookmark';
import { generateBookmarkId, formatPdfPageId } from './bookmarkId';

export const BOOKMARKS_STORAGE_KEY = 'panvas.bookmarks.v1';
const MAX_BOOKMARKS_PER_WORKSPACE = 20_000;

/**
 * Validates and normalizes an untrusted bookmark record.
 * Drops malformed or corrupt entries, ensuring persistence safety and schema compliance.
 */
export function validateBookmark(candidate: unknown, fallbackWorkspaceId?: string | null): Bookmark | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const raw = candidate as Record<string, unknown>;

  // Validate documentId
  if (typeof raw.documentId !== 'string' || !raw.documentId.trim()) return null;
  const documentId = raw.documentId.trim();

  // Validate documentType
  if (raw.documentType !== 'notebook' && raw.documentType !== 'pdf') return null;
  const documentType = raw.documentType as BookmarkDocumentType;

  // Validate pageId
  if (typeof raw.pageId !== 'string' || !raw.pageId.trim()) return null;
  const pageId = raw.pageId.trim();

  // Validate optional pageNumber
  let pageNumber: number | undefined;
  if (raw.pageNumber !== undefined && raw.pageNumber !== null) {
    if (typeof raw.pageNumber === 'number' && Number.isInteger(raw.pageNumber) && raw.pageNumber > 0) {
      pageNumber = raw.pageNumber;
    } else if (typeof raw.pageNumber === 'string' && /^\d+$/.test(raw.pageNumber)) {
      const parsed = parseInt(raw.pageNumber, 10);
      if (parsed > 0) pageNumber = parsed;
    }
  }

  // Validate createdAt
  let createdAt = Date.now();
  if (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) && raw.createdAt > 0) {
    createdAt = Math.floor(raw.createdAt);
  }

  // Validate optional title
  let title: string | undefined;
  if (typeof raw.title === 'string' && raw.title.trim()) {
    title = raw.title.trim().slice(0, 500);
  }

  // Validate optional workspaceId
  let workspaceId: string | null | undefined = fallbackWorkspaceId;
  if (raw.workspaceId !== undefined) {
    if (raw.workspaceId === null) {
      workspaceId = null;
    } else if (typeof raw.workspaceId === 'string') {
      workspaceId = raw.workspaceId.trim() || null;
    }
  }

  // Determine canonical composite ID
  const pageTarget = pageNumber !== undefined ? pageNumber : pageId;
  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : generateBookmarkId(documentId, pageTarget);

  return {
    id,
    workspaceId,
    documentId,
    pageId,
    ...(pageNumber !== undefined ? { pageNumber } : {}),
    documentType,
    ...(title !== undefined ? { title } : {}),
    createdAt,
  };
}

/**
 * Checks whether a bookmark corresponds to a given documentId and page target.
 */
export function isBookmarkMatch(
  bookmark: Bookmark,
  documentId: string,
  pageIdOrNumber: string | number
): boolean {
  if (bookmark.documentId !== documentId) return false;

  const targetStr = String(pageIdOrNumber).trim();
  if (bookmark.id === generateBookmarkId(documentId, targetStr)) return true;
  if (bookmark.pageId === targetStr) return true;
  if (bookmark.pageNumber !== undefined && String(bookmark.pageNumber) === targetStr) return true;

  // Check if target is a formatted PDF page ID matching the bookmark's pageNumber
  const pdfMatch = targetStr.match(/_pdf_(\d+)$/);
  if (pdfMatch && bookmark.pageNumber === parseInt(pdfMatch[1], 10)) return true;

  return false;
}

export class BookmarkRepository {
  private writeQueues = new Map<string, Promise<unknown>>();

  private getQueueKey(workspaceId?: string | null): string {
    return workspaceId ? String(workspaceId).trim() : '__panvas_global__';
  }

  private async enqueueWrite<T>(workspaceId: string | null | undefined, operation: () => Promise<T>): Promise<T> {
    const key = this.getQueueKey(workspaceId);
    const currentQueue = this.writeQueues.get(key) ?? Promise.resolve();

    const nextQueue = currentQueue
      .catch(() => {})
      .then(async () => {
        return await operation();
      });

    this.writeQueues.set(key, nextQueue);

    try {
      return await nextQueue;
    } finally {
      if (this.writeQueues.get(key) === nextQueue) {
        this.writeQueues.delete(key);
      }
    }
  }

  /**
   * Loads all valid bookmarks for the specified workspace.
   * Corrupted, unparseable, or missing fields are safely ignored.
   */
  async loadBookmarks(workspaceId?: string | null): Promise<Bookmark[]> {
    const cleanWorkspaceId = workspaceId ? String(workspaceId).trim() : null;
    let raw: unknown = null;

    try {
      if (typeof window !== 'undefined' && window.panvas?.settings) {
        raw = await window.panvas.settings.get(cleanWorkspaceId, BOOKMARKS_STORAGE_KEY);
      } else if (typeof localStorage !== 'undefined') {
        const key = `panvas.${cleanWorkspaceId ?? 'global'}.${BOOKMARKS_STORAGE_KEY}`;
        const stored = localStorage.getItem(key);
        if (stored) raw = JSON.parse(stored);
      }
    } catch {
      raw = null;
    }

    if (!Array.isArray(raw)) return [];

    const validated: Bookmark[] = [];
    const seenIds = new Set<string>();

    for (const item of raw.slice(0, MAX_BOOKMARKS_PER_WORKSPACE)) {
      const b = validateBookmark(item, cleanWorkspaceId);
      if (b && !seenIds.has(b.id)) {
        seenIds.add(b.id);
        validated.push(b);
      }
    }

    return validated;
  }

  private async persistRaw(cleanWorkspaceId: string | null, bookmarks: Bookmark[]): Promise<void> {
    const seenIds = new Set<string>();
    const valid = bookmarks
      .slice(0, MAX_BOOKMARKS_PER_WORKSPACE)
      .map(b => validateBookmark(b, cleanWorkspaceId))
      .filter((b): b is Bookmark => {
        if (!b || seenIds.has(b.id)) return false;
        seenIds.add(b.id);
        return true;
      });

    try {
      if (typeof window !== 'undefined' && window.panvas?.settings) {
        await window.panvas.settings.set(cleanWorkspaceId, BOOKMARKS_STORAGE_KEY, valid);
      } else if (typeof localStorage !== 'undefined') {
        const key = `panvas.${cleanWorkspaceId ?? 'global'}.${BOOKMARKS_STORAGE_KEY}`;
        localStorage.setItem(key, JSON.stringify(valid));
      }
    } catch (err) {
      // Safe error logging without throwing unhandled exceptions
      console.error('Failed to persist bookmarks to storage:', err);
    }
  }

  /**
   * Persists the given bookmarks array to storage.
   * Completely decoupled from drawing data, content records, and PDF binaries.
   */
  async saveBookmarks(workspaceId: string | null, bookmarks: Bookmark[]): Promise<void> {
    return this.enqueueWrite(workspaceId, async () => {
      const cleanWorkspaceId = workspaceId ? String(workspaceId).trim() : null;
      await this.persistRaw(cleanWorkspaceId, bookmarks);
    });
  }

  /**
   * Adds a new bookmark or returns the existing bookmark if already present.
   */
  async addBookmark(
    workspaceId: string | null,
    bookmarkData: Omit<Bookmark, 'id' | 'createdAt'> & { createdAt?: number }
  ): Promise<Bookmark> {
    return this.enqueueWrite(workspaceId, async () => {
      const cleanWorkspaceId = workspaceId ? String(workspaceId).trim() : null;
      const existing = await this.loadBookmarks(cleanWorkspaceId);

      const pageTarget = bookmarkData.pageNumber !== undefined ? bookmarkData.pageNumber : bookmarkData.pageId;
      const id = generateBookmarkId(bookmarkData.documentId, pageTarget);

      const foundIndex = existing.findIndex(b => isBookmarkMatch(b, bookmarkData.documentId, pageTarget));
      if (foundIndex >= 0) {
        return existing[foundIndex];
      }

      const newBookmark: Bookmark = {
        id,
        workspaceId: cleanWorkspaceId,
        documentId: bookmarkData.documentId,
        pageId: bookmarkData.pageId,
        ...(bookmarkData.pageNumber !== undefined ? { pageNumber: bookmarkData.pageNumber } : {}),
        documentType: bookmarkData.documentType,
        ...(bookmarkData.title ? { title: bookmarkData.title.trim().slice(0, 500) } : {}),
        createdAt: bookmarkData.createdAt ?? Date.now(),
      };

      const updated = [newBookmark, ...existing];
      await this.persistRaw(cleanWorkspaceId, updated);
      return newBookmark;
    });
  }

  /**
   * Removes a bookmark matching the document and page target.
   * Returns true if a bookmark was removed, false otherwise.
   */
  async removeBookmark(
    workspaceId: string | null,
    documentId: string,
    pageIdOrNumber: string | number
  ): Promise<boolean> {
    return this.enqueueWrite(workspaceId, async () => {
      const cleanWorkspaceId = workspaceId ? String(workspaceId).trim() : null;
      const existing = await this.loadBookmarks(cleanWorkspaceId);

      const filtered = existing.filter(b => !isBookmarkMatch(b, documentId, pageIdOrNumber));
      if (filtered.length === existing.length) return false;

      await this.persistRaw(cleanWorkspaceId, filtered);
      return true;
    });
  }

  /**
   * Toggles bookmark state for a given document and page target.
   */
  async toggleBookmark(
    workspaceId: string | null,
    documentId: string,
    pageIdOrNumber: string | number,
    documentType: BookmarkDocumentType,
    pageNumber?: number,
    title?: string
  ): Promise<{ bookmarked: boolean; bookmark?: Bookmark }> {
    return this.enqueueWrite(workspaceId, async () => {
      const cleanWorkspaceId = workspaceId ? String(workspaceId).trim() : null;
      const existing = await this.loadBookmarks(cleanWorkspaceId);

      const targetIndex = existing.findIndex(b => isBookmarkMatch(b, documentId, pageIdOrNumber));
      if (targetIndex >= 0) {
        const removed = existing.filter((_, idx) => idx !== targetIndex);
        await this.persistRaw(cleanWorkspaceId, removed);
        return { bookmarked: false };
      }

      let canonicalPageId: string;
      let canonicalPageNum: number | undefined = pageNumber;

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

      const keyTarget = canonicalPageNum !== undefined ? canonicalPageNum : canonicalPageId;
      const id = generateBookmarkId(documentId, keyTarget);

      const newBookmark: Bookmark = {
        id,
        workspaceId: cleanWorkspaceId,
        documentId,
        pageId: canonicalPageId,
        ...(canonicalPageNum !== undefined ? { pageNumber: canonicalPageNum } : {}),
        documentType,
        ...(title ? { title: title.trim().slice(0, 500) } : {}),
        createdAt: Date.now(),
      };

      const updated = [newBookmark, ...existing];
      await this.persistRaw(cleanWorkspaceId, updated);
      return { bookmarked: true, bookmark: newBookmark };
    });
  }

  /**
   * Retrieves bookmarks for the given workspace, optionally filtered by documentId.
   */
  async getBookmarks(workspaceId: string | null, documentId?: string): Promise<Bookmark[]> {
    const all = await this.loadBookmarks(workspaceId);
    if (!documentId) return all;
    return all.filter(b => b.documentId === documentId);
  }

  /**
   * Deletes all bookmarks associated with a specific document (e.g. when a notebook or PDF is deleted).
   */
  async deleteBookmarksForDocument(workspaceId: string | null, documentId: string): Promise<void> {
    return this.enqueueWrite(workspaceId, async () => {
      const cleanWorkspaceId = workspaceId ? String(workspaceId).trim() : null;
      const existing = await this.loadBookmarks(cleanWorkspaceId);
      const filtered = existing.filter(b => b.documentId !== documentId);
      if (filtered.length !== existing.length) {
        await this.persistRaw(cleanWorkspaceId, filtered);
      }
    });
  }

  /**
   * Deletes a bookmark for a specific page within a document.
   */
  async deleteBookmarkForPage(workspaceId: string | null, documentId: string, pageId: string): Promise<void> {
    await this.removeBookmark(workspaceId, documentId, pageId);
  }

  /**
   * Updates the title label of a bookmark.
   */
  async renameBookmark(
    workspaceId: string | null,
    bookmarkId: string,
    newTitle: string
  ): Promise<Bookmark | null> {
    return this.enqueueWrite(workspaceId, async () => {
      const cleanWorkspaceId = workspaceId ? String(workspaceId).trim() : null;
      const existing = await this.loadBookmarks(cleanWorkspaceId);
      const targetIndex = existing.findIndex(b => b.id === bookmarkId);
      if (targetIndex < 0) return null;

      const updatedBookmark: Bookmark = {
        ...existing[targetIndex],
        title: newTitle.trim().slice(0, 500),
      };

      const nextList = [...existing];
      nextList[targetIndex] = updatedBookmark;
      await this.persistRaw(cleanWorkspaceId, nextList);
      return updatedBookmark;
    });
  }

  /**
   * Moves a bookmark to another workspace.
   */
  async moveBookmark(
    sourceWorkspaceId: string | null,
    bookmarkId: string,
    targetWorkspaceId: string | null
  ): Promise<Bookmark | null> {
    const cleanSource = sourceWorkspaceId ? String(sourceWorkspaceId).trim() : null;
    const cleanTarget = targetWorkspaceId ? String(targetWorkspaceId).trim() : null;
    if (cleanSource === cleanTarget) return null;

    const sourceBookmarks = await this.loadBookmarks(cleanSource);
    const targetItem = sourceBookmarks.find(b => b.id === bookmarkId);
    if (!targetItem) return null;

    // Remove from source
    await this.removeBookmark(cleanSource, targetItem.documentId, targetItem.pageNumber ?? targetItem.pageId);

    // Add to target
    const movedBookmark: Bookmark = {
      ...targetItem,
      workspaceId: cleanTarget,
    };
    await this.addBookmark(cleanTarget, movedBookmark);
    return movedBookmark;
  }
}

export const bookmarkRepository = new BookmarkRepository();
