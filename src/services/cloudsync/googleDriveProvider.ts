/** Google Drive v3 adapter for Panvas-owned folders and immutable objects. */
import type { CloudSyncProvider, ObjectPutResult, ObjectUpload, ProviderConnectionInfo, ProviderRequestMetrics, RemoteManifestRead, RemoteWorkspaceSummary, SyncManifestV1 } from './types.ts';
import { ProviderConflictError } from './engine.ts';
import { connectBrowserGoogle, disconnectBrowserGoogle, getBrowserGoogleConnection, getBrowserGoogleToken, refreshBrowserGoogleToken } from './browserGoogleAuth.ts';
import { CloudOperationError } from './errors.ts';

export class AuthExpiredError extends Error {
  readonly status = 401;
  constructor(message = 'Google authorization expired or revoked.') { super(message); this.name = 'AuthExpiredError'; }
}

export class RateLimitedError extends Error {
  readonly status = 429;
  constructor(message = 'Google Drive is temporarily rate limited. Retry later.') { super(message); this.name = 'RateLimitedError'; }
}

export class GoogleDriveTimeoutError extends Error {
  constructor(stage: string) { super(`${stage} timed out.`); this.name = 'GoogleDriveTimeoutError'; }
}

export class GoogleDriveApiError extends Error {
  readonly status: number; readonly reason: string; readonly stage: string; readonly details?: string;
  constructor(opts: { stage: string; status: number; reason: string; message: string; details?: string }) {
    super(`${opts.stage} failed: ${opts.status} ${opts.reason} — ${opts.message}`);
    this.name = 'GoogleDriveApiError'; this.status = opts.status; this.reason = opts.reason; this.stage = opts.stage; this.details = opts.details;
  }
}

type DriveFile = { id: string; name: string; size?: string; md5Checksum?: string; version?: string; modifiedTime?: string; mimeType?: string };

export interface GoogleDriveProviderOptions {
  tokenProvider?: () => Promise<string | null>;
  tokenRefresher?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  apiBaseUrl?: string;
  uploadBaseUrl?: string;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
  maxRetries?: number;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
  /** Optional child namespace below Panvas/. Legacy sync leaves this unset. */
  remoteNamespace?: string;
  assertCurrent?: () => void;
  storageSpace?: 'appDataFolder' | 'drive';
  rootFolderId?: string;
}

