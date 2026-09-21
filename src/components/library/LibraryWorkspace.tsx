import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, BookOpen, BriefcaseBusiness, ChevronDown, Clock3, Cloud, Download, Folder, FolderOpen, Grid2X2, List, Palette, Plus, RotateCcw, Search, Star, Trash2, Upload, X, type LucideIcon } from 'lucide-react';
import { useLocation } from 'wouter';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useUIStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { FOLDER_COLOR_PRESETS, type Folder as WorkspaceFolder, type FolderIconId } from '@/types/workspace';
import { exportWorkspaceBackup, importWorkspaceBackup, importWorkspaceBackupFromDialog } from '@/services/backup/backupService';
import { FilePreviewCard, type LibraryFile } from './FilePreviewCards';
import { CloudSyncPanel } from './CloudSyncPanel';
import { filterAndSortLibraryFiles, getLibraryTags, projectActiveLibraryFiles, projectLibraryTrashFiles, type LibraryFilter, type LibrarySort, type LibraryView } from './libraryModel';
import type { Notebook, NotebookCover } from '@/types/notebook';
import { DEFAULT_NOTEBOOK_COVER } from './notebookCovers';
import { NotebookCoverPicker } from './NotebookCoverPicker';
import { readLastLibraryView, rememberLibraryView } from '@/services/library/libraryRouteState';
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

const filters: Array<{ id: LibraryFilter; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'notebook', label: 'Notebooks' },
  { id: 'canvas', label: 'Canvases' }, { id: 'pdf', label: 'PDFs' },
];
const folderIcons: Record<FolderIconId, LucideIcon> = { folder: Folder, book: BookOpen, briefcase: BriefcaseBusiness, archive: Archive };
const folderIconIds: FolderIconId[] = ['folder', 'book', 'briefcase', 'archive'];

function displayType(type: LibraryFile['type']): string {
  return type === 'pdf' ? 'PDF' : type === 'canvas' ? 'Canvas' : type[0].toUpperCase() + type.slice(1);
}

function trashEntityType(file: LibraryFile): 'workspace' | 'folder' | 'canvas' | 'notebook' | 'section' | 'page' {
  return file.trashKind ?? (file.type === 'pdf' || file.type === 'page' ? 'page' : file.type === 'canvas' ? 'canvas' : file.type === 'folder' ? 'folder' : file.type === 'section' ? 'section' : file.type === 'workspace' ? 'workspace' : 'notebook');
}

