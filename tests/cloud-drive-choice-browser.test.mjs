// Regression tests for the "Use Google Drive reports success without applying
// data" failure. Runs the REAL browser stack (Dexie, payload source, V2
// adapter, baselines, conflict store) against a mocked Drive provider, from
// the adoption state a legacy-era browser is in (local rows, no V2 baselines).
// The external Drive provider is replaced; no real account is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test('Use-Google-Drive conflict choice applies the remote workspace on real browser storage', { timeout: 240_000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({ root, configFile: false, envFile: false, appType: 'custom',
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'drive-choice-fixture', configureServer(s) {
      s.middlewares.use((req, res, next) => {
        if (req.url !== '/') return next();
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Sync test</title>');
      });
    } }],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    for (const scenario of ['choice-despite-bookkeeping-write', 'genuine-edit-still-fails-honestly', 'clean-choice-applies']) {
      await t.test(scenario, async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
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
            setCurrentBrowserUserIdReader(() => 'fixture-browser-owner');
            const baselines = new LocalStorageSyncV2BaselineStore();

            const manifests = new Map(), objects = new Map();
            const profile = { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: 'fixture-profile', accountIdentifier: 'fixture-account' };
            let catalog = { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 1, workspaces: [] };
            let writes = 0;
            const provider = {
              readProfile: async () => ({ value: profile, etag: 'profile' }),
              writeProfile: async () => { throw new Error('must not replace verified account'); },
              readCatalog: async () => ({ value: catalog, etag: String(catalog.revision) }),
              writeCatalog: async value => { catalog = value; writes++; return { etag: String(value.revision) }; },
              readManifest: async id => ({ value: manifests.get(id), etag: String(manifests.get(id)?.revision) }),
              writeManifest: async (id, value) => { manifests.set(id, value); writes++; return { etag: String(value.revision) }; },
              getObject: async hash => { check(objects.has(hash), 'object missing'); return objects.get(hash).slice(); },
              getObjectMetadata: async hash => objects.has(hash) ? { size: objects.get(hash).length } : null,
              putObjectIfAbsent: async (hash, bytes) => { if (objects.has(hash)) return 'present'; objects.set(hash, bytes.slice()); writes++; return 'uploaded'; },
            };
            const record = async (kind, id, parentId, value, baseHash = null) => {
              const bytes = encode(value);
              const hash = await sha256Bytes(bytes); objects.set(hash, bytes);
              return { kind, id, parentId, hash, baseHash, tombstone: false };
            };

            const ws = 'ws-choice', nb = 'nb-choice', sec = 'sec-choice', pg = 'page-choice';
            // Local browser state ("legacy era"): rows exist, no V2 baselines,
            // plus one browser-only page that the desktop has never seen.
            const localRows = [
              await record('workspace', ws, null, { id: ws, name: 'Choice Workspace', updatedAt: 1 }),
              await record('folder', 'folder-choice', ws, { id: 'folder-choice', workspaceId: ws, name: 'Folder', updatedAt: 1 }),
              await record('notebook', nb, 'folder-choice', { id: nb, workspaceId: ws, folderId: 'folder-choice', name: 'Notebook', updatedAt: 1 }),
              await record('notebookSection', sec, nb, { id: sec, notebookId: nb, name: 'Section', updatedAt: 1 }),
              await record('notebookPage', pg, sec, { id: pg, notebookId: nb, sectionId: sec, name: 'Page', updatedAt: 1 }),
              await record('pageContent', pg, pg, { pageId: pg, notebookId: nb, workspaceId: ws, data: { text: 'september text' }, version: 1 }),
              await record('pageDrawing', pg, pg, { pageId: pg, notebookId: nb, workspaceId: ws, data: { objects: [] }, version: 1 }),
              await record('notebookPage', 'page-local-only', sec, { id: 'page-local-only', notebookId: nb, sectionId: sec, name: 'Browser-only page', updatedAt: 2 }),
              await record('pageContent', 'page-local-only', 'page-local-only', { pageId: 'page-local-only', notebookId: nb, workspaceId: ws, data: { text: 'browser-only work' }, version: 1 }),
            ];
            for (const r of localRows) await adapter.applyRecord({ workspaceId: ws, record: r, bytes: objects.get(r.hash) });
            for (const table of [db.workspaces, db.folders, db.notebooks, db.notebookSections, db.notebookPages, db.notebookPageContents, db.notebookPageDrawings]) {
              for (const row of await table.toArray()) { row.userId = 'fixture-browser-owner'; await table.put(row); }
            }

            // Remote state ("desktop October"): edited content plus a new page.
            const remoteRows = [
              localRows[0], localRows[1], localRows[2], localRows[3],
              await record('notebookPage', pg, sec, { id: pg, notebookId: nb, sectionId: sec, name: 'Page', updatedAt: 500 }, localRows[4].hash),
              await record('pageContent', pg, pg, { pageId: pg, notebookId: nb, workspaceId: ws, data: { text: 'DESKTOP OCTOBER TEXT' }, version: 2 }, localRows[5].hash),
              await record('pageDrawing', pg, pg, { pageId: pg, notebookId: nb, workspaceId: ws, data: { objects: [{ id: 'desktop-ink', type: 'stroke' }] }, version: 2 }, localRows[6].hash),
              await record('notebookPage', 'page-new', sec, { id: 'page-new', notebookId: nb, sectionId: sec, name: 'New page', updatedAt: 500 }),
              await record('pageContent', 'page-new', 'page-new', { pageId: 'page-new', notebookId: nb, workspaceId: ws, data: { text: 'brand new page' }, version: 1 }),
            ];
            manifests.set(ws, { format: 'panvas-sync-v2-manifest', schemaVersion: 2, workspaceId: ws, revision: 7, records: remoteRows });
            catalog.workspaces.push({ workspaceId: ws, manifestRevision: 7 });

            const run = (resolutions, guardedAdapter) => runCloudSyncV2({
              accountIdentifier: profile.accountIdentifier, provider, source, adapter: guardedAdapter, baselines, conflictStore,
              resolutions, environment: 'web',
            });

            const first = await run(undefined, adapter);
            check(first.status === 'conflict', `first run must surface the adoption conflict: ${JSON.stringify(first)}`);

            const resolutions = (first.conflicts ?? []).map(c => ({ workspaceId: c.workspaceId, kind: c.kind, id: c.id, choice: 'cloud' }));
            check(resolutions.length > 0, 'adoption must produce reviewable conflicts');
            let injected = null;
            const guardedAdapter = scenario === 'clean-choice-applies' ? adapter : { ...adapter, async applyWorkspace(input) {
              if (!injected) {
                injected = 'fired';
                if (scenario === 'choice-despite-bookkeeping-write') {
                  // What the live app writes while the run is in flight.
                  await db.notebookPages.update(pg, { updatedAt: Date.now() });
                } else {
                  // A genuine content edit: the apply must NOT proceed.
                  await db.notebookPageContents.update(pg, { data: { text: 'typed during sync' } });
                }
              }
              return adapter.applyWorkspace(input);
            } };
            const second = await run(resolutions, guardedAdapter);
            const unresolved = (await conflictStore.listUnresolved?.(profile.profileId)) ?? [];
            const applied = {
              status: second.status, errorCode: second.errorCode,
              downloaded: second.downloaded,
              outcome: second.workspaceOutcomes.find(item => item.workspaceId === ws)?.status,
              conflicts: (second.conflicts ?? []).map(item => `${item.workspaceId}:${item.kind}:${item.id}`),
              localText: (await db.notebookPageContents.get(pg))?.data?.text,
              hasNewPage: Boolean(await db.notebookPages.get('page-new')),
              newPageText: (await db.notebookPageContents.get('page-new'))?.data?.text,
              unresolved: unresolved.map(item => `${item.entityKind}:${item.entityId}`),
              injected,
            };
            if (scenario !== 'genuine-edit-still-fails-honestly') {
              // The choice must actually download, persist and baseline the
              // remote graph — a bookkeeping write in flight must not break it.
              check(applied.status === 'synced', `status ${applied.status} / ${applied.errorCode}`);
              check(applied.outcome === 'synced', `outcome ${applied.outcome}`);
              check(applied.localText === 'DESKTOP OCTOBER TEXT', `remote content not applied: ${applied.localText}`);
              check(applied.hasNewPage, 'remote new page was not applied');
              check(applied.newPageText === 'brand new page', 'new page content missing');
              check(applied.unresolved.length === 0, 'resolved choice left review rows behind');
              const baselineRows = await baselines.loadWorkspace(ws);
              check(baselineRows.length === manifests.get(ws).records.length, 'rebuilt baseline is incomplete');
              // The replaced browser-only page survives as recovery data.
              const replaced = await db.notebookPages.get('page-local-only');
              check(Boolean(replaced?.deletedAt), 'replaced browser-only page lost its recovery copy');
              return { scenario, applied };
            }
            // A real content edit during the run must fail the apply AND the
            // failure must be reported as an unresolved conflict — never as a
            // successful reviewable sync.
            check(applied.injected === 'fired', 'injection did not run');
            check(applied.status === 'conflict', `honest failure required: ${JSON.stringify(applied)}`);
            check(applied.conflicts.length === 1 && applied.conflicts[0].startsWith(`${ws}:`), `the failed choice must surface a reviewable conflict: ${applied.conflicts.join(',')}`);
            check(applied.localText === 'typed during sync', 'failed apply must roll back to the local edit');
            check(!applied.hasNewPage, 'failed apply must not persist remote rows');
            check(applied.unresolved.length === 0, 'a rolled-back choice must not commit resolved rows');
            return { scenario, applied };
          }, scenario);
          assert.equal(result.scenario, scenario);
        } finally { await context.close(); }
      });
    }
  } finally { await browser?.close(); await server.close(); }
});
