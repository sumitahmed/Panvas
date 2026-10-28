import React from 'react';
import { Bookmark, ChevronRight, FileText, Folder, FolderOpen, Layers, LayoutGrid, MoreHorizontal, Plus, Star } from 'lucide-react';
import { useLocation } from 'wouter';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import { useUIStore } from '@/stores/uiStore';
import type { Notebook, NotebookPage, NotebookSection } from '@/types/notebook';
import type { CanvasFile, Folder as WorkspaceFolder } from '@/types/workspace';
import { createNotebookExportTarget, createPageExportTarget, createSectionExportTarget } from '@/services/pdf/notebookExportTargets';
import { validateEntityName } from '@/lib/entityName';
import { NotebookCoverThumbnail } from '@/components/library/NotebookCoverThumbnail';

export type DropPosition = 'before' | 'inside' | 'after';

export function getReorderedIds(items: any[], draggedId: string, targetId: string, position: 'before' | 'after') {
  const filtered = items.filter(i => i.id !== draggedId);
  const targetIndex = filtered.findIndex(i => i.id === targetId);
  if (targetIndex === -1) return items.map(i => i.id);
  const draggedItem = items.find(i => i.id === draggedId);
  if (!draggedItem) return items.map(i => i.id);
  filtered.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, draggedItem);
  return filtered.map(i => i.id);
}

export function WorkspaceTree({ workspaceId }: { workspaceId: string }) {
  const { folders, notebooks, canvasFiles, moveCanvas, moveNotebook, moveFolder, reorderItems } = useWorkspaceStore();
  const [isDragOverRoot, setIsDragOverRoot] = React.useState(false);
  const inlineCreate = useUIStore(state => state.inlineCreate);

  const rootFolders = folders.filter(folder => folder.workspaceId === workspaceId && folder.parentId === null);
  const rootNotebooks = notebooks.filter(notebook => notebook.workspaceId === workspaceId && notebook.folderId === null);
  const rootCanvases = canvasFiles.filter(canvas => canvas.workspaceId === workspaceId && canvas.folderId === null && !canvas.notebookId && !canvas.sectionId);

  const handleRootDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOverRoot(false);
    const raw = event.dataTransfer.getData('application/json');
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data.type === 'canvas') {
        const item = canvasFiles.find(c => c.id === data.id);
        if (item && (item.folderId !== null || item.notebookId !== null || item.sectionId !== null)) await moveCanvas(data.id, workspaceId, null, null, null);
      }
      else if (data.type === 'notebook') {
        const item = notebooks.find(n => n.id === data.id);
        if (item && item.folderId !== null) await moveNotebook(data.id, workspaceId, null);
      }
      else if (data.type === 'folder') {
        const item = folders.find(f => f.id === data.id);
        if (item && item.parentId !== null) await moveFolder(data.id, workspaceId, null);
      }
    } catch { /* Ignore */ }
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setIsDragOverRoot(true); }}
      onDragLeave={() => setIsDragOverRoot(false)}
      onDrop={handleRootDrop}
      className={`min-h-[28px] rounded ${isDragOverRoot ? 'bg-panvas-bg-hover/60 outline outline-1 outline-dashed outline-panvas-border-strong' : ''}`}
    >
      {rootFolders.map(folder => <FolderNode key={folder.id} folder={folder} depth={0} />)}
      {rootNotebooks.map(notebook => <NotebookNode key={notebook.id} notebook={notebook} depth={0} />)}
      {rootCanvases.map(canvas => <CanvasNode key={canvas.id} canvas={canvas} depth={0} />)}
      {inlineCreate?.type === 'canvas' && !inlineCreate.parentId && <InlineCreateRow type="canvas" depth={0} />}
      {rootFolders.length === 0 && rootNotebooks.length === 0 && rootCanvases.length === 0 && !inlineCreate && (
        <div className="px-2 py-3 text-center text-xs text-panvas-text-tertiary">Empty workspace</div>
      )}
    </div>
  );
}

