import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { buildWorkspaceBackup, remapWorkspaceBackup } from '../src/services/backup/backupService.ts';
import { collectBackupAssets } from '../src/services/backup/backupAssets.ts';
import { copyWorkspaceGraph } from '../src/services/cloudsync/v2/workspaceCopy.ts';
import { encodeAssetEnvelope, decodeAssetEnvelope } from '../src/services/cloudsync/assetEnvelope.ts';

// Explicit release audit: reports incomplete portability as a failing gate.
// No live workspace, filesystem asset store or Google account is accessed.
const out = process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? 'artifacts/documentation-release-prep-20261016';
await mkdir(out, { recursive: true });
const document = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 2, blockId: 'heading-1' }, content: [{ type: 'text', text: 'Portable research' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Formatted link', marks: [{ type: 'bold' }, { type: 'italic' },
    { type: 'highlight', attrs: { color: '#9b59b6' } }, { type: 'textStyle', attrs: { color: '#123456' } },
    { type: 'link', attrs: { href: 'https://panvas.example/app?panvasPage=page-2&panvasBlock=heading-2' } }] }] },
  { type: 'pageReference', attrs: { targetPageId: 'page-2', targetBlockId: 'heading-2', label: 'Other page' } },
  { type: 'image', attrs: { fileId: 'document-image', alt: 'Portable image' } },
  { type: 'codeBlock', attrs: { language: 'rust', wrap: false }, content: [{ type: 'text', text: 'fn main() {}' }] },
  { type: 'blockMath', attrs: { latex: 'E=mc^2' } },
] };
const drawing = { properties: { layoutMode: 'document', pageSize: 'Infinite', infiniteWidth: 794 },
  objects: [{ id: 'document-body', type: 'text', content: document, metadata: { documentRole: 'body', richTextSchemaVersion: 3 } },
    { id: 'legacy-image-object', type: 'image', fileId: 'legacy-image' }],
  audioNotes: [{ id: 'audio-note', fileId: 'audio-file', fileName: 'recording.wav', mimeType: 'audio/wav' }] };
const workspace = { id: 'ws-1', name: 'Disposable portability audit', userId: null };
const notebook = { id: 'nb-1', workspaceId: workspace.id, name: 'Research', folderId: null };
const section = { id: 'section-1', notebookId: notebook.id, name: 'Notes' };
const pages = [
  { id: 'page-1', notebookId: notebook.id, sectionId: section.id, title: 'Document', type: 'standard' },
  { id: 'page-2', notebookId: notebook.id, sectionId: section.id, title: 'Reference', type: 'pdf', pdfDataId: 'pdf-file' },
];
const backupSource = { workspace, notebooks: [notebook], folders: [], sections: [section], pages,
  canvases: [], pagePayloads: { 'page-1': { drawing, content: null }, 'page-2': { drawing: null, content: null } }, canvasPayloads: {} };
const backupAssets = await collectBackupAssets(backupSource, async reference => ({ data: new Uint8Array([0,1,127,128,255]), fileName: reference.id,
  mimeType: reference.kind === 'audio' ? 'audio/wav' : 'image/png', createdAt: 1 }));
const backup = buildWorkspaceBackup({ ...backupSource, assets: backupAssets });
const restored = remapWorkspaceBackup(backup);
const restoredDocument = restored.pagePayloads[restored.pages[0].id].drawing.objects[0].content;
const reference = content => content.content.find(node => node.type === 'pageReference').attrs.targetPageId;
const href = content => content.content.find(node => node.type === 'paragraph').content[0].marks.find(mark => mark.type === 'link').attrs.href;

// Exercise the existing collector functions, compiled unchanged from the current
// source. They are private to payloadSource; this keeps instrumentation out of product code.
const payloadSource = await readFile('src/services/cloudsync/payloadSource.ts', 'utf8');
const collectorSource = payloadSource.slice(payloadSource.indexOf('type AssetKind ='), payloadSource.indexOf('async function mapBounded'));
const collectorModule = await transform(collectorSource + '\nexport { rememberDrawingAssets };', { loader: 'ts', format: 'esm' });
const { rememberDrawingAssets } = await import('data:text/javascript;base64,' + Buffer.from(collectorModule.code).toString('base64'));
const assets = new Map(); rememberDrawingAssets(assets, drawing, 'page-1');

