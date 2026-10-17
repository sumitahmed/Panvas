import { Node, mergeAttributes, getRenderedAttributes, type JSONContent } from '@tiptap/core';
import { Details, DetailsSummary, DetailsContent } from '@tiptap/extension-details';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { isAssetId } from './notebookAssetImage';
import { Selection, TextSelection } from '@tiptap/pm/state';

export const NotebookCallout = Node.create({
  name: 'callout', group: 'block', content: 'block+', defining: true,
  addAttributes() {
    return {
      icon: { default: 'ℹ', parseHTML: element => element.getAttribute('data-icon') ?? 'ℹ', renderHTML: attrs => ({ 'data-icon': attrs.icon }) },
      tone: { default: 'note', parseHTML: element => element.getAttribute('data-tone') ?? 'note', renderHTML: attrs => ({ 'data-tone': attrs.tone }) },
    };
  },
  parseHTML() { return [{ tag: 'aside[data-type="callout"]', contentElement: '[data-callout-content]' }]; },
  renderHTML({ HTMLAttributes, node }) {
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-type': 'callout', class: 'panvas-document-callout' }),
      ['span', { 'aria-hidden': 'true', class: 'panvas-callout-icon' }, String(node.attrs.icon).slice(0, 64)],
      ['div', { 'data-callout-content': '' }, 0]];
  },
});

// Retain official schema/commands while using native details for active/static parity.
// The stock persist toggle overwrites all attrs with {open}; that would discard block IDs.
export const NotebookDetails = Details.extend({
  addKeyboardShortcuts() {
    const inherited = this.parent?.() ?? {};
    return {
      ...inherited,
      Backspace: () => {
        const { selection } = this.editor.state;
        if (selection instanceof TextSelection && selection.empty && selection.$from.parentOffset === 0) {
          const $pos = selection.$from;
          for (let depth = $pos.depth; depth > 0; depth--) {
            const node = $pos.node(depth);
            if (node.type !== this.type) continue;
            const empty = node.firstChild!.content.size === 0 && node.lastChild!.childCount === 1
              && node.lastChild!.firstChild!.type.name === 'paragraph' && node.lastChild!.firstChild!.content.size === 0;
            if (empty) return this.editor.commands.deleteDocumentationBlock(node.attrs.blockId);
            if ($pos.parent.type.name === 'detailsSummary'
              || (node.lastChild!.firstChild === $pos.parent && $pos.parent.content.size === 0)) {
              return this.editor.commands.turnDocumentationBlockInto('paragraph', { id: node.attrs.blockId });
            }
            break;
          }
        }
        return inherited.Backspace?.({ editor: this.editor }) ?? false;
      },
      'Mod-Enter': () => this.editor.commands.command(({ tr, dispatch }) => {
        const $pos = tr.selection.$from;
        for (let depth = $pos.depth; depth > 0; depth--) {
          const node = $pos.node(depth);
          if (node.type !== this.type) continue;
          const after = $pos.after(depth), $after = tr.doc.resolve(after);
          const paragraph = this.editor.schema.nodes.paragraph.create();
          if (!$after.parent.canReplaceWith($after.index(), $after.index(), paragraph.type)) return false;
          if (dispatch) {
            tr.insert(after, paragraph);
            tr.setSelection(Selection.near(tr.doc.resolve(after + 1))).scrollIntoView();
          }
          return true;
        }
        return false;
      }),
    };
  },
  addNodeView() {
    return ({ editor, getPos, node }) => {
      const dom = document.createElement('details');
      let attributes = new Set<string>();
      const apply = (current: ProseMirrorNode) => {
        const next = getRenderedAttributes(current, editor.extensionManager.attributes);
        for (const key of attributes) if (!(key in next)) dom.removeAttribute(key);
        for (const [key, value] of Object.entries(next)) if (value != null) dom.setAttribute(key, String(value));
        attributes = new Set(Object.keys(next));
        dom.open = Boolean(current.attrs.open);
      };
      apply(node);
      const toggle = () => {
        if (editor.isDestroyed || !editor.isInitialized || !dom.isConnected || !editor.isEditable) return;
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const current = editor.state.doc.nodeAt(pos);
        if (current?.type !== this.type || Boolean(current.attrs.open) === dom.open) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, open: dom.open }));
      };
      dom.addEventListener('toggle', toggle);
      return {
        dom, contentDOM: dom,
        update: current => { if (current.type !== this.type) return false; apply(current); return true; },
        ignoreMutation: mutation => mutation.type === 'attributes' && mutation.target === dom,
        destroy: () => dom.removeEventListener('toggle', toggle),
      };
    };
  },
}).configure({ persist: true });

export const NotebookDetailsSummary = DetailsSummary.extend({
  content: 'inline*',
  addAttributes() {
    return { headingLevel: {
      default: 0,
      parseHTML: element => Number(element.getAttribute('data-heading-level')) || 0,
      renderHTML: attrs => attrs.headingLevel ? { 'data-heading-level': attrs.headingLevel } : {},
    } };
  },
  renderHTML({ HTMLAttributes, node }) {
    const attributes = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes);
    // Keep the summary's native disclosure semantics; the title carries the heading role.
    return node.attrs.headingLevel >= 1 && node.attrs.headingLevel <= 6
      ? ['summary', attributes, ['span', { role: 'heading', 'aria-level': node.attrs.headingLevel }, 0]]
      : ['summary', attributes, 0];
  },
});
export const NotebookDetailsContent = DetailsContent.extend({ addNodeView() { return null; } });

