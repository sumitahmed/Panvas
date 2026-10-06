// ============================================
// Panvas — App Shell (Main Layout)
// ============================================

import React, { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { applyFullDarkViewClass } from '@/lib/theme';
import { useLocation } from 'wouter';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { StatusBar } from './StatusBar';
import { useUIStore } from '@/stores/uiStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport';
import { useMobileVisualViewport } from '@/hooks/useMobileVisualViewport';
import { useHasTouchInput } from '@/hooks/useHasTouchInput';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { isSidebarOpen, sidebarWidth, isFullDarkViewChoiceOpen, setFullDarkView } = useUIStore();
  const { notebookModeLevel, isNotebookPaneVisible, workspaceViewMode } = useLayoutStore();
  const activePageId = useWorkspaceStore(state => state.activePageId);
  const activeCanvasId = useWorkspaceStore(state => state.activeCanvasId);
  const isMobileViewport = useIsMobileViewport();
  const hasTouchInput = useHasTouchInput();
  const useLibraryDrawer = useIsMobileViewport(819);
  useMobileVisualViewport(hasTouchInput || isMobileViewport);
  const [location] = useLocation();
  const hideAppChrome = notebookModeLevel > 0 || workspaceViewMode === 'present';
  useEffect(() => {
    const printing = (active: boolean) => {
      document.documentElement.classList[active ? 'add' : 'remove']('panvas-printing');
      flushSync(() => useUIStore.setState({ isPrinting: active }));
      const state = useUIStore.getState();
      applyFullDarkViewClass(state.theme, state.fullDarkView && !active);
    };
    const before = () => printing(true), after = () => printing(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); };
  }, []);

  // On phones the library sidebar is an overlay rather than a flex column.
  // Picking a destination (route navigation or opening a document) dismisses
  // it, Escape closes it, and the scrim tap closes it. Desktop and tablet
  // keep the inline sidebar untouched.
  const lastDismissSignalRef = useRef(`${location}|${activePageId ?? ''}|${activeCanvasId ?? ''}`);
  const enteredMobileViewportRef = useRef(false);

  // A persistent desktop sidebar should not obscure a newly opened phone
  // workspace. This runs only when crossing into the phone breakpoint, never
  // when the person intentionally opens the drawer from the top bar.
  useEffect(() => {
    if (!useLibraryDrawer) {
      enteredMobileViewportRef.current = false;
      return;
    }
    if (enteredMobileViewportRef.current) return;
    enteredMobileViewportRef.current = true;
    const { isSidebarOpen: open, toggleSidebar } = useUIStore.getState();
    if (open) toggleSidebar();
  }, [useLibraryDrawer]);

  useEffect(() => {
    const signal = `${location}|${activePageId ?? ''}|${activeCanvasId ?? ''}`;
    if (lastDismissSignalRef.current === signal) return;
    lastDismissSignalRef.current = signal;
    if (!useLibraryDrawer) return;
    const { isSidebarOpen: open, toggleSidebar } = useUIStore.getState();
    if (open) toggleSidebar();
  }, [location, activePageId, activeCanvasId, useLibraryDrawer]);

  useEffect(() => {
    if (!useLibraryDrawer || !isSidebarOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const { isSidebarOpen: open, toggleSidebar } = useUIStore.getState();
      if (open) toggleSidebar();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [useLibraryDrawer, isSidebarOpen]);

  return (
    <div data-touch-input={hasTouchInput} className="panvas-app-shell h-screen w-full min-w-0 flex flex-col overflow-hidden bg-panvas-bg-primary">
      <ConfirmDialog open={isFullDarkViewChoiceOpen} title="Enable Full Dark View?" description="Darken notebook pages and PDFs too for easier low-light reading. Your original files, page colors and ink are not changed." confirmLabel="Full Dark View" cancelLabel="Standard Dark" tone="neutral" onConfirm={() => setFullDarkView(true)} onCancel={() => setFullDarkView(false)} />
      {/* Top Bar */}
      <div className={hideAppChrome ? 'hidden' : ''}>
        <TopBar />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Mobile scrim: phones only; desktop/tablet never render it visible. */}
        {isSidebarOpen && !hideAppChrome && (
          <button
            type="button"
            onClick={() => useUIStore.getState().toggleSidebar()}
            aria-label="Close library sidebar"
            className="fixed inset-0 z-30 bg-black/20 hidden max-[819px]:block"
          />
        )}
        {/* Main Sidebar. On phones it overlays the full-width content row
            instead of squeezing it, so document layout never changes. */}
        <div className={(hideAppChrome || !isSidebarOpen) ? 'hidden' : 'h-full flex-shrink-0 overflow-hidden max-[1023px]:max-w-[14rem] max-[599px]:absolute max-[819px]:absolute max-[819px]:inset-y-0 max-[819px]:left-0 max-[819px]:z-40 max-[819px]:h-full max-[819px]:shadow-2xl'} style={{ width: sidebarWidth }}>
          <Sidebar />
        </div>

        {/* Canvas Area */}
        <div className="flex-1 min-w-0 min-h-0 relative overflow-hidden">
          {children}
        </div>
      </div>

      {/* Status Bar */}
      <div className={hideAppChrome ? 'hidden' : 'max-[599px]:hidden'}>
        <StatusBar />
      </div>
    </div>
  );
}
