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
import { getBrowserCanvasVisualScale, MAX_INACTIVE_PAGE_RENDER_ZOOM, resolveCanvasBackingScale, ViewportManager } from './engine/ViewportManager';
import { ShapeManager } from './engine/ShapeManager';
import { ImageManager } from './engine/ImageManager';
import { getImageCrop, getImageRenderAppearance } from './engine/imageAppearance';
import type { ImageObject } from './engine/drawingTypes';
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
import { isDrawingRecentlyActive } from '@/services/cloudsync/drawingActivity';

const ignoreTextEditorBlur = () => {};

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
  logicalBase?: number;
  onLogicalRebase?: (base: number, delta: number) => void;
}


function LayerCanvas({ drawing, id, width, height, scale, order, top = 0 }: { drawing: DrawingEngine; id: string; width: number; height: number; scale: number; order: number; top?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => ref.current ? drawing.attachLayerCanvas(id, ref.current, width, height, scale) : undefined, [drawing, id, width, height, scale]);
  return <canvas ref={ref} aria-hidden="true" className="absolute inset-0 pointer-events-none" style={{ top, zIndex: 20 + order * 3 }} />;
}

/** DOM rendering for page images: the raster canvas sits below the text DOM,
 *  so a canvas-painted image could never appear above an older text object.
 *  The overlay stacks above its layer's text (zIndex 22+order*3 vs 21+order*3)
 *  while staying below the next layer's canvas (23+order*3). Interactions are
 *  untouched — pointerEvents none keeps canvas hit-testing authoritative. */
function PageImageOverlay({ object, url, zIndex, imageManager }: { object: ImageObject; url?: string; zIndex: number; imageManager?: ImageManager | null }) {
  // Not memoized: selection drags mutate ImageObject geometry in place, so the
  // overlay must re-read object.x/y whenever the owning page re-renders, or a
  // stale copy of the image would remain at its previous position.
  if (!url) return null;
  const crop = getImageCrop(object);
  const appearance = getImageRenderAppearance(object);
  return (
    <div aria-hidden="true" data-image-overlay={object.id} ref={element => { imageManager?.registerOverlayElement(object.id, element); }} className="absolute overflow-hidden" style={{
      left: object.x, top: object.y, width: object.width, height: object.height,
      opacity: appearance.opacity,
      transform: `rotate(${appearance.rotationRadians}rad)`,
      zIndex,
      pointerEvents: 'none',
    }}>
      <img src={url} alt="" draggable={false} style={{
        width: object.width / crop.width, height: object.height / crop.height,
        marginLeft: -crop.x * object.width / crop.width, marginTop: -crop.y * object.height / crop.height,
        maxWidth: 'none', maxHeight: 'none', display: 'block', userSelect: 'none',
      }} />
    </div>
  );
}

