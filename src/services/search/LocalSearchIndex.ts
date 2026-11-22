import type { CanvasFile, Folder } from '@/types/workspace';
import type { Notebook, NotebookPage, NotebookSection } from '@/types/notebook';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { notebookRepository } from '@/repositories/NotebookRepository';
import { rankLocalSearchDocuments } from './rankLocalSearchDocuments';
import { extractPageSearchContent, normalizeSearchText, textFromTipTap } from './pageSearchContent';
import {
  pdfAnnotationScopeKey,
  pdfAnnotationStorageId,
  subscribeToPageSearchSaves,
  type PageSearchSaveEvent,
} from './searchIndexEvents';
import { createLocalSearchScopeKey } from './searchIndexScope';
import {
  applyPageSearchSave,
  isSearchIndexValid,
  mergePageSearchText,
  type CachedPdfAnnotationPayload,
  type CachedSearchPagePayload,
  type SearchIndexMutationState,
} from './localSearchIndexState';

export { createLocalSearchScopeKey } from './searchIndexScope';

export type LocalSearchDocumentKind = 'folder' | 'canvas' | 'notebook' | 'page' | 'pdf';

export interface LocalSearchDocument {
  id: string;
  kind: LocalSearchDocumentKind;
  workspaceId: string;
  notebookId?: string;
  sectionId?: string;
  pageId?: string;
  pageNumber?: number;
  pdfPageNumber?: number;
  title: string;
  content: string;
  handwritingText: string;
  richText: string;
  /** Embedded PDF text is kept separate so annotation updates can merge into it. */
  pdfEmbeddedText?: string;
  snippet: string;
  tags: string[];
  updatedAt: number;
}

export interface LocalSearchSource {
  userId: string | null;
  workspaceId: string;
  folders: Folder[];
  canvasFiles: CanvasFile[];
  notebooks: Notebook[];
  sections: NotebookSection[];
  pages: NotebookPage[];
}

type CachedPagePayloads = CachedSearchPagePayload;
type CachedPdfAnnotationPayloads = ReadonlyMap<string, CachedPdfAnnotationPayload>;

const MAX_PDF_TEXT_CACHE_ENTRIES = 20;
const pdfTextCache = new Map<string, string[]>();

function getCachedPdfText(pdfDataId: string): string[] | undefined {
  const cached = pdfTextCache.get(pdfDataId);
  if (!cached) return undefined;
  pdfTextCache.delete(pdfDataId);
  pdfTextCache.set(pdfDataId, cached);
  return cached;
}

function setCachedPdfText(pdfDataId: string, pages: string[]): void {
  if (pdfTextCache.has(pdfDataId)) {
    pdfTextCache.delete(pdfDataId);
  }
  pdfTextCache.set(pdfDataId, pages);
  while (pdfTextCache.size > MAX_PDF_TEXT_CACHE_ENTRIES) {
    const oldestKey = pdfTextCache.keys().next().value;
    if (oldestKey === undefined) break;
    pdfTextCache.delete(oldestKey);
  }
}

async function loadPdfJs() {
  const [pdfjsLib, workerModule] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default;
  }
  return pdfjsLib;
}

async function extractPdfPages(userId: string | null, pdfDataId: string): Promise<string[]> {
  const cached = getCachedPdfText(pdfDataId);
  if (cached) return cached;
  const stored = await canvasRepository.getPdf(userId, pdfDataId);
  if (!stored) return [];
  const pdfjsLib = await loadPdfJs();
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(stored.data.slice(0)),
    disableAutoFetch: true,
    disableStream: true,
  });
  const document = await task.promise;
  try {
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      try {
        const text = await page.getTextContent();
        pages.push(normalizeSearchText(text.items.map(item => 'str' in item ? item.str : '').join(' ')));
      } finally {
        page.cleanup();
      }
    }
    setCachedPdfText(pdfDataId, pages);
    return pages;
  } finally {
    await document.destroy();
    if (!task.destroyed) {
      await task.destroy().catch(() => {});
    }
  }
}

