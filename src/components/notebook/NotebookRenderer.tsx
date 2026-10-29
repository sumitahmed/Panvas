import type { ImageManager } from './engine/ImageManager';
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback, startTransition } from 'react';
import { flushSync } from 'react-dom';
import { NotebookEngine } from './engine/NotebookEngine';
import type { ViewportState } from './engine/drawingTypes';
import { useUIStore } from '@/stores/uiStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { useAuthStore } from '@/stores/authStore';
import { UniversalDropRouter } from '@/services/drop/UniversalDropRouter';
import { useLayoutStore } from '@/stores/layoutStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useShallow } from 'zustand/react/shallow';
import { NotebookToolPropertiesPanel } from './NotebookToolPropertiesPanel';
import { NotebookFloatingToolbar } from './NotebookFloatingToolbar';
import { NotebookNavigator } from './NotebookNavigator';
import { NotebookWorkspaceControls } from './NotebookWorkspaceControls';
import { createDocumentLayoutTransition, runDocumentLayoutHistory, documentConversionSource } from './documentLayoutTransition';
import { unsupportedNotebookContent, NOTEBOOK_RICH_TEXT_SCHEMA_VERSION } from './notebookContentCompatibility';
import { getNotebookSchema } from './tiptapExtensions';
import { NotebookPageUtilities } from './NotebookPageUtilities';
import { PresentationOverlay } from '@/components/workspace/PresentationOverlay';
import { resolveNotebookNavigationDelta, shouldNotebookHandleNavigationKey } from './notebookNavigation';
import { NotebookPageView } from './NotebookPageView';
import { LOGICAL_SCROLL_WINDOW } from './logicalScrollWindow';
import { PageRenderer } from './PageRenderer';
import { residentPageIds, reuseResidentPageIds, dominantPageId } from './pageVisualWindow';
import { NotebookContextMenu, type ContextMenuState } from './NotebookContextMenu';
import { DocumentationLinkDialog } from './DocumentationLinkDialog';
import { DocumentationMarkdownDialog } from './DocumentationMarkdownDialog';
import { HandwritingConversionDialog } from './HandwritingConversionDialog';
import type { Editor } from '@tiptap/react';
import { notebookRepository } from '@/repositories/NotebookRepository';
import { exportNotebookToPdf, exportPageToPdf, printNotebook, printPage } from '@/services/pdf/notebookExportCommands';
import { type AudioNote, type TextObject, type Stroke, createEmptyDrawingData, type DrawingData, type NotebookMode } from './engine/drawingTypes';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { generateId } from '@/lib/utils/id';
import { htmlToTipTapJson } from './tiptapExtensions';
import { parsePlainTextClipboard, textContentWithSafeLinks } from './notebookClipboard';
import { installNotebookReferenceNavigation } from './notebookReferences';
import { useToolState } from './useEngineState';
import { attachTwoFingerViewportGesture } from './engine/touchViewportGesture';
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport';
import { useHasTouchInput } from '@/hooks/useHasTouchInput';
import { capturePageGeometryAnchor, derivePagePropertyOverrides, getNotebookPageDefaults, hasAuthoritativePageAppearance, resolveNotebookPageLayout, resolvePageDimensions, resolvePageGeometryScrollDelta, resolvePageProperties, resolvePageRenderProperties, resolveBasePageDimensions, type PageGeometryAnchor } from '@/lib/pageProperties';
import type { NotebookPropertyBatchSnapshot, PagePropertySet } from '@/types/notebook';
import { createStickyNote, STICKY_NOTE_MIN_HEIGHT, STICKY_NOTE_WIDTH } from './stickyNotes';
import type { HandwritingToolPreferences } from '@/services/beautification/handwritingBeautification';
import type { ReviewedHandwritingLine } from '@/services/recognition/bulkConversion';
import { PanelTopOpen, PanelRight, Plus } from 'lucide-react';
import { pageAudioPersistence } from '@/services/audio/pageAudioPersistenceInstance';
import { drawingSnapshotJson, rememberDrawingSnapshotJson } from '@/services/storage/drawingSnapshotJson';
import { changeVoiceNote, type VoiceState } from '@/services/audio/voiceNoteCommands';
import { formatPageIndicator } from './pageIndicator';
import {
  captureFreshPageOwnedDrawing,
  mayApplyPageLoadToEngine,
  mayPersistPagePropertyChange,
  isPaperColorOnlyUpdate,
  mergeLoadedPageData,
  resolveNotebookPageRenderData,
  isPageFarOffscreen,
  type PageOwnedDrawing,
} from './notebookPageRenderState';
import { gate0Profiler } from '@/dev/gate0Profiler';
import { recordHandwritingTraceMarker } from '@/dev/handwritingTrace';
import { DrawingSaveScheduler } from './drawingSaveScheduler';
import {
  DrawingPersistenceQueue,
  type DrawingPersistenceCallbacks,
  type DrawingSaveTarget,
} from './drawingPersistenceQueue';
import { setDrawingGestureActive, isDrawingRecentlyActive } from '@/services/cloudsync/drawingActivity';
import { resolveDocumentToolCursor } from './documentToolCursor';
import { DocumentToolCursorOverlay } from './DocumentToolCursorOverlay';
import { saveNotebookPosition, getNotebookPosition } from '@/lib/readingPosition';

function captureEngineOwnedDrawing(
  notebookEngine: NotebookEngine,
  documentId: string | undefined,
  sheetId: string | undefined,
  renderedSheetId = sheetId,
): PageOwnedDrawing | null {
  if (!documentId || !sheetId || !renderedSheetId) return null;
  // DATA SAFETY: This ownership check prevents one notebook page from rendering or saving another page's scene.
  const owner = notebookEngine.getDrawingOwnership();
  if (owner.pageId !== sheetId || renderedSheetId !== sheetId) {
    if (import.meta.env.DEV) {
      console.warn('[NotebookRenderer] blocked cross-sheet drawing save', {
        documentId,
        sheetId,
        renderedSheetId,
        sceneOwnerSheetId: owner.pageId,
        drawingRevision: owner.revision,
      });
    }
    return null;
  }
  return captureFreshPageOwnedDrawing(
    documentId,
    sheetId,
    owner.pageId ?? '',
    owner.revision,
    () => notebookEngine.getDrawingData(),
    renderedSheetId,
  );
}

/**
 * Presentation is stored on the existing TextObject metadata, rather than in
 * the TipTap document. This keeps pasted prose editable with the same editor
 * while ensuring fenced code retains its existing codeBlock rendering.
 */
function getPlainTextPastePresentation(content: any): 'sticky-note' | 'mixed-paste' | undefined {
  const nodes = content?.content;
  if (!Array.isArray(nodes)) return undefined;

  const hasCode = nodes.some(node => node?.type === 'codeBlock');
  const hasProse = nodes.some(node => node?.type !== 'codeBlock');

  if (!hasProse) return undefined;
  return hasCode ? 'mixed-paste' : 'sticky-note';
}

