// Regression tests for the owner-traced `parent-unavailable` import failure.
// A remote-only workspace (0 local entities) whose published graph contains
// (a) a live asset whose structural parent was tombstoned remotely, (b) a
// live asset owned by a PDF-annotation storage identity, and (c) a stale
// local asset row with a dangling parent. The import must not roll back:
// valid records and assets apply, the dangling asset is preserved for
// recovery, and the workspace reports review-needed instead of aborting.
// The device-choice guard keeps a remote-only workspace from being
// tombstoned by "Use this device". Real Dexie + real adapter + mocked Drive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test('remote-only workspace import survives dangling asset parents and stale asset rows', { timeout: 240_000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({ root, configFile: false, envFile: false, appType: 'custom',
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'drive-import-fixture', configureServer(s) {
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
    for (const scenario of ['cloud-choice-import', 'device-choice-guard', 'upload-not-blocked', 'upload-download-round-trip']) {
      await t.test(scenario, async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') console.log(`[page ${m.type()}]`, m.text().slice(0, 4000)); });
          await page.goto(server.resolvedUrls.local[0]);
          const result = await page.evaluate(async scenario => {
            const { db } = await import('/src/database/schema.ts');
            const { runCloudSyncV2 } = await import('/src/services/cloudsync/v2/engine.ts');
            const { syncV2LocalSource: source, syncV2LocalAdapter: adapter } = await import('/src/services/cloudsync/v2/localAdapter.ts');
            const { LocalStorageSyncV2BaselineStore } = await import('/src/services/cloudsync/v2/baselineStore.ts');
            const { dexieSyncV2ConflictStore: conflictStore } = await import('/src/services/cloudsync/v2/conflictStore.ts');
            const { setCurrentBrowserUserIdReader } = await import('/src/services/cloudsync/payloadSource.ts');
            const { sha256Bytes } = await import('/src/services/cloudsync/hash.ts');
            const { encodeAssetEnvelope } = await import('/src/services/cloudsync/assetEnvelope.ts');
            const check = (ok, message) => { if (!ok) throw new Error(message); };
            const encode = value => new TextEncoder().encode(JSON.stringify(value));
            setCurrentBrowserUserIdReader(() => null);
            const baselines = new LocalStorageSyncV2BaselineStore();

            const manifests = new Map(), objects = new Map();
            const profile = { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: 'fixture-profile', accountIdentifier: 'fixture-account' };
            let catalog = { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 1, workspaces: [] };
            const provider = {
              readProfile: async () => ({ value: profile, etag: 'profile' }),
              writeProfile: async () => { throw new Error('must not replace verified account'); },
              readCatalog: async () => ({ value: catalog, etag: String(catalog.revision) }),
              writeCatalog: async value => { catalog = value; return { etag: String(value.revision) }; },
              readManifest: async id => ({ value: manifests.get(id), etag: String(manifests.get(id)?.revision) }),
              writeManifest: async (id, value) => { manifests.set(id, value); return { etag: String(value.revision) }; },
              getObject: async hash => { check(objects.has(hash), `object missing ${hash.slice(0, 12)}`); return objects.get(hash).slice(); },
              getObjectMetadata: async hash => objects.has(hash) ? { size: objects.get(hash).length } : null,
              putObjectIfAbsent: async (hash, bytes) => { if (objects.has(hash)) return 'present'; objects.set(hash, bytes.slice()); return 'uploaded'; },
            };
            const record = async (kind, id, parentId, value, baseHash = null, tombstone = false) => {
              const bytes = value instanceof Uint8Array ? value : encode(value);
              const hash = tombstone ? null : await sha256Bytes(bytes);
              if (hash) objects.set(hash, bytes);
              return { kind, id, parentId, hash, baseHash, tombstone, ...(kind === 'asset' ? { encoding: 'asset-envelope-v1' } : {}) };
            };

            if (scenario === 'upload-not-blocked' || scenario === 'upload-download-round-trip') {
              // Upload-direction fixtures: a healthy LOCAL workspace with
              // baselines and a local edit, and (for upload-not-blocked) a
              // remote-only workspace whose content payload cannot apply.
              const profileRow = { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: 'fixture-profile', accountIdentifier: 'fixture-account' };
              await baselines.saveProfile({ profileId: profileRow.profileId, accountIdentifier: profileRow.accountIdentifier });
              const localRows = [];
              const localRecord = async (kind, id, parentId, value) => {
                const bytes = encode(value);
                const hash = await sha256Bytes(bytes);
                const pointer = { kind, id, parentId, hash, baseHash: null, tombstone: false };
                try { await adapter.applyRecord({ workspaceId: 'ws-round', record: pointer, bytes }); }
                catch (error) { console.warn('[seed failure]', kind, id, error?.diagnostic?.reason ?? error?.name ?? String(error).slice(0, 120)); throw error; }
                localRows.push(pointer);
                return { pointer, bytes };
              };
              const ws = 'ws-round', nb = 'nb-round', sec = 'sec-round', pg = 'page-round-1', pg2 = 'page-round-2';
              await localRecord('workspace', ws, null, { id: ws, name: 'Round Trip', updatedAt: 1 });
              await localRecord('folder', 'folder-round', ws, { id: 'folder-round', workspaceId: ws, name: 'Folder', updatedAt: 1 });
              await localRecord('notebook', nb, 'folder-round', { id: nb, workspaceId: ws, folderId: 'folder-round', name: 'Notebook', updatedAt: 1 });
              await localRecord('notebookSection', sec, nb, { id: sec, notebookId: nb, name: 'Section', updatedAt: 1 });
              await localRecord('notebookPage', pg, sec, { id: pg, notebookId: nb, sectionId: sec, name: 'Page 1', updatedAt: 1 });
              await localRecord('pageContent', pg, pg, { pageId: pg, notebookId: nb, workspaceId: ws, data: { text: 'original' }, version: 1 });
              await localRecord('pageDrawing', pg, pg, { pageId: pg, notebookId: nb, workspaceId: ws, data: { objects: [{ id: 'ink-1', type: 'stroke' }] }, version: 1 });
              await localRecord('notebookPage', pg2, sec, { id: pg2, notebookId: nb, sectionId: sec, name: 'Page 2', updatedAt: 1 });
              await localRecord('pageContent', pg2, pg2, { pageId: pg2, notebookId: nb, workspaceId: ws, data: { text: 'second' }, version: 1 });
              for (const table of [db.workspaces, db.folders, db.notebooks, db.notebookSections, db.notebookPages, db.notebookPageContents, db.notebookPageDrawings]) {
                for (const row of await table.toArray()) if (row.id?.includes('round') || row.pageId?.includes('round')) { row.userId = null; await table.put(row); }
              }
              await baselines.saveWorkspace(ws, localRows.map(r => ({ entityKind: r.kind, entityId: r.id, baseHash: r.hash, localHash: r.hash, remoteHash: r.hash, remoteRevision: 1, tombstone: false })));
              if (scenario === 'upload-download-round-trip') {
                // The workspace was already registered in the cloud catalog by
                // its first upload; the manifest itself is uploaded by run 1.
                catalog.workspaces.push({ workspaceId: ws, manifestRevision: 0 });
              }
              if (scenario === 'upload-not-blocked') {
                await db.notebookPageContents.update(pg, { data: { text: 'local edit' }, version: 2 });
                // A remote-only workspace whose content payload cannot apply:
                // the identity check fails inside browser-record-apply.
                const brokenRows = [
                  await record('workspace', 'ws-z-broken', null, { id: 'ws-z-broken', name: 'Broken', updatedAt: 5 }),
                  await record('pageContent', 'page-broken', 'page-broken', { pageId: 'DIFFERENT-PAGE', notebookId: 'nb-broken', workspaceId: 'ws-z-broken', data: { text: 'mismatched' }, version: 1 }),
                ];
                manifests.set('ws-z-broken', { format: 'panvas-sync-v2-manifest', schemaVersion: 2, workspaceId: 'ws-z-broken', revision: 1, records: brokenRows });
                catalog.workspaces.push({ workspaceId: 'ws-z-broken', manifestRevision: 1 });
              }
              const run = resolutions => runCloudSyncV2({
                accountIdentifier: profileRow.accountIdentifier, provider, source, adapter, baselines, conflictStore,
                resolutions, environment: 'web',
              });
              const manifestRecords = () => manifests.get(ws)?.records ?? [];
              if (scenario === 'upload-not-blocked') {
                const first = await run(undefined);
                const healthyOutcome = first.workspaceOutcomes.find(item => item.workspaceId === ws);
                const brokenOutcome = first.workspaceOutcomes.find(item => item.workspaceId === 'ws-z-broken');
                const publishedRecords = manifestRecords();
                const uploaded = {
                  status: first.status,
                  healthyOutcome: healthyOutcome ? `${healthyOutcome.classification}:${healthyOutcome.status}` : 'missing',
                  brokenOutcome: brokenOutcome ? `${brokenOutcome.classification}:${brokenOutcome.status}` : 'missing',
                  healthyManifestPublished: publishedRecords.length > 0,
                  editedContentUploaded: [...objects.keys()].some(hash => {
                    try { return JSON.parse(new TextDecoder().decode(objects.get(hash))).data?.text === 'local edit'; } catch { return false; }
                  }),
                };
                check(uploaded.status === 'synced-review', `quarantined-broken run must finish in review: ${JSON.stringify(uploaded)}`);
                check(uploaded.healthyOutcome.startsWith('healthy') || uploaded.healthyOutcome.endsWith('synced'), `healthy workspace must sync: ${uploaded.healthyOutcome}`);
                check(uploaded.brokenOutcome.startsWith('ambiguous'), `broken workspace must quarantine, not abort: ${uploaded.brokenOutcome}`);
                check(uploaded.healthyManifestPublished, 'healthy workspace manifest was not published');
                check(uploaded.editedContentUploaded, 'the local edit object did not reach the mocked Drive');
                return { scenario, roundTrip: uploaded };
              }
              // Round trip: publish the workspace first, then delete a page
              // through the normal soft-delete flow and publish the tombstone.
              const initial = await run(undefined);
              check(initial.status === 'synced' && initial.uploaded > 0, `initial upload failed: ${JSON.stringify(initial)}`);
              check(manifestRecords().some(r => r.kind === 'notebookPage' && r.id === pg2 && !r.tombstone), 'the live page was not published first');
              await db.notebookPageContents.update(pg, { data: { text: 'EDITED ON DEVICE A' }, version: 2 });
              await db.imageFiles.put({ id: 'asset-img-round', canvasFileId: pg, fileName: 'img.png', mimeType: 'image/png', data: encode({ image: 'round-trip-bytes' }).buffer, createdAt: 1, userId: null });
              await db.notebookPages.update(pg2, { deletedAt: Date.now() });
              const first = await run(undefined);
              check(first.status === 'synced', `upload run must succeed: ${JSON.stringify(first)}`);
              check(first.uploaded > 0, 'nothing was uploaded');
              const published = manifestRecords();
              check(published.some(r => r.kind === 'notebookPage' && r.id === pg2 && r.tombstone), 'the soft-deleted page was not published as a tombstone');
              const editedHash = published.find(r => r.kind === 'pageContent' && r.id === pg)?.hash;
              const readBack = JSON.parse(new TextDecoder().decode(await provider.getObject(editedHash)));
              check(readBack.data.text === 'EDITED ON DEVICE A', 'read-back of the edited content does not match the local edit');
              const baselineCount = (await baselines.loadWorkspace(ws)).length;
              check(baselineCount === published.length, `baseline did not commit completely (${baselineCount} vs ${published.length})`);
              // Device B: empty local store, import everything.
              for (const table of [db.workspaces, db.folders, db.notebooks, db.notebookSections, db.notebookPages, db.notebookPageContents, db.notebookPageDrawings, db.imageFiles]) {
                for (const row of await table.toArray()) if (row.id?.includes('round') || row.pageId?.includes('round') || row.canvasFileId === pg) await table.delete(row.id ?? row.pageId);
              }
              await baselines.saveWorkspace(ws, []);
              const revisionBefore = manifests.get(ws).revision;
              const second = await run(undefined);
              const imported = {
                status: second.status, downloaded: second.downloaded, uploaded: second.uploaded,
                outcome: (second.workspaceOutcomes ?? []).map(o => `${o.workspaceId}:${o.classification}:${o.status}`).join(','),
                editedText: (await db.notebookPageContents.get(pg))?.data?.text,
                deletedPageAbsent: !(await db.notebookPages.get(pg2)),
                orphanContentAbsent: !(await db.notebookPageContents.get(pg2)),
                assetBytes: new TextDecoder().decode(new Uint8Array((await db.imageFiles.get('asset-img-round'))?.data ?? new Uint8Array(0))),
                manifestStable: manifests.get(ws).revision === revisionBefore,
              };
              // Everything live imports; the deleted page's leftover content
              // row has no parent to attach to and is preserved for recovery
              // instead of being materialized as an orphan.
              check(imported.status === 'synced-review', `import must finish in honest review: ${JSON.stringify(imported)}`);
              check(imported.outcome.includes('ambiguous'), `workspace outcome must be ambiguous: ${imported.outcome}`);
              check(imported.editedText === 'EDITED ON DEVICE A', 'device B did not receive the edited content');
              check(imported.deletedPageAbsent, 'the tombstoned page was materialized on device B');
              check(imported.orphanContentAbsent, 'orphan content was materialized without its page');
              check(imported.assetBytes.includes('round-trip-bytes'), 'the asset was not imported with exact bytes');
              check(imported.manifestStable, 'import mutated the published manifest');
              const Dexie = (await import('/node_modules/dexie/dist/dexie.mjs')).default;
              const archive = new Dexie('panvas-sync-v2'); await archive.open();
              const preserved = await archive.table('conflicts').where('workspaceId').equals(ws).toArray(); archive.close();
              check(preserved.some(row => row.conflictId.startsWith('dangling:') && row.entityId === pg2 && row.remoteBytes?.byteLength > 0), 'orphan content bytes were not preserved');
              const third = await run(undefined);
              check(third.status === 'synced-review' && third.uploaded === 0, `retry must not re-upload: ${JSON.stringify(third)}`);
              return { scenario, roundTrip: { upload: first.status, import: imported, retry: third.status } };
            }

            const ws = 'ws-import';
            const livePage = 'page-import-live';
            const deadPage = 'page-import-deleted';
            const rows = [
              await record('workspace', ws, null, { id: ws, name: 'Import Workspace', updatedAt: 5 }),
              await record('folder', 'folder-import', ws, { id: 'folder-import', workspaceId: ws, name: 'Folder', updatedAt: 5 }),
              await record('notebook', 'nb-import', 'folder-import', { id: 'nb-import', workspaceId: ws, folderId: 'folder-import', name: 'Notebook', updatedAt: 5 }),
              await record('notebookSection', 'sec-import', 'nb-import', { id: 'sec-import', notebookId: 'nb-import', name: 'Section', updatedAt: 5 }),
              await record('notebookPage', livePage, 'sec-import', { id: livePage, notebookId: 'nb-import', sectionId: 'sec-import', name: 'Live page', updatedAt: 5 }),
              await record('pageContent', livePage, livePage, { pageId: livePage, notebookId: 'nb-import', workspaceId: ws, data: { text: 'imported content' }, version: 1 }),
              await record('pageDrawing', livePage, livePage, { pageId: livePage, notebookId: 'nb-import', workspaceId: ws, data: { objects: [] }, version: 1 }),
              // The desktop deleted this page; its tombstone stays in the manifest.
              await record('notebookPage', deadPage, 'sec-import', { id: deadPage, notebookId: 'nb-import', sectionId: 'sec-import', name: 'Deleted page' }, null, true),
              // A live asset owned by a PDF-annotation storage identity of the live page.
              await record('asset', 'asset-annotation', `${livePage}_pdf_1`, encodeAssetEnvelope({ id: 'asset-annotation', ownerId: `${livePage}_pdf_1`, fileName: 'annotated.pdf', mimeType: 'application/pdf', assetKind: 'pdf', createdAt: 1, userId: null }, encode({ pdf: true }))),
              // A live asset whose structural parent is the tombstoned page.
              await record('asset', 'asset-dangling', deadPage, encodeAssetEnvelope({ id: 'asset-dangling', ownerId: deadPage, fileName: 'orphan.pdf', mimeType: 'application/pdf', assetKind: 'pdf', createdAt: 1, userId: null }, encode({ orphan: true }))),
            ];
            manifests.set(ws, { format: 'panvas-sync-v2-manifest', schemaVersion: 2, workspaceId: ws, revision: 9, records: rows });
            catalog.workspaces.push({ workspaceId: ws, manifestRevision: 9 });

            // A stale local asset row for asset-annotation whose parent no
            // longer exists anywhere (legacy-era leftovers).
            await db.imageFiles.put({ id: 'asset-annotation', canvasFileId: 'ghost-page-gone', fileName: 'old.pdf', mimeType: 'application/pdf', data: encode({ old: true }).buffer, createdAt: 1, userId: null });

            const run = resolutions => runCloudSyncV2({
              accountIdentifier: profile.accountIdentifier, provider, source, adapter, baselines, conflictStore,
              resolutions, environment: 'web',
            });

            if (scenario === 'cloud-choice-import') {
              // A remote-only workspace has no local rows, so the automatic
              // run downloads it outright — this is exactly the run that used
              // to abort with `parent-unavailable`.
              const first = await run(undefined);
              const outcome = first.workspaceOutcomes.find(item => item.workspaceId === ws);
              const imported = {
                status: first.status, errorCode: first.errorCode,
                outcome: outcome ? `${outcome.classification}:${outcome.status}` : 'missing',
                notebook: Boolean(await db.notebooks.get('nb-import')),
                livePage: Boolean(await db.notebookPages.get(livePage)),
                deadPageAbsent: !(await db.notebookPages.get(deadPage)),
                validAsset: (await db.pdfFiles.get('asset-annotation'))?.canvasFileId,
                danglingAssetAbsent: !(await db.pdfFiles.get('asset-dangling')) && !(await db.imageFiles.get('asset-dangling')),
              };
              // The import must not roll back and must not claim plain synced.
              check(imported.status === 'synced-review', `ambiguous review status required: ${JSON.stringify(imported)}`);
              check(imported.outcome.startsWith('ambiguous'), `workspace outcome must be ambiguous: ${imported.outcome}`);
              check(imported.notebook && imported.livePage, 'structural records were not applied');
              check(imported.deadPageAbsent, 'tombstoned page was materialized');
              check(imported.validAsset === `${livePage}_pdf_1`, `annotation-owned asset was not applied: ${imported.validAsset}`);
              check(imported.danglingAssetAbsent, 'dangling asset must not be materialized');
              const Dexie = (await import('/node_modules/dexie/dist/dexie.mjs')).default;
              const archive = new Dexie('panvas-sync-v2'); await archive.open();
              const preserved = await archive.table('conflicts').where('workspaceId').equals(ws).toArray(); archive.close();
              const danglingPreserved = preserved.find(row => row.conflictId.startsWith('dangling:'));
              check(Boolean(danglingPreserved?.remoteBytes?.byteLength), 'dangling asset bytes were not preserved for recovery');
              const stillUnresolved = (await conflictStore.listUnresolved?.(profile.profileId) ?? []).filter(item => item.workspaceId === ws);
              check(stillUnresolved.length === 0, 'a preserved dangling record must not reopen the review list');
              return { scenario, imported, preservedId: danglingPreserved?.conflictId ?? null };
            }
            // "Use this device" on a workspace this device does not have must
            // not publish tombstones for it: the remote graph stays untouched
            // and the workspace downloads instead.
            const manifestBefore = JSON.stringify(manifests.get(ws));
            const second = await run([{ workspaceId: ws, kind: 'workspace', id: ws, choice: 'device' }]);
            const afterDevice = {
              status: second.status,
              manifestUnchanged: JSON.stringify(manifests.get(ws)) === manifestBefore,
              notebookDownloaded: Boolean(await db.notebooks.get('nb-import')),
            };
            check(afterDevice.manifestUnchanged, 'device choice tombstoned a remote-only workspace');
            check(afterDevice.notebookDownloaded, 'remote-only workspace was not downloaded');
            return { scenario, afterDevice };
          }, scenario);
          assert.equal(result.scenario, scenario);
          if (scenario === 'upload-not-blocked' || scenario === 'upload-download-round-trip') {
            console.log(`[${scenario}]`, JSON.stringify(result.roundTrip ?? result, null, 1));
          }
        } finally { await context.close(); }
      });
    }
  } finally { await browser?.close(); await server.close(); }
});
