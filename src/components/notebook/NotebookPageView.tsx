import { stickyPaperStyle } from './stickyNotes';
// ============================================
// Panvas — Unified Notebook Page View Component
// ============================================
// Single, persistent page representation for every page in the notebook.
// Replaces the legacy PageRenderer vs InactivePagePreview dual-component swap.
// Preserves DOM element identity, canvas state, and vector templates during scroll.

import React, { useEffect, useLayoutEffect, useRef, useMemo, useState } from 'react';
import { resolveDocumentToolCursor } from './documentToolCursor';
import { PageRenderer } from './PageRenderer';
import { FloatingTextEditor } from './FloatingTextEditor';
import { DocumentFlowEditor } from './DocumentFlowEditor';
import { isDocumentBody, documentExtent, positionedContentBottom, documentInsets } from './documentFlowGeometry';
import { resolveBasePageDimensions } from '../../lib/pageProperties';
import { nextLogicalScrollBase, LOGICAL_SCROLL_WINDOW } from './logicalScrollWindow';
import { createEmptyDrawingData, type DrawingData, type TextObject, type ToolState, DEFAULT_PAGE_LAYER_ID } from './engine/drawingTypes';
import {
  getStickyNoteColor,
  getStickyNoteOpacity,
  getStickyNoteShape,
  getShapeBorderRadius,
  hexToRgba,
  isStickyNote,
} from './stickyNotes';
import type { NotebookPage, PagePropertySet } from '@/types/notebook';
import type { NotebookEngine } from './engine/NotebookEngine';
import {
  getBrowserCanvasVisualScale,
  MAX_ACTIVE_CANVAS_PIXELS,
  MAX_CANVAS_DIMENSION,
  MAX_INACTIVE_PAGE_RENDER_ZOOM,
  resolveCanvasBackingScale,
  resolveViewportRenderWindow,
  ViewportManager,
  type RenderWindowRect,
} from './engine/ViewportManager';
import { ShapeManager } from './engine/ShapeManager';
import { ImageManager } from './engine/ImageManager';
import { DrawingEngine } from './engine/DrawingEngine';
import type { Editor } from '@tiptap/react';
import { StaticTextPreview } from './StaticTextPreview';
import { notebookTipTapExtensions } from './tiptapExtensions';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { useAuthStore } from '@/stores/authStore';
import { LayerManager } from './engine/LayerManager';
import { NotebookVoiceNote, StaticVoiceNote } from './NotebookVoiceNote';
import { textObjectStyle } from './textTypography';
import { isVoiceNoteObject } from '@/services/audio/voiceNoteObjects';
import type { AudioNote } from './engine/drawingTypes';
import { resolvePageSurfaceGeometry } from '@/lib/pageProperties';
import { gate0Profiler } from '@/dev/gate0Profiler';
import { useFullDarkView } from '@/hooks/useFullDarkView';
import { FULL_DARK_PDF_FILTER, isBrightDocumentCanvas } from '@/lib/fullDarkView';
import { useUIStore } from '@/stores/uiStore';

const ignoreTextEditorBlur = () => {};
const NOOP_VOICE_CHANGE = () => {};
const NOOP_VOICE_DELETE = (_note: AudioNote) => {};
const NOOP_VOICE_RENAME = (_note: AudioNote, _title: string) => {};

const createStaticPageEngine = (fullDarkView: boolean) => {
  const viewport = new ViewportManager();
  viewport.setZoom(1);
  const layers = new LayerManager();
  const shapes = new ShapeManager(viewport, layers);
  const images = new ImageManager(viewport, layers);
  const drawing = new DrawingEngine(viewport, shapes, images, layers);
  drawing.setCoalesceRedraws(true);
  drawing.setUseLayerPresentationOnly(true);
  drawing.setFullDarkView(fullDarkView);
  // Geometry caches outlive this component. Avoid capturing render/effect state
  // closures in the redraw callback.
  images.setRedrawCallback(drawing.scheduleRedraw.bind(drawing));
  return { drawing, viewport, layers, images, shapes };
};

export interface NotebookPageViewProps {
  page: NotebookPage;
  data?: DrawingData;
  properties: PagePropertySet;
  width: number;
  height: number;
  /** Current user zoom, used only to choose bounded raster backing resolution. */
  renderScale: number;
  pageNumberText: string;
  isFocused: boolean;
  toolState: ToolState;
  notebookEngine: NotebookEngine;
  /** Page currently represented by the shared live NotebookEngine scene. */
  sceneOwnerPageId?: string;
  /** Retained page-owned preview from a previous mount, if still current. */
  previewSource?: DrawingEngine;
  activeEditor: Editor | null;
  setActiveEditor: (editor: Editor | null) => void;
  onActivatePage: () => void;
  handleDrop?: (e: React.DragEvent) => void;
  handleDragOver?: (e: React.DragEvent) => void;
  editable?: boolean;
  onVoiceNoteChange?: () => void;
  onVoiceNoteDelete?: (note: AudioNote) => void;
  onVoiceNoteRename?: (note: AudioNote, title: string) => void;
  onUpdateProperties?: (updates: Partial<PagePropertySet>) => void;
  onImageManagerReady?: (pageId: string, images: ImageManager | null, drawing?: DrawingEngine) => void;
  onEditMathObject?: (object: TextObject) => void;
  logicalBase?: number;
  onLogicalRebase?: (base: number, delta: number) => void;
  pageX?: number;
  pageY?: number;
  layoutTotalWidth?: number;
  horizontalPadding?: number;
}


function LayerCanvas({
  drawing,
  id,
  width,
  height,
  scale,
  layerCount,
  order,
  left = 0,
  top = 0,
  visible = true,
  ready = true,
}: {
  drawing: DrawingEngine;
  id: string;
  width: number;
  height: number;
  scale: number;
  layerCount: number;
  order: number;
  left?: number;
  top?: number;
  visible?: boolean;
  ready?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => (ref.current ? drawing.registerLayerCanvas(id, ref.current) : undefined), [drawing, id]);
  useLayoutEffect(() => {
    if (ref.current && ready) drawing.configureLayerCanvas(id, ref.current, width, height, scale, layerCount);
  }, [drawing, id, width, height, scale, layerCount, ready]);
  // Presentation surfaces sit above the page text so images and ink retain the
  // existing image-over-text contract. They stay pointer-events:none, leaving
  // the lower interaction canvas responsible for hit testing and text editing.
  return <canvas ref={ref} data-panvas-presentation-layer={id} aria-hidden="true" className="absolute pointer-events-none" style={{ left, top, zIndex: 23 + order * 4, visibility: visible ? 'inherit' : 'hidden' }} />;
}

