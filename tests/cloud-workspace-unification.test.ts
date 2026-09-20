import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { CloudSyncProvider, ObjectUpload, ProviderConnectionInfo, RecordPointer, RemoteManifestRead, RemoteWorkspaceSummary, SyncJournalEntry, SyncManifestV1 } from '../src/services/cloudsync/types.ts';
import { finalizeAccountSync, ProviderConflictError, runSyncCycle, type ScannedSyncEntity, type SyncJournalStore, type SyncPayloadSource } from '../src/services/cloudsync/engine.ts';
import { createJournalEntry, recoverRetryMetadata } from '../src/services/cloudsync/journal.ts';
import { attachWorkspaceReplica, replicateMissingRemoteWorkspaces } from '../src/services/cloudsync/workspaceReplica.ts';
import type { RemoteRecordLocalAdapter } from '../src/services/cloudsync/applyRemoteChanges.ts';
import { applyRemoteChanges } from '../src/services/cloudsync/applyRemoteChanges.ts';
import { accountMigrationWorkspaceIds, attachedWorkspaceIds, loadWorkspaceBindings, moveWorkspaceBinding, reconcileWorkspaceBindings, saveWorkspaceBinding, workspaceHasBinding, workspaceIsBoundToOtherAccount, type BindingStorage } from '../src/services/cloudsync/workspaceBindings.ts';
import { migrateWorkspaceToGoogleAccount } from '../src/services/cloudsync/accountMigration.ts';
import { CloudOperationError, presentCloudError } from '../src/services/cloudsync/errors.ts';

class MemoryJournal implements SyncJournalStore {
  entries: SyncJournalEntry[] = [];
  async listPending(workspaceId: string, now: number) { return this.entries.filter(item => item.workspaceId === workspaceId && (item.state === 'pending' || item.state === 'syncing') && (item.nextAttemptAt === null || item.nextAttemptAt <= now)); }
  async upsert(entry: SyncJournalEntry) { const index = this.entries.findIndex(item => item.entryId === entry.entryId); if (index >= 0) this.entries[index] = entry; else this.entries.push(entry); }
  async latestByEntity(workspaceId: string) { const result = new Map<string, SyncJournalEntry>(); for (const item of this.entries.filter(value => value.workspaceId === workspaceId && value.state !== 'superseded')) { const key = `${item.entityType}:${item.entityId}`; const old = result.get(key); if (!old || old.localRevision < item.localRevision) result.set(key, item); } return result; }
  async listUnresolved(workspaceId: string) { return this.entries.filter(item => item.workspaceId === workspaceId && ['pending', 'syncing', 'conflict', 'error'].includes(item.state)); }
}

class SingleWorkspaceProvider implements CloudSyncProvider {
  readonly id = 'googledrive' as const; readonly supportsResumableUpload = true;
  manifest: SyncManifestV1 | null = null; etag: string | null = null; objects = new Map<string, Uint8Array>(); manifestWrites = 0;
  async connect(): Promise<ProviderConnectionInfo> { return { provider: 'googledrive', accountIdentifier: 'account-1', connectedAt: 1 }; }
  async disconnect() {} async getAccountInfo() { return null; } async ensureAppRoot() { return 'root'; }
  async readManifest(): Promise<RemoteManifestRead> { return { manifest: this.manifest, etag: this.etag }; }
  async writeManifest(_workspaceId: string, manifest: SyncManifestV1, ifMatch: string | null) { if (ifMatch !== this.etag) throw new ProviderConflictError(); this.manifest = manifest; this.etag = `etag-${manifest.revision}`; this.manifestWrites += 1; return { etag: this.etag }; }
  async getObject(_workspaceId: string, hash: string) { const bytes = this.objects.get(hash); if (!bytes) throw new Error('missing object'); return bytes; }
  async putObjectIfAbsent(_workspaceId: string, upload: ObjectUpload) { if (this.objects.has(upload.hash)) return 'present' as const; this.objects.set(upload.hash, upload.bytes); return 'uploaded' as const; }
  async deleteObject() {} async moveObject() {} async getMetadata(_workspaceId: string, hash: string) { return this.objects.has(hash) ? { size: this.objects.get(hash)!.length } : null; }
}

