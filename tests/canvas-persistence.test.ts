import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { writeQueue } from '../electron/ipc/write-queue.ts';
import { mergeCanvasAppStateForPersistence } from '../src/services/canvas/canvasSceneState.ts';
import { buildCanonicalCanvasPayload, isValidCanvasScenePayload, selectCanonicalCanvasScene } from '../src/repositories/canvasSceneStorage.ts';
import { validateEntityName, InvalidEntityNameError } from '../src/lib/entityName.ts';
import type { CanvasData, CustomBlock } from '../src/types/canvas';

function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

function scene(id: string, updatedAt: number, elements: unknown[] = [{ id: 'el-1' }]): CanvasData {
  return { canvasFileId: id, elements, appState: {}, files: {}, customBlocks: [], version: 1, updatedAt, userId: null };
}

function block(id: string, content = '# note'): CustomBlock {
  return { id, canvasFileId: 'canvas-1', type: 'markdown', x: 0, y: 0, width: 320, height: 120, content, createdAt: 1, updatedAt: 1, userId: null };
}

test('real Canvas repository saves Electron object/null loads, settings and images through atomic storage and recovers status', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'panvas-canvas-save-'));
  const originalWindow = (globalThis as any).window;
  let rejectWrite = false;
  let rejectRead = false;
  let writes = 0;
  const contentPath = path.join(directory, 'canvas-1.json');
  (globalThis as any).window = { panvas: { canvas: {
    load: async () => {
      if (rejectRead) throw new Error('Test read failure');
      try { return JSON.parse(await readFile(contentPath, 'utf8')); }
      catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
    },
    save: async (_workspace: string, _id: string, payload: unknown) => {
      if (rejectWrite) throw new Error('Test write failure');
      const cloned = structuredClone(payload);
      const json = JSON.stringify(cloned);
      assert.ok(Buffer.byteLength(json, 'utf8') < 10 * 1024 * 1024);
      await writeQueue.enqueue(contentPath, json);
      writes++;
    },
  } } };
  const stubs: Record<string, string> = {
    '/src/database/workspaceDB.ts': 'export {};',
    '/src/database/canvasDB.ts': 'export async function getBlocksByCanvas() { return []; }',
    '/src/database/schema.ts': 'export const db = {};',
    '/src/services/cloudsync/recordLocalChange.ts': 'export function recordLocalChangeDetached() {}',
    '/src/stores/authStore.ts': 'export const useAuthStore = { getState: () => ({ user: null }) };',
    '/src/stores/syncStore.ts': 'export const useSyncStore = { getState: () => ({ incrementPending() {} }) };',
  };
  const server = await createServer({
    configFile: false, envDir: directory, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true },
    resolve: { alias: { '@': path.resolve('src') } },
    plugins: [{ name: 'canvas-boundary-test', enforce: 'pre', load(id) {
      const key = Object.keys(stubs).find((suffix) => id.replaceAll('\\', '/').endsWith(suffix));
      return key ? stubs[key] : null;
    } }],
  });
  try {
    const { canvasRepository } = await server.ssrLoadModule('/src/repositories/CanvasRepository.ts');
    const appState = mergeCanvasAppStateForPersistence({}, {
      viewBackgroundColor: '#f7f1e3', theme: 'light', gridSize: 20,
      objectsSnapModeEnabled: true, isBindingEnabled: false, zoom: { value: 1.2 },
      scrollX: 12, scrollY: -30, currentItemStrokeColor: '#123456',
      currentItemBackgroundColor: 'transparent', currentItemOpacity: 65,
      currentItemFillStyle: 'hachure', currentItemStrokeWidth: 2,
      currentItemStartArrowhead: null, currentItemEndArrowhead: 'arrow',
    });
    const files = { image1: { id: 'image1', mimeType: 'image/png', dataURL: 'data:image/png;base64,aGVsbG8=', created: 1 } };
    const data = { canvasFileId: 'canvas-1', elements: [{ id: 'image-element', type: 'image', fileId: 'image1' }], appState, files };
    await canvasRepository.saveData(null, data, 'workspace-1');
    const first = JSON.parse(await readFile(contentPath, 'utf8'));
    assert.deepEqual(first.appState, appState);
    assert.deepEqual(first.files, files);
    assert.equal(first.version, 1);
    await canvasRepository.saveData(null, { canvasFileId: 'canvas-1', elements: [{ id: 'shape-2' }] }, 'workspace-1');
    const second = JSON.parse(await readFile(contentPath, 'utf8'));
    assert.equal(second.version, 2);
    assert.deepEqual(second.appState, appState);
    assert.deepEqual(second.files, files);

    rejectRead = true;
    await assert.rejects(canvasRepository.saveData(null, data, 'workspace-1'), /Test read failure/);
    assert.equal(writes, 2, 'failed read must not overwrite the existing scene');
    rejectRead = false;

    const { useCanvasStore } = await server.ssrLoadModule('/src/stores/canvasStore.ts');
    const statuses: string[] = [];
    const unsubscribe = useCanvasStore.subscribe((state: any) => statuses.push(state.saveStatus));
    try {
      rejectWrite = true;
      await assert.rejects(useCanvasStore.getState().saveCanvasData(data, 'workspace-1'), /Test write failure/);
      assert.equal(useCanvasStore.getState().saveStatus, 'error');
      rejectWrite = false;
      await useCanvasStore.getState().saveCanvasData(data, 'workspace-1');
      assert.equal(useCanvasStore.getState().saveStatus, 'saved');
      assert.deepEqual(statuses, ['saving', 'error', 'saving', 'saved']);
    } finally { unsubscribe(); }
  } finally {
    await server.close();
    (globalThis as any).window = originalWindow;
    await rm(directory, { recursive: true, force: true });
  }
});

