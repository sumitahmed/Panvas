import type { NotebookEngine } from './engine/NotebookEngine';
import type { NotebookPage } from '../../types/notebook';
import { isAssetId } from './notebookAssetImage';
import type { DocumentationReference } from './notebookDocumentationNodes';

/** Navigation uses existing page ownership; no document/page-layout authority is added. */
export function installNotebookReferenceNavigation(
  engine: NotebookEngine,
  getPages: () => NotebookPage[],
  setPage: (id: string) => Promise<void>,
): () => void {
  let frame = 0, generation = 0;
  const report = (message: string) => document.dispatchEvent(new CustomEvent('panvas:document-command-error', { detail: { message } }));
  const follow = async (reference: DocumentationReference) => {
    const request = ++generation;
    cancelAnimationFrame(frame);
    const pageId = reference.targetPageId ?? engine.getDrawingOwnership().pageId;
    if (!isAssetId(pageId) || (reference.targetBlockId && !isAssetId(reference.targetBlockId))) return;
    if (!getPages().some(page => page.id === pageId && !page.deletedAt)) { report('The referenced page is unavailable.'); return; }
    try {
      if (engine.getDrawingOwnership().pageId !== pageId) await setPage(pageId);
    } catch { report('Could not open the referenced page.'); return; }
    if (!reference.targetBlockId || request !== generation) return;
    let attempts = 0;
    const focus = () => {
      if (request !== generation) return;
      if (engine.getDrawingOwnership().pageId === pageId) for (const object of engine.texts.getTexts()) {
        const editor = engine.texts.getEditor(object.id);
        if (!editor || !editor.view.dom.isConnected || !editor.can().focusDocumentationBlock(reference.targetBlockId!)) continue;
        engine.tools.setMode('text');
        editor.commands.focus(undefined, { scrollIntoView: false });
        editor.commands.focusDocumentationBlock(reference.targetBlockId!);
        return;
      }
      if (++attempts < 120) frame = requestAnimationFrame(focus);
      else report('The referenced block is unavailable.');
    };
    focus();
  };
  const listener = (event: Event) => { void follow((event as CustomEvent<DocumentationReference>).detail ?? {}); };
  document.addEventListener('panvas:document-reference', listener);
  const url = new URL(window.location.href);
  const page = url.searchParams.get('panvasPage'), block = url.searchParams.get('panvasBlock');
  if (page) void follow({ targetPageId: page, targetBlockId: block });
  return () => { generation++; cancelAnimationFrame(frame); document.removeEventListener('panvas:document-reference', listener); };
}