class MultiWorkspaceProvider implements CloudSyncProvider {
  readonly id = 'googledrive' as const; readonly supportsResumableUpload = true;
  readonly manifests = new Map<string, SyncManifestV1>();
  readonly etags = new Map<string, string>();
  readonly objects = new Map<string, Uint8Array>();
  manifestWrites = 0;
  async connect(): Promise<ProviderConnectionInfo> { return { provider: 'googledrive', accountIdentifier: 'account-1', connectedAt: 1 }; }
  async disconnect() {} async getAccountInfo() { return null; } async ensureAppRoot() { return 'root'; }
  async listRemoteWorkspaces(): Promise<RemoteWorkspaceSummary[]> { return [...this.manifests.keys()].map(workspaceId => ({ workspaceId, name: workspaceId, revision: 0, generatedAt: '', recordCount: 0 })); }
  async readManifest(workspaceId: string): Promise<RemoteManifestRead> { return { manifest: this.manifests.get(workspaceId) ?? null, etag: this.etags.get(workspaceId) ?? null }; }
  async writeManifest(workspaceId: string, manifest: SyncManifestV1) { this.manifests.set(workspaceId, manifest); const etag = `etag-${workspaceId}-${manifest.revision}`; this.etags.set(workspaceId, etag); this.manifestWrites += 1; return { etag }; }
  async getObject(_workspaceId: string, hash: string) { const bytes = this.objects.get(hash); if (!bytes) throw new Error('missing object'); return bytes; }
  async putObjectIfAbsent(_workspaceId: string, upload: ObjectUpload) { if (this.objects.has(upload.hash)) return 'present' as const; this.objects.set(upload.hash, upload.bytes); return 'uploaded' as const; }
  async deleteObject() {} async moveObject() {} async getMetadata(_workspaceId: string, hash: string) { return this.objects.has(hash) ? { size: this.objects.get(hash)!.length } : null; }
  seed(workspaceId: string, hashDigit: string) {
    const hash = hashDigit.repeat(64);
    this.objects.set(hash, encode({ id: workspaceId, name: workspaceId }));
    this.manifests.set(workspaceId, {
      format: 'panvas-sync', schemaVersion: 1, workspaceId, revision: 1, previousRevision: null,
      writerDeviceId: 'electron', generatedAt: '2026-08-30T00:00:00.000Z',
      records: [{ kind: 'workspace', id: workspaceId, parentId: null, revision: 1, baseRevision: null, contentHash: hash, tombstone: false }],
    });
    this.etags.set(workspaceId, `etag-${workspaceId}-1`);
  }
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const key = (value: { entityType: string; entityId: string }) => `${value.entityType}:${value.entityId}`;

class MemoryDevice {
  readonly journal = new MemoryJournal();
  readonly entities = new Map<string, ScannedSyncEntity>();
  applyCount = 0;
  readonly source: SyncPayloadSource = {
    scanWorkspace: async workspaceId => [...this.entities.values()].filter(item => item.workspaceId === workspaceId),
    loadPayload: async entry => this.entities.get(key(entry))?.bytes ?? null,
    parentOf: async entry => this.entities.get(key(entry))?.parentId ?? null,
  };
  readonly adapter: RemoteRecordLocalAdapter = {
    applyRecord: async ({ workspaceId, pointer, bytes }) => {
      this.applyCount += 1;
      this.entities.set(`${pointer.kind}:${pointer.id}`, { entityType: pointer.kind, entityId: pointer.id, workspaceId, parentId: pointer.parentId, bytes, tombstone: pointer.tombstone, deletedAt: pointer.tombstone ? 1 : null });
    },
  };
  add(entityType: ScannedSyncEntity['entityType'], entityId: string, parentId: string | null, payload: unknown) {
    this.entities.set(`${entityType}:${entityId}`, { entityType, entityId, workspaceId: 'ws-A', parentId, bytes: encode(payload), tombstone: false, deletedAt: null });
  }
  async editPage(text: string, now: number, entryId: string) {
    const entity = this.entities.get('pageContent:page-X')!; entity.bytes = encode({ pageId: 'page-X', text });
    const latest = (await this.journal.latestByEntity('ws-A')).get('pageContent:page-X');
    await this.journal.upsert(createJournalEntry({ entityType: 'pageContent', entityId: 'page-X', workspaceId: 'ws-A', operation: 'update', currentLocalRevision: latest?.localRevision ?? 0, contentHash: 'stale', baseRevision: latest?.localRevision ?? null, payloadRef: 'page-X', now, entryId }));
  }
}

function seedDeviceA(): MemoryDevice {
  const device = new MemoryDevice();
  device.add('workspace', 'ws-A', null, { id: 'ws-A', name: 'Research' });
  device.add('folder', 'folder-1', 'ws-A', { id: 'folder-1', workspaceId: 'ws-A', name: 'Folder' });
  device.add('notebook', 'nb-4', 'folder-1', { id: 'nb-4', workspaceId: 'ws-A', folderId: 'folder-1' });
  device.add('notebookSection', 'sec-8', 'nb-4', { id: 'sec-8', notebookId: 'nb-4' });
  device.add('notebookPage', 'page-X', 'sec-8', { id: 'page-X', notebookId: 'nb-4', sectionId: 'sec-8' });
  device.add('pageContent', 'page-X', 'page-X', { pageId: 'page-X', text: 'Device A' });
  device.add('pageDrawing', 'page-X', 'page-X', { pageId: 'page-X', strokes: [{ id: 'stroke-1' }] });
  device.add('canvasFile', 'canvas-9', 'ws-A', { id: 'canvas-9', workspaceId: 'ws-A' });
  device.add('canvasScene', 'canvas-9', 'canvas-9', { canvasFileId: 'canvas-9', elements: [{ id: 'shape-1' }] });
  return device;
}

test('one canonical workspace attaches idempotently and propagates Device B edits back to Device A', async () => {
  const provider = new SingleWorkspaceProvider(); const deviceA = seedDeviceA(); const stateA = { lastSeenRevision: 0 };
  const first = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'device-A', journalStore: deviceA.journal, provider, payloadSource: deviceA.source, deviceState: stateA, now: 10 });
  assert.equal(first.upToDate, true); assert.equal(provider.manifest?.workspaceId, 'ws-A');

  const deviceB = new MemoryDevice();
  const attach = await attachWorkspaceReplica({ workspaceId: 'ws-A', records: provider.manifest!.records, remoteRevision: provider.manifest!.revision, hasLocalWorkspace: false, provider, journalStore: deviceB.journal, payloadSource: deviceB.source, localAdapter: deviceB.adapter, now: 20 });
  assert.equal(attach.errors, 0);
  assert.deepEqual([...deviceB.entities.values()].map(item => item.entityId).sort(), [...deviceA.entities.values()].map(item => item.entityId).sort());
  assert.equal(deviceB.entities.get('workspace:ws-A')?.entityId, 'ws-A');
  const sizeAfterFirstAttach = deviceB.entities.size; const appliesAfterFirstAttach = deviceB.applyCount;
  const secondAttach = await attachWorkspaceReplica({ workspaceId: 'ws-A', records: provider.manifest!.records, remoteRevision: provider.manifest!.revision, hasLocalWorkspace: true, provider, journalStore: deviceB.journal, payloadSource: deviceB.source, localAdapter: deviceB.adapter, now: 21 });
  assert.equal(secondAttach.applied, 0); assert.equal(deviceB.entities.size, sizeAfterFirstAttach); assert.equal(deviceB.applyCount, appliesAfterFirstAttach);