export async function rebuildLocalSearchIndex(source: LocalSearchSource): Promise<LocalSearchDocument[]> {
  if (localSearchIndex.getWorkspaceId() && localSearchIndex.getWorkspaceId() !== source.workspaceId) {
    localSearchIndex.clear();
  }
  const documents: LocalSearchDocument[] = [];
  const pagePayloads = new Map<string, CachedPagePayloads>();
  const pdfAnnotationPayloads = new Map<string, CachedPdfAnnotationPayload>();
  const scopeKey = createLocalSearchScopeKey(source);
  const activeFolders = source.folders.filter(item => item.workspaceId === source.workspaceId && !item.deletedAt);
  const activeNotebooks = source.notebooks.filter(item => item.workspaceId === source.workspaceId && !item.deletedAt);
  const notebookIds = new Set(activeNotebooks.map(item => item.id));
  const activeSections = source.sections.filter(item => notebookIds.has(item.notebookId) && !item.deletedAt);
  const activePages = source.pages.filter(item => notebookIds.has(item.notebookId) && !item.deletedAt);
  const sectionOrder = new Map(activeSections.map(section => [section.id, section.order]));
  const pageNumbers = new Map<string, number>();
  for (const notebook of activeNotebooks) {
    activePages
      .filter(page => page.notebookId === notebook.id)
      .sort((a, b) => (sectionOrder.get(a.sectionId) ?? 0) - (sectionOrder.get(b.sectionId) ?? 0) || a.order - b.order)
      .forEach((page, index) => pageNumbers.set(page.id, index + 1));
  }

  const emptyContent = { content: '', handwritingText: '', richText: '', snippet: '' };

  documents.push(...activeFolders.map(folder => ({
    id: folder.id, kind: 'folder' as const, workspaceId: folder.workspaceId, title: folder.name,
    ...emptyContent, tags: ['folder'], updatedAt: folder.updatedAt,
  })));

  for (const canvas of source.canvasFiles.filter(item => item.workspaceId === source.workspaceId && !item.deletedAt)) {
    const data = await canvasRepository.loadData(source.userId, canvas.id).catch(() => undefined);
    const canvasText = normalizeSearchText(textFromTipTap(data?.customBlocks));
    documents.push({
      id: canvas.id, kind: 'canvas', workspaceId: canvas.workspaceId, title: canvas.name,
      ...emptyContent,
      content: canvasText,
      richText: canvasText,
      snippet: canvasText.slice(0, 220),
      tags: ['canvas'], updatedAt: canvas.updatedAt,
    });
  }

  for (const notebook of activeNotebooks) {
    documents.push({ id: notebook.id, kind: 'notebook', workspaceId: notebook.workspaceId, title: notebook.name, ...emptyContent, tags: ['notebook'], updatedAt: notebook.updatedAt });
  }

  for (const page of activePages) {
    const notebook = activeNotebooks.find(item => item.id === page.notebookId);
    if (!notebook) continue;
    const section = activeSections.find(item => item.id === page.sectionId);
    const base = {
      workspaceId: notebook.workspaceId,
      notebookId: notebook.id,
      sectionId: page.sectionId,
      pageId: page.id,
      pageNumber: pageNumbers.get(page.id),
      title: page.title,
      tags: [page.type === 'pdf' ? 'pdf' : 'page', notebook.name, section?.name ?? ''],
      updatedAt: page.updatedAt,
    };
    if (page.type === 'pdf' && page.pdfDataId) {
      const pageTexts = await extractPdfPages(source.userId, page.pdfDataId).catch(error => {
        console.warn(`[LocalSearchIndex] Could not index PDF ${page.id}:`, error);
        return [];
      });
      if (pageTexts.length === 0) {
        documents.push({ id: page.id, kind: 'pdf', ...base, ...emptyContent });
      } else {
        for (let index = 0; index < pageTexts.length; index += 1) {
          const sourcePage = index + 1;
          const embeddedText = pageTexts[index];
          const annotationDrawing = await notebookRepository
            .loadDrawingData(notebook.workspaceId, notebook.id, pdfAnnotationStorageId(page.id, sourcePage))
            .catch(() => undefined);
          const annotation = extractPageSearchContent(undefined, annotationDrawing);
          if (annotationDrawing) {
            pdfAnnotationPayloads.set(
              pdfAnnotationScopeKey(notebook.workspaceId, notebook.id, page.id, sourcePage),
              { handwritingText: annotation.handwritingText, richText: annotation.richText },
            );
          }
          const richText = normalizeSearchText(`${embeddedText} ${annotation.richText}`);
          const content = normalizeSearchText(`${annotation.handwritingText} ${richText}`);
          documents.push({
            id: `${page.id}:${sourcePage}`, kind: 'pdf', ...base,
            pageNumber: sourcePage, pdfPageNumber: sourcePage,
            pdfEmbeddedText: embeddedText,
            content, handwritingText: annotation.handwritingText, richText, snippet: content.slice(0, 220),
          });
        }
      }
      continue;
    }
    const [content, drawing] = await Promise.all([
      notebookRepository.loadPageData(notebook.workspaceId, notebook.id, page.id).catch(() => null),
      notebookRepository.loadDrawingData(notebook.workspaceId, notebook.id, page.id).catch(() => null),
    ]);
    const contentText = normalizeSearchText(textFromTipTap(content));
    const drawingExtracted = extractPageSearchContent(undefined, drawing);
    pagePayloads.set(page.id, {
      contentText,
      drawingHandwritingText: drawingExtracted.handwritingText,
      drawingRichText: drawingExtracted.richText,
    });
    documents.push({
      id: page.id,
      kind: 'page',
      ...base,
      ...mergePageSearchText(contentText, drawingExtracted.handwritingText, drawingExtracted.richText),
    });
  }

  localSearchIndex.replace(documents, pagePayloads, pdfAnnotationPayloads, scopeKey, source.workspaceId);
  return documents;
}

