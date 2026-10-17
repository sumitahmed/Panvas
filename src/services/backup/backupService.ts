import type { CanvasData } from '@/types/canvas';
import type { Workspace, Folder, CanvasFile } from '@/types/workspace';
import type { Notebook, NotebookSection, NotebookPage } from '@/types/notebook';
import { pdfAnnotationStorageId } from '../../lib/pdfAnnotationStorage.ts';
import { MAX_BACKUP_BYTES, collectBackupAssetReferences, collectBackupBlockIds, isBackupId, remapBackupReferences, validateBackupAssetManifest, type BackupAsset } from './backupAssets.ts';

export const BACKUP_VERSION = 2 as const;
export const BACKUP_TYPE = 'panvas/workspace-backup' as const;

export interface BackupHeader {
  version: 1 | typeof BACKUP_VERSION;
  type: typeof BACKUP_TYPE;
  exportedAt: number;
  workspaceName: string;
}

export interface BackupPagePayload {
  drawing: unknown;
  content: unknown;
}
export interface BackupAnnotationPayload extends BackupPagePayload { ownerPageId: string; sourcePage: number }

export interface WorkspaceBackup {
  header: BackupHeader;
  workspace: Workspace;
  folders: Folder[];
  notebooks: Notebook[];
  sections: NotebookSection[];
  pages: NotebookPage[];
  canvases: CanvasFile[];
  pagePayloads: Record<string, BackupPagePayload>;
  canvasPayloads: Record<string, CanvasData>;
  assets?: Record<string, BackupAsset>;
  annotationPayloads?: Record<string, BackupAnnotationPayload>;
}

export interface BackupExportResult {
  backup: WorkspaceBackup;
  savedPath?: string;
  canceled?: boolean;
}

export interface BackupImportResult {
  workspaceId: string;
  workspaceName: string;
  warnings?: string[];
}

export interface BackupSource {
  workspace: Workspace;
  folders: Folder[];
  notebooks: Notebook[];
  sections: NotebookSection[];
  pages: NotebookPage[];
  canvases: CanvasFile[];
  pagePayloads: Record<string, BackupPagePayload>;
  canvasPayloads: Record<string, CanvasData>;
  assets?: Record<string, BackupAsset>;
  annotationPayloads?: Record<string, BackupAnnotationPayload>;
}

export interface BackupRemapOptions {
  idFactory?: (prefix: string) => string;
  workspaceName?: string;
  userId?: string | null;
  now?: number;
}

const isRecord = (value: unknown): value is Record<string, any> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function invalid(reason: string): never {
  throw new Error(`Invalid Panvas backup: ${reason}`);
}

function requireEntityCollection(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const ids = new Set<string>();
  for (const entity of value) {
    if (!isRecord(entity) || !isBackupId(entity.id)) invalid(`${label} contains an invalid record`);
    if (ids.has(entity.id)) invalid(`${label} contains duplicate id ${entity.id}`);
    ids.add(entity.id);
  }
  return value;
}

function requirePayloadMap(value: unknown, label: string): Record<string, any> {
  if (!isRecord(value)) invalid(`${label} must be an object`);
  for (const [id, payload] of Object.entries(value)) {
    if (!id || !isRecord(payload)) invalid(`${label} contains an invalid payload`);
  }
  return value;
}

function validateWorkspaceName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\\/:*?"<>|\u0000-\u001F]/.test(value)) {
    invalid('header.workspaceName is invalid');
  }
}

