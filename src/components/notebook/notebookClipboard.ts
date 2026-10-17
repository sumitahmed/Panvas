import DOMPurify from 'dompurify';
import { Extension, type JSONContent } from '@tiptap/core';
import { DOMParser as ProseMirrorDOMParser, DOMSerializer, Slice, Fragment, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { isAssetId, safeImageReference } from './notebookAssetImage';
import { canonicalNotebookCodeLanguage } from './notebookDocumentView';
import { notebookMathMatches } from './notebookMathDelimiters';

/** Only explicit code metadata identifies a language. Unknown labels stay intact. */
export function normalizeCodeLanguage(value: string | null | undefined): string {
  const language = value?.trim() ?? '';
  if (!/^[a-zA-Z0-9_+#.-]{1,64}$/.test(language)) return 'plaintext';
  return canonicalNotebookCodeLanguage(language);
}

export function getSafeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = value.trim();
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Packaged Electron links may address this renderer, never arbitrary local files. */
export function getSafeNotebookLink(value: string | null | undefined, base = typeof window === 'undefined' ? '' : window.location.href): string | null {
  const web = getSafeHttpUrl(value);
  if (web) return web;
  if (!value || !base) return null;
  try {
    const url = new URL(value.trim()), renderer = new URL(base);
    const page = url.searchParams.get('panvasPage'), block = url.searchParams.get('panvasBlock');
    return url.protocol === 'file:' && renderer.protocol === 'file:' && url.host === renderer.host && url.pathname === renderer.pathname
      && isAssetId(page) && (!block || isAssetId(block)) ? url.href : null;
  } catch { return null; }
}

export function canCopyNotebookText(): boolean {
  return Boolean(window.panvas?.clipboard?.writeText || navigator.clipboard?.writeText);
}

export async function copyNotebookText(text: string): Promise<void> {
  if (window.panvas?.clipboard?.writeText) await window.panvas.clipboard.writeText(text);
  else await navigator.clipboard.writeText(text);
}

// Keep the existing schema's formatting and native ProseMirror slice metadata.
// Resource elements, event handlers and arbitrary data attributes are excluded.
const htmlPolicy = {
  // Every anchor is checked below after purification, including same-renderer file links.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  ALLOWED_TAGS: [
    'p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr',
    'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'mark', 'a', 'pre', 'code',
    'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'colgroup', 'col', 'label', 'input', 'button',
    'aside', 'details', 'summary', 'nav', 'img', 'math', 'semantics', 'annotation',
  ],
  ALLOWED_ATTR: [
    'style', 'class', 'href', 'target', 'rel', 'title', 'start', 'type',
    'colspan', 'rowspan', 'colwidth', 'align', 'checked', 'disabled',
    'data-language', 'data-lang', 'data-code-wrap', 'data-code-caption', 'data-type', 'data-checked', 'data-color', 'data-pm-slice',
    'data-latex', 'data-block-id', 'data-block-color', 'data-block-background',
    'data-icon', 'data-tone', 'data-callout-content', 'data-heading-level', 'open',
    'data-target-page-id', 'data-target-block-id', 'data-label',
    'data-file-id', 'data-source', 'data-alt', 'data-width', 'data-height', 'alt',
    'encoding', 'role', 'aria-level', 'aria-label', 'tabindex',
  ],
  ALLOW_DATA_ATTR: false,
};
// A private purifier avoids changing HTML policy in unrelated canvas components.
const notebookPurifier = typeof window === 'undefined' ? DOMPurify : DOMPurify(window);
notebookPurifier.addHook('uponSanitizeAttribute', (node, data) => {
  if (node.nodeName === 'IMG' && data.attrName === 'src') {
    const source = safeImageReference(data.attrValue);
    if (source) (node as Element).setAttribute('data-source', source);
  }
});
const allowedStyles = new Set([
  'font-weight', 'font-style', 'text-decoration', 'text-decoration-line',
  'color', 'background-color', 'font-family', 'font-size', 'text-align',
]);

function hasSafeSliceContext(value: string, doc: Document): boolean {
  try {
    const match = value.match(/^\d+ \d+(?: -\d+)? (.*)$/);
    if (!match) return false;
    const context: unknown = JSON.parse(match[1]);
    if (!Array.isArray(context) || context.length % 2) return false;
    for (let index = 1; index < context.length; index += 2) {
      const value = context[index];
      if (value === null) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const attrs = value as Record<string, unknown>;
      for (const attribute of ['blockColor', 'blockBackground']) {
        if (attrs[attribute] == null) continue;
        if (typeof attrs[attribute] !== 'string') return false;
        const probe = doc.createElement('span');
        probe.style.color = attrs[attribute];
        if (!probe.style.color) return false;
      }
      for (const attribute of ['textAlign', 'align']) {
        if (attrs[attribute] == null || attrs[attribute] === '') continue;
        if (typeof attrs[attribute] !== 'string') return false;
        const probe = doc.createElement('span');
        probe.style.textAlign = attrs[attribute];
        if (!probe.style.textAlign) return false;
      }
      if (attrs.colwidth != null && (!Array.isArray(attrs.colwidth)
        || !attrs.colwidth.every(width => width === null || (typeof width === 'number' && Number.isFinite(width) && width >= 0)))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function explicitCodeLanguage(pre: HTMLElement, code: HTMLElement): string {
  for (const element of [code, pre]) {
    const attribute = element.getAttribute('data-language') || element.getAttribute('data-lang');
    if (attribute) return normalizeCodeLanguage(attribute);
    const match = element.className.match(/(?:^|\s)(?:language|lang|hljs)-([a-zA-Z0-9_+#.-]+)(?=\s|$)/i);
    if (match) return normalizeCodeLanguage(match[1]);
  }
  // GitHub's rendered code carries explicit TextMate scope metadata on its wrapper.
  const scope = pre.parentElement?.className ?? '';
  const github = scope.match(/(?:^|\s)highlight-source-([a-zA-Z0-9_+#.-]+)(?=\s|$)/);
  if (github) return normalizeCodeLanguage(github[1]);
  if (/(?:^|\s)highlight-text-html-basic(?=\s|$)/.test(scope)) return 'html';
  return 'plaintext';
}

/** Fail closed. This function must run before HTML reaches any notebook parser or preview. */
export function sanitizeHtml(rawHtml: string): string {
  if (typeof DOMParser === 'undefined' || !notebookPurifier.isSupported) return '';
  const doc = new DOMParser().parseFromString(notebookPurifier.sanitize(rawHtml, htmlPolicy), 'text/html');

  doc.querySelectorAll<HTMLElement>('.katex-display, .katex, [data-latex]').forEach(element => {
    const latex = element.getAttribute('data-latex') ?? element.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (latex == null || !element.parentNode) return;
    const block = element.dataset.type === 'block-math' || element.classList.contains('katex-display');
    const math = doc.createElement(block ? 'div' : 'span');
    for (const attribute of ['data-block-id', 'data-block-color', 'data-block-background']) {
      const value = element.getAttribute(attribute);
      if (value) math.setAttribute(attribute, value);
    }
    math.setAttribute('data-type', block ? 'block-math' : 'inline-math');
    math.setAttribute('data-latex', latex);
    element.replaceWith(math);
  });
  doc.querySelectorAll('math').forEach(element => element.replaceWith(doc.createTextNode(element.textContent ?? '')));
  // Panvas's derived code UI is not source prose; caption/language metadata
  // already lives on the pre/code element. Other independent labels remain.
  doc.querySelectorAll('.panvas-code-controls, .panvas-code-caption').forEach(element => element.remove());
  doc.querySelectorAll('img').forEach(image => {
    const fileId = image.getAttribute('data-file-id');
    const source = safeImageReference(image.getAttribute('data-source'));
    const alt = image.getAttribute('alt') ?? '';
    if (!isAssetId(fileId) && !source) { image.replaceWith(doc.createTextNode(alt)); return; }
    const placeholder = doc.createElement('span');
    placeholder.setAttribute('data-type', 'asset-inline-image');
    placeholder.setAttribute('data-alt', alt);
    if (isAssetId(fileId)) placeholder.setAttribute('data-file-id', fileId);
    if (source) placeholder.setAttribute('data-source', source);
    image.replaceWith(placeholder);
  });
  doc.querySelectorAll('[data-block-id], [data-file-id], [data-target-page-id], [data-target-block-id]').forEach(element => {
    for (const attribute of ['data-block-id', 'data-file-id', 'data-target-page-id', 'data-target-block-id']) {
      const value = element.getAttribute(attribute);
      if (value && !isAssetId(value)) element.removeAttribute(attribute);
    }
  });

  doc.querySelectorAll('button').forEach(button => button.remove());
  doc.querySelectorAll('input').forEach(input => {
    if (input.type !== 'checkbox' || !input.closest('li[data-type="taskItem"]')) input.remove();
    else input.disabled = true;
  });
  doc.querySelectorAll('[data-color], [data-block-color], [data-block-background]').forEach(element => {
    for (const attribute of ['data-color', 'data-block-color', 'data-block-background']) {
      if (!element.hasAttribute(attribute)) continue;
      const color = element.getAttribute(attribute)?.trim() ?? '';
      const probe = doc.createElement('span');
      probe.style.backgroundColor = color;
      if (probe.style.backgroundColor) element.setAttribute(attribute, color);
      else element.removeAttribute(attribute);
    }
  });
  // ProseMirror restores parent attributes from this JSON after parsing HTML.
  // Preserve valid native metadata, but do not let it bypass CSS validation.
  doc.querySelectorAll('[data-pm-slice]').forEach(element => {
    if (!hasSafeSliceContext(element.getAttribute('data-pm-slice') ?? '', doc)) element.removeAttribute('data-pm-slice');
  });
  doc.querySelectorAll('a').forEach(anchor => {
    const href = getSafeNotebookLink(anchor.getAttribute('href'));
    if (!href) anchor.replaceWith(...Array.from(anchor.childNodes));
    else {
      anchor.setAttribute('href', href);
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    }
  });

  doc.querySelectorAll('pre').forEach(pre => {
    const sourceCode = pre.querySelector('code');
    const language = normalizeCodeLanguage(explicitCodeLanguage(pre, sourceCode ?? pre));
    const source = sourceCode ?? pre;
    source.querySelectorAll('br').forEach(br => br.replaceWith(doc.createTextNode('\n')));
    const code = doc.createElement('code');
    code.className = 'language-' + language;
    code.textContent = source.textContent; // Discard copied token markup; highlighting is derived.
    pre.replaceChildren(code);
    pre.removeAttribute('style');
    pre.setAttribute('data-language', language);
  });

  doc.querySelectorAll<HTMLElement>('[style]').forEach(element => {
    for (const property of Array.from(element.style)) {
      const value = element.style.getPropertyValue(property);
      const tableDimension = ['TABLE', 'COL'].includes(element.tagName) && ['width', 'min-width'].includes(property);
      if ((!allowedStyles.has(property) && !tableDimension) || /url\s*\(|expression\s*\(/i.test(value)) {
        element.style.removeProperty(property);
      }
    }
    if (!element.style.length) element.removeAttribute('style');
  });

  // Add each semantic mark independently, retaining the span's color/font attributes.
  doc.querySelectorAll<HTMLElement>('span, p, div, h1, h2, h3, h4, h5, h6, b, strong, i, em, u, s, del, a').forEach(element => {
    if (element.closest('pre')) return;
    const style = element.style;
    const tags: string[] = [];
    if (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600) tags.push('strong');
    if (style.fontStyle === 'italic') tags.push('em');
    const decoration = style.textDecoration + ' ' + style.textDecorationLine;
    if (decoration.includes('underline')) tags.push('u');
    if (decoration.includes('line-through')) tags.push('s');
    if (style.backgroundColor && element.tagName !== 'MARK' && !element.hasAttribute('data-block-background')) tags.push('mark');
    let container = element;
    for (const tag of tags) {
      const wrapper = doc.createElement(tag);
      if (tag === 'mark') wrapper.style.backgroundColor = style.backgroundColor;
      wrapper.append(...Array.from(container.childNodes));
      container.appendChild(wrapper);
      container = wrapper;
    }
    // TextStyle parses spans; semantic tags and paragraphs may also carry font attributes.
    if (element.tagName !== 'SPAN' && ((!element.hasAttribute('data-block-color') && style.color) || style.fontFamily || style.fontSize)) {
      const font = doc.createElement('span');
      for (const property of ['color', 'font-family', 'font-size']) {
        const value = style.getPropertyValue(property);
        if (value && (property !== 'color' || !element.hasAttribute('data-block-color'))) font.style.setProperty(property, value);
      }
      font.append(...Array.from(container.childNodes));
      container.appendChild(font);
    }
  });
  // Normalization creates only known tags/attributes; run the sanitizer again at the boundary.
  return notebookPurifier.sanitize(doc.body.innerHTML, htmlPolicy);
}

const plainTextUrlPattern = /https?:\/\/[^\s<>"']+/gi;
export function textContentWithSafeLinks(text: string): JSONContent[] {
  const content: JSONContent[] = [];
  let cursor = 0;
  for (const match of text.matchAll(plainTextUrlPattern)) {
    const start = match.index ?? 0;
    const rawUrl = match[0];
    const url = rawUrl.replace(/[),.;!?]+$/, '');
    const safeUrl = getSafeHttpUrl(url);
    if (!safeUrl) continue;
    if (start > cursor) content.push({ type: 'text', text: text.slice(cursor, start) });
    content.push({ type: 'text', text: safeUrl, marks: [{ type: 'link', attrs: { href: safeUrl } }] });
    cursor = start + safeUrl.length;
  }
  if (cursor < text.length) content.push({ type: 'text', text: text.slice(cursor) });
  return content;
}

/** Reuse the existing closed triple-backtick code paste feature; this is not a Markdown importer. */
export function parsePlainTextClipboard(text: string): JSONContent | null {
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const content: JSONContent[] = [];
  const proseLines: string[] = [];
  let foundFence = false;
  let foundMath = false;
  const appendProse = () => {
    if (!proseLines.length) return;
    const source = proseLines.join(lineEnding), displays = notebookMathMatches(source).filter(match => match.block);
    const appendLines = (source: string) => { for (const line of source.split(/\r?\n/)) content.push({
      type: 'paragraph', content: line ? textContentWithSafeLinks(line) : [],
    }); };
    if (displays.length) {
      let cursor = 0;
      for (const match of displays) {
        const before = source.slice(cursor, match.from).replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, ''); if (before) appendLines(before);
        content.push({ type: 'blockMath', attrs: { latex: match.latex } }); cursor = match.to;
      }
      const after = source.slice(cursor).replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, ''); if (after) appendLines(after);
      foundMath = true;
    } else appendLines(source);
    proseLines.length = 0;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const openingFence = lines[index].match(/^ {0,3}```([^\s`]*)[ \t]*$/);
    if (!openingFence) { proseLines.push(lines[index]); continue; }
    const closingIndex = lines.findIndex(
      (line, candidate) => candidate > index && /^ {0,3}```[ \t]*$/.test(line),
    );
    if (closingIndex === -1) return null;
    appendProse();
    const code = lines.slice(index + 1, closingIndex).join(lineEnding);
    content.push({
      type: 'codeBlock', attrs: { language: normalizeCodeLanguage(openingFence[1]) },
      content: code ? [{ type: 'text', text: code }] : [],
    });
    foundFence = true;
    index = closingIndex;
  }
  appendProse();
  return foundFence || foundMath ? { type: 'doc', content } : null;
}

function recognizePastedMath(slice: Slice, schema: Schema, root?: ProseMirrorNode): Slice {
  const convert = (fragment: Fragment, parent?: ProseMirrorNode): Fragment => {
    const output: ProseMirrorNode[] = [];
    fragment.forEach((node, _offset, index) => {
      if (node.type.spec.code || node.isLeaf) { output.push(node); return; }
      if (!node.isTextblock) { output.push(node.copy(convert(node.content, node))); return; }
      const source = node.content.content.map(child => child.isText ? child.text : '\ufffc'.repeat(child.nodeSize)).join('');
      const protectedRanges: Array<{ from: number; to: number }> = [];
      node.content.forEach((child, offset) => { if (child.marks.some(mark => mark.type.spec.code)) protectedRanges.push({ from: offset, to: offset + child.nodeSize }); });
      const matches = notebookMathMatches(source).filter(match => !protectedRanges.some(range => range.from < match.to && range.to > match.from));
      const display = matches.length === 1 && matches[0].block && !source.slice(0, matches[0].from).trim() && !source.slice(matches[0].to).trim() ? matches[0] : undefined;
      if (display && node.type.name === 'paragraph') {
        const math = schema.nodes.blockMath.create({ ...node.attrs, latex: display.latex }, null, node.marks);
        if (!parent || parent.canReplace(index, index + 1, Fragment.from(math))) { output.push(math); return; }
      }
      let content = Fragment.empty, cursor = 0;
      for (const match of matches.filter(match => !match.block)) {
        content = content.append(node.content.cut(cursor, match.from));
        content = content.append(Fragment.from(schema.nodes.inlineMath.create({ latex: match.latex }, null, node.nodeAt(match.from)?.marks ?? node.resolve(match.from).marks())));
        cursor = match.to;
      }
      output.push(cursor ? node.copy(content.append(node.content.cut(cursor))) : node);
    });
    return Fragment.fromArray(output);
  };
  const content = convert(slice.content, root), opened = Slice.maxOpen(content);
  return new Slice(content, Math.min(slice.openStart, opened.openStart), Math.min(slice.openEnd, opened.openEnd));
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    notebookClipboard: {
      pasteDocumentationContent: (content: JSONContent) => ReturnType;
      convertExistingNotebookMath: () => ReturnType;
    };
  }
}

export const NotebookClipboard = Extension.create({
  name: 'notebookClipboard',
  addCommands() {
    return { pasteDocumentationContent: content => ({ editor, state, tr, dispatch, view }) => {
      if (!editor.isEditable) return false;
      let slice: Slice;
      try { slice = Slice.maxOpen(state.schema.nodeFromJSON(content).content); } catch { return false; }
      // Workspace paste uses the same identity/reference remapping as native
      // editor paste, including an isolated history action.
      view.someProp('transformPasted', transform => { slice = transform(slice, view, false); return false; });
      if (dispatch) { closeHistory(tr); tr.replaceSelection(slice).setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView(); }
      return true;
    }, convertExistingNotebookMath: () => ({ editor, tr, dispatch }) => {
      if (!editor.isEditable) return false;
      // Explicit author action only: loading and reopening retain literal text.
      // Reuse clipboard recognition, including its code/currency protections.
      const original = tr.doc;
      const converted = recognizePastedMath(new Slice(original.content, 0, 0), original.type.schema, original);
      if (original.content.eq(converted.content)) return false;
      if (dispatch) {
        closeHistory(tr);
        const replacements: Array<{ pos: number; node: ProseMirrorNode; next: ProseMirrorNode }> = [];
        original.forEach((node, pos, index) => {
          const next = converted.content.child(index);
          if (!node.eq(next)) replacements.push({ pos, node, next });
        });
        // Retain untouched blocks, their IDs, and positions outside each change.
        for (const { pos, node, next } of replacements.reverse()) tr.replaceWith(pos, pos + node.nodeSize, next);
        tr.scrollIntoView();
      }
      return true;
    } };
  },
  addProseMirrorPlugins() {
    let literalTextPaste = false;
    return [new Plugin({
      key: new PluginKey('notebookClipboard'),
      props: {
        transformPastedHTML: html => { literalTextPaste = false; return sanitizeHtml(html); },
        transformPasted: (slice, view) => {
          const literal = literalTextPaste; literalTextPaste = false;
          return literal || view.state.selection.$from.parent.type.spec.code ? slice : recognizePastedMath(slice, view.state.schema);
        },
        clipboardTextParser(text, $context, plain, view) {
          const { schema } = view.state;
          const fenced = !plain && parsePlainTextClipboard(text);
          literalTextPaste = plain || !fenced && /^ {0,3}`{3,}/m.test(text);
          if (fenced) return new Slice(schema.nodeFromJSON(fenced).content, 0, 0);

          // Match ProseMirror's native text fallback, including the caret's marks.
          // Code-context text is handled by ProseMirror before this hook.
          const dom = document.createElement('div');
          const serializer = DOMSerializer.fromSchema(schema);
          text.split(/(?:\r\n?|\n)+/).forEach(block => {
            const paragraph = dom.appendChild(document.createElement('p'));
            if (block) paragraph.appendChild(serializer.serializeNode(schema.text(block, $context.marks())));
          });
          const parser = view.someProp('clipboardParser') || view.someProp('domParser') || ProseMirrorDOMParser.fromSchema(schema);
          return parser.parseSlice(dom, { preserveWhitespace: true, context: $context });
        },
      },
    })];
  },
});
