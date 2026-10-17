import { Extension, type JSONContent, type CommandProps } from '@tiptap/core';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, NodeSelection, AllSelection, Selection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { normalizeCodeLanguage, canCopyNotebookText, copyNotebookText } from './notebookClipboard';
import { isAssetId } from './notebookAssetImage';
import { dispatchDocumentationReference, type DocumentationReference } from './notebookDocumentationNodes';

export const documentationBlockTypes = [
  'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
  'codeBlock', 'horizontalRule', 'table', 'tableRow', 'tableCell', 'tableHeader',
  'callout', 'details', 'detailsSummary', 'detailsContent', 'blockMath', 'image', 'tableOfContents',
  'documentPageBreak',
];
export type DocumentationBlockType = 'paragraph' | 'heading' | 'codeBlock' | 'blockquote' | 'bulletList' | 'orderedList' | 'taskList' | 'callout' | 'details' | 'horizontalRule' | 'blockMath' | 'tableOfContents' | 'image';
export interface DocumentationBlockOptions {
  id?: string; level?: number; language?: string; icon?: string; tone?: string; latex?: string;
  fileId?: string; alt?: string; headingLevel?: number;
}

/** Shared by the existing slash menu and block transformation UI. */
export const documentationBlockConversions: { value: string; label: string; type: DocumentationBlockType; options?: DocumentationBlockOptions }[] = [
  { value: 'paragraph', label: 'Text', type: 'paragraph' },
  ...[1, 2, 3, 4, 5, 6].map(level => ({ value: `heading-${level}`, label: `Heading ${level}`, type: 'heading' as const, options: { level } })),
  ...Object.entries({ bulletList: 'Bulleted list', orderedList: 'Numbered list', taskList: 'Checklist', blockquote: 'Quote', codeBlock: 'Code', callout: 'Callout', details: 'Toggle list', blockMath: 'Block equation' })
    .map(([type, label]) => ({ value: type, label, type: type as DocumentationBlockType })),
  ...[1, 2, 3, 4, 5, 6].map(headingLevel => ({ value: `toggle-heading-${headingLevel}`, label: `Toggle heading ${headingLevel}`, type: 'details' as const, options: { headingLevel } })),
];

function freshId(): string { return crypto.randomUUID(); }
export function safeDocumentColor(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return null;
  const style = document.createElement('span').style;
  style.color = value;
  return style.color ? value : null;
}

export function documentationBlockAt(props: Pick<CommandProps, 'tr'>, id?: string): { node: ProseMirrorNode; pos: number } | null {
  const normalize = (target: { node: ProseMirrorNode; pos: number }) => {
    // Code, equations, images and explicitly selected containers retain their
    // own identity, including when they live inside another container.
    if (!['paragraph', 'heading', 'detailsSummary', 'detailsContent'].includes(target.node.type.name)) return target;
    // Summaries and content are required parts of a toggle, never independent
    // blocks. A cursor/right click in its body addresses the nearest toggle.
    const $pos = props.tr.doc.resolve(Math.min(target.pos + 1, props.tr.doc.content.size));
    for (let depth = $pos.depth; depth > 0; depth--) {
      const node = $pos.node(depth);
      if (node.type.name === 'details') return { node, pos: $pos.before(depth) };
    }
    // A list's leading paragraph is required by its item schema.
    if ($pos.parent === target.node && $pos.depth > 1 && ['listItem', 'taskItem'].includes($pos.node(-1).type.name)) {
      const item = $pos.node(-1);
      if (item.firstChild === target.node) return { node: item, pos: $pos.before($pos.depth - 1) };
    }
    if ($pos.depth > 1 && ['callout', 'blockquote'].includes($pos.node(-1).type.name)) return { node: $pos.node(-1), pos: $pos.before($pos.depth - 1) };
    return target;
  };
  if (id) {
    let found: { node: ProseMirrorNode; pos: number } | null = null;
    props.tr.doc.descendants((node, pos) => {
      if (node.attrs.blockId === id) { found = { node, pos }; return false; }
      return !found;
    });
    return found ? normalize(found) : null;
  }
  const selection = props.tr.selection;
  if (selection instanceof NodeSelection && selection.node.isBlock) return normalize({ node: selection.node, pos: selection.from });
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const node = selection.$from.node(depth);
    if (node.isBlock && documentationBlockTypes.includes(node.type.name)) return normalize({ node, pos: selection.$from.before(depth) });
  }
  return null;
}
const blockAt = documentationBlockAt;

