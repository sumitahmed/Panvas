import React, { useEffect, useMemo, useState } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useUIStore } from '@/stores/uiStore';
import { Plus, ChevronRight, BookOpen, Grid2X2, ListTree } from 'lucide-react';
import { NotebookPageThumbnail } from './NotebookPageThumbnail';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { notebookRepository } from '@/repositories/NotebookRepository';
import { useAuthStore } from '@/stores/authStore';
import { extractNotebookOutline, type OutlinePage, type NotebookOutlineEntry } from './outlineModel';
import { createPageExportTarget } from '@/services/pdf/notebookExportTargets';

export function NotebookSidebar() {
  const { 
    notebooks, 
    notebookSections, 
    notebookPages, 
    activeWorkspaceId,
    activeNotebookId, 
    activeNotebookSectionId,
    activePageId,
    setActivePage,
    reorderPages
  } = useWorkspaceStore();
  
  const { openCreateDialog, openContextMenu, showToast } = useUIStore();

  const activeNotebook = notebooks.find(n => n.id === activeNotebookId);
  const activeSection = notebookSections.find(s => s.id === activeNotebookSectionId);
  
  // Filter and sort pages for current section
  const currentPages = notebookPages
    .filter(p => p.sectionId === activeNotebookSectionId && !p.deletedAt)
    .sort((a, b) => a.order - b.order);

  // Drag and drop state
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragTargetIndex, setDragTargetIndex] = useState<number | null>(null);
  const [dragTargetPosition, setDragTargetPosition] = useState<'top' | 'bottom' | null>(null);
  const [sidebarView, setSidebarView] = useState<'thumbnails' | 'outlines'>('thumbnails');
  const [pagePayloads, setPagePayloads] = useState<Record<string, { content: unknown; drawing: unknown }>>({});
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const { user } = useAuthStore();

  const outlinePages = useMemo<OutlinePage[]>(() => notebookPages
    .filter(page => page.notebookId === activeNotebookId && !page.deletedAt)
    .map(page => ({ ...page, ...(pagePayloads[page.id] ?? {}) })), [activeNotebookId, notebookPages, pagePayloads]);
  const outlineSections = useMemo(() => notebookSections.filter(section => section.notebookId === activeNotebookId && !section.deletedAt), [activeNotebookId, notebookSections]);
  const outline = useMemo(() => extractNotebookOutline(outlinePages, outlineSections), [outlinePages, outlineSections]);
  const hasHeadings = outline.some(item => item.kind === 'heading');

  useEffect(() => {
    if (!activeNotebookId || !activeWorkspaceId) return;
    let cancelled = false;
    const notebookPagesForOutline = notebookPages.filter(page => page.notebookId === activeNotebookId && !page.deletedAt);
    const loadPagePayload = async (pageId: string) => {
      const page = notebookPagesForOutline.find(item => item.id === pageId);
      if (!page) return;
      const [content, drawing] = await Promise.all([
        notebookRepository.loadPageData(activeWorkspaceId, activeNotebookId, page.id).catch(() => null),
        notebookRepository.loadDrawingData(activeWorkspaceId, activeNotebookId, page.id).catch(() => null),
      ]);
      if (!cancelled) setPagePayloads(previous => ({ ...previous, [page.id]: { content, drawing } }));
    };
    void Promise.all(notebookPagesForOutline.map(page => loadPagePayload(page.id)));
    const handleContentChanged = (event: Event) => {
      const pageId = (event as CustomEvent<{ pageId?: string }>).detail?.pageId;
      if (pageId) void loadPagePayload(pageId);
    };
    window.addEventListener('panvas:notebook-content-changed', handleContentChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('panvas:notebook-content-changed', handleContentChanged);
    };
  }, [activeNotebookId, activeWorkspaceId, notebookPages]);

  const handlePdfImport = async (file: File, sectionId: string) => {
    if (!activeNotebookId || !activeWorkspaceId) {
      showToast('No active workspace or notebook', 'error');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      // Store PDF
      const pdfData = await canvasRepository.storePdf(user?.id || null, 'temp', file.name, buffer);
      // Create Notebook Page
      const page = await notebookRepository.createPage(
        user?.id || null,
        activeWorkspaceId,
        activeNotebookId,
        sectionId,
        file.name,
        'pdf',
        pdfData.id
      );
      // Refresh pages via workspace store if needed, but the sync mechanism usually picks it up
      setActivePage(page.id);
      showToast(`Imported ${file.name}`, 'success');
    } catch (err: any) {
      console.error(err);
      showToast(`Failed to import PDF: ${err.message}`, 'error');
    }
  };

  React.useEffect(() => {
    const handleImportEvent = (e: CustomEvent<{ sectionId: string }>) => {
      if (fileInputRef.current) {
        // We store the target section ID as a data attribute on the input
        fileInputRef.current.dataset.targetSectionId = e.detail.sectionId;
        fileInputRef.current.click();
      }
    };
    window.addEventListener('panvas:import-pdf', handleImportEvent as EventListener);
    return () => window.removeEventListener('panvas:import-pdf', handleImportEvent as EventListener);
  }, []);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const sectionId = e.target.dataset.targetSectionId;
    const isPdf = file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
    if (isPdf && sectionId) {
      handlePdfImport(file, sectionId);
    }
    // reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    // Small delay to allow drag image to generate before adding styles
    setTimeout(() => {
      if (e.target instanceof HTMLElement) {
        e.target.style.opacity = '0.5';
      }
    }, 0);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    setDragTargetIndex(index);
    setDragTargetPosition(thumbnailDropHalf(e));
  };

  // Drop position comes from the event's own geometry: a quick flick can
  // release before React commits the dragover state, and a stale value would
  // shift the insert point by one slot.
  const thumbnailDropHalf = (e: React.DragEvent): 'top' | 'bottom' => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY - rect.top < rect.height / 2 ? 'top' : 'bottom';
  };

  const handleDragLeave = (e: React.DragEvent) => {
    setDragTargetIndex(null);
    setDragTargetPosition(null);
  };

  const handleDrop = async (e: React.DragEvent, index?: number) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const pdfFile = Array.from(e.dataTransfer.files).find(f => f.type === 'application/pdf');
      if (pdfFile && activeNotebookSectionId) {
         await handlePdfImport(pdfFile, activeNotebookSectionId);
      }
      resetDragState(e);
      return;
    }

    if (index === undefined || draggedIndex === null || draggedIndex === index) {
      resetDragState(e);
      return;
    }

    const targetPosition = thumbnailDropHalf(e);

    const newPages = [...currentPages];
    const [draggedItem] = newPages.splice(draggedIndex, 1);

    // Calculate new index
    let insertIndex = targetPosition === 'top' ? index : index + 1;
    // Adjust if dragging down since we removed an item before it
    if (draggedIndex < index && targetPosition === 'top') {
      insertIndex -= 1;
    }

    newPages.splice(insertIndex, 0, draggedItem);

    // Perform reorder
    if (reorderPages) {
      await reorderPages(newPages.map(p => p.id));
    }

    resetDragState(e);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    resetDragState(e);
  };

  const resetDragState = (e: React.DragEvent) => {
    if (e.target instanceof HTMLElement) {
      e.target.style.opacity = '1';
    }
    setDraggedIndex(null);
    setDragTargetIndex(null);
    setDragTargetPosition(null);
  };

  return (
    <aside 
      className="h-full w-full flex-shrink-0 flex flex-col bg-panvas-bg-primary border-r border-panvas-border-subtle text-xs"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          handleDrop(e);
        }
      }}
    >
      <input 
        type="file" 
        accept="application/pdf" 
        ref={fileInputRef} 
        onChange={handleFileInputChange}
        className="hidden" 
      />
      {/* Header */}
      <div className="px-3 pt-4 pb-3 flex-shrink-0 border-b border-panvas-border-subtle">
        <div className="flex items-center gap-1.5 text-panvas-text-tertiary mb-3 px-1">
          <BookOpen size={13} />
          <span className="truncate max-w-[80px]">{activeNotebook?.name || 'Notebook'}</span>
          <ChevronRight size={13} />
          <span className="truncate font-medium text-panvas-text-primary">{activeSection?.name || 'Section'}</span>
        </div>
        
        <button
          onClick={() => activeNotebookSectionId ? openCreateDialog('page', activeNotebookSectionId) : showToast('Select a section first', 'info')}
          className="w-full h-8 flex items-center justify-center gap-1.5 px-2 rounded-md
                     border border-panvas-accent-blue/20 bg-panvas-accent-blue/10 text-panvas-accent-blue font-medium
                     hover:bg-panvas-accent-blue/20 hover:border-panvas-accent-blue/30 active:bg-panvas-accent-blue/30
                     transition-colors duration-150 focus-ring"
        >
          <Plus size={14} />
          <span>Add Page</span>
        </button>
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-panvas-bg-secondary p-1" role="tablist" aria-label="Notebook navigation view">
          <button type="button" role="tab" aria-selected={sidebarView === 'thumbnails'} onClick={() => setSidebarView('thumbnails')} className={`flex h-7 items-center justify-center gap-1 rounded px-2 text-2xs font-medium transition-colors focus-ring ${sidebarView === 'thumbnails' ? 'bg-panvas-bg-primary text-panvas-text-primary shadow-sm' : 'text-panvas-text-tertiary hover:text-panvas-text-secondary'}`}><Grid2X2 size={13} />Thumbnails</button>
          <button type="button" role="tab" aria-selected={sidebarView === 'outlines'} onClick={() => setSidebarView('outlines')} className={`flex h-7 items-center justify-center gap-1 rounded px-2 text-2xs font-medium transition-colors focus-ring ${sidebarView === 'outlines' ? 'bg-panvas-bg-primary text-panvas-text-primary shadow-sm' : 'text-panvas-text-tertiary hover:text-panvas-text-secondary'}`}><ListTree size={13} />Outlines</button>
        </div>
      </div>

      {/* Page Sorter List */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
        {sidebarView === 'thumbnails' && currentPages.map((page, index) => (
          <NotebookPageThumbnail
            key={page.id}
            page={page}
            index={index}
            isActive={page.id === activePageId}
            onClick={() => setActivePage(page.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              openContextMenu(
                e.clientX,
                e.clientY,
                page.id,
                'page',
                activeNotebook && activeSection
                  ? createPageExportTarget(page, activeSection, activeNotebook)
                  : null,
              );
            }}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
            isDragTarget={dragTargetIndex === index}
            dragTargetPosition={dragTargetPosition}
          />
        ))}
        {sidebarView === 'thumbnails' && currentPages.length === 0 && (
          <div className="text-center text-panvas-text-tertiary mt-8">
            No pages in this section.
          </div>
        )}
        {sidebarView === 'outlines' && <NotebookOutlineList outline={outline} hasHeadings={hasHeadings} activePageId={activePageId} onSelectPage={setActivePage} />}
      </div>
    </aside>
  );
}

