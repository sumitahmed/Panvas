import { generateHTML, type JSONContent } from '@tiptap/core';
import { lowlight, notebookTipTapExtensions, sanitizeHtml, getNotebookSchema } from './tiptapExtensions';
import { renderStaticMath } from './notebookMath';
import { documentationHeadings, renderTableOfContents } from './notebookDocumentationNodes';
import { unsupportedNotebookContent, unsupportedContentFallback } from './notebookContentCompatibility';
import { notebookDocumentViewContent } from './notebookDocumentView';
import { notebookCodeLanguageLabel } from './notebookCodeBlockView';

type HighlightNode = ReturnType<typeof lowlight.highlight>['children'][number];

/** Render the same leaf classes as Tiptap's Lowlight decorations, using safe DOM nodes. */
function appendToken(doc: Document, parent: HTMLElement, node: HighlightNode, classes: string[] = []): void {
  if (node.type === 'element') {
    const ownClasses = node.properties.className;
    const combined = classes.concat(Array.isArray(ownClasses) ? ownClasses.map(String) : typeof ownClasses === 'string' ? ownClasses.split(' ') : []);
    node.children.forEach(child => appendToken(doc, parent, child, combined));
  } else if (node.type === 'text') {
    if (classes.length) {
      const span = doc.createElement('span');
      span.className = classes.join(' ');
      span.textContent = node.value;
      parent.appendChild(span);
    } else parent.appendChild(doc.createTextNode(node.value));
  }
}

export function renderNotebookStaticHtml(content: JSONContent): string {
  const unsupported = unsupportedNotebookContent(content, getNotebookSchema());
  if (unsupported.length) content = unsupportedContentFallback(content, unsupported);
  else content = notebookDocumentViewContent(content);
  const html = sanitizeHtml(generateHTML(content, notebookTipTapExtensions));
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('table').forEach(table => {
    const wrapper = doc.createElement('div'); wrapper.className = 'panvas-table-scroll';
    wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', 'Table, scroll horizontally');
    table.before(wrapper); wrapper.append(table);
  });
  doc.querySelectorAll<HTMLElement>('pre > code').forEach(code => {
    const language = code.parentElement?.getAttribute('data-language') ?? 'plaintext';
    const highlighted = lowlight.highlight(lowlight.registered(language) ? language : 'plaintext', code.textContent ?? '');
    code.replaceChildren();
    highlighted.children.forEach(node => appendToken(doc, code, node));
    const pre = code.parentElement!;
    const caption = pre.getAttribute('data-code-caption');
    const wrapper = doc.createElement('div'); wrapper.className = 'panvas-code-block';
    const header = doc.createElement('div'); header.className = 'panvas-code-controls';
    const label = doc.createElement('span'); label.className = 'panvas-code-language-label'; label.textContent = notebookCodeLanguageLabel(language);
    header.append(label); pre.before(wrapper); wrapper.append(header, pre);
    if (caption) {
      const label = doc.createElement('div'); label.className = 'panvas-code-caption'; label.textContent = caption; wrapper.append(label);
    }
  });
  renderStaticMath(doc.body);
  const headings = documentationHeadings(content);
  doc.querySelectorAll<HTMLElement>('nav[data-type="table-of-contents"]').forEach(element => renderTableOfContents(element, headings));
  return doc.body.innerHTML;
}
