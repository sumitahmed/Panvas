import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkspaceBackup, parseWorkspaceBackup, remapWorkspaceBackup, serializeWorkspaceBackup, type BackupSource } from '../src/services/backup/backupService.ts';
import { collectBackupAssets, verifyBackupAssets, MAX_BACKUP_BYTES } from '../src/services/backup/backupAssets.ts';

const source: BackupSource = {
  workspace: { id: 'ws-1', name: 'Research', createdAt: 1, updatedAt: 2, isPinned: false, syncStatus: 'local', userId: null, deletedAt: null },
  folders: [{ id: 'folder-1', workspaceId: 'ws-1', parentId: null, name: 'Notes', createdAt: 1, updatedAt: 2, order: 0, syncStatus: 'local', userId: null, deletedAt: null }],
  notebooks: [{ id: 'notebook-1', workspaceId: 'ws-1', folderId: 'folder-1', name: 'Daily', createdAt: 1, updatedAt: 2, order: 0, isExpanded: true, userId: null }],
  sections: [{ id: 'section-1', notebookId: 'notebook-1', name: 'General', createdAt: 1, updatedAt: 2, order: 0, isExpanded: true, userId: null }],
  pages: [{ id: 'page-1', notebookId: 'notebook-1', sectionId: 'section-1', title: 'Today', createdAt: 1, updatedAt: 2, order: 0, userId: null }],
  canvases: [{ id: 'canvas-1', workspaceId: 'ws-1', folderId: null, name: 'Plan', createdAt: 1, updatedAt: 2, lastOpenedAt: 2, order: 0, isPinned: false, syncStatus: 'local', userId: null, deletedAt: null }],
  pagePayloads: { 'page-1': { drawing: { strokes: [{ x: 10, y: 20 }] }, content: { type: 'doc', content: [{ type: 'paragraph' }] } } },
  canvasPayloads: { 'canvas-1': { canvasFileId: 'canvas-1', elements: [{ id: 'element-1' }], appState: { zoom: 1 }, files: {}, customBlocks: [], version: 1, updatedAt: 2, userId: null } },
};

test('backup serializes metadata, page payloads, and canvas payloads', () => {
  const backup = buildWorkspaceBackup(source, 123);
  const parsed = parseWorkspaceBackup(serializeWorkspaceBackup(backup));
  assert.equal(parsed.header.type, 'panvas/workspace-backup');
  assert.equal(parsed.header.exportedAt, 123);
  assert.equal(parsed.notebooks.length, 1);
  assert.deepEqual(parsed.pagePayloads['page-1'].drawing, source.pagePayloads['page-1'].drawing);
  assert.deepEqual(parsed.canvasPayloads['canvas-1'].elements, source.canvasPayloads['canvas-1'].elements);
});

test('backup rejects malformed JSON and invalid schema', () => {
  assert.throws(() => parseWorkspaceBackup('{not json'), /JSON is malformed/);
  assert.throws(() => parseWorkspaceBackup({ ...source, header: { ...buildWorkspaceBackup(source).header, type: 'other' } }), /header is invalid/);
  assert.throws(() => parseWorkspaceBackup({ ...buildWorkspaceBackup(source), pagePayloads: {} }), /page payload is missing/);
});

test('restore remaps ids and relationships while preserving payload content', () => {
  const restored = remapWorkspaceBackup(buildWorkspaceBackup(source), { idFactory: prefix => `${prefix}-new`, workspaceName: 'Research Restored', userId: 'user-1', now: 99 });
  assert.equal(restored.workspace.name, 'Research Restored');
  assert.equal(restored.folders.length, source.folders.length);
  assert.equal(restored.notebooks.length, source.notebooks.length);
  assert.equal(restored.sections.length, source.sections.length);
  assert.equal(restored.pages.length, source.pages.length);
  assert.equal(restored.canvases.length, source.canvases.length);
  assert.notEqual(restored.workspace.id, source.workspace.id);
  assert.equal(restored.folders[0].workspaceId, restored.workspace.id);
  assert.equal(restored.notebooks[0].workspaceId, restored.workspace.id);
  assert.equal(restored.pages[0].notebookId, restored.notebooks[0].id);
  assert.equal(restored.sections[0].notebookId, restored.notebooks[0].id);
  assert.deepEqual(restored.pagePayloads[restored.pages[0].id].content, source.pagePayloads['page-1'].content);
  assert.equal(restored.canvasPayloads[restored.canvases[0].id].canvasFileId, restored.canvases[0].id);
  assert.equal(restored.workspace.userId, 'user-1');
});

