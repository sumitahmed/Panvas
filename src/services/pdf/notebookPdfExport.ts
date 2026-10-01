import { drawPdfShape } from './drawPdfShape.ts';
import { concatTransformationMatrix, pushGraphicsState, popGraphicsState, clip, endPath, rectangle } from 'pdf-lib';
import { getStickyNoteColor, getStickyNoteOpacity, getStickyNoteShape, getStickyPaper } from '../../components/notebook/stickyNotes.ts';
import { drawPdfLine } from './drawPdfLine.ts';
import { drawPdfStroke } from './drawPdfStroke.ts';
import { drawPdfImage } from './drawPdfImage.ts';
import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import type { DrawingData, NotebookObject, PageProperties, Shape, Stroke, TextObject } from '../../components/notebook/engine/drawingTypes.ts';
import { DEFAULT_PAGE_LAYER_ID, createDefaultPageLayer } from '../../components/notebook/engine/drawingTypes.ts';
import type { NotebookCover, NotebookPage, NotebookSection } from '../../types/notebook.ts';
import { resolveNotebookCover } from '../../lib/notebookCover.ts';
import { resolvePageNoteSpace } from '../../lib/pageProperties.ts';
import { currentPresentationTheme, presentationColor, presentationData, presentationImage } from '../../lib/themePresentation.ts';
import type { PanvasTheme } from '../../lib/theme.ts';
import { marginRuling, MARGIN_RULE_ACCENT } from '../../components/notebook/templates/marginRuling.ts';

export interface NotebookExportImage {
  mimeType: string;
  data: ArrayBuffer | Uint8Array;
}

export interface NotebookPdfPageInput {
  id: string;
  title: string;
  properties: PageProperties;
  drawing: DrawingData;
}

export interface NotebookPdfWarning {
  code: string;
  message: string;
  pageId?: string;
  objectId?: string;
}

export interface NotebookPdfSectionInput {
  id: string;
  name: string;
  notebookName: string;
  pages: NotebookPdfPageInput[];
}

export interface NotebookPdfSectionDivider {
  sectionId: string;
  sectionName: string;
  notebookName: string;
  pageIndex: number;
}

export interface NotebookPdfCoverPage {
  notebookName: string;
  coverIdentity: string;
  coverKind: 'template' | 'image';
  pageIndex: number;
}

export interface NotebookPdfExportResult {
  success: boolean;
  bytes: Uint8Array | null;
  pageCount: number;
  exportedObjects: number;
  approximatedObjects: number;
  unsupportedObjects: number;
  warnings: NotebookPdfWarning[];
  sectionDividers: NotebookPdfSectionDivider[];
  notebookCover: NotebookPdfCoverPage | null;
  error?: string;
}

export interface NotebookPdfExportInput {
  /** Current visual presentation; application chrome is not part of the sheet. */
  theme?: PanvasTheme;
  pages?: NotebookPdfPageInput[];
  sections?: NotebookPdfSectionInput[];
  /** Present only for whole-notebook export. Page and section exports omit it. */
  cover?: { notebookName: string; cover?: NotebookCover };
  loadImage?: (fileId: string) => Promise<NotebookExportImage | undefined>;
}

function dataUrlBytes(dataUrl: string): { mimeType: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  const decoded = globalThis.atob(match[2]);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return { mimeType: match[1], bytes };
}

function coverPosition(position: string): { x: number; y: number } {
  const parts = position.trim().split(/\s+/);
  const percent = (value: string | undefined) => {
    const parsed = Number.parseFloat(value ?? '50');
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) / 100 : 0.5;
  };
  return { x: percent(parts[0]), y: percent(parts[1] ?? parts[0]) };
}

function drawCoverImage(page: PDFPage, image: PDFImage, width: number, height: number, position: string) {
  const scale = Math.max(width / image.width, height / image.height);
  const drawnWidth = image.width * scale;
  const drawnHeight = image.height * scale;
  const anchor = coverPosition(position);
  page.drawImage(image, {
    x: -(drawnWidth - width) * anchor.x,
    y: -(drawnHeight - height) * (1 - anchor.y),
    width: drawnWidth,
    height: drawnHeight,
  });
}

