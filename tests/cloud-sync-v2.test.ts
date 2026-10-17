import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCloudSyncV2 } from '../src/services/cloudsync/v2/engine.ts';
import { encodeAssetEnvelope, decodeAssetEnvelope } from '../src/services/cloudsync/assetEnvelope.ts';
import { sha256Bytes } from '../src/services/cloudsync/hash.ts';
import { parsePdfAnnotationStorageId, pdfAnnotationStorageId } from '../src/lib/pdfAnnotationStorage.ts';
import { LocalSyncPayloadSource, semanticSystemBootstrapBytes, setCurrentBrowserUserIdReader, type BrowserSyncSnapshot } from '../src/services/cloudsync/payloadSource.ts';
import { SinglePendingRunner } from '../src/services/cloudsync/v2/singlePendingRunner.ts';
import { SyncRunAuthority } from '../src/services/cloudsync/runAuthority.ts';
import { LocalStorageSyncV2BaselineStore } from '../src/services/cloudsync/v2/baselineStore.ts';
import { planAccountAdoption } from '../src/services/cloudsync/v2/accountAdoption.ts';
import { browserRecordApplyFailureCode } from '../src/services/cloudsync/browserApply.ts';
import { copyWorkspaceGraph } from '../src/services/cloudsync/v2/workspaceCopy.ts';
import type { ScannedSyncEntity } from '../src/services/cloudsync/engine.ts';
import type { SyncV2BaselineRecord, SyncV2BaselineStore, SyncV2Catalog, SyncV2ConflictStore, SyncV2LocalAdapter, SyncV2LocalSource, SyncV2Manifest, SyncV2MigrationConflict, SyncV2Profile, SyncV2ProfileState, SyncV2Provider, SyncV2RemoteRead } from '../src/services/cloudsync/v2/types.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const key = (value: { entityType?: string; entityId?: string; kind?: string; id?: string }) => `${value.entityType ?? value.kind}:${value.entityId ?? value.id}`;

class MemoryBaselines implements SyncV2BaselineStore {
  profile: SyncV2ProfileState | null = null;
  workspaces = new Map<string, SyncV2BaselineRecord[]>();
  loadProfile() { return this.profile; }
  saveProfile(value: SyncV2ProfileState) { this.profile = value; }
  loadWorkspace(id: string) { return this.workspaces.get(id) ?? []; }
  saveWorkspace(id: string, records: SyncV2BaselineRecord[]) { this.workspaces.set(id, structuredClone(records)); }
}

class MemoryConflicts implements SyncV2ConflictStore {
  rows = new Map<string, SyncV2MigrationConflict>();
  preserve(value: SyncV2MigrationConflict) {
    if (this.rows.has(value.conflictId)) return Promise.resolve('present' as const);
    this.rows.set(value.conflictId, structuredClone(value));
    return Promise.resolve('created' as const);
  }
  hasUnresolved(profileId: string) {
    return Promise.resolve([...this.rows.values()].some(row => row.profileId === profileId && row.resolvedAt === null));
  }
}

class MemoryProvider implements SyncV2Provider {
  profile: SyncV2Profile | null = null; catalog: SyncV2Catalog | null = null;
  manifests = new Map<string, SyncV2Manifest>(); objects = new Map<string, Uint8Array>();
  uploads = 0; manifestWrites = 0; catalogWrites = 0; failCatalogOnce = false;
  putOrder: string[] = [];
  readProfile(): Promise<SyncV2RemoteRead<SyncV2Profile>> { return Promise.resolve({ value: this.profile, etag: this.profile ? 'profile-1' : null }); }
  async writeProfile(value: SyncV2Profile) { this.profile = value; return { etag: 'profile-1' }; }
  readCatalog(): Promise<SyncV2RemoteRead<SyncV2Catalog>> { return Promise.resolve({ value: this.catalog, etag: this.catalog ? `catalog-${this.catalog.revision}` : null }); }
  async writeCatalog(value: SyncV2Catalog) { if (this.failCatalogOnce) { this.failCatalogOnce = false; throw new Error('interrupted'); } this.catalog = structuredClone(value); this.catalogWrites += 1; return { etag: `catalog-${value.revision}` }; }
  readManifest(id: string): Promise<SyncV2RemoteRead<SyncV2Manifest>> { const value = this.manifests.get(id) ?? null; return Promise.resolve({ value, etag: value ? `${id}-${value.revision}` : null }); }
  async writeManifest(id: string, value: SyncV2Manifest) { this.manifests.set(id, structuredClone(value)); this.manifestWrites += 1; return { etag: `${id}-${value.revision}` }; }
  async getObject(hash: string) { const value = this.objects.get(hash); if (!value) throw new Error('missing object'); return value; }
  async putObjectIfAbsent(hash: string, bytes: Uint8Array) { this.putOrder.push(hash); if (this.objects.has(hash)) return 'present' as const; this.objects.set(hash, bytes.slice()); this.uploads += 1; return 'uploaded' as const; }
  async getObjectMetadata(hash: string) { const value = this.objects.get(hash); return value ? { size: value.byteLength } : null; }
}

class InterruptibleProvider extends MemoryProvider {
  uploadCalls = 0;
  failUploadAt: number | null = null;
  failManifestOnce = false;
  override async putObjectIfAbsent(hash: string, bytes: Uint8Array) {
    this.uploadCalls += 1;
    if (this.failUploadAt !== null && this.uploadCalls === this.failUploadAt) {
      this.failUploadAt = null;
      throw new Error('injected object-upload interruption');
    }
    return super.putObjectIfAbsent(hash, bytes);
  }
  override async writeManifest(id: string, value: SyncV2Manifest) {
    if (this.failManifestOnce) {
      this.failManifestOnce = false;
      throw new Error('injected manifest-finalization interruption');
    }
    return super.writeManifest(id, value);
  }
}

class InterruptibleBaselines extends MemoryBaselines {
  failWorkspaceSaveOnce = false;
  override saveWorkspace(id: string, records: SyncV2BaselineRecord[]) {
    if (this.failWorkspaceSaveOnce) {
      this.failWorkspaceSaveOnce = false;
      throw new Error('injected baseline-commit interruption');
    }
    return super.saveWorkspace(id, records);
  }
}

class Device {
  baselines = new MemoryBaselines(); conflicts = new MemoryConflicts(); entities = new Map<string, ScannedSyncEntity>();
  source: SyncV2LocalSource = { listWorkspaceIds: async () => [...new Set([...this.entities.values()].map(item => item.workspaceId))], scanWorkspace: async id => [...this.entities.values()].filter(item => item.workspaceId === id) };
  adapter: SyncV2LocalAdapter = { applyRecord: async ({ workspaceId, record, bytes }) => { this.entities.set(key(record), { entityType: record.kind, entityId: record.id, workspaceId, parentId: record.parentId, bytes, tombstone: record.tombstone, deletedAt: record.tombstone ? 1 : null }); } };
  add(entityType: ScannedSyncEntity['entityType'], entityId: string, parentId: string | null, value: unknown | Uint8Array, workspaceId = 'ws-A') { this.entities.set(`${entityType}:${entityId}`, { entityType, entityId, workspaceId, parentId, bytes: value instanceof Uint8Array ? value : encode(value), tombstone: false, deletedAt: null }); }
  edit(kind: ScannedSyncEntity['entityType'], id: string, value: unknown) { this.entities.get(`${kind}:${id}`)!.bytes = encode(value); }
  value(kind: ScannedSyncEntity['entityType'], id: string): any { return JSON.parse(new TextDecoder().decode(this.entities.get(`${kind}:${id}`)!.bytes!)); }
  asset(id: string) { return decodeAssetEnvelope(this.entities.get(`asset:${id}`)!.bytes!); }
}

function richDevice() {
  const device = new Device();
  device.add('workspace', 'ws-A', null, { id: 'ws-A' });
  device.add('folder', 'folder-1', 'ws-A', { id: 'folder-1' });
  device.add('notebook', 'nb-1', 'folder-1', { id: 'nb-1' });
  device.add('notebookSection', 'sec-1', 'nb-1', { id: 'sec-1' });
  device.add('notebookPage', 'page-1', 'sec-1', { id: 'page-1', notebookId: 'nb-1', sectionId: 'sec-1', type: 'default' });
  device.add('pageContent', 'page-1', 'page-1', { pageId: 'page-1', data: { text: 'important' } });
  device.add('pageDrawing', 'page-1', 'page-1', { pageId: 'page-1', data: { objects: [{ id: 'image-1', type: 'image', fileId: 'image-page' }], audioNotes: [{ id: 'note-1', fileId: 'audio-page' }] } });
  device.add('notebookPage', 'page-pdf', 'sec-1', { id: 'page-pdf', notebookId: 'nb-1', sectionId: 'sec-1', type: 'pdf', pdfDataId: 'pdf-notebook' });
  device.add('pageDrawing', pdfAnnotationStorageId('page-pdf', 1), 'page-pdf', { pageId: pdfAnnotationStorageId('page-pdf', 1), data: { objects: [{ id: 'ink-1', type: 'stroke' }] } });
  device.add('pageDrawing', pdfAnnotationStorageId('page-pdf', 2), 'page-pdf', { pageId: pdfAnnotationStorageId('page-pdf', 2), data: { objects: [{ id: 'ink-2', type: 'stroke' }] } });
  device.add('canvasFile', 'canvas-1', 'ws-A', { id: 'canvas-1' });
  device.add('canvasScene', 'canvas-1', 'canvas-1', { canvasFileId: 'canvas-1', elements: [{ id: 'shape-1' }], files: { embedded: { dataURL: 'data:image/png;base64,AQID' } }, customBlocks: [{ id: 'block-pdf', type: 'pdf', metadata: { pdfDataId: 'pdf-canvas' } }, { id: 'block-audio', type: 'audio', metadata: { audioFileId: 'audio-canvas' } }] });
  device.add('customBlock', 'block-pdf', 'canvas-1', { id: 'block-pdf', canvasFileId: 'canvas-1', type: 'pdf', metadata: { pdfDataId: 'pdf-canvas' } });
  device.add('customBlock', 'block-audio', 'canvas-1', { id: 'block-audio', canvasFileId: 'canvas-1', type: 'audio', metadata: { audioFileId: 'audio-canvas' } });
  device.add('asset', 'pdf-notebook', 'page-pdf', encodeAssetEnvelope({ id: 'pdf-notebook', ownerId: 'page-pdf', fileName: 'paper.pdf', mimeType: 'application/pdf', assetKind: 'pdf', createdAt: 1, userId: null }, new Uint8Array([37, 80, 68, 70, 1, 2, 3])));
  device.add('asset', 'image-page', 'page-1', encodeAssetEnvelope({ id: 'image-page', ownerId: 'page-1', fileName: 'figure.png', mimeType: 'image/png', assetKind: 'image', createdAt: 2, userId: null }, new Uint8Array([137, 80, 78, 71])));
  device.add('asset', 'audio-page', 'page-1', encodeAssetEnvelope({ id: 'audio-page', ownerId: 'page-1', fileName: 'note.webm', mimeType: 'audio/webm', assetKind: 'audio', createdAt: 3, userId: null }, new Uint8Array([26, 69, 223, 163])));
  device.add('asset', 'pdf-canvas', 'canvas-1', encodeAssetEnvelope({ id: 'pdf-canvas', ownerId: 'canvas-1', fileName: 'canvas.pdf', mimeType: 'application/pdf', assetKind: 'pdf', createdAt: 4, userId: null }, new Uint8Array([37, 80, 68, 70, 9])));
  device.add('asset', 'audio-canvas', 'canvas-1', encodeAssetEnvelope({ id: 'audio-canvas', ownerId: 'canvas-1', fileName: 'canvas.webm', mimeType: 'audio/webm', assetKind: 'audio', createdAt: 5, userId: null }, new Uint8Array([1, 2, 3, 4])));
  return device;
}

