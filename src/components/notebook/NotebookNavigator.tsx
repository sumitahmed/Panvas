import React, { useState, useRef, useEffect } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useUIStore } from '@/stores/uiStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { OverlayManager } from '@/components/ui/OverlayManager';
import {
  ChevronRight,
  ChevronDown,
  Book,
  FolderOpen,
  FileText,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  Check,
  X,
} from 'lucide-react';
import type { Notebook, NotebookSection, NotebookPage } from '@/types/notebook';

interface DropdownItem {
  id: string;
  name: string;
}

interface DropdownProps {
  icon: React.ReactNode;
  label: string;
  items: DropdownItem[];
  onSelect: (id: string) => void;
  activeId?: string;
  type: 'section' | 'page';
  headerAction?: {
    label: string;
    onClick: () => void;
  };
  onRename?: (id: string, newName: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onMoveUp?: (id: string) => Promise<void>;
  onMoveDown?: (id: string) => Promise<void>;
}

function NavigatorItemRow({
  item,
  index,
  totalItems,
  isActive,
  type,
  isEditing,
  onSelect,
  onStartRename,
  onSaveRename,
  onCancelRename,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  item: DropdownItem;
  index: number;
  totalItems: number;
  isActive: boolean;
  type: 'section' | 'page';
  isEditing: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onSaveRename: (newName: string) => void;
  onCancelRename: () => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const [draft, setDraft] = useState(item.name);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setDraft(item.name);
      const timer = setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isEditing, item.name]);

