// Probe: reproduce the owner's Electron diagnostic — a WORKSPACE-LEVEL
// `unproven-local-or-simultaneous-edit` conflict (entityKind: workspace) and
// the resolveReviewChanges('device') path through the real engine.
import test from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test('workspace-level conflict + device choice diagnosis', { timeout: 240_000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({ root, configFile: false, envFile: false, appType: 'custom',
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'ws-conflict-fixture', configureServer(s) {
      s.middlewares.use((req, res, next) => {
        if (req.url !== '/') return next();
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>WS conflict probe</title>');
      });
    } }],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    for (const scenario of ['root-divergence-device', 'profile-replacement-device']) {
      await t.test(scenario, async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error' || m.text().includes('[CloudSync trace]')) console.log(`[page ${m.type()}]`, m.text().slice(0, 300)); });
          await page.goto(server.resolvedUrls.local[0]);
          const result = await page.evaluate(async scenario => {
            const { db } = await import('/src/database/schema.ts');
            const { runCloudSyncV2 } = await import('/src/services/cloudsync/v2/engine.ts');
            const { syncV2LocalSource: source, syncV2LocalAdapter: adapter } = await import('/src/services/cloudsync/v2/localAdapter.ts');
            const { LocalStorageSyncV2BaselineStore } = await import('/src/services/cloudsync/v2/baselineStore.ts');
            const { dexieSyncV2ConflictStore: conflictStore } = await import('/src/services/cloudsync/v2/conflictStore.ts');
            const { setCurrentBrowserUserIdReader } = await import('/src/services/cloudsync/payloadSource.ts');
            const { sha256Bytes } = await import('/src/services/cloudsync/hash.ts');
            const check = (ok, message) => { if (!ok) throw new Error(message); };
            const encode = value => new TextEncoder().encode(JSON.stringify(value));
            // Electron-like: an app session exists but rows are stamped null.
            setCurrentBrowserUserIdReader(() => 'desktop-user');
            const baselines = new LocalStorageSyncV2BaselineStore();

            const manifests = new Map(), objects = new Map();
            let catalog = { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 3, workspaces: [] };
            const profile = { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: scenario === 'profile-replacement-device' ? 'BROWSER-PROFILE' : 'shared-profile', accountIdentifier: 'account-1' };
            const provider = {
              readProfile: async () => ({ value: profile, etag: 'profile' }),
              writeProfile: async () => ({ etag: 'profile' }),
              readCatalog: async () => ({ value: catalog, etag: String(catalog.revision) }),
              writeCatalog: async value => { catalog = value; return { etag: String(value.revision) }; },
              readManifest: async id => ({ value: manifests.get(id), etag: String(manifests.get(id)?.revision) }),
              writeManifest: async (id, value) => { manifests.set(id, value); return { etag: String(value.revision) }; },
              getObject: async hash => { check(objects.has(hash), `object missing ${hash.slice(0, 10)}`); return objects.get(hash).slice(); },
              getObjectMetadata: async hash => objects.has(hash) ? { size: objects.get(hash).length } : null,
              putObjectIfAbsent: async (hash, bytes) => { if (objects.has(hash)) return 'present'; objects.set(hash, bytes.slice()); return 'uploaded'; },
            };
            const record = async (kind, id, parentId, value, baseHash = null) => {
              const bytes = encode(value);
              const hash = await sha256Bytes(bytes); objects.set(hash, bytes);
              return { kind, id, parentId, hash, baseHash, tombstone: false };
            };
            const ws = 'ws-Thq-gGAN3kWB';

            // --- Local (Electron): the shared base state; the root is then
            // renamed locally after the baselines are written.
            const localRows = [
              await record('workspace', ws, null, { id: ws, name: 'Original', updatedAt: 1 }),
              await record('folder', 'folder-1', ws, { id: 'folder-1', workspaceId: ws, name: 'Folder', updatedAt: 1 }),
              await record('notebook', 'nb-1', 'folder-1', { id: 'nb-1', workspaceId: ws, folderId: 'folder-1', name: 'Notebook', updatedAt: 1 }),
              await record('notebookSection', 'sec-1', 'nb-1', { id: 'sec-1', notebookId: 'nb-1', name: 'Section', updatedAt: 1 }),
              await record('notebookPage', 'page-1', 'sec-1', { id: 'page-1', notebookId: 'nb-1', sectionId: 'sec-1', name: 'Page', updatedAt: 1 }),
              await record('pageContent', 'page-1', 'page-1', { pageId: 'page-1', notebookId: 'nb-1', workspaceId: ws, data: { text: 'shared content' }, version: 1 }),
            ];
            for (const r of localRows) await adapter.applyRecord({ workspaceId: ws, record: r, bytes: objects.get(r.hash) });
            for (const table of [db.workspaces, db.folders, db.notebooks, db.notebookSections, db.notebookPages, db.notebookPageContents]) {
              for (const row of await table.toArray()) { row.userId = null; await table.put(row); }
            }
            // Baselines: only for the profile-replacement scenario does the
            // device start WITHOUT them (they were wiped by the profile swap).
            if (scenario !== 'profile-replacement-device') {
              await baselines.saveWorkspace(ws, localRows.map(r => ({ entityKind: r.kind, entityId: r.id, baseHash: r.hash, localHash: r.hash, remoteHash: r.hash, remoteRevision: 1, tombstone: false })));
              await baselines.saveProfile({ profileId: 'shared-profile', accountIdentifier: 'account-1' });
            }
            // The desktop user renames the workspace after the last sync.
            await db.workspaces.update(ws, { name: 'Local Renamed', updatedAt: 100 });

            // --- Remote (browser): root renamed differently, children identical.
            const remoteRows = [
              await record('workspace', ws, null, { id: ws, name: 'Browser Renamed', updatedAt: 200 }, localRows[0].hash),
              ...localRows.slice(1).map((r, index) => (index === 0 ? { ...r } : r)),
            ];
            manifests.set(ws, { format: 'panvas-sync-v2-manifest', schemaVersion: 2, workspaceId: ws, revision: 5, records: remoteRows });
            catalog.workspaces.push({ workspaceId: ws, manifestRevision: 5 });
            await baselines.saveProfile({ profileId: profile.profileId, accountIdentifier: profile.accountIdentifier }).catch(() => {});

            // Electron enumerates workspaces through IPC without user
            // filtering (scanElectronWorkspace / window.panvas.workspace.getAll).
            const desktopSource = {
              ...source,
              listWorkspaceIds: async () => (await db.workspaces.toArray()).map(item => item.id).filter(id => id !== 'default'),
            };
            const run = resolutions => runCloudSyncV2({
              accountIdentifier: 'account-1', provider, source: desktopSource, adapter, baselines, conflictStore,
              resolutions, environment: 'desktop',
            });

            const first = await run(undefined);
            const firstSummary = {
              status: first.status,
              conflicts: (first.conflicts ?? []).map(c => `${c.workspaceId}:${c.kind}:${c.id}`),
              outcome: (first.workspaceOutcomes ?? []).map(o => `${o.workspaceId}:${o.classification}:${o.status}${o.diagnostic ? `:${o.diagnostic.reason}` : ''}`),
            };
            check(first.status === 'conflict', `expected workspace conflict: ${JSON.stringify(firstSummary)}`);

            const resolutions = (first.conflicts ?? []).map(c => ({ workspaceId: c.workspaceId, kind: c.kind, id: c.id, choice: 'device' }));
            const second = await run(resolutions);
            const secondSummary = {
              status: second.status, errorCode: second.errorCode, error: second.error,
              uploaded: second.uploaded, downloaded: second.downloaded,
              outcome: (second.workspaceOutcomes ?? []).map(o => `${o.workspaceId}:${o.classification}:${o.status}${o.diagnostic ? `:${o.diagnostic.reason}` : ''}`),
              localName: (await db.workspaces.get(ws))?.name,
            };
            // Authoritative device choice: local root must remain, remote must
            // be republished from local, and the next run must be a no-op.
            const third = await run(undefined);
            const thirdSummary = { status: third.status, uploaded: third.uploaded, downloaded: third.downloaded, conflicts: (third.conflicts ?? []).length };
            return { scenario, firstSummary, secondSummary, thirdSummary };
          }, scenario);
          console.log(`\n=== ${scenario} ===`);
          console.log('run1:', JSON.stringify(result.firstSummary));
          console.log('run2(device):', JSON.stringify(result.secondSummary, null, 1));
          console.log('run3:', JSON.stringify(result.thirdSummary));
        } finally { await context.close(); }
      });
    }
  } finally { await browser?.close(); await server.close(); }
});