  await deviceB.editPage('Edited from Device B', 30, 'device-b-edit');
  const stateB = { lastSeenRevision: provider.manifest!.revision };
  const fromB = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'device-B', journalStore: deviceB.journal, provider, payloadSource: deviceB.source, deviceState: stateB, now: 31 });
  assert.equal(fromB.upToDate, true);
  const pullA = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'device-A', journalStore: deviceA.journal, provider, payloadSource: deviceA.source, deviceState: stateA, now: 32 });
  assert.ok(pullA.recordsForDownload.some(pointer => pointer.kind === 'pageContent' && pointer.id === 'page-X'), 'a genuinely newer Device-B edit remains downloadable');
  const appliesBeforeDeviceBEdit = deviceA.applyCount;
  await applyRemoteChanges({ workspaceId: 'ws-A', records: pullA.recordsForDownload, provider, journalStore: deviceA.journal, localAdapter: deviceA.adapter, now: 32 });
  assert.equal(deviceA.applyCount, appliesBeforeDeviceBEdit + 1, 'only the newer Device-B record is re-applied');
  assert.equal(JSON.parse(new TextDecoder().decode(deviceA.entities.get('pageContent:page-X')!.bytes!)).text, 'Edited from Device B');
  assert.equal(provider.manifest?.workspaceId, 'ws-A');

  await deviceA.editPage('Offline A', 40, 'device-a-offline');
  await deviceB.editPage('Offline B', 40, 'device-b-offline');
  await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'device-A', journalStore: deviceA.journal, provider, payloadSource: deviceA.source, deviceState: stateA, now: 41 });
  const conflict = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'device-B', journalStore: deviceB.journal, provider, payloadSource: deviceB.source, deviceState: stateB, now: 42 });
  assert.equal(conflict.conflicts[0]?.reason, 'concurrent-edit-edit');
  assert.equal(deviceB.entities.size, sizeAfterFirstAttach); assert.equal(provider.manifest?.workspaceId, 'ws-A');
});

test('stale incomplete browser cannot replace a rich same-ID Electron workspace and receives its missing entities', async () => {
  const provider = new SingleWorkspaceProvider();
  const electron = seedDeviceA();
  const electronState = { lastSeenRevision: 0 };
  const published = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'electron', journalStore: electron.journal, provider, payloadSource: electron.source, deviceState: electronState, now: 10 });
  assert.equal(published.upToDate, true);
  const remoteBefore = JSON.stringify(provider.manifest);
  const writesBefore = provider.manifestWrites;

  // This profile knows the stable workspace ID but has an older root and no
  // journal ancestry. Its missing children are absence, not deletion.
  const browser = new MemoryDevice();
  browser.add('workspace', 'ws-A', null, { id: 'ws-A', name: 'Older browser replica' });
  const staleRootBefore = new Uint8Array(browser.entities.get('workspace:ws-A')!.bytes!);
  const browserResult = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'browser', journalStore: browser.journal, provider, payloadSource: browser.source, deviceState: { lastSeenRevision: provider.manifest!.revision }, now: 20 });
  assert.deepEqual(browserResult.conflicts, [{ entityId: 'ws-A', reason: 'concurrent-edit-edit' }]);
  assert.equal(browserResult.manifestPublished, false, 'sync order must not let the stale browser rewrite the manifest');
  assert.equal(provider.manifestWrites, writesBefore);
  assert.equal(JSON.stringify(provider.manifest), remoteBefore);

  await applyRemoteChanges({ workspaceId: 'ws-A', records: browserResult.recordsForDownload, provider, journalStore: browser.journal, localAdapter: browser.adapter, now: 21 });
  assert.deepEqual(browser.entities.get('workspace:ws-A')!.bytes, staleRootBefore, 'conflicting local root remains untouched');
  for (const entityKey of ['folder:folder-1', 'notebook:nb-4', 'notebookSection:sec-8', 'notebookPage:page-X', 'pageContent:page-X', 'pageDrawing:page-X', 'canvasFile:canvas-9', 'canvasScene:canvas-9']) {
    assert.ok(browser.entities.has(entityKey), `remote-only ${entityKey} must be downloaded as a union member`);
  }
  assert.equal(electron.entities.size, 9, 'the rich Electron workspace survives unchanged');

  const repeat = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'electron', journalStore: electron.journal, provider, payloadSource: electron.source, deviceState: electronState, now: 30 });
  assert.equal(repeat.upToDate, true);
  assert.equal(provider.manifestWrites, writesBefore, 'a second sync is idempotent');
  assert.equal(electron.entities.size, 9, 'idempotency creates no copies, IDs, or deletions');
});

test('different-entity offline edits merge as a union on both devices', async () => {
  const provider = new SingleWorkspaceProvider();
  const electron = seedDeviceA();
  const electronState = { lastSeenRevision: 0 };
  await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'electron', journalStore: electron.journal, provider, payloadSource: electron.source, deviceState: electronState, now: 10 });
  const browser = new MemoryDevice();
  await attachWorkspaceReplica({ workspaceId: 'ws-A', records: provider.manifest!.records, remoteRevision: provider.manifest!.revision, hasLocalWorkspace: false, provider, journalStore: browser.journal, payloadSource: browser.source, localAdapter: browser.adapter, now: 11 });

  const electronCanvas = electron.entities.get('canvasScene:canvas-9')!;
  electronCanvas.bytes = encode({ canvasFileId: 'canvas-9', elements: [{ id: 'electron-shape' }] });
  const canvasBase = (await electron.journal.latestByEntity('ws-A')).get('canvasScene:canvas-9')!;
  await electron.journal.upsert(createJournalEntry({ entityType: 'canvasScene', entityId: 'canvas-9', workspaceId: 'ws-A', operation: 'update', currentLocalRevision: canvasBase.localRevision, contentHash: 'stale', baseRevision: canvasBase.localRevision, payloadRef: 'canvas-9', now: 20, entryId: 'electron-canvas-edit' }));

  const browserPage = browser.entities.get('pageContent:page-X')!;
  browserPage.bytes = encode({ pageId: 'page-X', text: 'browser-page-edit' });
  const pageBase = (await browser.journal.latestByEntity('ws-A')).get('pageContent:page-X')!;
  await browser.journal.upsert(createJournalEntry({ entityType: 'pageContent', entityId: 'page-X', workspaceId: 'ws-A', operation: 'update', currentLocalRevision: pageBase.localRevision, contentHash: 'stale', baseRevision: pageBase.localRevision, payloadRef: 'page-X', now: 20, entryId: 'browser-page-edit' }));

  await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'electron', journalStore: electron.journal, provider, payloadSource: electron.source, deviceState: electronState, now: 21 });
  const browserResult = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'browser', journalStore: browser.journal, provider, payloadSource: browser.source, deviceState: { lastSeenRevision: 1 }, now: 22 });
  assert.equal(browserResult.conflicts.length, 0);
  await applyRemoteChanges({ workspaceId: 'ws-A', records: browserResult.recordsForDownload, provider, journalStore: browser.journal, localAdapter: browser.adapter, now: 23 });

  const electronPull = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'electron', journalStore: electron.journal, provider, payloadSource: electron.source, deviceState: electronState, now: 24 });
  assert.equal(electronPull.conflicts.length, 0);
  await applyRemoteChanges({ workspaceId: 'ws-A', records: electronPull.recordsForDownload, provider, journalStore: electron.journal, localAdapter: electron.adapter, now: 25 });
  assert.equal(JSON.parse(new TextDecoder().decode(electron.entities.get('pageContent:page-X')!.bytes!)).text, 'browser-page-edit');
  assert.equal(JSON.parse(new TextDecoder().decode(browser.entities.get('canvasScene:canvas-9')!.bytes!)).elements[0].id, 'electron-shape');
});