async function drawNotebookCover(
  pdf: PDFDocument,
  coverInput: NonNullable<NotebookPdfExportInput['cover']>,
  properties: PageProperties,
  fonts: Record<string, PDFFont>,
  result: NotebookPdfExportResult,
) {
  const geometry = resolveNotebookPageGeometry(properties);
  if (!geometry) throw new Error('The notebook cover cannot use a Custom page size without stored dimensions.');
  const page = pdf.addPage([geometry.pdfWidth, geometry.pdfHeight]);
  const resolved = resolveNotebookCover(coverInput.cover);
  let renderedKind: 'template' | 'image' = resolved.kind;
  if (resolved.kind === 'image') {
    try {
      const source = dataUrlBytes(resolved.dataUrl);
      if (!source) throw new Error('invalid data URL');
      const embedded = /png/i.test(source.mimeType)
        ? await pdf.embedPng(source.bytes)
        : /jpe?g/i.test(source.mimeType)
          ? await pdf.embedJpg(source.bytes)
          : null;
      if (!embedded) throw new Error(`unsupported ${source.mimeType} image`);
      drawCoverImage(page, embedded, geometry.pdfWidth, geometry.pdfHeight, resolved.position);
    } catch (error) {
      renderedKind = 'template';
      const fallback = resolveNotebookCover(undefined);
      if (fallback.kind === 'template') page.drawRectangle({ x: 0, y: 0, width: geometry.pdfWidth, height: geometry.pdfHeight, color: color(fallback.template.endColor) });
      addWarning(result, { code: 'cover-image-approximated', message: `Notebook cover image could not be embedded and used the default cover: ${error instanceof Error ? error.message : 'unknown error'}.` });
    }
  } else {
    const bands = 32;
    for (let index = 0; index < bands; index += 1) {
      const mix = index / (bands - 1);
      page.drawRectangle({
        x: 0,
        y: geometry.pdfHeight * index / bands,
        width: geometry.pdfWidth,
        height: geometry.pdfHeight / bands + 0.5,
        color: blendedColor(resolved.template.endColor, resolved.template.startColor, mix),
      });
    }
  }
  page.drawRectangle({ x: 0, y: 0, width: geometry.pdfWidth * 0.075, height: geometry.pdfHeight, color: color('#000000'), opacity: 0.2 });
  page.drawLine({ start: { x: geometry.pdfWidth * 0.9, y: geometry.pdfHeight * 0.72 }, end: { x: geometry.pdfWidth * 0.9, y: geometry.pdfHeight * 0.9 }, thickness: 1, color: color('#ffffff'), opacity: 0.35 });
  const title = coverInput.notebookName;
  const fontSize = Math.min(30, Math.max(18, 360 / Math.max(10, title.length)));
  const titleWidth = fonts.bold.widthOfTextAtSize(title, fontSize);
  const bannerWidth = Math.min(geometry.pdfWidth * 0.74, Math.max(titleWidth + 44, geometry.pdfWidth * 0.38));
  const bannerX = (geometry.pdfWidth - bannerWidth) / 2;
  const bannerY = geometry.pdfHeight * 0.11;
  page.drawRectangle({ x: bannerX, y: bannerY, width: bannerWidth, height: fontSize + 30, color: color('#000000'), opacity: 0.28 });
  page.drawText(title, { x: Math.max(bannerX + 22, (geometry.pdfWidth - titleWidth) / 2), y: bannerY + 15, size: fontSize, font: fonts.bold, color: color('#ffffff') });
  result.notebookCover = { notebookName: title, coverIdentity: resolved.identity, coverKind: renderedKind, pageIndex: result.pageCount };
  result.pageCount += 1;
}

