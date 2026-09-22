import { GoogleDriveSyncProvider, type GoogleDriveProviderOptions } from '../googleDriveProvider.ts';
import type { SyncV2Catalog, SyncV2Manifest, SyncV2Profile, SyncV2Provider } from './types.ts';

export class GoogleDriveSyncV2Provider implements SyncV2Provider {
  private readonly drive: GoogleDriveSyncProvider;
  constructor(options: GoogleDriveProviderOptions = {}) {
    this.drive = new GoogleDriveSyncProvider({ ...options, remoteNamespace: 'sync-v2' });
    this.drive = new GoogleDriveSyncProvider({ storageSpace: 'appDataFolder', ...options, remoteNamespace: 'sync-v2' });
  }

  getDriveProvider(): GoogleDriveSyncProvider { return this.drive; }
  readProfile() { return this.drive.readRootJson<SyncV2Profile>('profile.json'); }
  writeProfile(value: SyncV2Profile, ifMatch: string | null) { return this.drive.writeRootJson('profile.json', value, ifMatch); }
  readCatalog() { return this.drive.readRootJson<SyncV2Catalog>('catalog.json'); }
  writeCatalog(value: SyncV2Catalog, ifMatch: string | null) { return this.drive.writeRootJson('catalog.json', value, ifMatch); }
  readManifest(workspaceId: string) { return this.drive.readWorkspaceJson<SyncV2Manifest>(workspaceId, 'manifest.json'); }
  writeManifest(workspaceId: string, value: SyncV2Manifest, ifMatch: string | null) { return this.drive.writeWorkspaceJson(workspaceId, 'manifest.json', value, ifMatch); }
  getObject(hash: string) { return this.drive.getObject('v2', hash); }
  putObjectIfAbsent(hash: string, bytes: Uint8Array) { return this.drive.putObjectIfAbsent('v2', { hash, bytes }); }
  getObjectMetadata(hash: string) { return this.drive.getMetadata('v2', hash); }
}