const bytes = new Uint8Array([0, 1, 127, 128, 255]);
const metadata = { id: 'document-image', ownerId: 'page-1', fileName: 'image.png', assetKind: 'image', mimeType: 'image/png', createdAt: 1, userId: null };
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const graph = [
  { entityType: 'workspace', entityId: workspace.id, parentId: null, bytes: encode(workspace) },
  { entityType: 'notebook', entityId: notebook.id, parentId: workspace.id, bytes: encode(notebook) },
  { entityType: 'notebookSection', entityId: section.id, parentId: notebook.id, bytes: encode(section) },
  { entityType: 'notebookPage', entityId: 'page-1', parentId: notebook.id, bytes: encode(pages[0]) },
  { entityType: 'notebookPage', entityId: 'page-2', parentId: notebook.id, bytes: encode(pages[1]) },
  { entityType: 'pageDrawing', entityId: 'page-1', parentId: 'page-1', bytes: encode({ pageId: 'page-1', workspaceId: workspace.id, notebookId: notebook.id, data: drawing, version: 1 }) },
  { entityType: 'asset', entityId: metadata.id, parentId: 'page-1', bytes: encodeAssetEnvelope(metadata, bytes) },
].map(entity => ({ ...entity, workspaceId: workspace.id, tombstone: false, deletedAt: null, ownership: 'current' }));
const copied = await copyWorkspaceGraph('disposable-profile', workspace.id, graph);
const copyOf = (type, id) => copied.entities[graph.findIndex(entity => entity.entityType === type && entity.entityId === id)];
const copiedDrawing = JSON.parse(new TextDecoder().decode(copyOf('pageDrawing', 'page-1').bytes)).data;
const copiedDocument = copiedDrawing.objects[0].content;
const copiedAsset = decodeAssetEnvelope(copyOf('asset', metadata.id).bytes);
assert.deepEqual(copiedAsset.bytes, bytes);
assert.deepEqual(copiedDrawing.properties, drawing.properties);
assert.deepEqual(copiedDocument.content.slice(4), document.content.slice(4));

const checks = {
  backupIncludesSeparateAssets: Boolean(backup.assets && Object.keys(backup.assets).length),
  restoredPageReferenceRemapped: reference(restoredDocument) === restored.pages[1].id,
  restoredInternalLinkRemapped: new URL(href(restoredDocument)).searchParams.get('panvasPage') === restored.pages[1].id,
  driveCollectorIncludesDocumentImages: assets.has('document-image'),
  driveCollectorIncludesLegacyImageAndAudio: assets.has('legacy-image') && assets.has('audio-file'),
  driveCopyPageReferenceRemapped: reference(copiedDocument) === copyOf('notebookPage', 'page-2').entityId,
  driveCopyInternalLinkRemapped: new URL(href(copiedDocument)).searchParams.get('panvasPage') === copyOf('notebookPage', 'page-2').entityId,
  driveCopyAssetBytesAndOwnershipRetained: Buffer.from(copiedAsset.bytes).equals(Buffer.from(bytes)) && copiedAsset.metadata.ownerId === copyOf('notebookPage', 'page-1').entityId,
  driveCopyRichCodeMathAndInfiniteMetadataRetained: true,
};
const result = { scope: 'Current backup builder/remapper and existing sync collector/copy functions, disposable in-memory fixtures; not live Drive acceptance',
  backupVersion: backup.header.version, checks, releaseReady: Object.values(checks).every(Boolean), collectedAssetIds: [...assets.keys()],
  restoredExpectedPageId: restored.pages[1].id, restoredActualTarget: reference(restoredDocument),
  copiedExpectedPageId: copyOf('notebookPage', 'page-2').entityId, copiedActualTarget: reference(copiedDocument) };
await writeFile(`${out}/portability-audit.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.releaseReady ? 0 : 1;