function FolderNode({ folder, depth }: { folder: WorkspaceFolder; depth: number }) {
  const { folders, notebooks, canvasFiles, toggleFolderExpanded, moveCanvas, renameFolder, moveNotebook, moveFolder, reorderItems } = useWorkspaceStore();
  const { openContextMenu, renamingId, setRenamingId } = useUIStore();
  const [value, setValue] = React.useState(folder.name);
  const isRenaming = renamingId === folder.id;
  const save = async () => { if (value.trim() && value !== folder.name) await renameFolder(folder.id, value.trim()); setRenamingId(null); };

  const childFolders = folders.filter(item => item.parentId === folder.id);
  const childNotebooks = notebooks.filter(item => item.folderId === folder.id);
  const childCanvases = canvasFiles.filter(item => item.folderId === folder.id && !item.notebookId && !item.sectionId);
  const isExpanded = folder.isExpanded !== false;
  const inlineCreate = useUIStore(state => state.inlineCreate);

  const handleDropItem = async (data: any, position: DropPosition) => {
    if (position === 'inside') {
      if (data.type === 'canvas') await moveCanvas(data.id, folder.workspaceId, folder.id, null, null);
      else if (data.type === 'notebook') await moveNotebook(data.id, folder.workspaceId, folder.id);
      else if (data.type === 'folder' && data.id !== folder.id) await moveFolder(data.id, folder.workspaceId, folder.id);
    } else {
      if (data.type !== 'folder') return;
      const siblings = folders.filter(f => f.workspaceId === folder.workspaceId && f.parentId === folder.parentId);
      const reorderedIds = getReorderedIds(siblings, data.id, folder.id, position);
      const draggedItem = folders.find(f => f.id === data.id);
      if (draggedItem && draggedItem.parentId !== folder.parentId) {
        await moveFolder(data.id, folder.workspaceId, folder.parentId);
      }
      await reorderItems('folder', reorderedIds);
    }
  };

  return (
    <div>
      <TreeRow
        itemId={folder.id}
        groupId={`tree-children-${folder.id}`}
        name={folder.name}
        depth={depth}
        expanded={isExpanded}
        badge={childFolders.length + childNotebooks.length + childCanvases.length || undefined}
        onClick={() => toggleFolderExpanded(folder.id)}
        onToggle={() => toggleFolderExpanded(folder.id)}
        onContextMenu={(event) => openContextMenu(event.clientX, event.clientY, folder.id, 'folder')}
        draggable
        onDragStart={(event) => event.dataTransfer.setData('application/json', JSON.stringify({ type: 'folder', id: folder.id }))}
        onDropItem={handleDropItem}
        acceptsDropInside
        icon={isExpanded ? <FolderOpen size={15} className="text-panvas-text-secondary" /> : <Folder size={15} className="text-panvas-text-tertiary" />}
        label={isRenaming ? <input autoFocus value={value} onChange={event => setValue(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setRenamingId(null); }} onClick={event => event.stopPropagation()} className="w-full bg-transparent outline-none" /> : folder.name}
      />
      <Collapsible id={`tree-children-${folder.id}`} depth={depth} open={isExpanded || (inlineCreate?.parentType === 'folder' && inlineCreate.parentId === folder.id)}>
        {childFolders.map(item => <FolderNode key={item.id} folder={item} depth={depth + 1} />)}
        {childNotebooks.map(item => <NotebookNode key={item.id} notebook={item} depth={depth + 1} />)}
        {childCanvases.map(item => <CanvasNode key={item.id} canvas={item} depth={depth + 1} />)}
        {inlineCreate?.type === 'canvas' && inlineCreate.parentType === 'folder' && inlineCreate.parentId === folder.id && <InlineCreateRow type="canvas" depth={depth + 1} />}
      </Collapsible>
    </div>
  );
}