const sync = (provider: MemoryProvider, device: Device, account = 'account-A') => runCloudSyncV2({ accountIdentifier: account, provider, source: device.source, adapter: device.adapter, baselines: device.baselines, conflictStore: device.conflicts });

const documentationDrawing = (pageSize = 'A4') => ({
  properties: { layoutMode: 'document', pageSize, infiniteWidth: 794 },
  objects: [{ id: 'body-1', type: 'text', metadata: { documentRole: 'body', richTextSchemaVersion: 3 }, content: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2, blockId: 'heading-1' }, content: [{ type: 'text', text: 'page-pdf is ordinary prose' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'marked link', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'highlight', attrs: { color: '#9b59b6' } },
      { type: 'textStyle', attrs: { color: '#123456' } }, { type: 'link', attrs: { href: 'file:///C:/Panvas/dist/index.html?panvasPage=page-pdf&panvasBlock=heading-2' } }] }] },
    { type: 'pageReference', attrs: { targetPageId: 'page-pdf', targetBlockId: 'heading-2' } },
    { type: 'callout', content: [{ type: 'paragraph', content: [{ type: 'inlineImage', attrs: { fileId: 'image-page' } }] }] },
    { type: 'image', attrs: { source: 'https://external.invalid/image.png' } },
    { type: 'codeBlock', attrs: { language: 'rust', wrap: false }, content: [{ type: 'text', text: 'fn main() {}' }] },
    { type: 'blockMath', attrs: { latex: 'E=mc^2' } },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: [140] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'table content' }] }] }] }] },
  ] } }],
});

test('native sync scanner includes nested documentation images without fetching external references', async () => {
  const previousWindow = (globalThis as any).window, requested: string[] = [];
  const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
  const document = documentationDrawing();
  (globalThis as any).window = { panvas: {
    workspace: { getAll: async () => [{ id: 'ws-doc', userId: null }] }, folder: { getAll: async () => [] },
    notebook: { getAll: async () => [{ id: 'nb-doc', workspaceId: 'ws-doc' }], loadPage: async () => null, loadDrawing: async () => document },
    notebookSection: { getAll: async () => [{ id: 'sec-doc', notebookId: 'nb-doc' }] },
    notebookPage: { getAll: async () => [{ id: 'page-doc', notebookId: 'nb-doc', sectionId: 'sec-doc' }] },
    canvasFile: { getAll: async () => [] }, cloudsync: { listPageDrawingRecords: async () => [] },
    binary: { getImage: async (id: string) => { requested.push(id); return { data: bytes, fileName: 'figure.png', mimeType: 'image/png' }; } },
  } };
  try {
    const entities = await new LocalSyncPayloadSource().scanWorkspace('ws-doc');
    assert.deepEqual(requested, ['image-page']);
    const asset = entities.find(entity => entity.entityType === 'asset')!;
    assert.equal(asset.parentId, 'page-doc'); assert.deepEqual([...decodeAssetEnvelope(asset.bytes!)!.bytes], [137, 80, 78, 71]);
  } finally { (globalThis as any).window = previousWindow; }
});

test('workspace copies remap documentation references and internal links while retaining prose and binary bytes', async () => {
  const device = richDevice(); device.edit('pageDrawing', 'page-1', { pageId: 'page-1', data: documentationDrawing('Infinite') });
  const graph = [...device.entities.values()], copied = await copyWorkspaceGraph('profile-doc', 'ws-A', graph);
  const copyOf = (kind: string, id: string) => copied.entities[graph.findIndex(entity => entity.entityType === kind && entity.entityId === id)]!;
  const drawing = JSON.parse(new TextDecoder().decode(copyOf('pageDrawing', 'page-1').bytes!)).data;
  const nodes = drawing.objects[0].content.content;
  assert.equal(nodes[0].content[0].text, 'page-pdf is ordinary prose');
  assert.deepEqual(nodes[1].content[0].marks.slice(0, 4), documentationDrawing().objects[0].content.content[1].content![0].marks!.slice(0, 4));
  const targetPage = copyOf('notebookPage', 'page-pdf').entityId;
  assert.equal(nodes[2].attrs.targetPageId, targetPage); assert.equal(nodes[2].attrs.targetBlockId, 'heading-2');
  assert.equal(new URL(nodes[1].content[0].marks[4].attrs.href).searchParams.get('panvasPage'), targetPage);
  assert.equal(nodes[4].attrs.source, 'https://external.invalid/image.png');
  assert.deepEqual(drawing.properties, documentationDrawing('Infinite').properties);
  const image = decodeAssetEnvelope(copyOf('asset', 'image-page').bytes!)!;
  assert.deepEqual([...image.bytes], [137, 80, 78, 71]); assert.equal(image.metadata.ownerId, copyOf('notebookPage', 'page-1').entityId);
});

test('rich A4 and Infinite documentation survives interrupted upload retry and a fresh replica', async () => {
  const provider = new InterruptibleProvider(), desktop = richDevice();
  desktop.edit('pageDrawing', 'page-1', { pageId: 'page-1', data: documentationDrawing() });
  desktop.add('notebookPage', 'infinite-doc', 'sec-1', { id: 'infinite-doc', notebookId: 'nb-1', sectionId: 'sec-1', type: 'default' });
  desktop.add('pageDrawing', 'infinite-doc', 'infinite-doc', { pageId: 'infinite-doc', data: documentationDrawing('Infinite') });
  provider.failUploadAt = 3;
  assert.equal((await sync(provider, desktop)).status, 'error');
  assert.equal((await sync(provider, desktop)).status, 'synced');
  const browser = new Device(); assert.equal((await sync(provider, browser)).status, 'synced');
  for (const id of ['page-1', 'infinite-doc']) assert.deepEqual(browser.value('pageDrawing', id), desktop.value('pageDrawing', id));
  assert.deepEqual(browser.asset('image-page')!.bytes, desktop.asset('image-page')!.bytes);
  assert.equal((await sync(provider, browser)).status, 'synced');
});

test('returning browser with legacy baselines downloads remote pages and contents despite local bookkeeping', async () => {
  const provider = new MemoryProvider();
  const electron = richDevice();
  const browser = new Device();
  assert.equal((await sync(provider, electron)).status, 'synced');
  assert.equal((await sync(provider, browser)).status, 'synced');
  // Model browser row stamping and opening a page, without editing its content.
  for (const entity of browser.entities.values()) {
    if (entity.entityType === 'asset') continue;
    browser.edit(entity.entityType, entity.entityId, {
      ...browser.value(entity.entityType, entity.entityId),
      userId: 'browser-owner', syncStatus: 'synced', lastOpenedAt: 500, updatedAt: 500,
      ...(['folder', 'notebook', 'notebookSection'].includes(entity.entityType) ? { isExpanded: false } : {}),
    });
  }
  electron.edit('notebookPage', 'page-1', { ...electron.value('notebookPage', 'page-1'), name: 'Edited on desktop', updatedAt: 600 });
  electron.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'new desktop content' }, updatedAt: 600 });
  electron.edit('pageDrawing', 'page-1', { pageId: 'page-1', data: { objects: [{ id: 'desktop-stroke', type: 'stroke' }] }, updatedAt: 600 });
  electron.add('notebookPage', 'page-new', 'sec-1', { id: 'page-new', notebookId: 'nb-1', sectionId: 'sec-1' });
  electron.add('pageContent', 'page-new', 'page-new', { pageId: 'page-new', data: { text: 'new page contents' } });
  assert.equal((await sync(provider, electron)).status, 'synced');
  const resumed = await sync(provider, browser);
  assert.equal(resumed.status, 'synced');
  assert.deepEqual(resumed.conflicts, []);
  assert.equal(browser.value('pageContent', 'page-1').data.text, 'new desktop content');
  assert.equal(browser.value('pageDrawing', 'page-1').data.objects[0].id, 'desktop-stroke');
  assert.equal(browser.value('pageContent', 'page-new').data.text, 'new page contents');
  assert.equal(browser.value('notebookPage', 'page-1').name, 'Edited on desktop');
  assert.deepEqual(browser.asset('pdf-notebook').bytes, electron.asset('pdf-notebook').bytes);
  const retry = await sync(provider, browser);
  assert.equal(retry.status, 'synced');
  assert.equal(retry.uploaded + retry.downloaded, 0);
});

test('metadata comparison preserves real offline edits and still detects concurrent content changes', async () => {
  const provider = new MemoryProvider();
  const desktop = richDevice();
  const browser = new Device();
  await sync(provider, desktop);
  await sync(provider, browser);
  browser.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'browser edit' }, lastOpenedAt: 10 });
  desktop.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'important' }, syncStatus: 'synced', updatedAt: 20 });
  await sync(provider, desktop);
  assert.equal((await sync(provider, browser)).status, 'synced');
  await sync(provider, desktop);
  assert.equal(desktop.value('pageContent', 'page-1').data.text, 'browser edit');
  browser.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'second browser edit' } });
  desktop.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'concurrent desktop edit' } });
  await sync(provider, desktop);
  assert.equal((await sync(provider, browser)).status, 'conflict');
  assert.equal(browser.value('pageContent', 'page-1').data.text, 'second browser edit');
});

async function conflictFixture() {
  const provider = new MemoryProvider();
  const desktop = richDevice();
  const browser = new Device();
  assert.equal((await sync(provider, desktop)).status, 'synced');
  assert.equal((await sync(provider, browser)).status, 'synced');
  desktop.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'desktop winner' } });
  browser.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'browser winner' } });
  assert.equal((await sync(provider, desktop)).status, 'synced');
  assert.equal((await sync(provider, browser)).status, 'conflict');
  return { provider, desktop, browser };
}

