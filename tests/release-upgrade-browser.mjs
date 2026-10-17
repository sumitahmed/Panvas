import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { _electron } from 'playwright';
import { expect } from '@playwright/test';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

// Executes both real packaged versions against one disposable legacy profile.
// This does not install/uninstall NSIS or use any normal Panvas data directory.
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
assert.ok(option('legacy-executable'), '--legacy-executable must identify the published packaged application.');
const root = await mkdtemp(path.join(tmpdir(), 'panvas-release-upgrade-'));
const out = path.resolve(option('out') ?? 'artifacts/release-upgrade');
await mkdir(out, { recursive: true });
await build({ entryPoints: ['src/components/notebook/engine/drawingTypes.ts'], outfile: path.join(root, 'drawing.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { createDefaultDrawingData } = await import(pathToFileURL(path.join(root, 'drawing.mjs')).href);
const assets = await Promise.all([
  ['Pdf', 'legacy-upgrade-pdf', 'diag.pdf', 'application/pdf'],
  ['Image', 'legacy-upgrade-image', 'integrity-test.png', 'image/png'],
  ['Audio', 'legacy-upgrade-audio', 'browser-note.wav', 'audio/wav'],
].map(async ([kind, id, name, mime]) => ({ kind, id, name, mime, bytes: [...await readFile(path.join('tests/fixtures', name))] })));
const env = { ...process.env, PANVAS_GATE0_PROFILE: '1', PANVAS_GATE0_WORKSPACE_ROOT: path.join(root, 'workspaces') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID', 'VITE_DEV_SERVER_URL']) delete env[key];
const evidence = { root, checks: [], errors: [], scope: 'Published 0.1.7 and final packaged application; disposable native data/profile upgrade, not NSIS installation.' };
let app, page;
const launch = async executable => {
  app = await _electron.launch({ executablePath: path.resolve(executable), args: [`--user-data-dir=${path.join(root, 'profile')}`], env });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), path.join(root, 'profile'));
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.panvas.storage.getRoot())).path, path.join(root, 'workspaces'));
  assert.ok(page.url().startsWith('file:'));
  const prompt = page.getByRole('button', { name: 'Continue locally', exact: true });
  if (await prompt.isVisible()) await prompt.click({ force: true });
};
const snapshot = ids => page.evaluate(async ({ ws, book, free, pdf }) => {
  const api = window.panvas;
  return {
    workspace: (await api.workspace.getAll()).find(item => item.id === ws),
    folders: await api.folder.getAll(ws), books: await api.notebook.getAll(ws),
    sections: await api.notebookSection.getAll(ws), pages: await api.notebookPage.getAll(ws),
    drawing: await api.notebook.loadDrawing(ws, book, free),
    annotation: await api.notebook.loadDrawing(ws, book, `${pdf}_pdf_1`),
    preference: await api.settings.get(null, 'release-upgrade-proof'),
    browserPreference: localStorage.getItem('release-upgrade-proof'),
  };
}, ids);
const hashes = async directory => {
  const result = {};
  const walk = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else result[path.relative(directory, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
  } };
  await walk(directory); return result;
};
try {
  await launch(option('legacy-executable'));
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), '0.1.7');
  const ids = await page.evaluate(async ({ assets, empty }) => {
    const api = window.panvas;
    const ws = await api.workspace.create('Disposable legacy upgrade');
    const folder = await api.folder.create(ws.id, 'Research', null);
    const book = await api.notebook.create(ws.id, 'Legacy notebook', folder.id);
    const section = await api.notebookSection.create(ws.id, book.id, 'Legacy notes');
    const free = await api.notebookPage.create(ws.id, book.id, section.id, 'Legacy rich ink');
    for (const asset of assets) {
      const bytes = new Uint8Array(asset.bytes).buffer;
      const ok = asset.kind === 'Pdf' ? await api.binary.storePdf(asset.id, asset.name, bytes)
        : await api.binary[`store${asset.kind}`](asset.id, asset.name, asset.mime, bytes);
      if (!ok) throw Error(`Legacy ${asset.kind} write failed`);
    }
    const pdf = await api.notebookPage.create(ws.id, book.id, section.id, 'Legacy PDF', 'pdf', assets[0].id);
    const drawing = structuredClone(empty);
    drawing.objects.push(
      { id: 'legacy-ink', type: 'stroke', tool: 'pen', color: '#e03131', thickness: 5, opacity: 1, createdAt: 1, points: [{ x: 60, y: 60, pressure: .3, t: 1 }, { x: 240, y: 120, pressure: .8, t: 2 }] },
      { id: 'legacy-text', type: 'text', x: 80, y: 160, width: 500, height: 160, createdAt: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Legacy formatting and user content survive v0.1.8.', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'highlight', attrs: { color: '#ffff00' } }, { type: 'textStyle', attrs: { color: '#123456' } }, { type: 'link', attrs: { href: 'https://example.com/legacy' } }] }] }] } },
      { id: 'legacy-image', type: 'image', x: 80, y: 400, width: 100, height: 100, rotation: 0, opacity: 1, fileId: assets[1].id, createdAt: 1 },
    );
    drawing.audioNotes = [{ id: 'legacy-audio-note', fileId: assets[2].id, fileName: assets[2].name, mimeType: assets[2].mime, createdAt: 1 }];
    await api.notebook.saveDrawing(ws.id, book.id, free.id, drawing);
    const annotation = structuredClone(empty); annotation.objects.push(drawing.objects[0]);
    await api.notebook.saveDrawing(ws.id, book.id, `${pdf.id}_pdf_1`, annotation);
    await api.settings.set(null, 'release-upgrade-proof', { theme: 'dark', marker: 'retain preferences' });
    localStorage.setItem('release-upgrade-proof', 'retain browser preferences');
    return { ws: ws.id, book: book.id, free: free.id, pdf: pdf.id };
  }, { assets, empty: createDefaultDrawingData() });
  const before = await snapshot(ids);
  await app.close(); app = null;
  await cp(path.join(root, 'workspaces'), path.join(root, 'pre-upgrade-copy'), { recursive: true });
  const beforeHashes = await hashes(path.join(root, 'workspaces'));
  assert.deepEqual(await hashes(path.join(root, 'pre-upgrade-copy')), beforeHashes);
  evidence.checks.push('Published packaged 0.1.7 created legacy workspace, hierarchy, rich text, ink, media, PDF annotations and preferences; exact independent copy retained.');
  await launch(option('executable') ?? 'release/win-unpacked/Panvas.exe');
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), JSON.parse(await readFile('package.json', 'utf8')).version);
  assert.deepEqual(await snapshot(ids), before);
  for (const asset of assets) {
    const bytes = await page.evaluate(async ({ kind, id }) => [...new Uint8Array((await window.panvas.binary[`get${kind}`](id)).data)], asset);
    assert.deepEqual(bytes, asset.bytes);
  }
  const afterHashes = await hashes(path.join(root, 'workspaces'));
  for (const [file, digest] of Object.entries(beforeHashes)) assert.equal(afterHashes[file], digest, `Legacy file retained exactly: ${file}`);
  evidence.checks.push('Final packaged application reads identical hierarchy, rich JSON, ink, PDF annotations, all media bytes and native/browser preferences without modifying any legacy workspace file.');
  const tree = page.getByRole('complementary');
  await tree.getByRole('treeitem', { name: 'Disposable legacy upgrade', exact: true }).click();
  const folder = tree.getByRole('treeitem', { name: 'Research', exact: true });
  if (!(await tree.locator(`[data-tree-id="${ids.book}"]`).isVisible())) await folder.click();
  await tree.locator(`[data-tree-id="${ids.book}"]`).click();
  await expect(page.getByText('Legacy formatting and user content survive v0.1.8.', { exact: true }).filter({ visible: true })).toBeVisible();
  await page.screenshot({ path: path.join(out, 'upgraded-legacy-note.png') });
  await app.close(); app = null;
  await launch(option('executable') ?? 'release/win-unpacked/Panvas.exe');
  const reopened = await snapshot(ids);
  assert.deepEqual(reopened.drawing.objects, before.drawing.objects);
  assert.deepEqual(reopened.annotation, before.annotation);
  assert.deepEqual(reopened.preference, before.preference);
  assert.deepEqual(await hashes(path.join(root, 'pre-upgrade-copy')), beforeHashes);
  evidence.checks.push('Legacy note visibly renders through the upgraded UI and remains intact after a full v0.1.8 restart; independent pre-upgrade copy is untouched.');
  evidence.legacyFilesVerified = Object.keys(beforeHashes).length;
  assert.deepEqual(evidence.errors, []); evidence.passed = true;
  console.log('PASS', evidence.checks);
} catch (error) {
  evidence.failure = error.stack; await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error;
} finally {
  await app?.close().catch(() => {});
  await writeFile(path.join(out, 'results.json'), JSON.stringify(evidence, null, 2));
}
