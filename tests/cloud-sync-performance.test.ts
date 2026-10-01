import assert from 'node:assert/strict';
import test from 'node:test';
import { runCloudSyncV2 } from '../src/services/cloudsync/v2/engine.ts';
import { GoogleDriveSyncV2Provider } from '../src/services/cloudsync/v2/googleDriveV2Provider.ts';
import { sha256Bytes } from '../src/services/cloudsync/hash.ts';
import { encodeAssetEnvelope, decodeAssetEnvelope } from '../src/services/cloudsync/assetEnvelope.ts';
import { FakeCloudDrive } from './helpers/fakeCloudDrive.ts';
import { LocalSyncPayloadSource, setCurrentBrowserUserIdReader, type BrowserSyncSnapshot } from '../src/services/cloudsync/payloadSource.ts';
import type { ScannedSyncEntity } from '../src/services/cloudsync/engine.ts';
import type { SyncV2BaselineRecord, SyncV2LocalSource, SyncV2ProfileState, SyncV2Provider } from '../src/services/cloudsync/v2/types.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const key = (entity: ScannedSyncEntity) => `${entity.entityType}:${entity.entityId}`;

class TestReplica {
  entities = new Map<string, ScannedSyncEntity>();
  scans = 0; serialized = 0; applied = 0;
  profile: SyncV2ProfileState | null = null;
  baseline = new Map<string, SyncV2BaselineRecord[]>();
  source: SyncV2LocalSource = {
    listWorkspaceIds: async () => [...new Set([...this.entities.values()].map(e => e.workspaceId))],
    scanWorkspace: async () => this.scan(),
    scanWorkspaceIncludingUnowned: async () => this.scan(),
    scanFreshWorkspace: async () => this.scan(),
    // The combined snapshot is optional, so the baseline engine ignores it.
    ...{ scanWorkspaceSnapshot: async () => { const all = this.scan(); return { owned: all, all }; } },
  };
  baselines = {
    loadProfile: () => this.profile,
    saveProfile: (value: SyncV2ProfileState) => { this.profile = value; },
    loadWorkspace: (id: string) => this.baseline.get(id) ?? [],
    saveWorkspace: (id: string, values: SyncV2BaselineRecord[]) => { this.baseline.set(id, structuredClone(values)); },
  };
  conflicts = { preserve: async () => 'created' as const, hasUnresolved: async () => false };
  adapter = {
    applyRecord: async ({ record, bytes }: any) => this.apply(record, bytes),
    applyWorkspace: async ({ expected, expectedHashes, downloads }: any) => {
      // Model the production adapter's mandatory fresh optimistic edit check.
      const fresh = this.scan();
      assert.equal(fresh.length, expected.length);
      for (const entity of expected) {
        const current = fresh.find(e => key(e) === key(entity));
        assert.equal(await sha256Bytes(current!.bytes!), expectedHashes?.get(key(entity)) ?? await sha256Bytes(entity.bytes!));
      }
      for (const { record, bytes } of downloads) this.apply(record, bytes);
    },
  };
  private scan() {
    this.scans++; this.serialized += this.entities.size;
    return [...this.entities.values()].map(e => {
      const asset = e.entityType === 'asset' && e.bytes ? decodeAssetEnvelope(e.bytes) : null;
      const bytes = asset ? encodeAssetEnvelope(asset.metadata, asset.bytes) : e.bytes ? encode(JSON.parse(new TextDecoder().decode(e.bytes))) : null;
      return { ...e, bytes };
    });
  }
  private apply(record: any, bytes: Uint8Array | null) {
    this.applied++;
    const entity: ScannedSyncEntity = { entityType: record.kind, entityId: record.id, workspaceId: 'ws-measure', parentId: record.parentId, bytes, tombstone: record.tombstone, deletedAt: null, ownership: 'current' };
    this.entities.set(key(entity), entity);
  }
  add(kind: ScannedSyncEntity['entityType'], id: string, parentId: string | null, value: unknown | Uint8Array) {
    this.apply({ kind, id, parentId, tombstone: false }, value instanceof Uint8Array ? value : encode(value));
  }
  edit(page: number) {
    this.entities.get(`pageContent:page-${page}`)!.bytes = encode({ pageId: `page-${page}`, data: { text: `edited-${page}` } });
  }
  resetCounts() { this.scans = 0; this.serialized = 0; this.applied = 0; }
}

