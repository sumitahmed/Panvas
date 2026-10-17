import { Editor } from '@tiptap/core';
import { PDFName, PDFString, StandardFonts, concatTransformationMatrix, popGraphicsState, pushGraphicsState, rgb, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';
import { notebookTipTapExtensions, getNotebookSchema } from '../../components/notebook/tiptapExtensions';
import { notebookDocumentViewContent } from '../../components/notebook/notebookDocumentView';
import { unsupportedNotebookContent } from '../../components/notebook/notebookContentCompatibility';
import { createDocumentPagination } from '../../components/notebook/documentPagination';
import { documentInsets, documentSheetStride } from '../../components/notebook/documentFlowGeometry';
import { textObjectStyle } from '../../components/notebook/textTypography';
import type { TextObject, PageProperties } from '../../components/notebook/engine/drawingTypes';
import { resolveBasePageDimensions } from '../../lib/pageProperties';
import type { NotebookExportImage, NotebookPageGeometry } from './notebookPdfExport';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
let colorProbe: CanvasRenderingContext2D | undefined;
function paintColor(value: string) {
  if (/^rgba?\(/.test(value)) {
    const parts = value.match(/[\d.]+/g)!.map(Number);
    if (parts.length > 3 && parts[3] === 0) return null;
    return { color: rgb(parts[0] / 255, parts[1] / 255, parts[2] / 255), opacity: parts[3] ?? 1 };
  }
  // Computed styles can be color(srgb ...), oklch(), or color-mix(). Let the
  // same browser color engine resolve them instead of assuming 0..255 rgb().
  if (!colorProbe) { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; colorProbe = canvas.getContext('2d', { willReadFrequently: true })!; }
  colorProbe.clearRect(0, 0, 1, 1); colorProbe.fillStyle = value; colorProbe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data;
  return a ? { color: rgb(r / 255, g / 255, b / 255), opacity: a / 255 } : null;
}
function baseline(rect: DOMRect, style: CSSStyleDeclaration, context: CanvasRenderingContext2D): number {
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const m = context.measureText('Mg'), ascent = m.fontBoundingBoxAscent || Number.parseFloat(style.fontSize) * .8,
    descent = m.fontBoundingBoxDescent || Number.parseFloat(style.fontSize) * .2;
  return rect.top + (rect.height + ascent - descent) / 2;
}
const ignored = '[aria-hidden="true"],.katex-mathml,.panvas-code-controls,.panvas-page-gap,button,style';
function visuallyClipped(style: CSSStyleDeclaration): boolean {
  return style.display === 'none' || style.visibility === 'hidden'
    || style.clip.replace(/\s/g, '') === 'rect(0px,0px,0px,0px)' || style.clipPath === 'inset(50%)';
}

/** A disposable view of canonical JSON. It never registers with an engine or saves. */
export async function layoutRichDocument(object: TextObject, properties: PageProperties, loadImage?: (id: string) => Promise<NotebookExportImage | undefined>, geometry?: NotebookPageGeometry) {
  if (typeof document === 'undefined') throw new Error('Rich PDF export requires the browser document layout runtime.');
  const unsupported = unsupportedNotebookContent(object.content, getNotebookSchema());
  if (unsupported.length) throw new Error(`This document contains unsupported rich content (${unsupported.slice(0, 5).join(', ')}); PDF export stopped without omitting it.`);
  const host = document.createElement('div'); host.dataset.panvasPdf = 'true';
  host.className = 'panvas-document-body panvas-document-text';
  const inset = documentInsets(properties), width = (geometry?.sourceWidth ?? resolveBasePageDimensions(properties).width) - inset * 2;
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;pointer-events:none;contain:layout style;`;
  const style = document.createElement('style');
  style.textContent = '[data-panvas-pdf] .panvas-code-controls{display:none!important}[data-panvas-pdf] pre,[data-panvas-pdf] code{white-space:pre-wrap!important;overflow-wrap:anywhere!important}[data-panvas-pdf] .panvas-table-scroll{overflow:visible!important}[data-panvas-pdf] table{width:100%!important;min-width:0!important;table-layout:fixed!important}[data-panvas-pdf] th,[data-panvas-pdf] td{min-width:0!important;overflow-wrap:anywhere!important}[data-panvas-pdf] details>div{display:block!important}';
  host.append(style); document.body.append(host);
  let height = 0, issues: string[] = [], editor: Editor | undefined;
  const urls: string[] = [];
  try {
    const element = document.createElement('div'); host.append(element);
    const imageView = (node: ProseMirrorNode) => {
      const dom = document.createElement(node.type.name === 'inlineImage' ? 'span' : 'div');
      dom.dataset.type = node.type.name === 'inlineImage' ? 'asset-inline-image' : 'asset-image'; dom.dataset.fileId = node.attrs.fileId ?? '';
      dom.className = 'panvas-document-asset';
      for (const key of ['width', 'height']) if (node.attrs[key]) dom.setAttribute(`data-${key}`, node.attrs[key]);
      return { dom, ignoreMutation: () => true };
    };
    editor = new Editor({ element, editable: false, injectCSS: false,
      extensions: [...notebookTipTapExtensions, createDocumentPagination(() => ({ properties, printPageHeight: geometry?.sourceHeight, onLayout: (next, _ms, nextIssues) => { height = next; issues = nextIssues; } }))],
      content: notebookDocumentViewContent(object.content),
      editorProps: { attributes: { class: 'tiptap prose prose-neutral prose-sm max-w-none panvas-document-content' }, nodeViews: { image: imageView, inlineImage: imageView } },
    });
    const root = editor.view.dom, typography = textObjectStyle(object);
    root.style.fontFamily = typography.fontFamily;
    if (typography.fontSize) root.style.fontSize = `${typography.fontSize}px`;
    if (typography.lineHeight) root.style.lineHeight = typography.lineHeight;
    root.querySelectorAll('details').forEach(details => details.open = true);
    await Promise.all([...root.querySelectorAll<HTMLElement>('[data-type="asset-image"],[data-type="asset-inline-image"]')].map(async wrapper => {
      const asset = await loadImage?.(wrapper.dataset.fileId!);
      if (!asset) throw new Error(`Document image ${wrapper.dataset.fileId} is unavailable. PDF export stopped.`);
      const url = URL.createObjectURL(new Blob([asset.data as BlobPart], { type: asset.mimeType })); urls.push(url);
      let image = wrapper.querySelector('img'); if (!image) { image = document.createElement('img'); wrapper.replaceChildren(image); }
      image.src = url; image.style.maxWidth = '100%';
      for (const dimension of ['width', 'height']) { const value = wrapper.getAttribute(`data-${dimension}`); if (value) image.setAttribute(dimension, value); }
      try { await image.decode(); } catch { throw new Error(`Document image ${wrapper.dataset.fileId} could not be decoded.`); }
    }));
    await Promise.all([...root.querySelectorAll<HTMLImageElement>('img[src]:not(.ProseMirror-separator)')].map(async image => { try { await image.decode(); } catch { throw new Error('An embedded document image could not be decoded.'); } }));
    await document.fonts.ready;
    root.dispatchEvent(new Event('panvas-layout'));
    for (let n = 0, stable = 0, previous = -1; n < 30; n++) { await frame(); if (height && height === previous) stable++; else stable = 0; previous = height; if (stable >= 2) break; }
    if (!height) throw new Error('Document PDF layout did not complete.');
    if (issues.length) throw new Error(`Document PDF layout needs attention: ${[...new Set(issues)].join(' ')}`);
    return { root, height, inset, stride: geometry ? geometry.logicalHeight + 32 : documentSheetStride(properties), dispose: () => { editor?.destroy(); host.remove(); urls.forEach(url => URL.revokeObjectURL(url)); } };
  } catch (error) { editor?.destroy(); host.remove(); urls.forEach(url => URL.revokeObjectURL(url)); throw error; }
}

/** Rasterize only a mathematical atom or a font glyph unavailable in PDF's core fonts. */
async function rasterAtom(element: HTMLElement, rect: DOMRect): Promise<Uint8Array> {
  const scale = 3, canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(rect.width * scale)); canvas.height = Math.max(1, Math.ceil(rect.height * scale));
  const c = canvas.getContext('2d')!; c.scale(scale, scale);
  // KaTeX's visible HTML is aria-hidden because MathML supplies accessibility.
  const elements = [element, ...element.querySelectorAll<HTMLElement>('*')].filter(el => !el.closest('.katex-mathml,.panvas-code-controls,.panvas-page-gap,button,style'));
  for (const el of elements) {
    const style = getComputedStyle(el), box = el.getBoundingClientRect();
    if (visuallyClipped(style)) continue;
    if (paintColor(style.backgroundColor)) { c.fillStyle = style.backgroundColor; c.fillRect(box.left - rect.left, box.top - rect.top, box.width, box.height); }
    for (const side of ['Top', 'Bottom', 'Left', 'Right'] as const) {
      const size = Number.parseFloat(style[`border${side}Width`]);
      if (size > 0) { c.fillStyle = style[`border${side}Color`]; c.fillRect(box.left - rect.left + (side === 'Right' ? box.width - size : 0), box.top - rect.top + (side === 'Bottom' ? box.height - size : 0), side === 'Left' || side === 'Right' ? size : box.width, side === 'Top' || side === 'Bottom' ? size : box.height); }
    }
    for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE && child.textContent) {
      const range = document.createRange(); let offset = 0;
      for (const character of child.textContent) { range.setStart(child, offset); offset += character.length; range.setEnd(child, offset); const box = range.getBoundingClientRect(); if (!box.width) continue;
        const y = baseline(box, style, c); c.fillStyle = style.color; c.fillText(character, box.left - rect.left, y - rect.top); }
    }
    if (el instanceof SVGSVGElement) {
      // KaTeX's stretchable SVGs retain width="400em" in markup, while CSS
      // supplies the actual viewport. Preserve that viewport when serializing:
      // squeezing the intrinsic 400em image into it erases radical/arrow stems.
      const svg = el.cloneNode(true) as SVGSVGElement;
      svg.setAttribute('width', String(box.width)); svg.setAttribute('height', String(box.height));
      svg.style.width = `${box.width}px`; svg.style.height = `${box.height}px`;
      svg.style.color = style.color; svg.style.fill = style.fill; svg.style.stroke = style.stroke;
      const image = new Image(); image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
      try { await image.decode(); } catch { throw new Error('A mathematical SVG glyph could not be decoded for PDF export.'); }
      c.drawImage(image, box.left - rect.left, box.top - rect.top, box.width, box.height);
    }
  }
  return new Uint8Array(await (await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!)))).arrayBuffer());
}

export async function drawRichDocument(pdf: PDFDocument, pages: PDFPage[], layout: Awaited<ReturnType<typeof layoutRichDocument>>, g: NotebookPageGeometry): Promise<{ rasterGlyphs: number }> {
  const { root, inset, stride } = layout, origin = root.getBoundingClientRect(), measure = document.createElement('canvas').getContext('2d')!;
  const shownCache = new WeakMap<HTMLElement, boolean>();
  const shown = (element: HTMLElement): boolean => {
    if (element === root) return true;
    const previous = shownCache.get(element); if (previous !== undefined) return previous;
    const visible = !visuallyClipped(getComputedStyle(element)) && (!element.parentElement || shown(element.parentElement));
    shownCache.set(element, visible); return visible;
  };
  const faces = { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold, italic: StandardFonts.HelveticaOblique, boldItalic: StandardFonts.HelveticaBoldOblique,
    mono: StandardFonts.Courier, monoBold: StandardFonts.CourierBold, monoItalic: StandardFonts.CourierOblique, monoBoldItalic: StandardFonts.CourierBoldOblique };
  const fonts = Object.fromEntries(await Promise.all(Object.entries(faces).map(async ([key, name]) => [key, await pdf.embedFont(name)]))) as Record<string, PDFFont>;
  let rasterGlyphs = 0;
  const locate = (rect: DOMRect) => {
    const top = rect.top - origin.top + inset, index = Math.floor((top + .1) / stride);
    return { page: pages[index], index, x: (rect.left - origin.left + inset + g.sourceX) * g.scaleX, y: top - index * stride + g.sourceY };
  };
  const box = (rect: DOMRect, fill: ReturnType<typeof paintColor>, border = false) => {
    if (!fill || !rect.width || !rect.height) return;
    const top = rect.top - origin.top + inset;
    for (let i = Math.max(0, Math.floor(top / stride)); i < pages.length && i * stride < top + rect.height; i++) {
      const y = Math.max(0, top - i * stride), end = Math.min(g.logicalHeight, top + rect.height - i * stride); if (end <= y) continue;
      pages[i].drawRectangle({ x: (rect.left - origin.left + inset + g.sourceX) * g.scaleX, y: g.pdfHeight - (end + g.sourceY) * g.scaleY, width: rect.width * g.scaleX, height: (end - y) * g.scaleY,
        ...(border ? { borderColor: fill.color, borderWidth: .5, borderOpacity: fill.opacity } : { color: fill.color, opacity: fill.opacity }) });
    }
  };
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (el.closest(ignored) || el.closest('.tiptap-mathematics-render')) continue;
    const s = getComputedStyle(el); if (!shown(el)) continue;
    for (const rect of el.getClientRects()) box(rect, paintColor(s.backgroundColor));
    if (el.matches('td,th')) box(el.getBoundingClientRect(), paintColor(s.borderBottomColor), true);
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      const r = el.getBoundingClientRect(), at = locate(r); if (at.page) { at.page.drawRectangle({ x: at.x, y: g.pdfHeight - (at.y + r.height) * g.scaleY, width: r.width * g.scaleX, height: r.height * g.scaleY, borderColor: rgb(.35, .35, .35), borderWidth: .7 }); if (el.checked) at.page.drawText('x', { x: at.x + 2, y: g.pdfHeight - (at.y + r.height - 2) * g.scaleY, size: r.height * g.scaleY, font: fonts.regular }); }
    }
  }
  for (const math of root.querySelectorAll<HTMLElement>('.tiptap-mathematics-render')) {
    const html = math.querySelector<HTMLElement>('.katex-html') ?? math, rect = html.getBoundingClientRect(), at = locate(rect);
    if (at.page && rect.width && rect.height) at.page.drawImage(await pdf.embedPng(await rasterAtom(html, rect)), { x: at.x, y: g.pdfHeight - (at.y + rect.height) * g.scaleY, width: rect.width * g.scaleX, height: rect.height * g.scaleY });
  }
  for (const image of root.querySelectorAll<HTMLImageElement>('img[src]:not(.ProseMirror-separator)')) {
    const rect = image.getBoundingClientRect(), at = locate(rect); if (!at.page || !rect.width || !rect.height) continue;
    const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight; c.getContext('2d')!.drawImage(image, 0, 0);
    const png = new Uint8Array(await (await new Promise<Blob>(resolve => c.toBlob(value => resolve(value!)))).arrayBuffer());
    at.page.drawImage(await pdf.embedPng(png), { x: at.x, y: g.pdfHeight - (at.y + rect.height) * g.scaleY, width: rect.width * g.scaleX, height: rect.height * g.scaleY });
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text, parent = node.parentElement!;
    if (!node.data.trim() || parent.closest(ignored + ',.tiptap-mathematics-render')) continue;
    const s = getComputedStyle(parent); if (!shown(parent)) continue;
    const bold = Number.parseInt(s.fontWeight) >= 600 || s.fontWeight === 'bold', italic = s.fontStyle === 'italic';
    const mono = /mono|courier|consolas/i.test(s.fontFamily), key = mono ? `mono${bold ? 'Bold' : ''}${italic ? 'Italic' : ''}` : bold ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular';
    const font = fonts[key], size = Number.parseFloat(s.fontSize), range = document.createRange();
    for (const match of node.data.matchAll(/\S+|\s+/g)) {
      const text = match[0]; if (!text.trim()) continue; range.setStart(node, match.index); range.setEnd(node, match.index + text.length);
      const rectangles = [...range.getClientRects()];
      const pieces = rectangles.length > 1 ? [...text].map((character, i, chars) => ({ text: character, start: match.index + chars.slice(0, i).join('').length })) : [{ text, start: match.index }];
      for (const piece of pieces) {
        range.setStart(node, piece.start); range.setEnd(node, piece.start + piece.text.length); const rect = range.getBoundingClientRect(), at = locate(rect);
        if (!at.page || !rect.width || !piece.text.trim()) continue;
        const y = g.pdfHeight - (baseline(rect, s, measure) - origin.top + inset + g.sourceY - at.index * stride) * g.scaleY;
        try {
          font.encodeText(piece.text); const natural = font.widthOfTextAtSize(piece.text, size * g.scaleY), ratio = rect.width * g.scaleX / natural;
          at.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(ratio, 0, 0, 1, at.x, 0));
          at.page.drawText(piece.text, { x: 0, y, size: size * g.scaleY, font, ...(paintColor(s.color) ?? { color: rgb(0, 0, 0) }) }); at.page.pushOperators(popGraphicsState());
        } catch {
          // Unsupported Unicode is visibly preserved without replacing all prose with a screenshot.
          const span = document.createElement('span'); span.style.cssText = s.cssText; span.style.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`; span.style.color = s.color; span.textContent = piece.text;
          span.style.position = 'fixed'; span.style.left = '-50000px'; span.style.top = '0'; document.body.append(span);
          try { const image = await pdf.embedPng(await rasterAtom(span, span.getBoundingClientRect())); at.page.drawImage(image, { x: at.x, y: g.pdfHeight - (at.y + rect.height) * g.scaleY, width: rect.width * g.scaleX, height: rect.height * g.scaleY }); rasterGlyphs++; }
          finally { span.remove(); }
        }
        if (s.textDecorationLine.includes('underline') || parent.closest('u,a')) at.page.drawLine({ start: { x: at.x, y: y - 1.5 }, end: { x: at.x + rect.width * g.scaleX, y: y - 1.5 }, color: paintColor(s.color)?.color ?? rgb(0, 0, 0), thickness: .6 });
        const link = parent.closest('a'); if (link && /^https?:\/\//i.test(link.href)) {
          const annotation = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [at.x, g.pdfHeight - (at.y + rect.height) * g.scaleY, at.x + rect.width * g.scaleX, g.pdfHeight - at.y * g.scaleY], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(link.href) } });
          const ref = pdf.context.register(annotation); const annots = at.page.node.Annots(); if (annots) annots.push(ref); else at.page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
        }
      }
    }
  }
  for (const item of root.querySelectorAll<HTMLElement>('li:not([data-type="taskItem"])')) {
    if (item.querySelector(':scope > label > input[type="checkbox"]')) continue;
    const rect = item.getBoundingClientRect(), at = locate(rect), size = Number.parseFloat(getComputedStyle(item).fontSize) * g.scaleY;
    const list = item.parentElement!, index = [...list.children].indexOf(item) + Number(list.getAttribute('start') ?? 1), text = list.tagName === 'OL' ? `${index}.` : '•';
    if (at.page) at.page.drawText(text, { x: at.x - size * 1.1, y: g.pdfHeight - at.y * g.scaleY - size, size, font: fonts.regular });
  }
  return { rasterGlyphs };
}
