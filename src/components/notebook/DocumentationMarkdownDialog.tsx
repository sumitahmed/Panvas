import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import type { SelectionBookmark, Transaction } from '@tiptap/pm/state';
import { useWorkspaceStore } from '@/stores/workspaceStore';

export function requestDocumentationMarkdown(editor: Editor | null): void {
  if (editor && !editor.isDestroyed && editor.isEditable && editor.view.dom.isConnected) document.dispatchEvent(new CustomEvent('panvas:paste-document-markdown', { detail: { editor } }));
}

/** Dedicated paste interaction; the source field never lives in the Aa menu. */
export function DocumentationMarkdownDialog() {
  const [session, setSession] = useState<{ editor: Editor; bookmark: SelectionBookmark } | null>(null);
  const [source, setSource] = useState(''), [message, setMessage] = useState('');
  const dialog = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const pageId = useWorkspaceStore(state => state.activePageId);
  useEffect(() => setSession(null), [pageId]);
  useEffect(() => {
    const show = (event: Event) => {
      const editor = (event as CustomEvent<{ editor: Editor }>).detail?.editor;
      if (!editor || editor.isDestroyed || !editor.isEditable || !editor.view.dom.isConnected) return;
      setSession({ editor, bookmark: editor.state.selection.getBookmark() }); setSource(''); setMessage('');
    };
    document.addEventListener('panvas:paste-document-markdown', show);
    return () => document.removeEventListener('panvas:paste-document-markdown', show);
  }, []);
  useEffect(() => {
    if (!session) return;
    input.current?.focus();
    const close = () => setSession(null), map = ({ transaction }: { transaction: Transaction }) => { session.bookmark = session.bookmark.map(transaction.mapping); };
    session.editor.on('destroy', close); session.editor.on('transaction', map);
    return () => { session.editor.off('destroy', close); session.editor.off('transaction', map); };
  }, [session]);
  if (!session) return null;
  const { editor } = session, owner = editor.view.dom.closest<HTMLElement>('[data-document-body],[data-text-object-id]');
  const close = () => { setSession(null); if (!editor.isDestroyed && editor.view.dom.isConnected) editor.view.focus(); };
  const insert = () => {
    if (editor.isDestroyed || !editor.isEditable || !editor.view.dom.isConnected) { setMessage('This editor is no longer editable.'); return; }
    editor.view.dispatch(editor.state.tr.setSelection(session.bookmark.resolve(editor.state.doc)));
    if (editor.chain().focus().pasteDocumentationMarkdown(source).run()) close();
    else setMessage('Could not insert Markdown at this selection.');
  };
  const button = 'min-h-9 rounded-md px-3 text-xs font-medium focus-ring';
  return createPortal(<div className="panvas-layer-modal fixed inset-0 flex items-center justify-center bg-black/30 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="Paste Markdown" data-document-editor={owner?.dataset.documentBody ?? owner?.dataset.textObjectId} className="panvas-dialog w-full max-w-lg p-4 text-panvas-text-primary" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'Tab') {
        const controls = dialog.current?.querySelectorAll<HTMLElement>('textarea,button:not(:disabled)');
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <h2 className="text-sm font-semibold">Paste Markdown</h2><p className="mt-1 text-xs text-panvas-text-secondary">Insert formatted Markdown at the current selection.</p>
      <label className="mt-4 block text-xs text-panvas-text-secondary">Markdown source<textarea ref={input} aria-label="Markdown source" rows={8} value={source} onChange={event => setSource(event.target.value)} className="mt-2 max-h-[45dvh] min-h-32 w-full resize-y rounded-md border border-panvas-border-default bg-panvas-bg-secondary p-3 font-mono text-xs leading-relaxed text-panvas-text-primary focus-ring" /></label>
      {message && <p role="status" className="mt-2 text-xs">{message}</p>}
      <div className="mt-3 flex justify-end gap-2"><button type="button" className={`${button} text-panvas-text-secondary hover:bg-panvas-bg-hover`} onClick={close}>Cancel</button><button type="button" disabled={!source.trim()} className={`${button} bg-panvas-text-primary text-panvas-bg-primary hover:opacity-90 disabled:opacity-40`} onClick={insert}>Insert Markdown</button></div>
    </div>
  </div>, document.body);
}