function representativeReplica() {
  const replica = new TestReplica();
  replica.add('workspace', 'ws-measure', null, { id: 'ws-measure', name: 'Measured workspace' });
  for (let n = 0; n < 3; n++) {
    replica.add('notebook', `nb-${n}`, 'ws-measure', { id: `nb-${n}` });
    replica.add('notebookSection', `section-${n}`, `nb-${n}`, { id: `section-${n}`, notebookId: `nb-${n}` });
  }
  for (let p = 0; p < 30; p++) {
    replica.add('notebookPage', `page-${p}`, `section-${p % 3}`, { id: `page-${p}`, notebookId: `nb-${p % 3}`, sectionId: `section-${p % 3}` });
    replica.add('pageContent', `page-${p}`, `page-${p}`, { pageId: `page-${p}`, data: { text: `original-${p}` } });
    replica.add('pageDrawing', `page-${p}`, `page-${p}`, { pageId: `page-${p}`, data: { objects: [{ id: `stroke-${p}` }] } });
  }
  for (let a = 0; a < 3; a++) {
    replica.add('asset', `asset-${a}`, `page-${a}`, encodeAssetEnvelope({ id: `asset-${a}`, ownerId: `page-${a}`, fileName: `image-${a}.png`, mimeType: 'image/png', assetKind: 'image', createdAt: 1, userId: null }, new Uint8Array(1024).fill(a)));
  }
  assert.equal(replica.entities.size, 100);
  replica.resetCounts();
  return replica;
}

function provider(drive: FakeCloudDrive) {
  return new GoogleDriveSyncV2Provider({ fetchFn: drive.fetch, tokenProvider: async () => 'fake-token', sleepFn: async () => {}, randomFn: () => .5 });
}

async function run(remote: SyncV2Provider, replica: TestReplica) {
  return runCloudSyncV2({ accountIdentifier: 'measure-account', provider: remote, source: replica.source, adapter: replica.adapter, baselines: replica.baselines, conflictStore: replica.conflicts });
}

test('deterministic work counts: 100-object workspace', async t => {
  const drive = new FakeCloudDrive(), original = representativeReplica();
  assert.equal((await run(provider(drive), original)).status, 'synced');
  const reused = provider(drive);
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto.subtle, 'digest');
  let hashes = 0;
  Object.defineProperty(globalThis.crypto.subtle, 'digest', { configurable: true, value: (...args: Parameters<SubtleCrypto['digest']>) => { hashes++; return digest(...args); } });
  async function measure(name: string, replica: TestReplica, remote: SyncV2Provider) {
    drive.resetCounts(); replica.resetCounts(); hashes = 0;
    const result = await run(remote, replica);
    assert.equal(result.status, 'synced', JSON.stringify(result));
    const counts = { ...drive.counts(), scans: replica.scans, serialized: replica.serialized, hashes, applied: replica.applied, uploaded: result.uploaded, downloaded: result.downloaded };
    t.diagnostic(`${name}: ${JSON.stringify(counts)}`);
    return counts;
  }
  try {
    const fresh = await measure('fresh', new TestReplica(), provider(drive));
    assert.equal(fresh.downloads, 100); assert.equal(fresh.maxDownloads, 4); assert.equal(fresh.applied, 100);
    assert.equal(fresh.objectLists, 0); assert.equal(fresh.scans, 3);
    const noop = await measure('noop', original, reused);
    assert.equal(noop.objectCreates, 0); assert.equal(noop.jsonWrites, 0);
    assert.equal(noop.scans, 1); assert.equal(noop.serialized, 100);
    original.edit(0);
    const edit = await measure('page-edit', original, reused);
    assert.equal(edit.uploaded, 1); assert.equal(edit.jsonWrites, 2); assert.equal(edit.scans, 1);
    assert.ok(edit.requests < 130, 'one validation sweep replaces repeated manifest-wide revalidation');
    for (let p = 1; p <= 12; p++) original.edit(p);
    const multi = await measure('multi-edit', original, reused);
    assert.equal(multi.uploaded, 12); assert.equal(multi.objectCreates, 12); assert.equal(multi.maxUploads, 4);
    original.add('asset', 'asset-0', 'page-0', encodeAssetEnvelope({ id: 'asset-0', ownerId: 'page-0', fileName: 'image-0.png', mimeType: 'image/png', assetKind: 'image', createdAt: 1, userId: null }, new Uint8Array(1024).fill(9)));
    const asset = await measure('asset-edit', original, reused);
    assert.equal(asset.uploaded, 1); assert.equal(asset.downloaded, 0);
    for (let repeat = 0; repeat < 3; repeat++) {
      drive.resetCounts(); assert.equal((await run(reused, original)).status, 'synced');
      assert.equal(drive.counts().objectCreates, 0); assert.equal(drive.counts().jsonWrites, 0);
    }
    assert.equal(drive.duplicates().length, 0, 'versions have different hashes; same name+parent must stay unique');
  } finally {
    if (descriptor) Object.defineProperty(globalThis.crypto.subtle, 'digest', descriptor);
    else Reflect.deleteProperty(globalThis.crypto.subtle, 'digest');
  }
});

