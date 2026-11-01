// Mobile browser experience probe: drives the REAL app shell, PDF workspace,
// and notebook renderer under emulated phone viewports (portrait + landscape).
// Verifies the docked reading layout: auto-hiding tool dock, tap-to-reveal,
// sheet menus, rotation-aware PDF fit, and untouched desktop behavior.
// Usage: node tests/mobile-viewport-probe.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const outDir = 'artifacts/mobile-viewport-probe';
await mkdir(outDir, { recursive: true });

// Five-page probe PDF so rotation/refit and scrolling have real content.
const pdfDoc = await PDFDocument.create();
const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 5; i++) {
  const pdfPage = pdfDoc.addPage([595, 842]);
  pdfPage.drawText(`Mobile probe page ${i}`, { x: 60, y: 770, size: 24, font });
}
const pdfBase64 = Buffer.from(await pdfDoc.save()).toString('base64');

const server = await createServer({ mode: 'web', server: { port: 0, open: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });

const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

// ---------------------------------------------------------------- seed ----
const phone = await browser.newPage({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const errors = [];
phone.on('pageerror', e => errors.push(e.message));
await phone.goto(url + 'app', { timeout: 120000 });
await phone.waitForSelector('.panvas-topbar', { timeout: 90000 });

const seedInPage = (page, pdfB64) => page.evaluate(async pdfB64 => {
  const { workspaceRepository } = await import('/src/repositories/WorkspaceRepository.ts');
  const { notebookRepository } = await import('/src/repositories/NotebookRepository.ts');
  const { canvasRepository } = await import('/src/repositories/CanvasRepository.ts');
  const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
  const workspace = await workspaceRepository.create(null, 'Mobile Probe');
  const notebook = await notebookRepository.create(null, workspace.id, null, 'Probe Notebook');
  const section = await notebookRepository.createSection(null, workspace.id, notebook.id, 'Section');
  const textPage = await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, 'Probe page', 'default');
  const bytes = Uint8Array.from(atob(pdfB64), ch => ch.charCodeAt(0));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const stored = await canvasRepository.storePdf(null, 'probe-pdf', 'mobile-probe.pdf', buffer);
  const pdfPage = await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, 'Probe PDF', 'pdf', stored.id);
  await useWorkspaceStore.getState().loadWorkspaceContents(workspace.id);
  return { workspaceId: workspace.id, textPageId: textPage.id, pdfPageId: pdfPage.id };
}, pdfB64);
const seeded = await seedInPage(phone, pdfBase64);
console.log('seeded:', JSON.stringify(seeded));
await phone.reload({ timeout: 120000 });
await phone.waitForSelector('.panvas-topbar', { timeout: 90000 });

const gotoDocument = async (page, pageId) => {
  await page.evaluate(async ({ targetPageId, workspaceId }) => {
    const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
    await useWorkspaceStore.getState().loadWorkspaceContents(workspaceId).catch(() => {});
    await useWorkspaceStore.getState().setActivePage(targetPageId);
    window.history.pushState({}, '', '/app');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, { targetPageId: pageId, workspaceId: seeded.workspaceId });
};

const openPdf = async page => {
  await gotoDocument(page, seeded.pdfPageId);
  try {
    await page.waitForSelector('[data-pdf-source-page="1"]', { timeout: 60000 });
  } catch (err) {
    const diag = await page.evaluate(async () => {
      const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
      const state = useWorkspaceStore.getState();
      return {
        path: window.location.pathname,
        activePageId: state.activePageId,
        pages: state.notebookPages.length,
        isLoading: state.isLoading,
        restoreComplete: state.initialDocumentRestoreComplete,
        topbar: Boolean(document.querySelector('.panvas-topbar')),
        dock: Boolean(document.querySelector('.panvas-mobile-tool-dock')),
      };
    }).catch(e => ({ diagError: String(e) }));
    console.error('openPdf diagnostics:', JSON.stringify(diag));
    throw err;
  }
};

const openNotebook = async page => {
  await gotoDocument(page, seeded.textPageId);
  await page.waitForSelector('.panvas-notebook-workspace', { timeout: 60000 });
};

const metrics = page => page.evaluate(() => {
  const dock = document.querySelector('.panvas-mobile-tool-dock');
  const dockRect = dock?.getBoundingClientRect();
  const pdfPage = document.querySelector('[data-pdf-source-page="1"]');
  const saveStatus = document.querySelector('[data-testid="save-status"]');
  const topbar = document.querySelector('.panvas-topbar');
  return {
    dockPresent: Boolean(dock),
    dockHidden: dock?.dataset.dockHidden ?? null,
    dockHeight: dockRect ? Math.round(dockRect.height) : null,
    revealHandle: Boolean(document.querySelector('.panvas-mobile-dock-reveal')),
    pdfPageWidth: pdfPage ? Math.round(pdfPage.getBoundingClientRect().width) : null,
    pdfPageCenterOffset: (() => {
      if (!pdfPage) return null;
      const rect = pdfPage.getBoundingClientRect();
      return Math.round(rect.left + rect.width / 2 - window.innerWidth / 2);
    })(),
    statusbarVisible: saveStatus ? saveStatus.getBoundingClientRect().height > 0 : false,
    topbarVisible: topbar ? topbar.getBoundingClientRect().height > 0 : false,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
});

// ------------------------------------------------- portrait PDF reading ----
await openPdf(phone);
let m = await metrics(phone);
console.log('430x932 portrait pdf:', JSON.stringify(m));
assert.equal(m.dockPresent, true, 'phone portrait must render the tool dock');
assert.equal(m.statusbarVisible, false, 'phone portrait must hide the status bar');
assert.ok(Math.abs(m.pdfPageWidth - (430 - 16)) <= 4, `pdf must fit portrait width (got ${m.pdfPageWidth})`);
await shot(phone, 'pdf-portrait-430');

// Reading mode: hand tool, dock auto-hides, tap reveals.
await phone.click('button[title="Hand (Space)"]');
await phone.waitForSelector('.panvas-mobile-tool-dock[data-dock-hidden="true"]', { state: 'attached', timeout: 8000 });
m = await metrics(phone);
assert.equal(m.revealHandle, true, 'reveal handle must appear while dock is hidden');
await shot(phone, 'pdf-portrait-dock-hidden');
const beforeTapScroll = await phone.evaluate(() => document.querySelector('[data-panvas-scroll-viewport]').scrollTop);
await phone.touchscreen.tap(215, 420);
await phone.waitForSelector('.panvas-mobile-tool-dock[data-dock-hidden="false"]', { timeout: 4000 });
m = await metrics(phone);
assert.equal(m.dockHidden, 'false', 'tapping the document must reveal the dock');
assert.equal(await phone.evaluate(() => document.querySelector('[data-panvas-scroll-viewport]').scrollTop), beforeTapScroll, 'dock reveal must not scroll or jump the document');

// More menu renders as a bottom sheet on the phone.
await phone.click('button[title="More Tools"]');
await phone.waitForSelector('.panvas-mobile-sheet .panvas-more-menu', { timeout: 5000 });
await shot(phone, 'pdf-portrait-more-sheet');
await phone.click('.panvas-sheet-close');
await phone.waitForSelector('.panvas-mobile-sheet .panvas-more-menu', { state: 'detached', timeout: 5000 });

// Full Page on the phone: chrome hides, floating exit pill appears.
await phone.click('button[title="More Tools"]');
await phone.waitForSelector('.panvas-mobile-sheet .panvas-more-menu', { timeout: 5000 });
await phone.click('button[aria-label="Enter Full Page View"]');
await phone.waitForSelector('.panvas-mobile-sheet .panvas-more-menu', { state: 'detached', timeout: 5000 });
await phone.waitForSelector('.panvas-layer-toolbar button[aria-label="Exit Full Page View"]', { timeout: 5000 });
await phone.waitForTimeout(400);
m = await metrics(phone);
console.log('430x932 portrait full page:', JSON.stringify(m));
assert.equal(m.topbarVisible, false, 'Full Page must hide the top bar');
await shot(phone, 'pdf-portrait-fullpage');
await phone.click('.panvas-layer-toolbar button[aria-label="Exit Full Page View"]');
await phone.waitForSelector('.panvas-layer-toolbar button[aria-label="Exit Full Page View"]', { state: 'detached', timeout: 5000 });

// ----------------------------------------------- rotation / landscape ----
const rotate = async (width, height) => {
  await phone.setViewportSize({ width, height });
  await phone.waitForTimeout(600);
};
await rotate(932, 430);
await phone.waitForFunction(() => {
  const pdfPage = document.querySelector('[data-pdf-source-page="1"]');
  return pdfPage && Math.abs(pdfPage.getBoundingClientRect().width - (window.innerWidth - 16)) <= 4;
}, null, { timeout: 8000 });
m = await metrics(phone);
console.log('932x430 landscape pdf:', JSON.stringify(m));
assert.equal(m.dockPresent, true, 'landscape phone must keep the mobile dock');
assert.equal(m.statusbarVisible, false, 'landscape phone must hide the status bar');
assert.ok(Math.abs(m.pdfPageWidth - (932 - 16)) <= 4, `pdf must refit to landscape width (got ${m.pdfPageWidth})`);
assert.ok(Math.abs(m.pdfPageCenterOffset) <= 40, `landscape refit must re-center the page (offset ${m.pdfPageCenterOffset})`);
await shot(phone, 'pdf-landscape-932');

// Landscape sheet menu.
await phone.click('button[title="More Tools"]');
await phone.waitForSelector('.panvas-mobile-sheet .panvas-more-menu', { timeout: 5000 });
await shot(phone, 'pdf-landscape-more-sheet');
await phone.click('.panvas-sheet-close');
await phone.waitForSelector('.panvas-mobile-sheet .panvas-more-menu', { state: 'detached', timeout: 5000 });

// Landscape reading: dock auto-hide + reveal handle.
await phone.click('button[title="Hand (Space)"]');
await phone.waitForSelector('.panvas-mobile-tool-dock[data-dock-hidden="true"]', { state: 'attached', timeout: 8000 });
await shot(phone, 'pdf-landscape-dock-hidden');
await phone.touchscreen.tap(466, 200);
await phone.waitForSelector('.panvas-mobile-tool-dock[data-dock-hidden="false"]', { timeout: 4000 });

// Fit page from the sheet in landscape.
await phone.click('button[title="More Tools"]');
await phone.waitForSelector('.panvas-mobile-sheet .panvas-more-menu', { timeout: 5000 });
await phone.click('button[aria-label="Fit PDF page"]');
await phone.waitForTimeout(700);
const fitPageWidth = await phone.evaluate(() => {
  const pdfPage = document.querySelector('[data-pdf-source-page="1"]');
  return pdfPage ? Math.round(pdfPage.getBoundingClientRect().width) : null;
});
console.log('landscape fit-page width:', fitPageWidth);
assert.ok(fitPageWidth && fitPageWidth <= 932 - 16 + 2, 'fit page must not exceed viewport width');
await rotate(430, 932);
await phone.waitForFunction(() => {
  const pdfPage = document.querySelector('[data-pdf-source-page="1"]');
  return pdfPage && Math.abs(pdfPage.getBoundingClientRect().width - (window.innerWidth - 16)) <= 4;
}, null, { timeout: 8000 });
console.log('rotated back to portrait, refit ok');

// --------------------------------------------------- notebook surface ----
await openNotebook(phone);
await phone.waitForSelector('.panvas-mobile-tool-dock', { timeout: 30000 });
m = await metrics(phone);
console.log('430x932 notebook:', JSON.stringify(m));
assert.equal(m.dockPresent, true, 'notebook phone must render the tool dock');
await shot(phone, 'notebook-portrait-430');
await phone.click('button[title="Hand (Space)"]');
await phone.waitForSelector('.panvas-mobile-tool-dock[data-dock-hidden="true"]', { state: 'attached', timeout: 8000 });
await shot(phone, 'notebook-portrait-dock-hidden');
await phone.touchscreen.tap(215, 420);
await phone.waitForSelector('.panvas-mobile-tool-dock[data-dock-hidden="false"]', { timeout: 4000 });
await rotate(932, 430);
await phone.waitForSelector('.panvas-mobile-document-header', { timeout: 8000 });
m = await metrics(phone);
console.log('932x430 notebook:', JSON.stringify(m));
assert.equal(m.dockPresent, true, 'landscape notebook must keep the mobile dock');
assert.equal(m.statusbarVisible, false, 'landscape notebook must hide the status bar');
await shot(phone, 'notebook-landscape-932');
await rotate(430, 932);

// --------------------------------------------- phone viewport matrix ----
for (const [w, h] of [[360, 800], [390, 844], [412, 915]]) {
  await rotate(w, h);
  await openPdf(phone);
  m = await metrics(phone);
  console.log(`${w}x${h} pdf:`, JSON.stringify(m));
  assert.equal(m.dockPresent, true, `${w}x${h} must render the dock`);
  assert.equal(m.statusbarVisible, false, `${w}x${h} must hide the status bar`);
  assert.ok(Math.abs(m.pdfPageWidth - (w - 16)) <= 4, `${w}x${h} pdf must fit width (got ${m.pdfPageWidth})`);
  await shot(phone, `pdf-portrait-${w}x${h}`);
  await phone.click('button[title="More Tools"]');
  await phone.waitForSelector('.panvas-mobile-sheet .panvas-more-menu', { timeout: 5000 });
  await shot(phone, `pdf-portrait-${w}x${h}-sheet`);
  await phone.click('.panvas-sheet-close');
  await rotate(h, w);
  m = await metrics(phone);
  assert.equal(m.dockPresent, true, `${h}x${w} landscape must render the dock`);
  assert.equal(m.statusbarVisible, false, `${h}x${w} landscape must hide the status bar`);
  await shot(phone, `pdf-landscape-${h}x${w}`);
  await rotate(w, h);
}

await phone.close();

// ------------------------------------------------------ desktop guard ----
const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
desktop.on('pageerror', e => errors.push(e.message));
await desktop.goto(url + 'app', { timeout: 120000 });
await desktop.waitForSelector('.panvas-topbar', { timeout: 90000 });
const desktopSeed = await seedInPage(desktop, pdfBase64);
await desktop.reload({ timeout: 120000 });
await desktop.waitForSelector('.panvas-topbar', { timeout: 90000 });
await gotoDocument(desktop, desktopSeed.pdfPageId);
await desktop.waitForSelector('[data-pdf-source-page="1"]', { timeout: 60000 });
const dm = await desktop.evaluate(() => ({
  dockPresent: Boolean(document.querySelector('.panvas-mobile-tool-dock')),
  statusbarVisible: document.querySelector('[data-testid="save-status"]')?.getBoundingClientRect().height > 0,
  floatingToolbar: Boolean(document.querySelector('.panvas-floating-toolbar .panvas-toolbar-surface')),
  bottomNavigation: Boolean(document.querySelector('[aria-label="PDF page controls"]')),
}));
console.log('desktop 1440x900 pdf:', JSON.stringify(dm));
assert.equal(dm.dockPresent, false, 'desktop must NOT render the mobile dock');
assert.equal(dm.statusbarVisible, true, 'desktop must keep the status bar');
assert.equal(dm.floatingToolbar, true, 'desktop must keep the floating toolbar');
assert.equal(dm.bottomNavigation, true, 'desktop must keep the bottom navigation');
await shot(desktop, 'desktop-1440-pdf');
await desktop.close();

await browser.close();
await server.close();

if (errors.length > 0) {
  console.error('PAGE ERRORS:', errors);
  process.exit(1);
}
console.log('mobile viewport probe: ALL CHECKS PASSED');
