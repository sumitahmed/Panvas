import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { accountSyncStatus, finalizeAccountSync, runSyncCycle, type DeviceManifestState, type SyncJournalStore, type SyncPayloadSource } from '../src/services/cloudsync/engine.ts';
import type { CloudSyncProvider, ObjectUpload, ProviderConnectionInfo, RemoteManifestRead, SyncJournalEntry, SyncManifestV1 } from '../src/services/cloudsync/types.ts';
import { buildManifestV1 } from '../src/services/cloudsync/manifest.ts';
import { createJournalEntry, recoverRetryMetadata } from '../src/services/cloudsync/journal.ts';
import { GoogleDriveApiError, GoogleDriveSyncProvider, GoogleDriveTimeoutError } from '../src/services/cloudsync/googleDriveProvider.ts';
import { decodeAssetEnvelope, encodeAssetEnvelope } from '../src/services/cloudsync/assetEnvelope.ts';
import { applyRemoteChanges } from '../src/services/cloudsync/applyRemoteChanges.ts';
import { connectBrowserGoogle, requestBrowserGoogleAccessToken } from '../src/services/cloudsync/browserGoogleAuth.ts';
import { CloudOperationError, sanitizeCloudDiagnostic } from '../src/services/cloudsync/errors.ts';

class MemoryJournal implements SyncJournalStore {
  readonly entries: SyncJournalEntry[];
  constructor(entries: SyncJournalEntry[]) { this.entries = entries; }
  async listPending(workspaceId: string, now: number) { return this.entries.filter(item => item.workspaceId === workspaceId && (item.state === 'pending' || item.state === 'syncing') && (item.nextAttemptAt === null || item.nextAttemptAt <= now)); }
  async upsert(entry: SyncJournalEntry) { const index = this.entries.findIndex(item => item.entryId === entry.entryId); if (index >= 0) this.entries[index] = entry; else this.entries.push(entry); }
  async latestByEntity(workspaceId: string) { const result = new Map<string, SyncJournalEntry>(); for (const item of this.entries.filter(value => value.workspaceId === workspaceId && value.state !== 'superseded')) { const key = `${item.entityType}:${item.entityId}`; if (!result.get(key) || result.get(key)!.localRevision < item.localRevision) result.set(key, item); } return result; }
  async listUnresolved(workspaceId: string) { return this.entries.filter(item => item.workspaceId === workspaceId && ['pending', 'syncing', 'conflict', 'error'].includes(item.state)); }
}

class MemoryProvider implements CloudSyncProvider {
  readonly id = 'googledrive' as const; readonly supportsResumableUpload = true;
  manifest: SyncManifestV1 | null; etag: string | null; objects = new Map<string, Uint8Array>(); writes = 0; puts = 0; reads = 0; active = 0; maxActive = 0; delayMs = 0;
  constructor(manifest: SyncManifestV1 | null = null) { this.manifest = manifest; this.etag = manifest ? `e-${manifest.revision}` : null; }
  async connect(): Promise<ProviderConnectionInfo> { return { provider: 'googledrive', accountIdentifier: 'fake', connectedAt: 0 }; }
  async disconnect() {} async getAccountInfo() { return null; } async ensureAppRoot() { return 'root'; }
  async readManifest(): Promise<RemoteManifestRead> { this.reads += 1; return { manifest: this.manifest, etag: this.etag }; }
  async writeManifest(_workspaceId: string, manifest: SyncManifestV1) { this.writes += 1; this.manifest = manifest; this.etag = `e-${manifest.revision}`; return { etag: this.etag }; }
  async getObject(_workspaceId: string, hash: string) { const value = this.objects.get(hash); if (!value) throw new Error('missing'); return value; }
  async putObjectIfAbsent(_workspaceId: string, upload: ObjectUpload) { this.active += 1; this.maxActive = Math.max(this.maxActive, this.active); try { if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs)); if (this.objects.has(upload.hash)) return 'present' as const; this.puts += 1; this.objects.set(upload.hash, upload.bytes); return 'uploaded' as const; } finally { this.active -= 1; } }
  async deleteObject() {} async moveObject() {} async getMetadata(_workspaceId: string, hash: string) { return this.objects.has(hash) ? { size: this.objects.get(hash)!.length } : null; }
}

const remoteSeed = (workspaceId: string) => buildManifestV1({ workspaceId, revision: 1, previousRevision: null, writerDeviceId: 'remote', generatedAt: '2026-01-01T00:00:00.000Z', records: [{ kind: 'workspace', id: workspaceId, parentId: null, revision: 1, baseRevision: null, contentHash: 'a'.repeat(64), tombstone: false }] });
const pending = (input: Partial<SyncJournalEntry> & Pick<SyncJournalEntry, 'entryId' | 'entityId'>): SyncJournalEntry => ({ entityType: 'notebook', workspaceId: 'ws-stable', operation: 'update', localRevision: 1, contentHash: 'stale', baseRevision: null, updatedAt: 1, deletedAt: null, tombstone: false, state: 'pending', attempts: 0, nextAttemptAt: null, lastErrorClass: null, payloadRef: input.entityId, ...input });

