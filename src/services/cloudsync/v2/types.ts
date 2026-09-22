import type { RecordPointer, SafeCloudDiagnostic, SyncEntityKind } from '../types.ts';
import type { ScannedSyncEntity } from '../engine.ts';

export interface SyncV2Profile {
  format: 'panvas-sync-v2-profile';
  schemaVersion: 2;
  profileId: string;
  accountIdentifier: string;
}

export interface SyncV2CatalogEntry {
  workspaceId: string;
  manifestRevision: number;
}

export interface SyncV2Catalog {
  format: 'panvas-sync-v2-catalog';
  schemaVersion: 2;
  revision: number;
  workspaces: SyncV2CatalogEntry[];
}

export interface SyncV2Record {
  kind: SyncEntityKind;
  id: string;
  parentId: string | null;
  hash: string | null;
  baseHash: string | null;
  tombstone: boolean;
  encoding?: RecordPointer['encoding'];
}

export interface SyncV2Manifest {
  format: 'panvas-sync-v2-manifest';
  schemaVersion: 2;
  workspaceId: string;
  revision: number;
  records: SyncV2Record[];
}

export interface SyncV2BaselineRecord {
  entityId: string;
  entityKind: SyncEntityKind;
  baseHash: string | null;
  localHash: string | null;
  remoteHash: string | null;
  remoteRevision: number;
  tombstone: boolean;
  /** Semantic identity of the actual local replica after application. */
  localContentHash?: string;
}

export interface SyncV2ProfileState {
  profileId: string;
  accountIdentifier: string;
}

export type SyncV2WorkspaceClassification =
  | 'healthy'
  | 'repairable'
  | 'orphaned'
  | 'ambiguous'
  | 'conflict'
  | 'account-blocked';

export interface SyncV2WorkspaceOutcome {
  workspaceId: string;
  classification: SyncV2WorkspaceClassification;
  status: 'synced' | 'synced-review' | 'conflict' | 'orphaned' | 'error';
  diagnostic?: SafeCloudDiagnostic;
}

type Awaitable<T> = T | Promise<T>;

export interface SyncV2BaselineStore {
  loadProfile(): Awaitable<SyncV2ProfileState | null>;
  saveProfile(profile: SyncV2ProfileState): Awaitable<void>;
  loadWorkspace(workspaceId: string): Awaitable<SyncV2BaselineRecord[]>;
  saveWorkspace(workspaceId: string, records: SyncV2BaselineRecord[]): Awaitable<void>;
  /** Removes the device-local V2 profile and all workspace BASE records. */
  clear?(): Awaitable<void>;
}

export interface SyncV2MigrationConflict {
  conflictId: string;
  profileId: string;
  workspaceId: string;
  entityKind: SyncEntityKind;
  entityId: string;
  parentId: string | null;
  localHash: string;
  remoteHash: string;
  localBytes: Uint8Array;
  /** Optional remote bytes retained for an explicit device-wins recovery. */
  remoteBytes?: Uint8Array;
  /** How an explicit conflict choice was reconciled. */
  resolution?: 'cloud' | 'device' | 'both';
  createdAt: number;
  resolvedAt: number | null;
}

export type SyncV2ConflictChoice = 'cloud' | 'device' | 'both';

export interface SyncV2ConflictResolution {
  workspaceId: string;
  kind: SyncEntityKind;
  id: string;
  choice: SyncV2ConflictChoice;
}

export interface SyncV2ConflictStore {
  preserve(conflict: SyncV2MigrationConflict): Promise<'created' | 'present'>;
  hasUnresolved(profileId: string): Promise<boolean>;
  listUnresolved?(profileId: string): Promise<SyncV2MigrationConflict[]>;
  hasUnresolved(profileId?: string): Promise<boolean>;
  listUnresolved?(profileId?: string): Promise<SyncV2MigrationConflict[]>;
  /** Acknowledges a preserved review without deleting its recovery bytes. */
  resolve?(conflictId: string, profileId: string): Promise<boolean>;
  resolve?(conflictId: string, profileId?: string): Promise<boolean>;
  remove?(conflictId: string): Promise<void>;
  /** Removes device-local review/recovery records during an explicit reset. */
  clear?(): Promise<void>;
}

export interface SyncV2RemoteRead<T> { value: T | null; etag: string | null }

export interface SyncV2Provider {
  readProfile(): Promise<SyncV2RemoteRead<SyncV2Profile>>;
  writeProfile(profile: SyncV2Profile, ifMatch: string | null): Promise<{ etag: string }>;
  readCatalog(): Promise<SyncV2RemoteRead<SyncV2Catalog>>;
  writeCatalog(catalog: SyncV2Catalog, ifMatch: string | null): Promise<{ etag: string }>;
  readManifest(workspaceId: string): Promise<SyncV2RemoteRead<SyncV2Manifest>>;
  writeManifest(workspaceId: string, manifest: SyncV2Manifest, ifMatch: string | null): Promise<{ etag: string }>;
  getObject(hash: string): Promise<Uint8Array>;
  putObjectIfAbsent(hash: string, bytes: Uint8Array): Promise<'uploaded' | 'present'>;
  getObjectMetadata(hash: string): Promise<{ size: number } | null>;
}

export interface SyncV2LocalSource {
  beginCycle?(): void;
  endCycle?(): void;
  /**
   * Only a durable, complete local replica may replace a manifest pointer
   * whose content-addressed object is absent from the remote store. Browser
   * caches deliberately do not have this authority because they may be an
   * old, incomplete replica returning after another device was used.
   */
  canRepairMissingRemoteObjects?(): boolean;
  listWorkspaceIds(): Promise<string[]>;
  scanWorkspace(workspaceId: string): Promise<ScannedSyncEntity[]>;
  scanWorkspaceIncludingUnowned?(workspaceId: string): Promise<ScannedSyncEntity[]>;
  /** Bypasses the cycle snapshot for edit detection and post-apply baselines. */
  scanFreshWorkspace?(workspaceId: string): Promise<ScannedSyncEntity[]>;
  /**
   * Returns only a trusted, canonical workspace-root recovery record. It must
   * never include page/document payloads. Missing or untrusted recovery is
   * represented by null so the engine can quarantine the workspace safely.
   */
  getRecoveryWorkspaceRoot?(workspaceId: string): Promise<ScannedSyncEntity | null>;
}

export interface SyncV2LocalAdapter {
  applyRecord(input: { workspaceId: string; record: SyncV2Record; bytes: Uint8Array | null; allowStaleOwnershipRepair?: boolean }): Promise<void>;
  applyWorkspace?(input: { workspaceId: string; expected: ScannedSyncEntity[]; downloads: Array<{ record: SyncV2Record; bytes: Uint8Array | null }>; allowStaleOwnershipRepair?: boolean; assertCurrent?: () => void }): Promise<void>;
}
