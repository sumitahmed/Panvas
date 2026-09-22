import type { ipcMain } from 'electron';
import { GoogleAuthDiagnosticError, googleAuthService } from './google-auth-service.js';
import { GoogleDriveSyncProvider } from '../../src/services/cloudsync/googleDriveProvider.js';
import { presentCloudError } from '../../src/services/cloudsync/errors.js';
import { validateRemoteManifest } from '../../src/services/cloudsync/manifest.js';
import type { ObjectUpload, SyncManifestV1 } from '../../src/services/cloudsync/types.js';
import { requireTrustedSender } from './security.js';
import { SyncRunAuthority } from '../../src/services/cloudsync/runAuthority.js';

const WORKSPACE_ID = /^ws-[A-Za-z0-9_-]+$/;
const OBJECT_HASH = /^[a-f0-9]{64}$/i;

function assertWorkspaceId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !WORKSPACE_ID.test(value)) throw new Error('Invalid workspace identifier.');
}

function assertObjectHash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !OBJECT_HASH.test(value)) throw new Error('Invalid object identifier.');
}

function assertRootFile(name: unknown): asserts name is string {
  if (name !== 'profile.json' && name !== 'catalog.json') throw new Error('Invalid V2 root file.');
}

const driveAuthority = new SyncRunAuthority();
let driveProvider = createDriveProvider(undefined, 'drive');
let driveV2Provider = createDriveProvider('sync-v2', 'drive');

function createDriveProvider(remoteNamespace?: string, storageSpace?: 'appDataFolder' | 'drive'): GoogleDriveSyncProvider {
  return new GoogleDriveSyncProvider({
    tokenProvider: () => googleAuthService.getValidAccessToken(),
    tokenRefresher: () => googleAuthService.forceRefreshAccessToken(),
    remoteNamespace,
    storageSpace,
    assertCurrent: driveAuthority.capture(),
  });
}

function resetDriveProvider(): void {
  driveAuthority.invalidate();
  driveProvider = createDriveProvider(undefined, 'drive');
  driveV2Provider = createDriveProvider('sync-v2', 'drive');
}

async function safeDriveCall<T>(stage: string, operation: () => Promise<T>) {
  try {
    return { success: true as const, value: await operation() };
  } catch (error) {
    const shown = presentCloudError(error, stage);
    return { success: false as const, errorCode: shown.code, diagnostic: shown.diagnostic };
  }
}

type IpcHandleRegistrar = Pick<typeof ipcMain, 'handle'>;

