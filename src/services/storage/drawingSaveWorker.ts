import { saveDrawingData } from '../../database/notebookDB';

// Same database, ownership check and atomic drawing/page transaction as the UI.
// Only the JSON decoding and IndexedDB structured clone run outside the renderer.
let tail = Promise.resolve();
self.onmessage = (event: MessageEvent<{ id: number; workspaceId: string; notebookId: string; pageId: string; json: string }>) => {
  tail = tail.then(async () => {
  const { id, workspaceId, notebookId, pageId, json } = event.data;
  try {
    await saveDrawingData(workspaceId, notebookId, pageId, JSON.parse(json));
    self.postMessage({ id, ok: true });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : 'Drawing save failed.' });
  }
  });
};
