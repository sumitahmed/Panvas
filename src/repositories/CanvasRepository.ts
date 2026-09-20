// ============================================
// Panvas — Canvas Repository
// Bridges local DB ↔ Sync Queue ↔ Supabase
// ============================================

import * as workspaceDB from '@/database/workspaceDB';
import * as canvasDB from '@/database/canvasDB';
import { db } from '@/database/schema';
import type { CanvasFile } from '@/types/workspace';
import type { CanvasData, CustomBlock, BlockType, PdfFileData, ImageFileData } from '@/types/canvas';
import type { SyncQueueItem } from '@/types/sync';
import { buildCanonicalCanvasPayload, isValidCanvasScenePayload, selectCanonicalCanvasScene } from './canvasSceneStorage';
import { recordLocalChangeDetached } from '@/services/cloudsync/recordLocalChange';
import { gate0Profiler } from '@/dev/gate0Profiler';

export class CanvasRepository {
  // ---- Canvas File CRUD ----

  async create(userId: string | null, workspaceId: string, folderId: string | null, notebookId: string | null, sectionId: string | null, name: string): Promise<CanvasFile> {
    if (typeof window !== 'undefined' && window.panvas) {
      return await window.panvas.canvasFile.create(workspaceId, name, folderId, notebookId, sectionId);
    }
    const canvas = await workspaceDB.createCanvasFile(userId, workspaceId, folderId, notebookId, sectionId, name);
    await this.queueSync('canvasFile', canvas.id, 'create', canvas);
    return canvas;
  }

