import { drawPdfShape } from './drawPdfShape.ts';
import { drawPdfImage } from './drawPdfImage.ts';
import { visibleObjects, drawTextObject, type NotebookPdfExportResult, type NotebookExportImage } from './notebookPdfExport.ts';
import { drawPdfStroke } from './drawPdfStroke.ts';
import { PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, concatTransformationMatrix, type PDFPage } from 'pdf-lib';
import type { DrawingData, NotebookObject, Stroke } from '../../components/notebook/engine/drawingTypes';
import type { PdfPageState } from '@/types/notebook';
import { normalizePdfPageState } from './pdfPageOperations.ts';
import { pdfSurroundingGeometry } from '../../components/notebook/engine/pdfCoordinates.ts';
import { resolvePageNoteSpace } from '../../lib/pageProperties.ts';
import { currentPresentationTheme, presentationData, presentationImage } from '../../lib/themePresentation.ts';
import type { PanvasTheme } from '../../lib/theme.ts';

export interface PdfAnnotationRenderResult {
  bytes: Uint8Array;
  exportedObjects: number;
  unsupportedObjects: number;
  warnings: string[];
}

function drawStroke(page: PDFPage, stroke: Stroke): number { drawPdfStroke(page, stroke); return stroke.points.length > 1 ? 1 : 0; }


export async function renderPdfAnnotations(
  originalBytes: ArrayBuffer | Uint8Array,
  drawingsByPage: ReadonlyArray<DrawingData | null>,
  pageState?: PdfPageState,
  loadImage?: (fileId: string) => Promise<NotebookExportImage | undefined>,
  theme: PanvasTheme = currentPresentationTheme(),
): Promise<PdfAnnotationRenderResult> {
  const document = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
  const normalizedState = normalizePdfPageState(pageState, document.getPageCount());
  const sourcePages = document.getPages();
  const orderedPages = await document.copyPages(document, normalizedState.pageOrder.map(page => page - 1));
  document.removePage(0);
  while (document.getPageCount() > 0) document.removePage(0);
  orderedPages.forEach(page => document.addPage(page));
  const fonts = { regular: await document.embedFont(StandardFonts.Helvetica), bold: await document.embedFont(StandardFonts.HelveticaBold), italic: await document.embedFont(StandardFonts.HelveticaOblique), boldItalic: await document.embedFont(StandardFonts.HelveticaBoldOblique) };
  const report: NotebookPdfExportResult = { success: true, bytes: null, pageCount: 0, exportedObjects: 0, approximatedObjects: 0, unsupportedObjects: 0, warnings: [], sectionDividers: [], notebookCover: null };
  const imageCache = new Map<string, Awaited<ReturnType<typeof document.embedPng>>>();
  let exportedObjects = 0;
  let unsupportedObjects = 0;

  for (let pageIndex = 0; pageIndex < document.getPageCount(); pageIndex += 1) {
    const sourcePageNumber = normalizedState.pageOrder[pageIndex];
    const drawing = presentationData(drawingsByPage[sourcePageNumber - 1], theme);
    const objects = drawing ? visibleObjects(drawing) : [];
    const pdfPage = document.getPage(pageIndex);
    // Enlarge only the exported sheet. Translate existing PDF streams upward
    // without scaling/rasterizing them; top-left annotation coordinates stay fixed.
    const sourceWidth = pdfPage.getWidth();
    const sourceHeight = pdfPage.getHeight();
    const geometry = pdfSurroundingGeometry({ width: sourceWidth, height: sourceHeight }, 0, resolvePageNoteSpace(drawing?.properties ?? {}));
    const hasNoteSpace = Object.values(geometry.noteSpace).some(value => value > 0);
    if (hasNoteSpace) {
      const width = geometry.sheet.width;
      const height = geometry.sheet.height;
      // Preserve the old crop: hidden source marks must not leak into new paper.
      pdfPage.pushOperators();
      const crop = pdfPage.getCropBox();
      const start = document.context.register(document.context.contentStream([pushGraphicsState(), rectangle(crop.x, crop.y, crop.width, crop.height), clip(), endPath()]));
      const end = document.context.register(document.context.contentStream([popGraphicsState()]));
      pdfPage.node.wrapContentStreams(start, end);
      pdfPage.setSize(width, height);
      pdfPage.setCropBox(0, 0, width, height);
      pdfPage.translateContent(geometry.noteSpace.left, geometry.noteSpace.bottom);
      // Start annotation commands outside the translated original content streams.
      pdfPage.resetPosition();
      if (pdfPage.node.Annots()?.size()) report.warnings.push({ code: 'pdf-interactive-annotations', message: 'Expanded PDF: original interactive links/form annotations retain their original PDF coordinates; verify those overlays in the exported file.' });
    }
    const intrinsicRotation = sourcePages[sourcePageNumber - 1]?.getRotation().angle ?? 0;
    const requestedRotation = normalizedState.rotations[sourcePageNumber] ?? 0;
    if (requestedRotation) pdfPage.setRotation(degrees((intrinsicRotation + requestedRotation) % 360));
    if (hasNoteSpace) pdfPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, geometry.noteSpace.left, -geometry.noteSpace.top));
    for (const object of objects as NotebookObject[]) {
      if (object.type === 'stroke') exportedObjects += drawStroke(pdfPage, object);
      else if (object.type === 'shape') { drawPdfShape(pdfPage, object); exportedObjects += 1; }
      else if (object.type === 'text') {
        drawTextObject(pdfPage, object, {
          logicalWidth: geometry.sheet.width,
          logicalHeight: geometry.sheet.height,
          pdfWidth: geometry.sheet.width,
          pdfHeight: geometry.sheet.height,
          scaleX: 1,
          scaleY: 1,
          sourceX: geometry.offset.x,
          sourceY: geometry.offset.y,
          sourceWidth,
          sourceHeight,
        }, fonts, report, String(sourcePageNumber)); exportedObjects += 1;
      } else if (object.type === 'image') {
        try {
          let image = imageCache.get(object.fileId);
          if (!image) {
            const originalAsset = await loadImage?.(object.fileId); if (!originalAsset) throw new Error('asset unavailable');
            const asset = await presentationImage(originalAsset, theme);
            image = /png/i.test(asset.mimeType) ? await document.embedPng(asset.data) : /jpe?g/i.test(asset.mimeType) ? await document.embedJpg(asset.data) : undefined;
            if (!image) throw new Error('unsupported image format'); imageCache.set(object.fileId, image);
          }
          drawPdfImage(pdfPage, image, object); exportedObjects += 1;
        } catch (error) { unsupportedObjects += 1; report.warnings.push({ code: 'image-skipped', message: `Image ${object.id}: ${error instanceof Error ? error.message : 'could not export'}` }); }
      }
      else unsupportedObjects += 1;
    }
    if (hasNoteSpace) pdfPage.pushOperators(popGraphicsState());
    unsupportedObjects += drawing?.audioNotes?.length ?? 0;
  }

  return {
    bytes: await document.save(),
    exportedObjects,
    unsupportedObjects,
    warnings: [...report.warnings.map(w => w.message), ...(unsupportedObjects > 0 ? [`${unsupportedObjects} unsupported attachment or unavailable image(s) were not included.`] : [])],
  };
}