const NotebookPageViewComponent: React.FC<NotebookPageViewProps> = ({
  page,
  data,
  properties,
  width,
  height,
  renderScale,
  pageNumberText,
  isFocused,
  toolState,
  notebookEngine,
  sceneOwnerPageId = '',
  previewSource,
  activeEditor: _activeEditor,
  setActiveEditor,
  onActivatePage,
  handleDrop,
  handleDragOver,
  editable = true,
  onVoiceNoteChange = NOOP_VOICE_CHANGE,
  onVoiceNoteDelete = NOOP_VOICE_DELETE,
  onVoiceNoteRename = NOOP_VOICE_RENAME,
  onUpdateProperties,
  onImageManagerReady,
  onEditMathObject,
  logicalBase = 0,
  onLogicalRebase,
  pageX,
  pageY,
  layoutTotalWidth,
  horizontalPadding,
}) => {
  gate0Profiler.resource('reactRenders.NotebookPageView', 1);
  useEffect(() => {
    gate0Profiler.resource('reactCommits.NotebookPageView', 1);
  });
  useEffect(() => {
    gate0Profiler.resource('mountedPages', 1);
    gate0Profiler.resource('canvases', 1);
    return () => {
      gate0Profiler.resource('mountedPages', -1);
      gate0Profiler.resource('canvases', -1);
    };
  }, []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRootRef = useRef<HTMLDivElement>(null);
  const expandedSurface = properties.pageSize === 'Infinite' || properties.layoutMode === 'document';
  const inactiveRenderScale = Math.min(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM);
  const sceneReady = !isFocused || sceneOwnerPageId === page.id;
  const liveSceneReady = isFocused && sceneReady;
  const activeCanvasRef = useRef<HTMLCanvasElement>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const activeCanvasConfigurationRef = useRef<string | null>(null);
  const activeRasterOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const staticCanvasConfigurationRef = useRef<string | null>(null);
  const fullDarkView = useFullDarkView();
  const [initialStaticEngine] = useState(() => (page.type === 'pdf' ? null : createStaticPageEngine(fullDarkView)));
  const staticEngineRef = useRef<{ drawing: DrawingEngine; viewport: ViewportManager; layers: LayerManager; images: ImageManager; shapes: ShapeManager } | null>(initialStaticEngine);
  const registeredStaticDrawingRef = useRef<DrawingEngine | null>(null);
  const pendingPreviewAdoptionRef = useRef<{ source: DrawingEngine; data: DrawingData } | null>(null);
  const [staticDrawing, setStaticDrawing] = useState<DrawingEngine | null>(() => initialStaticEngine?.drawing ?? null);
  const [layerRevision, setLayerRevision] = useState(0);
  // The page-owned preview stays visible until the shared live surface has
  // actual pixels. Deferred handoffs and sliced fallback paints would otherwise
  // expose a transparent canvas for the duration of the paint.
  const [liveSurfacePainted, setLiveSurfacePainted] = useState(false);
  const contentBottomRef = useRef(0);
  const drawingGestureActiveRef = useRef(false);

  const staticLayers = (data?.layers?.length ? data.layers : staticDrawing?.getLayerManager().getLayers()) ?? [];
  const liveLayers = notebookEngine.layers.getLayers();
  const activeLayerCount = Math.max(1, (liveSceneReady ? liveLayers.length : staticLayers.length) || 1);
  const targetWindowScale = isFocused ? renderScale : inactiveRenderScale;
  const currentWindowKey = `${targetWindowScale}:${width}:${height}:${activeLayerCount}:${logicalBase}:${isFocused}:${expandedSurface}`;

  const [windowState, setWindowState] = useState<{ rect: RenderWindowRect; key: string }>(() => ({
    rect: {
      left: 0,
      top: logicalBase,
      width,
      height: expandedSurface ? Math.min(height, 2048) : height,
      windowed: false,
    },
    key: (!isFocused && !expandedSurface) ? currentWindowKey : '',
  }));
  const renderWindowRef = useRef<RenderWindowRect>(windowState.rect);
  const renderWindow = windowState.rect;
  const windowAligned = windowState.key === currentWindowKey;

  useLayoutEffect(() => {
    const isInfinite = properties.pageSize === 'Infinite';
    const root = pageRootRef.current;
    const scroller = root?.closest('.notebook-viewport');
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const targetBackingScale = Math.max(0.25, dpr * targetWindowScale * getBrowserCanvasVisualScale());
    const safePageW = Math.max(1, Math.round(width));
    const safePageH = Math.max(1, Math.round(height));
    const layerPixelBudget = Math.floor(MAX_ACTIVE_CANVAS_PIXELS / Math.max(1, activeLayerCount));
    const pageFitsFullBacking = !isInfinite
      && safePageW * safePageH * targetBackingScale * targetBackingScale <= layerPixelBudget
      && Math.max(safePageW, safePageH) * targetBackingScale <= MAX_CANVAS_DIMENSION;

    if ((!isFocused && !expandedSurface) || (!expandedSurface && pageFitsFullBacking)) {
      const fullRect: RenderWindowRect = { left: 0, top: logicalBase, width, height, windowed: false };
      renderWindowRef.current = fullRect;
      setWindowState(prev =>
        prev.key === currentWindowKey
        && prev.rect.left === fullRect.left
        && prev.rect.top === fullRect.top
        && prev.rect.width === fullRect.width
        && prev.rect.height === fullRect.height
        && prev.rect.windowed === fullRect.windowed
          ? prev
          : { rect: fullRect, key: currentWindowKey },
      );
      return;
    }
    if (!root || !(scroller instanceof HTMLElement)) {
      const fallback: RenderWindowRect = {
        left: 0,
        top: logicalBase,
        width,
        height: expandedSurface ? Math.min(height, 2048) : height,
        windowed: false,
      };
      renderWindowRef.current = fallback;
      setWindowState(prev => (prev.key === currentWindowKey ? prev : { rect: fallback, key: currentWindowKey }));
      return;
    }
    let frame = 0;
    const update = (forceRebase = false) => {
      frame = 0;
      if (notebookEngine.input.navigationGestures.active && windowState.key !== '') return;
      if (drawingGestureActiveRef.current && !isInfinite) return;

      let liveScale = notebookEngine.viewport.getState().scale || 1;
      let localLeft: number;
      let localY: number;
      if (
        pageX !== undefined
        && pageY !== undefined
        && layoutTotalWidth !== undefined
        && horizontalPadding !== undefined
        && scroller.clientWidth > 0
      ) {
        if (drawingGestureActiveRef.current) notebookEngine.input.refreshCanvasGeometry();
        const sizerWidth = Math.max(scroller.clientWidth, layoutTotalWidth * liveScale + horizontalPadding);
        const pageScreenLeft = (sizerWidth - layoutTotalWidth * liveScale) / 2 + pageX * liveScale;
        const pageScreenTop = pageY * liveScale;
        localLeft = (scroller.scrollLeft - pageScreenLeft) / liveScale;
        localY = (scroller.scrollTop - pageScreenTop) / liveScale;
      } else {
        notebookEngine.input.refreshCanvasGeometry();
        const rootRect = root.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        liveScale = notebookEngine.viewport.getState().scale || (rootRect.width / width) || 1;
        localLeft = (scrollerRect.left - rootRect.left) / liveScale;
        localY = (scrollerRect.top - rootRect.top) / liveScale;
      }

      if (isInfinite && editable && isFocused && notebookEngine.getDrawingOwnership().pageId === page.id) {
        const liveBottom = Math.max(0, notebookEngine.input.getLiveStrokeBottom());
        const contentBottom = Math.max(contentBottomRef.current, liveBottom);
        const baseHeight = resolveBasePageDimensions(properties).height;
        const required = Math.max(baseHeight, Math.ceil((contentBottom + baseHeight / 4) / 256) * 256);
        if (required > (properties.layoutExtent ?? height)) notebookEngine.setProperties({ layoutExtent: required });
        if (drawingGestureActiveRef.current) {
          const prev = renderWindowRef.current;
          const prevBottom = prev.top - logicalBase + prev.height;
          if (liveBottom <= prevBottom - 64) return;
        }
      }
      if (expandedSurface) {
        const nextBase = nextLogicalScrollBase(logicalBase, localY, properties.layoutExtent ?? height);
        if (nextBase !== logicalBase && onLogicalRebase && isFocused && notebookEngine.getDrawingOwnership().pageId === page.id) {
          onLogicalRebase(nextBase, nextBase - logicalBase);
          return;
        }
      }

      const next = resolveViewportRenderWindow({
        pageWidth: width,
        pageHeight: height,
        logicalBase,
        isInfinite,
        zoom: targetWindowScale,
        dpr,
        browserVisualScale: getBrowserCanvasVisualScale(),
        layerCount: activeLayerCount,
        viewportLocal: {
          left: localLeft,
          top: localY,
          width: scroller.clientWidth / liveScale,
          height: scroller.clientHeight / liveScale,
        },
        previous: renderWindowRef.current,
        forceRebase,
      });
      renderWindowRef.current = next;
      setWindowState(prev =>
        prev.rect === next && prev.key === currentWindowKey
          ? prev
          : { rect: next, key: currentWindowKey },
      );
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => update(false)); };
    const idle = notebookEngine.input.navigationGestures.onIdle(() => {
      if (Math.abs(notebookEngine.viewport.getState().scale - renderScale) > 0.001) return;
      update(true);
    });
    scroller.addEventListener('scroll', schedule, { passive: true });
    update(true);

    let gestureFrame = 0;
    const unsubscribeGesture = notebookEngine.onDrawingGestureLifecycle(active => {
      drawingGestureActiveRef.current = active;
      if (active) {
        if (isInfinite && !gestureFrame) {
          gestureFrame = requestAnimationFrame(function gestureLoop() {
            update(false);
            gestureFrame = requestAnimationFrame(gestureLoop);
          });
        }
      } else {
        if (gestureFrame) {
          cancelAnimationFrame(gestureFrame);
          gestureFrame = 0;
        }
        update(false);
      }
    });
    return () => {
      drawingGestureActiveRef.current = false;
      cancelAnimationFrame(frame);
      if (gestureFrame) cancelAnimationFrame(gestureFrame);
      unsubscribeGesture();
      idle();
      scroller.removeEventListener('scroll', schedule);
    };
  }, [
    currentWindowKey,
    expandedSurface,
    height,
    width,
    targetWindowScale,
    activeLayerCount,
    notebookEngine,
    logicalBase,
    properties.pageSize,
    properties.layoutExtent,
    onLogicalRebase,
    editable,
    isFocused,
    page.id,
    pageX,
    pageY,
    layoutTotalWidth,
    horizontalPadding,
  ]);

  const lastLivePropsRef = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
    scale: number;
    layerCount: number;
    windowed: boolean;
  } | null>(null);
  if (windowAligned || !liveSceneReady) {
    if (liveSceneReady) {
      lastLivePropsRef.current = {
        left: renderWindow.left,
        top: renderWindow.top,
        width: renderWindow.width,
        height: renderWindow.height,
        scale: renderScale,
        layerCount: liveLayers.length,
        windowed: renderWindow.windowed,
      };
    } else {
      lastLivePropsRef.current = null;
    }
  }
  const mountReady = liveSceneReady && (windowAligned || lastLivePropsRef.current !== null);
  const effectiveLive = (windowAligned ? null : lastLivePropsRef.current) ?? {
    left: renderWindow.left,
    top: renderWindow.top,
    width: renderWindow.width,
    height: renderWindow.height,
    scale: windowAligned ? renderScale : Math.min(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM),
    layerCount: liveLayers.length,
    windowed: renderWindow.windowed,
  };
  const rasterLeft = effectiveLive.left;
  const rasterTop = effectiveLive.top;
  const rasterWidth = effectiveLive.width;
  const rasterHeight = effectiveLive.height;
  const staticRasterTop = expandedSurface ? renderWindow.top : 0;
  const staticRasterHeight = expandedSurface ? renderWindow.height : height;
  const canvasStyle = expandedSurface ? { top: staticRasterTop - logicalBase, height: staticRasterHeight } : undefined;
  const liveCanvasStyle = (expandedSurface || effectiveLive.windowed)
    ? { left: rasterLeft, top: rasterTop - logicalBase, width: rasterWidth, height: rasterHeight }
    : undefined;

  const instanceIdRef = useRef<string>('');
  if (!instanceIdRef.current) {
    instanceIdRef.current = 'inst_' + Math.random().toString(36).substring(2, 8);
  }

  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const pageCursor = (!isTouchDevice && isFocused) ? resolveDocumentToolCursor(toolState) : undefined;
  const pageGeometry = useMemo(() => resolvePageSurfaceGeometry(properties), [properties]);
  const textPageOffset = useMemo(
    () => ({ x: pageGeometry.source.left, y: pageGeometry.source.top - logicalBase }),
    [pageGeometry.source.left, pageGeometry.source.top, logicalBase],
  );
  const [brightPdfPreview, setBrightPdfPreview] = useState(false);
  useLayoutEffect(() => {
    if (fullDarkView && page.type === 'pdf' && canvasRef.current) setBrightPdfPreview(isBrightDocumentCanvas(canvasRef.current));
  }, [fullDarkView, page.type]);
  const prevPaperColorRef = useRef(properties.paperColor);
  useLayoutEffect(() => {
    const paperChanged = prevPaperColorRef.current !== properties.paperColor;
    prevPaperColorRef.current = properties.paperColor;
    if (liveSceneReady) {
      notebookEngine.drawing.setFullDarkView(fullDarkView);
      if (paperChanged) notebookEngine.drawing.redraw();
      notebookEngine.drawing.flushPendingLayerRedraw();
    }
    staticEngineRef.current?.drawing.setFullDarkView(fullDarkView);
    if (paperChanged) staticEngineRef.current?.drawing.redraw();
  }, [fullDarkView, properties.paperColor, liveSceneReady, notebookEngine]);

  // The committed surface belongs to this page, independent of the shared
  // interaction engine. Only data/geometry changes repaint it.
  useLayoutEffect(() => {
    // The focused live surface already owns these pixels. Refresh this page-owned
    // preview synchronously at handoff, rather than replaying the whole scene
    // behind every newly committed stroke.
    if (!data || page.type === 'pdf' || !canvasRef.current) return;
    let engine = staticEngineRef.current;
    if (!engine) {
      engine = createStaticPageEngine(fullDarkView);
      staticEngineRef.current = engine;
      setStaticDrawing(engine.drawing);
    }
    if (registeredStaticDrawingRef.current !== engine.drawing) {
      registeredStaticDrawingRef.current = engine.drawing;
      engine.drawing.setFullDarkView(fullDarkView);
      onImageManagerReady?.(page.id, engine.images, engine.drawing);
    }
    if (liveSceneReady) return;
    const staticConfiguration = `${width}:${staticRasterHeight}:${inactiveRenderScale}:${pageGeometry.source.left}:${pageGeometry.source.top}`;
    const canvasMatches = engine.drawing.getCanvasElement() === canvasRef.current;
    if (!canvasMatches || staticCanvasConfigurationRef.current !== staticConfiguration) {
      engine.drawing.setScaleMultiplier(Math.min(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM));
      engine.drawing.setCanvas(canvasRef.current, width, staticRasterHeight);
      staticCanvasConfigurationRef.current = staticConfiguration;
    }
    engine.viewport.setPageCoordinateTransform(0, width, height, pageGeometry.source.left, pageGeometry.source.top);
    engine.viewport.setRenderWindowRect(
      expandedSurface ? { left: 0, top: staticRasterTop, width, height: staticRasterHeight } : null,
    );
    // Page handoff already blitted the live pixels into this page-owned
    // surface. Reusing them avoids replaying the whole scene twice per
    // boundary (once for the outgoing preview, once for the incoming live
    // canvas) while still repainting after any real data/geometry change.
    if (engine.drawing.isSurfaceCurrent(data) || engine.drawing.isSurfacePaintCurrent(data)) {
      return;
    }
    engine.layers.setData(data.layers, data.activeLayerId);
    const fallbackLayerId = engine.layers.getLayers()[0].id;
    const withLayer = (object: any) => ({ ...object, layerId: object.layerId ?? fallbackLayerId });
    const objects = data.objects || [];
    // A retained preview from the previous mount can supply both Path2D geometry
    // and finished pixels. Retaining its paths avoids rebuilding ~90ms of dense
    // ink, and the pixel blit below avoids replaying the whole scene.
    const previewCurrent = Boolean(previewSource && previewSource !== engine.drawing
      && previewSource.getCanvasElement() && previewSource.isSurfaceCurrent(data));
    engine.drawing.setStrokes((data.version === 1 ? data.strokes || [] : objects.filter(o => o.type === 'stroke')).map(withLayer), previewSource ?? notebookEngine.drawing, false);
    engine.shapes.setShapes((data.version === 1 ? data.shapes || [] : objects.filter(o => o.type === 'shape')).map(withLayer));
    const imageObjs = objects.filter(o => o.type === 'image').map(withLayer);
    const copiedSurface = Boolean(previewCurrent && previewSource!.copySurfacesTo(engine.drawing, data));
    engine.images.adoptDecodedImages(notebookEngine.images, imageObjs.map(o => o.fileId));
    if (copiedSurface) {
      engine.images.setImages(imageObjs, { skipPreload: true });
      return;
    }
    engine.images.setImages(imageObjs, { skipPreload: previewCurrent && !staticDrawing });
    // Multi-layer previews attach their layer canvases in child layout effects.
    // Defer the adoption attempt until those canvases exist, then fall back to
    // the sliced paint if the retained pixels are not usable.
    if (previewCurrent && !staticDrawing) {
      pendingPreviewAdoptionRef.current = { source: previewSource!, data };
      return;
    }
    engine.drawing.schedulePreviewPaint(data);
  // `data` also carries page properties. A paper-color update replaces that
  // wrapper object, but must not replay unchanged strokes/images/shapes.
  }, [
    liveSceneReady,
    data?.version,
    data?.objects,
    data?.strokes,
    data?.shapes,
    data?.layers,
    data?.activeLayerId,
    width,
    height,
    staticRasterTop,
    staticRasterHeight,
    expandedSurface,
    page.type,
    inactiveRenderScale,
    pageGeometry.source.left,
    pageGeometry.source.top,
    notebookEngine,
  ]);

  useLayoutEffect(() => {
    const pending = pendingPreviewAdoptionRef.current;
    const engine = staticEngineRef.current;
    if (!pending || !staticDrawing || !engine || engine.drawing !== staticDrawing) return;
    pendingPreviewAdoptionRef.current = null;
    // Child LayerCanvas effects have run by now, so every target layer exists.
    if (pending.source.isSurfaceCurrent(pending.data)
      && pending.source.copySurfacesTo(staticDrawing, pending.data)) {
      return;
    }
    engine.images.setImages(engine.images.getImages());
    staticDrawing.schedulePreviewPaint(pending.data);
  }, [staticDrawing]);

  useLayoutEffect(() => {
    const unsubscribe = notebookEngine.images.onDecodedImage(() => {
      const preview = staticEngineRef.current;
      if (!preview || notebookEngine.getDrawingOwnership().pageId !== page.id) return;
      preview.images.adoptDecodedImages(notebookEngine.images);
      preview.drawing.scheduleRedraw();
      setLayerRevision(rev => rev + 1);
    });
    return () => {
      unsubscribe();
      // Keep the page-owned pixels alive for the resident geometry window.
      // React removes the canvas element, but the engine can still source a
      // handoff blit when the user scrolls back, avoiding a full preview
      // repaint. The renderer detaches it when the engine leaves that window.
      staticEngineRef.current?.drawing.setRetainedOffscreen(true);
      staticEngineRef.current?.images.destroy();
      onImageManagerReady?.(page.id, null);
      registeredStaticDrawingRef.current = null;
      staticEngineRef.current = null;
      staticCanvasConfigurationRef.current = null;
    };
  }, [notebookEngine, page.id]);

  // Ownership guards protect only the disposable interaction surface. The
  // correct page's committed canvas stays visible throughout a pending load.
  useLayoutEffect(() => {
    if (!mountReady || page.type === 'pdf' || !activeCanvasRef.current) return;
    const canvas = activeCanvasRef.current;
    const preview = staticEngineRef.current;
    if (preview) notebookEngine.images.adoptDecodedImages(preview.images);
    notebookEngine.drawing.setUseLayerPresentationOnly(true);
    notebookEngine.drawing.setScaleMultiplier(renderScale);
    notebookEngine.viewport.setPageCoordinateTransform(0, width, height, pageGeometry.source.left, pageGeometry.source.top);
    notebookEngine.viewport.setRenderWindowRect(
      effectiveLive.windowed || expandedSurface ? { left: rasterLeft, top: rasterTop, width: rasterWidth, height: rasterHeight } : null,
    );
    setLiveSurfacePainted(false);
    const markLiveSurfacePainted = () => {
      if (notebookEngine.drawing.getCanvasElement() !== canvas) return;
      // The hidden page-owned preview no longer needs to finish its own paint;
      // the live surface now owns these pixels and will refresh the preview at
      // the next handoff.
      preview?.drawing.cancelPaint();
      setLiveSurfacePainted(true);
    };
    notebookEngine.mount(canvas, rasterWidth, rasterHeight, preview?.drawing, data, markLiveSurfacePainted);
    activeRasterOriginRef.current = { x: rasterLeft, y: rasterTop };
    activeCanvasConfigurationRef.current = `${rasterLeft}:${rasterTop}:${rasterWidth}:${rasterHeight}:${renderScale}:${liveLayers.length}:${pageGeometry.source.left}:${pageGeometry.source.top}`;
    return () => {
      activeCanvasConfigurationRef.current = null;
      // A different page may already own the engine during React cleanup.
      if (notebookEngine.drawing.getCanvasElement() === canvas) notebookEngine.unmount();
    };
  }, [mountReady, notebookEngine, page.type, page.id]);

  useLayoutEffect(() => {
    if (!liveSceneReady || page.type === 'pdf' || !activeCanvasConfigurationRef.current || !windowAligned) return;
    const nextConfiguration = `${rasterLeft}:${rasterTop}:${rasterWidth}:${rasterHeight}:${renderScale}:${liveLayers.length}:${pageGeometry.source.left}:${pageGeometry.source.top}`;
    notebookEngine.viewport.setPageCoordinateTransform(0, width, height, pageGeometry.source.left, pageGeometry.source.top);
    notebookEngine.viewport.setRenderWindowRect(
      effectiveLive.windowed || expandedSurface ? { left: rasterLeft, top: rasterTop, width: rasterWidth, height: rasterHeight } : null,
    );
    const rebased = activeRasterOriginRef.current.x !== rasterLeft || activeRasterOriginRef.current.y !== rasterTop;
    activeRasterOriginRef.current = { x: rasterLeft, y: rasterTop };
    if (rebased) notebookEngine.input.refreshCanvasGeometry();
    if (activeCanvasConfigurationRef.current === nextConfiguration) {
      if (rebased) notebookEngine.drawing.rebaseLiveSurface();
      notebookEngine.drawing.flushPendingLayerRedraw();
      return;
    }
    notebookEngine.drawing.setScaleMultiplier(renderScale);
    notebookEngine.resize(rasterWidth, rasterHeight);
    if (rebased) notebookEngine.drawing.rebaseLiveSurface(true);
    activeCanvasConfigurationRef.current = nextConfiguration;
  }, [liveSceneReady, notebookEngine, page.type, windowAligned, renderScale, width, height, rasterLeft, rasterTop, rasterWidth, rasterHeight, liveLayers.length, expandedSurface, pageGeometry.source.left, pageGeometry.source.top]);

  const liveSurfaceCropped = effectiveLive.windowed && (
    rasterLeft > 0.5
    || rasterTop > logicalBase + 0.5
    || rasterWidth < width - 1
    || rasterHeight < height - 1
  );
  const showOverviewBackdrop = liveSceneReady && liveSurfaceCropped && renderScale >= 3.0 && !expandedSurface && page.type !== 'pdf';

  useLayoutEffect(() => {
    const canvas = overviewCanvasRef.current;
    if (!showOverviewBackdrop || !canvas) {
      notebookEngine.drawing.setOverviewCanvas(null, 0, 0);
      return;
    }
    notebookEngine.drawing.setOverviewCanvas(canvas, width, height);
    return () => {
      notebookEngine.drawing.setOverviewCanvas(null, 0, 0);
    };
  }, [
    showOverviewBackdrop,
    liveSurfacePainted,
    width,
    height,
    pageGeometry.source.left,
    pageGeometry.source.top,
    fullDarkView,
    notebookEngine,
    page.id,
  ]);

  const renderedTextVersionRef = useRef(-1);
  const [selectedTextKey, setSelectedTextKey] = useState('');
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

  useEffect(() => {
    if (!liveSceneReady) {
      setSelectedTextKey('');
      setEditingTextId(null);
      return;
    }
    const readKey = () => notebookEngine.selection.getSelectedElements()
      .filter(el => el.type === 'text')
      .map(el => el.id)
      .sort()
      .join('|');
    setSelectedTextKey(prev => {
      const next = readKey();
      return prev === next ? prev : next;
    });
    return notebookEngine.selection.subscribe(() => {
      const next = readKey();
      setSelectedTextKey(prev => (prev === next ? prev : next));
    });
  }, [liveSceneReady, notebookEngine]);

  useEffect(() => {
    if (!liveSceneReady) return;
    const handleFocusText = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id && notebookEngine.texts.getTexts().some(t => t.id === id)) {
        setEditingTextId(id);
      }
    };
    document.addEventListener('panvas:focus-text', handleFocusText);
    return () => document.removeEventListener('panvas:focus-text', handleFocusText);
  }, [liveSceneReady, notebookEngine]);

  useEffect(() => {
    if (toolState.mode !== 'text' && editingTextId !== null) {
      setEditingTextId(null);
    }
  }, [toolState.mode, editingTextId]);

  useEffect(() => {
    if (!isFocused) return;
    renderedTextVersionRef.current = notebookEngine.texts.getVersion();
    const unsubLayers = notebookEngine.layers.subscribe(() => {
      setLayerRevision(rev => rev + 1);
      if (showOverviewBackdrop) notebookEngine.drawing.scheduleOverviewSync();
    });
    const unsubMutation = notebookEngine.onSceneMutation(reason => {
      if (reason === 'document-text') return;
      if (showOverviewBackdrop) notebookEngine.drawing.scheduleOverviewSync();
      const nextVersion = notebookEngine.texts.getVersion();
      if (nextVersion !== renderedTextVersionRef.current) {
        renderedTextVersionRef.current = nextVersion;
        setLayerRevision(rev => rev + 1);
      }
    });
    return () => {
      unsubLayers();
      unsubMutation();
    };
  }, [isFocused, notebookEngine, showOverviewBackdrop]);

  // Text objects for non-focused pages
  // The live editor is authoritative while this preview is hidden. Generate
  // the latest static HTML synchronously at handoff, as with the committed ink
  // surface, instead of parsing/sanitizing/highlighting it on every keystroke.
  const staticTextDataRef = useRef(data);
  if (!liveSceneReady || page.type === 'pdf' || !staticTextDataRef.current) staticTextDataRef.current = data;
  const staticTextData = staticTextDataRef.current;
  const staticTextObjects: TextObject[] = useMemo(() => {
    if (!staticTextData?.objects) return [];
    const visibility = new Map((staticTextData.layers ?? []).map(layer => [layer.id, layer.visible !== false]));
    return staticTextData.objects.filter(o => o.type === 'text' && visibility.get(o.layerId ?? DEFAULT_PAGE_LAYER_ID) !== false) as TextObject[];
  }, [staticTextData]);

  // Live text objects from notebookEngine when focused
  const liveTextObjects = useMemo(() => {
    if (!liveSceneReady) {
      renderedTextVersionRef.current = -1;
      return [];
    }
    const allTexts = notebookEngine.texts.getTexts();
    renderedTextVersionRef.current = notebookEngine.texts.getVersion();
    const layers = notebookEngine.layers.getLayers();
    const orderMap = new Map<string, number>();
    layers.forEach((l, idx) => orderMap.set(l.id, idx));
    return allTexts
      .filter(object => notebookEngine.layers.isVisible(object.layerId))
      .sort((a, b) => {
        const orderA = orderMap.get(a.layerId ?? DEFAULT_PAGE_LAYER_ID) ?? 0;
        const orderB = orderMap.get(b.layerId ?? DEFAULT_PAGE_LAYER_ID) ?? 0;
        return orderA - orderB;
      });
  }, [liveSceneReady, notebookEngine, layerRevision]);
  const body = liveTextObjects.find(isDocumentBody);
  const displayedBody = liveSceneReady ? body : staticTextObjects.find(isDocumentBody);
  useEffect(() => {
    if (!liveSceneReady) return;
    notebookEngine.texts.setDocumentBodyId(properties.layoutMode === 'document' ? body?.id : undefined);
    return () => notebookEngine.texts.setDocumentBodyId(undefined);
  }, [liveSceneReady, properties.layoutMode, body?.id, notebookEngine]);
  // The committed content bottom feeds the live-drawing growth loop below, so
  // the per-frame extent check never rescans the whole scene.
  useEffect(() => {
    if (!liveSceneReady || !expandedSurface) return;
    const bottom = positionedContentBottom([...notebookEngine.drawing.getStrokes(), ...notebookEngine.shapes.getShapes(), ...notebookEngine.images.getImages(), ...notebookEngine.texts.getTexts()]);
    contentBottomRef.current = bottom;
    const extent = documentExtent(properties, (body?.height ?? 0) + documentInsets(properties), bottom);
    if (properties.pageSize === 'Infinite' ? extent > (properties.layoutExtent ?? 0) : extent !== properties.layoutExtent && body && body.height) notebookEngine.setProperties({ layoutExtent: extent });
  }, [liveSceneReady, layerRevision, properties.pageSize, body, notebookEngine, expandedSurface]);

  // PDF lifetime follows residency and geometry, never interaction focus.
  useEffect(() => {
    if (page.type !== 'pdf' || !page.pdfDataId || !canvasRef.current) return;
    let cancelled = false;
    let task: import('pdfjs-dist').PDFDocumentLoadingTask | undefined;
    let render: import('pdfjs-dist').RenderTask | undefined;
    async function loadPdf() {
      try {
        const userId = useAuthStore.getState().user?.id ?? null;
        const file = await canvasRepository.getPdf(userId, page.pdfDataId!);
        if (!file || cancelled) return;
        const pdfjs = await import('pdfjs-dist');
        // @ts-ignore
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        if (cancelled) return;
        task = pdfjs.getDocument({ data: new Uint8Array(file.data.slice(0)) });
        const doc = await task.promise;
        if (cancelled) return;
        const pdfPage = await doc.getPage(1);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale: 1 });
        const baseScale = Math.min(width / viewport.width, height / viewport.height) * .95;
        const cssWidth = viewport.width * baseScale;
        const cssHeight = viewport.height * baseScale;
        const backing = resolveCanvasBackingScale(window.devicePixelRatio || 1,
          Math.min(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM), cssWidth, cssHeight, getBrowserCanvasVisualScale());
        const scaled = pdfPage.getViewport({ scale: baseScale * backing });
        const buffer = document.createElement('canvas');
        buffer.width = Math.floor(scaled.width);
        buffer.height = Math.floor(scaled.height);
        render = pdfPage.render({ canvasContext: buffer.getContext('2d')!, viewport: scaled });
        await render.promise;
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        canvas.width = buffer.width;
        canvas.height = buffer.height;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        canvas.getContext('2d')!.drawImage(buffer, 0, 0);
        const appearance = useUIStore.getState();
        if (appearance.theme === 'dark' && appearance.fullDarkView && !appearance.isPrinting) setBrightPdfPreview(isBrightDocumentCanvas(canvas));
        buffer.width = buffer.height = 0;
      } catch (error) {
        if (!cancelled) console.error('Failed to load PDF preview:', error);
      } finally {
        if (task) { void task.destroy(); task = undefined; }
      }
    }
    void loadPdf();
    return () => {
      cancelled = true;
      render?.cancel();
      if (task) { void task.destroy(); task = undefined; }
    };
  }, [page.type, page.pdfDataId, width, height, inactiveRenderScale]);

  // Page activation must not fire while the Hand tool is active. Activating flips
  // focusedPageId, which runs this component's mount effect cleanup —
  // notebookEngine.unmount() -> InputManager.detach() -> canvas = null — in the middle of
  // a live pan. That is why the first hand drag started on a non-focused page appeared to
  // do nothing and only the second one worked. Panning is owned by the viewport
  // container (see NotebookRenderer), so this handler simply yields to it.
  const handlePointerDown = () => {
    if (toolState.mode === 'hand') return;
    if (!isFocused) {
      onActivatePage();
    }
  };

  const presentationDrawing = page.type !== 'pdf' ? (liveSceneReady ? notebookEngine.drawing : staticDrawing) : null;
  const textZIndexFor = (layerId: string | undefined, layers: typeof staticLayers) => page.type !== 'pdf' && presentationDrawing
    ? 21 + Math.max(0, layers.findIndex(layer => layer.id === (layerId ?? DEFAULT_PAGE_LAYER_ID))) * 4
    : undefined;

  return (
    <div
      ref={pageRootRef}
      data-page-id={page.id}
      data-rendered-page-id={page.id}
      data-logical-scroll-base={logicalBase}
      data-scene-owner-page-id={sceneOwnerPageId}
      data-render-ready={sceneReady ? 'true' : 'false'}
      className="relative shadow-2xl transition-shadow"
      onPointerDown={handlePointerDown}
      onClick={handlePointerDown}
    >
      <PageRenderer
        id={page.id}
        width={width}
        height={height}
        properties={properties}
        pageNumberText={pageNumberText}
        editable={isFocused && editable}
        onUpdateProperties={onUpdateProperties}
        logicalBase={logicalBase}
        renderWindow={expandedSurface ? { top: renderWindow.top - logicalBase, height: renderWindow.height } : undefined}
        engine={notebookEngine}
        onFocusEditor={setActiveEditor}
      >
        {/* This page-owned visual subtree survives every interaction handoff. */}
        <div data-stable-page-visual={page.id} style={{ visibility: liveSceneReady && page.type !== 'pdf' && liveSurfacePainted ? 'hidden' : 'visible' }}>
        {staticDrawing && staticLayers.map((layer, order) => <LayerCanvas key={layer.id} drawing={staticDrawing} id={layer.id} width={width} height={staticRasterHeight} left={0} top={expandedSurface ? staticRasterTop - logicalBase : 0} scale={Math.min(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM)} layerCount={Math.max(1, staticLayers.length)} order={order} />)}
        {/* Live text editors already render on focus; keep the static HTML
            hidden so the two copies never stack during a deferred ink handoff. */}
        <div style={{ visibility: liveSceneReady ? 'hidden' : 'visible' }}>
          {staticTextObjects.filter(obj => !isDocumentBody(obj) && (!expandedSurface || (obj.y + pageGeometry.source.top + (obj.height ?? 160) > rasterTop && obj.y + pageGeometry.source.top < rasterTop + rasterHeight))).map(obj => isVoiceNoteObject(obj) ? <StaticVoiceNote key={obj.id} object={obj} note={data?.audioNotes?.find(note => note.id === obj.metadata.audioNoteId)} offset={textPageOffset}/> : (
            <StaticTextPreview key={obj.id} object={obj} scale={1} zIndex={textZIndexFor(obj.layerId, staticLayers)} offset={textPageOffset} paperColor={properties.paperColor} />
          ))}
        </div>

        <canvas ref={canvasRef} data-committed-page-id={page.id} className="absolute inset-0 z-10 w-full h-full pointer-events-none"
          style={{ ...canvasStyle, filter: page.type === 'pdf' ? (fullDarkView && brightPdfPreview ? FULL_DARK_PDF_FILTER : 'none') : undefined }} />
        </div>
        {!data && <div role="status" className="absolute inset-0 flex items-center justify-center text-xs opacity-60">Loading page?</div>}

        {liveSceneReady && <div data-live-page-visual={page.id} style={{ visibility: 'visible' }}>
        {showOverviewBackdrop && (
          <canvas
            ref={overviewCanvasRef}
            data-panvas-overview-backdrop={page.id}
            aria-hidden="true"
            className="absolute pointer-events-none"
            style={{
              left: 0,
              top: 0,
              width: `${width}px`,
              height: `${height}px`,
              zIndex: 18,
              visibility: liveSurfacePainted ? 'visible' : 'hidden',
              clipPath: `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${rasterLeft}px ${rasterTop - logicalBase}px, ${rasterLeft + rasterWidth}px ${rasterTop - logicalBase}px, ${rasterLeft + rasterWidth}px ${rasterTop - logicalBase + rasterHeight}px, ${rasterLeft}px ${rasterTop - logicalBase + rasterHeight}px, ${rasterLeft}px ${rasterTop - logicalBase}px)`,
            }}
          />
        )}
        {/* Focused live TipTap editors only when selected or actively editing; idle text/math use StaticTextPreview */}
        {liveSceneReady && liveLayers.map((layer, order) => <LayerCanvas key={layer.id} drawing={notebookEngine.drawing} id={layer.id} width={rasterWidth} height={rasterHeight} left={rasterLeft} top={rasterTop - logicalBase} scale={effectiveLive.scale} layerCount={effectiveLive.layerCount} order={order} visible={liveSurfacePainted} ready={mountReady} />)}
        {liveSceneReady && liveTextObjects.filter(obj => !isDocumentBody(obj) && (!expandedSurface || (obj.y + pageGeometry.source.top + (obj.height ?? 160) > rasterTop && obj.y + pageGeometry.source.top < rasterTop + rasterHeight))).map(obj => {
          const selectedTextSet = selectedTextKey ? new Set(selectedTextKey.split('|')) : null;
          const idleInteractiveMode: 'select' | 'text' | 'none' = (editable && (toolState.mode === 'select' || toolState.mode === 'text')) ? toolState.mode : 'none';
          if (isVoiceNoteObject(obj)) {
              return <NotebookVoiceNote key={obj.id} object={obj} note={notebookEngine.audio.getAll().find(note => note.id === obj.metadata.audioNoteId)} engine={notebookEngine} scale={1} offset={textPageOffset} bounds={{ x: -pageGeometry.source.left, y: -pageGeometry.source.top, width, height: expandedSurface ? Math.max(height, properties.layoutExtent ?? 0) : height }} editable={editable && notebookEngine.texts.isEditable(obj)} onChange={onVoiceNoteChange} onDelete={onVoiceNoteDelete} onRename={onVoiceNoteRename}/>;
            }
            const needsTipTap = Boolean(selectedTextSet?.has(obj.id) || editingTextId === obj.id);
            if (!needsTipTap) {
              return (
                <StaticTextPreview
                  key={obj.id}
                  object={obj}
                  scale={1}
                  zIndex={textZIndexFor(obj.layerId, liveLayers)}
                  offset={textPageOffset}
                  paperColor={properties.paperColor}
                  engine={notebookEngine}
                  interactiveMode={editable && notebookEngine.layers.isEditable(obj.layerId) ? idleInteractiveMode : 'none'}
                  onActivateEdit={objToEdit => setEditingTextId(objToEdit.id)}
                  onEditMathObject={onEditMathObject}
                />
              );
            }
            return (
              <FloatingTextEditor
                key={obj.id}
                object={obj}
                engine={notebookEngine}
                scale={1}
                pageOffset={textPageOffset}
                paperColor={properties.paperColor}
                zIndex={textZIndexFor(obj.layerId, liveLayers)}
                toolMode={notebookEngine.layers.isEditable(obj.layerId) ? toolState.mode : 'hand'}
                onFocus={setActiveEditor}
                onBlur={ignoreTextEditorBlur}
                onEditMathObject={onEditMathObject}
              />
            );
          })}

        {/* Only this transient canvas is ever cleared by NotebookEngine. */}
        {liveSceneReady && page.type !== 'pdf' && <canvas
          ref={activeCanvasRef}
          data-rendered-page-id={page.id}
          data-scene-owner-page-id={sceneOwnerPageId}
          data-render-ready={sceneReady ? 'true' : 'false'}
          onPointerDown={e => {
            if (e.pointerType === 'touch') setIsTouchDevice(true);
            else setIsTouchDevice(false);
          }}
          onPointerMove={e => {
            if (e.pointerType === 'touch' && !isTouchDevice) setIsTouchDevice(true);
            else if (e.pointerType !== 'touch' && isTouchDevice) setIsTouchDevice(false);
          }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          className={`absolute ${liveCanvasStyle ? '' : 'inset-0 w-full h-full '}z-10 ${
            isFocused ? (
              toolState.mode === 'hand' ? 'cursor-grab active:cursor-grabbing touch-none' :
              toolState.mode === 'text' ? 'cursor-text touch-none' :
              toolState.mode === 'select' ? 'cursor-default touch-none' :
              'touch-none'
            ) : 'pointer-events-none'
          }`}
          style={{
            ...liveCanvasStyle,
            ...(pageCursor ? { cursor: pageCursor } : {}),
            // Do not expose the shared live surface until its ownership
            // marker has caught up with this physical page.
            visibility: liveSceneReady ? 'visible' : 'hidden',
          }}
        />}
        </div>}
        {displayedBody && properties.layoutMode === 'document' && <DocumentFlowEditor key={`${page.id}:${displayedBody.id}:${liveSceneReady ? 'live' : 'preview'}`} object={displayedBody} engine={notebookEngine} properties={properties} toolMode={toolState.mode} editable={liveSceneReady && editable && notebookEngine.layers.isEditable(displayedBody.layerId)} onFocus={liveSceneReady ? setActiveEditor : () => {}} ownerPageId={page.id} renderBase={logicalBase} />}

      </PageRenderer>
    </div>
  );
};