/** Validate and normalize a portable backup without touching local storage. */
export function validateWorkspaceBackup(input: unknown): WorkspaceBackup {
  if (!isRecord(input)) invalid('root must be an object');
  const header = input.header;
  if (!isRecord(header) || ![1, BACKUP_VERSION].includes(header.version) || header.type !== BACKUP_TYPE || typeof header.exportedAt !== 'number' || !Number.isFinite(header.exportedAt)) {
    invalid('header is invalid');
  }
  validateWorkspaceName(header.workspaceName);
  if (!isRecord(input.workspace) || !isBackupId(input.workspace.id)) invalid('workspace metadata is invalid');

  const folders = requireEntityCollection(input.folders, 'folders') as Folder[];
  const notebooks = requireEntityCollection(input.notebooks, 'notebooks') as Notebook[];
  const sections = requireEntityCollection(input.sections, 'sections') as NotebookSection[];
  const pages = requireEntityCollection(input.pages, 'pages') as NotebookPage[];
  const canvases = requireEntityCollection(input.canvases, 'canvases') as CanvasFile[];
  const entityIds = [input.workspace.id, ...[folders, notebooks, sections, pages, canvases].flatMap(items => items.map(item => item.id))];
  if (new Set(entityIds).size !== entityIds.length) invalid('entity identifiers collide across collections');
  const pagePayloads = requirePayloadMap(input.pagePayloads, 'pagePayloads') as Record<string, BackupPagePayload>;
  const canvasPayloads = requirePayloadMap(input.canvasPayloads, 'canvasPayloads') as Record<string, CanvasData>;

  const pageIds = new Set(pages.map(page => page.id));
  const folderIds = new Set(folders.map(folder => folder.id));
  const notebookIds = new Set(notebooks.map(notebook => notebook.id));
  const sectionIds = new Set(sections.map(section => section.id));
  if (folders.some(folder => folder.workspaceId !== input.workspace.id || (folder.parentId !== null && !folderIds.has(folder.parentId)))) invalid('folder relationships are invalid');
  if (notebooks.some(notebook => notebook.workspaceId !== input.workspace.id || (notebook.folderId !== null && !folderIds.has(notebook.folderId)))) invalid('notebook relationships are invalid');
  if (sections.some(section => !notebookIds.has(section.notebookId))) invalid('section relationships are invalid');
  for (const page of pages) {
    const payload = pagePayloads[page.id];
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'drawing') || !Object.prototype.hasOwnProperty.call(payload, 'content')) invalid(`page payload is missing for ${page.id}`);
    if (typeof page.notebookId !== 'string' || !notebookIds.has(page.notebookId) || !sectionIds.has(page.sectionId)
      || sections.find(section => section.id === page.sectionId)?.notebookId !== page.notebookId) invalid(`page ${page.id} relationships are invalid`);
  }
  if (Object.keys(pagePayloads).some(id => !pageIds.has(id))) invalid('pagePayloads contains an unknown page');
  const canvasIds = new Set(canvases.map(canvas => canvas.id));
  if (canvases.some(canvas => canvas.workspaceId !== input.workspace.id || (canvas.folderId !== null && !folderIds.has(canvas.folderId)))) invalid('canvas relationships are invalid');
  if (canvases.some(canvas => (canvas.notebookId != null && !notebookIds.has(canvas.notebookId))
    || (canvas.sectionId != null && (!sectionIds.has(canvas.sectionId) || sections.find(section => section.id === canvas.sectionId)?.notebookId !== canvas.notebookId)))) invalid('canvas notebook relationships are invalid');
  for (const canvas of canvases) {
    const payload = canvasPayloads[canvas.id];
    if (!payload || typeof payload !== 'object' || payload.canvasFileId !== canvas.id) invalid(`canvas payload is missing or mismatched for ${canvas.id}`);
  }
  if (Object.keys(canvasPayloads).some(id => !canvasIds.has(id))) invalid('canvasPayloads contains an unknown canvas');
  const assets = header.version === 2 ? validateBackupAssetManifest(input.assets ?? {}) : {};
  const annotationPayloads = header.version === 2 ? requirePayloadMap(input.annotationPayloads ?? {}, 'annotationPayloads') as Record<string, BackupAnnotationPayload> : {};
  const owners = new Set([...pageIds, ...canvasIds]);
  for (const asset of Object.values(assets)) if (!owners.has(asset.ownerId)) invalid('asset owner is outside the workspace');
  for (const [id, annotation] of Object.entries(annotationPayloads)) {
    if (!pageIds.has(annotation.ownerPageId) || pages.find(page => page.id === annotation.ownerPageId)?.type !== 'pdf'
      || !Number.isSafeInteger(annotation.sourcePage) || annotation.sourcePage < 1
      || id !== pdfAnnotationStorageId(annotation.ownerPageId, annotation.sourcePage)
      || !Object.prototype.hasOwnProperty.call(annotation, 'drawing') || !Object.prototype.hasOwnProperty.call(annotation, 'content')) invalid('PDF annotation ownership is invalid');
  }

  const normalized: WorkspaceBackup = {
    header: {
      version: header.version,
      type: BACKUP_TYPE,
      exportedAt: header.exportedAt,
      workspaceName: header.workspaceName,
    },
    workspace: input.workspace as Workspace,
    folders,
    notebooks,
    sections,
    pages,
    canvases,
    pagePayloads,
    canvasPayloads,
    assets,
    annotationPayloads,
  };
  return clone(normalized);
}

