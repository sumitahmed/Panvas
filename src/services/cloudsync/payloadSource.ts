/** Canonical local entity enumeration and payload retrieval for Cloud Sync. */
import type { SyncEntityKind, SyncJournalEntry } from './types.ts';
import type { ScannedSyncEntity, SyncPayloadSource } from './engine.ts';
import { canonicalizeJson } from './hash.ts';
import { db, SYSTEM_DEFAULT_WORKSPACE_ID, SYSTEM_WELCOME_CANVAS_ID } from '../../database/schema.ts';
import { encodeAssetEnvelope } from './assetEnvelope.ts';
import { parsePdfAnnotationStorageId } from '../../lib/pdfAnnotationStorage.ts';

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalizeJson(value));

/**
 * userId is a local ownership stamp, not shared document content. Electron
 * intentionally stores it as null while the browser stamps every downloaded
 * row with the currently authenticated user. Including that field in a V2
 * payload hash makes an unchanged browser replica look like an offline edit
 * and creates a false conflict on the next device sync. Keep the ownership
 * field in local storage and validate it at the database boundary, but
 * canonicalize it to the legacy wire value (`null`) for device exchange.
 * Keeping the key/value shape preserves compatibility with V2 objects already
 * uploaded by Electron before this fix.
 */
function canonicalSyncValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  if (Object.prototype.hasOwnProperty.call(copy, 'userId')) copy.userId = null;
  return copy;
}

const encodeSyncValue = (value: unknown): Uint8Array => encode(canonicalSyncValue(value));

const normalizeUserId = (userId: string | null | undefined): string | null => userId || null;
type BrowserUserIdReader = () => string | null;
let browserUserIdReader: BrowserUserIdReader = () => null;

/** Installed by the application shell so the sync core stays importable in
 * Node-based tests and non-authenticated browser contexts. */
export function setCurrentBrowserUserIdReader(reader: BrowserUserIdReader): void {
  browserUserIdReader = reader;
}

export const currentBrowserUserId = (): string | null => browserUserIdReader();
const belongsToCurrentBrowserUser = (value: { userId?: string | null }): boolean =>
  normalizeUserId(value.userId) === currentBrowserUserId();

function recoveryOwnership(owner: string | null, recovery: boolean): ScannedSyncEntity['ownership'] {
  const current = currentBrowserUserId();
  // A browser may be authorized with Google Drive while no optional Panvas
  // account session exists. In that mode null ownership is local bookkeeping,
  // not a stable identity; mark it as recovery metadata so a verified cloud
  // download can tolerate metadata-only writes during the run. The engine
  // still compares content identities, so real document edits remain guarded.
  if (recovery && current === null && owner === null) return 'unowned-recovery';
  if (owner === current) return 'current';
  if (!recovery) return undefined;
  // Drive OAuth is valid even when the optional Panvas/Supabase session is
  // absent. In that mode a non-null local stamp is still stale metadata, not
  // proof that the verified Drive account is different.
  return owner === null ? 'unowned-recovery' : 'foreign-recovery';
}

async function readBrowserSnapshot() {
  const userId = currentBrowserUserId();
  const [workspaces, folders, notebooks, sections, pages, contents, drawings, canvases, scenes, blocks, pdfs, media] = await Promise.all([
    db.workspaces.toArray(), db.folders.toArray(), db.notebooks.toArray(), db.notebookSections.toArray(), db.notebookPages.toArray(),
    db.notebookPageContents.toArray(), db.notebookPageDrawings.toArray(), db.canvasFiles.toArray(), db.canvasData.toArray(),
    db.customBlocks.toArray(), db.pdfFiles.toArray(), db.imageFiles.toArray(),
  ]);
  return {
    // Keep the snapshot complete. Normal scans filter to the authenticated
    // owner; verified returning-device recovery may inspect stale ownership
    // stamps as well so it can prove whether the row belongs to the cloud
    // replica being restored.
    workspaces, folders, notebooks, sections, pages, contents, drawings, canvases,
    scenes, blocks, pdfs, media,
  };
}

