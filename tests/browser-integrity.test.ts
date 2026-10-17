import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

// Browser reloads use the web build's root-relative asset URLs. Electron's
// relative-base build is intended for file://, not nested web routes.
const DIST_DIR = process.env.PANVAS_BROWSER_TEST_DIST ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const TEXT_MARKER = 'Browser persistence marker';

async function writeAudioFixture(): Promise<string> {
  const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'browser-note.wav');
  await mkdir(path.dirname(filePath), { recursive: true });
  // 100 ms mono 8-bit PCM silence with a standard RIFF/WAVE header.
  const samples = Buffer.alloc(800, 128);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(8000, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  await writeFile(filePath, Buffer.concat([header, samples]));
  return filePath;
}

async function startStaticServer(secure = false): Promise<{ url: string; close: () => Promise<void> }> {
  const handler = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    try {
      const requestPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
      if (requestPath === '/seed.html') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Panvas migration seed</title>');
        return;
      }
      const safePath = path.normalize(requestPath).replace(/^([/\\])+/, '');
      let filePath = path.join(DIST_DIR, safePath);
      if (!filePath.startsWith(DIST_DIR)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      try {
        await readFile(filePath);
      } catch {
        if (secure && /\.[a-z0-9]+$/i.test(requestPath)) console.log('offline missing asset:', requestPath);
        filePath = path.join(DIST_DIR, 'index.html');
      }
      const extension = path.extname(filePath);
      const contentType = extension === '.js' || extension === '.mjs'
        ? 'text/javascript'
        : extension === '.css' ? 'text/css' : extension === '.html' ? 'text/html' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': contentType });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404).end('not found');
    }
  };
  let server: http.Server | https.Server;
  if (secure) {
    const certDir = await mkdtemp(path.join(tmpdir(), 'panvas-offline-test-'));
    const key = path.join(certDir, 'test.key'), cert = path.join(certDir, 'test.crt');
    const openssl = process.env.OPENSSL_PATH ?? (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=panvas.test', '-addext', 'subjectAltName=DNS:panvas.test'], { stdio: 'ignore', timeout: 30000 });
    server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, handler);
  } else server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server failed to bind.');
  return {
    url: secure ? `https://panvas.test:${address.port}/` : `http://127.0.0.1:${address.port}/`,
    close: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

async function seedVersion4Database(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('panvas');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Version 4 seed database deletion was blocked.'));
    });

    await new Promise<void>((resolve, reject) => {
      // Dexie maps schema version 4 to native IndexedDB version 40.
      const request = indexedDB.open('panvas', 40);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const database = request.result;
        const createStore = (name: string, keyPath: string, indexes: string[]) => {
          const store = database.createObjectStore(name, { keyPath, autoIncrement: name === 'syncQueue' });
          for (const index of indexes) store.createIndex(index, index);
          return store;
        };
        createStore('workspaces', 'id', ['name', 'updatedAt', 'isPinned', 'syncStatus', 'userId']);
        createStore('folders', 'id', ['workspaceId', 'parentId', 'order', 'syncStatus', 'userId']);
        createStore('canvasFiles', 'id', ['workspaceId', 'folderId', 'updatedAt', 'lastOpenedAt', 'isPinned', 'syncStatus', 'userId']);
        createStore('canvasData', 'canvasFileId', ['userId']);
        createStore('customBlocks', 'id', ['canvasFileId', 'type', 'userId']);
        createStore('pdfFiles', 'id', ['canvasFileId', 'userId']);
        createStore('syncQueue', 'id', ['entityType', 'entityId', 'status', 'createdAt']);
        createStore('notebooks', 'id', ['workspaceId', 'folderId', 'order', 'updatedAt', 'userId']);
        createStore('notebookSections', 'id', ['notebookId', 'order', 'updatedAt', 'userId']);
        createStore('notebookPages', 'id', ['notebookId', 'sectionId', 'order', 'updatedAt', 'userId']);
        createStore('imageFiles', 'id', ['canvasFileId', 'userId']);

        const now = Date.now();
        request.transaction!.objectStore('workspaces').put({
          id: 'ws-migration', name: 'Migration Workspace', createdAt: now, updatedAt: now,
          isPinned: false, syncStatus: 'local', userId: '', deletedAt: null,
        });
        request.transaction!.objectStore('notebooks').put({
          id: 'notebook-migration', workspaceId: 'ws-migration', folderId: null,
          name: 'Version 4 Notebook', createdAt: now, updatedAt: now, order: 0, userId: '',
        });
        request.transaction!.objectStore('notebookSections').put({
          id: 'section-migration', notebookId: 'notebook-migration', name: 'Version 4 Section',
          createdAt: now, updatedAt: now, order: 0, userId: '',
        });
        request.transaction!.objectStore('notebookPages').put({
          id: 'page-migration', notebookId: 'notebook-migration', sectionId: 'section-migration',
          title: 'Version 4 Page', createdAt: now, updatedAt: now, order: 0, userId: '',
        });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
  });
}

