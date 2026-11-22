import { PDFDocument } from 'pdf-lib';
import type { PdfPageRotation, PdfPageState } from '@/types/notebook';
export { normalizePdfPageState } from './pdfPageState.ts';

export function rotatePdfPage(state: PdfPageState, page: number, direction: 1 | -1): PdfPageState {
  const current = state.rotations[page] ?? 0;
  const rotation = (((current + direction * 90) % 360) + 360) % 360 as PdfPageRotation;
  const next = { ...state.rotations };
  if (rotation === 0) delete next[page]; else next[page] = rotation;
  return { ...state, rotations: next };
}

export function movePdfPage(state: PdfPageState, sourceIndex: number, destinationIndex: number): PdfPageState {
  const pageOrder = [...state.pageOrder];
  if (sourceIndex < 0 || destinationIndex < 0 || sourceIndex >= pageOrder.length || destinationIndex >= pageOrder.length) return state;
  const [page] = pageOrder.splice(sourceIndex, 1);
  pageOrder.splice(destinationIndex, 0, page);
  return { ...state, pageOrder };
}

export async function extractPdfSourcePage(originalBytes: ArrayBuffer | Uint8Array, sourcePage: number): Promise<Uint8Array> {
  const source = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
  if (!Number.isInteger(sourcePage) || sourcePage < 1 || sourcePage > source.getPageCount()) throw new Error('The selected PDF page is unavailable.');
  const result = await PDFDocument.create();
  const [copied] = await result.copyPages(source, [sourcePage - 1]);
  result.addPage(copied);
  return result.save();
}