export type BrowserSyncSnapshot = Awaited<ReturnType<typeof readBrowserSnapshot>>;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isEmptyRecord = (value: unknown): boolean => isRecord(value) && Object.keys(value).length === 0;
const isEmptyArray = (value: unknown): boolean => Array.isArray(value) && value.length === 0;

/** Returns a semantic identity only for an untouched, deterministic system bootstrap record. */
export function semanticSystemBootstrapBytes(entityType: SyncEntityKind, entityId: string, bytes: Uint8Array): Uint8Array | null {
  if (!((entityType === 'workspace' && entityId === SYSTEM_DEFAULT_WORKSPACE_ID)
    || ((entityType === 'canvasFile' || entityType === 'canvasScene') && entityId === SYSTEM_WELCOME_CANVAS_ID))) return null;
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed)) return null;
    value = parsed;
  } catch { return null; }

  const workspaceUntouched = entityType === 'workspace'
    && entityId === SYSTEM_DEFAULT_WORKSPACE_ID
    && value.id === SYSTEM_DEFAULT_WORKSPACE_ID
    && value.name === 'My Workspace'
    && value.isSystem === true
    && value.systemType === 'default'
    && value.isPinned === false
    && value.color == null
    && value.deletedAt == null
    && value.deletedByAncestorId == null;
  const canvasFileUntouched = entityType === 'canvasFile'
    && entityId === SYSTEM_WELCOME_CANVAS_ID
    && value.id === SYSTEM_WELCOME_CANVAS_ID
    && value.workspaceId === SYSTEM_DEFAULT_WORKSPACE_ID
    && value.name === 'Welcome Canvas'
    && value.isSystem === true
    && value.systemType === 'welcome'
    && value.folderId == null
    && value.notebookId == null
    && value.sectionId == null
    && value.order === 0
    && value.isPinned === false
    && value.deletedAt == null
    && value.deletedByAncestorId == null;
  const canvasSceneUntouched = entityType === 'canvasScene'
    && entityId === SYSTEM_WELCOME_CANVAS_ID
    && value.canvasFileId === SYSTEM_WELCOME_CANVAS_ID
    && isEmptyArray(value.elements)
    && isEmptyRecord(value.appState)
    && isEmptyRecord(value.files)
    && (value.customBlocks === undefined || isEmptyArray(value.customBlocks))
    && value.version === 1;
  if (!workspaceUntouched && !canvasFileUntouched && !canvasSceneUntouched) return null;

  const semantic = { ...value };
  delete semantic.createdAt;
  delete semantic.updatedAt;
  delete semantic.lastOpenedAt;
  delete semantic.syncStatus;
  delete semantic.userId;
  return encode(semantic);
}

type AssetKind = 'pdf' | 'image' | 'audio';
interface AssetReference {
  id: string;
  ownerId: string;
  kind: AssetKind;
  fileName?: string;
  mimeType?: string;
  createdAt?: number;
  userId?: string | null;
}

function rememberAsset(target: Map<string, AssetReference>, reference: AssetReference): void {
  if (!reference.id || !reference.ownerId) return;
  target.set(reference.id, { ...target.get(reference.id), ...reference });
}

function rememberDrawingAssets(target: Map<string, AssetReference>, drawing: any, ownerId: string): void {
  for (const object of Array.isArray(drawing?.objects) ? drawing.objects : []) {
    if (object?.type === 'image' && typeof object.fileId === 'string') rememberAsset(target, { id: object.fileId, ownerId, kind: 'image' });
  }
  for (const note of Array.isArray(drawing?.audioNotes) ? drawing.audioNotes : []) {
    if (typeof note?.fileId === 'string') rememberAsset(target, { id: note.fileId, ownerId, kind: 'audio', fileName: note.fileName, mimeType: note.mimeType, createdAt: note.createdAt });
  }
}