test('remote tombstones apply only with a proven base; unknown destructive ancestry preserves local data', async () => {
  const provider = new SingleWorkspaceProvider();
  const electron = seedDeviceA();
  const state = { lastSeenRevision: 0 };
  await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'electron', journalStore: electron.journal, provider, payloadSource: electron.source, deviceState: state, now: 10 });
  const pagePointer = provider.manifest!.records.find(pointer => pointer.kind === 'notebookPage' && pointer.id === 'page-X')!;

  provider.manifest = {
    ...provider.manifest!, revision: provider.manifest!.revision + 1, previousRevision: provider.manifest!.revision,
    records: provider.manifest!.records.map(pointer => pointer === pagePointer ? { ...pointer, revision: pointer.revision + 1, baseRevision: pointer.revision, contentHash: 'tombstone', tombstone: true } : pointer),
  };
  provider.etag = `etag-${provider.manifest.revision}`;
  const valid = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'electron', journalStore: electron.journal, provider, payloadSource: electron.source, deviceState: state, now: 20 });
  assert.equal(valid.conflicts.length, 0);
  await applyRemoteChanges({ workspaceId: 'ws-A', records: valid.recordsForDownload, provider, journalStore: electron.journal, localAdapter: electron.adapter, now: 21 });
  assert.equal(electron.entities.get('notebookPage:page-X')?.tombstone, true, 'a direct descendant tombstone applies');

  const protectedDevice = seedDeviceA();
  const protectedPage = protectedDevice.entities.get('notebookPage:page-X')!;
  const unknown = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'stale-electron', journalStore: protectedDevice.journal, provider, payloadSource: protectedDevice.source, deviceState: { lastSeenRevision: 0 }, now: 30 });
  assert.ok(unknown.conflicts.some(item => item.entityId === 'page-X' && item.reason === 'delete-vs-edit'));
  await applyRemoteChanges({ workspaceId: 'ws-A', records: unknown.recordsForDownload, provider, journalStore: protectedDevice.journal, localAdapter: protectedDevice.adapter, now: 31 });
  assert.equal(protectedDevice.entities.get('notebookPage:page-X'), protectedPage, 'an unproven destructive change cannot touch local data');
  assert.equal(protectedDevice.entities.get('notebookPage:page-X')?.tombstone, false);
});

test('fresh reconstruction establishes the root and supersedes an absent canvas tombstone without inventing a child', async () => {
  const provider = new SingleWorkspaceProvider();
  const rootHash = '1'.repeat(64);
  provider.objects.set(rootHash, encode({ id: 'ws-reconstruct', name: 'Recovered' }));
  const records: RecordPointer[] = [
    { kind: 'canvasFile', id: 'canvas-ijqErFoK8SWg', parentId: 'ws-reconstruct', revision: 2, baseRevision: 1, contentHash: 'tombstone', tombstone: true },
    { kind: 'workspace', id: 'ws-reconstruct', parentId: null, revision: 1, baseRevision: null, contentHash: rootHash, tombstone: false },
  ];
  const fresh = new MemoryDevice();
  const attached = await attachWorkspaceReplica({ workspaceId: 'ws-reconstruct', records, remoteRevision: 2, hasLocalWorkspace: false, provider, journalStore: fresh.journal, payloadSource: fresh.source, localAdapter: fresh.adapter, now: 10 });
  assert.equal(attached.errors, 0);
  assert.ok(fresh.entities.has('workspace:ws-reconstruct'));
  assert.equal(fresh.entities.has('canvasFile:canvas-ijqErFoK8SWg'), false, 'an absent deleted child is not invented');
  assert.equal(fresh.journal.entries.find(item => item.entityId === 'canvas-ijqErFoK8SWg')?.state, 'synced');

  const existing = new MemoryDevice();
  existing.entities.set('workspace:ws-reconstruct', { entityType: 'workspace', entityId: 'ws-reconstruct', workspaceId: 'ws-reconstruct', parentId: null, bytes: encode({ id: 'ws-reconstruct', name: 'Local existing' }), tombstone: false, deletedAt: null });
  const reconciled = await attachWorkspaceReplica({ workspaceId: 'ws-reconstruct', records, remoteRevision: 2, hasLocalWorkspace: true, provider, journalStore: existing.journal, payloadSource: existing.source, localAdapter: existing.adapter, now: 11 });
  assert.equal(reconciled.stagedConflicts, 1);
  assert.equal(existing.applyCount, 0, 'same-ID local workspaces reconcile and never take the fresh reconstruction path');

  const tombstoneOnly = new MemoryDevice();
  const absentRoot = await attachWorkspaceReplica({ workspaceId: 'ws-gone', records: [{ ...records[0], parentId: 'ws-gone' }], remoteRevision: 2, hasLocalWorkspace: false, provider, journalStore: tombstoneOnly.journal, payloadSource: tombstoneOnly.source, localAdapter: tombstoneOnly.adapter, now: 12 });
  assert.equal(absentRoot.errors, 0, 'a child tombstone with no local root is an idempotent absence');
  assert.equal(tombstoneOnly.applyCount, 0);

  const deletedRoot = new MemoryDevice();
  const rootDeleted = await attachWorkspaceReplica({
    workspaceId: 'ws-gone', remoteRevision: 3, hasLocalWorkspace: false, provider,
    journalStore: deletedRoot.journal, payloadSource: deletedRoot.source, localAdapter: deletedRoot.adapter, now: 13,
    records: [
      { kind: 'workspace', id: 'ws-gone', parentId: null, revision: 3, baseRevision: 2, contentHash: 'tombstone', tombstone: true },
      { kind: 'canvasFile', id: 'canvas-historical', parentId: 'ws-gone', revision: 2, baseRevision: 1, contentHash: rootHash, tombstone: false },
    ],
  });
  assert.equal(rootDeleted.errors, 0);
  assert.equal(deletedRoot.applyCount, 0, 'a tombstoned root cannot reconstruct historical live children');
});

