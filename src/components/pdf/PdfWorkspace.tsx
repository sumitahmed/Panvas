import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react';
import { Bookmark, BookOpen, CalendarClock, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Download, FileText, Hand, Maximize2, MessageCircle, Minus, PanelLeftClose, PanelLeftOpen, PanelRight, Plus, Redo2, Undo2 } from 'lucide-react';
import { PdfThumbnailSidebar } from './PdfThumbnailSidebar';
import { PdfPageRenderer } from './PdfPageRenderer';
import { usePdfViewportZoom } from './usePdfViewportZoom';
import { resolveDocumentToolCursor } from '@/components/notebook/documentToolCursor';
import { usePdfDocument } from '@/hooks/usePdfDocument';
import type { NotebookPage, PdfPageState, PdfPageRotation } from '@/types/notebook';
import { NotebookEngine } from '@/components/notebook/engine/NotebookEngine';
import { createEmptyDrawingData, type DrawingData, type ViewportState, type TextObject } from '@/components/notebook/engine/drawingTypes';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { notebookRepository } from '@/repositories/NotebookRepository';
import { NotebookFloatingToolbar } from '@/components/notebook/NotebookFloatingToolbar';
import { FloatingTextEditor } from '@/components/notebook/FloatingTextEditor';
import { useToolState } from '@/components/notebook/useEngineState';
import type { Editor } from '@tiptap/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useUIStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { exportAnnotatedPdf } from '@/services/pdf/exportAnnotatedPdf';
import { NotebookPageUtilities } from '@/components/notebook/NotebookPageUtilities';
import { PresentationOverlay } from '@/components/workspace/PresentationOverlay';
import { WorkspaceViewInspectorPanel } from '@/components/workspace/WorkspaceViewControls';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { extractPdfSourcePage, movePdfPage, normalizePdfPageState, rotatePdfPage } from '@/services/pdf/pdfPageOperations';
import { pdfAnnotationStorageId } from '@/services/search/searchIndexEvents';
import { pdfSurroundingGeometry } from '@/components/notebook/engine/pdfCoordinates';
import { pageAudioPersistence } from '@/services/audio/pageAudioPersistenceInstance';
import { resolvePageNoteSpace, type PageNoteSpace } from '@/lib/pageProperties';
import { NoteSpaceControl } from '@/components/notebook/NoteSpaceControl';
import { resolveActivePdfPage } from './pdfNavigation';
import { attachTwoFingerViewportGesture } from '@/components/notebook/engine/touchViewportGesture';
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport';
import { useFullDarkView } from '@/hooks/useFullDarkView';
import { fullDarkSurfaceColor } from '@/lib/fullDarkView';

const iconButtonClass = 'flex h-8 w-8 items-center justify-center rounded-md text-panvas-text-secondary transition-colors hover:bg-panvas-bg-hover hover:text-panvas-text-primary active:bg-panvas-bg-active focus-ring';
interface PdfPageDescriptor {
  source: { width: number; height: number };
  noteSpace: PageNoteSpace;
  drawing: DrawingData;
}
const settledPdfScale = (current: number, next: number) => Math.abs(current - next) < 1e-7 ? current : next;

