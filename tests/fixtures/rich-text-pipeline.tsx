import React from 'react';
import { createRoot } from 'react-dom/client';
import type { JSONContent } from '@tiptap/core';
import { NotebookRenderer } from '../../src/components/notebook/NotebookRenderer';
import { StaticTextPreview } from '../../src/components/notebook/StaticTextPreview';
import type { NotebookEngine } from '../../src/components/notebook/engine/NotebookEngine';
import { createEmptyDrawingData, type TextObject } from '../../src/components/notebook/engine/drawingTypes';
import { htmlToTipTapJson, sanitizeHtml, getSafeNotebookLink } from '../../src/components/notebook/tiptapExtensions';
import { notebookRepository } from '../../src/repositories/NotebookRepository';
import { workspaceRepository } from '../../src/repositories/WorkspaceRepository';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { useUIStore } from '../../src/stores/uiStore';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { notebookDocumentViewContent } from '../../src/components/notebook/notebookDocumentView';
import '../../src/styles/index.css';

function FixtureShortcuts() { useKeyboardShortcuts(); return null; }

async function mount() {
  const store = useWorkspaceStore.getState;
  const query = new URLSearchParams(window.location.search || window.location.hash.slice(1));
  const resumeWorkspace = query.get('resumeWorkspace'), resumePage = query.get('resumePage');
  // Materialize the disposable hierarchy before page activation. Store creation
  // also starts detached recent-file updates; concurrent native metadata writes
  // can otherwise race this fixture's next page creation before editor tests start.
  await store().loadWorkspaces();
  const existingPages = resumePage ? await notebookRepository.getPages(null) : [];
  const restoredPage = existingPages.find(item => item.id === resumePage);
  const workspace = resumeWorkspace ? store().workspaces.find(item => item.id === resumeWorkspace)! : await workspaceRepository.create(null, 'Rich-text pipeline regression');
  const notebook = restoredPage ? (await notebookRepository.getAll(null)).find(item => item.id === restoredPage.notebookId)! : await notebookRepository.create(null, workspace.id, null, 'Rich-text regression');
  const section = restoredPage ? (await notebookRepository.getSections(null)).find(item => item.id === restoredPage.sectionId)! : await notebookRepository.createSection(null, workspace.id, notebook.id, 'Section 1');
  const page = restoredPage ?? await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, 'Page 1');
  const secondPage = restoredPage ? existingPages.find(item => item.notebookId === notebook.id && item.id !== page.id)! : await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, 'Reload boundary');
  if (!restoredPage) for (const item of [page, secondPage]) {
    await notebookRepository.saveDrawingData(workspace.id, notebook.id, item.id, createEmptyDrawingData());
  }
  await store().loadWorkspaces();
  await store().setActiveWorkspace(workspace.id);
  await store().setActivePage(page.id);
  useUIStore.setState({ isSidebarOpen: false, isPropertiesPanelOpen: false });
  let engine: NotebookEngine;
  let previewRoot: ReturnType<typeof createRoot>;
  const root = createRoot(document.getElementById('root')!);
  Object.assign(window, {
    richFixture: {
      mode: window.panvas ? 'electron' : 'web',
      commandPaletteOpen: () => useUIStore.getState().isCommandPaletteOpen,
      safeLink: getSafeNotebookLink,
      viewContent: notebookDocumentViewContent,
      setTheme: (theme: 'light' | 'dark') => useUIStore.getState().setTheme(theme),
      engine: () => engine,
      ready: () => Boolean(previewRoot) && engine?.getDrawingOwnership().pageId === page.id && Boolean(engine.drawing.getCanvasElement()),
      parseHtml: htmlToTipTapJson,
      sanitize: sanitizeHtml,
      reset: async (contents: JSONContent[] = [{ type: 'doc', content: [{ type: 'paragraph' }] }]) => {
        document.getElementById('fixture-outside')!.focus();
        // Unmount previous editor instances before reusing object IDs. The product
        // loads page-owned data; the fixture must not retain an old editor document.
        engine.setDrawingData(createEmptyDrawingData(), page.id);
        engine.input.notifyChange();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const drawing = createEmptyDrawingData();
        drawing.objects = contents.map((content, index): TextObject => ({
          id: `rich-text-${index}`, type: 'text', x: 70, y: 70 + index * 310,
          width: 470, height: 72, rotation: 0, createdAt: index,
          layerId: engine.layers.getActiveLayerId(), content: structuredClone(content),
        }));
        engine.setDrawingData(drawing, page.id);
        engine.tools.setMode('text');
        engine.input.notifyChange();
      },
      texts: () => structuredClone(engine.texts.getTexts()),
      editor: (id = 'rich-text-0') => engine.texts.getEditor(id),
      preview: (content: JSONContent, width = 470) => previewRoot.render(
        <StaticTextPreview object={{ id: 'preview', type: 'text', x: 0, y: 0, width, height: 72, createdAt: 0, content }} scale={1} />,
      ),
      reload: () => store().setActivePage(secondPage.id),
      returnToPage: () => store().setActivePage(page.id),
      load: () => notebookRepository.loadDrawingData(workspace.id, notebook.id, page.id),
    },
  });
  root.render(<React.Profiler id="Notebook fixture" onRender={(_id, phase, duration) => (window as any).stabilizationProfile?.commit(phase, duration)}><>
    <FixtureShortcuts />
    <button id="fixture-outside" style={{ position: 'fixed', top: 0, right: 0, zIndex: 9999 }}>Fixture outside focus</button>
    <div id="fixture-preview" style={{ position: 'fixed', left: -2000, width: 600, height: 600 }} />
    <div style={{ height: '100vh' }}><NotebookRenderer onEngineReady={next => { engine = next; }} /></div>
  </></React.Profiler>);
  while (!document.getElementById('fixture-preview')) await new Promise(requestAnimationFrame);
  previewRoot = createRoot(document.getElementById('fixture-preview')!);
}
void mount();
