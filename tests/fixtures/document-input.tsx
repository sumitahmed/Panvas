import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppearanceSection } from '../../src/components/settings/sections/AppearanceSection';
import { getDocument } from 'pdfjs-dist';
import { AppShell } from '../../src/components/layout/AppShell';
import { NotebookRenderer } from '../../src/components/notebook/NotebookRenderer';
import { PdfWorkspace } from '../../src/components/pdf/PdfWorkspace';
import { NotebookEngine } from '../../src/components/notebook/engine/NotebookEngine';
import { DrawingEngine } from '../../src/components/notebook/engine/DrawingEngine';
import { WetInkSurface } from '../../src/components/notebook/engine/WetInkSurface';
import { createEmptyDrawingData } from '../../src/components/notebook/engine/drawingTypes';
import { notebookRepository } from '../../src/repositories/NotebookRepository';
import { canvasRepository } from '../../src/repositories/CanvasRepository';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { useLayoutStore } from '../../src/stores/layoutStore';
import { useUIStore } from '../../src/stores/uiStore';
import { resolvePageSurfaceGeometry } from '../../src/lib/pageProperties';
import { pdfAnnotationStorageId } from '../../src/services/search/searchIndexEvents';
import { applyThemeClasses, readAndMigrateTheme } from '../../src/lib/theme';
import '../../src/styles/index.css';

let appearanceProbe: { root: Root; host: HTMLDivElement } | undefined;
export function mountAppearanceProbe() {
  const host = document.createElement('div');
  host.dataset.appearanceProbe = '';
  host.style.cssText = 'position:fixed;right:16px;top:110px;width:450px;padding:16px;background:var(--bg-primary);z-index:100';
  document.body.append(host);
  const root = createRoot(host);
  root.render(<AppearanceSection />);
  appearanceProbe = { root, host };
}
export function unmountAppearanceProbe() {
  appearanceProbe?.root.unmount();
  appearanceProbe?.host.remove();
  appearanceProbe = undefined;
}

const counters: Record<string, number> = {};
const engines = new Set<NotebookEngine>();
const bump = (name: string, count = 1) => { counters[name] = (counters[name] ?? 0) + count; };
const work = { bump, reset: () => { for (const key of Object.keys(counters)) delete counters[key]; }, report: () => ({ ...counters }) };
Object.assign(window, { __documentWork: work });
const pointerEvents: Record<string, unknown>[] = [];
Object.assign(window, { __documentPointerEvents: pointerEvents });
for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, event => {
  const pointer = event as PointerEvent;
  pointerEvents.push({ type, target: (event.target as HTMLElement)?.tagName, pointerType: pointer.pointerType, x: pointer.clientX, y: pointer.clientY, buttons: pointer.buttons });
  if (pointerEvents.length > 30) pointerEvents.shift();
}, true);
const capture = Element.prototype.setPointerCapture;
Element.prototype.setPointerCapture = function (id) {
  try { capture.call(this, id); pointerEvents.push({ type: 'capture', id, captured: this.hasPointerCapture(id) }); }
  catch (error) { pointerEvents.push({ type: 'capture-failed', id, error: String(error) }); throw error; }
};

function wrap(object: any, method: string, name: string, after?: (self: any, result: any, args: any[]) => void) {
  const original = object[method];
  object[method] = function (...args: any[]) {
    bump(name);
    const result = original.apply(this, args);
    after?.(this, result, args);
    return result;
  };
}
wrap(NotebookEngine.prototype, 'mount', 'engineMounts', self => { engines.add(self); });
wrap(NotebookEngine.prototype, 'unmount', 'engineUnmounts');
wrap(NotebookEngine.prototype, 'resize', 'engineResizes');
wrap(NotebookEngine.prototype, 'getDrawingData', 'sceneSnapshots');
wrap(DrawingEngine.prototype, 'redraw', 'redraws');
wrap(DrawingEngine.prototype, 'renderLiveStroke', 'liveRequests');
wrap(WetInkSurface.prototype, 'render', 'wetDraws', (_self, result) => {
  bump('wetPrimitives', result.primitives); bump('wetDirtyPixels', result.dirtyPixels);
});
wrap(notebookRepository, 'saveDrawingData', 'drawingSaves');

