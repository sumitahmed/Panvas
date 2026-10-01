import { ipcMain, app, dialog, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { generateId } from '../../src/lib/utils/id.js';
import { writeQueue } from './write-queue.js';
import { workspaceService } from './WorkspaceService.js';
import { DEFAULT_PAGE_PROPERTY_SET } from '../../src/types/notebook.js';
import { validateWorkspaceBackup } from '../../src/services/backup/backupService.js';
import {
  libraryDisplayName,
  parseExcalidrawLibrary,
  requireLibraryFileName,
  serializeExcalidrawLibrary,
} from '../../src/services/canvas/canvasLibraryModel.js';
import { runNativePdfPrint } from '../../src/services/pdf/nativePrintLifecycle.js';
import { getDeletedWorkspaceItems, setCanvasDeletedAt, setFolderDeletedAt, setNotebookDeletedAt, setSectionDeletedAt, setWorkspaceDeletedAt } from './workspace-trash.js';
import { parsePdfAnnotationStorageId } from '../../src/lib/pdfAnnotationStorage.js';
import { importDexieWorkspace, resolveMigrationWorkspaceDirectory } from './migration-import.js';
import { isUnmarkedLegacyDefaultShell, type WorkspaceMigrationBundle } from '../../src/lib/migration-core.js';
import { requireTrustedSender } from './security.js';
import { createNotebookPageFiles } from './notebook-page-create.js';
import { cloudApplyFailure } from '../../src/services/cloudsync/errors.js';
import { NativeRemoteRecordApplyError } from './workspace-sync-order.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_NAME_LENGTH = 160;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
// Imported documents (textbooks etc.) legitimately exceed the JSON payload
// bound; binaries get their own, larger limit.
const MAX_BINARY_BYTES = 200 * 1024 * 1024;
const PAGE_TEMPLATES = new Set([
  'Blank', 'Ruled', 'Narrow ruled', 'Wide ruled', 'Large ruled with margin', 'Double margin ruled',
  'Small grid', 'Large grid', 'Dotted', 'Engineering',
  'Cornell', 'Lecture Notes', 'Assignment', 'Checklist', 'To-do', 'Daily planner', 'Weekly planner',
  'Monthly planner', 'Journal', 'Music', 'Calendar',
]);
const FOLDER_ICONS = new Set(['folder', 'book', 'briefcase', 'archive']);
const NOTEBOOK_COVER_TEMPLATES = new Set(['linen', 'leather', 'midnight', 'sage', 'plum', 'sand']);

function requireId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Invalid ${label}.`);
}

function requireOptionalId(value: unknown, label: string): void {
  if (value !== null && value !== undefined) requireId(value, label);
}

function requireName(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_NAME_LENGTH || /[\\/:*?"<>|\u0000-\u001F]/.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid ${label}.`);
  }
}

function requirePlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`Invalid ${label}.`);
}

function requireJsonPayload(value: unknown, label: string, maxBytes = MAX_PAYLOAD_BYTES): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error(`Invalid ${label}.`);
}

