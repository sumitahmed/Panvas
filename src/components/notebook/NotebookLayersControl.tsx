import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff, Layers3, Lock, LockOpen, Plus, Trash2 } from 'lucide-react';
import type { NotebookEngine } from './engine/NotebookEngine';
import { OverlayManager } from '@/components/ui/OverlayManager';

export function NotebookLayersControl({ engine, onChange }: { engine: NotebookEngine; onChange?: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [, setRevision] = useState(0);
  const controlRef = useRef<HTMLDivElement>(null);


  useEffect(() => engine.layers.subscribe(() => setRevision(value => value + 1)), [engine]);

  const layers = engine.layers.getLayers();
  const activeLayerId = engine.layers.getActiveLayerId();
  const change = (operation: () => unknown) => {
    operation();
    onChange?.();
  };

  return (
    <div ref={controlRef} className="relative pointer-events-auto">
      <button
        type="button"
        onClick={() => setIsOpen(value => !value)}
        className="panvas-icon-control focus-ring"
        title="Layers"
        aria-label="Layers"
        aria-expanded={isOpen}
      >
        <Layers3 size={16} />
      </button>

      <OverlayManager isOpen={isOpen} onClose={() => setIsOpen(false)} anchorRef={controlRef} placement="bottom-start">
        <div role="dialog" aria-label="Layers" className="panvas-utility-panel panvas-floating-surface w-72 p-2">
          <div className="mb-2 flex items-center justify-between px-1">
            <div>
              <div className="text-xs font-semibold text-panvas-text-primary">Layers</div>
              <div className="text-2xs text-panvas-text-tertiary">Top row renders above lower rows</div>
            </div>
            <button type="button" className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-panvas-text-secondary hover:bg-panvas-bg-hover" onClick={() => change(() => engine.layers.create())}>
              <Plus size={13} /> Add
            </button>
          </div>

          <div className="space-y-1">
            {[...layers].reverse().map((layer, reverseIndex) => {
              const originalIndex = layers.length - reverseIndex - 1;
              const active = layer.id === activeLayerId;
              return (
                <div key={layer.id} className={`flex items-center gap-1 rounded-lg border px-1.5 py-1 ${active ? 'border-panvas-accent bg-panvas-bg-active' : 'border-transparent hover:bg-panvas-bg-hover'}`}>
                  <button type="button" title={layer.visible ? 'Hide layer' : 'Show layer'} aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`} className="p-1 text-panvas-text-secondary" onClick={() => change(() => engine.layers.setVisible(layer.id, !layer.visible))}>
                    {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                  <button type="button" title={layer.locked ? 'Unlock layer' : 'Lock layer'} aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`} className="p-1 text-panvas-text-secondary" onClick={() => change(() => engine.layers.setLocked(layer.id, !layer.locked))}>
                    {layer.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                  </button>
                  <input
                    aria-label={`Layer name ${layer.name}`}
                    value={layer.name}
                    onFocus={() => { if (layer.visible && !layer.locked) change(() => engine.layers.setActive(layer.id)); }}
                    onChange={event => change(() => engine.layers.rename(layer.id, event.target.value))}
                    className="min-w-0 flex-1 bg-transparent px-1 text-xs text-panvas-text-primary outline-none"
                  />
                  {active && <span className="rounded px-1 text-2xs font-semibold text-panvas-accent-blue">Active</span>}
                  {!active && layer.visible && !layer.locked && (
                    <button type="button" className="rounded px-1 text-2xs text-panvas-text-tertiary hover:text-panvas-text-primary" onClick={() => change(() => engine.layers.setActive(layer.id))}>Activate</button>
                  )}
                  <button type="button" disabled={originalIndex === layers.length - 1} title="Move layer up" className="p-1 text-panvas-text-tertiary disabled:opacity-25" onClick={() => change(() => engine.layers.move(layer.id, 1))}><ChevronUp size={13} /></button>
                  <button type="button" disabled={originalIndex === 0} title="Move layer down" className="p-1 text-panvas-text-tertiary disabled:opacity-25" onClick={() => change(() => engine.layers.move(layer.id, -1))}><ChevronDown size={13} /></button>
                  <button type="button" disabled={layers.length <= 1} title="Delete layer and move its objects" className="p-1 text-panvas-text-tertiary hover:text-panvas-text-error disabled:opacity-25" onClick={() => change(() => engine.removeLayer(layer.id))}><Trash2 size={13} /></button>
                </div>
              );
            })}
          </div>
        </div>
      </OverlayManager>
    </div>
  );
}