  const handleCommit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== item.name) {
      onSaveRename(trimmed);
    } else {
      onCancelRename();
    }
  };

  if (isEditing) {
    return (
      <div 
        className="flex items-center gap-1 px-1.5 py-1 rounded-md bg-panvas-bg-secondary border border-panvas-accent-blue/50"
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleCommit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={handleCommit}
          className="min-w-0 flex-1 bg-transparent text-xs text-panvas-text-primary outline-none"
          aria-label={`Rename ${item.name}`}
        />
        <button
          type="button"
          onMouseDown={e => { e.preventDefault(); handleCommit(); }}
          className="text-panvas-accent-emerald hover:text-panvas-accent-emerald/80 p-0.5 rounded focus-ring"
          title="Save"
          aria-label="Save"
        >
          <Check size={12} />
        </button>
        <button
          type="button"
          onMouseDown={e => { e.preventDefault(); onCancelRename(); }}
          className="text-panvas-text-tertiary hover:text-panvas-text-primary p-0.5 rounded focus-ring"
          title="Cancel"
          aria-label="Cancel"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`group relative flex items-center justify-between rounded-md text-xs transition-colors ${
        isActive 
          ? 'bg-panvas-accent-blue/10 text-panvas-accent-blue font-medium' 
          : 'text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary'
      }`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsMenuOpen(true);
      }}
    >
      <button
        type="button"
        className="min-w-0 flex-1 flex items-center px-2 py-1.5 text-left truncate focus-ring"
        onClick={onSelect}
        title={item.name}
      >
        {type === 'page' && (
          <span className="opacity-50 font-mono w-4 shrink-0 text-left text-[10px]">
            {index + 1}.
          </span>
        )}
        <span className="truncate">{item.name}</span>
      </button>

      <div className="relative shrink-0 pr-1">
          <button
            ref={actionButtonRef}
            type="button"
            aria-label={`Actions for ${item.name}`}
            className={`p-1 rounded text-panvas-text-tertiary hover:text-panvas-text-primary hover:bg-panvas-bg-hover focus-ring transition-opacity ${
              isMenuOpen ? 'opacity-100 bg-panvas-bg-hover text-panvas-text-primary' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              setIsMenuOpen(open => !open);
            }}
          >
            <MoreHorizontal size={13} />
          </button>

          <OverlayManager
            isOpen={isMenuOpen}
            onClose={() => setIsMenuOpen(false)}
            anchorRef={actionButtonRef}
            placement="bottom-end"
          >
            <div className="w-36 bg-panvas-bg-elevated border border-panvas-border-subtle rounded-lg shadow-xl p-1 z-50 animate-in fade-in zoom-in-95 text-xs text-panvas-text-primary select-none">
              <button
                type="button"
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-panvas-bg-hover text-left transition-colors focus-ring"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMenuOpen(false);
                  onStartRename();
                }}
              >
                <Pencil size={12} className="text-panvas-text-tertiary" />
                <span>Rename</span>
              </button>

              {onMoveUp && index > 0 && (
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-panvas-bg-hover text-left transition-colors focus-ring"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen(false);
                    onMoveUp();
                  }}
                >
                  <ArrowUp size={12} className="text-panvas-text-tertiary" />
                  <span>Move Up</span>
                </button>
              )}

              {onMoveDown && index < totalItems - 1 && (
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-panvas-bg-hover text-left transition-colors focus-ring"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMenuOpen(false);
                    onMoveDown();
                  }}
                >
                  <ArrowDown size={12} className="text-panvas-text-tertiary" />
                  <span>Move Down</span>
                </button>
              )}

              {onDelete && (
                <>
                  <div className="my-1 h-px bg-panvas-border-subtle" />
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-panvas-accent-rose/10 text-panvas-accent-rose text-left transition-colors focus-ring"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsMenuOpen(false);
                      onDelete();
                    }}
                  >
                    <Trash2 size={12} />
                    <span>Delete</span>
                  </button>
                </>
              )}
            </div>
          </OverlayManager>
        </div>
      </div>
  );
}

function NavigatorDropdown({
  icon,
  label,
  items,
  onSelect,
  activeId,
  type,
  headerAction,
  onRename,
  onDelete,
  onMoveUp,
  onMoveDown,
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { renamingId, setRenamingId } = useUIStore();
  const [editingId, setEditingId] = useState<string | null>(null);

  const currentEditingId = editingId || renamingId;

  return (
    <>
      <button 
        ref={buttonRef}
        className={`flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md transition-colors max-w-[150px] ${
          isOpen || activeId ? 'bg-panvas-bg-hover text-panvas-text-primary' : 'text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary'
        }`}
        onClick={() => setIsOpen(!isOpen)}
        onContextMenu={(e) => {
          e.preventDefault();
          setIsOpen(true);
        }}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        {icon}
        <span className="truncate font-medium">{label}</span>
        <ChevronDown size={14} className={`text-panvas-text-tertiary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      <OverlayManager 
        isOpen={isOpen} 
        onClose={() => {
          setIsOpen(false);
          setEditingId(null);
          setRenamingId(null);
        }} 
        anchorRef={buttonRef}
        placement="bottom-start"
      >
        <div className="w-52 sm:w-56 bg-panvas-bg-elevated border border-panvas-border-subtle rounded-xl shadow-2xl animate-in fade-in zoom-in-95 overflow-hidden">
          {headerAction && (
            <div className="p-1 border-b border-panvas-border-subtle bg-panvas-bg-secondary/40">
              <button
                type="button"
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md font-medium text-panvas-accent-blue hover:bg-panvas-accent-blue/10 transition-colors focus-ring"
                onClick={() => {
                  setIsOpen(false);
                  headerAction.onClick();
                }}
              >
                <Plus size={13} />
                <span>{headerAction.label}</span>
              </button>
            </div>
          )}

          <div className="max-h-64 overflow-y-auto p-1 space-y-0.5">
            {items.length === 0 ? (
              <div className="px-2 py-3 text-xs text-panvas-text-tertiary text-center">
                {type === 'page' ? 'No pages yet' : 'No sections yet'}
              </div>
            ) : (
              items.map((item, idx) => (
                <NavigatorItemRow
                  key={item.id}
                  item={item}
                  index={idx}
                  totalItems={items.length}
                  isActive={item.id === activeId}
                  type={type}
                  isEditing={currentEditingId === item.id}
                  onSelect={() => {
                    onSelect(item.id);
                    setIsOpen(false);
                  }}
                  onStartRename={() => {
                    setEditingId(item.id);
                    setRenamingId(item.id);
                  }}
                  onSaveRename={(newName) => {
                    setEditingId(null);
                    setRenamingId(null);
                    if (onRename) void onRename(item.id, newName);
                  }}
                  onCancelRename={() => {
                    setEditingId(null);
                    setRenamingId(null);
                  }}
                  onDelete={onDelete ? () => void onDelete(item.id) : undefined}
                  onMoveUp={onMoveUp ? () => void onMoveUp(item.id) : undefined}
                  onMoveDown={onMoveDown ? () => void onMoveDown(item.id) : undefined}
                />
              ))
            )}
          </div>
        </div>
      </OverlayManager>
    </>
  );
}