test('legacy duplicate restore is superseded by the newer delete without loading a live payload', async () => {
  const restore = pending({ entryId: 'restore-old', entityId: 'nb-1', operation: 'restore', localRevision: 2 });
  const deletion = pending({ entryId: 'delete-new', entityId: 'nb-1', operation: 'delete', localRevision: 3, updatedAt: 2, contentHash: null, tombstone: true, deletedAt: 2, payloadRef: null });
  const journal = new MemoryJournal([restore, deletion]); const provider = new MemoryProvider(remoteSeed('ws-stable')); let loads = 0;
  const result = await runSyncCycle({ workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider, payloadSource: { async loadPayload() { loads += 1; return null; }, async parentOf() { return 'ws-stable'; } }, deviceState: { lastSeenRevision: 1 }, now: 10 });
  assert.equal(loads, 0); assert.equal(journal.entries.find(item => item.entryId === 'restore-old')?.state, 'superseded'); assert.equal(result.errors.length, 0); assert.equal(provider.manifest?.records.find(item => item.id === 'nb-1')?.tombstone, true);
});

test('a required live restore payload fails explicitly with safe entity and stage diagnostics', async () => {
  const journal = new MemoryJournal([pending({ entryId: 'restore', entityId: 'nb-missing', operation: 'restore' })]);
  const result = await runSyncCycle({ workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider: new MemoryProvider(remoteSeed('ws-stable')), payloadSource: { async loadPayload() { return null; }, async parentOf() { return null; } }, deviceState: { lastSeenRevision: 1 }, now: 10 });
  assert.deepEqual(result.errors[0], { entityId: 'nb-missing', entityType: 'notebook', operation: 'restore', payloadRef: 'nb-missing', stage: 'restore-payload-load', errorClass: 'payload-missing' });
  assert.notEqual(journal.entries[0].state, 'synced');
});

test('a detached metadata update in payload backoff after local deletion reconciles immediately to the canonical tombstone', async () => {
  const staleUpdate = pending({ entryId: 'late-notebook-update', entityId: 'nb-deleted', operation: 'update', localRevision: 3, contentHash: 'stale-live-hash', attempts: 3, nextAttemptAt: 60_000, lastErrorClass: 'payload-missing' });
  const journal = new MemoryJournal([staleUpdate]);
  const provider = new MemoryProvider(remoteSeed('ws-stable'));
  let payloadLoads = 0;
  const result = await runSyncCycle({
    workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider,
    payloadSource: {
      async scanWorkspace() { return [{ entityType: 'notebook' as const, entityId: 'nb-deleted', workspaceId: 'ws-stable', parentId: 'ws-stable', bytes: null, tombstone: true, deletedAt: 9 }]; },
      async loadPayload() { payloadLoads += 1; return null; },
      async parentOf() { return 'ws-stable'; },
    },
    deviceState: { lastSeenRevision: 1 }, now: 10,
  });
  assert.equal(payloadLoads, 0, 'a canonical tombstone must never request a live payload');
  assert.equal(result.errors.length, 0);
  assert.equal(result.upToDate, true);
  assert.equal(result.objectsUploaded, 0);
  assert.equal(provider.manifest?.records.find(item => item.kind === 'notebook' && item.id === 'nb-deleted')?.tombstone, true);
  assert.equal(journal.entries.find(item => item.entryId === 'late-notebook-update')?.state, 'synced');
});