export function parseWorkspaceBackup(input: string | unknown): WorkspaceBackup {
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_BACKUP_BYTES) invalid('file exceeds the 100 MiB limit');
    try {
      return validateWorkspaceBackup(JSON.parse(input));
    } catch (error) {
      if (error instanceof SyntaxError) invalid('JSON is malformed');
      throw error;
    }
  }
  return validateWorkspaceBackup(input);
}

export function serializeWorkspaceBackup(input: WorkspaceBackup): string {
  const serialized = JSON.stringify(validateWorkspaceBackup(input));
  if (new TextEncoder().encode(serialized).byteLength > MAX_BACKUP_BYTES) invalid('file exceeds the 100 MiB limit');
  return serialized;
}

export function buildWorkspaceBackup(source: BackupSource, exportedAt = Date.now()): WorkspaceBackup {
  const workspace = { ...source.workspace } as Workspace & Record<string, unknown>;
  for (const key of ['folders', 'notebooks', 'notebookSections', 'notebookPages', 'canvasFiles']) delete workspace[key];
  const backup = {
    header: {
      version: BACKUP_VERSION,
      type: BACKUP_TYPE,
      exportedAt,
      workspaceName: source.workspace.name,
    },
    workspace,
    folders: source.folders,
    notebooks: source.notebooks,
    sections: source.sections,
    pages: source.pages,
    canvases: source.canvases,
    pagePayloads: source.pagePayloads,
    canvasPayloads: source.canvasPayloads,
    assets: source.assets ?? {},
    annotationPayloads: source.annotationPayloads ?? {},
  } satisfies WorkspaceBackup;
  return validateWorkspaceBackup(backup);
}

