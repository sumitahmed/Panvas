import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleDriveSyncV2Provider } from '../src/services/cloudsync/v2/googleDriveV2Provider.ts';
import { sha256Bytes } from '../src/services/cloudsync/hash.ts';
import { FakeCloudDrive } from './helpers/fakeCloudDrive.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const remoteFor = (drive: FakeCloudDrive) => new GoogleDriveSyncV2Provider({ fetchFn: drive.fetch, tokenProvider: async () => 'fake-token', randomFn: () => .5, sleepFn: async () => {} });
const objects = (drive: FakeCloudDrive, hash: string) => [...drive.files.values()].filter(f => f.name === hash && !f.trashed);

test('same-hash puts share one upload in a provider, for small and resumable objects', async () => {
  for (const length of [40, 5 * 1024 * 1024]) {
    const drive = new FakeCloudDrive(), remote = remoteFor(drive);
    await remote.readProfile(); drive.resetCounts();
    const bytes = new Uint8Array(length).fill(7), hash = await sha256Bytes(bytes);
    const result = await Promise.all(Array.from({ length: 8 }, () => remote.putObjectIfAbsent(hash, bytes)));
    assert.ok(result.every(value => value === 'uploaded' || value === 'present'));
    assert.equal(objects(drive, hash).length, 1);
    assert.equal(drive.counts().objectCreates, 1);
    assert.equal(drive.counts().maxUploads, 1, 'followers await the same physical upload');
    assert.equal(drive.requests.filter(r => r.method === 'POST' && r.name === hash).length, 1);
  }
});

test('lost response after multipart creation or resumable completion retries the same physical file ID', async () => {
  for (const length of [40, 5 * 1024 * 1024]) {
    const drive = new FakeCloudDrive(), remote = remoteFor(drive);
    const bytes = new Uint8Array(length).fill(3), hash = await sha256Bytes(bytes);
    await remote.readProfile(); drive.resetCounts();
    drive.failOnce(r => r.method === (length < 5 * 1024 * 1024 ? 'POST' : 'PUT') && (length < 5 * 1024 * 1024 ? r.url.searchParams.get('uploadType') === 'multipart' : r.url.pathname.startsWith('/resumable/')), 'lost-response');
    await remote.putObjectIfAbsent(hash, bytes);
    assert.equal(objects(drive, hash).length, 1);
    assert.equal(drive.counts().objectCreates, 1);
    assert.ok(remote.getDriveProvider().getRequestMetrics().retries >= 1);
    assert.equal((await remote.getObject(hash)).byteLength, length);
  }
});

test('persistent and reconnect providers reuse folders and PATCH existing JSON files', async () => {
  const drive = new FakeCloudDrive();
  const profile: any = { format: 'panvas-sync-v2-profile', schemaVersion: 2, profileId: 'profile-a', accountIdentifier: 'account-a' };
  const catalog: any = { format: 'panvas-sync-v2-catalog', schemaVersion: 2, revision: 1, workspaces: [] };
  const manifest: any = { format: 'panvas-sync-v2-manifest', schemaVersion: 2, workspaceId: 'ws-a', revision: 1, records: [] };
  for (const remote of [remoteFor(drive), remoteFor(drive)]) {
    for (let run = 0; run < 3; run++) {
      const p = await remote.readProfile(); await remote.writeProfile(profile, p.etag);
      const c = await remote.readCatalog(); await remote.writeCatalog(catalog, c.etag);
      const m = await remote.readManifest('ws-a'); await remote.writeManifest('ws-a', manifest, m.etag);
    }
  }
  assert.equal(drive.duplicates().length, 0);
  for (const name of ['Panvas', 'sync-v2', 'objects', 'workspaces', 'ws-a', 'profile.json', 'catalog.json', 'manifest.json']) {
    assert.equal([...drive.files.values()].filter(f => f.name === name).length, 1, name);
  }
  assert.equal(drive.requests.filter(r => r.method === 'PATCH' && r.name?.endsWith('.json')).length, 15);
});

test('a previous miss or an old object index never hides another provider upload', async () => {
  const drive = new FakeCloudDrive(), first = remoteFor(drive), other = remoteFor(drive);
  const bytes = encode({ version: 1 }), hash = await sha256Bytes(bytes);
  assert.equal(await first.getObjectMetadata(hash), null);
  await other.putObjectIfAbsent(hash, bytes);
  drive.resetCounts();
  assert.equal(await first.putObjectIfAbsent(hash, bytes), 'present');
  assert.equal(objects(drive, hash).length, 1);
  assert.equal(drive.counts().objectCreates, 0);
});

