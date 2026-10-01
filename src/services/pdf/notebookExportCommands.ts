import { canvasRepository } from '@/repositories/CanvasRepository';
import { notebookRepository } from '@/repositories/NotebookRepository';
import { useUIStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { workspaceRepository } from '@/repositories/WorkspaceRepository';
import { resolvePageProperties } from '@/lib/pageProperties';
import { currentPresentationTheme } from '@/lib/themePresentation';
import { createEmptyDrawingData, type DrawingData } from '@/components/notebook/engine/drawingTypes';
import { exportNotebookPdf, orderNotebookPages, type NotebookPdfExportResult, type NotebookPdfPageInput, type NotebookPdfSectionInput } from './notebookPdfExport';
import { deliverPreparedPdf, downloadPdfResult, preparePdfPrintDelivery } from './pdfDelivery';
import {
  resolveNotebookExportTarget,
  resolvePageExportTarget,
  resolveSectionExportTarget,
  type NotebookExportCatalog,
  type NotebookExportTarget,
  type PageExportTarget,
  type SectionExportTarget,
} from './notebookExportTargets';

export interface NotebookPdfCommandOptions {
  drawingOverrides?: Record<string, DrawingData>;
}

async function loadCanonicalExportCatalog(): Promise<NotebookExportCatalog> {
  const userId = useAuthStore.getState().user?.id ?? null;
  const [workspaces, notebooks, notebookSections, notebookPages] = await Promise.all([
    workspaceRepository.getAll(userId),
    notebookRepository.getAll(userId),
    notebookRepository.getSections(userId),
    notebookRepository.getPages(userId),
  ]);
  return { workspaces, notebooks, notebookSections, notebookPages };
}

async function generatePage(target: PageExportTarget, options: NotebookPdfCommandOptions = {}) {
  const theme = currentPresentationTheme();
  const catalog = await loadCanonicalExportCatalog();
  const { page, notebook, workspaceId } = resolvePageExportTarget(catalog, target);
  if (page.type === 'pdf') throw new Error('Imported PDF pages use the annotated PDF export action.');
  const drawing = options.drawingOverrides?.[page.id]
    ?? await notebookRepository.loadDrawingData(workspaceId, notebook.id, page.id) as DrawingData
    ?? createEmptyDrawingData();
  const properties = resolvePageProperties(notebook, page, drawing.properties);
  const result = await exportNotebookPdf({
    theme,
    pages: [{ id: page.id, title: page.title, properties, drawing: { ...drawing, properties } }],
    loadImage: fileId => canvasRepository.getImage(fileId),
  });
  return { result, fileName: page.title };
}

async function generateNotebook(target: NotebookExportTarget, options: NotebookPdfCommandOptions = {}) {
  const theme = currentPresentationTheme();
  const catalog = await loadCanonicalExportCatalog();
  const { notebook, workspaceId } = resolveNotebookExportTarget(catalog, target);
  const sections = catalog.notebookSections.filter(section => section.notebookId === notebook.id);
  const sectionIds = new Set(sections.map(section => section.id));
  const ordered = orderNotebookPages(sections, catalog.notebookPages.filter(page => sectionIds.has(page.sectionId)));
  const skippedPdfPages = ordered.filter(page => page.type === 'pdf');
  const inputsBySection = new Map<string, NotebookPdfPageInput[]>();
  for (const page of ordered.filter(item => item.type !== 'pdf')) {
    const drawing = options.drawingOverrides?.[page.id]
      ?? await notebookRepository.loadDrawingData(workspaceId, notebook.id, page.id) as DrawingData
      ?? createEmptyDrawingData();
    const properties = resolvePageProperties(notebook, page, drawing.properties);
    const inputs = inputsBySection.get(page.sectionId) ?? [];
    inputs.push({ id: page.id, title: page.title, properties, drawing: { ...drawing, properties } });
    inputsBySection.set(page.sectionId, inputs);
  }
  const sectionInputs: NotebookPdfSectionInput[] = sections
    .filter(section => !section.deletedAt)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map(section => ({
      id: section.id,
      name: section.name,
      notebookName: notebook.name,
      pages: inputsBySection.get(section.id) ?? [],
    }));
  const result = await exportNotebookPdf({
    theme,
    sections: sectionInputs,
    cover: { notebookName: notebook.name, cover: notebook.cover },
    loadImage: fileId => canvasRepository.getImage(fileId),
  });
  if (skippedPdfPages.length) {
    result.unsupportedObjects += skippedPdfPages.length;
    result.warnings.push({
      code: 'pdf-owned-pages-skipped',
      message: `${skippedPdfPages.length} imported PDF page record(s) were skipped by standard notebook export.`,
    });
  }
  return { result, fileName: notebook.name };
}

async function generateSection(target: SectionExportTarget, options: NotebookPdfCommandOptions = {}) {
  const theme = currentPresentationTheme();
  const catalog = await loadCanonicalExportCatalog();
  const { section, notebook, workspaceId } = resolveSectionExportTarget(catalog, target);
  const ordered = orderNotebookPages(
    [section],
    catalog.notebookPages.filter(page => page.sectionId === section.id),
  );
  const skippedPdfPages = ordered.filter(page => page.type === 'pdf');
  const pages: NotebookPdfPageInput[] = [];
  for (const page of ordered.filter(item => item.type !== 'pdf')) {
    const drawing = options.drawingOverrides?.[page.id]
      ?? await notebookRepository.loadDrawingData(workspaceId, notebook.id, page.id) as DrawingData
      ?? createEmptyDrawingData();
    const properties = resolvePageProperties(notebook, page, drawing.properties);
    pages.push({ id: page.id, title: page.title, properties, drawing: { ...drawing, properties } });
  }
  const result = await exportNotebookPdf({
    theme,
    sections: [{ id: section.id, name: section.name, notebookName: notebook.name, pages }],
    loadImage: fileId => canvasRepository.getImage(fileId),
  });
  if (skippedPdfPages.length) {
    result.unsupportedObjects += skippedPdfPages.length;
    result.warnings.push({
      code: 'pdf-owned-pages-skipped',
      message: `${skippedPdfPages.length} imported PDF page record(s) were skipped by standard section export.`,
    });
  }
  return { result, fileName: `${notebook.name}-${section.name}` };
}

function requireBytes(result: NotebookPdfExportResult): Uint8Array {
  if (!result.success || !result.bytes) throw new Error(result.error || 'PDF generation failed.');
  return result.bytes;
}

function reportExport(result: NotebookPdfExportResult): void {
  const reduced = result.approximatedObjects + result.unsupportedObjects;
  useUIStore.getState().showToast(
    reduced ? `PDF exported with ${reduced} fidelity warning${reduced === 1 ? '' : 's'}.` : 'PDF exported.',
    reduced ? 'info' : 'success',
  );
}

async function runDownload(generate: () => Promise<{ result: NotebookPdfExportResult; fileName: string }>): Promise<void> {
  useUIStore.getState().showToast('Preparing PDF…', 'info');
  try {
    const { result, fileName } = await generate();
    downloadPdfResult(result, fileName);
    reportExport(result);
  } catch (error) {
    useUIStore.getState().showToast(error instanceof Error ? error.message : 'PDF export failed.', 'error');
  }
}

async function runPrint(generate: () => Promise<{ result: NotebookPdfExportResult }>): Promise<void> {
  const delivery = preparePdfPrintDelivery();
  if (!delivery) {
    useUIStore.getState().showToast('The print window was blocked. Allow popups for Panvas and try again.', 'error');
    return;
  }
  useUIStore.getState().showToast('Preparing printable PDF…', 'info');
  try {
    const { result } = await generate();
    const outcome = await deliverPreparedPdf(requireBytes(result), delivery);
    useUIStore.getState().showToast(
      outcome.status === 'cancelled' ? 'Printing cancelled.' : 'Print dialog opened. Choose Print or Cancel in the system dialog.',
      'info',
    );
  } catch (error) {
    if (delivery.kind === 'browser' && !delivery.target.closed) delivery.target.close();
    useUIStore.getState().showToast(error instanceof Error ? error.message : 'Printing failed.', 'error');
  }
}

export const exportPageToPdf = (target: PageExportTarget, options?: NotebookPdfCommandOptions) =>
  runDownload(() => generatePage(target, options));
export const exportNotebookToPdf = (target: NotebookExportTarget, options?: NotebookPdfCommandOptions) =>
  runDownload(() => generateNotebook(target, options));
export const exportSectionToPdf = (target: SectionExportTarget, options?: NotebookPdfCommandOptions) =>
  runDownload(() => generateSection(target, options));
export const printPage = (target: PageExportTarget, options?: NotebookPdfCommandOptions) =>
  runPrint(() => generatePage(target, options));
export const printNotebook = (target: NotebookExportTarget, options?: NotebookPdfCommandOptions) =>
  runPrint(() => generateNotebook(target, options));
export const printSection = (target: SectionExportTarget, options?: NotebookPdfCommandOptions) =>
  runPrint(() => generateSection(target, options));
