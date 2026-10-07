/**
 * Provider-neutral Cloud Sync core (Phase 1) — shared domain types.
 *
 * Follows docs/SYNC_0_SPEC.md: local-first (a local save never needs a
 * network/account/provider), manifest+object remote layout, renderer stays
 * token-free, deterministic conflicts, no silent content destruction.
 * No provider network code exists in this phase — adapters implement these
 * interfaces in later phases (OneDrive first, then Google Drive).
 */

export type SyncEntityKind =
  | 'workspace'
  | 'folder'
  | 'notebook'
  | 'notebookSection'
  | 'notebookPage'
  | 'pageContent'
  | 'pageDrawing'
  | 'canvasFile'
  | 'canvasScene'
  | 'customBlock'
  | 'asset';

export type JournalOperation = 'create' | 'update' | 'delete' | 'restore';

export type JournalState = 'pending' | 'syncing' | 'synced' | 'superseded' | 'conflict' | 'error';

/** Versioned local journal entry (the outbox). One entity has at most one
 *  superseding pending entry; synced entries become the local revision log. */
export interface SyncJournalEntry {
  readonly entryId: string;
  readonly entityType: SyncEntityKind;
  readonly entityId: string;
  readonly workspaceId: string;
  readonly operation: JournalOperation;
  /** Monotonically increasing per-entity local revision. */
  readonly localRevision: number;
  readonly contentHash: string | null;
  /** Hash this entry was based on (null = create). */
  readonly baseRevision: number | null;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
  /** Tombstones are never auto-purged in v1 (SYNC-0); payload purge is a
   *  separate 30-day Trash lifecycle concern. */
  readonly tombstone: boolean;
  readonly state: JournalState;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly lastErrorClass: string | null;
  /** Opaque payload reference for upload (id only — never note contents). */
  readonly payloadRef: string | null;
}

export interface SyncManifestV1 {
  format: 'panvas-sync';
  schemaVersion: 1;
  workspaceId: string;
  revision: number;
  previousRevision: number | null;
  writerDeviceId: string;
  generatedAt: string; // diagnostic only; never used for conflict ordering
  records: RecordPointer[];
}

export interface RecordPointer {
  kind: SyncEntityKind;
  id: string;
  parentId: string | null;
  revision: number;
  baseRevision: number | null;
  contentHash: string;
  tombstone: boolean;
  /** Binary assets use a self-describing envelope so a fresh device can
   * reconstruct filename, MIME, owner, stable ID, and exact bytes. */
  encoding?: 'asset-envelope-v1';
}

export interface RemoteManifestRead {
  manifest: SyncManifestV1 | null;
  /** Provider concurrency token (ETag equivalent) for ifMatch writes. */
  etag: string | null;
}

export interface ObjectUpload {
  hash: string;
  bytes: Uint8Array;
}

export type ObjectPutResult = 'uploaded' | 'present';

export interface RemoteWorkspaceSummary {
  workspaceId: string;
  name: string;
  revision: number;
  generatedAt: string;
  recordCount: number;
}

/** Non-secret, device-local attachment metadata. Workspace identity remains
 * the stable Panvas workspaceId; provider/account fields only prevent a local
 * replica from being synchronized to the wrong cloud connection. */
export interface CloudWorkspaceBinding {
  workspaceId: string;
  provider: 'googledrive';
  providerAccountId: string;
  remoteWorkspaceId: string;
  lastKnownRemoteRevision: number;
  attachedAt: number;
}

export type WorkspaceCloudStatus =
  | 'local-only'
  | 'connected'
  | 'syncing'
  | 'synced'
  | 'synced-review'
  | 'account-migration-required'
  | 'offline'
  | 'conflict'
  | 'auth-expired'
  | 'rate-limited'
  | 'error';