function blendedColor(from: string, to: string, amount: number) {
  const components = (value: string) => {
    const parsed = Number.parseInt(value.slice(1), 16);
    return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255];
  };
  const a = components(from); const b = components(to);
  return rgb(...a.map((value, index) => (value + (b[index] - value) * amount) / 255) as [number, number, number]);
}

export interface NotebookPageGeometry {
  logicalWidth: number;
  logicalHeight: number;
  pdfWidth: number;
  pdfHeight: number;
  scaleX: number;
  scaleY: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
}

const PHYSICAL_POINTS = {
  A3: { width: 841.8898, height: 1190.5512 },
  A4: { width: 595.2756, height: 841.8898 },
  A5: { width: 419.5276, height: 595.2756 },
  Letter: { width: 612, height: 792 },
} as const;

const LOGICAL_PIXELS = {
  A3: { width: 1123, height: 1587 },
  A4: { width: 794, height: 1123 },
  A5: { width: 595, height: 842 },
  Letter: { width: 816, height: 1056 },
} as const;

export function resolveNotebookPageGeometry(properties: PageProperties): NotebookPageGeometry | null {
  if (properties.pageSize === 'Custom') return null;
  const physical = PHYSICAL_POINTS[properties.pageSize];
  const logical = LOGICAL_PIXELS[properties.pageSize];
  const landscape = properties.orientation === 'landscape';
  const pdfWidth = landscape ? physical.height : physical.width;
  const basePdfHeight = landscape ? physical.width : physical.height;
  const logicalWidth = landscape ? logical.height : logical.width;
  const baseLogicalHeight = landscape ? logical.width : logical.height;
  const noteSpace = resolvePageNoteSpace(properties);
  const scaleX = pdfWidth / logicalWidth;
  const scaleY = basePdfHeight / baseLogicalHeight;
  const surfaceLogicalWidth = noteSpace.left + logicalWidth + noteSpace.right;
  const logicalHeight = noteSpace.top + baseLogicalHeight + noteSpace.bottom;
  const surfacePdfWidth = surfaceLogicalWidth * scaleX;
  const pdfHeight = logicalHeight * scaleY;
  return {
    logicalWidth: surfaceLogicalWidth,
    logicalHeight,
    pdfWidth: surfacePdfWidth,
    pdfHeight,
    scaleX,
    scaleY,
    sourceX: noteSpace.left,
    sourceY: noteSpace.top,
    sourceWidth: logicalWidth,
    sourceHeight: baseLogicalHeight,
  };
}

export function orderNotebookPages(sections: NotebookSection[], pages: NotebookPage[]): NotebookPage[] {
  const sectionOrder = new Map(
    sections.filter(section => !section.deletedAt).sort((a, b) => a.order - b.order).map((section, index) => [section.id, index]),
  );
  return pages
    .filter(page => !page.deletedAt)
    .sort((a, b) => {
      const sectionDelta = (sectionOrder.get(a.sectionId) ?? Number.MAX_SAFE_INTEGER)
        - (sectionOrder.get(b.sectionId) ?? Number.MAX_SAFE_INTEGER);
      return sectionDelta || a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    });
}

export function getSectionDividerContent(section: NotebookPdfSectionInput) {
  return { sectionName: section.name, notebookName: section.notebookName };
}

