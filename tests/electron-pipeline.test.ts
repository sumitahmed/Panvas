// ============================================
// Panvas — Electron PDF pipeline + window chrome regression
// ============================================
// Phase 0 validation against the REAL Electron app (not the browser build):
//
//   1. PDF import → open → render (flow A)
//   2. App restart → IndexedDB wiped (simulating the profile/origin loss that
//      orphaned every imported PDF before filesystem storage existed) →
//      reopen → render from the filesystem store (flow B)
//   3. Window chrome: native-controls safe region is reserved and top-right
//      application controls clear it
//   4. Shell chrome stays at the native 100% scale; document zoom is separate
//
// The test creates an isolated "P0 Electron Test" workspace under
// Documents/Panvas and removes it (plus only its own pdf-store files) in
// teardown. Run after `npm run build`:  npm run test:electron

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  PANVAS_BASE,
  launchElectron as launchElectronImpl,
  stopElectron,
  connect as connectImpl,
  appPage as appPageImpl,
  domClick,
  cleanupTestWorkspaces,
} from './electron-lib.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const PDF_STORE = path.join(PANVAS_BASE, 'Assets', 'pdf-store');
const SCREENSHOT_DIR = path.join(PROJECT_ROOT, 'tests', 'screenshots');
const DEBUG_PORT = 9231;

const WORKSPACE_NAME = `P0 Electron Test ${Date.now()}`;

