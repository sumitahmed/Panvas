import React from 'react';
import { createRoot } from 'react-dom/client';
import { NotebookRenderer } from '../../src/components/notebook/NotebookRenderer';
import type { NotebookEngine } from '../../src/components/notebook/engine/NotebookEngine';
import { createEmptyDrawingData } from '../../src/components/notebook/engine/drawingTypes';
import { notebookRepository } from '../../src/repositories/NotebookRepository';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { AppShell } from '../../src/components/layout/AppShell';
import { useLayoutStore } from '../../src/stores/layoutStore';
import { useUIStore } from '../../src/stores/uiStore';
import '../../src/styles/index.css';

async function mount() {
  const responsive = new URLSearchParams(location.search).has('responsive');
  if (responsive) useUIStore.setState({ isSidebarOpen: false, isPropertiesPanelOpen: false });
  const store = useWorkspaceStore.getState;
  const workspace = await store().createWorkspace('Navigation lifecycle regression');
  await store().setActiveWorkspace(workspace.id);
  const notebook = await store().createNotebook(null, 'Navigation notebook');
  const section = store().notebookSections.find(item => item.notebookId === notebook.id)!;
  const pages = [store().notebookPages.find(item => item.sectionId === section.id)!];
  for (let index = 1; index < 6; index++) {
    pages.push(await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, `Page ${index + 1}`));
  }
  for (const page of pages) {
    await notebookRepository.saveDrawingData(workspace.id, notebook.id, page.id, createEmptyDrawingData());
  }
  await store().loadWorkspaceContents(workspace.id);
  store().setActivePage(pages[0].id);

  const loaded = new Set<string>();
  const load = notebookRepository.loadDrawingData.bind(notebookRepository);
  notebookRepository.loadDrawingData = async (...args) => {
    const data = await load(...args);
    loaded.add(args[2]);
    return data;
  };
  const counts = { mount: 0, unmount: 0, attach: 0, detach: 0, load: 0 };
  let engine: NotebookEngine;
  let originalCanvas: HTMLCanvasElement | null = null;
  const pointerEvents: { type: string; id: number; trusted: boolean }[] = [];
  const root = createRoot(document.getElementById('root')!);
  const instrument = (next: NotebookEngine) => {
    engine = next;
    for (const [object, method, counter] of [
      [engine, 'mount', 'mount'], [engine, 'unmount', 'unmount'],
      [engine.input, 'attach', 'attach'], [engine.input, 'detach', 'detach'],
      [engine, 'setDrawingData', 'load'],
    ] as const) {
      const original = (object as any)[method].bind(object);
      (object as any)[method] = (...args: any[]) => {
        counts[counter]++;
        return original(...args);
      };
    }
    engine.tools.setMode('hand');
  };
  Object.assign(window, {
    navigationIds: pages.map(page => page.id),
    navigationReady: () => pages.every(page => loaded.has(page.id)),
    navigationEngine: () => engine,
    navigationMode: () => useLayoutStore.getState().notebookModeLevel,
    navigationSelect: (index: number) => store().setActivePage(pages[index].id),
    navigationUnmount: () => root.unmount(),
    navigationRemember: () => {
      originalCanvas = engine.drawing.getCanvasElement();
      pointerEvents.length = 0;
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        originalCanvas!.addEventListener(type, event => {
          const pointer = event as PointerEvent;
          Object.assign(window, { navigationLastPointer: { x: pointer.clientX, y: pointer.clientY } });
          pointerEvents.push({ type, id: pointer.pointerId, trusted: pointer.isTrusted });
        });
      }
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
    },
    navigationSnapshot: () => ({
      owner: engine.getDrawingOwnership().pageId,
      focused: document.querySelector('[data-focused-sheet="true"]')?.getAttribute('data-page-id'),
      active: store().activePageId,
      navigationActive: engine.input.navigationGestures?.active ?? false,
      originalConnected: originalCanvas?.isConnected ?? false,
      sameCanvas: originalCanvas === engine.drawing.getCanvasElement(),
      scrollTop: document.querySelector('.notebook-viewport')?.scrollTop ?? 0,
      counts: { ...counts },
      pointerEvents: [...pointerEvents],
    }),
  });
  const renderer = <NotebookRenderer onEngineReady={instrument} />;
  root.render(responsive ? <AppShell>{renderer}</AppShell> : <div style={{ height: '100vh' }}>{renderer}</div>);
}
void mount();