/** Unwrap structural containers, retaining every inline mark, atom and child. */
function plainBlocks(node: ProseMirrorNode): ProseMirrorNode[] {
  const schema = node.type.schema;
  if (node.type.name === 'details') return [
    schema.nodes.paragraph.create({ ...node.firstChild!.attrs, blockId: node.attrs.blockId }, node.firstChild!.content),
    ...plainBlocks(node.lastChild!),
  ];
  if (['detailsContent', 'callout', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem'].includes(node.type.name)) {
    const result: ProseMirrorNode[] = [];
    node.forEach(child => result.push(...plainBlocks(child)));
    return result;
  }
  if (node.isTextblock && node.type.name !== 'paragraph') return [schema.nodes.paragraph.create(node.attrs, node.content)];
  return [node];
}

function replaceBlock(props: CommandProps, target: { node: ProseMirrorNode; pos: number }, replacement: ProseMirrorNode | Fragment): boolean {
  const $pos = props.tr.doc.resolve(target.pos);
  if (!$pos.parent.canReplace($pos.index(), $pos.index() + 1, Fragment.from(replacement))) return false;
  if (props.dispatch) {
    closeHistory(props.tr);
    const selection = props.tr.selection;
    const offset = selection.from - target.pos;
    const inside = props.tr.selection.from >= target.pos && props.tr.selection.to <= target.pos + target.node.nodeSize;
    const firstTextblock = (node: ProseMirrorNode): { start: number; size: number } | null => {
      if (node.isTextblock) return { start: 1, size: node.content.size };
      let first: { start: number; size: number } | null = null;
      node.descendants((child, pos) => {
        if (first) return false;
        if (child.isTextblock) { first = { start: pos + 2, size: child.content.size }; return false; }
      });
      return first;
    };
    const fragment = Fragment.from(replacement);
    const before = firstTextblock(target.node), after = fragment.firstChild && firstTextblock(fragment.firstChild);
    props.tr.replaceWith(target.pos, target.pos + target.node.nodeSize, replacement);
    if (inside && selection instanceof TextSelection && before && after
      && selection.from >= target.pos + before.start && selection.to <= target.pos + before.start + before.size) {
      const translate = (pos: number) => target.pos + after.start + Math.min(after.size, pos - target.pos - before.start);
      props.tr.setSelection(TextSelection.create(props.tr.doc, translate(selection.anchor), translate(selection.head)));
    } else if (inside) props.tr.setSelection(Selection.near(props.tr.doc.resolve(Math.min(target.pos + fragment.size - 1, Math.max(target.pos + 1, target.pos + offset)))));
  }
  return true;
}

function duplicateNode(node: ProseMirrorNode, relocateReferences = false): JSONContent {
  // ProseMirror toJSON shares attribute objects with the immutable source nodes.
  const json = structuredClone(node.toJSON()) as JSONContent;
  const remap = new Map<string, string>();
  const identity = (item: JSONContent) => {
    if (item.attrs && 'blockId' in item.attrs) {
      const id = freshId();
      if (typeof item.attrs.blockId === 'string') remap.set(item.attrs.blockId, id);
      item.attrs.blockId = id;
    }
    item.content?.forEach(identity);
  };
  identity(json);
  const references = (item: JSONContent) => {
    if (item.attrs?.targetBlockId && remap.has(item.attrs.targetBlockId)) {
      item.attrs.targetBlockId = remap.get(item.attrs.targetBlockId);
      if (relocateReferences) item.attrs.targetPageId = null;
    }
    item.content?.forEach(references);
  };
  references(json);
  return json;
}

export function documentationBlockLink(pageId: string, blockId: string): string | null {
  if (!isAssetId(pageId) || !isAssetId(blockId)) return null;
  const url = new URL(window.location.href);
  url.searchParams.set('panvasPage', pageId); url.searchParams.set('panvasBlock', blockId);
  return url.href;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    notebookDocumentation: {
      ensureDocumentationBlockIds: () => ReturnType;
      turnDocumentationBlockInto: (type: DocumentationBlockType, options?: DocumentationBlockOptions) => ReturnType;
      insertDocumentationBlock: (type: DocumentationBlockType, options?: DocumentationBlockOptions) => ReturnType;
      duplicateDocumentationBlock: (id?: string) => ReturnType;
      deleteDocumentationBlock: (id?: string) => ReturnType;
      moveDocumentationBlock: (direction: 'up' | 'down', id?: string) => ReturnType;
      reorderDocumentationBlocks: (ids: string[]) => ReturnType;
      setDocumentationBlockColor: (color: string | null, id?: string) => ReturnType;
      setDocumentationBlockBackground: (color: string | null, id?: string) => ReturnType;
      toggleDocumentationCollapse: (id?: string, open?: boolean) => ReturnType;
      setDocumentationCodeLanguage: (language: string, id?: string) => ReturnType;
      setDocumentationCodeOptions: (options: { language?: string; wrap?: boolean; caption?: string }, id?: string) => ReturnType;
      focusDocumentationBlock: (id: string) => ReturnType;
      insertDocumentationReference: (reference: DocumentationReference) => ReturnType;
      followDocumentationReference: (reference: DocumentationReference) => ReturnType;
      copyDocumentationBlockLink: (pageId: string, id?: string) => ReturnType;
    };
  }
}