// ─── NOTEBOOK MANAGER OVERLAY ─────────────────────────────────────────────

function NotebookManagerOverlay({ 
  notebooks, 
  sections, 
  pages, 
  activeNotebookId,
  activeSectionId,
  activePageId,
  onSelectNotebook,
  onSelectSection,
  onSelectPage,
  onRenameSection,
  onDeleteSection,
  onRenamePage,
  onDeletePage,
  onClose
}: { 
  notebooks: Notebook[];
  sections: NotebookSection[];
  pages: NotebookPage[];
  activeNotebookId: string;
  activeSectionId?: string;
  activePageId: string;
  onSelectNotebook: (id: string) => void;
  onSelectSection: (id: string) => void;
  onSelectPage: (id: string) => void;
  onRenameSection?: (id: string, name: string) => Promise<void>;
  onDeleteSection?: (id: string) => Promise<void>;
  onRenamePage?: (id: string, title: string) => Promise<void>;
  onDeletePage?: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const { openCreateDialog, renamingId, setRenamingId } = useUIStore();
  
  const [selectedNotebookId, setSelectedNotebookId] = useState<string>(activeNotebookId);
  const [selectedSectionId, setSelectedSectionId] = useState<string | undefined>(activeSectionId);
  const [editingId, setEditingId] = useState<string | null>(null);

  const selectedNotebook = notebooks.find(n => n.id === selectedNotebookId);
  const selectedSection = sections.find(s => s.id === selectedSectionId);

  const currentSections = sections.filter(s => s.notebookId === selectedNotebookId && !s.deletedAt);
  const currentPages = pages.filter(p => p.sectionId === selectedSectionId && !p.deletedAt);
  const currentEditingId = editingId || renamingId;

  const handleSelectNotebook = (id: string) => {
    setSelectedNotebookId(id);
    const firstSection = sections.find(s => s.notebookId === id && !s.deletedAt);
    setSelectedSectionId(firstSection?.id);
  };

  return (
    <div className="panvas-overlay flex max-h-[60vh] flex-row overflow-hidden rounded-xl border border-panvas-border-default bg-panvas-bg-elevated text-panvas-text-primary shadow-2xl max-[599px]:w-[min(24rem,calc(100vw-1.5rem))] max-[599px]:flex-col max-[599px]:overflow-y-auto">

      {/* COLUMN 1: Notebooks */}
      <div className="w-[220px] flex flex-col border-r border-panvas-border-subtle bg-panvas-bg-elevated flex-shrink-0 overflow-y-auto max-[599px]:w-full max-[599px]:border-r-0 max-[599px]:border-b">
        <div className="px-3 py-2 flex items-center justify-between border-b border-panvas-border-subtle sticky top-0 bg-panvas-bg-elevated z-10">
          <span className="text-[11px] font-semibold tracking-wider uppercase text-panvas-text-tertiary">Notebooks</span>
        </div>
        <div className="py-1">
          <button 
            type="button"
            onClick={() => openCreateDialog('notebook')}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-panvas-bg-hover transition-colors mb-1 text-panvas-text-tertiary hover:text-panvas-text-primary"
          >
            <Plus size={14} /> New Notebook
          </button>
          
          {notebooks.map(notebook => (
            <div 
              key={notebook.id}
              onClick={() => handleSelectNotebook(notebook.id)}
              className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs transition-colors ${notebook.id === selectedNotebookId ? 'bg-panvas-bg-active text-panvas-text-primary' : 'hover:bg-panvas-bg-hover text-panvas-text-secondary'}`}
            >
              <Book size={14} className={notebook.id === activeNotebookId ? 'text-panvas-accent-rose' : 'text-panvas-text-tertiary'} />
              <span className={`truncate flex-1 ${notebook.id === activeNotebookId ? 'font-medium text-panvas-text-primary' : 'text-panvas-text-secondary'}`}>
                {notebook.name}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* COLUMN 2: Sections */}
      <div className="w-[220px] flex flex-col border-r border-panvas-border-subtle bg-panvas-bg-secondary/60 flex-shrink-0 overflow-y-auto max-[599px]:w-full max-[599px]:border-r-0 max-[599px]:border-b">
        <div className="px-3 py-2 flex items-center justify-between border-b border-panvas-border-subtle sticky top-0 bg-panvas-bg-secondary z-10">
          <span className="text-[11px] font-semibold tracking-wider uppercase text-panvas-text-tertiary truncate">
            {selectedNotebook?.name ?? 'No Notebook Selected'}
          </span>
        </div>
        <div className="py-1 px-1 space-y-0.5">
          {selectedNotebookId && (
            <button 
              type="button"
              onClick={() => openCreateDialog('section', selectedNotebookId)}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-panvas-bg-hover transition-colors mb-1 text-panvas-text-tertiary hover:text-panvas-text-primary rounded"
            >
              <Plus size={14} /> Add Section
            </button>
          )}

          {currentSections.map((section, index) => (
            <NavigatorItemRow
              key={section.id}
              item={{ id: section.id, name: section.name }}
              index={index}
              totalItems={currentSections.length}
              isActive={section.id === selectedSectionId}
              type="section"
              isEditing={currentEditingId === section.id}
              onSelect={() => setSelectedSectionId(section.id)}
              onStartRename={() => {
                setEditingId(section.id);
                setRenamingId(section.id);
              }}
              onSaveRename={(newName) => {
                setEditingId(null);
                setRenamingId(null);
                if (onRenameSection) void onRenameSection(section.id, newName);
              }}
              onCancelRename={() => {
                setEditingId(null);
                setRenamingId(null);
              }}
              onDelete={onDeleteSection ? () => void onDeleteSection(section.id) : undefined}
            />
          ))}
        </div>
      </div>

      {/* COLUMN 3: Pages */}
      <div className="w-[240px] flex flex-col bg-panvas-bg-elevated flex-shrink-0 pb-1 overflow-y-auto max-[599px]:w-full">
        <div className="px-3 py-2 flex items-center justify-between border-b border-panvas-border-subtle sticky top-0 bg-panvas-bg-elevated z-10 mb-1">
          <span className="text-[11px] font-semibold tracking-wider uppercase text-panvas-text-tertiary truncate">
            {selectedSection?.name ?? 'No Section Selected'}
          </span>
        </div>
        <div className="py-1 px-1 space-y-0.5">
          {selectedSectionId && (
            <button 
              type="button"
              onClick={() => openCreateDialog('page', selectedSectionId)}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-panvas-bg-hover transition-colors mb-1 text-panvas-text-tertiary hover:text-panvas-text-primary rounded"
            >
              <Plus size={14} /> Add Page
            </button>
          )}

          {currentPages.map((page, index) => (
            <NavigatorItemRow
              key={page.id}
              item={{ id: page.id, name: page.title || 'Untitled Page' }}
              index={index}
              totalItems={currentPages.length}
              isActive={page.id === activePageId}
              type="page"
              isEditing={currentEditingId === page.id}
              onSelect={() => {
                onSelectPage(page.id);
                onClose();
              }}
              onStartRename={() => {
                setEditingId(page.id);
                setRenamingId(page.id);
              }}
              onSaveRename={(newName) => {
                setEditingId(null);
                setRenamingId(null);
                if (onRenamePage) void onRenamePage(page.id, newName);
              }}
              onCancelRename={() => {
                setEditingId(null);
                setRenamingId(null);
              }}
              onDelete={onDeletePage ? () => void onDeletePage(page.id) : undefined}
            />
          ))}
        </div>
      </div>

    </div>
  );
}

// ─── MAIN NOTEBOOK NAVIGATOR ──────────────────────────────────────────────

export function NotebookNavigator() {
  const [isManagerOpen, setIsManagerOpen] = useState(false);
  const managerRef = useRef<HTMLDivElement>(null);

  const { 
    notebooks, notebookSections, notebookPages, 
    activeWorkspaceId, activePageId, 
    setActivePage,
    setActiveNotebookSection,
    renameNotebookPage,
    deleteNotebookPage,
    renameNotebookSection,
    deleteNotebookSection,
    reorderItems,
  } = useWorkspaceStore();
  const { notebookModeLevel, isNotebookPaneVisible } = useLayoutStore();
  const { isSidebarOpen, openCreateDialog, showToast } = useUIStore();

  const activePage = notebookPages.find(p => p.id === activePageId && !p.deletedAt);
  const activeSection = notebookSections.find(s => s.id === activePage?.sectionId && !s.deletedAt);
  const activeNotebook = notebooks.find(n => n.id === activePage?.notebookId && !n.deletedAt);

  if (!activePage || !activeNotebook) return null;

  const currentNotebooks = notebooks.filter(n => n.workspaceId === activeNotebook.workspaceId && !n.deletedAt);
  const currentSections = notebookSections
    .filter(s => s.notebookId === activeNotebook.id && !s.deletedAt)
    .sort((a, b) => a.order - b.order);
  const currentPages = notebookPages
    .filter(p => p.sectionId === activeSection?.id && !p.deletedAt)
    .sort((a, b) => a.order - b.order);

  if (notebookModeLevel === 0 && isSidebarOpen) return null;
  if (notebookModeLevel > 0 && !isNotebookPaneVisible) return null;

  const handleSelectNotebook = (notebookId: string) => {
    if (notebookId === activeNotebook.id) return;
    const firstSection = notebookSections.find(s => s.notebookId === notebookId && !s.deletedAt);
    if (firstSection) {
      void setActiveNotebookSection(firstSection.id);
      const firstPage = notebookPages.find(p => p.sectionId === firstSection.id && !p.deletedAt);
      if (firstPage) setActivePage(firstPage.id);
    }
  };

  const handleSelectSection = (sectionId: string) => {
    if (sectionId === activeSection?.id) return;
    void setActiveNotebookSection(sectionId);
    const firstPage = notebookPages.find(p => p.sectionId === sectionId && !p.deletedAt);
    if (firstPage) setActivePage(firstPage.id);
  };

  const handleSelectPage = (pageId: string) => {
    setActivePage(pageId);
  };

  const handleRenamePage = async (pageId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    const page = notebookPages.find(p => p.id === pageId);
    if (!page || (page.title || 'Untitled Page') === trimmed) return;
    await renameNotebookPage(pageId, trimmed);
    showToast('Page renamed', 'success');
  };

  const handleDeletePage = async (pageId: string) => {
    const page = notebookPages.find(p => p.id === pageId);
    if (!page) return;
    if (activePage?.id === pageId) {
      const remaining = currentPages.filter(p => p.id !== pageId);
      if (remaining.length > 0) {
        const currentIndex = currentPages.findIndex(p => p.id === pageId);
        const nextIndex = Math.min(currentIndex, remaining.length - 1);
        handleSelectPage(remaining[nextIndex].id);
      }
    }
    await deleteNotebookPage(pageId);
    showToast(`Deleted page "${page.title || 'Untitled Page'}"`, 'info');
  };

  const handleMovePage = async (pageId: string, direction: 'up' | 'down') => {
    const index = currentPages.findIndex(p => p.id === pageId);
    if (index === -1) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= currentPages.length) return;
    const reordered = [...currentPages];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);
    await reorderItems('page', reordered.map(p => p.id));
  };

  const handleRenameSection = async (sectionId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const section = notebookSections.find(s => s.id === sectionId);
    if (!section || section.name === trimmed) return;
    await renameNotebookSection(sectionId, trimmed);
    showToast('Section renamed', 'success');
  };

  const handleDeleteSection = async (sectionId: string) => {
    const section = notebookSections.find(s => s.id === sectionId);
    if (!section) return;
    if (activeSection?.id === sectionId) {
      const remaining = currentSections.filter(s => s.id !== sectionId);
      if (remaining.length > 0) {
        const nextSec = remaining[0];
        void setActiveNotebookSection(nextSec.id);
        const firstPage = notebookPages.find(p => p.sectionId === nextSec.id && !p.deletedAt);
        if (firstPage) setActivePage(firstPage.id);
      }
    }
    await deleteNotebookSection(sectionId);
    showToast(`Deleted section "${section.name}"`, 'info');
  };

  const handleMoveSection = async (sectionId: string, direction: 'up' | 'down') => {
    const index = currentSections.findIndex(s => s.id === sectionId);
    if (index === -1) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= currentSections.length) return;
    const reordered = [...currentSections];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);
    await reorderItems('section', reordered.map(s => s.id));
  };

  return (
    <div className="flex items-center gap-1 bg-panvas-bg-primary/80 backdrop-blur-md rounded-lg p-1 border border-panvas-border-subtle shadow-sm select-none shrink-0 min-w-0">
      
      <div ref={managerRef}>
        <button 
          className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary transition-colors max-w-[150px] focus-ring"
          onClick={() => setIsManagerOpen(!isManagerOpen)}
          aria-label={`Notebook: ${activeNotebook.name}`}
        >
          <Book size={14} className="text-panvas-text-tertiary" />
          <span className="truncate font-medium text-panvas-text-primary">{activeNotebook.name}</span>
          <ChevronDown size={14} className={`text-panvas-text-tertiary transition-transform ${isManagerOpen ? 'rotate-180' : ''}`} />
        </button>

        <OverlayManager
          isOpen={isManagerOpen}
          onClose={() => setIsManagerOpen(false)}
          anchorRef={managerRef}
          placement="bottom-start"
        >
          <NotebookManagerOverlay 
            notebooks={currentNotebooks}
            sections={notebookSections}
            pages={notebookPages}
            activeNotebookId={activeNotebook.id}
            activeSectionId={activeSection?.id}
            activePageId={activePage.id}
            onSelectNotebook={handleSelectNotebook}
            onSelectSection={handleSelectSection}
            onSelectPage={handleSelectPage}
            onRenameSection={handleRenameSection}
            onDeleteSection={handleDeleteSection}
            onRenamePage={handleRenamePage}
            onDeletePage={handleDeletePage}
            onClose={() => setIsManagerOpen(false)}
          />
        </OverlayManager>
      </div>

      <ChevronRight size={12} className="text-panvas-text-tertiary flex-shrink-0" />
      
      {activeSection && (
        <>
          <NavigatorDropdown 
            icon={<FolderOpen size={14} className="text-panvas-text-tertiary" />}
            label={activeSection.name}
            items={currentSections.map(s => ({ id: s.id, name: s.name }))}
            onSelect={handleSelectSection}
            activeId={activeSection.id}
            type="section"
            headerAction={{
              label: 'Add Section',
              onClick: () => openCreateDialog('section', activeNotebook.id),
            }}
            onRename={handleRenameSection}
            onDelete={handleDeleteSection}
            onMoveUp={(id) => handleMoveSection(id, 'up')}
            onMoveDown={(id) => handleMoveSection(id, 'down')}
          />
          <ChevronRight size={12} className="text-panvas-text-tertiary flex-shrink-0" />
        </>
      )}
      <NavigatorDropdown 
        icon={<FileText size={14} className="text-panvas-text-tertiary" />}
        label={activePage.title || 'Untitled Page'}
        items={currentPages.map(p => ({ id: p.id, name: p.title || 'Untitled Page' }))}
        onSelect={handleSelectPage}
        activeId={activePage.id}
        type="page"
        headerAction={activeSection ? {
          label: 'Add Page',
          onClick: () => openCreateDialog('page', activeSection.id),
        } : undefined}
        onRename={handleRenamePage}
        onDelete={handleDeletePage}
        onMoveUp={(id) => handleMovePage(id, 'up')}
        onMoveDown={(id) => handleMovePage(id, 'down')}
      />
    </div>
  );
}
