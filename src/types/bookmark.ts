// ============================================
// Panvas — Shared Bookmark Domain Types
// ============================================

export type BookmarkDocumentType = 'notebook' | 'pdf';

/**
 * Normalized Bookmark entity representing a marked notebook page or PDF page.
 * Keyed by stable document and page identifiers, independent of page title changes.
 */
export interface Bookmark {
  /** Composite stable identifier: `${documentId}:${pageIdOrNumber}` */
  id: string;
  /** Optional workspace scope (null indicates global or workspace-agnostic) */
  workspaceId?: string | null;
  /** Stable document identifier (notebookId for notebooks; stable page.id for PDF documents) */
  documentId: string;
  /** Stable page identifier (page.id for notebooks; `${documentId}_pdf_${pageNumber}` for PDF pages) */
  pageId: string;
  /** 1-based source page number for PDFs (undefined for notebooks) */
  pageNumber?: number;
  /** Document type discriminator */
  documentType: BookmarkDocumentType;
  /** Human-readable display label snapshot (e.g. page title or "Page X") */
  title?: string;
  /** UTC timestamp in milliseconds when the bookmark was created */
  createdAt: number;
}

/**
 * Criteria for filtering bookmarks when querying the repository or store.
 */
export interface BookmarkFilter {
  /** Filter by workspace scope */
  workspaceId?: string | null;
  /** Filter by document identifier */
  documentId?: string;
  /** Filter by document type */
  documentType?: BookmarkDocumentType;
  /** Search string matching in title, pageId, or documentId */
  searchQuery?: string;
}

/**
 * Structured query result including pagination or counts if needed.
 */
export interface BookmarkQueryResult {
  items: Bookmark[];
  total: number;
}

/**
 * Bookmark change mutation types.
 */
export type BookmarkChangeType = 'added' | 'removed' | 'updated' | 'cleared' | 'loaded';

/**
 * Event emitted on reactive bookmark mutations.
 */
export interface BookmarkChangeEvent {
  type: BookmarkChangeType;
  bookmark?: Bookmark;
  bookmarks: Bookmark[];
  timestamp: number;
}