export function searchLocalIndex(documents: LocalSearchDocument[], query: string, limit = 20): Array<LocalSearchDocument & { excerpt: string }> {
  return rankLocalSearchDocuments(documents, query, limit);
}

export class LocalSearchIndex {
  private documents: LocalSearchDocument[] = [];
  private readonly pagePayloads = new Map<string, CachedPagePayloads>();
  private readonly pdfAnnotationPayloads = new Map<string, CachedPdfAnnotationPayload>();
  private scopeKey: string | null = null;
  private workspaceId: string | null = null;
  private readonly unsubscribe: () => void;

  constructor() {
    this.unsubscribe = subscribeToPageSearchSaves(event => this.applySavedPage(event));
  }

  replace(
    documents: LocalSearchDocument[],
    pagePayloads: ReadonlyMap<string, CachedPagePayloads> = new Map(),
    pdfAnnotationPayloads: CachedPdfAnnotationPayloads = new Map(),
    scopeKey: string | null = null,
    workspaceId: string | null = null,
  ): void {
    const nextWorkspaceId = workspaceId ?? documents[0]?.workspaceId ?? null;
    if (this.workspaceId && nextWorkspaceId && this.workspaceId !== nextWorkspaceId) {
      pdfTextCache.clear();
    }
    this.documents = documents;
    this.scopeKey = scopeKey;
    this.workspaceId = nextWorkspaceId;
    this.pagePayloads.clear();
    pagePayloads.forEach((payload, pageId) => this.pagePayloads.set(pageId, payload));
    this.pdfAnnotationPayloads.clear();
    pdfAnnotationPayloads.forEach((payload, key) => this.pdfAnnotationPayloads.set(key, payload));
  }

  getWorkspaceId(): string | null {
    return this.workspaceId;
  }

  isValidFor(scopeKey: string): boolean {
    return isSearchIndexValid(this.documents, this.scopeKey, scopeKey);
  }

  getAll(): readonly LocalSearchDocument[] {
    return this.documents;
  }

  search(query: string, limit = 20) {
    return rankLocalSearchDocuments(this.documents, query, limit);
  }

  clear(): void {
    this.documents = [];
    this.scopeKey = null;
    this.workspaceId = null;
    this.pagePayloads.clear();
    this.pdfAnnotationPayloads.clear();
    pdfTextCache.clear();
  }

  reset(): void {
    this.clear();
  }

  dispose(): void {
    this.unsubscribe();
    this.clear();
  }

  private applySavedPage(event: PageSearchSaveEvent): void {
    if (!this.scopeKey && this.documents.length === 0) return;
    const state: SearchIndexMutationState = {
      documents: this.documents,
      pagePayloads: this.pagePayloads,
      pdfAnnotationPayloads: this.pdfAnnotationPayloads,
    };
    applyPageSearchSave(state, event);
    this.documents = state.documents;
  }
}

export const localSearchIndex = new LocalSearchIndex();