function NotebookOutlineList({ outline, hasHeadings, activePageId, onSelectPage }: { outline: NotebookOutlineEntry[]; hasHeadings: boolean; activePageId: string | null; onSelectPage: (pageId: string) => void }) {
  if (!hasHeadings) {
    return <div className="mt-8 px-2 text-center text-panvas-text-tertiary"><ListTree size={20} className="mx-auto opacity-60" /><p className="mt-2 text-xs leading-relaxed">No headings found. Add H1, H2, or H3 in notes to generate an outline.</p></div>;
  }
  return <div className="space-y-0.5" role="tree" aria-label="Notebook outline">{outline.map(item => {
    const isPage = item.kind === 'page';
    const indent = isPage ? 'pl-1' : item.level === 1 ? 'pl-2' : item.level === 2 ? 'pl-4' : 'pl-6';
    return <button key={item.id} type="button" role="treeitem" onClick={() => onSelectPage(item.pageId)} className={`flex min-h-8 w-full items-center gap-1.5 rounded-md pr-2 text-left transition-colors focus-ring ${indent} ${item.pageId === activePageId ? 'bg-panvas-accent-blue/10 text-panvas-accent-blue' : 'text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary'}`} title={`Page ${item.pageNumber}: ${item.title}`}>
      {isPage ? <BookOpen size={13} className="flex-shrink-0 opacity-70" /> : <span className="flex h-4 min-w-6 items-center justify-center rounded border border-current/20 px-1 text-[9px] font-semibold uppercase">H{item.level}</span>}
      <span className="w-5 flex-shrink-0 text-right font-mono text-2xs opacity-60">{item.pageNumber}</span><span className="min-w-0 flex-1 truncate text-xs">{item.title}</span>
    </button>;
  })}</div>;
}
