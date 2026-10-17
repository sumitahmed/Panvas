import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import type { SelectionBookmark, Transaction } from '@tiptap/pm/state';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { getSafeNotebookLink, copyNotebookText } from './notebookClipboard';
import { isAssetId } from './notebookAssetImage';
import { openDocumentationLink } from './notebookLinkEditing';

/** A single link surface for the toolbar, right click, and the editor's Ctrl+K. */
export function DocumentationLinkDialog() {
  const [session, setSession] = useState<{ editor: Editor; bookmark: SelectionBookmark } | null>(null);
  const [href, setHref] = useState(''), [message, setMessage] = useState('');
  const [pageId, setPageId] = useState(''), [blockId, setBlockId] = useState('');
  const dialog = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const pages = useWorkspaceStore(state => state.notebookPages);
  const activePageId = useWorkspaceStore(state => state.activePageId);
  useEffect(() => setSession(null), [activePageId]);
  useEffect(() => {
    const show = (event: Event) => {
      const editor = (event as CustomEvent<{ editor: Editor }>).detail?.editor;
      if (!editor || editor.isDestroyed || !editor.isEditable) return;
      setSession({ editor, bookmark: editor.state.selection.getBookmark() });
      setHref(editor.getAttributes('link').href ?? ''); setPageId(''); setBlockId(''); setMessage('');
    };
    document.addEventListener('panvas:edit-document-link', show);
    return () => document.removeEventListener('panvas:edit-document-link', show);
  }, []);
  useEffect(() => {
    if (!session) return;
    input.current?.focus(); input.current?.select();
    const close = () => setSession(null);
    const map = ({ transaction }: { transaction: Transaction }) => {
      session.bookmark = session.bookmark.map(transaction.mapping);
    };
    session.editor.on('destroy', close); session.editor.on('transaction', map);
    return () => { session.editor.off('destroy', close); session.editor.off('transaction', map); };
  }, [session]);
  if (!session) return null;
  const { editor } = session;
  const close = () => { setSession(null); if (!editor.isDestroyed) editor.commands.focus(); };
  const restore = () => {
    if (editor.isDestroyed || !editor.isEditable || !editor.view.dom.isConnected) return false;
    editor.view.dispatch(editor.state.tr.setSelection(session.bookmark.resolve(editor.state.doc)));
    return true;
  };
  const save = () => {
    const safe = getSafeNotebookLink(href);
    if (!safe) { setMessage('Enter an http or https URL, or choose a Panvas page.'); return; }
    if (!restore()) { setMessage('This editor is no longer editable.'); return; }
    if (editor.state.selection.empty && !editor.isActive('link')) { setMessage('Select the text to link first.'); return; }
    if (!editor.can().setLink({ href: safe })) { setMessage('Links are unavailable for this selection.'); input.current?.focus(); return; }
    if (!editor.chain().focus().extendMarkRange('link').setLink({ href: safe }).run()) { setMessage('Links are unavailable for this selection.'); return; }
    close();
  };
  const internal = (page: string, block: string) => {
    setPageId(page); setBlockId(block);
    if (!isAssetId(page) || block && !isAssetId(block)) return;
    const url = new URL(window.location.href); url.searchParams.set('panvasPage', page);
    if (block) url.searchParams.set('panvasBlock', block); else url.searchParams.delete('panvasBlock');
    setHref(url.href);
  };
  const control = 'rounded border border-panvas-border-default bg-panvas-bg-secondary px-2 py-1.5 text-sm focus-ring';
  return createPortal(<div className="panvas-overlay fixed inset-0 flex items-center justify-center bg-black/30 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="Edit link" data-document-editor={!editor.isDestroyed ? editor.view.dom.closest<HTMLElement>('[data-document-body]')?.dataset.documentBody : undefined} className="w-full max-w-md rounded-lg border border-panvas-border-default bg-panvas-bg-elevated p-4 text-panvas-text-primary shadow-2xl" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopPropagation(); input.current?.focus(); }
      if (event.key === 'Tab') {
        const controls = dialog.current?.querySelectorAll<HTMLElement>('input,select,button');
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="mb-3 text-sm font-semibold">Edit link</div>
      <form onSubmit={event => { event.preventDefault(); save(); }}>
        <label className="block text-xs">URL<input ref={input} aria-label="Link URL" className={`${control} mt-1 w-full`} value={href} onChange={event => setHref(event.target.value)} /></label>
        <details className="mt-3 text-xs"><summary className="cursor-pointer">Link to a Panvas page or block</summary>
          <select aria-label="Link target page" className={`${control} mt-2 w-full`} value={pageId} onChange={event => internal(event.target.value, blockId)}>
            <option value="">Choose a page…</option>{pages.filter(page => !page.deletedAt).map(page => <option key={page.id} value={page.id}>{page.title}</option>)}
          </select>
          <input aria-label="Link target block ID" placeholder="Optional block ID from Copy link to block" className={`${control} mt-2 w-full`} value={blockId} onChange={event => internal(pageId, event.target.value)} />
        </details>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className={control} type="submit">Save link</button>
          <button className={control} type="button" onClick={() => { if (restore()) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); close(); } }}>Remove link</button>
          <button className={control} type="button" onClick={() => { if (!openDocumentationLink(href)) setMessage('Enter a valid link first.'); }}>Open link</button>
          <button className={control} type="button" onClick={async () => { const safe = getSafeNotebookLink(href); if (!safe) return; try { await copyNotebookText(safe); setMessage('Link copied.'); } catch { setMessage('Could not copy the link.'); } }}>Copy link</button>
          <button className={control} type="button" onClick={close}>Cancel</button>
        </div>
      </form>
      {message && <p className="mt-3 text-xs" role="status">{message}</p>}
    </div>
  </div>, document.body);
}
