import type { NotebookPage, NotebookSection } from '@/types/notebook';

export type NotebookOutlineLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface NotebookOutlineEntry {
  id: string;
  pageId: string;
  title: string;
  level: NotebookOutlineLevel;
  pageNumber: number;
  blockId?: string;
  /** Page rows make the outline scannable even when a page has no headings. */
  kind?: 'page' | 'heading';
}

export type OutlinePage = NotebookPage & {
  /** Optional rich-text payload loaded from the page content record. */
  content?: unknown;
  /** Optional drawing payload containing persisted TextObjects. */
  drawing?: unknown;
};

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function headingLevel(value: unknown): NotebookOutlineLevel | null {
  const level = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level as NotebookOutlineLevel : null;
}

function textFromNode(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromNode).join('');
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  const semantic = ['inlineMath', 'blockMath'].includes(value.type) ? value.attrs?.latex
    : value.type === 'pageReference' ? value.attrs?.label : ['image', 'inlineImage'].includes(value.type) ? value.attrs?.alt : null;
  if (typeof semantic === 'string') return semantic;
  return textFromNode(value.content);
}

function collectHeadingNodes(value: unknown, headings: Array<{ level: NotebookOutlineLevel; title: string; blockId?: string }>, parentBlockId?: string): void {
  if (Array.isArray(value)) {
    for (const child of value) collectHeadingNodes(child, headings, parentBlockId);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === 'heading' || value.type === 'detailsSummary') {
    const level = headingLevel(value.type === 'detailsSummary' ? value.attrs?.headingLevel : value.attrs?.level ?? value.level);
    const title = textFromNode(value.content ?? value.text).replace(/\s+/g, ' ').trim();
    const blockId = value.type === 'detailsSummary' ? parentBlockId ?? value.attrs?.blockId : value.attrs?.blockId;
    if (level && title) headings.push({ level, title, ...(typeof blockId === 'string' ? { blockId } : {}) });
  }
  // Walking all nested content supports TipTap docs, pasted fragments, and
  // text objects without coupling this model to a particular editor schema.
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'attrs' && key !== 'text') collectHeadingNodes(child, headings, value.attrs?.blockId ?? parentBlockId);
  }
}

function extractPageHeadings(page: OutlinePage): Array<{ level: NotebookOutlineLevel; title: string; blockId?: string }> {
  const headings: Array<{ level: NotebookOutlineLevel; title: string; blockId?: string }> = [];
  const content = isRecord(page.content) && 'data' in page.content ? page.content.data : page.content;
  collectHeadingNodes(content, headings);
  // Drawing payloads store TipTap JSON under TextObject.content (usually in
  // `objects`, with `texts` retained for older files). A recursive walk keeps
  // compatibility with both representations.
  collectHeadingNodes(page.drawing, headings);
  return headings;
}

/**
 * Build a deterministic, flat table of contents. Page rows are emitted first
 * for each ordered page, followed by that page's H1–H6 entries; `kind` lets
 * consumers distinguish navigation rows from actual headings.
 */
export function extractNotebookOutline(pages: OutlinePage[], sections: NotebookSection[]): NotebookOutlineEntry[] {
  const sectionOrder = new Map(
    sections
      .filter(section => !section.deletedAt)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((section, index) => [section.id, index]),
  );
  const orderedPages = pages
    .filter(page => !page.deletedAt)
    .sort((a, b) => (sectionOrder.get(a.sectionId) ?? Number.MAX_SAFE_INTEGER) - (sectionOrder.get(b.sectionId) ?? Number.MAX_SAFE_INTEGER) || a.order - b.order || a.id.localeCompare(b.id));
  const outline: NotebookOutlineEntry[] = [];
  orderedPages.forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1;
    outline.push({ id: `page:${page.id}`, pageId: page.id, title: page.title?.trim() || `Page ${pageNumber}`, level: 1, pageNumber, kind: 'page' });
    extractPageHeadings(page).forEach((heading, headingIndex) => {
      outline.push({ id: `heading:${page.id}:${heading.blockId ?? headingIndex}`, pageId: page.id, title: heading.title, level: heading.level, pageNumber, kind: 'heading', ...(heading.blockId ? { blockId: heading.blockId } : {}) });
    });
  });
  return outline;
}