async function createNotebookPage(page: Page): Promise<void> {
  const newItem = page.getByRole('button', { name: 'New item' });
  const sidebar = page.getByRole('complementary');
  await newItem.waitFor({ state: 'visible', timeout: 30_000 });
  await newItem.click();
  await page.getByRole('button', { name: 'New Notebook' }).click();
  await page.locator('#create-dialog-input').fill('Browser Integrity Notebook');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const notebook = sidebar.locator('[data-tree-id]').filter({ hasText: 'Browser Integrity Notebook' }).first();
  await notebook.waitFor({ state: 'visible', timeout: 15_000 });
  await notebook.click();
  const notebookToggle = sidebar.locator('button[data-tree-toggle][aria-label$="Browser Integrity Notebook"]');
  if ((await notebookToggle.getAttribute('aria-label'))?.startsWith('Expand')) await notebookToggle.click();

  await newItem.click();
  await page.getByRole('button', { name: 'New Section' }).click();
  await page.locator('#create-dialog-input').fill('Browser Integrity Section');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const section = sidebar.locator('[data-tree-id]').filter({ hasText: 'Browser Integrity Section' }).first();
  await section.waitFor({ state: 'visible', timeout: 15_000 });
  await section.click();

  await newItem.click();
  await page.getByRole('button', { name: 'New Page' }).click();
  await page.locator('#create-dialog-input').fill('Browser Integrity Page');
  await page.getByRole('dialog', { name: 'New Page', exact: true }).getByRole('button', { name: /^Freeform/ }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('button[title="Hide Toolbar"]').waitFor({ state: 'visible', timeout: 15_000 });
}

async function drawAndType(page: Page): Promise<void> {
  const canvas = page.locator('[data-page-id] canvas').first();
  const box = await canvas.boundingBox();
  assert.ok(box, 'notebook canvas has geometry');
  await page.keyboard.press('p');
  await page.mouse.move(box.x + 150, box.y + 200);
  await page.mouse.down();
  for (let step = 0; step < 12; step += 1) {
    await page.mouse.move(box.x + 150 + step * 12, box.y + 200 + Math.sin(step) * 8);
  }
  await page.mouse.up();

  await page.keyboard.press('t');
  await page.mouse.click(box.x + 220, box.y + 320);
  const editor = page.locator('[contenteditable="true"]').last();
  await editor.waitFor({ state: 'visible', timeout: 8_000 });
  await editor.fill(TEXT_MARKER);
  await page.keyboard.press('Escape');
}

async function readDrawingRecords(page: Page): Promise<any[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('panvas');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<any[]>((resolve, reject) => {
        const request = database.transaction('notebookPageDrawings', 'readonly')
          .objectStore('notebookPageDrawings').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

test('browser mode persists notebook objects in IndexedDB without Electron capabilities', async () => {
  const server = await startStaticServer();
  const browser = await chromium.launch({ headless: true });
  let observedPage: Page | undefined;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    observedPage = page;
    await page.addInitScript(() => {
      (window as any).__drawingWrites = [];
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        if (this.name === 'notebookPageDrawings') (window as any).__drawingWrites.push({ at: performance.now(), pageId: value.pageId,
          audio: value.data?.audioNotes?.length, layers: value.data?.layers?.length,
          voice: value.data?.objects?.filter((item: any) => item.metadata?.isVoiceNote).length,
          stack: new Error().stack?.split('\n').slice(1, 5) });
        return put.call(this, value, ...args);
      };
    });
    await page.goto(`${server.url}#/app`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(() => 'panvas' in window), false, 'browser renderer has no Electron preload bridge');

    await createNotebookPage(page);
    await drawAndType(page);
    if (await page.getByRole('button', { name: 'Layers' }).count() === 0) {
      await page.getByTitle('Page utilities').click();
    }
    await page.getByRole('button', { name: 'Layers' }).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Layers' }).click();
    await page.keyboard.press('Control+a');
    await page.getByRole('button', { name: 'Local Elements' }).click();
    await page.getByRole('button', { name: 'Save selection' }).click();
    await page.getByRole('button', { name: 'Local Elements' }).click();
    const audioPath = await writeAudioFixture();
    if (await page.getByRole('button', { name: 'Voice notes' }).count() === 0) {
      await page.getByTitle('Page utilities').click();
    }
    const voiceButton = page.getByRole('button', { name: 'Voice notes' });
    if ((await voiceButton.getAttribute('aria-expanded')) !== 'true') {
      await voiceButton.click();
    }
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await (await chooserPromise).setFiles(audioPath);
    // waitForFunction treats an async predicate's Promise as truthy in this
    // Playwright version, even when it resolves false. Poll completed IDB reads.
    let records: any[] = [];
    const saveDeadline = Date.now() + 10_000;
    while (Date.now() < saveDeadline) {
      records = await readDrawingRecords(page);
      if (records.some(record => (record.data?.audioNotes?.length ?? 0) >= 1 && (record.data?.layers?.length ?? 0) >= 2
        && (record.data?.objects ?? []).some((o: any) => o.type === 'stroke')
        && (record.data?.objects ?? []).some((o: any) => o.type === 'text' && JSON.stringify(o.content).includes(TEXT_MARKER)))) break;
      await page.waitForTimeout(100);
    }
    await mkdir('artifacts/critical-stabilization-20261016/browser-integrity', { recursive: true });
    await writeFile('artifacts/critical-stabilization-20261016/browser-integrity/canonical-before-reload.json', JSON.stringify(records, null, 2));
    assert.ok(records.length >= 1, 'at least one browser-local drawing record');
    const objects = records.flatMap((r: any) => r.data?.objects ?? r.objects ?? []);
    assert.ok(objects.some((object: any) => object.type === 'stroke'), 'stroke persisted in IndexedDB');
    assert.ok(objects.some((object: any) => object.type === 'text' && JSON.stringify(object.content).includes(TEXT_MARKER)), 'text persisted in IndexedDB');
    assert.ok(records.some((r: any) => (r.audioNotes?.length ?? r.data?.audioNotes?.length ?? 0) >= 1 || (r.objects ?? r.data?.objects ?? []).some((o: any) => o.metadata?.isVoiceNote)), 'audio attachment metadata persisted in the page drawing');
    assert.ok(records.some((r: any) => (r.layers?.length ?? r.data?.layers?.length ?? 0) >= 2), 'layer structure persisted in the page drawing');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const sidebar = page.getByRole('complementary');
    const reloadedNotebook = sidebar.locator('[data-tree-id]').filter({ hasText: 'Browser Integrity Notebook' }).first();
    await reloadedNotebook.waitFor({ state: 'visible', timeout: 15_000 });
    await reloadedNotebook.click();
    const reloadedSection = sidebar.locator('[data-tree-id]').filter({ hasText: 'Browser Integrity Section' }).first();
    await reloadedSection.waitFor({ state: 'visible', timeout: 15_000 });
    await reloadedSection.click();
    await sidebar.locator('[data-tree-id]').filter({ hasText: 'Browser Integrity Page' }).first().click();
    await page.locator('button[title="Hide Toolbar"]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByText(TEXT_MARKER).filter({ visible: true }).waitFor({ state: 'visible', timeout: 10_000 });
    if (await page.getByRole('button', { name: 'Local Elements' }).count() === 0) {
      await page.getByTitle('Page utilities').click();
    }
    await page.getByRole('button', { name: 'Local Elements' }).click();
    await page.locator('input[value="Element 1"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Local Elements' }).click();
    if (await page.getByRole('button', { name: 'Voice notes' }).count() === 0) {
      await page.getByTitle('Page utilities').click();
    }
    await page.getByRole('button', { name: 'Voice notes' }).click();
    await page.getByRole('button', { name: /^Play/i }).first().waitFor({ state: 'visible', timeout: 10_000 });
    const reloadedRecords = await readDrawingRecords(page);
    const reloadedObjects = reloadedRecords.flatMap((r: any) => r.data?.objects ?? []);
    assert.ok(reloadedObjects.some((object: any) => object.type === 'stroke'), 'reload preserves the canonical drawing payload');
    assert.ok(reloadedRecords.some((r: any) => (r.audioNotes?.length ?? r.data?.audioNotes?.length ?? 0) >= 1 || (r.objects ?? r.data?.objects ?? []).some((o: any) => o.metadata?.isVoiceNote)), 'reload preserves the audio attachment reference');
    assert.ok(reloadedRecords.some((r: any) => (r.layers?.length ?? r.data?.layers?.length ?? 0) >= 2), 'reload preserves layers');

    // Phase 5 view state is UI-only: a real split reference, two-page spread,
    // Read Mode, and Presentation laser must not mutate the canonical drawing.
    await page.getByRole('button', { name: 'Voice notes' }).click();
    await page.getByRole('button', { name: 'New item' }).click();
    await page.getByRole('button', { name: 'New Page' }).click();
    await page.locator('#create-dialog-input').fill('Browser Integrity Reference');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    if (await page.locator('#pane-layout').count() === 0) {
      await page.getByLabel('Open page and view inspector').click();
    }
    await page.locator('#pane-layout').selectOption('vertical-split');
    await page.getByRole('separator', { name: 'Resize reference pane' }).waitFor({ state: 'visible' });
    await page.getByRole('region', { name: 'Reference: Browser Integrity Page' }).waitFor({ state: 'visible' });
    const separator = page.getByRole('separator', { name: 'Resize reference pane' });
    const separatorBox = await separator.boundingBox();
    assert.ok(separatorBox, 'split separator has geometry');
    await page.mouse.move(separatorBox.x + separatorBox.width / 2, separatorBox.y + 50);
    await page.mouse.down();
    await page.mouse.move(separatorBox.x + 80, separatorBox.y + 50);
    await page.mouse.up();

    if (await page.locator('#pane-layout').count() === 0) {
      await page.getByLabel('Open page and view inspector').click();
    }
    await page.locator('#pane-layout').selectOption('two-page');
    assert.equal(await page.locator('[data-pane-layout="two-page"]').count(), 1, 'two-page layout is active');
    const spreadPages = page.locator('.notebook-viewport .origin-top > [data-page-id]');
    assert.ok(await spreadPages.count() >= 2, 'two-page spread renders both section pages');
    const firstBox = await spreadPages.nth(0).boundingBox();
    const secondBox = await spreadPages.nth(1).boundingBox();
    assert.ok(firstBox && secondBox && Math.abs(firstBox.y - secondBox.y) < 3 && secondBox.x > firstBox.x, 'spread pairs pages side by side');

    await page.getByRole('button', { name: 'Read' }).click();
    assert.equal(await page.locator('button[title="Hide Toolbar"]').count(), 0, 'Read Mode hides editing toolbar');
    await page.getByRole('button', { name: 'Present' }).click();
    await page.getByLabel('Presentation laser (trail)').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Edit' }).getAttribute('aria-pressed'), 'true', 'Escape leaves Presentation Mode safely');

    const unnamedButtons = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
      .filter(button => (button as HTMLElement).offsetParent !== null)
      .filter(button => !button.getAttribute('aria-label') && !button.getAttribute('title') && !button.textContent?.trim())
      .map(button => button.outerHTML.slice(0, 160)));
    assert.deepEqual(unnamedButtons, [], `visible buttons have accessible names: ${unnamedButtons.join(' | ')}`);

    const afterViewChanges = await readDrawingRecords(page);
    const populatedPageId = reloadedRecords.find((r: any) => (r.data?.objects?.length ?? 0) > 0)?.pageId;
    const canonical = afterViewChanges.find((record: any) => record.pageId === populatedPageId);
    assert.deepEqual(canonical?.data?.objects, objects, 'pane and presentation state do not mutate drawing objects');
    assert.ok((canonical?.data?.audioNotes?.length ?? 0) >= 1 || (canonical?.data?.objects ?? []).some((o: any) => o.metadata?.isVoiceNote), 'pane and presentation state do not mutate attachments');
  } finally {
    const artifactDir = path.resolve('artifacts/critical-stabilization-20261016/browser-integrity');
    await mkdir(artifactDir, { recursive: true });
    if (observedPage && !observedPage.isClosed()) {
      await writeFile(path.join(artifactDir, 'write-trace.json'), JSON.stringify(await observedPage.evaluate(() => (window as any).__drawingWrites), null, 2));
      await writeFile(path.join(artifactDir, 'last-ui.txt'), await observedPage.locator('body').innerText());
      await observedPage.screenshot({ path: path.join(artifactDir, 'last.png') });
    }
    await browser.close();
    await server.close();
  }
});

test('browser mode upgrades version 4 notebook metadata without data loss', async () => {
  const server = await startStaticServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`${server.url}seed.html`, { waitUntil: 'domcontentloaded' });
    await seedVersion4Database(page);
    await page.goto(`${server.url}#/app`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'New item' })
      .waitFor({ state: 'visible', timeout: 15_000 });

    const result = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('panvas');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const read = (storeName: string, key: string) => new Promise<any>((resolve, reject) => {
          const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return {
          version: database.version,
          stores: Array.from(database.objectStoreNames),
          notebook: await read('notebooks', 'notebook-migration'),
          section: await read('notebookSections', 'section-migration'),
          page: await read('notebookPages', 'page-migration'),
        };
      } finally {
        database.close();
      }
    });

    assert.equal(result.version, 60, 'Dexie schema upgraded to version 6');
    assert.ok(result.stores.includes('notebookPageContents'), 'content payload store created');
    assert.ok(result.stores.includes('notebookPageDrawings'), 'drawing payload store created');
    assert.equal(result.notebook.name, 'Version 4 Notebook');
    assert.equal(result.notebook.deletedAt, null, 'notebook trash marker normalized');
    assert.equal(result.section.deletedAt, null, 'section trash marker normalized');
    assert.equal(result.page.deletedAt, null, 'page trash marker normalized');
  } finally {
    await browser.close();
    await server.close();
  }
});