/** Remap every persisted identifier and relationship for a safe new restore. */
export function remapWorkspaceBackup(input: WorkspaceBackup, options: BackupRemapOptions = {}): WorkspaceBackup {
  const backup = validateWorkspaceBackup(input);
  let sequence = 0;
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-restored-${++sequence}`);
  const workspaceId = idFactory('ws');
  const folderIds = new Map(backup.folders.map(folder => [folder.id, idFactory('folder')]));
  const notebookIds = new Map(backup.notebooks.map(notebook => [notebook.id, idFactory('notebook')]));
  const sectionIds = new Map(backup.sections.map(section => [section.id, idFactory('section')]));
  const pageIds = new Map(backup.pages.map(page => [page.id, idFactory('page')]));
  const canvasIds = new Map(backup.canvases.map(canvas => [canvas.id, idFactory('canvas')]));
  const entities = new Map([[backup.workspace.id, workspaceId], ...folderIds, ...notebookIds, ...sectionIds, ...pageIds, ...canvasIds]);
  const assets = new Map([...new Set([...collectBackupAssetReferences(backup).keys(), ...Object.keys(backup.assets ?? {})])].map(id => [id, idFactory('asset')]));
  const blocks = new Map([...collectBackupBlockIds([backup.pagePayloads, backup.annotationPayloads, backup.canvasPayloads])].map(id => [id, idFactory('block')]));
  const now = options.now ?? Date.now();
  const userId = options.userId === undefined ? backup.workspace.userId ?? null : options.userId;
  const workspace = clone({ ...backup.workspace, id: workspaceId, name: options.workspaceName ?? `${backup.workspace.name} (Restored)`, userId, updatedAt: now, deletedAt: null, syncStatus: 'local', isSystem: false, systemType: undefined });
  const folders = backup.folders.map(folder => ({ ...remapBackupReferences(folder, entities, assets, blocks), id: folderIds.get(folder.id)!, userId }));
  const notebooks = backup.notebooks.map(notebook => ({ ...remapBackupReferences(notebook, entities, assets, blocks), id: notebookIds.get(notebook.id)!, userId }));
  const sections = backup.sections.map(section => ({ ...remapBackupReferences(section, entities, assets, blocks), id: sectionIds.get(section.id)!, userId }));
  const pages = backup.pages.map(page => ({ ...remapBackupReferences(page, entities, assets, blocks), id: pageIds.get(page.id)!, userId }));
  const canvases = backup.canvases.map(canvas => ({ ...remapBackupReferences(canvas, entities, assets, blocks), id: canvasIds.get(canvas.id)!, userId, isSystem: false, systemType: undefined }));
  const pagePayloads: Record<string, BackupPagePayload> = {};
  for (const page of backup.pages) pagePayloads[pageIds.get(page.id)!] = remapBackupReferences(clone(backup.pagePayloads[page.id]), entities, assets, blocks);
  const canvasPayloads: Record<string, CanvasData> = {};
  for (const canvas of backup.canvases) {
    const payload = remapBackupReferences(clone({ ...backup.canvasPayloads[canvas.id], userId, updatedAt: now }), entities, assets, blocks);
    payload.customBlocks = (payload.customBlocks ?? []).map(block => ({ ...block, userId }));
    canvasPayloads[canvasIds.get(canvas.id)!] = payload;
  }
  const annotationPayloads = Object.fromEntries(Object.values(backup.annotationPayloads ?? {}).map(annotation => [
    pdfAnnotationStorageId(pageIds.get(annotation.ownerPageId)!, annotation.sourcePage), remapBackupReferences(annotation, entities, assets, blocks),
  ]));
  const assetManifest = Object.fromEntries(Object.entries(backup.assets ?? {}).map(([id, asset]) => [assets.get(id)!, { ...asset, id: assets.get(id)!, ownerId: entities.get(asset.ownerId)! }]));
  return validateWorkspaceBackup({ header: { ...backup.header, exportedAt: now, workspaceName: workspace.name }, workspace,
    folders, notebooks, sections, pages, canvases,
    pagePayloads, canvasPayloads, annotationPayloads, assets: assetManifest });
}

export async function exportWorkspaceBackup(workspaceId: string, userId: string | null = null): Promise<BackupExportResult> {
  const runtime = globalThis as any;
  if (runtime.panvas?.backup) return runtime.panvas.backup.export(workspaceId);
  const { collectBrowserWorkspaceBackup } = await import('./backupBrowserStorage');
  return { backup: await collectBrowserWorkspaceBackup(workspaceId, userId) };
}

export async function importWorkspaceBackup(input: string | WorkspaceBackup, userId: string | null = null): Promise<BackupImportResult> {
  const backup = parseWorkspaceBackup(input);
  const runtime = globalThis as any;
  if (runtime.panvas?.backup) return runtime.panvas.backup.import(backup);
  const { restoreBrowserWorkspaceBackup } = await import('./backupBrowserStorage');
  return restoreBrowserWorkspaceBackup(backup, userId);
}

export async function importWorkspaceBackupFromDialog(): Promise<(BackupImportResult & { canceled?: false }) | { canceled: true }> {
  const runtime = globalThis as any;
  if (!runtime.panvas?.backup?.importDialog) throw new Error('Native backup import is unavailable.');
  return runtime.panvas.backup.importDialog();
}

export function describeBackupError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const detail = message.match(/(?:Invalid Panvas backup:|Invalid backup asset|Backup asset|Backup is incomplete:|Backup cannot complete:|Backup assets|Backup file|Restored asset|Storage root changed)[^\r\n]{0,220}/)?.[0];
  return detail ?? 'The workspace backup could not be completed. No existing workspace was changed.';
}