async function portableFixture() {
  const input = structuredClone(source);
  input.pages.push({ ...input.pages[0], id: 'page-2', title: 'Imported PDF', type: 'pdf', pdfDataId: 'pdf-asset', order: 1 });
  input.pagePayloads['page-2'] = { drawing: { objects: [{ type: 'text', content: { type: 'doc', content: [{ type: 'heading', attrs: { blockId: 'target-block' }, content: [{ type: 'text', text: 'Target' }] }] } }] }, content: null };
  input.pagePayloads['page-1'].drawing = { properties: { layoutMode: 'document', pageSize: 'Infinite', infiniteWidth: 794 }, objects: [{ type: 'text', content: { type: 'doc', content: [
    { type: 'paragraph', attrs: { blockId: 'source-block' }, content: [{ type: 'text', text: 'Keep page-2 literal', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'highlight', attrs: { color: '#ffe100' } }, { type: 'textStyle', attrs: { color: '#123456' } }, { type: 'link', attrs: { href: 'https://panvas.example/app?panvasPage=page-2&panvasBlock=target-block' } }] }] },
    { type: 'pageReference', attrs: { targetPageId: 'page-2', targetBlockId: 'target-block' } },
    { type: 'image', attrs: { fileId: 'image-asset', alt: 'image' } },
    { type: 'codeBlock', attrs: { language: 'rust', wrap: false }, content: [{ type: 'text', text: 'page-2 image-asset target-block' }] },
    { type: 'blockMath', attrs: { latex: 'E=mc^2' } },
  ] } }], audioNotes: [{ id: 'note-1', fileId: 'audio-asset', mimeType: 'audio/wav' }] };
  input.annotationPayloads = { 'page-2_pdf_1': { ownerPageId: 'page-2', sourcePage: 1, content: null, drawing: { objects: [{ type: 'stroke', id: 'annotation-ink', points: [{ x: 2, y: 4, pressure: .4, t: 7 }] }] } } };
  input.canvasPayloads['canvas-1'].customBlocks = [{ id: 'pdf-block', canvasFileId: 'canvas-1', type: 'pdf', x: 1, y: 2, width: 3, height: 4, content: 'pdf-asset', metadata: { pdfDataId: 'pdf-asset' }, createdAt: 1, updatedAt: 2, userId: null }];
  input.canvasPayloads['canvas-1'].files = { 'inline-image': { dataURL: 'data:image/png;base64,AA==' } };
  input.canvasPayloads['canvas-1'].elements = [{ id: 'inline-element', type: 'image', fileId: 'inline-image' }];
  const assets = await collectBackupAssets(input, async reference => ({ data: new Uint8Array([0,1,128,255,reference.id.length]), fileName: `${reference.id}.bin`, mimeType: reference.kind === 'audio' ? 'audio/wav' : 'image/png', createdAt: 12 }));
  return buildWorkspaceBackup({ ...input, assets });
}

