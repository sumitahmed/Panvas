import { ElementPreview } from './ElementPreview';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Heart, Plus, Shapes, Trash2, Upload } from 'lucide-react';
import type { NotebookEngine } from './engine/NotebookEngine';
import { filterLocalElements, getStarterElements, localElementRepository, type LocalElement, type LocalElementFilter } from '@/services/elements/LocalElementRepository';
import { useUIStore } from '@/stores/uiStore';
import { OverlayManager } from '@/components/ui/OverlayManager';

export function NotebookElementsControl({ engine, workspaceId, onInsert }: { engine: NotebookEngine; workspaceId?: string; onInsert?: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [elements, setElements] = useState<LocalElement[]>([]);
  const [category, setCategory] = useState<LocalElementFilter>('All');
  const fileRef = useRef<HTMLInputElement>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const showToast = useUIStore(state => state.showToast);


  useEffect(() => {
    if (!workspaceId || !isOpen) return;
    void localElementRepository.getAll(workspaceId).then(setElements).catch(() => showToast('Local Elements could not be loaded.', 'error'));
  }, [isOpen, showToast, workspaceId]);

  const allElements = useMemo(() => [...getStarterElements(), ...elements], [elements]);
  const categories: LocalElementFilter[] = ['All', 'Starter', 'My Elements'];
  const visible = useMemo(() => filterLocalElements(allElements, category), [allElements, category]);

  const capture = async () => {
    if (!workspaceId) return;
    try {
      let snapshot = engine.selection.getSelectedElementData();
      if (!snapshot || (snapshot.strokes.length === 0 && snapshot.shapes.length === 0 && snapshot.texts.length === 0 && snapshot.images.length === 0)) {
        const focusedText = engine.texts.getFocusedText();
        if (focusedText) {
          snapshot = {
            type: 'panvas/elements',
            strokes: [],
            shapes: [],
            texts: [structuredClone(focusedText)],
            images: [],
          };
        }
      }
      if (!snapshot) {
        throw new Error('Select an element on the canvas or focus a sticky note before saving.');
      }
      const created = await localElementRepository.create(workspaceId, snapshot, `Element ${elements.length + 1}`);
      setElements(await localElementRepository.getAll(workspaceId));
      setCategory('My Elements');
      showToast(`Saved ${created.name} for offline reuse.`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Element could not be saved.', 'error');
    }
  };

  const insert = (element: LocalElement) => {
    if (engine.selection.pasteElements(element.snapshot, engine.drawing.getInsertionPoint(), () => engine.input.notifyChange())) {
      engine.tools.setMode('select');
      onInsert?.();
      showToast(`Inserted ${element.name}.`, 'success');
      setIsOpen(false);
    } else showToast('Activate a visible, unlocked layer to insert this element.', 'error');
  };

  const exportCollection = async () => {
    if (!workspaceId) return;
    const collection = await localElementRepository.exportCollection(workspaceId);
    const url = URL.createObjectURL(new Blob([JSON.stringify(collection, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'panvas-elements.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const importCollection = async (file: File) => {
    if (!workspaceId) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Elements collection exceeds the 2 MB import limit.');
      const parsed = JSON.parse(await file.text());
      setElements(await localElementRepository.importCollection(workspaceId, parsed));
      showToast('Elements collection imported.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Elements import failed.', 'error');
    }
  };

  return (
    <div ref={controlRef} className="relative pointer-events-auto">
      <button type="button" onClick={() => setIsOpen(value => !value)} className="panvas-icon-control focus-ring" title="Local Elements" aria-label="Local Elements" aria-expanded={isOpen}>
        <Shapes size={16} />
      </button>
      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void importCollection(file); event.target.value = ''; }} />

      <OverlayManager isOpen={isOpen} onClose={() => setIsOpen(false)} anchorRef={controlRef} placement="bottom-start">
        <div role="dialog" aria-label="Local Elements" className="panvas-utility-panel panvas-floating-surface w-80 p-2">
          <div className="flex items-center justify-between px-1 pb-2">
            <div><div className="text-xs font-semibold text-panvas-text-primary">Local Elements</div><div className="text-2xs text-panvas-text-tertiary">Reusable object groups, stored with this workspace</div></div>
            <button type="button" onClick={capture} className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-panvas-text-secondary hover:bg-panvas-bg-hover"><Plus size={13} />Save selection</button>
          </div>
          <div className="mb-2 flex gap-1 overflow-x-auto px-1 pb-1">
            {categories.map(item => <button key={item} type="button" onClick={() => setCategory(item)} className={`whitespace-nowrap rounded-full px-2 py-1 text-2xs focus-ring ${category === item ? 'bg-panvas-accent-blue/15 text-panvas-accent-blue' : 'bg-panvas-bg-secondary text-panvas-text-secondary'}`}>{item}</button>)}
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {visible.length === 0 && <div className="panvas-empty-state p-5 text-center text-xs">Select one or more objects and choose &quot;Save selection&quot; to reuse them here.</div>}
            {visible.map(element => (
              <div key={element.id} className="flex items-center gap-1 rounded-lg border border-panvas-border-subtle bg-panvas-bg-primary p-1.5">
                <button type="button" onClick={() => insert(element)} className="flex h-14 w-[76px] shrink-0 items-center justify-center overflow-hidden rounded-md border border-panvas-border-subtle bg-panvas-bg-secondary text-panvas-text-secondary hover:border-panvas-accent-blue focus-ring" aria-label={`Insert ${element.name}`} title={`Insert ${element.name}`}><ElementPreview snapshot={element.snapshot} engine={engine} /></button>
                <div className="min-w-0 flex-1">
                  {element.builtin ? <><div className="truncate text-xs font-medium text-panvas-text-primary">{element.name}</div><div className="text-2xs text-panvas-text-tertiary">Starter</div></> : <>
                    <input defaultValue={element.name} aria-label={`Element name ${element.name}`} onBlur={event => void localElementRepository.update(workspaceId!, element.id, { name: event.target.value }).then(setElements)} className="w-full bg-transparent text-xs font-medium text-panvas-text-primary outline-none" />
                    <input defaultValue={element.category} aria-label={`Element category ${element.name}`} onBlur={event => void localElementRepository.update(workspaceId!, element.id, { category: event.target.value }).then(setElements)} className="w-full bg-transparent text-2xs text-panvas-text-tertiary outline-none" />
                  </>}
                </div>
                {!element.builtin && <><button type="button" title={element.favorite ? 'Remove favorite' : 'Favorite'} aria-label={`${element.favorite ? 'Remove favorite' : 'Favorite'} ${element.name}`} onClick={() => void localElementRepository.update(workspaceId!, element.id, { favorite: !element.favorite }).then(setElements)} className={element.favorite ? 'p-1 text-panvas-accent-rose' : 'p-1 text-panvas-text-tertiary'}><Heart size={13} fill={element.favorite ? 'currentColor' : 'none'} /></button>
                <button type="button" title={`Delete ${element.name}`} aria-label={`Delete ${element.name}`} onClick={() => void localElementRepository.remove(workspaceId!, element.id).then(setElements)} className="p-1 text-panvas-text-tertiary hover:text-panvas-text-error"><Trash2 size={13} /></button></>}
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-end gap-1 border-t border-panvas-border-subtle pt-2">
            <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-2xs text-panvas-text-secondary hover:bg-panvas-bg-hover"><Upload size={12} />Import</button>
            <button type="button" disabled={elements.length === 0} onClick={() => void exportCollection()} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-2xs text-panvas-text-secondary hover:bg-panvas-bg-hover disabled:opacity-40"><Download size={12} />Export</button>
          </div>
        </div>
      </OverlayManager>
    </div>
  );
}