test('fresh browser with one workspace auto-replicates five remote workspace IDs and uploads its local-only workspace', async () => {
  const provider = new MultiWorkspaceProvider();
  for (let index = 1; index <= 5; index += 1) provider.seed(`ws-${index}`, String(index));
  const browserWorkspaceIds = new Set(['ws-1']);
  const browserJournal = new MemoryJournal();
  let applied = 0;
  const progress: string[] = [];
  const adapter: RemoteRecordLocalAdapter = {
    async applyRecord({ pointer }) { browserWorkspaceIds.add(pointer.id); applied += 1; },
  };

  const replicas = await replicateMissingRemoteWorkspaces({
    remoteWorkspaces: await provider.listRemoteWorkspaces(),
    localWorkspaceIds: [...browserWorkspaceIds],
    provider,
    journalStore: browserJournal,
    payloadSource: { async loadPayload() { return null; }, async parentOf() { return null; } },
    localAdapter: adapter,
    now: 10,
    onRecordProgress: (workspaceNumber, workspaceTotal, completed, total) => progress.push(`${workspaceNumber}/${workspaceTotal}:${completed}/${total}`),
  });
  assert.deepEqual(replicas.map(item => item.workspaceId).sort(), ['ws-2', 'ws-3', 'ws-4', 'ws-5']);
  assert.deepEqual([...browserWorkspaceIds].sort(), ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5']);
  assert.equal(applied, 4);
  assert.deepEqual(progress, ['1/4:1/1', '2/4:1/1', '3/4:1/1', '4/4:1/1']);

  const repeated = await replicateMissingRemoteWorkspaces({
    remoteWorkspaces: await provider.listRemoteWorkspaces(), localWorkspaceIds: [...browserWorkspaceIds], provider,
    journalStore: browserJournal, payloadSource: { async loadPayload() { return null; }, async parentOf() { return null; } }, localAdapter: adapter, now: 11,
  });
  assert.deepEqual(repeated, []); assert.equal(applied, 4, 'an idle rediscovery must not duplicate logical workspaces');

  const localOnlyBytes = encode({ id: 'ws-browser', name: 'Browser local' });
  const upload = await runSyncCycle({
    workspaceId: 'ws-browser', deviceId: 'browser', journalStore: new MemoryJournal(), provider,
    payloadSource: { async scanWorkspace() { return [{ entityType: 'workspace' as const, entityId: 'ws-browser', workspaceId: 'ws-browser', parentId: null, bytes: localOnlyBytes, tombstone: false, deletedAt: null }]; }, async loadPayload() { return localOnlyBytes; }, async parentOf() { return null; } },
    deviceState: { lastSeenRevision: 0 }, now: 12,
  });
  assert.equal(upload.upToDate, true);
  assert.equal(provider.manifests.get('ws-browser')?.workspaceId, 'ws-browser');
  assert.deepEqual(['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5'].map(id => provider.manifests.get(id)?.workspaceId), ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5']);
  assert.deepEqual(['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5'].map(id => provider.manifests.get(id)?.revision), [1, 1, 1, 1, 1]);
});

test('an orphan remote workspace fails and a foreign local-only binding remains isolated', async () => {
  const provider = new MultiWorkspaceProvider();
  await assert.rejects(() => replicateMissingRemoteWorkspaces({
    remoteWorkspaces: [{ workspaceId: 'ws-orphan', name: 'ws-orphan', revision: 0, generatedAt: '', recordCount: 0 }],
    localWorkspaceIds: [], provider, journalStore: new MemoryJournal(),
    payloadSource: { async loadPayload() { return null; }, async parentOf() { return null; } },
  }), (error: Error) => error instanceof CloudOperationError && error.diagnostic.stage === 'workspace-attach');

  const values = new Map<string, string>();
  const storage: BindingStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  saveWorkspaceBinding({ workspaceId: 'ws-local-only', provider: 'googledrive', providerAccountId: 'account-A', remoteWorkspaceId: 'ws-local-only', lastKnownRemoteRevision: 1, attachedAt: 1 }, storage);
  const reconciled = reconcileWorkspaceBindings('account-B', ['ws-local-only'], storage, 2);
  assert.equal(workspaceIsBoundToOtherAccount(reconciled, 'ws-local-only', 'account-B'), true);
  assert.deepEqual(attachedWorkspaceIds(reconciled, 'account-B', ['ws-local-only']), []);
});

test('explicit Google account migration preserves isolation, publishes the full hierarchy, and stays idempotent', async () => {
  const accountA = new MultiWorkspaceProvider();
  const accountB = new MultiWorkspaceProvider();
  const electron = seedDeviceA();
  electron.add('customBlock', 'block-1', 'canvas-9', { id: 'block-1', canvasFileId: 'canvas-9' });
  electron.add('asset', 'asset-1', 'canvas-9', { id: 'asset-1', ownerId: 'canvas-9', bytes: [1, 2, 3] });
  const accountAState = { lastSeenRevision: 0 };
  await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'electron-A', journalStore: electron.journal, provider: accountA, payloadSource: electron.source, deviceState: accountAState, now: 1 });
  const accountABefore = JSON.stringify(accountA.manifests.get('ws-A'));
  const localBefore = JSON.stringify([...electron.entities].map(([entityKey, entity]) => [entityKey, [...(entity.bytes ?? [])]]));

  const values = new Map<string, string>();
  const storage: BindingStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  saveWorkspaceBinding({ workspaceId: 'ws-A', provider: 'googledrive', providerAccountId: 'account-A', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: accountAState.lastSeenRevision, attachedAt: 1 }, storage);
  const oldBinding = loadWorkspaceBindings(storage);
  const blocked = accountMigrationWorkspaceIds(oldBinding, ['ws-A'], 'account-B');

  assert.deepEqual(blocked, ['ws-A']);
  assert.deepEqual(attachedWorkspaceIds(oldBinding, 'account-B', ['ws-A']), []);
  assert.deepEqual(await accountB.listRemoteWorkspaces(), [], 'nothing reaches Account B before explicit confirmation');
  assert.deepEqual(finalizeAccountSync(0, 0, null, 10, blocked.length), { status: 'account-migration-required', lastSyncedAt: null });

  const migrated = await migrateWorkspaceToGoogleAccount({
    workspaceId: 'ws-A', deviceId: 'electron-B-migration', provider: accountB,
    payloadSource: electron.source, localAdapter: electron.adapter, now: 20,
  });
  assert.equal(migrated.status, 'synced');
  const movedBindings = moveWorkspaceBinding({ workspaceId: 'ws-A', provider: 'googledrive', providerAccountId: 'account-B', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: migrated.remoteRevision, attachedAt: 20 }, storage);
  assert.deepEqual(movedBindings.map(binding => binding.providerAccountId), ['account-B'], 'the local binding moves only after successful publication');

  const requiredKinds = ['workspace', 'folder', 'notebook', 'notebookSection', 'notebookPage', 'pageContent', 'pageDrawing', 'canvasFile', 'canvasScene', 'customBlock', 'asset'];
  const accountBManifest = accountB.manifests.get('ws-A')!;
  assert.deepEqual([...new Set(accountBManifest.records.map(pointer => pointer.kind))].sort(), [...requiredKinds].sort());
  assert.ok(accountBManifest.records.every(pointer => electron.entities.has(`${pointer.kind}:${pointer.id}`)), 'migration preserves every stable entity ID');
  assert.ok(accountBManifest.records.filter(pointer => !pointer.tombstone).every(pointer => accountB.objects.has(pointer.contentHash)), 'every live manifest pointer resolves to an uploaded object');

  const freshBrowser = new MemoryDevice();
  const replicas = await replicateMissingRemoteWorkspaces({
    remoteWorkspaces: await accountB.listRemoteWorkspaces(), localWorkspaceIds: [], provider: accountB,
    journalStore: freshBrowser.journal, payloadSource: freshBrowser.source, localAdapter: freshBrowser.adapter, now: 30,
  });
  assert.deepEqual(replicas.map(replica => replica.workspaceId), ['ws-A']);
  for (const kind of requiredKinds) assert.ok([...freshBrowser.entities.values()].some(entity => entity.entityType === kind), `fresh browser reconstructs ${kind}`);
  assert.equal(JSON.stringify(accountA.manifests.get('ws-A')), accountABefore, 'Account A remote manifest remains untouched');

  const migratedJournal = new MemoryJournal();
  migratedJournal.entries = migrated.journalEntries.map(entry => ({ ...entry }));
  const writesBeforeSecondSync = accountB.manifestWrites;
  const second = await runSyncCycle({
    workspaceId: 'ws-A', deviceId: 'electron-B', journalStore: migratedJournal, provider: accountB,
    payloadSource: electron.source, deviceState: { lastSeenRevision: migrated.remoteRevision }, now: 40,
  });
  assert.equal(second.upToDate, true);
  assert.equal(accountB.manifestWrites, writesBeforeSecondSync, 'second successful sync is idempotent');

  const collisionAccountB = new MultiWorkspaceProvider();
  collisionAccountB.seed('ws-A', 'a');
  const collisionRootBefore = JSON.stringify(collisionAccountB.manifests.get('ws-A')!.records.find(pointer => pointer.kind === 'workspace'));
  const collision = await migrateWorkspaceToGoogleAccount({
    workspaceId: 'ws-A', deviceId: 'electron-B-collision', provider: collisionAccountB,
    payloadSource: electron.source, localAdapter: electron.adapter, now: 50,
  });
  assert.equal(collision.status, 'conflict');
  assert.equal(JSON.stringify(collisionAccountB.manifests.get('ws-A')!.records.find(pointer => pointer.kind === 'workspace')), collisionRootBefore, 'same-ID remote root is never overwritten blindly');

  const failureBindings = new Map<string, string>();
  const failureStorage: BindingStorage = { getItem: key => failureBindings.get(key) ?? null, setItem: (key, value) => { failureBindings.set(key, value); } };
  saveWorkspaceBinding({ workspaceId: 'ws-A', provider: 'googledrive', providerAccountId: 'account-A', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: 1, attachedAt: 1 }, failureStorage);
  const failingAccountB = new MultiWorkspaceProvider();
  failingAccountB.writeManifest = async () => { throw new Error('forced migration failure'); };
  const failedMigration = await migrateWorkspaceToGoogleAccount({
    workspaceId: 'ws-A', deviceId: 'electron-B-failure', provider: failingAccountB,
    payloadSource: electron.source, localAdapter: electron.adapter, now: 60,
  });
  assert.equal(failedMigration.status, 'error');
  assert.deepEqual(loadWorkspaceBindings(failureStorage).map(binding => binding.providerAccountId), ['account-A']);
  assert.equal(JSON.stringify([...electron.entities].map(([entityKey, entity]) => [entityKey, [...(entity.bytes ?? [])]])), localBefore, 'failed migration preserves all existing local entities and bytes');
  assert.equal(JSON.stringify(accountA.manifests.get('ws-A')), accountABefore, 'failed Account B migration cannot modify Account A');
});