test('duplicate-sensitive same-hash concurrency measurement', async t => {
  const drive = new FakeCloudDrive(), remote = provider(drive);
  await remote.readProfile();
  drive.resetCounts();
  const bytes = encode({ text: 'same immutable bytes' }), hash = await sha256Bytes(bytes);
  await Promise.all([remote.putObjectIfAbsent(hash, bytes), remote.putObjectIfAbsent(hash, bytes)]);
  t.diagnostic(JSON.stringify({ physicalObjectCreates: drive.counts().objectCreates, uploadRequests: drive.requests.filter(r => r.method === 'POST').length }));
  assert.equal(drive.counts().objectCreates, 1);
  assert.equal(drive.requests.filter(r => r.method === 'POST').length, 1);
});

test('combined browser scan shares exact bytes and preserves both ownership graphs', async () => {
  for (const current of ['owner', null]) {
    setCurrentBrowserUserIdReader(() => current);
    const snapshot = {
      workspaces: [{ id: 'ws-owned', userId: current }], folders: [],
      notebooks: [{ id: 'nb-owned', workspaceId: 'ws-owned', userId: current }, { id: 'nb-foreign', workspaceId: 'ws-owned', userId: 'foreign' }],
      sections: [], pages: [{ id: 'owned-page', notebookId: 'nb-owned', userId: current }, { id: 'foreign-page', notebookId: 'nb-foreign', userId: 'foreign' }],
      contents: [{ pageId: 'owned-page', data: { text: 'owned' }, userId: current }, { pageId: 'foreign-page', data: { text: 'foreign' }, userId: 'foreign' }],
      drawings: [], canvases: [], scenes: [], blocks: [], pdfs: [], media: [],
    } as unknown as BrowserSyncSnapshot;
    let reads = 0;
    const source = new LocalSyncPayloadSource(async () => { reads++; return snapshot; });
    source.beginCycle();
    try {
      const owned = await source.scanWorkspace('ws-owned'), all = await source.scanWorkspaceIncludingUnowned('ws-owned');
      const combined = await source.scanWorkspaceSnapshot('ws-owned');
      assert.deepEqual(combined.owned, owned); assert.deepEqual(combined.all, all);
      assert.equal(reads, 1);
      for (const entity of combined.owned) assert.equal(entity.bytes, combined.all.find(e => key(e) === key(entity))!.bytes, 'one serialization per entity, not per ownership projection');
      assert.ok(combined.all.length > combined.owned.length);
    } finally { source.endCycle(); setCurrentBrowserUserIdReader(() => null); }
  }
});

test('one failed parallel upload drains workers and cannot publish a manifest or advance baselines', async () => {
  const drive = new FakeCloudDrive(), replica = representativeReplica(), remote = provider(drive);
  assert.equal((await run(remote, replica)).status, 'synced');
  const before = structuredClone(replica.baseline.get('ws-measure'));
  for (let p = 0; p < 12; p++) replica.edit(p);
  drive.resetCounts();
  drive.failOnce(r => r.method === 'POST' && r.url.searchParams.get('uploadType') === 'multipart', 403);
  assert.equal((await run(remote, replica)).status, 'error');
  assert.equal(drive.counts().jsonWrites, 0);
  assert.equal(drive.activeUploads, 0, 'failure waits for every worker before returning');
  assert.deepEqual(replica.baseline.get('ws-measure'), before);
  assert.equal((await run(remote, replica)).status, 'synced', 'next cycle safely uses completed immutable objects');
});