test('deleted positive-cache file is rechecked and safely restored with the original creation ID', async () => {
  const drive = new FakeCloudDrive(), remote = remoteFor(drive);
  const bytes = encode({ text: 'repairable' }), hash = await sha256Bytes(bytes);
  await remote.putObjectIfAbsent(hash, bytes);
  const file = objects(drive, hash)[0]; drive.files.delete(file.id);
  await remote.putObjectIfAbsent(hash, bytes);
  assert.equal(objects(drive, hash).length, 1);
  assert.equal(await sha256Bytes(await remote.getObject(hash)), hash);
});

test('existing duplicate same-hash files have a deterministic valid canonical ID and no third copy is created', async () => {
  const drive = new FakeCloudDrive(), remote = remoteFor(drive);
  await remote.readProfile();
  const parent = [...drive.files.values()].find(f => f.name === 'objects')!.id;
  const bytes = encode({ original: 'immutable' }), hash = await sha256Bytes(bytes);
  drive.add(hash, parent, bytes, 'object-b'); drive.add(hash, parent, bytes, 'object-a');
  drive.add(hash, parent, new Uint8Array(), 'object-0-incomplete');
  drive.add(hash, parent, new Uint8Array([1]), 'object-0-wrong-size');
  drive.resetCounts();
  assert.equal(await remote.putObjectIfAbsent(hash, bytes), 'present');
  assert.deepEqual(await remote.getObject(hash), bytes);
  const download = drive.requests.find(r => r.url.searchParams.get('alt') === 'media');
  assert.equal(download!.url.pathname.split('/').pop(), 'object-a');
  assert.equal(objects(drive, hash).length, 4, 'preexisting incomplete and duplicate files are preserved');
  assert.equal(drive.counts().objectCreates, 0);
});

test('different content hashes are legitimate immutable versions and are both retained', async () => {
  const drive = new FakeCloudDrive(), remote = remoteFor(drive);
  const a = encode({ version: 'A' }), b = encode({ version: 'B' });
  const hashA = await sha256Bytes(a), hashB = await sha256Bytes(b);
  await remote.putObjectIfAbsent(hashA, a); await remote.putObjectIfAbsent(hashB, b);
  await remote.putObjectIfAbsent(hashA, a); await remote.putObjectIfAbsent(hashB, b);
  assert.equal(objects(drive, hashA).length, 1); assert.equal(objects(drive, hashB).length, 1);
  assert.equal(drive.duplicates().length, 0);
  assert.deepEqual(await remote.getObject(hashA), a); assert.deepEqual(await remote.getObject(hashB), b);
});

test('two providers racing in the same objects folder demonstrate the remaining cross-device race', async t => {
  const drive = new FakeCloudDrive(), first = remoteFor(drive), second = remoteFor(drive);
  await first.readProfile(); await second.readProfile();
  const bytes = encode({ concurrent: 'two-device' }), hash = await sha256Bytes(bytes);
  await Promise.all([first.putObjectIfAbsent(hash, bytes), second.putObjectIfAbsent(hash, bytes)]);
  assert.equal(objects(drive, hash).length, 2);
  assert.equal(new Set(objects(drive, hash).map(f => f.parents[0])).size, 1);
  t.diagnostic('Two independent providers can both see a missing hash and allocate distinct file IDs before either create completes.');
  await remoteFor(drive).putObjectIfAbsent(hash, bytes);
  assert.equal(objects(drive, hash).length, 2, 'a later run reuses the deterministic canonical object without making a third copy');
  // Exact lookups narrow the race but cannot make independent ID allocations unique.
});

test('independent devices can also race first-time folder creation; existing folders are preserved', async t => {
  const drive = new FakeCloudDrive();
  await Promise.all([remoteFor(drive).readProfile(), remoteFor(drive).readProfile()]);
  assert.equal([...drive.files.values()].filter(f => f.name === 'Panvas').length, 2);
  const before = drive.files.size;
  await remoteFor(drive).readProfile();
  assert.equal(drive.files.size, before);
  t.diagnostic('Same-process provider reuse prevents redundant discovery; filenames cannot enforce cross-device folder uniqueness.');
});
