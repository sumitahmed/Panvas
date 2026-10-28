/**
 * Safe persistence of reading positions for Notebooks and PDF documents.
 * Wraps localStorage with try/catch to safely degrade in private browsing
 * or restricted environments.
 */

export interface NotebookReadingPosition {
  pageId: string;
  scrollX?: number;
  scrollY?: number;
  timestamp: number;
}

export interface PdfReadingPosition {
  pdfPage: number;
  scrollX?: number;
  scrollY?: number;
  timestamp: number;
}

const NOTEBOOK_PREFIX = 'panvas.readingPosition.notebook.';
const PDF_PREFIX = 'panvas.readingPosition.pdf.';

export function saveNotebookPosition(
  notebookId: string,
  position: { pageId: string; scrollX?: number; scrollY?: number }
): void {
  if (!notebookId || !position.pageId) return;
  try {
    const payload: NotebookReadingPosition = {
      pageId: position.pageId,
      scrollX: typeof position.scrollX === 'number' ? Math.round(position.scrollX) : 0,
      scrollY: typeof position.scrollY === 'number' ? Math.round(position.scrollY) : 0,
      timestamp: Date.now(),
    };
    localStorage.setItem(`${NOTEBOOK_PREFIX}${notebookId}`, JSON.stringify(payload));
  } catch (err) {
    // Non-fatal: LocalStorage write quota or private mode restriction
  }
}

export function getNotebookPosition(notebookId: string): NotebookReadingPosition | null {
  if (!notebookId) return null;
  try {
    const raw = localStorage.getItem(`${NOTEBOOK_PREFIX}${notebookId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.pageId === 'string') {
      return parsed as NotebookReadingPosition;
    }
  } catch (err) {
    // Non-fatal: parsing or read error
  }
  return null;
}

export function clearNotebookPosition(notebookId: string): void {
  if (!notebookId) return;
  try {
    localStorage.removeItem(`${NOTEBOOK_PREFIX}${notebookId}`);
  } catch (err) {
    // Non-fatal
  }
}

export function savePdfPosition(
  documentId: string,
  position: { pdfPage: number; scrollX?: number; scrollY?: number }
): void {
  if (!documentId || typeof position.pdfPage !== 'number') return;
  try {
    const payload: PdfReadingPosition = {
      pdfPage: position.pdfPage,
      scrollX: typeof position.scrollX === 'number' ? Math.round(position.scrollX) : 0,
      scrollY: typeof position.scrollY === 'number' ? Math.round(position.scrollY) : 0,
      timestamp: Date.now(),
    };
    localStorage.setItem(`${PDF_PREFIX}${documentId}`, JSON.stringify(payload));
  } catch (err) {
    // Non-fatal
  }
}

export function getPdfPosition(documentId: string): PdfReadingPosition | null {
  if (!documentId) return null;
  try {
    const raw = localStorage.getItem(`${PDF_PREFIX}${documentId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.pdfPage === 'number') {
      return parsed as PdfReadingPosition;
    }
  } catch (err) {
    // Non-fatal
  }
  return null;
}

export function clearPdfPosition(documentId: string): void {
  if (!documentId) return;
  try {
    localStorage.removeItem(`${PDF_PREFIX}${documentId}`);
  } catch (err) {
    // Non-fatal
  }
}