test('an interrupted migration resumes its own remote head but keeps a different writer as a conflict', async () => {
  const accountB = new MultiWorkspaceProvider();
  const electron = seedDeviceA();
  const deviceId = 'electron-migration-device';
  const first = await migrateWorkspaceToGoogleAccount({
    workspaceId: 'ws-A', deviceId, provider: accountB,
    payloadSource: electron.source, localAdapter: electron.adapter, now: 10,
  });
  assert.equal(first.status, 'synced');

  // Simulate a crash after manifest publication but before binding/journal commit.
  electron.entities.get('pageContent:page-X')!.bytes = encode({ pageId: 'page-X', text: 'continued migration' });
  const resumed = await migrateWorkspaceToGoogleAccount({
    workspaceId: 'ws-A', deviceId, provider: accountB,
    payloadSource: electron.source, localAdapter: electron.adapter, now: 20,
  });
  assert.equal(resumed.status, 'synced');
  assert.equal(accountB.manifests.get('ws-A')?.revision, 2);
  assert.equal(accountB.manifests.get('ws-A')?.records.find(pointer => pointer.kind === 'pageContent')?.baseRevision, 1);

  accountB.manifests.set('ws-A', { ...accountB.manifests.get('ws-A')!, writerDeviceId: 'another-device' });
  electron.entities.get('pageContent:page-X')!.bytes = encode({ pageId: 'page-X', text: 'unknown ancestry' });
  const genuine = await migrateWorkspaceToGoogleAccount({
    workspaceId: 'ws-A', deviceId, provider: accountB,
    payloadSource: electron.source, localAdapter: electron.adapter, now: 30,
  });
  assert.equal(genuine.status, 'conflict');
});