async function makeTestPdf(): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Panvas pipeline test — page ${i}`, { x: 72, y: 700, size: 24, font });
  }
  const bytes = await doc.save();
  const pdfPath = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'pipeline-test.pdf');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  fs.writeFileSync(pdfPath, bytes);
  return pdfPath;
}






// Window resizing is done at launch via PANVAS_TEST_WINDOW (Electron's CDP
// does not expose the Browser.setWindowBounds domain).

// DOM-level click: Electron + framer-motion intermittently defeat Playwright's
// coordinate-based actionability in this app (hit-testing verifies fine via
// elementFromPoint), so UI driving dispatches clicks directly on the element.
// Real mouse input is reserved for the file chooser flow.

async function createWorkspaceNotebookSection(page: import('playwright').Page): Promise<void> {
  // All tree interactions are scoped to the library sidebar (role
  // complementary) — the TopBar renders matching breadcrumb names first in
  // DOM order and would otherwise intercept strict-mode resolution.
  const sidebar = page.getByRole('complementary');
  const newItem = sidebar.getByRole('button', { name: 'New item' });

  await domClick(sidebar.getByRole('button', { name: 'Create workspace' }));
  await page.locator('#create-dialog-input').fill(WORKSPACE_NAME);
  await domClick(page.getByRole('button', { name: 'Create', exact: true }));
  await page.locator('#create-dialog-input').waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(1200);
  // Verify the actual parent before creating entities in the test workspace.
  const workspace = JSON.parse(await readFile(path.join(PANVAS_BASE, WORKSPACE_NAME, '.panvas', 'workspace.json'), 'utf8'));
  await domClick(sidebar.locator('div[role="button"]').filter({ hasText: WORKSPACE_NAME }).first());
  await page.waitForFunction(id => localStorage.getItem('panvas.activeWorkspaceId') === id, workspace.id);
  await page.waitForTimeout(900);

  await domClick(newItem);
  await domClick(page.getByRole('button', { name: 'New Notebook' }));
  await page.locator('#create-dialog-input').fill('Pipeline Notebook');
  await domClick(page.getByRole('button', { name: 'Create', exact: true }));
  await page.locator('#create-dialog-input').waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(900);

  await ensureTreeRowVisible(page, /Pipeline Notebook/);
  const afterNotebook = JSON.parse(await readFile(path.join(PANVAS_BASE, WORKSPACE_NAME, '.panvas', 'workspace.json'), 'utf8'));
  const notebook = afterNotebook.notebooks.find((item: any) => item.name === 'Pipeline Notebook');
  assert.ok(notebook, 'notebook was persisted in the isolated workspace');
  await domClick(sidebar.locator(`[data-tree-id="${notebook.id}"]`));
  await page.waitForTimeout(800);

  await domClick(newItem);
  await domClick(page.getByRole('button', { name: 'New Section' }));
  await page.locator('#create-dialog-input').fill('Pipeline Section');
  await domClick(page.getByRole('button', { name: 'Create', exact: true }));
  await page.locator('#create-dialog-input').waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(900);

  const afterSection = JSON.parse(await readFile(path.join(PANVAS_BASE, WORKSPACE_NAME, '.panvas', 'workspace.json'), 'utf8'));
  const sectionRecord = afterSection.notebookSections.find((item: any) => item.notebookId === notebook.id && item.name === 'Pipeline Section');
  assert.ok(sectionRecord, 'section was persisted under the test notebook');
  // Creating a child reloads persisted expansion state. Expand its notebook,
  // rather than toggling the unrelated workspace and hiding the entire tree.
  const expandNotebook = sidebar.getByRole('button', { name: 'Expand Pipeline Notebook', exact: true });
  if (await expandNotebook.count()) await domClick(expandNotebook);
  const section = sidebar.locator(`[data-tree-id="${sectionRecord.id}"]`);
  await section.waitFor({ state: 'visible', timeout: 12000 });
  await domClick(section);
  await page.waitForTimeout(700);
}

// Tree rows appear only under an expanded workspace; creation flows can leave
// the parent collapsed. Wait, then toggle the workspace node once and retry.
async function ensureTreeRowVisible(page: import('playwright').Page, name: RegExp): Promise<void> {
  const sidebar = page.getByRole('complementary');
  const row = sidebar.getByRole('button', { name }).first();
  try {
    await row.waitFor({ state: 'visible', timeout: 12000 });
    return;
  } catch { /* fall through: expand the workspace */ }
  const ws = sidebar.getByRole('button', { name: new RegExp(WORKSPACE_NAME.slice(0, 20)) }).first();
  await domClick(ws);
  await page.waitForTimeout(800);
  await row.waitFor({ state: 'visible', timeout: 12000 });
}

async function importPdfIntoSection(page: import('playwright').Page, pdfPath: string): Promise<void> {
  const section = page.getByRole('complementary').getByRole('button', { name: /Pipeline Section/ }).first();
  await section.evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const importItem = page.getByText('Import PDF', { exact: true });
  await importItem.waitFor({ state: 'visible', timeout: 5000 });
  const chooserP = page.waitForEvent('filechooser', { timeout: 8000 });
  await domClick(importItem);
  const chooser = await chooserP;
  await chooser.setFiles(pdfPath);
}

async function assertPdfRenders(page: import('playwright').Page, label: string): Promise<void> {
  // 'Failed to load PDF.' / 'No PDF document attached.' are the failure texts.
  const failure = await page.getByText(/Failed to load PDF\.|No PDF document attached\./).count();
  assert.equal(failure, 0, `[${label}] PDF failure text visible`);
  // The PDF surface renders an actual pdf.js canvas.
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 20000 });
  const canvasInfo = await page.locator('canvas').first().evaluate(el => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  assert.ok(canvasInfo.w > 50 && canvasInfo.h > 50, `[${label}] pdf.js canvas has no rendered content`);
  // PDF navigation is deliberately hidden while Pen is selected. Exercise
  // the normal Select shortcut before checking our three-page fixture.
  await page.keyboard.press('v');
  const navigation = page.getByRole('group', { name: 'Page navigation', exact: true });
  await navigation.waitFor({ state: 'visible', timeout: 5000 });
  const navText = await navigation.innerText();
  assert.match(navText, /1\s*\/\s*3/, `[${label}] page indicator '1 / 3' not found`);
}

async function openTestWorkspace(page: import('playwright').Page): Promise<void> {
  const sidebar = page.getByRole('complementary');
  await domClick(sidebar.getByRole('button', { name: new RegExp(WORKSPACE_NAME.slice(0, 20)) }).first());
  await page.waitForTimeout(900);
  await ensureTreeRowVisible(page, /Pipeline Notebook/);
  await domClick(sidebar.getByRole('button', { name: /Pipeline Notebook/ }).first());
  await page.waitForTimeout(700);
  await domClick(sidebar.getByRole('button', { name: /Pipeline Section/ }).first());
  await page.waitForTimeout(600);
}

test('Electron PDF pipeline survives restart and IndexedDB loss; window chrome + native scale', async () => {
  const pdfPath = await makeTestPdf();
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  let electron: ChildProcess | null = null;
  const log: string[] = [];

  try {
    // ---------- Run 1: import → open → render (flow A) ----------
    electron = launchElectronImpl(DEBUG_PORT);
    let browser = await connectImpl(DEBUG_PORT);
    let page = await appPageImpl(browser);
    await page.getByRole('button', { name: 'New item' }).waitFor({ state: 'visible', timeout: 30000 });

    const rendererBoundary = await page.evaluate(() => {
      const exposed = (window as any).panvas ?? {};
      return {
        processType: typeof (window as any).process,
        requireType: typeof (window as any).require,
        knowledgeOperations: Object.keys(exposed.knowledge ?? {}).sort(),
        forbiddenTopLevel: Object.keys(exposed).filter(key => /credential|endpoint|filesystem|shell/i.test(key)),
      };
    });
    assert.equal(rendererBoundary.processType, 'undefined', 'Node process is not exposed to the renderer');
    assert.equal(rendererBoundary.requireType, 'undefined', 'Node require is not exposed to the renderer');
    assert.deepEqual(rendererBoundary.knowledgeOperations, [
      'find_related', 'get_note_context', 'get_note_ref', 'knowledge_health', 'search_knowledge',
    ], 'knowledge preload exposes exactly the five read-only operations');
    assert.deepEqual(rendererBoundary.forbiddenTopLevel, [], 'preload exposes no credential, endpoint, filesystem, or shell primitive');
    log.push('renderer boundary: isolated Node globals; five-operation read-only knowledge API');

    // Window chrome: the WCO-driven safe region must be reserved.
    const chrome = await page.evaluate(() => {
      const spacer = Array.from(document.querySelectorAll('header div[aria-hidden="true"]'))
        .find(el => String(el.className).includes('flex-shrink-0')) as HTMLElement | undefined;
      const controls = Array.from(document.querySelectorAll('header button')).pop();
      return {
        spacerWidth: spacer?.getBoundingClientRect().width ?? 0,
        lastControlRight: controls ? controls.getBoundingClientRect().right : 0,
        viewportWidth: window.innerWidth,
      };
    });
    assert.ok(chrome.spacerWidth >= 90,
      `native-controls safe region not reserved (spacer=${chrome.spacerWidth}px)`);
    assert.ok(chrome.lastControlRight <= chrome.viewportWidth - chrome.spacerWidth + 2,
      `application controls (right=${chrome.lastControlRight}) intrude into the native-controls safe region`);
    log.push(`chrome safe region: spacer=${chrome.spacerWidth.toFixed(0)}px, last control right=${chrome.lastControlRight.toFixed(0)}/${chrome.viewportWidth}`);

    const rootFont = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    assert.equal(rootFont, '16px', `shell root font must remain native 16px, got ${rootFont}`);
    log.push(`shell root font size: ${rootFont} (native scale)`);

    await createWorkspaceNotebookSection(page);
    await importPdfIntoSection(page, pdfPath);

    // The import toast appears and the PDF page opens automatically.
    await page.waitForTimeout(1500);
    await assertPdfRenders(page, 'run1 import');

    // The bytes must exist in the filesystem store — the durability contract.
    const wsJson = JSON.parse(await readFile(
      path.join(PANVAS_BASE, WORKSPACE_NAME, '.panvas', 'workspace.json'), 'utf8'));
    const pdfPage = wsJson.notebookPages.find((p: any) => p.type === 'pdf');
    if (!pdfPage?.pdfDataId) {
      console.log('DIAG pages:', JSON.stringify(wsJson.notebookPages.map((p: any) => ({ t: p.title, type: p.type, pdf: p.pdfDataId }))));
      console.log('DIAG notebooks:', JSON.stringify(wsJson.notebooks.map((n: any) => ({ name: n.name, ws: n.workspaceId }))));
      console.log('DIAG pdf-store files:', fs.readdirSync(PDF_STORE).join(', '));
    }
    assert.ok(pdfPage?.pdfDataId, 'imported page record has no pdfDataId');
    const binStat = fs.statSync(path.join(PDF_STORE, `${pdfPage.pdfDataId}.bin`));
    const metaStat = fs.statSync(path.join(PDF_STORE, `${pdfPage.pdfDataId}.meta.json`));
    assert.ok(binStat.size > 500, `filesystem pdf store .bin too small (${binStat.size}B)`);
    assert.ok(metaStat.size > 0);
    log.push(`fs store: ${pdfPage.pdfDataId}.bin = ${binStat.size}B`);

    // Add one real annotation through the PDF workspace and prove that the
    // virtual PDF-page drawing is persisted beside the canonical notebook.
    // The toolbar deliberately opens settings when its already-active tool is
    // clicked. Select Pen through its documented shortcut so this persistence
    // check targets the annotation surface, not a contextual settings overlay.
    await page.keyboard.press('p');
    const annotationCanvas = page.locator('canvas.panvas-layer-canvas-decoration').first();
    const annotationBounds = await annotationCanvas.boundingBox();
    assert.ok(annotationBounds, 'PDF annotation canvas is unavailable');
    await page.mouse.move(annotationBounds.x + 120, annotationBounds.y + 140);
    await page.mouse.down();
    await page.mouse.move(annotationBounds.x + 220, annotationBounds.y + 210, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1400);
    const drawingPath = path.join(PANVAS_BASE, WORKSPACE_NAME, 'Notebooks', pdfPage.notebookId, 'pages', `${pdfPage.id}_pdf_1.drawing.json`);
    const drawing = JSON.parse(await readFile(drawingPath, 'utf8'));
    assert.ok(drawing.objects?.some((object: any) => object.type === 'stroke'), 'PDF annotation stroke was not persisted');
    log.push('run1: PDF annotation persisted to canonical virtual-page drawing');

    // Screenshot evidence of the rendered PDF workspace.
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'electron-pdf.png') });

    await stopElectron(electron);
    electron = null;

    // ---------- Run 2: restart → wipe IndexedDB → reopen (flow B) ----------
    // Deleting the renderer's IndexedDB reproduces exactly what orphaned the
    // user's imported PDFs: page references live on the filesystem, bytes did
    // not. With the filesystem store they must survive.
    electron = launchElectronImpl(DEBUG_PORT);
    browser = await connectImpl(DEBUG_PORT);
    page = await appPageImpl(browser);
    await page.getByRole('button', { name: 'New item' }).waitFor({ state: 'visible', timeout: 30000 });
    // Wipe ONLY the pdfFiles store through a second raw IDB connection.
    // Deleting the whole database while Dexie holds it open takes the
    // renderer down; clearing the store proves the same thing: the bytes are
    // gone from renderer storage and must come back from the filesystem.
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        const req = indexedDB.open('panvas', 4);
        req.onsuccess = () => {
          const dbx = req.result;
          try {
            const tx = dbx.transaction('pdfFiles', 'readwrite');
            tx.objectStore('pdfFiles').clear();
            tx.oncomplete = tx.onerror = tx.onabort = () => { dbx.close(); resolve(); };
          } catch { dbx.close(); resolve(); }
        };
        req.onerror = () => resolve();
      });
    });
    await page.waitForTimeout(600);

    await openTestWorkspace(page);
    const pdfRow = page.getByRole('complementary').getByRole('button', { name: /pipeline-test\.pdf/i }).first();
    await pdfRow.waitFor({ state: 'visible', timeout: 10000 });
    await domClick(pdfRow);
    await page.waitForTimeout(1500);
    await assertPdfRenders(page, 'run2 after IndexedDB wipe');
    log.push('run2: PDF reopened from filesystem store after IndexedDB wipe');
    const restartedDrawing = JSON.parse(await readFile(
      path.join(PANVAS_BASE, WORKSPACE_NAME, 'Notebooks', pdfPage.notebookId, 'pages', `${pdfPage.id}_pdf_1.drawing.json`),
      'utf8',
    ));
    assert.ok(restartedDrawing.objects?.some((object: any) => object.type === 'stroke'), 'PDF annotation did not survive restart');
    log.push('run2: PDF annotation survived restart');

    const restartedRootFont = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    assert.equal(restartedRootFont, '16px', `restart changed shell root font to ${restartedRootFont}`);
    log.push(`restart shell root font size: ${restartedRootFont} (native scale)`);

    console.log(log.join('\n'));
  } finally {
    if (electron) await stopElectron(electron);
    // Teardown: remove ALL test workspaces created by this suite.
    try {
      await cleanupTestWorkspaces(['P0 Electron Test']);
    } catch (err) {
      console.error('teardown warning:', err);
    }
  }
}, 300000);