test('v2 includes verified binary bytes, PDF annotations and custom blocks and remaps structured references only', async () => {
  const backup = await portableFixture(), verified = await verifyBackupAssets(backup);
  assert.equal(backup.header.version, 2); assert.equal(verified.bytes.size, 3); assert.deepEqual(verified.warnings, []);
  let next = 0;
  const restored = remapWorkspaceBackup(backup, { idFactory: prefix => `${prefix}-${++next}` });
  const doc = (restored.pagePayloads[restored.pages[0].id].drawing as any).objects[0].content;
  const target = (restored.pagePayloads[restored.pages[1].id].drawing as any).objects[0].content.content[0].attrs.blockId;
  assert.notEqual(target, 'target-block');
  assert.equal(doc.content[1].attrs.targetPageId, restored.pages[1].id); assert.equal(doc.content[1].attrs.targetBlockId, target);
  const link = new URL(doc.content[0].content[0].marks.find((m: any) => m.type === 'link').attrs.href);
  assert.equal(link.searchParams.get('panvasPage'), restored.pages[1].id); assert.equal(link.searchParams.get('panvasBlock'), target);
  assert.equal(doc.content[0].content[0].text, 'Keep page-2 literal');
  assert.equal(doc.content[0].content[0].marks.find((m: any) => m.type === 'textStyle').attrs.color, '#123456');
  assert.deepEqual(doc.content[0].content[0].marks.map((m: any) => m.type), ['bold','italic','highlight','textStyle','link']);
  assert.equal(doc.content[3].content[0].text, 'page-2 image-asset target-block');
  const image = Object.values(restored.assets!).find(asset => asset.kind === 'image')!;
  assert.equal(doc.content[2].attrs.fileId, image.id); assert.notEqual(image.id, 'image-asset');
  assert.equal(restored.pages[1].pdfDataId, Object.values(restored.assets!).find(asset => asset.kind === 'pdf')!.id);
  assert.equal(restored.canvasPayloads[restored.canvases[0].id].customBlocks[0].canvasFileId, restored.canvases[0].id);
  assert.notEqual(restored.canvasPayloads[restored.canvases[0].id].customBlocks[0].id, 'pdf-block');
  assert.deepEqual(restored.canvasPayloads[restored.canvases[0].id].files, backup.canvasPayloads['canvas-1'].files);
  assert.deepEqual(Object.values(restored.annotationPayloads!)[0].drawing, backup.annotationPayloads!['page-2_pdf_1'].drawing);
  assert.equal(Object.values(restored.annotationPayloads!)[0].ownerPageId, restored.pages[1].id);
  const checked = await verifyBackupAssets(restored); for (const asset of Object.values(restored.assets!)) assert.equal(checked.bytes.get(asset.id)!.byteLength, asset.byteLength);
});

test('corrupt, incomplete, truncated, oversized and wrong-owner backups fail before restore', async () => {
  const backup = await portableFixture();
  const corrupt = structuredClone(backup); corrupt.assets!['image-asset'].base64 = 'AgGA/w s='.replace(' ', '');
  await assert.rejects(verifyBackupAssets(corrupt), /integrity check/);
  const missing = structuredClone(backup); delete missing.assets!['image-asset']; await assert.rejects(verifyBackupAssets(missing), /incomplete/);
  const truncated = structuredClone(backup); truncated.assets!['image-asset'].base64 = 'AA=='; assert.throws(() => parseWorkspaceBackup(truncated), /Invalid backup asset/);
  const oversized = structuredClone(backup); oversized.assets!['image-asset'].byteLength = MAX_BACKUP_BYTES + 1; assert.throws(() => parseWorkspaceBackup(oversized), /Invalid backup asset/);
  const owner = structuredClone(backup); owner.assets!['image-asset'].ownerId = 'foreign-page'; assert.throws(() => parseWorkspaceBackup(owner), /owner is outside/);
  const annotation = structuredClone(backup); annotation.annotationPayloads!['page-2_pdf_1'].ownerPageId = 'page-1'; assert.throws(() => parseWorkspaceBackup(annotation), /annotation ownership/);
});

test('v1 remains readable and explicitly reports missing binaries without borrowing existing asset IDs', async () => {
  const backup = await portableFixture(); backup.header.version = 1; delete backup.assets; delete backup.annotationPayloads;
  const parsed = parseWorkspaceBackup(serializeWorkspaceBackup(backup));
  assert.equal(parsed.header.version, 1); const verified = await verifyBackupAssets(parsed);
  assert.equal(verified.bytes.size, 0); assert.equal(verified.warnings.length, 1);
  let next = 0; const restored = remapWorkspaceBackup(parsed, { idFactory: prefix => `${prefix}-legacy-${++next}` });
  assert.notEqual(restored.pages[1].pdfDataId, 'pdf-asset');
  assert.notEqual((restored.pagePayloads[restored.pages[0].id].drawing as any).objects[0].content.content[2].attrs.fileId, 'image-asset');
});