function requirePagePropertyPatch(value: unknown, label: string): void {
  requirePlainObject(value, label);
  const allowed = new Set(['paperColor', 'template', 'ruleLineColor', 'orientation', 'pageSize', 'margins', 'templateFields', 'extraHeight', 'extraTop', 'extraRight', 'extraBottom', 'extraLeft']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(`Invalid ${label}.`);
  for (const [key, entry] of Object.entries(value)) {
    if ((key === 'paperColor' || key === 'ruleLineColor') && (typeof entry !== 'string' || !/^#[0-9a-f]{6,8}$/i.test(entry))) throw new Error(`Invalid ${key}.`);
    if (key === 'template' && (typeof entry !== 'string' || !PAGE_TEMPLATES.has(entry))) throw new Error('Invalid template.');
    if (key === 'orientation' && entry !== 'portrait' && entry !== 'landscape') throw new Error('Invalid orientation.');
    if (key === 'pageSize' && !['A3', 'A4', 'A5', 'Letter', 'Custom'].includes(String(entry))) throw new Error('Invalid page size.');
    if (key === 'margins' && !['No Margin', 'Normal', 'Narrow', 'Wide'].includes(String(entry))) throw new Error('Invalid margins.');
    if (['extraHeight', 'extraTop', 'extraRight', 'extraBottom', 'extraLeft'].includes(key)
      && (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > 6000)) throw new Error(`Invalid ${key}.`);
    if (key === 'templateFields') {
      requirePlainObject(entry, 'template fields');
      if (Object.keys(entry).length > 100 || Object.entries(entry).some(([field, fieldValue]) => field.length > 100 || typeof fieldValue !== 'string' || fieldValue.length > 10_000)) throw new Error('Invalid template fields.');
    }
  }
}

function requirePagePropertySnapshot(value: unknown): void {
  requirePlainObject(value, 'page property snapshot');
  requireId(value.notebookId, 'notebook identifier');
  requirePagePropertyPatch(value.defaultPageProperties, 'page defaults');
  if (!Array.isArray(value.pages) || value.pages.length > 10_000) throw new Error('Invalid page property snapshot.');
  for (const entry of value.pages) {
    requirePlainObject(entry, 'page property snapshot entry');
    requireId(entry.pageId, 'page identifier');
    requirePagePropertyPatch(entry.overrides, 'page property overrides');
  }
}

function requireNotebookCover(value: unknown): void {
  requirePlainObject(value, 'notebook cover');
  if (value.kind === 'template') {
    if (typeof value.id !== 'string' || !NOTEBOOK_COVER_TEMPLATES.has(value.id) || Object.keys(value).some(key => !['kind', 'id'].includes(key))) {
      throw new Error('Invalid notebook cover template.');
    }
    return;
  }
  if (value.kind === 'image') {
    if (Object.keys(value).some(key => !['kind', 'dataUrl', 'position'].includes(key))) throw new Error('Invalid notebook cover.');
    if (typeof value.dataUrl !== 'string' || value.dataUrl.length > 5_000_000 || !/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(value.dataUrl)) {
      throw new Error('Invalid notebook cover image.');
    }
    if (value.position !== undefined && (typeof value.position !== 'string' || value.position.length > 80)) throw new Error('Invalid notebook cover position.');
    return;
  }
  throw new Error('Invalid notebook cover.');
}

function requireUpdates(channel: string, updates: unknown): void {
  requirePlainObject(updates, 'updates');
  const allowed: Record<string, readonly string[]> = {
    'workspace:update': ['name', 'deletedAt', 'isPinned'],
    'folder:update': ['name', 'workspaceId', 'parentId', 'deletedAt', 'isExpanded', 'color', 'icon'],
    'canvasFile:update': ['name', 'workspaceId', 'folderId', 'notebookId', 'sectionId', 'deletedAt', 'isPinned', 'lastOpenedAt'],
    'notebook:update': ['name', 'workspaceId', 'folderId', 'isExpanded', 'isPinned', 'deletedAt', 'defaultPageProperties', 'cover', 'lastOpenedAt'],
    'notebookSection:update': ['name', 'notebookId', 'isExpanded', 'deletedAt'],
    'notebookPage:update': ['title', 'sectionId', 'type', 'pdfDataId', 'deletedAt', 'pagePropertyOverrides', 'pdfPageState', 'lastOpenedAt'],
  };
  if (Object.keys(updates).some((key) => !allowed[channel]?.includes(key))) throw new Error('Invalid update fields.');
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'name' || key === 'title') requireName(value, key);
    if (['workspaceId', 'parentId', 'folderId', 'notebookId', 'sectionId', 'pdfDataId'].includes(key)) requireOptionalId(value, key);
    if (['isPinned', 'isExpanded'].includes(key) && typeof value !== 'boolean') throw new Error(`Invalid ${key}.`);
    if (key === 'color' && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) throw new Error('Invalid folder color.');
    if (key === 'icon' && (typeof value !== 'string' || !FOLDER_ICONS.has(value))) throw new Error('Invalid folder icon.');
    if (['deletedAt', 'lastOpenedAt'].includes(key) && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Invalid ${key}.`);
    if (key === 'type' && (typeof value !== 'string' || value.length > 80)) throw new Error('Invalid page type.');
    if (key === 'defaultPageProperties' || key === 'pagePropertyOverrides') requirePagePropertyPatch(value, key);
    if (key === 'pdfPageState') {
      requirePlainObject(value, 'pdfPageState');
      const pdfState = value as { version?: unknown; pageOrder?: unknown; rotations?: unknown };
      if (pdfState.version !== 1 || !Array.isArray(pdfState.pageOrder) || !pdfState.pageOrder.every((item: unknown) => Number.isInteger(item) && (item as number) > 0) || !pdfState.rotations || typeof pdfState.rotations !== 'object' || Array.isArray(pdfState.rotations)) throw new Error('Invalid PDF page state.');
      if (!Object.entries(pdfState.rotations as Record<string, unknown>).every(([pageNumber, rotation]) => Number.isInteger(Number(pageNumber)) && [0, 90, 180, 270].includes(rotation as number))) throw new Error('Invalid PDF page rotations.');
    }
    if (key === 'cover') requireNotebookCover(value);
  }
}

function validateArguments(channel: string, args: unknown[]): void {
  const idArguments: Record<string, number[]> = {
    'workspace:update': [0], 'workspace:reorder': [0],
    'folder:create': [0], 'folder:getAll': [0], 'folder:update': [0, 1], 'folder:delete': [0, 1],
    'canvasFile:create': [0], 'canvasFile:getAll': [0], 'canvasFile:update': [0, 1], 'canvasFile:delete': [0, 1],
    'canvas:save': [0, 1], 'canvas:load': [0, 1],
    'library:getAll': [0], 'library:import': [0], 'library:delete': [0],
    'notebook:create': [0], 'notebook:getAll': [0], 'notebook:update': [0, 1], 'notebook:delete': [0, 1], 'notebook:applyPageDefaults': [0, 1], 'notebook:restorePageDefaults': [0],
    'notebookSection:create': [0, 1], 'notebookSection:getAll': [0], 'notebookSection:update': [0, 1], 'notebookSection:delete': [0, 1],
    'notebookPage:create': [0, 1, 2], 'notebookPage:getAll': [0], 'notebookPage:update': [0, 1], 'notebookPage:delete': [0, 1],
    'notebook:savePage': [0, 1, 2], 'notebook:loadPage': [0, 1, 2], 'notebook:saveDrawing': [0, 1, 2], 'notebook:loadDrawing': [0, 1, 2],
    'binary:getPdf': [0], 'binary:getImage': [0], 'binary:getAudio': [0], 'binary:deleteAudio': [0],
    'backup:export': [0],
    'trash:permanentlyDelete': [0, 1],
    'cloudsync:listPageDrawingRecords': [0], 'cloudsync:applyRemoteRecords': [0],
    'workspace:getRecoveryWorkspaceRoot': [0],
  };
  for (const index of idArguments[channel] ?? []) requireId(args[index], 'identifier');

  if (channel === 'workspace:create') requireName(args[0], 'workspace name');
  if (channel === 'storage:setRoot' && (typeof args[0] !== 'string' || args[0].length > 4096)) throw new Error('Invalid storage folder.');
  if (channel === 'folder:create' || channel === 'canvasFile:create' || channel === 'notebook:create') {
    requireName(args[1], 'name'); requireOptionalId(args[2], 'parent identifier');
  }
  if (channel === 'notebookSection:create') requireName(args[2], 'section name');
  if (channel === 'notebookPage:create') {
    requireName(args[3], 'page title');
    const type = args[4] ?? 'default';
    if (type !== 'default' && type !== 'pdf') throw new Error('Invalid page type.');
    requireOptionalId(args[5], 'PDF data identifier');
    if (type === 'pdf' && args[5] === undefined) throw new Error('PDF pages require a PDF data identifier.');
    if (type === 'default' && args[5] !== undefined) throw new Error('Default pages cannot reference PDF data.');
  }
  if (channel === 'notebook:applyPageDefaults') requirePagePropertyPatch(args[2], 'page defaults');
  if (channel === 'notebook:restorePageDefaults') requirePagePropertySnapshot(args[1]);
  if (channel === 'workspace:reorder') {
    if (!['folder', 'notebook', 'canvas', 'section', 'page'].includes(String(args[1])) || !Array.isArray(args[2]) || args[2].length > 10_000) throw new Error('Invalid reorder request.');
    args[2].forEach((id) => requireId(id, 'identifier'));
  }
  if (channel === 'trash:permanentlyDelete' && !['workspace', 'folder', 'canvas', 'notebook', 'section', 'page'].includes(String(args[2]))) {
    throw new Error('Invalid trash entity kind.');
  }
  if (['workspace:update', 'folder:update', 'canvasFile:update', 'notebook:update', 'notebookSection:update', 'notebookPage:update'].includes(channel)) requireUpdates(channel, args[2] ?? args[1]);
  if (['canvas:save', 'notebook:savePage', 'notebook:saveDrawing'].includes(channel)) requireJsonPayload(args[args.length - 1], 'content payload');
  if (channel === 'library:import' || channel === 'library:delete') requireLibraryFileName(args[1]);
  if (channel === 'library:import') {
    if (typeof args[2] !== 'string') throw new Error('Invalid Excalidraw library payload.');
    parseExcalidrawLibrary(args[2]);
  }
  if (channel === 'backup:import') {
    requireJsonPayload(args[0], 'backup payload', MAX_BACKUP_BYTES);
    validateWorkspaceBackup(args[0]);
  }
  if (channel === 'cloudsync:applyRemoteRecord') {
    requireId(args[0], 'workspace identifier');
    requirePlainObject(args[1], 'remote sync record');
    const record = args[1] as Record<string, unknown>;
    requireId(record.id, 'remote entity identifier');
    if (record.parentId !== undefined && record.parentId !== null) requireId(record.parentId, 'remote parent identifier');
    if (!['workspace', 'folder', 'notebook', 'notebookSection', 'notebookPage', 'pageContent', 'pageDrawing', 'canvasFile', 'canvasScene', 'customBlock'].includes(String(record.kind))) throw new Error('Invalid remote entity kind.');
    if (typeof record.tombstone !== 'boolean') throw new Error('Invalid remote tombstone.');
    if (!record.tombstone) requireJsonPayload(record.payload, 'remote sync payload');
  }
  if (channel === 'cloudsync:applyRemoteRecords') {
    requireId(args[0], 'workspace identifier');
    if (!Array.isArray(args[1]) || args[1].length > 100_000) throw new Error('Invalid remote sync record batch.');
    for (const candidate of args[1]) {
      requirePlainObject(candidate, 'remote sync record');
      const record = candidate as Record<string, unknown>;
      requireId(record.id, 'remote entity identifier');
      if (record.parentId !== undefined && record.parentId !== null) requireId(record.parentId, 'remote parent identifier');
      if (!['workspace', 'folder', 'notebook', 'notebookSection', 'notebookPage', 'pageContent', 'pageDrawing', 'canvasFile', 'canvasScene', 'customBlock'].includes(String(record.kind))) throw new Error('Invalid remote entity kind.');
      if (typeof record.tombstone !== 'boolean') throw new Error('Invalid remote tombstone.');
      if (!record.tombstone) requireJsonPayload(record.payload, 'remote sync payload');
    }
  }
  if (channel === 'settings:get' || channel === 'settings:set') {
    if (args[0] !== null) requireId(args[0], 'workspace identifier');
    if (typeof args[1] !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(args[1])) throw new Error('Invalid settings key.');
    if (channel === 'settings:set') requireJsonPayload(args[2], 'settings value');
  }
  if (channel === 'theme:set' && !['light', 'dark', 'ink'].includes(String(args[0]))) throw new Error('Invalid theme.');
  if (channel === 'binary:storePdf') {
    requireId(args[0], 'pdf identifier');
    requireName(args[1], 'pdf file name');
    if (!(args[2] instanceof ArrayBuffer) || args[2].byteLength === 0 || args[2].byteLength > MAX_BINARY_BYTES) {
      throw new Error('Invalid pdf payload.');
    }
  }
  if (channel === 'print:pdf') {
    const payload = args[0];
    if (!(payload instanceof ArrayBuffer) || payload.byteLength < 5 || payload.byteLength > MAX_BINARY_BYTES) {
      throw new Error('Invalid print PDF payload.');
    }
    const signature = new Uint8Array(payload, 0, 5);
    if (String.fromCharCode(...signature) !== '%PDF-') throw new Error('Invalid print PDF payload.');
  }
  if (channel === 'binary:storeImage') {
    requireId(args[0], 'image identifier');
    requireName(args[1], 'image file name');
    if (typeof args[2] !== 'string' || args[2].length === 0 || args[2].length > 128) throw new Error('Invalid image mime type.');
    if (!(args[3] instanceof ArrayBuffer) || args[3].byteLength === 0 || args[3].byteLength > MAX_BINARY_BYTES) {
      throw new Error('Invalid image payload.');
    }
  }
  if (channel === 'binary:storeAudio') {
    requireId(args[0], 'audio identifier');
    requireName(args[1], 'audio file name');
    if (typeof args[2] !== 'string' || args[2].length > 160 || !/^audio\/[a-z0-9.+-]{1,80}(\s*;\s*[a-z0-9.+-]{1,40}\s*=\s*[a-z0-9.+-]{1,80})*$/i.test(args[2])) throw new Error('Invalid audio mime type.');
    if (!(args[3] instanceof ArrayBuffer) || args[3].byteLength === 0 || args[3].byteLength > 100 * 1024 * 1024) throw new Error('Invalid audio payload.');
  }
  if (channel === 'binary:getPdf') requireId(args[0], 'pdf identifier');
  if (channel === 'binary:getImage') requireId(args[0], 'image identifier');
  if (channel === 'migration:importWorkspace') {
    requirePlainObject(args[0], 'workspace migration bundle');
    const bundle = args[0] as Record<string, any>;
    requirePlainObject(bundle.workspace, 'workspace migration');
    requireName(bundle.workspace.name, 'workspace name'); requireId(bundle.workspace.id, 'workspace identifier');
    requireJsonPayload(bundle.workspace, 'workspace migration');
    for (const key of ['canvasData', 'pageContents', 'pageDrawings', 'pdfFiles', 'imageFiles']) {
      if (!Array.isArray(bundle[key]) || bundle[key].length > 10_000) throw new Error(`Invalid migration ${key}.`);
    }
    for (const [collection, idKey] of [['notebooks', 'id'], ['notebookSections', 'id'], ['notebookPages', 'id']] as const) {
      for (const item of Array.isArray(bundle.workspace[collection]) ? bundle.workspace[collection] : []) {
        requirePlainObject(item, `${collection} migration`);
        requireId(item[idKey], `${collection} identifier`);
        if (collection === 'notebookSections') requireId(item.notebookId, 'notebook identifier');
        if (collection === 'notebookPages') {
          requireId(item.notebookId, 'notebook identifier');
          requireId(item.sectionId, 'section identifier');
        }
      }
    }
    for (const canvas of bundle.canvasData) { requirePlainObject(canvas, 'canvas migration'); requireId(canvas.canvasFileId, 'canvas identifier'); requireJsonPayload(canvas, 'canvas migration'); }
    for (const record of [...bundle.pageContents, ...bundle.pageDrawings]) { requirePlainObject(record, 'page payload migration'); requireId(record.pageId, 'page payload identifier'); requireId(record.notebookId, 'notebook identifier'); requireJsonPayload(record.data, 'page payload migration'); }
    for (const asset of [...bundle.pdfFiles, ...bundle.imageFiles]) {
      requirePlainObject(asset, 'asset migration'); requireId(asset.id, 'asset identifier'); requireName(asset.fileName, 'asset file name');
      if (!(asset.data instanceof ArrayBuffer) || asset.data.byteLength === 0 || asset.data.byteLength > MAX_BINARY_BYTES) throw new Error('Invalid migration asset payload.');
    }
  }
}

function registerHandler(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    requireTrustedSender(event);
    validateArguments(channel, args);
    return handler(event, ...args);
  });
}

function requireWorkspacePage(ws: any, notebookId: string, pageFileId: string): any {
  const canonicalPageId = parsePdfAnnotationStorageId(pageFileId)?.ownerPageId ?? pageFileId;
  const page = (ws.notebookPages ?? []).find((item: any) => item.id === canonicalPageId && item.notebookId === notebookId && !item.deletedAt);
  if (!page || (canonicalPageId !== pageFileId && page.type !== 'pdf')) throw new Error('Notebook page does not belong to the requested notebook.');
  return page;
}

type PermanentTrashKind = 'workspace' | 'folder' | 'canvas' | 'notebook' | 'section' | 'page';

async function removeNotebookPagePayloads(workspaceDir: string, notebookId: string, pageId: string): Promise<void> {
  const pagesDir = path.join(workspaceDir, 'Notebooks', notebookId, 'pages');
  await Promise.all([
    fsPromises.rm(path.join(pagesDir, `${pageId}.json`), { force: true }),
    fsPromises.rm(path.join(pagesDir, `${pageId}.content.json`), { force: true }),
    fsPromises.rm(path.join(pagesDir, `${pageId}.drawing.json`), { force: true }),
  ]);
}

async function removeCanvasPayload(workspaceDir: string, canvasId: string): Promise<void> {
  await fsPromises.rm(path.join(workspaceDir, 'Canvas', `${canvasId}.json`), { force: true });
}

/** Permanently removes a single Trash root and everything owned by it. */
async function permanentlyDeleteWorkspaceEntity(workspaceId: string, id: string, kind: PermanentTrashKind): Promise<boolean> {
  const workspaceDir = workspaceService.getWorkspaceDirById(workspaceId);
  if (kind === 'workspace') {
    await fsPromises.rm(workspaceDir, { recursive: true, force: true });
    workspaceService.unregisterWorkspace(workspaceId);
    return true;
  }

  const ws = await workspaceService.readWorkspaceJson(workspaceDir);
  const folders: any[] = ws.folders ?? [];
  const canvases: any[] = ws.canvasFiles ?? [];
  const notebooks: any[] = ws.notebooks ?? [];
  const sections: any[] = ws.notebookSections ?? [];
  const pages: any[] = ws.notebookPages ?? [];
  const folderIds = new Set<string>();
  // notebookIds: notebooks whose METADATA records are being permanently removed.
  const notebookIds = new Set<string>();
  // ownerNotebookIds: notebook IDs used only to locate page payload files on
  // disk (Notebooks/<notebookId>/pages/*). For section/page deletions the
  // parent notebook stays alive — its ID must NOT appear in notebookIds.
  const ownerNotebookIds = new Set<string>();
  const sectionIds = new Set<string>();
  const pageIds = new Set<string>();
  const canvasIds = new Set<string>();

  if (kind === 'folder') {
    folderIds.add(id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders) if (folder.parentId && folderIds.has(folder.parentId) && !folderIds.has(folder.id)) {
        folderIds.add(folder.id);
        changed = true;
      }
    }
    for (const notebook of notebooks) if (notebook.folderId && folderIds.has(notebook.folderId)) notebookIds.add(notebook.id);
  } else if (kind === 'notebook') {
    notebookIds.add(id);
  } else if (kind === 'section') {
    sectionIds.add(id);
    // The parent notebook is NOT being deleted — only used for payload paths.
    const section = sections.find(item => item.id === id);
    if (section) ownerNotebookIds.add(section.notebookId);
  } else if (kind === 'page') {
    pageIds.add(id);
    // The parent notebook is NOT being deleted — only used for payload paths.
    const page = pages.find(item => item.id === id);
    if (page) ownerNotebookIds.add(page.notebookId);
  } else if (kind === 'canvas') {
    canvasIds.add(id);
  }

  // Merge notebookIds into ownerNotebookIds so payload lookups cover both.
  for (const nbId of notebookIds) ownerNotebookIds.add(nbId);

  if (kind === 'folder' || kind === 'notebook') {
    for (const section of sections) if (notebookIds.has(section.notebookId)) sectionIds.add(section.id);
    for (const page of pages) if (notebookIds.has(page.notebookId)) pageIds.add(page.id);
  } else if (kind === 'section') {
    for (const page of pages) if (page.sectionId === id) pageIds.add(page.id);
  }
  if (kind === 'folder' || kind === 'notebook' || kind === 'section') {
    for (const canvas of canvases) {
      if ((canvas.folderId && folderIds.has(canvas.folderId)) || (canvas.notebookId && notebookIds.has(canvas.notebookId)) || (canvas.sectionId && sectionIds.has(canvas.sectionId))) canvasIds.add(canvas.id);
    }
  }

  const targetExists = kind === 'folder' ? folders.some(item => item.id === id)
    : kind === 'canvas' ? canvases.some(item => item.id === id)
      : kind === 'notebook' ? notebooks.some(item => item.id === id)
        : kind === 'section' ? sections.some(item => item.id === id)
          : pages.some(item => item.id === id);
  if (!targetExists) return false;

  // Remove page payload files (content/drawing JSON) using ownerNotebookIds
  // for the disk path, since pages live under Notebooks/<notebookId>/pages/.
  for (const page of pages) if (pageIds.has(page.id)) await removeNotebookPagePayloads(workspaceDir, page.notebookId, page.id);
  // Only remove entire notebook directories when the notebook itself is being deleted.
  if (kind === 'folder' || kind === 'notebook') {
    for (const notebookId of notebookIds) await fsPromises.rm(path.join(workspaceDir, 'Notebooks', notebookId), { recursive: true, force: true });
  }
  for (const canvasId of canvasIds) await removeCanvasPayload(workspaceDir, canvasId);

  ws.folders = folders.filter(item => !folderIds.has(item.id));
  // Only remove notebook records that are actually being deleted (not parent lookups).
  ws.notebooks = notebooks.filter(item => !notebookIds.has(item.id));
  ws.notebookSections = sections.filter(item => !sectionIds.has(item.id));
  ws.notebookPages = pages.filter(item => !pageIds.has(item.id));
  ws.canvasFiles = canvases.filter(item => !canvasIds.has(item.id));
  await workspaceService.writeWorkspaceJson(workspaceDir, ws);
  return true;
}

export function registerDomainHandlers() {
  registerHandler('print:pdf', async (event, payload: ArrayBuffer) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const tempRoot = path.resolve(app.getPath('temp'));
    return runNativePdfPrint(new Uint8Array(payload), {
      createTemporaryPdf: async bytes => {
        const directory = await fsPromises.mkdtemp(path.join(tempRoot, 'panvas-print-'));
        const resolvedDirectory = path.resolve(directory);
        if (path.dirname(resolvedDirectory) !== tempRoot || !path.basename(resolvedDirectory).startsWith('panvas-print-')) {
          throw new Error('Unsafe print temporary directory.');
        }
        const filePath = path.join(resolvedDirectory, 'document.pdf');
        await fsPromises.writeFile(filePath, bytes);
        return {
          filePath,
          cleanup: () => fsPromises.rm(resolvedDirectory, { recursive: true, force: true }),
        };
      },
      createPrintWindow: () => new BrowserWindow({
        show: false,
        parent,
        title: 'Panvas Print Preview',
        autoHideMenuBar: true,
        width: 960,
        height: 720,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          devTools: false,
        },
      }),
    });
  });

  // ---- WORKSPACE ----

  registerHandler('workspace:create', async (event, name: string) => {
    await workspaceService.ensureBaseDir();
    await workspaceService.assertStorageRootAvailable();
    const workspaceId = generateId('ws');
    const workspaceDir = workspaceService.getWorkspaceDirByName(name);
    const panvasDir = path.join(workspaceDir, '.panvas');
    
    await fsPromises.mkdir(panvasDir, { recursive: true });
    
    const now = Date.now();
    const workspaceObj = {
      id: workspaceId,
      name,
      createdAt: now,
      updatedAt: now,
      isPinned: false,
      syncStatus: 'local',
      userId: null,
      deletedAt: null,
      isSystem: false,
      version: 1,
      folders: [],
      canvasFiles: [],
      notebooks: [],
      notebookSections: [],
      notebookPages: []
    };

    await fsPromises.writeFile(path.join(panvasDir, 'system.json'), JSON.stringify({ version: 1, migration_complete: true }, null, 2));
    await fsPromises.writeFile(path.join(panvasDir, 'workspace.json'), JSON.stringify(workspaceObj, null, 2));
    await fsPromises.writeFile(path.join(panvasDir, 'settings.json'), JSON.stringify({ version: 1 }, null, 2));
    
    await fsPromises.mkdir(path.join(panvasDir, 'journal'), { recursive: true });
    await fsPromises.mkdir(path.join(panvasDir, 'recovery'), { recursive: true });
    await fsPromises.mkdir(path.join(panvasDir, 'temp'), { recursive: true });
    await fsPromises.mkdir(path.join(panvasDir, 'Plugins'), { recursive: true });
    
    await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'images'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'pdfs'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'videos'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'audio'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'attachments'), { recursive: true });
    
    await fsPromises.mkdir(path.join(workspaceDir, 'Notebooks'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'Canvas'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'PDF'), { recursive: true });
    
    workspaceService.registerWorkspace(workspaceId, workspaceDir);
    await workspaceService.rememberWorkspaceLocation(workspaceId, workspaceDir);
    return workspaceObj;
  });

  registerHandler('workspace:openDialog', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win 
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    
    const workspaceDir = result.filePaths[0];
    const panvasDir = path.join(workspaceDir, '.panvas');
    
    // Check if it's already a workspace
    if (fs.existsSync(panvasDir)) {
      try {
        const ws = await workspaceService.readWorkspaceJson(workspaceDir);
        workspaceService.registerWorkspace(ws.id, workspaceDir);
        await workspaceService.rememberWorkspaceLocation(ws.id, workspaceDir);
        return ws;
      } catch (e) {
        throw new Error('Selected folder is not a valid Panvas workspace or is corrupted.');
      }
    } else {
      // Initialize new workspace
      const name = path.basename(workspaceDir);
      const workspaceId = generateId('ws');
      
      await fsPromises.mkdir(panvasDir, { recursive: true });
      
      const now = Date.now();
      const workspaceObj = {
        id: workspaceId,
        name,
        createdAt: now,
        updatedAt: now,
        isPinned: false,
        syncStatus: 'local',
        userId: null,
        deletedAt: null,
        isSystem: false,
        version: 1,
        folders: [],
        canvasFiles: [],
        notebooks: [],
        notebookSections: [],
        notebookPages: []
      };

      await fsPromises.writeFile(path.join(panvasDir, 'system.json'), JSON.stringify({ version: 1, migration_complete: true }, null, 2));
      await fsPromises.writeFile(path.join(panvasDir, 'workspace.json'), JSON.stringify(workspaceObj, null, 2));
      await fsPromises.writeFile(path.join(panvasDir, 'settings.json'), JSON.stringify({ version: 1 }, null, 2));
      
      await fsPromises.mkdir(path.join(panvasDir, 'journal'), { recursive: true });
      await fsPromises.mkdir(path.join(panvasDir, 'recovery'), { recursive: true });
      await fsPromises.mkdir(path.join(panvasDir, 'temp'), { recursive: true });
      await fsPromises.mkdir(path.join(panvasDir, 'Plugins'), { recursive: true });
      
      await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'images'), { recursive: true });
      await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'pdfs'), { recursive: true });
      await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'videos'), { recursive: true });
      await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'audio'), { recursive: true });
      await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'attachments'), { recursive: true });
      
      await fsPromises.mkdir(path.join(workspaceDir, 'Notebooks'), { recursive: true });
      await fsPromises.mkdir(path.join(workspaceDir, 'Canvas'), { recursive: true });
      await fsPromises.mkdir(path.join(workspaceDir, 'PDF'), { recursive: true });
      
      workspaceService.registerWorkspace(workspaceId, workspaceDir);
      await workspaceService.rememberWorkspaceLocation(workspaceId, workspaceDir);
      return workspaceObj;
    }
  });

  // Storage preferences affect only where future workspaces and new binary
  // assets are created. Existing registered workspace directories remain in
  // the service registry and are never moved by this operation.
  registerHandler('storage:getRoot', async () => workspaceService.getStorageRootInfo());

  registerHandler('storage:setRoot', async (_event, selectedPath: string) => workspaceService.setStorageRoot(selectedPath));

  registerHandler('storage:chooseRoot', async (event) => {
    let result: Awaited<ReturnType<typeof dialog.showOpenDialog>>;
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      result = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    } catch {
      throw new Error('The storage folder chooser is unavailable.');
    }
    if (result.canceled || result.filePaths.length === 0) return null;
    try {
      return await workspaceService.setStorageRoot(result.filePaths[0]);
    } catch {
      throw new Error('The selected storage folder is unavailable or not writable.');
    }
  });

  registerHandler('workspace:getAll', async (event) => {
    const entries = await workspaceService.discoverWorkspaces();
    return entries.map(entry => entry.workspace).filter(workspace => !workspace.deletedAt);
  });

  registerHandler('workspace:getRecoveryWorkspaceRoot', async (_event, workspaceId: string) => workspaceService.getRecoveryWorkspaceRoot(workspaceId));

  registerHandler('workspace:getStartupSnapshot', async () => workspaceService.getStartupSnapshot());

  registerHandler('workspace:update', async (event, workspaceId: string, updates: any) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const updatedAt = Date.now();
    const ordinaryUpdates = { ...updates };
    delete ordinaryUpdates.deletedAt;
    Object.assign(ws, ordinaryUpdates, { updatedAt });
    if ('deletedAt' in updates) {
      setWorkspaceDeletedAt({
        workspaces: [ws],
        folders: ws.folders ?? [],
        canvasFiles: ws.canvasFiles ?? [],
        notebooks: ws.notebooks ?? [],
        notebookSections: ws.notebookSections ?? [],
        notebookPages: ws.notebookPages ?? [],
      }, workspaceId, updates.deletedAt, updatedAt);
    }
    await workspaceService.writeWorkspaceJson(dir, ws);
    return ws;
  });

  registerHandler('workspace:reorder', async (event, workspaceId: string, type: 'folder' | 'notebook' | 'canvas' | 'section' | 'page', itemIds: string[]) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    
    let array: any[];
    if (type === 'folder') array = ws.folders;
    else if (type === 'notebook') array = ws.notebooks;
    else if (type === 'canvas') array = ws.canvasFiles;
    else if (type === 'section') array = ws.notebookSections;
    else if (type === 'page') array = ws.notebookPages;
    else return false;

    const idToIndex = new Map(itemIds.map((id, index) => [id, index]));
    
    array.sort((a, b) => {
      const idxA = idToIndex.has(a.id) ? idToIndex.get(a.id)! : 999999;
      const idxB = idToIndex.has(b.id) ? idToIndex.get(b.id)! : 999999;
      return idxA - idxB;
    });

    array.forEach((item, index) => {
      item.order = index;
    });

    await workspaceService.writeWorkspaceJson(dir, ws);
    return true;
  });

  // ---- FOLDERS ----
  
  registerHandler('folder:create', async (event, workspaceId: string, name: string, parentId: string | null) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const folder = {
      id: generateId('f'),
      workspaceId,
      parentId,
      name,
      order: ws.folders.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
      isExpanded: false
    };
    ws.folders.push(folder);
    await workspaceService.writeWorkspaceJson(dir, ws);
    return folder;
  });

  registerHandler('folder:getAll', async (event, workspaceId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    return ws.folders || [];
  });

  registerHandler('folder:update', async (event, workspaceId: string, folderId: string, updates: any) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const folder = ws.folders.find((f: any) => f.id === folderId);
    if (folder) {
      const updatedAt = Date.now();
      const ordinaryUpdates = { ...updates };
      delete ordinaryUpdates.deletedAt;
      Object.assign(folder, ordinaryUpdates, { updatedAt });
      if ('deletedAt' in updates) {
        setFolderDeletedAt(ws, folderId, updates.deletedAt, updatedAt);
      }
      await workspaceService.writeWorkspaceJson(dir, ws);
    }
    return folder;
  });

  registerHandler('folder:delete', async (event, workspaceId: string, folderId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    ws.folders = ws.folders.filter((f: any) => f.id !== folderId);
    await workspaceService.writeWorkspaceJson(dir, ws);
    return true;
  });

  // ---- CANVAS FILES (Metadata) ----
  
  registerHandler('canvasFile:create', async (event, workspaceId: string, name: string, folderId: string | null, notebookId: string | null, sectionId: string | null) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const canvasFile = {
      id: generateId('canvas'),
      workspaceId,
      folderId,
      notebookId,
      sectionId,
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
      order: ws.canvasFiles.length,
      isPinned: false,
      deletedAt: null
    };
    ws.canvasFiles.push(canvasFile);
    await workspaceService.writeWorkspaceJson(dir, ws);
    
    // Create the empty canvas content file
    const canvasData = { canvasFileId: canvasFile.id, elements: [], appState: {}, files: {}, version: 1 };
    const contentPath = path.join(dir, 'Canvas', `${canvasFile.id}.json`);
    await writeQueue.enqueue(contentPath, JSON.stringify(canvasData, null, 2));
    
    return canvasFile;
  });

  registerHandler('canvasFile:getAll', async (event, workspaceId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    return ws.canvasFiles || [];
  });

  registerHandler('canvasFile:update', async (event, workspaceId: string, canvasId: string, updates: any) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const canvas = ws.canvasFiles.find((c: any) => c.id === canvasId);
    if (canvas) {
      const updatedAt = Date.now();
      const ordinaryUpdates = { ...updates };
      delete ordinaryUpdates.deletedAt;
      Object.assign(canvas, ordinaryUpdates, { updatedAt });
      if ('deletedAt' in updates) setCanvasDeletedAt(ws, canvasId, updates.deletedAt, updatedAt);
      await workspaceService.writeWorkspaceJson(dir, ws);
    }
    return canvas;
  });

  registerHandler('canvasFile:delete', async (event, workspaceId: string, canvasId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    ws.canvasFiles = ws.canvasFiles.filter((c: any) => c.id !== canvasId);
    await workspaceService.writeWorkspaceJson(dir, ws);
    return true;
  });

  // ---- CANVAS DATA (Content) ----

  registerHandler('canvas:save', async (event, workspaceId: string, canvasId: string, data: any) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const contentPath = path.join(dir, 'Canvas', `${canvasId}.json`);
    await writeQueue.enqueue(contentPath, JSON.stringify(data, null, 2));
  });

  registerHandler('canvas:load', async (event, workspaceId: string, canvasId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const contentPath = path.join(dir, 'Canvas', `${canvasId}.json`);
    if (fs.existsSync(contentPath)) {
      const content = await fsPromises.readFile(contentPath, 'utf8');
      return JSON.parse(content);
    }
    return null;
  });

  // ---- EXCALIDRAW LIBRARIES ----
  // Libraries are workspace-local, inert JSON assets. The renderer can only
  // access validated .excalidrawlib payloads through these narrow channels.
  registerHandler('library:getAll', async (event, workspaceId: string) => {
    const libraryDir = path.join(workspaceService.getWorkspaceDirById(workspaceId), '.panvas', 'Libraries');
    await fsPromises.mkdir(libraryDir, { recursive: true });
    const entries = await fsPromises.readdir(libraryDir, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.excalidrawlib')) continue;
      try {
        requireLibraryFileName(entry.name);
        const filePath = path.join(libraryDir, entry.name);
        const [contents, stat] = await Promise.all([
          fsPromises.readFile(filePath, 'utf8'),
          fsPromises.stat(filePath),
        ]);
        records.push({
          fileName: entry.name,
          name: libraryDisplayName(entry.name),
          libraryItems: parseExcalidrawLibrary(contents),
          updatedAt: stat.mtimeMs,
          size: stat.size,
        });
      } catch (error) {
        console.warn(`[library:getAll] Ignoring invalid library ${entry.name}:`, error);
      }
    }
    return records.sort((left, right) => left.name.localeCompare(right.name));
  });

  registerHandler('library:import', async (event, workspaceId: string, fileName: string, contents: string) => {
    const libraryItems = parseExcalidrawLibrary(contents);
    const serialized = serializeExcalidrawLibrary(libraryItems);
    const libraryDir = path.join(workspaceService.getWorkspaceDirById(workspaceId), '.panvas', 'Libraries');
    await fsPromises.mkdir(libraryDir, { recursive: true });
    const filePath = path.join(libraryDir, fileName);
    await writeQueue.enqueue(filePath, serialized);
    const stat = await fsPromises.stat(filePath);
    return {
      fileName,
      name: libraryDisplayName(fileName),
      libraryItems,
      updatedAt: stat.mtimeMs,
      size: stat.size,
    };
  });

  registerHandler('library:delete', async (event, workspaceId: string, fileName: string) => {
    const libraryDir = path.join(workspaceService.getWorkspaceDirById(workspaceId), '.panvas', 'Libraries');
    await fsPromises.rm(path.join(libraryDir, fileName), { force: true });
    return true;
  });
  
  // ---- NOTEBOOKS ----

  registerHandler('notebook:create', async (event, workspaceId: string, name: string, folderId: string | null) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    
    // Create notebook dir
    const notebook = {
      id: generateId('nb'),
      workspaceId,
      folderId,
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
      order: 0,
      isPinned: false,
      defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET },
      deletedAt: null
    };
    
    const nbDir = path.join(dir, 'Notebooks', notebook.id);
    await fsPromises.mkdir(path.join(nbDir, 'pages'), { recursive: true });
    
    await writeQueue.enqueue(path.join(nbDir, 'notebook.json'), JSON.stringify(notebook, null, 2));
    
    // We also need to update workspace.json temporarily until we refactor loadWorkspaceContents
    const ws = await workspaceService.readWorkspaceJson(dir);
    ws.notebooks.push(notebook);
    await workspaceService.writeWorkspaceJson(dir, ws);
    
    return notebook;
  });

  registerHandler('notebook:getAll', async (event, workspaceId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    return ws.notebooks || [];
  });

  registerHandler('notebook:update', async (event, workspaceId: string, notebookId: string, updates: any) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const nb = ws.notebooks.find((n: any) => n.id === notebookId);
    if (nb) {
      if (updates.defaultPageProperties) {
        updates = {
          ...updates,
          defaultPageProperties: {
            ...DEFAULT_PAGE_PROPERTY_SET,
            ...(nb.defaultPageProperties ?? {}),
            ...updates.defaultPageProperties,
          },
        };
      }
      const updatedAt = Date.now();
      const ordinaryUpdates = { ...updates };
      delete ordinaryUpdates.deletedAt;
      Object.assign(nb, ordinaryUpdates, { updatedAt });
      if ('deletedAt' in updates) {
        setNotebookDeletedAt(ws, notebookId, updates.deletedAt, updatedAt);
      }
      await workspaceService.writeWorkspaceJson(dir, ws);
    }
    return nb;
  });

  registerHandler('notebook:applyPageDefaults', async (event, workspaceId: string, notebookId: string, updates: any) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const notebook = ws.notebooks.find((item: any) => item.id === notebookId && !item.deletedAt);
    if (!notebook) throw new Error('Notebook not found.');
    const pages = ws.notebookPages.filter((item: any) => item.notebookId === notebookId && !item.deletedAt && item.type !== 'pdf');
    const snapshot = {
      notebookId,
      defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET, ...(notebook.defaultPageProperties ?? {}) },
      pages: pages.map((page: any) => ({ pageId: page.id, overrides: { ...(page.pagePropertyOverrides ?? {}) } })),
    };
    notebook.defaultPageProperties = {
      ...DEFAULT_PAGE_PROPERTY_SET,
      ...(notebook.defaultPageProperties ?? {}),
      ...updates,
    };
    notebook.updatedAt = Date.now();
    const changedKeys = Object.keys(updates);
    for (const page of pages) {
      const overrides = { ...(page.pagePropertyOverrides ?? {}) };
      for (const key of changedKeys) delete overrides[key];
      page.pagePropertyOverrides = overrides;
      page.updatedAt = Date.now();
    }
    // One canonical metadata write makes the notebook default and every page's
    // inheritance marker visible together.
    await workspaceService.writeWorkspaceJson(dir, ws);
    return snapshot;
  });

  registerHandler('notebook:restorePageDefaults', async (event, workspaceId: string, snapshot: any) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const notebook = ws.notebooks.find((item: any) => item.id === snapshot.notebookId && !item.deletedAt);
    if (!notebook) throw new Error('Notebook not found.');
    notebook.defaultPageProperties = { ...snapshot.defaultPageProperties };
    notebook.updatedAt = Date.now();
    const allowedPages = new Map(snapshot.pages.map((entry: any) => [entry.pageId, entry.overrides]));
    for (const page of ws.notebookPages.filter((item: any) => item.notebookId === snapshot.notebookId && allowedPages.has(item.id))) {
      page.pagePropertyOverrides = { ...(allowedPages.get(page.id) as object) };
      page.updatedAt = Date.now();
    }
    await workspaceService.writeWorkspaceJson(dir, ws);
    return true;
  });

  registerHandler('notebook:delete', async (event, workspaceId: string, notebookId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const notebook = ws.notebooks.find((n: any) => n.id === notebookId);
    if (notebook) {
      // Soft delete: the record and all page content stay on disk and remain
      // restorable from trash. Hard deletion is a separate explicit operation.
      setNotebookDeletedAt(ws, notebookId, Date.now());
      await workspaceService.writeWorkspaceJson(dir, ws);
    }
    return true;
  });

  registerHandler('notebookSection:create', async (event, workspaceId: string, notebookId: string, name: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const section = {
      id: generateId('sec'),
      notebookId,
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      order: 0,
      deletedAt: null
    };
    
    // For now, continue saving sections in workspace.json to avoid rewriting the entire read path for sections immediately
    const ws = await workspaceService.readWorkspaceJson(dir);
    section.order = ws.notebookSections.length;
    ws.notebookSections.push(section);
    await workspaceService.writeWorkspaceJson(dir, ws);
    return section;
  });

  registerHandler('notebookSection:getAll', async (event, workspaceId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    return ws.notebookSections || [];
  });

  registerHandler('notebookSection:update', async (event, workspaceId: string, sectionId: string, updates: any) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const section = ws.notebookSections.find((s: any) => s.id === sectionId);
    if (section) {
      const updatedAt = Date.now();
      const ordinaryUpdates = { ...updates };
      delete ordinaryUpdates.deletedAt;
      Object.assign(section, ordinaryUpdates, { updatedAt });
      if ('deletedAt' in updates) {
        setSectionDeletedAt(ws, sectionId, updates.deletedAt, updatedAt);
      }
      await workspaceService.writeWorkspaceJson(dir, ws);
    }
    return section;
  });

  registerHandler('notebookSection:delete', async (event, workspaceId: string, sectionId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    if (setSectionDeletedAt(ws, sectionId, Date.now())) {
      await workspaceService.writeWorkspaceJson(dir, ws);
    }
    return true;
  });

  registerHandler('notebookPage:create', async (event, workspaceId: string, notebookId: string, sectionId: string, title: string, type: 'default' | 'pdf' = 'default', pdfDataId?: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const pageId = generateId('page');
    const now = Date.now();
    return createNotebookPageFiles({
      workspaceDir: dir,
      workspace: ws,
      notebookId,
      sectionId,
      title,
      type,
      pdfDataId,
      pageId,
      now,
      writeWorkspace: () => workspaceService.writeWorkspaceJson(dir, ws),
      writeQueue,
    });
  });

  registerHandler('notebookPage:getAll', async (event, workspaceId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    return ws.notebookPages || [];
  });

  registerHandler('notebookPage:update', async (event, workspaceId: string, pageId: string, updates: any) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const page = ws.notebookPages.find((p: any) => p.id === pageId);
    if (page) {
      const updatedAt = Date.now();
      const ordinaryUpdates = { ...updates };
      delete ordinaryUpdates.deletedAt;
      Object.assign(page, ordinaryUpdates, { updatedAt });
      if ('deletedAt' in updates) {
        if (updates.deletedAt === null) {
          page.deletedAt = null;
          page.updatedAt = updatedAt;
          delete page.deletedByAncestorId;
        } else {
          page.deletedAt = updates.deletedAt;
          page.updatedAt = updatedAt;
          delete page.deletedByAncestorId;
        }
      }
      await workspaceService.writeWorkspaceJson(dir, ws);
    }
    return page;
  });

  registerHandler('notebookPage:delete', async (event, workspaceId: string, pageId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    const ws = await workspaceService.readWorkspaceJson(dir);
    const page = ws.notebookPages.find((p: any) => p.id === pageId);
    if (page) {
      // Soft delete: the page record and its drawing/content files stay on
      // disk and remain restorable from trash.
      const now = Date.now();
      page.deletedAt = now;
      page.updatedAt = now;
      delete page.deletedByAncestorId;
      await workspaceService.writeWorkspaceJson(dir, ws);
    }
    return true;
  });

  registerHandler('trash:getAll', async (event, workspaceId: string | null = null) => {
    const workspaces: any[] = [];
    if (workspaceId) {
      const dir = workspaceService.getWorkspaceDirById(workspaceId);
      workspaces.push(await workspaceService.readWorkspaceJson(dir));
    } else {
      const entries = await workspaceService.discoverWorkspaces();
      workspaces.push(...entries.map(entry => entry.workspace));
    }
    const merged = workspaces.reduce((result, ws) => {
      // Workspace JSON stores its root as the document itself; the shared
      // trash model expects workspace roots in a `workspaces` collection.
      const roots = getDeletedWorkspaceItems({ ...ws, workspaces: [ws] });
      result.workspaces.push(...roots.workspaces);
      result.folders.push(...roots.folders);
      result.canvasFiles.push(...roots.canvasFiles);
      result.notebooks.push(...roots.notebooks);
      result.sections.push(...roots.sections);
      result.pages.push(...roots.pages);
      return result;
    }, { workspaces: [], folders: [], canvasFiles: [], notebooks: [], sections: [], pages: [] } as Record<string, any[]>);
    return merged;
  });

  registerHandler('trash:permanentlyDelete', async (event, workspaceId: string, id: string, kind: PermanentTrashKind) => (
    permanentlyDeleteWorkspaceEntity(workspaceId, id, kind)
  ));

  registerHandler('notebook:savePage', async (event, workspaceId: string, notebookId: string, pageId: string, data: any) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    requireWorkspacePage(await workspaceService.readWorkspaceJson(dir), notebookId, pageId);
    const pagesDir = path.join(dir, 'Notebooks', notebookId, 'pages');
    await fsPromises.mkdir(pagesDir, { recursive: true });
    
    const contentPath = path.join(pagesDir, `${pageId}.content.json`);
    await writeQueue.enqueue(contentPath, JSON.stringify(data, null, 2));
  });

  registerHandler('notebook:loadPage', async (event, workspaceId: string, notebookId: string, pageId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    requireWorkspacePage(await workspaceService.readWorkspaceJson(dir), notebookId, pageId);
    const contentPath = path.join(dir, 'Notebooks', notebookId, 'pages', `${pageId}.content.json`);
    if (fs.existsSync(contentPath)) {
      const content = await fsPromises.readFile(contentPath, 'utf8');
      return JSON.parse(content);
    }
    return null;
  });

  registerHandler('notebook:saveDrawing', async (event, workspaceId: string, notebookId: string, pageId: string, drawingData: any) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    requireWorkspacePage(await workspaceService.readWorkspaceJson(dir), notebookId, pageId);
    const pagesDir = path.join(dir, 'Notebooks', notebookId, 'pages');
    await fsPromises.mkdir(pagesDir, { recursive: true });

    const drawingPath = path.join(pagesDir, `${pageId}.drawing.json`);
    await writeQueue.enqueue(drawingPath, JSON.stringify(drawingData, null, 2));
  });

  registerHandler('notebook:loadDrawing', async (event, workspaceId: string, notebookId: string, pageId: string) => {
    const dir = workspaceService.getWorkspaceDirById(workspaceId);
    requireWorkspacePage(await workspaceService.readWorkspaceJson(dir), notebookId, pageId);
    const drawingPath = path.join(dir, 'Notebooks', notebookId, 'pages', `${pageId}.drawing.json`);
    if (fs.existsSync(drawingPath)) {
      const content = await fsPromises.readFile(drawingPath, 'utf8');
      return JSON.parse(content);
    }
    return null;
  });

  // ---- BACKUP / RESTORE ----
  registerHandler('backup:export', async (event, workspaceId: string) => {
    const backup = await workspaceService.exportWorkspaceBackup(workspaceId);
    const win = BrowserWindow.fromWebContents(event.sender);
    const filters = [{ name: 'Panvas Workspace Backup (*.panvas-backup.json, *.json)', extensions: ['panvas-backup.json', 'json', 'panvas-backup'] }];
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath: `${backup.header.workspaceName}.panvas-backup.json`, filters })
      : await dialog.showSaveDialog({ defaultPath: `${backup.header.workspaceName}.panvas-backup.json`, filters });
    if (result.canceled || !result.filePath) return { backup, canceled: true };
    await writeQueue.enqueue(result.filePath, JSON.stringify(backup, null, 2));
    return { backup, savedPath: result.filePath };
  });

  registerHandler('backup:import', async (event, backup: unknown) => workspaceService.importWorkspaceBackup(backup));

  registerHandler('backup:importDialog', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const filters = [{ name: 'Panvas Workspace Backup (*.panvas-backup.json, *.json)', extensions: ['panvas-backup.json', 'json', 'panvas-backup'] }];
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
      : await dialog.showOpenDialog({ properties: ['openFile'], filters });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const fileInfo = await fsPromises.stat(result.filePaths[0]);
    if (fileInfo.size > MAX_BACKUP_BYTES) throw new Error('The selected backup file is too large.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fsPromises.readFile(result.filePaths[0], 'utf8'));
    } catch {
      throw new Error('This file is not a valid Panvas workspace backup.');
    }
    try {
      return await workspaceService.importWorkspaceBackup(parsed);
    } catch (error) {
      console.warn('[backup:importDialog] Backup validation error:', error);
      throw new Error('This file is not a valid Panvas workspace backup.');
    }
  });

  // ---- SETTINGS ----
  registerHandler('settings:get', async (event, workspaceId: string | null, key: string) => {
    // For now, settings are workspace-specific since there's no global config file in this app's current fs architecture.
    // However, if workspaceId is null, we might need a fallback or global settings.
    // In Joplin, settings are global. Let's create a global settings file in the panvasDataDir.
    const settingsPath = workspaceId
      ? path.join(workspaceService.getWorkspaceDirById(workspaceId), '.panvas', 'settings.json')
      : path.join(app.getPath('userData'), 'panvas', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const content = await fsPromises.readFile(settingsPath, 'utf8');
      const settings = JSON.parse(content);
      return settings[key] !== undefined ? settings[key] : null;
    }
    return null;
  });

  registerHandler('settings:set', async (event, workspaceId: string | null, key: string, value: any) => {
    const settingsPath = workspaceId
      ? path.join(workspaceService.getWorkspaceDirById(workspaceId), '.panvas', 'settings.json')
      : path.join(app.getPath('userData'), 'panvas', 'settings.json');
    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
      const content = await fsPromises.readFile(settingsPath, 'utf8');
      settings = JSON.parse(content);
    } else {
      await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
    }
    settings[key] = value;
    await writeQueue.enqueue(settingsPath, JSON.stringify(settings, null, 2));
    return true;
  });

  // ---- THEME ----
  registerHandler('theme:set', async (event, theme: 'light' | 'dark' | 'ink') => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      // Transparent background so the app's own header shows through; only the
      // symbol color needs to contrast with the active theme.
      // Ink is a paper-toned light theme, not a dark theme. Treating it as
      // dark makes the native minimize/maximize/close glyphs disappear
      // against the title-bar surface.
      const symbolColor = theme === 'dark' ? '#f6f3ed' : '#2f2921';
      win.setTitleBarOverlay({
        color: '#00000000',
        symbolColor
      });
    }
    return true;
  });

  // ---- BINARY ASSETS (PDF) ----
  // The renderer's IndexedDB is origin/profile scoped: PDF bytes stored only
  // there are lost whenever the app runs from a different profile or origin
  // (dev vs packaged build, http dev server vs file://), while the page
  // references live on the filesystem and survive. The filesystem is the
  // durability boundary: store the bytes under Documents/Panvas/Assets keyed
  // by the validated pdf id. The .bin is written before the .meta.json, so a
  // metadata file's presence implies a complete payload.

  registerHandler('binary:storePdf', async (event, id: string, fileName: string, data: ArrayBuffer) => {
    await workspaceService.ensureBaseDir();
    await workspaceService.assertStorageRootAvailable();
    const dir = workspaceService.getPdfStoreDir();
    await fsPromises.mkdir(dir, { recursive: true });
    await writeQueue.enqueue(path.join(dir, `${id}.bin`), new Uint8Array(data));
    await writeQueue.enqueue(path.join(dir, `${id}.meta.json`), JSON.stringify({ id, fileName, createdAt: Date.now() }, null, 2));
    return true;
  });

  registerHandler('binary:getPdf', async (event, id: string) => {
    await workspaceService.ensureBaseDir();
    const dir = workspaceService.getPdfStoreDir();
    try {
      const meta = JSON.parse(await fsPromises.readFile(path.join(dir, `${id}.meta.json`), 'utf8'));
      const bytes = await fsPromises.readFile(path.join(dir, `${id}.bin`));
      const data = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(data).set(bytes);
      return { id, fileName: String(meta.fileName ?? 'document.pdf'), createdAt: Number.isFinite(meta.createdAt) ? Number(meta.createdAt) : 0, data };
    } catch {
      return null; // caller falls back to its local IndexedDB copy
    }
  });

  registerHandler('binary:storeImage', async (event, id: string, fileName: string, mimeType: string, data: ArrayBuffer) => {
    await workspaceService.ensureBaseDir();
    await workspaceService.assertStorageRootAvailable();
    const dir = workspaceService.getImageStoreDir();
    await fsPromises.mkdir(dir, { recursive: true });
    await writeQueue.enqueue(path.join(dir, `${id}.bin`), new Uint8Array(data));
    await writeQueue.enqueue(path.join(dir, `${id}.meta.json`), JSON.stringify({ id, fileName, mimeType, createdAt: Date.now() }, null, 2));
    return true;
  });

  registerHandler('binary:getImage', async (event, id: string) => {
    await workspaceService.ensureBaseDir();
    const dir = workspaceService.getImageStoreDir();
    try {
      const meta = JSON.parse(await fsPromises.readFile(path.join(dir, `${id}.meta.json`), 'utf8'));
      const bytes = await fsPromises.readFile(path.join(dir, `${id}.bin`));
      const data = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(data).set(bytes);
      return { id, fileName: String(meta.fileName ?? 'image'), mimeType: String(meta.mimeType ?? 'image/png'), createdAt: Number.isFinite(meta.createdAt) ? Number(meta.createdAt) : 0, data };
    } catch {
      return null;
    }
  });

  registerHandler('binary:storeAudio', async (event, id: string, fileName: string, mimeType: string, data: ArrayBuffer) => {
    await workspaceService.ensureBaseDir();
    await workspaceService.assertStorageRootAvailable();
    const dir = workspaceService.getAudioStoreDir();
    await fsPromises.mkdir(dir, { recursive: true });
    await writeQueue.enqueue(path.join(dir, `${id}.bin`), new Uint8Array(data));
    await writeQueue.enqueue(path.join(dir, `${id}.meta.json`), JSON.stringify({ id, fileName, mimeType, createdAt: Date.now() }, null, 2));
    return true;
  });

  registerHandler('binary:getAudio', async (event, id: string) => {
    await workspaceService.ensureBaseDir();
    const dir = workspaceService.getAudioStoreDir();
    try {
      const meta = JSON.parse(await fsPromises.readFile(path.join(dir, `${id}.meta.json`), 'utf8'));
      const bytes = await fsPromises.readFile(path.join(dir, `${id}.bin`));
      const data = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(data).set(bytes);
      return { id, fileName: String(meta.fileName ?? 'voice-note.webm'), mimeType: String(meta.mimeType ?? 'audio/webm'), createdAt: Number.isFinite(meta.createdAt) ? Number(meta.createdAt) : 0, data };
    } catch {
      return null;
    }
  });

  registerHandler('binary:deleteAudio', async (event, id: string) => {
    await workspaceService.ensureBaseDir();
    const dir = workspaceService.getAudioStoreDir();
    await Promise.all([
      fsPromises.rm(path.join(dir, `${id}.bin`), { force: true }),
      fsPromises.rm(path.join(dir, `${id}.meta.json`), { force: true }),
    ]);
    return true;
  });

  // ---- MIGRATION ----
  registerHandler('migration:importWorkspace', async (event, bundle: WorkspaceMigrationBundle) => {
    await workspaceService.ensureBaseDir();
    await workspaceService.assertStorageRootAvailable();
    // A returning profile may already have a usable filesystem workspace while
    // Dexie still contains an old unmarked random-ID default shell. That shell
    // is a migration artifact, not a second user workspace. Once any active
    // local root exists, acknowledge the source row without allocating a new
    // `My Workspace (Migrated …)` directory. A truly empty profile can still
    // import the one retained shell selected by migration-core.
    if (isUnmarkedLegacyDefaultShell(bundle)) {
      const existing = await workspaceService.discoverWorkspaces();
      if (existing.some(entry => !entry.workspace.deletedAt)) return true;
    }
    const existingWorkspaceDir = await workspaceService.findWorkspaceDirByCanonicalId(bundle.workspace.id);
    const storageRoot = await workspaceService.getStorageRootInfo();
    const workspaceDir = existingWorkspaceDir
      ?? await resolveMigrationWorkspaceDirectory(storageRoot.path, bundle.workspace);
    return importDexieWorkspace(bundle, {
      workspaceDir,
      pdfStoreDir: workspaceService.getPdfStoreDir(),
      imageStoreDir: workspaceService.getImageStoreDir(),
      audioStoreDir: workspaceService.getAudioStoreDir(),
      writeQueue,
      registerWorkspace: (workspaceId, dir) => workspaceService.registerWorkspace(workspaceId, dir),
    });
  });

  registerHandler('cloudsync:applyRemoteRecord', async (_event, workspaceId: string, record: { kind: import('../../src/services/cloudsync/types.js').SyncEntityKind; id: string; parentId?: string | null; payload: unknown; tombstone: boolean }) => {
    await workspaceService.applyRemoteRecord(workspaceId, record.kind, record.id, record.payload, record.tombstone, record.parentId);
    return true;
  });
  registerHandler('cloudsync:applyRemoteRecords', async (_event, workspaceId: string, records: Array<{ kind: import('../../src/services/cloudsync/types.js').SyncEntityKind; id: string; parentId?: string | null; payload: unknown; tombstone: boolean }>) => {
    try {
      await workspaceService.applyRemoteRecords(workspaceId, records);
      return { success: true as const };
    } catch (error) {
      const record = error instanceof NativeRemoteRecordApplyError ? error.record : null;
      const normalized = cloudApplyFailure(error instanceof NativeRemoteRecordApplyError ? error.sourceError : error, {
        workspaceId,
        entityKind: record?.kind ?? 'workspace',
        entityId: record?.id ?? workspaceId,
        parentId: record?.parentId,
        schemaVersion: 2,
        operation: 'apply-workspace',
        stage: 'local-record-apply',
        throwingFunction: 'WorkspaceService.applyRemoteRecords',
      });
      return { success: false as const, errorCode: normalized.code, diagnostic: normalized.diagnostic };
    }
  });
  registerHandler('cloudsync:listPageDrawingRecords', async (_event, workspaceId: string) => workspaceService.listPageDrawingRecords(workspaceId));
}
