import type { LocalSearchDocument } from './LocalSearchIndex.ts';
import { extractPageSearchContent, normalizeSearchText, textFromTipTap, type PageSearchContent } from './pageSearchContent.ts';
import { pdfAnnotationScopeKey, type PageSearchSaveEvent } from './searchIndexEvents.ts';

export interface CachedSearchPagePayload {
  contentText?: string;
  drawingHandwritingText?: string;
  drawingRichText?: string;
}

export interface CachedPdfAnnotationPayload {
  handwritingText: string;
  richText: string;
}

export interface SearchIndexMutationState {
  documents: LocalSearchDocument[];
  pagePayloads: Map<string, CachedSearchPagePayload>;
  pdfAnnotationPayloads: Map<string, CachedPdfAnnotationPayload>;
}

/** Combine pre-extracted plain text from page rich text and drawing layers without retaining raw payloads. */
export function mergePageSearchText(
  contentText = '',
  drawingHandwritingText = '',
  drawingRichText = '',
): PageSearchContent {
  const handwritingText = normalizeSearchText(drawingHandwritingText);
  const richText = normalizeSearchText(`${contentText} ${drawingRichText}`);
  const content = normalizeSearchText(`${handwritingText} ${richText}`);
  return {
    handwritingText,
    richText,
    content,
    snippet: content.slice(0, 220),
  };
}

/** A populated index can be reused only for the exact source-record scope. */
export function isSearchIndexValid(
  documents: readonly unknown[],
  indexedScopeKey: string | null,
  requestedScopeKey: string,
): boolean {
  return documents.length > 0 && indexedScopeKey === requestedScopeKey;
}

/** Applies one persisted page save without rebuilding unrelated index entries. */
export function applyPageSearchSave(state: SearchIndexMutationState, event: PageSearchSaveEvent): void {
  if (event.pdfOwnerPageId && Number.isInteger(event.pdfSourcePage)) {
    if (event.kind !== 'drawing') return;
    const sourcePage = event.pdfSourcePage as number;
    const annotationKey = pdfAnnotationScopeKey(event.workspaceId, event.notebookId, event.pdfOwnerPageId, sourcePage);
    const annotation = extractPageSearchContent(undefined, event.data);
    state.pdfAnnotationPayloads.set(annotationKey, {
      handwritingText: annotation.handwritingText,
      richText: annotation.richText,
    });
    state.documents = state.documents.map(document => {
      if (
        document.kind !== 'pdf'
        || document.workspaceId !== event.workspaceId
        || document.notebookId !== event.notebookId
        || document.pageId !== event.pdfOwnerPageId
        || document.pdfPageNumber !== sourcePage
      ) return document;
      const richText = normalizeSearchText(`${document.pdfEmbeddedText ?? ''} ${annotation.richText}`);
      const content = normalizeSearchText(`${annotation.handwritingText} ${richText}`);
      return {
        ...document,
        content,
        handwritingText: annotation.handwritingText,
        richText,
        snippet: content.slice(0, 220),
        updatedAt: Date.now(),
      };
    });
    return;
  }

  const payloads = state.pagePayloads.get(event.pageId) ?? {};
  if (event.kind === 'content') {
    payloads.contentText = normalizeSearchText(textFromTipTap(event.data));
  } else {
    const drawingExtracted = extractPageSearchContent(undefined, event.data);
    payloads.drawingHandwritingText = drawingExtracted.handwritingText;
    payloads.drawingRichText = drawingExtracted.richText;
  }
  state.pagePayloads.set(event.pageId, payloads);

  const extracted = mergePageSearchText(
    payloads.contentText,
    payloads.drawingHandwritingText,
    payloads.drawingRichText,
  );

  state.documents = state.documents.map(document => {
    if (document.kind !== 'page' || document.pageId !== event.pageId || document.workspaceId !== event.workspaceId) return document;
    return {
      ...document,
      ...extracted,
      updatedAt: Date.now(),
    };
  });
}
