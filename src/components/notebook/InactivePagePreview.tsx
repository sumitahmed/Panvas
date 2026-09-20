import React, { useEffect, useState, useRef, useMemo } from 'react';
import { textObjectStyle } from './textTypography';
import { notebookRepository } from '@/repositories/NotebookRepository';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { useAuthStore } from '@/stores/authStore';
import { PageRenderer } from './PageRenderer';
import { createEmptyDrawingData, type DrawingData, type TextObject, DEFAULT_PAGE_LAYER_ID } from './engine/drawingTypes';
import type { Notebook, NotebookPage } from '@/types/notebook';
import { resolvePageProperties } from '@/lib/pageProperties';
import { ViewportManager } from './engine/ViewportManager';
import { ShapeManager } from './engine/ShapeManager';
import { ImageManager } from './engine/ImageManager';
import { LayerManager } from './engine/LayerManager';
import { DrawingEngine } from './engine/DrawingEngine';
import { EditorContent, useEditor } from '@tiptap/react';
import { notebookTipTapExtensions } from './tiptapExtensions';
import { resolvePageSurfaceGeometry } from '@/lib/pageProperties';
import {
  getStickyNoteColor,
  getStickyNoteOpacity,
  getStickyNoteShape,
  getShapeBorderRadius,
  hexToRgba,
  isStickyNote,
} from './stickyNotes';
import { gate0Profiler } from '@/dev/gate0Profiler';

interface InactivePagePreviewProps {
  workspaceId: string;
  notebookId: string;
  notebook: Notebook;
  page: NotebookPage;
  width: number;
  height: number;
  scale: number;
  pageNumberText: string;
  /** Immutable page-owned snapshot supplied by the notebook renderer. */
  data?: DrawingData;
  onActivatePage?: (pageId: string) => void;
}

const StaticTextPreview: React.FC<{ object: TextObject; scale: number; offset?: { x: number; y: number } }> = ({ object, scale, offset }) => {
  gate0Profiler.resource('reactRenders.InactiveStaticTextPreview', 1);
  const editor = useEditor({
    editable: false,
    extensions: notebookTipTapExtensions,
    content: object.content,
  });
  useEffect(() => {
    gate0Profiler.resource('tipTapEditors', 1);
    return () => gate0Profiler.resource('tipTapEditors', -1);
  }, []);

  if (!editor) return null;

  const isSticky = isStickyNote(object);
  const stickyColor = getStickyNoteColor(object);
  const stickyOpacity = getStickyNoteOpacity(object);
  const stickyShape = getStickyNoteShape(object);
  const bgRgba = isSticky ? hexToRgba(stickyColor, stickyOpacity) : undefined;
  const legacyBg = /^#[0-9a-f]{6}$/i.test(String(object.metadata?.elementBackground ?? ''))
    ? String(object.metadata?.elementBackground)
    : undefined;

  return (
    <div
      className={`absolute pointer-events-none z-0 ${object.metadata?.pastePresentation === 'sticky-note' ? 'panvas-pasted-note' : object.metadata?.pastePresentation === 'mixed-paste' ? 'panvas-mixed-paste' : ''}`}
      style={{
        ...textObjectStyle(object),
        left: `${(object.x + (offset?.x ?? 0)) * scale}px`,
        top: `${(object.y + (offset?.y ?? 0)) * scale}px`,
        width: `${object.width}px`,
        minHeight: object.height ? `${object.height}px` : undefined,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
        padding: isSticky ? '14px' : undefined,
        ...(legacyBg && !isSticky ? { backgroundColor: legacyBg } : {}),
      }}
    >
      {isSticky && (
        <div className="absolute inset-0 -z-10 overflow-visible pointer-events-none">
          {stickyShape === 'star' ? (
            <svg className="w-full h-full drop-shadow-md" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polygon points="50,0 63,38 100,38 69,59 82,100 50,75 18,100 31,59 0,38 37,38" fill={bgRgba} />
            </svg>
          ) : (
            <div
              className="w-full h-full shadow-md"
              style={{
                backgroundColor: bgRgba,
                borderRadius: getShapeBorderRadius(stickyShape),
              }}
            />
          )}
        </div>
      )}
      <EditorContent 
        editor={editor} 
        className={`outline-none prose prose-neutral max-w-none prose-sm ${isSticky ? 'p-0' : 'p-1'}`} 
        style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}
      />
    </div>
  );
};

