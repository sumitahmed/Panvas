import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { preparePdfPrintDelivery, printPdfBytes, type PdfPrintRuntime, type PdfPrintTarget } from '../src/services/pdf/pdfDelivery.ts';
import { runNativePdfPrint } from '../src/services/pdf/nativePrintLifecycle.ts';
import {
  createNotebookExportTarget,
  createPageExportTarget,
  createSectionExportTarget,
  resolveNotebookExportTarget,
  resolvePageExportTarget,
  resolveSectionExportTarget,
} from '../src/services/pdf/notebookExportTargets.ts';
import type { Notebook, NotebookPage, NotebookSection } from '../src/types/notebook.ts';
import type { Workspace } from '../src/types/workspace.ts';
import { getNotebookCoverIdentity } from '../src/lib/notebookCover.ts';

const readSource = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const workspace = (id: string): Workspace => ({ id, name: id, createdAt: 1, updatedAt: 1, isPinned: false, syncStatus: 'local', userId: null, deletedAt: null });
const notebook = (id: string, workspaceId: string): Notebook => ({ id, workspaceId, folderId: null, name: id, createdAt: 1, updatedAt: 1, order: 0, isExpanded: true, userId: null, deletedAt: null });
const section = (id: string, notebookId: string): NotebookSection => ({ id, notebookId, name: id, createdAt: 1, updatedAt: 1, order: 0, isExpanded: true, userId: null, deletedAt: null });
const page = (id: string, notebookId: string, sectionId = `section-${notebookId}`): NotebookPage => ({ id, notebookId, sectionId, title: id, createdAt: 1, updatedAt: 1, order: 0, userId: null, deletedAt: null });

test('inactive right-clicked Notebook B resolves independently of active Notebook A', () => {
  const notebookA = notebook('notebook-a', 'workspace-a');
  const notebookB = notebook('notebook-b', 'workspace-b');
  const clickedTarget = createNotebookExportTarget(notebookB);
  const resolved = resolveNotebookExportTarget({
    notebooks: [notebookA, notebookB],
    notebookSections: [],
    notebookPages: [],
    workspaces: [workspace('workspace-a'), workspace('workspace-b')],
  }, clickedTarget);
  assert.deepEqual(clickedTarget, { type: 'notebook', notebookId: 'notebook-b', workspaceId: 'workspace-b' });
  assert.equal(resolved.notebook.id, 'notebook-b');
  assert.equal(resolved.workspaceId, 'workspace-b');
});

test('inactive right-clicked Page B resolves through its own notebook instead of active Page A', () => {
  const notebookA = notebook('notebook-a', 'workspace-a');
  const notebookB = notebook('notebook-b', 'workspace-b');
  const sectionA = section('section-a', notebookA.id);
  const sectionB = section('section-b', notebookB.id);
  const pageA = page('page-a', notebookA.id, sectionA.id);
  const pageB = page('page-b', notebookB.id, sectionB.id);
  const clickedTarget = createPageExportTarget(pageB, sectionB, notebookB);
  const resolved = resolvePageExportTarget({
    notebooks: [notebookA, notebookB],
    notebookSections: [sectionA, sectionB],
    notebookPages: [pageA, pageB],
    workspaces: [workspace('workspace-a'), workspace('workspace-b')],
  }, clickedTarget);
  assert.deepEqual(clickedTarget, {
    type: 'page',
    pageId: 'page-b',
    sectionId: 'section-b',
    notebookId: 'notebook-b',
    workspaceId: 'workspace-b',
  });
  assert.equal(resolved.page.id, 'page-b');
  assert.equal(resolved.notebook.id, 'notebook-b');
  assert.equal(resolved.workspaceId, 'workspace-b');
});

