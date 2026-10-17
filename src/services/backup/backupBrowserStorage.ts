import { db } from '../../database/schema';
import { generateId } from '../../lib/utils/id';
import type { CanvasData } from '@/types/canvas';
import type { Workspace, Folder, CanvasFile } from '@/types/workspace';
import type { Notebook, NotebookSection, NotebookPage } from '@/types/notebook';
import { buildWorkspaceBackup, remapWorkspaceBackup, serializeWorkspaceBackup, type BackupPagePayload, type BackupAnnotationPayload, type WorkspaceBackup, type BackupImportResult } from './backupService';
import { collectBackupAssets, verifyBackupAssets } from './backupAssets';
import { parsePdfAnnotationStorageId, pdfAnnotationStorageId } from '../../lib/pdfAnnotationStorage';

// Legacy binary/custom-block stores represent an anonymous owner as ''.
const belongsToUser = (record: { userId?: string | null }, userId: string | null) => (record.userId || null) === userId;

export async function collectBrowserWorkspaceBackup(workspaceId: string, userId: string | null): Promise<WorkspaceBackup> {
  const workspace = await db.workspaces.get(workspaceId);
  if (!workspace || !belongsToUser(workspace, userId)) throw new Error('Workspace not found in local storage.');
  const [allFolders, allNotebooks, allSections, allPages, allCanvases] = await Promise.all([
    db.folders.toArray(), db.notebooks.toArray(), db.notebookSections.toArray(), db.notebookPages.toArray(), db.canvasFiles.toArray(),
  ]);
  const folders = allFolders.filter(item => item.workspaceId === workspaceId && belongsToUser(item, userId));
  const notebooks = allNotebooks.filter(item => item.workspaceId === workspaceId && belongsToUser(item, userId));
  const notebookIds = new Set(notebooks.map(item => item.id));
  const sections = allSections.filter(item => notebookIds.has(item.notebookId) && belongsToUser(item, userId));
  // A page can legitimately predate section assignment; the notebook is the
  // ownership boundary for backup purposes, so never drop such pages.
  const pages = allPages.filter(item => notebookIds.has(item.notebookId) && belongsToUser(item, userId));
  const canvases = allCanvases.filter(item => item.workspaceId === workspaceId && belongsToUser(item, userId));
  const pageIds = new Set(pages.map(item => item.id));
  const [contents, drawings, canvasPayloads] = await Promise.all([
    db.notebookPageContents.toArray(), db.notebookPageDrawings.toArray(), db.canvasData.toArray(),
  ]);
  const contentByPage = new Map(contents.filter(item => pageIds.has(item.pageId) && belongsToUser(item, userId)).map(item => [item.pageId, item.data]));
  const drawingByPage = new Map(drawings.filter(item => pageIds.has(item.pageId) && belongsToUser(item, userId)).map(item => [item.pageId, item.data]));
  const payloadByCanvas = new Map(canvasPayloads.filter(item => canvases.some(canvas => canvas.id === item.canvasFileId) && belongsToUser(item, userId)).map(item => [item.canvasFileId, item]));
  const pagePayloads: Record<string, BackupPagePayload> = {};
  for (const page of pages) pagePayloads[page.id] = { content: contentByPage.get(page.id) ?? null, drawing: drawingByPage.get(page.id) ?? null };
  const canvasData: Record<string, CanvasData> = {};
  const customBlocks = await db.customBlocks.toArray();
  for (const canvas of canvases) {
    canvasData[canvas.id] = payloadByCanvas.get(canvas.id) ?? {
      canvasFileId: canvas.id, elements: [], appState: {}, files: {}, customBlocks: [], version: 1, updatedAt: canvas.updatedAt, userId,
    };
    const canonicalBlocks = customBlocks.filter(block => block.canvasFileId === canvas.id && belongsToUser(block, userId));
    const canonicalIds = new Set(canonicalBlocks.map(block => block.id));
    canvasData[canvas.id] = { ...canvasData[canvas.id], customBlocks: [
      ...(canvasData[canvas.id].customBlocks ?? []).filter(block => !canonicalIds.has(block.id)), ...canonicalBlocks,
    ] };
  }
  const annotationPayloads: Record<string, BackupAnnotationPayload> = {};
  const contentById = new Map(contents.map(record => [record.pageId, record]));
  for (const record of drawings) {
    const annotation = parsePdfAnnotationStorageId(record.pageId);
    if (!annotation || !belongsToUser(record, userId) || !pages.some(page => page.id === annotation.ownerPageId && page.type === 'pdf')) continue;
    const content = contentById.get(record.pageId);
    annotationPayloads[record.pageId] = { ...annotation, drawing: record.data, content: content && belongsToUser(content, userId) ? content.data : null };
  }
  const source = { workspace, folders, notebooks, sections, pages, canvases, pagePayloads, canvasPayloads: canvasData, annotationPayloads };
  const assets = await collectBackupAssets(source, async reference => {
    const record = await (reference.kind === 'pdf' ? db.pdfFiles.get(reference.id) : db.imageFiles.get(reference.id));
    return record && belongsToUser(record, userId) ? record : null;
  });
  const backup = buildWorkspaceBackup({ ...source, assets });
  serializeWorkspaceBackup(backup); // Do not emit a package the importer cannot accept.
  return backup;
}

