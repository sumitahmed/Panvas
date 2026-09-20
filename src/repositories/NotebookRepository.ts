import * as notebookDB from '@/database/notebookDB';
import type { Notebook, NotebookPage, NotebookPropertyBatchSnapshot, NotebookSection, PagePropertySet, NotebookCover, PdfPageState } from '@/types/notebook';
import { db } from '@/database/schema';
import { queuePageSearchSave, type PageSearchSaveContext } from '@/services/search/searchIndexEvents';
import { clearAncestorDeletion } from '@/services/library/trashModel';
import { recordLocalChangeDetached } from '@/services/cloudsync/recordLocalChange';
import { parsePdfAnnotationStorageId } from '@/lib/pdfAnnotationStorage';
import { gate0Profiler } from '@/dev/gate0Profiler';

export class NotebookRepository {
  async getAll(userId: string | null): Promise<Notebook[]> {
    if (typeof window !== 'undefined' && window.panvas) {
      const workspaces = await window.panvas.workspace.getAll();
      let all: Notebook[] = [];
      for (const ws of workspaces.filter((workspace: any) => !workspace.deletedAt)) {
        const items = await window.panvas.notebook.getAll(ws.id);
        all = all.concat(items.filter((n: any) => !n.deletedAt));
      }
      return all;
    }
    return notebookDB.getNotebooks(userId);
  }
  
  async getSections(userId: string | null): Promise<NotebookSection[]> {
    if (typeof window !== 'undefined' && window.panvas) {
      const workspaces = await window.panvas.workspace.getAll();
      let all: NotebookSection[] = [];
      for (const ws of workspaces.filter((workspace: any) => !workspace.deletedAt)) {
        const items = await window.panvas.notebookSection.getAll(ws.id);
        all = all.concat(items.filter((s: any) => !s.deletedAt));
      }
      return all;
    }
    return notebookDB.getSections(userId);
  }
  
  async getPages(userId: string | null): Promise<NotebookPage[]> {
    if (typeof window !== 'undefined' && window.panvas) {
      const workspaces = await window.panvas.workspace.getAll();
      let all: NotebookPage[] = [];
      for (const ws of workspaces.filter((workspace: any) => !workspace.deletedAt)) {
        const items = await window.panvas.notebookPage.getAll(ws.id);
        all = all.concat(items.filter((p: any) => !p.deletedAt));
      }
      return all;
    }
    return notebookDB.getPages(userId);
  }

  async create(userId: string | null, workspaceId: string, folderId: string | null, name: string): Promise<Notebook> { 
    if (typeof window !== 'undefined' && window.panvas) {
      return await window.panvas.notebook.create(workspaceId, name, folderId);
    }
    return notebookDB.createNotebook(userId, workspaceId, folderId, name); 
  }
  async createSection(userId: string | null, workspaceId: string, notebookId: string, name: string): Promise<NotebookSection> { 
    if (typeof window !== 'undefined' && window.panvas) {
      return await window.panvas.notebookSection.create(workspaceId, notebookId, name);
    }
    return notebookDB.createSection(userId, notebookId, name); 
  }
  async createPage(userId: string | null, workspaceId: string, notebookId: string, sectionId: string, title: string, type: 'default' | 'pdf' = 'default', pdfDataId?: string): Promise<NotebookPage> {
    if (typeof window !== 'undefined' && window.panvas) {
      return window.panvas.notebookPage.create(workspaceId, notebookId, sectionId, title, type, pdfDataId);
    }
    return notebookDB.createPage(userId, notebookId, sectionId, title, type, pdfDataId);
  }
  
