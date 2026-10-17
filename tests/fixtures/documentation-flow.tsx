import './documentation-engine';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { notebookRepository } from '../../src/repositories/NotebookRepository';
import { documentPaginationKey } from '../../src/components/notebook/documentPagination';
Object.assign(window, { flowFixture: {
  gapPositions: () => {
    const engine = (window as any).richFixture.engine(), body = engine.texts.getTexts().find((text: any) => text.metadata?.documentRole === 'body');
    const editor = body && engine.texts.getEditor(body.id);
    return editor ? documentPaginationKey.getState(editor.state)?.find().map(gap => gap.from) ?? [] : [];
  },
  body: () => {
    const engine = (window as any).richFixture.engine();
    return engine.texts.getTexts().find((text: any) => text.metadata?.documentRole === 'body');
  },
  editor: () => {
    const engine = (window as any).richFixture.engine();
    const body = engine.texts.getTexts().find((text: any) => text.metadata?.documentRole === 'body');
    return body && engine.texts.getEditor(body.id);
  },
  pageIds: () => {
    const state = useWorkspaceStore.getState();
    return state.notebookPages.filter(page => page.notebookId === state.activeNotebookId && !page.deletedAt).map(page => page.id);
  },
  location: () => ({ workspaceId: useWorkspaceStore.getState().activeWorkspaceId, pageId: useWorkspaceStore.getState().activePageId }),
  activate: (pageId: string) => useWorkspaceStore.getState().setActivePage(pageId),
  resume: async (workspaceId: string, pageId: string) => {
    await useWorkspaceStore.getState().loadWorkspaces();
    await useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
    await useWorkspaceStore.getState().setActivePage(pageId);
  },
  saveTiming: async () => {
    const state = useWorkspaceStore.getState(), engine = (window as any).richFixture.engine();
    const started = performance.now(), data = engine.getDrawingData(), captureMs = performance.now() - started;
    const serialized = performance.now(), bytes = new Blob([JSON.stringify(data)]).size, serializeMs = performance.now() - serialized;
    const saving = performance.now();
    await notebookRepository.saveDrawingData(state.activeWorkspaceId!, state.activeNotebookId!, state.activePageId!, data);
    return { captureMs, serializeMs, saveMs: performance.now() - saving, bytes };
  },
} });