export interface DocumentationReference { targetPageId?: string | null; targetBlockId?: string | null; label?: string }

export function dispatchDocumentationReference(reference: DocumentationReference): boolean {
  if (reference.targetPageId && !isAssetId(reference.targetPageId)) return false;
  if (reference.targetBlockId && !isAssetId(reference.targetBlockId)) return false;
  if (!reference.targetPageId && !reference.targetBlockId) return false;
  document.dispatchEvent(new CustomEvent('panvas:document-reference', { detail: reference }));
  return true;
}

export const NotebookPageReference = Node.create({
  name: 'pageReference', group: 'inline', inline: true, atom: true,
  addAttributes() {
    return {
      targetPageId: { default: null, parseHTML: element => element.getAttribute('data-target-page-id'), renderHTML: attrs => attrs.targetPageId ? { 'data-target-page-id': attrs.targetPageId } : {} },
      targetBlockId: { default: null, parseHTML: element => element.getAttribute('data-target-block-id'), renderHTML: attrs => attrs.targetBlockId ? { 'data-target-block-id': attrs.targetBlockId } : {} },
      label: { default: 'Page reference', parseHTML: element => element.getAttribute('data-label') ?? element.textContent, renderHTML: attrs => ({ 'data-label': attrs.label }) },
    };
  },
  parseHTML() { return [{ tag: 'span[data-type="page-reference"]' }]; },
  renderHTML({ HTMLAttributes, node }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'page-reference', role: 'link', tabindex: 0, class: 'panvas-document-reference' }), String(node.attrs.label)];
  },
  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const dom = document.createElement('span');
      for (const [key, value] of Object.entries(HTMLAttributes)) if (value != null) dom.setAttribute(key, String(value));
      dom.dataset.type = 'page-reference';
      dom.className = 'panvas-document-reference';
      dom.setAttribute('role', 'link'); dom.tabIndex = 0;
      dom.textContent = String(node.attrs.label);
      const follow = (event: Event) => { event.preventDefault(); dispatchDocumentationReference(node.attrs); };
      const key = (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') follow(event); };
      dom.addEventListener('click', follow); dom.addEventListener('keydown', key);
      return { dom, stopEvent: event => event.type === 'click' || event.type === 'keydown',
        destroy: () => { dom.removeEventListener('click', follow); dom.removeEventListener('keydown', key); } };
    };
  },
});

export interface DocumentationHeading { blockId: string; title: string; level: number }

export function documentationHeadings(doc: JSONContent | ProseMirrorNode): DocumentationHeading[] {
  const headings: DocumentationHeading[] = [];
  const atomText = (attrs?: Record<string, unknown>): string => {
    const value = attrs?.latex ?? attrs?.label ?? attrs?.alt;
    return typeof value === 'string' ? value : '';
  };
  const add = (node: { type?: string; attrs?: Record<string, unknown> }, title: string, parentId?: unknown) => {
    const level = Number(node.type === 'detailsSummary' ? node.attrs?.headingLevel : node.attrs?.level);
    const id = node.type === 'detailsSummary' ? parentId ?? node.attrs?.blockId : node.attrs?.blockId;
    if (['heading', 'detailsSummary'].includes(node.type ?? '') && level >= 1 && level <= 6 && isAssetId(id) && title.trim()) {
      headings.push({ blockId: id, title: title.trim(), level });
    }
  };
  if ('descendants' in doc) {
    (doc as ProseMirrorNode).descendants((node, _pos, parent) => add({ type: node.type.name, attrs: node.attrs },
      node.textBetween(0, node.content.size, '', leaf => atomText(leaf.attrs)), parent?.attrs.blockId));
  } else {
    const text = (node: JSONContent): string => node.text ?? (node.content?.map(text).join('') || atomText(node.attrs));
    const walk = (node: JSONContent, parentId?: unknown) => {
      add(node, text(node), parentId);
      node.content?.forEach(child => walk(child, node.attrs?.blockId));
    };
    walk(doc);
  }
  return headings;
}

export function renderTableOfContents(root: HTMLElement, headings: DocumentationHeading[]): void {
  root.replaceChildren();
  const list = document.createElement('ol');
  for (const heading of headings) {
    const item = document.createElement('li');
    item.dataset.headingLevel = String(heading.level);
    const link = document.createElement('a');
    link.href = '#' + heading.blockId;
    link.textContent = heading.title;
    link.addEventListener('click', event => { event.preventDefault(); dispatchDocumentationReference({ targetBlockId: heading.blockId }); });
    item.appendChild(link); list.appendChild(item);
  }
  root.appendChild(list);
}

export const NotebookTableOfContents = Node.create({
  name: 'tableOfContents', group: 'block', atom: true,
  parseHTML() { return [{ tag: 'nav[data-type="table-of-contents"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['nav', mergeAttributes(HTMLAttributes, { 'data-type': 'table-of-contents', 'aria-label': 'Table of contents' })]; },
  addNodeView() {
    return ({ editor, HTMLAttributes }) => {
      const dom = document.createElement('nav');
      for (const [key, value] of Object.entries(HTMLAttributes)) if (value != null) dom.setAttribute(key, String(value));
      dom.dataset.type = 'table-of-contents';
      dom.setAttribute('aria-label', 'Table of contents');
      const render = () => renderTableOfContents(dom, documentationHeadings(editor.state.doc));
      render(); editor.on('update', render);
      return { dom, ignoreMutation: () => true, stopEvent: event => event.type === 'click',
        destroy: () => editor.off('update', render) };
    };
  },
});
