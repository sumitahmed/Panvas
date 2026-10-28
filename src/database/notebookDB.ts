import { db } from './schema';
import { DEFAULT_PAGE_PROPERTY_SET, type Notebook, type NotebookPage, type NotebookPropertyBatchSnapshot, type NotebookSection, type PagePropertySet, type NotebookCover } from '@/types/notebook';
import { generateId } from '@/lib/utils/id';
import { markDeletedByAncestor, markDirectlyDeleted } from '@/services/library/trashModel';
import { parsePdfAnnotationStorageId } from '@/lib/pdfAnnotationStorage';

export async function getNotebooks(userId: string | null): Promise<Notebook[]> {
  return db.notebooks
    .filter(notebook => (notebook.userId ?? null) === (userId ?? null) && !notebook.deletedAt)
    .sortBy('order');
}

export async function getSections(userId: string | null): Promise<NotebookSection[]> {
  const activeNotebookIds = new Set((await getNotebooks(userId)).map(notebook => notebook.id));
  return db.notebookSections
    .filter(section => (section.userId ?? null) === (userId ?? null) && !section.deletedAt && activeNotebookIds.has(section.notebookId))
    .sortBy('order');
}

export async function getPages(userId: string | null): Promise<NotebookPage[]> {
  const activeSections = await getSections(userId);
  const activeSectionIds = new Set(activeSections.map(section => section.id));
  const activeNotebookIds = new Set(activeSections.map(section => section.notebookId));
  return db.notebookPages
    .filter(page => (page.userId ?? null) === (userId ?? null) && !page.deletedAt
      && activeSectionIds.has(page.sectionId) && activeNotebookIds.has(page.notebookId))
    .sortBy('order');
}

export async function createNotebook(userId: string | null, workspaceId: string, folderId: string | null, name: string): Promise<Notebook> {
  const now = Date.now();
  const order = await db.notebooks.where('workspaceId').equals(workspaceId).count();
  const notebook: Notebook = { id: generateId('notebook'), workspaceId, folderId, name, createdAt: now, updatedAt: now, lastOpenedAt: now, order, isExpanded: true, isPinned: false, userId, deletedAt: null, defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET } };
  await db.notebooks.add(notebook);
  return notebook;
}

export async function createSection(userId: string | null, notebookId: string, name: string): Promise<NotebookSection> {
  const now = Date.now();
  const order = await db.notebookSections.where('notebookId').equals(notebookId).count();
  const section: NotebookSection = { id: generateId('section'), notebookId, name, createdAt: now, updatedAt: now, order, isExpanded: true, userId, deletedAt: null };
  await db.notebookSections.add(section);
  return section;
}

export async function createPage(userId: string | null, notebookId: string, sectionId: string, title: string, type: 'default' | 'pdf' = 'default', pdfDataId?: string, titleProvenance?: 'default' | 'custom'): Promise<NotebookPage> {
  const now = Date.now();
  const order = await db.notebookPages.where('sectionId').equals(sectionId).count();
  const page: NotebookPage = { id: generateId('page'), notebookId, sectionId, title, titleProvenance: titleProvenance ?? 'default', createdAt: now, updatedAt: now, lastOpenedAt: now, order, userId, deletedAt: null, type, pdfDataId, pagePropertyOverrides: {} };
  await db.notebookPages.add(page);
  return page;
}

export async function toggleNotebookExpanded(id: string): Promise<void> {
  const notebook = await db.notebooks.get(id);
  if (notebook) await db.notebooks.update(id, { isExpanded: !notebook.isExpanded, updatedAt: Date.now() });
}

export async function toggleNotebookPin(id: string, isPinned?: boolean): Promise<void> {
  const notebook = await db.notebooks.get(id);
  if (notebook) {
    const nextPinned = typeof isPinned === 'boolean' ? isPinned : !notebook.isPinned;
    await db.notebooks.update(id, { isPinned: nextPinned, updatedAt: Date.now() });
  }
}

export async function updateNotebookLastOpened(id: string, openedAt = Date.now()): Promise<void> {
  const notebook = await db.notebooks.get(id);
  if (notebook) {
    await db.notebooks.update(id, { lastOpenedAt: openedAt });
  }
}

export async function updatePageLastOpened(id: string, openedAt = Date.now()): Promise<void> {
  const page = await db.notebookPages.get(id);
  if (page) {
    await db.notebookPages.update(id, { lastOpenedAt: openedAt });
    if (page.notebookId) {
      await db.notebooks.update(page.notebookId, { lastOpenedAt: openedAt });
    }
  }
}

export async function toggleSectionExpanded(id: string): Promise<void> {
  const section = await db.notebookSections.get(id);
  if (section) await db.notebookSections.update(id, { isExpanded: !section.isExpanded, updatedAt: Date.now() });
}

