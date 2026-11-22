// ============================================
// Panvas — Context Menu
// ============================================

import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  BookOpen,
  Pencil,
  Trash2,
  Star,
  StarOff,
  Copy,
  FolderPlus,
  Plus,
  MoveRight,
  FileText,
  Download,
  Printer,
} from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';

export function ContextMenu() {
  const { contextMenu, closeContextMenu, setRenamingId, openCreateDialog } = useUIStore();
  const {
    deleteWorkspace,
    deleteFolder,
    deleteCanvas,
    deleteNotebook,
    deleteNotebookSection,
    deleteNotebookPage,
    togglePinWorkspace,
    togglePinCanvas,
    togglePinNotebook,
    setActiveWorkspace,
    duplicateCanvas,
    workspaces,
    canvasFiles,
    notebooks,
  } = useWorkspaceStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };
    if (contextMenu.isOpen) {
      document.addEventListener('mousedown', handleClick);
    }
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu.isOpen, closeContextMenu]);

  useEffect(() => {
    if (!contextMenu.isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [contextMenu.isOpen, closeContextMenu]);

  if (!contextMenu.isOpen || !contextMenu.targetId || !contextMenu.targetType) {
    return null;
  }

  const { x, y, targetId, targetType, exportTarget } = contextMenu;

  const menuItems: { label: string; icon: React.ReactNode; action: () => void; danger?: boolean }[] = [];

  if (
    targetType === 'workspace' ||
    targetType === 'folder' ||
    targetType === 'canvas' ||
    targetType === 'notebook' ||
    targetType === 'section' ||
    targetType === 'page'
  ) {
    menuItems.push({
      label: 'Rename',
      icon: <Pencil size={13} />,
      action: () => { setRenamingId(targetId); closeContextMenu(); },
    });
  }

  // Favorite / Pin (supported items: workspace, canvas, notebook)
  if (targetType === 'workspace' || targetType === 'canvas' || targetType === 'notebook') {
    const isPinned = targetType === 'workspace'
      ? workspaces.find(w => w.id === targetId)?.isPinned
      : targetType === 'canvas'
      ? canvasFiles.find(c => c.id === targetId)?.isPinned
      : notebooks.find(n => n.id === targetId)?.isPinned;

    menuItems.push({
      label: isPinned ? 'Unfavorite' : 'Favorite',
      icon: isPinned ? <StarOff size={13} /> : <Star size={13} />,
      action: () => {
        if (targetType === 'workspace') void togglePinWorkspace(targetId);
        else if (targetType === 'canvas') void togglePinCanvas(targetId);
        else if (targetType === 'notebook') void togglePinNotebook(targetId);
        closeContextMenu();
      },
    });
  }

  if (targetType === 'workspace' || targetType === 'canvas') {
    menuItems.push({
      label: 'New Notebook',
      icon: <BookOpen size={13} />,
      action: () => { setActiveWorkspace(targetId); openCreateDialog('notebook'); closeContextMenu(); },
    });
  }

  // Add sub-items (for folders and workspaces)
  if (targetType === 'workspace') {
    menuItems.push({
      label: 'New Canvas',
      icon: <Plus size={13} />,
      action: () => {
        setActiveWorkspace(targetId);
        openCreateDialog('canvas');
        closeContextMenu();
      },
    });
    menuItems.push({
      label: 'New Folder',
      icon: <FolderPlus size={13} />,
      action: () => {
        setActiveWorkspace(targetId);
        openCreateDialog('folder');
        closeContextMenu();
      },
    });
    menuItems.push({
      label: 'New Notebook Here',
      icon: <BookOpen size={13} />,
      action: () => { openCreateDialog('notebook', targetId); closeContextMenu(); },
    });
  }

  if (targetType === 'notebook') {
    menuItems.push({
      label: 'New Canvas',
      icon: <Plus size={13} />,
      action: () => { openCreateDialog('canvas', targetId, 'notebook'); closeContextMenu(); },
    });
    menuItems.push({
      label: 'New Section',
      icon: <FolderPlus size={13} />,
      action: () => { openCreateDialog('section', targetId); closeContextMenu(); },
    });
    menuItems.push({
      label: 'Export Notebook to PDF',
      icon: <Download size={13} />,
      action: () => {
        closeContextMenu();
        void import('@/services/pdf/notebookExportCommands')
          .then(({ exportNotebookToPdf }) => exportNotebookToPdf(exportTarget?.type === 'notebook' ? exportTarget : targetId))
          .catch(err => console.error('[ContextMenu] Failed to load PDF export:', err));
      },
    });
    menuItems.push({
      label: 'Print Notebook',
      icon: <Printer size={13} />,
      action: () => {
        closeContextMenu();
        void import('@/services/pdf/notebookExportCommands')
          .then(({ printNotebook }) => printNotebook(exportTarget?.type === 'notebook' ? exportTarget : targetId))
          .catch(err => console.error('[ContextMenu] Failed to load PDF print:', err));
      },
    });
  }

  if (targetType === 'page') {
    menuItems.push({
      label: 'Export Page to PDF',
      icon: <Download size={13} />,
      action: () => {
        closeContextMenu();
        void import('@/services/pdf/notebookExportCommands')
          .then(({ exportPageToPdf }) => exportPageToPdf(exportTarget?.type === 'page' ? exportTarget : targetId))
          .catch(err => console.error('[ContextMenu] Failed to load PDF export:', err));
      },
    });
    menuItems.push({
      label: 'Print Page',
      icon: <Printer size={13} />,
      action: () => {
        closeContextMenu();
        void import('@/services/pdf/notebookExportCommands')
          .then(({ printPage }) => printPage(exportTarget?.type === 'page' ? exportTarget : targetId))
          .catch(err => console.error('[ContextMenu] Failed to load PDF print:', err));
      },
    });
  }

  if (targetType === 'section') {
    menuItems.push({
      label: 'New Canvas',
      icon: <Plus size={13} />,
      action: () => { openCreateDialog('canvas', targetId, 'section'); closeContextMenu(); },
    });
    menuItems.push({
      label: 'New Page',
      icon: <Plus size={13} />,
      action: () => { openCreateDialog('page', targetId); closeContextMenu(); },
    });
    menuItems.push({
      label: 'Import PDF',
      icon: <FileText size={13} />,
      action: () => {
        // We trigger the hidden file input in NotebookSidebar by dispatching a custom event
        window.dispatchEvent(new CustomEvent('panvas:import-pdf', { detail: { sectionId: targetId } }));
        closeContextMenu();
      },
    });
    menuItems.push({
      label: 'Export Section to PDF',
      icon: <Download size={13} />,
      action: () => {
        closeContextMenu();
        void import('@/services/pdf/notebookExportCommands')
          .then(({ exportSectionToPdf }) => exportSectionToPdf(exportTarget?.type === 'section' ? exportTarget : targetId))
          .catch(err => console.error('[ContextMenu] Failed to load PDF export:', err));
      },
    });
    menuItems.push({
      label: 'Print Section',
      icon: <Printer size={13} />,
      action: () => {
        closeContextMenu();
        void import('@/services/pdf/notebookExportCommands')
          .then(({ printSection }) => printSection(exportTarget?.type === 'section' ? exportTarget : targetId))
          .catch(err => console.error('[ContextMenu] Failed to load PDF print:', err));
      },
    });
  }

  if (targetType === 'folder') {
    menuItems.push({
      label: 'New Canvas Here',
      icon: <Plus size={13} />,
      action: () => { openCreateDialog('canvas', targetId, 'folder'); closeContextMenu(); },
    });
    menuItems.push({
      label: 'New Subfolder',
      icon: <FolderPlus size={13} />,
      action: () => { openCreateDialog('folder', targetId); closeContextMenu(); },
    });
  }

  if (targetType === 'canvas') {
    menuItems.push({
      label: 'Duplicate Canvas',
      icon: <Copy size={13} />,
      action: () => { duplicateCanvas(targetId); closeContextMenu(); },
    });
  }

  // Delete
  if (
    targetType === 'workspace' ||
    targetType === 'folder' ||
    targetType === 'canvas' ||
    targetType === 'notebook' ||
    targetType === 'section' ||
    targetType === 'page'
  ) {
    menuItems.push({
      label: 'Delete',
      icon: <Trash2 size={13} />,
      danger: true,
      action: () => {
        if (targetType === 'workspace') deleteWorkspace(targetId);
        else if (targetType === 'folder') deleteFolder(targetId);
        else if (targetType === 'canvas') deleteCanvas(targetId);
        else if (targetType === 'notebook') deleteNotebook(targetId);
        else if (targetType === 'section') deleteNotebookSection(targetId);
        else if (targetType === 'page') deleteNotebookPage(targetId);
        closeContextMenu();
      },
    });
  }

  return (
    <motion.div
      ref={ref}
      role="menu"
      aria-label="Item actions"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.1 }}
        className="panvas-overlay panvas-menu fixed w-52 p-1.5"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - 216)),
        top: Math.max(8, Math.min(y, window.innerHeight - menuItems.length * 36 - 16)),
      }}
    >
      {menuItems.map((item, i) => (
        <button
          key={i}
          onClick={item.action}
          role="menuitem"
          className={`panvas-menu-item ${item.danger
                       ? 'text-panvas-accent-rose hover:bg-panvas-accent-rose/10'
                       : ''
                     }`}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </motion.div>
  );
}