test('object proofs expire after a cycle; remote deletion or corrupt bytes never reach local apply', async () => {
  const drive = new FakeCloudDrive(), original = representativeReplica(), remote = provider(drive);
  assert.equal((await run(remote, original)).status, 'synced');
  const file = [...drive.files.values()].find(f => f.content && new TextDecoder().decode(f.content).includes('original-0'))!;
  const bytes = file.content!.slice();
  file.content = encode({ corrupt: 'different exact bytes' }); file.size = String(file.content.byteLength);
  const empty = new TestReplica();
  assert.equal((await run(remote, empty)).status, 'error'); assert.equal(empty.applied, 0); assert.equal(empty.baseline.size, 0);
  drive.files.delete(file.id);
  assert.equal((await run(remote, new TestReplica())).status, 'error', 'positive ID is revalidated in a new cycle');
  // A complete device with the exact bytes may repair the missing hash, not a stale different version.
  file.content = bytes; file.size = String(bytes.byteLength);
  assert.equal((await run(remote, original)).status, 'synced');
});

test('429, 5xx and timeout retries stay bounded and do not duplicate files', async () => {
  for (const status of [429, 503, 'lost-response'] as const) {
    const drive = new FakeCloudDrive(), remote = provider(drive);
    await remote.readProfile(); drive.resetCounts();
    const bytes = encode({ status }), hash = await sha256Bytes(bytes);
    drive.failOnce(r => r.method === 'POST' && r.url.searchParams.get('uploadType') === 'multipart', status);
    await remote.putObjectIfAbsent(hash, bytes);
    assert.equal(drive.counts().objectCreates, 1);
    assert.equal(remote.getDriveProvider().getRequestMetrics().retries, 1);
    assert.equal(await sha256Bytes(await remote.getObject(hash)), hash);
  }
});

test('manifest 412 prevents catalog and baseline publication after successful immutable transfers', async () => {
  const drive = new FakeCloudDrive(), replica = representativeReplica(), remote = provider(drive);
  assert.equal((await run(remote, replica)).status, 'synced');
  const before = structuredClone(replica.baseline.get('ws-measure'));
  replica.edit(0); drive.resetCounts();
  drive.failOnce(r => r.method === 'PATCH' && r.name === 'manifest.json', 412);
  assert.equal((await run(remote, replica)).status, 'error');
  assert.equal(drive.requests.filter(r => r.method === 'PATCH' && r.name === 'catalog.json').length, 0);
  assert.deepEqual(replica.baseline.get('ws-measure'), before);
});

test('download size proof is checked alongside SHA before reconstruction', async () => {
  const drive = new FakeCloudDrive(), replica = representativeReplica(), remote = provider(drive);
  assert.equal((await run(remote, replica)).status, 'synced');
  const file = [...drive.files.values()].find(f => f.content && new TextDecoder().decode(f.content).includes('original-0'))!;
  file.size = String(file.content!.byteLength + 1);
  const empty = new TestReplica();
  const result = await run(remote, empty);
  assert.equal(result.status, 'error'); assert.equal(result.diagnostic?.reason, 'object-size-mismatch');
  assert.equal(empty.applied, 0); assert.equal(empty.baseline.size, 0);
});

test('an edit during upload stays dirty against the captured baseline and uploads on the next run', async () => {
  const drive = new FakeCloudDrive(), replica = representativeReplica();
  assert.equal((await run(provider(drive), replica)).status, 'synced');
  replica.edit(0);
  let release!: () => void, entered!: () => void;
  const beforeUpload = new Promise<void>(resolve => { entered = resolve; });
  const pausedUpload = new Promise<void>(resolve => { release = resolve; });
  let paused = false;
  const remote = new GoogleDriveSyncV2Provider({ tokenProvider: async () => 'fake-token', fetchFn: async (input, init) => {
    if (!paused && init?.method === 'POST' && String(input).includes('uploadType=multipart')) {
      paused = true; entered(); await pausedUpload;
    }
    return drive.fetch(input, init);
  } });
  const active = run(remote, replica);
  await beforeUpload;
  replica.entities.get('pageContent:page-0')!.bytes = encode({ pageId: 'page-0', data: { text: 'newer edit during upload' } });
  release();
  assert.equal((await active).status, 'synced');
  const baseline = replica.baseline.get('ws-measure')!.find(b => b.entityKind === 'pageContent' && b.entityId === 'page-0')!;
  assert.notEqual(baseline.localHash, await sha256Bytes(replica.entities.get('pageContent:page-0')!.bytes!));
  const next = await run(remote, replica);
  assert.equal(next.status, 'synced'); assert.equal(next.uploaded, 1);
});
