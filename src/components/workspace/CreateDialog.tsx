import { TEMPLATE_REGISTRY } from '@/components/notebook/templates/TemplateRegistry';
import { TemplatePreview } from '@/components/notebook/templates/TemplatePreview';
import { createEmptyDrawingData, type PageTemplate } from '@/components/notebook/engine/drawingTypes';
import { useNotebookSettingsStore } from '@/stores/notebookSettingsStore';
// ============================================
// Panvas — Create Dialog
// ============================================

import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, FileText, Folder, Briefcase, BookOpen, ListTree } from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { NotebookCover } from '@/types/notebook';
import { DEFAULT_NOTEBOOK_COVER } from '@/components/library/notebookCovers';
import { NotebookCoverPicker } from '@/components/library/NotebookCoverPicker';
import { validateEntityName } from '@/lib/entityName';
import { useLocation } from 'wouter';
import type { NewDocumentPageOptions } from '@/stores/workspaceStore';

export function CreateDialog() {
  const {
    isCreateDialogOpen,
    createDialogType,
    createDialogParentId,
    createDialogParentType,
    createDialogLayoutMode,
    createDialogAfterPageId,
    setDocumentFocusPageId,
    closeCreateDialog,
    showToast,
  } = useUIStore();

  const { createWorkspace, createFolder, createNotebook, createNotebookSection, createNotebookPage, createCanvas, setActiveCanvas, setActivePage, reorderPages } = useWorkspaceStore();
  const [name, setName] = useState('');
  const [cover, setCover] = useState<NotebookCover>(DEFAULT_NOTEBOOK_COVER);
  const [template, setTemplate] = useState<PageTemplate>('Blank');
  const [layoutMode, setLayoutMode] = useState<'document' | 'freeform'>('document');
  const [pageSize, setPageSize] = useState<NewDocumentPageOptions['pageSize']>('A4');
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (isCreateDialogOpen) {
      setName('');
      setTemplate(useNotebookSettingsStore.getState().template);
      setCover({ ...DEFAULT_NOTEBOOK_COVER });
      setLayoutMode(createDialogLayoutMode ?? 'document');
      setPageSize('A4');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isCreateDialogOpen, createDialogLayoutMode]);

  // Handle Escape key to close dialog
  useEffect(() => {
    if (!isCreateDialogOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeCreateDialog();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isCreateDialogOpen, closeCreateDialog]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
      // Filesystem-safe names (Windows reserved device names like CON/LPT1,
      // illegal characters) are rejected here with a clean error before any
      // store or repository path runs. Valid names pass through unchanged.
      const validated = validateEntityName(trimmed, current.title.toLowerCase());
      if (createDialogType === 'workspace') {
        await createWorkspace(validated);
      } else if (createDialogType === 'folder') {
        await createFolder(createDialogParentId, validated);
      } else if (createDialogType === 'notebook') {
        await createNotebook(createDialogParentId, validated, cover, template);
      } else if (createDialogType === 'section' && createDialogParentId) {
        await createNotebookSection(createDialogParentId, validated);
      } else if (createDialogType === 'page' && createDialogParentId) {
        const page = await createNotebookPage(createDialogParentId, validated, { layoutMode, pageSize });
        if (createDialogAfterPageId) {
          const ids = useWorkspaceStore.getState().notebookPages.filter(item => !item.deletedAt && item.sectionId === createDialogParentId && item.id !== page.id).sort((a, b) => a.order - b.order).map(item => item.id);
          const previousIndex = ids.indexOf(createDialogAfterPageId);
          ids.splice(previousIndex >= 0 ? previousIndex + 1 : ids.length, 0, page.id);
          await reorderPages(ids);
        }
        if (layoutMode === 'document') setDocumentFocusPageId(page.id);
        setActivePage(page.id);
        navigate('/app');
      } else if (createDialogType === 'canvas') {
        const folderId = (!createDialogParentType || createDialogParentType === 'folder') ? createDialogParentId : null;
        const notebookId = createDialogParentType === 'notebook' ? createDialogParentId : null;
        const sectionId = createDialogParentType === 'section' ? createDialogParentId : null;
        const canvas = await createCanvas(folderId, notebookId, sectionId, validated);
        setActiveCanvas(canvas.id);
      }
      closeCreateDialog();
    } catch (err) {
      console.error('Failed to create:', err);
      const cleanDetail = err instanceof Error && typeof err.message === 'string' && !err.message.includes('\\') && !err.message.includes('/') && err.message.length < 80
        ? `: ${err.message}`
        : '.';
      showToast(`Couldn't create ${current.title.toLowerCase()}${cleanDetail}`, 'error');
    }
  };

  const config = {
    workspace: {
      icon: <Briefcase size={18} className="text-panvas-accent-violet" />,
      title: 'New Workspace',
      description: 'A top-level space for notebooks, canvases, and folders.',
      placeholder: 'Workspace name...',
      defaultName: 'My Workspace',
    },
    folder: {
      icon: <Folder size={18} className="text-panvas-accent-amber" />,
      title: 'New Folder',
      description: 'Keep related notebooks and canvases together.',
      placeholder: 'Folder name...',
      defaultName: 'New Folder',
    },
    notebook: {
      icon: <BookOpen size={18} className="text-panvas-accent-blue" />,
      title: 'New Notebook',
      description: 'Create a page-based workspace for writing and drawing.',
      placeholder: 'Notebook name...',
      defaultName: 'Untitled Notebook',
    },
    section: {
      icon: <ListTree size={18} className="text-panvas-accent-emerald" />,
      title: 'New Section',
      description: 'Add a focused section to the active notebook.',
      placeholder: 'Section name...',
      defaultName: 'Untitled Section',
    },
    page: {
      icon: <FileText size={18} className="text-panvas-accent-violet" />,
      title: 'New Page',
      description: 'Write across automatic sheets, or choose a Freeform page.',
      placeholder: 'Page title...',
      defaultName: 'Untitled Page',
    },
    canvas: {
      icon: <FileText size={18} className="text-panvas-accent-blue" />,
      title: 'New Canvas',
      description: 'Open an infinite surface for visual thinking.',
      placeholder: 'Canvas name...',
      defaultName: 'Untitled Canvas',
    },
  };

  const current = createDialogType ? config[createDialogType] : config.canvas;

  if (!isCreateDialogOpen) return null;

  return (
    <AnimatePresence>
      <div className="panvas-layer-modal fixed inset-0 flex items-center justify-center p-4 max-[599px]:p-2">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="panvas-dialog-backdrop absolute inset-0"
          onClick={closeCreateDialog}
        />

        {/* Dialog */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 4 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-dialog-title"
          className={`panvas-dialog relative max-h-[calc(100dvh-1rem)] w-full overflow-y-auto p-5 ${createDialogType === 'notebook' ? 'max-w-xl' : 'max-w-sm'}`}
        >
          {/* Close Button */}
          <button
            type="button"
            onClick={closeCreateDialog}
            className="absolute top-3.5 right-3.5 flex h-7 w-7 items-center justify-center rounded-md text-panvas-text-tertiary hover:bg-panvas-bg-hover hover:text-panvas-text-primary transition-colors focus-ring"
            aria-label="Close dialog"
          >
            <X size={15} />
          </button>

          {/* Header */}
          <div className="flex items-center gap-2.5 mb-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-panvas-bg-secondary border border-panvas-border-subtle">
              {current.icon}
            </div>
            <div><h2 id="create-dialog-title" className="text-sm font-semibold text-panvas-text-primary">{current.title}</h2><p className="mt-1 text-[11px] leading-relaxed text-panvas-text-tertiary">{current.description}</p></div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                ref={inputRef}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={current.placeholder}
                className="w-full h-9 px-3 rounded-lg bg-panvas-bg-primary border border-panvas-border-default text-panvas-text-primary text-xs placeholder:text-panvas-text-tertiary focus:outline-none focus:border-panvas-border-strong focus:ring-1 focus:ring-panvas-border-strong transition-colors"
                id="create-dialog-input"
                autoComplete="off"
              />
            </div>
            {createDialogType === 'notebook' && <NotebookCoverPicker value={cover} onChange={setCover} title={name || 'Notebook'} />}
            {createDialogType === 'page' && <div className="space-y-3 text-xs text-panvas-text-secondary">
              <fieldset><legend className="mb-1.5">Writing layout</legend><div className="grid grid-cols-2 gap-2">
                {(['document', 'freeform'] as const).map(mode => <button key={mode} type="button" aria-pressed={layoutMode === mode} onClick={() => setLayoutMode(mode)} className={`rounded-lg border p-3 text-left focus-ring ${layoutMode === mode ? 'border-panvas-accent-blue bg-panvas-accent-blue/10 text-panvas-text-primary' : 'border-panvas-border-default hover:bg-panvas-bg-hover'}`}>
                  <span className="block font-medium">{mode === 'document' ? 'Document' : 'Freeform'}</span><span className="mt-1 block text-2xs text-panvas-text-secondary">{mode === 'document' ? 'Text flows across sheets' : 'Text boxes and handwriting'}</span>
                </button>)}
              </div></fieldset>
              <fieldset><legend className="mb-1.5">Paper size</legend><div className="flex flex-wrap gap-1">
                {(['A4', 'A3', 'A5', 'Letter', 'Infinite'] as const).map(size => <button key={size} type="button" aria-pressed={pageSize === size} onClick={() => setPageSize(size)} className={`min-h-8 rounded-md border px-3 focus-ring ${pageSize === size ? 'border-panvas-accent-blue bg-panvas-accent-blue/10 text-panvas-text-primary' : 'border-panvas-border-default hover:bg-panvas-bg-hover'}`}>{size}</button>)}
              </div></fieldset>
              <p className="text-2xs leading-relaxed">{layoutMode === 'freeform' ? 'Place text boxes and handwriting anywhere on the page.' : pageSize === 'Infinite' ? 'One continuous document with a fixed writing width.' : 'Text continues onto the next sheet automatically.'}</p>
            </div>}
            {createDialogType === 'notebook' && <fieldset className="mt-3 min-w-0"><legend className="mb-2 text-xs font-medium text-panvas-text-secondary">Paper for new pages</legend>
              <div className="relative min-w-0">
                <div className="flex max-w-full snap-x snap-proximity gap-2 overflow-x-auto pb-2 pr-8 [scrollbar-color:var(--color-panvas-border-strong)_transparent] [scrollbar-width:thin]">
                  {Object.values(TEMPLATE_REGISTRY).map(item => <button key={item.id} type="button" aria-pressed={template === item.id} onClick={() => setTemplate(item.id)} title={item.description} className={`group w-[96px] shrink-0 snap-start rounded-xl border p-1.5 text-left transition-all focus-ring ${template === item.id ? 'border-panvas-accent-blue bg-panvas-accent-blue/10 shadow-sm ring-1 ring-panvas-accent-blue/30' : 'border-panvas-border-subtle bg-panvas-bg-secondary/35 hover:border-panvas-border-strong hover:bg-panvas-bg-hover'}`}>
                    <div className="h-28 overflow-hidden rounded-lg border border-panvas-border-subtle bg-panvas-bg-primary shadow-inner"><TemplatePreview template={item.id} properties={createEmptyDrawingData().properties} /></div>
                    <span className="mt-1.5 block truncate text-2xs font-medium text-panvas-text-primary">{item.name}</span>
                  </button>)}
                </div>
                <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-panvas-bg-primary to-transparent" />
              </div>
            </fieldset>}

            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={closeCreateDialog}
                className="h-8 px-3 rounded-md text-xs font-medium text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary transition-colors focus-ring"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!name.trim()}
                className="h-8 px-4 rounded-md bg-panvas-text-primary text-panvas-bg-primary text-xs font-medium transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
              >
                Create
              </button>
            </div>
          </form>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
