import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { PagePropertySet } from '@/types/notebook';
import { resolvePageNoteSpace } from '@/lib/pageProperties';

const STEP = 140;
const MAX_SPACE = 6000;
const sides = [
  ['Top', 'extraTop'],
  ['Right', 'extraRight'],
  ['Bottom', 'extraBottom'],
  ['Left', 'extraLeft'],
] as const;

export function NoteSpaceControl({ properties, onChange }: {
  properties: Partial<PagePropertySet>;
  onChange: (updates: Partial<PagePropertySet>) => void;
}) {
  const noteSpace = resolvePageNoteSpace(properties);
  const [expanded, setExpanded] = useState(false);
  const updateSide = (key: typeof sides[number][1], value: number) => onChange({
    [key]: Math.max(0, Math.min(MAX_SPACE, value)),
    ...(key === 'extraBottom' ? { extraHeight: 0 } : {}),
  });
  const hasSpace = Object.values(noteSpace).some(value => value > 0);

  return (
    <section className="rounded-xl border border-panvas-border-subtle bg-panvas-bg-secondary/45" aria-labelledby="note-space-heading">
      <button type="button" aria-expanded={expanded} aria-controls="research-space-controls" onClick={() => setExpanded(value => !value)} className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-panvas-bg-hover focus-ring">
        <span className="min-w-0">
          <span id="note-space-heading" className="block font-medium text-panvas-text-primary">Research space</span>
          <span className="mt-0.5 block truncate text-2xs text-panvas-text-tertiary">{hasSpace ? `${Math.round(noteSpace.top + noteSpace.right + noteSpace.bottom + noteSpace.left)} px added` : 'Add room around this page'}</span>
        </span>
        <ChevronDown size={15} className={`shrink-0 text-panvas-text-tertiary transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && <div id="research-space-controls" className="border-t border-panvas-border-subtle p-3 pt-2.5">
      {hasSpace && <div className="mb-2 flex justify-end"><button type="button" onClick={() => onChange({ extraTop: 0, extraRight: 0, extraBottom: 0, extraLeft: 0, extraHeight: 0 })} className="rounded px-1.5 py-1 text-2xs text-panvas-text-secondary hover:bg-panvas-bg-hover focus-ring">Reset all</button></div>}
      <div className="flex items-center gap-3 rounded-lg border border-panvas-border-subtle bg-panvas-bg-primary p-2.5">
        <SpaceMap noteSpace={noteSpace} />
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5" aria-label="Research space directions">
          {sides.filter(([label]) => properties.pageSize !== 'Infinite' || label === 'Top' || label === 'Bottom').map(([label, key]) => {
            const value = noteSpace[label.toLowerCase() as keyof typeof noteSpace];
            return <SideButton key={key} label={label} value={value} onDecrease={() => updateSide(key, value - STEP)} onIncrease={() => updateSide(key, value + STEP)} />;
          })}
        </div>
      </div>
      <button type="button" onClick={() => onChange({ extraTop: Math.min(MAX_SPACE, noteSpace.top + STEP), extraRight: properties.pageSize === 'Infinite' ? noteSpace.right : Math.min(MAX_SPACE, noteSpace.right + STEP), extraBottom: Math.min(MAX_SPACE, noteSpace.bottom + STEP), extraLeft: properties.pageSize === 'Infinite' ? noteSpace.left : Math.min(MAX_SPACE, noteSpace.left + STEP), extraHeight: 0 })} className="mt-2 w-full rounded-md border border-panvas-border-default bg-panvas-bg-primary px-2 py-1.5 text-xs font-medium text-panvas-text-primary hover:bg-panvas-bg-hover focus-ring">Add {STEP} px around page</button>
      </div>}
    </section>
  );
}

function SideButton({ label, value, onDecrease, onIncrease }: { label: string; value: number; onDecrease: () => void; onIncrease: () => void }) {
  return <div className="min-w-0 rounded-md border border-panvas-border-subtle bg-panvas-bg-secondary/60 p-1">
    <div className="mb-0.5 truncate px-1 text-[9px] font-semibold uppercase tracking-wide text-panvas-text-tertiary">{label}</div>
    <div className="flex items-center justify-between">
      <button type="button" onClick={onDecrease} disabled={value <= 0} className="grid h-6 w-6 place-items-center rounded text-sm text-panvas-text-secondary hover:bg-panvas-bg-hover focus-ring disabled:opacity-25" aria-label={`Remove ${label.toLowerCase()} research space`}>−</button>
      <span className="min-w-8 text-center text-[10px] font-medium tabular-nums text-panvas-text-primary">{Math.round(value)}</span>
      <button type="button" onClick={onIncrease} className="grid h-6 w-6 place-items-center rounded text-sm text-panvas-text-secondary hover:bg-panvas-bg-hover focus-ring" aria-label={`Add ${label.toLowerCase()} research space`}>+</button>
    </div>
  </div>;
}

function SpaceMap({ noteSpace }: { noteSpace: ReturnType<typeof resolvePageNoteSpace> }) {
  const active = (value: number) => value > 0 ? 'bg-panvas-accent-blue/20' : 'bg-panvas-bg-secondary';
  return <div className="grid h-[82px] w-[70px] shrink-0 grid-cols-[10px_1fr_10px] grid-rows-[10px_1fr_10px] gap-0.5 rounded-lg border border-panvas-border-subtle bg-panvas-bg-secondary p-1.5" aria-hidden="true">
    <div className={`col-start-2 ${active(noteSpace.top)} rounded-sm`} />
    <div className={`row-start-2 ${active(noteSpace.left)} rounded-sm`} />
    <div className="col-start-2 row-start-2 rounded border border-panvas-border-strong bg-panvas-bg-primary shadow-sm" />
    <div className={`col-start-3 row-start-2 ${active(noteSpace.right)} rounded-sm`} />
    <div className={`col-start-2 row-start-3 ${active(noteSpace.bottom)} rounded-sm`} />
  </div>;
}