test('migration never publishes a manifest that references a missing object', async () => {
  const provider = new MultiWorkspaceProvider();
  provider.getMetadata = async () => null;
  const electron = seedDeviceA();
  const result = await migrateWorkspaceToGoogleAccount({
    workspaceId: 'ws-A', deviceId: 'electron-migration', provider,
    payloadSource: electron.source, localAdapter: electron.adapter, now: 10,
  });
  assert.equal(result.status, 'error');
  assert.equal(result.firstError?.stage, 'object-verification');
  assert.equal(provider.manifests.has('ws-A'), false, 'manifest publication is last');
});

test('local-before-login adoption and durable binding retain one stable workspace ID', async () => {
  const provider = new SingleWorkspaceProvider(); const local = seedDeviceA();
  const result = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'device-local', journalStore: local.journal, provider, payloadSource: local.source, deviceState: { lastSeenRevision: 0 }, now: 50 });
  assert.equal(result.upToDate, true); assert.equal(provider.manifest?.workspaceId, 'ws-A');
  assert.equal(provider.manifest?.records.filter(pointer => pointer.kind === 'workspace').length, 1);

  const values = new Map<string, string>();
  const storage: BindingStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  const binding = { workspaceId: 'ws-A', provider: 'googledrive' as const, providerAccountId: 'account-1', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: provider.manifest!.revision, attachedAt: 1 };
  saveWorkspaceBinding(binding, storage); saveWorkspaceBinding({ ...binding, lastKnownRemoteRevision: 2 }, storage);
  assert.equal(loadWorkspaceBindings(storage).length, 1);
  assert.deepEqual(attachedWorkspaceIds(loadWorkspaceBindings(storage), 'account-1', ['ws-A', 'ws-local']), ['ws-A']);
  assert.equal(workspaceIsBoundToOtherAccount(loadWorkspaceBindings(storage), 'ws-A', 'account-2'), true);
  saveWorkspaceBinding({ ...binding, providerAccountId: 'account-2' }, storage);
  const bindings = loadWorkspaceBindings(storage);
  assert.equal(bindings.length, 2, 'account ownership history must not be overwritten');
  assert.deepEqual(attachedWorkspaceIds(bindings, 'account-1', ['ws-A']), ['ws-A']);
  assert.deepEqual(attachedWorkspaceIds(bindings, 'account-2', ['ws-A']), ['ws-A']);
  assert.equal(workspaceHasBinding(bindings, 'ws-A'), true);
  assert.equal(workspaceIsBoundToOtherAccount(bindings, 'ws-A', 'account-2'), false);
  assert.equal(workspaceIsBoundToOtherAccount(bindings, 'ws-A', 'account-3'), true);
});

test('old Chrome binding and exhausted journal metadata migrate into a safe retry', async () => {
  const values = new Map<string, string>();
  values.set('panvas.cloudWorkspaceBindings', JSON.stringify([{ workspaceId: 'ws-A', accountId: 'account-1' }, { workspaceId: 'ws-orphan', accountId: 'account-1' }]));
  const storage: BindingStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  const bindings = reconcileWorkspaceBindings('account-1', ['ws-A'], storage, 100);
  assert.deepEqual(bindings, [{ workspaceId: 'ws-A', provider: 'googledrive', providerAccountId: 'account-1', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: 0, attachedAt: 100 }]);

  const local = seedDeviceA();
  const stale = createJournalEntry({ entityType: 'workspace', entityId: 'ws-A', workspaceId: 'ws-A', operation: 'create', currentLocalRevision: 0, contentHash: 'stale', baseRevision: null, payloadRef: 'ws-A', now: 1, entryId: 'old-chrome' });
  local.journal.entries.push({ ...stale, state: 'error', attempts: 8, lastErrorClass: 'provider-error' });
  local.journal.entries[0] = recoverRetryMetadata(local.journal.entries[0]);
  const provider = new SingleWorkspaceProvider();
  const result = await runSyncCycle({ workspaceId: 'ws-A', deviceId: 'chrome-C', journalStore: local.journal, provider, payloadSource: local.source, deviceState: { lastSeenRevision: 0 }, now: 101 });
  assert.equal(result.upToDate, true);
  assert.equal(provider.manifest?.workspaceId, 'ws-A');
  assert.equal(local.journal.entries.find(item => item.entryId === 'old-chrome')?.state, 'synced');
});