const InactivePagePreviewComponent: React.FC<InactivePagePreviewProps> = ({
  workspaceId, notebookId, notebook, page, width, height, scale, pageNumberText, data: pageSnapshot, onActivatePage
}) => {
  gate0Profiler.resource('reactRenders.InactivePagePreview', 1);
  useEffect(() => {
    gate0Profiler.resource('reactCommits.InactivePagePreview', 1);
  });
  useEffect(() => {
    gate0Profiler.resource('mountedPages', 1);
    gate0Profiler.resource('inactivePreviews', 1);
    gate0Profiler.resource('canvases', 1);
    return () => {
      gate0Profiler.resource('mountedPages', -1);
      gate0Profiler.resource('inactivePreviews', -1);
      gate0Profiler.resource('canvases', -1);
    };
  }, []);
  const [loadedData, setLoadedData] = useState<DrawingData | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Preview engine instance persists across width/height changes (e.g. zoom).
  const engineRef = useRef<{ drawing: DrawingEngine; viewport: ViewportManager } | null>(null);
  const renderGenerationRef = useRef(0);
  const data = pageSnapshot ?? loadedData;
  const properties = data ? data.properties : createEmptyDrawingData().properties;
  const pageGeometry = useMemo(() => resolvePageSurfaceGeometry(properties), [properties]);

  // Load Drawing Data for default pages
  useEffect(() => {
    let mounted = true;
    if (pageSnapshot) {
      setLoadedData(null);
      return () => { mounted = false; };
    }
    if (page.type === 'pdf') {
      const emptyData = createEmptyDrawingData();
      emptyData.properties = resolvePageProperties(notebook, page);
      setLoadedData(emptyData); // PDFs don't use regular drawing data, just need properties
      return;
    }

    notebookRepository.loadDrawingData(workspaceId, notebookId, page.id).then(loaded => {
      if (!mounted) return;
      const resolved = (loaded || createEmptyDrawingData()) as DrawingData;
      setLoadedData({ ...resolved, properties: resolvePageProperties(notebook, page, resolved.properties) });
    });
    return () => { mounted = false; };
  }, [workspaceId, notebookId, notebook, page, pageSnapshot]);

  // Build the preview engine and load its data. Deliberately excludes
  // width/height: this must NOT rerun on every zoom-driven size change.
  useEffect(() => {
    if (!data || page.type === 'pdf' || !canvasRef.current) return;
    const generation = ++renderGenerationRef.current;

    const viewport = new ViewportManager();
    viewport.setZoom(scale);
    viewport.setPageCoordinateTransform(0, width, height, pageGeometry.source.left, pageGeometry.source.top);
    const layers = new LayerManager();
    layers.setData(data.layers, data.activeLayerId);
    const shapes = new ShapeManager(viewport, layers);
    const images = new ImageManager(viewport, layers);
    const drawing = new DrawingEngine(viewport, shapes, images, layers);

    drawing.setCanvas(canvasRef.current, width, height);

    if (data.version === 1) {
      drawing.setStrokes((data.strokes || []).map(object => ({ ...object, layerId: object.layerId ?? layers.getLayers()[0].id })));
      shapes.setShapes((data.shapes || []).map(object => ({ ...object, layerId: object.layerId ?? layers.getLayers()[0].id })));
      images.clearImages();
    } else {
      const objects = data.objects || [];
      drawing.setStrokes(objects.filter(o => o.type === 'stroke').map(object => ({ ...object, layerId: object.layerId ?? layers.getLayers()[0].id })) as any);
      shapes.setShapes(objects.filter(o => o.type === 'shape').map(object => ({ ...object, layerId: object.layerId ?? layers.getLayers()[0].id })) as any);
      images.setImages(objects.filter(o => o.type === 'image').map(object => ({ ...object, layerId: object.layerId ?? layers.getLayers()[0].id })) as any);
    }

    drawing.redraw();
    if (generation !== renderGenerationRef.current) {
      drawing.detachCanvas();
      images.destroy();
      return;
    }
    engineRef.current = { drawing, viewport };

    return () => {
      if (renderGenerationRef.current === generation) engineRef.current = null;
      drawing.detachCanvas();
      images.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, page.type]);

  // Resize the existing preview canvas when width/height/scale change (e.g. zoom),
  // without rebuilding the engine or reloading strokes/shapes/images.
  useEffect(() => {
    if (!engineRef.current || page.type === 'pdf') return;
    engineRef.current.viewport.setZoom(scale);
    engineRef.current.viewport.setPageCoordinateTransform(0, width, height, pageGeometry.source.left, pageGeometry.source.top);
    engineRef.current.drawing.resize(width, height);
  }, [width, height, scale, page.type, pageGeometry.source.left, pageGeometry.source.top]);

  const textObjects: TextObject[] = useMemo(() => {
    if (!data || !data.objects) return [];
    const visibility = new Map((data.layers ?? []).map(layer => [layer.id, layer.visible !== false]));
    return data.objects.filter(o => o.type === 'text' && visibility.get(o.layerId ?? DEFAULT_PAGE_LAYER_ID) !== false) as TextObject[];
  }, [data]);

  // PDF Preview Rendering
  useEffect(() => {
    if (page.type !== 'pdf' || !page.pdfDataId || !canvasRef.current) return;
    let mounted = true;

    async function loadPdf() {
      const loadStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
      try {
        const userId = useAuthStore.getState().user?.id ?? null;
        const pdfFile = await canvasRepository.getPdf(userId, page.pdfDataId!);
        if (!pdfFile || !mounted) return;

        const pdfjsLib = await import('pdfjs-dist');
        // @ts-ignore
        const pdfjsWorkerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

        // Bytes are passed directly: a blob object URL would need fetch(),
        // which is unavailable on the file:// origin of the packaged app.
        // slice(0) copies: pdf.js takes ownership of the buffer.
        const bytes = new Uint8Array(pdfFile.data.slice(0));
        const loadingTask = pdfjsLib.getDocument({ data: bytes });
        gate0Profiler.resource('pdfLoadingTasks', 1);
        gate0Profiler.event('pdf-loading-task-start', undefined, { pageId: page.id, focused: false });
        const doc = await loadingTask.promise;
        gate0Profiler.resource('pdfLoadingTasks', -1);
        gate0Profiler.resource('pdfDocuments', 1);
        gate0Profiler.event('pdf-document-load', loadStartedAt ? performance.now() - loadStartedAt : undefined, { pageId: page.id, focused: false });

        if (!mounted) {
          loadingTask.destroy();
          gate0Profiler.resource('pdfDocuments', -1);
          gate0Profiler.event('pdf-destroy', undefined, { pageId: page.id, reason: 'resolved-after-unmount' });
          return;
        }
        
        // Render first page
        const pdfPage = await doc.getPage(1);
        const viewport = pdfPage.getViewport({ scale: 1.0 });
        const canvas = canvasRef.current;
        if (!canvas) return;

        // Scale to fit the page dimensions while preserving aspect ratio
        const pdfScale = Math.min(width / viewport.width, height / viewport.height) * 0.95;
        const scaledViewport = pdfPage.getViewport({ scale: pdfScale });
        
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;

        const renderStartedAt = gate0Profiler.isEnabled() ? performance.now() : 0;
        gate0Profiler.resource('pdfRenderTasks', 1);
        await pdfPage.render({
          canvasContext: ctx,
          viewport: scaledViewport,
        }).promise;
        gate0Profiler.resource('pdfRenderTasks', -1);
        gate0Profiler.event('pdf-render', renderStartedAt ? performance.now() - renderStartedAt : undefined, { pageId: page.id, focused: false });
      } catch (err) {
        console.error('Failed to load PDF preview:', err);
      }
    }

    loadPdf();
    return () => { mounted = false; };
  }, [page.type, page.pdfDataId, width, height]);

  const handleTriggerActivate = () => {
    onActivatePage?.(page.id);
  };

  return (
    <div
      data-page-id={page.id}
      data-rendered-page-id={page.id}
      className="relative shadow-2xl transition-shadow" 
      onPointerDown={handleTriggerActivate}
      onClick={handleTriggerActivate}
    >
      <PageRenderer
        id={page.id}
        width={width}
        height={height}
        properties={properties}
        pageNumberText={pageNumberText}
      >
        {/* Render text objects on inactive page */}
        {textObjects.map(obj => (
          <StaticTextPreview key={obj.id} object={obj} scale={1} offset={{ x: pageGeometry.source.left, y: pageGeometry.source.top }} />
        ))}

        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <canvas 
            ref={canvasRef} 
            className={`pointer-events-none ${page.type === 'pdf' ? 'shadow-md bg-white' : ''}`}
            style={page.type === 'default' ? { width, height } : {}}
          />
        </div>
        
      </PageRenderer>
    </div>
  );
};

export const InactivePagePreview = React.memo(InactivePagePreviewComponent);
InactivePagePreview.displayName = 'InactivePagePreview';