function drawSectionDivider(
  pdf: PDFDocument,
  section: NotebookPdfSectionInput,
  properties: PageProperties,
  fonts: Record<string, PDFFont>,
  result: NotebookPdfExportResult,
) {
  const geometry = resolveNotebookPageGeometry(properties);
  if (!geometry) throw new Error(`Section “${section.name}” uses Custom size, but the current page schema stores no custom dimensions.`);
  const page = pdf.addPage([geometry.pdfWidth, geometry.pdfHeight]);
  page.drawRectangle({ x: 0, y: 0, width: geometry.pdfWidth, height: geometry.pdfHeight, color: color(properties.paperColor, '#ffffff') });
  const { sectionName, notebookName } = getSectionDividerContent(section);
  const titleSize = 30;
  const supportingSize = 12;
  const titleWidth = fonts.bold.widthOfTextAtSize(sectionName, titleSize);
  const notebookWidth = fonts.regular.widthOfTextAtSize(notebookName, supportingSize);
  const centerY = geometry.pdfHeight * 0.56;
  page.drawText(sectionName, {
    x: Math.max(36, (geometry.pdfWidth - titleWidth) / 2),
    y: centerY,
    size: titleSize,
    font: fonts.bold,
    color: color('#202124'),
  });
  page.drawLine({
    start: { x: geometry.pdfWidth * 0.34, y: centerY - 20 },
    end: { x: geometry.pdfWidth * 0.66, y: centerY - 20 },
    thickness: 0.8,
    color: color(properties.ruleLineColor, '#c8c3b8'),
    opacity: 0.8,
  });
  page.drawText(notebookName, {
    x: Math.max(36, (geometry.pdfWidth - notebookWidth) / 2),
    y: centerY - 45,
    size: supportingSize,
    font: fonts.regular,
    color: color('#666666'),
  });
  result.sectionDividers.push({
    sectionId: section.id,
    sectionName,
    notebookName,
    pageIndex: result.pageCount,
  });
  result.pageCount += 1;
}

