import type { SyncV2Catalog, SyncV2Manifest, SyncV2Profile, SyncV2Provider } from './types.ts';
import { GoogleDriveSyncProvider } from '../googleDriveProvider.ts';

export interface LegacyCandidateRoot {
  id: string;
  name: string;
  modifiedTime?: string;
}

export interface CandidateInspector {
  readRootJson<T>(rootFolderId: string, name: string): Promise<{ value: T | null; etag: string | null }>;
  readWorkspaceJson<T>(rootFolderId: string, workspaceId: string, name: string): Promise<{ value: T | null; etag: string | null }>;
  getObject(rootFolderId: string, hash: string): Promise<Uint8Array>;
}

export interface LegacyMigrationOptions {
  accountIdentifier: string;
  localWorkspaceIds: string[];
  canonicalProvider: SyncV2Provider;
  legacyDriveProvider: GoogleDriveSyncProvider;
  inspector?: CandidateInspector;
  assertCurrent?: () => void;
  onProgress?: (message: string) => void;
}

export type LegacyMigrationResult =
  | { status: 'migrated'; workspaceCount: number }
  | { status: 'no-legacy' }
  | { status: 'migration-recovery-required'; reason: string; candidateCount: number };

function createCandidateInspector(legacyDriveProvider: GoogleDriveSyncProvider, assertCurrent?: () => void): CandidateInspector {
  // If running in Electron, check for privileged bridge methods on window.panvas.cloudsync.drive
  const electronDrive = typeof window !== 'undefined' ? (window.panvas?.cloudsync?.drive as any) : undefined;
  if (electronDrive?.readCandidateRootJson && electronDrive?.readCandidateWorkspaceJson && electronDrive?.getCandidateObject) {
    return {
      async readRootJson<T>(rootFolderId: string, name: string) {
        const res = await electronDrive.readCandidateRootJson(rootFolderId, name);
        if (!res.success) throw new Error(`Failed to read root JSON ${name} from candidate ${rootFolderId}`);
        return res.value;
      },
      async readWorkspaceJson<T>(rootFolderId: string, workspaceId: string, name: string) {
        const res = await electronDrive.readCandidateWorkspaceJson(rootFolderId, workspaceId, name);
        if (!res.success) throw new Error(`Failed to read workspace JSON ${name} from candidate ${rootFolderId}`);
        return res.value;
      },
      async getObject(rootFolderId: string, hash: string) {
        const res = await electronDrive.getCandidateObject(rootFolderId, hash);
        if (!res.success) throw new Error(`Failed to get object ${hash} from candidate ${rootFolderId}`);
        return res.value;
      },
    };
  }

  // Node test environment or direct browser environment: instantiate a scoped GoogleDriveSyncProvider
  const scopedProviders = new Map<string, GoogleDriveSyncProvider>();
  const getScopedProvider = (rootFolderId: string) => {
    let p = scopedProviders.get(rootFolderId);
    if (!p) {
      p = new GoogleDriveSyncProvider({
        storageSpace: 'drive',
        remoteNamespace: 'sync-v2',
        rootFolderId,
        tokenProvider: (legacyDriveProvider as any).tokenProvider,
        tokenRefresher: (legacyDriveProvider as any).tokenRefresher,
        fetchFn: (legacyDriveProvider as any).fetchFn,
        apiBaseUrl: (legacyDriveProvider as any).apiBaseUrl,
        uploadBaseUrl: (legacyDriveProvider as any).uploadBaseUrl,
        assertCurrent,
      });
      scopedProviders.set(rootFolderId, p);
    }
    return p;
  };

  return {
    readRootJson<T>(rootFolderId: string, name: string) {
      return getScopedProvider(rootFolderId).readRootJson<T>(name);
    },
    readWorkspaceJson<T>(rootFolderId: string, workspaceId: string, name: string) {
      return getScopedProvider(rootFolderId).readWorkspaceJson<T>(workspaceId, name);
    },
    getObject(rootFolderId: string, hash: string) {
      return getScopedProvider(rootFolderId).getObject('v2', hash);
    },
  };
}

