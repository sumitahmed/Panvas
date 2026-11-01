// Regression: the owner's Electron failure — a WORKSPACE-LEVEL
// `unproven-local-or-simultaneous-edit` conflict (entityKind: workspace)
// followed by "Use this device" that kept reporting "still present".
//
// Root cause under test: review rows are ephemeral (rebuilt by every run),
// so when the workspace-level conflict row was lost between runs the store
// sent NO resolution back to the engine and the same conflict was
// rediscovered forever. resolveReviewChanges must derive workspace-level
// resolutions from the authoritative per-workspace status.
//
// Runs the REAL store through the REAL Electron bridge surface
// (window.panvas.cloudsync.driveV2 + workspace IPC) with an in-memory
// native Drive emulator. No real account is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test('Use this device resolves a workspace-level conflict through the real store', { timeout: 300_000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({ root, configFile: false, envFile: false, appType: 'custom',
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'store-native-fixture', configureServer(s) {
      s.middlewares.use((req, res, next) => {
        if (req.url !== '/') return next();
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Store native test</title>');
      });
    } }],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    for (const scenario of ['device-choice-resolves', 'choice-without-review-items']) {
      await t.test(scenario, async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') console.log(`[page ${m.type()}]`, m.text().slice(0, 240)); });
          await page.addInitScript(() => {
            Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
            localStorage.setItem('panvas.dexieMigration.canonicalDestinations.v1', 'true');
            const ws = 'ws-Thq-gGAN3kWB';
            const workspaceRow = { id: ws, name: 'Local Renamed', updatedAt: 100, userId: null };
            const folderRow = { id: 'folder-1', workspaceId: ws, name: 'Folder', userId: null };
            const notebookRow = { id: 'nb-1', workspaceId: ws, folderId: 'folder-1', name: 'Notebook', userId: null };
            const sectionRow = { id: 'sec-1', notebookId: 'nb-1', name: 'Section', userId: null };
            const pageRow = { id: 'page-1', notebookId: 'nb-1', sectionId: 'sec-1', name: 'Page', userId: null };
            const contentRow = { pageId: 'page-1', notebookId: 'nb-1', workspaceId: ws, data: { text: 'shared' }, version: 1, userId: null };
            const objects = new Map();
            const manifest = { format: 'panvas-sync-v2-manifest', schemaVersion: 2, workspaceId: ws, revision: 5, records: [] };
            const catalog = { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 2, workspaces: [{ workspaceId: ws, manifestRevision: 5 }] };
            const profile = { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: 'shared-profile', accountIdentifier: 'account-1' };
            let manifestWritten = 0;
            window.__nativeDrive = { objects, manifest, manifestWritten: () => manifestWritten, manifestRecords: [] };
            window.panvas = {
              workspace: { getAll: async () => [workspaceRow] },
              folder: { getAll: async () => [folderRow] },
              notebook: {
                getAll: async () => [notebookRow],
                loadPage: async () => contentRow.data,
                loadDrawing: async () => ({ objects: [] }),
              },
              notebookSection: { getAll: async () => [sectionRow] },
              notebookPage: { getAll: async () => [pageRow] },
              canvasFile: { getAll: async () => [] },
              trash: { getAll: async () => ({ workspaces: [] }) },
              migration: { importWorkspace: async () => { throw new Error('migration must not run'); } },
              cloudsync: {
                listPageDrawingRecords: async () => [],
                driveV2: {
                  ensureAppRoot: async () => { window.__nativeCalls = (window.__nativeCalls ?? 0) + 1; return { success: true, value: 'ns-root' }; },
                  readRootJson: async name => {
                    window.__nativeCalls = (window.__nativeCalls ?? 0) + 1;
                    if (name === 'profile.json') return { success: true, value: { value: profile, etag: 'profile' } };
                    if (name === 'catalog.json') return { success: true, value: { value: catalog, etag: String(catalog.revision) } };
                    return { success: true, value: { value: null, etag: null } };
                  },
                  writeRootJson: async (name, value) => {
                    if (name === 'catalog.json') Object.assign(catalog, value);
                    if (name === 'profile.json') Object.assign(profile, value);
                    return { success: true, value: { etag: 'written' } };
                  },
                  readWorkspaceJson: async (id, name) => {
                    if (id === ws && name === 'manifest.json') return { success: true, value: { value: manifest, etag: String(manifest.revision) } };
                    return { success: true, value: { value: null, etag: null } };
                  },
                  writeWorkspaceJson: async (id, name, value) => {
                    if (id === ws && name === 'manifest.json') {
                      Object.assign(manifest, value); manifestWritten += 1;
                      window.__nativeDrive.manifestRecords = value.records;
                    }
                    return { success: true, value: { etag: String(value.revision ?? 0) } };
                  },
                  getObject: async (_workspaceId, hash) => {
                    if (!objects.has(hash)) return { success: false, errorCode: 'sync', diagnostic: { stage: 'object-download', reason: 'remote-object-missing', retryable: false } };
                    return { success: true, value: objects.get(hash).slice() };
                  },
                  putObjectIfAbsent: async (_workspaceId, upload) => {
                    if (objects.has(upload.hash)) return { success: true, value: 'present' };
                    objects.set(upload.hash, upload.bytes.slice());
                    return { success: true, value: 'uploaded' };
                  },
                  getMetadata: async (_workspaceId, hash) => ({ success: true, value: objects.has(hash) ? { size: objects.get(hash).length } : null }),
                  getMetadataBatch: async hashes => ({ success: true, value: hashes.filter(hash => objects.has(hash)).map(hash => ({ hash, size: objects.get(hash).length })) }),
                },
                drive: {
                  ensureAppRoot: async () => { window.__v1Calls = (window.__v1Calls ?? 0) + 1; return { success: true, value: 'ns-root' }; },
                  readProfile: async () => { window.__v1Calls = (window.__v1Calls ?? 0) + 1; return { success: true, value: { value: profile, etag: 'profile' } }; },
                  readCatalog: async () => ({ success: true, value: { value: catalog, etag: String(catalog.revision) } }),
                  writeCatalog: async value => ({ success: true, value: { etag: String(value.revision) } }),
                  readManifest: async () => ({ success: true, value: { manifest, etag: String(manifest.revision) } }),
                  writeManifest: async () => ({ success: true, value: { etag: '1' } }),
                  getObject: async (_w, hash) => ({ success: true, value: objects.get(hash)?.slice() ?? new Uint8Array() }),
                  putObjectIfAbsent: async (_w, upload) => { objects.set(upload.hash, upload.bytes.slice()); return { success: true, value: 'uploaded' }; },
                  getMetadata: async (_w, hash) => ({ success: true, value: objects.has(hash) ? { size: objects.get(hash).length } : null }),
                },
                applyRemoteRecords: async () => ({ success: false, errorCode: 'sync', diagnostic: { stage: 'native-apply', reason: 'not-implemented-in-test' } }),
              },
            };
          });
          await page.goto(server.resolvedUrls.local[0]);
          const result = await page.evaluate(async scenario => {
            const { db } = await import('/src/database/schema.ts');
            const storeModule = await import('/src/stores/cloudSyncStore.ts');
            const { useCloudSyncStore } = storeModule;
            const { LocalStorageSyncV2BaselineStore } = await import('/src/services/cloudsync/v2/baselineStore.ts');
            const { setCurrentBrowserUserIdReader } = await import('/src/services/cloudsync/payloadSource.ts');
            const { sha256Bytes } = await import('/src/services/cloudsync/hash.ts');
            const check = (ok, message) => { if (!ok) throw new Error(message); };
            const encode = value => new TextEncoder().encode(JSON.stringify(value));
            setCurrentBrowserUserIdReader(() => null); // Electron: no optional app session
            const baselines = new LocalStorageSyncV2BaselineStore();
            const ws = 'ws-Thq-gGAN3kWB';

            // Seed the local canonical rows (the device state to publish).
            await db.workspaces.put({ id: ws, name: 'Local Renamed', updatedAt: 100, userId: null });
            await db.folders.put({ id: 'folder-1', workspaceId: ws, name: 'Folder', userId: null });
            await db.notebooks.put({ id: 'nb-1', workspaceId: ws, folderId: 'folder-1', name: 'Notebook', userId: null });
            await db.notebookSections.put({ id: 'sec-1', notebookId: 'nb-1', name: 'Section', userId: null });
            await db.notebookPages.put({ id: 'page-1', notebookId: 'nb-1', sectionId: 'sec-1', name: 'Page', userId: null });
            await db.notebookPageContents.put({ pageId: 'page-1', notebookId: 'nb-1', workspaceId: ws, data: { text: 'shared' }, version: 1, userId: null });

            // Seed the shared baseline ("Original") and the remote root
            // (renamed by the other device) so both sides diverged from base.
            const originalRoot = encode({ id: ws, name: 'Original', updatedAt: 1 });
            const originalHash = await sha256Bytes(originalRoot);
            const renamedRoot = encode({ id: ws, name: 'Browser Renamed', updatedAt: 200 });
            const renamedHash = await sha256Bytes(renamedRoot);
            window.__nativeDrive.objects.set(originalHash, originalRoot);
            window.__nativeDrive.objects.set(renamedHash, renamedRoot);
            const childPayloads = {
              'folder:folder-1': { id: 'folder-1', workspaceId: ws, name: 'Folder', updatedAt: 1 },
              'notebook:nb-1': { id: 'nb-1', workspaceId: ws, folderId: 'folder-1', name: 'Notebook', updatedAt: 1 },
              'notebookSection:sec-1': { id: 'sec-1', notebookId: 'nb-1', name: 'Section', updatedAt: 1 },
              'notebookPage:page-1': { id: 'page-1', notebookId: 'nb-1', sectionId: 'sec-1', name: 'Page', updatedAt: 1 },
              'pageContent:page-1': { pageId: 'page-1', notebookId: 'nb-1', workspaceId: ws, data: { text: 'shared' }, version: 1 },
            };
            const rows = [
              { kind: 'workspace', id: ws, parentId: null },
              { kind: 'folder', id: 'folder-1', parentId: ws },
              { kind: 'notebook', id: 'nb-1', parentId: 'folder-1' },
              { kind: 'notebookSection', id: 'sec-1', parentId: 'nb-1' },
              { kind: 'notebookPage', id: 'page-1', parentId: 'sec-1' },
              { kind: 'pageContent', id: 'page-1', parentId: 'page-1' },
            ];
            const baselineRecords = [];
            const remoteRecords = [];
            for (const row of rows) {
              const baseBytes = row.kind === 'workspace' ? originalRoot : encode(childPayloads[`${row.kind}:${row.id}`]);
              const baseHash = await sha256Bytes(baseBytes);
              baselineRecords.push({ entityKind: row.kind, entityId: row.id, baseHash, localHash: baseHash, remoteHash: baseHash, remoteRevision: 1, tombstone: false });
              remoteRecords.push({
                kind: row.kind, id: row.id, parentId: row.parentId,
                hash: row.kind === 'workspace' ? renamedHash : baseHash,
                baseHash: row.kind === 'workspace' ? originalHash : null,
                tombstone: false,
              });
              if (row.kind !== 'workspace') window.__nativeDrive.objects.set(baseHash, baseBytes);
            }
            window.__nativeDrive.manifest.records = remoteRecords;
            await baselines.saveWorkspace(ws, baselineRecords);
            await baselines.saveProfile({ profileId: 'shared-profile', accountIdentifier: 'account-1' });

            // --- Wire the real store against the native bridge.
            useCloudSyncStore.setState({
              connectionByProvider: { googledrive: { provider: 'googledrive', accountIdentifier: 'account-1', email: 'owner@example.test' } },
              autoSync: false,
              statusByProvider: { googledrive: 'connected' },
            });
            const { GoogleDriveSyncV2Provider } = await import('/src/services/cloudsync/v2/googleDriveV2Provider.ts');
            const direct = new GoogleDriveSyncV2Provider({ assertCurrent: () => {} });
            let directResult = 'unset';
            try { const rp = await direct.readProfile(); directResult = JSON.stringify(rp.value?.value?.profileId ?? rp); }
            catch (error) { directResult = `THREW ${error?.constructor?.name}`; }
            console.warn('[probe] direct readProfile:', directResult, 'nativeCalls:', window.__nativeCalls ?? 0);
            const store = useCloudSyncStore.getState();
            await store.triggerSync();
            const afterAuto = useCloudSyncStore.getState();
            const autoState = {
              status: afterAuto.statusByProvider.googledrive,
              reviewItems: afterAuto.reviewItems.map(item => `${item.workspaceId}:${item.entityKind}:${item.entityId}`),
              workspaceStatus: afterAuto.workspaceStatusById[ws],
            };
            const features = await import('/src/config/features.ts');
            check(autoState.status === 'conflict', `auto run must surface the conflict: ${JSON.stringify(autoState)} nativeCalls=${window.__nativeCalls ?? 0} v2enabled=${features.CLOUD_SYNC_V2_ENABLED}`);

            if (scenario === 'choice-without-review-items') {
              // Test G: the entity-level review row is lost between runs —
              // only the authoritative per-workspace status remains.
              useCloudSyncStore.setState({ reviewItems: [] });
            }
            const resolved = await useCloudSyncStore.getState().resolveReviewChanges('device');
            const after = useCloudSyncStore.getState();
            const outcome = {
              resolved,
              status: after.statusByProvider.googledrive,
              workspaceStatus: after.workspaceStatusById[ws],
              lastSynced: after.lastSyncedByProvider.googledrive,
              localName: (await db.workspaces.get(ws))?.name,
              reviewLeft: after.reviewItems.length,
              error: after.lastError,
            };
            check(resolved === true, `device choice must resolve: ${JSON.stringify(outcome)}`);
            check(outcome.status === 'synced' || outcome.status === 'synced-review', `status must be synced: ${outcome.status}`);
            check(outcome.localName === 'Local Renamed', 'the local workspace state must remain authoritative');
            check(Boolean(outcome.lastSynced), 'the last-sync timestamp must advance after a genuine publication');
            // The published manifest root must be the device version.
            const publishedRoot = window.__nativeDrive.manifestRecords.find(item => item.kind === 'workspace');
            check(publishedRoot.tombstone === false && publishedRoot.hash !== renamedHash, 'the published root is not the device version');
            const rootBytes = new TextDecoder().decode(window.__nativeDrive.objects.get(publishedRoot.hash));
            check(JSON.parse(rootBytes).name === 'Local Renamed', 'the published workspace root is not the device version');
            // A following sync must not rediscover the conflict.
            await useCloudSyncStore.getState().triggerSync();
            const afterRerun = useCloudSyncStore.getState();
            check(afterRerun.statusByProvider.googledrive === 'synced' || afterRerun.statusByProvider.googledrive === 'synced-review', `rerun status: ${afterRerun.statusByProvider.googledrive}`);
            return { scenario, autoState, outcome, rerun: afterRerun.statusByProvider.googledrive };
          }, scenario);
          assert.equal(result.scenario, scenario);
        } finally { await context.close(); }
      });
    }
  } finally { await browser?.close(); await server.close(); }
});
