import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Minus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PenTool,
  Search,
  Square,
  Sun,
  X,
} from 'lucide-react';
import { useLocation } from 'wouter';
import { useUIStore } from '@/stores/uiStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useAuthStore } from '@/stores/authStore';
import { useShallow } from 'zustand/react/shallow';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { SyncIndicator } from '@/components/ui/SyncIndicator';
import { navigateToLibraryView } from '@/services/library/libraryRouteState';
import { PANVAS_LOGO_SRC } from '@/lib/brand';

const noDragStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
const isElectronShell = typeof window !== 'undefined' && Boolean(window.panvas);
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.userAgent || navigator.platform);
const isElectronOnWindows = isElectronShell && !isMac;
const ELECTRON_CAPTION_SAFE_WIDTH = 144;

const TopBarBreadcrumbs = React.memo(function TopBarBreadcrumbs({ navigate }: { navigate: (to: string) => void }) {
  const {
    activeCanvasId, activePageId, activeWorkspaceId,
    canvasFiles, workspaces, folders, notebooks, notebookSections, notebookPages,
  } = useWorkspaceStore(useShallow(state => ({
    activeCanvasId: state.activeCanvasId,
    activePageId: state.activePageId,
    activeWorkspaceId: state.activeWorkspaceId,
    canvasFiles: state.canvasFiles,
    workspaces: state.workspaces,
    folders: state.folders,
    notebooks: state.notebooks,
    notebookSections: state.notebookSections,
    notebookPages: state.notebookPages,
  })));
  const { setActiveCanvas, setActivePage, setActiveNotebook, setActiveNotebookSection } = useWorkspaceStore.getState();

  const activeCanvas = canvasFiles.find(canvas => canvas.id === activeCanvasId);
  let currentWorkspace = workspaces.find(workspace => workspace.id === (activeCanvas?.workspaceId ?? activeWorkspaceId));

  const breadcrumbs: { id: string, name: string, type: string }[] = [];

  if (activePageId) {
    const page = notebookPages.find(p => p.id === activePageId);
    if (page) {
      breadcrumbs.unshift({ id: page.id, name: page.title, type: 'page' });
      const section = notebookSections.find(s => s.id === page.sectionId);
      if (section) {
        breadcrumbs.unshift({ id: section.id, name: section.name, type: 'section' });
        const notebook = notebooks.find(n => n.id === section.notebookId);
        if (notebook) {
          breadcrumbs.unshift({ id: notebook.id, name: notebook.name, type: 'notebook' });
          let currentFolderId = notebook.folderId;
          while (currentFolderId) {
            const folder = folders.find(f => f.id === currentFolderId);
            if (folder) {
              breadcrumbs.unshift({ id: folder.id, name: folder.name, type: 'folder' });
              currentFolderId = folder.parentId;
            } else {
              break;
            }
          }
          if (!currentWorkspace) currentWorkspace = workspaces.find(w => w.id === notebook.workspaceId);
        }
      }
    }
  } else if (activeCanvasId) {
    if (activeCanvas) {
      breadcrumbs.unshift({ id: activeCanvas.id, name: activeCanvas.name, type: 'canvas' });
      let currentFolderId = activeCanvas.folderId;
      while (currentFolderId) {
        const folder = folders.find(f => f.id === currentFolderId);
        if (folder) {
          breadcrumbs.unshift({ id: folder.id, name: folder.name, type: 'folder' });
          currentFolderId = folder.parentId;
        } else {
          break;
        }
      }
    }
  }

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 items-center gap-1.5 text-xs text-panvas-text-secondary hidden md:flex">
      <ChevronRight size={13} className="flex-shrink-0 text-panvas-text-tertiary" />
      <button
        onClick={() => {
          setActiveCanvas(null);
          setActivePage(null);
          setActiveNotebook(null);
          navigateToLibraryView('library');
          navigate('/app/library');
        }}
        className="max-w-20 lg:max-w-28 xl:max-w-36 truncate rounded px-1 py-0.5 hover:text-panvas-text-primary focus-ring"
        style={noDragStyle}
      >
        {currentWorkspace?.name ?? 'Library'}
      </button>
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1;
        return (
          <React.Fragment key={crumb.id}>
            <ChevronRight size={13} className="flex-shrink-0 text-panvas-text-tertiary" />
            <button
              type="button"
              onClick={() => {
                if (crumb.type === 'page') setActivePage(crumb.id);
                else if (crumb.type === 'section') void setActiveNotebookSection(crumb.id);
                else if (crumb.type === 'notebook') void setActiveNotebook(crumb.id);
                else if (crumb.type === 'canvas') setActiveCanvas(crumb.id);
                navigate('/app');
              }}
              className={`max-w-24 lg:max-w-32 xl:max-w-44 truncate rounded px-1 py-0.5 text-left ${isLast ? 'font-medium text-panvas-text-primary cursor-default' : 'hover:text-panvas-text-primary focus-ring'}`}
              style={noDragStyle}
            >
              {crumb.name}
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
});

export function TopBar() {
  const [, navigate] = useLocation();
  const { isSidebarOpen, toggleSidebar, openCommandPalette, theme, setTheme, requestCloudSyncReview } = useUIStore(useShallow(state => ({
    isSidebarOpen: state.isSidebarOpen,
    toggleSidebar: state.toggleSidebar,
    openCommandPalette: state.openCommandPalette,
    theme: state.theme,
    setTheme: state.setTheme,
    requestCloudSyncReview: state.requestCloudSyncReview,
  })));
  const { isAuthenticated, signOut } = useAuthStore(useShallow(state => ({
    isAuthenticated: state.isAuthenticated,
    signOut: state.signOut,
  })));
  const [isAuthMenuOpen, setIsAuthMenuOpen] = useState(false);
  const authMenuRef = useRef<HTMLDivElement>(null);

  // Keep the native overlay symbols contrasting with the active theme; the
  // handler also mirrors the theme into main-process settings.
  useEffect(() => {
    window.panvas?.settings.setTheme(theme).catch(() => {});
  }, [theme]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (authMenuRef.current && !authMenuRef.current.contains(event.target as Node)) {
        setIsAuthMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Public cycle matches Appearance; legacy choices migrate before first paint.
  const THEME_CYCLE = ['light', 'ink', 'dark'] as const;
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'ink' ? PenTool : Sun;

  const nextThemeInCycle = () => {
    const index = THEME_CYCLE.indexOf(theme as typeof THEME_CYCLE[number]);
    return THEME_CYCLE[(index + 1) % THEME_CYCLE.length];
  };

  const cycleTheme = () => {
    setTheme(nextThemeInCycle());
  };

  const handleSignOut = async () => {
    setIsAuthMenuOpen(false);
    await signOut();
    navigate('/');
  };

  const openCloudSync = () => {
    setIsAuthMenuOpen(false);
    requestCloudSyncReview();
    navigateToLibraryView('cloud');
    navigate('/app/library');
  };

  return (
    <header
      className="panvas-topbar panvas-layer-toolbar flex-shrink-0 relative flex items-center justify-between px-3 bg-panvas-bg-primary text-panvas-text-primary border-b border-panvas-border-subtle select-none h-11"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* LEFT ZONE: Sidebar toggle, Logo, Breadcrumbs. Container stays draggable; only leaf controls are no-drag. */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <IconButton
          label={isSidebarOpen ? 'Hide library' : 'Show library'}
          onClick={toggleSidebar}
        >
          {isSidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
        </IconButton>

        <button
          onClick={() => {
            useWorkspaceStore.getState().setActiveCanvas(null);
            navigateToLibraryView('library');
            navigate('/app/library');
          }}
          className="flex items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-panvas-bg-hover focus-ring flex-shrink-0"
          style={noDragStyle}
          aria-label="Open Panvas library"
        >
          <img src={PANVAS_LOGO_SRC} alt="" className="h-6 w-6 rounded-md" />
          <span className="hidden text-sm font-semibold tracking-tight sm:inline">Panvas</span>
        </button>

        <TopBarBreadcrumbs navigate={navigate} />
      </div>

      {/* CENTER ZONE: Search Panvas. Shrinks responsively when unmaximized so generous drag gaps remain on both sides. */}
      <div className="flex items-center justify-center flex-shrink min-w-0 px-3 w-[clamp(180px,28vw,380px)] max-[599px]:w-auto max-[599px]:px-0">
        <button
          onClick={openCommandPalette}
          aria-label="Search Panvas"
          title="Search Panvas (Ctrl K)"
          className="flex h-8 sm:h-9 w-full items-center gap-2 rounded-lg border border-panvas-border-default bg-panvas-bg-secondary px-3 text-xs text-panvas-text-tertiary shadow-sm transition-colors hover:bg-panvas-bg-hover hover:border-panvas-border-strong focus-ring max-[599px]:h-8 max-[599px]:w-9 max-[599px]:justify-center max-[599px]:px-0"
          style={noDragStyle}
        >
          <Search size={14} className="flex-shrink-0" />
          <span className="flex-1 text-left truncate max-[599px]:hidden">Search Panvas</span>
          <kbd className="hidden sm:inline-block rounded border border-panvas-border-subtle bg-panvas-bg-primary px-1.5 py-0.5 font-mono text-[10px] text-panvas-text-tertiary">Ctrl K</kbd>
        </button>
      </div>

      {/* RIGHT ZONE: App controls + Native Caption Safe Spacer. Empty right-zone whitespace remains draggable. */}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        <div className="flex flex-shrink-0 items-center pl-1" style={noDragStyle}>
          <SyncIndicator onOpenCloudSync={openCloudSync} />
        </div>

        <IconButton label={`Switch to ${nextThemeInCycle()} theme`} onClick={cycleTheme}>
          <ThemeIcon size={16} />
        </IconButton>

        {isAuthenticated && <div className="relative ml-0.5 flex-shrink-0" ref={authMenuRef} style={noDragStyle}>
          <button
            onClick={() => setIsAuthMenuOpen(open => !open)}
            className="rounded-full focus-ring flex items-center justify-center"
            aria-label="Open account menu"
            aria-expanded={isAuthMenuOpen}
          >
            <UserAvatar size="sm" />
          </button>

          {isAuthMenuOpen && isAuthenticated && (
            <div className="panvas-overlay absolute right-0 mt-2 w-56 rounded-lg border border-panvas-border-default bg-panvas-bg-elevated p-1.5 shadow-glass-sm z-50">
              <div className="mb-1 flex items-center gap-3 border-b border-panvas-border-subtle px-2.5 py-2">
                <UserAvatar size="sm" />
                <span className="truncate text-xs font-medium text-panvas-text-primary">{useAuthStore.getState().user?.email}</span>
              </div>
              <AccountMenuItem onClick={() => { setIsAuthMenuOpen(false); navigate('/app/settings/account'); }}>My Account</AccountMenuItem>
              <AccountMenuItem onClick={() => { setIsAuthMenuOpen(false); navigate('/app/settings/appearance'); }}>Settings</AccountMenuItem>
              <div className="my-1 h-px bg-panvas-border-subtle" />
              <AccountMenuItem danger onClick={handleSignOut}>Sign out</AccountMenuItem>
            </div>
          )}
        </div>}

        {/* Native window caption reserved safe area for Electron on Windows */}
        {isElectronOnWindows && (
          <div
            className="panvas-caption-safe-region flex-shrink-0 pointer-events-none"
            style={{ width: ELECTRON_CAPTION_SAFE_WIDTH, minWidth: ELECTRON_CAPTION_SAFE_WIDTH }}
            aria-hidden="true"
          />
        )}
      </div>
    </header>
  );
}

function IconButton({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-panvas-text-secondary transition-colors hover:bg-panvas-bg-hover hover:text-panvas-text-primary active:bg-panvas-bg-active focus-ring"
      style={noDragStyle}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function AccountMenuItem({ children, danger = false, onClick }: { children: React.ReactNode; danger?: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-ring ${danger ? 'text-panvas-accent-rose hover:bg-panvas-bg-hover' : 'text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary'}`}>{children}</button>;
}

// No custom window controls rendered here since we rely on titleBarOverlay
