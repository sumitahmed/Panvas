// ============================================
// Panvas — Bookmark ID Utilities & Normalizers
// ============================================

import type { BookmarkDocumentType } from '@/types/bookmark';

/**
 * Generates a stable composite key for a bookmark.
 * Format: `${documentId}:${pageIdOrNumber}`
 */
export function generateBookmarkId(documentId: string, pageIdOrNumber: string | number): string {
  const cleanDoc = String(documentId).trim();
  const cleanPage = String(pageIdOrNumber).trim();
  if (!cleanDoc) throw new Error('Bookmark documentId must be a non-empty string.');
  if (!cleanPage) throw new Error('Bookmark pageIdOrNumber must be a non-empty string or positive number.');
  return `${cleanDoc}:${cleanPage}`;
}

/**
 * Parses a composite bookmark ID into its components.
 */
export function parseBookmarkId(id: string): {
  documentId: string;
  pageIdOrNumber: string;
  pageNumber?: number;
} | null {
  if (typeof id !== 'string' || !id.includes(':')) return null;
  const colonIndex = id.indexOf(':');
  const documentId = id.slice(0, colonIndex).trim();
  const pageIdOrNumber = id.slice(colonIndex + 1).trim();
  if (!documentId || !pageIdOrNumber) return null;

  let pageNumber: number | undefined;
  if (/^\d+$/.test(pageIdOrNumber)) {
    const num = parseInt(pageIdOrNumber, 10);
    if (Number.isFinite(num) && num > 0) pageNumber = num;
  } else {
    const pdfMatch = pageIdOrNumber.match(/_pdf_(\d+)$/);
    if (pdfMatch) {
      const num = parseInt(pdfMatch[1], 10);
      if (Number.isFinite(num) && num > 0) pageNumber = num;
    }
  }

  return {
    documentId,
    pageIdOrNumber,
    ...(pageNumber !== undefined ? { pageNumber } : {}),
  };
}

/**
 * Formats a canonical PDF page identifier.
 * Example: `page_abc123_pdf_1`
 */
export function formatPdfPageId(documentId: string, pageNumber: number): string {
  const cleanDoc = String(documentId).trim();
  const cleanNum = Number(pageNumber);
  if (!cleanDoc) throw new Error('Document ID is required to format PDF page ID.');
  if (!Number.isInteger(cleanNum) || cleanNum < 1) {
    throw new Error(`Invalid PDF page number: ${pageNumber}. Must be a 1-based positive integer.`);
  }
  return `${cleanDoc}_pdf_${cleanNum}`;
}

/**
 * Normalizes a notebook bookmark target, ensuring stable identity bound to page.id.
 */
export function normalizeNotebookBookmarkTarget(notebookId: string, pageId: string) {
  const cleanNotebookId = String(notebookId).trim();
  const cleanPageId = String(pageId).trim();
  if (!cleanNotebookId) throw new Error('Notebook ID is required.');
  if (!cleanPageId) throw new Error('Page ID is required.');

  return {
    documentId: cleanNotebookId,
    pageId: cleanPageId,
    pageIdOrNumber: cleanPageId,
    documentType: 'notebook' as BookmarkDocumentType,
    bookmarkId: generateBookmarkId(cleanNotebookId, cleanPageId),
  };
}

/**
 * Normalizes a PDF bookmark target, ensuring stable identity bound to document ID and page number.
 */
export function normalizePdfBookmarkTarget(documentId: string, pageIdOrNumber: string | number) {
  const cleanDocId = String(documentId).trim();
  if (!cleanDocId) throw new Error('PDF document ID is required.');

  let pageNumber: number;
  let pageId: string;
  let keySegment: string;

  if (typeof pageIdOrNumber === 'number') {
    if (!Number.isInteger(pageIdOrNumber) || pageIdOrNumber < 1) {
      throw new Error(`Invalid PDF page number: ${pageIdOrNumber}. Must be a positive integer.`);
    }
    pageNumber = pageIdOrNumber;
    pageId = formatPdfPageId(cleanDocId, pageNumber);
    keySegment = String(pageNumber);
  } else {
    const raw = String(pageIdOrNumber).trim();
    if (/^\d+$/.test(raw)) {
      pageNumber = parseInt(raw, 10);
      pageId = formatPdfPageId(cleanDocId, pageNumber);
      keySegment = String(pageNumber);
    } else {
      const match = raw.match(/_pdf_(\d+)$/);
      if (match) {
        pageNumber = parseInt(match[1], 10);
        pageId = raw;
        keySegment = String(pageNumber);
      } else {
        throw new Error(`Cannot parse PDF page number from target: ${raw}`);
      }
    }
  }

  return {
    documentId: cleanDocId,
    pageId,
    pageNumber,
    pageIdOrNumber: keySegment,
    documentType: 'pdf' as BookmarkDocumentType,
    bookmarkId: generateBookmarkId(cleanDocId, keySegment),
  };
}
