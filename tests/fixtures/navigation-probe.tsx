import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '../../src/components/layout/AppShell';
import { NotebookRenderer } from '../../src/components/notebook/NotebookRenderer';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { useLayoutStore } from '../../src/stores/layoutStore';
import { useUIStore } from '../../src/stores/uiStore';
import { createEmptyDrawingData } from '../../src/components/notebook/engine/drawingTypes';
import '../../src/styles/index.css';

let noteEngine: import('../../src/components/notebook/engine/NotebookEngine').NotebookEngine;

void (async () => {
  useUIStore.setState({ isSidebarOpen: false, isPropertiesPanelOpen: false });
  useLayoutStore.setState({ notebookModeLevel: 1, workspaceViewMode: 'edit' });
  const store = useWorkspaceStore.getState();
  const workspace = await store.createWorkspace('Nav Probe');
  await store.setActiveWorkspace(workspace.id);
  const notebook = await store.createNotebook(null, 'Nav Notebook');
  const section = await store.createNotebookSection(notebook.id, 'Section');
  const pageIds: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const page = await store.createNotebookPage(section.id, `Nav Page ${i}`);
    pageIds.push(page.id);
    // Give each page distinct ink so page visuals differ and extents are stable.
    const data = createEmptyDrawingData();
    data.objects.push({
      id: `mark-${i}`, type: 'stroke', tool: 'pen', color: '#981b22', thickness: 3, opacity: 1,
      centerline: 'polyline' as const, createdAt: i,
      points: [{ x: 60 + i * 20, y: 80 + i * 40, pressure: .5, t: 0 }, { x: 140 + i * 20, y: 120 + i * 40, pressure: .5, t: 8 }],
    });
    await notebookRepositorySave(workspace.id, notebook.id, page.id, data);
  }
  await store.loadWorkspaceContents(workspace.id);
  store.setActivePage(pageIds[0], false);

  function Surface() {
    const active = useWorkspaceStore(state => state.activePageId);
    return <NotebookRenderer onEngineReady={engine => { noteEngine = engine; }} key={active === pageIds[0] ? 'init' : 'init'} />;
  }
  const treeHost = document.createElement('div');
  treeHost.id = 'nav-tree-host';
  treeHost.style.cssText = 'position:fixed;right:0;top:0;width:300px;height:100vh;overflow:auto;z-index:9999';
  document.body.appendChild(treeHost);
  void (async () => {
    const React = (await import('react')).default;
    const { createRoot } = await import('react-dom/client');
    const { WorkspaceTree } = await import('../../src/components/workspace/WorkspaceTree');
    const current = useWorkspaceStore.getState();
    const target = current.notebooks.find(item => item.id === notebook.id);
    if (target && !target.isExpanded) await useWorkspaceStore.getState().toggleNotebookExpanded(notebook.id);
    if (!useWorkspaceStore.getState().notebookSections.find(item => item.id === section.id)?.isExpanded) {
      await useWorkspaceStore.getState().toggleNotebookSectionExpanded(section.id);
    }
    createRoot(treeHost).render(React.createElement(WorkspaceTree, { workspaceId: workspace.id }));
  })();

  createRoot(document.getElementById('root')!).render(<AppShell><Surface /></AppShell>);

  async function notebookRepositorySave(workspaceId: string, notebookId: string, pageId: string, data: unknown) {
    const { notebookRepository } = await import('../../src/repositories/NotebookRepository');
    await notebookRepository.saveDrawingData(workspaceId, notebookId, pageId, data);
  }

  async function pasteImage(x: number, y: number): Promise<string> {
    const { canvasRepository } = await import('../../src/repositories/CanvasRepository');
    const canvas = document.createElement('canvas');
    canvas.width = 120; canvas.height = 80;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#2266cc';
    ctx.fillRect(0, 0, 120, 80);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(20, 20, 80, 40);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/png'));
    const asset = await canvasRepository.storeImage(null, pageIds[0], 'probe-image.png', 'image/png', await blob.arrayBuffer());
    const image = {
      id: `img-${Date.now()}`, type: 'image' as const, x, y, width: 120, height: 80,
      rotation: 0, opacity: 1, createdAt: Date.now(), fileId: asset.id,
    };
    noteEngine.images.addImage(image);
    noteEngine.drawing.redraw();
    return image.id;
  }

  (window as any).navProbe = {
    pageIds,
    workspaceId: workspace.id,
    engine: () => noteEngine,
    activePageId: () => useWorkspaceStore.getState().activePageId,
    ownershipPageId: () => noteEngine?.getDrawingOwnership().pageId ?? null,
    setActivePage: (id: string) => useWorkspaceStore.getState().setActivePage(id),
    viewport: () => document.querySelector<HTMLElement>('.notebook-viewport'),
    pageTop: (id: string) => {
      const viewport = document.querySelector<HTMLElement>('.notebook-viewport');
      const element = document.getElementById(`page-${id}`);
      if (!viewport || !element) return null;
      return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    },
    pageGeometry: () => {
      const viewport = document.querySelector<HTMLElement>('.notebook-viewport');
      const rows = [...document.querySelectorAll<HTMLElement>('[data-page-id]')].map(element => ({
        id: element.getAttribute('data-page-id'),
        top: viewport ? element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop : -1,
        height: element.getBoundingClientRect().height,
      }));
      return { viewportHeight: viewport?.clientHeight ?? -1, scale: noteEngine?.viewport.getState().scale ?? -1, rows };
    },
    pasteImage,
    canvasPoint: (px: number, py: number) => {
      const canvas = noteEngine.drawing.getCanvasElement()!;
      const rect = canvas.getBoundingClientRect();
      const visual = noteEngine.viewport.pageToCanvas(px, py);
      return { x: rect.left + visual.x * rect.width / canvas.clientWidth, y: rect.top + visual.y * rect.height / canvas.clientHeight };
    },
    canvasPointer: (type: string, px: number, py: number) => {
      const canvas = noteEngine.drawing.getCanvasElement()!;
      const point = (window as any).navProbe.canvasPoint(px, py);
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 71, pointerType: 'pen', button: type === 'pointerdown' ? 0 : -1, buttons: type === 'pointerup' ? 0 : 1, pressure: .5, clientX: point.x, clientY: point.y }));
    },
    strokeGeometry: () => noteEngine.drawing.getStrokes().map(stroke => ({
      id: stroke.id,
      x: Math.min(...stroke.points.map(p => p.x)),
      y: Math.min(...stroke.points.map(p => p.y)),
    })),
    selectionIds: () => new Set(noteEngine.selection.getSelectedElements().map(element => element.id)),
    setSelectTool: () => noteEngine.tools.setMode('select'),
    debugState: () => {
      const engine = noteEngine;
      return {
        pageSize: engine.getProperties().pageSize,
        layoutExtent: engine.getProperties().layoutExtent,
        liveBottom: engine.input.getLiveStrokeBottom(),
        mode: engine.tools.getState().mode,
        ownership: engine.getDrawingOwnership().pageId,
      };
    },
    selectAndMoveImage: async (imageId: string, dx: number, dy: number) => {
      const probe = window.navProbe;
      const engine = probe.engine();
      engine.tools.setMode('select');
      const image = engine.images.getImages().find(item => item.id === imageId)!;
      const canvas = engine.drawing.getCanvasElement()!;
      const scaleX = canvas.width / canvas.clientWidth;
      const toClient = (px: number, py: number) => {
        const rect = canvas.getBoundingClientRect();
        const visual = engine.viewport.pageToCanvas(px, py);
        return { x: rect.left + visual.x * rect.width / canvas.clientWidth, y: rect.top + visual.y * rect.height / canvas.clientHeight };
      };
      // dx/dy are PAGE units; convert through the CSS camera for client pixels.
      const scale = canvas.getBoundingClientRect().width / canvas.clientWidth;
      const start = toClient(image.x + image.width / 2, image.y + image.height / 2);
      const pointer = (type: string, x: number, y: number) => {
        canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 55, pointerType: 'pen', button: type === 'pointerdown' ? 0 : -1, buttons: type === 'pointerup' ? 0 : 1, pressure: .5, clientX: x, clientY: y }));
      };
      pointer('pointerdown', start.x, start.y);
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        pointer('pointermove', start.x + dx * scale * i / steps, start.y + dy * scale * i / steps);
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      const midTransform = document.querySelector<HTMLElement>(`[data-image-overlay="${imageId}"]`)?.style.transform ?? '';
      pointer('pointerup', start.x + dx * scale, start.y + dy * scale);
      await new Promise(resolve => setTimeout(resolve, 150));
      return { midTransform, image };
    },
    highlightedTreePage: () => {
      const rows = [...document.querySelectorAll('#nav-tree-host [data-state="selected"]')];
      return rows.map(row => row.getAttribute('data-tree-id')).at(-1) ?? null;
    },
    pageIdToTreeId: new Map(pageIds.map(id => [id, id])),
    dominantPageIdAtViewportCenter: () => {
      const viewport = document.querySelector<HTMLElement>('.notebook-viewport');
      if (!viewport) return null;
      const rect = viewport.getBoundingClientRect();
      const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        ?.closest('[data-page-id]');
      return element?.getAttribute('data-page-id') ?? null;
    },
  };
})();