export async function renameNotebook(id: string, name: string): Promise<void> {
  await db.notebooks.update(id, { name, updatedAt: Date.now() });
}

export async function updateNotebookCover(id: string, cover: NotebookCover): Promise<void> {
  await db.notebooks.update(id, { cover, updatedAt: Date.now() });
}

export async function renameSection(id: string, name: string): Promise<void> {
  await db.notebookSections.update(id, { name, updatedAt: Date.now() });
}

export async function renamePage(id: string, title: string, titleProvenance?: 'default' | 'custom'): Promise<void> {
  const updates: Partial<NotebookPage> = { title, updatedAt: Date.now() };
  if (titleProvenance) updates.titleProvenance = titleProvenance;
  await db.notebookPages.update(id, updates);
}

// Soft deletes only: children keep their own deletedAt state and restoring
// the parent is enough to bring the hierarchy back (read paths filter on the
// parent chain).
export async function deleteNotebook(id: string): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', [db.notebooks, db.notebookSections, db.notebookPages, db.canvasFiles], async () => {
    const notebook = await db.notebooks.get(id);
    if (!notebook) return;
    markDirectlyDeleted(notebook, now);
    await db.notebooks.put(notebook);
    const sections = await db.notebookSections.where('notebookId').equals(id).toArray();
    for (const section of sections) {
      markDeletedByAncestor(section, now, id);
      await db.notebookSections.put(section);
    }
    const pages = await db.notebookPages.where('notebookId').equals(id).toArray();
    for (const page of pages) {
      markDeletedByAncestor(page, now, id);
      await db.notebookPages.put(page);
    }
    const canvases = await db.canvasFiles.where('notebookId').equals(id).toArray();
    for (const canvas of canvases) {
      markDeletedByAncestor(canvas, now, id);
      await db.canvasFiles.put(canvas);
    }
  });
}

export async function deleteSection(id: string): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', [db.notebookSections, db.notebookPages, db.canvasFiles], async () => {
    const section = await db.notebookSections.get(id);
    if (!section) return;
    markDirectlyDeleted(section, now);
    await db.notebookSections.put(section);
    const pages = await db.notebookPages.where('sectionId').equals(id).toArray();
    for (const page of pages) {
      markDeletedByAncestor(page, now, id);
      await db.notebookPages.put(page);
    }
    const canvases = await db.canvasFiles.where('sectionId').equals(id).toArray();
    for (const canvas of canvases) {
      markDeletedByAncestor(canvas, now, id);
      await db.canvasFiles.put(canvas);
    }
  });
}

export async function deletePage(id: string): Promise<void> {
  // Soft delete for parity with the Electron handlers: trash + restore.
  const now = Date.now();
  const page = await db.notebookPages.get(id);
  if (page) {
    markDirectlyDeleted(page, now);
    await db.notebookPages.put(page);
  }
}

export async function moveNotebook(id: string, workspaceId: string, folderId: string | null): Promise<void> {
  await db.notebooks.update(id, { workspaceId, folderId, updatedAt: Date.now() });
}

export async function moveSection(id: string, notebookId: string): Promise<void> {
  await db.notebookSections.update(id, { notebookId, updatedAt: Date.now() });
}

export async function movePage(id: string, sectionId: string): Promise<void> {
  const section = await db.notebookSections.get(sectionId);
  if (!section || section.deletedAt) throw new Error('Target notebook section not found.');
  await db.notebookPages.update(id, { sectionId, notebookId: section.notebookId, updatedAt: Date.now() });
}

async function requirePageOwnership(workspaceId: string, notebookId: string, pageId: string): Promise<NotebookPage> {
  const canonicalPageId = parsePdfAnnotationStorageId(pageId)?.ownerPageId ?? pageId;
  const [page, notebook] = await Promise.all([
    db.notebookPages.get(canonicalPageId),
    db.notebooks.get(notebookId),
  ]);
  if (!page || page.notebookId !== notebookId || !notebook || notebook.workspaceId !== workspaceId
    || (canonicalPageId !== pageId && page.type !== 'pdf')) {
    throw new Error('Notebook page does not belong to the requested workspace and notebook.');
  }
  return page;
}

export async function savePageData(workspaceId: string, notebookId: string, pageId: string, data: unknown): Promise<void> {
  const page = await requirePageOwnership(workspaceId, notebookId, pageId);
  const updatedAt = Date.now();
  await db.transaction('rw', [db.notebookPageContents, db.notebookPages], async () => {
    await db.notebookPageContents.put({
      pageId,
      workspaceId,
      notebookId,
      data,
      version: 1,
      updatedAt,
      userId: page.userId,
    });
    await db.notebookPages.update(page.id, { updatedAt });
  });
}

