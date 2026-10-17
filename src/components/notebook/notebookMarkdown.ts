import { Extension, generateHTML, type JSONContent } from '@tiptap/core';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { notebookTipTapExtensions, htmlToTipTapJson, getNotebookSchema } from './tiptapExtensions';
import { getSafeNotebookLink, normalizeCodeLanguage, sanitizeHtml } from './notebookClipboard';
import { isAssetId, safeImageReference } from './notebookAssetImage';
import { unsupportedNotebookContent } from './notebookContentCompatibility';
import { closeHistory } from '@tiptap/pm/history';
import { Slice } from '@tiptap/pm/model';

interface MdNode {
  type: string; value?: string; children?: MdNode[]; depth?: number; lang?: string | null;
  ordered?: boolean; start?: number | null; checked?: boolean | null; align?: (string | null)[];
  url?: string; title?: string | null; identifier?: string; label?: string; alt?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
}
export interface NotebookMarkdownImport { content: JSONContent; warnings: string[] }
export interface NotebookMarkdownExport { markdown: string; warnings: string[] }

// One parser/serializer pipeline. Raw HTML is sanitized before the schema sees it.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' });
const paragraph = (content: JSONContent[] = []): JSONContent => ({ type: 'paragraph', content });
const text = (value: string): JSONContent[] => value ? [{ type: 'text', text: value }] : [];
const doc = (content: JSONContent[]): JSONContent => ({ type: 'doc', content });

function normalizeImportedContent(node: JSONContent): JSONContent {
  const copy = { ...node };
  if (copy.type === 'codeBlock') copy.attrs = { ...copy.attrs, language: normalizeCodeLanguage(copy.attrs?.language) };
  if (copy.marks) copy.marks = copy.marks.filter(mark => mark.type !== 'link' || getSafeNotebookLink(mark.attrs?.href));
  if (copy.content) copy.content = copy.content.map(normalizeImportedContent).filter(child => child.type !== 'text' || Boolean(child.text));
  return copy;
}