export function registerCloudSyncHandlers(registrar: IpcHandleRegistrar) {
  const registerPrivilegedHandler = (channel: string, handler: (...args: any[]) => unknown): void => {
    registrar.handle(channel, (event, ...args) => {
      requireTrustedSender(event);
      return handler(...args);
    });
  };

  registerPrivilegedHandler('cloudsync:connect', async (provider: string) => {
    if (provider === 'googledrive') {
      try {
        resetDriveProvider();
        const connection = await googleAuthService.startAuthFlow();
        resetDriveProvider();
        return { success: true, connection };
      } catch (error) {
        resetDriveProvider();
        const diagnostic = error instanceof GoogleAuthDiagnosticError
          ? { provider: 'googledrive', stage: error.stage, status: error.status, reason: error.reason, retryable: error.status === 408 || error.status === 429 || Boolean(error.status && error.status >= 500) }
          : { provider: 'googledrive', stage: 'authorization', reason: (error as Error)?.name || 'unknown', retryable: false };
        return { success: false, errorCode: error instanceof GoogleAuthDiagnosticError && error.stage === 'configuration' ? 'configuration' : 'connection', diagnostic };
      }
    }
    return { success: false, errorCode: 'connection', diagnostic: { provider: 'googledrive', stage: 'authorization', reason: 'unsupported_provider', retryable: false } };
  });

  registerPrivilegedHandler('cloudsync:disconnect', async (provider: string) => {
    if (provider === 'googledrive') {
      driveAuthority.invalidate();
      await googleAuthService.disconnect();
      resetDriveProvider();
    }
    return { success: true };
  });

  registerPrivilegedHandler('cloudsync:getConnection', async (provider: string) => {
    if (provider === 'googledrive') return await googleAuthService.getConnectionInfo();
    return null;
  });

  // Keep the filesystem service out of the renderer/SSR import graph. The
  // trusted sender guard runs before this lazy import, so an untrusted invoke
  // cannot initialize or reach privileged filesystem code.
  registerPrivilegedHandler('cloudsync:resetLocalData', async () => {
    const { workspaceService } = await import('./WorkspaceService.js');
    return workspaceService.resetLocalData();
  });

  registerPrivilegedHandler('cloudsync:drive:ensureAppRoot', () => safeDriveCall('drive-root', () => driveProvider.ensureAppRoot()));
  registerPrivilegedHandler('cloudsync:drive:listRemoteWorkspaces', () => safeDriveCall('workspace-discovery', () => driveProvider.listRemoteWorkspaces()));
  registerPrivilegedHandler('cloudsync:drive:readManifest', (workspaceId: unknown) => safeDriveCall('manifest-read', async () => {
    assertWorkspaceId(workspaceId);
    return driveProvider.readManifest(workspaceId);
  }));
  registerPrivilegedHandler('cloudsync:drive:writeManifest', (workspaceId: unknown, manifestValue: unknown, ifMatch: unknown) => safeDriveCall('manifest-publication', async () => {
    assertWorkspaceId(workspaceId);
    const manifest = validateRemoteManifest(manifestValue);
    if (!manifest || manifest.workspaceId !== workspaceId) throw new Error('Invalid sync manifest.');
    if (ifMatch !== null && typeof ifMatch !== 'string') throw new Error('Invalid manifest precondition.');
    return driveProvider.writeManifest(workspaceId, manifest as SyncManifestV1, ifMatch);
  }));
  registerPrivilegedHandler('cloudsync:drive:getObject', (workspaceId: unknown, hash: unknown) => safeDriveCall('object-download', async () => {
    assertWorkspaceId(workspaceId); assertObjectHash(hash);
    return driveProvider.getObject(workspaceId, hash);
  }));
  registerPrivilegedHandler('cloudsync:drive:putObjectIfAbsent', (workspaceId: unknown, uploadValue: unknown) => safeDriveCall('object-transfer', async () => {
    assertWorkspaceId(workspaceId);
    const upload = uploadValue as Partial<ObjectUpload>;
    assertObjectHash(upload?.hash);
    if (!(upload?.bytes instanceof Uint8Array)) throw new Error('Invalid object payload.');
    return driveProvider.putObjectIfAbsent(workspaceId, { hash: upload.hash, bytes: upload.bytes });
  }));
  registerPrivilegedHandler('cloudsync:drive:deleteObject', (workspaceId: unknown, hash: unknown) => safeDriveCall('object-delete', async () => {
    assertWorkspaceId(workspaceId); assertObjectHash(hash);
    await driveProvider.deleteObject(workspaceId, hash);
    return true;
  }));
  registerPrivilegedHandler('cloudsync:drive:moveObject', (workspaceId: unknown, fromHash: unknown, toHash: unknown) => safeDriveCall('object-move', async () => {
    assertWorkspaceId(workspaceId); assertObjectHash(fromHash); assertObjectHash(toHash);
    await driveProvider.moveObject(workspaceId, fromHash, toHash);
    return true;
  }));
  registerPrivilegedHandler('cloudsync:drive:getMetadata', (workspaceId: unknown, hash: unknown) => safeDriveCall('object-metadata', async () => {
    assertWorkspaceId(workspaceId); assertObjectHash(hash);
    return driveProvider.getMetadata(workspaceId, hash);
  }));
  registerPrivilegedHandler('cloudsync:drive:findCandidatePanvasRoots', () => safeDriveCall('candidate-roots', () => driveProvider.findCandidatePanvasRoots()));
  registerPrivilegedHandler('cloudsync:drive:readRootJson', (name: unknown) => safeDriveCall('drive-root-read', async () => {
    assertRootFile(name); return driveProvider.readRootJson(name);
  }));
  registerPrivilegedHandler('cloudsync:drive:readWorkspaceJson', (workspaceId: unknown, name: unknown) => safeDriveCall('drive-workspace-read', async () => {
    assertWorkspaceId(workspaceId); if (name !== 'manifest.json') throw new Error('Invalid workspace file.');
    return driveProvider.readWorkspaceJson(workspaceId, name);
  }));
  registerPrivilegedHandler('cloudsync:drive:readCandidateRootJson', (rootFolderId: unknown, name: unknown) => safeDriveCall('candidate-root-read', async () => {
    if (typeof rootFolderId !== 'string') throw new Error('Invalid root folder ID.');
    assertRootFile(name);
    const candidate = new GoogleDriveSyncProvider({
      tokenProvider: () => googleAuthService.getValidAccessToken(),
      tokenRefresher: () => googleAuthService.forceRefreshAccessToken(),
      remoteNamespace: 'sync-v2',
      storageSpace: 'drive',
      rootFolderId,
      assertCurrent: driveAuthority.capture(),
    });
    return candidate.readRootJson(name);
  }));
  registerPrivilegedHandler('cloudsync:drive:readCandidateWorkspaceJson', (rootFolderId: unknown, workspaceId: unknown, name: unknown) => safeDriveCall('candidate-ws-read', async () => {
    if (typeof rootFolderId !== 'string') throw new Error('Invalid root folder ID.');
    assertWorkspaceId(workspaceId);
    if (name !== 'manifest.json') throw new Error('Invalid workspace file.');
    const candidate = new GoogleDriveSyncProvider({
      tokenProvider: () => googleAuthService.getValidAccessToken(),
      tokenRefresher: () => googleAuthService.forceRefreshAccessToken(),
      remoteNamespace: 'sync-v2',
      storageSpace: 'drive',
      rootFolderId,
      assertCurrent: driveAuthority.capture(),
    });
    return candidate.readWorkspaceJson(workspaceId, name);
  }));
  registerPrivilegedHandler('cloudsync:drive:getCandidateObject', (rootFolderId: unknown, hash: unknown) => safeDriveCall('candidate-object', async () => {
    if (typeof rootFolderId !== 'string') throw new Error('Invalid root folder ID.');
    assertObjectHash(hash);
    const candidate = new GoogleDriveSyncProvider({
      tokenProvider: () => googleAuthService.getValidAccessToken(),
      tokenRefresher: () => googleAuthService.forceRefreshAccessToken(),
      remoteNamespace: 'sync-v2',
      storageSpace: 'drive',
      rootFolderId,
      assertCurrent: driveAuthority.capture(),
    });
    return candidate.getObject('v2', hash);
  }));

  registerPrivilegedHandler('cloudsync:driveV2:readRootJson', (name: unknown) => safeDriveCall('v2-root-read', async () => {
    assertRootFile(name); return driveV2Provider.readRootJson(name);
  }));
  registerPrivilegedHandler('cloudsync:driveV2:writeRootJson', (name: unknown, value: unknown, ifMatch: unknown) => safeDriveCall('v2-root-write', async () => {
    assertRootFile(name); if (!value || typeof value !== 'object' || (ifMatch !== null && typeof ifMatch !== 'string')) throw new Error('Invalid V2 root payload.');
    return driveV2Provider.writeRootJson(name, value, ifMatch);
  }));
  registerPrivilegedHandler('cloudsync:driveV2:readWorkspaceJson', (workspaceId: unknown, name: unknown) => safeDriveCall('v2-manifest-read', async () => {
    assertWorkspaceId(workspaceId); if (name !== 'manifest.json') throw new Error('Invalid V2 workspace file.');
    return driveV2Provider.readWorkspaceJson(workspaceId, name);
  }));
  registerPrivilegedHandler('cloudsync:driveV2:writeWorkspaceJson', (workspaceId: unknown, name: unknown, value: unknown, ifMatch: unknown) => safeDriveCall('v2-manifest-write', async () => {
    assertWorkspaceId(workspaceId); if (name !== 'manifest.json' || !value || typeof value !== 'object' || (ifMatch !== null && typeof ifMatch !== 'string')) throw new Error('Invalid V2 manifest payload.');
    return driveV2Provider.writeWorkspaceJson(workspaceId, name, value, ifMatch);
  }));
  registerPrivilegedHandler('cloudsync:driveV2:getObject', (hash: unknown) => safeDriveCall('v2-object-download', async () => {
    assertObjectHash(hash); return driveV2Provider.getObject('v2', hash);
  }));
  registerPrivilegedHandler('cloudsync:driveV2:putObjectIfAbsent', (uploadValue: unknown) => safeDriveCall('v2-object-transfer', async () => {
    const upload = uploadValue as Partial<ObjectUpload>; assertObjectHash(upload?.hash);
    if (!(upload?.bytes instanceof Uint8Array)) throw new Error('Invalid V2 object payload.');
    return driveV2Provider.putObjectIfAbsent('v2', { hash: upload.hash, bytes: upload.bytes });
  }));
  registerPrivilegedHandler('cloudsync:driveV2:getMetadata', (hash: unknown) => safeDriveCall('v2-object-metadata', async () => {
    assertObjectHash(hash); return driveV2Provider.getMetadata('v2', hash);
  }));
}