test('a stale child payload update in backoff under deleted page metadata is superseded without a payload failure', async () => {
  const staleDrawing = pending({ entryId: 'late-page-drawing', entityId: 'page-deleted', entityType: 'pageDrawing', operation: 'update', contentHash: 'stale-drawing-hash', attempts: 3, nextAttemptAt: 60_000, lastErrorClass: 'payload-missing' });
  const journal = new MemoryJournal([staleDrawing]);
  const provider = new MemoryProvider(remoteSeed('ws-stable'));
  let payloadLoads = 0;
  const result = await runSyncCycle({
    workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider,
    payloadSource: {
      async scanWorkspace() { return [{ entityType: 'notebookPage' as const, entityId: 'page-deleted', workspaceId: 'ws-stable', parentId: 'section-1', bytes: null, tombstone: true, deletedAt: 9 }]; },
      async loadPayload() { payloadLoads += 1; return null; },
      async parentOf() { return 'page-deleted'; },
    },
    deviceState: { lastSeenRevision: 1 }, now: 10,
  });
  assert.equal(payloadLoads, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(result.upToDate, true);
  assert.equal(journal.entries[0].state, 'superseded');
});

test('a delayed payload-missing entry is rearmed when canonical bytes now exist', async () => {
  const stale = pending({ entryId: 'late-notebook', entityId: 'nb-repaired', entityType: 'notebook', contentHash: 'old-hash', attempts: 8, nextAttemptAt: null, lastErrorClass: 'payload-missing', state: 'error' });
  const journal = new MemoryJournal([stale]);
  const provider = new MemoryProvider(remoteSeed('ws-stable'));
  const bytes = new TextEncoder().encode('repaired notebook');
  const result = await runSyncCycle({
    workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider,
    payloadSource: {
      async scanWorkspace() { return [{ entityType: 'notebook' as const, entityId: 'nb-repaired', workspaceId: 'ws-stable', parentId: 'ws-stable', bytes, tombstone: false, deletedAt: null }]; },
      async loadPayload() { throw new Error('canonical scan should provide the payload'); },
      async parentOf() { return 'ws-stable'; },
    },
    deviceState: { lastSeenRevision: 1 }, now: 10,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.upToDate, true);
  assert.equal(journal.entries[0].state, 'synced');
  assert.equal(journal.entries[0].lastErrorClass, null);
});

test('payload failures from deleted workspaces are superseded while an unbased root tombstone fails closed', async () => {
  const stale = pending({ entryId: 'late-child', entityId: 'nb-deleted', entityType: 'notebook', lastErrorClass: 'payload-missing', attempts: 8, nextAttemptAt: null, state: 'error' });
  const journal = new MemoryJournal([stale]);
  const result = await runSyncCycle({
    workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider: new MemoryProvider(remoteSeed('ws-stable')),
    payloadSource: {
      async scanWorkspace() { return [{ entityType: 'workspace' as const, entityId: 'ws-stable', workspaceId: 'ws-stable', parentId: null, bytes: null, tombstone: true, deletedAt: 9 }]; },
      async loadPayload() { throw new Error('deleted workspace children must not load'); },
      async parentOf() { return null; },
    },
    deviceState: { lastSeenRevision: 1 }, now: 10,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.upToDate, false);
  assert.deepEqual(result.conflicts, [{ entityId: 'ws-stable', reason: 'edit-vs-delete' }]);
  assert.equal(journal.entries[0].state, 'superseded');
});

test('an unresolved journal row without an error class still emits a concrete retry diagnostic', async () => {
  const stuck = pending({ entryId: 'stuck', entityId: 'nb-stuck', nextAttemptAt: 60_000, lastErrorClass: null });
  const journal = new MemoryJournal([stuck]);
  const result = await runSyncCycle({
    workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider: new MemoryProvider(remoteSeed('ws-stable')),
    payloadSource: { async loadPayload() { return new TextEncoder().encode('payload'); }, async parentOf() { return 'ws-stable'; } },
    deviceState: { lastSeenRevision: 1 }, now: 10,
  });
  assert.equal(result.upToDate, false);
  assert.deepEqual(result.errors[0], { entityId: 'nb-stuck', entityType: 'notebook', operation: 'update', payloadRef: 'nb-stuck', stage: 'retry-backoff', errorClass: 'provider-error' });
});

test('persisted pre-fix conflict/error rows are superseded only when canonical and remote state exactly match', async () => {
  const bytes = new TextEncoder().encode('identical current workspace');
  const { sha256Bytes } = await import('../src/services/cloudsync/hash.ts');
  const hash = await sha256Bytes(bytes);
  const manifest = buildManifestV1({
    workspaceId: 'ws-stable', revision: 3, previousRevision: 2, writerDeviceId: 'remote', generatedAt: '2026-01-01T00:00:00.000Z',
    records: [{ kind: 'workspace', id: 'ws-stable', parentId: null, revision: 3, baseRevision: 2, contentHash: hash, tombstone: false }],
  });
  const staleConflict = pending({
    entryId: 'old-conflict', entityId: 'ws-stable', entityType: 'workspace', localRevision: 4,
    contentHash: hash, baseRevision: 2, state: 'conflict', lastErrorClass: 'concurrent-edit-edit',
  });
  const staleError = pending({
    entryId: 'old-error', entityId: 'ws-stable', entityType: 'workspace', localRevision: 2,
    contentHash: hash, baseRevision: 1, state: 'error', attempts: 8, lastErrorClass: 'provider-error',
  });
  const journal = new MemoryJournal([staleConflict, staleError]);
  const provider = new MemoryProvider(manifest);
  const source: SyncPayloadSource = {
    async scanWorkspace() { return [{ entityType: 'workspace', entityId: 'ws-stable', workspaceId: 'ws-stable', parentId: null, bytes, tombstone: false, deletedAt: null }]; },
    async loadPayload() { return bytes; },
    async parentOf() { return null; },
  };

  const first = await runSyncCycle({ workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider, payloadSource: source, deviceState: { lastSeenRevision: 3 }, now: 10 });
  assert.equal(first.upToDate, true);
  assert.equal(first.unresolvedEntries, 0);
  assert.equal(journal.entries.find(item => item.entryId === 'old-conflict')?.state, 'superseded');
  assert.equal(journal.entries.find(item => item.entryId === 'old-error')?.state, 'superseded');

  const second = await runSyncCycle({ workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider, payloadSource: source, deviceState: { lastSeenRevision: 3 }, now: 11 });
  assert.equal(second.upToDate, true, 'the migration is idempotent on the next sync');
  assert.equal(second.unresolvedEntries, 0);
});

test('an orphaned payload-missing retry is superseded without treating absence as deletion', async () => {
  const bytes = new TextEncoder().encode('current workspace root');
  const { sha256Bytes } = await import('../src/services/cloudsync/hash.ts');
  const hash = await sha256Bytes(bytes);
  const manifest = buildManifestV1({
    workspaceId: 'ws-stable', revision: 2, previousRevision: 1, writerDeviceId: 'remote', generatedAt: '2026-01-01T00:00:00.000Z',
    records: [{ kind: 'workspace', id: 'ws-stable', parentId: null, revision: 2, baseRevision: 1, contentHash: hash, tombstone: false }],
  });
  const orphan = pending({
    entryId: 'orphan-payload', entityId: 'nb-no-longer-canonical', entityType: 'notebook',
    state: 'error', attempts: 8, lastErrorClass: 'payload-missing', nextAttemptAt: null,
  });
  const recoveredOrphan = recoverRetryMetadata(orphan);
  assert.equal(recoveredOrphan.lastErrorClass, 'payload-missing', 'startup retry recovery must retain deterministic orphan evidence');
  const journal = new MemoryJournal([recoveredOrphan]);
  const provider = new MemoryProvider(manifest);
  const result = await runSyncCycle({
    workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider,
    payloadSource: {
      async scanWorkspace() { return [{ entityType: 'workspace' as const, entityId: 'ws-stable', workspaceId: 'ws-stable', parentId: null, bytes, tombstone: false, deletedAt: null }]; },
      async loadPayload() { throw new Error('orphaned payload must not be retried'); },
      async parentOf() { return null; },
    },
    deviceState: { lastSeenRevision: 2 }, now: 20,
  });
  assert.equal(result.upToDate, true);
  assert.equal(journal.entries.find(item => item.entryId === 'orphan-payload')?.state, 'superseded');
  assert.equal(provider.manifest?.records.some(pointer => pointer.id === 'nb-no-longer-canonical'), false, 'absence never creates a tombstone');
});

test('a persisted conflict that still differs from the remote remains conflict/red on every run', async () => {
  const localBytes = new TextEncoder().encode('local current state');
  const remoteBytes = new TextEncoder().encode('remote current state');
  const { sha256Bytes } = await import('../src/services/cloudsync/hash.ts');
  const localHash = await sha256Bytes(localBytes);
  const remoteHash = await sha256Bytes(remoteBytes);
  const manifest = buildManifestV1({
    workspaceId: 'ws-stable', revision: 4, previousRevision: 3, writerDeviceId: 'remote', generatedAt: '2026-01-01T00:00:00.000Z',
    records: [{ kind: 'workspace', id: 'ws-stable', parentId: null, revision: 4, baseRevision: 3, contentHash: remoteHash, tombstone: false }],
  });
  const conflict = pending({
    entryId: 'current-conflict', entityId: 'ws-stable', entityType: 'workspace', localRevision: 5,
    contentHash: localHash, baseRevision: 3, state: 'conflict', lastErrorClass: 'concurrent-edit-edit',
  });
  const journal = new MemoryJournal([conflict]);
  const result = await runSyncCycle({
    workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider: new MemoryProvider(manifest),
    payloadSource: {
      async scanWorkspace() { return [{ entityType: 'workspace' as const, entityId: 'ws-stable', workspaceId: 'ws-stable', parentId: null, bytes: localBytes, tombstone: false, deletedAt: null }]; },
      async loadPayload() { return localBytes; },
      async parentOf() { return null; },
    },
    deviceState: { lastSeenRevision: 4 }, now: 30,
  });
  assert.equal(result.upToDate, false);
  assert.deepEqual(result.conflicts, [{ entityId: 'ws-stable', reason: 'concurrent-edit-edit' }]);
  assert.equal(result.errors.length, 0, 'a real conflict is not mislabeled as generic retry residue');
  assert.equal(journal.entries.find(item => item.entryId === 'current-conflict')?.state, 'conflict');
});

test('object uploads are bounded-concurrent and each payload is loaded and hashed once per cycle', async () => {
  const entries = Array.from({ length: 12 }, (_, index) => pending({ entryId: `e-${index}`, entityId: `nb-${index}` }));
  const journal = new MemoryJournal(entries); const provider = new MemoryProvider(remoteSeed('ws-stable')); provider.delayMs = 8; const loads = new Map<string, number>();
  const source: SyncPayloadSource = { async loadPayload(entry) { loads.set(entry.entityId, (loads.get(entry.entityId) ?? 0) + 1); return new TextEncoder().encode(`payload-${entry.entityId}`); }, async parentOf() { return 'ws-stable'; } };
  const result = await runSyncCycle({ workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider, payloadSource: source, deviceState: { lastSeenRevision: 1 }, now: 10, objectConcurrency: 4 });
  assert.ok(provider.maxActive > 1 && provider.maxActive <= 4); assert.equal(result.objectsUploaded, 12); assert.ok([...loads.values()].every(count => count === 1));
});

test('second no-change sync is idempotent with no object upload or manifest write', async () => {
  const journal = new MemoryJournal([pending({ entryId: 'e-1', entityId: 'nb-1' })]); const provider = new MemoryProvider(remoteSeed('ws-stable')); const state: DeviceManifestState = { lastSeenRevision: 1 };
  const source = { async loadPayload() { return new TextEncoder().encode('same'); }, async parentOf() { return 'ws-stable'; } };
  await runSyncCycle({ workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider, payloadSource: source, deviceState: state, now: 10 });
  const writes = provider.writes, puts = provider.puts;
  const idle = await runSyncCycle({ workspaceId: 'ws-stable', deviceId: 'device-a', journalStore: journal, provider, payloadSource: source, deviceState: state, now: 20 });
  assert.equal(idle.upToDate, true); assert.equal(provider.writes, writes); assert.equal(provider.puts, puts); assert.equal(idle.payloadsLoaded, 0);
});

function folderFetch(transient: number[], calls: { count: number }): typeof fetch {
  return async (input) => {
    calls.count += 1; const status = transient.shift();
    if (status) return new Response(JSON.stringify({ error: { message: 'temporary' } }), { status, headers: status === 429 ? { 'Retry-After': '0' } : {} });
    const url = new URL(String(input)); const query = decodeURIComponent(url.searchParams.get('q') ?? '');
    const name = query.match(/name = '([^']+)'/)?.[1] ?? 'unknown';
    return new Response(JSON.stringify({ files: [{ id: `${name}-id`, name }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('Google requests honor Retry-After and bounded retries for 429 and 5xx', async () => {
  for (const statuses of [[429], [500, 503]]) {
    const calls = { count: 0 }, delays: number[] = [];
    const provider = new GoogleDriveSyncProvider({ tokenProvider: async () => 'token', fetchFn: folderFetch([...statuses], calls), sleepFn: async ms => { delays.push(ms); }, randomFn: () => 0, maxRetries: 3 });
    await provider.ensureAppRoot(); const metrics = provider.getRequestMetrics();
    assert.equal(metrics.retries, statuses.length); assert.equal(delays.length, statuses.length); assert.ok(calls.count >= statuses.length + 3);
  }
});

test('permanent 4xx is not retried and a dead request times out after the retry cap', async () => {
  let permanentCalls = 0;
  const permanent = new GoogleDriveSyncProvider({ tokenProvider: async () => 'token', fetchFn: async () => { permanentCalls += 1; return new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 }); }, sleepFn: async () => {}, maxRetries: 3 });
  await assert.rejects(() => permanent.ensureAppRoot(), (error: Error) => error instanceof GoogleDriveApiError && (error as GoogleDriveApiError).status === 403); assert.equal(permanentCalls, 1);
  const timeout = new GoogleDriveSyncProvider({ tokenProvider: async () => 'token', fetchFn: async () => new Promise<Response>(() => {}), sleepFn: async () => {}, randomFn: () => 0, requestTimeoutMs: 5, maxRetries: 1 });
  await assert.rejects(() => timeout.ensureAppRoot(), (error: Error) => error instanceof GoogleDriveTimeoutError); assert.deepEqual(timeout.getRequestMetrics(), { requests: 2, retries: 1, backoffMs: 400, timeouts: 2 });
});

test('fake cross-device manifest/object round-trip preserves IDs and binary envelope bytes', async () => {
  const provider = new MemoryProvider(); const stateA = new DeviceManifestStateCtor();
  const workspace = { id: 'ws-cross', name: 'Cross device' }; const page = { pageId: 'page-stable', workspaceId: 'ws-cross', notebookId: 'nb-stable', data: { text: 'A' }, version: 1 };
  const journalA = new MemoryJournal([
    createJournalEntry({ entityType: 'workspace', entityId: 'ws-cross', workspaceId: 'ws-cross', operation: 'create', currentLocalRevision: 0, contentHash: 'stale', baseRevision: null, payloadRef: 'ws-cross', now: 1, entryId: 'a-workspace' }),
    createJournalEntry({ entityType: 'pageContent', entityId: 'page-stable', workspaceId: 'ws-cross', operation: 'create', currentLocalRevision: 0, contentHash: 'stale', baseRevision: null, payloadRef: 'page-stable', now: 1, entryId: 'a-page' }),
  ]);
  const sourceA = { async loadPayload(entry: SyncJournalEntry) { return new TextEncoder().encode(JSON.stringify(entry.entityType === 'workspace' ? workspace : page)); }, async parentOf(entry: SyncJournalEntry) { return entry.entityType === 'workspace' ? null : 'page-stable'; } };
  await runSyncCycle({ workspaceId: 'ws-cross', deviceId: 'device-a', journalStore: journalA, provider, payloadSource: sourceA, deviceState: stateA, now: 2 });
  const remotePage = provider.manifest!.records.find(item => item.kind === 'pageContent')!; const deviceBCopy = JSON.parse(new TextDecoder().decode(await provider.getObject('ws-cross', remotePage.contentHash)));
  assert.equal(deviceBCopy.pageId, 'page-stable'); assert.equal(deviceBCopy.notebookId, 'nb-stable');
  const pageFromB = { ...deviceBCopy, data: { text: 'edited on device B', ink: [{ id: 'stroke-stable', points: [[1, 2], [3, 4]] }] } };
  const journalB = new MemoryJournal([createJournalEntry({ entityType: 'pageContent', entityId: 'page-stable', workspaceId: 'ws-cross', operation: 'update', currentLocalRevision: remotePage.revision, contentHash: 'stale', baseRevision: remotePage.revision, payloadRef: 'page-stable', now: 3, entryId: 'b-page-edit' })]);
  await runSyncCycle({ workspaceId: 'ws-cross', deviceId: 'device-b', journalStore: journalB, provider, payloadSource: { async loadPayload() { return new TextEncoder().encode(JSON.stringify(pageFromB)); }, async parentOf() { return 'page-stable'; } }, deviceState: { lastSeenRevision: provider.manifest!.revision }, now: 4 });
  const returnedPointer = provider.manifest!.records.find(item => item.kind === 'pageContent' && item.id === 'page-stable')!;
  const deviceAReceived = JSON.parse(new TextDecoder().decode(await provider.getObject('ws-cross', returnedPointer.contentHash)));
  assert.equal(deviceAReceived.pageId, 'page-stable'); assert.equal(deviceAReceived.data.ink[0].id, 'stroke-stable'); assert.equal(deviceAReceived.data.text, 'edited on device B');
  const original = new Uint8Array([0, 1, 2, 250, 255]); const wrapped = encodeAssetEnvelope({ id: 'asset-stable', ownerId: 'page-stable', fileName: 'voice.webm', mimeType: 'audio/webm', assetKind: 'audio', createdAt: 1, userId: null }, original); const decoded = decodeAssetEnvelope(wrapped)!;
  assert.equal(decoded.metadata.id, 'asset-stable'); assert.deepEqual(decoded.bytes, original);
});

test('empty device reconstruction applies remote records in dependency order without regenerating IDs', async () => {
  const provider = new MemoryProvider();
  const payloads = [
    ['1'.repeat(64), { id: 'ws-cross', name: 'Cross device' }],
    ['2'.repeat(64), { id: 'nb-stable', workspaceId: 'ws-cross', name: 'Notebook' }],
    ['3'.repeat(64), { id: 'section-stable', notebookId: 'nb-stable', name: 'Section' }],
    ['4'.repeat(64), { id: 'page-stable', sectionId: 'section-stable', name: 'Page' }],
    ['5'.repeat(64), { pageId: 'page-stable', notebookId: 'nb-stable', data: { text: 'remote', ink: [{ id: 'stroke-stable' }] } }],
  ] as const;
  for (const [hash, payload] of payloads) provider.objects.set(hash, new TextEncoder().encode(JSON.stringify(payload)));
  const records = [
    { kind: 'pageContent' as const, id: 'page-stable', parentId: 'page-stable', revision: 1, baseRevision: null, contentHash: '5'.repeat(64), tombstone: false },
    { kind: 'notebookPage' as const, id: 'page-stable', parentId: 'section-stable', revision: 1, baseRevision: null, contentHash: '4'.repeat(64), tombstone: false },
    { kind: 'notebookSection' as const, id: 'section-stable', parentId: 'nb-stable', revision: 1, baseRevision: null, contentHash: '3'.repeat(64), tombstone: false },
    { kind: 'notebook' as const, id: 'nb-stable', parentId: 'ws-cross', revision: 1, baseRevision: null, contentHash: '2'.repeat(64), tombstone: false },
    { kind: 'folder' as const, id: 'folder-deleted', parentId: 'ws-cross', revision: 2, baseRevision: 1, contentHash: '0'.repeat(64), tombstone: true },
    { kind: 'workspace' as const, id: 'ws-cross', parentId: null, revision: 1, baseRevision: null, contentHash: '1'.repeat(64), tombstone: false },
  ];
  const applied: Array<{ kind: string; id: string; payload: unknown; tombstone: boolean }> = [];
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = { panvas: { cloudsync: { applyRemoteRecord: async (_workspaceId: string, record: typeof applied[number]) => { applied.push(record); } } } };
  try {
    const result = await applyRemoteChanges({ workspaceId: 'ws-cross', records, provider, journalStore: new MemoryJournal([]), mode: 'reconstruct', now: 10 });
    assert.deepEqual(result, { applied: 5, skipped: 1, errors: 0 });
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
  }
  assert.deepEqual(applied.map(record => record.kind), ['workspace', 'notebook', 'notebookSection', 'notebookPage', 'pageContent']);
  assert.deepEqual(applied.map(record => record.id), ['ws-cross', 'nb-stable', 'section-stable', 'page-stable', 'page-stable']);
  assert.equal((applied[4].payload as any).data.ink[0].id, 'stroke-stable');
});

test('page metadata finishes before pageContent and pageDrawing begin', async () => {
  const provider = new MemoryProvider();
  const records = [
    { kind: 'pageDrawing' as const, id: 'page-ordered', parentId: 'page-ordered', revision: 1, baseRevision: null, contentHash: '3'.repeat(64), tombstone: false },
    { kind: 'pageContent' as const, id: 'page-ordered', parentId: 'page-ordered', revision: 1, baseRevision: null, contentHash: '2'.repeat(64), tombstone: false },
    { kind: 'notebookPage' as const, id: 'page-ordered', parentId: 'section-ordered', revision: 1, baseRevision: null, contentHash: '1'.repeat(64), tombstone: false },
  ];
  for (const pointer of records) provider.objects.set(pointer.contentHash, new TextEncoder().encode(JSON.stringify({ id: pointer.id, kind: pointer.kind })));
  let pageMetadataComplete = false;
  const started: string[] = [];
  const result = await applyRemoteChanges({
    workspaceId: 'ws-ordered', records, provider, journalStore: new MemoryJournal([]),
    localAdapter: {
      async applyRecord({ pointer }) {
        started.push(pointer.kind);
        if (pointer.kind === 'notebookPage') {
          await new Promise(resolve => setTimeout(resolve, 5));
          pageMetadataComplete = true;
          return;
        }
        assert.equal(pageMetadataComplete, true, `${pointer.kind} began before notebookPage metadata completed`);
      },
    },
  });
  assert.deepEqual(result, { applied: 3, skipped: 0, errors: 0 });
  assert.equal(started[0], 'notebookPage');
  assert.deepEqual(new Set(started.slice(1)), new Set(['pageContent', 'pageDrawing']));
});

test('Electron remote applies serialize workspace metadata read-modify-write operations', async () => {
  const source = await fs.readFile(new URL('../electron/ipc/WorkspaceService.ts', import.meta.url), 'utf8');
  assert.match(source, /remoteApplyTails/);
  assert.match(source, /applyRemoteRecordUnlocked/);
  assert.match(source, /previous\s*\.catch\(\(\) => undefined\)\s*\.then\(\(\) => this\.applyRemoteRecordUnlocked/);
});

test('remote download failures return sanitized diagnostic fields instead of logging payload context', async () => {
  const provider = new MemoryProvider();
  provider.getObject = async () => { throw new GoogleDriveApiError({ stage: 'Object download', status: 503, reason: 'backendError', message: 'internal provider text' }); };
  const records = [{ kind: 'notebook' as const, id: 'nb-diagnostic', parentId: 'ws-diagnostic', revision: 1, baseRevision: null, contentHash: 'a'.repeat(64), tombstone: false }];
  const result = await applyRemoteChanges({ workspaceId: 'ws-diagnostic', records, provider, journalStore: new MemoryJournal([]) });
  assert.equal(result.errors, 1);
  assert.deepEqual(result.firstError, {
    entityId: 'nb-diagnostic', entityType: 'notebook', operation: 'create', stage: 'remote-object-download', errorClass: 'provider-error',
    providerStatus: 503, providerReason: 'backendError', retryable: true,
  });
});

test('an unproven destructive remote pointer fails closed before the local adapter is called', async () => {
  const provider = new MemoryProvider();
  const pointer = { kind: 'canvasFile' as const, id: 'canvas-protected', parentId: 'ws-protected', revision: 4, baseRevision: 3, contentHash: 'tombstone', tombstone: true };
  let adapterCalls = 0;
  const result = await applyRemoteChanges({
    workspaceId: 'ws-protected', records: [pointer], provider, journalStore: new MemoryJournal([]),
    localAdapter: { async applyRecord() { adapterCalls += 1; } },
  });
  assert.equal(adapterCalls, 0);
  assert.equal(result.errors, 1);
  assert.equal(result.firstError?.providerReason, 'destructive-base-unproven');
});

test('Electron diagnostic transport allowlists fields and strips content before terminal logging', async () => {
  const diagnostic = sanitizeCloudDiagnostic({
    provider: 'googledrive', workspaceId: 'ws-safe / leaked', stage: 'object transfer', status: 503, reason: 'backend error',
    entityKind: 'notebook', entityId: 'nb-safe / leaked', operation: 'update note content', retryable: true,
    accessToken: 'must-not-survive', noteContent: 'must-not-survive',
  });
  assert.deepEqual(diagnostic, {
    provider: 'googledrive', workspaceId: 'ws-safe_leaked', stage: 'object_transfer', status: 503, reason: 'backend_error',
    entityKind: 'notebook', entityId: 'nb-safe_leaked', operation: 'update_note_content', retryable: true,
  });
  const [preload, handler] = await Promise.all([
    fs.readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../electron/ipc/cloudsync-diagnostic-handler.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(preload, /cloudsync:diagnostic/);
  assert.match(handler, /sanitizeCloudDiagnostic/);
  assert.match(handler, /\[CloudSync diagnostic\]/);
});

test('one failed workspace keeps the account result out of full-success state', () => {
  assert.equal(accountSyncStatus(1, 0, { entityId: 'ws-broken', stage: 'object-transfer', errorClass: 'provider-error' }), 'error');
  assert.equal(accountSyncStatus(1, 0, { entityId: 'ws-auth', stage: 'manifest-read', errorClass: 'auth-expired' }), 'auth-expired');
  assert.notEqual(accountSyncStatus(1, 1, null), 'synced');
});

test('account finalization advances lastSynced only for a fully successful aggregated run', () => {
  assert.deepEqual(finalizeAccountSync(0, 0, null, 123_456), { status: 'synced', lastSyncedAt: 123_456 });
  assert.deepEqual(finalizeAccountSync(1, 0, { entityId: 'ws-broken', stage: 'remote-record-apply', errorClass: 'provider-error' }, 123_456), { status: 'error', lastSyncedAt: null });
  assert.deepEqual(finalizeAccountSync(0, 1, null, 123_456), { status: 'conflict', lastSyncedAt: null });
  assert.deepEqual(finalizeAccountSync(0, 0, null, 123_456, 2), { status: 'account-migration-required', lastSyncedAt: null });
});

test('browser GIS initializes a token client, requests access, and reports missing Web client configuration', async () => {
  let config: any = null;
  let requestCount = 0;
  const oauth2 = {
    initTokenClient(value: any) {
      config = value;
      return { requestAccessToken() { requestCount += 1; queueMicrotask(() => value.callback({ access_token: 'memory-only-token', expires_in: 3600 })); } };
    },
  };
  const response = await requestBrowserGoogleAccessToken('web-client.apps.googleusercontent.com', oauth2);
  assert.equal(config.client_id, 'web-client.apps.googleusercontent.com');
  assert.equal(config.scope, 'https://www.googleapis.com/auth/drive.appdata email profile openid');
  assert.equal(requestCount, 1);
  assert.equal(response.access_token, 'memory-only-token');
  await assert.rejects(connectBrowserGoogle(), (error: Error) => error instanceof CloudOperationError && error.code === 'configuration');
});

class DeviceManifestStateCtor implements DeviceManifestState { lastSeenRevision = 0 }

test('browser sync security keeps secrets out and OAuth flows request least privilege with appdata', async () => {
  const [auth, electronAuth, store, env, preload] = await Promise.all([
    fs.readFile(new URL('../src/services/cloudsync/browserGoogleAuth.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../electron/ipc/google-auth-service.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/stores/cloudSyncStore.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    fs.readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(auth, /initTokenClient/); assert.match(auth, /requestAccessToken/); assert.match(auth, /VITE_PANVAS_GOOGLE_WEB_CLIENT_ID/); assert.doesNotMatch(auth, /VITE_PANVAS_GOOGLE_CLIENT_ID|VITE_GOOGLE_CLIENT_ID/); assert.doesNotMatch(`${auth}\n${store}\n${preload}`, /PANVAS_GOOGLE_CLIENT_SECRET|VITE_.*CLIENT_SECRET/); assert.match(env, /^PANVAS_GOOGLE_CLIENT_ID=$/m); assert.match(env, /^PANVAS_GOOGLE_CLIENT_SECRET=$/m); assert.doesNotMatch(env, /^PANVAS_GOOGLE_(?:CLIENT_ID|CLIENT_SECRET)=.+$/m); assert.doesNotMatch(`${auth}\n${electronAuth}`, /userinfo\.email|userinfo\.profile/); assert.match(store, /runSyncCycle/); assert.match(store, /applyRemoteChanges/); assert.match(store, /crypto\.randomUUID/); assert.match(store, /lastSyncedByProvider/);
});
