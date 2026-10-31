import type { PagePropertySet } from '@/types/notebook';
import type { NotebookObject } from './engine/drawingTypes';
import { resolveBasePageDimensions, resolvePageNoteSpace } from '../../lib/pageProperties.ts';

export const DOCUMENT_SHEET_GAP = 32;
export const isDocumentBody = (object: NotebookObject): boolean => object.type === 'text' && object.metadata?.documentRole === 'body';
export function documentInsets(properties: PagePropertySet): number {
  return properties.margins === 'No Margin' ? 12 : properties.margins === 'Narrow' ? 32 : properties.margins === 'Wide' ? 104 : 64;
}
export function documentSheetStride(properties: PagePropertySet): number {
  const notes = resolvePageNoteSpace(properties);
  return resolveBasePageDimensions(properties).height + notes.top + notes.bottom + DOCUMENT_SHEET_GAP;
}
export function positionedContentBottom(objects: readonly NotebookObject[]): number {
  let bottom = 0;
  for (const object of objects) {
    if (isDocumentBody(object)) continue;
    if (object.type === 'stroke') {
      for (const point of object.points) bottom = Math.max(bottom, point.y + object.thickness);
    } else {
      // A diagonal conservatively retains rotated positioned content.
      bottom = Math.max(bottom, object.y + (object.rotation ? Math.hypot(object.width, object.height ?? 0) : object.height ?? 0));
    }
  }
  return bottom;
}
export function documentExtent(properties: PagePropertySet, bodyBottom: number, annotationBottom = 0): number {
  const { height } = resolveBasePageDimensions(properties);
  const notes = resolvePageNoteSpace(properties);
  const bottom = Math.max(bodyBottom + documentInsets(properties), annotationBottom + documentInsets(properties));
  // Trailing blank space beyond the latest content is about one quarter of the
  // base page height (a quarter A4 sheet in page units) — room to keep working
  // without several screens of empty page, derived from real page dimensions.
  if (properties.pageSize === 'Infinite') return Math.max(height, Math.ceil((bottom + height / 4) / 256) * 256);
  const stride = documentSheetStride(properties);
  const surfaceBottom = notes.top + Math.max(bodyBottom + documentInsets(properties) + notes.bottom, annotationBottom + documentInsets(properties));
  const sheets = Math.max(1, Math.ceil((surfaceBottom + DOCUMENT_SHEET_GAP) / stride));
  return sheets * stride - DOCUMENT_SHEET_GAP - notes.top - notes.bottom;
}
