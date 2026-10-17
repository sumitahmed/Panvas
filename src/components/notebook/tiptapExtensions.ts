// ============================================
// Panvas — Shared TipTap Extensions & HTML Parser
// ============================================

import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { NotebookCodeBlock } from './notebookCodeBlockView';
import { common, createLowlight } from 'lowlight';
import { FontSize } from './FontSizeExtension';
import { generateJSON, getSchema, type JSONContent } from '@tiptap/core';
import { NotebookClipboard, getSafeNotebookLink, sanitizeHtml } from './notebookClipboard';
import { NotebookInlineMath, NotebookBlockMath } from './notebookMath';
import { NotebookCallout, NotebookDetails, NotebookDetailsSummary, NotebookDetailsContent, NotebookPageReference, NotebookTableOfContents } from './notebookDocumentationNodes';
import { NotebookImage, NotebookInlineImage } from './notebookAssetImage';
import { NotebookBlockCommands } from './notebookBlockCommands';
import { NotebookMarkdownCommands } from './notebookMarkdown';
import { NotebookLinkEditing } from './notebookLinkEditing';
import { DocumentPageBreak } from './documentPageBreak';
import { DocumentTableView, documentTablePartView } from './DocumentTableView';
import { NOTEBOOK_TABLE_COLUMN_MIN_WIDTH, notebookTableAttributes } from './notebookDocumentView';
export { getSafeHttpUrl, getSafeNotebookLink, sanitizeHtml } from './notebookClipboard';

export const lowlight = createLowlight(common);

/**
 * Shared, unified TipTap extensions used across FloatingTextEditor,
 * StaticTextPreview, and clipboard HTML parsing.
 */
export const notebookTipTapExtensions = [
  StarterKit.extend({
    addExtensions() {
      return (this.parent?.() ?? []).map(extension => extension.type === 'mark' && extension.name === 'code'
        ? extension.extend({ excludes: '' }) : extension);
    },
  }).configure({
    heading: {
      levels: [1, 2, 3, 4, 5, 6],
    },
    // TipTap v3 StarterKit already bundles these. Disable the bundled copies because Panvas
    // registers configured Link and Underline instances below.
    link: false,
    underline: false,
    codeBlock: false, // Handled by CodeBlockLowlight
    // Opening/focusing a legacy document must not append content or assign IDs.
    // Native exit-code/gap-cursor commands still provide an editing position.
    trailingNode: false,
  }),
  NotebookCodeBlock.configure({
    lowlight: {
      ...lowlight,
      highlight: (language: string, text: string) => lowlight.highlight(lowlight.registered(language) ? language : 'plaintext', text),
      highlightAuto: (text: string) => lowlight.highlight('plaintext', text),
    },
    defaultLanguage: 'plaintext',
    enableTabIndentation: true,
    tabSize: 2,
    HTMLAttributes: {
      class: 'rounded-lg bg-neutral-900 text-neutral-100 p-3.5 font-mono text-xs my-2.5 overflow-x-auto border border-neutral-700/60 shadow-inner',
    },
  }),
  Table.configure({
    resizable: true,
    cellMinWidth: NOTEBOOK_TABLE_COLUMN_MIN_WIDTH,
    View: DocumentTableView,
    HTMLAttributes: {
      class: 'panvas-table border-collapse my-3 w-full border border-neutral-700/50 rounded-md',
    },
  }),
  TableRow.extend({ addNodeView() { return this.editor.extensionManager.extensions.some(extension => extension.name === 'panvasDocumentPagination') ? documentTablePartView('tr', this.options.HTMLAttributes) : null; } }),
  TableHeader.extend({ addAttributes() { return notebookTableAttributes(this.parent?.() ?? {}); }, addNodeView() { return this.editor.extensionManager.extensions.some(extension => extension.name === 'panvasDocumentPagination') ? documentTablePartView('th', this.options.HTMLAttributes) : null; } }).configure({
    HTMLAttributes: {
      class: 'bg-neutral-800/60 font-semibold p-2 border border-neutral-700/50 text-left text-xs',
    },
  }),
  TableCell.extend({ addAttributes() { return notebookTableAttributes(this.parent?.() ?? {}); }, addNodeView() { return this.editor.extensionManager.extensions.some(extension => extension.name === 'panvasDocumentPagination') ? documentTablePartView('td', this.options.HTMLAttributes) : null; } }).configure({
    HTMLAttributes: {
      class: 'p-2 border border-neutral-700/40 text-xs',
    },
  }),
  Link.configure({
    openOnClick: true,
    protocols: ['http', 'https'],
    isAllowedUri: (url) => getSafeNotebookLink(url) !== null,
    HTMLAttributes: {
      class: 'panvas-text-link',
      target: '_blank',
      rel: 'noopener noreferrer',
    },
  }),
  Underline,
  Highlight.configure({ multicolor: true }),
  TextAlign.configure({ types: ['heading', 'paragraph', 'detailsSummary'] }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TextStyle,
  Color,
  FontFamily,
  FontSize,
  NotebookInlineMath,
  NotebookBlockMath,
  NotebookCallout,
  NotebookDetails,
  NotebookDetailsSummary,
  NotebookDetailsContent,
  NotebookPageReference,
  NotebookTableOfContents,
  NotebookImage,
  NotebookInlineImage,
  NotebookBlockCommands,
  NotebookMarkdownCommands,
  NotebookLinkEditing,
  NotebookClipboard,
  DocumentPageBreak,
];

let notebookSchema: ReturnType<typeof getSchema> | undefined;
export function getNotebookSchema(): ReturnType<typeof getSchema> {
  return notebookSchema ??= getSchema(notebookTipTapExtensions);
}

/**
 * Converts clipboard rich HTML into a TipTap ProseMirror document JSON.
 * Preserves headings, bold, italic, underline, colors, code blocks, lists, links, tables, etc.
 */
export function htmlToTipTapJson(html: string): JSONContent | null {
  try {
    const cleanHtml = sanitizeHtml(html);
    const json = generateJSON(cleanHtml, notebookTipTapExtensions);
    return json;
  } catch (err) {
    console.warn('Failed to parse HTML to TipTap JSON, falling back to plain text:', err);
    return null;
  }
}
