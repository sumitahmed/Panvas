let worker: Worker | undefined;
let sequence = 0;
let unavailable = false;
const pending = new Map<number, { resolve: (saved: boolean) => void; reject: (error: Error) => void }>();

/** False means transport unavailable: caller uses the existing in-thread path. */
export async function saveLargeDrawingOffThread(workspaceId: string, notebookId: string, pageId: string, json: string): Promise<boolean> {
  if (json.length < 512_000 || unavailable || typeof Worker === 'undefined') return false;
  if (!worker) {
    try {
      worker = new Worker(new URL('./drawingSaveWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => {
        const request = pending.get(event.data.id);
        if (!request) return;
        pending.delete(event.data.id);
        if (event.data.ok) request.resolve(true);
        else request.reject(new Error(event.data.error || 'Drawing save failed.'));
      };
      worker.onerror = () => {
        unavailable = true;
        worker?.terminate(); worker = undefined;
        for (const request of pending.values()) request.resolve(false);
        pending.clear();
      };
    } catch { unavailable = true; return false; }
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    try { worker!.postMessage({ id, workspaceId, notebookId, pageId, json }); }
    catch { pending.delete(id); resolve(false); }
  });
}
