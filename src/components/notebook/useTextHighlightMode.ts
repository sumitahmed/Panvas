import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import type { NotebookEngine } from './engine/NotebookEngine';
import { runFormattingCommand } from './textFormatting';
import { useNotebookSettingsStore } from '@/stores/notebookSettingsStore';

interface HighlightMode { armed: boolean; color: string | null }
interface HighlightGesture {
  editor: Editor; id: string; pageId: string | null; doc: ProseMirrorNode;
  pointerId: number; x: number; y: number; moved: boolean;
}

/** Text selection gestures only; the canvas ink highlighter has its own tool state. */
export function useTextHighlightMode(engine: NotebookEngine, enabled: boolean) {
  const preferredColor = useNotebookSettingsStore(state => state.highlightPalette.selectedColor);
  const [mode, setMode] = useState<HighlightMode>({ armed: false, color: preferredColor });
  const current = useRef(mode);
  const cancelGesture = useRef(() => {});
  const disarm = useCallback(() => {
    cancelGesture.current();
    if (!current.current.armed) return;
    current.current = { ...current.current, armed: false };
    setMode(current.current);
  }, []);
  const arm = useCallback((color: string | null) => {
    cancelGesture.current();
    current.current = { armed: true, color };
    setMode(current.current);
  }, []);

  useEffect(() => {
    if (current.current.armed || current.current.color === preferredColor) return;
    current.current = { ...current.current, color: preferredColor };
    setMode(current.current);
  }, [preferredColor]);

  useEffect(() => {
    if (!enabled) { disarm(); return; }
    let gesture: HighlightGesture | null = null;
    let frame = 0;
    const cancel = () => { gesture = null; cancelAnimationFrame(frame); frame = 0; };
    cancelGesture.current = cancel;
    const isCurrent = (g: HighlightGesture) => current.current.armed && engine.tools.getState().mode === 'text'
      && engine.getDrawingOwnership().pageId === g.pageId && engine.texts.getEditor(g.id) === g.editor
      && !g.editor.isDestroyed && g.editor.isInitialized && g.editor.isEditable
      && g.editor.view.dom.isConnected && g.editor.state.doc === g.doc;
    const down = (event: PointerEvent) => {
      cancel();
      if (!current.current.armed || event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
      if (event.target.closest('[contenteditable="false"],button,input,select,textarea')) return;
      const owner = event.target.closest<HTMLElement>('[data-text-object-id],[data-document-body]');
      const id = owner?.dataset.textObjectId ?? owner?.dataset.documentBody;
      const editor: Editor | undefined = id ? engine.texts.getEditor(id) : undefined;
      if (!editor || editor.isDestroyed || !editor.isInitialized || !editor.isEditable || !editor.view.dom.contains(event.target)) return;
      const candidate = { editor, id: id!, pageId: engine.getDrawingOwnership().pageId, doc: editor.state.doc,
        pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      if (isCurrent(candidate)) gesture = candidate;
    };
    const move = (event: PointerEvent) => {
      if (gesture?.pointerId === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 3) gesture.moved = true;
    };
    const up = (event: PointerEvent) => {
      const completed = gesture;
      if (!completed || completed.pointerId !== event.pointerId) return;
      gesture = null;
      if (!completed.moved) return;
      // Let native mouseup/ProseMirror selection handling finish. No command or
      // React update runs on pointer movement. Read the final native range once.
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!isCurrent(completed) || !completed.editor.isFocused) return;
        const { editor } = completed, native = editor.view.dom.ownerDocument.getSelection();
        if (!native || native.isCollapsed || !native.anchorNode || !native.focusNode
          || !editor.view.dom.contains(native.anchorNode) || !editor.view.dom.contains(native.focusNode)) return;
        const selection = TextSelection.create(editor.state.doc,
          editor.view.posAtDOM(native.anchorNode, native.anchorOffset),
          editor.view.posAtDOM(native.focusNode, native.focusOffset));
        if (selection.empty || !(editor.state.selection instanceof TextSelection)) return;
        const color = current.current.color;
        runFormattingCommand(editor, null, chain => {
          const command = chain.command(({ tr }: { tr: import('@tiptap/pm/state').Transaction }) => {
            if (!tr.selection.eq(selection)) tr.setSelection(selection);
            closeHistory(tr); // Repeated adjacent gestures must undo separately.
            return true;
          });
          return color === null ? command.unsetHighlight() : command.setHighlight({ color });
        });
      });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !current.current.armed) return;
      disarm();
      // Menus, dialogs and form controls retain their own Escape handling
      // (for example Edit link or cancelling a sidebar rename).
      if (event.target instanceof Element && event.target.closest('.panvas-overlay,[role="dialog"],[role="menu"],input,textarea,select')) return;
      event.preventDefault(); event.stopPropagation();
    };
    const unsubscribe = engine.tools.subscribe(state => { if (state.mode !== 'text') disarm(); });
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', cancel, true);
    document.addEventListener('dragstart', cancel, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape, true);
    return () => {
      cancel(); unsubscribe(); cancelGesture.current = () => {};
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', cancel, true);
      document.removeEventListener('dragstart', cancel, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape, true);
    };
  }, [engine, enabled, disarm]);

  return { ...mode, arm, disarm };
}
