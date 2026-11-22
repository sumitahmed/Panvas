import React, { useEffect, useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useLayoutStore } from '@/stores/layoutStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { InactivePagePreview } from '@/components/notebook/InactivePagePreview';
import { PdfPageRenderer } from '@/components/pdf/PdfPageRenderer';
import { usePdfDocument } from '@/hooks/usePdfDocument';
import { normalizePdfPageState } from '@/services/pdf/pdfPageState';
import type { NotebookPage, PdfPageRotation } from '@/types/notebook';

/**
 * A reference should open beside the current document, not an arbitrary first
 * page left over from a previous session. The user can still deliberately pick
 * any page from the inspector afterwards.
 */
export function getSuggestedReferencePage(activePage: NotebookPage | undefined, pages: NotebookPage[]): NotebookPage | undefined {
  const available = pages.filter(page => !page.deletedAt && page.id !== activePage?.id);
  if (!activePage) return available[0];

  const sameSection = available
    .filter(page => page.notebookId === activePage.notebookId && page.sectionId === activePage.sectionId)
    .sort((a, b) => a.order - b.order);
  const afterActive = sameSection.find(page => page.order > activePage.order);
  if (afterActive) return afterActive;
  if (sameSection.length) return sameSection[sameSection.length - 1];

  return available.find(page => page.notebookId === activePage.notebookId) ?? available[0];
}

function PdfReferencePreview({ page, zoom }: { page: { pdfDataId?: string; pdfPageState?: { version: 1; pageOrder: number[]; rotations: Record<number, PdfPageRotation> } }; zoom: number }) {
  const { pdfDocument, numPages, isLoading, error } = usePdfDocument(page.pdfDataId);
  const [size, setSize] = useState({ width: 794, height: 1123 });
  const state = useMemo(() => normalizePdfPageState(page.pdfPageState, numPages), [numPages, page.pdfPageState]);
  const sourcePage = state.pageOrder[0] ?? 1;
  const rotation = state.rotations[sourcePage] ?? 0;

  useEffect(() => {
    if (!pdfDocument) return;
    let mounted = true;
    void pdfDocument.getPage(sourcePage).then(pdfPage => {
      if (!mounted) return;
      const viewport = pdfPage.getViewport({ scale: 1, rotation: ((pdfPage.rotate ?? 0) + rotation) % 360 });
      setSize({ width: viewport.width, height: viewport.height });
    });
    return () => { mounted = false; };
  }, [pdfDocument, rotation, sourcePage]);

  if (isLoading) return <div className="flex h-full items-center justify-center text-xs text-panvas-text-tertiary">Loading PDF reference…</div>;
  if (error || !pdfDocument) return <div className="flex h-full items-center justify-center px-6 text-center text-xs text-panvas-text-error">Unable to render this PDF reference.</div>;

  return (
    <div className="mx-auto shadow-2xl" style={{ width: size.width * zoom, height: size.height * zoom }}>
      <PdfPageRenderer pdfDocument={pdfDocument} pageNumber={sourcePage} scale={zoom} rotation={rotation} />
    </div>
  );
}

export function ReferencePagePane() {
  const { secondaryPageId, setSuggestedSecondaryPageId, hasExplicitReferenceSelection } = useLayoutStore();
  const { activePageId, notebookPages, notebooks, workspaces } = useWorkspaceStore();
  const activePage = notebookPages.find(page => page.id === activePageId);
  const suggested = useMemo(() => getSuggestedReferencePage(activePage, notebookPages), [activePage, notebookPages]);
  const selected = hasExplicitReferenceSelection
    ? notebookPages.find(page => page.id === secondaryPageId && !page.deletedAt && page.id !== activePageId)
    : suggested;
  const notebook = selected ? notebooks.find(item => item.id === selected.notebookId) : undefined;
  const workspace = notebook ? workspaces.find(item => item.id === notebook.workspaceId) : undefined;
  const [zoom, setZoom] = useState(0.65);

  useEffect(() => {
    if (!hasExplicitReferenceSelection && selected && selected.id !== secondaryPageId) {
      setSuggestedSecondaryPageId(selected.id);
    }
  }, [hasExplicitReferenceSelection, secondaryPageId, selected, setSuggestedSecondaryPageId]);

  if (!selected || !notebook || !workspace) {
    return <div className="flex h-full items-center justify-center bg-panvas-bg-secondary text-sm text-panvas-text-tertiary">Choose another page as a reference.</div>;
  }

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden bg-panvas-bg-secondary" aria-label={`Reference: ${selected.title}`}>
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-panvas-border-subtle bg-panvas-bg-primary px-3">
        <div className="min-w-0"><div className="truncate text-xs font-medium text-panvas-text-primary">{selected.title}</div><div className="truncate text-2xs text-panvas-text-tertiary">{notebook.name} · Read-only reference</div></div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setZoom(value => Math.max(0.35, value - 0.1))} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-panvas-bg-hover" title="Zoom out reference" aria-label="Zoom out reference"><Minus size={13} /></button>
          <span className="w-10 text-center text-2xs text-panvas-text-secondary">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom(value => Math.min(1.5, value + 0.1))} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-panvas-bg-hover" title="Zoom in reference" aria-label="Zoom in reference"><Plus size={13} /></button>
        </div>
      </header>
      <div className="flex-1 overflow-auto p-6">
        {selected.type === 'pdf' ? (
          <PdfReferencePreview page={selected} zoom={zoom} />
        ) : (
          <div className="mx-auto origin-top" style={{ width: 794, height: 1123, transform: `scale(${zoom})`, transformOrigin: 'top center', marginBottom: 1123 * (zoom - 1) }}>
            <InactivePagePreview workspaceId={workspace.id} notebookId={notebook.id} notebook={notebook} page={selected} width={794} height={1123} scale={1} pageNumberText="Reference" />
          </div>
        )}
      </div>
    </section>
  );
}