function rememberCanvasAssets(target: Map<string, AssetReference>, scene: any, canvasId: string): void {
  for (const block of Array.isArray(scene?.customBlocks) ? scene.customBlocks : []) {
    const metadata = block?.metadata;
    if (block?.type === 'pdf' && typeof metadata?.pdfDataId === 'string') rememberAsset(target, { id: metadata.pdfDataId, ownerId: canvasId, kind: 'pdf', fileName: block.content });
    if (block?.type === 'audio' && typeof metadata?.audioFileId === 'string') rememberAsset(target, { id: metadata.audioFileId, ownerId: canvasId, kind: 'audio', fileName: block.content, mimeType: metadata.mimeType });
  }
}

async function mapBounded<T, R>(items: readonly T[], worker: (item: T) => Promise<R>, concurrency = 8): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await worker(items[index]); }
  }));
  return result;
}

export class LocalSyncPayloadSource implements SyncPayloadSource {
  private readonly scanned = new Map<string, ScannedSyncEntity>();
  private readonly snapshotReader: () => Promise<BrowserSyncSnapshot>;
  private browserSnapshot: Promise<BrowserSyncSnapshot> | null = null;
  private cacheUserId: string | null = currentBrowserUserId();

  private checkCacheOwner(): void {
    const userId = currentBrowserUserId();
    if (this.cacheUserId !== userId) {
      this.scanned.clear(); this.browserSnapshot = null; this.cacheUserId = userId;
    }
  }

  constructor(snapshotReader: () => Promise<BrowserSyncSnapshot> = readBrowserSnapshot) {
    this.snapshotReader = snapshotReader;
  }

  beginCycle(): void {
    this.checkCacheOwner();
    this.scanned.clear();
    if (!(typeof window !== 'undefined' && window.panvas)) this.browserSnapshot = this.snapshotReader();
  }

  endCycle(): void { this.browserSnapshot = null; this.scanned.clear(); }

  async listWorkspaceIds(): Promise<string[]> {
    this.checkCacheOwner();
    if (typeof window !== 'undefined' && window.panvas) {
      const [active, trash] = await Promise.all([window.panvas.workspace.getAll(), window.panvas.trash.getAll(null)]);
      return [...new Set([...active, ...trash.workspaces].map(item => item.id))];
    }
    return (await (this.browserSnapshot ?? this.snapshotReader())).workspaces
      .filter(item => belongsToCurrentBrowserUser(item))
      .map(item => item.id);
  }

  async scanWorkspace(workspaceId: string): Promise<ScannedSyncEntity[]> {
    this.checkCacheOwner();
    const owner = this.cacheUserId;
    const entities = typeof window !== 'undefined' && window.panvas
      ? await this.scanElectronWorkspace(workspaceId)
      : await this.scanBrowserWorkspace(workspaceId, false);
    this.checkCacheOwner();
    if (owner !== this.cacheUserId) return [];
    for (const [key, entity] of this.scanned) if (entity.workspaceId === workspaceId) this.scanned.delete(key);
    for (const entity of entities) this.scanned.set(`${entity.entityType}:${entity.entityId}`, entity);
    return entities;
  }

  async scanWorkspaceIncludingUnowned(workspaceId: string): Promise<ScannedSyncEntity[]> {
    this.checkCacheOwner();
    if (typeof window !== 'undefined' && window.panvas) return this.scanWorkspace(workspaceId);
    const entities = await this.scanBrowserWorkspace(workspaceId, true);
    for (const [key, entity] of this.scanned) if (entity.workspaceId === workspaceId) this.scanned.delete(key);
    for (const entity of entities) this.scanned.set(`${entity.entityType}:${entity.entityId}`, entity);
    return entities;
  }

