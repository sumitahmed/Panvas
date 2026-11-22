import React, { Suspense, lazy, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { NotebookRenderer } from '@/components/notebook/NotebookRenderer';
import { shouldFallBackToLibrary } from '@/lib/defaultLanding';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { useUIStore } from '@/stores/uiStore';
import { ViewportErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport';

const CanvasView = lazy(() => import('@/components/canvas/CanvasView').then((module) => ({ default: module.CanvasView })));
const PdfWorkspace = lazy(() => import('@/components/pdf/PdfWorkspace').then((module) => ({ default: module.PdfWorkspace })));
const ReferencePagePane = lazy(() => import('./ReferencePagePane').then((module) => ({ default: module.ReferencePagePane })));

export function WorkspaceContent() {
  const isMobileViewport = useIsMobileViewport();
  const {
    activePageId,
    activeCanvasId,
    notebookPages,
    initialDocumentRestoreComplete,
    isLoading: isWorkspaceContentLoading,
  } = useWorkspaceStore();
  const [location, setLocation] = useLocation();
  const { paneLayout, splitRatio, setSplitRatio } = useLayoutStore();
  const { isPropertiesPanelOpen, togglePropertiesPanel } = useUIStore();
  const rootRef = useRef<HTMLDivElement>(null);
  const previousSplitRef = useRef(false);
  const hasNormalisedInitialSplitRef = useRef(false);
  const activePage = notebookPages.find(page => page.id === activePageId);

  // Serious-workspace default landing: once the startup restore pass has
  // settled, an /app visit without a valid active document belongs in the
  // Library. The gate never fires while restore/hydration is in flight, so
  // asynchronous workspace, notebook, and document transitions whose active
  // ids are transiently null cannot cause a spurious redirect.
  useEffect(() => {
    if (location !== '/app') return;
    if (shouldFallBackToLibrary({ initialDocumentRestoreComplete, isLoading: isWorkspaceContentLoading, activePageId, activeCanvasId })) {
      setLocation('/app/library');
    }
  }, [location, initialDocumentRestoreComplete, isWorkspaceContentLoading, activePageId, activeCanvasId, setLocation]);

  const primary = activePageId
    ? activePage?.type === 'pdf'
      ? <ViewportErrorBoundary surface="PDF workspace" resetKey={`pdf:${activePageId}`} onNavigate={() => setLocation('/app/library')}><Suspense fallback={null}><PdfWorkspace page={activePage} /></Suspense></ViewportErrorBoundary>
      : <ViewportErrorBoundary surface="Notebook viewport" resetKey={`notebook:${activePageId}`} onNavigate={() => setLocation('/app/library')}><NotebookRenderer spreadMode={!isMobileViewport && paneLayout === 'two-page'} /></ViewportErrorBoundary>
    : <ViewportErrorBoundary surface="Canvas viewport" resetKey={`canvas:${activeCanvasId ?? 'empty'}`} onNavigate={() => setLocation('/app/library')}><Suspense fallback={<div className="flex h-full w-full items-center justify-center bg-panvas-bg-primary text-sm text-panvas-text-tertiary">Loading canvas…</div>}><CanvasView /></Suspense></ViewportErrorBoundary>;

  const split = !isMobileViewport && activePageId && (paneLayout === 'vertical-split' || paneLayout === 'horizontal-split');
  const isHorizontal = paneLayout === 'horizontal-split';

  // The Page & View drawer belongs to the primary document. Leaving it open
  // while creating a split turns one half of the workspace into a narrow
  // sliver, as the drawer consumes a second slice of the same pane. Close it
  // on entry only; users may reopen it afterwards without it being forced shut.
  useEffect(() => {
    const enteringSplit = split && !previousSplitRef.current;
    const initialSplit = split && !hasNormalisedInitialSplitRef.current;
    if (isPropertiesPanelOpen && (enteringSplit || initialSplit)) {
      togglePropertiesPanel();
    }
    previousSplitRef.current = Boolean(split);
    hasNormalisedInitialSplitRef.current = true;
  }, [isPropertiesPanelOpen, split, togglePropertiesPanel]);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!rootRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const update = (pointerEvent: PointerEvent) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const ratio = isHorizontal
        ? (pointerEvent.clientY - rect.top) / rect.height
        : (pointerEvent.clientX - rect.left) / rect.width;
      setSplitRatio(ratio);
    };
    const finish = () => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  };

  return (
    <div ref={rootRef} data-pane-layout={paneLayout} className="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden" style={{ flexDirection: isHorizontal ? 'column' : 'row' }}>
      <div className="relative min-h-0 min-w-0 overflow-hidden" style={split ? { flexBasis: `${splitRatio * 100}%`, flexGrow: 0, flexShrink: 0 } : { flex: 1 }}>
        {primary}
      </div>
      {split && <>
        <div
          role="separator"
          aria-orientation={isHorizontal ? 'horizontal' : 'vertical'}
          aria-label="Resize reference pane"
          onPointerDown={beginResize}
          className={`${isHorizontal ? 'h-1.5 w-full cursor-row-resize' : 'h-full w-1.5 cursor-col-resize'} panvas-layer-sheet shrink-0 bg-panvas-border-default transition-colors hover:bg-panvas-accent-primary`}
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden"><ViewportErrorBoundary surface="Reference pane" resetKey={`${activePageId ?? 'none'}:${activeCanvasId ?? 'none'}`}><Suspense fallback={null}><ReferencePagePane /></Suspense></ViewportErrorBoundary></div>
      </>}
    </div>
  );
}