function color(value: string | null | undefined, fallback = '#000000') {
  const match = /^#([0-9a-f]{6})$/i.exec(value || '') ?? /^#([0-9a-f]{6})$/i.exec(fallback)!;
  const n = Number.parseInt(match[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function opacity(value: number | undefined): number {
  return Math.max(0, Math.min(1, value ?? 1));
}

function point(geometry: NotebookPageGeometry, x: number, y: number) {
  return { x: x * geometry.scaleX, y: geometry.pdfHeight - y * geometry.scaleY };
}

function addWarning(result: NotebookPdfExportResult, warning: NotebookPdfWarning) {
  result.warnings.push(warning);
}

function drawTemplate(page: PDFPage, properties: PageProperties, g: NotebookPageGeometry, result: NotebookPdfExportResult, pageId: string, theme: PanvasTheme) {
  const ink = color(properties.ruleLineColor, '#e0e0e0');
  const line = (x1: number, y1: number, x2: number, y2: number, thickness = 0.7) => {
    const a = point(g, x1, y1); const b = point(g, x2, y2);
    page.drawLine({ start: a, end: b, thickness, color: ink, opacity: 0.82 });
  };
  const ruled = (start: number, spacing: number) => {
    for (let y = start; y < g.logicalHeight - 20; y += spacing) line(0, y, g.logicalWidth, y);
  };
  switch (properties.template) {
    case 'Blank': break;
    case 'Ruled': ruled(60, 28); break;
    case 'Narrow ruled': ruled(50, 20); break;
    case 'Wide ruled': ruled(64, 36); break;
    case 'Large ruled with margin':
    case 'Double margin ruled': {
      const ruling = marginRuling(g.logicalWidth, g.logicalHeight, properties.template);
      const marginLine = (x1: number, y1: number, x2: number, y2: number, paint = ink) => page.drawLine({
        start: point(g, x1, y1), end: point(g, x2, y2), thickness: g.scaleX, color: paint, opacity: 0.85,
      });
      ruling.horizontal.forEach(y => marginLine(0, y, g.logicalWidth, y));
      ruling.margins.forEach((x, index) => {
        const paint = properties.template === 'Double margin ruled' && index === 0
          ? color(presentationColor(MARGIN_RULE_ACCENT, theme)) : ink;
        marginLine(x, ruling.top, x, ruling.bottom, paint);
      });
      break;
    }
    case 'Small grid':
    case 'Large grid':
    case 'Engineering': {
      const spacing = properties.template === 'Small grid' ? 14 : properties.template === 'Large grid' ? 28 : 8;
      for (let x = spacing; x < g.logicalWidth; x += spacing) line(x, 0, x, g.logicalHeight, properties.template === 'Engineering' && x % 40 === 0 ? 0.8 : 0.35);
      for (let y = spacing; y < g.logicalHeight; y += spacing) line(0, y, g.logicalWidth, y, properties.template === 'Engineering' && y % 40 === 0 ? 0.8 : 0.35);
      break;
    }
    case 'Dotted':
      for (let x = 8; x < g.logicalWidth; x += 16) for (let y = 8; y < g.logicalHeight; y += 16) {
        const p = point(g, x, y); page.drawCircle({ x: p.x, y: p.y, size: 0.65, color: ink, opacity: 0.8 });
      }
      break;
    case 'Cornell': {
      const cue = g.logicalWidth * 0.28; const summary = g.logicalHeight * 0.82;
      line(0, 54, g.logicalWidth, 54, 1); line(cue, 54, cue, summary, 1); line(0, summary, g.logicalWidth, summary, 1);
      for (let y = 82; y < summary; y += 28) line(cue, y, g.logicalWidth, y);
      break;
    }
    default: {
      // Complex study/planner paper remains recognizable through its principal grid/ruled structure.
      const planning = ['Daily planner', 'Weekly planner', 'Monthly planner', 'Calendar'].includes(properties.template);
      if (planning) {
        const columns = properties.template === 'Weekly planner' ? 7 : properties.template === 'Monthly planner' || properties.template === 'Calendar' ? 7 : 2;
        const rows = properties.template === 'Monthly planner' || properties.template === 'Calendar' ? 6 : 16;
        for (let x = 20; x <= g.logicalWidth - 20; x += (g.logicalWidth - 40) / columns) line(x, 55, x, g.logicalHeight - 25);
        for (let y = 55; y <= g.logicalHeight - 25; y += (g.logicalHeight - 80) / rows) line(20, y, g.logicalWidth - 20, y);
      } else {
        ruled(60, properties.template === 'Checklist' || properties.template === 'To-do' ? 32 : 28);
      }
      addWarning(result, { code: 'template-approximated', message: `${properties.template} paper was exported with a simplified vector layout.`, pageId });
      break;
    }
  }
  const margin = properties.margins === 'No Margin' ? 0 : properties.margins === 'Narrow' ? 32 : properties.margins === 'Wide' ? 104 : 64;
  if (margin > 0) {
    const left = g.sourceX + margin;
    page.drawRectangle({ x: left * g.scaleX, y: point(g, 0, g.sourceY + g.sourceHeight - margin).y, width: (g.sourceWidth - margin * 2) * g.scaleX, height: (g.sourceHeight - margin * 2) * g.scaleY, borderColor: ink, borderWidth: 0.45, borderDashArray: [2, 2], opacity: 0.35 });
  }
}

export function visibleObjects(data: DrawingData): NotebookObject[] {
  const objects = data.version === 1 ? [...(data.strokes ?? []), ...(data.shapes ?? [])] : [...(data.objects ?? [])];
  const layers = data.layers?.length ? [...data.layers].sort((a, b) => a.order - b.order) : [createDefaultPageLayer()];
  const visible = new Set(layers.filter(layer => layer.visible).map(layer => layer.id));
  const order = new Map(layers.map((layer, index) => [layer.id, index]));
  return objects
    .map((object, index) => ({ object, index, layer: order.get(object.layerId ?? DEFAULT_PAGE_LAYER_ID) ?? 0 }))
    .filter(entry => visible.has(entry.object.layerId ?? DEFAULT_PAGE_LAYER_ID))
    .sort((a, b) => a.layer - b.layer || ({ image: 0, stroke: 1, shape: 2, text: 3 }[a.object.type] - { image: 0, stroke: 1, shape: 2, text: 3 }[b.object.type]) || a.index - b.index)
    .map(entry => entry.object);
}

function drawStroke(page: PDFPage, stroke: Stroke, g: NotebookPageGeometry) { drawPdfStroke(page, stroke, g.scaleX, g.scaleY); }

function rotated(x: number, y: number, cx: number, cy: number, angle: number) {
  const r = angle * Math.PI / 180; const dx = x - cx; const dy = y - cy;
  return { x: cx + dx * Math.cos(r) - dy * Math.sin(r), y: cy + dx * Math.sin(r) + dy * Math.cos(r) };
}

function drawShape(page: PDFPage, shape: Shape, g: NotebookPageGeometry, result: NotebookPdfExportResult, pageId: string) { drawPdfShape(page, shape, g.scaleX, g.scaleY); }

type TextRun = { text: string; bold: boolean; italic: boolean; size: number; color: string };
type TextLine = { runs: TextRun[]; align: 'left' | 'center' | 'right'; prefix?: string };

function textLines(content: any, result: NotebookPdfExportResult, pageId: string, objectId: string): TextLine[] {
  const lines: TextLine[] = [];
  const walk = (node: any, prefix?: string) => {
    if (!node || typeof node !== 'object') return;
    if (['table', 'tableRow', 'tableCell', 'tableHeader', 'codeBlock', 'taskList', 'taskItem'].includes(node.type)) {
      addWarning(result, { code: 'rich-text-approximated', message: `${node.type} content was flattened for PDF export.`, pageId, objectId });
    }
    if (['paragraph', 'heading', 'listItem', 'taskItem', 'codeBlock'].includes(node.type)) {
      const runs: TextRun[] = [];
      const collect = (child: any) => {
        if (child?.type === 'text') {
          const marks = child.marks ?? []; const style = marks.find((mark: any) => mark.type === 'textStyle')?.attrs ?? {};
          runs.push({ text: child.text ?? '', bold: marks.some((mark: any) => mark.type === 'bold'), italic: marks.some((mark: any) => mark.type === 'italic'), size: Number.parseFloat(style.fontSize) || (node.type === 'heading' ? Math.max(16, 26 - (node.attrs?.level ?? 1) * 3) : 14), color: style.color ?? '#000000' });
        } else if (child?.type === 'hardBreak') runs.push({ text: '\n', bold: false, italic: false, size: 14, color: '#000000' });
        else child?.content?.forEach(collect);
      };
      node.content?.forEach(collect);
      lines.push({ runs, align: ['center', 'right'].includes(node.attrs?.textAlign) ? node.attrs.textAlign : 'left', prefix });
      return;
    }
    if (node.type === 'bulletList' || node.type === 'orderedList') node.content?.forEach((child: any, index: number) => walk(child, node.type === 'bulletList' ? '• ' : `${index + 1}. `));
    else node.content?.forEach((child: any) => walk(child, prefix));
  };
  walk(content);
  return lines.length ? lines : [{ runs: [], align: 'left' }];
}

function fontFor(fonts: Record<string, PDFFont>, run: TextRun) { return fonts[run.bold ? (run.italic ? 'boldItalic' : 'bold') : (run.italic ? 'italic' : 'regular')]; }

export function drawTextObject(page: PDFPage, object: TextObject, g: NotebookPageGeometry, fonts: Record<string, PDFFont>, result: NotebookPdfExportResult, pageId: string) {
  const sticky = object.metadata?.isStickyNote === true;
  const cx = (object.x + object.width / 2) * g.scaleX, cy = page.getHeight() - (object.y + (object.height ?? 180) / 2) * g.scaleY;
  const rotation = -(object.rotation ?? 0) * Math.PI / 180;
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(Math.cos(rotation), Math.sin(rotation), -Math.sin(rotation), Math.cos(rotation), cx - cx * Math.cos(rotation) + cy * Math.sin(rotation), cy - cx * Math.sin(rotation) - cy * Math.cos(rotation)));
  if (sticky) {
    const shape = getStickyNoteShape(object), alpha = getStickyNoteOpacity(object);
    const h = object.height ?? 180;
    if (shape === 'star') {
      const vertices = '50,0 63,38 100,38 69,59 82,100 50,75 18,100 31,59 0,38 37,38'.split(' ').map((p, i) => { const [x, y] = p.split(',').map(Number); return `${i ? 'L' : 'M'}${(object.x + x / 100 * object.width) * g.scaleX} ${(object.y + y / 100 * h) * g.scaleY}`; }).join(' ') + ' Z';
      page.drawSvgPath(vertices, { x: 0, y: page.getHeight(), color: color(getStickyNoteColor(object)), opacity: alpha });
    } else drawPdfShape(page, { ...object, type: 'shape', shapeType: shape === 'circle' || shape === 'oval' ? 'ellipse' : shape === 'rounded-rect' ? 'rounded-rectangle' : 'rectangle', height: h, rotation: 0, color: getStickyNoteColor(object), fill: getStickyNoteColor(object), opacity: alpha, strokeWidth: 0 }, g.scaleX, g.scaleY);
    const paper = getStickyPaper(object);
    if (paper !== 'plain') {
      for (let y = 24; y < h; y += 24) page.drawLine({ start: point(g, object.x, object.y + y), end: point(g, object.x + object.width, object.y + y), thickness: g.scaleY * 0.7, color: color('#505050'), opacity: alpha * 0.14 });
      if (paper === 'grid') for (let x = 24; x < object.width; x += 24) page.drawLine({ start: point(g, object.x + x, object.y), end: point(g, object.x + x, object.y + h), thickness: g.scaleX * 0.7, color: color('#505050'), opacity: alpha * 0.14 });
    }
    page.pushOperators(rectangle(object.x * g.scaleX, page.getHeight() - (object.y + h) * g.scaleY, object.width * g.scaleX, h * g.scaleY), clip(), endPath());
  }
  const inset = sticky ? 14 : 0; const width = Math.max(8, (object.width - inset * 2) * g.scaleX);
  let y = point(g, object.x, object.y + inset).y;
  const warningCount = result.warnings.length;
  for (const line of textLines(object.content, result, pageId, object.id)) {
    const runs = line.prefix ? [{ text: line.prefix, bold: false, italic: false, size: 14, color: '#000000' }, ...line.runs] : line.runs;
    const lineWidth = runs.reduce((sum, run) => sum + fontFor(fonts, run).widthOfTextAtSize(run.text, run.size * g.scaleY), 0);
    let x = (object.x + inset) * g.scaleX + (line.align === 'center' ? (width - lineWidth) / 2 : line.align === 'right' ? width - lineWidth : 0);
    const maxSize = Math.max(14, ...runs.map(run => run.size)) * g.scaleY;
    y -= maxSize;
    for (const run of runs) {
      const size = run.size * g.scaleY; const font = fontFor(fonts, run);
      page.drawText(run.text, { x, y, size, font, color: color(run.color) });
      x += font.widthOfTextAtSize(run.text, size);
    }
    y -= 3 * g.scaleY;
  }
  if (result.warnings.slice(warningCount).some(warning => warning.code === 'rich-text-approximated')) result.approximatedObjects += 1;
  page.pushOperators(popGraphicsState());
}

export async function exportNotebookPdf(input: NotebookPdfExportInput): Promise<NotebookPdfExportResult> {
  const theme = input.theme ?? currentPresentationTheme();
  const result: NotebookPdfExportResult = { success: false, bytes: null, pageCount: 0, exportedObjects: 0, approximatedObjects: 0, unsupportedObjects: 0, warnings: [], sectionDividers: [], notebookCover: null };
  try {
    const sections = (input.sections ?? []).filter(section => section.pages.length > 0);
    const standalonePages = input.pages ?? [];
    if (!standalonePages.length && !sections.length) throw new Error('There are no standard notebook pages to export.');
    const pdf = await PDFDocument.create();
    const fonts = {
      regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold),
      italic: await pdf.embedFont(StandardFonts.HelveticaOblique), boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    };
    const firstPage = sections[0]?.pages[0] ?? standalonePages[0];
    if (input.cover) await drawNotebookCover(pdf, input.cover, firstPage.properties, fonts, result);
    const imageCache = new Map<string, Awaited<ReturnType<typeof pdf.embedPng>>>();
    const entries: Array<{ source: NotebookPdfPageInput; section?: NotebookPdfSectionInput }> = [];
    for (const section of sections) {
      section.pages.forEach((source, index) => entries.push({ source, section: index === 0 ? section : undefined }));
    }
    standalonePages.forEach(source => entries.push({ source }));
    for (const entry of entries) {
      const source = presentationData(entry.source, theme);
      const section = entry.section;
      if (section) drawSectionDivider(pdf, section, source.properties, fonts, result);
      const g = resolveNotebookPageGeometry(source.properties);
      if (!g) throw new Error(`Page “${source.title}” uses Custom size, but the current page schema stores no custom dimensions.`);
      const page = pdf.addPage([g.pdfWidth, g.pdfHeight]);
      page.drawRectangle({ x: 0, y: 0, width: g.pdfWidth, height: g.pdfHeight, color: color(source.properties.paperColor, '#ffffff') });
      drawTemplate(page, source.properties, g, result, source.id, theme);
      const hasNoteSpace = g.sourceX > 0 || g.sourceY > 0 || g.sourceWidth < g.logicalWidth || g.sourceHeight < g.logicalHeight;
      if (hasNoteSpace) page.drawRectangle({ x: g.sourceX * g.scaleX, y: g.pdfHeight - (g.sourceY + g.sourceHeight) * g.scaleY, width: g.sourceWidth * g.scaleX, height: g.sourceHeight * g.scaleY, borderColor: color(source.properties.ruleLineColor, '#c8c3b8'), borderWidth: 0.35, opacity: 0.45 });
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, g.sourceX * g.scaleX, -g.sourceY * g.scaleY));
      for (const object of visibleObjects(source.drawing)) {
        if (object.type === 'stroke') drawStroke(page, object, g);
        else if (object.type === 'shape') drawShape(page, object, g, result, source.id);
        else if (object.type === 'text') drawTextObject(page, object, g, fonts, result, source.id);
        else if (object.type === 'image') {
          try {
            let embedded = imageCache.get(object.fileId);
            if (!embedded) {
              const originalAsset = await input.loadImage?.(object.fileId);
              if (!originalAsset) throw new Error('asset missing');
              const asset = await presentationImage(originalAsset, theme);
              const bytes = asset.data instanceof Uint8Array ? asset.data : new Uint8Array(asset.data);
              if (/png/i.test(asset.mimeType)) embedded = await pdf.embedPng(bytes);
              else if (/jpe?g/i.test(asset.mimeType)) embedded = await pdf.embedJpg(bytes);
              else throw new Error(`unsupported format ${asset.mimeType || 'unknown'}`);
              imageCache.set(object.fileId, embedded);
            }
            drawPdfImage(page, embedded, object, g.scaleX, g.scaleY);
          } catch (error) {
            result.unsupportedObjects += 1;
            addWarning(result, { code: 'image-skipped', message: `Image could not be embedded: ${error instanceof Error ? error.message : 'unknown error'}.`, pageId: source.id, objectId: object.id });
            continue;
          }
        } else {
          result.unsupportedObjects += 1;
          const unsupported = object as unknown as NotebookObject;
          addWarning(result, { code: 'object-unsupported', message: `Unsupported object type ${unsupported.type} was skipped.`, pageId: source.id, objectId: unsupported.id });
          continue;
        }
        result.exportedObjects += 1;
      }
      page.pushOperators(popGraphicsState());
      result.pageCount += 1;
    }
    result.bytes = await pdf.save();
    result.success = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Notebook PDF export failed.';
    return result;
  }
}
