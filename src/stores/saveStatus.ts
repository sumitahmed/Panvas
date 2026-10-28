export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
export type PageSaveStatus = Exclude<SaveStatus, 'idle'>;

export interface PageSaveStatusEntry {
  status: PageSaveStatus;
  sequence: number;
}

/**
 * A page-level failure must remain visible until that page succeeds, even if
 * another page saves afterwards. Likewise, an older completion may not
 * overwrite a newer completion for the same page.
 */
export function deriveSaveStatus(
  legacy: SaveStatus,
  pages: Readonly<Record<string, PageSaveStatusEntry>>,
): SaveStatus {
  const entries = Object.values(pages);
  if (legacy === 'error' || entries.some(entry => entry.status === 'error')) return 'error';
  if (legacy === 'saving' || entries.some(entry => entry.status === 'saving')) return 'saving';
  if (legacy === 'saved' || entries.some(entry => entry.status === 'saved')) return 'saved';
  return 'idle';
}

/** Returns null when a stale completion must not replace a newer one. */
export function mergePageSaveStatus(
  pages: Readonly<Record<string, PageSaveStatusEntry>>,
  pageId: string,
  sequence: number,
  status: PageSaveStatus,
): Record<string, PageSaveStatusEntry> | null {
  const existing = pages[pageId];
  if (existing && sequence < existing.sequence) return null;
  return { ...pages, [pageId]: { status, sequence } };
}