function NotebookNode({ notebook, depth }: { notebook: Notebook; depth: number }) {
  const [, navigate] = useLocation();
  const { notebooks, notebookSections, notebookPages, canvasFiles, toggleNotebookExpanded, setActiveNotebook, renameNotebook, activeNotebookId, moveNotebookSection, moveCanvas, reorderItems, moveNotebook } = useWorkspaceStore();
  const { openContextMenu, renamingId, setRenamingId } = useUIStore();
  const [value, setValue] = React.useState(notebook.name);
  const isRenaming = renamingId === notebook.id;
  const isActive = activeNotebookId === notebook.id;
  const inlineCreate = useUIStore(state => state.inlineCreate);
  const save = async () => { if (value.trim() && value !== notebook.name) await renameNotebook(notebook.id, value.trim()); setRenamingId(null); };
  
  const sections = notebookSections.filter(section => section.notebookId === notebook.id);
  const childCanvases = canvasFiles.filter(canvas => canvas.notebookId === notebook.id && !canvas.sectionId);

  const handleNotebookClick = async () => {
    // Last-opened writes and tree expansion share native workspace metadata.
    // Finish activation before publishing the expansion update.
    await setActiveNotebook(notebook.id);
    const current = useWorkspaceStore.getState();
    if (current.activeNotebookId !== notebook.id || current.activeWorkspaceId !== notebook.workspaceId) return;
    if (!current.notebooks.find(item => item.id === notebook.id)?.isExpanded) {
      toggleNotebookExpanded(notebook.id);
    }
    navigate('/app');
  };

  const handleDropItem = async (data: any, position: DropPosition) => {
    if (position === 'inside') {
      if (data.type === 'section') await moveNotebookSection(data.id, notebook.workspaceId, notebook.id);
      else if (data.type === 'canvas') await moveCanvas(data.id, notebook.workspaceId, null, notebook.id, null);
    } else {
      if (data.type !== 'notebook') return;
      const siblings = notebooks.filter(n => n.workspaceId === notebook.workspaceId && n.folderId === notebook.folderId);
      const reorderedIds = getReorderedIds(siblings, data.id, notebook.id, position);
      const draggedItem = notebooks.find(n => n.id === data.id);
      if (draggedItem && draggedItem.folderId !== notebook.folderId) {
        await moveNotebook(data.id, notebook.workspaceId, notebook.folderId);
      }
      await reorderItems('notebook', reorderedIds);
    }
  };

  return (
    <div>
      <TreeRow
        itemId={notebook.id}
        groupId={`tree-children-${notebook.id}`}
        name={notebook.name}
        depth={depth}
        active={isActive}
        ancestor
        expanded={notebook.isExpanded}
        badge={sections.length || undefined}
        onClick={handleNotebookClick}
        onToggle={async () => { await setActiveNotebook(notebook.id); const current = useWorkspaceStore.getState(); if (current.activeNotebookId === notebook.id && current.activeWorkspaceId === notebook.workspaceId) await toggleNotebookExpanded(notebook.id); }}
        onContextMenu={(event) => openContextMenu(
          event.clientX,
          event.clientY,
          notebook.id,
          'notebook',
          createNotebookExportTarget(notebook),
        )}
        draggable
        onDragStart={(event) => event.dataTransfer.setData('application/json', JSON.stringify({ type: 'notebook', id: notebook.id }))}
        onDropItem={handleDropItem}
        acceptsDropInside
        icon={<NotebookCoverThumbnail title={notebook.name} cover={notebook.cover} variant="mini" />}
        label={isRenaming ? <input autoFocus value={value} onChange={event => setValue(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setRenamingId(null); }} onClick={event => event.stopPropagation()} className="w-full bg-transparent outline-none" /> : notebook.name}
        trailing={notebook.isPinned ? <Star size={12} className="text-panvas-accent-amber fill-panvas-accent-amber" /> : undefined}
      />
      <Collapsible id={`tree-children-${notebook.id}`} depth={depth} open={notebook.isExpanded || (inlineCreate?.parentType === 'notebook' && inlineCreate.parentId === notebook.id)}>
        {sections.map(section => <SectionNode key={section.id} section={section} pages={notebookPages.filter(page => page.sectionId === section.id)} depth={depth + 1} />)}
        {childCanvases.map(canvas => <CanvasNode key={canvas.id} canvas={canvas} depth={depth + 1} />)}
        {inlineCreate?.type === 'canvas' && inlineCreate.parentType === 'notebook' && inlineCreate.parentId === notebook.id && <InlineCreateRow type="canvas" depth={depth + 1} />}
        {sections.length === 0 && childCanvases.length === 0 && !(inlineCreate?.parentType === 'notebook' && inlineCreate.parentId === notebook.id) && <TreeEmptyState depth={depth + 1} label="No items" />}
      </Collapsible>
    </div>
  );
}