export function parseNotebookMarkdown(source: string): NotebookMarkdownImport {
  const root = processor.parse(source) as unknown as MdNode;
  const warnings = new Set<string>();
  const definitions = new Map<string, MdNode>();
  const collect = (node: MdNode) => { if (node.type === 'definition' && node.identifier) definitions.set(node.identifier.toLowerCase(), node); node.children?.forEach(collect); };
  collect(root);
  const raw = (node: MdNode) => source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
  const sourceText = (value: string): string => {
    const extract = (node: MdNode): string => node.value ?? node.children?.map(extract).join('') ?? '';
    return extract(processor.parse(value) as unknown as MdNode);
  };
  const inline = (nodes: MdNode[] = []): JSONContent[] => {
    if (nodes.some(node => node.type === 'html')) {
      const html = nodes.map(node => node.type === 'html' ? node.value ?? '' :
        generateHTML(doc([paragraph(inline([node]))]), notebookTipTapExtensions).replace(/^<p[^>]*>|<\/p>$/g, '')).join('');
      const parsed = htmlToTipTapJson('<p>' + html + '</p>');
      return parsed?.content?.flatMap(node => node.type === 'paragraph' ? node.content ?? [] : []) ?? [];
    }
    return nodes.flatMap(node => {
      if (node.type === 'text') {
        // CommonMark unescapes \( ... \). Recover deliberate source delimiters
        // from the AST's source range; fenced/inline code never enters this path.
        const value = raw(node);
        const matches = [...value.matchAll(/\\\(([\s\S]+?)\\\)/g)];
        if (matches.length) {
          const result: JSONContent[] = [];
          let cursor = 0;
          for (const match of matches) {
            result.push(...text(sourceText(value.slice(cursor, match.index))));
            result.push({ type: 'inlineMath', attrs: { latex: match[1] } });
            cursor = (match.index ?? 0) + match[0].length;
          }
          result.push(...text(sourceText(value.slice(cursor))));
          return result;
        }
        return text(node.value ?? '');
      }
      if (node.type === 'inlineCode') return text(node.value ?? '').map(item => ({ ...item, marks: [{ type: 'code' }] }));
      if (node.type === 'break') return [{ type: 'hardBreak' }];
      if (node.type === 'inlineMath') {
        const value = node.value ?? '';
        // Numeric dollar amounts and "$5 and $10" remain ordinary currency.
        // Numeric mathematics can use explicit \( ... \) or an HTML fallback.
        const following = source.slice(node.position?.end.offset ?? source.length);
        if (/^\d/.test(following) || (/^\s*\d/.test(value) && !/[=+*/^_\\{}]/.test(value))) return text(raw(node));
        return [{ type: 'inlineMath', attrs: { latex: value } }];
      }
      if (['strong', 'emphasis', 'delete'].includes(node.type)) {
        const type = node.type === 'strong' ? 'bold' : node.type === 'emphasis' ? 'italic' : 'strike';
        return inline(node.children).map(item => ({ ...item, marks: [...(item.marks ?? []), { type }] }));
      }
      if (node.type === 'link' || node.type === 'linkReference') {
        const reference = node.type === 'linkReference' ? definitions.get(node.identifier?.toLowerCase() ?? '') : node;
        const content = inline(node.children);
        const href = getSafeNotebookLink(reference?.url);
        if (!href) { warnings.add('Unsupported or unsafe link target retained as readable text.'); return content; }
        return content.map(item => ({ ...item, marks: [...(item.marks ?? []), { type: 'link', attrs: { href } }] }));
      }
      if (node.type === 'image' || node.type === 'imageReference') {
        const reference = node.type === 'imageReference' ? definitions.get(node.identifier?.toLowerCase() ?? '') : node;
        const asset = reference?.url?.match(/^panvas-asset\/([a-zA-Z0-9_-]{1,160})$/);
        const imageSource = asset ? null : safeImageReference(reference?.url);
        if (!asset && !imageSource) { warnings.add('Unsupported image target retained as alt text.'); return text(node.alt ?? node.label ?? 'Image'); }
        warnings.add('Image references are preserved; importing image bytes and portable asset bundles await Stage 3.');
        return [{ type: 'inlineImage', attrs: { fileId: asset?.[1] ?? null, source: imageSource, alt: node.alt ?? node.label ?? '', title: reference?.title ?? null } }];
      }
      warnings.add('Unsupported Markdown construct retained as readable source: ' + node.type);
      return text(raw(node) || node.value || '');
    });
  };
  const blocks = (nodes: MdNode[] = []): JSONContent[] => nodes.flatMap(node => {
    if (node.type === 'definition') return [];
    if (node.type === 'paragraph') {
      const display = raw(node).match(/^\s*\\\[([\s\S]+?)\\\]\s*$/);
      if (display) return [{ type: 'blockMath', attrs: { latex: display[1] } }];
      const content = inline(node.children);
      if (content.length === 1 && content[0].type === 'inlineImage') return [{ ...content[0], type: 'image' }];
      return [paragraph(content)];
    }
    if (node.type === 'heading') return [{ type: 'heading', attrs: { level: node.depth }, content: inline(node.children) }];
    if (node.type === 'blockquote') return [{ type: 'blockquote', content: blocks(node.children) }];
    if (node.type === 'thematicBreak') return [{ type: 'horizontalRule' }];
    if (node.type === 'math') return [{ type: 'blockMath', attrs: { latex: node.value ?? '' } }];
    if (node.type === 'code') {
      if (node.lang === 'panvas-json') {
        try {
          const original = JSON.parse(node.value ?? '');
          if (original?.type === 'doc' && Array.isArray(original.content)) {
            warnings.add('Recovered original JSON content; unsupported nodes require a compatible editor.');
            // Unknown payloads are protected read-only. Known payloads still cross
            // the HTML sanitizer so a recovery fence cannot bypass clipboard policy.
            if (unsupportedNotebookContent(original, getNotebookSchema()).length) return original.content as JSONContent[];
            return htmlToTipTapJson(generateHTML(original, notebookTipTapExtensions))?.content ?? [];
          }
        } catch { /* It is ordinary code if the recovery payload is invalid. */ }
      }
      return [{ type: 'codeBlock', attrs: { language: normalizeCodeLanguage(node.lang) }, content: text(node.value ?? '') }];
    }
    if (node.type === 'html') {
      const parsed = htmlToTipTapJson(node.value ?? '');
      if (parsed?.content?.length) return parsed.content;
      warnings.add('Unsupported HTML retained as readable source.');
      return [paragraph(text(node.value ?? ''))];
    }
    if (node.type === 'list') {
      const output: JSONContent[] = [];
      for (const item of node.children ?? []) {
        const task = typeof item.checked === 'boolean';
        const type = task ? 'taskList' : node.ordered ? 'orderedList' : 'bulletList';
        if (task && node.ordered) warnings.add('Ordered checklists are retained as task lists; numbering is not portable.');
        let container = output[output.length - 1];
        if (container?.type !== type) {
          container = { type, ...(type === 'orderedList' ? { attrs: { start: node.start ?? 1 } } : {}), content: [] };
          output.push(container);
        }
        const content = blocks(item.children);
        if (content[0]?.type !== 'paragraph') content.unshift(paragraph());
        container.content!.push({ type: task ? 'taskItem' : 'listItem', ...(task ? { attrs: { checked: item.checked } } : {}), content });
      }
      return output;
    }
    if (node.type === 'table') return [{
      type: 'table', content: node.children?.map((row, rowIndex) => ({
        type: 'tableRow', content: row.children?.map((cell, column) => ({
          type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
          content: [{ type: 'paragraph', attrs: { textAlign: node.align?.[column] ?? null }, content: inline(cell.children) }],
        })),
      })),
    }];
    warnings.add('Unsupported Markdown block retained as readable source: ' + node.type);
    return [paragraph(text(raw(node) || node.value || ''))];
  });
  const content = normalizeImportedContent(doc(blocks(root.children)));
  if (!content.content?.length) content.content = [paragraph()];
  const schema = getNotebookSchema();
  const unsupported = unsupportedNotebookContent(content, schema);
  if (unsupported.length) { warnings.add('Original unsupported JSON is preserved and must be opened read-only.'); return { content, warnings: [...warnings] }; }
  const validated = schema.nodeFromJSON(content);
  validated.check();
  return { content: validated.toJSON(), warnings: [...warnings] };
}