  async scanWorkspaceSnapshot(workspaceId: string): Promise<{ owned: ScannedSyncEntity[]; all: ScannedSyncEntity[] }> {
    this.checkCacheOwner();
    if (typeof window !== 'undefined' && window.panvas) {
      const owned = await this.scanWorkspace(workspaceId);
      return { owned, all: owned };
    }
    const owner = this.cacheUserId;
    const snapshot = await (this.browserSnapshot ?? this.snapshotReader());
    const all = await this.scanBrowserWorkspace(workspaceId, true, snapshot);
    // The narrower graph still applies its original ownership/ancestry filters.
    // Only exact payload bytes from this same snapshot are shared.
    const owned = await this.scanBrowserWorkspace(workspaceId, false, snapshot, new Map(all.map(entity => [`${entity.entityType}:${entity.entityId}`, entity])));
    this.checkCacheOwner();
    if (owner !== this.cacheUserId) return { owned: [], all: [] };
    for (const [key, entity] of this.scanned) if (entity.workspaceId === workspaceId) this.scanned.delete(key);
    for (const entity of all) this.scanned.set(`${entity.entityType}:${entity.entityId}`, entity);
    return { owned, all };
  }

  async getRecoveryWorkspaceRoot(workspaceId: string): Promise<ScannedSyncEntity | null> {
    this.checkCacheOwner();
    if (typeof window === 'undefined' || !window.panvas?.workspace.getRecoveryWorkspaceRoot) return null;
    const workspace = await window.panvas.workspace.getRecoveryWorkspaceRoot(workspaceId);
    if (!workspace || workspace.id !== workspaceId || workspace.deletedAt) return null;
    return this.entity('workspace', workspaceId, workspaceId, null, workspace, null, true);
  }

  async loadPayload(entry: SyncJournalEntry): Promise<Uint8Array | null> {
    this.checkCacheOwner();
    const cached = this.scanned.get(`${entry.entityType}:${entry.entityId}`);
    if (cached) return cached.workspaceId === entry.workspaceId ? cached.bytes : null;
    try {
      if (typeof window !== 'undefined' && window.panvas) {
        const found = (await this.scanElectronWorkspace(entry.workspaceId))
          .find(item => item.entityType === entry.entityType && item.entityId === entry.entityId);
        return found?.bytes ?? null;
      }
      return await this.loadBrowserPayload(entry);
    } catch { return null; }
  }

  async parentOf(entry: SyncJournalEntry): Promise<string | null> {
    this.checkCacheOwner();
    const cached = this.scanned.get(`${entry.entityType}:${entry.entityId}`);
    if (cached) return cached.workspaceId === entry.workspaceId ? cached.parentId : null;
    try {
      if (typeof window !== 'undefined' && window.panvas) {
        const found = (await this.scanElectronWorkspace(entry.workspaceId))
          .find(item => item.entityType === entry.entityType && item.entityId === entry.entityId);
        return found?.parentId ?? null;
      }
      return await this.browserParent(entry);
    } catch { return null; }
  }

  private entity(entityType: SyncEntityKind, entityId: string, workspaceId: string, parentId: string | null, value: unknown, deletedAt?: number | null, recovery = false): ScannedSyncEntity {
    const tombstone = Boolean(deletedAt);
    const owner = value && typeof value === 'object' && 'userId' in value ? normalizeUserId((value as { userId?: string | null }).userId) : currentBrowserUserId();
    const current = currentBrowserUserId();
    const ownership = recoveryOwnership(owner, recovery);
    return { entityType, entityId, workspaceId, parentId, bytes: tombstone ? null : encodeSyncValue(value), tombstone, deletedAt: deletedAt ?? null, ownership };
  }