function SectionNode({ section, pages, depth }: { section: NotebookSection; pages: NotebookPage[]; depth: number }) {
  const [, navigate] = useLocation();
  const { notebooks, notebookSections, notebookPages, canvasFiles, toggleNotebookSectionExpanded, setActiveNotebookSection, renameNotebookSection, activeNotebookSectionId, moveNotebookPage, moveCanvas, reorderItems, moveNotebookSection } = useWorkspaceStore();
  const { openContextMenu, renamingId, setRenamingId } = useUIStore();
  const [value, setValue] = React.useState(section.name);
  const isRenaming = renamingId === section.id;
  const isActive = activeNotebookSectionId === section.id;
  const inlineCreate = useUIStore(state => state.inlineCreate);
  const save = async () => { if (value.trim() && value !== section.name) await renameNotebookSection(section.id, value.trim()); setRenamingId(null); };

  const workspaceId = notebooks.find(n => n.id === section.notebookId)?.workspaceId || '';
  const childCanvases = canvasFiles.filter(canvas => canvas.sectionId === section.id);

  const handleSectionClick = async () => {
    await setActiveNotebookSection(section.id);
    const current = useWorkspaceStore.getState();
    if (current.activeNotebookSectionId !== section.id || current.activeWorkspaceId !== workspaceId) return;
    if (!current.notebookSections.find(item => item.id === section.id)?.isExpanded) {
      toggleNotebookSectionExpanded(section.id);
    }
    navigate('/app');
  };

  const handleDropItem = async (data: any, position: DropPosition) => {
    if (position === 'inside') {
      if (data.type === 'page') await moveNotebookPage(data.id, workspaceId, section.id);
      else if (data.type === 'canvas') {
        const notebook = notebooks.find(n => n.id === section.notebookId);
        await moveCanvas(data.id, workspaceId, null, null, section.id); // For section canvases, Notebook ancestry is derived
      }
    } else {
      if (data.type !== 'section') return;
      const siblings = notebookSections.filter(s => s.notebookId === section.notebookId);
      const reorderedIds = getReorderedIds(siblings, data.id, section.id, position);
      const draggedItem = notebookSections.find(s => s.id === data.id);
      if (draggedItem && draggedItem.notebookId !== section.notebookId) {
        await moveNotebookSection(data.id, workspaceId, section.notebookId);
      }
      await reorderItems('section', reorderedIds);
    }
  };

  return (
    <div>
      <TreeRow
        itemId={section.id}
        groupId={`tree-children-${section.id}`}
        name={section.name}
        depth={depth}
        active={isActive}
        ancestor
        expanded={section.isExpanded}
        badge={pages.length || undefined}
        onClick={handleSectionClick}
        onToggle={async () => { await setActiveNotebookSection(section.id); const current = useWorkspaceStore.getState(); if (current.activeNotebookSectionId === section.id && current.activeWorkspaceId === workspaceId) await toggleNotebookSectionExpanded(section.id); }}
        onContextMenu={(event) => {
          const notebook = notebooks.find(item => item.id === section.notebookId);
          openContextMenu(
            event.clientX,
            event.clientY,
            section.id,
            'section',
            notebook ? createSectionExportTarget(section, notebook) : null,
          );
        }}
        draggable
        onDragStart={(event) => event.dataTransfer.setData('application/json', JSON.stringify({ type: 'section', id: section.id, notebookId: section.notebookId }))}
        onDropItem={handleDropItem}
        acceptsDropInside
        icon={<Layers size={16} className="text-panvas-text-tertiary" />}
        label={isRenaming ? <input autoFocus value={value} onChange={event => setValue(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setRenamingId(null); }} onClick={event => event.stopPropagation()} className="w-full bg-transparent outline-none" /> : section.name}
      />
      <Collapsible id={`tree-children-${section.id}`} depth={depth} open={section.isExpanded || inlineCreate?.parentId === section.id}>
        {pages.map(page => <PageNode key={page.id} page={page} depth={depth + 1} />)}
        {childCanvases.map(canvas => <CanvasNode key={canvas.id} canvas={canvas} depth={depth + 1} />)}
        {inlineCreate?.parentId === section.id && inlineCreate.parentType !== 'folder' && inlineCreate.parentType !== 'notebook' && <InlineCreateRow type={inlineCreate.type} depth={depth + 1} sectionId={section.id} />}
        {pages.length === 0 && childCanvases.length === 0 && inlineCreate?.parentId !== section.id && <TreeEmptyState depth={depth + 1} label="No items" />}
      </Collapsible>
    </div>
  );
}