function requiresHtml(node: JSONContent): boolean {
  if (['callout', 'details', 'pageReference', 'tableOfContents', 'documentPageBreak'].includes(node.type ?? '')) return true;
  if (node.type === 'codeBlock' && (node.attrs?.wrap || node.attrs?.caption)) return true;
  if (node.type === 'paragraph' && !node.content?.length) return true;
  if (['image', 'inlineImage'].includes(node.type ?? '') && (node.attrs?.width || node.attrs?.height)) return true;
  if (node.type === 'table' && node.content?.some((row, index) =>
    row.content?.some(cell => cell.type !== (index === 0 ? 'tableHeader' : 'tableCell')))) return true;
  if (node.attrs?.blockColor || node.attrs?.blockBackground || node.attrs?.textAlign || node.attrs?.colwidth
    || Number(node.attrs?.colspan ?? 1) !== 1 || Number(node.attrs?.rowspan ?? 1) !== 1) return true;
  if (['tableCell', 'tableHeader'].includes(node.type ?? '') && (node.content?.length !== 1 || node.content[0].type !== 'paragraph')) return true;
  if (node.marks?.some(mark => ['underline', 'textStyle', 'highlight'].includes(mark.type))) return true;
  if (node.type === 'inlineMath' && /^\s*\d/.test(node.attrs?.latex ?? '') && !/[=+*/^_\\{}]/.test(node.attrs?.latex ?? '')) return true;
  return Boolean(node.content?.some(requiresHtml));
}

