// ============================================
// Panvas — Phase 1 integrity regression (real Electron app)
// ============================================
// Roadmap Phase 1 acceptance, end to end:
//   1. create -> edit (ink + rich text + image) -> autosave
//   2. restart -> reopen -> content restored (disk + render)
//   3. delete page -> trash -> restore -> content intact
//   4. simulated write failure -> "Save failed" surfaced (never false success)
//      -> failure resolved -> "Saved" again
// Uses an isolated "P1 Integrity Test" workspace removed in teardown.
// Run after `npm run build`:  npm run test:integrity

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import {
  PANVAS_BASE,
  launchElectron,
  stopElectron,
  connect,
  appPage,
  waitForApp,
  domClick,
  createWorkspaceNotebookSection,
  cleanupTestWorkspaces,
} from './electron-lib.ts';

const DEBUG_PORT = 9261;
const WORKSPACE_NAME = `P1 Integrity Test ${Date.now()}`;
const TEXT_MARKER = 'INTEGRITY-MARKER-42';

// Minimal valid 4x4 red PNG.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8Dwn4GBgYGJAQwAHxcCAmLesTkAAAAASUVORK5CYII=';

async function writePngFixture(): Promise<string> {
  const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'integrity-test.png');
  await import('node:fs/promises').then(m => m.mkdir(path.dirname(fixture), { recursive: true }));
  fs.writeFileSync(fixture, Buffer.from(TINY_PNG_BASE64, 'base64'));
  return fixture;
}

function readWorkspaceJson(): any {
  return JSON.parse(fs.readFileSync(path.join(PANVAS_BASE, WORKSPACE_NAME, '.panvas', 'workspace.json'), 'utf8'));
}

function pagePaths(): { pageId: string; drawingJson: string } {
  const ws = readWorkspaceJson();
  const page = ws.notebookPages.find((p: any) => p.title === 'Integrity Page')
    ?? [...ws.notebookPages].reverse().find((p: any) => !p.type || p.type === 'default');
  assert.ok(page, 'default page record exists');
  const notebook = ws.notebooks.find((n: any) => n.id === page.notebookId);
  return {
    pageId: page.id,
    drawingJson: path.join(PANVAS_BASE, WORKSPACE_NAME, 'Notebooks', notebook.id, 'pages', `${page.id}.drawing.json`),
  };
}

async function drawStrokeOnPage(page: import('playwright').Page): Promise<void> {
  const canvas = page.locator('[data-page-id] canvas:not(.pointer-events-none)').first();
  await canvas.waitFor({ state: 'visible', timeout: 10000 });
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  const box = await canvas.boundingBox();
  assert.ok(box, 'page canvas box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 3;
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) {
    await page.mouse.move(cx - 80 + i * 8, cy + Math.sin(i / 3) * 18);
  }
  await page.mouse.up();
}