const PageNode = React.memo(function PageNode({ page, depth }: { page: NotebookPage; depth: number }) {
  const [, navigate] = useLocation();
  const isActive = useWorkspaceStore(state => state.activePageId === page.id);
  const isRenaming = useUIStore(state => state.renamingId === page.id);
  const isBookmarked = useBookmarkStore(state => state.isBookmarked(page.notebookId, page.id));
  const { setActivePage, renameNotebookPage, moveNotebookPage, reorderItems } = useWorkspaceStore.getState();
  const { openContextMenu, setRenamingId } = useUIStore.getState();
  const [value, setValue] = React.useState(page.title);
  const save = async () => { if (value.trim() && value !== page.title) await renameNotebookPage(page.id, value.trim()); setRenamingId(null); };

  const handleDropItem = async (data: any, position: DropPosition) => {
    if (position === 'inside') return;
    if (data.type !== 'page') return;
    const { notebooks, notebookSections, notebookPages } = useWorkspaceStore.getState();
    const section = notebookSections.find(item => item.id === page.sectionId);
    const workspaceId = notebooks.find(item => item.id === section?.notebookId)?.workspaceId ?? '';
    const siblings = notebookPages.filter(p => p.sectionId === page.sectionId);
    const reorderedIds = getReorderedIds(siblings, data.id, page.id, position);
    const draggedItem = notebookPages.find(p => p.id === data.id);
    if (draggedItem && draggedItem.sectionId !== page.sectionId) {
      await moveNotebookPage(data.id, workspaceId, page.sectionId);
    }
    await reorderItems('page', reorderedIds);
  };

  return (
    <TreeRow
      itemId={page.id}
      name={page.title}
      depth={depth}
      active={isActive}
      onClick={() => {
        setActivePage(page.id);
        navigate('/app');
      }}
      onContextMenu={(event) => {
        const { notebooks, notebookSections } = useWorkspaceStore.getState();
        const section = notebookSections.find(item => item.id === page.sectionId);
        const notebook = notebooks.find(item => item.id === section?.notebookId);
        openContextMenu(event.clientX, event.clientY, page.id, 'page', section && notebook ? createPageExportTarget(page, section, notebook) : null);
      }}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('application/json', JSON.stringify({ type: 'page', id: page.id, sectionId: page.sectionId }))}
      onDropItem={handleDropItem}
      icon={<FileText size={15} className="text-panvas-text-tertiary" />}
      trailing={isBookmarked ? (
        <Bookmark size={12} className="text-panvas-accent-blue fill-panvas-accent-blue shrink-0" aria-label="Bookmarked page" />
      ) : undefined}
      label={isRenaming ? <input autoFocus value={value} onChange={event => setValue(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setRenamingId(null); }} onClick={event => event.stopPropagation()} className="w-full bg-transparent outline-none" /> : page.title}
    />
  );
});