function assignIdentities(props: Pick<CommandProps, 'tr'>): boolean {
  const used = new Set<string>();
  let changed = false;
  props.tr.doc.descendants((node, pos) => {
    if (!('blockId' in node.attrs)) return;
    let id = node.attrs.blockId;
    if (!isAssetId(id) || used.has(id)) {
      id = freshId(); props.tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: id }); changed = true;
    }
    used.add(id);
  });
  return changed;
}

function reorderChildren(props: CommandProps, parentStart: number, nodes: ProseMirrorNode[], order: ProseMirrorNode[]): boolean {
  const parent = props.tr.doc.resolve(parentStart).parent;
  const fragment = Fragment.fromArray(order);
  if (!parent.type.validContent(fragment)) return false;
  if (!props.dispatch) return true;
  closeHistory(props.tr);
  const old = props.tr.selection;
  const translate = (pos: number): number => {
    let offset = parentStart;
    for (const node of nodes) {
      if (pos >= offset && pos < offset + node.nodeSize) {
        return parentStart + order.slice(0, order.indexOf(node)).reduce((sum, child) => sum + child.nodeSize, 0) + pos - offset;
      }
      offset += node.nodeSize;
    }
    return props.tr.mapping.map(pos);
  };
  const anchor = translate(old.anchor), head = translate(old.head);
  props.tr.replaceWith(parentStart, parentStart + parent.content.size, fragment);
  props.tr.setSelection(old instanceof NodeSelection
    ? NodeSelection.create(props.tr.doc, anchor)
    : old instanceof AllSelection ? new AllSelection(props.tr.doc)
    : TextSelection.create(props.tr.doc, anchor, head));
  return true;
}

