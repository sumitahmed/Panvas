// ============================================
// Panvas — Bookmark History Command Helper
// ============================================

import type { HistoryCommand } from '@/components/notebook/engine/drawingTypes';
import type { BookmarkDocumentType } from '@/types/bookmark';
import { useBookmarkStore } from '@/stores/bookmarkStore';

export interface BookmarkHistoryOptions {
  documentId: string;
  pageIdOrNumber: string | number;
  documentType: BookmarkDocumentType;
  pageNumber?: number;
  title?: string;
  /**
   * State BEFORE the operation was performed:
   * - If true: the action is a bookmark REMOVAL (undo will restore it, execute will remove it).
   * - If false: the action is a bookmark ADDITION (undo will remove it, execute will restore it).
   */
  wasBookmarked: boolean;
  workspaceId?: string | null;
  onExecute?: () => void;
  onUndo?: () => void;
}

/**
 * Creates a HistoryCommand representing a bookmark add/remove operation.
 * Completely isolated from drawing strokes, canvas vectors, and PDF binaries.
 * Designed to be pushed to NotebookEngine.history via `pushExecuted()`.
 */
export function createBookmarkHistoryCommand(options: BookmarkHistoryOptions): HistoryCommand {
  const {
    documentId,
    pageIdOrNumber,
    documentType,
    pageNumber,
    title,
    wasBookmarked,
    workspaceId,
    onExecute,
    onUndo,
  } = options;

  const description = wasBookmarked
    ? `Remove bookmark on ${documentType} page ${pageIdOrNumber}`
    : `Add bookmark on ${documentType} page ${pageIdOrNumber}`;

  return {
    description,
    execute: () => {
      const store = useBookmarkStore.getState();
      const promise = wasBookmarked
        ? store.removeBookmark(documentId, pageIdOrNumber, workspaceId)
        : store.addBookmark(documentId, pageIdOrNumber, documentType, pageNumber, title, workspaceId);
      promise.catch((err: unknown) => {
        console.error('[BookmarkHistory] execute persistence failed:', err);
      });
      onExecute?.();
    },
    undo: () => {
      const store = useBookmarkStore.getState();
      const promise = wasBookmarked
        ? store.addBookmark(documentId, pageIdOrNumber, documentType, pageNumber, title, workspaceId)
        : store.removeBookmark(documentId, pageIdOrNumber, workspaceId);
      promise.catch((err: unknown) => {
        console.error('[BookmarkHistory] undo persistence failed:', err);
      });
      onUndo?.();
    },
  };
}

/**
 * Convenience helper to toggle a bookmark and record the action in HistoryManager.
 */
export async function toggleBookmarkWithHistory(
  historyManager: { pushExecuted: (command: HistoryCommand) => void },
  options: {
    documentId: string;
    pageIdOrNumber: string | number;
    documentType: BookmarkDocumentType;
    pageNumber?: number;
    title?: string;
    workspaceId?: string | null;
    onExecute?: () => void;
    onUndo?: () => void;
  }
): Promise<boolean> {
  const store = useBookmarkStore.getState();
  const wasBookmarked = store.isBookmarked(options.documentId, options.pageIdOrNumber);

  // Perform the toggle in store
  const isNowBookmarked = await store.toggleBookmark(
    options.documentId,
    options.pageIdOrNumber,
    options.documentType,
    options.pageNumber,
    options.title,
    options.workspaceId
  );

  // Push executed command to history stack
  const command = createBookmarkHistoryCommand({
    ...options,
    wasBookmarked,
  });
  historyManager.pushExecuted(command);

  return isNowBookmarked;
}