async function addTextBox(page: import('playwright').Page): Promise<void> {
  await domClick(page.locator('button[title="Text (T)"]'));
  const canvas = page.locator('[data-page-id] canvas:not(.pointer-events-none)').first();
  await page.waitForFunction(
    element => (element as HTMLCanvasElement).className.includes('cursor-text'),
    await canvas.elementHandle(),
    { timeout: 5000 },
  );
  const box = await canvas.boundingBox();
  assert.ok(box, 'page canvas box');
  await canvas.dispatchEvent('pointerdown', {
    bubbles: true,
    button: 0,
    buttons: 1,
    clientX: box.x + box.width / 3,
    clientY: box.y + box.height / 2,
    pointerId: 41,
    pointerType: 'mouse',
  });
  const editor = page.locator('[contenteditable="true"]').last();
  await editor.waitFor({ state: 'visible', timeout: 8000 });
  await editor.click();
  await page.keyboard.type(TEXT_MARKER);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

async function insertImage(page: import('playwright').Page, pngPath: string): Promise<void> {
  const more = page.locator('button[title="More Tools"]');
  if (await more.count() === 1) {
    await domClick(more);
    const imageBtn = page.locator('div[role="menu"][aria-label="More Tools"] button[title="Insert Image"]');
    await imageBtn.waitFor({ state: 'visible', timeout: 5000 });
    const chooserP = page.waitForEvent('filechooser', { timeout: 8000 });
    await domClick(imageBtn);
    const chooser = await chooserP;
    await chooser.setFiles(pngPath);
  } else {
    const imageBtn = page.locator('button[title="Insert Image"]');
    const chooserP = page.waitForEvent('filechooser', { timeout: 8000 });
    await domClick(imageBtn);
    const chooser = await chooserP;
    await chooser.setFiles(pngPath);
  }
  await page.waitForTimeout(1200);
}

test('mixed note survives restart; trash restores; save failures are honest', async () => {
  const pngPath = await writePngFixture();
  let electron: ChildProcess | null = null;
  const log: string[] = [];
  let pagesDir: string | null = null;

  const restoreAcl = () => {
    if (pagesDir) {
      try { execSync(`icacls "${pagesDir}" /remove:d Everyone`, { stdio: 'ignore' }); } catch { /* best effort */ }
    }
  };

  try {
    // ---------- Run 1: create + edit mixed content ----------
    electron = launchElectron(DEBUG_PORT, '1280x800');
    let browser = await connect(DEBUG_PORT);
    let page = await appPage(browser);
    await waitForApp(page);
    await createWorkspaceNotebookSection(page, WORKSPACE_NAME, readFile);

    // Create a page and let it open.
    const newItem = page.getByRole('complementary').getByRole('button', { name: 'New item' });
    await domClick(newItem);
    await domClick(page.getByRole('button', { name: 'New Page' }));
    await page.locator('#create-dialog-input').fill('Integrity Page');
    await page.getByRole('dialog', { name: 'New Page', exact: true }).getByRole('button', { name: /^Freeform/ }).click();
    await domClick(page.getByRole('button', { name: 'Create', exact: true }));
    await page.locator('button[title="Hide Toolbar"]').waitFor({ state: 'visible', timeout: 15000 });

    await drawStrokeOnPage(page);
    await addTextBox(page);
    await insertImage(page, pngPath);

    // Autosave (1s debounce) + IPC write.
    await page.waitForTimeout(2600);

    const { pageId, drawingJson } = pagePaths();
    pagesDir = path.dirname(drawingJson);
    const drawing = JSON.parse(await readFile(drawingJson, 'utf8'));
    const objects: any[] = drawing.objects ?? [];
    const strokes = objects.filter(o => o.type === 'stroke');
    const texts = objects.filter(o => o.type === 'text');
    const images = objects.filter(o => o.type === 'image');
    assert.ok(strokes.length >= 1, `ink persisted (strokes=${strokes.length})`);
    assert.ok(texts.length >= 1, `text persisted (texts=${texts.length})`);
    assert.ok(images.length >= 1, `image persisted (images=${images.length})`);
    assert.ok(texts.some((t: any) => JSON.stringify(t.content).includes(TEXT_MARKER)), 'text marker persisted');
    const imageId = images[0].fileId ?? images[0].id;
    const imageBin = path.join(PANVAS_BASE, 'Assets', 'image-store', `${imageId}.bin`);
    assert.ok(fs.existsSync(imageBin), `image bytes in filesystem store (${imageBin})`);
    log.push(`run1: ink=${strokes.length} text=${texts.length} image=${images.length}; fs image-store ok`);

    // ---------- Restart and reopen ----------
    await stopElectron(electron);
    electron = launchElectron(DEBUG_PORT, '1280x800');
    browser = await connect(DEBUG_PORT);
    page = await appPage(browser);
    await waitForApp(page);

    const sidebar = page.getByRole('complementary');
    const reopenedWorkspace = readWorkspaceJson();
    const reopenedPageRecord = reopenedWorkspace.notebookPages.find((item: any) => item.id === pageId);
    const reopenedNotebookRecord = reopenedWorkspace.notebooks.find((item: any) => item.id === reopenedPageRecord.notebookId);
    const reopenedSectionRecord = reopenedWorkspace.notebookSections.find((item: any) => item.id === reopenedPageRecord.sectionId);
    const reopenedWorkspaceRow = sidebar.getByRole('treeitem', { name: WORKSPACE_NAME, exact: true });
    await domClick(reopenedWorkspaceRow);
    await page.waitForTimeout(900);
    const reopenedNotebookRow = sidebar.locator(`[data-tree-id="${reopenedNotebookRecord.id}"]`);
    try {
      await reopenedNotebookRow.waitFor({ state: 'visible', timeout: 2500 });
    } catch {
      await domClick(sidebar.getByRole('button', { name: `Expand ${WORKSPACE_NAME}`, exact: true }));
      await reopenedNotebookRow.waitFor({ state: 'visible', timeout: 12000 });
    }
    await domClick(reopenedNotebookRow);
    const notebookToggle = sidebar.locator(`button[data-tree-toggle][aria-label$="${reopenedNotebookRecord.name}"]`);
    if ((await notebookToggle.count()) > 0 && (await notebookToggle.getAttribute('aria-label'))?.startsWith('Expand')) {
      await domClick(notebookToggle);
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(500);
    const reopenedSectionRow = sidebar.locator(`[data-tree-id="${reopenedSectionRecord.id}"]`);
    await reopenedSectionRow.waitFor({ state: 'visible', timeout: 12000 });
    await domClick(reopenedSectionRow);
    const sectionToggle = sidebar.locator(`button[data-tree-toggle][aria-label$="${reopenedSectionRecord.name}"]`);
    if ((await sectionToggle.count()) > 0 && (await sectionToggle.getAttribute('aria-label'))?.startsWith('Expand')) {
      await domClick(sectionToggle);
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(500);
    const pageRow = sidebar.locator(`[data-tree-id="${pageId}"]`);
    await pageRow.waitFor({ state: 'visible', timeout: 10000 });
    await domClick(pageRow);
    await page.waitForTimeout(2000);

    // Text content restored into the DOM.
    try {
      await page.getByText(TEXT_MARKER).filter({ visible: true }).waitFor({ state: 'visible', timeout: 10000 });
    } catch (error) {
      const reopenedWorkspace = readWorkspaceJson();
      const reopenedPage = reopenedWorkspace.notebookPages.find((item: any) => item.id === pageId);
      const debug = await page.evaluate(async ({ workspaceId, notebookId, reopenedPageId, marker }) => {
        const drawing = await (window as any).panvas.notebook.loadDrawing(workspaceId, notebookId, reopenedPageId);
        return {
          activePageId: localStorage.getItem('panvas.activePageId'),
          bodyHasMarker: document.body.innerText.includes(marker),
          pageElementPresent: Boolean(document.querySelector(`[data-page-id="${reopenedPageId}"]`)),
          objectTypes: (drawing?.objects ?? []).map((object: any) => object.type),
          drawingHasMarker: JSON.stringify(drawing).includes(marker),
        };
      }, {
        workspaceId: reopenedWorkspace.id,
        notebookId: reopenedPage.notebookId,
        reopenedPageId: pageId,
        marker: TEXT_MARKER,
      });
      console.log('reopenDebug:', JSON.stringify(debug));
      throw error;
    }
    // Ink actually rendered: non-transparent pixels on the page canvas.
    let inkPixels = 0;
    for (let attempt = 0; attempt < 12 && inkPixels <= 200; attempt += 1) {
      inkPixels = await page.locator('[data-page-id] canvas:not(.pointer-events-none)').first().evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx || c.width === 0) return 0;
        const data = ctx.getImageData(0, 0, c.width, Math.min(c.height, 600)).data;
        let count = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 16) count++;
        return count;
      });
      if (inkPixels <= 200) await page.waitForTimeout(300);
    }
    assert.ok(inkPixels > 200, `ink rendered after restart (opaque pixels=${inkPixels})`);
    log.push(`run2: text + ink restored (opaque canvas pixels=${inkPixels})`);

    // ---------- Delete -> trash -> restore ----------
    await pageRow.evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    const deleteItem = page.getByText('Delete', { exact: true }).first();
    await deleteItem.waitFor({ state: 'visible', timeout: 5000 });
    await domClick(deleteItem);
    await page.waitForTimeout(1200);

    // Soft-deleted on disk, content files intact, gone from the tree.
    const afterDelete = readWorkspaceJson().notebookPages.find((p: any) => p.id === pageId);
    assert.ok(afterDelete?.deletedAt, 'page record soft-deleted (deletedAt set)');
    assert.ok(fs.existsSync(drawingJson), 'drawing file kept on disk after delete');
    assert.equal(await sidebar.locator(`[data-tree-id="${pageId}"]`).count(), 0, 'page removed from tree');

    // Trash section lists it; restore brings it back with content intact.
    const trashSection = page.locator('section[aria-labelledby="trash-heading"]');
    await trashSection.waitFor({ state: 'visible', timeout: 8000 });
    await domClick(trashSection.getByRole('button', { name: /^Trash(?: \d+)?$/i }));
    await page.waitForTimeout(500);
    const restorePage = trashSection.getByRole('button', { name: 'Restore Integrity Page', exact: true });
    await restorePage.waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await restorePage.count(), 1, 'each deleted page has exactly one Trash row');
    await domClick(restorePage);
    await page.waitForTimeout(1200);

    const afterRestore = readWorkspaceJson().notebookPages.find((p: any) => p.id === pageId);
    assert.ok(!afterRestore?.deletedAt, 'page record restored (deletedAt cleared)');
    const restoredRow = sidebar.locator(`[data-tree-id="${pageId}"]`);
    await restoredRow.waitFor({ state: 'visible', timeout: 10000 });
    await domClick(restoredRow);
    await page.waitForTimeout(1800);
    try {
      await page.getByText(TEXT_MARKER).filter({ visible: true }).waitFor({ state: 'visible', timeout: 10000 });
    } catch (error) {
      const restoredWorkspace = readWorkspaceJson();
      const restoredPage = restoredWorkspace.notebookPages.find((item: any) => item.id === pageId);
      const debug = await page.evaluate(async ({ workspaceId, notebookId, restoredPageId, marker }) => {
        const drawing = await (window as any).panvas.notebook.loadDrawing(workspaceId, notebookId, restoredPageId);
        return {
          activePageId: localStorage.getItem('panvas.activePageId'),
          bodyHasMarker: document.body.innerText.includes(marker),
          pageElementPresent: Boolean(document.querySelector(`[data-page-id="${restoredPageId}"]`)),
          objectTypes: (drawing?.objects ?? []).map((object: any) => object.type),
          drawingHasMarker: JSON.stringify(drawing).includes(marker),
        };
      }, {
        workspaceId: restoredWorkspace.id,
        notebookId: restoredPage.notebookId,
        restoredPageId: pageId,
        marker: TEXT_MARKER,
      });
      console.log('restoreDebug:', JSON.stringify(debug));
      throw error;
    }
    log.push('trash: page soft-deleted, restored, content intact');

    // ---------- Save-failure honesty ----------
    // Deny write access to the pages directory: the atomic write's temp file
    // creation fails, the IPC rejects, and the app must say so.
    execSync(`icacls "${pagesDir}" /deny "Everyone:(WD,AD)"`, { stdio: 'ignore' });
    try {
      await drawStrokeOnPage(page);
      await page.waitForTimeout(400);
      // Autosave debounce 1s + IPC round trip; failure must be surfaced.
      const failureSignal = page.getByTestId('save-status').getByText('Save failed')
        .or(page.getByText('Save failed. Your changes are kept in memory and will retry on the next edit.'));
      await failureSignal.first().waitFor({ state: 'visible', timeout: 12000 });
      log.push('failure: StatusBar shows "Save failed" (no false success)');
    } finally {
      restoreAcl();
    }

    // Failure resolved: the next save reaches disk again. Proven by polling
    // the drawing file itself — the StatusBar "Saved" flash is transient and
    // races the auto-reset to idle.
    await drawStrokeOnPage(page);
    let strokesAfter: any[] = [];
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      const drawingAfter = JSON.parse(await readFile(drawingJson, 'utf8'));
      strokesAfter = (drawingAfter.objects ?? []).filter((o: any) => o.type === 'stroke');
      if (strokesAfter.length >= strokes.length + 2) break;
    }
    assert.ok(strokesAfter.length >= strokes.length + 2,
      `post-recovery saves reached disk (${strokesAfter.length} < ${strokes.length + 2})`);
    await page.getByTestId('save-status').getByText('Saved').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.getByTestId('save-status').getByText('Save failed').count(), 0, 'error indicator cleared after recovery');
    log.push(`failure-recovery: saves reached disk again, strokes=${strokesAfter.length}`);

    // ---------- Metadata recovery artifact ----------
    await stopElectron(electron);
    const workspaceJsonPath = path.join(PANVAS_BASE, WORKSPACE_NAME, '.panvas', 'workspace.json');
    const recoveryJsonPath = path.join(PANVAS_BASE, WORKSPACE_NAME, '.panvas', 'recovery', 'workspace.last-good.json');
    assert.ok(fs.existsSync(recoveryJsonPath), 'last-good workspace recovery artifact exists');
    fs.writeFileSync(workspaceJsonPath, '{ intentionally corrupt metadata');

    electron = launchElectron(DEBUG_PORT, '1280x800');
    browser = await connect(DEBUG_PORT);
    page = await appPage(browser);
    await waitForApp(page);
    const recoveredWorkspace = readWorkspaceJson();
    assert.equal(recoveredWorkspace.id, reopenedWorkspace.id, 'workspace metadata recovered on startup');
    assert.ok(recoveredWorkspace.notebookPages.some((item: any) => item.id === pageId && !item.deletedAt), 'restored page retained by metadata recovery');
    assert.ok(fs.existsSync(drawingJson), 'page drawing remains intact after metadata recovery');
    log.push('recovery: corrupt workspace.json restored from last-good mirror');

    console.log(log.join('\n'));
  } finally {
    restoreAcl();
    if (electron) await stopElectron(electron);
    await cleanupTestWorkspaces(['P1 Integrity Test']).catch(err => console.error('teardown warning:', err));
  }
}, 300000);
