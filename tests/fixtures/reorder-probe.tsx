import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceTree } from '../../src/components/workspace/WorkspaceTree';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { useUIStore } from '../../src/stores/uiStore';
import '../../src/styles/index.css';

void (async () => {
  useUIStore.setState({ isSidebarOpen: true });
  const store = useWorkspaceStore.getState();
  const workspace = await store.createWorkspace('Reorder Probe');
  await store.setActiveWorkspace(workspace.id);
  const notebook = await store.createNotebook(null, 'Probe Notebook');
  const section = await store.createNotebookSection(notebook.id, 'Section A');
  for (let i = 1; i <= 4; i++) await store.createNotebookPage(section.id, `Note ${i}`);
  await store.loadWorkspaceContents(workspace.id);
  (window as any).reorderProbe = {
    workspaceId: workspace.id, sectionId: section.id,
    notebookId: notebook.id,
    expand: async () => {
      const current = useWorkspaceStore.getState();
      const target = current.notebooks.find(item => item.id === notebook.id);
      if (target && !target.isExpanded) await useWorkspaceStore.getState().toggleNotebookExpanded(notebook.id);
      if (!current.notebookSections.find(item => item.id === section.id)?.isExpanded) {
        await useWorkspaceStore.getState().toggleNotebookSectionExpanded(section.id);
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    },
    treeLabels: () => [...document.querySelectorAll('[role="treeitem"]')].map(row => row.getAttribute('aria-label')),
    storePageOrder: () => useWorkspaceStore.getState().notebookPages
      .filter(page => page.sectionId === section.id && !page.deletedAt)
      .sort((a, b) => a.order - b.order)
      .map(page => page.title),
  };
  createRoot(document.getElementById('root')!).render(<WorkspaceTree workspaceId={workspace.id} />);
})();