export async function restoreBrowserWorkspaceBackup(backup: WorkspaceBackup, userId: string | null): Promise<BackupImportResult> {
  serializeWorkspaceBackup(backup);
  const verified = await verifyBackupAssets(backup);
  const existing = await db.workspaces.toArray();
  const baseName = backup.header.workspaceName.trim().slice(0, 140);
  const names = new Set(existing.map(item => item.name));
  let workspaceName = `${baseName} (Restored)`;
  let suffix = 2;
  while (names.has(workspaceName)) workspaceName = `${baseName} (Restored ${suffix++})`;
  const restored = remapWorkspaceBackup(backup, { idFactory: prefix => generateId(prefix), workspaceName, userId, now: Date.now() });
  const pageContentRecords = restored.pages.map(page => ({ pageId: page.id, workspaceId: restored.workspace.id, notebookId: page.notebookId, data: restored.pagePayloads[page.id].content, version: 1 as const, updatedAt: restored.workspace.updatedAt, userId }));
  const pageDrawingRecords = restored.pages.map(page => ({ pageId: page.id, workspaceId: restored.workspace.id, notebookId: page.notebookId, data: restored.pagePayloads[page.id].drawing, version: 1 as const, updatedAt: restored.workspace.updatedAt, userId }));
  const canvasData = restored.canvases.map(canvas => restored.canvasPayloads[canvas.id]);
  for (const annotation of Object.values(restored.annotationPayloads ?? {})) {
    const id = pdfAnnotationStorageId(annotation.ownerPageId, annotation.sourcePage);
    const owner = restored.pages.find(page => page.id === annotation.ownerPageId)!;
    pageDrawingRecords.push({ pageId: id, workspaceId: restored.workspace.id, notebookId: owner.notebookId, data: annotation.drawing, version: 1, updatedAt: restored.workspace.updatedAt, userId });
    if (annotation.content !== null) pageContentRecords.push({ pageId: id, workspaceId: restored.workspace.id, notebookId: owner.notebookId, data: annotation.content, version: 1, updatedAt: restored.workspace.updatedAt, userId });
  }
  const bytesByHash = new Map(Object.entries(backup.assets ?? {}).map(([id, asset]) => [asset.sha256, verified.bytes.get(id)!]));
  await db.transaction('rw', [db.workspaces, db.folders, db.canvasFiles, db.canvasData, db.customBlocks, db.pdfFiles, db.imageFiles, db.notebooks, db.notebookSections, db.notebookPages, db.notebookPageContents, db.notebookPageDrawings], async () => {
    await db.workspaces.add({ ...restored.workspace, name: workspaceName, userId, syncStatus: 'local', deletedAt: null });
    await db.folders.bulkAdd(restored.folders.map(item => ({ ...item, userId, syncStatus: 'local' })));
    await db.notebooks.bulkAdd(restored.notebooks.map(item => ({ ...item, userId, syncStatus: 'local' })));
    await db.notebookSections.bulkAdd(restored.sections.map(item => ({ ...item, userId })));
    await db.notebookPages.bulkAdd(restored.pages.map(item => ({ ...item, userId })));
    await db.canvasFiles.bulkAdd(restored.canvases.map(item => ({ ...item, userId, syncStatus: 'local' })));
    if (canvasData.length) await db.canvasData.bulkAdd(canvasData);
    if (pageContentRecords.length) await db.notebookPageContents.bulkAdd(pageContentRecords);
    if (pageDrawingRecords.length) await db.notebookPageDrawings.bulkAdd(pageDrawingRecords);
    const blocks = canvasData.flatMap(canvas => canvas.customBlocks);
    if (blocks.length) await db.customBlocks.bulkAdd(blocks);
    for (const asset of Object.values(restored.assets ?? {})) {
      const bytes = bytesByHash.get(asset.sha256)!;
      const record = { id: asset.id, canvasFileId: asset.ownerId, fileName: asset.fileName, mimeType: asset.mimeType, createdAt: asset.createdAt, userId, data: bytes.slice().buffer };
      if (asset.kind === 'pdf') await db.pdfFiles.add(record); else await db.imageFiles.add(record);
    }
  });
  return { workspaceId: restored.workspace.id, workspaceName, ...(verified.warnings.length ? { warnings: verified.warnings } : {}) };
}