export function serializeNotebookMarkdown(content: JSONContent): NotebookMarkdownExport {
  const warnings = new Set<string>();
  const unsupported = unsupportedNotebookContent(content, getNotebookSchema());
  if (unsupported.length) {
    warnings.add('Unsupported content exported as a panvas-json recovery code block; original JSON is preserved.');
    const recovery: MdNode = { type: 'root', children: [{ type: 'code', lang: 'panvas-json', value: JSON.stringify(content, null, 2) }] };
    return { markdown: processor.stringify(recovery as never), warnings: [...warnings] };
  }
  const targets = new Set<string>();
  let hasTableOfContents = false;
  const collectTargets = (node: JSONContent) => {
    if (node.type === 'pageReference' && typeof node.attrs?.targetBlockId === 'string') targets.add(node.attrs.targetBlockId);
    if (node.type === 'tableOfContents') hasTableOfContents = true;
    node.content?.forEach(collectTargets);
  };
  collectTargets(content);
  const retainsTarget = (node: JSONContent): boolean => targets.has(node.attrs?.blockId)
    || (hasTableOfContents && node.type === 'heading' && isAssetId(node.attrs?.blockId))
    || Boolean(node.content?.some(retainsTarget));
  const inline = (nodes: JSONContent[] = []): MdNode[] => nodes.map(node => {
    let result: MdNode;
    if (node.type === 'text') result = { type: 'text', value: node.text };
    else if (node.type === 'hardBreak') result = { type: 'break' };
    else if (node.type === 'inlineMath') result = { type: 'inlineMath', value: node.attrs?.latex ?? '' };
    else if (node.type === 'inlineImage') {
      warnings.add('Markdown contains image references, not image bytes; portable bundles await Stage 3.');
      result = { type: 'image', url: isAssetId(node.attrs?.fileId) ? 'panvas-asset/' + node.attrs.fileId : safeImageReference(node.attrs?.source) ?? '', alt: node.attrs?.alt ?? '', title: node.attrs?.title ?? null };
    } else throw new Error('No safe Markdown representation for inline node ' + node.type);
    for (const mark of node.marks ?? []) {
      if (mark.type === 'code' && result.type === 'text') result = { type: 'inlineCode', value: result.value };
      else if (mark.type === 'link') result = { type: 'link', url: mark.attrs?.href, children: [result] };
      else if (['bold', 'italic', 'strike'].includes(mark.type)) result = { type: mark.type === 'bold' ? 'strong' : mark.type === 'italic' ? 'emphasis' : 'delete', children: [result] };
    }
    return result;
  });
  const blocks = (nodes: JSONContent[] = []): MdNode[] => nodes.map(node => {
    if (requiresHtml(node) || retainsTarget(node)) {
      warnings.add('Formatting or structure outside standard Markdown is preserved as sanitized Panvas HTML.');
      return { type: 'html', value: sanitizeHtml(generateHTML(doc([node]), notebookTipTapExtensions)) };
    }
    if (node.type === 'paragraph') return { type: 'paragraph', children: inline(node.content) };
    if (node.type === 'heading') return { type: 'heading', depth: node.attrs?.level ?? 1, children: inline(node.content) };
    if (node.type === 'codeBlock') return { type: 'code', lang: normalizeCodeLanguage(node.attrs?.language), value: node.content?.map(child => child.text ?? '').join('') ?? '' };
    if (node.type === 'blockquote') return { type: 'blockquote', children: blocks(node.content) };
    if (node.type === 'horizontalRule') return { type: 'thematicBreak' };
    if (node.type === 'blockMath') return { type: 'math', value: node.attrs?.latex ?? '' };
    if (node.type === 'image') return { type: 'paragraph', children: inline([{ ...node, type: 'inlineImage' }]) };
    if (['bulletList', 'orderedList', 'taskList'].includes(node.type ?? '')) return {
      type: 'list', ordered: node.type === 'orderedList', start: node.attrs?.start ?? 1,
      children: node.content?.map(item => ({ type: 'listItem', checked: node.type === 'taskList' ? Boolean(item.attrs?.checked) : null, children: blocks(item.content) })),
    };
    if (node.type === 'table') return { type: 'table', align: node.content?.[0]?.content?.map(cell => cell.content?.[0]?.attrs?.textAlign ?? null),
      children: node.content?.map(row => ({ type: 'tableRow', children: row.content?.map(cell => ({ type: 'tableCell', children: inline(cell.content?.[0]?.content) })) })) };
    throw new Error('No safe Markdown representation for block ' + node.type);
  });
  const root: MdNode = { type: 'root', children: blocks(content.content) };
  return { markdown: processor.stringify(root as never), warnings: [...warnings] };
}

export async function importNotebookMarkdownFile(file: Pick<File, 'name' | 'text'>): Promise<NotebookMarkdownImport> {
  if (!/\.md$/i.test(file.name)) throw new Error('Expected a .md file.');
  return parseNotebookMarkdown(await file.text());
}
export function createNotebookMarkdownFile(content: JSONContent, name = 'document'): NotebookMarkdownExport & { fileName: string; blob: Blob } {
  const result = serializeNotebookMarkdown(content);
  const fileName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.md$/i, '') + '.md';
  return { ...result, fileName, blob: new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' }) };
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    notebookMarkdown: {
      importDocumentationMarkdown: (source: string) => ReturnType;
      pasteDocumentationMarkdown: (source: string) => ReturnType;
    };
  }
}
export const NotebookMarkdownCommands = Extension.create<{ }, { warnings: string[] }>({
  name: 'notebookMarkdown',
  addStorage() { return { warnings: [] }; },
  addCommands() {
    const insert = (source: string, replace: boolean) => ({ commands, state, dispatch, tr, editor }: import('@tiptap/core').CommandProps) => {
      if (!editor.isEditable) return false;
      if (!replace && state.selection.$from.parent.type.spec.code) {
        if (dispatch) { closeHistory(tr); tr.insertText(source); }
        return true;
      }
      const parsed = parseNotebookMarkdown(source);
      if (unsupportedNotebookContent(parsed.content, state.schema).length) return false;
      if (dispatch) { this.storage.warnings = parsed.warnings; closeHistory(tr); }
      if (replace) return commands.setContent(parsed.content);
      if (dispatch) tr.replaceSelection(Slice.maxOpen(state.schema.nodeFromJSON(parsed.content).content)).scrollIntoView();
      return true;
    };
    return { importDocumentationMarkdown: source => insert(source, true), pasteDocumentationMarkdown: source => insert(source, false) };
  },
});