test('nested page ownership resolves through Page -> Section -> Notebook -> Workspace', () => {
  const staleNotebook = notebook('notebook-stale', 'workspace-stale');
  const owningNotebook = notebook('notebook-owner', 'workspace-owner');
  const owningSection = section('section-owner', owningNotebook.id);
  // A moved page may retain a stale denormalized notebookId. The section is
  // the canonical parent rendered by WorkspaceTree.
  const nestedPage = page('page-nested', staleNotebook.id, owningSection.id);
  const target = createPageExportTarget(nestedPage, owningSection, owningNotebook);
  const resolved = resolvePageExportTarget({
    notebooks: [staleNotebook, owningNotebook],
    notebookSections: [owningSection],
    notebookPages: [nestedPage],
    workspaces: [workspace('workspace-stale'), workspace('workspace-owner')],
  }, target);
  assert.equal(resolved.notebook.id, owningNotebook.id);
  assert.equal(resolved.workspaceId, owningNotebook.workspaceId);
});

test('inactive right-clicked section resolves through its own notebook and workspace', () => {
  const activeNotebook = notebook('notebook-a', 'workspace-a');
  const clickedNotebook = notebook('notebook-b', 'workspace-b');
  const clickedSection = section('section-b', clickedNotebook.id);
  const target = createSectionExportTarget(clickedSection, clickedNotebook);
  const resolved = resolveSectionExportTarget({
    notebooks: [activeNotebook, clickedNotebook],
    notebookSections: [clickedSection],
    notebookPages: [],
    workspaces: [workspace('workspace-a'), workspace('workspace-b')],
  }, target);
  assert.deepEqual(target, {
    type: 'section',
    sectionId: 'section-b',
    notebookId: 'notebook-b',
    workspaceId: 'workspace-b',
  });
  assert.equal(resolved.section.id, clickedSection.id);
  assert.equal(resolved.notebook.id, clickedNotebook.id);
  assert.equal(resolved.workspaceId, clickedNotebook.workspaceId);
});

test('missing and deleted context-menu targets retain existing errors', () => {
  const deletedNotebook = { ...notebook('notebook-deleted', 'workspace-a'), deletedAt: 2 };
  const deletedSection = { ...section('section-deleted', deletedNotebook.id), deletedAt: 2 };
  const deletedPage = { ...page('page-deleted', deletedNotebook.id, deletedSection.id), deletedAt: 2 };
  const catalog = { notebooks: [deletedNotebook], notebookSections: [deletedSection], notebookPages: [deletedPage], workspaces: [workspace('workspace-a')] };
  assert.throws(() => resolveNotebookExportTarget(catalog, deletedNotebook.id), /selected notebook no longer exists/);
  assert.throws(() => resolveNotebookExportTarget(catalog, 'missing'), /selected notebook no longer exists/);
  assert.throws(() => resolvePageExportTarget(catalog, deletedPage.id), /selected page no longer exists/);
  assert.throws(() => resolvePageExportTarget(catalog, 'missing'), /selected page no longer exists/);
  assert.throws(() => resolveSectionExportTarget(catalog, 'missing'), /selected section no longer exists/);
});

test('notebook and page item menus expose export and print commands', async () => {
  const source = await readSource('src/components/ui/ContextMenu.tsx');
  assert.match(source, /targetType === 'notebook'[\s\S]*Export Notebook to PDF[\s\S]*Print Notebook/);
  assert.match(source, /targetType === 'page'[\s\S]*Export Page to PDF[\s\S]*Print Page/);
  assert.match(source, /targetType === 'section'[\s\S]*Export Section to PDF[\s\S]*Print Section/);
  assert.match(source, /exportNotebookToPdf\(exportTarget\?\.type === 'notebook' \? exportTarget : targetId\)/);
  assert.match(source, /printNotebook\(exportTarget\?\.type === 'notebook' \? exportTarget : targetId\)/);
  assert.match(source, /exportPageToPdf\(exportTarget\?\.type === 'page' \? exportTarget : targetId\)/);
  assert.match(source, /printPage\(exportTarget\?\.type === 'page' \? exportTarget : targetId\)/);
  const treeSource = await readSource('src/components/workspace/WorkspaceTree.tsx');
  assert.match(treeSource, /createNotebookExportTarget\(notebook\)/);
  assert.match(treeSource, /createPageExportTarget\(page, section, notebook\)/);
  assert.match(treeSource, /createSectionExportTarget\(section, notebook\)/);
});

