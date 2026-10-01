import { PDFDocument } from 'pdf-lib';
import type { DrawingData } from '@/components/notebook/engine/drawingTypes';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { notebookRepository } from '@/repositories/NotebookRepository';
import { renderPdfAnnotations } from './renderPdfAnnotations';
import type { PdfPageState } from '@/types/notebook';
import { currentPresentationTheme } from '@/lib/themePresentation';

export interface AnnotatedPdfExportInput {
  userId: string | null;
  workspaceId: string;
  notebookId: string;
  pageId: string;
  pdfDataId: string;
  fileName: string;
  pageState?: PdfPageState;
}

export interface AnnotatedPdfExportResult {
  bytes: Uint8Array;
  fileName: string;
  exportedObjects: number;
  unsupportedObjects: number;
  warnings: string[];
}

export async function exportAnnotatedPdf(input: AnnotatedPdfExportInput): Promise<AnnotatedPdfExportResult> {
  const theme = currentPresentationTheme();
  const stored = await canvasRepository.getPdf(input.userId, input.pdfDataId);
  if (!stored) throw new Error('The original PDF bytes are unavailable. Re-import the source document before exporting.');

  const originalBytes = stored.data.slice(0);
  const source = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
  const drawings = await Promise.all(Array.from({ length: source.getPageCount() }, (_, index) =>
    notebookRepository.loadDrawingData(input.workspaceId, input.notebookId, `${input.pageId}_pdf_${index + 1}`)
      .then(value => value as DrawingData | null),
  ));
  const rendered = await renderPdfAnnotations(originalBytes, drawings, input.pageState, async fileId => { const image = await canvasRepository.getImage(fileId); return image ? { mimeType: image.mimeType, data: image.data } : undefined; }, theme);
  const baseName = input.fileName.replace(/\.pdf$/i, '') || 'document';
  return { ...rendered, fileName: `${baseName}-annotated.pdf` };
}
