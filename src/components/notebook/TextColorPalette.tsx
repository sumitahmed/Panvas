import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Slash } from 'lucide-react';
import { OverlayManager } from '@/components/ui/OverlayManager';
import { useNotebookSettingsStore } from '@/stores/notebookSettingsStore';
import { useUIStore } from '@/stores/uiStore';
import { highlightColorLabel } from '@/lib/highlightPalette';
import { formattingColorValue } from './textFormatting';

const foregrounds = [['Black', '#20242a'], ['Gray', '#6b7280'], ['Red', '#dc2626'], ['Green', '#15803d'], ['Blue', '#2563eb'], ['Purple', '#7c3aed']];

/** The existing overlay and formatting commands own focus, selection and history. */
export function TextColorPalette({ kind, anchorRef, value, mixed, noneSelected, onChange, onClose, onEscape }: {
  kind: 'textStyle' | 'highlight'; anchorRef: React.RefObject<HTMLButtonElement | null>;
  value?: string; mixed: boolean; noneSelected: boolean;
  onChange: (value: string | null) => void; onClose: () => void; onEscape: () => void;
}) {
  const label = kind === 'highlight' ? 'Highlight' : 'Text';
  const palette = useNotebookSettingsStore(state => state.highlightPalette);
  const customRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<HTMLButtonElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const customColor = formattingColorValue(value, kind === 'highlight' ? '#fff4b8' : '#20242a');
  const customPending = useRef(false);
  const reportSaveError = () => useUIStore.getState().showToast('Could not save highlight palette preferences.', 'error');
  const choose = (color: string | null, custom = false, closeAfter = true) => {
    customPending.current = false;
    if (kind === 'highlight') void useNotebookSettingsStore.getState().selectHighlightColor(color, custom).catch(reportSaveError);
    onChange(color); if (closeAfter) onClose();
  };
  const close = () => {
    // Chromium queues change when its native chooser closes. An outside
    // mousedown can dismiss this overlay first and detach the input, losing
    // that event. Consume the final preview before unmount, exactly once.
    if (customPending.current && customRef.current) choose(customRef.current.value, true);
    else onClose();
  };
  useEffect(() => {
    if (customRef.current && !customPending.current) customRef.current.value = customColor;
  }, [customColor]);
  useEffect(() => {
    const input = customRef.current;
    if (!input) return;
    // Native color inputs emit preview `input` events while the picker is open.
    // Commit once on `change`; React's color onChange also fires for previews.
    const commit = () => { if (customPending.current) choose(input.value, true); };
    // The anchor toggles its own menu on click, bypassing OverlayManager's
    // outside-close callback. Commit before that toggle without closing twice.
    const commitBeforeToggle = () => { if (customPending.current) choose(input.value, true, false); };
    const anchor = anchorRef.current;
    input.addEventListener('change', commit);
    anchor?.addEventListener('mousedown', commitBeforeToggle, true);
    return () => { input.removeEventListener('change', commit); anchor?.removeEventListener('mousedown', commitBeforeToggle, true); };
  });
  const colors = kind === 'highlight' ? palette.colors.map(color => [highlightColorLabel(color), color]) : foregrounds;
  return <OverlayManager isOpen anchorRef={anchorRef} onClose={close} onEscape={onEscape} initialFocus='[aria-checked="true"]' placement="bottom-end" exclusiveGroup="documentation">
    <div role="menu" aria-label={`${label} color palette`} className="w-56 rounded-xl border border-panvas-border-strong bg-panvas-bg-primary p-2 text-xs text-panvas-text-primary shadow-xl"
      onKeyDownCapture={event => { if (event.key === 'Escape') customPending.current = false; }}
      onKeyDown={event => {
        if (event.target instanceof HTMLInputElement) return;
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + options.length) % options.length;
        event.preventDefault(); options[next]?.focus();
      }}>
      <div className="relative flex items-center justify-between px-1 pb-1.5 font-medium leading-4 text-panvas-text-secondary">
        <span>{label} color{mixed ? ' · Mixed' : ''}</span>
        {kind === 'highlight' && <button ref={optionsRef} type="button" aria-label="Highlight palette options" aria-haspopup="menu" aria-expanded={optionsOpen} onMouseDown={event => event.preventDefault()} onClick={() => setOptionsOpen(open => !open)} className="-my-1 flex h-4 w-5 items-center justify-center rounded hover:bg-panvas-bg-hover focus-ring"><MoreHorizontal size={14} /></button>}
      </div>
      {optionsOpen && <OverlayManager isOpen anchorRef={optionsRef} onClose={() => setOptionsOpen(false)} onEscape={() => { setOptionsOpen(false); optionsRef.current?.focus(); }} initialFocus='[role="menuitem"]' placement="bottom-end">
        <div role="menu" aria-label="Highlight palette options" className="rounded-lg border border-panvas-border-default bg-panvas-bg-primary p-1 shadow-lg">
          <button type="button" role="menuitem" onMouseDown={event => event.preventDefault()} onClick={() => {
            customPending.current = false;
            void useNotebookSettingsStore.getState().resetHighlightPalette().catch(reportSaveError); setOptionsOpen(false); optionsRef.current?.focus();
          }} className="rounded px-3 py-2 text-xs text-panvas-text-primary hover:bg-panvas-bg-hover focus-ring">Restore default colors</button>
        </div>
      </OverlayManager>}
      <button type="button" role="menuitemradio" aria-checked={noneSelected} onMouseDown={event => event.preventDefault()} onClick={() => choose(null)} className={`mb-1 flex min-h-9 w-full items-center gap-2 rounded-md px-2 focus-ring hover:bg-panvas-bg-hover ${noneSelected ? 'bg-panvas-bg-active' : ''}`}>
        <span className="flex h-5 w-5 items-center justify-center rounded border border-panvas-border-default"><Slash size={14} /></span>{kind === 'highlight' ? 'None' : 'Default'}
      </button>
      <div className="grid grid-cols-3 gap-1">
        {colors.map(([name, color]) => <button key={color} type="button" role="menuitemradio" data-color={color} aria-label={name} aria-checked={!mixed && !noneSelected && formattingColorValue(value, '') === color} onMouseDown={event => event.preventDefault()} onClick={() => choose(color)} className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 hover:bg-panvas-bg-hover focus-ring aria-checked:bg-panvas-bg-active">
          <span aria-hidden="true" className="h-5 w-7 rounded border border-panvas-border-default" style={{ backgroundColor: color }} />{name}
        </button>)}
      </div>
      <label className="mt-2 flex min-h-9 items-center justify-between gap-2 border-t border-panvas-border-subtle px-1 pt-2">Custom color<input ref={customRef} type="color" aria-label={`Custom ${label.toLowerCase()} color`} defaultValue={customColor} onInput={() => { customPending.current = true; }} className="h-7 w-9 cursor-pointer rounded border border-panvas-border-default p-0 focus-ring" /></label>
    </div>
  </OverlayManager>;
}