test('Library and workspace sidebar render notebook covers through the same canonical thumbnail component', async () => {
  const library = await readSource('src/components/library/FilePreviewCards.tsx');
  const sidebar = await readSource('src/components/workspace/WorkspaceTree.tsx');
  const thumbnail = await readSource('src/components/library/NotebookCoverThumbnail.tsx');
  assert.match(library, /NotebookCoverThumbnail title=\{title\} cover=\{cover\}/);
  assert.match(sidebar, /NotebookCoverThumbnail title=\{notebook\.name\} cover=\{notebook\.cover\} variant="mini"/);
  assert.match(thumbnail, /data-cover-id=\{getNotebookCoverIdentity\(cover\)\}/);
  assert.equal(getNotebookCoverIdentity({ kind: 'template', id: 'sage' }), 'template:sage');
  assert.equal(getNotebookCoverIdentity(undefined), 'template:linen');
});

test('only whole-notebook generation passes persisted cover metadata into the shared PDF exporter', async () => {
  const commands = await readSource('src/services/pdf/notebookExportCommands.ts');
  assert.match(commands, /cover: \{ notebookName: notebook\.name, cover: notebook\.cover \}/);
  assert.equal((commands.match(/cover: \{ notebookName:/g) ?? []).length, 1);
});

test('all four context-menu commands reload canonical repositories before resolving targets', async () => {
  const commands = await readSource('src/services/pdf/notebookExportCommands.ts');
  assert.match(commands, /workspaceRepository\.getAll/);
  assert.match(commands, /notebookRepository\.getAll/);
  assert.match(commands, /notebookRepository\.getSections/);
  assert.match(commands, /notebookRepository\.getPages/);
  assert.match(commands, /exportPageToPdf = \(target: PageExportTarget/);
  assert.match(commands, /printPage = \(target: PageExportTarget/);
  assert.match(commands, /exportNotebookToPdf = \(target: NotebookExportTarget/);
  assert.match(commands, /printNotebook = \(target: NotebookExportTarget/);
});

test('page utility export menu is explicit-click, keyboard dismissible, and touch reachable', async () => {
  const [source, overlay] = await Promise.all([
    readSource('src/components/notebook/NotebookPageUtilities.tsx'),
    readSource('src/components/ui/OverlayManager.tsx'),
  ]);
  assert.match(source, /onClick=\{\(\) => setIsPdfMenuOpen/);
  assert.match(source, /aria-expanded=\{isPdfMenuOpen\}/);
  assert.match(source, /<OverlayManager isOpen=\{isPdfMenuOpen\} onClose=\{\(\) => setIsPdfMenuOpen\(false\)\} anchorRef=\{pdfMenuRef\}/);
  assert.match(overlay, /e\.key === 'Escape'[\s\S]*?onClose\(\)/);
  assert.match(overlay, /document\.addEventListener\('mousedown', handleClickOutside\)/);
  assert.doesNotMatch(source, /group-hover:visible|group-focus-within:visible/);
});

test('template previews stay faithful while remaining legible at thumbnail size', async () => {
  const [preview, gallery, createDialog] = await Promise.all([
    readSource('src/components/notebook/templates/TemplatePreview.tsx'),
    readSource('src/components/notebook/templates/TemplateGalleryModal.tsx'),
    readSource('src/components/workspace/CreateDialog.tsx'),
  ]);
  assert.match(preview, /boostPreviewNode/);
  assert.match(preview, /resolveNotebookLineColor\(properties\.ruleLineColor\)/);
  assert.match(preview, /definition\.renderSVG/);
  assert.match(gallery, /max-w-4xl/);
  assert.match(gallery, /lg:grid-cols-4/);
  assert.match(gallery, /line-clamp-2/);
  assert.match(createDialog, /overflow-x-auto/);
  assert.match(createDialog, /TemplatePreview template=\{item\.id\}/);
});

test('line color uses an explicit Panvas palette and updates through page properties', async () => {
  const [panel, renderer] = await Promise.all([
    readSource('src/components/notebook/NotebookToolPropertiesPanel.tsx'),
    readSource('src/components/notebook/NotebookRenderer.tsx'),
  ]);
  assert.match(panel, /Choose line color/);
  assert.match(panel, /Preset line colors/);
  assert.match(panel, /handleUpdate\(\{ ruleLineColor: swatch\.color \}\)/);
  assert.match(panel, /Custom line color/);
  assert.match(panel, /aria-expanded=\{isLineColorOpen\}/);
  assert.match(renderer, /const isLineColorChange = updates\.ruleLineColor !== undefined/);
  assert.match(renderer, /description: isNoteSpaceChange \? 'Change research space' : 'Change line color'/);
  assert.doesNotMatch(renderer, /const livePageId = focusedPageIdRef\.current \|\| activePageId/);
  assert.match(renderer, /resolvePageRenderProperties\(notebook, sectionPage, cachedProperties\)/);
  assert.match(renderer, /updateSectionDataCache\(previous =>/);
  assert.match(renderer, /properties: \{ \.\.\.properties \}/);
});

test('PDF-backed notebook pages render only their source PDF and annotation layers', async () => {
  const [pageView, inactivePreview, pdfBlock] = await Promise.all([
    readSource('src/components/notebook/NotebookPageView.tsx'),
    readSource('src/components/notebook/InactivePagePreview.tsx'),
    readSource('src/components/canvas/PdfBlock.tsx'),
  ]);
  assert.doesNotMatch(pageView, /Click to open/);
  assert.doesNotMatch(inactivePreview, /Click to open/);
  assert.match(pdfBlock, /PDF Canvas/);
  assert.match(pdfBlock, /pdfDataId/);
});

test('cloud entry points use the canonical Google Drive Cloud Sync workspace', async () => {
  const [topbar, indicator, guard, palette, panel] = await Promise.all([
    readSource('src/components/layout/TopBar.tsx'),
    readSource('src/components/ui/SyncIndicator.tsx'),
    readSource('src/components/auth/AuthGuard.tsx'),
    readSource('src/components/ui/CommandPalette.tsx'),
    readSource('src/components/library/CloudSyncPanel.tsx'),
  ]);
  assert.match(topbar, /SyncIndicator onOpenCloudSync={openCloudSync}/);
  assert.match(topbar, /navigateToLibraryView\('cloud'\)/);
  assert.match(indicator, /aria-label=\{onOpenCloudSync \? 'Open Cloud Sync'/);
  assert.match(guard, /navigateToLibraryView\('cloud'\)/);
  assert.doesNotMatch(guard, /navigate\('\/auth\/(login|signup)'\)/);
  assert.match(palette, /label: 'Cloud Sync'/);
  assert.doesNotMatch(palette, /navigate\('\/auth\/login'\)/);
  assert.match(panel, /Connect Google Drive/);
  assert.doesNotMatch(panel, /GitHub|email\/password|Sign in with Google/);
});

test('recognition language UI exposes the supported English model and migrates legacy values', async () => {
  const [toolbar, preferences] = await Promise.all([
    readSource('src/components/notebook/NotebookFloatingToolbar.tsx'),
    readSource('src/services/beautification/handwritingBeautification.ts'),
  ]);
  assert.match(toolbar, /SUPPORTED_HANDWRITING_RECOGNITION_LANGUAGES/);
  assert.doesNotMatch(toolbar, /Hindi|Japanese|Chinese \(Simplified\)/);
  assert.match(preferences, /normalizeHandwritingRecognitionLanguage/);
  assert.match(preferences, /return 'en-US'/);
});

test('research space stays collapsed until requested and image controls avoid the header safe area', async () => {
  const [space, image] = await Promise.all([
    readSource('src/components/notebook/NoteSpaceControl.tsx'),
    readSource('src/components/notebook/FloatingImageControls.tsx'),
  ]);
  assert.match(space, /const \[expanded, setExpanded\] = useState\(false\)/);
  assert.match(space, /aria-expanded=\{expanded\}/);
  assert.match(space, /expanded &&/);
  assert.match(image, /const top = rawTop < 76/);
  assert.match(image, /aria-label="Crop image"/);
  assert.match(image, /Image opacity/);
});

test('note printing uses canonical PDF generation and never prints the live workspace', async () => {
  const commands = await readSource('src/services/pdf/notebookExportCommands.ts');
  assert.match(commands, /exportNotebookPdf/);
  assert.match(commands, /deliverPreparedPdf\(requireBytes\(result\), delivery\)/);
  assert.doesNotMatch(commands, /window\.print\(/);
});

test('Electron print delivery never opens a browser popup and browser fallback still pre-opens one', async () => {
  let popupCalls = 0;
  const electron = preparePdfPrintDelivery({
    nativePrint: async () => ({ status: 'printed' }),
    openBrowserTarget: () => { popupCalls += 1; return null; },
  });
  assert.equal(electron?.kind, 'electron');
  assert.equal(popupCalls, 0);

  const browserTarget = { closed: false, navigate: async () => undefined, print: () => undefined, close: () => undefined };
  const browser = preparePdfPrintDelivery({ openBrowserTarget: () => { popupCalls += 1; return browserTarget; } });
  assert.equal(browser?.kind, 'browser');
  assert.equal(popupCalls, 1);
});

test('native print lifecycle cleans temporary PDF and window after print and cancellation', async () => {
  for (const [success, reason, expected] of [[true, '', 'printed'], [false, 'Print job canceled', 'cancelled']] as const) {
    const calls: string[] = [];
    const result = await runNativePdfPrint(new Uint8Array([37, 80, 68, 70, 45]), {
      createTemporaryPdf: async bytes => {
        assert.equal(bytes[0], 37);
        calls.push('create-temp');
        return { filePath: 'temporary/document.pdf', cleanup: async () => { calls.push('cleanup-temp'); } };
      },
      createPrintWindow: () => ({
        loadFile: async filePath => { calls.push(`load:${filePath}`); },
        showInactive: () => { calls.push('show-preview'); },
        isDestroyed: () => false,
        destroy: () => { calls.push('destroy-window'); },
        webContents: { print: (_options, callback) => { calls.push('print'); callback(success, reason); } },
      }),
    });
    assert.equal(result.status, expected);
    assert.deepEqual(calls, ['create-temp', 'load:temporary/document.pdf', 'show-preview', 'print', 'destroy-window', 'cleanup-temp']);
  }
});

test('printPdfBytes hands generated application/pdf bytes to the isolated print target and cleans up', async () => {
  const calls: string[] = [];
  const target: PdfPrintTarget = {
    closed: false,
    navigate: async url => { calls.push(`navigate:${url}`); },
    print: () => calls.push('print'),
    close: () => calls.push('close'),
  };
  const runtime: PdfPrintRuntime = {
    createObjectURL: blob => {
      assert.equal(blob.type, 'application/pdf');
      calls.push('create');
      return 'blob:panvas-test';
    },
    revokeObjectURL: url => calls.push(`revoke:${url}`),
    delay: async () => { calls.push('delay'); },
    schedule: callback => { calls.push('schedule'); callback(); return 1; },
  };
  await printPdfBytes(new Uint8Array([37, 80, 68, 70]), target, runtime);
  assert.deepEqual(calls, [
    'create',
    'navigate:blob:panvas-test',
    'delay',
    'print',
    'schedule',
    'revoke:blob:panvas-test',
  ]);
});

test('printPdfBytes rejects blocked targets and cleans failed handoffs', async () => {
  await assert.rejects(() => printPdfBytes(new Uint8Array([1]), null), /blocked/);
  const calls: string[] = [];
  const target: PdfPrintTarget = {
    closed: false,
    navigate: async () => { calls.push('navigate'); },
    print: () => { throw new Error('print unavailable'); },
    close: () => calls.push('close'),
  };
  const runtime: PdfPrintRuntime = {
    createObjectURL: () => 'blob:failure',
    revokeObjectURL: url => calls.push(`revoke:${url}`),
    delay: async () => undefined,
    schedule: () => 1,
  };
  await assert.rejects(() => printPdfBytes(new Uint8Array([1]), target, runtime), /print unavailable/);
  assert.deepEqual(calls, ['navigate', 'revoke:blob:failure', 'close']);
});

test('command failures and popup blocking are surfaced through Panvas toast feedback', async () => {
  const source = await readSource('src/services/pdf/notebookExportCommands.ts');
  assert.match(source, /print window was blocked/);
  assert.match(source, /showToast\([^)]*'error'/s);
  assert.match(source, /Print dialog opened\. Choose Print or Cancel/);
});