// ---- Adapter selection (behavioral via the pure decision + source contract) ----

test('invalid payloads never win arbitration', () => {
  assert.equal(isValidCanvasScenePayload(null), false);
  assert.equal(isValidCanvasScenePayload({ canvasFileId: 'x' }), false, 'elements array is mandatory');
  const decision = selectCanonicalCanvasScene(null, scene('c-1', 5));
  assert.equal(decision.scene?.updatedAt, 5);
  assert.equal(decision.writeForwardLegacy, true, 'legacy-only scene must be adopted into the canonical file');
});

test('newest-wins arbitration: filesystem wins ties, legacy wins only when strictly newer', () => {
  const file = scene('c-1', 100);
  const legacy = scene('c-1', 100);
  assert.equal(selectCanonicalCanvasScene(file, legacy).writeForwardLegacy, false, 'tie → filesystem (no endless migration)');

  const newerFile = selectCanonicalCanvasScene(scene('c-1', 200), scene('c-1', 100));
  assert.equal(newerFile.scene?.updatedAt, 200);
  assert.equal(newerFile.writeForwardLegacy, false, 'never overwrite newer canonical data with legacy');

  const newerLegacy = selectCanonicalCanvasScene(scene('c-1', 100), scene('c-1', 200));
  assert.equal(newerLegacy.scene?.updatedAt, 200);
  assert.equal(newerLegacy.writeForwardLegacy, true, 'strictly newer legacy scene is written forward exactly once');

  assert.equal(selectCanonicalCanvasScene(scene('c-1', 100), null).scene?.updatedAt, 100);
});

test('canonical payload embeds custom blocks, bumps version, and merges partial saves', () => {
  const previous = scene('canvas-1', 50);
  previous.version = 7;
  previous.appState = { zoom: 2 } as CanvasData['appState'];
  const payload = buildCanonicalCanvasPayload(
    { canvasFileId: 'canvas-1', elements: [{ id: 'el-2' }], appState: {}, files: {} },
    previous,
    [block('block-1'), block('block-2', '$E=mc^2$')],
    'user-1',
    999,
  );
  assert.deepEqual(payload.customBlocks.map(b => b.id), ['block-1', 'block-2'], 'custom blocks are part of the ONE canonical representation');
  assert.equal(payload.version, 8);
  assert.equal(payload.updatedAt, 999);
  assert.equal(payload.userId, 'user-1');
  assert.equal(payload.elements.length, 1);

  // Partial autosave (no files/appState given) merges over the previous scene.
  const partial = buildCanonicalCanvasPayload({ canvasFileId: 'canvas-1', elements: [] }, previous, [], null, 1000);
  assert.deepEqual(partial.appState, { zoom: 2 }, 'partial saves must not drop previous fields');
  assert.deepEqual(partial.files, previous.files);

  // First save with no previous scene still produces a valid payload.
  const fresh = buildCanonicalCanvasPayload({ canvasFileId: 'c-2', elements: [], appState: {}, files: {} }, null, [], null, 1);
  assert.equal(fresh.version, 1);
  assert.deepEqual(fresh.customBlocks, []);
});

// ---- Windows reserved names ----

