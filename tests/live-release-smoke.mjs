import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = option('base');
assert.ok(base && new URL(base).protocol === 'https:', '--base requires the existing HTTPS production origin.');
const out = path.resolve(option('out') ?? 'artifacts/live-release'); await mkdir(out, { recursive: true });
const seed = process.argv.includes('--seed'), statePath = path.join(out, 'upgrade-state.json');
const state = seed ? { root: await mkdtemp(path.join(tmpdir(), 'panvas-live-release-')), base, marker: 'Release upgrade preserves this browser note.' } : JSON.parse(await readFile(statePath, 'utf8'));
assert.equal(state.base, base);
assert.ok(state.root.startsWith(path.join(tmpdir(), 'panvas-live-release-')));
const context = await chromium.launchPersistentContext(path.join(state.root, 'profile'), { headless: true, viewport: { width: 1440, height: 1000 } });
const page = context.pages()[0]; page.setDefaultTimeout(30000);
const evidence = { base, root: state.root, phase: seed ? 'pre-deploy' : 'post-deploy', checks: [], errors: [], consoleErrors: [] };
page.on('pageerror', error => evidence.errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
const records = () => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('panvas'); request.onerror = () => reject(request.error);
  request.onsuccess = () => { const db = request.result, result = {}, names = [...db.objectStoreNames];
    const transaction = db.transaction(names, 'readonly');
    for (const name of names) { const item = transaction.objectStore(name).getAll(); item.onsuccess = () => { result[name] = item.result; }; }
    transaction.oncomplete = () => { db.close(); resolve(result); }; transaction.onerror = () => reject(transaction.error);
  };
}));
try {
  await page.goto(base + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
  const local = page.getByRole('button', { name: 'Continue locally', exact: true }); if (await local.isVisible()) await local.click({ force: true });
  if (seed) {
    await page.getByRole('button', { name: 'New item', exact: true }).click();
    await page.getByRole('button', { name: 'New Notebook', exact: true }).click();
    await page.locator('#create-dialog-input').fill('Release browser upgrade');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('#create-dialog-input').waitFor({ state: 'hidden' });
    await page.getByRole('complementary').getByText('Release browser upgrade', { exact: true }).click();
    // Unmount the old editor before inserting the fixture so an old in-memory
    // autosave cannot overwrite the deliberately seeded upgrade data.
    await page.goto(base + '/privacy', { waitUntil: 'domcontentloaded' }); await page.locator('h1').waitFor();
    // Seed a representative legacy drawing in this disposable browser profile.
    // The existing production UI creates the hierarchy and renders the fixture;
    // only the post-deployment phase claims UI-authored text persistence.
    await page.evaluate(marker => new Promise((resolve, reject) => {
      const request = indexedDB.open('panvas'); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction(['notebooks', 'notebookPages', 'notebookPageDrawings'], 'readwrite');
        const books = transaction.objectStore('notebooks').getAll();
        books.onsuccess = () => {
          const book = books.result.find(item => item.name === 'Release browser upgrade');
          const pages = transaction.objectStore('notebookPages').getAll();
          pages.onsuccess = () => {
            const page = pages.result.find(item => item.notebookId === book.id);
            const drawings = transaction.objectStore('notebookPageDrawings'), drawing = drawings.get(page.id);
            drawing.onsuccess = () => {
              const record = drawing.result;
              if (!record?.data) { transaction.abort(); return; }
              record.data.objects.push({ id: 'release-upgrade-text', type: 'text', x: 80, y: 180, width: 500, height: 100, opacity: 1, createdAt: 1,
                content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: marker, marks: [{ type: 'bold' }] }] }] } });
              drawings.put(record);
            };
          };
        };
        transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onabort = () => { db.close(); reject(transaction.error ?? Error('Legacy fixture write aborted')); };
      };
    }), state.marker);
    await page.goto(base + '/app', { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
    await page.getByRole('complementary').getByText('Release browser upgrade', { exact: true }).click();
    await expect(page.getByText(state.marker, { exact: true }).filter({ visible: true })).toBeVisible();
    await expect.poll(async () => JSON.stringify(await records()).includes(state.marker), { timeout: 30000 }).toBe(true);
    state.records = await records();
    await writeFile(statePath, JSON.stringify(state, null, 2));
    evidence.checks.push('Existing production UI created the hierarchy and visibly rendered a synthetic legacy IndexedDB note in a fresh profile before deployment.');
  } else {
    await page.evaluate(async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.update(); });
    await page.reload(); await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
    const current = await records();
    for (const [store, values] of Object.entries(state.records)) for (const record of values) {
      if (record.id !== undefined) assert.ok(current[store]?.some(item => item.id === record.id), `Existing record retained: ${store}/${record.id}`);
    }
    assert.ok(JSON.stringify(current).includes(state.marker));
    await page.getByRole('complementary').getByText('Release browser upgrade', { exact: true }).click();
    await expect(page.getByText(state.marker, { exact: true }).filter({ visible: true })).toBeVisible();
    const version = JSON.parse(await readFile('package.json', 'utf8')).version;
    await expect(page.getByText(`v${version}`, { exact: true })).toBeVisible();
    evidence.checks.push('Same production origin and browser profile retained every identified legacy record and visibly reopened the pre-deployment note under the new version.');
    await page.keyboard.press('t');
    const text = page.getByText(state.marker, { exact: true }).filter({ visible: true }); await text.dblclick();
    const editor = page.locator('[contenteditable="true"]').last(); await editor.waitFor(); await editor.focus();
    await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type(' Edited after deployment.'); await page.keyboard.press('Escape');
    await expect.poll(async () => JSON.stringify(await records()).includes('Edited after deployment.')).toBe(true);
    await page.reload(); await expect(page.getByText(/Edited after deployment\./).filter({ visible: true })).toBeVisible();
    evidence.checks.push('Live production editing and refresh preserve the post-deployment edit.');
    for (const route of ['/', '/download', '/privacy', '/terms', '/security', '/roadmap', '/app/library']) {
      assert.equal((await page.goto(base + route)).status(), 200); await page.locator('main').first().waitFor();
      assert.equal((await page.reload()).status(), 200);
    }
    await page.goto(base + '/download'); await page.locator('h1').waitFor();
    const links = await page.locator('a[href*="releases/download"]').evaluateAll(items => items.map(a => a.href));
    assert.ok(links.some(url => url.endsWith(`/v${version}/Panvas-${version}-Setup.exe`)));
    assert.ok(links.every(url => url.includes(`/v${version}/`))); evidence.downloadLinks = links;
    await page.goto(base + '/'); await page.locator('h1').waitFor();
    await page.locator('img').evaluateAll(images => { for (const image of images) image.loading = 'eager'; });
    await expect.poll(() => page.locator('img').evaluateAll(images => images.filter(image => !image.complete || !image.naturalWidth).map(image => image.src))).toEqual([]);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(out, `live-landing-${width}.png`) });
    }
    evidence.checks.push('Production routes refresh, landing images load, download metadata matches the published release, and desktop/mobile widths fit.');
  }
  await page.screenshot({ path: path.join(out, seed ? 'legacy-production-note.png' : 'production-final.png') });
  assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.consoleErrors, []); evidence.passed = true;
  console.log('PASS', evidence.checks);
} catch (error) { evidence.failure = error.stack; await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error; }
finally { await context.close(); await writeFile(path.join(out, seed ? 'before.json' : 'results.json'), JSON.stringify(evidence, null, 2)); }
