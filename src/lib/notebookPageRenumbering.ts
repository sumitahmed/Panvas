import type { NotebookPage } from '@/types/notebook';

export interface PageForRenumbering {
  id: string;
  title: string;
  order: number;
  titleProvenance?: 'default' | 'custom';
  deletedAt?: number | null;
}

export interface PageTitleRenumberUpdate {
  id: string;
  title: string;
  titleProvenance: 'default';
}

/**
 * Pure helper for computing section renumbering updates.
 * - Filters for non-deleted pages and sorts by logical order ascending.
 * - Pages with titleProvenance === 'default' are expected to be titled `Page ${1-based index}`.
 * - Emits updates for default pages whose current title does not match.
 * - Pages with titleProvenance === 'custom' (or undefined legacy pages) are strictly preserved.
 */
export function computeSectionRenumbering(
  pages: ReadonlyArray<PageForRenumbering>,
): PageTitleRenumberUpdate[] {
  const activePages = pages
    .filter(page => !page.deletedAt)
    .slice()
    .sort((a, b) => a.order - b.order);

  const updates: PageTitleRenumberUpdate[] = [];

  for (let index = 0; index < activePages.length; index++) {
    const page = activePages[index];
    const provenance = page.titleProvenance ?? 'custom';
    if (provenance === 'default') {
      const expectedTitle = `Page ${index + 1}`;
      if (page.title !== expectedTitle) {
        updates.push({
          id: page.id,
          title: expectedTitle,
          titleProvenance: 'default',
        });
      }
    }
  }

  return updates;
}
