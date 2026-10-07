import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { StaticTextPreview } from '@/components/notebook/StaticTextPreview';
import { DrawingEngine } from '@/components/notebook/engine/DrawingEngine';
import { ImageManager } from '@/components/notebook/engine/ImageManager';
import { LayerManager } from '@/components/notebook/engine/LayerManager';
import { ShapeManager } from '@/components/notebook/engine/ShapeManager';
import { ViewportManager } from '@/components/notebook/engine/ViewportManager';
import { DEFAULT_PAGE_LAYER_ID, type DrawingData, type TextObject } from '@/components/notebook/engine/drawingTypes';
import { pdfRotationMatrix, type pdfSurroundingGeometry } from '@/components/notebook/engine/pdfCoordinates';
import { useFullDarkView } from '@/hooks/useFullDarkView';
import type { PdfPageRotation } from '@/types/notebook';

interface Props {
  drawing: DrawingData;
  geometry: ReturnType<typeof pdfSurroundingGeometry>;
  rotation: PdfPageRotation;
  scale: number;
  rasterScale: number;
  sourcePage: number;
  decodedSource: ImageManager;
  onImagesReady: (page: number, images: ImageManager | null) => void;
  hidden?: boolean;
}

/** Inactive annotations have no input manager, history, editor or persistence. */
export const PdfStaticAnnotationLayer = React.memo(function PdfStaticAnnotationLayer(props: Props) {
  const { drawing } = props;
  if (!(drawing.objects?.length || drawing.strokes?.length || drawing.shapes?.length)) return null;
  return <StaticAnnotations {...props} />;
}, (previous, next) => previous.drawing === next.drawing && previous.rotation === next.rotation
  && previous.scale === next.scale && previous.rasterScale === next.rasterScale
  && previous.sourcePage === next.sourcePage && previous.decodedSource === next.decodedSource
  && previous.onImagesReady === next.onImagesReady
  && previous.hidden === next.hidden
  && previous.geometry.sheet.width === next.geometry.sheet.width && previous.geometry.sheet.height === next.geometry.sheet.height
  && previous.geometry.offset.x === next.geometry.offset.x && previous.geometry.offset.y === next.geometry.offset.y);

function StaticAnnotations({ drawing: data, geometry, rotation, scale, rasterScale, sourcePage, decodedSource, onImagesReady, hidden }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const configuration = useRef('');
  const fullDarkView = useFullDarkView();
  const runtime = useMemo(() => {
    const viewport = new ViewportManager();
    viewport.setRenderTransform({ pan: false, scale: false });
    const layers = new LayerManager();
    const shapes = new ShapeManager(viewport, layers);
    const images = new ImageManager(viewport, layers);
    const drawing = new DrawingEngine(viewport, shapes, images, layers);
    images.setRedrawCallback(() => drawing.redraw());
    return { viewport, layers, shapes, images, drawing };
  }, []);
  useLayoutEffect(() => { runtime.drawing.setFullDarkView(fullDarkView); }, [runtime, fullDarkView]);
  useLayoutEffect(() => {
    if (!canvasRef.current) return;
    runtime.viewport.setPageCoordinateTransform(rotation, geometry.sheet.width, geometry.sheet.height, geometry.offset.x, geometry.offset.y);
    runtime.layers.setData(data.layers, data.activeLayerId);
    const validLayerIds = new Set(runtime.layers.getLayers().map(layer => layer.id));
    const fallbackLayerId = validLayerIds.has(DEFAULT_PAGE_LAYER_ID) ? DEFAULT_PAGE_LAYER_ID : runtime.layers.getLayers()[0].id;
    const withLayer = <T extends { layerId?: string }>(object: T) => ({ ...object, layerId: object.layerId && validLayerIds.has(object.layerId) ? object.layerId : fallbackLayerId });
    runtime.drawing.setScaleMultiplier(rasterScale);
    const next = `${geometry.visual.width}:${geometry.visual.height}:${rasterScale}`;
    if (configuration.current !== next) {
      runtime.drawing.setCanvas(canvasRef.current, geometry.visual.width, geometry.visual.height);
      configuration.current = next;
    }
    const objects = data.version === 1 ? [] : data.objects ?? [];
    runtime.drawing.setStrokes((data.version === 1 ? data.strokes ?? [] : objects.filter(object => object.type === 'stroke')).map(withLayer));
    runtime.shapes.setShapes((data.version === 1 ? data.shapes ?? [] : objects.filter(object => object.type === 'shape')).map(withLayer));
    const images = objects.filter(object => object.type === 'image').map(withLayer);
    runtime.images.adoptDecodedImages(decodedSource, images.map(image => image.fileId));
    runtime.images.setImages(images);
    runtime.drawing.redraw();
  }, [runtime, decodedSource, data.objects, data.strokes, data.shapes, data.layers, data.activeLayerId, data.version, geometry.sheet.width, geometry.sheet.height, geometry.offset.x, geometry.offset.y, geometry.visual.width, geometry.visual.height, rotation, rasterScale]);
  useLayoutEffect(() => {
    onImagesReady(sourcePage, runtime.images);
    return () => { onImagesReady(sourcePage, null); runtime.drawing.detachCanvas(); runtime.images.destroy(); };
  }, [runtime, sourcePage, onImagesReady]);
  const visible = new Map((data.layers ?? []).filter(layer => layer && typeof layer.id === 'string' && layer.id.length > 0).map(layer => [layer.id, layer.visible !== false]));
  const fallbackLayerId = visible.has(DEFAULT_PAGE_LAYER_ID) ? DEFAULT_PAGE_LAYER_ID : visible.keys().next().value ?? DEFAULT_PAGE_LAYER_ID;
  const texts = (data.version === 1 ? [] : data.objects ?? []).filter((object): object is TextObject => object.type === 'text'
    && visible.get(object.layerId && visible.has(object.layerId) ? object.layerId : fallbackLayerId) !== false);
  const matrix = pdfRotationMatrix(rotation, geometry.sheet);
  return <div className="pointer-events-none absolute inset-0" aria-hidden="true" data-pdf-static-annotations style={{ visibility: hidden ? 'hidden' : 'visible' }}>
    <div className="absolute left-0 top-0" style={{ width: geometry.visual.width, height: geometry.visual.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
      <canvas ref={canvasRef} className="panvas-colored-content absolute inset-0 h-full w-full" />
      <div className="absolute left-0 top-0" style={{ width: geometry.sheet.width, height: geometry.sheet.height, transform: `matrix(${matrix.join(',')})`, transformOrigin: 'top left' }}>
        {texts.map(object => <StaticTextPreview key={object.id} object={object} scale={1} offset={geometry.offset} />)}
      </div>
    </div>
  </div>;
}
