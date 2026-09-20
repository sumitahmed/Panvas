import { stickyPaperStyle } from './stickyNotes';
// ============================================
// Panvas — Unified Notebook Page View Component
// ============================================
// Single, persistent page representation for every page in the notebook.
// Replaces the legacy PageRenderer vs InactivePagePreview dual-component swap.
// Preserves DOM element identity, canvas state, and vector templates during scroll.

import React, { useEffect, useLayoutEffect, useRef, useMemo, useState } from 'react';
import { PageRenderer } from './PageRenderer';
import { FloatingTextEditor } from './FloatingTextEditor';
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
import { MAX_INACTIVE_PAGE_RENDER_ZOOM, resolveCanvasBackingScale, ViewportManager } from './engine/ViewportManager';
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
  onImageManagerReady?: (pageId: string, images: ImageManager | null) => void;
}

/**
 * Native-looking ink cursors keep the pen tip, rather than a crosshair centre,
 * on the document point that receives the stroke. They are deliberately small
 * and monochrome so they work on every paper colour and theme.
 */
const svgCursor = (svg: string, hotspotX: number, hotspotY: number, fallback = 'crosshair') =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspotX} ${hotspotY}, ${fallback}`;

const ERASER_CURSOR = svgCursor(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="m7 20 10-10a3 3 0 0 1 4.2 0l4.8 4.8a3 3 0 0 1 0 4.2l-8 8H9l-4-4 2-7Z" fill="#f6c7d7" stroke="#5d4650" stroke-width="1.7" stroke-linejoin="round"/><path d="m11 24 5-5" fill="none" stroke="#fff" stroke-width="1.5"/></svg>`, 9, 25, 'cell');