test('same-account email binding migrates to permissionId while a foreign account stays isolated', () => {
  const values = new Map<string, string>();
  values.set('panvas.cloudWorkspaceBindings.v1', JSON.stringify([
    { workspaceId: 'ws-A', provider: 'googledrive', providerAccountId: 'person@example.com', remoteWorkspaceId: 'ws-A', lastKnownRemoteRevision: 4, attachedAt: 1 },
    { workspaceId: 'ws-B', provider: 'googledrive', providerAccountId: 'other@example.com', remoteWorkspaceId: 'ws-B', lastKnownRemoteRevision: 2, attachedAt: 2 },
  ]));
  const storage: BindingStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  const migrated = reconcileWorkspaceBindings('permission-id-123', ['ws-A', 'ws-B'], storage, 10, ['person@example.com']);
  assert.equal(migrated.find(item => item.workspaceId === 'ws-A')?.providerAccountId, 'permission-id-123');
  assert.equal(migrated.find(item => item.workspaceId === 'ws-A')?.lastKnownRemoteRevision, 4);
  assert.equal(workspaceIsBoundToOtherAccount(migrated, 'ws-A', 'permission-id-123'), false);
  assert.equal(workspaceIsBoundToOtherAccount(migrated, 'ws-B', 'permission-id-123'), true);
});

test('bootstrap uses one reserved system identity and never treats duplicate names as identity', async () => {
  const schema = await fs.readFile(new URL('../src/database/schema.ts', import.meta.url), 'utf8');
  const workspaceStore = await fs.readFile(new URL('../src/stores/workspaceStore.ts', import.meta.url), 'utf8');
  assert.match(schema, /SYSTEM_DEFAULT_WORKSPACE_ID = 'ws-system-default-v1'/);
  assert.match(schema, /SYSTEM_WELCOME_CANVAS_ID = 'canvas-system-welcome-v1'/);
  assert.match(schema, /isSystem: true[\s\S]*systemType: 'default'/);
  assert.match(schema, /isSystem: true[\s\S]*systemType: 'welcome'/);
  assert.match(schema, /generateId\('ws'\)|generateId\('canvas'\)/, 'a foreign owner receives a fresh identity instead of taking over the reserved row');
  assert.doesNotMatch(schema, /db\.workspaces\.update\(defaultWorkspaceId/);
  assert.doesNotMatch(schema, /db\.canvasFiles\.update\(defaultCanvasId/);
  assert.match(workspaceStore, /workspaceRepository\.create\(userId, name\)/, 'user-created duplicate names remain ordinary random-ID records');
});

test('public cloud errors never expose configuration, secret, HTTP, or internal provider text', async () => {
  for (const internal of ['PANVAS_GOOGLE_CLIENT_ID is not configured', 'client_secret is missing', '400 invalid_request']) {
    const shown = presentCloudError(new Error(internal), 'authorization');
    assert.doesNotMatch(shown.message, /PANVAS_|client_secret|400|invalid_request/i);
  }
  assert.equal(presentCloudError(new Error('PANVAS_GOOGLE_CLIENT_ID missing'), 'authorization').message, 'Google Drive sign-in is temporarily unavailable.');
  assert.equal(presentCloudError(Object.assign(new Error('raw'), { name: 'AuthExpiredError' }), 'sync').message, 'Google Drive needs to be reconnected.');

  const [store, panel, indicator, handlers, auth] = await Promise.all([
    fs.readFile(new URL('../src/stores/cloudSyncStore.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/library/CloudSyncPanel.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/ui/SyncIndicator.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../electron/ipc/cloudsync-handlers.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../electron/ipc/google-auth-service.ts', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(`${store}\n${panel}\n${indicator}\n${handlers}`, /\(error as Error\)\.message|err\.message|result\.error\b|Open \/ Download/);
  assert.doesNotMatch(panel, /PANVAS_GOOGLE_CLIENT_ID|client_secret|invalid_request/);
  assert.doesNotMatch(panel, /Cloud workspaces|Workspaces on this device|Add to this device|Enable sync/);
  assert.doesNotMatch(panel, /Drive requests|objectsUploaded|objectsAlreadyPresent|contentHash|revision/);
  assert.doesNotMatch(handlers, /success: false, error:/);
  assert.doesNotMatch(auth, /renderHtmlResponse\(false, \(err as Error\)\.message\)/);
});

test('30-day Trash model calculates purge eligibility and leaves remote tombstone retention intact', async () => {
  const { trashCountdown, purgeEligibleRoots, TRASH_RETENTION_DAYS } = await import('../src/services/cloudsync/trash.ts');
  assert.equal(TRASH_RETENTION_DAYS, 30);
  const DAY = 86_400_000;
  const now = 1_000 * DAY;
  const recent = now - 5 * DAY;
  const expired = now - 31 * DAY;

  const recentCountdown = trashCountdown(recent, now);
  assert.equal(recentCountdown.purgeEligible, false);
  assert.equal(recentCountdown.daysRemaining, 25);
  assert.match(recentCountdown.label, /25 days/);

  const expiredCountdown = trashCountdown(expired, now);
  assert.equal(expiredCountdown.purgeEligible, true);
  assert.equal(expiredCountdown.daysRemaining, 0);
  assert.equal(expiredCountdown.label, 'Deletes permanently today');

  const items = [{ id: 'item-1', deletedAt: recent }, { id: 'item-2', deletedAt: expired }];
  assert.deepEqual(purgeEligibleRoots(items, now), ['item-2']);
});
