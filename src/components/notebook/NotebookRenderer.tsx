import type { ImageManager } from './engine/ImageManager';
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react';
import { NotebookEngine } from './engine/NotebookEngine';
import type { ViewportState } from './engine/drawingTypes';
import { useUIStore } from '@/stores/uiStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { useAuthStore } from '@/stores/authStore';
import { UniversalDropRouter } from '@/services/drop/UniversalDropRouter';
import { useLayoutStore } from '@/stores/layoutStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { NotebookToolPropertiesPanel } from './NotebookToolPropertiesPanel';
import { NotebookFloatingToolbar } from './NotebookFloatingToolbar';
import { NotebookNavigator } from './NotebookNavigator';
import { NotebookWorkspaceControls } from './NotebookWorkspaceControls';
import { NotebookPageUtilities } from './NotebookPageUtilities';
import { PresentationOverlay } from '@/components/workspace/PresentationOverlay';
import { resolveNotebookNavigationDelta, shouldNotebookHandleNavigationKey } from './notebookNavigation';
import { NotebookPageView } from './NotebookPageView';
import { PageRenderer } from './PageRenderer';
import { residentPageIds, dominantPageId } from './pageVisualWindow';
import { NotebookContextMenu, type ContextMenuState } from './NotebookContextMenu';
import { HandwritingConversionDialog } from './HandwritingConversionDialog';
import type { Editor } from '@tiptap/react';
import { notebookRepository } from '@/repositories/NotebookRepository';
import { exportNotebookToPdf, exportPageToPdf, printNotebook, printPage } from '@/services/pdf/notebookExportCommands';
import { type AudioNote, type TextObject, type Stroke, createEmptyDrawingData, type DrawingData, type NotebookMode } from './engine/drawingTypes';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { generateId } from '@/lib/utils/id';
import { getSafeHttpUrl, htmlToTipTapJson } from './tiptapExtensions';
import { useToolState } from './useEngineState';
import { attachTwoFingerViewportGesture } from './engine/touchViewportGesture';
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport';
import { capturePageGeometryAnchor, derivePagePropertyOverrides, getNotebookPageDefaults, hasAuthoritativePageAppearance, resolveNotebookPageLayout, resolvePageDimensions, resolvePageGeometryScrollDelta, resolvePageProperties, resolvePageRenderProperties, type PageGeometryAnchor } from '@/lib/pageProperties';
import type { NotebookPropertyBatchSnapshot, PagePropertySet } from '@/types/notebook';
import { createStickyNote, STICKY_NOTE_MIN_HEIGHT, STICKY_NOTE_WIDTH } from './stickyNotes';
import type { HandwritingToolPreferences } from '@/services/beautification/handwritingBeautification';
import type { ReviewedHandwritingLine } from '@/services/recognition/bulkConversion';
import { PanelTopOpen, PanelRight, Plus } from 'lucide-react';
import { pageAudioPersistence } from '@/services/audio/pageAudioPersistenceInstance';
import { changeVoiceNote, type VoiceState } from '@/services/audio/voiceNoteCommands';
import { formatPageIndicator } from './pageIndicator';
import {
  captureFreshPageOwnedDrawing,
  hasValidPageDrawingOwnership,
  mayApplyPageLoadToEngine,
  mayPersistPagePropertyChange,
  isPaperColorOnlyUpdate,
  mergeLoadedPageData,
  resolveNotebookPageRenderData,
  type PageOwnedDrawing,
} from './notebookPageRenderState';
import { gate0Profiler } from '@/dev/gate0Profiler';
import { recordHandwritingTraceMarker } from '@/dev/handwritingTrace';
import { DrawingSaveScheduler } from './drawingSaveScheduler';

const clipboardCodeLanguages = new Set([
  'python', 'javascript', 'typescript', 'java', 'c', 'cpp', 'csharp',
  'go', 'rust', 'sql', 'bash', 'shell', 'json', 'html', 'css',
  'markdown', 'jsx', 'tsx',
]);

const plainTextUrlPattern = /https?:\/\/[^\s<>"']+/gi;

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

function textContentWithSafeLinks(text: string): any[] {
  const content: any[] = [];
  let cursor = 0;

  for (const match of text.matchAll(plainTextUrlPattern)) {
    const start = match.index ?? 0;
    const rawUrl = match[0];
    // Sentence punctuation is not normally part of a copied URL.
    const url = rawUrl.replace(/[),.;!?]+$/, '');
    const safeUrl = getSafeHttpUrl(url);

    if (!safeUrl) continue;
    if (start > cursor) content.push({ type: 'text', text: text.slice(cursor, start) });
    content.push({ type: 'text', text: safeUrl, marks: [{ type: 'link', attrs: { href: safeUrl } }] });
    cursor = start + rawUrl.length;
  }

  if (cursor < text.length) content.push({ type: 'text', text: text.slice(cursor) });
  return content;
}

/**
 * Converts only properly fenced Markdown code into the existing TipTap
 * codeBlock schema. Returning null leaves the established plain-text path
 * untouched.
 */