export const NotebookPageView = React.memo(NotebookPageViewComponent, (prev, next) => {
  if (prev.page !== next.page) {
    if (prev.page.id !== next.page.id || prev.page.type !== next.page.type || prev.page.pdfDataId !== next.page.pdfDataId) {
      return false;
    }
  }
  if (prev.width !== next.width || prev.height !== next.height) return false;
  if (prev.pageNumberText !== next.pageNumberText) return false;
  if (prev.isFocused !== next.isFocused) return false;
  if (prev.sceneOwnerPageId !== next.sceneOwnerPageId) return false;
  if (prev.editable !== next.editable) return false;
  if (prev.logicalBase !== next.logicalBase) return false;
  if (prev.pageX !== next.pageX || prev.pageY !== next.pageY || prev.layoutTotalWidth !== next.layoutTotalWidth || prev.horizontalPadding !== next.horizontalPadding) {
    return false;
  }
  if (prev.isFocused || next.isFocused) {
    if (prev.renderScale !== next.renderScale) return false;
  } else {
    if (Math.min(prev.renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM) !== Math.min(next.renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM)) {
      return false;
    }
  }
  if (prev.data !== next.data) return false;
  if (prev.properties !== next.properties && JSON.stringify(prev.properties) !== JSON.stringify(next.properties)) {
    return false;
  }
  if (prev.toolState !== next.toolState) return false;
  if (prev.notebookEngine !== next.notebookEngine) return false;
  // `previewSource` is only read on initial mount/data adoption (never in JSX
  // or effect dependencies), so self-registration into `residentDrawingEnginesRef`
  // must not trigger neighbor re-renders during scroll.
  if (
    prev.onActivatePage !== next.onActivatePage
    || prev.onUpdateProperties !== next.onUpdateProperties
    || prev.onLogicalRebase !== next.onLogicalRebase
    || prev.onImageManagerReady !== next.onImageManagerReady
    || prev.setActiveEditor !== next.setActiveEditor
    || prev.handleDrop !== next.handleDrop
    || prev.handleDragOver !== next.handleDragOver
    || prev.onVoiceNoteChange !== next.onVoiceNoteChange
    || prev.onVoiceNoteDelete !== next.onVoiceNoteDelete
    || prev.onVoiceNoteRename !== next.onVoiceNoteRename
    || prev.onEditMathObject !== next.onEditMathObject
  ) {
    return false;
  }
  return true;
});