export function PdfWorkspace({ page }: { page?: NotebookPage }) {
  const isPhone = useIsMobileViewport();
  const fullDarkView = useFullDarkView();
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  
  const { pdfDocument, numPages, isLoading, error } = usePdfDocument(page?.pdfDataId);
  const { workspaces, notebooks, loadWorkspaceContents, setActivePage } = useWorkspaceStore();
  const { notebookModeLevel, setNotebookModeLevel, workspaceViewMode, setWorkspaceViewMode, paneLayout } = useLayoutStore();
  const { isPropertiesPanelOpen, togglePropertiesPanel } = useUIStore();
  
  const notebook = page ? notebooks.find(item => item.id === page.notebookId) : undefined;
  const workspace = notebook ? workspaces.find(item => item.id === notebook.workspaceId) : undefined;

  // Engine setup
  const notebookEngine = useMemo(() => new NotebookEngine(), []);
  useLayoutEffect(() => { notebookEngine.drawing.setFullDarkView(fullDarkView); }, [notebookEngine, fullDarkView]);
  const [rasterScale, setRasterScale] = useState(1);
  const annotationGestureActive = useRef(false);
  const rasterPending = useRef(false);
  const [viewport, setViewport] = useState<Readonly<ViewportState>>(() => notebookEngine.viewport.getState());
  // Read the engine directly instead of mirroring it — see useEngineState.ts.
  const toolState = useToolState(notebookEngine);
  const [textObjects, setTextObjects] = useState<TextObject[]>([]);
  const [loadedAnnotationId, setLoadedAnnotationId] = useState<string | null>(null);
  const activeAnnotationId = page ? pdfAnnotationStorageId(page.id, currentPage) : null;
  const activeSceneReady = activeAnnotationId !== null && loadedAnnotationId === activeAnnotationId;
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [noteSpace, setNoteSpace] = useState<PageNoteSpace>(() => resolvePageNoteSpace({}));
  const [sourcePaperDimensions, setSourcePaperDimensions] = useState({ width: 794, height: 1123 });
  const [dimensionsSourceId, setDimensionsSourceId] = useState<string | undefined>();
  const [pageDescriptors, setPageDescriptors] = useState<Record<number, PdfPageDescriptor>>({});
  const [isExporting, setIsExporting] = useState(false);
  const userId = useAuthStore(state => state.user?.id ?? null);
  const pdfPageState = useMemo(() => normalizePdfPageState(page?.pdfPageState, numPages), [numPages, page?.pdfPageState]);
  const currentRotation = pdfPageState.rotations[currentPage] ?? 0;
  const currentOrderIndex = Math.max(0, pdfPageState.pageOrder.indexOf(currentPage));
  const currentSource = pageDescriptors[currentPage]?.source ?? sourcePaperDimensions;
  const currentNoteSpace = activeSceneReady ? noteSpace : pageDescriptors[currentPage]?.noteSpace ?? noteSpace;
  const primaryGeometry = useMemo(() => pdfSurroundingGeometry(currentSource, currentRotation, currentNoteSpace), [currentSource, currentRotation, currentNoteSpace]);
  const paperDimensions = primaryGeometry.visual;
  useEffect(() => notebookEngine.onPropertiesChange(props => {
    const nextNoteSpace = resolvePageNoteSpace(props);
    setNoteSpace(nextNoteSpace);
    setPageDescriptors(current => current[currentPage]
      ? { ...current, [currentPage]: { ...current[currentPage], noteSpace: nextNoteSpace, drawing: notebookEngine.getDrawingData() } }
      : current);
  }), [currentPage, notebookEngine]);
  useEffect(() => {
    notebookEngine.viewport.setPageCoordinateTransform(currentRotation, primaryGeometry.sheet.width, primaryGeometry.sheet.height, primaryGeometry.offset.x, primaryGeometry.offset.y);
    notebookEngine.drawing.redraw();
  }, [notebookEngine, currentRotation, primaryGeometry]);


  const handlePrimaryEditorFocus = useCallback((editor: Editor) => {
    setActiveEditor(editor);
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const documentScrollRef = useRef<HTMLDivElement>(null);
  const pageElementRefs = useRef(new Map<number, HTMLDivElement>());
  const { setZoom: setZoomStable, getScale: getZoomScale, isZooming, captureTouchAnchor } = usePdfViewportZoom(notebookEngine.viewport, documentScrollRef, pageElementRefs, currentPage);
  const commandedPageRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [sidebarWidth, setSidebarWidth] = useState(0);
  const positionedDocumentRef = useRef<string | null>(null);
  const [isBottomNavCollapsed, setIsBottomNavCollapsed] = useState(false);
  const geometryReady = numPages > 0 && Object.keys(pageDescriptors).length === numPages;
  

  
  // Sidebar toggle
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => !isPhone);
  useEffect(() => { if (isPhone) setIsSidebarOpen(false); }, [isPhone]);

  useEffect(() => {
    if (workspaceViewMode !== 'edit') {
      notebookEngine.tools.setMode('hand');
      setActiveEditor(null);
    }
  }, [notebookEngine, workspaceViewMode]);

  // Annotation canvases use the same touch-action contract as notebook pages.
  // Restore two-finger pan/pinch on the document scroller itself, preserving
  // direct one-finger draw/select and the existing PDF persistence path.
  useEffect(() => {
    const scroller = documentScrollRef.current;
    if (!scroller) return;
    return attachTwoFingerViewportGesture({
      target: scroller,
      getScale: () => notebookEngine.viewport.getState().scale,
      setScale: scale => setZoomStable(scale),
      captureContentAnchor: captureTouchAnchor,
      cancelActivePointerInteraction: () => notebookEngine.input.cancelActivePointerInteraction(),
      navigationGestures: notebookEngine.input.navigationGestures,
      subscribeCancellation: cancel => notebookEngine.tools.subscribe(cancel),
    });
  }, [notebookEngine, isLoading, numPages, setZoomStable, captureTouchAnchor]);

  // PdfWorkspace is reused when moving directly between PDF pages. A page number
  // from the previous document is not meaningful for the newly selected document.
  useEffect(() => {
    setCurrentPage(1);
    commandedPageRef.current = null;
    setDimensionsSourceId(undefined);
    setPageDescriptors({});
  }, [page?.id, page?.pdfDataId]);

  // Resolve every source frame before laying out the document. Page switching
  // then moves only the active editor; it never swaps or resizes the document.
  useEffect(() => {
    if (!pdfDocument || !page || !workspace || !notebook || numPages < 1) return;
    let cancelled = false;
    void Promise.all(Array.from({ length: numPages }, async (_, index) => {
      const sourcePage = index + 1;
      const [pdfPage, drawing] = await Promise.all([
        pdfDocument.getPage(sourcePage),
        notebookRepository.loadDrawingData(workspace.id, notebook.id, pdfAnnotationStorageId(page.id, sourcePage)),
      ]);
      const sourceViewport = pdfPage.getViewport({ scale: 1, rotation: 0 });
      return [sourcePage, {
        source: { width: sourceViewport.width, height: sourceViewport.height },
        noteSpace: resolvePageNoteSpace(drawing?.properties ?? {}),
        drawing: drawing ?? createEmptyDrawingData(),
      }] as const;
    })).then(entries => {
      if (!cancelled) setPageDescriptors(Object.fromEntries(entries));
    }).catch(loadError => {
      if (!cancelled) console.error('[PdfWorkspace] PDF page geometry load failed:', loadError);
    });
    return () => { cancelled = true; };
  }, [notebook?.id, numPages, page?.id, pdfDocument, workspace?.id]);

  useEffect(() => {
    const descriptor = pageDescriptors[currentPage];
    if (!descriptor) return;
    setSourcePaperDimensions(descriptor.source);
    setNoteSpace(descriptor.noteSpace);
    setDimensionsSourceId(page?.pdfDataId);
  }, [currentPage, page?.pdfDataId, pageDescriptors]);

  const navigateToPage = useCallback((sourcePage: number) => {
    const target = Math.max(1, Math.min(numPages || 1, sourcePage));
    commandedPageRef.current = target;
    setCurrentPage(target);
    requestAnimationFrame(() => {
      const scroller = documentScrollRef.current;
      const element = pageElementRefs.current.get(target);
      if (scroller && element) {
        const scrollerBounds = scroller.getBoundingClientRect();
        const elementBounds = element.getBoundingClientRect();
        const top = scroller.scrollTop + elementBounds.top - scrollerBounds.top;
        scroller.scrollTo({ top: Math.max(0, top - 28), behavior: 'auto' });
      }
      requestAnimationFrame(() => { commandedPageRef.current = null; });
    });
  }, [numPages]);


  useEffect(() => {
    if (!page?.id || numPages < 1) return;
    const key = `panvas.pdfTargetPage.${page.id}`;
    const requested = Number(sessionStorage.getItem(key));
    sessionStorage.removeItem(key);
    if (Number.isInteger(requested) && requested >= 1) {
      const target = Math.min(numPages, requested);
      commandedPageRef.current = target;
      setCurrentPage(target);
    }
  }, [numPages, page?.id]);

  useEffect(() => {
    if (geometryReady && commandedPageRef.current) navigateToPage(commandedPageRef.current);
  }, [geometryReady, navigateToPage]);

  useEffect(() => {
    notebookEngine.viewport.setRenderTransform({ pan: false, scale: false });
    return () => notebookEngine.viewport.setRenderTransform({ pan: true, scale: false });
  }, [notebookEngine]);

  // Determine PDF Page Dimensions
  useEffect(() => {
    if (!pdfDocument || numPages === 0) return;
    let isMounted = true;
    pdfDocument.getPage(currentPage).then(pdfPage => {
      if (!isMounted) return;
      const sourceViewport = pdfPage.getViewport({ scale: 1.0, rotation: 0 });
      const sourceDimensions = { width: sourceViewport.width, height: sourceViewport.height };
      setSourcePaperDimensions(sourceDimensions);

      setDimensionsSourceId(page?.pdfDataId);
    });
    return () => { isMounted = false; };
  }, [currentRotation, pdfDocument, currentPage, numPages, notebookEngine]);


  // Sync Engine state to React
  useEffect(() => {
    const unsubViewport = notebookEngine.viewport.subscribe(setViewport);
    const unsubDrawing = notebookEngine.input.onDrawingChange(() => {
      setTextObjects([...notebookEngine.texts.getTexts()]);
      setPageDescriptors(current => current[currentPage]
        ? { ...current, [currentPage]: { ...current[currentPage], drawing: notebookEngine.getDrawingData() } }
        : current);
    });
    const unsubHistory = notebookEngine.history.subscribe(() => {
      setTextObjects([...notebookEngine.texts.getTexts()]);
      setPageDescriptors(current => current[currentPage]
        ? { ...current, [currentPage]: { ...current[currentPage], drawing: notebookEngine.getDrawingData() } }
        : current);
    });
    return () => {
      unsubViewport();
      unsubDrawing();
      unsubHistory();
    };
  }, [currentPage, notebookEngine]);

  // Container and Sidebar ResizeObservers
  useEffect(() => {
    const container = containerRef.current;
    const sidebar = sidebarRef.current;
    
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === container) {
          setContainerSize({
            width: entry.contentRect.width,
            height: entry.contentRect.height
          });
        } else if (entry.target === sidebar) {
          setSidebarWidth(entry.contentRect.width);
        }
      }
    });

    if (container) observer.observe(container);
    if (sidebar) observer.observe(sidebar);

    return () => observer.disconnect();
  }, [isLoading, error]);

  // Each PDF viewer session owns one stable zoom level. Page changes within the
  // same document must not re-run fit-to-width and overwrite it.
  const fittedDocumentRef = useRef<string | null>(null);
  const documentSessionId = page?.id ?? page?.pdfDataId ?? null;

  useEffect(() => {
    fittedDocumentRef.current = null;
    positionedDocumentRef.current = null;
  }, [documentSessionId]);

  useLayoutEffect(() => {
    const scroller = documentScrollRef.current;
    const first = pageElementRefs.current.get(pdfPageState.pageOrder[0]);
    if (!scroller || !first || !geometryReady || !containerSize.width || !fittedDocumentRef.current || positionedDocumentRef.current === documentSessionId) return;
    // Writable scroll room around a fitted page keeps an off-center zoom anchor
    // attainable, rather than clamping it away until horizontal overflow starts.
    const bounds = scroller.getBoundingClientRect();
    const pageBounds = first.getBoundingClientRect();
    scroller.scrollLeft += pageBounds.left + pageBounds.width / 2 - bounds.left - bounds.width / 2;
    scroller.scrollTop = containerSize.height / 2;
    positionedDocumentRef.current = documentSessionId;
  }, [containerSize, documentSessionId, geometryReady, pdfPageState.pageOrder, viewport.scale]);

  useEffect(() => {
    const fitKey = isPhone ? `${documentSessionId}:${containerSize.width}` : documentSessionId;
    if (!documentSessionId || fittedDocumentRef.current === fitKey) return;
    if (!isPhone && isSidebarOpen && sidebarWidth === 0) return; // Wait for the sidebar ResizeObserver to finish
    if (containerSize.width === 0 || paperDimensions.width === 0 || dimensionsSourceId !== page?.pdfDataId) return;
    
    const availableWidth = Math.max(100, containerSize.width - (!isPhone && isSidebarOpen ? sidebarWidth : 0));
    const fitZoom = (availableWidth - (isPhone ? 16 : 40)) / paperDimensions.width;
    
    notebookEngine.viewport.setZoom(fitZoom);
    notebookEngine.viewport.setPan(0, 0);
    fittedDocumentRef.current = fitKey;
  }, [documentSessionId, dimensionsSourceId, page?.pdfDataId, isSidebarOpen, sidebarWidth, containerSize.width, paperDimensions.width, notebookEngine, isPhone]);

  // Native document scrolling keeps every page in one stable flow. Only the
  // active-page marker changes as the viewport crosses a page boundary.
  useEffect(() => {
    const scroller = documentScrollRef.current;
    if (!scroller) return;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const resolveVisiblePage = () => {
      scrollFrameRef.current = null;
      if (commandedPageRef.current || notebookEngine.input.navigationGestures.active) return;
      const top = scroller.scrollTop;
      const bottom = top + scroller.clientHeight;
      const scrollerBounds = scroller.getBoundingClientRect();
      const frames = pdfPageState.pageOrder.flatMap(sourcePage => {
        const element = pageElementRefs.current.get(sourcePage);
        if (!element) return [];
        const bounds = element.getBoundingClientRect();
        const frameTop = scroller.scrollTop + bounds.top - scrollerBounds.top;
        return [{ page: sourcePage, top: frameTop, bottom: frameTop + bounds.height }];
      });
      const resolved = resolveActivePdfPage(frames, top, bottom, currentPage);
      if (resolved && resolved !== currentPage) setCurrentPage(resolved);
    };
    const handleScroll = () => {
      if (notebookEngine.input.navigationGestures.active) return;
      if (scrollTimer !== null) clearTimeout(scrollTimer);
      if (isZooming()) {
        scrollTimer = setTimeout(handleScroll, 180);
        return;
      }
      if (scrollFrameRef.current === null) scrollFrameRef.current = requestAnimationFrame(resolveVisiblePage);
    };
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const nextScale = getZoomScale() * Math.exp(-event.deltaY * 0.0015);
      setZoomStable(nextScale, { x: event.clientX, y: event.clientY });
    };
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    scroller.addEventListener('wheel', handleWheel, { passive: false });
    const unsubscribeIdle = notebookEngine.input.navigationGestures.onIdle(handleScroll);
    handleScroll();
    return () => {
      scroller.removeEventListener('scroll', handleScroll);
      scroller.removeEventListener('wheel', handleWheel);
      unsubscribeIdle();
      if (scrollTimer !== null) clearTimeout(scrollTimer);
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    };
  }, [currentPage, notebookEngine, pdfPageState.pageOrder, getZoomScale, setZoomStable, isZooming, geometryReady]);



  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement || 
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      if (e.key === 'F11') {
        e.preventDefault();
        setNotebookModeLevel(notebookModeLevel === 2 ? 0 : 2);
        return;
      }
      
      if (e.key === 'Escape' && notebookModeLevel > 0) {
        setNotebookModeLevel(0);
      }

      if (workspaceViewMode !== 'edit') {
        if (e.key === 'Escape' && workspaceViewMode === 'present') setWorkspaceViewMode('edit');
        const isZoom = (e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+' || e.key === '-' || e.code === 'Equal' || e.code === 'Minus' || e.code === 'NumpadAdd' || e.code === 'NumpadSubtract');
        const isNavigation = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
        if (!isZoom && !isNavigation) return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            notebookEngine.history.redo();
          } else {
            notebookEngine.history.undo();
          }
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
          e.preventDefault();
          notebookEngine.history.redo();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
          e.preventDefault();
          notebookEngine.selection.copySelection();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
          e.preventDefault();
          notebookEngine.selection.cutSelection();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
          e.preventDefault();
          notebookEngine.selection.pasteSelection();
        }
        
        // Bug 4: Robust zoom shortcuts
        const isZoomIn = e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd';
        const isZoomOut = e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract';
        const isZoomFit = e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0';

        if ((e.ctrlKey || e.metaKey) && isZoomIn) {
          e.preventDefault();
          setZoomStable(notebookEngine.viewport.getState().scale + 0.25);
        }
        if ((e.ctrlKey || e.metaKey) && isZoomOut) {
          e.preventDefault();
          setZoomStable(notebookEngine.viewport.getState().scale - 0.25);
        }
        if ((e.ctrlKey || e.metaKey) && isZoomFit) {
          e.preventDefault();
          notebookEngine.viewport.setPan(0, 0);
          const availableWidth = Math.max(100, containerSize.width - (isSidebarOpen ? sidebarWidth : 0));
          notebookEngine.viewport.setZoom((availableWidth - 40) / paperDimensions.width);
        }
        return;
      }

      const key = e.key.toLowerCase();
      
      switch (key) {
        case 'arrowleft':
          navigateToPage(pdfPageState.pageOrder[Math.max(0, currentOrderIndex - 1)] ?? currentPage);
          break;
        case 'arrowright':
          navigateToPage(pdfPageState.pageOrder[Math.min(pdfPageState.pageOrder.length - 1, currentOrderIndex + 1)] ?? currentPage);
          break;
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
          notebookEngine.selection.deleteSelection();
          break;
        case 'escape':
          notebookEngine.selection.clearSelection();
          break;
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [currentOrderIndex, currentPage, navigateToPage, notebookEngine, notebookModeLevel, pdfPageState.pageOrder, setNotebookModeLevel, setWorkspaceViewMode, setZoomStable, workspaceViewMode]);

  // Load and Save PDF Page Data
  useEffect(() => {
    let cancelled = false;
    async function loadPageData() {
      if (!workspace || !notebook || !page) return;
      const pdfPageId = pdfAnnotationStorageId(page.id, currentPage);
      const drawingData = await notebookRepository.loadDrawingData(workspace.id, notebook.id, pdfPageId);
      if (cancelled) return;
      notebookEngine.setDrawingData(drawingData || createEmptyDrawingData(), pdfPageId);
      setTextObjects([...notebookEngine.texts.getTexts()]);
      setLoadedAnnotationId(pdfPageId);
    }
    void loadPageData();
    return () => { cancelled = true; };
  }, [workspace?.id, notebook?.id, page?.id, currentPage, notebookEngine]);

  // Input stays attached while the document's DOM frame zooms. Raster detail
  // catches up after navigation settles, without losing pointer capture.
  useEffect(() => {
    const timer = setTimeout(() => {
      rasterPending.current = true;
      if (!annotationGestureActive.current) {
        setRasterScale(current => settledPdfScale(current, viewport.scale));
        rasterPending.current = false;
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [viewport.scale]);
  useEffect(() => notebookEngine.onDrawingGestureLifecycle(active => {
    annotationGestureActive.current = active;
    if (!active && rasterPending.current) {
      setRasterScale(current => settledPdfScale(current, notebookEngine.viewport.getState().scale));
      rasterPending.current = false;
    }
  }), [notebookEngine]);

  const annotationConfiguration = useRef('');
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeSceneReady) return;
    notebookEngine.drawing.setScaleMultiplier(rasterScale);
    notebookEngine.mount(canvas, paperDimensions.width, paperDimensions.height);
    annotationConfiguration.current = `${paperDimensions.width}:${paperDimensions.height}:${rasterScale}`;
    return () => {
      annotationConfiguration.current = '';
      if (notebookEngine.drawing.getCanvasElement() === canvas) notebookEngine.unmount();
    };
  }, [notebookEngine, currentPage, page?.id, geometryReady, isLoading, activeSceneReady]);
  useLayoutEffect(() => {
    if (!annotationConfiguration.current) return;
    const next = `${paperDimensions.width}:${paperDimensions.height}:${rasterScale}`;
    if (next === annotationConfiguration.current) return;
    notebookEngine.drawing.setScaleMultiplier(rasterScale);
    notebookEngine.resize(paperDimensions.width, paperDimensions.height);
    annotationConfiguration.current = next;
  }, [notebookEngine, paperDimensions.width, paperDimensions.height, rasterScale]);

  useEffect(() => {
    if (!workspace || !notebook || !page) return;

    let drawingSaveTimeout: NodeJS.Timeout | null = null;
    let hasPendingSave = false;

    const flushSave = () => {
      if (hasPendingSave) {
        const pdfPageId = pdfAnnotationStorageId(page.id, currentPage);
        useCanvasStore.getState().setSaveStatus('saving');
        void pageAudioPersistence.saveDrawing({ workspaceId: workspace.id, notebookId: notebook.id, pageId: pdfPageId }, notebookEngine.getDrawingData(), {
          pdfOwnerPageId: page.id,
          pdfSourcePage: currentPage,
        })
          .then(() => useCanvasStore.getState().setSaveStatus('saved'))
          .catch(error => {
            console.error('[PdfWorkspace] annotation save failed:', error);
            useCanvasStore.getState().setSaveStatus('error');
            useUIStore.getState().showToast('PDF annotations could not be saved.', 'error');
          });
        hasPendingSave = false;
        if (drawingSaveTimeout) {
          clearTimeout(drawingSaveTimeout);
          drawingSaveTimeout = null;
        }
      }
    };

    const scheduleSave = () => {
      hasPendingSave = true;
      if (drawingSaveTimeout) clearTimeout(drawingSaveTimeout);
      
      drawingSaveTimeout = setTimeout(() => {
        flushSave();
      }, 1000);
    };
    const unsubHistory = notebookEngine.history.subscribe(scheduleSave);
    const unsubDrawing = notebookEngine.input.onDrawingChange(scheduleSave);

    return () => {
      unsubHistory();
      unsubDrawing();
      flushSave(); // Ensure pending saves are written to disk before unmounting/changing pages
    };
  }, [notebookEngine, workspace, notebook, page, currentPage]);

  const handleExport = useCallback(async () => {
    if (!workspace || !notebook || !page?.pdfDataId) return;
    try {
      setIsExporting(true);
      await pageAudioPersistence.saveDrawing(
        { workspaceId: workspace.id, notebookId: notebook.id, pageId: pdfAnnotationStorageId(page.id, currentPage) },
        notebookEngine.getDrawingData(),
        { pdfOwnerPageId: page.id, pdfSourcePage: currentPage },
      );
      const result = await exportAnnotatedPdf({
        userId,
        workspaceId: workspace.id,
        notebookId: notebook.id,
        pageId: page.id,
        pdfDataId: page.pdfDataId,
        fileName: page.title,
        pageState: pdfPageState,
      });
      const bytes = new Uint8Array(result.bytes.byteLength);
      bytes.set(result.bytes);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      const message = result.warnings.length > 0
        ? `Exported with warning: ${result.warnings.join(' ')}`
        : `Exported ${result.exportedObjects} annotation object(s).`;
      useUIStore.getState().showToast(message, result.warnings.length > 0 ? 'info' : 'success');
    } catch (error) {
      console.error('[PdfWorkspace] Export failed:', error);
      useUIStore.getState().showToast(error instanceof Error ? error.message : 'PDF export failed.', 'error');
    } finally {
      setIsExporting(false);
    }
  }, [currentPage, notebook, notebookEngine, page, pdfPageState, userId, workspace]);

  const savePdfPageState = useCallback(async (nextState: PdfPageState) => {
    if (!workspace || !page) return;
    await notebookRepository.setPdfPageState(workspace.id, page.id, nextState);
    await loadWorkspaceContents(workspace.id);
  }, [loadWorkspaceContents, page, workspace]);

  const handleRotatePage = useCallback((sourcePage: number, direction: 1 | -1) => {
    void savePdfPageState(rotatePdfPage(pdfPageState, sourcePage, direction)).catch(() => useUIStore.getState().showToast('Page rotation could not be saved.', 'error'));
  }, [pdfPageState, savePdfPageState]);

  const handleMovePage = useCallback((from: number, to: number) => {
    void savePdfPageState(movePdfPage(pdfPageState, from, to)).catch(() => useUIStore.getState().showToast('Page order could not be saved.', 'error'));
  }, [pdfPageState, savePdfPageState]);

  const handleExtractPage = useCallback(async (sourcePage: number) => {
    if (!workspace || !notebook || !page || !pdfDocument) return;
    try {
      const extracted = await extractPdfSourcePage(await pdfDocument.getData(), sourcePage);
      const buffer = extracted.buffer.slice(extracted.byteOffset, extracted.byteOffset + extracted.byteLength) as ArrayBuffer;
      const title = `${page.title.replace(/\.pdf$/i, '')}-page-${sourcePage}.pdf`;
      const stored = await canvasRepository.storePdf(userId, 'temp', title, buffer);
      const created = await notebookRepository.createPage(userId, workspace.id, notebook.id, page.sectionId, title, 'pdf', stored.id);
      await loadWorkspaceContents(workspace.id);
      setActivePage(created.id);
      useUIStore.getState().showToast(`Extracted page ${sourcePage} as a new PDF.`, 'success');
    } catch (extractError) {
      console.error('[PdfWorkspace] page extraction failed:', extractError);
      useUIStore.getState().showToast('PDF page extraction failed.', 'error');
    }
  }, [loadWorkspaceContents, notebook, page, pdfDocument, setActivePage, userId, workspace]);

  const handleLayersChange = useCallback(() => {
    setTextObjects([...notebookEngine.texts.getTexts()]);
    if (!workspace || !notebook || !page) return;
    void pageAudioPersistence.saveDrawing(
      { workspaceId: workspace.id, notebookId: notebook.id, pageId: pdfAnnotationStorageId(page.id, currentPage) },
      notebookEngine.getDrawingData(),
      { pdfOwnerPageId: page.id, pdfSourcePage: currentPage },
    ).catch(error => {
      console.error('[PdfWorkspace] layer save failed:', error);
      useUIStore.getState().showToast('PDF layers could not be saved.', 'error');
    });
  }, [currentPage, notebook, notebookEngine, page, workspace]);

  const handlePageAudioPersisted = useCallback((storagePageId: string, data: DrawingData) => {
    if (!page || storagePageId !== pdfAnnotationStorageId(page.id, currentPage)) return;
    notebookEngine.audio.setAll(data.audioNotes);
  }, [currentPage, notebookEngine, page]);

  // Keep the PDF chrome out of the way while the page is actively edited.
  // Navigation remains available in hand/select mode and is omitted in Present.
  const isPdfInteractionActive = workspaceViewMode === 'present'
    || activeEditor !== null
    || !['hand', 'select'].includes(toolState.mode);
  const showBottomNavigation = workspaceViewMode !== 'present' && !isPdfInteractionActive && !isBottomNavCollapsed;

  if (isLoading) {
    return (
      <main className="h-full bg-panvas-bg-secondary/40 flex items-center justify-center">
        <div className="flex flex-col items-center justify-center text-panvas-text-tertiary">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-panvas-text-primary mb-4"></div>
          Loading PDF...
        </div>
      </main>
    );
  }

  if (error || !pdfDocument) {
    return (
      <main className="h-full bg-panvas-bg-secondary/40 flex items-center justify-center">
        <div className="flex flex-col items-center justify-center text-panvas-text-error">
          {error ? 'Failed to load PDF.' : 'No PDF document attached.'}
        </div>
      </main>
    );
  }

  return (
    <main 
      className="relative flex h-full w-full flex-col overflow-hidden bg-panvas-bg-secondary select-none"
      ref={containerRef}
    >
      {isPhone && workspaceViewMode !== 'present' && <div className="panvas-mobile-document-header">
        <button type="button" aria-label="PDF pages" className="panvas-icon-control" onClick={() => setIsSidebarOpen(value => !value)}><PanelLeftOpen size={18} /></button>
        <button type="button" className="flex-1 text-xs" onClick={() => setMobileControlsOpen(value => !value)} aria-label="PDF page controls">{currentOrderIndex + 1} / {numPages}</button>
        <button type="button" className="px-2 text-xs" aria-label="Fit PDF width" onClick={() => setZoomStable((containerSize.width - 16) / paperDimensions.width)}>Fit width</button>
        <button type="button" aria-label="Open page and view inspector" className="panvas-icon-control" onClick={togglePropertiesPanel}><PanelRight size={18} /></button>
        <NotebookPageUtilities engine={notebookEngine} workspaceId={workspace?.id} notebookId={notebook?.id} ownerId={page ? pdfAnnotationStorageId(page.id, currentPage) : undefined} editable={workspaceViewMode === 'edit'} onPageDataPersisted={handlePageAudioPersisted} onChange={handleLayersChange} compact />
      </div>}
      {isPhone && mobileControlsOpen && <div className="panvas-mobile-sheet panvas-overlay">
        <button type="button" className="panvas-sheet-close" onClick={() => setMobileControlsOpen(false)}>Done</button>
        <BottomNavigation page={currentOrderIndex + 1} totalPages={numPages} onPageChange={orderPage => navigateToPage(pdfPageState.pageOrder[orderPage - 1] ?? currentPage)} engine={notebookEngine} zoom={viewport.scale} onZoom={setZoomStable} onExport={handleExport} isExporting={isExporting} />
      </div>}
      {/* UI Overlays */}
      <div className="panvas-layer-toolbar pointer-events-none absolute inset-0 flex p-4 justify-between pointer-events-none">
        
        {/* Left: Sidebar */}
        {workspaceViewMode !== 'present' && <div
          ref={sidebarRef}
          className={`panvas-floating-surface pointer-events-auto h-full max-h-[calc(100vh-2rem)] w-48 overflow-y-auto xl:w-64 ${isPhone ? 'panvas-mobile-sheet panvas-overlay' : ''} ${!isSidebarOpen ? 'hidden' : ''}`}
        >
          <PdfThumbnailSidebar 
            pdfDocument={pdfDocument} 
            numPages={numPages} 
            currentPage={currentPage} 
            onPageChange={sourcePage => { navigateToPage(sourcePage); if (isPhone) setIsSidebarOpen(false); }}
            isSidebarOpen={isSidebarOpen}
            setIsSidebarOpen={setIsSidebarOpen}
            engine={notebookEngine}
            pageOrder={pdfPageState.pageOrder}
            rotations={pdfPageState.rotations}
            onRotatePage={handleRotatePage}
            onExtractPage={handleExtractPage}
            onMovePage={handleMovePage}
          />
        </div>}

        {/* Bug 1: Persistent Reopen Button when sidebar is closed */}
        {!isPhone && !isSidebarOpen && workspaceViewMode !== 'present' && (
          <div className="absolute left-4 top-4 pointer-events-auto">
            <button 
              type="button"
              onClick={() => setIsSidebarOpen(true)}
              className="panvas-floating-surface panvas-icon-control h-10 w-10 rounded-lg focus-ring"
              title="Open Sidebar"
              aria-label="Open Sidebar"
            >
              <PanelLeftOpen size={18} />
            </button>
          </div>
        )}
        
        {/* Center: Top Toolbar */}
        {!isPhone && <div className="flex-1 flex flex-col justify-between items-center min-w-0 px-4 h-full">
          {/* Top: Notebook Floating Toolbar */}
          <div className="pointer-events-auto mt-2 w-full flex justify-center">
            {workspaceViewMode === 'edit' && <NotebookFloatingToolbar
              engine={notebookEngine}
              editor={activeEditor} 
              saveKey={page ? pdfAnnotationStorageId(page.id, currentPage) : undefined}
              workspaceId={workspace?.id}
            />}
          </div>
          
        </div>

        }
        {/* Dock controls in the reserved bottom chrome band. */}
        {!isPhone && workspaceViewMode !== 'present' && !isPdfInteractionActive && (
          <div className="pointer-events-auto absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-end gap-1">
            {showBottomNavigation && <BottomNavigation
              page={currentOrderIndex + 1}
              totalPages={numPages}
              onPageChange={orderPage => navigateToPage(pdfPageState.pageOrder[orderPage - 1] ?? currentPage)}
              engine={notebookEngine}
              zoom={viewport.scale}
              onZoom={setZoomStable}
              onExport={handleExport}
              isExporting={isExporting}
            />}
            <button
              type="button"
              onClick={() => setIsBottomNavCollapsed(value => !value)}
              className="panvas-floating-surface flex h-8 w-8 items-center justify-center text-panvas-text-secondary transition-colors hover:bg-panvas-bg-hover hover:text-panvas-text-primary focus-ring"
              aria-expanded={showBottomNavigation}
              aria-label={showBottomNavigation ? 'Collapse PDF controls' : 'Expand PDF controls'}
              title={showBottomNavigation ? 'Collapse PDF controls' : 'Expand PDF controls'}
            >
              {showBottomNavigation ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
          </div>
        )}

        {!isPhone && workspaceViewMode !== 'present' && <div className="pointer-events-auto mt-2 flex self-start items-start gap-1.5">
          <NotebookPageUtilities engine={notebookEngine} workspaceId={workspace?.id} notebookId={notebook?.id} ownerId={page ? pdfAnnotationStorageId(page.id, currentPage) : undefined} editable={workspaceViewMode === 'edit'} onPageDataPersisted={handlePageAudioPersisted} onChange={handleLayersChange} compact={containerSize.width < 900} />
          <button
            type="button"
            onClick={togglePropertiesPanel}
            aria-pressed={isPropertiesPanelOpen}
            className={`${iconButtonClass} panvas-floating-surface ${isPropertiesPanelOpen ? 'bg-panvas-bg-active text-panvas-text-primary' : ''}`}
            title="Toggle Page Properties"
            aria-label="Open page and view inspector"
          >
            <PanelRight size={16} />
          </button>
        </div>}
      </div>

      <div ref={documentScrollRef} data-panvas-scroll-viewport style={{ overflowAnchor: 'none' }} className={isPhone ? 'relative min-h-0 flex-1 overflow-auto p-2' : 'absolute inset-0 overflow-auto px-8 pb-28 pt-28'} aria-label="PDF document pages">
        <div className="mx-auto flex min-w-max flex-col items-center gap-8" style={{ width: 'max-content', paddingInline: containerSize.width / 2, paddingBlock: containerSize.height / 2 }}>
          {!geometryReady && <div className="flex min-h-[40vh] items-center justify-center text-sm text-panvas-text-tertiary">Preparing stable page layout…</div>}
          {geometryReady && (!isPhone && paneLayout === 'two-page'
            ? pdfPageState.pageOrder.reduce<number[][]>((rows, sourcePage, index) => {
                if (index % 2 === 0) rows.push([sourcePage]); else rows[rows.length - 1].push(sourcePage);
                return rows;
              }, [])
            : pdfPageState.pageOrder.map(sourcePage => [sourcePage])
          ).map(row => (
            <div key={row.join('-')} className="flex items-start justify-center gap-6">
              {row.map(sourcePage => {
                const descriptor = pageDescriptors[sourcePage] ?? { source: { width: 794, height: 1123 }, noteSpace: resolvePageNoteSpace({}), drawing: createEmptyDrawingData() };
                const rotation = pdfPageState.rotations[sourcePage] ?? 0;
                const active = sourcePage === currentPage;
                const geometry = pdfSurroundingGeometry(descriptor.source, rotation, active && activeSceneReady ? noteSpace : descriptor.noteSpace);
                return <div
                  key={sourcePage}
                  ref={element => { if (element) pageElementRefs.current.set(sourcePage, element); else pageElementRefs.current.delete(sourcePage); }}
                  data-pdf-source-page={sourcePage}
                  onPointerDownCapture={() => { if (!active) navigateToPage(sourcePage); }}
                  className={`relative shrink-0 bg-white shadow-2xl ${active ? 'ring-2 ring-panvas-accent-blue/35' : ''}`}
                  style={{ width: geometry.visual.width * viewport.scale, height: geometry.visual.height * viewport.scale, backgroundColor: fullDarkView ? fullDarkSurfaceColor('#ffffff') : '#ffffff' }}
                >
                  <LazyPdfPageContent active={active}>
                    <div className="absolute" style={{ left: geometry.pdf.x * viewport.scale, top: geometry.pdf.y * viewport.scale, width: geometry.pdf.width * viewport.scale, height: geometry.pdf.height * viewport.scale }}>
                      <div style={{ width: geometry.pdf.width * rasterScale, height: geometry.pdf.height * rasterScale, transform: `scale(${viewport.scale / rasterScale})`, transformOrigin: 'top left' }}>
                        <PdfPageRenderer pdfDocument={pdfDocument} pageNumber={sourcePage} scale={rasterScale} rotation={rotation} />
                      </div>
                    </div>
                    {active && <>
                      <div className="absolute left-0 top-0" style={{ width: geometry.visual.width, height: geometry.visual.height, transform: `scale(${viewport.scale})`, transformOrigin: 'top left' }}>
                      <canvas
                        ref={canvasRef}
                        className={`panvas-colored-content panvas-layer-canvas-decoration absolute inset-0 h-full w-full touch-none ${toolState.mode === 'hand' ? 'cursor-grab active:cursor-grabbing' : toolState.mode === 'text' ? 'cursor-text' : toolState.mode === 'select' ? 'cursor-default' : ''}`}
                        style={{ cursor: resolveDocumentToolCursor(toolState), visibility: activeSceneReady ? 'visible' : 'hidden' }}
                      />
                      </div>
                      {activeSceneReady && textObjects.filter(object => notebookEngine.layers.isVisible(object.layerId)).map(obj => (
                        <FloatingTextEditor
                          key={obj.id}
                          object={obj}
                          engine={notebookEngine}
                          scale={viewport.scale}
                          pdfPlacement={{ rotation, sourceDimensions: geometry.sheet, sourceOffset: geometry.offset }}
                          toolMode={notebookEngine.layers.isEditable(obj.layerId) ? toolState.mode : 'hand'}
                          onFocus={handlePrimaryEditorFocus}
                          onBlur={() => setActiveEditor(null)}
                        />
                      ))}
                    </>}
                    {(!active || !activeSceneReady) && <PdfStaticAnnotationLayer drawing={descriptor.drawing} geometry={geometry} rotation={rotation} scale={viewport.scale} rasterScale={rasterScale} />}
                  </LazyPdfPageContent>
                  {geometry.noteSpace.top + geometry.noteSpace.right + geometry.noteSpace.bottom + geometry.noteSpace.left > 0 && <div className="pointer-events-none absolute border border-panvas-border-subtle" style={{ left: geometry.pdf.x * viewport.scale, top: geometry.pdf.y * viewport.scale, width: geometry.pdf.width * viewport.scale, height: geometry.pdf.height * viewport.scale }} />}
                </div>;
              })}
            </div>
          ))}
        </div>
      </div>
      {isPhone && workspaceViewMode === 'edit' && <div className="panvas-mobile-tool-dock"><NotebookFloatingToolbar engine={notebookEngine} editor={activeEditor} saveKey={page ? pdfAnnotationStorageId(page.id, currentPage) : undefined} workspaceId={workspace?.id} /></div>}
      {isPropertiesPanelOpen && workspaceViewMode !== 'present' && <WorkspaceViewInspectorPanel onClose={togglePropertiesPanel}><PdfNoteSpaceControl engine={notebookEngine} /></WorkspaceViewInspectorPanel>}
      {workspaceViewMode === 'present' && <PresentationOverlay />}
    </main>
  );
}

function PdfStaticAnnotationLayer({ drawing, geometry, rotation, scale, rasterScale }: {
  drawing: DrawingData;
  geometry: ReturnType<typeof pdfSurroundingGeometry>;
  rotation: PdfPageRotation;
  scale: number;
  rasterScale: number;
}) {
  const engine = useMemo(() => new NotebookEngine(), []);
  const fullDarkView = useFullDarkView();
  useLayoutEffect(() => { engine.drawing.setFullDarkView(fullDarkView); }, [engine, fullDarkView]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textObjects = (drawing.objects ?? []).filter((object): object is TextObject => object.type === 'text');
  const visibleLayers = new Set((drawing.layers ?? []).filter(layer => layer.visible).map(layer => layer.id));

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    engine.viewport.setRenderTransform({ pan: false, scale: false });
    engine.drawing.setScaleMultiplier(rasterScale);
    engine.mount(canvas, geometry.visual.width, geometry.visual.height);
    return () => engine.unmount();
  }, [engine]);
  useLayoutEffect(() => {
    engine.viewport.setPageCoordinateTransform(rotation, geometry.sheet.width, geometry.sheet.height, geometry.offset.x, geometry.offset.y);
    engine.drawing.setScaleMultiplier(rasterScale);
    engine.resize(geometry.visual.width, geometry.visual.height);
    engine.setDrawingData(drawing);
  }, [drawing, engine, geometry.offset.x, geometry.offset.y, geometry.sheet.height, geometry.sheet.width, geometry.visual.height, geometry.visual.width, rotation, rasterScale]);

  return <div className="pointer-events-none absolute inset-0" aria-hidden="true">
    <div className="absolute left-0 top-0" style={{ width: geometry.visual.width, height: geometry.visual.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}><canvas ref={canvasRef} className="panvas-colored-content absolute inset-0 h-full w-full" /></div>
    {textObjects.filter(object => visibleLayers.size === 0 || visibleLayers.has(object.layerId ?? 'layer-default')).map(object => (
      <FloatingTextEditor
        key={object.id}
        object={object}
        engine={engine}
        scale={scale}
        pdfPlacement={{ rotation, sourceDimensions: geometry.sheet, sourceOffset: geometry.offset }}
        toolMode="hand"
        onFocus={() => undefined}
        onBlur={() => undefined}
      />
    ))}
  </div>;
}

function LazyPdfPageContent({ active, children }: { active: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(active);
  useEffect(() => {
    if (active) {
      setNearViewport(true);
      return;
    }
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setNearViewport(true);
    }, { rootMargin: '900px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  return <div ref={ref} className="absolute inset-0">{(active || nearViewport) ? children : null}</div>;
}

function BottomNavigation({ 
  page, totalPages, onPageChange, engine, zoom, onZoom, onExport, isExporting
}: { 
  page: number; totalPages: number; onPageChange: (page: number) => void;
  engine: NotebookEngine; zoom: number; onZoom: (zoom: number) => void; onExport: () => void; isExporting: boolean;
}) { 
  const total = totalPages > 0 ? totalPages : 1;
  const zoomPercent = Math.round(zoom * 100);

  const handleZoomOut = () => onZoom(zoom - 0.25);
  const handleZoomIn = () => onZoom(zoom + 0.25);

  // Subscribed, not a bare render-time read. `engine.tools.getState()` on its own gives the
  // value at first paint and never updates: this button showed a stale highlight, and its
  // toggle then computed the wrong target mode from it.
  const isHandTool = useToolState(engine).mode === 'hand';

  return (
    <div className="panvas-floating-surface flex max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-1.5 p-1.5" role="toolbar" aria-label="PDF page controls">
      <div className="panvas-control-group" role="group" aria-label="Page navigation">
        <button type="button" onClick={() => onPageChange(Math.max(1, page - 1))} className={iconButtonClass} aria-label="Previous page"><ChevronLeft size={16} /></button>
        <span className="min-w-[60px] text-center text-xs text-panvas-text-secondary">{page} / {total}</span>
        <button type="button" onClick={() => onPageChange(Math.min(total, page + 1))} className={iconButtonClass} aria-label="Next page"><ChevronRight size={16} /></button>
      </div>
      <div className="panvas-control-group" role="group" aria-label="Zoom">
        <button type="button" onClick={handleZoomOut} className={iconButtonClass} aria-label="Zoom out"><Minus size={16} /></button>
        <span className="min-w-[48px] text-center text-xs text-panvas-text-secondary">{zoomPercent}%</span>
        <button type="button" onClick={handleZoomIn} className={iconButtonClass} aria-label="Zoom in"><Plus size={16} /></button>
      </div>
      <div className="panvas-control-group" role="group" aria-label="PDF utilities">
        <button
          type="button"
          onClick={() => {
            engine.tools.setMode(isHandTool ? 'select' : 'hand');
          }}
          className={`${iconButtonClass} ${isHandTool ? 'bg-panvas-bg-active text-panvas-text-primary' : ''}`}
          title="Pan Tool"
          aria-label="Pan Tool"
        >
          <Hand size={15} />
        </button>
        <button type="button" onClick={onExport} disabled={isExporting} className={iconButtonClass} title="Export annotated PDF" aria-label="Export annotated PDF">
          <Download size={15} />
        </button>
      </div>
    </div>
  ); 
}

/** A page-local command for the currently active source page. */
function PdfNoteSpaceControl({ engine }: { engine: NotebookEngine }) {
  const [properties, setProperties] = useState(engine.getProperties());
  useEffect(() => { setProperties(engine.getProperties()); return engine.onPropertiesChange(setProperties); }, [engine]);
  const update = (updates: Partial<typeof properties>) => {
    const before = engine.getProperties();
    const after = { ...before, ...updates };
    engine.history.push({ description: 'Change PDF research space', execute: () => engine.setProperties(after), undo: () => engine.setProperties(before) });
  };
  return <NoteSpaceControl properties={properties} onChange={update} />;
}
