import React, { useEffect, useRef, useState } from 'react';
import { Download, FileDown, MoreHorizontal, Printer } from 'lucide-react';
import type { NotebookEngine } from './engine/NotebookEngine';
import { NotebookLayersControl } from './NotebookLayersControl';
import { NotebookElementsControl } from './NotebookElementsControl';
import { NotebookAudioControl } from './NotebookAudioControl';
import type { AudioNote, DrawingData } from './engine/drawingTypes';
import type { PageAudioOwner } from '@/services/audio/audioLifecycle';

interface NotebookPageUtilitiesProps {
  engine: NotebookEngine;
  workspaceId?: string;
  notebookId?: string;
  ownerId?: string;
  onChange: () => void;
  onVoiceDelete?: (note: AudioNote) => void;
  onVoiceRename?: (note: AudioNote, title: string) => void;
  editable?: boolean;
  onPageDataPersisted?: (pageId: string, data: DrawingData) => void;
  compact?: boolean;
  onExportPage?: () => void;
  onExportNotebook?: () => void;
  onPrintPage?: () => void;
  onPrintNotebook?: () => void;
  isExporting?: boolean;
  embedded?: boolean;
}

export function NotebookPageUtilities({ engine, workspaceId, notebookId, ownerId, onChange, onVoiceDelete, onVoiceRename, editable = true, onPageDataPersisted, compact = false, onExportPage, onExportNotebook, onPrintPage, onPrintNotebook, isExporting = false, embedded = false }: NotebookPageUtilitiesProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPdfMenuOpen, setIsPdfMenuOpen] = useState(false);
  const compactMenuRef = useRef<HTMLDivElement>(null);
  const pdfMenuRef = useRef<HTMLDivElement>(null);
  const audioOwner: PageAudioOwner | undefined = workspaceId && notebookId && ownerId
    ? { workspaceId, notebookId, pageId: ownerId }
    : undefined;
  const controls = <>
    {editable && <NotebookLayersControl engine={engine} onChange={onChange} />}
    {editable && <NotebookElementsControl engine={engine} workspaceId={workspaceId} onInsert={onChange} />}
    <NotebookAudioControl engine={engine} owner={audioOwner} canRecord={editable} onPageDataPersisted={onPageDataPersisted} onDelete={onVoiceDelete} onRename={onVoiceRename} />
    {onPrintPage && (
      <button
        type="button"
        onClick={() => onPrintPage()}
        disabled={isExporting}
        className="panvas-icon-control h-9 w-9 focus-ring disabled:opacity-50"
        aria-label="Print page"
        title="Print page"
      >
        <Printer size={16} />
      </button>
    )}
    {onExportPage && onExportNotebook && (
      <div ref={pdfMenuRef} className="relative">
        <button type="button" onClick={() => setIsPdfMenuOpen(value => !value)} disabled={isExporting} className="panvas-icon-control h-9 w-9 focus-ring disabled:opacity-50" aria-label="Export and print" title="Export and print" aria-haspopup="menu" aria-expanded={isPdfMenuOpen}><Download size={16} /></button>
        {isPdfMenuOpen && <div role="menu" aria-label="Export and print" className="panvas-floating-surface absolute right-0 top-10 z-50 min-w-56 p-1 shadow-xl rounded-xl border border-panvas-border-subtle">
          <button role="menuitem" type="button" onClick={() => { setIsPdfMenuOpen(false); onExportPage(); }} disabled={isExporting} className="panvas-menu-item w-full disabled:opacity-50"><FileDown size={15} />Export Page to PDF</button>
          <button role="menuitem" type="button" onClick={() => { setIsPdfMenuOpen(false); onExportNotebook(); }} disabled={isExporting} className="panvas-menu-item w-full disabled:opacity-50"><Download size={15} />Export Notebook to PDF</button>
          {onPrintPage && <button role="menuitem" type="button" onClick={() => { setIsPdfMenuOpen(false); onPrintPage(); }} disabled={isExporting} className="panvas-menu-item w-full disabled:opacity-50"><Printer size={15} />Print Page</button>}
          {onPrintNotebook && <button role="menuitem" type="button" onClick={() => { setIsPdfMenuOpen(false); onPrintNotebook(); }} disabled={isExporting} className="panvas-menu-item w-full disabled:opacity-50"><Printer size={15} />Print Notebook</button>}
        </div>}
      </div>
    )}
  </>;

  useEffect(() => {
    if (!isOpen && !isPdfMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setIsOpen(false); setIsPdfMenuOpen(false); }
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!compactMenuRef.current?.contains(event.target as Node)) setIsOpen(false);
      if (!pdfMenuRef.current?.contains(event.target as Node)) setIsPdfMenuOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
    };
  }, [isOpen, isPdfMenuOpen]);

  if (!compact) {
    return <div className={`flex items-center gap-1 ${embedded ? 'p-1' : 'panvas-page-utilities panvas-floating-surface p-1.5'}`} role="toolbar" aria-label="Page utilities">{controls}</div>;
  }

  return (
    <div ref={compactMenuRef} className="relative">
      <button type="button" onClick={() => setIsOpen(value => !value)} className="panvas-page-utilities panvas-icon-control h-11 w-11 rounded-xl focus-ring" title="Page utilities" aria-label="Page utilities" aria-expanded={isOpen}><MoreHorizontal size={17} /></button>
      {isOpen && <div role="menu" aria-label="Page utilities" className="panvas-floating-surface absolute right-0 top-12 z-50 flex items-center p-1.5 shadow-xl rounded-xl border border-panvas-border-subtle">{controls}</div>}
    </div>
  );
}
