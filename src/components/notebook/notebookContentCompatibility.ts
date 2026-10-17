import type { JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { textFromTipTap } from '../../services/search/pageSearchContent';

export const NOTEBOOK_RICH_TEXT_SCHEMA_VERSION = 3;
/** Existing Stage 2 nodes retain their writing-client requirement. */
export function notebookContentSchemaVersion(value: JSONContent): number {
  return value.type === 'documentPageBreak' || value.type === 'codeBlock' && ('wrap' in (value.attrs ?? {}) || 'caption' in (value.attrs ?? {}))
    || Boolean(value.marks?.some(mark => mark.type === 'code') && value.marks.length > 1)
    || Boolean(value.marks?.some(mark => mark.type === 'link' && /^file:/i.test(mark.attrs?.href ?? '')))
    || value.content?.some(child => notebookContentSchemaVersion(child) === 3) ? 3 : 2;
}

export function unsupportedNotebookContent(value: unknown, schema: Schema): string[] {
  const unsupported = new Set<string>();
  const walk = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach(walk); return; }
    const node = item as JSONContent;
    if (typeof node.type !== 'string' || !schema.nodes[node.type]) unsupported.add(String(node.type ?? 'invalid node'));
    else for (const key of Object.keys(node.attrs ?? {})) {
      if (!(key in (schema.nodes[node.type].spec.attrs ?? {}))) unsupported.add(node.type + '.' + key);
    }
    for (const mark of node.marks ?? []) {
      if (!schema.marks[mark.type]) unsupported.add('mark:' + mark.type);
      else for (const key of Object.keys(mark.attrs ?? {})) {
        if (!(key in (schema.marks[mark.type].spec.attrs ?? {}))) unsupported.add('mark:' + mark.type + '.' + key);
      }
    }
    node.content?.forEach(walk);
  };
  if (typeof value === 'string') return []; // Existing legacy text/HTML input contract.
  walk(value);
  if (!unsupported.size && value) {
    try { schema.nodeFromJSON(value).check(); } catch { unsupported.add('invalid document structure'); }
  }
  return [...unsupported];
}

export function unsupportedContentFallback(value: unknown, types: string[]): JSONContent {
  const text = 'Unsupported content (' + types.join(', ') + '). Original data is preserved; open with a compatible editor.\n'
    + textFromTipTap(value);
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

export function usesDocumentationNodes(value: JSONContent): boolean {
  if (['callout', 'details', 'inlineMath', 'blockMath', 'image', 'inlineImage', 'pageReference', 'tableOfContents', 'documentPageBreak'].includes(value.type ?? '')) return true;
  return Boolean(value.content?.some(usesDocumentationNodes));
}
