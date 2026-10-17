// ============================================
// Panvas — Keyboard Shortcuts Hook
// ============================================

import { useEffect } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';

export function useKeyboardShortcuts() {
  const {
    toggleCommandPalette,
    toggleSidebar,
    openCreateDialog,
  } = useUIStore();

  const { addBlock, currentData } = useCanvasStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const isCtrl = e.ctrlKey || e.metaKey;

      // Ctrl+K → Command Palette
      if (isCtrl && e.key === 'k') {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }

      // Ctrl+N → New Canvas
      if (isCtrl && !e.shiftKey && e.key === 'n') {
        e.preventDefault();
        openCreateDialog('canvas');
        return;
      }

      // Ctrl+Shift+N → New Folder
      if (isCtrl && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        openCreateDialog('folder');
        return;
      }

      // Ctrl+\ → Toggle Sidebar
      if (isCtrl && e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Ctrl+M → Add Markdown Block
      if (isCtrl && e.key === 'm' && currentData) {
        e.preventDefault();
        addBlock('markdown', 150 + Math.random() * 200, 150 + Math.random() * 200);
        return;
      }

      // Ctrl+E → Add LaTeX Block
      if (isCtrl && e.key === 'e' && currentData) {
        e.preventDefault();
        addBlock('latex', 150 + Math.random() * 200, 150 + Math.random() * 200);
        return;
      }

      // Ctrl+S → Force Save (prevent default browser save dialog)
      if (isCtrl && e.key === 's') {
        e.preventDefault();
        // Auto-save handles this, but we prevent the browser dialog
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleCommandPalette, toggleSidebar, openCreateDialog, addBlock, currentData]);
}
