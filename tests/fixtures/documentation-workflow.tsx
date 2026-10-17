import { NotebookEngine } from '../../src/components/notebook/engine/NotebookEngine';
import { TextManager } from '../../src/components/notebook/engine/TextManager';
import { DrawingEngine } from '../../src/components/notebook/engine/DrawingEngine';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { notebookRepository } from '../../src/repositories/NotebookRepository';
import { documentSheetStride } from '../../src/components/notebook/documentFlowGeometry';
import { lowlight } from '../../src/components/notebook/tiptapExtensions';

// The real application initializes and creates its own workspace through its UI.
// This fixture only observes its engine/editor and profiles inclusive work.
let engine: NotebookEngine | undefined, active = false;
const lifecycle: unknown[] = [];
const trace = (type: string, detail: unknown = null) => { lifecycle.push({ at: performance.now(), type, detail, active: useWorkspaceStore.getState().activePageId, owner: engine?.getDrawingOwnership().pageId, top: document.querySelector('.notebook-viewport')?.scrollTop }); if (lifecycle.length > 300) lifecycle.shift(); };
useWorkspaceStore.subscribe((next, previous) => { if (next.activePageId !== previous.activePageId) trace('active-page', next.activePageId); });
let metrics: Record<string, { count: number; totalMs: number; maxMs: number }> = {}, frames: number[] = [], pointerFrames: number[] = [];
const record = (key: string, duration = 0) => {
  if (!active) return;
  const value = metrics[key] ??= { count: 0, totalMs: 0, maxMs: 0 };
  value.count++; value.totalMs += duration; value.maxMs = Math.max(value.maxMs, duration);
};
const instrument = (target: any, key: string, name = key) => {
  const original = target[key];
  target[key] = function(...args: any[]) {
    const started = performance.now();
    const result = original.apply(this, args);
    if (result?.then) return result.finally(() => record(name, performance.now() - started));
    record(name, performance.now() - started); return result;
  };
};
const mount = NotebookEngine.prototype.mount;
NotebookEngine.prototype.mount = function(...args) { engine = this; trace('mount', args[0].dataset); return mount.apply(this, args); };
const loadDrawing = NotebookEngine.prototype.setDrawingData;
NotebookEngine.prototype.setDrawingData = function(...args) { engine = this; trace('load-drawing', args[1]); return loadDrawing.apply(this, args); };
const unmount = NotebookEngine.prototype.unmount;
NotebookEngine.prototype.unmount = function(...args) { trace('unmount'); return unmount.apply(this, args); };
instrument(NotebookEngine.prototype, 'getDrawingData', 'sceneCapture');
instrument(DrawingEngine.prototype, 'redraw', 'drawingRedraw');
instrument(lowlight, 'highlight', 'syntaxHighlight');
instrument(JSON, 'stringify', 'stringify'); instrument(window, 'structuredClone', 'clone');
instrument(notebookRepository, 'saveDrawingData', 'repositoryWrite');
instrument(document.fonts, 'load', 'fontLoad');
document.fonts.addEventListener('loadingdone', event => {
  record('fontLoadingDone');
  for (const _face of event.fontfaces) record('fontFaceLoaded');
});
const writes: any[] = [], saveDrawing = notebookRepository.saveDrawingData;
notebookRepository.saveDrawingData = async function(workspaceId, notebookId, pageId, data, ...args) {
  const body = data.objects?.find((object: any) => object.metadata?.documentRole === 'body');
  const record = { at: performance.now(), pageId, revision: engine?.getDrawingOwnership().revision, extent: data.properties.layoutExtent, ending: (JSON.stringify(body?.content) ?? '').slice(-200), complete: false };
  writes.push(record); await saveDrawing.call(this, workspaceId, notebookId, pageId, data, ...args); record.complete = true;
};
const register = TextManager.prototype.registerEditor, editors = new WeakSet<object>();
TextManager.prototype.registerEditor = function(id, editor) {
  if (!editors.has(editor)) {
    editors.add(editor); instrument(editor, 'getJSON', 'editorJSON'); instrument(editor.view, 'dispatch', 'dispatch');
    instrument(editor.view, 'coordsAtPos', 'caretMeasurement');
    editor.on('transaction', ({ transaction }: any) => { record('transactions'); if (transaction.docChanged) record('docTransactions'); if (transaction.selectionSet) record('selectionTransactions'); if (Object.keys(transaction.meta).some(key => key.includes('panvasDocumentPagination'))) record('paginationTransactions'); });
    editor.on('destroy', () => record('editorDestroy'));
  }
  return register.call(this, id, editor);
};
const observer = ResizeObserver;
window.ResizeObserver = class extends observer { constructor(callback: ResizeObserverCallback) { super((entries, instance) => { const started = performance.now(); callback(entries, instance); record('resizeObserver', performance.now() - started); }); } };
new PerformanceObserver(list => list.getEntries().forEach(value => record('longTask', value.duration))).observe({ type: 'longtask', buffered: false });
document.addEventListener('pointerdown', () => {
  if (!active) return;
  const started = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => { if (active) pointerFrames.push(performance.now() - started); }));
}, true);
document.addEventListener('click', event => {
  if (!active || !(event.target instanceof Element) || !event.target.closest('[aria-label="Copy code"]')) return;
  const button = event.target.closest('[aria-label="Copy code"]')!, started = performance.now();
  const observer = new MutationObserver(() => { if (button.getAttribute('aria-label') === 'Copied' || button.getAttribute('aria-label') === 'Could not copy') { record('copyFeedback', performance.now() - started); observer.disconnect(); } });
  observer.observe(button, { attributes: true, attributeFilter: ['aria-label'] });
}, true);
document.addEventListener('beforeinput', event => { if (!active || !(event.target instanceof Element) || !event.target.closest('.ProseMirror')) return; const started = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => { if (active) frames.push(performance.now() - started); })); }, true);
const editor = () => { const text = engine?.texts.getTexts().find(text => text.metadata?.documentRole === 'body') ?? engine?.texts.getTexts().find(text => text.id === engine?.texts.getActiveTextId()) ?? engine?.texts.getTexts()[0]; return text && engine?.texts.getEditor(text.id); };
Object.assign(window, { workflowProbe: {
  engine: () => engine, editor, commit: (_phase: string, duration: number) => record('reactCommit', duration), nodeView: (kind: string) => record('codeNodeView-' + kind),
  writes: () => writes,
  lifecycle: () => lifecycle,
  sheetStride: () => documentSheetStride(engine!.getProperties()),
  positioned: () => structuredClone({ strokes: engine?.drawing.getStrokes(), shapes: engine?.shapes.getShapes(), images: engine?.images.getImages() }),
  ready: () => engine?.getDrawingOwnership().pageId === useWorkspaceStore.getState().activePageId && Boolean(engine?.drawing.getCanvasElement()),
  begin: () => { active = true; metrics = {}; frames = []; pointerFrames = []; }, end: () => { active = false; return { metrics, frames, pointerFrames }; },
  location: () => { const state = useWorkspaceStore.getState(); return { workspaceId: state.activeWorkspaceId, notebookId: state.activeNotebookId, pageId: state.activePageId, sectionId: state.activeNotebookSectionId, restored: state.initialDocumentRestoreComplete }; },
  snapshot: () => ({ location: (window as any).workflowProbe.location(), owner: engine?.getDrawingOwnership().pageId, canvasOwner: engine?.drawing.getCanvasElement()?.dataset.renderedPageId, editorOwner: editor()?.view.dom.closest('[data-rendered-page-id]')?.getAttribute('data-rendered-page-id'), scrollTop: document.querySelector('.notebook-viewport')?.scrollTop, properties: engine?.getProperties(), texts: structuredClone(engine?.texts.getTexts() ?? []), notebooks: useWorkspaceStore.getState().notebooks.map(notebook => ({ id: notebook.id, name: notebook.name })), pages: useWorkspaceStore.getState().notebookPages.map(page => ({ id: page.id, title: page.title, sectionId: page.sectionId, order: page.order, overrides: page.pagePropertyOverrides })) }),
  saved: async () => { const state = useWorkspaceStore.getState(); return notebookRepository.loadDrawingData(state.activeWorkspaceId!, state.activeNotebookId!, state.activePageId!); },
} });
if (!window.panvas) history.replaceState(null, '', '/app');
// There is no legacy workspace in this disposable profile. Measure the normal
// editing path independently of the deferred first-run Dexie import.
else if (!new URLSearchParams(location.search).has('firstRun')) localStorage.setItem('panvas.dexieMigration.canonicalDestinations.v1', 'true');