  // Soft-deleted entities are restored by clearing deletedAt. Content and
  // drawing files were never removed, so no further recovery is needed.
  async restoreEntity(workspaceId: string, id: string, kind: 'notebook' | 'section' | 'page'): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      if (kind === 'notebook') await window.panvas.notebook.update(workspaceId, id, { deletedAt: null });
      else if (kind === 'section') await window.panvas.notebookSection.update(workspaceId, id, { deletedAt: null });
      else await window.panvas.notebookPage.update(workspaceId, id, { deletedAt: null });
      return;
    }
    const { db } = await import('@/database/schema');
    const now = Date.now();
    await db.transaction('rw', [db.notebooks, db.notebookSections, db.notebookPages, db.canvasFiles], async () => {
      if (kind === 'notebook') {
        const notebook = await db.notebooks.get(id);
        if (!notebook) return;
        const notebookDeletedAt = notebook.deletedAt;
        notebook.deletedAt = null;
        notebook.updatedAt = now;
        delete notebook.deletedByAncestorId;
        await db.notebooks.put(notebook);
        const sections = await db.notebookSections.where('notebookId').equals(id).toArray();
        for (const section of sections) { clearAncestorDeletion(section, id, now, notebookDeletedAt); await db.notebookSections.put(section); }
        const pages = await db.notebookPages.where('notebookId').equals(id).toArray();
        for (const page of pages) { clearAncestorDeletion(page, id, now, notebookDeletedAt); await db.notebookPages.put(page); }
        const canvases = await db.canvasFiles.where('notebookId').equals(id).toArray();
        for (const canvas of canvases) { clearAncestorDeletion(canvas, id, now, notebookDeletedAt); await db.canvasFiles.put(canvas); }
      } else if (kind === 'section') {
        const section = await db.notebookSections.get(id);
        if (!section) return;
        const sectionDeletedAt = section.deletedAt;
        section.deletedAt = null;
        section.updatedAt = now;
        delete section.deletedByAncestorId;
        await db.notebookSections.put(section);
        const pages = await db.notebookPages.where('sectionId').equals(id).toArray();
        for (const page of pages) { clearAncestorDeletion(page, id, now, sectionDeletedAt); await db.notebookPages.put(page); }
        const canvases = await db.canvasFiles.where('sectionId').equals(id).toArray();
        for (const canvas of canvases) { clearAncestorDeletion(canvas, id, now, sectionDeletedAt); await db.canvasFiles.put(canvas); }
      } else {
        const page = await db.notebookPages.get(id);
        if (!page) return;
        page.deletedAt = null;
        page.updatedAt = now;
        delete page.deletedByAncestorId;
        await db.notebookPages.put(page);
      }
    });
  }

  async permanentlyDeleteEntity(workspaceId: string, id: string, kind: 'notebook' | 'section' | 'page'): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.trash.permanentlyDelete(workspaceId, id, kind);
      return;
    }
    const { db } = await import('@/database/schema');
    await db.transaction('rw', [
      db.notebooks, db.notebookSections, db.notebookPages, db.canvasFiles,
      db.canvasData, db.customBlocks, db.pdfFiles, db.imageFiles,
      db.notebookPageContents, db.notebookPageDrawings,
    ], async () => {
      if (kind === 'notebook') {
        await db.notebooks.delete(id);
        const sections = await db.notebookSections.where('notebookId').equals(id).toArray();
        for (const section of sections) await db.notebookSections.delete(section.id);
        const pages = await db.notebookPages.where('notebookId').equals(id).toArray();
        for (const page of pages) {
          await db.notebookPageContents.delete(page.id);
          await db.notebookPageDrawings.delete(page.id);
          await db.notebookPages.delete(page.id);
        }
        const canvases = await db.canvasFiles.where('notebookId').equals(id).toArray();
        for (const canvas of canvases) {
          await db.canvasData.delete(canvas.id);
          await db.customBlocks.where('canvasFileId').equals(canvas.id).delete();
          await db.pdfFiles.where('canvasFileId').equals(canvas.id).delete();
          await db.imageFiles.where('canvasFileId').equals(canvas.id).delete();
          await db.canvasFiles.delete(canvas.id);
        }
      } else if (kind === 'section') {
        await db.notebookSections.delete(id);
        const pages = await db.notebookPages.where('sectionId').equals(id).toArray();
        for (const page of pages) {
          await db.notebookPageContents.delete(page.id);
          await db.notebookPageDrawings.delete(page.id);
          await db.notebookPages.delete(page.id);
        }
        const canvases = await db.canvasFiles.where('sectionId').equals(id).toArray();
        for (const canvas of canvases) {
          await db.canvasData.delete(canvas.id);
          await db.customBlocks.where('canvasFileId').equals(canvas.id).delete();
          await db.pdfFiles.where('canvasFileId').equals(canvas.id).delete();
          await db.imageFiles.where('canvasFileId').equals(canvas.id).delete();
          await db.canvasFiles.delete(canvas.id);
        }
      } else {
        await db.notebookPageContents.delete(id);
        await db.notebookPageDrawings.delete(id);
        await db.notebookPages.delete(id);
      }
    });
  }

  async savePageData(workspaceId: string, notebookId: string, pageId: string, data: any): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas?.notebook) {
      await window.panvas.notebook.savePage(workspaceId, notebookId, pageId, data);
    } else {
      await notebookDB.savePageData(workspaceId, notebookId, pageId, data);
    }
    recordLocalChangeDetached({ entityType: 'pageContent', entityId: pageId, workspaceId, operation: 'update', payload: data });
    queuePageSearchSave({ workspaceId, notebookId, pageId, kind: 'content', data });
  }

  async loadPageData(workspaceId: string, notebookId: string, pageId: string): Promise<any> {
    if (typeof window !== 'undefined' && window.panvas?.notebook) {
      return window.panvas.notebook.loadPage(workspaceId, notebookId, pageId);
    }
    return notebookDB.loadPageData(workspaceId, notebookId, pageId);
  }

  async saveDrawingData(workspaceId: string, notebookId: string, pageId: string, data: any, searchContext?: PageSearchSaveContext): Promise<void> {
    let effectiveNotebookId = notebookId;
    let effectiveWorkspaceId = workspaceId;
    const canonicalPageId = searchContext?.pdfOwnerPageId || parsePdfAnnotationStorageId(pageId)?.ownerPageId || pageId;
    if (typeof window !== 'undefined') {
      try {
        const { useWorkspaceStore } = await import('@/stores/workspaceStore');
        const state = useWorkspaceStore.getState();
        const foundPage = state.notebookPages?.find(p => p.id === canonicalPageId);
        if (foundPage?.notebookId) {
          effectiveNotebookId = foundPage.notebookId;
          const foundNotebook = state.notebooks?.find(n => n.id === effectiveNotebookId);
          if (foundNotebook?.workspaceId) effectiveWorkspaceId = foundNotebook.workspaceId;
        }
      } catch { /* store fallback */ }
    }
    if (typeof window !== 'undefined' && window.panvas?.notebook) {
      await window.panvas.notebook.saveDrawing(effectiveWorkspaceId, effectiveNotebookId, pageId, data);
    } else {
      await notebookDB.saveDrawingData(effectiveWorkspaceId, effectiveNotebookId, pageId, data);
    }
    recordLocalChangeDetached({ entityType: 'pageDrawing', entityId: pageId, workspaceId: effectiveWorkspaceId, operation: 'update', payload: data });
    queuePageSearchSave({ workspaceId: effectiveWorkspaceId, notebookId: effectiveNotebookId, pageId, kind: 'drawing', data, ...searchContext });
  }

  async loadDrawingData(workspaceId: string, notebookId: string, pageId: string): Promise<any> {
    const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    if (typeof window !== 'undefined' && window.panvas?.notebook) {
      const result = await window.panvas.notebook.loadDrawing(workspaceId, notebookId, pageId);
      if (startedAt) gate0Profiler.event('notebook-repository-read', performance.now() - startedAt, { pageId, source: 'electron' });
      return result;
    }
    const result = await notebookDB.loadDrawingData(workspaceId, notebookId, pageId);
    if (startedAt) gate0Profiler.event('notebook-repository-read', performance.now() - startedAt, { pageId, source: 'dexie' });
    return result;
  }

  async setNotebookPageDefaults(workspaceId: string, notebookId: string, updates: PagePropertySet): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebook.update(workspaceId, notebookId, { defaultPageProperties: updates });
      return;
    }
    return notebookDB.setNotebookPageDefaults(notebookId, updates);
  }

  async setPagePropertyOverrides(workspaceId: string, pageId: string, overrides: Partial<PagePropertySet>): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebookPage.update(workspaceId, pageId, { pagePropertyOverrides: overrides });
      return;
    }
    return notebookDB.setPagePropertyOverrides(pageId, overrides);
  }

  async setPdfPageState(workspaceId: string, pageId: string, pdfPageState: PdfPageState): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebookPage.update(workspaceId, pageId, { pdfPageState });
      return;
    }
    return notebookDB.setPdfPageState(pageId, pdfPageState);
  }

  async applyPageDefaults(workspaceId: string, notebookId: string, updates: Partial<PagePropertySet>): Promise<NotebookPropertyBatchSnapshot> {
    if (typeof window !== 'undefined' && window.panvas) {
      return window.panvas.notebook.applyPageDefaults(workspaceId, notebookId, updates);
    }
    return notebookDB.applyPageDefaultsToNotebook(notebookId, updates);
  }

  async restorePageDefaults(workspaceId: string, snapshot: NotebookPropertyBatchSnapshot): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebook.restorePageDefaults(workspaceId, snapshot);
      return;
    }
    return notebookDB.restorePageDefaultsSnapshot(snapshot);
  }
  
  async toggleExpanded(workspaceId: string, id: string, isExpanded: boolean): Promise<void> { 
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebook.update(workspaceId, id, { isExpanded });
      return;
    }
    return notebookDB.toggleNotebookExpanded(id); 
  }

  async togglePin(workspaceId: string, id: string, isPinned: boolean): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebook.update(workspaceId, id, { isPinned });
      return;
    }
    return notebookDB.toggleNotebookPin(id, isPinned);
  }

  async updateLastOpened(workspaceId: string, id: string, openedAt = Date.now()): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebook.update(workspaceId, id, { lastOpenedAt: openedAt });
      return;
    }
    return notebookDB.updateNotebookLastOpened(id, openedAt);
  }

  async updatePageLastOpened(workspaceId: string, pageId: string, openedAt = Date.now()): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebookPage.update(workspaceId, pageId, { lastOpenedAt: openedAt });
      return;
    }
    return notebookDB.updatePageLastOpened(pageId, openedAt);
  }
  
  async toggleSectionExpanded(workspaceId: string, id: string, isExpanded: boolean): Promise<void> { 
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebookSection.update(workspaceId, id, { isExpanded });
      return;
    }
    return notebookDB.toggleSectionExpanded(id); 
  }
  
  async rename(workspaceId: string, id: string, name: string): Promise<void> { 
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebook.update(workspaceId, id, { name });
      return;
    }
    return notebookDB.renameNotebook(id, name); 
  }

  async updateCover(workspaceId: string, id: string, cover: NotebookCover): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebook.update(workspaceId, id, { cover });
      return;
    }
    return notebookDB.updateNotebookCover(id, cover);
  }
  
  async renameSection(workspaceId: string, id: string, name: string): Promise<void> { 
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebookSection.update(workspaceId, id, { name });
      return;
    }
    return notebookDB.renameSection(id, name); 
  }
  
  async renamePage(workspaceId: string, id: string, title: string): Promise<void> { 
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebookPage.update(workspaceId, id, { title });
      return;
    }
    return notebookDB.renamePage(id, title); 
  }
  
  async delete(workspaceId: string, id: string): Promise<void> { 
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebook.delete(workspaceId, id);
      return;
    }
    return notebookDB.deleteNotebook(id); 
  }
  
  async deleteSection(workspaceId: string, id: string): Promise<void> { 
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebookSection.delete(workspaceId, id);
      return;
    }
    return notebookDB.deleteSection(id); 
  }
  
  async deletePage(workspaceId: string, id: string): Promise<void> { 
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebookPage.delete(workspaceId, id);
      return;
    }
    return notebookDB.deletePage(id); 
  }
  
  async move(id: string, workspaceId: string, folderId: string | null): Promise<void> { 
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebook.update(workspaceId, id, { workspaceId, folderId });
      return;
    }
    return notebookDB.moveNotebook(id, workspaceId, folderId); 
  }

  async moveSection(id: string, workspaceId: string, notebookId: string): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebookSection.update(workspaceId, id, { notebookId });
      return;
    }
    return notebookDB.moveSection(id, notebookId);
  }

  async movePage(id: string, workspaceId: string, sectionId: string): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.notebookPage.update(workspaceId, id, { sectionId });
      return;
    }
    return notebookDB.movePage(id, sectionId);
  }
}

export const notebookRepository = new NotebookRepository();
