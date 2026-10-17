import type { Attributes, JSONContent } from '@tiptap/core';
import { common } from 'lowlight';
const languageAliases: Record<string, string> = {
  py: 'python', python: 'python', js: 'javascript', javascript: 'javascript',
  ts: 'typescript', typescript: 'typescript', 'c++': 'cpp', cpp: 'cpp',
  'c#': 'csharp', csharp: 'csharp', sh: 'bash', bash: 'bash', html: 'xml', xml: 'xml',
  text: 'plaintext', txt: 'plaintext', plain: 'plaintext', plaintext: 'plaintext',
};

export function canonicalNotebookCodeLanguage(value: string): string {
  const name = value.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(languageAliases, name)) return languageAliases[name];
  return Object.prototype.hasOwnProperty.call(common, name) ? name : value;
}

export const NOTEBOOK_TABLE_COLUMN_MIN_WIDTH = 120;

export function notebookTableSpan(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}

export function notebookTableAttributes(parent: Attributes): Attributes {
  return { ...parent, ...Object.fromEntries(['colspan', 'rowspan'].map(name => [name, {
    ...parent[name], default: 1, parseHTML: (element: HTMLElement) => notebookTableSpan(element.getAttribute(name)),
  }])) };
}

/** Repair known legacy attributes for the view without mutating or saving stored JSON.
 * A real edit subsequently writes the valid native table attributes through Tiptap.
 */
export function notebookDocumentViewContent(content: JSONContent): JSONContent {
  if (!content || typeof content !== 'object') return content;
  let attrs = content.attrs;
  if (content.type === 'codeBlock' && typeof attrs?.language === 'string' && attrs.language !== canonicalNotebookCodeLanguage(attrs.language)) {
    attrs = { ...attrs, language: canonicalNotebookCodeLanguage(attrs.language) };
  }
  if (content.type === 'tableCell' || content.type === 'tableHeader') {
    for (const name of ['colspan', 'rowspan']) {
      if (attrs && name in attrs && attrs[name] !== notebookTableSpan(attrs[name])) attrs = { ...attrs, [name]: notebookTableSpan(attrs[name]) };
    }
  }
  const children = content.content?.map(notebookDocumentViewContent);
  const changed = children?.some((child, index) => child !== content.content![index]);
  return attrs !== content.attrs || changed ? { ...content, ...(attrs !== content.attrs ? { attrs } : {}), ...(changed ? { content: children } : {}) } : content;
}
