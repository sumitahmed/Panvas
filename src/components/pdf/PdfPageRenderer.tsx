import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';
import 'pdfjs-dist/web/pdf_viewer.css';
import { resolveCanvasBackingScale } from '@/components/notebook/engine/ViewportManager';
import { useFullDarkView } from '@/hooks/useFullDarkView';
import { FULL_DARK_PDF_FILTER, isBrightDocumentCanvas } from '@/lib/fullDarkView';
import { useUIStore } from '@/stores/uiStore';

interface PdfPageRendererProps {
  pdfDocument: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation?: number;
}

export const PdfPageRenderer = React.memo(function PdfPageRenderer({ pdfDocument, pageNumber, scale, rotation = 0 }: PdfPageRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fullDarkView = useFullDarkView();
  const [brightDocument, setBrightDocument] = useState(false);
  useLayoutEffect(() => {
    if (fullDarkView && canvasRef.current) setBrightDocument(isBrightDocumentCanvas(canvasRef.current));
  }, [fullDarkView]);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let isMounted = true;
    let renderTask: any = null;
    let textLayer: TextLayer | null = null;
    let rendering = false;
    setError(null);

    const renderPage = async () => {
      try {
        const page = await pdfDocument.getPage(pageNumber);
        if (!isMounted) return;

        const baseViewport = page.getViewport({ scale: 1, rotation });
        const viewport = page.getViewport({ scale, rotation });
        const canvas = canvasRef.current;
        if (!canvas) return;

        // Keep the previous sharp raster visible until its replacement is ready.
        const nextCanvas = document.createElement('canvas');
        const context = nextCanvas.getContext('2d');
        if (!context) return;

        const outputScale = window.devicePixelRatio || 1;
        const backingScale = resolveCanvasBackingScale(
          outputScale,
          scale,
          baseViewport.width,
          baseViewport.height,
        );
        const renderViewport = page.getViewport({ scale: backingScale, rotation });
        nextCanvas.width = Math.floor(renderViewport.width);
        nextCanvas.height = Math.floor(renderViewport.height);

        const renderContext = {
          canvasContext: context,
          viewport: renderViewport,
        };

        renderTask = page.render(renderContext);
        rendering = true;
        await renderTask.promise;
        rendering = false;
        if (!isMounted) return;
        canvas.width = nextCanvas.width;
        canvas.height = nextCanvas.height;
        canvas.getContext('2d')?.drawImage(nextCanvas, 0, 0);
        const appearance = useUIStore.getState();
        if (appearance.theme === 'dark' && appearance.fullDarkView && !appearance.isPrinting) setBrightDocument(isBrightDocumentCanvas(canvas));

        // Render Text Layer
        const textLayerDiv = textLayerRef.current;
        if (textLayerDiv && isMounted) {
          textLayerDiv.innerHTML = '';
          const textContent = await page.getTextContent();
          if (!isMounted) return;
          textLayer = new TextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport: viewport
          });
          await textLayer.render();
        }
      } catch (err: any) {
        if (isMounted && err.name !== 'RenderingCancelledException') {
          console.error('[PdfPageRenderer] Render error:', err);
          setError(err);
        }
      }
    };

    renderPage();

    return () => {
      isMounted = false;
      textLayer?.cancel();
      if (renderTask && rendering) {
        renderTask.cancel();
      }
    };
  }, [pdfDocument, pageNumber, rotation, scale]);

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-panvas-bg-elevated text-panvas-text-error">
        Failed to render page {pageNumber}
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <canvas 
        ref={canvasRef} 
        className="block w-full h-full"
        data-pdf-raster
        data-bright-document={brightDocument}
        style={{ filter: fullDarkView && brightDocument ? FULL_DARK_PDF_FILTER : undefined }}
        dir="ltr"
      />
      <div 
        ref={textLayerRef} 
        className="textLayer absolute inset-0 w-full h-full" 
        style={{ '--scale-factor': scale } as React.CSSProperties}
      />
    </div>
  );
});