export async function loadPageData(workspaceId: string, notebookId: string, pageId: string): Promise<unknown | null> {
  await requirePageOwnership(workspaceId, notebookId, pageId);
  return (await db.notebookPageContents.get(pageId))?.data ?? null;
}

export async function saveDrawingData(workspaceId: string, notebookId: string, pageId: string, data: unknown): Promise<void> {
  const page = await requirePageOwnership(workspaceId, notebookId, pageId);
  const updatedAt = Date.now();
  await db.transaction('rw', [db.notebookPageDrawings, db.notebookPages], async () => {
    await db.notebookPageDrawings.put({
      pageId,
      workspaceId,
      notebookId,
      data,
      version: 1,
      updatedAt,
      userId: page.userId,
    });
    await db.notebookPages.update(page.id, { updatedAt });
  });
}

export async function loadDrawingData(workspaceId: string, notebookId: string, pageId: string): Promise<unknown | null> {
  await requirePageOwnership(workspaceId, notebookId, pageId);
  return (await db.notebookPageDrawings.get(pageId))?.data ?? null;
}

export async function setNotebookPageDefaults(
  notebookId: string,
  updates: Partial<PagePropertySet>,
): Promise<void> {
  const notebook = await db.notebooks.get(notebookId);
  if (!notebook || notebook.deletedAt) throw new Error('Notebook not found.');
  await db.notebooks.update(notebookId, {
    defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET, ...(notebook.defaultPageProperties ?? {}), ...updates },
    updatedAt: Date.now(),
  });
}

export async function setPagePropertyOverrides(pageId: string, overrides: NotebookPage['pagePropertyOverrides']): Promise<void> {
  const page = await db.notebookPages.get(pageId);
  if (!page || page.deletedAt) throw new Error('Notebook page not found.');
  await db.notebookPages.update(pageId, { pagePropertyOverrides: { ...(overrides ?? {}) }, updatedAt: Date.now() });
}

export async function setPdfPageState(pageId: string, pdfPageState: NotebookPage['pdfPageState']): Promise<void> {
  const page = await db.notebookPages.get(pageId);
  if (!page || page.deletedAt || page.type !== 'pdf') throw new Error('PDF notebook page not found.');
  await db.notebookPages.update(pageId, { pdfPageState, updatedAt: Date.now() });
}

/** One IndexedDB transaction: update defaults and make every live page inherit the changed keys. */
export async function applyPageDefaultsToNotebook(notebookId: string, updates: Partial<PagePropertySet>): Promise<NotebookPropertyBatchSnapshot> {
  return db.transaction('rw', [db.notebooks, db.notebookPages], async () => {
    const notebook = await db.notebooks.get(notebookId);
    if (!notebook || notebook.deletedAt) throw new Error('Notebook not found.');
    const pages = await db.notebookPages.where('notebookId').equals(notebookId).toArray();
    const eligiblePages = pages.filter(page => !page.deletedAt && page.type !== 'pdf');
    const snapshot: NotebookPropertyBatchSnapshot = {
      notebookId,
      defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET, ...(notebook.defaultPageProperties ?? {}) },
      pages: eligiblePages.map(page => ({ pageId: page.id, overrides: { ...(page.pagePropertyOverrides ?? {}) } })),
    };
    await db.notebooks.update(notebookId, {
      defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET, ...(notebook.defaultPageProperties ?? {}), ...updates },
      updatedAt: Date.now(),
    });
    const changedKeys = Object.keys(updates);
    await Promise.all(eligiblePages.map(page => {
      const next = { ...(page.pagePropertyOverrides ?? {}) } as Record<string, unknown>;
      for (const key of changedKeys) delete next[key];
      return db.notebookPages.update(page.id, { pagePropertyOverrides: next, updatedAt: Date.now() });
    }));
    return snapshot;
  });
}

export async function restorePageDefaultsSnapshot(snapshot: NotebookPropertyBatchSnapshot): Promise<void> {
  await db.transaction('rw', [db.notebooks, db.notebookPages], async () => {
    const notebook = await db.notebooks.get(snapshot.notebookId);
    if (!notebook || notebook.deletedAt) throw new Error('Notebook not found.');
    await db.notebooks.update(snapshot.notebookId, {
      defaultPageProperties: { ...snapshot.defaultPageProperties },
      updatedAt: Date.now(),
    });
    await Promise.all(snapshot.pages.map(({ pageId, overrides }) => db.notebookPages.update(pageId, {
      pagePropertyOverrides: { ...overrides },
      updatedAt: Date.now(),
    })));
  });
}