export const NotebookBlockCommands = Extension.create({
  name: 'notebookDocumentation',
  addGlobalAttributes() {
    return [{
      types: documentationBlockTypes,
      attributes: {
        blockId: { default: null, parseHTML: element => element.getAttribute('data-block-id'), renderHTML: attrs => attrs.blockId ? { 'data-block-id': attrs.blockId } : {} },
        blockColor: { default: null, parseHTML: element => safeDocumentColor(element.getAttribute('data-block-color')), renderHTML: attrs => attrs.blockColor ? { 'data-block-color': attrs.blockColor, style: 'color:' + safeDocumentColor(attrs.blockColor) } : {} },
        blockBackground: { default: null, parseHTML: element => safeDocumentColor(element.getAttribute('data-block-background')), renderHTML: attrs => attrs.blockBackground ? { 'data-block-background': attrs.blockBackground, style: 'background-color:' + safeDocumentColor(attrs.blockBackground) } : {} },
      },
    }];
  },
  addCommands() {
    const color = (attribute: string, value: string | null, id?: string) => (props: CommandProps) => {
      const target = blockAt(props, id), safe = safeDocumentColor(value);
      if (!target || (value !== null && value !== '' && !safe)) return false;
      if (props.dispatch) { closeHistory(props.tr); props.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, [attribute]: safe }); }
      return true;
    };
    return {
      ensureDocumentationBlockIds: () => props => { if (props.dispatch) { assignIdentities(props); props.tr.setMeta('addToHistory', false); } return true; },
      turnDocumentationBlockInto: (type, options = {}) => props => {
        const target = blockAt(props, options.id);
        if (!target) return false;
        const { node } = target, { schema } = props.state;
        const attrs = { blockId: node.attrs.blockId, blockColor: node.attrs.blockColor, blockBackground: node.attrs.blockBackground };
        const paragraph = () => schema.nodes.paragraph.create({ ...node.attrs, blockId: freshId() }, node.isTextblock ? node.content : null);
        let replacement: ProseMirrorNode;
        if (type === 'paragraph' || type === 'heading') {
          if (type === 'paragraph' && !node.isTextblock && node.type.name !== 'blockMath') {
            if (!['details', 'detailsContent', 'callout', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem'].includes(node.type.name)) return false;
            return replaceBlock(props, target, Fragment.fromArray(plainBlocks(node)));
          }
          let content = node.content;
          if (node.type.name === 'blockMath') content = node.attrs.latex ? Fragment.from(schema.text(node.attrs.latex)) : Fragment.empty;
          else if (!node.isTextblock) {
            if (node.childCount !== 1 || !node.firstChild?.isTextblock) return false;
            content = node.firstChild.content;
          }
          replacement = schema.nodes[type].create({ ...attrs, textAlign: node.isTextblock ? node.attrs.textAlign : node.firstChild?.attrs.textAlign,
            ...(type === 'heading' ? { level: Math.max(1, Math.min(6, options.level ?? 1)) } : {}) }, content);
        } else if (type === 'codeBlock') {
          if (!node.isTextblock) return false;
          replacement = schema.nodes.codeBlock.create({ ...attrs, language: normalizeCodeLanguage(options.language) }, node.textContent ? schema.text(node.textContent) : null);
        } else if (['bulletList', 'orderedList', 'taskList'].includes(type)) {
          const itemType = type === 'taskList' ? 'taskItem' : 'listItem';
          const items: ProseMirrorNode[] = [];
          if (['bulletList', 'orderedList', 'taskList'].includes(node.type.name)) {
            node.forEach(item => items.push(schema.nodes[itemType].create({ ...item.attrs, ...(itemType === 'taskItem' ? { checked: Boolean(item.attrs.checked) } : {}) }, item.content)));
          } else {
            const child = node.type.create({ ...node.attrs, blockId: freshId() }, node.content, node.marks);
            items.push(schema.nodes[itemType].create({ blockId: freshId(), ...(itemType === 'taskItem' ? { checked: false } : {}) }, node.isTextblock ? paragraph() : [schema.nodes.paragraph.create(), child]));
          }
          replacement = schema.nodes[type].create({ ...attrs, ...(type === 'orderedList' ? { start: node.attrs.start ?? 1 } : {}) }, items);
        } else if (type === 'blockquote' || type === 'callout') {
          const child = node.type.create({ ...node.attrs, blockId: freshId() }, node.content, node.marks);
          replacement = schema.nodes[type].create({ ...attrs, ...(type === 'callout' ? { icon: options.icon ?? 'ℹ', tone: options.tone ?? 'note' } : {}) }, child);
        } else if (type === 'details') {
          const summary = schema.nodes.detailsSummary.create({ blockId: freshId(), textAlign: node.attrs.textAlign,
            headingLevel: options.headingLevel ?? (node.type.name === 'heading' ? node.attrs.level : 0) }, node.isTextblock ? node.content : schema.text('Toggle'));
          const body = schema.nodes.detailsContent.create({ blockId: freshId() }, node.isTextblock ? schema.nodes.paragraph.create() : node.type.create({ ...node.attrs, blockId: freshId() }, node.content, node.marks));
          replacement = schema.nodes.details.create({ ...attrs, open: true }, [summary, body]);
        } else if (type === 'blockMath') {
          if (!node.isTextblock || node.content.content.some(child => !child.isText)) return false;
          replacement = schema.nodes.blockMath.create({ ...attrs, latex: options.latex ?? node.textContent });
        } else return false;
        return replaceBlock(props, target, replacement);
      },
      insertDocumentationBlock: (type, options = {}) => ({ commands, tr, dispatch }) => {
        let content: JSONContent[] | undefined;
        let attrs: Record<string, unknown> = {};
        if (type === 'heading') attrs.level = Math.max(1, Math.min(6, options.level ?? 1));
        if (type === 'codeBlock') attrs.language = normalizeCodeLanguage(options.language);
        if (type === 'blockMath') { if (!options.latex) return false; attrs.latex = options.latex; }
        if (type === 'image') { if (!isAssetId(options.fileId)) return false; attrs = { fileId: options.fileId, alt: options.alt ?? '' }; }
        if (type === 'callout' || type === 'blockquote') { content = [{ type: 'paragraph' }]; if (type === 'callout') attrs = { icon: options.icon ?? 'ℹ', tone: options.tone ?? 'note' }; }
        if (type === 'details') { attrs.open = true; content = [{ type: 'detailsSummary', attrs: { headingLevel: options.headingLevel ?? 0 } }, { type: 'detailsContent', content: [{ type: 'paragraph' }] }]; }
        if (['bulletList', 'orderedList', 'taskList'].includes(type)) content = [{ type: type === 'taskList' ? 'taskItem' : 'listItem', content: [{ type: 'paragraph' }] }];
        if (dispatch) closeHistory(tr);
        return commands.insertContent({ type, attrs, ...(content ? { content } : {}) });
      },
      duplicateDocumentationBlock: id => props => {
        const target = blockAt(props, id);
        if (!target) return false;
        const parent = props.tr.doc.resolve(target.pos), index = parent.index() + 1;
        if (!parent.parent.canReplace(index, index, Fragment.from(target.node))) return false;
        if (props.dispatch) { closeHistory(props.tr); props.tr.insert(target.pos + target.node.nodeSize, props.state.schema.nodeFromJSON(duplicateNode(target.node))); }
        return true;
      },
      deleteDocumentationBlock: id => props => {
        let target = blockAt(props, id);
        if (!target) return false;
        let parent = props.tr.doc.resolve(target.pos), index = parent.index();
        if (['listItem', 'taskItem'].includes(target.node.type.name) && parent.parent.childCount === 1) {
          target = { node: parent.parent, pos: parent.before() };
          parent = props.tr.doc.resolve(target.pos); index = parent.index();
        }
        if (parent.parent.type.name !== 'doc' && !parent.parent.canReplace(index, index + 1)) return false;
        if (props.dispatch) { closeHistory(props.tr); props.tr.delete(target.pos, target.pos + target.node.nodeSize); }
        return true;
      },
      moveDocumentationBlock: (direction, id) => props => {
        const target = blockAt(props, id);
        if (!target) return false;
        const $pos = props.tr.doc.resolve(target.pos), parent = $pos.parent, index = $pos.index();
        const next = index + (direction === 'up' ? -1 : 1);
        if (next < 0 || next >= parent.childCount) return false;
        const nodes: ProseMirrorNode[] = []; parent.forEach(child => nodes.push(child));
        const order = [...nodes]; [order[index], order[next]] = [order[next], order[index]];
        return reorderChildren(props, $pos.start(), nodes, order);
      },
      reorderDocumentationBlocks: ids => props => {
        const nodes: ProseMirrorNode[] = []; props.tr.doc.forEach(child => nodes.push(child));
        if (ids.length !== nodes.length || new Set(ids).size !== ids.length) return false;
        const order = ids.map(id => nodes.find(node => node.attrs.blockId === id));
        if (order.some(node => !node)) return false;
        return reorderChildren(props, 0, nodes, order as ProseMirrorNode[]);
      },
      setDocumentationBlockColor: (value, id) => color('blockColor', value, id),
      setDocumentationBlockBackground: (value, id) => color('blockBackground', value, id),
      toggleDocumentationCollapse: (id, open) => props => {
        let target = blockAt(props, id);
        if (target && target.node.type.name !== 'details') {
          // A reopened context menu targets the summary's own block ID.
          const position = props.tr.doc.resolve(target.pos);
          for (let depth = position.depth; depth > 0; depth--) {
            const node = position.node(depth);
            if (node.type.name === 'details') { target = { node, pos: position.before(depth) }; break; }
          }
        }
        if (!target || target.node.type.name !== 'details') return false;
        if (props.dispatch) { closeHistory(props.tr); props.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, open: open ?? !target.node.attrs.open }); }
        return true;
      },
      setDocumentationCodeLanguage: (language, id) => props => {
        const target = blockAt(props, id);
        if (!target || target.node.type.name !== 'codeBlock') return false;
        if (props.dispatch) { closeHistory(props.tr); props.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, language: normalizeCodeLanguage(language) }); }
        return true;
      },
      focusDocumentationBlock: id => props => {
        const target = blockAt(props, id);
        if (!target) return false;
        if (props.dispatch) props.tr.setSelection(Selection.near(props.tr.doc.resolve(target.pos + (target.node.isAtom ? 0 : 1)))).scrollIntoView();
        return true;
      },
      setDocumentationCodeOptions: (options, id) => props => {
        const target = blockAt(props, id);
        if (!target || target.node.type.name !== 'codeBlock') return false;
        const attrs = { ...target.node.attrs };
        if (options.language !== undefined) attrs.language = normalizeCodeLanguage(options.language);
        if (options.wrap !== undefined) attrs.wrap = Boolean(options.wrap);
        if (options.caption !== undefined) attrs.caption = options.caption;
        if (Object.keys(attrs).every(name => attrs[name] === target.node.attrs[name])) return true;
        if (props.dispatch) { if (options.language !== undefined || options.wrap !== undefined) closeHistory(props.tr); props.tr.setNodeMarkup(target.pos, undefined, attrs); }
        return true;
      },
      insertDocumentationReference: reference => ({ commands }) => {
        if ((!reference.targetPageId && !reference.targetBlockId) || (reference.targetPageId && !isAssetId(reference.targetPageId)) || (reference.targetBlockId && !isAssetId(reference.targetBlockId))) return false;
        return commands.insertContent({ type: 'pageReference', attrs: reference });
      },
      followDocumentationReference: reference => () => dispatchDocumentationReference(reference),
      copyDocumentationBlockLink: (pageId, id) => props => {
        const target = blockAt(props, id);
        const link = target && documentationBlockLink(pageId, target.node.attrs.blockId);
        if (!link || !canCopyNotebookText()) return false;
        if (props.dispatch) void copyNotebookText(link).then(() => {
          document.dispatchEvent(new CustomEvent('panvas:document-command-result', { detail: { message: 'Block link copied.' } }));
        }).catch(() => {
          document.dispatchEvent(new CustomEvent('panvas:document-command-error', { detail: { message: 'Could not copy the block link.' } }));
        });
        return true;
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Alt-ArrowUp': () => this.editor.commands.moveDocumentationBlock('up'),
      'Mod-Alt-ArrowDown': () => this.editor.commands.moveDocumentationBlock('down'),
      'Mod-Shift-d': () => this.editor.commands.duplicateDocumentationBlock(),
      'Mod-Alt-Backspace': () => this.editor.commands.deleteDocumentationBlock(),
      'Mod-Alt-0': () => this.editor.commands.turnDocumentationBlockInto('paragraph'),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => ['Mod-Alt-' + level, () => this.editor.commands.turnDocumentationBlockInto('heading', { level })])),
      'Mod-Alt-Shift-e': () => this.editor.commands.toggleDocumentationCollapse(),
    };
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('notebookBlockIdentity'),
      props: { transformPasted: (slice, view) => {
        // One temporary root lets copied references follow targets within the
        // whole pasted fragment, including targets in another copied block.
        const schema = view.state.schema;
        const root = schema.topNodeType.create(null, slice.content);
        const content = schema.nodeFromJSON(duplicateNode(root, true)).content;
        return new Slice(content, slice.openStart, slice.openEnd);
      } },
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some(transaction => transaction.docChanged)) return null;
        const tr = state.tr;
        return assignIdentities({ tr }) ? tr.setMeta('addToHistory', false) : null;
      },
    })];
  },
});
