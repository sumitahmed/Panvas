import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Real Chromium IndexedDB, production scanner/adapter/BASE/archive, and real
// WorkspaceService filesystem application. Only Drive and the IPC transport
// are substituted; all paths belong to a temporary test profile.
test('workspace preflight and conflict choices across native filesystem and Chromium', { timeout: 240_000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'panvas-workspace-flow-'));
  globalThis.__panvasFlowRoot = temporary;
  const server = await createServer({ configFile: false, envFile: false, appType: 'custom',
    resolve: { alias: { '@': path.resolve('src'), electron: 'virtual:flow-electron', dexie: path.resolve('node_modules/dexie/dist/dexie.mjs') } },
    optimizeDeps: { noDiscovery: true }, server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{ name: 'flow-fixture', resolveId(id) { if (id === 'virtual:flow-electron') return '\0flow-electron'; },
      load(id) { if (id === '\0flow-electron') return 'export const app = { getPath: key => globalThis.__panvasFlowRoot + "/" + key };'; },
      configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url !== '/') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated Cloud Sync flow</title>'); }); },
    }],
  });
  let browser;
  try {
    await server.listen();
    const { WorkspaceService } = await server.ssrLoadModule('/electron/ipc/WorkspaceService.ts');
    browser = await chromium.launch({ headless: true });
    for (const scenario of ['fresh', 'cloud', 'device', 'both', 'cloud-native', 'device-native', 'both-native', 'unbased-cloud', 'unbased-device', 'unbased-both', 'reset-device']) await t.test(scenario, async () => {
      const choice = scenario.replace('-native', '').replace('unbased-', '');
      const unbased = scenario.startsWith('unbased-');
      globalThis.__panvasFlowRoot = path.join(temporary, scenario);
      const native = new WorkspaceService();
      const contexts = [];
      const appliedNative = [];
      const drive = {
        profile: null, catalog: null, manifests: new Map(), objects: new Map(), writes: [],
        async readProfile() { return { value: this.profile, etag: this.profile ? 'profile' : null }; },
        async writeProfile(value) { this.profile = value; return { etag: 'profile' }; },
        async readCatalog() { return { value: this.catalog, etag: this.catalog ? String(this.catalog.revision) : null }; },
        async writeCatalog(value, etag) { assert.equal(etag, this.catalog ? String(this.catalog.revision) : null); this.catalog = structuredClone(value); return { etag: String(value.revision) }; },
        async readManifest(id) { const value = this.manifests.get(id) ?? null; return { value, etag: value ? String(value.revision) : null }; },
        async writeManifest(id, value, etag) { assert.equal(etag, this.manifests.has(id) ? String(this.manifests.get(id).revision) : null); this.manifests.set(id, structuredClone(value)); this.writes.push(['manifest', id]); return { etag: String(value.revision) }; },
        async getObject(hash) { assert.ok(this.objects.has(hash), `missing object ${hash}`); return this.objects.get(hash); },
        async getObjectMetadata(hash) { return this.objects.has(hash) ? { size: this.objects.get(hash).length } : null; },
        async putObjectIfAbsent(hash, bytes) { if (this.objects.has(hash)) return 'present'; this.objects.set(hash, bytes); this.writes.push(['object', hash]); return 'uploaded'; },
      };
      const metadata = async id => native.readWorkspaceJson(native.getWorkspaceDirById(id));
      const optionalJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
      const nativeCall = async (method, args) => {
        if (method === 'workspace.getAll') return (await native.discoverWorkspaces()).map(entry => entry.workspace).filter(ws => !ws.deletedAt);
        if (method === 'trash.getAll') return { workspaces: (await native.discoverWorkspaces()).map(entry => entry.workspace).filter(ws => ws.deletedAt) };
        if (method === 'workspace.getRecoveryWorkspaceRoot') return null;
        const collection = { 'folder.getAll': 'folders', 'notebook.getAll': 'notebooks', 'notebookSection.getAll': 'notebookSections', 'notebookPage.getAll': 'notebookPages', 'canvasFile.getAll': 'canvasFiles' }[method];
        if (collection) return (await metadata(args[0]))[collection];
        if (method === 'notebook.loadPage' || method === 'notebook.loadDrawing') return optionalJson(path.join(native.getWorkspaceDirById(args[0]), 'Notebooks', args[1], 'pages', `${args[2]}.${method.endsWith('Drawing') ? 'drawing' : 'content'}.json`));
        if (method === 'canvas.load') return optionalJson(path.join(native.getWorkspaceDirById(args[0]), 'Canvas', `${args[1]}.json`));
        if (method === 'cloudsync.listPageDrawingRecords') return (await metadata(args[0])).notebookPages.filter(p => p.type === 'pdf').map(p => ({ id: `${p.id}_pdf_1`, ownerPageId: p.id, notebookId: p.notebookId }));
        if (method === 'cloudsync.applyRemoteRecords') {
          appliedNative.push(...args[1].map(r => [args[0], r.kind]));
          await native.applyRemoteRecords(...args); return { success: true };
        }
        if (method.startsWith('binary.')) {
          const file = path.join(temporary, scenario, 'binary', args[0] + '.json');
          if (method.startsWith('binary.get')) return optionalJson(file);
          await mkdir(path.dirname(file), { recursive: true });
          const data = args.at(-1); await writeFile(file, JSON.stringify({ fileName: args[1], mimeType: method.endsWith('Pdf') ? 'application/pdf' : args[2], data })); return true;
        }
        throw new Error(`unimplemented test transport ${method}`);
      };
      const initializeDevice = async (page, electron) => page.evaluate(async electron => {
          const { db } = await import('/src/database/schema.ts');
          const { setCurrentBrowserUserIdReader, LocalSyncPayloadSource } = await import('/src/services/cloudsync/payloadSource.ts');
          setCurrentBrowserUserIdReader(() => null);
          if (electron) {
            const call = (method, args) => window.flowNative(method, args);
            window.panvas = {};
            for (const group of ['workspace', 'folder', 'notebook', 'notebookSection', 'notebookPage', 'canvasFile', 'canvas', 'trash', 'cloudsync', 'binary']) window.panvas[group] = new Proxy({}, { get: (_, method) => async (...args) => {
              const binary = group === 'binary';
              if (binary && String(method).startsWith('store')) args[args.length - 1] = [...new Uint8Array(args.at(-1))];
              const value = await call(`${group}.${String(method)}`, args);
              if (binary && String(method).startsWith('get') && value) value.data = new Uint8Array(value.data).buffer;
              return value;
            } });
          }
          const { runCloudSyncV2 } = await import('/src/services/cloudsync/v2/engine.ts');
          const { syncV2LocalSource, syncV2LocalAdapter } = await import('/src/services/cloudsync/v2/localAdapter.ts');
          const { LocalStorageSyncV2BaselineStore } = await import('/src/services/cloudsync/v2/baselineStore.ts');
          const { dexieSyncV2ConflictStore } = await import('/src/services/cloudsync/v2/conflictStore.ts');
          const provider = new Proxy({}, { get: (_, method) => async (...args) => {
            if (method === 'putObjectIfAbsent') args[1] = [...args[1]];
            const value = await window.flowDrive(method, args);
            return method === 'getObject' ? new Uint8Array(value) : value;
          } });
          const applied = [];
          const originalApply = syncV2LocalAdapter.applyRecord;
          syncV2LocalAdapter.applyRecord = async input => { applied.push([input.workspaceId, input.record.kind]); return originalApply(input); };
          const baselines = new LocalStorageSyncV2BaselineStore();
          window.flow = { db, source: syncV2LocalSource, adapter: syncV2LocalAdapter, baselines, applied,
            run: resolutions => runCloudSyncV2({ accountIdentifier: 'test-account', provider, source: syncV2LocalSource, adapter: syncV2LocalAdapter, baselines, conflictStore: dexieSyncV2ConflictStore, resolutions }),
            scan: id => new LocalSyncPayloadSource().scanWorkspaceIncludingUnowned(id),
          };
        }, electron);
      const createDevice = async electron => {
        const context = await browser.newContext(); contexts.push(context);
        const page = await context.newPage();
        await page.exposeFunction('flowDrive', (method, args) => drive[method](...args));
        if (electron) await page.exposeFunction('flowNative', nativeCall);
        await page.goto(server.resolvedUrls.local[0]);
        await initializeDevice(page, electron);
        return page;
      };
      const seed = async (page, ws) => page.evaluate(async ws => {
        const { encodeAssetEnvelope } = await import('/src/services/cloudsync/assetEnvelope.ts');
        const { sha256Bytes } = await import('/src/services/cloudsync/hash.ts');
        const rows = [];
        const add = (kind, id, parentId, value) => rows.push({ kind, id, parentId, value });
        const nb = `${ws}-nb`, sec = `${ws}-sec`, p = `${ws}-page`, c = `${ws}-canvas`, pdf = `${ws}-pdfpage`, asset = `${ws}-image`, pdfAsset = `${ws}-pdf`, audio = `${ws}-audio`;
        add('workspace', ws, null, { id: ws, name: ws, userId: null, deletedAt: null });
        add('folder', `${ws}-folder`, ws, { id: `${ws}-folder`, workspaceId: ws, parentId: null, name: 'Folder' });
        add('notebook', nb, `${ws}-folder`, { id: nb, workspaceId: ws, folderId: `${ws}-folder`, name: 'Notebook' });
        add('notebookSection', sec, nb, { id: sec, notebookId: nb, name: 'Section' });
        add('notebookPage', p, sec, { id: p, notebookId: nb, sectionId: sec, title: 'Page', type: 'default' });
        add('pageContent', p, p, { pageId: p, notebookId: nb, workspaceId: ws, data: { text: 'base text' }, version: 1 });
        add('pageDrawing', p, p, { pageId: p, notebookId: nb, workspaceId: ws, data: { objects: [{ id: 'drawing-image', type: 'image', fileId: asset }], audioNotes: [{ id: 'audio-note', fileId: audio }] }, version: 1 });
        add('notebookPage', pdf, sec, { id: pdf, notebookId: nb, sectionId: sec, title: 'PDF', type: 'pdf', pdfDataId: pdfAsset });
        add('pageDrawing', `${pdf}_pdf_1`, pdf, { pageId: `${pdf}_pdf_1`, notebookId: nb, workspaceId: ws, data: { objects: [{ id: 'annotation', type: 'stroke' }] }, version: 1 });
        add('canvasFile', c, ws, { id: c, workspaceId: ws, folderId: null, name: 'Canvas' });
        add('canvasScene', c, c, { canvasFileId: c, elements: [{ id: 'shape-base' }], appState: {}, files: {}, customBlocks: [{ id: `${ws}-block`, canvasFileId: c, type: 'markdown', content: 'Keep me' }], version: 1 });
        add('customBlock', `${ws}-block`, c, { id: `${ws}-block`, canvasFileId: c, type: 'markdown', content: 'Keep me' });
        for (const [id, owner, kind, mime] of [[asset, p, 'image', 'image/png'], [pdfAsset, pdf, 'pdf', 'application/pdf'], [audio, p, 'audio', 'audio/webm']]) {
          add('asset', id, owner, encodeAssetEnvelope({ id, ownerId: owner, fileName: id, mimeType: mime, assetKind: kind, createdAt: 0, userId: null }, new Uint8Array([1, 2, 3, 4])));
        }
        const downloads = await Promise.all(rows.map(async r => { const bytes = r.value instanceof Uint8Array ? r.value : new TextEncoder().encode(JSON.stringify(r.value)); return { record: { kind: r.kind, id: r.id, parentId: r.parentId, hash: await sha256Bytes(bytes), baseHash: null, tombstone: false, ...(r.kind === 'asset' ? { encoding: 'asset-envelope-v1' } : {}) }, bytes }; }));
        await window.flow.adapter.applyWorkspace({ workspaceId: ws, expected: [], downloads });
      }, ws);
      const run = (page, choice) => page.evaluate(choice => window.flow.run(choice ? [{ workspaceId: 'ws-main', kind: 'canvasScene', id: 'ws-main-canvas', choice }] : undefined), choice);
      const edit = (page, label, workspaceId = 'ws-main') => page.evaluate(async ({ label, workspaceId }) => {
        const rows = await window.flow.scan(workspaceId);
        const scene = rows.find(r => r.entityType === 'canvasScene');
        const value = JSON.parse(new TextDecoder().decode(scene.bytes)); value.elements = [{ id: label }];
        await window.flow.adapter.applyWorkspace({ workspaceId, expected: rows, downloads: [{ record: { kind: 'canvasScene', id: scene.entityId, parentId: scene.parentId, hash: 'a'.repeat(64), baseHash: null, tombstone: false }, bytes: new TextEncoder().encode(JSON.stringify(value)) }] });
      }, { label, workspaceId });
      const sceneLabel = (page, ws = 'ws-main') => page.evaluate(async ws => {
        const rows = await window.flow.scan(ws); const scene = rows.find(r => r.entityType === 'canvasScene');
        return scene ? JSON.parse(new TextDecoder().decode(scene.bytes)).elements[0]?.id : null;
      }, ws);
      try {
        let desktop = await createDevice(true);
        await seed(desktop, 'ws-main'); await seed(desktop, 'ws-healthy'); await seed(desktop, 'ws-broken');
        const uploaded = await run(desktop); assert.equal(uploaded.status, 'synced', JSON.stringify(uploaded));
        if (scenario === 'reset-device') {
          const remoteBeforeReset = structuredClone(drive.manifests.get('ws-main'));
          let returning = await createDevice(false);
          const hydrated = await run(returning);
          assert.equal(hydrated.status, 'synced', JSON.stringify(hydrated));
          const browserIdsBefore = await returning.evaluate(() => window.flow.source.listWorkspaceIds());
          assert.ok(browserIdsBefore.includes('ws-main'));
          const browserResetState = await returning.evaluate(async () => {
            const { resetBrowserLocalData } = await import('/src/services/cloudsync/deviceReset.ts');
            const { initializeDatabase, isDeviceResetPending } = await import('/src/database/schema.ts');
            await resetBrowserLocalData(null);
            const counts = Object.fromEntries(window.flow.db.tables.map(table => [table.name, table.count()]));
            const resolvedCounts = Object.fromEntries(await Promise.all(Object.entries(counts).map(async ([name, pending]) => [name, await pending])));
            const ids = await window.flow.source.listWorkspaceIds();
            await initializeDatabase(null);
            return { ids, bootstrapIds: await window.flow.source.listWorkspaceIds(), pending: isDeviceResetPending(), counts: resolvedCounts, profile: await window.flow.baselines.loadProfile() };
          });
          assert.deepEqual(browserResetState.ids, [], 'browser reset removes every local workspace before rehydrate');
          assert.deepEqual(browserResetState.bootstrapIds, [], 'reset marker suppresses default bootstrap before remote hydrate');
          assert.equal(browserResetState.pending, true, 'reset marker remains until hydrate reaches a terminal result');
          assert.equal(browserResetState.profile, null, 'browser reset removes the V2 profile BASE');
          for (const [table, count] of Object.entries(browserResetState.counts)) assert.equal(count, 0, `browser reset clears ${table}`);
          const browserRestored = await run(returning);
          assert.equal(browserRestored.status, 'synced', JSON.stringify(browserRestored));
          assert.ok((await returning.evaluate(() => window.flow.source.listWorkspaceIds())).includes('ws-main'));
          const browserSecond = await run(returning);
          assert.equal(browserSecond.status, 'synced', JSON.stringify(browserSecond));
          assert.equal(browserSecond.conflicts.length, 0);
          await returning.reload();
          await initializeDevice(returning, false);
          const browserAfterRestart = await run(returning);
          assert.equal(browserAfterRestart.status, 'synced', JSON.stringify(browserAfterRestart));
          assert.equal(browserAfterRestart.conflicts.length, 0);

          const outsideSentinel = path.join(temporary, `${scenario}-outside.txt`);
          await writeFile(outsideSentinel, 'must survive reset');
          const nativeReset = await native.resetLocalData();
          assert.deepEqual(nativeReset.workspaceIds.filter(id => !id.startsWith('ws-system-')).sort(), ['ws-broken', 'ws-healthy', 'ws-main'].sort());
          assert.ok(nativeReset.recoveryPath, 'Electron reset creates a final recovery snapshot');
          assert.equal(await readFile(path.join(nativeReset.recoveryPath, 'workspaces', 'ws-main', '.panvas', 'workspace.json'), 'utf8').then(Boolean), true);
          assert.equal(await readFile(outsideSentinel, 'utf8'), 'must survive reset', 'reset cannot delete outside Panvas storage');
          assert.equal((await native.discoverWorkspaces()).length, 0, 'Electron reset removes local workspace roots');
          const electronRestored = await run(desktop);
          assert.equal(electronRestored.status, 'synced', JSON.stringify(electronRestored));
          assert.ok((await desktop.evaluate(() => window.flow.source.listWorkspaceIds())).includes('ws-main'));
          const electronSecond = await run(desktop);
          assert.equal(electronSecond.status, 'synced', JSON.stringify(electronSecond));
          assert.equal(electronSecond.conflicts.length, 0);
          const restartedNative = new WorkspaceService();
          assert.equal((await restartedNative.discoverWorkspaces()).filter(e => !e.workspace.id.startsWith('ws-system-')).length, 3, 'Electron restart rediscovers one canonical root per workspace');
          assert.deepEqual(drive.manifests.get('ws-main'), remoteBeforeReset, 'reset does not mutate Google Drive data');
          return;
        }
        // Historical live failure: a tombstoned root is still a manifest entry,
        // but cannot parent a live folder. It must stop at workspace preflight.
        const broken = drive.manifests.get('ws-broken');
        broken.records = broken.records.map(r => r.kind === 'workspace' ? { ...r, baseHash: r.hash, hash: null, tombstone: true } : r);
        let returning = await createDevice(false);
        if (unbased) {
          await seed(returning, 'ws-main'); await edit(returning, 'Device version');
          await edit(desktop, 'Drive version'); await run(desktop);
        }
        const fresh = await run(returning);
        assert.equal(fresh.status, unbased ? 'conflict' : 'synced-review', JSON.stringify(fresh));
        assert.equal(fresh.conflicts.length > 0, unbased);
        assert.equal(fresh.workspaceOutcomes.find(o => o.workspaceId === 'ws-main').status, unbased ? 'conflict' : 'synced');
        if (unbased) {
          assert.equal(await sceneLabel(returning), 'Device version');
          assert.equal((await returning.evaluate(() => window.flow.baselines.loadWorkspace('ws-main'))).length, 0);
        }
        assert.equal(fresh.workspaceOutcomes.find(o => o.workspaceId === 'ws-broken').classification, 'orphaned');
        const applied = await returning.evaluate(() => window.flow.applied);
        assert.equal(applied.some(([ws]) => ws === 'ws-broken'), false, 'quarantined children never reach browser record apply');
        for (const ws of ['ws-main', 'ws-healthy']) assert.equal(applied.find(([id]) => id === ws)[1], 'workspace');
        const idle = await run(returning); assert.equal(idle.conflicts.length > 0, unbased, JSON.stringify(idle)); assert.equal(idle.uploaded + idle.downloaded, 0, JSON.stringify(idle));
        if (scenario === 'fresh') {
          await returning.evaluate(async () => {
            const expected = await window.flow.scan('ws-main');
            await window.flow.adapter.applyWorkspace({ workspaceId: 'ws-main', expected, downloads: [{ record: { kind: 'folder', id: 'folder-added-after-sync', parentId: 'ws-main', tombstone: false, hash: 'a'.repeat(64), baseHash: null }, bytes: new TextEncoder().encode(JSON.stringify({ id: 'folder-added-after-sync', workspaceId: 'ws-main', parentId: null, name: 'New local folder' })) }] });
          });
          await edit(returning, 'browser edit');
          const localUpload = await run(returning);
          assert.equal(localUpload.conflicts.length, 0, JSON.stringify(localUpload));
          const before = appliedNative.length;
          const downloaded = await run(desktop); assert.equal(downloaded.conflicts.length, 0, JSON.stringify(downloaded));
          assert.equal(appliedNative.slice(before).some(([ws]) => ws === 'ws-broken'), false);
          assert.equal(await sceneLabel(desktop), 'browser edit', 'Browser -> Drive -> filesystem Electron');
          return;
        }
        if (scenario.endsWith('-native')) [desktop, returning] = [returning, desktop];
        if (!unbased) {
          await edit(desktop, 'Drive version'); await run(desktop);
          await edit(returning, 'Device version');
        }
        const conflict = await run(returning); assert.equal(conflict.status, 'conflict', JSON.stringify(conflict));
        assert.ok(conflict.conflicts.every(c => c.workspaceId !== 'ws-broken'));
        const resolved = await run(returning, choice);
        assert.equal(resolved.status, 'synced-review', JSON.stringify(resolved));
        assert.equal(resolved.conflicts.length, 0, JSON.stringify(resolved));
        assert.equal(await sceneLabel(returning), choice === 'device' ? 'Device version' : 'Drive version');
        const again = await run(returning); assert.equal(again.conflicts.length, 0, JSON.stringify(again)); assert.equal(again.uploaded + again.downloaded, 0, JSON.stringify(again));
        const other = await createDevice(false); const otherRun = await run(other);
        assert.equal(otherRun.conflicts.length, 0, JSON.stringify(otherRun));
        assert.equal(await sceneLabel(other), choice === 'device' ? 'Device version' : 'Drive version');
        const ids = await returning.evaluate(() => window.flow.source.listWorkspaceIds());
        const copies = ids.filter(id => id.startsWith('ws-copy-'));
        assert.equal(copies.length, choice === 'both' ? 1 : 0);
        await returning.reload(); await initializeDevice(returning, scenario.endsWith('-native'));
        const restarted = await run(returning);
        assert.equal(restarted.conflicts.length, 0, JSON.stringify(restarted));
        assert.equal(restarted.uploaded + restarted.downloaded, 0, JSON.stringify(restarted));
        assert.deepEqual((await returning.evaluate(() => window.flow.source.listWorkspaceIds())).sort(), [...ids].sort(), 'restart must not create defaults or another device copy');
        if (choice === 'both') {
          const copyId = copies[0];
          assert.ok(drive.catalog.workspaces.some(w => w.workspaceId === copyId));
          assert.equal(await sceneLabel(other, copyId), 'Device version');
          const proof = await other.evaluate(async id => {
            const rows = await window.flow.scan(id);
            const { decodeAssetEnvelope } = await import('/src/services/cloudsync/assetEnvelope.ts');
            const assets = rows.filter(r => r.entityType === 'asset');
            return { kinds: [...new Set(rows.map(r => r.entityType))], owned: rows.every(r => r.workspaceId === id), parents: rows.every(r => !r.parentId || r.parentId === id || rows.some(p => p.entityId === r.parentId)), bytes: assets.map(r => [...decodeAssetEnvelope(r.bytes).bytes]) };
          }, copyId);
          assert.equal(proof.owned && proof.parents, true);
          assert.deepEqual(proof.kinds.sort(), ['workspace', 'folder', 'notebook', 'notebookSection', 'notebookPage', 'pageContent', 'pageDrawing', 'canvasFile', 'canvasScene', 'customBlock', 'asset'].sort());
          assert.equal(proof.bytes.length, 3);
          assert.ok(proof.bytes.every(bytes => bytes.join(',') === '1,2,3,4'));
          await edit(other, 'copy edited independently', copyId); await run(other);
          await edit(returning, 'original edited independently'); await run(returning);
          const desktopAgain = await run(desktop); assert.equal(desktopAgain.conflicts.length, 0, JSON.stringify(desktopAgain));
          assert.equal(await sceneLabel(desktop, copyId), 'copy edited independently');
          assert.equal(await sceneLabel(desktop), 'original edited independently');
          assert.equal(drive.catalog.workspaces.filter(w => w.workspaceId.startsWith('ws-copy-')).length, 1);
        }
      } finally { for (const context of contexts) await context.close(); }
    });
  } finally {
    await browser?.close(); await server.close(); delete globalThis.__panvasFlowRoot;
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(temporary, { recursive: true, force: true });
  }
});
