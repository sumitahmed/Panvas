import React, { useState, useEffect, useRef } from 'react';
import { Bookmark, ChevronDown, ChevronUp, Download, Grid2X2, ListFilter, MoreHorizontal, PanelLeftClose, PanelLeftOpen, RotateCcw, RotateCw } from 'lucide-react';
import type { PdfPageRotation } from '@/types/notebook';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { NotebookEngine } from '@/components/notebook/engine/NotebookEngine';
import { useBookmarkStore } from '@/stores/bookmarkStore';

interface PdfThumbnailSidebarProps {
  pdfDocument: PDFDocumentProxy | null;
  numPages: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  isSidebarOpen: boolean;
  setIsSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  engine: NotebookEngine;
  documentId?: string;
  pageOrder?: number[];
  rotations?: Record<number, PdfPageRotation>;
  onRotatePage?: (page: number, direction: 1 | -1) => void;
  onExtractPage?: (page: number) => void;
  onMovePage?: (from: number, to: number) => void;
}

export function PdfThumbnailSidebar({ pdfDocument, numPages, currentPage, onPageChange, isSidebarOpen, setIsSidebarOpen, engine, documentId, pageOrder, rotations = {}, onRotatePage, onExtractPage, onMovePage }: PdfThumbnailSidebarProps) { 
  const [activeTab, setActiveTab] = useState<'Thumbnails' | 'Outline'>('Thumbnails'); 
  const [outline, setOutline] = useState<any[] | null>(null);
  const thumbnailRefs = useRef(new Map<number, HTMLDivElement>());

  useEffect(() => {
    if (activeTab !== 'Thumbnails') return;
    thumbnailRefs.current.get(currentPage)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [activeTab, currentPage]);

  useEffect(() => {
    if (pdfDocument) {
      pdfDocument.getOutline().then(data => {
        setOutline(data || []);
      }).catch(err => {
        console.error('Failed to get outline', err);
        setOutline([]);
      });
    } else {
      setOutline(null);
    }
  }, [pdfDocument]);

  const handleOutlineClick = async (dest: any) => {
    if (!pdfDocument || !dest) return;
    try {
      let explicitDest = dest;
      if (typeof dest === 'string') {
        explicitDest = await pdfDocument.getDestination(dest);
      }
      if (Array.isArray(explicitDest) && explicitDest.length > 0) {
        const pageIndex = await pdfDocument.getPageIndex(explicitDest[0]);
        onPageChange(pageIndex + 1);
      }
    } catch (err) {
      console.error('Failed to navigate to outline destination', err);
    }
  };
  
  return (
    <aside className="w-full h-full flex-shrink-0 flex flex-col" aria-label="PDF page thumbnails">
      <div className="mb-3 flex h-10 items-center justify-between border-b border-panvas-border-subtle px-2">
        <div className="flex items-center gap-1">
          <Tab label="Thumbnails" active={activeTab === 'Thumbnails'} onClick={() => setActiveTab('Thumbnails')} />
          <Tab label="Outline" active={activeTab === 'Outline'} onClick={() => setActiveTab('Outline')} />
        </div>
        <button 
          type="button" 
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-panvas-text-secondary transition-colors hover:bg-panvas-bg-hover hover:text-panvas-text-primary active:bg-panvas-bg-active focus-ring" 
          title="Toggle Sidebar" 
          aria-label="Toggle Sidebar"
        >
          {isSidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </button>
      </div>
      <div className="mb-3 flex justify-end gap-1 px-4">
        <MiniButton label="Filter thumbnails"><ListFilter size={13} /></MiniButton>
        <MiniButton label="Grid thumbnails"><Grid2X2 size={13} /></MiniButton>
      </div>
      {activeTab === 'Thumbnails' ? (
        <div className="space-y-3 px-4 pb-4 overflow-y-auto flex-1">
          {(pageOrder?.length === numPages ? pageOrder : Array.from({ length: numPages }, (_, index) => index + 1)).map((pageNum, index, order) => {
            return (
              <div ref={element => { if (element) thumbnailRefs.current.set(pageNum, element); else thumbnailRefs.current.delete(pageNum); }} key={pageNum} className={`group rounded-lg p-1.5 transition-colors ${currentPage === pageNum ? 'bg-panvas-bg-active' : 'hover:bg-panvas-bg-hover'}`}>
                <button type="button" onClick={() => onPageChange(pageNum)} aria-pressed={currentPage === pageNum} className="w-full text-left focus-ring rounded-md relative">
                  <Thumbnail page={pageNum} pdfDocument={pdfDocument} rotation={rotations[pageNum] ?? 0} documentId={documentId} />
                  <span className={`mt-1.5 block text-center text-2xs ${currentPage === pageNum ? 'font-medium text-panvas-text-primary' : 'text-panvas-text-tertiary'}`}>Page {index + 1}</span>
                </button>
                {(onRotatePage || onExtractPage || onMovePage) && <div className="mt-1 flex items-center justify-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <MiniButton label="Rotate counter-clockwise" onClick={() => onRotatePage?.(pageNum, -1)}><RotateCcw size={12} /></MiniButton>
                  <MiniButton label="Rotate clockwise" onClick={() => onRotatePage?.(pageNum, 1)}><RotateCw size={12} /></MiniButton>
                  <MiniButton label="Extract page" onClick={() => onExtractPage?.(pageNum)}><Download size={12} /></MiniButton>
                  <MiniButton label="Move page earlier" disabled={index === 0} onClick={() => onMovePage?.(index, index - 1)}><ChevronUp size={12} /></MiniButton>
                  <MiniButton label="Move page later" disabled={index === order.length - 1} onClick={() => onMovePage?.(index, index + 1)}><ChevronDown size={12} /></MiniButton>
                </div>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-0.5 px-4 pb-4 overflow-y-auto flex-1">
          {!outline ? (
            <div className="text-xs text-panvas-text-tertiary px-2 py-4 text-center">Loading outline...</div>
          ) : outline.length === 0 ? (
            <div className="text-xs text-panvas-text-tertiary px-2 py-4 text-center">No document outline available.</div>
          ) : (
            <OutlineTree items={outline} level={0} onNavigate={handleOutlineClick} />
          )}
        </div>
      )}
    </aside>
  ); 
}

function OutlineTree({ items, level, onNavigate }: { items: any[]; level: number; onNavigate: (dest: any) => void }) {
  if (!items || items.length === 0) return null;
  return (
    <>
      {items.map((item, index) => (
        <div key={`${item.title}-${index}`}>
          <button 
            type="button" 
            onClick={() => onNavigate(item.dest)}
            className="flex min-h-[28px] w-full items-start rounded-md py-1 pr-2 text-left text-xs transition-colors hover:bg-panvas-bg-hover focus-ring text-panvas-text-secondary"
            style={{ paddingLeft: `${8 + level * 12}px` }}
            title={item.title}
          >
            <span className="line-clamp-2">{item.title}</span>
          </button>
          {item.items && item.items.length > 0 && (
            <OutlineTree items={item.items} level={level + 1} onNavigate={onNavigate} />
          )}
        </div>
      ))}
    </>
  );
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) { return <button type="button" onClick={onClick} className={`h-8 border-b-2 px-1.5 text-2xs transition-colors focus-ring ${active ? 'border-panvas-text-primary text-panvas-text-primary' : 'border-transparent text-panvas-text-tertiary hover:text-panvas-text-secondary'}`}>{label}</button>; }
function MiniButton({ label, children, onClick, disabled }: { label: string; children: React.ReactNode; onClick?: () => void; disabled?: boolean }) { return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="flex h-6 w-6 items-center justify-center rounded text-panvas-text-tertiary hover:bg-panvas-bg-hover hover:text-panvas-text-primary focus-ring disabled:opacity-35">{children}</button>; }

export function Thumbnail({ page, pdfDocument, rotation, documentId }: { page: number; pdfDocument: PDFDocumentProxy | null; rotation: number; documentId?: string }) { 
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isBookmarked = useBookmarkStore((s) => documentId ? s.isBookmarked(documentId, page) : false);

  useEffect(() => {
    let isMounted = true;
    let renderTask: any = null;

    if (!pdfDocument) return;

    const renderThumbnail = async () => {
      try {
        const pdfPage = await pdfDocument.getPage(page);
        if (!isMounted) return;

        // Render at a small fixed scale for thumbnail (width roughly ~150px)
        const unscaledViewport = pdfPage.getViewport({ scale: 1.0, rotation });
        const scale = 150 / unscaledViewport.width;
        const viewport = pdfPage.getViewport({ scale, rotation });

        const canvas = canvasRef.current;
        if (!canvas) return;

        const context = canvas.getContext('2d');
        if (!context) return;

        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = Math.floor(viewport.width) + 'px';
        canvas.style.height = Math.floor(viewport.height) + 'px';

        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

        renderTask = pdfPage.render({
          canvasContext: context,
          transform,
          viewport: viewport,
        });
        
        await renderTask.promise;
      } catch (err: any) {
        if (isMounted && err.name !== 'RenderingCancelledException') {
          console.error('[Thumbnail] Render error:', err);
        }
      }
    };

    renderThumbnail();

    return () => {
      isMounted = false;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [pdfDocument, page, rotation]);

  return (
    <div className="relative overflow-hidden rounded-md border border-panvas-border-subtle bg-white shadow-sm flex items-center justify-center min-h-[200px]">
      <canvas ref={canvasRef} className="max-w-full" dir="ltr" />
      {isBookmarked && (
        <div
          className="absolute top-1.5 right-1.5 pointer-events-none z-10"
          aria-label={`Page ${page} bookmarked`}
          data-testid={`thumbnail-bookmark-${page}`}
        >
          <Bookmark size={15} className="text-panvas-accent-blue fill-panvas-accent-blue drop-shadow-sm" />
        </div>
      )}
    </div>
  ); 
}