  private async scanElectronWorkspace(workspaceId: string): Promise<ScannedSyncEntity[]> {
    const api = window.panvas;
    const workspaces = await api.workspace.getAll();
    let workspace = workspaces.find(item => item.id === workspaceId);
    if (!workspace) {
      // Deleted workspaces are not registered in the active-workspace IPC
      // registry. Enumerate the global Trash projection, then select the
      // requested root instead of asking the bridge to resolve a deleted ID.
      const trash = await api.trash.getAll(null);
      workspace = trash.workspaces.find(item => item.id === workspaceId);
      if (!workspace) return [];
      // Deleted roots are absent from active workspace APIs. Publish the root
      // tombstone without reopening or exposing deleted descendants.
      return [this.entity('workspace', workspace.id, workspaceId, null, workspace, workspace.deletedAt)];
    }
    const [folders, notebooks, sections, pages, canvases] = await Promise.all([
      api.folder.getAll(workspaceId), api.notebook.getAll(workspaceId),
      api.notebookSection.getAll(workspaceId), api.notebookPage.getAll(workspaceId), api.canvasFile.getAll(workspaceId),
    ]);
    const result: ScannedSyncEntity[] = [this.entity('workspace', workspace.id, workspaceId, null, workspace, workspace.deletedAt)];
    for (const item of folders) result.push(this.entity('folder', item.id, workspaceId, item.parentId ?? workspaceId, item, item.deletedAt));
    for (const item of notebooks) result.push(this.entity('notebook', item.id, workspaceId, item.folderId ?? workspaceId, item, item.deletedAt));
    for (const item of sections) result.push(this.entity('notebookSection', item.id, workspaceId, item.notebookId, item, item.deletedAt));
    const referencedAssets = new Map<string, AssetReference>();
    for (const page of pages) if (!page.deletedAt && page.type === 'pdf' && page.pdfDataId) rememberAsset(referencedAssets, { id: page.pdfDataId, ownerId: page.id, kind: 'pdf' });
    const pagePayloads = await mapBounded(pages, async page => {
      const entities = [this.entity('notebookPage', page.id, workspaceId, page.sectionId ?? page.notebookId, page, page.deletedAt)];
      if (page.deletedAt) return entities;
      const [content, drawing] = await Promise.all([api.notebook.loadPage(workspaceId, page.notebookId, page.id), api.notebook.loadDrawing(workspaceId, page.notebookId, page.id)]);
      if (content !== null && content !== undefined) entities.push(this.entity('pageContent', page.id, workspaceId, page.id, { pageId: page.id, workspaceId, notebookId: page.notebookId, data: content, version: 1 }));
      if (drawing !== null && drawing !== undefined) {
        entities.push(this.entity('pageDrawing', page.id, workspaceId, page.id, { pageId: page.id, workspaceId, notebookId: page.notebookId, data: drawing, version: 1 }));
        rememberDrawingAssets(referencedAssets, drawing, page.id);
      }
      return entities;
    });
    result.push(...pagePayloads.flat());
    const drawingRecords = await api.cloudsync?.listPageDrawingRecords?.(workspaceId) ?? [];
    const annotationPayloads = await mapBounded(drawingRecords.filter(record => record.id !== record.ownerPageId), async record => {
      const drawing = await api.notebook.loadDrawing(workspaceId, record.notebookId, record.id);
      if (drawing === null || drawing === undefined) return null;
      rememberDrawingAssets(referencedAssets, drawing, record.ownerPageId);
      return this.entity('pageDrawing', record.id, workspaceId, record.ownerPageId, { pageId: record.id, workspaceId, notebookId: record.notebookId, data: drawing, version: 1 });
    });
    result.push(...annotationPayloads.filter((item): item is NonNullable<typeof item> => item !== null));
    const canvasPayloads = await mapBounded(canvases, async canvas => {
      const entities = [this.entity('canvasFile', canvas.id, workspaceId, canvas.folderId ?? canvas.notebookId ?? workspaceId, canvas, canvas.deletedAt)];
      if (canvas.deletedAt) return entities;
      const scene = await api.canvas.load(workspaceId, canvas.id);
      if (scene !== null && scene !== undefined) {
        entities.push(this.entity('canvasScene', canvas.id, workspaceId, canvas.id, scene));
        // Native scenes own their blocks on disk; browsers store the same
        // blocks separately. Emit both representations so a workspace copy
        // can remap every block ID and a fresh browser gets usable blocks.
        for (const block of Array.isArray(scene.customBlocks) ? scene.customBlocks : []) {
          entities.push(this.entity('customBlock', block.id, workspaceId, canvas.id, { ...block, canvasFileId: canvas.id }, block.deletedAt));
        }
        rememberCanvasAssets(referencedAssets, scene, canvas.id);
      }
      return entities;
    });
    result.push(...canvasPayloads.flat());
    if (typeof indexedDB !== 'undefined') {
      const ownerIds = new Set([...pages.map(item => item.id), ...canvases.map(item => item.id), ...drawingRecords.map(item => item.id)]);
      const [pdfs, media] = await Promise.all([db.pdfFiles.toArray(), db.imageFiles.toArray()]);
      for (const item of pdfs.filter(item => ownerIds.has(item.canvasFileId))) rememberAsset(referencedAssets, { id: item.id, ownerId: item.canvasFileId, kind: 'pdf', fileName: item.fileName, createdAt: item.createdAt, userId: item.userId });
      for (const item of media.filter(item => ownerIds.has(item.canvasFileId))) rememberAsset(referencedAssets, { id: item.id, ownerId: item.canvasFileId, kind: /^audio\//i.test(item.mimeType) ? 'audio' : 'image', fileName: item.fileName, mimeType: item.mimeType, createdAt: item.createdAt, userId: item.userId });
    }
    const assetEntities = await mapBounded([...referencedAssets.values()], async item => {
      const stored = item.kind === 'pdf' ? await api.binary.getPdf(item.id) : item.kind === 'audio' ? await api.binary.getAudio(item.id) : await api.binary.getImage(item.id);
      if (!stored?.data) return null;
      const mimeType = item.kind === 'pdf' ? 'application/pdf' : (stored as any).mimeType ?? item.mimeType ?? 'application/octet-stream';
      return { entityType: 'asset' as const, entityId: item.id, workspaceId, parentId: item.ownerId, bytes: encodeAssetEnvelope({ id: item.id, ownerId: item.ownerId, fileName: stored.fileName || item.fileName || item.id, mimeType, assetKind: item.kind, createdAt: item.createdAt ?? (stored as any).createdAt ?? 0, userId: null }, new Uint8Array(stored.data)), tombstone: false, deletedAt: null };
    });
    result.push(...assetEntities.filter((item): item is NonNullable<typeof item> => item !== null));
    return result;
  }

  private async scanBrowserWorkspace(workspaceId: string, includeUnowned: boolean, captured?: BrowserSyncSnapshot, reusable?: ReadonlyMap<string, ScannedSyncEntity>): Promise<ScannedSyncEntity[]> {
    const snapshot = captured ?? await (this.browserSnapshot ?? this.snapshotReader());
    const eligible = <T extends { userId?: string | null }>(items: T[]): T[] => items.filter(item => belongsToCurrentBrowserUser(item) || includeUnowned);
    const owned = eligible;
    const workspaces = owned(snapshot.workspaces);
    const allFolders = owned(snapshot.folders);
    const allNotebooks = owned(snapshot.notebooks);
    const sections = owned(snapshot.sections);
    const pages = owned(snapshot.pages);
    const contents = owned(snapshot.contents);
    const drawings = owned(snapshot.drawings);
    const allCanvases = owned(snapshot.canvases);
    const scenes = owned(snapshot.scenes);
    const blocks = owned(snapshot.blocks);
    const pdfs = owned(snapshot.pdfs);
    const media = owned(snapshot.media);
    const makeEntity = (entityType: SyncEntityKind, entityId: string, rowWorkspaceId: string, parentId: string | null, value: unknown, deletedAt?: number | null) => {
      const existing = reusable?.get(`${entityType}:${entityId}`);
      return existing ? { ...existing, ownership: 'current' as const } : this.entity(entityType, entityId, rowWorkspaceId, parentId, value, deletedAt, includeUnowned);
    };
    const workspace = workspaces.find(item => item.id === workspaceId);
    if (!workspace) return [];
    const folders = allFolders.filter(item => item.workspaceId === workspaceId);
    const notebooks = allNotebooks.filter(item => item.workspaceId === workspaceId);
    const canvases = allCanvases.filter(item => item.workspaceId === workspaceId);
    const notebookIds = new Set(notebooks.map(item => item.id));
    const pageIds = new Set(pages.filter(item => notebookIds.has(item.notebookId)).map(item => item.id));
    const canvasIds = new Set(canvases.map(item => item.id));
    const result: ScannedSyncEntity[] = [makeEntity('workspace', workspace.id, workspaceId, null, workspace, workspace.deletedAt)];
    for (const item of folders) result.push(makeEntity('folder', item.id, workspaceId, item.parentId ?? workspaceId, item, item.deletedAt));
    for (const item of notebooks) result.push(makeEntity('notebook', item.id, workspaceId, item.folderId ?? workspaceId, item, item.deletedAt));
    for (const item of sections.filter(item => notebookIds.has(item.notebookId))) result.push(makeEntity('notebookSection', item.id, workspaceId, item.notebookId, item, item.deletedAt));
    for (const item of pages.filter(item => notebookIds.has(item.notebookId))) result.push(makeEntity('notebookPage', item.id, workspaceId, item.sectionId ?? item.notebookId, item, item.deletedAt));
    for (const item of contents.filter(item => pageIds.has(item.pageId))) result.push(makeEntity('pageContent', item.pageId, workspaceId, item.pageId, item));
    const drawingIds = new Set<string>();
    for (const item of drawings) {
      const annotation = parsePdfAnnotationStorageId(item.pageId);
      const ownerPageId = annotation?.ownerPageId ?? item.pageId;
      if (!pageIds.has(ownerPageId)) continue;
      result.push(makeEntity('pageDrawing', item.pageId, workspaceId, ownerPageId, item));
      drawingIds.add(item.pageId);
    }
    for (const item of canvases) result.push(makeEntity('canvasFile', item.id, workspaceId, item.folderId ?? item.notebookId ?? workspaceId, item, item.deletedAt));
    for (const item of scenes.filter(item => canvasIds.has(item.canvasFileId))) result.push(makeEntity('canvasScene', item.canvasFileId, workspaceId, item.canvasFileId, item));
    for (const item of blocks.filter(item => canvasIds.has(item.canvasFileId))) result.push(makeEntity('customBlock', item.id, workspaceId, item.canvasFileId, item));
    const ownerIds = new Set([...pageIds, ...canvasIds, ...drawingIds]);
    for (const item of pdfs.filter(item => ownerIds.has(item.canvasFileId))) result.push(reusable?.has(`asset:${item.id}`) ? { ...reusable.get(`asset:${item.id}`)!, ownership: 'current' } : { entityType: 'asset', entityId: item.id, workspaceId, parentId: item.canvasFileId, bytes: encodeAssetEnvelope({ id: item.id, ownerId: item.canvasFileId, fileName: item.fileName, mimeType: 'application/pdf', assetKind: 'pdf', createdAt: item.createdAt, userId: null }, new Uint8Array(item.data)), tombstone: false, deletedAt: null, ownership: recoveryOwnership(normalizeUserId(item.userId), includeUnowned) });
    for (const item of media.filter(item => ownerIds.has(item.canvasFileId))) result.push(reusable?.has(`asset:${item.id}`) ? { ...reusable.get(`asset:${item.id}`)!, ownership: 'current' } : { entityType: 'asset', entityId: item.id, workspaceId, parentId: item.canvasFileId, bytes: encodeAssetEnvelope({ id: item.id, ownerId: item.canvasFileId, fileName: item.fileName, mimeType: item.mimeType, assetKind: /^audio\//i.test(item.mimeType) ? 'audio' : 'image', createdAt: item.createdAt, userId: null }, new Uint8Array(item.data)), tombstone: false, deletedAt: null, ownership: recoveryOwnership(normalizeUserId(item.userId), includeUnowned) });
    return result;
  }

  private async loadBrowserPayload(entry: SyncJournalEntry): Promise<Uint8Array | null> {
    let value: unknown;
    switch (entry.entityType) {
      case 'workspace': value = await db.workspaces.get(entry.entityId); break;
      case 'folder': value = await db.folders.get(entry.entityId); break;
      case 'notebook': value = await db.notebooks.get(entry.entityId); break;
      case 'notebookSection': value = await db.notebookSections.get(entry.entityId); break;
      case 'notebookPage': value = await db.notebookPages.get(entry.entityId); break;
      case 'pageContent': value = await db.notebookPageContents.get(entry.entityId); break;
      case 'pageDrawing': value = await db.notebookPageDrawings.get(entry.entityId); break;
      case 'canvasFile': value = await db.canvasFiles.get(entry.entityId); break;
      case 'canvasScene': value = await db.canvasData.get(entry.entityId); break;
      case 'customBlock': value = await db.customBlocks.get(entry.entityId); break;
      case 'asset': {
        const asset = await db.pdfFiles.get(entry.entityId) ?? await db.imageFiles.get(entry.entityId);
        if (!asset || !belongsToCurrentBrowserUser(asset)) return null;
        const isPdf = !('mimeType' in asset);
        const mimeType = isPdf ? 'application/pdf' : String(asset.mimeType);
        return encodeAssetEnvelope({ id: asset.id, ownerId: asset.canvasFileId, fileName: asset.fileName, mimeType, assetKind: isPdf ? 'pdf' : /^audio\//i.test(mimeType) ? 'audio' : 'image', createdAt: asset.createdAt, userId: asset.userId }, new Uint8Array(asset.data));
      }
      default: value = null;
    }
    return value === null || value === undefined || !belongsToCurrentBrowserUser(value as { userId?: string | null }) ? null : encode(value);
  }

  private async browserParent(entry: SyncJournalEntry): Promise<string | null> {
    const ownedParent = async <T extends { userId?: string | null }>(
      itemPromise: Promise<T | undefined>,
      parent: (item: T) => string | null,
    ): Promise<string | null> => {
      const item = await itemPromise;
      return item && belongsToCurrentBrowserUser(item) ? parent(item) : null;
    };
    switch (entry.entityType) {
      case 'folder': return ownedParent(db.folders.get(entry.entityId), item => item.parentId ?? entry.workspaceId);
      case 'notebook': return ownedParent(db.notebooks.get(entry.entityId), item => item.folderId ?? entry.workspaceId);
      case 'notebookSection': return ownedParent(db.notebookSections.get(entry.entityId), item => item.notebookId ?? null);
      case 'notebookPage': return ownedParent(db.notebookPages.get(entry.entityId), item => item.sectionId ?? item.notebookId ?? null);
      case 'pageContent': return ownedParent(db.notebookPageContents.get(entry.entityId), () => entry.entityId);
      case 'canvasScene': return ownedParent(db.canvasData.get(entry.entityId), () => entry.entityId);
      case 'pageDrawing': return ownedParent(db.notebookPageDrawings.get(entry.entityId), () => parsePdfAnnotationStorageId(entry.entityId)?.ownerPageId ?? entry.entityId);
      case 'canvasFile': return ownedParent(db.canvasFiles.get(entry.entityId), item => item.folderId ?? item.notebookId ?? entry.workspaceId);
      case 'customBlock': return ownedParent(db.customBlocks.get(entry.entityId), item => item.canvasFileId ?? null);
      case 'asset': {
        const pdf = await db.pdfFiles.get(entry.entityId);
        if (pdf && belongsToCurrentBrowserUser(pdf)) return pdf.canvasFileId ?? null;
        const image = await db.imageFiles.get(entry.entityId);
        return image && belongsToCurrentBrowserUser(image) ? image.canvasFileId ?? null : null;
      }
      default: return null;
    }
  }
}
