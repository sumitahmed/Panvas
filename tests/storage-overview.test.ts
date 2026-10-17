import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { inspectNativeStorage } from '../electron/ipc/storage-overview.ts';

test('Settings reads independent canonical counts and exact owned file bytes without writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'panvas-storage-overview-'));
  const main = path.join(root, 'data'), external = path.join(root, 'external');
  let expectedBytes = 0;
  const put = async (dir: string, name: string, data: string) => {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), data); expectedBytes += Buffer.byteLength(data);
  };
  const workspace = (id: string, canvases: number, pages: number) => ({
    id, name: id, canvasFiles: Array.from({ length: canvases }, (_, index) => ({ id: `${id}-canvas${index}` })),
    notebooks: [{ id: `${id}-notebook` }], notebookSections: [{ id: `${id}-section`, notebookId: `${id}-notebook` }],
    notebookPages: [...Array.from({ length: pages }, (_, index) => ({ id: `${id}-page${index}`, notebookId: `${id}-notebook`, sectionId: `${id}-section` })),
      { id: 'deleted', deletedAt: 1 }, { id: 'orphan', notebookId: 'missing' }],
  });
  await put(main, 'one/.panvas/workspace.json', JSON.stringify(workspace('one', 2, 3)));
  await put(external, '.panvas/workspace.json', JSON.stringify(workspace('two', 1, 1)));
  await put(main, 'one/Notebooks/one/page.drawing.json', 'drawing bytes');
  await put(main, 'Assets/image-store/picture.bin', 'asset bytes');
  await put(external, '.panvas/recovery/workspace.last-good.json', 'recovery bytes');
  await writeFile(path.join(external, 'unrelated.txt'), 'not Panvas data');
  const metadataBefore = await readFile(path.join(external, '.panvas/workspace.json'), 'utf8');
  const result = await inspectNativeStorage({ root: { path: main, configuredPath: main, available: true, isDefault: false }, roots: [main], registeredDirs: [external], budgetMs: 10_000 });
  assert.deepEqual(result.counts, { workspaces: 2, canvases: 3, notebooks: 2, pages: 4 });
  assert.equal(result.countsComplete, true);
  assert.equal(result.usedBytes, expectedBytes);
  assert.equal(result.usageKind, 'measured');
  assert.equal(result.health, 'accessible');
  assert.equal(await readFile(path.join(external, '.panvas/workspace.json'), 'utf8'), metadataBefore);
});

test('empty storage reports measured zero, missing storage reports unavailable, corruption reports attention', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'panvas-storage-empty-'));
  const inspect = (directory: string, extra = {}) => inspectNativeStorage({ root: { path: directory, configuredPath: null, available: true, isDefault: true }, roots: [directory], registeredDirs: [], ...extra });
  const empty = await inspect(root);
  assert.equal(empty.usedBytes, 0); assert.equal(empty.usageKind, 'measured');
  assert.deepEqual(empty.counts, { workspaces: 0, canvases: 0, notebooks: 0, pages: 0 });
  const inactive = await inspect(root, { root: { path: root, configuredPath: root, available: false, isDefault: false } });
  assert.equal(inactive.health, 'unavailable'); assert.equal(inactive.counts, null);
  const missing = await inspect(path.join(root, 'missing'));
  assert.equal(missing.health, 'unavailable'); assert.equal(missing.usedBytes, null);
  await mkdir(path.join(root, 'bad/.panvas'), { recursive: true });
  await writeFile(path.join(root, 'bad/.panvas/workspace.json'), '{invalid');
  const bad = await inspect(root);
  assert.equal(bad.health, 'attention'); assert.equal(bad.countsComplete, false); assert.equal(bad.usageKind, 'partial');
  assert.equal(await readFile(path.join(root, 'bad/.panvas/workspace.json'), 'utf8'), '{invalid');
});

test('a bounded scan labels its lower bound rather than claiming complete usage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'panvas-storage-bounded-'));
  await mkdir(path.join(root, 'Assets'), { recursive: true });
  for (let index = 0; index < 10; index++) await writeFile(path.join(root, 'Assets', `${index}.bin`), Buffer.alloc(100));
  const result = await inspectNativeStorage({ root: { path: root, configuredPath: null, available: true, isDefault: true }, roots: [root], registeredDirs: [], maxEntries: 2 });
  assert.equal(result.usageKind, 'partial'); assert.equal(result.health, 'attention');
  assert.ok(result.usedBytes! < 1_000);
});