export function NotebookRenderer({ spreadMode = false, onEngineReady }: { spreadMode?: boolean; onEngineReady?: (engine: NotebookEngine) => void }) {
  gate0Profiler.resource('reactRenders.NotebookRenderer', 1);
  useEffect(() => {
    gate0Profiler.resource('reactCommits.NotebookRenderer', 1);
  });
  const gate0OnRender = useCallback((_id: string, phase: 'mount' | 'update' | 'nested-update', actualDuration: number, baseDuration: number) => {
    gate0Profiler.event('react-profiler-commit', actualDuration, { phase, baseDuration });
  }, []);
  const { activePageId, notebookPages, notebookSections, notebooks, workspaces, activeNotebookSectionId } = useWorkspaceStore(useShallow(state => ({
    activePageId: state.activePageId,
    notebookPages: state.notebookPages,
    notebookSections: state.notebookSections,
    notebooks: state.notebooks,
    workspaces: state.workspaces,
    activeNotebookSectionId: state.activeNotebookSectionId,
  })));
  const page = notebookPages.find(item => item.id === activePageId);
  const notebook = page ? notebooks.find(item => item.id === page.notebookId) : undefined;
  const workspace = notebook ? workspaces.find(item => item.id === notebook.workspaceId) : undefined;
  
  // Engine setup
  const notebookEngine = useMemo(() => new NotebookEngine(), []);
  // The renderer owns this engine for its full mounted lifetime. Re-renders
  // keep the same instance; a replacement instance or genuine unmount tears
  // down the old one exactly once through NotebookEngine's idempotent cleanup.
  useEffect(() => {
    return () => notebookEngine.destroy();
  }, [notebookEngine]);
  useEffect(() => {
    onEngineReady?.(notebookEngine);
  }, [notebookEngine, onEngineReady]);
  useEffect(() => {
    (window as any).__PANVAS_GATE0_ENGINE__ = notebookEngine;
    return () => {
      if ((window as any).__PANVAS_GATE0_ENGINE__ === notebookEngine) delete (window as any).__PANVAS_GATE0_ENGINE__;
    };
  }, [notebookEngine]);
  const [viewport, setViewport] = useState<Readonly<ViewportState>>(() => notebookEngine.viewport.getState());
  // Read straight from the engine rather than mirroring it. The previous
  // `useState(getState()) + subscribe(setToolState)` pair was resubscribed by the effect
  // below on every workspace/notebook/page change without re-reading the engine, so any
  // notification emitted across a resubscribe was silently dropped and never recovered.
  const toolState = useToolState(notebookEngine);
  const [pageProperties, setPageProperties] = useState(() => notebookEngine.getProperties());
  // Stable callbacks can retain earlier render contexts through each other.
  // Keep large scene payloads only in the live ref, not in those contexts;
  // a scalar revision still publishes every required visual update.
  const [sectionDataRevision, setSectionDataRevision] = useState(0);
  const pendingSectionPublishRef = useRef(false);
  const sectionDataCacheRef = useRef<Record<string, DrawingData>>({});
  const publishedSectionDataRef = useRef(sectionDataCacheRef.current);
  const updateSectionDataCache = useCallback((update: (current: Record<string, DrawingData>) => Record<string, DrawingData>, publish = true) => {
    const next = update(sectionDataCacheRef.current);
    sectionDataCacheRef.current = next;
    if (publish && next !== publishedSectionDataRef.current) {
      publishedSectionDataRef.current = next;
      if (drawingGestureActiveRef.current) {
        pendingSectionPublishRef.current = true;
      } else {
        setSectionDataRevision(revision => revision + 1);
      }
    }
  }, []);
  // A save snapshot contains the same scene at the same drawing revision but
  // freshly cloned object arrays. Replacing a page-cache entry with it would
  // invalidate an already-current page-owned preview and replay 1,200 strokes.
  // Preserve the content-bearing arrays unless the engine actually advanced.
  const sectionDataRevisionRef = useRef<Record<string, number>>({});
  const publishSnapshotPageData = useCallback((snapshot: PageOwnedDrawing, data: DrawingData) => {
    const pageId = snapshot.saveTargetSheetId;
    const knownRevision = sectionDataRevisionRef.current[pageId];
    if (knownRevision !== undefined && knownRevision > snapshot.drawingRevision) return;
    if (knownRevision === snapshot.drawingRevision) {
      updateSectionDataCache(previous => {
        const current = previous[pageId];
        if (!current) return { ...previous, [pageId]: data };
        return {
          ...previous,
          [pageId]: {
            ...current,
            version: data.version,
            properties: data.properties,
            audioNotes: data.audioNotes,
          },
        };
      }, false);
      return;
    }
    sectionDataRevisionRef.current[pageId] = snapshot.drawingRevision;
    updateSectionDataCache(previous => ({ ...previous, [pageId]: data }));
  }, [updateSectionDataCache]);
  const focusedPageLoadGenerationRef = useRef(0);
  const loadedSceneRevisionRef = useRef<number | null>(null);
  const residentImageManagersRef = useRef(new Map<string, ImageManager>());
  const residentDrawingEnginesRef = useRef(new Map<string, NotebookEngine['drawing']>());
  const registerPageImages = useCallback((pageId: string, images: ImageManager | null, drawing?: NotebookEngine['drawing']) => {
    if (images) residentImageManagersRef.current.set(pageId, images);
    else residentImageManagersRef.current.delete(pageId);
    if (drawing) {
      const cached = residentDrawingEnginesRef.current.get(pageId);
      if (cached && cached !== drawing) drawing.retainStrokePaths(cached);
      residentDrawingEnginesRef.current.delete(pageId);
      residentDrawingEnginesRef.current.set(pageId, drawing);
      // Detached previews release their canvases/images in PageView cleanup.
      // Keep only a small recent geometry window so revisiting a page does not
      // rebuild every path. Never retain an unbounded notebook's geometry.
      const sampleCount = (id: string, engine: NotebookEngine['drawing']) => {
        const strokes = engine.getStrokes();
        if (strokes.length) return strokes.reduce((count, stroke) => count + stroke.points.length, 0);
        const data = sectionDataCacheRef.current[id];
        return (data?.strokes ?? data?.objects?.filter(object => object.type === 'stroke') ?? [])
          .reduce((count, stroke) => count + stroke.points.length, 0);
      };
      let samples = [...residentDrawingEnginesRef.current].reduce((sum, [id, engine]) => sum + sampleCount(id, engine), 0);
      for (const [id, engine] of residentDrawingEnginesRef.current) {
        if (residentDrawingEnginesRef.current.size <= 10 && samples <= 1_000_000) break;
        if (id === pageId) continue;
        samples -= sampleCount(id, engine);
        residentDrawingEnginesRef.current.delete(id);
      }
    }
  }, []);
  // The focused page owns the live engine. Keep its identity available while
  // resolving the visible page props so a metadata snapshot cannot briefly
  // overwrite an in-memory property change during a render.
  const [focusedPageId, setFocusedPageId] = useState<string>(activePageId || '');
  const focusedPageIdRef = useRef(focusedPageId);
  const propertySaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPropertySaveRef = useRef<PageOwnedDrawing | null>(null);
  const persistDrawingRef = useRef<(snapshot: PageOwnedDrawing | null) => void>(() => {});
  const drawingGestureActiveRef = useRef(false);
  // Scrolling a dense page is also a gesture that must not compete with the
  // synchronous multi-megabyte snapshot encode. The save scheduler already
  // understands deferral and a hard 10s checkpoint, so extending its active
  // window to scroll keeps persistence safe without serializing mid-fling.
  const scrollGestureActiveRef = useRef(false);
  const deferredPageSavesRef = useRef(new Map<string, PageOwnedDrawing>());
  const deferredSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drawingSaveSchedulerRef = useRef<DrawingSaveScheduler<PageOwnedDrawing> | null>(null);
  if (!drawingSaveSchedulerRef.current) {
    drawingSaveSchedulerRef.current = new DrawingSaveScheduler<PageOwnedDrawing>(
      snapshot => {
        if (snapshot) {
          updateSectionDataCache(current => current, false);
        }
        persistDrawingRef.current(snapshot);
      },
      { onEvent: event => recordHandwritingTraceMarker(event.type, event) },
    );
  }
  const syncSaveGestureActive = useCallback(() => {
    drawingSaveSchedulerRef.current?.setGestureActive(
      drawingGestureActiveRef.current || scrollGestureActiveRef.current,
    );
  }, []);
  const latestCapturedDrawingRef = useRef(new Map<string, PageOwnedDrawing>());
  const drawingPersistenceCallbacksRef = useRef<DrawingPersistenceCallbacks | null>(null);
  const drawingPersistenceRef = useRef<DrawingPersistenceQueue | null>(null);
  if (!drawingPersistenceRef.current) {
    drawingPersistenceRef.current = new DrawingPersistenceQueue(
      () => drawingPersistenceCallbacksRef.current,
    );
  }
  const [, setTextObjects] = useState<TextObject[]>([]);
  const [handwritingStrokes, setHandwritingStrokes] = useState<Stroke[]>([]);
  const [isHandwritingDialogOpen, setIsHandwritingDialogOpen] = useState(false);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [, setLayerRevision] = useState(0);
  const { isPropertiesPanelOpen } = useUIStore(useShallow(state => ({ isPropertiesPanelOpen: state.isPropertiesPanelOpen })));
  const { notebookModeLevel, setNotebookModeLevel, workspaceViewMode, setWorkspaceViewMode, isToolbarCollapsed, setToolbarCollapsed } = useLayoutStore(useShallow(state => ({
    notebookModeLevel: state.notebookModeLevel,
    setNotebookModeLevel: state.setNotebookModeLevel,
    workspaceViewMode: state.workspaceViewMode,
    setWorkspaceViewMode: state.setWorkspaceViewMode,
    isToolbarCollapsed: state.isToolbarCollapsed,
    setToolbarCollapsed: state.setToolbarCollapsed,
  })));
  const setActivePage = useWorkspaceStore(s => s.setActivePage);
  useEffect(() => installNotebookReferenceNavigation(
    notebookEngine, () => useWorkspaceStore.getState().notebookPages,
    id => useWorkspaceStore.getState().setActivePage(id),
  ), [notebookEngine]);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const fullscreenToolbarHostRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [fullscreenToolbarHostWidth, setFullscreenToolbarHostWidth] = useState<number | null>(null);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [debouncedScale, setDebouncedScale] = useState(1.0);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const containerToolCursor = (!isTouchDevice && (toolState.mode === 'draw' || toolState.mode === 'erase'))
    ? resolveDocumentToolCursor(toolState)
    : undefined;
  const initialRestoredNotebookRef = useRef<string | null>(null);

  useEffect(() => {
    const gestures = notebookEngine.input.navigationGestures;
    const updateRasterScale = () => {
      if (!gestures.active) setDebouncedScale(notebookEngine.viewport.getState().scale);
    };
    const handler = setTimeout(updateRasterScale, 150);
    const unsubscribe = gestures.onIdle(updateRasterScale);
    return () => { clearTimeout(handler); unsubscribe(); };
  }, [notebookEngine, viewport.scale]);

  useEffect(() => {
    if (workspaceViewMode !== 'edit') {
      notebookEngine.tools.setMode('hand');
      setActiveEditor(null);
    }
  }, [notebookEngine, workspaceViewMode]);

  // Every manual pan owner shares this synchronous lifecycle. Focus handoff
  // unmounts/detaches the live canvas, so ALL activation requests must defer.
  const navigationGestures = notebookEngine.input.navigationGestures;
  const pendingFocusPageIdRef = useRef<string | null>(null);
  const pendingActivationPageIdRef = useRef<string | null>(null);
  // Passive scroll coalesces its focus transfer until motion settles. Running a
  // handoff at every intermediate page boundary would commit the whole notebook
  // subtree repeatedly while the user is still scrolling past those pages.
  const passiveActivationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPassiveActivationRef = useRef<string | null>(null);
  const flushNavigationScrollRef = useRef<() => void>(() => {});
  // Clear before child layout cleanup detaches the focused canvas on teardown.
  useLayoutEffect(() => () => {
    pendingFocusPageIdRef.current = null;
    pendingActivationPageIdRef.current = null;
    if (passiveActivationTimerRef.current !== null) {
      clearTimeout(passiveActivationTimerRef.current);
      passiveActivationTimerRef.current = null;
    }
    pendingPassiveActivationRef.current = null;
    flushNavigationScrollRef.current = () => {};
  }, []);
  const pageGeometryTransitionRef = useRef<{ pageId: string; anchor: PageGeometryAnchor } | null>(null);
  const pageGeometryReleaseRafRef = useRef<number | null>(null);
  const [pageGeometryTransitionRevision, setPageGeometryTransitionRevision] = useState(0);
  // handleActivatePage is defined further down (it needs the section cache) and is rebuilt
  // whenever that cache changes. Effects that outlive those rebuilds must always call the
  // latest version — a captured stale copy would flush the wrong outgoing page — so they go
  // through this ref, which is reassigned on every render right after the callback is created.
  const handleActivatePageRef = useRef<(targetPageId: string, recordOpen?: boolean) => void>(() => {});
  useEffect(() => navigationGestures.onIdle(() => {
    // The final pointermove can precede the observer's rAF. Resolve that final
    // position before flushing, avoiding a stale-page handoff followed by another.
    flushNavigationScrollRef.current();
    const targetPageId = pendingFocusPageIdRef.current;
    pendingFocusPageIdRef.current = null;
    if (targetPageId) handleActivatePageRef.current(targetPageId);
  }), [navigationGestures]);

  // The scroll viewport is only rendered when a page is active (see the guard just before the
  // JSX), so this boolean — not the page id — is what listener-binding effects depend on.
  const hasActivePage = Boolean(activePageId);

  // Sync Engine state to React
  useEffect(() => {
    const unsubViewport = notebookEngine.viewport.subscribe(setViewport);

    const unsubProps = notebookEngine.onPropertiesChange((newProps, source) => {
      // 1. Immediately update React state for instant UI response
      setPageProperties(newProps);
      
      const sceneOwnerPageId = notebookEngine.getDrawingOwnership().pageId;
      const currentPageId = source === 'load'
        ? sceneOwnerPageId
        : focusedPageIdRef.current || sceneOwnerPageId;
      if (currentPageId) {
        updateSectionDataCache(prev => {
          const prevData = prev[currentPageId] || createEmptyDrawingData();
          return {
            ...prev,
            [currentPageId]: {
              ...prevData,
              properties: { ...newProps },
            }
          };
        });
      }

      // Page loads publish properties for rendering, but they are not edits.
      // Persisting a load notification can write whichever page owns the live
      // engine 500 ms later into the page that originally emitted the event.
      if (!mayPersistPagePropertyChange(source) || !currentPageId) return;
      recordHandwritingTraceMarker('snapshot/captureStarted', { pageId: currentPageId });
      const pageOwnedSnapshot = captureEngineOwnedDrawing(notebookEngine, notebook?.id, currentPageId);
      recordHandwritingTraceMarker('snapshot/captureEnded', {
        pageId: currentPageId,
        revision: pageOwnedSnapshot?.drawingRevision,
      });
      if (!pageOwnedSnapshot) return;
      latestCapturedDrawingRef.current.set(currentPageId, pageOwnedSnapshot);
      
      // 2. Debounce persistence so serialization and disk/IPC never block the UI render
      if (propertySaveTimeoutRef.current) clearTimeout(propertySaveTimeoutRef.current);
      pendingPropertySaveRef.current = pageOwnedSnapshot;
      propertySaveTimeoutRef.current = setTimeout(() => {
        const pending = pendingPropertySaveRef.current;
        pendingPropertySaveRef.current = null;
        propertySaveTimeoutRef.current = null;
        if (pending) persistDrawingRef.current(pending);
      }, 500);
    });
    
    return () => {
      unsubViewport();
      unsubProps();
    };
  }, [notebookEngine, notebook?.id, updateSectionDataCache]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(entries => {
      if (entries[0]) {
        setContainerSize({
          width: entries[0].contentRect.width,
          height: entries[0].contentRect.height
        });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const host = fullscreenToolbarHostRef.current;
    if (!host || notebookModeLevel !== 2 || isToolbarCollapsed) return;
    const updateWidth = (width: number) => setFullscreenToolbarHostWidth(previous =>
      Math.abs((previous ?? -1) - width) < 0.5 ? previous : width);
    updateWidth(host.getBoundingClientRect().width);
    const observer = new ResizeObserver(entries => {
      if (entries[0]) updateWidth(entries[0].contentRect.width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [isToolbarCollapsed, notebookModeLevel]);

  // Below this notebook width the pinned chrome cannot hold the properties
  // drawer (288px) + workspace controls (~141px) + even the minimal toolbar
  // (~172px) without overlap, so the drawer auto-closes on resize. Explicit
  // user opens get a grace period (lastPropertiesPanelToggleAt) and the
  // effect only re-runs on resize, so an intentionally re-opened drawer is
  // left alone until the window is resized again. On phones the panel is a
  // viewport-level bottom sheet that never reserves chrome width, so the
  // auto-close protection does not apply there.
  const isMobileViewport = useIsMobileViewport();
  const hasTouchInput = useHasTouchInput();
  const isCompactWorkspace = useIsMobileViewport(1023);
  const PROPERTIES_DRAWER_AUTOCLOSE_WIDTH = 680;
  useEffect(() => {
    if (!isPropertiesPanelOpen) return;
    if (isMobileViewport) return;
    if (containerSize.width === 0 || containerSize.width >= PROPERTIES_DRAWER_AUTOCLOSE_WIDTH) return;
    const { lastPropertiesPanelToggleAt, togglePropertiesPanel } = useUIStore.getState();
    if (Date.now() - lastPropertiesPanelToggleAt < 2500) return;
    togglePropertiesPanel();
  }, [containerSize.width, isPropertiesPanelOpen, isMobileViewport]);

  const paperDimensions = useMemo(
    () => resolvePageDimensions(pageProperties),
    [pageProperties],
  );

  // Auto-fit zoom to fill ~85% of workspace width on initial load. The upper
  // clamp bounds the zoom level itself (not a fixed pixel width) so large
  // desktop windows get proportionally larger paper instead of hitting a
  // 1150px ceiling that left big displays mostly empty.
  const hasAutoZoomed = useRef(false);
  const fittedViewportRef = useRef('');
  const fittedScaleRef = useRef<number | null>(null);
  useEffect(() => {
    if (containerSize.width === 0 || paperDimensions.width === 0) return;
    // ResizeObserver's content box also changes when scrollbars appear during
    // zoom. That is not a viewport resize: refitting here fights the gesture
    // and repeatedly adds/removes the scrollbar. Use the stable layout width
    // to decide whether fitting is needed; retain the available width below.
    const layoutWidth = containerRef.current?.offsetWidth ?? containerSize.width;
    const fitKey = `${isMobileViewport}:${layoutWidth}:${paperDimensions.width}:${activeNotebookSectionId}`;
    const phoneResized = isMobileViewport && fittedViewportRef.current !== fitKey;
    const wasAutoFitted = fittedScaleRef.current !== null && Math.abs(notebookEngine.viewport.getState().scale - fittedScaleRef.current) < 0.001;
    const changedComposition = fittedViewportRef.current !== '' && !fittedViewportRef.current.startsWith(`${isMobileViewport}:`);
    if (hasAutoZoomed.current && !phoneResized && !wasAutoFitted && !changedComposition) return;

    const targetWidth = isMobileViewport ? containerSize.width - 16 : containerSize.width * 0.85;
    const fitZoom = Math.max(0.25, Math.min(1.75, targetWidth / paperDimensions.width));
    notebookEngine.viewport.setZoom(fitZoom);
    if (isMobileViewport && containerRef.current) containerRef.current.scrollLeft = 0;
    fittedViewportRef.current = fitKey;
    fittedScaleRef.current = fitZoom;
    hasAutoZoomed.current = true;
  }, [containerSize.width, paperDimensions.width, notebookEngine, isMobileViewport, activeNotebookSectionId]);

  // Reset auto-zoom when active notebook or section changes (not on every single page scroll)
  useEffect(() => {
    hasAutoZoomed.current = false;
  }, [activeNotebookSectionId, notebook?.id]);
  const marginPaddingClass = useMemo(() => {
    if (pageProperties.margins === 'Narrow') return 'px-[5%] py-[5%]';
    if (pageProperties.margins === 'Wide') return 'px-[18%] py-[12%]';
    return 'px-[10%] py-[10%]';
  }, [pageProperties.margins]);

  // 6B: Calculate current page position
  const currentSectionPages = useMemo(() => {
    const rawPages = notebookPages
      .filter(p => p.sectionId === activeNotebookSectionId && !p.deletedAt)
      .sort((a, b) => a.order - b.order);

    const seen = new Set<string>();
    const uniquePages: typeof rawPages = [];
    for (const p of rawPages) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        uniquePages.push(p);
      } else {
        console.error('[PAGE DUPLICATE DETECTED IN STORE]', { id: p.id, title: p.title });
      }
    }

    return uniquePages;
  }, [notebookPages, activeNotebookSectionId]);
  const currentSectionPageIdsKey = useMemo(
    () => currentSectionPages.map(sectionPage => sectionPage.id).join('\u0000'),
    [currentSectionPages],
  );
  
  // Compute the canonical section layout in stable base-document coordinates.
  // Two-page mode is a real spread (paired columns), not a global UI scale.
  const resolvedSectionProperties = useMemo(() => {
    return new Map(currentSectionPages.map(sectionPage => {
      const cachedProperties = sectionDataCacheRef.current[sectionPage.id]?.properties;
      // On first load there is no cache yet, so persisted metadata remains the
      // source until the engine finishes loading.
      return [sectionPage.id, resolvePageRenderProperties(notebook, sectionPage, cachedProperties)] as const;
    }));
  }, [currentSectionPages, notebook, sectionDataRevision]);

  const [logicalScrollBases, setLogicalScrollBases] = useState<Record<string, number>>({});
  const rebaseLogicalScroll = useCallback((pageId: string, base: number, delta: number) => {
    const container = containerRef.current;
    // Only the editing owner can recenter the shared scroll viewport. An
    // inactive Infinite neighbor must not pull a manually selected page away.
    if (!container || focusedPageIdRef.current !== pageId || notebookEngine.getDrawingOwnership().pageId !== pageId) return;
    const scrollTop = container.scrollTop;
    flushSync(() => setLogicalScrollBases(previous => ({ ...previous, [pageId]: base })));
    container.scrollTop = scrollTop - delta * notebookEngine.viewport.getState().scale;
  }, [notebookEngine]);
  const layoutConfig = useMemo(() => resolveNotebookPageLayout(
    currentSectionPages.map(sectionPage => ({
      id: sectionPage.id,
      properties: resolvedSectionProperties.get(sectionPage.id)!.pageSize === 'Infinite' || resolvedSectionProperties.get(sectionPage.id)!.layoutMode === 'document'
        ? { ...resolvedSectionProperties.get(sectionPage.id)!, layoutExtent: Math.min(LOGICAL_SCROLL_WINDOW, resolvedSectionProperties.get(sectionPage.id)!.layoutExtent ?? 1123) }
        : resolvedSectionProperties.get(sectionPage.id)!,
    })),
    spreadMode,
  ), [currentSectionPages, resolvedSectionProperties, spreadMode]);
  const sectionAppearanceReady = currentSectionPages.every(sectionPage =>
    hasAuthoritativePageAppearance(sectionPage, sectionDataCacheRef.current[sectionPage.id]?.properties),
  );
  useEffect(() => {
    const goToPosition = (event: Event) => {
      const y = Number((event as CustomEvent).detail?.y);
      const id = focusedPageIdRef.current, container = containerRef.current;
      const props = id ? resolvedSectionProperties.get(id) : undefined;
      if (!id || !container || !Number.isFinite(y) || y < 0 || !(props?.pageSize === 'Infinite' || props?.layoutMode === 'document')) return;
      const extent = props.layoutExtent ?? 1123;
      const point = Math.min(extent - 1, y);
      const base = Math.max(0, Math.min(extent - LOGICAL_SCROLL_WINDOW, point - LOGICAL_SCROLL_WINDOW / 2));
      flushSync(() => setLogicalScrollBases(previous => ({ ...previous, [id]: base })));
      const root = document.getElementById(`page-${id}`);
      if (root) container.scrollTop += root.getBoundingClientRect().top - container.getBoundingClientRect().top + (point - base) * notebookEngine.viewport.getState().scale;
    };
    document.addEventListener('panvas:go-to-logical-y', goToPosition);
    return () => document.removeEventListener('panvas:go-to-logical-y', goToPosition);
  }, [resolvedSectionProperties, notebookEngine]);

  useLayoutEffect(() => {
    const pending = pageGeometryTransitionRef.current;
    const container = containerRef.current;
    if (!pending || !container) return;
    const pageElement = document.getElementById(`page-${pending.pageId}`);
    if (pageElement) {
      const pageRect = pageElement.getBoundingClientRect();
      const delta = resolvePageGeometryScrollDelta(pending.anchor, pageRect);
      container.scrollTo({
        left: Math.max(0, container.scrollLeft + delta.x),
        top: Math.max(0, container.scrollTop + delta.y),
        behavior: 'instant',
      });
    }

    if (pageGeometryReleaseRafRef.current !== null) cancelAnimationFrame(pageGeometryReleaseRafRef.current);
    pageGeometryReleaseRafRef.current = requestAnimationFrame(() => {
      pageGeometryReleaseRafRef.current = requestAnimationFrame(() => {
        if (pageGeometryTransitionRef.current === pending) pageGeometryTransitionRef.current = null;
        pageGeometryReleaseRafRef.current = null;
      });
    });
  }, [pageGeometryTransitionRevision]);

  useEffect(() => () => {
    if (pageGeometryReleaseRafRef.current !== null) cancelAnimationFrame(pageGeometryReleaseRafRef.current);
  }, []);

  // ---- Zoom: deterministic closed-form anchor-based scroll correction ----
  // We capture the document-space point under the cursor BEFORE zoom,
  // then in useLayoutEffect we calculate the exact new scroll position using
  // closed-form vertical coordinates without any flexbox ambiguity or jumps.
  const zoomAnchorRef = useRef<{
    docX: number;      // document-space X under cursor
    docY: number;      // document-space Y under cursor
    originX: number;   // cursor X relative to container
    originY: number;   // cursor Y relative to container
    newScale: number;  // target scale
  } | null>(null);

  const applyZoom = useCallback((factor: number, originX: number, originY: number): boolean => {
    const container = containerRef.current;
    if (!container) return false;

    const renderedScale = viewport.scale;
    const pendingScale = zoomAnchorRef.current?.newScale;
    const targetBaseScale = pendingScale !== undefined && pendingScale !== renderedScale
      ? pendingScale
      : renderedScale;
    const newScale = Math.max(0.25, Math.min(4.0, targetBaseScale * factor));
    if (newScale === targetBaseScale) return false;

    const w = layoutConfig.totalWidth * renderedScale;
    const offsetX = Math.max(0, (container.clientWidth - w) / 2);

    // Convert cursor origin (in container-space) to exact document-space coordinates
    const contentX = container.scrollLeft + originX - offsetX;
    const contentY = container.scrollTop + originY;
    const docX = contentX / renderedScale;
    const docY = contentY / renderedScale;

    // Store anchor for post-render correction
    zoomAnchorRef.current = { docX, docY, originX, originY, newScale };

    // Update viewport scale — triggers React re-render
    notebookEngine.viewport.setZoom(newScale);
    return true;
  }, [layoutConfig.totalWidth, notebookEngine, viewport.scale]);

  // After React re-renders with the new scale, compute exact new scroll coordinates
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    zoomAnchorRef.current = null;

    const container = containerRef.current;
    if (!container) return;

    const scale = anchor.newScale;
    const w = layoutConfig.totalWidth * scale;
    const offsetX = Math.max(0, (container.clientWidth - w) / 2);

    const newScrollLeft = Math.max(0, anchor.docX * scale + offsetX - anchor.originX);
    const newScrollTop = Math.max(0, anchor.docY * scale - anchor.originY);

    container.scrollTo({ left: newScrollLeft, top: newScrollTop, behavior: 'instant' });
  }, [layoutConfig.totalWidth, viewport.scale]);

  // Direct panel zoom button (+, -, fit)
  const handlePanelZoom = useCallback((zoomFactor: number) => {
    const container = containerRef.current;
    if (!container) return;
    const clampedZoom = Math.max(0.25, Math.min(4.0, viewport.scale * zoomFactor));
    const factor = clampedZoom / viewport.scale;
    if (factor === 1) return;
    applyZoom(factor, container.clientWidth / 2, container.clientHeight / 2);
  }, [viewport.scale, applyZoom]);

  // Continuously flushes accumulated pinch-zoom deltas on animation frames so
  // there is always exactly one anchor in flight per committed scale.
  const CONTINUOUS_PINCH_MAX_ABS_DELTA = 50; // px; below this, treat as a touchpad pinch sample
  const pinchAccumulatedDeltaYRef = useRef(0);
  const pinchOriginRef = useRef({ x: 0, y: 0 });
  const pinchFrameRef = useRef<number | null>(null);
  const pinchCommitInFlightRef = useRef(false);

  const flushPinchZoom = useCallback(() => {
    pinchFrameRef.current = null;
    if (pinchCommitInFlightRef.current) return; // wait for the in-flight scale to commit + correct
    const deltaY = pinchAccumulatedDeltaYRef.current;
    if (deltaY === 0) return;
    pinchAccumulatedDeltaYRef.current = 0;

    const factor = Math.exp(-deltaY / 100);
    const didCommit = applyZoom(factor, pinchOriginRef.current.x, pinchOriginRef.current.y);
    if (didCommit) {
      pinchCommitInFlightRef.current = true;
    }
  }, [applyZoom]);

  const schedulePinchFlush = useCallback(() => {
    if (pinchFrameRef.current !== null) return;
    pinchFrameRef.current = requestAnimationFrame(flushPinchZoom);
  }, [flushPinchZoom]);

  useEffect(() => {
    pinchCommitInFlightRef.current = false;
    if (pinchAccumulatedDeltaYRef.current !== 0) {
      schedulePinchFlush();
    }
  }, [viewport.scale, schedulePinchFlush]);

  useEffect(() => {
    return () => {
      if (pinchFrameRef.current !== null) {
        cancelAnimationFrame(pinchFrameRef.current);
      }
    };
  }, []);

  // Wheel handler: capture zoom with cursor as anchor
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();

        const rect = container.getBoundingClientRect();
        const originX = e.clientX - rect.left;
        const originY = e.clientY - rect.top;

        if (Math.abs(e.deltaY) < CONTINUOUS_PINCH_MAX_ABS_DELTA) {
          pinchAccumulatedDeltaYRef.current += e.deltaY;
          pinchOriginRef.current = { x: originX, y: originY };
          schedulePinchFlush();
        } else {
          const factor = e.deltaY < 0 ? 1.1 : 0.9;
          applyZoom(factor, originX, originY);
        }
      }
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [applyZoom, schedulePinchFlush]);



  // Space held = temporary Hand tool. The override has to be strictly symmetric: it is the
  // only code path that writes a tool mode the user did not choose, so a lost restore shows
  // up as exactly the reported symptom — the engine in one mode, the toolbar labelled with
  // another. Previously the keyup listener was registered on `window` from inside the keydown
  // handler and removed only by a matching Space keyup, so the effect's cleanup could not
  // reclaim it. Losing focus before the keyup (alt-tab, or the native file dialog the image
  // importer opens) left an orphaned listener holding a stale `prevMode` that fired on the
  // next Space, silently reverting the mode with no user action.
  useEffect(() => {
    if (workspaceViewMode !== 'edit') return undefined;
    // Non-null only while the override is engaged; also the restore-once guard.
    let overriddenFrom: NotebookMode | null = null;

    const restore = () => {
      if (overriddenFrom === null) return;
      const previous = overriddenFrom;
      overriddenFrom = null;
      notebookEngine.tools.setMode(previous);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      const target = e.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target as HTMLElement)?.isContentEditable) return;
      if (overriddenFrom !== null) return;

      const currentMode = notebookEngine.tools.getState().mode;
      if (currentMode === 'hand') return;

      overriddenFrom = currentMode;
      notebookEngine.tools.setMode('hand');
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') restore();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    // A keyup that lands on another window never reaches us, so blur is the backstop.
    window.addEventListener('blur', restore);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', restore);
      restore();
    };
  }, [notebookEngine, workspaceViewMode]);

  // Viewport-level panning: Hand tool (left button).
  //
  // These listeners belong on the `.notebook-viewport` scroll container, NOT on a page
  // canvas. Panning is a viewport concern: the gesture must work when it starts on an
  // inter-page gap, a side margin, or a page that is not the focused one. The previous
  // design bound panning to the single focused page's <canvas> inside InputManager, so a
  // drag only panned when it happened to begin inside that one rectangle — and starting
  // on a non-focused page instead triggered page activation, which tore the engine down
  // mid-gesture. The container is an ancestor of every page, gap and margin, so ordinary
  // event bubbling covers all of them with one binding (this is scoped delegation on an
  // element we already own, not a global window listener).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Anchors are captured once per gesture and each move computes an ABSOLUTE target
    // from them. Accumulating per-move deltas — and rebasing the anchor each move, as the
    // old code did — permanently discards whatever the scroller clamps at a boundary or
    // rounds off at fractional display scaling, which is what made the content lag
    // behind the cursor and stutter on scaled displays.
    let activePointerId: number | null = null;
    let releaseNavigation: (() => void) | null = null;
    let startClientX = 0;
    let startClientY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;

    const isPanGesture = (e: PointerEvent): boolean => {
      // Touch is left to the container's native scrolling; capturing it here would apply
      // the gesture twice. Touch over the focused canvas (where `touch-action: none`
      // suppresses native scrolling) is still handled by InputManager.
      if (e.pointerType === 'touch') return false;
      return e.button === 0 && notebookEngine.tools.getState().mode === 'hand';
    };

    const onPointerDown = (e: PointerEvent) => {
      if (activePointerId !== null || !isPanGesture(e)) return;

      // Suppress text selection, drag-start and focus changes for the duration
      // of the Hand drag. Middle-click is deliberately left untouched so the
      // scroll container keeps Chromium's native autoscroll, as the PDF viewer does.
      e.preventDefault();

      activePointerId = e.pointerId;
      container.dataset.panActive = 'true';
      container.dataset.panSource = 'hand';
      container.dataset.panPointer = String(e.pointerId);
      releaseNavigation = navigationGestures.begin();
      startClientX = e.clientX;
      startClientY = e.clientY;
      startScrollLeft = container.scrollLeft;
      startScrollTop = container.scrollTop;

      // Capture on the container keeps the gesture alive when the pointer moves over a
      // child, leaves the viewport, or is released outside the window.
      try {
        container.setPointerCapture(e.pointerId);
      } catch (err) {
        // Ignore DOMException if the pointer is already gone
      }
    };

    const finishGesture = (pointerId?: number, releaseCapture = true) => {
      if (activePointerId === null || (pointerId !== undefined && pointerId !== activePointerId)) return;
      const finishedPointerId = activePointerId;
      activePointerId = null;
      container.dataset.panActive = 'false';
      delete container.dataset.panSource;
      delete container.dataset.panPointer;
      if (releaseCapture) {
        try {
          if (container.hasPointerCapture(finishedPointerId)) {
            container.releasePointerCapture(finishedPointerId);
          }
        } catch (err) {
          // Ignore DOMException if capture is already lost
        }
      }
      const release = releaseNavigation;
      releaseNavigation = null;
      release?.();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointerId) return;
      // Some display/window transitions drop pointerup but still deliver a final move with
      // no button held. End the capture instead of leaving an old Hand gesture in charge of
      // later pointer events (including toolbar clicks).
      if (e.pointerType !== 'touch' && e.buttons === 0) {
        finishGesture(e.pointerId);
        return;
      }
      container.scrollLeft = startScrollLeft - (e.clientX - startClientX);
      container.scrollTop = startScrollTop - (e.clientY - startClientY);
    };

    const endGesture = (e: PointerEvent) => finishGesture(e.pointerId);
    const onLostPointerCapture = (e: PointerEvent) => finishGesture(e.pointerId, false);
    const onWindowBlur = () => finishGesture();
    const unsubscribeTools = notebookEngine.tools.subscribe((state) => {
      // A Hand gesture cannot remain authoritative after the user selects
      // another tool.
      if (state.mode !== 'hand') finishGesture();
    });

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', endGesture);
    container.addEventListener('pointercancel', endGesture);
    container.addEventListener('lostpointercapture', onLostPointerCapture);
    window.addEventListener('blur', onWindowBlur);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', endGesture);
      container.removeEventListener('pointercancel', endGesture);
      container.removeEventListener('lostpointercapture', onLostPointerCapture);
      window.removeEventListener('blur', onWindowBlur);
      unsubscribeTools();
      // If the effect is torn down mid-gesture, also release capture and flush any deferred
      // focus transfer instead of leaving either state latched.
      finishGesture();
    };
    // `activePageId` was in this dependency list but nothing in the effect reads it. Because
    // the scroll observer updates activePageId while a Hand drag is scrolling the container,
    // that dependency re-ran the effect *during* the gesture: the cleanup removed the
    // listeners and the fresh closure started with `activePointerId = null`, so the drag went
    // dead the moment it crossed a page boundary. The gesture state lives in this closure, so
    // the effect must only re-run when the engine identity changes, or when the viewport
    // element itself appears or disappears.
  }, [notebookEngine, hasActivePage, navigationGestures]);

  // The page canvas opts out of browser gestures so single-finger ink and
  // selection stay exact. Put a two-finger viewport controller on the actual
  // scroll surface so pinch/pan starts naturally on paper rather than only in
  // the surrounding margin.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let mode = notebookEngine.tools.getState().mode;
    return attachTwoFingerViewportGesture({
      target: container,
      getScale: () => notebookEngine.viewport.getState().scale,
      setScale: scale => flushSync(() => notebookEngine.viewport.setZoom(scale)),
      cancelActivePointerInteraction: () => notebookEngine.input.cancelActivePointerInteraction(),
      navigationGestures,
      subscribeCancellation: cancel => notebookEngine.tools.subscribe(state => {
        if (state.mode === mode) return;
        mode = state.mode;
        cancel();
      }),
      getContentOffset: scale => ({ x: Math.max((container.clientWidth - layoutConfig.totalWidth * scale) / 2, isMobileViewport ? 8 : 32), y: 0 }),
    });
  }, [notebookEngine, hasActivePage, layoutConfig.totalWidth, isMobileViewport, navigationGestures]);


  // Central persistence writer for drawing data. Every notebook save goes
  // through the persistence queue so a failed target lookup, a failed write,
  // and a later retry all share one ordered state machine. The queue marks a
  // revision scheduled only after the target resolves, and it keeps failed
  // immutable snapshots for automatic and lifecycle-boundary retries.
  const lastSaveErrorToastAtRef = useRef(0);
  drawingPersistenceCallbacksRef.current = {
    resolveTarget: (snapshot): DrawingSaveTarget | 'stale' | null => {
      const pageId = snapshot.saveTargetSheetId;
      const { notebookPages: allPages, notebooks: allNotebooks, workspaces: allWorkspaces } = useWorkspaceStore.getState();
      const targetPage = allPages.find(p => p.id === pageId) ?? notebookPages.find(p => p.id === pageId);
      if (!targetPage) return null;
      if (targetPage.deletedAt) return 'stale';
      const targetNotebook = allNotebooks.find(n => n.id === targetPage.notebookId) ?? notebooks.find(n => n.id === targetPage.notebookId);
      if (!targetNotebook) return null;
      if (targetNotebook.deletedAt) return 'stale';
      if (targetNotebook.id !== snapshot.documentId) return 'stale';
      const targetWorkspace = allWorkspaces.find(w => w.id === targetNotebook.workspaceId) ?? workspaces.find(w => w.id === targetNotebook.workspaceId);
      if (!targetWorkspace) return null;
      if (targetWorkspace.deletedAt) return 'stale';
      return { workspaceId: targetWorkspace.id, notebookId: targetNotebook.id };
    },
    encode: snapshot => {
      const pageId = snapshot.saveTargetSheetId;
      recordHandwritingTraceMarker('stringifyStarted', { pageId, revision: snapshot.drawingRevision });
      // Immutable snapshots retain their already computed JSON. This is the
      // same encoding sent through notebook:saveDrawing, so retries do not
      // re-serialize a multi-megabyte page while the user is drawing.
      const json = drawingSnapshotJson(snapshot.data);
      rememberDrawingSnapshotJson(snapshot.data, json);
      recordHandwritingTraceMarker('stringifyEnded', { pageId, revision: snapshot.drawingRevision });
      return json;
    },
    save: (target, data, snapshot) => pageAudioPersistence.saveDrawing({
      ...target,
      pageId: snapshot.saveTargetSheetId,
    }, data),
    onSaveStarted: snapshot => recordHandwritingTraceMarker('saveStarted', {
      pageId: snapshot.sheetId,
      revision: snapshot.drawingRevision,
    }),
    onScheduled: (snapshot) => {
      const pageId = snapshot.saveTargetSheetId;
      publishSnapshotPageData(snapshot, snapshot.data);
      recordHandwritingTraceMarker('ipcSaveStart', { pageId, revision: snapshot.drawingRevision });
    },
    onSaved: (snapshot, savedData, completion) => {
      const pageId = snapshot.saveTargetSheetId;
      recordHandwritingTraceMarker('ipcSaveEnd', { pageId, revision: snapshot.drawingRevision, ok: true });
      // The persisted result belongs to this exact snapshot. If the live
      // engine has produced a newer cache entry while the write was in
      // flight, keep that newer entry visible instead of rolling the page
      // back until the next interaction.
      publishSnapshotPageData(snapshot, savedData);
      if (!completion.latestScheduled || !completion.latestPersisted) return;
      if (focusedPageIdRef.current === pageId) notebookEngine.audio.setAll(savedData.audioNotes);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('panvas:notebook-content-changed', { detail: { pageId } }));
      }
    },
    onFailed: (snapshot, err, context) => {
      const pageId = snapshot.saveTargetSheetId;
      recordHandwritingTraceMarker('ipcSaveEnd', { pageId, revision: snapshot.drawingRevision, ok: false });
      console.error('[NotebookRenderer] drawing save failed:', err);
      const now = Date.now();
      if (now - lastSaveErrorToastAtRef.current > 10000) {
        lastSaveErrorToastAtRef.current = now;
        useUIStore.getState().showToast(
          context.willRetry
            ? 'Save failed. Your changes are kept in memory and will retry automatically.'
            : 'Save failed. Your changes are kept in memory and will retry when you edit or leave the page.',
          'error',
        );
      }
    },
    onStatus: (snapshot, status) => {
      useCanvasStore.getState().setSaveStatusForPage(snapshot.saveTargetSheetId, snapshot.sequence, status);
    },
  };
  const persistDrawing = useCallback((snapshot: PageOwnedDrawing | null) => {
    if (snapshot) drawingPersistenceRef.current?.persist(snapshot);
  }, []);
  persistDrawingRef.current = persistDrawing;

  // Debounced writes belong to immutable page snapshots, not to a particular
  // render/effect instance. Rebinding subscriptions while scrolling must not
  // discard the final sheet's pending edit. A genuine unmount flushes both
  // queues before their timers are cleared.
  useEffect(() => {
    drawingPersistenceRef.current?.setRetriesEnabled(true);
    return () => {
      const pendingProperty = pendingPropertySaveRef.current;
      pendingPropertySaveRef.current = null;
      if (propertySaveTimeoutRef.current) clearTimeout(propertySaveTimeoutRef.current);
      propertySaveTimeoutRef.current = null;
      if (pendingProperty) persistDrawingRef.current(pendingProperty);
      drawingSaveSchedulerRef.current?.flush();
      if (deferredSaveTimerRef.current) clearTimeout(deferredSaveTimerRef.current);
      for (const snapshot of deferredPageSavesRef.current.values()) persistDrawingRef.current(snapshot);
      deferredPageSavesRef.current.clear();
      // Lifecycle boundary: attempt failed snapshots immediately, then stop
      // scheduling timers so an unmounted renderer cannot retry forever.
      drawingPersistenceRef.current?.flushFailed();
      drawingPersistenceRef.current?.setRetriesEnabled(false);
    };
  }, [notebookEngine]);

  // In-Memory Section Data Cache
  const focusedPage = notebookPages.find(item => item.id === focusedPageId) ?? page;

  // Keep focusedPageId in sync when activePageId changes
  useEffect(() => {
    const targetPageId = activePageId && currentSectionPages.some(p => p.id === activePageId)
      ? activePageId
      : !focusedPageId
        ? currentSectionPages[0]?.id
        : undefined;
    // A scroll can advance the store and live owner before an older render's
    // passive effect runs. That stale snapshot must not activate the old page.
    if (!targetPageId || activePageId !== useWorkspaceStore.getState().activePageId) return;
    // Focus owns the shared engine and may only move once target data is
    // available. The section preload will update this effect when a cache gap
    // is filled; until then the existing focused page remains authoritative.
    if (sectionDataCacheRef.current[targetPageId]) {
      handleActivatePageRef.current(targetPageId);
    }
  }, [activePageId, focusedPageId, currentSectionPages, sectionDataRevision]);

  const handlePagePropertiesUpdate = useCallback((updates: Partial<PagePropertySet>, sourceTextId?: string) => {
    if (updates.layoutMode && (workspaceViewMode !== 'edit' || focusedPage?.type === 'pdf')) return;
    if (updates.layoutMode === 'document' && !sourceTextId) {
      const texts = notebookEngine.texts.getTexts();
      if (!texts.some(text => text.metadata?.documentRole === 'body' || text.metadata?.documentDormantBody) && texts.some(text => !text.metadata?.audioNoteId)) {
        sourceTextId = documentConversionSource(notebookEngine)?.id;
        if (!sourceTextId) { useUIStore.getState().showToast('Select or edit a text box to use as the document.', 'info'); return; }
      }
    }
    const previousProperties = notebookEngine.getProperties();
    if (updates.pageSize === 'Infinite' && previousProperties.pageSize !== 'Infinite') updates = { ...updates, infiniteWidth: resolveBasePageDimensions(previousProperties).width };
    const noteSpaceKeys: (keyof PagePropertySet)[] = ['extraHeight', 'extraTop', 'extraRight', 'extraBottom', 'extraLeft'];
    const isNoteSpaceChange = noteSpaceKeys.some(key => key in updates);
    const isLineColorChange = updates.ruleLineColor !== undefined;
    const changesDimensions =
      (updates.orientation !== undefined && updates.orientation !== previousProperties.orientation)
      || (updates.pageSize !== undefined && updates.pageSize !== previousProperties.pageSize)
      || isNoteSpaceChange;
    if (changesDimensions && updates.pageSize !== 'Infinite' && previousProperties.pageSize !== 'Infinite') {
      const container = containerRef.current;
      const pageId = focusedPageIdRef.current;
      const pageElement = pageId ? document.getElementById(`page-${pageId}`) : null;
      if (container && pageId && pageElement) {
        const containerRect = container.getBoundingClientRect();
        pageGeometryTransitionRef.current = {
          pageId,
          anchor: capturePageGeometryAnchor(pageElement.getBoundingClientRect(), {
            x: containerRect.left + container.clientWidth / 2,
            y: containerRect.top + container.clientHeight / 2,
          }),
        };
      }
    }
    const pageId = focusedPageIdRef.current;
    const isPaperColorOnlyChange = isPaperColorOnlyUpdate(updates);
    const applyProperties = (properties: PagePropertySet) => {
      notebookEngine.setProperties(properties, isPaperColorOnlyChange ? 'appearance' : 'user');
      setPageProperties({ ...properties });
      if (pageId) {
        updateSectionDataCache(previous => {
          const previousData = previous[pageId] || createEmptyDrawingData();
          return { ...previous, [pageId]: { ...previousData, properties: { ...properties } } };
        });
      }
      if (changesDimensions) setPageGeometryTransitionRevision(revision => revision + 1);
      if (!workspace || !notebook || !pageId) return;
      const overrides = derivePagePropertyOverrides(properties, notebook);
      useWorkspaceStore.setState(state => ({
        notebookPages: state.notebookPages.map(item => item.id === pageId
          ? { ...item, pagePropertyOverrides: overrides, updatedAt: Date.now() }
          : item),
      }));
      void notebookRepository.setPagePropertyOverrides(workspace.id, pageId, overrides).catch(error => {
        console.error('[NotebookRenderer] page-property metadata save failed:', error);
        useCanvasStore.getState().setSaveStatus('error');
        useUIStore.getState().showToast('Page properties could not be saved.', 'error');
      });
    };
    const nextProperties = { ...previousProperties, ...updates };
    if (updates.layoutMode) {
      const source = sourceTextId ? notebookEngine.texts.getTexts().find(text => text.id === sourceTextId) : undefined;
      if (source && notebookEngine.texts.getEditor(source.id)?.view.composing) {
        useUIStore.getState().showToast('Finish the current text composition before converting.', 'info');
        return;
      }
      if (sourceTextId && (!source || Number(source.metadata?.richTextSchemaVersion ?? 1) > NOTEBOOK_RICH_TEXT_SCHEMA_VERSION || unsupportedNotebookContent(source.content, getNotebookSchema()).length)) {
        useUIStore.getState().showToast('This text requires a compatible Panvas version. Its original content is protected.', 'info');
        return;
      }
      const transition = createDocumentLayoutTransition(notebookEngine, updates.layoutMode, properties => {
        setActiveEditor(null);
        applyProperties(properties);
        if (properties.layoutMode === 'document' && pageId) {
          notebookEngine.tools.setMode('text');
          useUIStore.getState().setDocumentFocusPageId(pageId);
        }
      }, sourceTextId);
      if (transition) { notebookEngine.history.push(transition); return; }
      if (sourceTextId) { useUIStore.getState().showToast('Select an editable text box on a Freeform page to convert.', 'info'); return; }
      if (Object.keys(updates).length === 1 && updates.layoutMode === (previousProperties.layoutMode ?? 'freeform')) return;
    }
    if (isNoteSpaceChange || isLineColorChange) {
      notebookEngine.history.push({
        description: isNoteSpaceChange ? 'Change research space' : 'Change line color',
        execute: () => applyProperties(nextProperties),
        undo: () => applyProperties(previousProperties),
      });
    } else applyProperties(nextProperties);
  }, [notebookEngine, notebook, workspace, updateSectionDataCache, workspaceViewMode, focusedPage?.type]);

  const getConversionText = useCallback(() => {
    return documentConversionSource(notebookEngine);
  }, [notebookEngine]);
  const handleConvertText = useCallback(() => {
    const source = getConversionText();
    if (source) handlePagePropertiesUpdate({ layoutMode: 'document' }, source.id);
  }, [getConversionText, handlePagePropertiesUpdate]);

  const handleApplyPropertiesToAll = useCallback(async (updates: Partial<PagePropertySet>) => {
    if (!workspace || !notebook) throw new Error('No active notebook.');
    const previousProperties = notebookEngine.getProperties();
    const changesDimensions =
      (updates.orientation !== undefined && updates.orientation !== previousProperties.orientation)
      || (updates.pageSize !== undefined && updates.pageSize !== previousProperties.pageSize);
    if (changesDimensions) {
      const container = containerRef.current;
      const pageId = focusedPageIdRef.current;
      const pageElement = pageId ? document.getElementById(`page-${pageId}`) : null;
      if (container && pageId && pageElement) {
        const containerRect = container.getBoundingClientRect();
        pageGeometryTransitionRef.current = {
          pageId,
          anchor: capturePageGeometryAnchor(pageElement.getBoundingClientRect(), {
            x: containerRect.left + container.clientWidth / 2,
            y: containerRect.top + container.clientHeight / 2,
          }),
        };
      }
    }
    const snapshot = await notebookRepository.applyPageDefaults(workspace.id, notebook.id, updates);
    const changedKeys = Object.keys(updates) as (keyof PagePropertySet)[];
    useWorkspaceStore.setState(state => ({
      notebooks: state.notebooks.map(item => item.id === notebook.id
        ? { ...item, defaultPageProperties: { ...getNotebookPageDefaults(item), ...updates }, updatedAt: Date.now() }
        : item),
      notebookPages: state.notebookPages.map(item => {
        if (item.notebookId !== notebook.id || item.deletedAt || item.type === 'pdf') return item;
        const overrides = { ...(item.pagePropertyOverrides ?? {}) } as Record<string, unknown>;
        for (const key of changedKeys) delete overrides[key];
        return { ...item, pagePropertyOverrides: overrides, updatedAt: Date.now() };
      }),
    }));
    updateSectionDataCache(previous => Object.fromEntries(Object.entries(previous).map(([id, data]) => [
      id,
      { ...data, properties: { ...data.properties, ...updates } },
    ])));
    notebookEngine.setProperties(updates, isPaperColorOnlyUpdate(updates) ? 'appearance' : 'user');
    setPageProperties(prev => ({ ...prev, ...updates }));
    if (changesDimensions) setPageGeometryTransitionRevision(revision => revision + 1);
    return snapshot;
  }, [notebookEngine, notebook, workspace, updateSectionDataCache]);

  const handleRestorePropertiesBatch = useCallback(async (snapshot: NotebookPropertyBatchSnapshot) => {
    if (!workspace) throw new Error('No active workspace.');
    await notebookRepository.restorePageDefaults(workspace.id, snapshot);
    const restoredPages = new Map(snapshot.pages.map(entry => [entry.pageId, entry.overrides]));
    useWorkspaceStore.setState(state => ({
      notebooks: state.notebooks.map(item => item.id === snapshot.notebookId
        ? { ...item, defaultPageProperties: { ...snapshot.defaultPageProperties }, updatedAt: Date.now() }
        : item),
      notebookPages: state.notebookPages.map(item => restoredPages.has(item.id)
        ? { ...item, pagePropertyOverrides: { ...restoredPages.get(item.id) }, updatedAt: Date.now() }
        : item),
    }));
    updateSectionDataCache(previous => Object.fromEntries(Object.entries(previous).map(([id, data]) => {
      const overrides = restoredPages.get(id);
      return [id, overrides === undefined ? data : {
        ...data,
        properties: { ...snapshot.defaultPageProperties, ...overrides },
      }];
    })));
    const focusedOverrides = restoredPages.get(focusedPageIdRef.current);
    if (focusedOverrides !== undefined) {
      notebookEngine.setProperties({ ...snapshot.defaultPageProperties, ...focusedOverrides });
    }
  }, [notebookEngine, workspace, updateSectionDataCache]);

  // Preload section drawing data into memory cache when section changes
  useEffect(() => {
    if (!workspace || !notebook || currentSectionPages.length === 0) return;
    let mounted = true;

    async function preloadSection() {
      const entries = await Promise.all(
        currentSectionPages.map(async (p) => {
          const d = await notebookRepository.loadDrawingData(workspace!.id, notebook!.id, p.id);
          const loaded = (d || createEmptyDrawingData()) as DrawingData;
          const data = { ...loaded, properties: resolvePageProperties(notebook, p, loaded.properties) };
          return [p.id, data] as const;
        })
      );
      if (!mounted) return;
      const map: Record<string, DrawingData> = {};
      for (const [id, d] of entries) {
        map[id] = d;
        // Repository data has no engine revision; a later save from a new
        // engine must replace it rather than matching a stale page revision.
        delete sectionDataRevisionRef.current[id];
      }
      updateSectionDataCache(prev => mergeLoadedPageData(prev, map));
    }

    preloadSection();
    return () => { mounted = false; };
  }, [workspace?.id, notebook?.id, activeNotebookSectionId, currentSectionPageIdsKey, updateSectionDataCache]);

  // Sync focused page data with notebookEngine
  useEffect(() => {
    if (!focusedPageId || !workspace || !notebook) return;
    let cancelled = false;
    const requestedPageId = focusedPageId;
    // handleActivatePage binds cached data synchronously before React commits
    // focusedPageId. Re-applying that pre-edit cache from this passive effect can
    // erase a stroke made immediately after a fast scroll/focus transfer.
    if (notebookEngine.getDrawingOwnership().pageId === requestedPageId) return;
    const requestGeneration = ++focusedPageLoadGenerationRef.current;
    const cachedData = sectionDataCacheRef.current[requestedPageId];
    if (cachedData) {
      if (!mayApplyPageLoadToEngine(
        requestedPageId,
        focusedPageIdRef.current,
        requestGeneration,
        focusedPageLoadGenerationRef.current,
      )) return;
      handleActivatePageRef.current(requestedPageId);
    } else {
      notebookRepository.loadDrawingData(workspace.id, notebook.id, requestedPageId).then(loaded => {
        if (cancelled) return;
        const raw = (loaded || createEmptyDrawingData()) as DrawingData;
        const pageMetadata = notebookPages.find(item => item.id === requestedPageId);
        const d = { ...raw, properties: resolvePageProperties(notebook, pageMetadata, raw.properties) };
        updateSectionDataCache(prev => prev[requestedPageId] ? prev : { ...prev, [requestedPageId]: d });
        if (!mayApplyPageLoadToEngine(
          requestedPageId,
          focusedPageIdRef.current,
          requestGeneration,
          focusedPageLoadGenerationRef.current,
        )) return;
        handleActivatePageRef.current(requestedPageId);
      });
    }
    return () => { cancelled = true; };
  }, [focusedPageId, workspace?.id, notebook?.id, notebookEngine, notebookPages, updateSectionDataCache]);

  // Safe Autosave: debounced write strictly on user drawing actions
  useEffect(() => {
    const onUserDrawingAction = (reason?: 'document-text') => {
      const currentPageId = focusedPageIdRef.current;
      if (!currentPageId) return;
      const { notebookPages: allPages } = useWorkspaceStore.getState();
      const pageOwner = allPages.find(p => p.id === currentPageId);
      if (!pageOwner || (notebook && pageOwner.notebookId !== notebook.id)) return;
      recordHandwritingTraceMarker('snapshot/captureStarted', { pageId: currentPageId });
      const pageOwnedSnapshot = captureEngineOwnedDrawing(notebookEngine, notebook?.id, currentPageId);
      recordHandwritingTraceMarker('snapshot/captureEnded', {
        pageId: currentPageId,
        revision: pageOwnedSnapshot?.drawingRevision,
      });
      if (!pageOwnedSnapshot) return;
      latestCapturedDrawingRef.current.set(currentPageId, pageOwnedSnapshot);
      sectionDataRevisionRef.current[currentPageId] = pageOwnedSnapshot.drawingRevision;
      // Capture and enqueue every document edit synchronously. Its live editor
      // owns the DOM; publishing identical geometry would rerender the whole
      // notebook per keystroke. Properties, save completion and handoff publish.
      updateSectionDataCache(prev => prev[currentPageId] === pageOwnedSnapshot.data
        ? prev
        : { ...prev, [currentPageId]: pageOwnedSnapshot.data }, false);
      drawingSaveSchedulerRef.current?.enqueue(pageOwnedSnapshot);
    };

    const unsubscribe = notebookEngine.onSceneMutation(onUserDrawingAction);

    return () => {
      unsubscribe();
    };
  }, [notebookEngine, notebook?.id, updateSectionDataCache]);

  useEffect(() => {
    const unsubscribe = notebookEngine.onDrawingGestureLifecycle(active => {
      drawingGestureActiveRef.current = active;
      setDrawingGestureActive(notebookEngine, active);
      recordHandwritingTraceMarker(active ? 'penDown' : 'penUp');
      syncSaveGestureActive();
      if (!active && pendingActivationPageIdRef.current) {
        const deferredTargetId = pendingActivationPageIdRef.current;
        pendingActivationPageIdRef.current = null;
        handleActivatePageRef.current(deferredTargetId);
      }
      if (!active && pendingSectionPublishRef.current) {
        pendingSectionPublishRef.current = false;
        setSectionDataRevision(revision => revision + 1);
      }
    });
    return () => {
      unsubscribe();
      drawingGestureActiveRef.current = false;
      setDrawingGestureActive(notebookEngine, false);
      syncSaveGestureActive();
      pendingActivationPageIdRef.current = null;
    };
  }, [notebookEngine, syncSaveGestureActive]);

  // NOTE: no early return may be placed above this point, and none between here and the JSX.
  // Seventeen hooks are declared below, so bailing out early changes the hook count for the
  // render and React throws "Rendered fewer hooks than during the previous render", tearing
  // down the whole subtree. The `if (!activePageId) return null` guard that used to sit here
  // now lives immediately before the JSX return. Same defect class as the conditional hook
  // already fixed in FloatingTextEditor.
  const currentPageIndex = currentSectionPages.findIndex(p => p.id === activePageId);
  const totalPages = currentSectionPages.length;

  // Keep track of activePageId for asynchronous scroll/pointer callbacks
  const currentActivePageIdRef = useRef(activePageId);
  currentActivePageIdRef.current = activePageId;
  const isNavigatingRef = useRef<boolean>(false);
  const lastNavigatedPageIdRef = useRef<string>('');

  const flushOwnedPageDrawing = useCallback((pageId: string) => {
    // Complete the outgoing gesture before consulting Stage C's revision-keyed capture.
    if (notebookEngine.getDrawingOwnership().pageId === pageId) notebookEngine.input.flushPendingErasing();
    const owner = notebookEngine.getDrawingOwnership();
    const latest = latestCapturedDrawingRef.current.get(pageId);
    const snapshot = latest && latest.drawingRevision === owner.revision
      ? latest
      : captureEngineOwnedDrawing(notebookEngine, notebook?.id, pageId);
    if (snapshot && drawingSaveSchedulerRef.current?.peek()?.sheetId === pageId) drawingSaveSchedulerRef.current.clear();
    persistDrawing(snapshot);
  }, [notebook?.id, notebookEngine, persistDrawing]);

  // Flush any pending drawing changes immediately
  const flushActivePageDrawing = useCallback(() => {
    const pageId = focusedPageIdRef.current;
    if (pageId) flushOwnedPageDrawing(pageId);
  }, [flushOwnedPageDrawing]);

  // Handle immediate page activation on pointerdown or click without jumping the view
  const handleActivatePage = useCallback((targetPageId: string, recordOpen = true) => {
    // Any explicit activation supersedes a passive scroll handoff that has not
    // fired yet. The pending page is no longer the user's current target.
    if (passiveActivationTimerRef.current !== null) {
      clearTimeout(passiveActivationTimerRef.current);
      passiveActivationTimerRef.current = null;
    }
    pendingPassiveActivationRef.current = null;
    // Central protection covers scroll observation, active-page synchronization,
    // direct navigation, and late cache/load arrivals. Queue even the current
    // page: returning to A must replace an earlier pending request for B.
    if (navigationGestures.active) {
      pendingFocusPageIdRef.current = targetPageId;
      return;
    }
    pendingFocusPageIdRef.current = null;
    const activationStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    if (targetPageId === focusedPageIdRef.current && notebookEngine.getDrawingOwnership().pageId === targetPageId) return;

    const activeMemoryData = latestCapturedDrawingRef.current.get(targetPageId)?.data
      ?? deferredPageSavesRef.current.get(targetPageId)?.data;
    if (activeMemoryData) {
      const cached = sectionDataCacheRef.current[targetPageId];
      // The cache entry refreshed at the previous handoff is at least as new as
      // an earlier mutation capture. Keep its identity when the page-owned
      // preview already represents it, so the incoming mount can adopt those
      // pixels instead of replaying the scene. A larger memory snapshot still
      // wins, preserving the recovery path for pages missing cached objects.
      const previewCurrent = Boolean(cached
        && residentDrawingEnginesRef.current.get(targetPageId)?.isSurfaceCurrent(cached));
      if (!cached || (!previewCurrent
        && (activeMemoryData.objects?.length ?? 0) >= (cached.objects?.length ?? 0))) {
        sectionDataCacheRef.current[targetPageId] = activeMemoryData;
      }
    }

    const incomingData = sectionDataCacheRef.current[targetPageId];
    if (!incomingData) {
      // Never install an empty placeholder into the shared engine for a page
      // that may have persisted objects. Mark it active and let the existing
      // section preload fill this page-ID cache gap before transferring focus.
      // Scroll observation already publishes the passive activation, so only
      // call the store when it is actually behind (explicit pointer activation).
      if (useWorkspaceStore.getState().activePageId !== targetPageId) setActivePage(targetPageId, recordOpen);
      return;
    }

    // Mutations already captured an immutable, page-owned snapshot. Transfer
    // the scheduler's single pending slot to a page-keyed task queue, so an edit
    // on B cannot overwrite A's pending save. Keep the lifecycle fallback for
    // an uncaptured revision; never trade persistence safety for smooth scroll.
    const outgoingPageId = focusedPageIdRef.current;
    if (outgoingPageId) {
      updateSectionDataCache(current => current, true);
      notebookEngine.input.flushPendingErasing();
      const owner = notebookEngine.getDrawingOwnership();
      const latest = latestCapturedDrawingRef.current.get(outgoingPageId);
      if (latest && latest.drawingRevision === owner.revision) {
        if (drawingSaveSchedulerRef.current?.peek()?.sheetId === outgoingPageId) drawingSaveSchedulerRef.current.clear();
        if (drawingPersistenceRef.current?.getScheduledSequence(outgoingPageId) !== latest.sequence) {
          deferredPageSavesRef.current.set(outgoingPageId, latest);
          if (deferredSaveTimerRef.current === null) deferredSaveTimerRef.current = setTimeout(() => {
            deferredSaveTimerRef.current = null;
            const pending = [...deferredPageSavesRef.current.values()];
            deferredPageSavesRef.current.clear();
            for (const snapshot of pending) persistDrawingRef.current(snapshot);
          }, 0);
        }
      } else if (owner.revision !== loadedSceneRevisionRef.current) {
        flushOwnedPageDrawing(outgoingPageId);
      }
    }

    // The previous page's FloatingTextEditor is about to unmount. Its TipTap
    // instance must not remain as the toolbar target while the new page mounts.
    // The next focused editor registers itself through its existing onFocus path.
    setActiveEditor(null);

    // 2. Load the already page-ID-resolved data synchronously. Load-originated
    // history/property notifications carry the engine's new owner and cannot be
    // mistaken for edits to either the outgoing or incoming sheet.
    // React may defer its commit. Reveal the page-owned backing before the
    // engine detaches/clears its old interaction canvas, even in that interval.
    const oldCanvas = notebookEngine.drawing.getCanvasElement();
    const oldSlot = oldCanvas?.closest('[data-page-id]');
    if (outgoingPageId && notebookEngine.getDrawingOwnership().pageId === outgoingPageId) {
      if (notebookEngine.getDrawingOwnership().revision !== loadedSceneRevisionRef.current) {
        sectionDataCacheRef.current[outgoingPageId] = notebookEngine.getDrawingData();
        sectionDataRevisionRef.current[outgoingPageId] = notebookEngine.getDrawingOwnership().revision;
      }
    }
    const outgoingDrawing = outgoingPageId ? residentDrawingEnginesRef.current.get(outgoingPageId) : undefined;
    const outgoingData = outgoingPageId ? sectionDataCacheRef.current[outgoingPageId] : undefined;
    // Copy the focused live surfaces into the outgoing page-owned preview
    // before unmount clears them. Unlike the DOM fallback below this also
    // preserves every layer canvas. When the preview already represents the
    // outgoing payload, skip the blit: during pure scrolling the live surface
    // was itself adopted from that preview, so a copy would only resample the
    // same pixels and queue another GPU raster.
    const previewCurrent = Boolean(outgoingDrawing && outgoingData
      && outgoingDrawing.isSurfaceCurrent(outgoingData));
    const previewCopied = previewCurrent || Boolean(outgoingDrawing && outgoingData
      && notebookEngine.drawing.copySurfacesTo(outgoingDrawing, outgoingData));
    if (oldSlot?.getAttribute('data-page-id') === outgoingPageId) {
      const backing = oldSlot.querySelector<HTMLElement>('[data-stable-page-visual]');
      const interaction = oldSlot.querySelector<HTMLElement>('[data-live-page-visual]');
      if (!previewCopied && backing && oldCanvas) {
        const backingCanvas = backing.querySelector<HTMLCanvasElement>('canvas[data-committed-page-id]');
        if (backingCanvas && backingCanvas.width > 0 && backingCanvas.height > 0) {
          const backingCtx = backingCanvas.getContext('2d');
          if (backingCtx) {
            backingCtx.clearRect(0, 0, backingCanvas.width, backingCanvas.height);
            backingCtx.drawImage(oldCanvas, 0, 0);
          }
        }
      }
      if (backing) backing.style.visibility = 'visible';
      if (interaction) interaction.style.visibility = 'hidden';
    }
    if (outgoingPageId) residentDrawingEnginesRef.current.get(outgoingPageId)?.retainStrokePaths(notebookEngine.drawing);
    notebookEngine.unmount();
    const incomingImages = residentImageManagersRef.current.get(targetPageId);
    if (incomingImages) notebookEngine.images.adoptDecodedImages(incomingImages,
      (incomingData.objects ?? []).filter(object => object.type === 'image').map(object => object.fileId));
    const incomingDrawing = residentDrawingEnginesRef.current.get(targetPageId);
    notebookEngine.setDrawingData(incomingData, targetPageId, incomingDrawing);
    // Offer the incoming page-owned preview to the live canvas mount so the
    // focus handoff does not replay the whole scene behind React's commit.
    if (incomingDrawing) notebookEngine.drawing.prepareSurfaceAdoption(incomingDrawing, incomingData);
    if (incomingDrawing) {
      residentDrawingEnginesRef.current.delete(targetPageId);
      residentDrawingEnginesRef.current.set(targetPageId, incomingDrawing);
    }
    loadedSceneRevisionRef.current = notebookEngine.getDrawingOwnership().revision;
    sectionDataRevisionRef.current[targetPageId] = loadedSceneRevisionRef.current;
    focusedPageIdRef.current = targetPageId;

    // 3. Switch focusedPageId & activePageId. Passive scroll has already
    // published activePageId (with recordOpen=false), so avoid a duplicate
    // store write that would rerender every store subscriber and repeat the
    // last-opened IPC update for the same page.
    setFocusedPageId(targetPageId);
    if (useWorkspaceStore.getState().activePageId !== targetPageId) setActivePage(targetPageId, recordOpen);
    if (activationStartedAt) gate0Profiler.event('page-focus-transfer', performance.now() - activationStartedAt, { targetPageId });
  }, [flushOwnedPageDrawing, notebookEngine, setActivePage, navigationGestures]);

  handleActivatePageRef.current = handleActivatePage;

  const [residentIds, setResidentIds] = useState(() => residentPageIds(
    layoutConfig.positions, 0, containerSize.height / viewport.scale,
  ));
  const residentIdsRef = useRef(residentIds);

  // Real-time visible page detection on vertical scroll (Passive Observational Update)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let scrollRafId: number | null = null;
    let scrollSaveReleaseTimer: ReturnType<typeof setTimeout> | null = null;

    const holdSaveDuringScroll = () => {
      if (!scrollGestureActiveRef.current) {
        scrollGestureActiveRef.current = true;
        syncSaveGestureActive();
      }
      if (scrollSaveReleaseTimer !== null) clearTimeout(scrollSaveReleaseTimer);
      scrollSaveReleaseTimer = setTimeout(() => {
        scrollSaveReleaseTimer = null;
        scrollGestureActiveRef.current = false;
        syncSaveGestureActive();
      }, 160);
    };

    const updateResidency = (top: number, height: number) => {
      const previous = residentIdsRef.current;
      const next = reuseResidentPageIds(previous, residentPageIds(layoutConfig.positions, top, height));
      if (next === previous) return;
      residentIdsRef.current = next;
      setResidentIds(next);
    };

    // Focus has to follow the dominant page. `focusedPageId` decides which page
    // owns the live engine canvas and the interactive FloatingTextEditor nodes;
    // every other page renders a `pointer-events-none` StaticTextPreview over a
    // `pointer-events-none` canvas, so it has no interactive text DOM at all.
    // Run that transfer once scrolling settles instead of at every intermediate
    // boundary. Pointer activation and direct navigation cancel this pending
    // handoff synchronously through handleActivatePage.
    const runPassiveActivation = () => {
      passiveActivationTimerRef.current = null;
      const pendingPageId = pendingPassiveActivationRef.current;
      pendingPassiveActivationRef.current = null;
      if (!pendingPageId) return;
      if (pendingPageId === currentActivePageIdRef.current) return;
      const dominantPage = currentSectionPages.find(page => page.id === pendingPageId);
      if (!dominantPage || dominantPage.type === 'pdf') return;
      currentActivePageIdRef.current = dominantPage.id;
      startTransition(() => {
        if (useWorkspaceStore.getState().activePageId !== dominantPage.id) setActivePage(dominantPage.id, false);
        handleActivatePageRef.current(dominantPage.id, false);
      });
    };
    const armPassiveActivation = () => {
      if (passiveActivationTimerRef.current !== null) clearTimeout(passiveActivationTimerRef.current);
      passiveActivationTimerRef.current = setTimeout(runPassiveActivation, 140);
    };
    const schedulePassiveActivation = (dominantPage: (typeof currentSectionPages)[number]) => {
      pendingPassiveActivationRef.current = dominantPage.id;
      armPassiveActivation();
    };

    const observeScroll = () => {
      const scrollStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
      let geometryReads = 0;
      if (!container) return;

      const scale = notebookEngine.viewport.getState().scale;
      const top = container.scrollTop / scale;
      const height = container.clientHeight / scale;
      updateResidency(top, height);
      const dominantId = dominantPageId(layoutConfig.positions, top + height / 2,
        currentActivePageIdRef.current || '', 24 / scale);
      const dominantPage = currentSectionPages.find(page => page.id === dominantId);

      if (isNavigatingRef.current || pageGeometryTransitionRef.current) return;
      if (notebookEngine.getProperties().pageSize === 'Infinite') return;
      if (notebookEngine.getProperties().layoutMode === 'document' && drawingGestureActiveRef.current) return;
      // Caret scrolling and reflow must not replace the editor's page. This
      // applies to freeform text as well as the flowing document body.
      const textId = notebookEngine.texts.getActiveTextId();
      const textEditor = textId && notebookEngine.texts.getEditor(textId);
      const editingControl = document.activeElement?.closest<HTMLElement>('[data-document-editor]');
      if (textEditor?.view.dom.isConnected && (textEditor.isFocused || textEditor.view.dom.contains(document.activeElement)
        || editingControl?.dataset.documentEditor === textId)) return;

      if (dominantPage && dominantPage.id !== currentActivePageIdRef.current) {
        if (dominantPage.type === 'pdf') {
          // Never allow passive scroll over a PDF preview in NotebookRenderer to hijack activePageId!
          return;
        }
        currentActivePageIdRef.current = dominantPage.id;
        // Suppresses the scroll-to-page layout effect below, which is only meant to react
        // to sidebar/navigator navigation, not to the user's own scrolling.
        lastNavigatedPageIdRef.current = dominantPage.id;
        // Passive scroll must not repeat the last-opened IPC/database write on
        // every page boundary. Explicit pointer/sidebar activation still records.
        // Coalesce the handoff itself until motion settles: committing a focus
        // transfer at every intermediate boundary rerenders the notebook subtree
        // while the user is still scrolling past those pages.
        schedulePassiveActivation(dominantPage);
      }
      if (scrollStartedAt) gate0Profiler.event('notebook-scroll-handler', performance.now() - scrollStartedAt, {
        pages: currentSectionPages.length,
        geometryReads,
      });
    };

    let savePositionTimeout: ReturnType<typeof setTimeout> | null = null;
    const persistPositionDebounced = () => {
      if (savePositionTimeout !== null) clearTimeout(savePositionTimeout);
      savePositionTimeout = setTimeout(() => {
        savePositionTimeout = null;
        if (notebook?.id && currentActivePageIdRef.current) {
          saveNotebookPosition(notebook.id, {
            pageId: currentActivePageIdRef.current,
            scrollX: container.scrollLeft,
            scrollY: container.scrollTop,
          });
        }
      }, 250);
    };

    const flushPendingPosition = () => {
      if (savePositionTimeout !== null) {
        clearTimeout(savePositionTimeout);
        savePositionTimeout = null;
        if (notebook?.id && currentActivePageIdRef.current) {
          saveNotebookPosition(notebook.id, {
            pageId: currentActivePageIdRef.current,
            scrollX: container.scrollLeft,
            scrollY: container.scrollTop,
          });
        }
      }
    };

    const onScroll = () => {
      holdSaveDuringScroll();
      persistPositionDebounced();
      // Keep deferring while wheel/touch motion continues. The handoff runs
      // after the last scroll event, not between two pages the user is passing.
      if (pendingPassiveActivationRef.current) armPassiveActivation();
      if (scrollRafId !== null) return;
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        observeScroll();
      });
    };
    const flushScroll = () => {
      if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
      observeScroll();
      if (pendingPassiveActivationRef.current) runPassiveActivation();
      flushPendingPosition();
    };
    flushNavigationScrollRef.current = flushScroll;

    updateResidency(container.scrollTop / viewport.scale, container.clientHeight / viewport.scale);
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (flushNavigationScrollRef.current === flushScroll) flushNavigationScrollRef.current = () => {};
      container.removeEventListener('scroll', onScroll);
      if (scrollRafId !== null) {
        cancelAnimationFrame(scrollRafId);
      }
      if (passiveActivationTimerRef.current !== null) {
        clearTimeout(passiveActivationTimerRef.current);
        passiveActivationTimerRef.current = null;
      }
      if (scrollSaveReleaseTimer !== null) {
        clearTimeout(scrollSaveReleaseTimer);
        scrollSaveReleaseTimer = null;
      }
      if (scrollGestureActiveRef.current) {
        scrollGestureActiveRef.current = false;
        syncSaveGestureActive();
      }
      pendingPassiveActivationRef.current = null;
      flushPendingPosition();
    };
  }, [currentSectionPages, setActivePage, layoutConfig.positions, viewport.scale, containerSize.height, notebookEngine, syncSaveGestureActive]);

  // Scroll to active page when activePageId changes from sidebar/navigator clicks
  useLayoutEffect(() => {
    if (!sectionAppearanceReady) return;
    if (!activePageId || activePageId === lastNavigatedPageIdRef.current) return;

    if (drawingGestureActiveRef.current) {
      pendingActivationPageIdRef.current = activePageId;
      return;
    }

    handleActivatePage(activePageId);

    const isDrawingActive = drawingGestureActiveRef.current || isDrawingRecentlyActive(2000);

    const scrollToTarget = () => {
      if (isDrawingActive) {
        lastNavigatedPageIdRef.current = activePageId;
        return true;
      }

      const pageElem = document.getElementById(`page-${activePageId}`);
      const container = containerRef.current;
      if (!container) return false;

      if (pageElem) {
        const containerRect = container.getBoundingClientRect();
        const pageRect = pageElem.getBoundingClientRect();
        const relativeTop = pageRect.top - containerRect.top;
        const relativeBottom = pageRect.bottom - containerRect.top;

        // If the page element is already fully or comfortably visible in the viewport,
        // avoid instant scroll snap so we don't jump 400px and push lines off-screen.
        const isComfortablyVisible = relativeTop >= -24 && relativeBottom <= containerRect.height + 60;
        const pageOutsideHorizontalViewport = pageRect.left < containerRect.left || pageRect.right > containerRect.right;

        if (isComfortablyVisible && !pageOutsideHorizontalViewport) {
          lastNavigatedPageIdRef.current = activePageId;
          return true;
        }

        const savedPosition = notebook?.id && initialRestoredNotebookRef.current !== notebook.id
          ? getNotebookPosition(notebook.id)
          : null;
        if (savedPosition && savedPosition.pageId === activePageId) {
          initialRestoredNotebookRef.current = notebook?.id ?? null;
          const targetScrollLeft = typeof savedPosition.scrollX === 'number' ? savedPosition.scrollX : container.scrollLeft;
          const targetScrollTop = typeof savedPosition.scrollY === 'number' ? savedPosition.scrollY : (container.scrollTop + relativeTop - 24);
          isNavigatingRef.current = true;
          container.scrollTo({ left: targetScrollLeft, top: Math.max(0, targetScrollTop), behavior: 'instant' });
          lastNavigatedPageIdRef.current = activePageId;
          setTimeout(() => {
            isNavigatingRef.current = false;
          }, 150);
          return true;
        }

        const targetScrollLeft = pageOutsideHorizontalViewport
          ? Math.max(0, container.scrollLeft + pageRect.left - containerRect.left - (container.clientWidth - pageRect.width) / 2)
          : container.scrollLeft;
        const targetScrollTop = container.scrollTop + relativeTop - 24;

        isNavigatingRef.current = true;
        container.scrollTo({ left: targetScrollLeft, top: Math.max(0, targetScrollTop), behavior: 'instant' });
        lastNavigatedPageIdRef.current = activePageId;
        setTimeout(() => {
          isNavigatingRef.current = false;
        }, 150);
        return true;
      } else {
        const pos = layoutConfig.positions.find(p => p.id === activePageId);
        if (pos && container) {
          const targetScrollTop = Math.max(0, pos.y * viewport.scale - 24);
          const targetScrollLeft = spreadMode
            ? Math.max(0, pos.x * viewport.scale - (container.clientWidth - pos.width * viewport.scale) / 2)
            : container.scrollLeft;
          isNavigatingRef.current = true;
          container.scrollTo({ left: targetScrollLeft, top: targetScrollTop, behavior: 'instant' });
          lastNavigatedPageIdRef.current = activePageId;
          setTimeout(() => {
            isNavigatingRef.current = false;
          }, 150);
          return true;
        }
      }
      return false;
    };

    if (!scrollToTarget()) {
      const raf = requestAnimationFrame(() => {
        scrollToTarget();
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [activePageId, currentSectionPages, handleActivatePage, layoutConfig.positions, sectionAppearanceReady, spreadMode, viewport.scale]);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
    hasSelection: false,
    isTextEditing: false,
    canUndo: false,
    canRedo: false,
    canConvertHandwriting: false,
  });
  useEffect(() => { setContextMenu(previous => ({ ...previous, isOpen: false, editor: null })); }, [activePageId]);

  // Sensible position for pasted content (viewport center on focused/active page)
  const getSensiblePastePosition = useCallback((contentWidth = 300, contentHeight = 100): { x: number; y: number } => {
    const container = containerRef.current;
    const targetPageId = focusedPageId || activePageId;
    const pageElem = targetPageId ? document.getElementById(`page-${targetPageId}`) : null;
    
    if (!container || !pageElem) {
      return {
        x: Math.max(20, Math.round((paperDimensions.width - contentWidth) / 2)),
        y: Math.max(20, Math.round(paperDimensions.height / 3))
      };
    }

    const pageRect = pageElem.getBoundingClientRect();
    const viewportRect = container.getBoundingClientRect();

    const visibleTop = Math.max(pageRect.top, viewportRect.top);
    const visibleBottom = Math.min(pageRect.bottom, viewportRect.bottom);
    
    let pageCenterY = paperDimensions.height / 3;
    if (visibleBottom > visibleTop) {
      const visibleCenterY = (visibleTop + visibleBottom) / 2;
      pageCenterY = (visibleCenterY - pageRect.top) / (viewport.scale || 1) + (targetPageId ? logicalScrollBases[targetPageId] ?? 0 : 0);
    }

    const x = Math.max(20, Math.min(paperDimensions.width - contentWidth - 20, Math.round((paperDimensions.width - contentWidth) / 2)));
    const y = Math.max(20, Math.min(paperDimensions.height - contentHeight - 20, Math.round(pageCenterY - contentHeight / 2)));

    return { x, y };
  }, [focusedPageId, activePageId, paperDimensions, viewport.scale, logicalScrollBases]);

  // Sticky notes use the existing text/selection/persistence pipeline. The
  // toolbar and slash menu intentionally communicate through a narrow DOM
  // event so neither surface needs to know about page storage internals.
  useEffect(() => {
    const createSticky = () => {
      if (!notebookEngine.drawing.canEditActiveLayer()) return;
      const targetPageId = focusedPageIdRef.current || activePageId;
      if (!targetPageId) return;

      const position = getSensiblePastePosition(STICKY_NOTE_WIDTH, STICKY_NOTE_MIN_HEIGHT);
      const sticky = createStickyNote({
        id: generateId('txt'),
        x: position.x,
        y: position.y,
      });

      const insert = () => {
        if (!notebookEngine.texts.getTexts().some(text => text.id === sticky.id)) {
          notebookEngine.texts.addText(sticky);
        }
        setTextObjects([...notebookEngine.texts.getTexts()]);
        notebookEngine.selection.clearSelection();
        notebookEngine.selection.selectAt(sticky.x + 10, sticky.y + 10, false);
        notebookEngine.tools.setMode('text');
        notebookEngine.drawing.redraw();
      };

      insert();
      notebookEngine.history.pushExecuted({
        description: 'Create sticky note',
        execute: insert,
        undo: () => {
          notebookEngine.texts.removeText(sticky.id);
          notebookEngine.selection.clearSelection();
          setTextObjects([...notebookEngine.texts.getTexts()]);
          notebookEngine.drawing.redraw();
        },
      });
      persistDrawing(captureEngineOwnedDrawing(notebookEngine, notebook?.id, targetPageId));
    };

    const persistStickyChange = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (!id || !notebookEngine.texts.getTexts().some(text => text.id === id)) return;
      setTextObjects([...notebookEngine.texts.getTexts()]);
      const targetPageId = focusedPageIdRef.current || activePageId;
      if (targetPageId) persistDrawing(captureEngineOwnedDrawing(notebookEngine, notebook?.id, targetPageId));
    };

    document.addEventListener('panvas:create-sticky-note', createSticky);
    document.addEventListener('panvas:sticky-note-changed', persistStickyChange);
    return () => {
      document.removeEventListener('panvas:create-sticky-note', createSticky);
      document.removeEventListener('panvas:sticky-note-changed', persistStickyChange);
    };
  }, [activePageId, getSensiblePastePosition, notebookEngine, persistDrawing]);

  // Import image (used by drag-and-drop and clipboard paste)
  const importImage = useCallback(async (file: File, clientX?: number, clientY?: number) => {
    if (!notebookEngine.drawing.canEditActiveLayer()) return;
    const targetPageId = focusedPageId || activePageId;
    if (!targetPageId) return;

    const reader = new FileReader();
    reader.onload = async (re) => {
      const buffer = re.target?.result as ArrayBuffer;
      if (!buffer) return;

      try {
        const { canvasRepository } = await import('@/repositories/CanvasRepository');
        const userId = useAuthStore.getState().user?.id || null;
        
        const mimeType = file.type || 'image/png';
        const fileName = file.name || `image_${Date.now()}.png`;
        const imgData = await canvasRepository.storeImage(userId, targetPageId, fileName, mimeType, buffer);
        
        const imgUrl = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
        const img = new Image();
        img.onload = () => {
          const viewportManager = notebookEngine.viewport;
          
          let width = img.width;
          let height = img.height;
          const max = 450;
          if (width > max || height > max) {
            const ratio = Math.min(max / width, max / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }

          let pageX = paperDimensions.width / 2;
          let pageY = paperDimensions.height / 3;

          const pageElem = document.getElementById(`page-${targetPageId}`);
          if (clientX !== undefined && clientY !== undefined && pageElem) {
            const rect = pageElem.getBoundingClientRect();
            const screenX = clientX - rect.left;
            const screenY = clientY - rect.top;
            const pt = viewportManager.screenToPage(screenX, screenY);
            pageX = pt.x;
            pageY = pt.y + (logicalScrollBases[targetPageId] ?? 0);
          } else {
            const pos = getSensiblePastePosition(width, height);
            pageX = pos.x + width / 2;
            pageY = pos.y + height / 2;
          }

          const newImg = {
            type: 'image' as const,
            id: imgData.id,
            x: Math.max(10, Math.min(paperDimensions.width - width - 10, pageX - width / 2)),
            y: Math.max(10, Math.min(paperDimensions.height - height - 10, pageY - height / 2)),
            width,
            height,
            fileId: imgData.id,
            rotation: 0,
            createdAt: Date.now()
          };

          notebookEngine.images.cacheImage(imgData.id, img, imgUrl);
          if ((focusedPageIdRef.current || activePageId) !== targetPageId || !notebookEngine.drawing.canEditActiveLayer()) return;
          notebookEngine.images.addImage(newImg);
          notebookEngine.drawing.redraw();
          
          // Switch to select tool and highlight the inserted image
          notebookEngine.tools.setMode('select');
          notebookEngine.selection.clearSelection();
          notebookEngine.selection.selectAt(newImg.x + 10, newImg.y + 10, false);

          notebookEngine.history.pushExecuted({
            description: 'Insert image',
            execute: () => {
              notebookEngine.images.addImage(newImg);
              notebookEngine.drawing.redraw();
            },
            undo: () => {
              notebookEngine.images.removeImage(imgData.id);
              notebookEngine.drawing.redraw();
            }
          });

          // Immediate persistence
          if (workspace && notebook && targetPageId) {
            persistDrawing(captureEngineOwnedDrawing(notebookEngine, notebook?.id, targetPageId));
          }
        };
        img.onerror = (err) => {
          console.error('Image onload failed:', err);
        };
        img.src = imgUrl;
      } catch (err) {
        console.error('Failed to store image:', err);
      }
    };
    reader.readAsArrayBuffer(file);
  }, [focusedPageId, activePageId, notebookEngine, paperDimensions, getSensiblePastePosition, workspace, notebook, logicalScrollBases]);

  // Import rich text formatted content as editable TextObject (OneNote style paste)
  const importRichText = useCallback((content: any, customX?: number, customY?: number, pastePresentation?: 'sticky-note' | 'mixed-paste') => {
    if (!notebookEngine.drawing.canEditActiveLayer()) return;
    if (!content || !content.content || content.content.length === 0) return;
    const targetPageId = focusedPageId || activePageId;
    if (!targetPageId) return;

    const currentProperties = notebookEngine.getProperties();
    const existingTexts = notebookEngine.texts.getTexts();
    const existingNonAudioTexts = existingTexts.filter(text => !text.metadata?.audioNoteId);
    const contentStr = JSON.stringify(content);
    const isMultiBlock = Array.isArray(content.content) && (
      content.content.length > 1 ||
      content.content.some((b: any) => b.type === 'heading' || b.type === 'bulletList' || b.type === 'orderedList' || b.type === 'codeBlock') ||
      contentStr.length > 300
    );

    if (currentProperties.layoutMode === 'document') {
      let body = existingTexts.find(text => text.metadata?.documentRole === 'body');
      if (!body) {
        body = {
          id: generateId('document'),
          type: 'text',
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          content,
          createdAt: Date.now(),
          metadata: { documentRole: 'body', richTextSchemaVersion: 3 },
        };
        notebookEngine.texts.addText(body);
        setTextObjects([...notebookEngine.texts.getTexts()]);
        notebookEngine.texts.setDocumentBodyId(body.id);
        notebookEngine.tools.setMode('text');
        if (workspace && notebook && targetPageId) {
          persistDrawing(captureEngineOwnedDrawing(notebookEngine, notebook?.id, targetPageId));
        }
        return;
      }
      const editor = body && notebookEngine.texts.getEditor(body.id);
      if (editor && !editor.isDestroyed && editor.view.dom.dataset.protectedContent !== 'true' && notebookEngine.layers.isEditable(body.layerId)) {
        notebookEngine.tools.setMode('text');
        editor.setEditable(true, false);
        editor.chain().focus().pasteDocumentationContent(content).run();
        return;
      }
      notebookEngine.texts.updateTextContent(body.id, content);
      notebookEngine.input.notifyChange('document-text');
      notebookEngine.tools.setMode('text');
      if (workspace && notebook && targetPageId) {
        persistDrawing(captureEngineOwnedDrawing(notebookEngine, notebook?.id, targetPageId));
      }
      return;
    }

    // Auto-promote to document flow on fixed-size pages (A4, A3, etc.) when pasting onto a fresh page or multi-block document
    if ((existingNonAudioTexts.length === 0 || isMultiBlock) && currentProperties.pageSize !== 'Infinite') {
      const newBody: TextObject = {
        id: generateId('document'),
        type: 'text',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        content,
        createdAt: Date.now(),
        metadata: { documentRole: 'body', richTextSchemaVersion: 3 },
      };
      notebookEngine.texts.addText(newBody);
      setTextObjects([...notebookEngine.texts.getTexts()]);
      notebookEngine.texts.setDocumentBodyId(newBody.id);
      handlePagePropertiesUpdate({ layoutMode: 'document' });
      notebookEngine.tools.setMode('text');
      if (workspace && notebook && targetPageId) {
        persistDrawing(captureEngineOwnedDrawing(notebookEngine, notebook?.id, targetPageId));
      }
      return;
    }

    // Check if content has codeBlock or large elements to size appropriately
    const hasCodeBlock = contentStr.includes('"type":"codeBlock"');
    const hasHeading = contentStr.includes('"type":"heading"');
    const boxWidth = hasCodeBlock ? 520 : (hasHeading ? 420 : 360);
    const boxHeight = 120;

    let { x, y } = getSensiblePastePosition(boxWidth, boxHeight);
    if (customX !== undefined && customY !== undefined) {
      x = customX;
      y = customY;
    }

    const newText: TextObject = {
      id: generateId('txt'),
      type: 'text',
      x,
      y,
      width: boxWidth,
      content,
      createdAt: Date.now(),
      metadata: pastePresentation ? { pastePresentation } : undefined,
    };

    notebookEngine.texts.addText(newText);
    setTextObjects([...notebookEngine.texts.getTexts()]);
    notebookEngine.tools.setMode('select');
    notebookEngine.selection.clearSelection();
    notebookEngine.selection.selectAt(newText.x + 10, newText.y + 10, false);
    notebookEngine.drawing.redraw();

    notebookEngine.history.pushExecuted({
      description: 'Paste formatted text',
      execute: () => {
        notebookEngine.texts.addText(newText);
        setTextObjects([...notebookEngine.texts.getTexts()]);
        notebookEngine.drawing.redraw();
      },
      undo: () => {
        notebookEngine.texts.removeText(newText.id);
        notebookEngine.selection.clearSelection();
        setTextObjects([...notebookEngine.texts.getTexts()]);
        notebookEngine.drawing.redraw();
      }
    });

    if (workspace && notebook && targetPageId) {
      persistDrawing(captureEngineOwnedDrawing(notebookEngine, notebook?.id, targetPageId));
    }
  }, [focusedPageId, activePageId, getSensiblePastePosition, notebookEngine, workspace, notebook, handlePagePropertiesUpdate]);

  // Import text as editable TextObject (plain text fallback)
  const importText = useCallback((rawText: string, customX?: number, customY?: number, pastePresentation?: 'sticky-note') => {
    if (!notebookEngine.drawing.canEditActiveLayer()) return;
    if (!rawText.trim()) return;
    const targetPageId = focusedPageId || activePageId;
    if (!targetPageId) return;

    const lines = rawText.split(/\r?\n/);
    if (notebookEngine.getProperties().layoutMode === 'document') {
      importRichText({ type: 'doc', content: lines.map(line => ({ type: 'paragraph', content: line ? textContentWithSafeLinks(line) : [] })) });
      return;
    }
    const toolColor = toolState.color || '#20242a';

    const content = {
      type: 'doc',
      content: lines.map(line => ({
        type: 'paragraph',
        content: line ? textContentWithSafeLinks(line).map(node => ({
          ...node,
          marks: [
            ...(node.marks || []),
            { type: 'textStyle', attrs: { color: toolColor } },
          ],
        })) : []
      }))
    };

    let { x, y } = getSensiblePastePosition(320, Math.min(400, Math.max(80, lines.length * 24)));
    if (customX !== undefined && customY !== undefined) {
      x = customX;
      y = customY;
    }

    const newText: TextObject = {
      id: generateId('txt'),
      type: 'text',
      x,
      y,
      width: 320,
      content,
      createdAt: Date.now(),
      metadata: pastePresentation ? { pastePresentation } : undefined,
    };

    notebookEngine.texts.addText(newText);
    setTextObjects([...notebookEngine.texts.getTexts()]);
    notebookEngine.tools.setMode('select');
    notebookEngine.selection.clearSelection();
    notebookEngine.selection.selectAt(newText.x + 10, newText.y + 10, false);
    notebookEngine.drawing.redraw();

    notebookEngine.history.pushExecuted({
      description: 'Paste text',
      execute: () => {
        notebookEngine.texts.addText(newText);
        setTextObjects([...notebookEngine.texts.getTexts()]);
        notebookEngine.drawing.redraw();
      },
      undo: () => {
        notebookEngine.texts.removeText(newText.id);
        notebookEngine.selection.clearSelection();
        setTextObjects([...notebookEngine.texts.getTexts()]);
        notebookEngine.drawing.redraw();
      }
    });

    if (workspace && notebook && targetPageId) {
      persistDrawing(captureEngineOwnedDrawing(notebookEngine, notebook?.id, targetPageId));
    }
  }, [focusedPageId, activePageId, toolState.color, getSensiblePastePosition, notebookEngine, workspace, notebook, importRichText]);

  const handledPasteEvents = useRef(new WeakSet<Event>());

  // Unified clipboard paste handler (strictly obeys live OS clipboard precedence)
  const pasteIntoDocument = useCallback((html: string, text: string, original?: DataTransfer): boolean => {
    const owner = notebookEngine.getDrawingOwnership().pageId;
    if (!owner) return false;
    const currentProps = notebookEngine.getProperties();
    if (currentProps.layoutMode !== 'document') return false;
    let body = notebookEngine.texts.getTexts().find(object => object.metadata?.documentRole === 'body');
    if (!body) {
      body = {
        id: generateId('document'),
        type: 'text',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        createdAt: Date.now(),
        metadata: { documentRole: 'body', richTextSchemaVersion: 3 },
      };
      notebookEngine.texts.addText(body);
      setTextObjects([...notebookEngine.texts.getTexts()]);
      notebookEngine.texts.setDocumentBodyId(body.id);
    }
    // Native clipboard data is readable during its event. Copy every textual
    // format before replaying it after the Text tool becomes editable.
    const clipboard = new DataTransfer();
    if (original) for (const type of original.types) if (type !== 'Files') clipboard.setData(type, original.getData(type));
    if (html) clipboard.setData('text/html', html);
    if (text) clipboard.setData('text/plain', text);
    notebookEngine.tools.setMode('text');
    const deliver = (attempt = 0) => {
      const editor = notebookEngine.texts.getEditor(body.id);
      if (notebookEngine.getDrawingOwnership().pageId !== owner || notebookEngine.tools.getState().mode !== 'text') return;
      if (!editor?.isEditable || !editor.view.dom.isConnected) {
        if (attempt < 3) requestAnimationFrame(() => deliver(attempt + 1));
        else useUIStore.getState().showToast('The document is not editable yet. Paste when the writing cursor appears.', 'info');
        return;
      }
      editor.view.focus();
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    };
    requestAnimationFrame(() => deliver());
    return true;
  }, [notebookEngine]);

  const handlePasteFromClipboard = useCallback(async (e?: React.ClipboardEvent | ClipboardEvent) => {
    // 1. If inside a native input / TipTap text editor, let it paste natively
    const pasteTarget = e?.target instanceof HTMLElement ? e.target : null;
    const isTextEditing = (
      Boolean(pasteTarget?.isContentEditable) ||
      document.activeElement instanceof HTMLInputElement || 
      document.activeElement instanceof HTMLTextAreaElement ||
      !!(document.activeElement as HTMLElement)?.isContentEditable
    );
    if (isTextEditing) return;

    if (e) {
      const nativeEvent = 'nativeEvent' in e ? e.nativeEvent : e;
      if (handledPasteEvents.current.has(nativeEvent)) return;
      handledPasteEvents.current.add(nativeEvent);
    }
    const pastePageId = focusedPageIdRef.current;
    const stillOnPage = () => focusedPageIdRef.current === pastePageId;

    // 2. Check ClipboardEvent items if provided (e.g. from onPaste or window paste event)
    if (e && 'clipboardData' in e && e.clipboardData) {
      // a. Image from OS clipboard (check both items and files)
      let imageFile: File | null = null;
      const items = Array.from(e.clipboardData.items || []);
      const imageItem = items.find(item => item.type.startsWith('image/'));
      if (imageItem) {
        imageFile = imageItem.getAsFile();
      }
      if (!imageFile && e.clipboardData.files && e.clipboardData.files.length > 0) {
        const file = Array.from(e.clipboardData.files).find(f => f.type.startsWith('image/'));
        if (file) {
          imageFile = file;
        }
      }
      if (imageFile) {
        e.preventDefault();
        await importImage(imageFile);
        return;
      }

      const textData = e.clipboardData.getData('text/plain');
      const htmlData = e.clipboardData.getData('text/html');

      // b. Explicit Panvas element JSON payload from live clipboard
      if (textData && textData.trim().startsWith('{"type":"panvas/elements"')) {
        try {
          const parsed = JSON.parse(textData);
          if (parsed?.type === 'panvas/elements') {
            e.preventDefault();
            const success = notebookEngine.selection.pasteElements(parsed);
            if (success) {
              setTextObjects([...notebookEngine.texts.getTexts()]);
              return;
            }
          }
        } catch {
          // not valid JSON
        }
      }

      if ((htmlData || textData) && pasteIntoDocument(htmlData, textData, e.clipboardData)) { e.preventDefault(); return; }

      // c. Formatted HTML from OS clipboard
      if (htmlData && htmlData.trim().length > 0) {
        e.preventDefault();
        const json = htmlToTipTapJson(htmlData);
        if (json && json.content && json.content.length > 0) {
          importRichText(json, undefined, undefined, getPlainTextPastePresentation(json));
          return;
        }
      }

      // d. Plain text from OS clipboard
      if (textData && textData.trim().length > 0) {
        e.preventDefault();
        const content = parsePlainTextClipboard(textData);
        if (content) {
          importRichText(content, undefined, undefined, getPlainTextPastePresentation(content));
        } else {
          importText(textData, undefined, undefined, 'sticky-note');
        }
        return;
      }

      if (notebookEngine.selection.pasteInternalClipboard()) {
        e.preventDefault();
        notebookEngine.input.notifyChange();
      }
      return;
    }

    // 3. Programmatic clipboard read (e.g. from context menu click)
    try {
      if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
        try {
          const clipboardItems = await navigator.clipboard.read();
          if (!stillOnPage()) return;
          for (const item of clipboardItems) {
            const imageType = item.types.find(t => t.startsWith('image/'));
            if (imageType) {
              const blob = await item.getType(imageType);
              if (!stillOnPage()) return;
              const ext = imageType.split('/')[1] || 'png';
              const file = new File([blob], `pasted_image_${Date.now()}.${ext}`, { type: imageType });
              await importImage(file);
              return;
            }

            if (item.types.includes('text/html')) {
              const htmlBlob = await item.getType('text/html');
              const htmlText = await htmlBlob.text();
              if (!stillOnPage()) return;
              if (htmlText && htmlText.trim().length > 0) {
                if (pasteIntoDocument(htmlText, '')) return;
                const json = htmlToTipTapJson(htmlText);
                if (json && json.content && json.content.length > 0) {
                  importRichText(json, undefined, undefined, getPlainTextPastePresentation(json));
                  return;
                }
              }
            }
          }
        } catch {
          // navigator.clipboard.read() might fail or be restricted
        }
      }

      let text = '';
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        try {
          text = await navigator.clipboard.readText();
        } catch {
          // fallback
        }
      }

      if (!stillOnPage()) return;
      if (text && text.trim().length > 0) {
        if (text.trim().startsWith('{"type":"panvas/elements"')) {
          try {
            const parsed = JSON.parse(text);
            if (parsed?.type === 'panvas/elements') {
              const success = notebookEngine.selection.pasteElements(parsed);
              if (success) {
                setTextObjects([...notebookEngine.texts.getTexts()]);
                return;
              }
            }
          } catch {
            // not valid JSON
          }
        }
        if (pasteIntoDocument('', text)) return;
        const content = parsePlainTextClipboard(text);
        if (content) {
          importRichText(content, undefined, undefined, getPlainTextPastePresentation(content));
        } else {
          importText(text, undefined, undefined, 'sticky-note');
        }
      } else if (notebookEngine.selection.pasteInternalClipboard()) {
        notebookEngine.input.notifyChange();
      }
    } catch (err) {
      console.error('Failed to paste from clipboard:', err);
    }
  }, [importImage, importRichText, importText, notebookEngine, pasteIntoDocument]);

  const openHandwritingConversion = useCallback(() => {
    const strokes = notebookEngine.selection.getSelectedStrokes();
    if (strokes.length === 0) {
      useUIStore.getState().showToast('Select handwriting strokes to convert them to text.', 'error');
      return;
    }
    setHandwritingStrokes(strokes);
    setIsHandwritingDialogOpen(true);
  }, [notebookEngine]);

  const confirmHandwritingConversion = useCallback((
    lines: ReviewedHandwritingLine[],
    preferences: HandwritingToolPreferences,
    providerId: string,
  ) => {
    if (!notebookEngine.convertSelectedHandwritingLinesToText(lines, preferences, providerId)) {
      useUIStore.getState().showToast('The selected handwriting is no longer available for conversion.', 'error');
      return;
    }
    const targetPageId = focusedPageIdRef.current || activePageId;
    setTextObjects([...notebookEngine.texts.getTexts()]);
    if (targetPageId) persistDrawing(captureEngineOwnedDrawing(notebookEngine, notebook?.id, targetPageId));
    setIsHandwritingDialogOpen(false);
    setHandwritingStrokes([]);
  }, [activePageId, notebookEngine, persistDrawing]);

  // Centralized command dispatcher shared between context menu & keyboard
  const executeCommand = useCallback(async (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete' | 'selectAll' | 'bringToFront' | 'bringForward' | 'sendBackward' | 'sendToBack' | 'convertHandwriting') => {
    const isTextEditing = (
      document.activeElement instanceof HTMLInputElement || 
      document.activeElement instanceof HTMLTextAreaElement ||
      !!(document.activeElement as HTMLElement)?.isContentEditable
    );

    switch (command) {
      case 'undo':
        if ((document.activeElement as HTMLElement)?.closest('.ProseMirror')) {
          const text = notebookEngine.texts.getFocusedText(), editor = text && notebookEngine.texts.getEditor(text.id);
          if (!editor?.commands.undo()) runDocumentLayoutHistory(notebookEngine, 'undo', editor);
        } else if (isTextEditing) {
          document.execCommand('undo');
        } else if (notebookEngine.history.canUndo()) {
          notebookEngine.history.undo();
          setTextObjects([...notebookEngine.texts.getTexts()]);
          notebookEngine.drawing.redraw();
        }
        break;
      case 'redo':
        if ((document.activeElement as HTMLElement)?.closest('.ProseMirror')) {
          const text = notebookEngine.texts.getFocusedText(), editor = text && notebookEngine.texts.getEditor(text.id);
          if (!editor?.commands.redo()) runDocumentLayoutHistory(notebookEngine, 'redo', editor);
        } else if (isTextEditing) {
          document.execCommand('redo');
        } else if (notebookEngine.history.canRedo()) {
          notebookEngine.history.redo();
          setTextObjects([...notebookEngine.texts.getTexts()]);
          notebookEngine.drawing.redraw();
        }
        break;
      case 'cut':
        if (isTextEditing) {
          document.execCommand('cut');
        } else {
          await notebookEngine.selection.cutSelection();
          setTextObjects([...notebookEngine.texts.getTexts()]);
        }
        break;
      case 'copy':
        if (isTextEditing) {
          document.execCommand('copy');
        } else {
          await notebookEngine.selection.copySelection();
        }
        break;
      case 'paste':
        if (isTextEditing) {
          document.execCommand('paste');
        } else {
          await handlePasteFromClipboard();
        }
        break;
      case 'duplicate':
        if (!isTextEditing) {
          await notebookEngine.selection.duplicateSelection();
          setTextObjects([...notebookEngine.texts.getTexts()]);
        }
        break;
      case 'bringToFront':
        if (!isTextEditing && notebookEngine.bringSelectionToFront()) {
          setTextObjects([...notebookEngine.texts.getTexts()]);
        }
        break;
      case 'bringForward':
        if (!isTextEditing && notebookEngine.bringSelectionForward()) {
          setTextObjects([...notebookEngine.texts.getTexts()]);
        }
        break;
      case 'sendBackward':
        if (!isTextEditing && notebookEngine.sendSelectionBackward()) {
          setTextObjects([...notebookEngine.texts.getTexts()]);
        }
        break;
      case 'sendToBack':
        if (!isTextEditing && notebookEngine.sendSelectionToBack()) {
          setTextObjects([...notebookEngine.texts.getTexts()]);
        }
        break;
      case 'delete':
        if (!isTextEditing) {
          notebookEngine.selection.deleteSelection();
          setTextObjects([...notebookEngine.texts.getTexts()]);
        }
        break;
      case 'selectAll':
        if (isTextEditing) {
          document.execCommand('selectAll');
        } else {
          notebookEngine.selection.selectAll();
        }
        break;
      case 'convertHandwriting':
        if (!isTextEditing) openHandwritingConversion();
        break;
    }
  }, [notebookEngine, handlePasteFromClipboard, openHandwritingConversion]);

  // Global Keyboard Shortcuts (Consolidated)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isTextEditing = (
        e.target instanceof HTMLInputElement || 
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable ||
        document.activeElement instanceof HTMLInputElement || 
        document.activeElement instanceof HTMLTextAreaElement ||
        !!(document.activeElement as HTMLElement)?.isContentEditable
      );

      if (e.key === 'F11') {
        e.preventDefault();
        setNotebookModeLevel(notebookModeLevel === 2 ? 0 : 2);
        return;
      }
      
      if (e.key === 'Escape' && notebookModeLevel > 0) {
        setNotebookModeLevel(0);
      }

      const isMod = e.ctrlKey || e.metaKey;

      const navigationDelta = shouldNotebookHandleNavigationKey(e)
        ? resolveNotebookNavigationDelta(e, workspaceViewMode, containerRef.current?.clientHeight ?? 0)
        : null;
      if (navigationDelta !== null) {
        const container = containerRef.current;
        if (container) {
          e.preventDefault();
          container.scrollBy({ top: navigationDelta, behavior: 'auto' });
        }
        return;
      }

      if (workspaceViewMode !== 'edit') {
        if (e.key === 'Escape' && workspaceViewMode === 'present') setWorkspaceViewMode('edit');
        const isReadingZoom = isMod && (e.key === '+' || e.key === '=' || e.key === '-' || e.code === 'Equal' || e.code === 'Minus' || e.code === 'NumpadAdd' || e.code === 'NumpadSubtract');
        if (!isReadingZoom) return;
      }

      if (isMod) {
        const isZoomIn = e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd';
        const isZoomOut = e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract';

        if (isZoomIn || isZoomOut) {
          e.preventDefault();
          handlePanelZoom(isZoomIn ? 1.1 : 0.9);
          return;
        }

        if (e.code === 'BracketRight' || e.code === 'BracketLeft') {
          if (!isTextEditing) {
            e.preventDefault();
            if (e.code === 'BracketRight') {
              executeCommand(e.shiftKey ? 'bringToFront' : 'bringForward');
            } else {
              executeCommand(e.shiftKey ? 'sendToBack' : 'sendBackward');
            }
          }
          return;
        }

        if (e.key.toLowerCase() === 'z') {
          if (!isTextEditing) {
            e.preventDefault();
            if (e.shiftKey) {
              executeCommand('redo');
            } else {
              executeCommand('undo');
            }
          }
          return;
        }

        if (e.key.toLowerCase() === 'y') {
          if (!isTextEditing) {
            e.preventDefault();
            executeCommand('redo');
          }
          return;
        }

        if (e.key.toLowerCase() === 'c') {
          if (!isTextEditing) {
            e.preventDefault();
            executeCommand('copy');
          }
          return;
        }

        if (e.key.toLowerCase() === 'x') {
          if (!isTextEditing) {
            e.preventDefault();
            executeCommand('cut');
          }
          return;
        }

        if (e.key.toLowerCase() === 'v') {
          if (!isTextEditing) {
            // Allow native paste event to fire so onWindowPaste receives the full ClipboardEvent with image File items
          }
          return;
        }

        if (e.key.toLowerCase() === 'd') {
          if (!isTextEditing) {
            e.preventDefault();
            executeCommand('duplicate');
          }
          return;
        }

        if (e.key.toLowerCase() === 'a') {
          if (!isTextEditing) {
            e.preventDefault();
            executeCommand('selectAll');
          }
          return;
        }

        return;
      }

      if (isTextEditing) return;

      const key = e.key.toLowerCase();
      
      switch (key) {
        case 'v': notebookEngine.tools.setMode('select'); break;
        case 't': notebookEngine.tools.setMode('text'); break;
        case 'p': notebookEngine.tools.setDrawingTool('pen'); break;
        case 'n': notebookEngine.tools.setDrawingTool('pencil'); break;
        case 'h': notebookEngine.tools.setDrawingTool('highlighter'); break;
        case 'm': notebookEngine.tools.setDrawingTool('marker'); break;
        case 'e': notebookEngine.tools.setMode('erase'); break;
        case 'r': notebookEngine.tools.setShapeTool('rectangle'); break;
        case 'o': notebookEngine.tools.setShapeTool('ellipse'); break;
        case 'a': notebookEngine.tools.setShapeTool('arrow'); break;
        case 'l': notebookEngine.tools.setShapeTool('line'); break;
        case 'delete':
        case 'backspace':
          if (notebookEngine.selection.getSelectedElements().length > 0) {
            e.preventDefault();
            executeCommand('delete');
          }
          break;
        case 'escape':
          notebookEngine.selection.clearSelection();
          break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [notebookEngine, notebookModeLevel, setNotebookModeLevel, handlePanelZoom, executeCommand, setWorkspaceViewMode, workspaceViewMode]);

  // Window paste event listener
  useEffect(() => {
    if (workspaceViewMode !== 'edit') return;
    const onWindowPaste = (e: ClipboardEvent) => {
      const isTextEditing = (
        e.target instanceof HTMLInputElement || 
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable ||
        document.activeElement instanceof HTMLInputElement || 
        document.activeElement instanceof HTMLTextAreaElement ||
        !!(document.activeElement as HTMLElement)?.isContentEditable
      );
      if (isTextEditing) return;

      handlePasteFromClipboard(e);
    };

    window.addEventListener('paste', onWindowPaste);
    return () => window.removeEventListener('paste', onWindowPaste);
  }, [handlePasteFromClipboard, workspaceViewMode, notebookEngine]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const editor = notebookEngine.texts.getTexts().map(object => notebookEngine.texts.getEditor(object.id))
      .find(candidate => candidate && !candidate.isDestroyed && candidate.isEditable && candidate.view.dom.contains(target));
    const blockId = target.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
    if (editor && blockId && !target.closest('[data-block-id]')?.contains(editor.view.domAtPos(editor.state.selection.from).node)) {
      editor.commands.focusDocumentationBlock(blockId);
    }
    const hasSelection = notebookEngine.selection.getSelectedElements().length > 0;
    const canConvertHandwriting = notebookEngine.selection.hasSelectedStrokes();
    const isTextEditing = (
      document.activeElement instanceof HTMLInputElement || 
      document.activeElement instanceof HTMLTextAreaElement ||
      !!(document.activeElement as HTMLElement)?.isContentEditable
    );

    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
      hasSelection,
      isTextEditing,
      canUndo: notebookEngine.history.canUndo(),
      canRedo: notebookEngine.history.canRedo(),
      canConvertHandwriting,
      editor: editor ?? null,
      blockId,
    });
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    await handlePasteFromClipboard(e);
  };

  const handleDrop = async (e: React.DragEvent) => {
    await UniversalDropRouter.handleExternalDrop(e, {
      onImageDrop: async (file) => {
        await importImage(file, e.clientX, e.clientY);
      },
      onPdfDrop: () => {
        useUIStore.getState().showToast('PDFs cannot be inserted into notebook pages directly.', 'error');
      },
      onUnsupportedDrop: (file) => {
        if (file) {
          useUIStore.getState().showToast(`Unsupported file type: ${file.name}`, 'error');
        }
      }
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    UniversalDropRouter.handleDragOver(e, ['IMAGE']);
  };

  const handleLayersChange = useCallback(() => {
    setLayerRevision(value => value + 1);
    setTextObjects([...notebookEngine.texts.getTexts()]);
    const currentPageId = focusedPageIdRef.current || page?.id;
    if (!currentPageId) return;
    const snapshot = captureEngineOwnedDrawing(notebookEngine, notebook?.id, currentPageId);
    if (!snapshot) return;
    sectionDataRevisionRef.current[currentPageId] = snapshot.drawingRevision;
    updateSectionDataCache(previous => ({ ...previous, [currentPageId]: snapshot.data }));
    persistDrawing(snapshot);
  }, [notebook?.id, notebookEngine, page?.id, persistDrawing, updateSectionDataCache]);

  const handlePageAudioPersisted = useCallback((pageId: string, data: DrawingData) => {
    updateSectionDataCache(previous => ({ ...previous, [pageId]: data }));
    if (focusedPageIdRef.current === pageId) {
      notebookEngine.audio.setAll(data.audioNotes);
      const persistedVoice = (data.objects ?? []).filter(object => object.type === 'text' && object.metadata?.isVoiceNote === true) as TextObject[];
      const ordinary = notebookEngine.texts.getTexts().filter(object => object.metadata?.isVoiceNote !== true);
      const live = new Map(notebookEngine.texts.getTexts().map(object => [object.id, object]));
      const merged = [...ordinary, ...persistedVoice.map(object => live.get(object.id) ?? object)];
      notebookEngine.texts.setTexts(merged);
      setTextObjects(merged);
      notebookEngine.input.notifyChange();
    }
  }, [notebookEngine, updateSectionDataCache]);

  const handleVoiceCommand = useCallback((note: AudioNote, change: { delete: true } | { title: string }) => {
    if (!workspace?.id || !notebook?.id || !focusedPageIdRef.current) return;
    const owner = { workspaceId: workspace.id, notebookId: notebook.id, pageId: focusedPageIdRef.current };
    const persist = (state: VoiceState) => {
      void pageAudioPersistence.replaceVoiceState(owner, state.notes, state.objects).catch(() =>
        useUIStore.getState().showToast('Voice note changes could not be saved.', 'error'));
    };
    changeVoiceNote(notebookEngine, note.id, change, persist);
    handleLayersChange();
  }, [notebookEngine, notebook?.id, workspace?.id, handleLayersChange]);
  const handleDeleteVoiceNote = useCallback((note: AudioNote) => handleVoiceCommand(note, { delete: true }), [handleVoiceCommand]);
  const handleRenameVoiceNote = useCallback((note: AudioNote, title: string) => handleVoiceCommand(note, { title }), [handleVoiceCommand]);
  useEffect(() => {
    notebookEngine.selection.setVoiceDeleteHandler(id => {
      const note = notebookEngine.audio.getAll().find(item => item.id === id);
      if (note) handleDeleteVoiceNote(note);
    });
    return () => notebookEngine.selection.setVoiceDeleteHandler(undefined);
  }, [notebookEngine, handleDeleteVoiceNote]);

  const handleInsertPage = useCallback(async () => {
    const sectionId = page?.sectionId ?? activeNotebookSectionId;
    if (!sectionId) return;

    const layoutMode = pageProperties.layoutMode ?? 'document';
    await useWorkspaceStore.getState().createNotebookPage(sectionId, '', {
      layoutMode,
      pageSize: pageProperties.pageSize,
      orientation: pageProperties.orientation,
      paperColor: pageProperties.paperColor,
      template: pageProperties.template,
      ruleLineColor: pageProperties.ruleLineColor,
      margins: pageProperties.margins,
      infiniteWidth: pageProperties.infiniteWidth,
      titleProvenance: 'default',
      insertAfterPageId: activePageId ?? undefined,
    });
  }, [activePageId, activeNotebookSectionId, page?.sectionId, pageProperties]);

  const handleExportPagePdf = useCallback(async () => {
    if (!page || !notebook) return;
    setIsExportingPdf(true);
    try {
      await exportPageToPdf(page.id, { drawingOverrides: { [page.id]: notebookEngine.getDrawingData() } });
    } finally {
      setIsExportingPdf(false);
    }
  }, [notebook, notebookEngine, page]);

  const handleExportNotebookPdf = useCallback(async () => {
    if (!notebook) return;
    setIsExportingPdf(true);
    try {
      const activeId = focusedPageIdRef.current;
      const overrides = activeId ? { [activeId]: notebookEngine.getDrawingData() } : undefined;
      await exportNotebookToPdf(notebook.id, { drawingOverrides: overrides });
    } finally {
      setIsExportingPdf(false);
    }
  }, [notebook, notebookEngine]);

  const handlePrintPage = useCallback(async () => {
    if (!page) return;
    setIsExportingPdf(true);
    try {
      await printPage(page.id, { drawingOverrides: { [page.id]: notebookEngine.getDrawingData() } });
    } finally {
      setIsExportingPdf(false);
    }
  }, [notebookEngine, page]);

  const handlePrintNotebook = useCallback(async () => {
    if (!notebook) return;
    setIsExportingPdf(true);
    try {
      const activeId = focusedPageIdRef.current;
      const overrides = activeId ? { [activeId]: notebookEngine.getDrawingData() } : undefined;
      await printNotebook(notebook.id, { drawingOverrides: overrides });
    } finally {
      setIsExportingPdf(false);
    }
  }, [notebook, notebookEngine]);

  if (!activePageId) return null;

  // The floating header has three independent control clusters. When the page
  // properties drawer reserves its width, keeping the utilities beside the
  // workspace controls can leave less than the toolbar's compact footprint.
  // Stack those two secondary clusters instead of letting the toolbar overflow
  // into them; every control remains available and the paper viewport is not
  // globally scaled or remounted.
  // On phones the properties panel is a viewport-level bottom sheet that
  // overlays the paper, so it never reserves header width. Mobile detection
  // is viewport-based (matching the max-[599px] styles) rather than pane
  // width, so narrow desktop split panes keep the desktop/tablet contract.
  const reservedPropertiesWidth = isPropertiesPanelOpen && workspaceViewMode !== 'present' && !isMobileViewport ? 288 : 0;
  const isConstrainedHeader = containerSize.width > 0 && containerSize.width - reservedPropertiesWidth < 560;
  const landscapePageUtilities = !isMobileViewport && hasTouchInput && isCompactWorkspace
    ? <NotebookPageUtilities engine={notebookEngine} workspaceId={workspace?.id} notebookId={notebook?.id} ownerId={focusedPage?.id} editable={workspaceViewMode === 'edit'} onPageDataPersisted={handlePageAudioPersisted} onVoiceDelete={handleDeleteVoiceNote} onVoiceRename={handleRenameVoiceNote} onChange={handleLayersChange} onExportPage={() => void handleExportPagePdf()} onExportNotebook={() => void handleExportNotebookPdf()} onPrintPage={() => void handlePrintPage()} onPrintNotebook={() => void handlePrintNotebook()} isExporting={isExportingPdf} embedded />
    : undefined;

  return (
    <React.Profiler id="NotebookSurface" onRender={gate0OnRender}>
    <div
      className={`panvas-notebook-workspace relative flex h-full w-full min-w-0 overflow-hidden bg-panvas-bg-primary ${isCompactWorkspace ? 'flex-col' : ''}`}
      onPaste={workspaceViewMode === 'edit' ? handlePaste : undefined}
      onDrop={workspaceViewMode === 'edit' ? handleDrop : undefined}
      onDragOver={workspaceViewMode === 'edit' ? handleDragOver : undefined}
      onDragEnter={workspaceViewMode === 'edit' ? handleDragOver : undefined}
      tabIndex={0}
    >
      {/* Responsive Floating Header (Fixed, outside scroll viewport) */}
      {/* Reserve space matching the Page Properties <aside> (w-72) whenever the
          panel is open. Below the xl breakpoint the panel renders as an overlay
          drawer; reserving space only at xl let that drawer cover the floating
          toolbar's right side and the workspace controls on smaller windows. */}
      {/* The three wrappers below are layout only and must stay `pointer-events-none`: they
          are full-height flex cells spanning the width of the header, so making them
          interactive turned the whole top band into an invisible click sink over the top of
          page 1 and over anything scrolled beneath it. Each child re-enables pointer events
          on its own visible chrome. */}
      {isMobileViewport && workspaceViewMode !== 'present' && notebookModeLevel !== 2 && <div className="panvas-mobile-document-header">
        <button type="button" className="min-w-0 flex-1 truncate text-left text-xs font-medium" onClick={() => useUIStore.getState().toggleSidebar()} title="Browse notebook pages">{focusedPage?.title ?? 'Notebook'}</button>
        <button type="button" onClick={() => handlePanelZoom((containerSize.width - 16) / paperDimensions.width / viewport.scale)} className="shrink-0 whitespace-nowrap px-2 text-xs" aria-label="Fit page width">Fit width</button>
        <button type="button" className="panvas-icon-control focus-ring" onClick={() => useUIStore.getState().togglePropertiesPanel()} aria-label="Open page and view inspector" aria-expanded={isPropertiesPanelOpen}><PanelRight size={18} /></button>
        <NotebookPageUtilities engine={notebookEngine} workspaceId={workspace?.id} notebookId={notebook?.id} ownerId={focusedPage?.id} editable={workspaceViewMode === 'edit'} onPageDataPersisted={handlePageAudioPersisted} onVoiceDelete={handleDeleteVoiceNote} onVoiceRename={handleRenameVoiceNote} onChange={handleLayersChange} compact onExportPage={() => void handleExportPagePdf()} onExportNotebook={() => void handleExportNotebookPdf()} onPrintPage={() => void handlePrintPage()} onPrintNotebook={() => void handlePrintNotebook()} isExporting={isExportingPdf} />
        <NotebookWorkspaceControls focusOnly embedded />
      </div>}
      {isMobileViewport && workspaceViewMode !== 'present' && notebookModeLevel === 2 && (
        <div className="panvas-layer-toolbar absolute right-2 top-2 z-40 pointer-events-auto">
          <NotebookWorkspaceControls focusOnly />
        </div>
      )}
      {!isMobileViewport && workspaceViewMode !== 'present' && notebookModeLevel === 2 && (
        isToolbarCollapsed ? (
          <button
            type="button"
            onClick={() => setToolbarCollapsed(false)}
            className="panvas-floating-surface panvas-icon-control absolute left-1/2 top-3 z-40 h-8 w-8 -translate-x-1/2 rounded-full pointer-events-auto focus-ring"
            title="Show fullscreen tools and exit control"
            aria-label="Show fullscreen tools and exit control"
          >
            <PanelTopOpen size={17} />
          </button>
        ) : (
          <div ref={fullscreenToolbarHostRef} className="panvas-fullscreen-toolbar-host absolute left-3 right-3 top-3 z-40 flex min-w-0 justify-center overflow-visible pointer-events-none">
            <div className="panvas-layer-toolbar panvas-floating-surface flex w-fit max-w-full items-center gap-1 overflow-visible rounded-2xl p-1 pointer-events-auto" role="toolbar" aria-label="Fullscreen notebook tools">
              {workspaceViewMode === 'edit' && <NotebookFloatingToolbar editor={activeEditor} engine={notebookEngine} workspaceId={workspace?.id} onConvertHandwriting={openHandwritingConversion} pageUtilities={landscapePageUtilities} embedded hideCollapseButton fullscreenToolOnly availableWidth={fullscreenToolbarHostWidth === null ? null : Math.max(0, fullscreenToolbarHostWidth - 104)} />}
              <button type="button" onClick={() => setToolbarCollapsed(true)} className="panvas-icon-control shrink-0 focus-ring" title="Hide fullscreen tools" aria-label="Hide fullscreen tools">
                <PanelTopOpen size={16} className="rotate-180" />
              </button>
              <NotebookWorkspaceControls focusOnly embedded />
            </div>
          </div>
        )
      )}
      {!isMobileViewport && workspaceViewMode !== 'present' && notebookModeLevel !== 2 && <div style={{ marginRight: isCompactWorkspace ? reservedPropertiesWidth : undefined }} className={`panvas-notebook-chrome panvas-layer-toolbar absolute top-0 left-0 right-0 p-4 flex justify-between items-start pointer-events-none gap-4 ${isPropertiesPanelOpen ? 'right-72 max-[599px]:right-0' : ''}`}>
        {/* Below ~500px of notebook width the navigator's minimum footprint
            (~116px even fully truncated) starves the toolbar cell below the
            minimal tier and the bar overlaps the workspace controls. Tool
            access wins: the navigator is hidden and navigation stays available
            through the library toggle in the workspace controls. */}
        {!isCompactWorkspace && !isConstrainedHeader && (containerSize.width === 0 || containerSize.width >= 500) && (
          <div className="pointer-events-auto flex flex-shrink items-start gap-1 min-w-0 max-w-[30%]">
            <NotebookNavigator />
          </div>
        )}

        <div className="pointer-events-none flex-1 flex justify-center items-start min-w-0">
          {workspaceViewMode === 'edit' && <NotebookFloatingToolbar editor={activeEditor} engine={notebookEngine} workspaceId={workspace?.id} onConvertHandwriting={openHandwritingConversion} pageUtilities={landscapePageUtilities} />}
        </div>

        <div className={`pointer-events-auto flex flex-shrink-0 items-end gap-2 ${isConstrainedHeader ? 'flex-col gap-1' : 'items-start'}`}>
          <NotebookPageUtilities engine={notebookEngine} workspaceId={workspace?.id} notebookId={notebook?.id} ownerId={focusedPage?.id} editable={workspaceViewMode === 'edit'} onPageDataPersisted={handlePageAudioPersisted} onVoiceDelete={handleDeleteVoiceNote} onVoiceRename={handleRenameVoiceNote} onChange={handleLayersChange} compact={containerSize.width < 900} onExportPage={() => void handleExportPagePdf()} onExportNotebook={() => void handleExportNotebookPdf()} onPrintPage={() => void handlePrintPage()} onPrintNotebook={() => void handlePrintNotebook()} isExporting={isExportingPdf} />
          <NotebookWorkspaceControls />
        </div>
      </div>}

      {/* Native Scrolling Viewport: one-finger margin scrolling stays enabled;
          the notebook controller owns pinch even on an inactive page. */}
      <main 
        ref={containerRef}
        tabIndex={0}
        aria-label="Notebook pages"
        style={{
          ...(hasTouchInput ? { touchAction: 'pan-x pan-y' } : {}),
          ...(containerToolCursor ? { cursor: containerToolCursor } : {}),
        }}
        className={`panvas-notebook-viewport notebook-viewport relative flex-1 min-w-0 min-h-0 overflow-auto bg-panvas-bg-secondary ${
          toolState.mode === 'hand' ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onContextMenu={workspaceViewMode === 'edit' ? handleContextMenu : event => event.preventDefault()}
        onPointerDown={e => {
          if (e.pointerType === 'touch') setIsTouchDevice(true);
          else setIsTouchDevice(false);
          containerRef.current?.focus({ preventScroll: true });
          if (contextMenu.isOpen) {
            setContextMenu(prev => ({ ...prev, isOpen: false }));
          }
        }}
        onPointerMove={e => {
          if (e.pointerType === 'touch' && !isTouchDevice) setIsTouchDevice(true);
          else if (e.pointerType !== 'touch' && isTouchDevice) setIsTouchDevice(false);
        }}
      >
        <DocumentToolCursorOverlay toolState={toolState} containerRef={containerRef} />
        {!sectionAppearanceReady ? (
          <div className="flex min-h-full w-full items-center justify-center text-xs text-panvas-text-secondary" role="status">
            Preparing notebook appearance…
          </div>
        ) : (
        <div 
          className="flex flex-col items-center mx-auto"
          style={{ 
            width: `${Math.max(containerSize.width, layoutConfig.totalWidth * viewport.scale + (isMobileViewport ? 16 : 64))}px`,
            minHeight: '100%',
            height: `${layoutConfig.totalHeight * viewport.scale}px`,
            position: 'relative'
          }}
        >
          <div
            className="relative origin-top"
            style={{
              width: `${layoutConfig.totalWidth}px`,
              height: `${layoutConfig.totalHeight}px`,
              transform: `scale(${viewport.scale})`,
              transformOrigin: 'top center',
            }}
          >
            {layoutConfig.positions.map((pos, index) => {
              const pageNumText = formatPageIndicator(index + 1, totalPages);
              const isFocused = pos.id === focusedPageId;
              const pageItem = currentSectionPages.find(p => p.id === pos.id)!;
              const sceneOwnerPageId = notebookEngine.getDrawingOwnership().pageId;
              const cachedData = sectionDataCacheRef.current[pos.id];
              // A page-owned preview is marked current for the exact cache entry
              // that was blitted into it at handoff. Prefer that identity for the
              // mount so the incoming live canvas can adopt the preview pixels.
              // Falling back to an older captured snapshot with the same content
              // but different array identities would force a full scene replay.
              const previewCurrent = sceneOwnerPageId === pos.id && Boolean(cachedData)
                && residentDrawingEnginesRef.current.get(pos.id)?.isSurfaceCurrent(cachedData);
              const focusedData = sceneOwnerPageId === pos.id
                ? (previewCurrent ? cachedData : (latestCapturedDrawingRef.current.get(pos.id)?.data ?? cachedData))
                : undefined;
              const renderData = resolveNotebookPageRenderData(
                pos.id,
                focusedPageId,
                sectionDataCacheRef.current,
                focusedData,
                sceneOwnerPageId ?? '',
              );

              const isResident = residentIds.has(pos.id) || isFocused;
              const isFarOffscreen = isPageFarOffscreen(
                pos.y,
                viewport.scale,
                containerRef.current?.scrollTop ?? 0,
                containerSize.height,
                isResident,
                3,
              );

              return (
                <div 
                  key={pos.id} 
                  data-page-id={pos.id}
                  data-page-index={index}
                  data-focused-sheet={isFocused ? 'true' : 'false'}
                  data-scene-owner-sheet-id={isFocused ? notebookEngine.getDrawingOwnership().pageId ?? '' : ''}
                  className="absolute"
                  style={{ 
                    left: pos.x,
                    top: pos.y, 
                    width: pos.width, 
                    height: pos.height 
                  }}
                >
                  {isResident ? (
                    <NotebookPageView
                      key={pos.id}
                      page={pageItem}
                      logicalBase={resolvedSectionProperties.get(pos.id)!.pageSize === 'Infinite' || resolvedSectionProperties.get(pos.id)!.layoutMode === 'document' ? logicalScrollBases[pos.id] ?? 0 : 0}
                      onLogicalRebase={(base, delta) => rebaseLogicalScroll(pos.id, base, delta)}
                      onImageManagerReady={registerPageImages}
                      data={renderData}
                      properties={resolvedSectionProperties.get(pos.id)!}
                      width={pos.width}
                      height={pos.height}
                      renderScale={debouncedScale}
                      pageNumberText={pageNumText}
                      isFocused={isFocused}
                      toolState={toolState}
                      notebookEngine={notebookEngine}
                      sceneOwnerPageId={isFocused ? notebookEngine.getDrawingOwnership().pageId ?? '' : ''}
                      previewSource={residentDrawingEnginesRef.current.get(pos.id)}
                      activeEditor={activeEditor}
                      setActiveEditor={setActiveEditor}
                      onActivatePage={() => handleActivatePage(pos.id)}
                      handleDrop={handleDrop}
                      handleDragOver={handleDragOver}
                      editable={workspaceViewMode === 'edit'}
                      onVoiceNoteChange={handleLayersChange}
                      onVoiceNoteDelete={note => void handleDeleteVoiceNote(note)}
                      onVoiceNoteRename={(note, title) => void handleRenameVoiceNote(note, title)}
                      onUpdateProperties={handlePagePropertiesUpdate}
                    />
                  ) : isFarOffscreen ? (
                    <div
                      id={`page-${pos.id}`}
                      data-page-id={pos.id}
                      className="relative shadow-md rounded border border-panvas-border/20 bg-panvas-bg-card/30 flex items-center justify-center text-xs text-panvas-text-tertiary select-none"
                      style={{ width: `${pos.width}px`, height: `${pos.height}px` }}
                    >
                      <span className="font-mono opacity-50">{pageNumText}</span>
                    </div>
                  ) : (
                    <PageRenderer id={pos.id} width={pos.width} height={pos.height}
                      properties={resolvedSectionProperties.get(pos.id)!} pageNumberText={pageNumText}>
                      <div role="status" className="absolute inset-0 flex items-center justify-center text-xs opacity-60">Loading page…</div>
                    </PageRenderer>
                  )}
                  {isFocused && workspaceViewMode === 'edit' && !isMobileViewport && (
                    <button
                      type="button"
                      onPointerDownCapture={event => event.stopPropagation()}
                      onClick={() => void handleInsertPage()}
                      className="panvas-insert-page-button panvas-floating-surface panvas-icon-control absolute bottom-0 left-full ml-3 z-30 h-8 w-8 rounded-full p-0 pointer-events-auto focus-ring"
                      aria-label="Insert page after current page"
                      title="Insert page after current page"
                    >
                      <Plus size={15} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        )}
      </main>

      {isMobileViewport && workspaceViewMode === 'edit' && <div className="panvas-mobile-tool-dock">
        <NotebookFloatingToolbar
          editor={activeEditor}
          engine={notebookEngine}
          workspaceId={workspace?.id}
         
          onConvertHandwriting={openHandwritingConversion}
          pageUtilities={
            <NotebookPageUtilities
              engine={notebookEngine}
              workspaceId={workspace?.id}
              notebookId={notebook?.id}
              ownerId={focusedPage?.id}
              editable={workspaceViewMode === 'edit'}
              onPageDataPersisted={handlePageAudioPersisted}
              onVoiceDelete={handleDeleteVoiceNote}
              onVoiceRename={handleRenameVoiceNote}
              onChange={handleLayersChange}
              onExportPage={() => void handleExportPagePdf()}
              onExportNotebook={() => void handleExportNotebookPdf()}
              onPrintPage={() => void handlePrintPage()}
              onPrintNotebook={() => void handlePrintNotebook()}
              isExporting={isExportingPdf}
              embedded
            />
          }
        />
      </div>}

      {/* Static properties panel on the right */}
      {isPropertiesPanelOpen && workspaceViewMode !== 'present' && (
        <NotebookToolPropertiesPanel 
          viewportEngine={notebookEngine.viewport} 
          zoom={viewport.scale} 
          properties={pageProperties}
          onUpdateProperties={handlePagePropertiesUpdate}
          onConvertText={handleConvertText}
          canConvertText={Boolean(getConversionText())}
          onApplyPropertiesToAll={handleApplyPropertiesToAll}
          onRestorePropertiesBatch={handleRestorePropertiesBatch}
          onZoom={handlePanelZoom}
        />
      )}

      {/* Right-click Context Menu */}
      <DocumentationLinkDialog />
      <DocumentationMarkdownDialog />
      <NotebookContextMenu
        engine={notebookEngine}
        state={contextMenu}
        onClose={() => setContextMenu(prev => ({ ...prev, isOpen: false }))}
        onCommand={executeCommand}
      />
      <HandwritingConversionDialog
        open={isHandwritingDialogOpen}
        strokes={handwritingStrokes}
        initialPreferences={notebookEngine.handwriting.getPreferences()}
          onCancel={() => {
            setIsHandwritingDialogOpen(false);
            setHandwritingStrokes([]);
          }}
        onConfirm={confirmHandwritingConversion}
      />
      {workspaceViewMode === 'present' && <PresentationOverlay onWheel={event => {
        const container = containerRef.current;
        if (!container || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        container.scrollBy({ left: event.deltaX, top: event.deltaY, behavior: 'auto' });
      }} />}
    </div>
    </React.Profiler>
  );
}
