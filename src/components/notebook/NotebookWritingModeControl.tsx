import React from 'react';
import { FileText, Pencil } from 'lucide-react';
import type { PagePropertySet } from '@/types/notebook';

export function NotebookWritingModeControl({ properties, onChange, onConvert, canConvert = false, className = '' }: {
  properties: Readonly<PagePropertySet>; onChange?: (updates: Partial<PagePropertySet>) => void;
  onConvert?: () => void; canConvert?: boolean; className?: string;
}) {
  const mode = properties.layoutMode ?? 'freeform';
  return <div className={className}>
    <div role="group" aria-label="Writing layout" className="grid grid-cols-2 gap-1 rounded-lg border border-panvas-border-default bg-panvas-bg-secondary p-1">
      {(['document', 'freeform'] as const).map(value => <button key={value} type="button" disabled={!onChange}
        aria-pressed={mode === value} onMouseDown={event => event.preventDefault()} onClick={() => onChange?.({ layoutMode: value })}
        className={`flex min-h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs focus-ring disabled:opacity-50 ${mode === value ? 'bg-panvas-bg-active font-medium text-panvas-text-primary' : 'text-panvas-text-secondary hover:bg-panvas-bg-hover'}`}>
        {value === 'document' ? <FileText size={14} aria-hidden="true" /> : <Pencil size={14} aria-hidden="true" />}{value === 'document' ? 'Document' : 'Freeform'}
      </button>)}
    </div>
    {mode === 'freeform' && onConvert && <div className="mt-2">
      <button type="button" disabled={!canConvert} onMouseDown={event => event.preventDefault()} onClick={onConvert}
        className="min-h-8 w-full rounded-md border border-panvas-border-default px-2 text-left text-xs text-panvas-text-primary hover:bg-panvas-bg-hover focus-ring disabled:opacity-50">Convert selected text to document</button>
      <p className="mt-1 text-[11px] leading-relaxed text-panvas-text-secondary">{canConvert ? 'Keeps the original and other objects. Undo restores its position.' : 'Select or edit a text box to convert it.'}</p>
    </div>}
  </div>;
}
