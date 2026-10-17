import { useAuthStore } from '@/stores/authStore';
import { workspaceRepository } from '@/repositories/WorkspaceRepository';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { notebookRepository } from '@/repositories/NotebookRepository';
import { initializeBrowserStorageDurability } from './browserStorageDurability';
import type { StorageOverview } from '@/types/storageOverview';

const cache = new Map<string, { value?: StorageOverview; pending?: Promise<StorageOverview> }>();
const CACHE_MS = 30_000;

export class StorageService {
  /** Lazy, coalesced inspection; explicit Refresh bypasses the settled cache. */
  static getMetrics(refresh = false): Promise<StorageOverview> {
    const userId = useAuthStore.getState().user?.id ?? null;
    const native = typeof window !== 'undefined' ? window.panvas?.storage : undefined;
    const key = native ? 'desktop' : userId ?? 'local';
    const entry = cache.get(key) ?? {};
    if (entry.pending) return entry.pending;
    if (!refresh && entry.value && Date.now() - entry.value.measuredAt < CACHE_MS) return Promise.resolve(entry.value);
    const pending = native ? native.getOverview(refresh) : this.inspectBrowser(userId);
    entry.pending = pending.then(value => { entry.value = value; return value; })
      .catch(error => { delete entry.value; throw error; }).finally(() => { delete entry.pending; });
    cache.set(key, entry);
    return entry.pending;
  }

  private static async inspectBrowser(userId: string | null): Promise<StorageOverview> {
    const [workspaces, canvases, notebooks, pages, durability] = await Promise.all([
      workspaceRepository.getAll(userId), canvasRepository.getAll(userId),
      notebookRepository.getAll(userId), notebookRepository.getPages(userId),
      initializeBrowserStorageDurability(),
    ]);
    const activeWorkspaceIds = new Set(workspaces.map(item => item.id));
    const activeNotebooks = notebooks.filter(item => activeWorkspaceIds.has(item.workspaceId));
    const notebookIds = new Set(activeNotebooks.map(item => item.id));
    let usedBytes: number | null = null, quotaBytes: number | null = null;
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (typeof estimate?.usage === 'number' && Number.isFinite(estimate.usage) && estimate.usage >= 0) usedBytes = estimate.usage;
      if (typeof estimate?.quota === 'number' && Number.isFinite(estimate.quota) && estimate.quota > 0) quotaBytes = estimate.quota;
    } catch { /* Unsupported or rejected estimates are unavailable, never zero. */ }
    const persistent = ['granted', 'already-persisted'].includes(durability.persistence);
    return {
      backend: 'browser', counts: {
        workspaces: workspaces.length,
        canvases: canvases.filter(item => activeWorkspaceIds.has(item.workspaceId)).length,
        notebooks: activeNotebooks.length, pages: pages.filter(item => notebookIds.has(item.notebookId)).length,
      }, countsComplete: true, usedBytes, usageKind: usedBytes === null ? 'unavailable' : 'estimated', quotaBytes,
      health: persistent && usedBytes !== null ? 'accessible' : 'attention',
      healthDetail: `Local repositories were read successfully. ${durability.message}`,
      root: null, measuredAt: Date.now(), issues: [],
    };
  }

  static formatBytes(bytes: number, decimals = 1): string {
    if (bytes === 0) return '0 Bytes';
    const unit = Math.min(4, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))));
    return `${parseFloat((bytes / 1024 ** unit).toFixed(decimals))} ${['Bytes', 'KB', 'MB', 'GB', 'TB'][unit]}`;
  }
}