function dynamicInkCursor(tool: ToolState['drawingTool'], color: string): string {
  const ink = /^#[0-9a-f]{6}$/i.test(color) ? color : '#2563eb';
  if (tool === 'laser') {
    return svgCursor(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="9" fill="${ink}" fill-opacity=".18"/><circle cx="16" cy="16" r="4.5" fill="${ink}" stroke="#fff" stroke-width="1.5"/><circle cx="16" cy="16" r="1.4" fill="#fff"/></svg>`, 16, 16);
  }
  const tip = tool === 'highlighter' ? '#fef08a' : ink;
  const body = tool === 'pencil' ? '#fbfaf7' : tip;
  const accent = tool === 'highlighter' ? ink : '#24201a';
  return svgCursor(`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><path d="m7 26 3.5-8L24 4.5l5.5 5.5L16 23.5 7 26Z" fill="${body}" stroke="${accent}" stroke-width="1.8" stroke-linejoin="round"/><path d="m21.5 7 5.5 5.5" fill="none" stroke="${ink}" stroke-width="2"/><path d="m7 26 6.2-2.2-4-4L7 26Z" fill="${ink}" stroke="#24201a" stroke-width="1.2" stroke-linejoin="round"/></svg>`, 7, 26);
}

function resolvePageCursor(toolState: ToolState): string | undefined {
  if (toolState.mode === 'erase') return ERASER_CURSOR;
  if (toolState.mode !== 'draw') return undefined;
  const handwritingInk = toolState.handwritingToTextEnabled
    && (toolState.drawingTool === 'pen' || toolState.drawingTool === 'pencil');
  return dynamicInkCursor(
    toolState.drawingTool,
    handwritingInk ? toolState.handwritingInkColor : toolState.color,
  );
}

function LayerCanvas({ drawing, id, width, height, scale, order }: { drawing: DrawingEngine; id: string; width: number; height: number; scale: number; order: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => ref.current ? drawing.attachLayerCanvas(id, ref.current, width, height, scale) : undefined, [drawing, id, width, height, scale]);
  return <canvas ref={ref} aria-hidden="true" className="absolute inset-0 pointer-events-none" style={{ zIndex: 20 + order * 2 }} />;
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
  const activeCanvasRef = useRef<HTMLCanvasElement>(null);
  const activeCanvasConfigurationRef = useRef<string | null>(null);
  const staticCanvasConfigurationRef = useRef<string | null>(null);
  const staticEngineRef = useRef<{ drawing: DrawingEngine; viewport: ViewportManager; layers: LayerManager; images: ImageManager; shapes: ShapeManager } | null>(null);
  const [staticDrawing, setStaticDrawing] = useState<DrawingEngine | null>(null);
  const instanceIdRef = useRef<string>('');
  if (!instanceIdRef.current) {
    instanceIdRef.current = 'inst_' + Math.random().toString(36).substring(2, 8);
  }

  const pageCursor = isFocused ? resolvePageCursor(toolState) : undefined;
  const pageGeometry = useMemo(() => resolvePageSurfaceGeometry(properties), [properties]);
  const textPageOffset = useMemo(
    () => ({ x: pageGeometry.source.left, y: pageGeometry.source.top }),
    [pageGeometry.source.left, pageGeometry.source.top],
  );
  const sceneReady = !isFocused || sceneOwnerPageId === page.id;
  const liveSceneReady = isFocused && sceneReady;

  // The committed surface belongs to this page, independent of the shared
  // interaction engine. Only data/geometry changes repaint it.
  useLayoutEffect(() => {
    if (!data || page.type === 'pdf' || !canvasRef.current) return;
    let engine = staticEngineRef.current;
    if (!engine) {
      const viewport = new ViewportManager();
      viewport.setZoom(1);
      const layers = new LayerManager();
      const shapes = new ShapeManager(viewport, layers);
      const images = new ImageManager(viewport, layers);
      const drawing = new DrawingEngine(viewport, shapes, images, layers);
      images.setRedrawCallback(() => drawing.redraw());
      engine = { drawing, viewport, layers, images, shapes };
      staticEngineRef.current = engine;
      onImageManagerReady?.(page.id, images);
      setStaticDrawing(drawing);
    }
    engine.viewport.setPageCoordinateTransform(0, width, height, pageGeometry.source.left, pageGeometry.source.top);
    engine.layers.setData(data.layers, data.activeLayerId);
    const fallbackLayerId = engine.layers.getLayers()[0].id;
    const withLayer = (object: any) => ({ ...object, layerId: object.layerId ?? fallbackLayerId });
    // Configure only when geometry changes; the retained canvas is never reset
    // by focus. Data updates finish synchronously before the next paint.
    engine.drawing.setScaleMultiplier(Math.min(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM));
    const staticConfiguration = `${width}:${height}:${renderScale}`;
    if (staticCanvasConfigurationRef.current !== staticConfiguration) {
      engine.drawing.setCanvas(canvasRef.current, width, height);
      staticCanvasConfigurationRef.current = staticConfiguration;
    }
    const objects = data.objects || [];
    engine.drawing.setStrokes((data.version === 1 ? data.strokes || [] : objects.filter(o => o.type === 'stroke')).map(withLayer));
    engine.shapes.setShapes((data.version === 1 ? data.shapes || [] : objects.filter(o => o.type === 'shape')).map(withLayer));
    engine.images.adoptDecodedImages(notebookEngine.images, objects.filter(o => o.type === 'image').map(o => o.fileId));
    engine.images.setImages(objects.filter(o => o.type === 'image').map(withLayer));
    engine.drawing.redraw();
  // `data` also carries page properties. A paper-color update replaces that
  // wrapper object, but must not replay unchanged strokes/images/shapes.
  }, [
    data?.version,
    data?.objects,
    data?.strokes,
    data?.shapes,
    data?.layers,
    data?.activeLayerId,
    width,
    height,
    page.type,
    renderScale,
    pageGeometry.source.left,
    pageGeometry.source.top,
    notebookEngine,
  ]);

  useLayoutEffect(() => {
    const unsubscribe = notebookEngine.images.onDecodedImage(() => {
      const preview = staticEngineRef.current;
      if (!preview || notebookEngine.getDrawingOwnership().pageId !== page.id) return;
      preview.images.adoptDecodedImages(notebookEngine.images);
      preview.drawing.redraw();
    });
    return () => {
      unsubscribe();
      staticEngineRef.current?.drawing.detachCanvas();
      staticEngineRef.current?.images.destroy();
      onImageManagerReady?.(page.id, null);
      staticEngineRef.current = null;
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
    notebookEngine.mount(canvas, width, height);
    activeCanvasConfigurationRef.current = `${width}:${height}:${renderScale}`;
    return () => {
      activeCanvasConfigurationRef.current = null;
      // A different page may already own the engine during React cleanup.
      if (notebookEngine.drawing.getCanvasElement() === canvas) notebookEngine.unmount();
    };
  }, [liveSceneReady, notebookEngine, page.type, page.id]);

  useLayoutEffect(() => {
    if (!liveSceneReady || page.type === 'pdf' || !activeCanvasConfigurationRef.current) return;
    const nextConfiguration = `${width}:${height}:${renderScale}`;
    notebookEngine.viewport.setPageCoordinateTransform(0, width, height, pageGeometry.source.left, pageGeometry.source.top);
    if (activeCanvasConfigurationRef.current === nextConfiguration) {
      notebookEngine.drawing.redraw();
      return;
    }
    notebookEngine.drawing.setScaleMultiplier(renderScale);
    notebookEngine.resize(width, height);
    activeCanvasConfigurationRef.current = nextConfiguration;
  }, [liveSceneReady, notebookEngine, page.type, renderScale, width, height, pageGeometry.source.left, pageGeometry.source.top]);

  const [layerRevision, setLayerRevision] = useState(0);
  useEffect(() => {
    if (!isFocused) return;
    const unsubLayers = notebookEngine.layers.subscribe(() => {
      setLayerRevision(rev => rev + 1);
    });
    const unsubMutation = notebookEngine.onSceneMutation(() => setLayerRevision(rev => rev + 1));
    return () => {
      unsubLayers();
      unsubMutation();
    };
  }, [isFocused, notebookEngine]);

  // Text objects for non-focused pages
  const staticTextObjects: TextObject[] = useMemo(() => {
    if (!data || !data.objects) return [];
    const visibility = new Map((data.layers ?? []).map(layer => [layer.id, layer.visible !== false]));
    return data.objects.filter(o => o.type === 'text' && visibility.get(o.layerId ?? DEFAULT_PAGE_LAYER_ID) !== false) as TextObject[];
  }, [data]);

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
          Math.min(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM), cssWidth, cssHeight);
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
  const textZIndex = (layerId?: string) => layeredDrawing ? 21 + Math.max(0, orderedLayers.findIndex(layer => layer.id === (layerId ?? DEFAULT_PAGE_LAYER_ID))) * 2 : undefined;

  return (
    <div 
      data-page-id={page.id}
      data-rendered-page-id={page.id}
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
      >
        {/* This page-owned visual subtree survives every interaction handoff. */}
        <div data-stable-page-visual={page.id} style={{ visibility: liveSceneReady && page.type !== 'pdf' ? 'hidden' : 'visible' }}>
        {staticDrawing && (data?.layers?.length ?? 0) > 1 && data!.layers!.map((layer, order) => <LayerCanvas key={layer.id} drawing={staticDrawing} id={layer.id} width={width} height={height} scale={Math.min(renderScale, MAX_INACTIVE_PAGE_RENDER_ZOOM)} order={order} />)}
        {staticTextObjects.map(obj => isVoiceNoteObject(obj) ? <StaticVoiceNote key={obj.id} object={obj} note={data?.audioNotes?.find(note => note.id === obj.metadata.audioNoteId)} offset={{ x: pageGeometry.source.left, y: pageGeometry.source.top }}/> : (
          <StaticTextPreview key={obj.id} object={obj} scale={1} zIndex={textZIndex(obj.layerId)} offset={{ x: pageGeometry.source.left, y: pageGeometry.source.top }} />
        ))}

        <canvas ref={canvasRef} data-committed-page-id={page.id} className="absolute inset-0 z-10 w-full h-full pointer-events-none" />
        </div>
        {!data && <div role="status" className="absolute inset-0 flex items-center justify-center text-xs opacity-60">Loading page?</div>}

        {liveSceneReady && <div data-live-page-visual={page.id} style={{ visibility: 'visible' }}>
        {/* Focused live TipTap text editors */}
        {liveSceneReady && layeredDrawing && orderedLayers.map((layer, order) => <LayerCanvas key={layer.id} drawing={layeredDrawing} id={layer.id} width={width} height={height} scale={renderScale} order={order} />)}
        {liveSceneReady && liveTextObjects.map(obj => isVoiceNoteObject(obj) ? (
          <NotebookVoiceNote key={obj.id} object={obj} note={notebookEngine.audio.getAll().find(note => note.id === obj.metadata.audioNoteId)} engine={notebookEngine} scale={1} offset={{ x: pageGeometry.source.left, y: pageGeometry.source.top }} bounds={{ x: -pageGeometry.source.left, y: -pageGeometry.source.top, width, height }} editable={editable && notebookEngine.texts.isEditable(obj)} onChange={onVoiceNoteChange} onDelete={onVoiceNoteDelete} onRename={onVoiceNoteRename}/>
        ) : (
          <FloatingTextEditor
            key={obj.id}
            object={obj}
            engine={notebookEngine}
            scale={1}
            pageOffset={textPageOffset}
            zIndex={textZIndex(obj.layerId)}
            toolMode={notebookEngine.layers.isEditable(obj.layerId) ? toolState.mode : 'hand'}
            onFocus={setActiveEditor}
            onBlur={ignoreTextEditorBlur}
          />
        ))}

        {/* Only this transient canvas is ever cleared by NotebookEngine. */}
        {liveSceneReady && page.type !== 'pdf' && <canvas
          ref={activeCanvasRef}
          data-rendered-page-id={page.id}
          data-scene-owner-page-id={sceneOwnerPageId}
          data-render-ready={sceneReady ? 'true' : 'false'}
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
            ...(pageCursor ? { cursor: pageCursor } : {}),
            // Do not expose the shared live surface until its ownership
            // marker has caught up with this physical page.
            visibility: liveSceneReady ? 'visible' : 'hidden',
          }}
        />}
        </div>}

      </PageRenderer>
    </div>
  );
};