export async function inspectAndMigrateLegacyPanvasRoot(options: LegacyMigrationOptions): Promise<LegacyMigrationResult> {
  const assertCurrent = options.assertCurrent ?? (() => {});
  assertCurrent();

  const candidates: LegacyCandidateRoot[] = await options.legacyDriveProvider.findCandidatePanvasRoots();
  if (!candidates || candidates.length === 0) {
    return { status: 'no-legacy' };
  }

  const inspector = options.inspector ?? createCandidateInspector(options.legacyDriveProvider, assertCurrent);

  interface InspectedCandidate {
    candidate: LegacyCandidateRoot;
    profile: SyncV2Profile | null;
    catalog: SyncV2Catalog;
    matchingWorkspaceCount: number;
  }

  const validCandidates: InspectedCandidate[] = [];

  for (const candidate of candidates) {
    assertCurrent();
    try {
      const [profileRead, catalogRead] = await Promise.all([
        inspector.readRootJson<SyncV2Profile>(candidate.id, 'profile.json').catch(() => ({ value: null, etag: null })),
        inspector.readRootJson<SyncV2Catalog>(candidate.id, 'catalog.json').catch(() => ({ value: null, etag: null })),
      ]);

      const profile = profileRead.value;
      const catalog = catalogRead.value;

      if (!catalog || !Array.isArray(catalog.workspaces) || catalog.workspaces.length === 0) {
        continue;
      }

      if (profile && profile.accountIdentifier && profile.accountIdentifier !== options.accountIdentifier) {
        // Belongs to another Google account
        continue;
      }

      const catalogWorkspaceIds = new Set(catalog.workspaces.map(w => w.workspaceId));
      let matches = 0;
      for (const localId of options.localWorkspaceIds) {
        if (catalogWorkspaceIds.has(localId)) matches += 1;
      }

      validCandidates.push({
        candidate,
        profile,
        catalog,
        matchingWorkspaceCount: matches,
      });
    } catch {
      // Ignore unreadable candidate folder
    }
  }

  if (validCandidates.length === 0) {
    // There were candidate folders, but none contained a usable V2 catalog for this account
    return { status: 'no-legacy' };
  }

  let selected: InspectedCandidate | null = null;

  if (validCandidates.length === 1) {
    selected = validCandidates[0];
  } else {
    // Multiple candidate roots exist. Apply strict proof:
    // Check if exactly one has matching workspace IDs from local desktop
    const matching = validCandidates.filter(c => c.matchingWorkspaceCount > 0);
    if (matching.length === 1) {
      selected = matching[0];
    } else if (matching.length > 1) {
      // Ambiguous: multiple candidates match local workspaces. DO NOT GUESS.
      return { status: 'migration-recovery-required', reason: 'multiple-matching-legacy-roots', candidateCount: matching.length };
    } else {
      // 0 candidates match local workspaces, but multiple valid candidates exist. DO NOT GUESS.
      return { status: 'migration-recovery-required', reason: 'ambiguous-legacy-roots', candidateCount: validCandidates.length };
    }
  }

  assertCurrent();
  options.onProgress?.('Migrating legacy Drive data to canonical storage…');

  // Perform non-destructive copy:
  // 1. Copy each workspace manifest and its immutable object blobs
  for (let i = 0; i < selected.catalog.workspaces.length; i++) {
    assertCurrent();
    const ws = selected.catalog.workspaces[i];
    options.onProgress?.(`Migrating workspace ${i + 1} of ${selected.catalog.workspaces.length}…`);

    const manifestRead = await inspector.readWorkspaceJson<SyncV2Manifest>(selected.candidate.id, ws.workspaceId, 'manifest.json');
    if (!manifestRead.value) continue;

    const manifest = manifestRead.value;
    for (const record of manifest.records ?? []) {
      assertCurrent();
      if (record.hash && !record.tombstone) {
        const existing = await options.canonicalProvider.getObjectMetadata(record.hash);
        if (!existing) {
          const bytes = await inspector.getObject(selected.candidate.id, record.hash);
          await options.canonicalProvider.putObjectIfAbsent(record.hash, bytes);
        }
      }
    }

    await options.canonicalProvider.writeManifest(ws.workspaceId, manifest, null);
  }

  // 2. Copy catalog and profile
  assertCurrent();
  await options.canonicalProvider.writeCatalog(selected.catalog, null);
  if (selected.profile) {
    await options.canonicalProvider.writeProfile(selected.profile, null);
  }

  // NOTE: Legacy folder is NEVER deleted or modified.
  return { status: 'migrated', workspaceCount: selected.catalog.workspaces.length };
}