test('explicit cloud/device/both conflict choices reconcile V2 and retain recovery bytes', async () => {
  for (const choice of ['cloud', 'device', 'both'] as const) {
    const { provider, desktop, browser } = await conflictFixture();
    const resolved = await runCloudSyncV2({
      accountIdentifier: 'account-A',
      provider,
      source: browser.source,
      adapter: browser.adapter,
      baselines: browser.baselines,
      conflictStore: browser.conflicts,
      resolutions: [{ workspaceId: 'ws-A', kind: 'pageContent', id: 'page-1', choice }],
    });
    assert.equal(resolved.status, 'synced', `choice ${choice} should finish synced`);
    if (choice === 'device') {
      const fresh = new Device();
      assert.equal((await sync(provider, fresh)).status, 'synced');
      assert.equal(fresh.value('pageContent', 'page-1').data.text, 'browser winner');
    } else {
      assert.equal(browser.value('pageContent', 'page-1').data.text, 'desktop winner');
    }
    const saved = [...browser.conflicts.rows.values()].find(row => row.resolution === choice);
    assert.ok(saved, `choice ${choice} should retain a recovery row`);
    assert.ok(saved?.localBytes.byteLength);
    if (choice === 'both') assert.ok(saved?.remoteBytes?.byteLength);
    const next = await sync(provider, browser);
    assert.equal(next.status, 'synced', JSON.stringify(next));
    assert.equal(next.uploaded + next.downloaded, 0, 'resolution must establish a stable BASE');
    if (choice === 'both') {
      const ids = await browser.source.listWorkspaceIds();
      assert.equal(ids.length, 2, 'Keep both must create two normal workspaces');
      assert.equal(provider.catalog!.workspaces.length, 2);
      const fresh = new Device();
      assert.equal((await sync(provider, fresh)).status, 'synced');
      assert.deepEqual((await fresh.source.listWorkspaceIds()).sort(), ids.sort());
    }
    void desktop;
  }
});

test('all choices preserve a repaired canonical root before applying descendants', async () => {
  for (const choice of ['cloud', 'device', 'both'] as const) {
    const { provider, browser } = await conflictFixture();
    const manifest = provider.manifests.get('ws-A')!;
    manifest.records = manifest.records.filter(record => record.kind !== 'workspace');
    const result = await runCloudSyncV2({ accountIdentifier: 'account-A', provider, source: browser.source, adapter: browser.adapter, baselines: browser.baselines, conflictStore: browser.conflicts,
      resolutions: [{ workspaceId: 'ws-A', kind: 'pageContent', id: 'page-1', choice }] });
    assert.equal(result.status, 'synced', `${choice}: ${JSON.stringify(result)}`);
    assert.equal(provider.manifests.get('ws-A')!.records.find(r => r.kind === 'workspace')?.tombstone, false);
    const next = await sync(provider, browser);
    assert.equal(next.status, 'synced', JSON.stringify(next));
    assert.equal(next.uploaded + next.downloaded, 0);
  }
});