export const NotebookPageView: React.FC<NotebookPageViewProps> = ({
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
  activeEditor,
  setActiveEditor,
  onActivatePage,
  handleDrop,
  handleDragOver,
  editable = true,
  onVoiceNoteChange = () => {},
  onVoiceNoteDelete = () => {},
  onVoiceNoteRename = () => {},
  onUpdateProperties,
  onImageManagerReady,
  logicalBase = 0,
  onLogicalRebase,
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
  const [renderWindow, setRenderWindow] = useState({ top: 0, height: Math.min(height, 2048) });
  useLayoutEffect(() => {
    if (!expandedSurface) { setRenderWindow({ top: 0, height }); return; }
    const root = pageRootRef.current;
    const scroller = root?.closest('.notebook-viewport');
    if (!root || !(scroller instanceof HTMLElement)) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (notebookEngine.input.navigationGestures.active) return;
      notebookEngine.input.refreshCanvasGeometry();
      const rect = root.getBoundingClientRect(), scale = rect.width / width || 1;
      const localY = (scroller.getBoundingClientRect().top - rect.top) / scale;
      // Scrolling never grows the page: layoutExtent is owned by content
      // (scene mutations and document text layout), which keeps about a
      // quarter-page of trailing blank space past the latest content.
      // Live drawing growth: while the pen is down, the active stroke's points
      // are part of the document extent. One logical infinite page grows
      // continuously (256-aligned, ~quarter-page trailing buffer); scrolling
      // alone never grows it. Also keep the raster window covering the stroke
      // so an in-progress stroke is never clipped at the old boundary.
      if (properties.pageSize === 'Infinite' && editable && isFocused && notebookEngine.getDrawingOwnership().pageId === page.id) {
        const liveBottom = Math.max(0, notebookEngine.input.getLiveStrokeBottom());
        const contentBottom = Math.max(contentBottomRef.current, liveBottom);
        const baseHeight = resolveBasePageDimensions(properties).height;
        const required = Math.max(baseHeight, Math.ceil((contentBottom + baseHeight / 4) / 256) * 256);
        if (required > (properties.layoutExtent ?? height)) notebookEngine.setProperties({ layoutExtent: required });
      }
      const nextBase = nextLogicalScrollBase(logicalBase, localY, properties.layoutExtent ?? height);
      if (nextBase !== logicalBase && onLogicalRebase && isFocused && notebookEngine.getDrawingOwnership().pageId === page.id) { onLogicalRebase(nextBase, nextBase - logicalBase); return; }
      // Infinite pages keep a viewport-following drawing window that may
      // overhang below the paper: the pen must be able to start past the
      // current extent, and the paper then grows to cover committed content.
      const isInfinite = properties.pageSize === 'Infinite';
      const viewportTopLocal = (scroller.getBoundingClientRect().top - rect.top) / scale;
      const rawTop = Math.max(0, Math.floor((viewportTopLocal - 512) / 512) * 512);
      const windowHeight = isInfinite
        ? Math.max(2048, Math.ceil(scroller.clientHeight / scale) + 1536)
        : Math.min(height, Math.max(2048, Math.ceil(scroller.clientHeight / scale) + 1536));
      const top = logicalBase + (isInfinite
        ? rawTop
        : Math.max(0, Math.min(height - windowHeight, rawTop)));
      setRenderWindow(previous => previous.top === top && previous.height === windowHeight ? previous : { top, height: windowHeight });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const idle = notebookEngine.input.navigationGestures.onIdle(schedule);
    scroller.addEventListener('scroll', schedule, { passive: true });
    schedule();
    // While the stylus is down the document extent must track the live stroke
    // even when no scroll event fires; rAF-batched so each frame costs one pass.
    let gestureFrame = 0;
    const unsubscribeGesture = notebookEngine.onDrawingGestureLifecycle(active => {
      if (active) {
        if (!gestureFrame) gestureFrame = requestAnimationFrame(function gestureLoop() {
          update();
          gestureFrame = requestAnimationFrame(gestureLoop);
        });
      } else if (gestureFrame) {
        cancelAnimationFrame(gestureFrame);
        gestureFrame = 0;
        update();
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      if (gestureFrame) cancelAnimationFrame(gestureFrame);
      unsubscribeGesture();
      idle();
      scroller.removeEventListener('scroll', schedule);
    };
  }, [expandedSurface, height, width, renderScale, notebookEngine, logicalBase, properties.layoutExtent, onLogicalRebase, editable, isFocused, page.id]);
  const rasterTop = expandedSurface ? renderWindow.top : 0;
  const rasterHeight = expandedSurface ? renderWindow.height : height;
  const canvasStyle = expandedSurface ? { top: rasterTop - logicalBase, height: rasterHeight } : undefined;
  const activeCanvasRef = useRef<HTMLCanvasElement>(null);
  const activeCanvasConfigurationRef = useRef<string | null>(null);
  const activeRasterOriginRef = useRef(0);
  const staticCanvasConfigurationRef = useRef<string | null>(null);
  const staticEngineRef = useRef<{ drawing: DrawingEngine; viewport: ViewportManager; layers: LayerManager; images: ImageManager; shapes: ShapeManager } | null>(null);
  const pendingPreviewAdoptionRef = useRef<{ source: DrawingEngine; data: DrawingData } | null>(null);
  const [staticDrawing, setStaticDrawing] = useState<DrawingEngine | null>(null);
  // The static engine's image manager owns the object URLs the DOM image
  // overlay renders from while this page is unfocused.
  const [staticImages, setStaticImages] = useState<ImageManager | null>(null);
  // The page-owned preview stays visible until the shared live surface has
  // actual pixels. Deferred handoffs and sliced fallback paints would otherwise
  // expose a transparent canvas for the duration of the paint.
  const [liveSurfacePainted, setLiveSurfacePainted] = useState(false);
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
  const sceneReady = !isFocused || sceneOwnerPageId === page.id;
  const liveSceneReady = isFocused && sceneReady;
  const fullDarkView = useFullDarkView();
  const [brightPdfPreview, setBrightPdfPreview] = useState(false);
  useLayoutEffect(() => {
    if (fullDarkView && page.type === 'pdf' && canvasRef.current) setBrightPdfPreview(isBrightDocumentCanvas(canvasRef.current));
  }, [fullDarkView, page.type]);
  useLayoutEffect(() => {
    if (liveSceneReady) notebookEngine.drawing.setFullDarkView(fullDarkView);
    staticEngineRef.current?.drawing.setFullDarkView(fullDarkView);
  }, [fullDarkView, liveSceneReady, notebookEngine]);

  // The committed surface belongs to this page, independent of the shared
  // interaction engine. Only data/geometry changes repaint it.
  useLayoutEffect(() => {
    // The focused live surface already owns these pixels. Refresh this page-owned
    // preview synchronously at handoff, rather than replaying the whole scene
    // behind every newly committed stroke.
    if (!data || page.type === 'pdf' || !canvasRef.current) return;
    let engine = staticEngineRef.current;
    if (!engine) {
      const viewport = new ViewportManager();
      viewport.setZoom(1);
      const layers = new LayerManager();
      const shapes = new ShapeManager(viewport, layers);
      const images = new ImageManager(viewport, layers);
      const drawing = new DrawingEngine(viewport, shapes, images, layers);
      drawing.setCoalesceRedraws(true);
      // Geometry caches outlive this component. A closure created here also
      // retains the render/effect contexts and their old page payloads.
      images.setRedrawCallback(drawing.scheduleRedraw.bind(drawing));
      engine = { drawing, viewport, layers, images, shapes };
      staticEngineRef.current = engine;
      drawing.setFullDarkView(fullDarkView);
      onImageManagerReady?.(page.id, images, drawing);
      setStaticDrawing(drawing);
      setStaticImages(images);
    }
    if (liveSceneReady) return;
    const staticConfiguration = `${width}:${rasterHeight}:${renderScale}`;
    const canvasMatches = engine.drawing.getCanvasElement() === canvasRef.current;
    if (!canvasMatches || staticCanvasConfigurationRef.current !== staticConfiguration) {
      engine.drawing.setScaleMultiplier(Math.min(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM));
      engine.drawing.setCanvas(canvasRef.current, width, rasterHeight);
      staticCanvasConfigurationRef.current = staticConfiguration;
    }
    engine.viewport.setPageCoordinateTransform(0, width, height, pageGeometry.source.left, pageGeometry.source.top);
    engine.viewport.setRenderWindowOrigin(rasterTop, expandedSurface ? rasterHeight : undefined);
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
    engine.images.adoptDecodedImages(notebookEngine.images, objects.filter(o => o.type === 'image').map(o => o.fileId));
    engine.images.setImages(objects.filter(o => o.type === 'image').map(withLayer));
    if (previewCurrent && previewSource!.copySurfacesTo(engine.drawing, data)) {
      return;
    }
    // Multi-layer previews attach their layer canvases in child layout effects.
    // Defer the adoption attempt until those canvases exist, then fall back to
    // the sliced paint if the retained pixels are not usable.
    if (previewCurrent && !staticDrawing && (data.layers?.length ?? 0) > 1) {
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
    rasterTop,
    rasterHeight,
    page.type,
    renderScale,
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
      staticEngineRef.current?.images.destroy();
      onImageManagerReady?.(page.id, null);
      staticEngineRef.current = null;
      setStaticImages(null);
      staticCanvasConfigurationRef.current = null;
    };
  }, [notebookEngine, page.id]);

  // Ownership guards protect only the disposable interaction surface. The
  // correct page's committed canvas stays visible throughout a pending load.
  useLayoutEffect(() => {
    if (!liveSceneReady || page.type === 'pdf' || !activeCanvasRef.current) return;
    const canvas = activeCanvasRef.current;
    const preview = staticEngineRef.current;
    if (preview) notebookEngine.images.adoptDecodedImages(preview.images);
    notebookEngine.drawing.setScaleMultiplier(renderScale);
    notebookEngine.viewport.setPageCoordinateTransform(0, width, height, pageGeometry.source.left, pageGeometry.source.top);
    notebookEngine.viewport.setRenderWindowOrigin(rasterTop, expandedSurface ? rasterHeight : undefined);
    setLiveSurfacePainted(false);
    const markLiveSurfacePainted = () => {
      if (notebookEngine.drawing.getCanvasElement() !== canvas) return;
      // The hidden page-owned preview no longer needs to finish its own paint;
      // the live surface now owns these pixels and will refresh the preview at
      // the next handoff.
      preview?.drawing.cancelPaint();
      setLiveSurfacePainted(true);
    };
    notebookEngine.mount(canvas, width, rasterHeight, preview?.drawing, data, markLiveSurfacePainted);
    activeRasterOriginRef.current = rasterTop;
    activeCanvasConfigurationRef.current = `${width}:${rasterHeight}:${renderScale}:${pageGeometry.source.left}:${pageGeometry.source.top}`;
    return () => {
      activeCanvasConfigurationRef.current = null;
      // A different page may already own the engine during React cleanup.
      if (notebookEngine.drawing.getCanvasElement() === canvas) notebookEngine.unmount();
    };
  }, [liveSceneReady, notebookEngine, page.type, page.id]);

  useLayoutEffect(() => {
    if (!liveSceneReady || page.type === 'pdf' || !activeCanvasConfigurationRef.current) return;
    const nextConfiguration = `${width}:${rasterHeight}:${renderScale}:${pageGeometry.source.left}:${pageGeometry.source.top}`;
    notebookEngine.viewport.setPageCoordinateTransform(0, width, height, pageGeometry.source.left, pageGeometry.source.top);
    notebookEngine.viewport.setRenderWindowOrigin(rasterTop, expandedSurface ? rasterHeight : undefined);
    const rebased = activeRasterOriginRef.current !== rasterTop;
    activeRasterOriginRef.current = rasterTop;
    if (rebased) notebookEngine.input.refreshCanvasGeometry();
    if (activeCanvasConfigurationRef.current === nextConfiguration) {
      if (rebased) notebookEngine.drawing.rebaseLiveSurface();
      return;
    }
    notebookEngine.drawing.setScaleMultiplier(renderScale);
    notebookEngine.resize(width, rasterHeight);
    if (rebased) notebookEngine.drawing.rebaseLiveSurface();
    activeCanvasConfigurationRef.current = nextConfiguration;
  }, [liveSceneReady, notebookEngine, page.type, renderScale, width, height, rasterTop, rasterHeight, pageGeometry.source.left, pageGeometry.source.top]);

  const [layerRevision, setLayerRevision] = useState(0);
  useEffect(() => {
    if (!isFocused) return;
    const unsubLayers = notebookEngine.layers.subscribe(() => {
      setLayerRevision(rev => rev + 1);
    });
    const unsubMutation = notebookEngine.onSceneMutation(reason => {
      if (reason !== 'document-text' && !isDrawingRecentlyActive(300)) {
        setLayerRevision(rev => rev + 1);
      }
    });
    return () => {
      unsubLayers();
      unsubMutation();
    };
  }, [isFocused, notebookEngine]);

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
    if (!liveSceneReady) return [];
    const layers = notebookEngine.layers.getLayers();
    const orderMap = new Map<string, number>();
    layers.forEach((l, idx) => orderMap.set(l.id, idx));
    return notebookEngine.texts
      .getTexts()
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
  const contentBottomRef = useRef(0);
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
  }, [page.type, page.pdfDataId, width, height, renderScale]);

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

  const orderedLayers = liveSceneReady ? notebookEngine.layers.getLayers() : data?.layers ?? [];
  const layeredDrawing = page.type !== 'pdf' && orderedLayers.length > 1 ? (liveSceneReady ? notebookEngine.drawing : staticDrawing) : null;
  const textZIndex = (layerId?: string) => layeredDrawing ? 21 + Math.max(0, orderedLayers.findIndex(layer => layer.id === (layerId ?? DEFAULT_PAGE_LAYER_ID))) * 3 : undefined;

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
        {staticDrawing && (data?.layers?.length ?? 0) > 1 && data!.layers!.map((layer, order) => <LayerCanvas key={layer.id} drawing={staticDrawing} id={layer.id} width={width} height={rasterHeight} top={rasterTop - logicalBase} scale={Math.min(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM)} order={order} />)}
        {/* Live text editors already render on focus; keep the static HTML
            hidden so the two copies never stack during a deferred ink handoff. */}
        <div style={{ visibility: liveSceneReady ? 'hidden' : 'visible' }}>
          {staticTextObjects.filter(obj => !isDocumentBody(obj) && (!expandedSurface || obj.y + (obj.height ?? 100) > rasterTop && obj.y < rasterTop + rasterHeight)).map(obj => isVoiceNoteObject(obj) ? <StaticVoiceNote key={obj.id} object={obj} note={data?.audioNotes?.find(note => note.id === obj.metadata.audioNoteId)} offset={textPageOffset}/> : (
            <StaticTextPreview key={obj.id} object={obj} scale={1} zIndex={textZIndex(obj.layerId)} offset={textPageOffset} />
          ))}
          {(data?.objects ?? []).filter((obj): obj is ImageObject => obj.type === 'image' && (!expandedSurface || obj.y + (obj.height ?? 0) > rasterTop && obj.y < rasterTop + rasterHeight)).map(obj => (
            <PageImageOverlay key={`img-${obj.id}`} object={obj} url={staticImages?.getObjectUrl(obj.fileId)} imageManager={staticImages}
              zIndex={layeredDrawing ? 22 + Math.max(0, (data?.layers ?? []).findIndex(layer => layer.id === (obj.layerId ?? DEFAULT_PAGE_LAYER_ID))) * 3 : 22} />
          ))}
        </div>

        <canvas ref={canvasRef} data-committed-page-id={page.id} className="absolute inset-0 z-10 w-full h-full pointer-events-none"
          style={{ ...canvasStyle, filter: page.type === 'pdf' ? (fullDarkView && brightPdfPreview ? FULL_DARK_PDF_FILTER : 'none') : undefined }} />
        </div>
        {!data && <div role="status" className="absolute inset-0 flex items-center justify-center text-xs opacity-60">Loading page?</div>}

        {liveSceneReady && <div data-live-page-visual={page.id} style={{ visibility: 'visible' }}>
        {/* Focused live TipTap text editors */}
        {liveSceneReady && layeredDrawing && orderedLayers.map((layer, order) => <LayerCanvas key={layer.id} drawing={layeredDrawing} id={layer.id} width={width} height={rasterHeight} top={rasterTop - logicalBase} scale={renderScale} order={order} />)}
        {liveSceneReady && liveTextObjects.filter(obj => !isDocumentBody(obj) && (!expandedSurface || obj.y + (obj.height ?? 100) > rasterTop && obj.y < rasterTop + rasterHeight)).map(obj => isVoiceNoteObject(obj) ? (
          <NotebookVoiceNote key={obj.id} object={obj} note={notebookEngine.audio.getAll().find(note => note.id === obj.metadata.audioNoteId)} engine={notebookEngine} scale={1} offset={textPageOffset} bounds={{ x: -pageGeometry.source.left, y: -pageGeometry.source.top, width, height: expandedSurface ? Math.max(height, properties.layoutExtent ?? 0) : height }} editable={editable && notebookEngine.texts.isEditable(obj)} onChange={onVoiceNoteChange} onDelete={onVoiceNoteDelete} onRename={onVoiceNoteRename}/>
        ) : (
          <FloatingTextEditor
            key={obj.id}
            object={obj}
            engine={notebookEngine}
            scale={1}
            pageOffset={textPageOffset}
            zIndex={textZIndex(obj.layerId)}
            toolMode={properties.layoutMode !== 'document' && notebookEngine.layers.isEditable(obj.layerId) ? toolState.mode : 'hand'}
            onFocus={setActiveEditor}
            onBlur={ignoreTextEditorBlur}
          />
        ))}

        {liveSceneReady && notebookEngine.images.getImages().filter(obj => !expandedSurface || obj.y + (obj.height ?? 0) > rasterTop && obj.y < rasterTop + rasterHeight).map(obj => (
          <PageImageOverlay key={`img-${obj.id}`} object={obj} url={notebookEngine.images.getObjectUrl(obj.fileId)} imageManager={notebookEngine.images}
            zIndex={layeredDrawing ? 22 + Math.max(0, orderedLayers.findIndex(layer => layer.id === (obj.layerId ?? DEFAULT_PAGE_LAYER_ID))) * 3 : 22} />
        ))}

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
          className={`absolute inset-0 z-10 w-full h-full ${
            isFocused ? (
              toolState.mode === 'hand' ? 'cursor-grab active:cursor-grabbing touch-none' : 
              toolState.mode === 'text' ? 'cursor-text touch-none' : 
              toolState.mode === 'select' ? 'cursor-default touch-none' : 
              'touch-none'
            ) : 'pointer-events-none'
          }`}
          style={{
            ...canvasStyle,
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