export function LibraryWorkspace() {
  const [, navigate] = useLocation();
  const store = useWorkspaceStore();
  const { openCreateDialog, openContextMenu, showToast } = useUIStore();
  const user = useAuthStore(state => state.user);
  const importInputRef = useRef<HTMLInputElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [trashBusy, setTrashBusy] = useState(false);
  const [view, setView] = useState<LibraryView>(() => readLastLibraryView());
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [query, setQuery] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<LibrarySort>('modified-desc');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const isMobileViewport = useIsMobileViewport();
  // Presentation-only fallback: below the phone breakpoint the fixed-width
  // desktop list rows would force horizontal scrolling, so the mobile card
  // grid renders instead. The user's grid/list preference is untouched and
  // applies unchanged at >=600px.
  const effectiveViewMode: 'grid' | 'list' = isMobileViewport ? 'grid' : viewMode;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customizingFolderId, setCustomizingFolderId] = useState<string | null>(null);
  const [customizingNotebookId, setCustomizingNotebookId] = useState<string | null>(null);
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
  } | null>(null);

  useEffect(() => {
    if (store.activeWorkspaceId) void store.loadWorkspaceContents(store.activeWorkspaceId);
    void store.loadTrash();
  }, [store.activeWorkspaceId, store.loadTrash, store.loadWorkspaceContents]);

  useEffect(() => {
    const handleSetView = (e: Event) => {
      const customEvent = e as CustomEvent<LibraryView>;
      if (customEvent.detail) {
        selectView(customEvent.detail);
      }
    };
    window.addEventListener('panvas:set-library-view', handleSetView);
    return () => window.removeEventListener('panvas:set-library-view', handleSetView);
  }, []);

  useEffect(() => {
    if (!isCreateMenuOpen) return;
    const dismissOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsCreateMenuOpen(false);
    };
    const dismissOnPointer = (event: PointerEvent) => {
      if (!createMenuRef.current?.contains(event.target as Node)) setIsCreateMenuOpen(false);
    };
    document.addEventListener('keydown', dismissOnKey);
    document.addEventListener('pointerdown', dismissOnPointer);
    return () => {
      document.removeEventListener('keydown', dismissOnKey);
      document.removeEventListener('pointerdown', dismissOnPointer);
    };
  }, [isCreateMenuOpen]);

  const activeWorkspace = store.workspaces.find(item => item.id === store.activeWorkspaceId);
  const liveFolders = store.folders.filter(item => item.workspaceId === store.activeWorkspaceId && !item.deletedAt);

  const openFile = async (file: LibraryFile) => {
    if (file.workspaceId && file.workspaceId !== store.activeWorkspaceId) {
      await store.setActiveWorkspace(file.workspaceId);
    }
    if (file.type === 'canvas') {
      await store.setActiveCanvas(file.id);
      navigate('/app');
      return;
    }
    if (file.type === 'pdf' || file.type === 'page') {
      const targetPage = store.notebookPages.find(item => item.id === file.id);
      if (targetPage) {
        const section = store.notebookSections.find(s => s.id === targetPage.sectionId);
        const notebook = store.notebooks.find(n => n.id === targetPage.notebookId);
        if (notebook) await store.setActiveNotebook(notebook.id);
        if (section) await store.setActiveNotebookSection(section.id);
        await store.setActivePage(targetPage.id);
        navigate('/app');
        return;
      }
    }
    if (file.type === 'notebook') {
      const notebook = store.notebooks.find(n => n.id === file.id);
      if (!notebook) return;
      const sections = store.notebookSections.filter(s => s.notebookId === notebook.id && !s.deletedAt).sort((a, b) => a.order - b.order);
      const pages = store.notebookPages.filter(p => p.notebookId === notebook.id && !p.deletedAt).sort((a, b) => a.order - b.order);

      if (pages.length > 0) {
        const targetPage = pages[0];
        const section = sections.find(s => s.id === targetPage.sectionId);
        if (section) await store.setActiveNotebookSection(section.id);
        await store.setActivePage(targetPage.id);
      } else if (sections.length > 0) {
        await store.setActiveNotebookSection(sections[0].id);
      } else {
        await store.setActiveNotebook(notebook.id);
      }
      navigate('/app');
      return;
    }
  };

  const toggleFavorite = async (file: LibraryFile) => {
    if (file.type === 'notebook') {
      await store.togglePinNotebook(file.id);
    } else if (file.type === 'canvas') {
      await store.togglePinCanvas(file.id);
    }
  };

  const handleRestore = async (file: LibraryFile) => {
    try {
      await store.restoreItem(file.id, trashEntityType(file));
      showToast(`Restored "${file.title}".`, 'success');
    } catch (error) {
      console.warn('[LibraryWorkspace] Restore failed:', error);
      showToast('Could not restore item.', 'error');
    }
  };

  const handlePermanentDelete = (file: LibraryFile) => {
    if (trashBusy) return;
    setConfirmDialog({
      title: 'Delete this item permanently?',
      description: `“${file.title}” will be permanently deleted. This action cannot be undone.`,
      confirmLabel: 'Delete permanently',
      onConfirm: async () => {
        setTrashBusy(true);
        try {
          await store.permanentlyDeleteItem(file.id, trashEntityType(file));
          showToast(`Deleted "${file.title}" permanently.`, 'success');
        } catch (error) {
          console.warn('[LibraryWorkspace] Permanent Trash delete failed:', error);
          showToast('Could not permanently delete this item.', 'error');
        } finally {
          setTrashBusy(false);
          setConfirmDialog(null);
        }
      },
    });
  };

  const handleDeleteAllTrash = () => {
    const count = trashFiles.length;
    if (count === 0 || trashBusy) return;
    setConfirmDialog({
      title: 'Empty Trash permanently?',
      description: `This will permanently delete all ${count} Trash item${count === 1 ? '' : 's'}. This cannot be undone.`,
      confirmLabel: 'Empty Trash',
      onConfirm: async () => {
        setTrashBusy(true);
        try {
          const result = await store.permanentlyDeleteAllTrash();
          if (result.failed > 0) showToast(`${result.deleted} item${result.deleted === 1 ? '' : 's'} deleted; ${result.failed} could not be deleted.`, 'error');
          else showToast(`Deleted ${result.deleted} Trash item${result.deleted === 1 ? '' : 's'} permanently.`, 'success');
        } catch (error) {
          console.warn('[LibraryWorkspace] Delete all Trash failed:', error);
          showToast('Could not empty Trash.', 'error');
        } finally {
          setTrashBusy(false);
          setConfirmDialog(null);
        }
      },
    });
  };

  const handleContextMenu = (event: React.MouseEvent, file: LibraryFile) => {
    event.preventDefault();
    openContextMenu(event.clientX, event.clientY, file.id, trashEntityType(file));
  };

  const liveFiles = useMemo<LibraryFile[]>(() => projectActiveLibraryFiles({
    activeWorkspaceId: store.activeWorkspaceId,
    notebooks: store.notebooks,
    notebookPages: store.notebookPages,
    canvasFiles: store.canvasFiles,
  }), [store.activeWorkspaceId, store.canvasFiles, store.notebookPages, store.notebooks]);

  const trashFiles = useMemo<LibraryFile[]>(() => projectLibraryTrashFiles({
    activeWorkspaceId: store.activeWorkspaceId,
    workspaces: store.deletedWorkspaces,
    folders: store.deletedFolders,
    canvasFiles: store.deletedCanvases,
    notebooks: store.deletedNotebooks,
    sections: store.deletedSections,
    pages: store.deletedPages,
    activeWorkspaces: store.workspaces,
    activeFolders: store.folders,
    activeNotebooks: store.notebooks,
    activeSections: store.notebookSections,
  }), [store.activeWorkspaceId, store.deletedCanvases, store.deletedFolders, store.deletedNotebooks, store.deletedPages, store.deletedSections, store.deletedWorkspaces, store.folders, store.notebooks, store.notebookSections, store.workspaces]);

  const sourceFiles = view === 'trash' ? trashFiles : liveFiles;
  const queryOptions = { view, filter, folderId, query, tag, sort };
  const visibleFiles = useMemo(() => filterAndSortLibraryFiles(sourceFiles, queryOptions), [filter, folderId, query, sort, sourceFiles, tag, view]);
  const availableTags = useMemo(() => getLibraryTags(filterAndSortLibraryFiles(sourceFiles, { ...queryOptions, tag: null })), [filter, folderId, query, sort, sourceFiles, view]);

  const selectView = (nextView: LibraryView) => {
    setView(nextView);
    rememberLibraryView(nextView);
    setFolderId(null);
    setTag(null);
    setSelectedId(null);
  };

  const selectFolder = (id: string | null) => {
    setView('library');
    setFolderId(id);
    setTag(null);
    setSelectedId(null);
  };
  const updateFolderAppearance = (id: string, appearance: Pick<WorkspaceFolder, 'color' | 'icon'>) => {
    void store.updateFolderAppearance(id, appearance);
  };

  const handleExportBackup = async () => {
    if (!store.activeWorkspaceId) return;
    setBackupBusy(true);
    try {
      const result = await exportWorkspaceBackup(store.activeWorkspaceId, user?.id ?? null);
      if (result.canceled) return;
      if (!result.savedPath) {
        const blob = new Blob([JSON.stringify(result.backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${result.backup.header.workspaceName}.panvas-backup.json`;
        anchor.click();
        URL.revokeObjectURL(url);
      }
      showToast('Workspace backup exported.', 'success');
    } catch (error) {
      console.warn('[LibraryWorkspace] Backup export failed:', error);
      showToast('Could not export workspace backup.', 'error');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImportBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBackupBusy(true);
    try {
      const text = await file.text();
      const result = await importWorkspaceBackup(text, user?.id ?? null);
      await store.loadWorkspaces();
      store.setActiveWorkspace(result.workspaceId);
      await store.loadWorkspaceContents(result.workspaceId);
      showToast(`Backup restored as “${result.workspaceName}”.`, 'success');
    } catch (error) {
      console.warn('[LibraryWorkspace] Backup import failed:', error);
      showToast('This file is not a valid Panvas workspace backup.', 'error');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImportClick = async () => {
    if (!(globalThis as any).panvas?.backup?.importDialog) {
      importInputRef.current?.click();
      return;
    }
    setBackupBusy(true);
    try {
      const result = await importWorkspaceBackupFromDialog();
      if (result.canceled) return;
      await store.loadWorkspaces();
      store.setActiveWorkspace(result.workspaceId);
      await store.loadWorkspaceContents(result.workspaceId);
      showToast(`Backup restored as “${result.workspaceName}”.`, 'success');
    } catch (error) {
      console.warn('[LibraryWorkspace] Backup dialog import failed:', error);
      showToast('This file is not a valid Panvas workspace backup.', 'error');
    } finally {
      setBackupBusy(false);
    }
  };

  const openNewItem = (type: 'notebook' | 'canvas' | 'folder') => {
    setIsCreateMenuOpen(false);
    openCreateDialog(type);
  };

  return <main className="panvas-library h-full overflow-auto bg-panvas-bg-secondary/40"><div className="mx-auto flex min-h-full max-w-[1640px] gap-6 px-5 py-7 lg:px-8 2xl:px-10">
    <LibraryNavigator view={view} onSelectView={selectView} folders={liveFolders} folderId={folderId} onSelectFolder={selectFolder} />
    <section className="min-w-0 flex-1 pb-12">
      {view !== 'cloud' && (
        <header className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="text-xs text-panvas-text-tertiary">{folderId ? 'Folder' : activeWorkspace?.name ?? 'Local workspace'}</p>
            <h1 className="mt-1 text-[30px] font-semibold tracking-tight text-panvas-text-primary">
              {folderId
                ? liveFolders.find(item => item.id === folderId)?.name ?? 'Folder'
                : view === 'library'
                ? 'Library'
                : view[0].toUpperCase() + view.slice(1)}
            </h1>
            <p className="mt-2 text-sm text-panvas-text-secondary">
              {folderId
                ? 'Items organized inside this folder.'
                : view === 'recent'
                ? 'Recently opened and modified notebooks, canvases, and PDFs.'
                : view === 'favorites'
                ? 'Starred items across your active workspace.'
                : view === 'trash'
                ? 'Deleted notebooks, canvases, sections, and pages.'
                : 'Your local notebooks, canvases, PDFs, folders, favorites, and trash.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={importInputRef} type="file" accept=".panvas-backup.json,.json,.panvas-backup" onChange={handleImportBackup} className="hidden" />
            {view === 'trash' && <button
              type="button"
              disabled={trashBusy || trashFiles.length === 0}
              onClick={() => void handleDeleteAllTrash()}
              className="panvas-action-button panvas-action-button--secondary text-panvas-accent-rose disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
              title="Permanently delete every item currently in Trash"
            >
              <Trash2 size={15} />Empty Trash
            </button>}
            <button
              type="button"
              disabled={backupBusy || !store.activeWorkspaceId}
              onClick={() => void handleExportBackup()}
              className="panvas-action-button panvas-action-button--secondary disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
              title="Export complete workspace data, pages, and canvases as a backup file"
            >
              <Download size={15} />Export Workspace Backup
            </button>
            <button
              type="button"
              disabled={backupBusy}
              onClick={() => void handleImportClick()}
              className="panvas-action-button panvas-action-button--secondary disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
              title="Restore a previously exported Panvas workspace backup"
            >
              <Upload size={15} />Restore Workspace Backup
            </button>
            <div ref={createMenuRef} className="relative">
              <button type="button" onClick={() => setIsCreateMenuOpen(open => !open)} aria-expanded={isCreateMenuOpen} aria-haspopup="menu" className="panvas-action-button panvas-action-button--primary focus-ring">
                <Plus size={15} />New<ChevronDown size={14} />
              </button>
              {isCreateMenuOpen && <div role="menu" aria-label="Create new item" className="panvas-overlay panvas-menu absolute right-0 top-[calc(100%+0.5rem)] w-64 p-1.5 z-50">
                <LibraryCreateMenuItem type="notebook" icon={<BookOpen size={15} />} label="New notebook" description="Pages, sections, and handwriting" onClick={() => openNewItem('notebook')} />
                <LibraryCreateMenuItem type="canvas" icon={<BriefcaseBusiness size={15} />} label="New canvas" description="An infinite visual workspace" onClick={() => openNewItem('canvas')} />
                <LibraryCreateMenuItem type="folder" icon={<Folder size={15} />} label="New folder" description="Organize notebooks and canvases" onClick={() => openNewItem('folder')} />
              </div>}
            </div>
          </div>
        </header>
      )}

      {/* Compact Browse switcher for mobile/tablet */}
      <div className="mt-5 flex flex-wrap gap-2 lg:hidden" aria-label="Library views">
        {([
          { id: 'recent', label: 'Recent' },
          { id: 'favorites', label: 'Favorites' },
          { id: 'library', label: 'Library' },
          { id: 'trash', label: 'Trash' },
          { id: 'cloud', label: 'Cloud Sync' },
        ] as Array<{ id: LibraryView; label: string }>).map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => selectView(item.id)}
            aria-current={view === item.id && folderId === null ? 'page' : undefined}
            className={`rounded-full border px-3 py-1.5 text-xs transition-colors focus-ring ${view === item.id && folderId === null ? 'border-panvas-text-primary/25 bg-panvas-bg-active text-panvas-text-primary' : 'border-panvas-border-default bg-panvas-bg-elevated text-panvas-text-secondary hover:bg-panvas-bg-hover'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {view === 'cloud' ? (
        <div className="mt-2 sm:mt-4">
          <CloudSyncPanel />
        </div>
      ) : (
        <>
          <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-y border-panvas-border-subtle py-3">
            <label className="flex h-9 min-w-[220px] max-w-md flex-1 items-center gap-2 rounded-lg border border-panvas-border-default bg-panvas-bg-elevated px-3 text-sm text-panvas-text-tertiary">
              <Search size={15} />
              <input value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-panvas-text-primary outline-none" placeholder="Search this library" aria-label="Search this library" />
            </label>
            <div className="flex items-center gap-2">
              <label className="sr-only" htmlFor="library-sort">Sort library items</label>
              <select id="library-sort" value={sort} onChange={event => setSort(event.target.value as LibrarySort)} className="h-9 rounded-lg border border-panvas-border-default bg-panvas-bg-elevated px-2 text-xs text-panvas-text-secondary focus-ring">
                <option value="name-asc">Name (A–Z)</option>
                <option value="modified-desc">Modified (newest)</option>
                <option value="modified-asc">Modified (oldest)</option>
                <option value="type-asc">Type</option>
              </select>
              <div className="flex h-9 rounded-lg border border-panvas-border-default bg-panvas-bg-elevated p-0.5" role="group" aria-label="Library view">
                <button type="button" onClick={() => setViewMode('grid')} aria-label="Grid view" aria-pressed={viewMode === 'grid'} className={`flex w-8 items-center justify-center rounded ${viewMode === 'grid' ? 'bg-panvas-bg-active text-panvas-text-primary' : 'text-panvas-text-tertiary hover:bg-panvas-bg-hover'}`}><Grid2X2 size={15} /></button>
                <button type="button" onClick={() => setViewMode('list')} aria-label="List view" aria-pressed={viewMode === 'list'} className={`flex w-8 items-center justify-center rounded ${viewMode === 'list' ? 'bg-panvas-bg-active text-panvas-text-primary' : 'text-panvas-text-tertiary hover:bg-panvas-bg-hover'}`}><List size={15} /></button>
              </div>
              <span className="hidden items-center gap-1.5 text-xs text-panvas-text-tertiary sm:flex"><Grid2X2 size={14} />{visibleFiles.length} items</span>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {filters.map(item => <button key={item.id} type="button" onClick={() => { setFilter(item.id); setTag(null); }} className={`rounded-full border px-3 py-1 text-xs transition-colors ${filter === item.id ? 'border-panvas-text-primary/25 bg-panvas-bg-active text-panvas-text-primary' : 'border-panvas-border-default bg-panvas-bg-elevated text-panvas-text-secondary hover:bg-panvas-bg-hover'}`}>{item.label}</button>)}
          </div>

          {availableTags.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-2xs font-semibold uppercase tracking-[0.12em] text-panvas-text-tertiary">Tags</span>
            {availableTags.map(item => <button key={item} type="button" onClick={() => setTag(current => current?.toLocaleLowerCase() === item.toLocaleLowerCase() ? null : item)} className={`rounded-md border px-2 py-1 text-2xs transition-colors ${tag?.toLocaleLowerCase() === item.toLocaleLowerCase() ? 'border-panvas-text-primary/25 bg-panvas-bg-active text-panvas-text-primary' : 'border-panvas-border-default bg-panvas-bg-elevated text-panvas-text-secondary hover:bg-panvas-bg-hover'}`}>{item}</button>)}
          </div>}

          {view === 'library' && liveFolders.length > 0 && <LibrarySection title="Folders">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {liveFolders.map(folder => <FolderShelfCard key={folder.id} folder={folder} count={liveFiles.filter(file => file.folderId === folder.id).length} active={folderId === folder.id} editing={customizingFolderId === folder.id} onOpen={() => selectFolder(folder.id)} onToggleEdit={() => setCustomizingFolderId(current => current === folder.id ? null : folder.id)} onAppearance={appearance => updateFolderAppearance(folder.id, appearance)} />)}
            </div>
          </LibrarySection>}

          <LibrarySection title={folderId ? `Items in ${liveFolders.find(item => item.id === folderId)?.name ?? 'folder'}` : view === 'recent' ? 'Recently opened' : view === 'favorites' ? 'Favorites' : view === 'trash' ? 'Deleted items' : 'All files'}>
            {visibleFiles.length > 0 ? (
              effectiveViewMode === 'grid' ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {visibleFiles.map(file => (
                    <FilePreviewCard
                      key={`${file.type}-${file.id}`}
                      file={file}
                      selected={selectedId === file.id}
                      onSelect={() => setSelectedId(file.id)}
                      onOpen={view === 'trash' ? undefined : () => void openFile(file)}
                      onContextMenu={event => handleContextMenu(event, file)}
                      onToggleFavorite={() => void toggleFavorite(file)}
                      onRestore={view === 'trash' ? () => void handleRestore(file) : undefined}
                      onPermanentDelete={view === 'trash' ? () => void handlePermanentDelete(file) : undefined}
                      onTagClick={setTag}
                      onCustomizeCover={view === 'trash' ? undefined : file.type === 'notebook' ? () => setCustomizingNotebookId(file.id) : undefined}
                    />
                  ))}
                </div>
              ) : (
                <LibraryList
                  files={visibleFiles}
                  folders={liveFolders}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onTagClick={setTag}
                  onOpen={view === 'trash' ? undefined : file => void openFile(file)}
                  onContextMenu={handleContextMenu}
                  onToggleFavorite={file => void toggleFavorite(file)}
                  onRestore={view === 'trash' ? file => void handleRestore(file) : undefined}
                  onPermanentDelete={view === 'trash' ? file => void handlePermanentDelete(file) : undefined}
                  onCustomizeCover={view === 'trash' ? undefined : file => file.type === 'notebook' ? setCustomizingNotebookId(file.id) : undefined}
                />
              )
            ) : (
              <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-panvas-border-default bg-panvas-bg-elevated/60 text-center p-6">
                <Archive size={20} className="text-panvas-text-tertiary" />
                <p className="mt-2 text-sm font-medium text-panvas-text-secondary">
                  {view === 'recent'
                    ? 'No recent activity yet'
                    : view === 'favorites'
                    ? 'No favorite items yet'
                    : view === 'trash'
                    ? 'Trash is empty'
                    : 'No matching items'}
                </p>
                <p className="mt-1 text-xs text-panvas-text-tertiary max-w-sm">
                  {view === 'recent'
                    ? 'Notebooks, canvases, and PDFs you open or edit will appear here.'
                    : view === 'favorites'
                    ? 'Star notebooks or canvases to find them quickly in Favorites.'
                    : view === 'trash'
                    ? 'Deleted items in this workspace will appear here and can be restored.'
                    : 'Adjust your search query, folder selection, tags, or filters.'}
                </p>
              </div>
            )}
          </LibrarySection>
        </>
      )}
    </section>
    {customizingNotebookId && (() => { const notebook = store.notebooks.find(item => item.id === customizingNotebookId); return notebook ? <NotebookCoverDialog notebook={notebook} onClose={() => setCustomizingNotebookId(null)} /> : null; })()}
    {confirmDialog && (
      <ConfirmDialog
        open
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmLabel={confirmDialog.confirmLabel}
        onCancel={() => setConfirmDialog(null)}
        onConfirm={confirmDialog.onConfirm}
      />
    )}
  </div></main>;
}

function LibraryCreateMenuItem({ type, icon, label, description, onClick }: { type: 'notebook' | 'canvas' | 'folder'; icon: React.ReactNode; label: string; description: string; onClick: () => void }) {
  return <button type="button" role="menuitem" aria-label={label} data-create-type={type} onClick={onClick} className="panvas-menu-item items-start"><span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-panvas-bg-secondary text-panvas-text-secondary">{icon}</span><span className="min-w-0"><span className="block text-xs font-medium text-panvas-text-primary">{label}</span><span className="mt-0.5 block text-2xs leading-4 text-panvas-text-tertiary">{description}</span></span></button>;
}

function FolderShelfCard({ folder, count, active, editing, onOpen, onToggleEdit, onAppearance }: { folder: WorkspaceFolder; count: number; active: boolean; editing: boolean; onOpen: () => void; onToggleEdit: () => void; onAppearance: (appearance: Pick<WorkspaceFolder, 'color' | 'icon'>) => void }) {
  const Icon = folderIcons[folder.icon ?? 'folder'];
  const color = folder.color ?? FOLDER_COLOR_PRESETS[0];
  return <article className={`rounded-xl border bg-panvas-bg-elevated p-4 transition-shadow hover:shadow-sm ${active ? 'border-panvas-text-primary/40' : 'border-panvas-border-default'}`}><div className="flex items-start justify-between gap-2"><button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left focus-ring"><span className="flex h-9 w-9 items-center justify-center rounded-lg text-white shadow-sm" style={{ backgroundColor: color }}><Icon size={18} /></span><h3 className="mt-3 truncate text-sm font-medium text-panvas-text-primary">{folder.name}</h3><p className="mt-1 text-2xs text-panvas-text-tertiary">{count} direct items</p></button><button type="button" onClick={onToggleEdit} aria-label={`Customize ${folder.name}`} aria-expanded={editing} className="flex h-7 w-7 items-center justify-center rounded-md text-panvas-text-tertiary hover:bg-panvas-bg-hover hover:text-panvas-text-primary focus-ring"><Palette size={14} /></button></div>{editing && <div className="mt-3 border-t border-panvas-border-subtle pt-3"><div className="flex items-center justify-between gap-2"><div className="flex flex-wrap gap-1">{FOLDER_COLOR_PRESETS.map(item => <button key={item} type="button" aria-label={`Use ${item} for ${folder.name}`} onClick={() => onAppearance({ color: item, icon: folder.icon })} className={`h-5 w-5 rounded-full border-2 ${color === item ? 'border-panvas-text-primary' : 'border-transparent'}`} style={{ backgroundColor: item }} />)}</div><input aria-label={`Custom color for ${folder.name}`} type="color" value={color} onChange={event => onAppearance({ color: event.target.value, icon: folder.icon })} className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0" /></div><div className="mt-2 flex gap-1">{folderIconIds.map(icon => { const Candidate = folderIcons[icon]; return <button key={icon} type="button" onClick={() => onAppearance({ color, icon })} aria-label={`Use ${icon} icon for ${folder.name}`} className={`flex h-7 w-7 items-center justify-center rounded-md ${folder.icon === icon ? 'bg-panvas-bg-active text-panvas-text-primary' : 'text-panvas-text-tertiary hover:bg-panvas-bg-hover'}`}><Candidate size={14} /></button>; })}</div></div>}</article>;
}

function LibraryList({
  files,
  folders,
  selectedId,
  onSelect,
  onTagClick,
  onOpen,
  onContextMenu,
  onToggleFavorite,
  onRestore,
  onPermanentDelete,
  onCustomizeCover,
}: {
  files: LibraryFile[];
  folders: WorkspaceFolder[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onTagClick: (tag: string) => void;
  onOpen?: (file: LibraryFile) => void;
  onContextMenu?: (event: React.MouseEvent, file: LibraryFile) => void;
  onToggleFavorite?: (file: LibraryFile) => void;
  onRestore?: (file: LibraryFile) => void;
  onPermanentDelete?: (file: LibraryFile) => void;
  onCustomizeCover?: (file: LibraryFile) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-panvas-border-default bg-panvas-bg-elevated">
      <div className="min-w-[780px]">
        <div className="grid grid-cols-[minmax(190px,1.5fr)_90px_minmax(110px,1fr)_72px_118px_110px] gap-3 border-b border-panvas-border-subtle px-4 py-3 text-2xs font-semibold uppercase tracking-[0.1em] text-panvas-text-tertiary">
          <span>Title</span>
          <span>Type</span>
          <span>Folder</span>
          <span>Pages</span>
          <span>Modified</span>
          <span>Actions</span>
        </div>
        {files.map(file => (
          <LibraryListRow
            key={`${file.type}-${file.id}`}
            file={file}
            folders={folders}
            selected={selectedId === file.id}
            onSelect={() => onSelect(file.id)}
            onTagClick={onTagClick}
            onOpen={onOpen ? () => onOpen(file) : undefined}
            onContextMenu={onContextMenu ? event => onContextMenu(event, file) : undefined}
            onToggleFavorite={onToggleFavorite ? () => onToggleFavorite(file) : undefined}
            onRestore={onRestore ? () => onRestore(file) : undefined}
            onPermanentDelete={onPermanentDelete ? () => onPermanentDelete(file) : undefined}
            onCustomizeCover={onCustomizeCover ? () => onCustomizeCover(file) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function LibraryListRow({
  file,
  folders,
  selected = false,
  onSelect,
  onTagClick,
  onOpen,
  onContextMenu,
  onToggleFavorite,
  onRestore,
  onPermanentDelete,
  onCustomizeCover,
}: {
  file: LibraryFile;
  folders: WorkspaceFolder[];
  selected?: boolean;
  onSelect?: () => void;
  onTagClick: (tag: string) => void;
  onOpen?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onToggleFavorite?: () => void;
  onRestore?: () => void;
  onPermanentDelete?: () => void;
  onCustomizeCover?: () => void;
}) {
  const Icon = file.type === 'notebook' ? BookOpen : file.type === 'canvas' ? Grid2X2 : Folder;
  const folder = folders.find(item => item.id === file.folderId);
  const isTrash = Boolean(onRestore || onPermanentDelete);

  return (
    <div
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      className={`grid min-w-[780px] grid-cols-[minmax(190px,1.5fr)_90px_minmax(110px,1fr)_72px_118px_110px] items-center gap-3 border-b border-panvas-border-subtle px-4 py-3 last:border-b-0 hover:bg-panvas-bg-hover/60 ${
        selected ? 'bg-panvas-bg-active/40' : ''
      }`}
    >
      <div className="min-w-0 flex items-center gap-2">
        {!isTrash && onToggleFavorite && (
          <button
            type="button"
            onClick={event => {
              event.stopPropagation();
              onToggleFavorite();
            }}
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors ${
              file.isFavorite
                ? 'text-panvas-accent-amber'
                : 'text-panvas-text-tertiary hover:text-panvas-text-primary'
            }`}
            title={file.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            aria-label={file.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <Star size={13} className={file.isFavorite ? 'fill-panvas-accent-amber text-panvas-accent-amber' : ''} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-panvas-text-primary">
            <Icon size={15} className="flex-shrink-0 text-panvas-text-secondary" />
            <span className="truncate">{file.title}</span>
          </div>
          <div className="mt-1 flex gap-1 overflow-hidden">
            {file.tags.slice(0, 2).map(item => (
              <button
                key={item}
                type="button"
                onClick={event => {
                  event.stopPropagation();
                  onTagClick(item);
                }}
                className="truncate rounded bg-panvas-bg-secondary px-1.5 py-0.5 text-2xs text-panvas-text-secondary hover:bg-panvas-bg-active focus-ring"
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      </div>

      <span className="text-xs text-panvas-text-secondary">{displayType(file.type)}</span>
      <span className="truncate text-xs text-panvas-text-secondary">{folder?.name ?? '—'}</span>
      <span className="truncate text-xs text-panvas-text-secondary" title={isTrash && file.originPath ? file.originPath : (folder?.name ?? '')}>
        {isTrash && file.originPath ? file.originPath : (folder?.name ?? '—')}
      </span>
      <span className="text-xs text-panvas-text-secondary">{file.pageCount ?? '—'}</span>
      <span className="truncate text-xs text-panvas-text-secondary" title={isTrash ? file.size : file.modified}>
        {isTrash ? file.size : file.modified}
      </span>

      <div className="flex items-center gap-1.5 justify-self-start">
        {isTrash ? (
          <div className="flex items-center gap-1.5">
            {onRestore && <button
              type="button"
              onClick={event => {
                event.stopPropagation();
                onRestore();
              }}
              className="flex items-center gap-1 rounded-md bg-panvas-bg-secondary px-2 py-1 text-xs font-medium text-panvas-text-primary hover:bg-panvas-bg-active focus-ring"
            >
              <RotateCcw size={12} />
              Restore
            </button>}
            {onPermanentDelete && <button
              type="button"
              onClick={event => {
                event.stopPropagation();
                onPermanentDelete();
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-panvas-bg-secondary text-panvas-text-tertiary hover:bg-panvas-accent-rose/15 hover:text-panvas-accent-rose focus-ring"
              title="Delete permanently"
              aria-label={`Delete ${file.title} permanently`}
            >
              <Trash2 size={12} />
            </button>}
          </div>
        ) : onOpen ? (
          <button
            type="button"
            onClick={event => {
              event.stopPropagation();
              onOpen();
            }}
            className="rounded-md bg-panvas-bg-secondary px-2 py-1 text-xs text-panvas-text-primary hover:bg-panvas-bg-active focus-ring"
          >
            Open
          </button>
        ) : (
          <span className="text-xs text-panvas-text-tertiary">In trash</span>
        )}
      </div>
    </div>
  );
}

function LibraryNavigator({
  view,
  onSelectView,
  folders,
  folderId,
  onSelectFolder,
}: {
  view: LibraryView;
  onSelectView: (view: LibraryView) => void;
  folders: WorkspaceFolder[];
  folderId: string | null;
  onSelectFolder: (id: string | null) => void;
}) {
  const views: Array<{ id: LibraryView; label: string; icon: typeof Clock3 }> = [
    { id: 'recent', label: 'Recent', icon: Clock3 },
    { id: 'favorites', label: 'Favorites', icon: Star },
    { id: 'library', label: 'Library', icon: FolderOpen },
    { id: 'trash', label: 'Trash', icon: Trash2 },
    { id: 'cloud', label: 'Cloud Sync', icon: Cloud },
  ];

  return (
    <aside className="hidden w-52 flex-shrink-0 border-r border-panvas-border-subtle pr-5 lg:block" aria-label="Library navigation">
      <div className="mb-3 text-2xs font-semibold uppercase tracking-[0.12em] text-panvas-text-tertiary">
        Browse
      </div>
      <nav className="space-y-0.5" aria-label="Library views">
        {views.map(item => {
          const isActive = view === item.id && folderId === null;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectView(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors cursor-pointer ${
                isActive
                  ? 'bg-panvas-bg-active font-medium text-panvas-text-primary'
                  : 'text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary'
              }`}
            >
              <item.icon size={14} className={isActive ? 'text-panvas-text-primary' : 'text-panvas-text-tertiary'} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mb-3 mt-8 text-2xs font-semibold uppercase tracking-[0.12em] text-panvas-text-tertiary">
        Folders
      </div>
      <nav className="space-y-0.5" aria-label="Library folders">
        {folders.map(folder => {
          const Icon = folderIcons[folder.icon ?? 'folder'];
          const isFolderActive = view === 'library' && folderId === folder.id;
          return (
            <button
              key={folder.id}
              type="button"
              onClick={() => onSelectFolder(folder.id)}
              aria-current={isFolderActive ? 'page' : undefined}
              className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors cursor-pointer ${
                isFolderActive
                  ? 'bg-panvas-bg-active font-medium text-panvas-text-primary'
                  : 'text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary'
              }`}
            >
              <span
                className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: folder.color ?? FOLDER_COLOR_PRESETS[0] }}
                aria-hidden="true"
              />
              <Icon size={13} className="flex-shrink-0" />
              <span className="truncate">{folder.name}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function LibrarySection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mt-9"><h2 className="mb-4 text-base font-semibold text-panvas-text-primary">{title}</h2>{children}</section>;
}

function NotebookCoverDialog({ notebook, onClose }: { notebook: Notebook; onClose: () => void }) {
  const updateNotebookCover = useWorkspaceStore(state => state.updateNotebookCover);
  const { showToast } = useUIStore();
  const [cover, setCover] = useState<NotebookCover>(notebook.cover ?? { ...DEFAULT_NOTEBOOK_COVER });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await updateNotebookCover(notebook.id, cover);
      showToast('Notebook cover updated.', 'success');
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not update notebook cover.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return <div className="panvas-layer-modal fixed inset-0 flex items-center justify-center p-4" role="presentation">
    <button type="button" className="panvas-dialog-backdrop absolute inset-0" onClick={onClose} aria-label="Close cover editor" />
    <section role="dialog" aria-modal="true" aria-labelledby="notebook-cover-dialog-title" className="panvas-dialog relative w-full max-w-lg p-5">
      <div className="mb-4 flex items-center justify-between"><div><h2 id="notebook-cover-dialog-title" className="text-sm font-semibold text-panvas-text-primary">Customize cover</h2><p className="mt-1 truncate text-xs text-panvas-text-tertiary">{notebook.name}</p></div><button type="button" onClick={onClose} className="panvas-icon-control focus-ring" aria-label="Close cover editor" title="Close cover editor"><X size={15} /></button></div>
      <NotebookCoverPicker value={cover} onChange={setCover} title={notebook.name} />
      <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} className="panvas-control h-8 px-3 text-xs focus-ring">Cancel</button><button type="button" onClick={() => void save()} disabled={saving} className="panvas-action-button panvas-action-button--primary h-8 px-3 text-xs disabled:opacity-50 focus-ring">{saving ? 'Saving…' : 'Save cover'}</button></div>
    </section>
  </div>;
}