export interface SafeCloudDiagnostic {
  provider: 'googledrive';
  workspaceId?: string;
  stage: string;
  status?: number;
  reason: string;
  entityKind?: SyncEntityKind;
  entityId?: string;
  /** Non-secret record metadata used to diagnose apply failures. */
  schemaVersion?: string;
  parentId?: string | null;
  errorClass?: string;
  throwingFunction?: string;
  errorMessage?: string;
  operation?: string;
  retryable: boolean;
}

export interface ProviderRequestMetrics {
  requests: number;
  retries: number;
  backoffMs: number;
  timeouts: number;
}

/** Provider-neutral adapter contract (SYNC-0 §adapter operations). All
 *  methods may throw typed provider errors; the engine owns retries. */
export interface CloudSyncProvider {
  readonly id: 'onedrive' | 'googledrive' | 'dropbox';
  /** Stable within a provider; never a Panvas identity. */
  connect(): Promise<ProviderConnectionInfo>;
  disconnect(): Promise<void>;
  getAccountInfo(): Promise<ProviderConnectionInfo | null>;
  ensureAppRoot(): Promise<string>;
  readManifest(workspaceId: string): Promise<RemoteManifestRead>;
  /** Optimistic concurrency: throws ProviderConflictError when etag is stale. */
  writeManifest(workspaceId: string, manifest: SyncManifestV1, ifMatch: string | null): Promise<{ etag: string }>;
  getObject(workspaceId: string, hash: string): Promise<Uint8Array>;
  /** Idempotent content-addressed upload; no-op when the object exists. */
  putObjectIfAbsent(workspaceId: string, upload: ObjectUpload): Promise<ObjectPutResult | void>;
  deleteObject(workspaceId: string, hash: string): Promise<void>;
  moveObject(workspaceId: string, fromHash: string, toHash: string): Promise<void>;
  getMetadata(workspaceId: string, hash: string): Promise<{ size: number } | null>;
  /** Large-file contract: adapters that support resumable upload declare it. */
  readonly supportsResumableUpload: boolean;
  uploadLargeObject?(workspaceId: string, upload: ObjectUpload): Promise<void>;
  /** Panvas-owned workspace folders only. Legacy `default` is excluded. */
  listRemoteWorkspaces?(): Promise<RemoteWorkspaceSummary[]>;
  resetRequestMetrics?(): void;
  getRequestMetrics?(): ProviderRequestMetrics;
}

export interface ProviderConnectionInfo {
  provider: CloudSyncProvider['id'];
  /** Provider-side account identifier (never a Panvas identity). */
  accountIdentifier: string;
  displayName?: string;
  email?: string;
  connectedAt: number;
}

/** Durable, renderer-token-free credential storage contract. Electron will
 *  back this with OS-protected storage in the adapter phases; the browser
 *  build never stores long-lived secrets here. Implementations must redact
 *  tokens from all diagnostics. */
export interface CloudTokenStore {
  storeToken(provider: CloudSyncProvider['id'], token: string): Promise<void>;
  readToken(provider: CloudSyncProvider['id']): Promise<string | null>;
  clearToken(provider: CloudSyncProvider['id']): Promise<void>;
}

export type CloudSyncStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'token-needed'
  | 'syncing'
  | 'synced'
  | 'synced-review'
  | 'account-migration-required'
  | 'offline'
  | 'conflict'
  | 'auth-expired'
  | 'rate-limited'
  | 'error';

export type CloudSyncProgressStage = 'preparing' | 'uploading' | 'updating-manifest' | 'finalizing' | 'downloading' | 'complete';

export interface CloudSyncProgress {
  stage: CloudSyncProgressStage;
  completed: number;
  total: number;
  message: string;
}

/** Least-privilege scopes for the future adapters (documented contract only —
 *  nothing requests them yet). Panvas controls only its own app root. */
export const FUTURE_PROVIDER_SCOPES = {
  googledrive: ['https://www.googleapis.com/auth/drive.file'],
  onedrive: ['Files.ReadWrite.AppFolder'],
} as const;