test('browser shell reloads offline after one successful load', async () => {
  // Production registers SW only on HTTPS outside localhost. Keep that policy.
  const server = await startStaticServer(true);
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP panvas.test 127.0.0.1', '--no-proxy-server', '--ignore-certificate-errors'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 760 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const registrationErrors: string[] = [];
    page.on('console', message => {
      if (message.type() === 'warning' || message.type() === 'error') console.log('offline:', message.text());
      if (message.text().includes('Offline shell registration failed')) registrationErrors.push(message.text());
    });
    page.on('response', response => { if (/\.(?:js|mjs)(?:\?|$)/.test(response.url()) && response.headers()['content-type']?.includes('text/html')) console.log('offline HTML module:', response.url()); });
    await page.addInitScript(() => {
      (window as any).__loadAdds = [];
      const add = window.addEventListener;
      window.addEventListener = function(type, listener, options) { if (type === 'load') (window as any).__loadAdds.push({ ready: document.readyState, stack: new Error().stack }); return add.call(this, type, listener, options); };
    });
    // A fresh deep link must register the root shell without relying on a
    // worker installed by a previous visit to the origin root.
    await page.goto(`${server.url}app/library`, { waitUntil: 'networkidle' });
    console.log('offline registration observation:', await page.evaluate(async () => ({ ready: document.readyState, secure: isSecureContext, listeners: (window as any).__loadAdds, registrations: (await navigator.serviceWorker.getRegistrations()).length })));
    await page.evaluate(async () => {
      await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Offline service worker did not register')), 20000))]);
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
      }
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New item' }).waitFor({ state: 'visible', timeout: 15_000 });
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'New item' }).waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await page.evaluate(() => 'panvas' in window), false, 'offline browser shell does not gain Electron capabilities');
    assert.deepEqual(registrationErrors, [], 'deep routes register the correct production service worker');
  } finally {
    await browser.close();
    await server.close();
  }
});