test('unusable root objects are quarantined without applying or baselining children', async () => {
  for (const shape of ['missing', 'invalid-json', 'wrong-id', 'deleted'] as const) {
    const provider = new MemoryProvider(); await sync(provider, richDevice());
    const root = provider.manifests.get('ws-A')!.records.find(r => r.kind === 'workspace')!;
    if (shape === 'missing') provider.objects.delete(root.hash!);
    else {
      const bytes = shape === 'invalid-json' ? new TextEncoder().encode('{') : encode({ id: shape === 'wrong-id' ? 'ws-other' : 'ws-A', deletedAt: shape === 'deleted' ? 123 : null });
      root.hash = await sha256Bytes(bytes); provider.objects.set(root.hash, bytes);
    }
    const fresh = new Device();
    const result = await sync(provider, fresh);
    assert.equal(result.status, 'synced-review', `${shape}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.conflicts, []);
    assert.equal(fresh.entities.size, 0);
    assert.equal(fresh.baselines.workspaces.size, 0);
  }
});

test('a tombstoned remote root with live children is quarantined before reconciliation and apply', async () => {
  const provider = new MemoryProvider();
  const owner = richDevice();
  await sync(provider, owner);
  const manifest = provider.manifests.get('ws-A')!;
  manifest.records = manifest.records.map(record => record.kind === 'workspace'
    ? { ...record, tombstone: true, baseHash: record.hash, hash: null } : record);
  for (const returning of [new Device(), owner]) {
    let applied = 0;
    returning.adapter = { applyRecord: async () => { applied++; } };
    const result = await sync(provider, returning);
    assert.equal(result.status, 'synced-review', JSON.stringify(result));
    assert.equal(applied, 0, 'no child or root of a quarantined workspace may be applied');
    assert.deepEqual(result.conflicts, [], 'quarantine must not also produce entity conflicts');
    assert.ok(['orphaned', 'ambiguous'].includes(result.workspaceOutcomes[0].classification));
  }
});

test('legacy browser asset ownership stamps do not create an asset conflict', async () => {
  const provider = new MemoryProvider();
  const desktop = richDevice();
  const browser = new Device();
  await sync(provider, desktop);
  await sync(provider, browser);
  const existing = browser.entities.get('asset:pdf-notebook')!;
  const envelope = decodeAssetEnvelope(existing.bytes!)!;
  existing.bytes = encodeAssetEnvelope({ ...envelope.metadata, userId: 'browser-owner' }, envelope.bytes);
  const result = await sync(provider, browser);
  assert.equal(result.status, 'synced');
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.uploaded + result.downloaded, 0);
});

test('a partially baselined returning browser uses the remote historical base to receive device edits', async () => {
  const provider = new MemoryProvider();
  const desktop = richDevice();
  const browser = new Device();
  await sync(provider, desktop);
  await sync(provider, browser);
  const prior = browser.baselines.loadWorkspace('ws-A');
  browser.baselines.workspaces.set('ws-A', prior.filter(record => !(record.entityKind === 'pageContent' && record.entityId === 'page-1')));
  desktop.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'desktop changed while browser was closed' } });
  await sync(provider, desktop);
  const result = await sync(provider, browser);
  assert.equal(result.status, 'synced');
  assert.deepEqual(result.conflicts, []);
  assert.equal(browser.value('pageContent', 'page-1').data.text, 'desktop changed while browser was closed');
});

test('Use this account adoption reconciles stale V1 ownership before the next V2 run and is idempotent', () => {
  const plan = planAccountAdoption({
    connection: { accountIdentifier: 'account-B', email: 'b@example.test' },
    remoteProfile: null,
    remoteCatalog: null,
    localProfile: null,
    localWorkspaceIds: ['ws-A'],
    legacyBindings: [{ workspaceId: 'ws-A', provider: 'googledrive', providerAccountId: 'account-A', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: 4, attachedAt: 10 }],
    now: 20,
  });
  assert.deepEqual(plan.foreignWorkspaceIds, ['ws-A']);
  assert.deepEqual(plan.bindings, [{ workspaceId: 'ws-A', provider: 'googledrive', providerAccountId: 'account-B', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: 0, attachedAt: 10 }]);
  assert.equal(plan.profile.accountIdentifier, 'account-B');
  assert.equal(plan.bindings.some(binding => binding.providerAccountId === 'account-A'), false, 'the next V2 ownership guard cannot see the stale account');
  const second = planAccountAdoption({
    connection: { accountIdentifier: 'account-B', email: 'b@example.test' },
    remoteProfile: { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: plan.profile.profileId, accountIdentifier: 'account-B' },
    remoteCatalog: { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 1, workspaces: [] },
    localProfile: plan.profile,
    localWorkspaceIds: ['ws-A'],
    legacyBindings: plan.bindings,
    now: 30,
  });
  assert.deepEqual({ profile: second.profile, bindings: second.bindings }, { profile: plan.profile, bindings: plan.bindings }, 'repeating the explicit action does not duplicate or damage ownership state');
  assert.deepEqual(second.foreignWorkspaceIds, [], 'the second adoption has no stale ownership left to migrate');
});

test('adoption collapses mixed and unbound local workspace bindings to the selected account', () => {
  const plan = planAccountAdoption({
    connection: { accountIdentifier: 'account-B', email: 'b@example.test' },
    remoteProfile: null,
    remoteCatalog: null,
    localProfile: null,
    localWorkspaceIds: ['ws-A', 'ws-B'],
    legacyBindings: [
      { workspaceId: 'ws-A', provider: 'googledrive', providerAccountId: 'account-A', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: 4, attachedAt: 10 },
      { workspaceId: 'ws-A', provider: 'googledrive', providerAccountId: 'account-B', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: 5, attachedAt: 11 },
    ],
    now: 20,
  });
  assert.deepEqual(plan.foreignWorkspaceIds, [], 'a workspace already carrying the selected account is not a migration blocker');
  assert.deepEqual(plan.bindings.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)), [
    { workspaceId: 'ws-A', provider: 'googledrive', providerAccountId: 'account-B', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: 5, attachedAt: 11 },
    { workspaceId: 'ws-B', provider: 'googledrive', providerAccountId: 'account-B', remoteWorkspaceId: 'ws-B', lastKnownRemoteRevision: 0, attachedAt: 20 },
  ]);
});

test('switching accounts starts a fresh profile and safely resumes an owned destination', () => {
  const fresh = planAccountAdoption({
    connection: { accountIdentifier: 'account-B', email: 'b@example.test' },
    remoteProfile: null,
    remoteCatalog: null,
    localProfile: { profileId: 'profile-a', accountIdentifier: 'account-A' },
    localWorkspaceIds: ['ws-A'],
    legacyBindings: [],
  });
  assert.equal(fresh.profile.accountIdentifier, 'account-B');
  assert.notEqual(fresh.profile.profileId, 'profile-a');
  assert.equal(fresh.baselineResetRequired, true);
  const resumed = planAccountAdoption({
    connection: { accountIdentifier: 'account-B', email: 'b@example.test' },
    remoteProfile: { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: 'profile-a', accountIdentifier: 'account-B' },
    remoteCatalog: { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 1, workspaces: [] },
    localProfile: { profileId: 'profile-a', accountIdentifier: 'account-A' },
    localWorkspaceIds: ['ws-A'],
    legacyBindings: [],
  });
  assert.equal(resumed.profile.profileId, 'profile-a');
  assert.equal(resumed.baselineResetRequired, true);
});

test('account adoption blocks a conflicting destination with a specific safe error', () => {
  assert.throws(() => planAccountAdoption({
    connection: { accountIdentifier: 'account-B', email: 'b@example.test' },
    remoteProfile: { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: 'profile-a', accountIdentifier: 'account-A' },
    remoteCatalog: null,
    localProfile: null,
    localWorkspaceIds: ['ws-A'],
    legacyBindings: [],
  }), (error: any) => error?.code === 'remote-account-conflict' && /different Panvas sync space/.test(error.message));
});

test('account adoption keeps a different Panvas profile protected during an account switch', () => {
  assert.throws(() => planAccountAdoption({
    connection: { accountIdentifier: 'account-B', email: 'b@example.test' },
    remoteProfile: { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: 'profile-b', accountIdentifier: 'account-B' },
    remoteCatalog: { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 3, workspaces: [{ workspaceId: 'ws-remote', manifestRevision: 2 }] },
    localProfile: { profileId: 'profile-a', accountIdentifier: 'account-A' },
    localWorkspaceIds: ['ws-local'],
    legacyBindings: [],
  }), (error: any) => error?.code === 'remote-account-conflict' && error?.diagnostic?.reason === 'profile-id-mismatch');
});

test('same Google account can adopt a profile created by another device', () => {
  const plan = planAccountAdoption({
    connection: { accountIdentifier: 'account-A', email: 'a@example.test' },
    remoteProfile: { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: 'profile-remote', accountIdentifier: 'account-A' },
    remoteCatalog: { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 1, workspaces: [] },
    localProfile: { profileId: 'profile-browser', accountIdentifier: 'account-A' },
    localWorkspaceIds: ['ws-A'],
    legacyBindings: [],
  });
  assert.equal(plan.profile.profileId, 'profile-remote');
  assert.equal(plan.profile.accountIdentifier, 'account-A');
  assert.equal(plan.baselineResetRequired, true);
});

test('browser record ownership failures stay out of the account-adoption state', () => {
  assert.equal(browserRecordApplyFailureCode('local-owner-mismatch'), 'conflict');
  assert.equal(browserRecordApplyFailureCode('workspace-unavailable'), 'conflict');
  assert.equal(browserRecordApplyFailureCode('parent-unavailable'), 'conflict');
  assert.equal(browserRecordApplyFailureCode('payload-identity-mismatch'), 'payload');
  assert.equal(browserRecordApplyFailureCode('local-user-changed'), 'sync');
  assert.notEqual(browserRecordApplyFailureCode('local-owner-mismatch'), 'account-migration-required');
});

test('an interrupted account adoption resumes the selected account instead of creating a false conflict', async () => {
  const provider = new MemoryProvider();
  const owner = richDevice();
  assert.equal((await sync(provider, owner, 'account-B')).status, 'synced');

  const resumed = richDevice();
  resumed.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'local recovery copy' } });
  resumed.baselines.profile = { profileId: provider.profile!.profileId, accountIdentifier: 'account-B' };
  const result = await sync(provider, resumed, 'account-B');
  assert.equal(result.status, 'conflict');
  assert.equal(result.downloaded, 0);
  assert.match(new TextDecoder().decode(resumed.entities.get('pageContent:page-1')!.bytes!), /local recovery copy/);
});

test('two-client adoption path uploads Electron data, reconstructs Browser data, and round-trips an edit', async () => {
  const provider = new MemoryProvider();
  const electron = richDevice();
  electron.baselines.profile = { profileId: 'profile-a', accountIdentifier: 'account-A' };
  const initialBindings = [{ workspaceId: 'ws-A', provider: 'googledrive', providerAccountId: 'account-A', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: 0, attachedAt: 1 }] as const;
  const adoption = planAccountAdoption({
    connection: { accountIdentifier: 'account-B', email: 'b@example.test' },
    remoteProfile: null,
    remoteCatalog: null,
    localProfile: electron.baselines.profile,
    localWorkspaceIds: ['ws-A'],
    legacyBindings: initialBindings,
    now: 2,
  });
  assert.deepEqual(adoption.foreignWorkspaceIds, ['ws-A']);
  assert.equal(adoption.bindings[0].providerAccountId, 'account-B');
  assert.equal(adoption.baselineResetRequired, true);
  // Apply the same metadata handoff that the store commits before its first
  // reconciliation. The engine then proves the real Electron -> Drive ->
  // Browser path, rather than only exercising the pure plan helper.
  electron.baselines.profile = adoption.profile;
  assert.equal((await sync(provider, electron, 'account-B')).status, 'synced');
  assert.equal(provider.profile?.accountIdentifier, 'account-B');
  assert.equal(electron.baselines.profile?.accountIdentifier, 'account-B');

  const browser = new Device();
  assert.equal((await sync(provider, browser, 'account-B')).status, 'synced');
  assert.deepEqual([...browser.entities.keys()].sort(), [...electron.entities.keys()].sort());
  browser.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'browser round-trip' } });
  assert.equal((await sync(provider, browser, 'account-B')).status, 'synced');
  assert.equal((await sync(provider, electron, 'account-B')).status, 'synced');
  assert.match(new TextDecoder().decode(electron.entities.get('pageContent:page-1')!.bytes!), /browser round-trip/);
});

test('same-account profile replacement does not loop back to migration-required', async () => {
  const provider = new MemoryProvider();
  const owner = richDevice();
  assert.equal((await sync(provider, owner, 'account-A')).status, 'synced');
  const browser = new Device();
  browser.baselines.profile = { profileId: 'older-browser-profile', accountIdentifier: 'account-A' };
  browser.baselines.workspaces.set('ws-A', [{ entityId: 'ws-A', entityKind: 'workspace', baseHash: '0'.repeat(64), localHash: '0'.repeat(64), remoteHash: '0'.repeat(64), remoteRevision: 1, tombstone: false }]);
  const result = await sync(provider, browser, 'account-A');
  assert.equal(result.status, 'synced');
  assert.equal(browser.baselines.profile?.profileId, provider.profile?.profileId);
  assert.equal(result.errorCode, undefined);
});

test('obsolete V2 run stops before profile, payload or baseline publication', async () => {
  const authority = new SyncRunAuthority();
  const provider = new MemoryProvider(); const device = richDevice();
  provider.readCatalog = async () => { authority.invalidate(); return { value: null, etag: null }; };
  const result = await runCloudSyncV2({ accountIdentifier: 'account-A', provider, source: device.source, adapter: device.adapter, baselines: device.baselines, conflictStore: device.conflicts, assertCurrent: authority.capture() });
  assert.equal(result.status, 'error');
  assert.equal(provider.profile, null);
  assert.equal(provider.uploads, 0);
  assert.equal(device.baselines.profile, null);
});

test('V2 malformed kinds, duplicate records and workspace identities fail closed', async () => {
  for (const mutate of [
    (manifest: SyncV2Manifest) => { manifest.records[0].kind = '__proto__' as any; },
    (manifest: SyncV2Manifest) => { manifest.records.push(manifest.records[0]); },
    (manifest: SyncV2Manifest) => { manifest.records.find(record => record.kind === 'workspace')!.id = 'ws-other'; },
  ]) {
    const provider = new MemoryProvider(); await sync(provider, richDevice());
    mutate(provider.manifests.get('ws-A')!);
    const target = new Device(); const result = await sync(provider, target);
    assert.equal(result.status, 'error');
    assert.equal(result.diagnostic?.reason, 'invalid-manifest');
    assert.equal(result.diagnostic?.workspaceId, 'ws-A');
    assert.equal(target.entities.size, 0);
  }
});

function systemBootstrap(timestamp: number, userId: string) {
  const device = new Device();
  const workspaceId = 'ws-system-default-v1';
  device.add('workspace', workspaceId, null, { id: workspaceId, name: 'My Workspace', createdAt: timestamp, updatedAt: timestamp, isPinned: false, syncStatus: 'local', userId, deletedAt: null, isSystem: true, systemType: 'default' }, workspaceId);
  device.add('canvasFile', 'canvas-system-welcome-v1', workspaceId, { id: 'canvas-system-welcome-v1', workspaceId, folderId: null, name: 'Welcome Canvas', createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: timestamp, order: 0, isPinned: false, syncStatus: 'local', userId, deletedAt: null, isSystem: true, systemType: 'welcome' }, workspaceId);
  device.add('canvasScene', 'canvas-system-welcome-v1', 'canvas-system-welcome-v1', { canvasFileId: 'canvas-system-welcome-v1', elements: [], appState: {}, files: {}, customBlocks: [], version: 1, updatedAt: timestamp, userId }, workspaceId);
  return device;
}

test('fresh system bootstrap reconciles remote metadata, establishes a baseline, and stays idempotent', async () => {
  const provider = new MemoryProvider();
  const remote = systemBootstrap(1, 'remote-device');
  assert.equal((await sync(provider, remote)).status, 'synced');

  const fresh = systemBootstrap(2, 'fresh-device');
  const localWorkspaceIdentity = semanticSystemBootstrapBytes('workspace', 'ws-system-default-v1', fresh.entities.get('workspace:ws-system-default-v1')!.bytes!);
  const remoteWorkspaceIdentity = semanticSystemBootstrapBytes('workspace', 'ws-system-default-v1', remote.entities.get('workspace:ws-system-default-v1')!.bytes!);
  assert.deepEqual(localWorkspaceIdentity, remoteWorkspaceIdentity, 'device-local bootstrap fields do not change semantic identity');

  const first = await sync(provider, fresh);
  assert.equal(first.status, 'synced');
  assert.equal(first.conflicts.length, 0);
  assert.equal(first.downloaded, 3);
  assert.equal(fresh.baselines.loadWorkspace('ws-system-default-v1').length, 3);
  assert.equal(fresh.value('workspace', 'ws-system-default-v1').createdAt, 1, 'canonical remote bootstrap wins');

  const uploads = provider.uploads; const downloads = first.downloaded;
  const second = await sync(provider, fresh);
  assert.equal(second.status, 'synced');
  assert.equal(second.downloaded, 0);
  assert.equal(provider.uploads, uploads);
  assert.equal(downloads, 3);
});

test('edited Welcome Canvas and normal user workspaces keep existing conflict behavior', async () => {
  const provider = new MemoryProvider(); const remote = systemBootstrap(1, 'device-a'); await sync(provider, remote);
  const browser = systemBootstrap(2, 'device-b'); await sync(provider, browser);
  browser.edit('canvasScene', 'canvas-system-welcome-v1', { canvasFileId: 'canvas-system-welcome-v1', elements: [{ id: 'local-edit' }], appState: {}, files: {}, customBlocks: [], version: 1, updatedAt: 3, userId: 'device-b' });
  remote.edit('canvasScene', 'canvas-system-welcome-v1', { canvasFileId: 'canvas-system-welcome-v1', elements: [{ id: 'remote-edit' }], appState: {}, files: {}, customBlocks: [], version: 1, updatedAt: 4, userId: 'device-a' });
  assert.equal((await sync(provider, remote)).status, 'synced');
  const welcomeConflict = await sync(provider, browser);
  assert.equal(welcomeConflict.status, 'conflict');
  assert.ok(welcomeConflict.conflicts.some(item => item.kind === 'canvasScene' && item.id === 'canvas-system-welcome-v1'));

  const userProvider = new MemoryProvider(); const a = new Device(); const b = new Device();
  a.add('workspace', 'ws-user', null, { id: 'ws-user', name: 'A', createdAt: 1, updatedAt: 1 }, 'ws-user');
  b.add('workspace', 'ws-user', null, { id: 'ws-user', name: 'B', createdAt: 2, updatedAt: 2 }, 'ws-user');
  await sync(userProvider, a);
  assert.equal((await sync(userProvider, b)).status, 'conflict', 'meaningful no-baseline work needs an explicit choice');
  a.edit('workspace', 'ws-user', { id: 'ws-user', name: 'A2', createdAt: 1, updatedAt: 3 });
  b.edit('workspace', 'ws-user', { id: 'ws-user', name: 'B2', createdAt: 2, updatedAt: 4 });
  await sync(userProvider, a);
  const userConflict = await sync(userProvider, b);
  assert.equal(userConflict.status, 'conflict');
  assert.deepEqual(userConflict.conflicts.map(item => `${item.kind}:${item.id}`), ['workspace:ws-user']);
});

test('V2 reconstructs the complete Electron hierarchy and exact binary assets on a fresh browser', async () => {
  const provider = new MemoryProvider(); const electron = richDevice();
  assert.equal((await sync(provider, electron)).status, 'synced');
  const browser = new Device();
  assert.equal((await sync(provider, browser)).status, 'synced');
  assert.deepEqual([...browser.entities.keys()].sort(), [...electron.entities.keys()].sort());
  assert.equal(browser.entities.get('pageDrawing:page-pdf_pdf_1')?.parentId, 'page-pdf');
  assert.equal(browser.entities.get('pageDrawing:page-pdf_pdf_2')?.parentId, 'page-pdf');
  assert.equal(browser.value('notebookPage', 'page-pdf').pdfDataId, 'pdf-notebook');
  assert.equal(browser.value('canvasScene', 'canvas-1').files.embedded.dataURL, 'data:image/png;base64,AQID');
  const asset = browser.asset('pdf-notebook');
  assert.equal(asset?.metadata.mimeType, 'application/pdf');
  assert.deepEqual([...asset!.bytes], [37, 80, 68, 70, 1, 2, 3]);
  assert.equal(browser.asset('image-page')?.metadata.assetKind, 'image');
  assert.equal(browser.asset('audio-page')?.metadata.assetKind, 'audio');
  assert.equal(browser.asset('pdf-canvas')?.metadata.ownerId, 'canvas-1');
  assert.equal(browser.asset('audio-canvas')?.metadata.mimeType, 'audio/webm');
});

test('fresh browser edits round-trip to Electron without changing stable identities', async () => {
  const provider = new MemoryProvider(); const electron = richDevice(); const browser = new Device();
  await sync(provider, electron); await sync(provider, browser);
  browser.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'browser edit' } });
  browser.edit('pageDrawing', 'page-pdf_pdf_2', { pageId: 'page-pdf_pdf_2', data: { objects: [{ id: 'browser-ink', type: 'stroke' }] } });
  await sync(provider, browser); await sync(provider, electron);
  assert.match(new TextDecoder().decode(electron.entities.get('pageContent:page-1')!.bytes!), /browser edit/);
  assert.match(new TextDecoder().decode(electron.entities.get('pageDrawing:page-pdf_pdf_2')!.bytes!), /browser-ink/);
  assert.equal(electron.entities.get('pageDrawing:page-pdf_pdf_2')?.parentId, 'page-pdf');
  assert.equal((await sync(provider, electron)).status, 'synced');
});

test('stale incomplete browser absence cannot delete richer Electron entities', async () => {
  const provider = new MemoryProvider(); const electron = richDevice(); await sync(provider, electron);
  const browser = new Device(); browser.add('workspace', 'ws-A', null, { id: 'ws-A' });
  const result = await sync(provider, browser);
  assert.equal(result.status, 'synced');
  for (const id of electron.entities.keys()) assert.ok(browser.entities.has(id), `${id} survives and downloads`);
  assert.equal(provider.manifests.get('ws-A')!.records.length, electron.entities.size);
});

test('different-entity edits form a union while same-entity edits conflict', async () => {
  const provider = new MemoryProvider(); const a = richDevice(); await sync(provider, a);
  const b = new Device(); await sync(provider, b);
  a.edit('canvasScene', 'canvas-1', { elements: [{ id: 'from-a' }] });
  b.edit('pageContent', 'page-1', { text: 'from-b' });
  assert.equal((await sync(provider, a)).status, 'synced');
  assert.equal((await sync(provider, b)).status, 'synced');
  assert.equal((await sync(provider, a)).status, 'synced');
  assert.match(new TextDecoder().decode(a.entities.get('pageContent:page-1')!.bytes!), /from-b/);
  assert.match(new TextDecoder().decode(b.entities.get('canvasScene:canvas-1')!.bytes!), /from-a/);
  a.edit('pageContent', 'page-1', { text: 'offline-a' }); b.edit('pageContent', 'page-1', { text: 'offline-b' });
  await sync(provider, a);
  const conflict = await sync(provider, b);
  assert.equal(conflict.status, 'conflict');
  assert.match(new TextDecoder().decode(b.entities.get('pageContent:page-1')!.bytes!), /offline-b/);
});

test('only a tombstone with a shared base deletes; mere absence downloads or republishes', async () => {
  const provider = new MemoryProvider(); const a = richDevice(); await sync(provider, a);
  const b = new Device(); await sync(provider, b);
  const page = a.entities.get('notebookPage:page-1')!; page.bytes = null; page.tombstone = true; page.deletedAt = 2;
  assert.equal((await sync(provider, a)).status, 'synced');
  assert.equal((await sync(provider, b)).status, 'synced');
  assert.equal(b.entities.get('notebookPage:page-1')?.tombstone, true);

  b.entities.delete('pageContent:page-1');
  assert.equal((await sync(provider, b)).status, 'synced');
  assert.ok(b.entities.has('pageContent:page-1'), 'local absence is download, not deletion');
  provider.manifests.get('ws-A')!.records = provider.manifests.get('ws-A')!.records.filter(record => !(record.kind === 'canvasScene' && record.id === 'canvas-1'));
  assert.equal((await sync(provider, a)).status, 'synced');
  assert.ok(provider.manifests.get('ws-A')!.records.some(record => record.kind === 'canvasScene' && record.id === 'canvas-1'), 'remote absence is republished, not deletion');
});

test('idle sync is cheap, incomplete objects fail, and interrupted publication retries safely', async () => {
  const provider = new MemoryProvider(); const device = richDevice(); await sync(provider, device);
  const uploads = provider.uploads, writes = provider.manifestWrites, catalogs = provider.catalogWrites;
  assert.equal((await sync(provider, device)).status, 'synced');
  assert.equal(provider.uploads, uploads); assert.equal(provider.manifestWrites, writes); assert.equal(provider.catalogWrites, catalogs);

  const broken = new Device(); provider.objects.delete(provider.manifests.get('ws-A')!.records.find(record => record.kind === 'asset')!.hash!);
  assert.equal((await sync(provider, broken)).status, 'error');
  assert.equal(broken.baselines.loadWorkspace('ws-A').length, 0);

  const retryProvider = new MemoryProvider(); retryProvider.failCatalogOnce = true; const retryDevice = richDevice();
  assert.equal((await sync(retryProvider, retryDevice)).status, 'error');
  assert.equal(retryDevice.baselines.loadWorkspace('ws-A').length, 0, 'baseline never advances before catalog commit');
  assert.equal((await sync(retryProvider, retryDevice)).status, 'synced');
  assert.equal(retryProvider.manifestWrites, 1, 'retry reuses the already-published manifest');
  assert.deepEqual(retryProvider.catalog?.workspaces.map(item => item.workspaceId), ['ws-A'], 'retry repairs the missing catalog publication');
});

test('V2 blocks a different Google account without migration or remote mutation', async () => {
  const provider = new MemoryProvider(); const device = richDevice(); await sync(provider, device, 'account-A');
  const manifests = JSON.stringify([...provider.manifests]); const uploads = provider.uploads;
  const blocked = await sync(provider, device, 'account-B');
  assert.equal(blocked.status, 'blocked');
  assert.equal(JSON.stringify([...provider.manifests]), manifests); assert.equal(provider.uploads, uploads);
});

test('uploaded object hash is exact before manifest publication', async () => {
  const provider = new MemoryProvider(); const device = richDevice(); await sync(provider, device);
  for (const record of provider.manifests.get('ws-A')!.records.filter(record => !record.tombstone)) {
    assert.equal(await sha256Bytes(provider.objects.get(record.hash!)!), record.hash);
  }
});

test('BASE comparison is evaluated independently for no-op, upload, download, and conflict workspaces', async () => {
  const provider = new MemoryProvider();
  const local = new Device();
  for (const workspaceId of ['ws-noop', 'ws-upload', 'ws-download', 'ws-conflict']) {
    local.add('workspace', workspaceId, null, { id: workspaceId, value: 'base' }, workspaceId);
  }
  assert.equal((await sync(provider, local)).status, 'synced');

  const remoteDevice = new Device();
  assert.equal((await sync(provider, remoteDevice)).status, 'synced');
  remoteDevice.edit('workspace', 'ws-download', { id: 'ws-download', value: 'remote' });
  remoteDevice.edit('workspace', 'ws-conflict', { id: 'ws-conflict', value: 'remote' });
  assert.equal((await sync(provider, remoteDevice)).status, 'synced');

  local.edit('workspace', 'ws-upload', { id: 'ws-upload', value: 'local' });
  local.edit('workspace', 'ws-conflict', { id: 'ws-conflict', value: 'local' });
  const result = await sync(provider, local);

  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflicts, [{ workspaceId: 'ws-conflict', kind: 'workspace', id: 'ws-conflict' }]);
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-noop')?.classification, 'healthy');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-upload')?.status, 'synced');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-download')?.status, 'synced');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-conflict')?.classification, 'conflict');
  assert.equal(local.value('workspace', 'ws-noop').value, 'base');
  assert.equal(local.value('workspace', 'ws-upload').value, 'local');
  assert.equal(local.value('workspace', 'ws-download').value, 'remote');
  assert.equal(local.value('workspace', 'ws-conflict').value, 'local');
  assert.equal(remoteDevice.value('workspace', 'ws-conflict').value, 'remote');
  assert.ok(local.baselines.loadWorkspace('ws-noop').length > 0);
  assert.ok(local.baselines.loadWorkspace('ws-upload').length > 0);
  assert.ok(local.baselines.loadWorkspace('ws-download').length > 0);
});

test('five-workspace mixed run isolates upload, download, orphan, conflict, and no-op outcomes', async () => {
  const provider = new MemoryProvider();
  const seed = new Device();
  for (const workspaceId of ['ws-upload', 'ws-download', 'ws-orphan', 'ws-conflict', 'ws-noop']) {
    seed.add('workspace', workspaceId, null, { id: workspaceId, value: 'base' }, workspaceId);
  }
  assert.equal((await sync(provider, seed)).status, 'synced');

  const local = new Device();
  const remote = new Device();
  assert.equal((await sync(provider, local)).status, 'synced');
  assert.equal((await sync(provider, remote)).status, 'synced');

  remote.edit('workspace', 'ws-download', { id: 'ws-download', value: 'remote download' });
  remote.edit('workspace', 'ws-conflict', { id: 'ws-conflict', value: 'remote conflict' });
  assert.equal((await sync(provider, remote)).status, 'synced');

  local.edit('workspace', 'ws-upload', { id: 'ws-upload', value: 'local upload' });
  local.edit('workspace', 'ws-conflict', { id: 'ws-conflict', value: 'local conflict' });
  local.entities.delete('workspace:ws-orphan');
  const orphanManifest = provider.manifests.get('ws-orphan')!;
  provider.manifests.set('ws-orphan', { ...orphanManifest, records: orphanManifest.records.filter(record => record.kind !== 'workspace') });

  const result = await sync(provider, local);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflicts, [{ workspaceId: 'ws-conflict', kind: 'workspace', id: 'ws-conflict' }]);
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-upload')?.status, 'synced');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-download')?.status, 'synced');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-orphan')?.classification, 'orphaned');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-conflict')?.classification, 'conflict');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-noop')?.classification, 'healthy');
  assert.equal(local.value('workspace', 'ws-upload').value, 'local upload');
  assert.equal(local.value('workspace', 'ws-download').value, 'remote download');
  assert.equal(local.value('workspace', 'ws-conflict').value, 'local conflict');
  assert.equal(local.value('workspace', 'ws-noop').value, 'base');
  assert.ok(local.baselines.loadWorkspace('ws-upload').length > 0);
  assert.ok(local.baselines.loadWorkspace('ws-download').length > 0);
  assert.ok(local.baselines.loadWorkspace('ws-noop').length > 0);
});

test('all required objects are verified before a replacement manifest is published', async () => {
  const provider = new MemoryProvider(); const device = richDevice(); await sync(provider, device);
  const writes = provider.manifestWrites;
  const missing = provider.manifests.get('ws-A')!.records.find(record => record.kind === 'asset')!;
  provider.objects.delete(missing.hash!);
  device.entities.delete(`asset:${missing.id}`);
  device.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'new local edit' } });
  assert.equal((await sync(provider, device)).status, 'error');
  assert.equal(provider.manifestWrites, writes, 'manifest is not published while any referenced object is missing');
});

test('missing remote object reports the exact workspace entity', async () => {
  const provider = new MemoryProvider();
  const remote = richDevice();
  assert.equal((await sync(provider, remote)).status, 'synced');
  const target = provider.manifests.get('ws-A')!.records.find(record => record.kind === 'pageContent' && record.id === 'page-1')!;
  provider.objects.delete(target.hash!);
  const returning = new Device();
  const result = await sync(provider, returning);
  assert.equal(result.status, 'error');
  assert.equal(result.diagnostic?.stage, 'object-download');
  assert.equal(result.diagnostic?.reason, 'remote-object-missing');
  assert.equal(result.diagnostic?.workspaceId, 'ws-A');
  assert.equal(result.diagnostic?.entityKind, 'pageContent');
  assert.equal(result.diagnostic?.entityId, 'page-1');
  assert.equal(result.diagnostic?.retryable, false);
});

test('same-byte local replica repairs an incomplete remote object before declaring sync', async () => {
  const provider = new MemoryProvider();
  const device = richDevice();
  assert.equal((await sync(provider, device)).status, 'synced');
  device.source.canRepairMissingRemoteObjects = () => true;
  const target = provider.manifests.get('ws-A')!.records.find(record => record.kind === 'workspace')!;
  const bytes = provider.objects.get(target.hash!)!.slice();
  const manifestWrites = provider.manifestWrites;
  provider.objects.delete(target.hash!);
  const repaired = await sync(provider, device);
  assert.equal(repaired.status, 'synced');
  assert.equal(repaired.uploaded, 1);
  assert.deepEqual(provider.objects.get(target.hash!), bytes);
  assert.equal(provider.manifestWrites, manifestWrites, 'restoring exact immutable bytes does not rewrite manifest history');
});

test('returning browser restores an exact missing object without becoming cloud authority', async () => {
  const provider = new MemoryProvider();
  const desktop = richDevice();
  const browser = new Device();
  assert.equal((await sync(provider, desktop)).status, 'synced');
  assert.equal((await sync(provider, browser)).status, 'synced');
  const target = provider.manifests.get('ws-A')!.records.find(record => record.kind === 'pageContent' && record.id === 'page-1')!;
  const original = provider.objects.get(target.hash!)!.slice();
  provider.objects.delete(target.hash!);

  const repaired = await sync(provider, browser);
  assert.equal(repaired.status, 'synced');
  assert.equal(repaired.conflicts.length, 0);
  assert.deepEqual(provider.objects.get(target.hash!), original);
  assert.equal(provider.manifests.get('ws-A')!.records.find(record => record.kind === 'pageContent' && record.id === 'page-1')!.hash, target.hash);
});

test('durable desktop repairs a missing remote pointer from its newer local entity and completes sync', async () => {
  const provider = new MemoryProvider();
  const desktop = richDevice();
  assert.equal((await sync(provider, desktop)).status, 'synced');
  const returningBrowser = new Device();
  assert.equal((await sync(provider, returningBrowser)).status, 'synced');
  const manifestBefore = provider.manifests.get('ws-A')!;
  const target = manifestBefore.records.find(record => record.kind === 'notebook' && record.id === 'nb-1')!;
  const brokenHash = target.hash!;
  provider.objects.delete(brokenHash);
  desktop.edit('notebook', 'nb-1', { id: 'nb-1', name: 'complete durable desktop copy' });
  desktop.source.canRepairMissingRemoteObjects = () => true;

  const repaired = await sync(provider, desktop);
  assert.equal(repaired.status, 'synced');
  assert.deepEqual(repaired.conflicts, []);
  assert.equal(repaired.uploaded, 1);
  const expectedHash = await sha256Bytes(desktop.entities.get('notebook:nb-1')!.bytes!);
  const repairedRecord = provider.manifests.get('ws-A')!.records.find(record => record.kind === 'notebook' && record.id === 'nb-1')!;
  assert.equal(repairedRecord.hash, expectedHash);
  assert.equal(repairedRecord.baseHash, expectedHash);
  assert.ok(provider.objects.has(expectedHash));
  assert.equal(provider.objects.has(brokenHash), false, 'repair does not fabricate or delete the unavailable historical object');

  const downloaded = await sync(provider, returningBrowser);
  assert.equal(downloaded.status, 'synced');
  assert.ok(downloaded.downloaded > 0, 'the stale browser receives the repaired cloud entity');
  assert.equal(returningBrowser.value('notebook', 'nb-1').name, 'complete durable desktop copy');

  const freshDevice = new Device();
  assert.equal((await sync(provider, freshDevice)).status, 'synced');
  assert.equal(freshDevice.value('notebook', 'nb-1').name, 'complete durable desktop copy');
});

test('durable repair still refuses a missing remote object when no local entity can reconstruct it', async () => {
  const provider = new MemoryProvider();
  const desktop = richDevice();
  assert.equal((await sync(provider, desktop)).status, 'synced');
  const target = provider.manifests.get('ws-A')!.records.find(record => record.kind === 'notebook' && record.id === 'nb-1')!;
  provider.objects.delete(target.hash!);
  desktop.entities.delete('notebook:nb-1');
  desktop.source.canRepairMissingRemoteObjects = () => true;
  const manifestWrites = provider.manifestWrites;

  const result = await sync(provider, desktop);
  assert.equal(result.status, 'error');
  assert.equal(result.diagnostic?.stage, 'object-download');
  assert.equal(result.diagnostic?.reason, 'remote-object-missing');
  assert.equal(result.diagnostic?.entityKind, 'notebook');
  assert.equal(result.diagnostic?.entityId, 'nb-1');
  assert.equal(provider.manifestWrites, manifestWrites);
});

test('missing remote workspace root is repaired from the canonical local root before children', async () => {
  const provider = new MemoryProvider();
  const desktop = richDevice();
  const browser = new Device();
  assert.equal((await sync(provider, desktop)).status, 'synced');
  assert.equal((await sync(provider, browser)).status, 'synced');

  // Reproduce the live incomplete-commit shape: the manifest still contains
  // the complete child graph, but its workspace root pointer and immutable
  // object were lost before finalization. The returning browser still has the
  // canonical local root and a trustworthy BASE for every entity.
  const manifest = provider.manifests.get('ws-A')!;
  const root = manifest.records.find(record => record.kind === 'workspace')!;
  manifest.records = manifest.records.filter(record => record.kind !== 'workspace');
  provider.objects.delete(root.hash!);
  desktop.edit('pageContent', 'page-1', { pageId: 'page-1', data: { text: 'new desktop content' } });
  provider.putOrder = [];
  assert.equal((await sync(provider, desktop)).status, 'synced');
  assert.equal(provider.putOrder[0], root.hash, 'the repaired workspace root is uploaded before child objects');
  // The desktop run itself repairs the root before publishing its child edit;
  // remove the root pointer again to model the returning-device observation.
  provider.manifests.get('ws-A')!.records = provider.manifests.get('ws-A')!.records.filter(record => record.kind !== 'workspace');
  provider.objects.delete(root.hash!);

  const repaired = await sync(provider, browser);
  assert.equal(repaired.status, 'synced');
  assert.deepEqual(repaired.conflicts, []);
  assert.equal(browser.value('pageContent', 'page-1').data.text, 'new desktop content');
  const repairedManifest = provider.manifests.get('ws-A')!;
  assert.equal(repairedManifest.records.filter(record => record.kind === 'workspace').length, 1);
  assert.ok(provider.objects.has(repairedManifest.records.find(record => record.kind === 'workspace')!.hash!));

  const uploads = provider.uploads;
  const writes = provider.manifestWrites;
  const retry = await sync(provider, browser);
  assert.equal(retry.status, 'synced');
  assert.equal(retry.uploaded + retry.downloaded, 0);
  assert.equal(provider.uploads, uploads);
  assert.equal(provider.manifestWrites, writes);
});

test('missing remote root without a canonical local or recovery root is quarantined without blocking the account', async () => {
  const provider = new MemoryProvider();
  const desktop = richDevice();
  assert.equal((await sync(provider, desktop)).status, 'synced');
  const manifest = provider.manifests.get('ws-A')!;
  manifest.records = manifest.records.filter(record => record.kind !== 'workspace');

  const childOnly = new Device();
  childOnly.add('notebook', 'nb-local', 'ws-A', { id: 'nb-local', workspaceId: 'ws-A' }, 'ws-A');
  const result = await sync(provider, childOnly);
  assert.equal(result.status, 'synced-review');
  assert.equal(result.diagnostic?.reason, 'remote-workspace-root-missing');
  assert.equal(result.diagnostic?.workspaceId, 'ws-A');
  assert.equal(result.diagnostic?.entityKind, 'workspace');
  assert.deepEqual(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-A')?.classification, 'orphaned');
  assert.equal(provider.manifestWrites, 1, 'quarantine never publishes a guessed root');
});

test('missing remote root with an ambiguous child graph is quarantined without guessing identity', async () => {
  const provider = new MemoryProvider();
  const desktop = richDevice();
  assert.equal((await sync(provider, desktop)).status, 'synced');
  const manifest = provider.manifests.get('ws-A')!;
  const folder = manifest.records.find(record => record.kind === 'folder')!;
  const notebook = manifest.records.find(record => record.kind === 'notebook')!;
  manifest.records = manifest.records
    .filter(record => record.kind !== 'workspace')
    .concat([
      { ...folder, id: 'ambiguous-parent', parentId: 'ws-A' },
      { ...notebook, id: 'ambiguous-parent', parentId: 'ws-A' },
      { ...notebook, id: 'ambiguous-child', parentId: 'ambiguous-parent' },
    ]);

  const result = await sync(provider, desktop);
  assert.equal(result.status, 'synced-review');
  assert.equal(result.diagnostic?.reason, 'remote-workspace-root-ambiguous');
  assert.equal(result.diagnostic?.workspaceId, 'ws-A');
  assert.equal(result.diagnostic?.entityKind, 'workspace');
  assert.equal(provider.manifestWrites, 1, 'ambiguous recovery does not publish a guessed root');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-A')?.classification, 'ambiguous');
});

test('a trusted exact-ID recovery root repairs an incomplete manifest before children', async () => {
  const provider = new MemoryProvider();
  const owner = richDevice();
  assert.equal((await sync(provider, owner)).status, 'synced');
  const manifest = provider.manifests.get('ws-A')!;
  const root = manifest.records.find(record => record.kind === 'workspace')!;
  manifest.records = manifest.records.filter(record => record.kind !== 'workspace');
  provider.objects.delete(root.hash!);

  const returning = new Device();
  const recovered = owner.entities.get('workspace:ws-A')!;
  // Electron recovery metadata may carry a historical Panvas userId while no
  // optional Panvas session is present on the returning device. The bridge
  // has already validated the exact workspace ID and bounded root shape, so
  // this artifact is deliberately marked foreign-recovery to exercise that
  // narrow trusted-root exception (ordinary stale rows must still conflict).
  returning.source.getRecoveryWorkspaceRoot = async workspaceId => workspaceId === 'ws-A' ? { ...recovered, bytes: recovered.bytes?.slice() ?? null, ownership: 'foreign-recovery' } : null;
  provider.putOrder = [];
  const result = await sync(provider, returning);
  assert.equal(result.status, 'synced', JSON.stringify(result));
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-A')?.classification, 'repairable');
  assert.equal(provider.putOrder[0], root.hash, 'recovery root is uploaded before descendants');
  assert.ok(returning.entities.has('workspace:ws-A'));
  assert.equal(returning.value('pageContent', 'page-1').data.text, 'important');
  assert.ok(provider.manifests.get('ws-A')!.records.some(record => record.kind === 'workspace'));
});

test('an orphaned workspace does not block a healthy workspace in the same account', async () => {
  const provider = new MemoryProvider();
  const seed = richDevice();
  assert.equal((await sync(provider, seed)).status, 'synced');
  const healthy = new Device();
  healthy.add('workspace', 'ws-healthy', null, { id: 'ws-healthy', name: 'Healthy' }, 'ws-healthy');
  assert.equal((await sync(provider, healthy)).status, 'synced');
  provider.manifests.get('ws-A')!.records = provider.manifests.get('ws-A')!.records.filter(record => record.kind !== 'workspace');

  const returning = new Device();
  const result = await sync(provider, returning);
  assert.equal(result.status, 'synced-review');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-A')?.classification, 'orphaned');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-healthy')?.status, 'synced');
  assert.ok(returning.entities.has('workspace:ws-healthy'), 'healthy workspace continues after orphan');
  assert.equal(returning.baselines.loadWorkspace('ws-healthy').length > 0, true);
});

test('catalog self-healing quarantines a missing manifest and retains it while other workspaces sync', async () => {
  const provider = new MemoryProvider();
  const seed = richDevice();
  assert.equal((await sync(provider, seed)).status, 'synced');
  const healthy = new Device();
  healthy.add('workspace', 'ws-healthy', null, { id: 'ws-healthy', name: 'Healthy' }, 'ws-healthy');
  assert.equal((await sync(provider, healthy)).status, 'synced');
  provider.manifests.delete('ws-A');
  const catalogBefore = provider.catalog!.workspaces.map(item => item.workspaceId).sort();
  const returning = new Device();
  const result = await sync(provider, returning);
  assert.equal(result.status, 'synced-review');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-A')?.classification, 'orphaned');
  assert.equal(result.workspaceOutcomes.find(item => item.workspaceId === 'ws-healthy')?.status, 'synced');
  assert.deepEqual(provider.catalog!.workspaces.map(item => item.workspaceId).sort(), catalogBefore, 'catalog entry is preserved for explicit recovery');
  assert.ok(returning.entities.has('workspace:ws-healthy'));
});

test('interrupted root/child upload, manifest finalization, and baseline commit all resume safely', async () => {
  const prepare = async (provider: InterruptibleProvider, extraCount = 4) => {
    const device = richDevice();
    assert.equal((await sync(provider, device)).status, 'synced');
    const root = provider.manifests.get('ws-A')!.records.find(record => record.kind === 'workspace')!;
    provider.manifests.get('ws-A')!.records = provider.manifests.get('ws-A')!.records.filter(record => record.kind !== 'workspace');
    provider.objects.delete(root.hash!);
    for (let index = 0; index < extraCount; index += 1) {
      const id = `nb-repair-${index}`;
      device.add('notebook', id, 'ws-A', { id, workspaceId: 'ws-A', name: id });
    }
    provider.uploadCalls = 0;
    return { device, root };
  };

  for (const [label, failAt] of [['before root upload', 1], ['immediately after root', 2], ['halfway through children', 3] ] as const) {
    const provider = new InterruptibleProvider();
    const { device } = await prepare(provider);
    provider.failUploadAt = failAt;
    const interrupted = await sync(provider, device);
    assert.equal(interrupted.status, 'error', label);
    assert.equal(provider.manifests.get('ws-A')!.records.some(record => record.kind === 'workspace'), false, `${label}: manifest stays incomplete`);
    assert.equal((await sync(provider, device)).status, 'synced', `${label}: retry completes`);
    assert.equal(provider.manifests.get('ws-A')!.records.filter(record => record.kind === 'workspace').length, 1);
  }

  {
    const provider = new InterruptibleProvider();
    const { device } = await prepare(provider, 1);
    provider.failManifestOnce = true;
    assert.equal((await sync(provider, device)).status, 'error', 'manifest finalization interruption');
    assert.equal(provider.manifests.get('ws-A')!.records.some(record => record.kind === 'workspace'), false);
    assert.equal((await sync(provider, device)).status, 'synced');
  }

  {
    const provider = new InterruptibleProvider();
    const { device } = await prepare(provider, 1);
    // Seed the baseline in the same device profile, then recreate the
    // incomplete publication with that baseline still available.
    assert.equal((await sync(provider, device)).status, 'synced');
    const retryBaselines = new InterruptibleBaselines();
    retryBaselines.profile = device.baselines.profile;
    retryBaselines.workspaces = new Map(device.baselines.workspaces);
    const root = provider.manifests.get('ws-A')!.records.find(record => record.kind === 'workspace')!;
    provider.manifests.get('ws-A')!.records = provider.manifests.get('ws-A')!.records.filter(record => record.kind !== 'workspace');
    provider.objects.delete(root.hash!);
    device.add('notebook', 'nb-baseline-retry', 'ws-A', { id: 'nb-baseline-retry', workspaceId: 'ws-A' });
    retryBaselines.failWorkspaceSaveOnce = true;
    const interrupted = await runCloudSyncV2({ accountIdentifier: 'account-A', provider, source: device.source, adapter: device.adapter, baselines: retryBaselines, conflictStore: device.conflicts });
    assert.equal(interrupted.status, 'error', 'baseline commit interruption');
    assert.equal(provider.manifests.get('ws-A')!.records.some(record => record.kind === 'workspace'), true, 'manifest is valid before baseline commit');
    assert.equal((await runCloudSyncV2({ accountIdentifier: 'account-A', provider, source: device.source, adapter: device.adapter, baselines: retryBaselines, conflictStore: device.conflicts })).status, 'synced');
  }
});

test('durable desktop repairs multiple missing objects across a ten-workspace interrupted sync', async () => {
  const provider = new MemoryProvider();
  const desktop = new Device();
  for (let index = 1; index <= 10; index += 1) {
    const suffix = String(index).padStart(2, '0');
    const workspaceId = `ws-${suffix}`;
    desktop.add('workspace', workspaceId, null, { id: workspaceId, name: `Workspace ${suffix}` }, workspaceId);
    desktop.add('notebook', `nb-${suffix}`, workspaceId, { id: `nb-${suffix}`, name: `Notebook ${suffix}` }, workspaceId);
  }
  assert.equal((await sync(provider, desktop)).status, 'synced');

  for (const suffix of ['04', '08']) {
    const workspaceId = `ws-${suffix}`;
    const record = provider.manifests.get(workspaceId)!.records.find(item => item.kind === 'notebook')!;
    provider.objects.delete(record.hash!);
    desktop.edit('notebook', `nb-${suffix}`, { id: `nb-${suffix}`, name: `Recovered ${suffix}`, pages: ['complete'] });
  }
  desktop.source.canRepairMissingRemoteObjects = () => true;

  const result = await sync(provider, desktop);
  assert.equal(result.status, 'synced');
  assert.equal(result.uploaded, 2);
  assert.deepEqual(result.conflicts, []);
  assert.equal(provider.catalog?.workspaces.length, 10);

  const freshDevice = new Device();
  assert.equal((await sync(provider, freshDevice)).status, 'synced');
  assert.equal(freshDevice.value('notebook', 'nb-04').name, 'Recovered 04');
  assert.equal(freshDevice.value('notebook', 'nb-08').name, 'Recovered 08');
});

test('no-baseline data waits for a choice, then cloud selection preserves recovery and stays idempotent', async () => {
  const provider = new MemoryProvider();
  const remote = new Device(); remote.add('workspace', 'ws-old', null, { id: 'ws-old', name: 'remote canonical' }, 'ws-old');
  assert.equal((await sync(provider, remote)).status, 'synced');

  const stale = new Device(); stale.add('workspace', 'ws-old', null, { id: 'ws-old', name: 'preserve me' }, 'ws-old');
  const first = await sync(provider, stale);
  assert.equal(first.status, 'conflict');
  assert.equal(first.downloaded + first.uploaded, 0);
  assert.equal(stale.value('workspace', 'ws-old').name, 'preserve me');
  assert.equal(stale.baselines.loadWorkspace('ws-old').length, 0);
  const chosen = await runCloudSyncV2({ accountIdentifier: 'account-A', provider, source: stale.source, adapter: stale.adapter, baselines: stale.baselines, conflictStore: stale.conflicts, resolutions: [{ workspaceId: 'ws-old', kind: 'workspace', id: 'ws-old', choice: 'cloud' }] });
  assert.equal(chosen.status, 'synced');
  assert.equal(stale.conflicts.rows.size, 1);
  assert.equal(stale.value('workspace', 'ws-old').name, 'remote canonical');
  assert.equal(stale.baselines.loadWorkspace('ws-old').length, 1);

  const second = await sync(provider, stale);
  assert.equal(second.status, 'synced', 'recovery is retained without asking again');
  assert.equal(second.preservedConflicts, 0);
  assert.equal(second.uploaded, 0); assert.equal(second.downloaded, 0);
  assert.equal(stale.conflicts.rows.size, 1, 'the preservation record is idempotent');
});

test('old browser with full localStorage commits V2 baselines durably and finishes in review', async () => {
  const primary = {
    getItem: (_key: string) => null,
    setItem: (_key: string, _value: string) => { throw new DOMException('Storage quota exceeded.', 'QuotaExceededError'); },
  };
  const durableValues = new Map<string, string>();
  const durable = {
    getItem: async (key: string) => durableValues.get(key) ?? null,
    setItem: async (key: string, value: string) => { durableValues.set(key, value); },
  };
  const baselines = new LocalStorageSyncV2BaselineStore(primary, durable);
  const provider = new MemoryProvider();
  const remote = new Device();
  remote.add('workspace', 'ws-old-browser', null, { id: 'ws-old-browser', name: 'remote canonical' }, 'ws-old-browser');
  remote.add('notebookPage', 'page-old-browser', 'section-old-browser', { id: 'page-old-browser' }, 'ws-old-browser');
  await sync(provider, remote);

  const oldBrowser = new Device();
  oldBrowser.add('workspace', 'ws-old-browser', null, { id: 'ws-old-browser', name: 'preserved local divergence' }, 'ws-old-browser');
  const run = (choose = false) => runCloudSyncV2({ accountIdentifier: 'account-A', provider, source: oldBrowser.source, adapter: oldBrowser.adapter, baselines, conflictStore: oldBrowser.conflicts, resolutions: choose ? [{ workspaceId: 'ws-old-browser', kind: 'workspace', id: 'ws-old-browser', choice: 'cloud' }] : undefined });
  assert.equal((await run()).status, 'conflict');
  const first = await run(true);
  assert.equal(first.status, 'synced');
  assert.equal(first.downloaded, 2, 'remote records still reconstruct');
  assert.equal((await baselines.loadWorkspace('ws-old-browser')).length, 2, 'baseline commits outside full localStorage');
  assert.equal(oldBrowser.conflicts.rows.size, 2, 'the complete resolution graph is archived');

  const second = await run();
  assert.equal(second.status, 'synced');
  assert.equal(second.downloaded, 0);
  assert.equal(second.preservedConflicts, 0);
  assert.equal(oldBrowser.conflicts.rows.size, 2, 'second sync does not recreate the recovery records');

  const storeSource = readFileSync(new URL('../src/stores/cloudSyncStore.ts', import.meta.url), 'utf8');
  assert.match(storeSource, /finalStatus === 'synced' \|\| finalStatus === 'synced-review'\) \? Date\.now\(\) : null/);
  assert.match(storeSource, /finalStatus === 'synced-review' \? publicCloudMessage\('review'\)/);
});

test('no-baseline local-only and remote-only entities wait for a workspace choice', async () => {
  const provider = new MemoryProvider();
  const remote = new Device();
  remote.add('workspace', 'ws-union', null, { id: 'ws-union' }, 'ws-union');
  remote.add('folder', 'remote-folder', 'ws-union', { id: 'remote-folder' }, 'ws-union');
  await sync(provider, remote);

  const old = new Device();
  old.add('workspace', 'ws-union', null, { id: 'ws-union' }, 'ws-union');
  old.add('notebook', 'local-notebook', 'ws-union', { id: 'local-notebook' }, 'ws-union');
  const result = await sync(provider, old);
  assert.equal(result.status, 'conflict');
  assert.equal(result.downloaded + result.uploaded, 0);
  assert.equal(old.entities.has('folder:remote-folder'), false);
  assert.equal(provider.manifests.get('ws-union')!.records.some(record => record.kind === 'notebook' && record.id === 'local-notebook'), false);
});

test('remote V2 data without an account profile is ambiguous and cannot be adopted', async () => {
  const provider = new MemoryProvider();
  provider.catalog = { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 1, workspaces: [{ workspaceId: 'ws-private', manifestRevision: 1 }] };
  const device = new Device();
  const result = await sync(provider, device);
  assert.equal(result.status, 'blocked');
  assert.equal(provider.profile, null);
  assert.equal(provider.uploads, 0);
});

test('Auto Sync requests coalesce into one serial pending rerun', async () => {
  const runner = new SinglePendingRunner();
  let runs = 0, active = 0, maxActive = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = runner.request(async () => {
    runs += 1; active += 1; maxActive = Math.max(maxActive, active);
    if (runs === 1) await gate;
    active -= 1;
  });
  const second = runner.request(async () => { throw new Error('the active callback owns the coalesced rerun'); });
  const third = runner.request(async () => { throw new Error('only one pending rerun is retained'); });
  assert.equal(runner.hasPending, true);
  release();
  await Promise.all([first, second, third]);
  assert.equal(runs, 2);
  assert.equal(maxActive, 1);
  assert.equal(runner.hasPending, false);
});

test('browser V2 reads one Dexie snapshot for all workspaces in a cycle', async () => {
  let reads = 0;
  const snapshot = {
    workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }], folders: [], notebooks: [], sections: [], pages: [], contents: [], drawings: [], canvases: [], scenes: [], blocks: [], pdfs: [], media: [],
  } as unknown as BrowserSyncSnapshot;
  const source = new LocalSyncPayloadSource(async () => { reads += 1; return snapshot; });
  source.beginCycle();
  assert.deepEqual(await source.listWorkspaceIds(), ['ws-1', 'ws-2']);
  await source.scanWorkspace('ws-1'); await source.scanWorkspace('ws-2');
  source.endCycle();
  assert.equal(reads, 1);
});

test('browser ownership stamps do not create a false cross-device conflict', async () => {
  const provider = new MemoryProvider();
  const electron = new Device();
  // Electron's V2 source carries a null ownership stamp; the browser later
  // replaces it locally with the authenticated browser user.
  electron.add('workspace', 'ws-ownership', null, { id: 'ws-ownership', name: 'Shared workspace', userId: null }, 'ws-ownership');
  assert.equal((await sync(provider, electron)).status, 'synced');

  const snapshot = {
    workspaces: [{ id: 'ws-ownership', name: 'Shared workspace', userId: 'browser-user' }],
    folders: [], notebooks: [], sections: [], pages: [], contents: [], drawings: [], canvases: [], scenes: [], blocks: [], pdfs: [], media: [],
  } as unknown as BrowserSyncSnapshot;
  setCurrentBrowserUserIdReader(() => 'browser-user');
  try {
    const source = new LocalSyncPayloadSource(async () => snapshot);
    const browserBaselines = new MemoryBaselines();
    const browserConflicts = new MemoryConflicts();
    const first = await runCloudSyncV2({
      accountIdentifier: 'account-A', provider, source,
      adapter: { applyRecord: async () => {} },
      baselines: browserBaselines, conflictStore: browserConflicts,
    });
    assert.equal(first.status, 'synced');
    assert.equal(first.conflicts.length, 0);
    const second = await runCloudSyncV2({
      accountIdentifier: 'account-A', provider, source,
      adapter: { applyRecord: async () => {} },
      baselines: browserBaselines, conflictStore: browserConflicts,
    });
    assert.equal(second.status, 'synced');
    assert.equal(second.conflicts.length, 0);
    assert.equal(second.uploaded, 0);
    assert.equal(second.downloaded, 0);
  } finally {
    setCurrentBrowserUserIdReader(() => null);
  }
});

test('V2 download completion refreshes the active workspace projection', () => {
  const store = readFileSync(new URL('../src/stores/cloudSyncStore.ts', import.meta.url), 'utf8');
  assert.match(store, /refreshWorkspaceProjectionAfterSync/);
  assert.match(store, /await store\.loadWorkspaces\(\)/);
  assert.match(store, /loadWorkspaceContents\(activeWorkspaceId\)/);
  assert.match(store, /if \(v2\.downloaded > 0\) \{\s*await refreshWorkspaceProjectionAfterSync\(\);/);
});

test('V2 public errors do not expose workspace IDs or provider details', async () => {
  const provider = new MemoryProvider();
  provider.profile = { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: 'profile-safe', accountIdentifier: 'account-A' };
  provider.catalog = { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 1, workspaces: [{ workspaceId: 'secret-workspace-id', manifestRevision: 1 }] };
  const result = await sync(provider, new Device());
  assert.equal(result.status, 'error');
  assert.doesNotMatch(result.error ?? '', /secret-workspace-id|catalog-manifest-unavailable|read-manifest/);
  const store = readFileSync(new URL('../src/stores/cloudSyncStore.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(store, /lastError:\s*v2\.error/);
});

test('virtual PDF identities parse once and V2 routing returns before the V1 state machine', () => {
  assert.deepEqual(parsePdfAnnotationStorageId('page-with_pdf_marker_pdf_12'), { ownerPageId: 'page-with_pdf_marker', sourcePage: 12 });
  assert.equal(parsePdfAnnotationStorageId('page-1_pdf_0'), null);
  const store = readFileSync(new URL('../src/stores/cloudSyncStore.ts', import.meta.url), 'utf8');
  const start = store.indexOf('if (CLOUD_SYNC_V2_ENABLED) {', store.indexOf('triggerSync: async workspaceId =>'));
  const end = store.indexOf('let diagnosticWorkspaceId', start);
  const v2Branch = store.slice(start, end);
  assert.match(v2Branch, /runCloudSyncV2/);
  assert.match(v2Branch, /return;/);
  assert.doesNotMatch(v2Branch, /runSyncCycle|reconcileWorkspaceBindings|loadSyncJournalStore/);
  const localChanges = readFileSync(new URL('../src/services/cloudsync/recordLocalChange.ts', import.meta.url), 'utf8');
  assert.ok(localChanges.indexOf("VITE_PANVAS_SYNC_V2 === 'true'") < localChanges.indexOf('appendJournalEntry({'), 'V2 exits before the V1 journal append');
});