test('Windows reserved device names are rejected case-insensitively, with or without extensions', () => {
  for (const name of ['CON', 'con', 'Con', 'PRN', 'aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'CON.txt', 'nul.md', 'LPT1.notes', 'com4.canvas']) {
    assert.throws(() => validateEntityName(name), InvalidEntityNameError, `"${name}" must be rejected`);
  }
  assert.match((() => { try { validateEntityName('CON.txt'); } catch (error) { return error; } throw new Error('unreachable'); })().message, /reserved Windows device name/);
});

test('normal names pass through unchanged and validation is clean', () => {
  for (const name of ['Research', 'my notes', 'Plan 3000', 'con artist', 'second.nan', '控制']) {
    const trimmed = name.trim();
    assert.equal(validateEntityName(name), trimmed);
  }
  assert.throws(() => validateEntityName('   '), InvalidEntityNameError);
  assert.throws(() => validateEntityName('bad<name'), InvalidEntityNameError);
  assert.throws(() => validateEntityName('x'.repeat(129)), InvalidEntityNameError);
});

// ---- Wiring contracts (renderer/store/backup paths) ----

test('CanvasRepository routes Electron saves/loads through the canonical filesystem bridge', async () => {
  const source = await read('../src/repositories/CanvasRepository.ts');
  assert.match(source, /window\.panvas[\s\S]{0,40}canvas\.save\(workspace, data\.canvasFileId, payload\)/);
  assert.match(source, /window\.panvas[\s\S]{0,40}canvas\.load\(workspace, canvasFileId\)/);
  assert.match(source, /selectCanonicalCanvasScene\(fileScene, legacyScene \?\? null\)/);
  assert.match(source, /importCustomBlocks\(userId, embeddedBlocks\)/);
  // Electron scene writes no longer touch Dexie; browser path still does.
  const electronBranch = source.slice(source.indexOf('// ---- Canvas Data'));
  assert.ok(electronBranch.indexOf('window.panvas.canvas.save') < electronBranch.indexOf('canvasDB.saveCanvasData'));
  assert.match(source, /getBlocksByCanvas\(userId, data\.canvasFileId\)/, 'saves embed the renderer block cache');
});

test('browser IndexedDB path and sync queue remain unchanged', async () => {
  const source = await read('../src/repositories/CanvasRepository.ts');
  assert.match(source, /await canvasDB\.saveCanvasData\(userId, data\);/);
  assert.match(source, /queueSync\('canvasData', data\.canvasFileId, 'update', full\)/);
  const store = await read('../src/stores/canvasStore.ts');
  assert.match(store, /loadCanvasData: async \(canvasFileId: string, workspaceId\?: string\)/);
  assert.match(store, /saveCanvasData: async \(data: Partial<CanvasData> & \{ canvasFileId: string \}, workspaceId\?: string\)/);
});

test('backup/restore uses the canonical filesystem scenes in Electron', async () => {
  const service = await read('../electron/ipc/WorkspaceService.ts');
  // Export reads canonical files; restore queues unpublished staging payloads.
  assert.match(service, /path\.join\(workspaceDir, 'Canvas', `\$\{canvas\.id\}\.json`\)/);
  assert.match(service, /writeQueue\.enqueue\(path\.join\(stagingDir, 'Canvas', `\$\{canvas\.id\}\.json`\)/);
  assert.ok(service.indexOf("fsPromises.rename(path.join(stagingDir, 'Canvas')") < service.indexOf('this.writeWorkspaceJson(workspaceDir, metadata)'), 'scene promotion precedes metadata publication');
  const backupService = await read('../src/services/backup/backupService.ts');
  assert.match(backupService, /runtime\.panvas\?\.backup\)\s*return runtime\.panvas\.backup\.export\(workspaceId\)/);
});

test('hierarchy, trash, and custom-block helper contracts are untouched', async () => {
  const workspaceDB = await read('../src/database/canvasDB.ts');
  assert.match(workspaceDB, /export async function importCustomBlocks/);
  assert.match(workspaceDB, /bulkPut/);
  const repo = await read('../src/repositories/CanvasRepository.ts');
  // Canvas hierarchy ownership and trash semantics must be identical strings.
  assert.match(repo, /canvasFile\.update\(workspaceId, id, \{ deletedAt: Date\.now\(\) \}\)/);
  assert.match(repo, /canvasFile\.update\(workspaceId, id, \{ deletedAt: null \}\)/);
  assert.match(repo, /canvasFile\.create\(workspaceId, name, folderId, notebookId, sectionId\)/);
});