const CanvasNode = React.memo(function CanvasNode({ canvas, depth }: { canvas: CanvasFile; depth: number }) {
  const [, navigate] = useLocation();
  const isActive = useWorkspaceStore(state => state.activeCanvasId === canvas.id);
  const isRenaming = useUIStore(state => state.renamingId === canvas.id);
  const { setActiveCanvas, renameCanvas, moveCanvas, reorderItems } = useWorkspaceStore.getState();
  const { openContextMenu, setRenamingId } = useUIStore.getState();
  const [value, setValue] = React.useState(canvas.name);
  const save = async () => { if (value.trim() && value !== canvas.name) await renameCanvas(canvas.id, value.trim()); setRenamingId(null); };

  const handleDropItem = async (data: any, position: DropPosition) => {
    if (position === 'inside') return;
    if (data.type !== 'canvas') return;
    const { canvasFiles } = useWorkspaceStore.getState();
    const siblings = canvasFiles.filter(c => c.workspaceId === canvas.workspaceId && c.folderId === canvas.folderId && c.notebookId === canvas.notebookId && c.sectionId === canvas.sectionId);
    const reorderedIds = getReorderedIds(siblings, data.id, canvas.id, position);
    const draggedItem = canvasFiles.find(c => c.id === data.id);
    if (draggedItem && (draggedItem.folderId !== canvas.folderId || draggedItem.notebookId !== canvas.notebookId || draggedItem.sectionId !== canvas.sectionId)) {
      await moveCanvas(data.id, canvas.workspaceId, canvas.folderId, canvas.notebookId || null, canvas.sectionId || null);
    }
    await reorderItems('canvas', reorderedIds);
  };

  return (
    <TreeRow
      itemId={canvas.id}
        name={canvas.name}
      depth={depth}
      active={isActive}
      onClick={() => {
        setActiveCanvas(canvas.id);
        navigate('/app');
      }}
      onContextMenu={(event) => openContextMenu(event.clientX, event.clientY, canvas.id, 'canvas')}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('application/json', JSON.stringify({ type: 'canvas', id: canvas.id }))}
      onDropItem={handleDropItem}
      icon={<LayoutGrid size={16} className="text-panvas-text-tertiary" />}
      label={isRenaming ? <input autoFocus value={value} onChange={event => setValue(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setRenamingId(null); }} onClick={event => event.stopPropagation()} className="w-full bg-transparent outline-none" /> : canvas.name}
      trailing={canvas.isPinned ? <Star size={12} className="text-panvas-accent-amber fill-panvas-accent-amber" /> : undefined}
    />
  );
});

function InlineCreateRow({ type, depth, sectionId }: { type: 'page' | 'canvas'; depth: number; sectionId?: string }) {
  const [, navigate] = useLocation();
  const { createNotebookPage, createCanvas, setActivePage, setActiveCanvas } = useWorkspaceStore();
  const { inlineCreate, closeInlineCreate, showToast } = useUIStore();
  const [value, setValue] = React.useState(type === 'page' ? 'New page' : 'New canvas');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const committingRef = React.useRef(false);

  React.useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const commit = async () => {
    if (committingRef.current) return;
    try {
      const name = validateEntityName(value.trim(), type);
      committingRef.current = true;
      if (type === 'page') {
        const targetSection = sectionId ?? inlineCreate?.parentId;
        if (!targetSection) throw new Error('Select a section first.');
        const created = await createNotebookPage(targetSection, name);
        setActivePage(created.id);
      } else {
        const parentId = inlineCreate?.parentId ?? null;
        const parentType = inlineCreate?.parentType ?? null;
        const created = await createCanvas(parentType === 'folder' ? parentId : null, parentType === 'notebook' ? parentId : null, parentType === 'section' ? parentId : sectionId ?? null, name);
        setActiveCanvas(created.id);
      }
      closeInlineCreate();
      navigate('/app');
    } catch (error) {
      committingRef.current = false;
      showToast(error instanceof Error ? error.message : `Couldn't create ${type}.`, 'error');
      inputRef.current?.focus();
    }
  };

  return <div className="flex h-7 items-center gap-1.5 rounded bg-panvas-bg-hover pr-2" style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}>
    {type === 'page'
      ? <FileText size={15} className="shrink-0 text-panvas-text-tertiary" aria-hidden="true" />
      : <LayoutGrid size={15} className="shrink-0 text-panvas-text-tertiary" aria-hidden="true" />}
    <input ref={inputRef} value={value} onChange={event => setValue(event.target.value)} aria-label={`${type === 'page' ? 'Page' : 'Canvas'} name`} className="min-w-0 flex-1 bg-transparent text-xs text-panvas-text-primary outline-none" onBlur={() => { if (!committingRef.current) closeInlineCreate(); }} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); void commit(); }
      if (event.key === 'Escape') { event.preventDefault(); closeInlineCreate(); }
    }} />
  </div>;
}

