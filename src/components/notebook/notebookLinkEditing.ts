import { Extension, type Editor } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { getSafeNotebookLink } from './notebookClipboard';
import { isAssetId } from './notebookAssetImage';
import { dispatchDocumentationReference } from './notebookDocumentationNodes';

export function requestDocumentationLink(editor: Editor | null): void {
  if (editor && !editor.isDestroyed && editor.isEditable && editor.view.dom.isConnected) document.dispatchEvent(new CustomEvent('panvas:edit-document-link', { detail: { editor } }));
}

export function openDocumentationLink(href: string): boolean {
  const safe = getSafeNotebookLink(href);
  if (!safe) return false;
  const url = new URL(safe), page = url.searchParams.get('panvasPage'), block = url.searchParams.get('panvasBlock');
  if (url.origin === window.location.origin && isAssetId(page) && (!block || isAssetId(block))) {
    dispatchDocumentationReference({ targetPageId: page, targetBlockId: block });
  } else window.open(safe, '_blank', 'noopener,noreferrer');
  return true;
}

export const NotebookLinkEditing = Extension.create({
  name: 'notebookLinkEditing',
  priority: 1100,
  addKeyboardShortcuts() {
    return { 'Mod-k': () => { if (!this.editor.isEditable) return false; requestDocumentationLink(this.editor); return true; } };
  },
  addProseMirrorPlugins() {
    return [new Plugin({ props: { handleClick: (_view, _pos, event) => {
      const href = (event.target as Element)?.closest('a')?.getAttribute('href');
      const safe = getSafeNotebookLink(href);
      if (!safe) return false;
      const url = new URL(safe);
      if (url.origin !== window.location.origin || !isAssetId(url.searchParams.get('panvasPage'))) return false;
      event.preventDefault(); return openDocumentationLink(safe);
    } } })];
  },
});
