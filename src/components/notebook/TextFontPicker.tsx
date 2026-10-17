import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { OverlayManager } from '@/components/ui/OverlayManager';
import {
  PANVAS_TEXT_FONT_FAMILIES,
  TEXT_FONT_GROUPS,
  UI_FONT_FAMILY,
  fontLabel,
  fontOptionStyle,
  loadTextFont,
  type FontAvailability,
} from './textFonts';

export function TextFontPicker({ value, onChange, ariaLabel = 'Text font', className = '', presentation = 'popover', open: controlledOpen, onOpenChange }: {
  value: string;
  onChange: (font: string) => void;
  ariaLabel?: string;
  className?: string;
  presentation?: 'popover' | 'inline';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (value: boolean | ((previous: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(open) : value;
    setLocalOpen(next); onOpenChange?.(next);
  };
  const [availability, setAvailability] = useState<Record<string, FontAvailability>>(() =>
    Object.fromEntries(PANVAS_TEXT_FONT_FAMILIES.map(font => [font, 'loading'])),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = value || 'Inter, sans-serif';

  useEffect(() => {
    let active = true;
    // Opening typography must not download the entire preview catalog or
    // invalidate document pagination for fonts the author has not requested.
    (open ? PANVAS_TEXT_FONT_FAMILIES : [current]).forEach(font => {
      void loadTextFont(font).then(state => { if (active) setAvailability(previous => previous[font] === state ? previous : { ...previous, [font]: state }); });
    });
    return () => { active = false; };
  }, [open, current]);

  // Keep the catalog stable while faces load. Filtering failed faces reduced
  // an offline/error state to a misleading three-font list.
  const visibleFonts = useMemo(() => [...PANVAS_TEXT_FONT_FAMILIES], []);
  const focusOption = (index: number) => optionRefs.current[Math.max(0, Math.min(visibleFonts.length - 1, index))]?.focus();
  const openAndFocus = (direction: 1 | -1) => {
    setOpen(true);
    requestAnimationFrame(() => focusOption(direction > 0 ? 0 : visibleFonts.length - 1));
  };
  const currentAvailability = availability[current] ?? 'unavailable';

  const catalog = <div ref={listRef} role="listbox" aria-label={ariaLabel} onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} className={`${presentation === 'inline' ? 'mt-1 max-h-44 w-full' : 'max-h-72 w-[236px] rounded-lg border border-panvas-border-strong shadow-xl'} overflow-y-auto overscroll-contain bg-panvas-bg-primary p-1.5`} style={{ maxHeight: presentation === 'inline' ? '11rem' : 'min(18rem, var(--panvas-overlay-max-height, 18rem))', fontFamily: UI_FONT_FAMILY }}>
      {TEXT_FONT_GROUPS.map(group => {
        const fonts = group.fonts.filter(font => visibleFonts.includes(font));
        if (fonts.length === 0) return null;
        return <div key={group.label} className="mb-1 last:mb-0">
          <div className="px-2 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-panvas-text-tertiary" style={{ fontFamily: group.fontFamily }}>{group.label}</div>
          {fonts.map(font => {
            const flatIndex = visibleFonts.indexOf(font), selected = current === font, state = availability[font] ?? 'unavailable';
            return <button ref={node => { optionRefs.current[flatIndex] = node; }} key={font} type="button" role="option" aria-selected={selected} aria-disabled={state !== 'loaded'}
              onMouseDown={event => event.preventDefault()} onClick={() => { if (state === 'loaded') { onChange(font === 'Inter, sans-serif' ? '' : font); setOpen(false); } }}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusOption(flatIndex + (event.key === 'ArrowDown' ? 1 : -1)); }
                else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); focusOption(event.key === 'Home' ? 0 : visibleFonts.length - 1); }
                else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); rootRef.current?.querySelector('button')?.focus(); }
              }}
              className={`flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left focus-ring ${selected ? 'bg-panvas-accent-blue/10 text-panvas-accent-blue' : 'text-panvas-text-primary hover:bg-panvas-bg-hover'} ${state !== 'loaded' ? state === 'loading' ? 'cursor-wait opacity-60' : 'cursor-not-allowed opacity-60' : ''}`} style={{ fontFamily: UI_FONT_FAMILY }}>
              <span className="w-4 shrink-0">{selected && <Check size={13} />}</span><span className="truncate text-[15px] leading-5" style={fontOptionStyle(font, state)}>{fontLabel(font)}</span>
              {state !== 'loaded' && <span className="ml-auto text-[9px] text-panvas-text-tertiary">{state === 'loading' ? 'Loading' : 'Unavailable'}</span>}
            </button>;
          })}
        </div>;
      })}
    </div>;

  return <div ref={rootRef} className={`relative min-w-0 flex-1 ${className}`} style={{ fontFamily: UI_FONT_FAMILY }} data-notebook-navigation-ignore="true">
    <button
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={ariaLabel}
      onMouseDown={event => event.preventDefault()}
      onClick={() => setOpen(previous => !previous)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          openAndFocus(event.key === 'ArrowDown' ? 1 : -1);
        }
      }}
      className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-panvas-border-default bg-panvas-bg-primary px-2.5 text-left text-xs text-panvas-text-primary hover:bg-panvas-bg-hover focus-ring"
      style={{ fontFamily: UI_FONT_FAMILY }}
    >
      <span className="min-w-0 truncate">
        <span style={fontOptionStyle(current, currentAvailability)}>{fontLabel(current)}</span>
        {currentAvailability !== 'loaded' && <span className="ml-1 text-[9px] text-panvas-text-tertiary">{currentAvailability === 'loading' ? 'loading' : 'unavailable'}</span>}
      </span>
      <ChevronDown size={13} className={`shrink-0 text-panvas-text-tertiary ${open ? 'rotate-180' : ''}`} />
    </button>
    {presentation === 'inline' && open && catalog}
    {presentation === 'popover' && <OverlayManager isOpen={open} onClose={() => setOpen(false)} anchorRef={rootRef} placement="bottom-start" offset={{ x: 0, y: 6 }}>
      {catalog}
    </OverlayManager>}
  </div>;
}