function TreeRow({ itemId, groupId, name, depth, label, icon, expanded, active = false, ancestor = false, onClick, onToggle, onContextMenu, trailing, badge, draggable, onDragStart, onDropItem, acceptsDropInside = false }: { itemId: string; groupId?: string; name: string; depth: number; label: React.ReactNode; icon: React.ReactNode; expanded?: boolean; active?: boolean; ancestor?: boolean; onClick?: () => void; onToggle?: () => void; onContextMenu?: (event: React.MouseEvent) => void; trailing?: React.ReactNode; badge?: number; draggable?: boolean; onDragStart?: (event: React.DragEvent) => void; onDropItem?: (data: any | null, position: DropPosition, files?: FileList) => void; acceptsDropInside?: boolean }) {
  const activate = () => onClick?.();
  const [dragPosition, setDragPosition] = React.useState<DropPosition | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    let pos: DropPosition = 'inside';
    if (y < rect.height * 0.25) pos = 'before';
    else if (y > rect.height * 0.75) pos = 'after';
    else pos = acceptsDropInside ? 'inside' : (y < rect.height / 2 ? 'before' : 'after');
    setDragPosition(pos);
  };

  const handleDragLeave = () => setDragPosition(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = dragPosition;
    setDragPosition(null);
    const raw = e.dataTransfer.getData('application/json');
    if (!raw && (!e.dataTransfer.files || e.dataTransfer.files.length === 0)) return;
    try {
      const data = raw ? JSON.parse(raw) : null;
      onDropItem?.(data, pos || 'inside', e.dataTransfer.files);
    } catch {}
  };

  let dragClass = '';
  if (dragPosition === 'before') dragClass = 'before:absolute before:inset-x-2 before:top-0 before:h-px before:bg-panvas-text-primary';
  else if (dragPosition === 'after') dragClass = 'before:absolute before:inset-x-2 before:bottom-0 before:h-px before:bg-panvas-text-primary';
  else if (dragPosition === 'inside') dragClass = 'bg-panvas-bg-hover';

  return (
    <div
      ref={ref}
      data-tree-id={itemId}
      role="treeitem"
      aria-level={depth + 2}
      aria-expanded={onToggle ? Boolean(expanded) : undefined}
      aria-owns={expanded ? groupId : undefined}
      aria-selected={active && !ancestor}
      aria-current={active && !ancestor ? 'page' : undefined}
      aria-label={name}
      data-state={active ? ancestor ? 'ancestor' : 'selected' : undefined}
      tabIndex={active && !ancestor ? 0 : -1}
      onClick={activate}
      onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); activate(); } }}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`panvas-tree-row relative ${dragClass}`}
      style={{ paddingLeft: `${(depth + 1) * 16 + 6}px` }}
    >
      {onToggle ? (
        <button
          type="button"
          data-tree-toggle
          tabIndex={-1}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
          title={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
          onClick={event => { event.stopPropagation(); onToggle(); }}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-panvas-text-tertiary hover:text-panvas-text-primary focus-ring"
        >
          <ChevronRight size={13} className={expanded ? 'rotate-90' : ''} />
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <span className="flex w-4 shrink-0 items-center justify-center" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left" title={name}>{label}</span>
      {badge !== undefined && <span className="text-[10px] tabular-nums text-panvas-text-tertiary">{badge}</span>}
      {trailing}
      <button
        type="button"
        tabIndex={-1}
        onClick={event => { event.stopPropagation(); onContextMenu?.(event); }}
        className="panvas-tree-actions flex h-5 w-5 shrink-0 items-center justify-center text-panvas-text-tertiary hover:bg-panvas-bg-active focus-ring"
        aria-label={`More actions for ${name}`}
        title={`More actions for ${name}`}
      >
        <MoreHorizontal size={13} />
      </button>
    </div>
  );
}

function Collapsible({ id, open, depth, children }: { id: string; open: boolean; depth: number; children: React.ReactNode }) {
  return open ? <div id={id} role="group" className="panvas-tree-branch" style={{ '--tree-guide-left': `${(depth + 1) * 16 + 14}px` } as React.CSSProperties}>{children}</div> : null;
}

function TreeEmptyState({ depth, label }: { depth: number; label: string }) {
  return <div className="h-7 pr-2 text-[11px] leading-7 text-panvas-text-tertiary" style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}>{label}</div>;
}
