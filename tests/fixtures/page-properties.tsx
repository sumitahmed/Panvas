import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '../../src/components/layout/AppShell';
import { NotebookRenderer } from '../../src/components/notebook/NotebookRenderer';
import type { NotebookEngine } from '../../src/components/notebook/engine/NotebookEngine';
import { createDefaultDrawingData } from '../../src/components/notebook/engine/drawingTypes';
import { notebookRepository } from '../../src/repositories/NotebookRepository';
import { db } from '../../src/database/schema';
import { resolvePageProperties } from '../../src/lib/pageProperties';
import { DEFAULT_PAGE_PROPERTY_SET } from '../../src/types/notebook';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { useUIStore } from '../../src/stores/uiStore';
import '../../src/styles/index.css';
import '../../src/styles/editor-fonts.css';

const marker = 'panvas-page-properties-fixture';
const baseline = { ...DEFAULT_PAGE_PROPERTY_SET, paperColor: '#E8F5E9', ruleLineColor: '#64748b', margins: 'No Margin' as const, orientation: 'landscape' as const, pageSize: 'A5' as const };

async function mount() {
  const store = useWorkspaceStore.getState;
  let ids = JSON.parse(localStorage.getItem(marker) || 'null');
  if (!ids) {
    const workspace = await store().createWorkspace('Page properties regression');
    await store().setActiveWorkspace(workspace.id);
    // Set up records sequentially without the app's detached last-opened
    // writes competing with fixture creation in the native JSON metadata.
    const notebook = await notebookRepository.create(null, workspace.id, null, 'Template persistence');
    const firstSection = await notebookRepository.createSection(null, workspace.id, notebook.id, 'Section 1');
    const first = await notebookRepository.createPage(null, workspace.id, notebook.id, firstSection.id, 'Page 1');
    const second = await notebookRepository.createPage(null, workspace.id, notebook.id, first.sectionId, 'Page 2');
    const section = await notebookRepository.createSection(null, workspace.id, notebook.id, 'Other section');
    const third = await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, 'Other-section note');
    const excludedSection = await notebookRepository.createSection(null, workspace.id, notebook.id, 'Excluded pages');
    const pdf = await notebookRepository.createPage(null, workspace.id, notebook.id, excludedSection.id, 'Excluded PDF', 'pdf', 'fixture-pdf');
    const deleted = await notebookRepository.createPage(null, workspace.id, notebook.id, excludedSection.id, 'Deleted note');
    const outside = await notebookRepository.create(null, workspace.id, null, 'Other notebook');
    const outsideSection = await notebookRepository.createSection(null, workspace.id, outside.id, 'Section 1');
    const outsidePage = await notebookRepository.createPage(null, workspace.id, outside.id, outsideSection.id, 'Outside note');
    ids = { workspaceId: workspace.id, notebookId: notebook.id, notes: [first.id, second.id, third.id], pdf: pdf.id, deleted: deleted.id, outside: outsidePage.id };
    for (const page of [first, second, third, pdf, deleted, outsidePage]) {
      await notebookRepository.setPagePropertyOverrides(workspace.id, page.id, baseline);
      if (page.type !== 'pdf') {
        const drawing = createDefaultDrawingData(baseline);
        drawing.objects = [{ id: 'ink-' + page.id, type: 'shape', shapeType: 'rectangle', x: 120, y: 140, width: 80, height: 60, color: '#0066cc', fill: '#0066cc', strokeWidth: 1, rotation: 0, createdAt: 1, layerId: 'layer-default' }];
        await notebookRepository.saveDrawingData(workspace.id, page.notebookId, page.id, drawing);
      }
    }
    await notebookRepository.deletePage(workspace.id, deleted.id);
    localStorage.setItem(marker, JSON.stringify(ids));
  }
  await store().loadWorkspaces();
  await store().setActiveWorkspace(ids.workspaceId);
  await store().loadWorkspaceContents(ids.workspaceId);
  await store().setActivePage(ids.notes[0], false);
  useUIStore.setState({ isPropertiesPanelOpen: true });
  const toasts: { message: string; type: string }[] = [];
  let previousToast: unknown;
  useUIStore.subscribe(state => {
    if (state.toast && state.toast !== previousToast) toasts.push({ ...state.toast });
    previousToast = state.toast;
  });
  let engine: NotebookEngine;
  Object.assign(window, { propertiesFixture: {
    ids, baseline, toasts, mode: window.panvas ? 'electron' : 'web',
    engine: () => engine,
    clearToasts: () => { toasts.length = 0; useUIStore.getState().clearToast(); },
    select: (id: string) => store().setActivePage(id, false),
    async reopen() {
      await store().setActivePage(null, false);
      await store().loadWorkspaceContents(ids.workspaceId);
      await store().setActivePage(ids.notes[0], false);
    },
    async records() {
      const notebooks = window.panvas ? await window.panvas.notebook.getAll(ids.workspaceId) : await db.notebooks.toArray();
      const pages = window.panvas ? await window.panvas.notebookPage.getAll(ids.workspaceId) : await db.notebookPages.toArray();
      return { notebooks, pages, effective: Object.fromEntries(pages.map(page => [page.id,
        resolvePageProperties(notebooks.find(notebook => notebook.id === page.notebookId), page)])) };
    },
    async drawingObjects() {
      return Promise.all(ids.notes.map(async (id: string) => (await notebookRepository.loadDrawingData(ids.workspaceId, ids.notebookId, id)).objects));
    },
    closeDatabase: () => db.close(),
    openDatabase: () => db.open(),
  } });
  createRoot(document.getElementById('root')!).render(<AppShell><NotebookRenderer onEngineReady={value => { engine = value; }} /></AppShell>);
}
void mount();
