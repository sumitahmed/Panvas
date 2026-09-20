import type { DrawingData } from './engine/drawingTypes';
import type { PagePropertySet } from '../../types/notebook';
import { gate0Profiler } from '../../dev/gate0Profiler.ts';

export type NotebookPageDataCache = Readonly<Record<string, DrawingData>>;
export type PagePropertyChangeSource = 'load' | 'user' | 'appearance';

export interface PageOwnedDrawing {
  documentId: string;
  sheetId: string;
  renderedSheetId: string;
  sceneOwnerSheetId: string;
  saveTargetSheetId: string;
  drawingRevision: number;
  data: DrawingData;
}

/** Capture one immutable sheet-owned payload before any persistence step. */
export function capturePageOwnedDrawing(
  documentId: string,
  sheetId: string,
  sceneOwnerSheetId: string,
  drawingRevision: number,
  data: DrawingData,
  renderedSheetId = sheetId,
): PageOwnedDrawing | null {
  if (!documentId || !sheetId || sheetId !== sceneOwnerSheetId || sheetId !== renderedSheetId) return null;
  const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
  const cloned = structuredClone(data);
  if (startedAt) gate0Profiler.event('capture-page-owned-drawing', performance.now() - startedAt, { objects: cloned.objects?.length ?? 0 });
  return {
    documentId,
    sheetId,
    renderedSheetId,
    sceneOwnerSheetId,
    saveTargetSheetId: sheetId,
    drawingRevision,
    data: cloned,
  };
}

/** Capture from a factory that already returns a fresh immutable snapshot. */
export function captureFreshPageOwnedDrawing(
  documentId: string,
  sheetId: string,
  sceneOwnerSheetId: string,
  drawingRevision: number,
  createFreshData: () => DrawingData,
  renderedSheetId = sheetId,
): PageOwnedDrawing | null {
  if (!documentId || !sheetId || sheetId !== sceneOwnerSheetId || sheetId !== renderedSheetId) return null;
  const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
  const data = createFreshData();
  if (startedAt) gate0Profiler.event('capture-page-owned-drawing', performance.now() - startedAt, { objects: data.objects?.length ?? 0 });
  return {
    documentId,
    sheetId,
    renderedSheetId,
    sceneOwnerSheetId,
    saveTargetSheetId: sheetId,
    drawingRevision,
    data,
  };
}

export function hasValidPageDrawingOwnership(snapshot: PageOwnedDrawing): boolean {
  return snapshot.sheetId === snapshot.renderedSheetId
    && snapshot.sheetId === snapshot.sceneOwnerSheetId
    && snapshot.sheetId === snapshot.saveTargetSheetId;
}

/** Loading a page updates rendering, but must never be mistaken for an edit. */
export function mayPersistPagePropertyChange(source: PagePropertyChangeSource): boolean {
  return source === 'user';
}

/** Paper color is page metadata; it does not change committed drawing objects. */
export function isPaperColorOnlyUpdate(updates: Partial<PagePropertySet>): boolean {
  return Object.keys(updates).length === 1 && typeof updates.paperColor === 'string';
}

/**
 * Repository reads are snapshots. They may fill a cache gap, but must never
 * replace data captured from the live engine while the read was in flight.
 */
export function mergeLoadedPageData(
  current: NotebookPageDataCache,
  loaded: NotebookPageDataCache,
): Record<string, DrawingData> {
  return { ...loaded, ...current };
}

/** Resolve one stable page identity to its active or inactive render data. */
export function resolveNotebookPageRenderData(
  pageId: string,
  focusedPageId: string,
  cache: NotebookPageDataCache,
  focusedData?: DrawingData,
  sceneOwnerPageId = focusedPageId,
): DrawingData | undefined {
  return pageId === focusedPageId && pageId === sceneOwnerPageId && focusedData
    ? focusedData
    : cache[pageId];
}

/** A completed focused-page read may only mutate the engine it was requested for. */
export function mayApplyPageLoadToEngine(
  requestedPageId: string,
  currentFocusedPageId: string,
  requestGeneration: number,
  latestGeneration: number,
): boolean {
  return requestedPageId === currentFocusedPageId && requestGeneration === latestGeneration;
}
