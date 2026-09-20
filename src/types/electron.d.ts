import type { Workspace, Folder, CanvasFile } from '@/types/workspace';
import type { Notebook, NotebookPropertyBatchSnapshot, NotebookSection, NotebookPage, PagePropertySet } from '@/types/notebook';
import type { PanvasKnowledgeAPI } from '@/types/knowledge';
import type { BackupExportResult, BackupImportResult, WorkspaceBackup } from '@/services/backup/backupService';
import type { RecognitionOptions, RecognitionResult } from '@/services/recognition/types';
import type { Stroke } from '@/components/notebook/engine/drawingTypes';
import type { CanvasLibraryRecord } from '@/services/canvas/canvasLibraryModel';
import type { NativePdfPrintResult } from '@/services/pdf/nativePrintLifecycle';
import type { PanvasBootstrapSnapshot } from '@/types/bootstrap';

type CloudDriveResult<T> =
  | { success: true; value: T }
  | { success: false; errorCode: import('@/services/cloudsync/errors').CloudErrorCode; diagnostic: import('@/services/cloudsync/types').SafeCloudDiagnostic };

export interface PanvasDomainAPI {
  bootstrap: {
    getSnapshot: () => Promise<PanvasBootstrapSnapshot>;
  };
  storage: {
    getRoot: () => Promise<{ path: string; configuredPath: string | null; isDefault: boolean; available: boolean }>;
    setRoot: (folderPath: string) => Promise<{ path: string; configuredPath: string; isDefault: boolean; available: boolean }>;
    chooseRoot: () => Promise<{ path: string; configuredPath: string; isDefault: boolean; available: boolean } | null>;
  };
  workspace: {
    create: (name: string) => Promise<Workspace>;
    openDialog: () => Promise<Workspace | null>;
    getAll: () => Promise<Workspace[]>;
    getRecoveryWorkspaceRoot: (id: string) => Promise<Workspace | null>;
    update: (id: string, updates: Partial<Workspace>) => Promise<Workspace>;
    reorder: (wsId: string, type: 'folder' | 'notebook' | 'canvas' | 'section' | 'page', itemIds: string[]) => Promise<boolean>;
  };
  folder: {
    create: (wsId: string, name: string, parentId: string | null) => Promise<Folder>;
    update: (wsId: string, folderId: string, updates: Partial<Folder>) => Promise<Folder>;
    delete: (wsId: string, folderId: string) => Promise<boolean>;
    getAll: (wsId: string) => Promise<Folder[]>;
  };
  canvasFile: {
    create: (wsId: string, name: string, folderId: string | null, notebookId: string | null, sectionId: string | null) => Promise<CanvasFile>;
    update: (wsId: string, canvasId: string, updates: Partial<CanvasFile>) => Promise<CanvasFile>;
    delete: (wsId: string, canvasId: string) => Promise<boolean>;
    getAll: (wsId: string) => Promise<CanvasFile[]>;
  };
  canvas: {
    save: (wsId: string, canvasId: string, data: any) => Promise<void>;
    load: (wsId: string, canvasId: string) => Promise<any>;
  };
  library: {
    getAll: (wsId: string) => Promise<CanvasLibraryRecord[]>;
    import: (wsId: string, fileName: string, contents: string) => Promise<CanvasLibraryRecord>;
    delete: (wsId: string, fileName: string) => Promise<boolean>;
  };
  notebook: {
    create: (wsId: string, name: string, folderId: string | null) => Promise<Notebook>;
    update: (wsId: string, notebookId: string, updates: Partial<Notebook>) => Promise<Notebook>;
    delete: (wsId: string, notebookId: string) => Promise<boolean>;
    getAll: (wsId: string) => Promise<Notebook[]>;
    savePage: (wsId: string, notebookId: string, pageId: string, data: any) => Promise<void>;
    loadPage: (wsId: string, notebookId: string, pageId: string) => Promise<any>;
    saveDrawing: (wsId: string, notebookId: string, pageId: string, drawingData: any) => Promise<void>;
    loadDrawing: (wsId: string, notebookId: string, pageId: string) => Promise<any>;
    applyPageDefaults: (wsId: string, notebookId: string, updates: Partial<PagePropertySet>) => Promise<NotebookPropertyBatchSnapshot>;
    restorePageDefaults: (wsId: string, snapshot: NotebookPropertyBatchSnapshot) => Promise<boolean>;
  };
  notebookSection: {
    create: (wsId: string, notebookId: string, name: string) => Promise<NotebookSection>;
    update: (wsId: string, sectionId: string, updates: Partial<NotebookSection>) => Promise<NotebookSection>;
    delete: (wsId: string, sectionId: string) => Promise<boolean>;
    getAll: (wsId: string) => Promise<NotebookSection[]>;
  };
  notebookPage: {
    create: (wsId: string, notebookId: string, sectionId: string, title: string, type?: 'default' | 'pdf', pdfDataId?: string) => Promise<NotebookPage>;
    update: (wsId: string, pageId: string, updates: Partial<NotebookPage>) => Promise<NotebookPage>;
    delete: (wsId: string, pageId: string) => Promise<boolean>;
    getAll: (wsId: string) => Promise<NotebookPage[]>;
  };
  settings: {
    get: (wsId: string | null, key: string) => Promise<any>;
    set: (wsId: string | null, key: string, value: any) => Promise<boolean>;
    setTheme: (theme: string) => Promise<void>;
  };
  migration: {
    importWorkspace: (bundle: import('@/lib/migration-core').WorkspaceMigrationBundle) => Promise<boolean>;
  };
  binary: {
    /** Durably store imported PDF bytes under the workspace asset store. */
    storePdf: (id: string, fileName: string, data: ArrayBuffer) => Promise<boolean>;
    /** Fetch stored PDF bytes; null when the id is unknown to the store. */
    getPdf: (id: string) => Promise<{ id: string; fileName: string; createdAt: number; data: ArrayBuffer } | null>;
    /** Durably store imported image bytes under the workspace asset store. */
    storeImage: (id: string, fileName: string, mimeType: string, data: ArrayBuffer) => Promise<boolean>;
    /** Fetch stored image bytes; null when the id is unknown to the store. */
    getImage: (id: string) => Promise<{ id: string; fileName: string; mimeType: string; createdAt: number; data: ArrayBuffer } | null>;
    storeAudio: (id: string, fileName: string, mimeType: string, data: ArrayBuffer) => Promise<boolean>;
    getAudio: (id: string) => Promise<{ id: string; fileName: string; mimeType: string; createdAt: number; data: ArrayBuffer } | null>;
    deleteAudio: (id: string) => Promise<boolean>;
  };
  trash: {
    /** Soft-deleted workspace children stored in Electron filesystem metadata. */
    getAll: (wsId?: string | null) => Promise<{
      workspaces: Workspace[];
      folders: Folder[];
      canvasFiles: CanvasFile[];
      notebooks: Notebook[];
      sections: NotebookSection[];
      pages: NotebookPage[];
    }>;
    /** Permanently removes one trash root and all of its owned descendants. */
    permanentlyDelete: (workspaceId: string, id: string, kind: 'workspace' | 'folder' | 'canvas' | 'notebook' | 'section' | 'page') => Promise<boolean>;
  };
  backup: {
    export: (workspaceId: string) => Promise<BackupExportResult>;
    import: (backup: WorkspaceBackup) => Promise<BackupImportResult>;
    importDialog: () => Promise<BackupImportResult & { canceled?: false } | { canceled: true }>;
  };
  recognition: {
    recognize: (strokes: Stroke[], options?: RecognitionOptions) => Promise<RecognitionResult>;
  };
  /** Narrow generated-PDF-only native print capability. */
  print: {
    pdf: (bytes: Uint8Array) => Promise<NativePdfPrintResult>;
  };
  knowledge: PanvasKnowledgeAPI;
  cloudsync: {
    connect: (provider: string) => Promise<{ success: boolean; connection?: import('@/services/cloudsync/types').ProviderConnectionInfo; errorCode?: 'configuration' | 'connection'; diagnostic?: import('@/services/cloudsync/types').SafeCloudDiagnostic }>;
    disconnect: (provider: string) => Promise<{ success: boolean }>;
    getConnection: (provider: string) => Promise<import('@/services/cloudsync/types').ProviderConnectionInfo | null>;
    resetLocalData: () => Promise<{ workspaceIds: string[]; recoveryPath: string | null }>;
    drive: {
      ensureAppRoot: () => Promise<CloudDriveResult<string>>;
      listRemoteWorkspaces: () => Promise<CloudDriveResult<import('@/services/cloudsync/types').RemoteWorkspaceSummary[]>>;
      readManifest: (workspaceId: string) => Promise<CloudDriveResult<import('@/services/cloudsync/types').RemoteManifestRead>>;
      writeManifest: (workspaceId: string, manifest: import('@/services/cloudsync/types').SyncManifestV1, ifMatch: string | null) => Promise<CloudDriveResult<{ etag: string }>>;
      getObject: (workspaceId: string, hash: string) => Promise<CloudDriveResult<Uint8Array>>;
      putObjectIfAbsent: (workspaceId: string, upload: import('@/services/cloudsync/types').ObjectUpload) => Promise<CloudDriveResult<import('@/services/cloudsync/types').ObjectPutResult>>;
      deleteObject: (workspaceId: string, hash: string) => Promise<CloudDriveResult<boolean>>;
      moveObject: (workspaceId: string, fromHash: string, toHash: string) => Promise<CloudDriveResult<boolean>>;
      getMetadata: (workspaceId: string, hash: string) => Promise<CloudDriveResult<{ size: number } | null>>;
    };
    driveV2: {
      readRootJson: <T>(name: string) => Promise<CloudDriveResult<{ value: T | null; etag: string | null }>>;
      writeRootJson: (name: string, value: unknown, ifMatch: string | null) => Promise<CloudDriveResult<{ etag: string }>>;
      readWorkspaceJson: <T>(workspaceId: string, name: string) => Promise<CloudDriveResult<{ value: T | null; etag: string | null }>>;
      writeWorkspaceJson: (workspaceId: string, name: string, value: unknown, ifMatch: string | null) => Promise<CloudDriveResult<{ etag: string }>>;
      getObject: (workspaceId: string, hash: string) => Promise<CloudDriveResult<Uint8Array>>;
      putObjectIfAbsent: (workspaceId: string, upload: import('@/services/cloudsync/types').ObjectUpload) => Promise<CloudDriveResult<import('@/services/cloudsync/types').ObjectPutResult>>;
      getMetadata: (workspaceId: string, hash: string) => Promise<CloudDriveResult<{ size: number } | null>>;
    };
    applyRemoteRecord: (workspaceId: string, record: { kind: import('@/services/cloudsync/types').SyncEntityKind; id: string; parentId?: string | null; payload: unknown; tombstone: boolean }) => Promise<boolean>;
    applyRemoteRecords: (workspaceId: string, records: Array<{ kind: import('@/services/cloudsync/types').SyncEntityKind; id: string; parentId?: string | null; payload: unknown; tombstone: boolean }>) => Promise<
      { success: true } | { success: false; errorCode: import('@/services/cloudsync/errors').CloudErrorCode; diagnostic: import('@/services/cloudsync/types').SafeCloudDiagnostic }
    >;
    listPageDrawingRecords: (workspaceId: string) => Promise<Array<{ id: string; notebookId: string; ownerPageId: string }>>;
    logDiagnostic: (diagnostic: import('@/services/cloudsync/types').SafeCloudDiagnostic) => void;
  };
}

declare global {
  interface Window {
    panvas: PanvasDomainAPI;
    __PANVAS_GATE0_PROFILER__?: {
      enable: () => void;
      disable: () => void;
      reset: () => void;
      report: () => import('@/dev/gate0Profiler').Gate0Report;
    };
  }
}