const bounds = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () { bump('layoutReads'); return bounds.call(this); };
for (const field of ['width', 'height']) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, field)!;
  Object.defineProperty(HTMLCanvasElement.prototype, field, { ...descriptor, set(value) { bump('canvasResizes'); descriptor.set!.call(this, value); } });
}
for (const field of ['scrollTop', 'scrollLeft']) {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, field)!;
  Object.defineProperty(Element.prototype, field, { ...descriptor, set(value) { bump(field + 'Writes'); descriptor.set!.call(this, value); } });
}
const NativeResizeObserver = window.ResizeObserver;
window.ResizeObserver = class extends NativeResizeObserver {
  constructor(callback: ResizeObserverCallback) { super((entries, observer) => { bump('resizeCallbacks'); callback(entries, observer); }); }
};

async function mount() {
  applyThemeClasses(readAndMigrateTheme());
  const store = useWorkspaceStore.getState;
  const workspace = await store().createWorkspace(`Document input regression ${crypto.randomUUID().slice(0, 8)}`);
  await store().setActiveWorkspace(workspace.id);
  const notebook = await notebookRepository.create(null, workspace.id, null, 'Document input');
  const section = await notebookRepository.createSection(null, workspace.id, notebook.id, 'Input');
  const note = await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, 'Research Space');
  const bytes = await (await fetch('./pipeline-test.pdf')).arrayBuffer();
  const pdfData = await canvasRepository.storePdf(null, note.id, 'Input fixture.pdf', bytes);
  const pdf = await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, 'Annotated PDF', 'pdf', pdfData.id);
  const probe = await getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  const source = await probe.getPage(1);
  wrap(Object.getPrototypeOf(source), 'render', 'pdfRasterStarts', (_self, task) => {
    const cancel = task.cancel.bind(task);
    task.cancel = (...args: any[]) => { bump('pdfRasterCancels'); return cancel(...args); };
  });
  await probe.destroy();
  const data = createEmptyDrawingData();
  Object.assign(data.properties, { pageSize: 'A4', extraLeft: 140, extraRight: 140, extraTop: 140, extraBottom: 140 });
  data.objects = Array.from({ length: 120 }, (_, i) => ({
    id: `seed-${i}`, type: 'stroke' as const, tool: 'pen' as const, color: '#2563eb', thickness: 2, opacity: 1,
    centerline: 'polyline' as const, createdAt: i,
    points: Array.from({ length: 40 }, (_, j) => ({ x: 25 + j * 12, y: 30 + i * 7 + Math.sin(j) * 3, pressure: .5, t: j * 4 })),
  }));
  await notebookRepository.setPagePropertyOverrides(workspace.id, note.id, data.properties);
  await notebookRepository.saveDrawingData(workspace.id, notebook.id, note.id, data);
  for (let i = 1; i <= 3; i++) await notebookRepository.saveDrawingData(workspace.id, notebook.id, pdfAnnotationStorageId(pdf.id, i), data);
  await store().loadWorkspaceContents(workspace.id);
  store().setActivePage(note.id, false);
  useUIStore.setState({ isSidebarOpen: false, isPropertiesPanelOpen: false });
  useLayoutStore.setState({ notebookModeLevel: 1, workspaceViewMode: 'edit' });
  let noteEngine: NotebookEngine;
  Object.assign(window, { documentFixture: {
    mode: window.panvas ? 'electron' : 'web', ids: { workspace: workspace.id, notebook: notebook.id, section: section.id, note: note.id, pdf: pdf.id },
    engine: () => store().notebookPages.find(page => page.id === store().activePageId)?.type !== 'pdf' ? noteEngine : [...engines].find(engine => engine.drawing.getCanvasElement()?.classList.contains('panvas-layer-canvas-decoration')),
    geometry: () => resolvePageSurfaceGeometry(noteEngine.getProperties()),
    select: (mode: string) => store().setActivePage(mode === 'pdf' ? pdf.id : note.id, false),
    saved: (id: string) => notebookRepository.loadDrawingData(workspace.id, notebook.id, id),
  } });
  function Surface() {
    const active = useWorkspaceStore(state => state.activePageId);
    const page = useWorkspaceStore(state => state.notebookPages.find(item => item.id === active));
    return <React.Profiler id="DocumentInput" onRender={() => bump(active === pdf.id ? 'pdfCommits' : 'notebookCommits')}>
      {page?.type === 'pdf' ? <PdfWorkspace page={page} /> : <NotebookRenderer onEngineReady={engine => { noteEngine = engine; }} />}
    </React.Profiler>;
  }
  createRoot(document.getElementById('root')!).render(<AppShell><Surface /></AppShell>);
}
void mount();