  async rename(userId: string | null, workspaceId: string, id: string, name: string): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.canvasFile.update(workspaceId, id, { name });
      return;
    }
    await workspaceDB.renameCanvasFile(id, name);
    const updated = await db.canvasFiles.get(id);
    if (updated) {
      await this.queueSync('canvasFile', id, 'update', updated);
    }
  }

  async duplicate(userId: string | null, id: string): Promise<CanvasFile | null> {
    const canvas = await workspaceDB.duplicateCanvasFile(userId, id);
    if (canvas) {
      // Sync the duplicated file and data
      await this.queueSync('canvasFile', canvas.id, 'create', canvas);
      const data = await canvasDB.getCanvasData(userId, canvas.id);
      if (data) {
        await this.queueSync('canvasData', canvas.id, 'update', data);
      }
    }
    return canvas;
  }

  async move(userId: string | null, id: string, workspaceId: string, folderId: string | null, notebookId: string | null, sectionId: string | null): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.canvasFile.update(workspaceId, id, { workspaceId, folderId, notebookId, sectionId });
      return;
    }
    await workspaceDB.moveCanvasFile(id, workspaceId, folderId, notebookId, sectionId);
    const updated = await db.canvasFiles.get(id);
    if (updated) {
      await this.queueSync('canvasFile', id, 'update', updated);
    }
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.canvasFile.update(workspaceId, id, { deletedAt: Date.now() });
      return;
    }
    await workspaceDB.deleteCanvasFile(id, true); // soft delete
    const deleted = await db.canvasFiles.get(id);
    if (deleted) {
      await this.queueSync('canvasFile', id, 'update', deleted);
    }
  }

  async restore(workspaceId: string, id: string): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.canvasFile.update(workspaceId, id, { deletedAt: null });
      return;
    }
    await workspaceDB.restoreCanvasFile(id);
    const updated = await db.canvasFiles.get(id);
    if (updated) {
      await this.queueSync('canvasFile', id, 'update', updated);
    }
  }

  async permanentlyDelete(workspaceId: string, id: string): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.trash.permanentlyDelete(workspaceId, id, 'canvas');
      return;
    }
    await workspaceDB.deleteCanvasFile(id, false);
    await this.queueSync('canvasFile', id, 'delete', { id });
  }

  async getByWorkspace(userId: string | null, workspaceId: string): Promise<CanvasFile[]> {
    return workspaceDB.getCanvasFilesByWorkspace(userId, workspaceId);
  }

  async getAll(userId: string | null): Promise<CanvasFile[]> {
    if (typeof window !== 'undefined' && window.panvas) {
      const workspaces = await window.panvas.workspace.getAll();
      let allCanvases: CanvasFile[] = [];
      for (const ws of workspaces.filter((workspace: any) => !workspace.deletedAt)) {
        const canvases = await window.panvas.canvasFile.getAll(ws.id);
        allCanvases = allCanvases.concat(canvases.filter((c: any) => !c.deletedAt));
      }
      return allCanvases;
    }
    return workspaceDB.getAllCanvasFiles(userId);
  }

  async getByFolder(userId: string | null, workspaceId: string, folderId: string | null): Promise<CanvasFile[]> {
    return workspaceDB.getCanvasFilesByFolder(userId, workspaceId, folderId);
  }

  async getRecent(userId: string | null, limit: number = 10): Promise<CanvasFile[]> {
    if (typeof window !== 'undefined' && window.panvas) {
      const workspaces = await window.panvas.workspace.getAll();
      let allCanvases: CanvasFile[] = [];
      for (const ws of workspaces.filter((workspace: any) => !workspace.deletedAt)) {
        const canvases = await window.panvas.canvasFile.getAll(ws.id);
        allCanvases = allCanvases.concat(canvases);
      }
      return allCanvases
        .filter(canvas => !canvas.deletedAt)
        .sort((a, b) => (b.lastOpenedAt ?? b.updatedAt ?? 0) - (a.lastOpenedAt ?? a.updatedAt ?? 0))
        .slice(0, limit);
    }
    return workspaceDB.getRecentCanvasFiles(userId, limit);
  }

  async updateLastOpened(workspaceIdOrId: string, id?: string, openedAt = Date.now()): Promise<void> {
    const canvasId = id ?? workspaceIdOrId;
    if (typeof window !== 'undefined' && window.panvas) {
      const workspaceId = id ? workspaceIdOrId : (await db.canvasFiles.get(canvasId))?.workspaceId;
      if (!workspaceId) return;
      await window.panvas.canvasFile.update(workspaceId, canvasId, { lastOpenedAt: openedAt });
      return;
    }
    return workspaceDB.updateCanvasLastOpened(canvasId, openedAt);
  }

  async togglePin(workspaceId: string, id: string, isPinned: boolean): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.canvasFile.update(workspaceId, id, { isPinned });
      return;
    }
    await workspaceDB.togglePinCanvas(id, isPinned);
    const updated = await db.canvasFiles.get(id);
    if (updated) {
      await this.queueSync('canvasFile', id, 'update', updated);
    }
  }

  // ---- Canvas Data (Excalidraw scene) ----

  /**
   * Resolves the owning workspace for an Electron canvas. Callers normally
   * pass it; the fallback scans workspace metadata once (cheap relative to a
   * scene save) so legacy call sites cannot bypass canonical storage.
   */
  private async resolveElectronWorkspaceId(canvasFileId: string, workspaceId?: string): Promise<string | null> {
    if (workspaceId) return workspaceId;
    const runtime = globalThis as unknown as { panvas?: { workspace: { getAll(): Promise<Array<{ id: string; deletedAt?: number | null }>> }; canvasFile: { getAll(wsId: string): Promise<Array<{ id: string }>> } } };
    if (!runtime.panvas) return null;
    try {
      const workspaces = await runtime.panvas.workspace.getAll();
      for (const workspace of workspaces.filter(entry => !entry.deletedAt)) {
        const canvases = await runtime.panvas.canvasFile.getAll(workspace.id);
        if (canvases.some(canvas => canvas.id === canvasFileId)) return workspace.id;
      }
    } catch (error) {
      console.warn('[CanvasRepo] workspace resolution failed:', error);
    }
    return null;
  }

  private async resolveAssetWorkspaceId(ownerId: string): Promise<string | null> {
    if (typeof window !== 'undefined' && window.panvas) {
      const workspaces = await window.panvas.workspace.getAll();
      for (const workspace of workspaces) {
        const [canvases, pages] = await Promise.all([
          window.panvas.canvasFile.getAll(workspace.id), window.panvas.notebookPage.getAll(workspace.id),
        ]);
        if (canvases.some(item => item.id === ownerId) || pages.some(item => item.id === ownerId)) return workspace.id;
      }
      return null;
    }
    const canvas = await db.canvasFiles.get(ownerId);
    if (canvas) return canvas.workspaceId;
    const page = await db.notebookPages.get(ownerId);
    if (!page) return null;
    return (await db.notebooks.get(page.notebookId))?.workspaceId ?? null;
  }

  /** A loadable canonical scene must at least identify itself and carry elements. */
  private static isValidScenePayload(value: unknown): value is CanvasData {
    return Boolean(
      value && typeof value === 'object'
      && typeof (value as CanvasData).canvasFileId === 'string'
      && Array.isArray((value as CanvasData).elements),
    );
  }

  /**
   * Electron: the filesystem `Canvas/<canvasId>.json` is the single canonical
   * scene store. Legacy IndexedDB scenes (written before filesystem parity)
   * participate exactly once: if the stored Dexie scene is strictly newer it
   * is written FORWARD to the filesystem — never the reverse — so user data
   * cannot regress. Ties and unknown timestamps go to the filesystem.
   */
  async loadData(userId: string | null, canvasFileId: string, workspaceId?: string): Promise<CanvasData | undefined> {
    if (typeof window !== 'undefined' && window.panvas) {
      const workspace = await this.resolveElectronWorkspaceId(canvasFileId, workspaceId);
      if (!workspace) return canvasDB.getCanvasData(userId, canvasFileId);

      const [rawFileScene, legacyScene] = await Promise.all([
        window.panvas.canvas.load(workspace, canvasFileId).catch((error: unknown) => {
          console.warn('[CanvasRepo] canonical canvas read failed:', error);
          return null;
        }),
        canvasDB.getCanvasData(userId, canvasFileId),
      ]);
      const fileScene = isValidCanvasScenePayload(rawFileScene) ? rawFileScene : null;
      const { scene: canonical, writeForwardLegacy } = selectCanonicalCanvasScene(fileScene, legacyScene ?? null);

      // One-time write-forward of newer legacy data (including adopting a
      // legacy-only scene into a missing canonical file).
      if (writeForwardLegacy && canonical) {
        await window.panvas.canvas.save(workspace, canvasFileId, canonical).catch((error: unknown) => {
          console.warn('[CanvasRepo] legacy canvas write-forward failed:', error);
        });
      }

      // Custom blocks live inside the canonical payload; mirror them into the
      // renderer's Dexie block cache only when that cache has none for this
      // canvas (fresh restore / first load on a new profile).
      const embeddedBlocks = canonical?.customBlocks ?? [];
      if (embeddedBlocks.length > 0) {
        const existingBlocks = await canvasDB.getBlocksByCanvas(userId, canvasFileId);
        if (existingBlocks.length === 0) {
          await canvasDB.importCustomBlocks(userId, embeddedBlocks).catch(error => {
            console.warn('[CanvasRepo] block mirror from canonical scene failed:', error);
          });
        }
      }
      return canonical ?? undefined;
    }
    return canvasDB.getCanvasData(userId, canvasFileId);
  }

  /**
   * Electron: write the complete canonical payload (scene + embedded custom
   * blocks) through the validated IPC bridge into the atomic write queue.
   * Dexie canvasData stops being written in Electron — it remains only as
   * legacy data for the one-time arbitration above. Browser behavior is
   * unchanged (IndexedDB + sync queue).
   */
  async saveData(userId: string | null, data: Partial<CanvasData> & { canvasFileId: string }, workspaceId?: string): Promise<void> {
    if (typeof window !== 'undefined' && window.panvas) {
      const workspace = await this.resolveElectronWorkspaceId(data.canvasFileId, workspaceId);
      if (!workspace) throw new Error(`Cannot persist canvas ${data.canvasFileId}: workspace not found.`);
      // The IPC contract returns a scene object or null, never a tuple.
      // A read error must propagate: treating it as absence could discard
      // previous fields during a partial save.
      const rawPrevious = await window.panvas.canvas.load(workspace, data.canvasFileId);
      const previous = isValidCanvasScenePayload(rawPrevious) ? rawPrevious : null;
      const customBlocks = await canvasDB.getBlocksByCanvas(userId, data.canvasFileId);
      const payload = buildCanonicalCanvasPayload(data, previous, customBlocks, userId, Date.now());
      await window.panvas.canvas.save(workspace, data.canvasFileId, payload);
      recordLocalChangeDetached({
        entityType: 'canvasScene',
        entityId: data.canvasFileId,
        workspaceId: workspace,
        operation: previous ? 'update' : 'create',
        payload: { elements: payload.elements, customBlocks: payload.customBlocks },
      });
      return;
    }
    await canvasDB.saveCanvasData(userId, data);
    // Queue canvas data for sync
    const full = await canvasDB.getCanvasData(userId, data.canvasFileId);
    if (full) {
      await this.queueSync('canvasData', data.canvasFileId, 'update', full);
    }
  }

  // ---- Custom Blocks ----

  async loadBlocks(userId: string | null, canvasFileId: string): Promise<CustomBlock[]> {
    return canvasDB.getBlocksByCanvas(userId, canvasFileId);
  }

  async addBlock(userId: string | null, block: Omit<CustomBlock, 'id' | 'createdAt' | 'updatedAt' | 'userId'>): Promise<CustomBlock> {
    return canvasDB.addCustomBlock(userId, block);
  }

  async updateBlock(id: string, updates: Partial<CustomBlock>): Promise<void> {
    return canvasDB.updateCustomBlock(id, updates);
  }

  async deleteBlock(id: string): Promise<void> {
    return canvasDB.deleteCustomBlock(id);
  }

  // ---- PDF ----

  /**
   * PDF bytes are dual-written: Dexie stays the immediate local cache (and the
   * only store in browser mode), while Electron also persists the bytes under
   * Documents/Panvas/Assets via IPC. IndexedDB alone is origin/profile scoped —
   * dev vs packaged builds and http vs file:// origins each get a separate
   * database — so filesystem storage is what makes an imported PDF survive
   * restarts and profile changes.
   */
  async storePdf(userId: string | null, canvasFileId: string, fileName: string, data: ArrayBuffer): Promise<PdfFileData> {
    const pdfFile = await canvasDB.storePdfFile(userId, canvasFileId, fileName, data);
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.binary.storePdf(pdfFile.id, fileName, data);
    }
    const workspaceId = await this.resolveAssetWorkspaceId(canvasFileId);
    if (workspaceId) recordLocalChangeDetached({ entityType: 'asset', entityId: pdfFile.id, workspaceId, operation: 'create', payload: { ownerId: canvasFileId, fileName } });
    return pdfFile;
  }

  async getPdf(userId: string | null, id: string): Promise<PdfFileData | undefined> {
    const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    const finishProfile = (source: string) => {
      if (startedAt) gate0Profiler.event('pdf-repository-read', performance.now() - startedAt, { id, source });
    };
    if (typeof window !== 'undefined' && window.panvas) {
      const stored = await window.panvas.binary.getPdf(id).catch(() => null);
      if (stored?.data) {
        const meta = await canvasDB.getPdfFile(userId, id).catch(() => undefined);
        finishProfile('electron');
        return {
          id,
          canvasFileId: meta?.canvasFileId ?? '',
          fileName: stored.fileName || meta?.fileName || 'document.pdf',
          data: stored.data,
          createdAt: meta?.createdAt ?? 0,
          userId: meta?.userId ?? userId ?? '',
        };
      }
    }
    const local = await canvasDB.getPdfFile(userId, id);
    // Lazy migration: bytes that exist only in this profile's IndexedDB (from
    // before filesystem storage existed) are written through so they survive
    // the next profile or origin change.
    if (local && typeof window !== 'undefined' && window.panvas) {
      await window.panvas.binary.storePdf(id, local.fileName, local.data).catch(err => {
        console.warn('[CanvasRepo] PDF write-through to filesystem failed:', err);
      });
    }
    finishProfile('dexie');
    return local;
  }

  // ---- Image ----
  // Images follow the same durability contract as PDFs: Dexie stays the
  // immediate local cache (and the only store in browser mode), while
  // Electron also persists the bytes under Documents/Panvas/Assets so they
  // survive profile or origin changes.
  async storeImage(userId: string | null, canvasFileId: string, fileName: string, mimeType: string, data: ArrayBuffer): Promise<ImageFileData> {
    const imageFile = await canvasDB.storeImageFile(userId, canvasFileId, fileName, mimeType, data);
    if (typeof window !== 'undefined' && window.panvas) {
      await window.panvas.binary.storeImage(imageFile.id, fileName, mimeType, data);
    }
    const workspaceId = await this.resolveAssetWorkspaceId(canvasFileId);
    if (workspaceId) recordLocalChangeDetached({ entityType: 'asset', entityId: imageFile.id, workspaceId, operation: 'create', payload: { ownerId: canvasFileId, fileName, mimeType } });
    return imageFile;
  }

  async getImage(id: string): Promise<ImageFileData | undefined> {
    const startedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    const finishProfile = (source: string) => {
      if (startedAt) gate0Profiler.event('image-repository-read', performance.now() - startedAt, { id, source });
    };
    if (typeof window !== 'undefined' && window.panvas) {
      const stored = await window.panvas.binary.getImage(id).catch(() => null);
      if (stored?.data) {
        finishProfile('electron');
        return {
          id,
          canvasFileId: '',
          fileName: stored.fileName,
          mimeType: stored.mimeType,
          data: stored.data,
          createdAt: 0,
          userId: '',
        };
      }
    }
    const local = await canvasDB.getImageFile(id);
    // Lazy migration for images that exist only in this profile's IndexedDB.
    if (local && typeof window !== 'undefined' && window.panvas) {
      await window.panvas.binary.storeImage(id, local.fileName, local.mimeType, local.data).catch(err => {
        console.warn('[CanvasRepo] image write-through to filesystem failed:', err);
      });
    }
    finishProfile('dexie');
    return local;
  }

  async deleteImage(id: string): Promise<void> {
    return canvasDB.deleteImageFile(id);
  }

  async storeAudio(userId: string | null, ownerId: string, fileName: string, mimeType: string, data: ArrayBuffer): Promise<ImageFileData> {
    if (!/^audio\//i.test(mimeType)) throw new Error('Unsupported audio format.');
    if (data.byteLength > 100 * 1024 * 1024) throw new Error('Audio note exceeds the 100 MB local limit.');
    const asset = await canvasDB.storeImageFile(userId, ownerId, fileName, mimeType, data);
    if (typeof window !== 'undefined' && window.panvas) await window.panvas.binary.storeAudio(asset.id, fileName, mimeType, data);
    const workspaceId = await this.resolveAssetWorkspaceId(ownerId);
    if (workspaceId) recordLocalChangeDetached({ entityType: 'asset', entityId: asset.id, workspaceId, operation: 'create', payload: { ownerId, fileName, mimeType } });
    return asset;
  }

  async getAudio(id: string): Promise<ImageFileData | undefined> {
    if (typeof window !== 'undefined' && window.panvas) {
      const stored = await window.panvas.binary.getAudio(id).catch(() => null);
      if (stored?.data) return { id, canvasFileId: '', fileName: stored.fileName, mimeType: stored.mimeType, data: stored.data, createdAt: 0, userId: '' };
    }
    return canvasDB.getImageFile(id);
  }

  async deleteAudio(id: string): Promise<void> {
    await canvasDB.deleteImageFile(id);
    if (typeof window !== 'undefined' && window.panvas) await window.panvas.binary.deleteAudio(id);
  }

  // ---- Sync helpers ----

  private async queueSync(
    entityType: SyncQueueItem['entityType'],
    entityId: string,
    action: SyncQueueItem['action'],
    data: unknown
  ): Promise<void> {
    try {
      await db.syncQueue.add({
        entityType,
        entityId,
        action,
        data,
        status: 'pending',
        attempts: 0,
        createdAt: Date.now(),
      });
    } catch (err) {
      console.warn('[CanvasRepo] Failed to queue sync:', err);
    }
  }
}

export const canvasRepository = new CanvasRepository();