const DEFAULT_API_BASE = 'https://www.googleapis.com/drive/v3';
const DEFAULT_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const LARGE_OBJECT_BYTES = 5 * 1024 * 1024;
const EMPTY_METRICS = (): ProviderRequestMetrics => ({ requests: 0, retries: 0, backoffMs: 0, timeouts: 0 });
const escapeQuery = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export class GoogleDriveSyncProvider implements CloudSyncProvider {
  readonly id = 'googledrive' as const;
  readonly supportsResumableUpload = true;
  private readonly tokenProvider: () => Promise<string | null>;
  private readonly tokenRefresher: () => Promise<string | null>;
  private readonly fetchFn: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly uploadBaseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;
  private readonly remoteNamespace: string | null;
  private readonly assertCurrent: () => void;
  private readonly storageSpace: 'appDataFolder' | 'drive';
  private readonly optionsRootFolderId: string | null;
  private metrics = EMPTY_METRICS();
  private rootFolderId: string | null = null;
  private objectsFolderId: string | null = null;
  private workspacesFolderId: string | null = null;
  private workspaceFolders = new Map<string, string>();
  private manifestFiles = new Map<string, DriveFile>();
  private missingManifests = new Set<string>();
  private objectFiles = new Map<string, DriveFile>();
  private objectIndexPromise: Promise<void> | null = null;
  private objectIndexLoaded = false;
  private rootJsonFiles = new Map<string, DriveFile>();
  private workspaceJsonFiles = new Map<string, DriveFile>();
  private tokenRefreshPromise: Promise<string | null> | null = null;
  private validTokenPromise: Promise<string> | null = null;
  private rootPromise: Promise<string> | null = null;
  private folderPromises = new Map<string, Promise<string>>();
  private creationIds = new Map<string, Promise<string>>();

  constructor(options: GoogleDriveProviderOptions = {}) {
    this.tokenProvider = options.tokenProvider ?? (async () => {
      // Electron Drive operations are executed by the narrow main-process
      // bridge below; an OAuth token must never cross into the renderer.
      if (typeof window !== 'undefined' && window.panvas?.cloudsync?.drive) return null;
      return getBrowserGoogleToken();
    });
    this.tokenRefresher = options.tokenRefresher ?? (async () => {
      if (typeof window !== 'undefined' && window.panvas?.cloudsync?.drive) return null;
      return refreshBrowserGoogleToken();
    });
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE;
    this.uploadBaseUrl = options.uploadBaseUrl ?? DEFAULT_UPLOAD_BASE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
    this.maxRetries = Math.max(0, Math.min(5, options.maxRetries ?? 3));
    this.sleepFn = options.sleepFn ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.randomFn = options.randomFn ?? Math.random;
    this.remoteNamespace = options.remoteNamespace?.trim() || null;
    this.assertCurrent = options.assertCurrent ?? (() => {});
    this.storageSpace = options.storageSpace ?? (this.remoteNamespace === 'sync-v2' ? 'appDataFolder' : 'drive');
    this.optionsRootFolderId = options.rootFolderId ?? null;
  }

  resetRequestMetrics(): void { this.metrics = EMPTY_METRICS(); }
  getRequestMetrics(): ProviderRequestMetrics { return { ...this.metrics }; }

  private electronDrive() {
    if (typeof window === 'undefined') return undefined;
    return this.remoteNamespace === 'sync-v2'
      ? (window.panvas?.cloudsync as any)?.driveV2
      : window.panvas?.cloudsync?.drive;
  }

  private async unwrapElectronDrive<T>(resultPromise: Promise<
    { success: true; value: T }
    | { success: false; errorCode: import('./errors.ts').CloudErrorCode; diagnostic: import('./types.ts').SafeCloudDiagnostic }
  >): Promise<T> {
    const result = await resultPromise;
    if (!result.success) {
      if (result.errorCode === 'conflict') throw new ProviderConflictError();
      if (result.errorCode === 'auth-expired') throw new AuthExpiredError();
      if (result.errorCode === 'rate-limited') throw new RateLimitedError();
      if (result.diagnostic.status) {
        throw new GoogleDriveApiError({
          stage: result.diagnostic.stage,
          status: result.diagnostic.status,
          reason: result.diagnostic.reason,
          message: 'Google Drive operation failed.',
        });
      }
      if (result.errorCode === 'offline' || result.diagnostic.retryable) throw new GoogleDriveTimeoutError(result.diagnostic.stage);
      throw new CloudOperationError(result.errorCode, result.diagnostic);
    }
    return result.value;
  }

  async connect(): Promise<ProviderConnectionInfo> {
    if (typeof window !== 'undefined' && window.panvas?.cloudsync?.connect) {
      const result = await window.panvas.cloudsync.connect('googledrive');
      if (!result.success || !result.connection) throw new CloudOperationError(result.errorCode ?? 'connection', result.diagnostic ?? { stage: 'authorization', reason: 'connection_failed' });
      this.adoptConnection(result.connection);
      return result.connection;
    }
    const connection = await connectBrowserGoogle();
    this.adoptConnection(connection);
    return connection;
  }

  async disconnect(): Promise<void> {
    this.clearCaches();
    if (typeof localStorage !== 'undefined') for (const key of ['panvas_gdrive_root_id', 'panvas_gdrive_objects_id', 'panvas_gdrive_workspaces_id', 'panvas_gdrive_account_id']) localStorage.removeItem(key);
    if (typeof window !== 'undefined' && window.panvas?.cloudsync?.disconnect) await window.panvas.cloudsync.disconnect('googledrive');
    else await disconnectBrowserGoogle();
  }

  async getAccountInfo(): Promise<ProviderConnectionInfo | null> {
    const connection = typeof window !== 'undefined' && window.panvas?.cloudsync?.getConnection
      ? await window.panvas.cloudsync.getConnection('googledrive')
      : getBrowserGoogleConnection();
    if (connection) this.adoptConnection(connection);
    return connection;
  }

  async ensureAppRoot(): Promise<string> {
    const electronDrive = this.electronDrive();
    if (electronDrive) return this.unwrapElectronDrive(electronDrive.ensureAppRoot());
    if (this.rootFolderId && this.objectsFolderId && this.workspacesFolderId) return this.rootFolderId;
    // Older persistent folder hints were not account-scoped or validated.
    // Discover once per provider lifetime instead of trusting those hints.
    this.rootPromise ??= this.discoverAppRoot().finally(() => { this.rootPromise = null; });
    return this.rootPromise;
  }

  private async discoverAppRoot(): Promise<string> {
    const parent = this.storageSpace === 'appDataFolder' ? 'appDataFolder' : 'root';
    const panvasRootId = this.optionsRootFolderId ?? await this.findOrCreateFolder('Panvas', parent);
    const rootId = this.remoteNamespace ? await this.findOrCreateFolder(this.remoteNamespace, panvasRootId) : panvasRootId;
    const [objectsId, workspacesId] = await Promise.all([this.findOrCreateFolder('objects', rootId), this.findOrCreateFolder('workspaces', rootId)]);
    this.rootFolderId = rootId; this.objectsFolderId = objectsId; this.workspacesFolderId = workspacesId;
    return rootId;
  }

  async findCandidatePanvasRoots(): Promise<DriveFile[]> {
    const electronDrive = this.electronDrive() as any;
    if (electronDrive?.findCandidatePanvasRoots) return this.unwrapElectronDrive(electronDrive.findCandidatePanvasRoots());
    const token = await this.getValidToken();
    const query = `name = 'Panvas' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents`;
    const response = await this.request('Candidate Panvas roots discovery', `${this.apiBaseUrl}/files?q=${encodeURIComponent(query)}&spaces=drive&fields=files(id,name,modifiedTime)`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) await this.handleHttpError(response, 'Candidate Panvas roots discovery');
    return (await response.json()).files ?? [];
  }

  async readManifest(workspaceId: string): Promise<RemoteManifestRead> {
    const electronDrive = this.electronDrive();
    if (electronDrive) return this.unwrapElectronDrive(electronDrive.readManifest(workspaceId));
    await this.ensureAppRoot();
    const wsFolderId = await this.ensureWorkspaceFolder(workspaceId);
    // Refresh metadata on every cycle. If file ID is already known, read direct metadata
    // with strong consistency instead of depending on search index latency.
    const cached = this.manifestFiles.get(workspaceId);
    const file = (cached && cached.id)
      ? await this.getFileMetadata(cached.id) ?? await this.findFile('manifest.json', wsFolderId)
      : await this.findFile('manifest.json', wsFolderId);
    if (!file) { this.missingManifests.add(workspaceId); return { manifest: null, etag: null }; }
    this.manifestFiles.set(workspaceId, file); this.missingManifests.delete(workspaceId);
    const token = await this.getValidToken();
    const response = await this.request(`Manifest download for workspace "${workspaceId}"`, `${this.apiBaseUrl}/files/${file.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 404) { this.manifestFiles.delete(workspaceId); this.missingManifests.add(workspaceId); return { manifest: null, etag: null }; }
    if (!response.ok) await this.handleHttpError(response, `Manifest download for workspace "${workspaceId}"`);
    const text = await response.text();
    try { return { manifest: JSON.parse(text), etag: this.etag(file) }; }
    catch { return { manifest: { format: 'corrupt' } as any, etag: file.id }; }
  }

  async writeManifest(workspaceId: string, manifest: SyncManifestV1, ifMatch: string | null): Promise<{ etag: string }> {
    const electronDrive = this.electronDrive();
    if (electronDrive) return this.unwrapElectronDrive(electronDrive.writeManifest(workspaceId, manifest, ifMatch));
    await this.ensureAppRoot();
    const wsFolderId = await this.ensureWorkspaceFolder(workspaceId);
    // Re-read current metadata immediately before writing so a manifest changed by
    // another device is rejected instead of being overwritten with stale state.
    const cached = this.manifestFiles.get(workspaceId);
    let file = (cached && cached.id)
      ? await this.getFileMetadata(cached.id) ?? await this.findFile('manifest.json', wsFolderId)
      : await this.findFile('manifest.json', wsFolderId);
    const content = JSON.stringify(manifest, null, 2);
    if (file) {
      if (ifMatch !== null && ifMatch !== this.etag(file)) throw new ProviderConflictError();
      const token = await this.getValidToken();
      const response = await this.request(`Manifest update for workspace "${workspaceId}"`, `${this.uploadBaseUrl}/files/${file.id}?uploadType=media&fields=id,name,size,md5Checksum,version,modifiedTime`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: content });
      if (!response.ok) await this.handleHttpError(response, `Manifest update for workspace "${workspaceId}"`);
      const updated = await response.json() as DriveFile;
      file = { ...file, ...updated }; this.manifestFiles.set(workspaceId, file);
      return { etag: this.etag(file) };
    }
    if (ifMatch !== null) throw new ProviderConflictError();
    const token = await this.getValidToken();
    const created = await this.createFileMultipart({ name: 'manifest.json', parentFolderId: wsFolderId, mimeType: 'application/json', content: new TextEncoder().encode(content), token });
    file = { ...created, name: 'manifest.json' }; this.manifestFiles.set(workspaceId, file); this.missingManifests.delete(workspaceId);
    return { etag: this.etag(file) };
  }

  async readRootJson<T>(name: string): Promise<{ value: T | null; etag: string | null }> {
    const electronDrive = this.electronDrive() as any;
    if (electronDrive?.readRootJson) return this.unwrapElectronDrive(electronDrive.readRootJson(name));
    await this.ensureAppRoot();
    const cached = this.rootJsonFiles.get(name);
    const file = (cached ? await this.getFileMetadata(cached.id) : null) ?? await this.findFile(name, this.rootFolderId!);
    if (!file) return { value: null, etag: null };
    this.rootJsonFiles.set(name, file);
    return this.downloadJson<T>(file, `Root file ${name}`);
  }

  async writeRootJson(name: string, value: unknown, ifMatch: string | null): Promise<{ etag: string }> {
    const electronDrive = this.electronDrive() as any;
    if (electronDrive?.writeRootJson) return this.unwrapElectronDrive(electronDrive.writeRootJson(name, value, ifMatch));
    await this.ensureAppRoot();
    return this.writeJson(name, this.rootFolderId!, value, ifMatch, this.rootJsonFiles);
  }

  async readWorkspaceJson<T>(workspaceId: string, name: string): Promise<{ value: T | null; etag: string | null }> {
    const electronDrive = this.electronDrive() as any;
    if (electronDrive?.readWorkspaceJson) return this.unwrapElectronDrive(electronDrive.readWorkspaceJson(workspaceId, name));
    await this.ensureAppRoot();
    const folderId = await this.ensureWorkspaceFolder(workspaceId);
    const key = `${workspaceId}:${name}`;
    const cached = this.workspaceJsonFiles.get(key);
    const file = (cached ? await this.getFileMetadata(cached.id) : null) ?? await this.findFile(name, folderId);
    if (!file) return { value: null, etag: null };
    this.workspaceJsonFiles.set(key, file);
    return this.downloadJson<T>(file, `Workspace file ${name}`);
  }

  async writeWorkspaceJson(workspaceId: string, name: string, value: unknown, ifMatch: string | null): Promise<{ etag: string }> {
    const electronDrive = this.electronDrive() as any;
    if (electronDrive?.writeWorkspaceJson) return this.unwrapElectronDrive(electronDrive.writeWorkspaceJson(workspaceId, name, value, ifMatch));
    await this.ensureAppRoot();
    const folderId = await this.ensureWorkspaceFolder(workspaceId);
    return this.writeJson(name, folderId, value, ifMatch, this.workspaceJsonFiles, `${workspaceId}:${name}`);
  }

  async getObject(_workspaceId: string, hash: string): Promise<Uint8Array> {
    const electronDrive = this.electronDrive();
    if (electronDrive) return this.unwrapElectronDrive(electronDrive.getObject(_workspaceId, hash));
    await this.ensureAppRoot();
    const objectFile = await this.resolveObjectFile(hash);
    if (!objectFile) throw new CloudOperationError('sync', { stage: 'object-download', reason: 'remote-object-missing', operation: 'download', retryable: false });
    const token = await this.getValidToken();
    const response = await this.request(`Object download for "${hash}"`, `${this.apiBaseUrl}/files/${objectFile.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } }, this.uploadTimeoutMs);
    if (!response.ok) await this.handleHttpError(response, `Object download for "${hash}"`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async putObjectIfAbsent(workspaceId: string, upload: ObjectUpload): Promise<ObjectPutResult> {
    const electronDrive = this.electronDrive();
    if (electronDrive) return this.unwrapElectronDrive(electronDrive.putObjectIfAbsent(workspaceId, upload));
    await this.ensureAppRoot();
    // Upload callers use the shared object index as their idempotency check.
    // Manifest validation re-checks stale entries before a repair reaches this
    // path, so avoid an extra Drive search for every object upload.
    await this.ensureObjectIndex();
    const existing = this.objectFiles.get(upload.hash);
    if (existing) { this.objectFiles.set(upload.hash, existing); return 'present'; }
    if (upload.bytes.byteLength >= LARGE_OBJECT_BYTES) await this.uploadLargeObject(workspaceId, upload);
    else {
      const token = await this.getValidToken();
      const created = await this.createFileMultipart({ name: upload.hash, parentFolderId: this.objectsFolderId!, mimeType: 'application/octet-stream', content: upload.bytes, token });
      this.objectFiles.set(upload.hash, { ...created, name: upload.hash });
    }
    return 'uploaded';
  }

  async uploadLargeObject(_workspaceId: string, upload: ObjectUpload): Promise<void> {
    await this.ensureAppRoot();
    const token = await this.getValidToken();
    const id = await this.creationId(upload.hash, this.objectsFolderId!);
    const initResponse = await this.request(`Initiating resumable upload for "${upload.hash}"`, `${this.uploadBaseUrl}/files?uploadType=resumable&fields=id,name,size,md5Checksum,version,modifiedTime`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(upload.bytes.byteLength) }, body: JSON.stringify({ id, name: upload.hash, parents: [this.objectsFolderId!] }) }, this.uploadTimeoutMs);
    if (initResponse.status === 409) {
      const existing = await this.getFileMetadata(id);
      if (existing) { this.objectFiles.set(upload.hash, existing); return; }
    }
    if (!initResponse.ok) await this.handleHttpError(initResponse, `Initiating resumable upload for "${upload.hash}"`);
    const sessionUri = initResponse.headers.get('Location');
    if (!sessionUri) throw new Error('Resumable upload session URI missing from Google Drive response');
    const uploadResponse = await this.request(`Uploading resumable payload for "${upload.hash}"`, sessionUri, { method: 'PUT', headers: { 'Content-Length': String(upload.bytes.byteLength), 'Content-Type': 'application/octet-stream' }, body: upload.bytes as unknown as BodyInit }, this.uploadTimeoutMs);
    if (!uploadResponse.ok) await this.handleHttpError(uploadResponse, `Uploading resumable payload for "${upload.hash}"`);
    const file = await uploadResponse.json().catch(() => null) as DriveFile | null;
    if (file?.id) this.objectFiles.set(upload.hash, { ...file, name: upload.hash });
  }

  async deleteObject(_workspaceId: string, hash: string): Promise<void> {
    const electronDrive = this.electronDrive();
    if (electronDrive) { await this.unwrapElectronDrive(electronDrive.deleteObject(_workspaceId, hash)); return; }
    await this.ensureAppRoot(); await this.ensureObjectIndex(); const file = this.objectFiles.get(hash); if (!file) return;
    const token = await this.getValidToken(); const response = await this.request(`Object deletion for "${hash}"`, `${this.apiBaseUrl}/files/${file.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok && response.status !== 404) await this.handleHttpError(response, `Object deletion for "${hash}"`); this.objectFiles.delete(hash);
  }

  async moveObject(_workspaceId: string, fromHash: string, toHash: string): Promise<void> {
    const electronDrive = this.electronDrive();
    if (electronDrive) { await this.unwrapElectronDrive(electronDrive.moveObject(_workspaceId, fromHash, toHash)); return; }
    await this.ensureAppRoot(); await this.ensureObjectIndex(); const file = this.objectFiles.get(fromHash); if (!file) return;
    const token = await this.getValidToken(); const response = await this.request(`Object rename from "${fromHash}"`, `${this.apiBaseUrl}/files/${file.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ name: toHash }) });
    if (!response.ok) await this.handleHttpError(response, `Object rename from "${fromHash}"`); this.objectFiles.delete(fromHash); this.objectFiles.set(toHash, { ...file, name: toHash });
  }

  async getMetadata(_workspaceId: string, hash: string): Promise<{ size: number } | null> {
    const electronDrive = this.electronDrive();
    if (electronDrive) return this.unwrapElectronDrive(electronDrive.getMetadata(_workspaceId, hash));
    await this.ensureAppRoot();
    // Revalidate cached entries as well as misses. A prior run can have indexed
    // a file that was removed or never completed, and stale metadata must not
    // make a broken manifest look healthy.
    const file = await this.resolveObjectFile(hash);
    if (!file || file.size === undefined) return null;
    return { size: Number(file.size) };
  }

  async listRemoteWorkspaces(): Promise<RemoteWorkspaceSummary[]> {
    const electronDrive = this.electronDrive();
    if (electronDrive) return this.unwrapElectronDrive(electronDrive.listRemoteWorkspaces());
    await this.ensureAppRoot();
    const token = await this.getValidToken();
    const query = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${this.workspacesFolderId}' in parents`;
    const response = await this.request('Remote workspace discovery', `${this.apiBaseUrl}/files?q=${encodeURIComponent(query)}&spaces=${this.storageSpace}&pageSize=1000&fields=files(id,name,modifiedTime)`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) await this.handleHttpError(response, 'Remote workspace discovery');
    const rawFiles: DriveFile[] = (await response.json()).files ?? [];
    const validFolders = rawFiles.filter((file: DriveFile) => file.name !== 'default' && /^ws-[A-Za-z0-9_-]+$/.test(file.name));
    const uniqueByWorkspace = new Map<string, DriveFile>();
    for (const folder of validFolders) {
      const current = uniqueByWorkspace.get(folder.name);
      if (!current || String(folder.modifiedTime ?? '') > String(current.modifiedTime ?? '')) uniqueByWorkspace.set(folder.name, folder);
    }
    const summaries: RemoteWorkspaceSummary[] = [];
    for (const folder of uniqueByWorkspace.values()) {
      this.workspaceFolders.set(folder.name, folder.id);
      summaries.push({ workspaceId: folder.name, name: folder.name, revision: 0, generatedAt: folder.modifiedTime ?? '', recordCount: 0 });
    }
    return summaries.sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  }

  private async downloadJson<T>(file: DriveFile, stage: string): Promise<{ value: T | null; etag: string | null }> {
    const token = await this.getValidToken();
    const response = await this.request(stage, `${this.apiBaseUrl}/files/${file.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) await this.handleHttpError(response, stage);
    try { return { value: await response.json() as T, etag: this.etag(file) }; }
    catch { throw new Error(`${stage} contains invalid JSON.`); }
  }

  private async writeJson(name: string, parentFolderId: string, value: unknown, ifMatch: string | null, cache: Map<string, DriveFile>, cacheKey = name): Promise<{ etag: string }> {
    let file = cache.get(cacheKey) ?? await this.findFile(name, parentFolderId);
    const content = JSON.stringify(value);
    if (file) {
      let current = await this.getFileMetadata(file.id);
      if (!current) {
        if (ifMatch !== null) throw new ProviderConflictError();
        current = await this.findFile(name, parentFolderId);
      }
      if (current) {
        if (ifMatch !== null && ifMatch !== this.etag(current)) throw new ProviderConflictError();
      } else {
        file = null;
      }
      if (!current) {
        const token = await this.getValidToken();
        file = { ...await this.createFileMultipart({ name, parentFolderId, mimeType: 'application/json', content: new TextEncoder().encode(content), token }), name };
        cache.set(cacheKey, file);
        return { etag: this.etag(file) };
      }
      const token = await this.getValidToken();
      const response = await this.request(`JSON update for ${name}`, `${this.uploadBaseUrl}/files/${current.id}?uploadType=media&fields=id,name,size,md5Checksum,version,modifiedTime`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: content });
      if (!response.ok) await this.handleHttpError(response, `JSON update for ${name}`);
      file = { ...current, ...await response.json() as DriveFile };
    } else {
      if (ifMatch !== null) throw new ProviderConflictError();
      const token = await this.getValidToken();
      file = { ...await this.createFileMultipart({ name, parentFolderId, mimeType: 'application/json', content: new TextEncoder().encode(content), token }), name };
    }
    cache.set(cacheKey, file);
    return { etag: this.etag(file) };
  }

  private async resolveObjectFile(hash: string, validateCached = true): Promise<DriveFile | null> {
    await this.ensureObjectIndex();
    const cached = this.objectFiles.get(hash);
    if (cached) {
      if (!validateCached) return cached;
      const current = await this.getFileMetadata(cached.id);
      if (current) {
        this.objectFiles.set(hash, current);
        return current;
      }
      this.objectFiles.delete(hash);
    }
    const file = await this.findFile(hash, this.objectsFolderId!);
    if (file) this.objectFiles.set(hash, file);
    return file;
  }

  private async ensureObjectIndex(): Promise<void> {
    if (this.objectIndexLoaded) return;
    if (this.objectIndexPromise) return this.objectIndexPromise;
    this.objectIndexPromise = (async () => {
      const token = await this.getValidToken();
      let pageToken: string | undefined;
      do {
        const query = `trashed = false and '${escapeQuery(this.objectsFolderId!)}' in parents`;
        const params = new URLSearchParams({ q: query, spaces: this.storageSpace, pageSize: '1000', fields: 'nextPageToken,files(id,name,size,md5Checksum,version,modifiedTime,mimeType)' });
        if (pageToken) params.set('pageToken', pageToken);
        const response = await this.request('Object index discovery', `${this.apiBaseUrl}/files?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) await this.handleHttpError(response, 'Object index discovery');
        const page = await response.json() as { files?: DriveFile[]; nextPageToken?: string };
        for (const file of page.files ?? []) if (/^[a-f0-9]{64}$/i.test(file.name)) this.objectFiles.set(file.name, file);
        pageToken = page.nextPageToken;
      } while (pageToken);
      this.objectIndexLoaded = true;
    })().finally(() => { this.objectIndexPromise = null; });
    return this.objectIndexPromise;
  }

  private async ensureWorkspaceFolder(workspaceId: string): Promise<string> {
    if (workspaceId === 'default') throw new Error('Legacy default workspace is not a canonical sync target.');
    const cached = this.workspaceFolders.get(workspaceId); if (cached) return cached;
    let pending = this.folderPromises.get(workspaceId);
    if (!pending) {
      pending = this.findOrCreateFolder(workspaceId, this.workspacesFolderId!).then(folder => {
        this.workspaceFolders.set(workspaceId, folder); return folder;
      }).finally(() => { this.folderPromises.delete(workspaceId); });
      this.folderPromises.set(workspaceId, pending);
    }
    return pending;
  }

  private async findOrCreateFolder(name: string, parentFolderId: string): Promise<string> {
    const token = await this.getValidToken();
    const parent = parentFolderId === 'root'
      ? "'root' in parents"
      : parentFolderId === 'appDataFolder'
        ? "'appDataFolder' in parents"
        : `'${escapeQuery(parentFolderId)}' in parents`;
    const query = `name = '${escapeQuery(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and ${parent}`;
    const search = await this.request(`Folder search for "${name}"`, `${this.apiBaseUrl}/files?q=${encodeURIComponent(query)}&spaces=${this.storageSpace}&fields=files(id,name)`, { headers: { Authorization: `Bearer ${token}` } });
    if (!search.ok) await this.handleHttpError(search, `Folder search for "${name}"`);
    const found = (await search.json()).files?.[0]; if (found) return found.id;
    const id = await this.creationId(name, parentFolderId);
    const metadata: Record<string, unknown> = { id, name, mimeType: 'application/vnd.google-apps.folder' };
    if (parentFolderId !== 'root') metadata.parents = [parentFolderId];
    const created = await this.request(`Folder creation for "${name}"`, `${this.apiBaseUrl}/files?fields=id,name`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(metadata) });
    if (created.status === 409 && await this.getFileMetadata(id)) return id;
    if (!created.ok) await this.handleHttpError(created, `Folder creation for "${name}"`); return (await created.json()).id;
  }

  private async getFileMetadata(fileId: string): Promise<DriveFile | null> {
      const token = await this.getValidToken();
      const response = await this.request(`File metadata for "${fileId}"`, `${this.apiBaseUrl}/files/${fileId}?fields=id,name,size,md5Checksum,version,modifiedTime,trashed,mimeType`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 404) return null;
      if (!response.ok) await this.handleHttpError(response, `File metadata for "${fileId}"`);
      const file = await response.json() as DriveFile & { trashed?: boolean };
      if (file.trashed) return null;
      return file;
  }

  private async findFile(name: string, parentFolderId: string): Promise<DriveFile | null> {
    const token = await this.getValidToken(); const query = `name = '${escapeQuery(name)}' and trashed = false and '${escapeQuery(parentFolderId)}' in parents`;
    const response = await this.request(`File search for "${name}"`, `${this.apiBaseUrl}/files?q=${encodeURIComponent(query)}&spaces=${this.storageSpace}&fields=files(id,name,size,md5Checksum,version,modifiedTime,mimeType)`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) await this.handleHttpError(response, `File search for "${name}"`); return (await response.json()).files?.[0] ?? null;
  }

  private async createFileMultipart(input: { name: string; parentFolderId: string; mimeType: string; content: Uint8Array; token: string }): Promise<DriveFile> {
    const id = await this.creationId(input.name, input.parentFolderId);
    const boundary = `-------PanvasBoundary${Date.now()}${Math.floor(this.randomFn() * 1e6)}`;
    const header = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ id, name: input.name, parents: [input.parentFolderId] })}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`);
    const footer = new TextEncoder().encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(header.length + input.content.length + footer.length); body.set(header); body.set(input.content, header.length); body.set(footer, header.length + input.content.length);
    const response = await this.request(`File upload for "${input.name}"`, `${this.uploadBaseUrl}/files?uploadType=multipart&fields=id,name,size,md5Checksum,version,modifiedTime`, { method: 'POST', headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: body as unknown as BodyInit }, this.uploadTimeoutMs);
    if (response.status === 409) {
      const existing = await this.getFileMetadata(id);
      if (existing) return existing;
    }
    if (!response.ok) await this.handleHttpError(response, `File upload for "${input.name}"`); return response.json();
  }

  private creationId(name: string, parent: string): Promise<string> {
    const key = `${parent}:${name}`;
    let pending = this.creationIds.get(key);
    if (!pending) {
      pending = (async () => {
        const token = await this.getValidToken();
        const response = await this.request('File ID allocation', `${this.apiBaseUrl}/files/generateIds?count=1&space=${this.storageSpace}&type=files`, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) await this.handleHttpError(response, 'File ID allocation');
        const id = (await response.json()).ids?.[0];
        if (typeof id !== 'string' || !id) throw new CloudOperationError('sync', { stage: 'file-id-allocation', reason: 'missing-file-id', retryable: true });
        return id;
      })().catch(error => { this.creationIds.delete(key); throw error; });
      this.creationIds.set(key, pending);
    }
    return pending;
  }

  private async refreshToken(): Promise<string | null> {
    this.tokenRefreshPromise ??= this.tokenRefresher().finally(() => { this.tokenRefreshPromise = null; });
    return this.tokenRefreshPromise;
  }

  private async getValidToken(): Promise<string> {
    this.assertCurrent();
    this.validTokenPromise ??= (async () => {
      const token = await this.tokenProvider() ?? await this.refreshToken();
      if (!token) throw new AuthExpiredError();
      return token;
    })().finally(() => { this.validTokenPromise = null; });
    return this.validTokenPromise;
  }
  private etag(file: DriveFile): string { return file.md5Checksum || file.version || file.modifiedTime || file.id; }
  private adoptConnection(connection: ProviderConnectionInfo): void {
    this.clearCaches();
    if (typeof localStorage === 'undefined') return;
    const priorAccount = localStorage.getItem('panvas_gdrive_account_id');
    if (priorAccount !== connection.accountIdentifier) {
      for (const key of ['panvas_gdrive_root_id', 'panvas_gdrive_objects_id', 'panvas_gdrive_workspaces_id']) localStorage.removeItem(key);
    }
    localStorage.setItem('panvas_gdrive_account_id', connection.accountIdentifier);
  }

  clearCaches(): void {
    this.validTokenPromise = null;
    this.tokenRefreshPromise = null;
    this.rootPromise = null;
    this.rootFolderId = null;
    this.objectsFolderId = null;
    this.workspacesFolderId = null;
    this.workspaceFolders.clear();
    this.folderPromises.clear();
    this.creationIds.clear();
    this.manifestFiles.clear();
    this.missingManifests.clear();
    this.objectFiles.clear();
    this.rootJsonFiles.clear();
    this.workspaceJsonFiles.clear();
    this.objectIndexPromise = null;
    this.objectIndexLoaded = false;
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const seconds = Number(retryAfter); const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(parsed) && parsed > 0) return Math.min(30_000, parsed);
    }
    return Math.min(30_000, 500 * 2 ** attempt) * (0.8 + this.randomFn() * 0.4);
  }

  private async request(stage: string, url: string, init: RequestInit = {}, timeoutMs = this.requestTimeoutMs): Promise<Response> {
    let requestInit = init;
    let authRetried = false;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      this.assertCurrent();
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      this.metrics.requests += 1;
      try {
        const response = await Promise.race([
          this.fetchFn(url, { ...requestInit, signal: controller.signal }),
          new Promise<never>((_, reject) => { timeoutId = setTimeout(() => { controller.abort(); reject(new GoogleDriveTimeoutError(stage)); }, timeoutMs); }),
        ]);
        if (timeoutId) clearTimeout(timeoutId);
        if (response.status === 401 && !authRetried) {
          authRetried = true;
          const refreshedToken = await this.refreshToken();
          if (refreshedToken) {
            const headers = new Headers(requestInit.headers);
            headers.set('Authorization', `Bearer ${refreshedToken}`);
            requestInit = { ...requestInit, headers };
            this.metrics.retries += 1;
            attempt -= 1;
            continue;
          }
        }
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt === this.maxRetries) return response;
        const delay = this.retryDelay(response, attempt); this.metrics.retries += 1; this.metrics.backoffMs += Math.round(delay); await this.sleepFn(delay);
      } catch (error) {
        if (timeoutId) clearTimeout(timeoutId);
        const timedOut = error instanceof GoogleDriveTimeoutError || (error as Error)?.name === 'AbortError';
        if (timedOut) this.metrics.timeouts += 1;
        if (attempt === this.maxRetries || (!timedOut && (error as Error)?.name !== 'TypeError')) throw error;
        const delay = Math.min(30_000, 500 * 2 ** attempt) * (0.8 + this.randomFn() * 0.4); this.metrics.retries += 1; this.metrics.backoffMs += Math.round(delay); await this.sleepFn(delay);
      }
    }
    throw new Error(`${stage} failed after bounded retries.`);
  }

  private async handleHttpError(response: Response, stage: string): Promise<never> {
    if (response.status === 401) throw new AuthExpiredError();
    if (response.status === 412) throw new ProviderConflictError();
    if (response.status === 429) throw new RateLimitedError();
    let reason = response.statusText || 'unknown'; let message = `HTTP ${response.status}`;
    try { const text = await response.text(); if (text) { try { const json = JSON.parse(text); message = json.error?.message || message; reason = json.error?.errors?.[0]?.reason || json.error?.status || reason; } catch { message = text.substring(0, 120).replace(/\s+/g, ' '); } } } catch { /* sanitized fallback */ }
    if (response.status === 403 && (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || reason === 'insufficient_scope' || message.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || message.toLowerCase().includes('insufficient scope'))) {
      throw new AuthExpiredError('Google authorization lacks required scope. Re-authentication required.');
    }
    throw new GoogleDriveApiError({ stage, status: response.status, reason, message });
  }
}
