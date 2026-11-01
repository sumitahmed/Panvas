// Diagnostic: run the REAL GoogleDriveSyncV2Provider (fetchFn-emulated Drive
// REST surface) against the REAL V2 engine on real IndexedDB, at owner-like
// scale (7 workspaces, diverged desktop, local-only browser rows, assets).
// Surfaces provider/engine failures the hand-rolled mock cannot.
import test from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test('real-provider choice diagnosis', { timeout: 300_000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({ root, configFile: false, envFile: false, appType: 'custom',
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'drive-emulator-fixture', configureServer(s) {
      s.middlewares.use((req, res, next) => {
        if (req.url !== '/') return next();
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Drive emulator probe</title>');
      });
    } }],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    await t.test('cloud and device choices through the real provider', async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error' || m.text().includes('[CloudSync trace]')) console.log(`[page ${m.type()}]`, m.text().slice(0, 500)); });
        page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 500)));
        await page.goto(server.resolvedUrls.local[0]);
        const result = await page.evaluate(async () => {
          const { db } = await import('/src/database/schema.ts');
          const { runCloudSyncV2 } = await import('/src/services/cloudsync/v2/engine.ts');
          const { syncV2LocalSource: source, syncV2LocalAdapter: adapter } = await import('/src/services/cloudsync/v2/localAdapter.ts');
          const { LocalStorageSyncV2BaselineStore } = await import('/src/services/cloudsync/v2/baselineStore.ts');
          const { dexieSyncV2ConflictStore: conflictStore } = await import('/src/services/cloudsync/v2/conflictStore.ts');
          const { GoogleDriveSyncV2Provider } = await import('/src/services/cloudsync/v2/googleDriveV2Provider.ts');
          const { setCurrentBrowserUserIdReader } = await import('/src/services/cloudsync/payloadSource.ts');
          const { sha256Bytes } = await import('/src/services/cloudsync/hash.ts');
          const { encodeAssetEnvelope } = await import('/src/services/cloudsync/assetEnvelope.ts');
          const check = (ok, message) => { if (!ok) throw new Error(message); };
          const encode = value => new TextEncoder().encode(JSON.stringify(value));
          setCurrentBrowserUserIdReader(() => null); // browser with Drive OAuth but no app session
          const baselines = new LocalStorageSyncV2BaselineStore();

          // ---------- Minimal Drive REST emulator ----------
          const files = new Map(); let idCounter = 0, versionCounter = 1;
          const stableHash = async bytes => (await sha256Bytes(bytes)).slice(0, 32);
          const makeFile = (name, parents, mimeType, content) => {
            const id = `f-${++idCounter}`;
            const file = { id, name, parents, mimeType, content, version: String(versionCounter++), md5: '', modifiedTime: new Date().toISOString() };
            file.md5 = `md5-${id}`;
            files.set(id, file); return file;
          };
          const matchQuery = (query, file) => {
            const nameMatch = /name = '([^']*)'/.exec(query);
            const parentMatch = /'([^']+)' in parents/.exec(query);
            if (nameMatch && file.name !== nameMatch[1]) return false;
            if (parentMatch && !file.parents.includes(parentMatch[1]) && !(parentMatch[1] === 'root' && file.parents.includes('root'))) return false;
            if (/mimeType = 'application\/vnd\.google-apps\.folder'/.test(query) && file.mimeType !== 'application/vnd.google-apps.folder') return false;
            if (/trashed = false/.test(query) && file.trashed) return false;
            return true;
          };
          const respondJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
          const fetchFn = async (url, init = {}) => {
            const u = new URL(url);
            const path = u.pathname, method = init.method ?? 'GET';
            if (path.endsWith('/files/generateIds')) return respondJson({ ids: [`f-${++idCounter}`] });
            if (path.endsWith('/files') && method === 'GET' && u.searchParams.has('q')) {
              const query = u.searchParams.get('q');
              const matches = [...files.values()].filter(file => matchQuery(query, file)).map(({ content, ...meta }) => ({ ...meta, size: String(content.length) }));
              return respondJson({ files: matches });
            }
            if (path.endsWith('/files') && method === 'POST' && !path.includes('/upload/')) {
              const body = JSON.parse(init.body); const file = makeFile(body.name, body.parents ?? [], body.mimeType ?? 'application/octet-stream', new Uint8Array());
              return respondJson({ id: file.id, name: file.name, size: '0', md5Checksum: file.md5, version: file.version, modifiedTime: file.modifiedTime });
            }
            const fileId = /\/files\/([^/?]+)/.exec(path)?.[1];
            if (fileId && method === 'GET' && u.searchParams.get('alt') === 'media') {
              const file = files.get(fileId); if (!file) return new Response('missing', { status: 404 });
              return new Response(new Uint8Array(file.content), { status: 200 });
            }
            if (fileId && method === 'GET') {
              const file = files.get(fileId); if (!file) return new Response('missing', { status: 404 });
              return respondJson({ id: file.id, name: file.name, size: String(file.content.length), md5Checksum: file.md5, version: file.version, modifiedTime: file.modifiedTime, mimeType: file.mimeType, trashed: false });
            }
            if (fileId && method === 'PATCH') {
              const file = files.get(fileId); if (!file) return new Response('missing', { status: 404 });
              file.content = new TextEncoder().encode(init.body); file.version = String(versionCounter++); file.modifiedTime = new Date().toISOString();
              return respondJson({ id: file.id, name: file.name, size: String(file.content.length), md5Checksum: file.md5, version: file.version, modifiedTime: file.modifiedTime });
            }
            if (path.endsWith('/files') && method === 'POST' && path.includes('/upload/')) {
              const body = new Uint8Array(await new Response(init.body).arrayBuffer());
              const text = new TextDecoder().decode(body);
              const boundary = /boundary=(.+)$/.exec(init.headers['Content-Type'] ?? '')?.[1];
              if (boundary) {
                const parts = text.split(`--${boundary}`);
                const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
                const contentStart = body.indexOf(new TextEncoder().encode(parts[1].split('\r\n\r\n')[1])) + meta ? 0 : 0;
                // Simpler: locate the second part's payload between header and closing boundary.
                const secondPart = text.split(`--${boundary}\r\n`)[2];
                const payloadText = secondPart.slice(secondPart.indexOf('\r\n\r\n') + 4, secondPart.lastIndexOf(`\r\n--${boundary}`));
                const content = parts[1].includes('application/octet-stream') || meta.mimeType === 'application/json'
                  ? new TextEncoder().encode(payloadText) : new TextEncoder().encode(payloadText);
                const file = makeFile(meta.name, meta.parents ?? [], meta.mimeType ?? 'application/octet-stream', content);
                return respondJson({ id: file.id, name: file.name, size: String(content.length), md5Checksum: file.md5, version: file.version, modifiedTime: file.modifiedTime });
              }
              return new Response('bad multipart', { status: 400 });
            }
            throw new Error(`emulator: unhandled ${method} ${path}`);
          };

          const provider = new GoogleDriveSyncV2Provider({
            tokenProvider: async () => 'emulated-token',
            fetchFn: async (url, init) => {
              try { return await fetchFn(url, init); }
              catch (error) { console.warn('[fetch failed]', String(url).slice(0, 160), error?.constructor?.name, String(error?.message).slice(0, 200)); throw error; }
            },
            assertCurrent: () => {},
          });
          // Surface raw provider errors the engine otherwise sanitizes away.
          const loggingProvider = new Proxy(provider, {
            get(target, prop) {
              const value = target[prop];
              if (typeof value !== 'function') return value;
              return async (...args) => {
                try { return await value.apply(target, args); }
                catch (error) {
                  console.warn(`[provider ${String(prop)}]`, error?.constructor?.name, (error?.message ?? String(error)).slice(0, 300), error?.diagnostic ? JSON.stringify(error.diagnostic).slice(0, 300) : '');
                  throw error;
                }
              };
            },
          });

          // ---------- Seed Drive: desktop published 7 workspaces ----------
          const WS = Array.from({ length: 7 }, (_, i) => `ws-real-${String(i + 1).padStart(2, '0')}`);
          const remoteRecord = async (kind, id, parentId, value, baseHash = null) => {
            const bytes = value instanceof Uint8Array ? value : encode(value);
            const hash = await sha256Bytes(bytes);
            const objectPath = `sync-v2/objects/${hash}`;
            if (!files.has(objectPath)) makeFile(hash, [objectsFolder.id], 'application/octet-stream', bytes);
            return { kind, id, parentId, hash, baseHash, tombstone: false, ...(kind === 'asset' ? { encoding: 'asset-envelope-v1' } : {}) };
          };
          // Simplify folder wiring: the provider discovers folders by NAME, so
          // pre-create the namespace with the exact names it searches for.
          const root = makeFile('Panvas', ['root'], 'application/vnd.google-apps.folder', new Uint8Array());
          const ns = makeFile('sync-v2', [root.id], 'application/vnd.google-apps.folder', new Uint8Array());
          const objectsFolder = makeFile('objects', [ns.id], 'application/vnd.google-apps.folder', new Uint8Array());
          const workspacesFolder = makeFile('workspaces', [ns.id], 'application/vnd.google-apps.folder', new Uint8Array());
          for (const f of [root, ns, objectsFolder, workspacesFolder]) files.get(f.id).parents = f.parents;
          // Map the seeded folders by fixing parents used in matchQuery ('objects-folder' etc.)
          files.get(objectsFolder.id).parents = [ns.id]; files.get(workspacesFolder.id).parents = [ns.id];
          // Re-key object storage onto the real objects folder id:
          for (const file of [...files.values()]) if (file.parents.includes('objects-folder')) file.parents = [objectsFolder.id];

          const catalog = { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 5, workspaces: [] };
          for (const ws of WS) {
            const wsFolder = makeFile(ws, [workspacesFolder.id], 'application/vnd.google-apps.folder', new Uint8Array());
            const rows = [];
            rows.push(await remoteRecord('workspace', ws, null, { id: ws, name: `Workspace ${ws}`, updatedAt: 900 }));
            rows.push(await remoteRecord('folder', `folder-${ws}`, ws, { id: `folder-${ws}`, workspaceId: ws, name: 'Folder', updatedAt: 900 }));
            rows.push(await remoteRecord('notebook', `nb-${ws}`, `folder-${ws}`, { id: `nb-${ws}`, workspaceId: ws, folderId: `folder-${ws}`, name: 'Notebook', updatedAt: 900 }));
            rows.push(await remoteRecord('notebookSection', `sec-${ws}`, `nb-${ws}`, { id: `sec-${ws}`, notebookId: `nb-${ws}`, name: 'Section', updatedAt: 900 }));
            rows.push(await remoteRecord('notebookPage', `page-${ws}`, `sec-${ws}`, { id: `page-${ws}`, notebookId: `nb-${ws}`, sectionId: `sec-${ws}`, name: 'Page', updatedAt: 900 }));
            rows.push(await remoteRecord('pageContent', `page-${ws}`, `page-${ws}`, { pageId: `page-${ws}`, notebookId: `nb-${ws}`, workspaceId: ws, data: { text: `desktop october ${ws}` }, version: 2 }));
            rows.push(await remoteRecord('pageDrawing', `page-${ws}`, `page-${ws}`, { pageId: `page-${ws}`, notebookId: `nb-${ws}`, workspaceId: ws, data: { objects: [{ id: 'desktop-ink', type: 'stroke' }] }, version: 2 }));
            const pdfBytes = encode({ pdf: ws });
            const pdfHash = await sha256Bytes(pdfBytes);
            makeFile(pdfHash, [objectsFolder.id], 'application/octet-stream', pdfBytes);
            rows.push(await remoteRecord('asset', `pdf-${ws}`, `page-${ws}`, encodeAssetEnvelope({ id: `pdf-${ws}`, ownerId: `page-${ws}`, fileName: `course-${ws}.pdf`, mimeType: 'application/pdf', assetKind: 'pdf', createdAt: 1, userId: null }, pdfBytes)));
            files.set(`manifest-${ws}`, makeFile('manifest.json', [wsFolder.id], 'application/json', encode({ format: 'panvas-sync-v2-manifest', schemaVersion: 2, workspaceId: ws, revision: 6, records: rows })));
            catalog.workspaces.push({ workspaceId: ws, manifestRevision: 6 });
          }
          makeFile('profile.json', [ns.id], 'application/json', encode({ format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: 'real-profile', accountIdentifier: 'real-account' }));
          makeFile('catalog.json', [ns.id], 'application/json', encode(catalog));
          // The provider writes catalog/profile via writeRootJson → name search in ns folder.

          // ---------- Seed browser: 7 local workspaces, September-era ----------
          const localRecord = async (kind, id, parentId, value) => {
            const bytes = encode(value);
            const hash = await sha256Bytes(bytes);
            return { kind, id, parentId, hash, baseHash: null, tombstone: false, bytes };
          };
          for (const ws of WS) {
            const rows = [
              await localRecord('workspace', ws, null, { id: ws, name: `Workspace ${ws}`, updatedAt: 1 }),
              await localRecord('folder', `folder-${ws}`, ws, { id: `folder-${ws}`, workspaceId: ws, name: 'Folder', updatedAt: 1 }),
              await localRecord('notebook', `nb-${ws}`, `folder-${ws}`, { id: `nb-${ws}`, workspaceId: ws, folderId: `folder-${ws}`, name: 'Notebook', updatedAt: 1 }),
              await localRecord('notebookSection', `sec-${ws}`, `nb-${ws}`, { id: `sec-${ws}`, notebookId: `nb-${ws}`, name: 'Section', updatedAt: 1 }),
              await localRecord('notebookPage', `page-${ws}`, `sec-${ws}`, { id: `page-${ws}`, notebookId: `nb-${ws}`, sectionId: `sec-${ws}`, name: 'Page', updatedAt: 1 }),
              await localRecord('pageContent', `page-${ws}`, `page-${ws}`, { pageId: `page-${ws}`, notebookId: `nb-${ws}`, workspaceId: ws, data: { text: `september ${ws}` }, version: 1 }),
              await localRecord('pageDrawing', `page-${ws}`, `page-${ws}`, { pageId: `page-${ws}`, notebookId: `nb-${ws}`, workspaceId: ws, data: { objects: [] }, version: 1 }),
              await localRecord('notebookPage', `page-local-${ws}`, `sec-${ws}`, { id: `page-local-${ws}`, notebookId: `nb-${ws}`, sectionId: `sec-${ws}`, name: 'Browser-only', updatedAt: 2 }),
            ];
            for (const r of rows) await adapter.applyRecord({ workspaceId: ws, record: r, bytes: r.bytes });
          }
          for (const table of [db.workspaces, db.folders, db.notebooks, db.notebookSections, db.notebookPages, db.notebookPageContents, db.notebookPageDrawings]) {
            for (const row of await table.toArray()) { row.userId = 'legacy-owner'; await table.put(row); }
          }

          const run = resolutions => runCloudSyncV2({
            accountIdentifier: 'real-account', provider: loggingProvider, source, adapter, baselines, conflictStore,
            resolutions, environment: 'web',
          });

          const first = await run(undefined);
          const firstSummary = {
            status: first.status, errorCode: first.errorCode,
            downloaded: first.downloaded, uploaded: first.uploaded,
            conflicts: (first.conflicts ?? []).map(c => `${c.workspaceId}:${c.kind}:${c.id}`),
            outcomes: (first.workspaceOutcomes ?? []).map(o => `${o.workspaceId}:${o.classification}:${o.status}${o.diagnostic ? `:${o.diagnostic.reason}` : ''}`),
            error: first.error,
          };

          const resolutions = (first.conflicts ?? []).map(c => ({ workspaceId: c.workspaceId, kind: c.kind, id: c.id, choice: 'cloud' }));
          const second = await run(resolutions);
          // Mirror of the desktop "Use this device" flow: the local rows are
          // the authority and must publish to the emulated Drive.
          const third = await run((first.conflicts ?? []).map(c => ({ workspaceId: c.workspaceId, kind: c.kind, id: c.id, choice: 'device' })));
          const secondSummary = {
            status: second.status, errorCode: second.errorCode,
            downloaded: second.downloaded, uploaded: second.uploaded,
            conflicts: (second.conflicts ?? []).map(c => `${c.workspaceId}:${c.kind}:${c.id}`),
            outcomes: (second.workspaceOutcomes ?? []).map(o => `${o.workspaceId}:${o.classification}:${o.status}${o.diagnostic ? `:${o.diagnostic.reason}` : ''}`),
            error: second.error, diagnostic: second.diagnostic,
            sampleText: (await db.notebookPageContents.get(`page-${WS[0]}`))?.data?.text,
            appliedWorkspaces: (await db.workspaces.toArray()).filter(row => row.userId === null && WS.includes(row.id)).length,
          };
          const thirdSummary = {
            status: third.status, errorCode: third.errorCode,
            downloaded: third.downloaded, uploaded: third.uploaded,
            conflicts: (third.conflicts ?? []).map(c => `${c.workspaceId}:${c.kind}:${c.id}`),
            outcomes: (third.workspaceOutcomes ?? []).map(o => `${o.workspaceId}:${o.classification}:${o.status}${o.diagnostic ? `:${o.diagnostic.reason}` : ''}`),
            error: third.error, diagnostic: third.diagnostic,
          };
          return { firstSummary, secondSummary, thirdSummary };
        });
        console.log('run1:', JSON.stringify(result.firstSummary, null, 1));
        console.log('run2:', JSON.stringify(result.secondSummary, null, 1));
        console.log('run3-device:', JSON.stringify(result.thirdSummary, null, 1));
      } finally { await context.close(); }
    });
  } finally { await browser?.close(); await server.close(); }
});