function parsePlainTextClipboard(text: string): any | null {
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const content: any[] = [];
  const proseLines: string[] = [];
  let foundFence = false;

  const appendProse = () => {
    for (const line of proseLines) {
      content.push({
        type: 'paragraph',
        content: line ? textContentWithSafeLinks(line) : [],
      });
    }
    proseLines.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const openingFence = lines[index].match(/^ {0,3}```([^\s`]*)[ \t]*$/);
    if (!openingFence) {
      proseLines.push(lines[index]);
      continue;
    }

    const closingIndex = lines.findIndex(
      (line, candidate) => candidate > index && /^ {0,3}```[ \t]*$/.test(line),
    );
    if (closingIndex === -1) {
      return null;
    }

    appendProse();
    const requestedLanguage = openingFence[1].toLowerCase();
    const language = clipboardCodeLanguages.has(requestedLanguage) ? requestedLanguage : null;
    const code = lines.slice(index + 1, closingIndex).join(lineEnding);
    content.push({
      type: 'codeBlock',
      attrs: { language },
      content: code ? [{ type: 'text', text: code }] : [],
    });
    foundFence = true;
    index = closingIndex;
  }

  appendProse();
  return foundFence ? { type: 'doc', content } : null;
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
  const { activePageId, notebookPages, notebookSections, notebooks, workspaces, activeNotebookSectionId } = useWorkspaceStore();
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
    if (!gate0Profiler.isEnabled()) return;
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
  const [sectionDataCache, setSectionDataCache] = useState<Record<string, DrawingData>>({});
  const sectionDataCacheRef = useRef<Record<string, DrawingData>>({});
  const updateSectionDataCache = useCallback((update: (current: Record<string, DrawingData>) => Record<string, DrawingData>) => {
    const next = update(sectionDataCacheRef.current);
    sectionDataCacheRef.current = next;
    setSectionDataCache(next);
  }, []);
  const focusedPageLoadGenerationRef = useRef(0);
  const loadedSceneRevisionRef = useRef<number | null>(null);
  const residentImageManagersRef = useRef(new Map<string, ImageManager>());
  const registerPageImages = useCallback((pageId: string, images: ImageManager | null) => {
    if (images) residentImageManagersRef.current.set(pageId, images);
    else residentImageManagersRef.current.delete(pageId);
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
  const deferredPageSavesRef = useRef(new Map<string, PageOwnedDrawing>());
  const deferredSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drawingSaveSchedulerRef = useRef<DrawingSaveScheduler<PageOwnedDrawing> | null>(null);
  if (!drawingSaveSchedulerRef.current) {
    drawingSaveSchedulerRef.current = new DrawingSaveScheduler<PageOwnedDrawing>(
      snapshot => persistDrawingRef.current(snapshot),
      { onEvent: event => recordHandwritingTraceMarker(event.type, event) },
    );
  }
  const latestScheduledDrawingRevisionRef = useRef(new Map<string, number>());
  const latestScheduledDrawingFingerprintRef = useRef(new Map<string, string>());
  const [, setTextObjects] = useState<TextObject[]>([]);
  const latestCapturedDrawingRef = useRef(new Map<string, PageOwnedDrawing>());
  const [, setSelectionRevision] = useState(0);
  const [handwritingStrokes, setHandwritingStrokes] = useState<Stroke[]>([]);
  const [isHandwritingDialogOpen, setIsHandwritingDialogOpen] = useState(false);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [, setLayerRevision] = useState(0);
  const { isPropertiesPanelOpen } = useUIStore();
  const { notebookModeLevel, setNotebookModeLevel, workspaceViewMode, setWorkspaceViewMode, isToolbarCollapsed, setToolbarCollapsed } = useLayoutStore();
  const setActivePage = useWorkspaceStore(s => s.setActivePage);
  const createNotebookPage = useWorkspaceStore(s => s.createNotebookPage);
  const reorderPages = useWorkspaceStore(s => s.reorderPages);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const fullscreenToolbarHostRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [fullscreenToolbarHostWidth, setFullscreenToolbarHostWidth] = useState<number | null>(null);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [debouncedScale, setDebouncedScale] = useState(1.0);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedScale(viewport.scale);
    }, 150);
    return () => clearTimeout(handler);
  }, [viewport.scale]);

  useEffect(() => {
    if (workspaceViewMode !== 'edit') {
      notebookEngine.tools.setMode('hand');
      setActiveEditor(null);
    }
  }, [notebookEngine, workspaceViewMode]);

  // True for the lifetime of a viewport pan gesture. Transferring page focus runs
  // NotebookPageView's mount-effect cleanup — notebookEngine.unmount() ->
  // InputManager.detach() — so it must never happen while a pan is in flight. Panning scrolls
  // by definition, and scrolling is exactly what triggers a focus transfer, so these two have
  // to be sequenced rather than left to race.
  const panGestureActiveRef = useRef(false);
  // Focus transfer requested by the scroll observer while a pan was in flight; applied when
  // the gesture ends.
  const pendingFocusPageIdRef = useRef<string | null>(null);
  const pageGeometryTransitionRef = useRef<{ pageId: string; anchor: PageGeometryAnchor } | null>(null);
  const pageGeometryReleaseRafRef = useRef<number | null>(null);
  const [pageGeometryTransitionRevision, setPageGeometryTransitionRevision] = useState(0);
  // handleActivatePage is defined further down (it needs the section cache) and is rebuilt
  // whenever that cache changes. Effects that outlive those rebuilds must always call the
  // latest version — a captured stale copy would flush the wrong outgoing page — so they go
  // through this ref, which is reassigned on every render right after the callback is created.
  const handleActivatePageRef = useRef<(targetPageId: string) => void>(() => {});

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
    
    const unsubSelection = notebookEngine.selection.subscribe(() => setSelectionRevision(revision => revision + 1));
    return () => {
      unsubViewport();
      unsubProps();
      unsubSelection();
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
    const fitKey = `${isMobileViewport}:${containerSize.width}:${paperDimensions.width}:${activeNotebookSectionId}`;
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
      const cachedProperties = sectionDataCache[sectionPage.id]?.properties;
      // On first load there is no cache yet, so persisted metadata remains the
      // source until the engine finishes loading.
      return [sectionPage.id, resolvePageRenderProperties(notebook, sectionPage, cachedProperties)] as const;
    }));
  }, [currentSectionPages, notebook, sectionDataCache]);

  const layoutConfig = useMemo(() => resolveNotebookPageLayout(
    currentSectionPages.map(sectionPage => ({
      id: sectionPage.id,
      properties: resolvedSectionProperties.get(sectionPage.id)!,
    })),
    spreadMode,
  ), [currentSectionPages, resolvedSectionProperties, spreadMode]);
  const sectionAppearanceReady = currentSectionPages.every(sectionPage =>
    hasAuthoritativePageAppearance(sectionPage, sectionDataCache[sectionPage.id]?.properties),
  );

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
  const handlePanelZoom = useCallback((newZoom: number) => {
    const container = containerRef.current;
    if (!container) return;
    const clampedZoom = Math.max(0.25, Math.min(4.0, newZoom));
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

  // Viewport-level panning: Hand tool (left button) and middle mouse button.
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
    let activePanSource: 'hand' | 'middle' | null = null;
    let startClientX = 0;
    let startClientY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;

    const isPanGesture = (e: PointerEvent): boolean => {
      // Touch is left to the container's native scrolling; capturing it here would apply
      // the gesture twice. Touch over the focused canvas (where `touch-action: none`
      // suppresses native scrolling) is still handled by InputManager.
      if (e.pointerType === 'touch') return false;
      if (e.button === 1) return true;
      return e.button === 0 && notebookEngine.tools.getState().mode === 'hand';
    };

    const onPointerDown = (e: PointerEvent) => {
      if (activePointerId !== null || !isPanGesture(e)) return;

      // Suppresses middle-click autoscroll, and for the Hand tool also suppresses text
      // selection, drag-start and focus changes for the duration of the drag.
      e.preventDefault();

      activePointerId = e.pointerId;
      activePanSource = e.button === 1 ? 'middle' : 'hand';
      container.dataset.panActive = 'true';
      container.dataset.panSource = activePanSource;
      container.dataset.panPointer = String(e.pointerId);
      panGestureActiveRef.current = true;
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
      activePanSource = null;
      container.dataset.panActive = 'false';
      delete container.dataset.panSource;
      delete container.dataset.panPointer;
      panGestureActiveRef.current = false;
      if (releaseCapture) {
        try {
          if (container.hasPointerCapture(finishedPointerId)) {
            container.releasePointerCapture(finishedPointerId);
          }
        } catch (err) {
          // Ignore DOMException if capture is already lost
        }
      }
      const pendingFocusPageId = pendingFocusPageIdRef.current;
      if (pendingFocusPageId) {
        pendingFocusPageIdRef.current = null;
        handleActivatePageRef.current(pendingFocusPageId);
      }
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
      // Middle-button panning is tool-independent. A left-button Hand gesture, however,
      // cannot remain authoritative after the user has selected another tool.
      if (activePanSource === 'hand' && state.mode !== 'hand') finishGesture();
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
  }, [notebookEngine, hasActivePage]);

  // The page canvas opts out of browser gestures so single-finger ink and
  // selection stay exact. Put a two-finger viewport controller on the actual
  // scroll surface so pinch/pan starts naturally on paper rather than only in
  // the surrounding margin.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return attachTwoFingerViewportGesture({
      target: container,
      getScale: () => notebookEngine.viewport.getState().scale,
      setScale: scale => notebookEngine.viewport.setZoom(scale),
      cancelActivePointerInteraction: () => notebookEngine.input.cancelActivePointerInteraction(),
      getContentOffset: scale => ({ x: Math.max((container.clientWidth - layoutConfig.totalWidth * scale) / 2, isMobileViewport ? 8 : 32), y: 0 }),
    });
  }, [notebookEngine, hasActivePage, layoutConfig.totalWidth, isMobileViewport]);


  // Central persistence writer for drawing data. Every notebook save goes
  // through here so the StatusBar save indicator reflects reality and a
  // failed write is surfaced instead of silently dropped: the roadmap's
  // "intentional failure does not falsely report save success" contract.
  const lastSaveErrorToastAtRef = useRef(0);
  const persistDrawing = useCallback((snapshot: PageOwnedDrawing | null) => {
    if (!snapshot || !hasValidPageDrawingOwnership(snapshot)) {
      return;
    }
    const pageId = snapshot.saveTargetSheetId;
    const data = snapshot.data;
    const latestScheduledRevision = latestScheduledDrawingRevisionRef.current.get(pageId);
    const latestScheduledFingerprint = latestScheduledDrawingFingerprintRef.current.get(pageId);
    // A lower revision is provably stale without traversing the page snapshot.
    if (latestScheduledRevision !== undefined && snapshot.drawingRevision < latestScheduledRevision) {
      return;
    }
    recordHandwritingTraceMarker('saveStarted', {
      pageId: snapshot.sheetId,
      revision: snapshot.drawingRevision,
    });
    recordHandwritingTraceMarker('stringifyStarted', { pageId, revision: snapshot.drawingRevision });
    const fingerprint = JSON.stringify(data);
    recordHandwritingTraceMarker('stringifyEnded', { pageId, revision: snapshot.drawingRevision });
    if (latestScheduledRevision !== undefined && snapshot.drawingRevision === latestScheduledRevision
      && fingerprint === latestScheduledFingerprint) return;
    latestScheduledDrawingRevisionRef.current.set(pageId, snapshot.drawingRevision);
    latestScheduledDrawingFingerprintRef.current.set(pageId, fingerprint);
    const { notebookPages: allPages, notebooks: allNotebooks, workspaces: allWorkspaces } = useWorkspaceStore.getState();
    const targetPage = allPages.find(p => p.id === pageId) ?? notebookPages.find(p => p.id === pageId);
    if (!targetPage) {
      return;
    }
    const targetNotebook = allNotebooks.find(n => n.id === targetPage.notebookId) ?? notebooks.find(n => n.id === targetPage.notebookId);
    if (!targetNotebook || targetNotebook.id !== snapshot.documentId) {
      return;
    }
    const targetWorkspace = allWorkspaces.find(w => w.id === targetNotebook.workspaceId) ?? workspaces.find(w => w.id === targetNotebook.workspaceId);
    if (!targetWorkspace) {
      return;
    }

    updateSectionDataCache(prev => prev[pageId] === data ? prev : { ...prev, [pageId]: data });
    useCanvasStore.getState().setSaveStatus('saving');
    recordHandwritingTraceMarker('ipcSaveStart', { pageId, revision: snapshot.drawingRevision });
    pageAudioPersistence.saveDrawing({ workspaceId: targetWorkspace.id, notebookId: targetNotebook.id, pageId }, data)
      .then(savedData => {
        recordHandwritingTraceMarker('ipcSaveEnd', { pageId, revision: snapshot.drawingRevision, ok: true });
        // The persisted result belongs to this exact snapshot. If the live
        // engine has produced a newer cache entry while the write was in
        // flight, keep that newer entry visible instead of rolling the page
        // back until the next interaction.
        updateSectionDataCache(prev => prev[pageId] === data
          ? { ...prev, [pageId]: savedData }
          : prev);
        if (focusedPageIdRef.current === pageId) notebookEngine.audio.setAll(savedData.audioNotes);
        useCanvasStore.getState().setSaveStatus('saved');
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('panvas:notebook-content-changed', { detail: { pageId } }));
        }
      })
      .catch(err => {
        recordHandwritingTraceMarker('ipcSaveEnd', { pageId, revision: snapshot.drawingRevision, ok: false });
        useCanvasStore.getState().setSaveStatus('error');
        console.error('[NotebookRenderer] drawing save failed:', err);
        const now = Date.now();
        if (now - lastSaveErrorToastAtRef.current > 10000) {
          lastSaveErrorToastAtRef.current = now;
          useUIStore.getState().showToast('Save failed. Your changes are kept in memory and will retry on the next edit.', 'error');
        }
      });
  }, [notebookEngine, notebookPages, notebooks, workspaces, updateSectionDataCache]);
  persistDrawingRef.current = persistDrawing;

  // Debounced writes belong to immutable page snapshots, not to a particular
  // render/effect instance. Rebinding subscriptions while scrolling must not
  // discard the final sheet's pending edit. A genuine unmount flushes both
  // queues before their timers are cleared.
  useEffect(() => () => {
    const pendingProperty = pendingPropertySaveRef.current;
    pendingPropertySaveRef.current = null;
    if (propertySaveTimeoutRef.current) clearTimeout(propertySaveTimeoutRef.current);
    propertySaveTimeoutRef.current = null;
    if (pendingProperty) persistDrawingRef.current(pendingProperty);
    drawingSaveSchedulerRef.current?.flush();
    if (deferredSaveTimerRef.current) clearTimeout(deferredSaveTimerRef.current);
    for (const snapshot of deferredPageSavesRef.current.values()) persistDrawingRef.current(snapshot);
    deferredPageSavesRef.current.clear();
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
    if (!targetPageId || focusedPageId === targetPageId) return;
    // Focus owns the shared engine and may only move once target data is
    // available. The section preload will update this effect when a cache gap
    // is filled; until then the existing focused page remains authoritative.
    if (sectionDataCacheRef.current[targetPageId]) {
      handleActivatePageRef.current(targetPageId);
    }
  }, [activePageId, focusedPageId, currentSectionPages, sectionDataCache]);

  const handlePagePropertiesUpdate = useCallback((updates: Partial<PagePropertySet>) => {
    const previousProperties = notebookEngine.getProperties();
    const noteSpaceKeys: (keyof PagePropertySet)[] = ['extraHeight', 'extraTop', 'extraRight', 'extraBottom', 'extraLeft'];
    const isNoteSpaceChange = noteSpaceKeys.some(key => key in updates);
    const isLineColorChange = updates.ruleLineColor !== undefined;
    const changesDimensions =
      (updates.orientation !== undefined && updates.orientation !== previousProperties.orientation)
      || (updates.pageSize !== undefined && updates.pageSize !== previousProperties.pageSize)
      || isNoteSpaceChange;
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
    if (isNoteSpaceChange || isLineColorChange) {
      notebookEngine.history.push({
        description: isNoteSpaceChange ? 'Change research space' : 'Change line color',
        execute: () => applyProperties(nextProperties),
        undo: () => applyProperties(previousProperties),
      });
    } else applyProperties(nextProperties);
  }, [notebookEngine, notebook, workspace, updateSectionDataCache]);

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
      notebookEngine.setDrawingData(cachedData, requestedPageId);
    loadedSceneRevisionRef.current = notebookEngine.getDrawingOwnership().revision;
    } else {
      notebookRepository.loadDrawingData(workspace.id, notebook.id, requestedPageId).then(loaded => {
        if (cancelled) return;
        const raw = (loaded || createEmptyDrawingData()) as DrawingData;
        const pageMetadata = notebookPages.find(item => item.id === requestedPageId);
        const d = { ...raw, properties: resolvePageProperties(notebook, pageMetadata, raw.properties) };
        const effectiveData = sectionDataCacheRef.current[requestedPageId] ?? d;
        updateSectionDataCache(prev => prev[requestedPageId] ? prev : { ...prev, [requestedPageId]: d });
        if (!mayApplyPageLoadToEngine(
          requestedPageId,
          focusedPageIdRef.current,
          requestGeneration,
          focusedPageLoadGenerationRef.current,
        )) return;
        notebookEngine.setDrawingData(effectiveData, requestedPageId);
    loadedSceneRevisionRef.current = notebookEngine.getDrawingOwnership().revision;
      });
    }
    return () => { cancelled = true; };
  }, [focusedPageId, workspace?.id, notebook?.id, notebookEngine, notebookPages, updateSectionDataCache]);

  // Safe Autosave: debounced write strictly on user drawing actions
  useEffect(() => {
    const onUserDrawingAction = () => {
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
      updateSectionDataCache(prev => prev[currentPageId] === pageOwnedSnapshot.data
        ? prev
        : { ...prev, [currentPageId]: pageOwnedSnapshot.data });
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
      recordHandwritingTraceMarker(active ? 'penDown' : 'penUp');
      drawingSaveSchedulerRef.current?.setGestureActive(active);
    });
    return () => {
      unsubscribe();
      drawingGestureActiveRef.current = false;
      drawingSaveSchedulerRef.current?.setGestureActive(false);
    };
  }, [notebookEngine]);

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
  const handleActivatePage = useCallback((targetPageId: string) => {
    const activationStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
    if (targetPageId === focusedPageIdRef.current) return;

    const incomingData = sectionDataCacheRef.current[targetPageId];
    if (!incomingData) {
      // Never install an empty placeholder into the shared engine for a page
      // that may have persisted objects. Mark it active and let the existing
      // section preload fill this page-ID cache gap before transferring focus.
      setActivePage(targetPageId);
      return;
    }

    // Mutations already captured an immutable, page-owned snapshot. Transfer
    // the scheduler's single pending slot to a page-keyed task queue, so an edit
    // on B cannot overwrite A's pending save. Keep the lifecycle fallback for
    // an uncaptured revision; never trade persistence safety for smooth scroll.
    const outgoingPageId = focusedPageIdRef.current;
    if (outgoingPageId) {
      notebookEngine.input.flushPendingErasing();
      const owner = notebookEngine.getDrawingOwnership();
      const latest = latestCapturedDrawingRef.current.get(outgoingPageId);
      if (latest && latest.drawingRevision === owner.revision) {
        if (drawingSaveSchedulerRef.current?.peek()?.sheetId === outgoingPageId) drawingSaveSchedulerRef.current.clear();
        if (latestScheduledDrawingRevisionRef.current.get(outgoingPageId) !== latest.drawingRevision) {
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
    if (oldSlot?.getAttribute('data-page-id') === outgoingPageId) {
      const backing = oldSlot.querySelector<HTMLElement>('[data-stable-page-visual]');
      const interaction = oldSlot.querySelector<HTMLElement>('[data-live-page-visual]');
      if (backing) backing.style.visibility = 'visible';
      if (interaction) interaction.style.visibility = 'hidden';
    }
    notebookEngine.unmount();
    const incomingImages = residentImageManagersRef.current.get(targetPageId);
    if (incomingImages) notebookEngine.images.adoptDecodedImages(incomingImages,
      (incomingData.objects ?? []).filter(object => object.type === 'image').map(object => object.fileId));
    notebookEngine.setDrawingData(incomingData, targetPageId);
    loadedSceneRevisionRef.current = notebookEngine.getDrawingOwnership().revision;
    focusedPageIdRef.current = targetPageId;

    // 3. Switch focusedPageId & activePageId
    setFocusedPageId(targetPageId);
    setActivePage(targetPageId);
    if (activationStartedAt) gate0Profiler.event('page-focus-transfer', performance.now() - activationStartedAt, { targetPageId });
  }, [flushOwnedPageDrawing, notebookEngine, setActivePage]);

  handleActivatePageRef.current = handleActivatePage;

  const [visualWindow, setVisualWindow] = useState({ top: 0, height: 0 });
  const residentIds = useMemo(() => residentPageIds(
    layoutConfig.positions, visualWindow.top, visualWindow.height || containerSize.height / viewport.scale,
  ), [layoutConfig.positions, visualWindow, containerSize.height, viewport.scale]);

  // Real-time visible page detection on vertical scroll (Passive Observational Update)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let scrollRafId: number | null = null;

    const onScroll = () => {
      if (scrollRafId !== null) return;

      scrollRafId = requestAnimationFrame(() => {
        const scrollStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
        let geometryReads = 0;
        scrollRafId = null;
        if (!container) return;

        const scale = notebookEngine.viewport.getState().scale;
        const top = container.scrollTop / scale;
        const height = container.clientHeight / scale;
        setVisualWindow(previous => previous.top === top && previous.height === height ? previous : { top, height });
        const dominantId = dominantPageId(layoutConfig.positions, top + height / 2,
          currentActivePageIdRef.current || '', 24 / scale);
        const dominantPage = currentSectionPages.find(page => page.id === dominantId);

        if (isNavigatingRef.current || pageGeometryTransitionRef.current) return;

        if (dominantPage && dominantPage.id !== currentActivePageIdRef.current) {
          if (dominantPage.type === 'pdf') {
            // Never allow passive scroll over a PDF preview in NotebookRenderer to hijack activePageId!
            return;
          }
          currentActivePageIdRef.current = dominantPage.id;
          // Suppresses the scroll-to-page layout effect below, which is only meant to react
          // to sidebar/navigator navigation, not to the user's own scrolling.
          lastNavigatedPageIdRef.current = dominantPage.id;
          setActivePage(dominantPage.id);

          // Focus has to follow. `focusedPageId` decides which page owns the live engine
          // canvas and the interactive FloatingTextEditor nodes; every other page renders a
          // `pointer-events-none` StaticTextPreview over a `pointer-events-none` canvas, so
          // it has no interactive text DOM at all. This observer used to update only
          // `activePageId` — the page indicator — and leave focus behind on whichever page
          // was last *clicked*, which made text (and drawing) inert on the page actually on
          // screen until a throwaway click re-activated it. The two values are no longer
          // independent: the dominant page is the single source of truth and focus is derived
          // from it.
          // it has no interactive text DOM at all.
          if (panGestureActiveRef.current) {
            // Deferred rather than dropped: transferring focus mid-pan would unmount the
            // engine under the live gesture. Applied by endGesture in the pan effect.
            pendingFocusPageIdRef.current = dominantPage.id;
          } else {
            handleActivatePageRef.current(dominantPage.id);
          }
        }
        if (scrollStartedAt) gate0Profiler.event('notebook-scroll-handler', performance.now() - scrollStartedAt, {
          pages: currentSectionPages.length,
          geometryReads,
        });
      });
    };

    setVisualWindow({ top: container.scrollTop / viewport.scale, height: container.clientHeight / viewport.scale });
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (scrollRafId !== null) {
        cancelAnimationFrame(scrollRafId);
      }
    };
  }, [currentSectionPages, setActivePage, layoutConfig.positions, viewport.scale, containerSize.height, notebookEngine]);

  // Scroll to active page when activePageId changes from sidebar/navigator clicks
  useLayoutEffect(() => {
    if (!sectionAppearanceReady) return;
    if (!activePageId || activePageId === lastNavigatedPageIdRef.current) return;

    handleActivatePage(activePageId);

    const scrollToTarget = () => {
      const pageElem = document.getElementById(`page-${activePageId}`);
      const container = containerRef.current;
      if (!container) return false;

      if (pageElem) {
        const containerRect = container.getBoundingClientRect();
        const pageRect = pageElem.getBoundingClientRect();
        const relativeTop = pageRect.top - containerRect.top;
        const pageOutsideHorizontalViewport = pageRect.left < containerRect.left || pageRect.right > containerRect.right;
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
      pageCenterY = (visibleCenterY - pageRect.top) / (viewport.scale || 1);
    }

    const x = Math.max(20, Math.min(paperDimensions.width - contentWidth - 20, Math.round((paperDimensions.width - contentWidth) / 2)));
    const y = Math.max(20, Math.min(paperDimensions.height - contentHeight - 20, Math.round(pageCenterY - contentHeight / 2)));

    return { x, y };
  }, [focusedPageId, activePageId, paperDimensions, viewport.scale]);

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
            pageY = pt.y;
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
  }, [focusedPageId, activePageId, notebookEngine, paperDimensions, getSensiblePastePosition, workspace, notebook]);

  // Import rich text formatted content as editable TextObject (OneNote style paste)
  const importRichText = useCallback((content: any, customX?: number, customY?: number, pastePresentation?: 'sticky-note' | 'mixed-paste') => {
    if (!notebookEngine.drawing.canEditActiveLayer()) return;
    if (!content || !content.content || content.content.length === 0) return;
    const targetPageId = focusedPageId || activePageId;
    if (!targetPageId) return;

    // Check if content has codeBlock or large elements to size appropriately
    const contentStr = JSON.stringify(content);
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
  }, [focusedPageId, activePageId, getSensiblePastePosition, notebookEngine, workspace, notebook]);

  // Import text as editable TextObject (plain text fallback)
  const importText = useCallback((rawText: string, customX?: number, customY?: number, pastePresentation?: 'sticky-note') => {
    if (!notebookEngine.drawing.canEditActiveLayer()) return;
    if (!rawText.trim()) return;
    const targetPageId = focusedPageId || activePageId;
    if (!targetPageId) return;

    const lines = rawText.split(/\r?\n/);
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
  }, [focusedPageId, activePageId, toolState.color, getSensiblePastePosition, notebookEngine, workspace, notebook]);

  const handledPasteEvents = useRef(new WeakSet<Event>());

  // Unified clipboard paste handler (strictly obeys live OS clipboard precedence)
  const handlePasteFromClipboard = useCallback(async (e?: React.ClipboardEvent | ClipboardEvent) => {
    // 1. If inside a native input / TipTap text editor, let it paste natively
    const isTextEditing = (
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
  }, [importImage, importRichText, importText, notebookEngine]);

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
        if (isTextEditing) {
          document.execCommand('undo');
        } else if (notebookEngine.history.canUndo()) {
          notebookEngine.history.undo();
          setTextObjects([...notebookEngine.texts.getTexts()]);
          notebookEngine.drawing.redraw();
        }
        break;
      case 'redo':
        if (isTextEditing) {
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
  }, [handlePasteFromClipboard, workspaceViewMode]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
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

    try {
      // The repository creates new pages at the end. Reinsert the new id after
      // the current page so the quick action has predictable notebook semantics.
      const existingIds = currentSectionPages.map(item => item.id);
      const created = await createNotebookPage(sectionId, 'New page');
      const activeIndex = existingIds.indexOf(activePageId ?? '');
      const insertAt = activeIndex >= 0 ? activeIndex + 1 : existingIds.length;
      existingIds.splice(insertAt, 0, created.id);
      await reorderPages(existingIds);
      setActivePage(created.id);
    } catch (error) {
      console.error('[NotebookRenderer] quick page insertion failed:', error);
      useUIStore.getState().showToast('Could not insert a new page.', 'error');
    }
  }, [activePageId, activeNotebookSectionId, createNotebookPage, currentSectionPages, page?.sectionId, reorderPages, setActivePage]);

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
      {isMobileViewport && workspaceViewMode !== 'present' && <div className="panvas-mobile-document-header">
        <button type="button" className="min-w-0 flex-1 truncate text-left text-xs font-medium" onClick={() => useUIStore.getState().toggleSidebar()} title="Browse notebook pages">{focusedPage?.title ?? 'Notebook'}</button>
        <button type="button" onClick={() => handlePanelZoom((containerSize.width - 16) / paperDimensions.width)} className="px-2 text-xs" aria-label="Fit page width">Fit width</button>
        <button type="button" className="panvas-icon-control focus-ring" onClick={() => useUIStore.getState().togglePropertiesPanel()} aria-label="Open page and view inspector" aria-expanded={isPropertiesPanelOpen}><PanelRight size={18} /></button>
        <NotebookPageUtilities engine={notebookEngine} workspaceId={workspace?.id} notebookId={notebook?.id} ownerId={focusedPage?.id} editable={workspaceViewMode === 'edit'} onPageDataPersisted={handlePageAudioPersisted} onVoiceDelete={handleDeleteVoiceNote} onVoiceRename={handleRenameVoiceNote} onChange={handleLayersChange} compact onExportPage={() => void handleExportPagePdf()} onExportNotebook={() => void handleExportNotebookPdf()} onPrintPage={() => void handlePrintPage()} onPrintNotebook={() => void handlePrintNotebook()} isExporting={isExportingPdf} />
      </div>}
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
              {workspaceViewMode === 'edit' && <NotebookFloatingToolbar editor={activeEditor} engine={notebookEngine} workspaceId={workspace?.id} hasSelectedStrokes={notebookEngine.selection.hasSelectedStrokes()} onConvertHandwriting={openHandwritingConversion} embedded hideCollapseButton fullscreenToolOnly availableWidth={fullscreenToolbarHostWidth === null ? null : Math.max(0, fullscreenToolbarHostWidth - 104)} />}
              <button type="button" onClick={() => setToolbarCollapsed(true)} className="panvas-icon-control shrink-0 focus-ring" title="Hide fullscreen tools" aria-label="Hide fullscreen tools">
                <PanelTopOpen size={16} className="rotate-180" />
              </button>
              <NotebookWorkspaceControls focusOnly embedded />
            </div>
          </div>
        )
      )}
      {!isMobileViewport && workspaceViewMode !== 'present' && notebookModeLevel !== 2 && <div className={`panvas-notebook-chrome panvas-layer-toolbar absolute top-0 left-0 right-0 p-4 flex justify-between items-start pointer-events-none gap-4 ${isPropertiesPanelOpen ? 'right-72 max-[599px]:right-0' : ''}`}>
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
          {workspaceViewMode === 'edit' && <NotebookFloatingToolbar editor={activeEditor} engine={notebookEngine} workspaceId={workspace?.id} hasSelectedStrokes={notebookEngine.selection.hasSelectedStrokes()} onConvertHandwriting={openHandwritingConversion} />}
        </div>

        <div className={`pointer-events-auto flex flex-shrink-0 items-end gap-2 ${isConstrainedHeader ? 'flex-col gap-1' : 'items-start'}`}>
          <NotebookPageUtilities engine={notebookEngine} workspaceId={workspace?.id} notebookId={notebook?.id} ownerId={focusedPage?.id} editable={workspaceViewMode === 'edit'} onPageDataPersisted={handlePageAudioPersisted} onVoiceDelete={handleDeleteVoiceNote} onVoiceRename={handleRenameVoiceNote} onChange={handleLayersChange} compact={containerSize.width < 900} onExportPage={() => void handleExportPagePdf()} onExportNotebook={() => void handleExportNotebookPdf()} onPrintPage={() => void handlePrintPage()} onPrintNotebook={() => void handlePrintNotebook()} isExporting={isExportingPdf} />
          <NotebookWorkspaceControls />
        </div>
      </div>}

      {/* Native Scrolling Viewport */}
      <main 
        ref={containerRef}
        tabIndex={0}
        aria-label="Notebook pages"
        className={`panvas-notebook-viewport notebook-viewport relative flex-1 min-w-0 min-h-0 overflow-auto bg-panvas-bg-secondary ${
          toolState.mode === 'hand' ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onContextMenu={workspaceViewMode === 'edit' ? handleContextMenu : event => event.preventDefault()}
        onPointerDown={() => {
          containerRef.current?.focus({ preventScroll: true });
          if (contextMenu.isOpen) {
            setContextMenu(prev => ({ ...prev, isOpen: false }));
          }
        }}
      >
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
              const renderData = resolveNotebookPageRenderData(
                pos.id,
                focusedPageId,
                sectionDataCache,
                undefined,
                notebookEngine.getDrawingOwnership().pageId ?? '',
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
                  {residentIds.has(pos.id) || isFocused ? (
                    <NotebookPageView
                      key={pos.id}
                      page={pageItem}
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
                  ) : (
                    <PageRenderer id={pos.id} width={pos.width} height={pos.height}
                      properties={resolvedSectionProperties.get(pos.id)!} pageNumberText={pageNumText}>
                      <div role="status" className="absolute inset-0 flex items-center justify-center text-xs opacity-60">Loading page?</div>
                    </PageRenderer>
                  )}
                  {isFocused && workspaceViewMode === 'edit' && !isMobileViewport && (
                    <button
                      type="button"
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
        <NotebookFloatingToolbar editor={activeEditor} engine={notebookEngine} workspaceId={workspace?.id} hasSelectedStrokes={notebookEngine.selection.hasSelectedStrokes()} onConvertHandwriting={openHandwritingConversion} />
      </div>}

      {/* Static properties panel on the right */}
      {isPropertiesPanelOpen && workspaceViewMode !== 'present' && (
        <NotebookToolPropertiesPanel 
          viewportEngine={notebookEngine.viewport} 
          zoom={viewport.scale} 
          properties={pageProperties}
          onUpdateProperties={handlePagePropertiesUpdate}
          onApplyPropertiesToAll={handleApplyPropertiesToAll}
          onRestorePropertiesBatch={handleRestorePropertiesBatch}
          onZoom={handlePanelZoom}
        />
      )}

      {/* Right-click Context Menu */}
      <NotebookContextMenu
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
