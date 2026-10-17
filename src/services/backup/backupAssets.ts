import { sha256Bytes } from '../cloudsync/hash.ts';

export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
export type BackupAssetKind = 'image' | 'pdf' | 'audio';
export interface BackupAsset {
  id: string;
  ownerId: string;
  kind: BackupAssetKind;
  fileName: string;
  mimeType: string;
  createdAt: number;
  byteLength: number;
  sha256: string;
  base64: string;
}
export interface BackupAssetReference { id: string; ownerId: string; kind: BackupAssetKind }
export interface BackupAssetSource {
  pages: Array<{ id: string; pdfDataId?: string }>;
  pagePayloads: Record<string, unknown>;
  canvasPayloads: Record<string, { files?: Record<string, unknown> }>;
  annotationPayloads?: Record<string, { ownerPageId: string; drawing: unknown; content?: unknown }>;
}
export const isBackupId = (id: unknown): id is string => typeof id === 'string'
  && /^[a-zA-Z0-9_-]{1,160}$/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id);

/** Follow stored references only. Never fetch URLs or reinterpret prose/code. */
export function collectBackupAssetReferences(source: BackupAssetSource): Map<string, BackupAssetReference> {
  const references = new Map<string, BackupAssetReference>();
  const remember = (id: unknown, ownerId: string, kind: BackupAssetKind, inline: Set<string>) => {
    if (typeof id !== 'string' || !id || inline.has(id)) return;
    if (!isBackupId(id)) throw new Error('Backup contains an invalid asset identifier.');
    const previous = references.get(id);
    if (previous && previous.kind !== kind) throw new Error(`Asset ${id} is referenced with conflicting types.`);
    if (!previous) references.set(id, { id, ownerId, kind });
  };
  const walk = (root: unknown, ownerId: string, inline = new Set<string>()) => {
    const stack: Array<{ value: unknown; kind: BackupAssetKind }> = [{ value: root, kind: 'image' }];
    const seen = new Set<object>();
    while (stack.length) {
      const { value, kind } = stack.pop()!;
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) { for (const item of value) stack.push({ value: item, kind }); continue; }
      const record = value as Record<string, unknown>;
      const currentKind = record.type === 'image' || record.type === 'inlineImage' ? 'image'
        : record.type === 'pdf' ? 'pdf' : record.type === 'audio' || (typeof record.mimeType === 'string' && record.mimeType.startsWith('audio/')) ? 'audio' : kind;
      remember(record.fileId, ownerId, currentKind, inline);
      remember(record.pdfDataId, ownerId, 'pdf', inline);
      if ((record.type === 'pdf' || record.type === 'audio') && typeof record.content === 'string' && isBackupId(record.content)) {
        remember(record.content, ownerId, record.type, inline);
      }
      for (const [key, child] of Object.entries(record)) {
        if (key !== 'files') stack.push({ value: child, kind: key === 'audioNotes' ? 'audio' : currentKind });
      }
    }
  };
  for (const page of source.pages) {
    if (page.pdfDataId) remember(page.pdfDataId, page.id, 'pdf', new Set());
    walk(source.pagePayloads[page.id], page.id);
  }
  for (const annotation of Object.values(source.annotationPayloads ?? {})) walk(annotation, annotation.ownerPageId);
  for (const [id, canvas] of Object.entries(source.canvasPayloads)) walk(canvas, id, new Set(Object.keys(canvas.files ?? {})));
  return references;
}

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};

export async function collectBackupAssets(source: BackupAssetSource, load: (reference: BackupAssetReference) => Promise<{
  data: ArrayBuffer | Uint8Array; fileName: string; mimeType?: string; createdAt?: number;
} | null | undefined>): Promise<Record<string, BackupAsset>> {
  const entries: Array<[string, BackupAsset]> = [];
  let bytes = 0;
  for (const reference of collectBackupAssetReferences(source).values()) {
    const file = await load(reference);
    if (!file) throw new Error(`Backup cannot complete: referenced ${reference.kind} asset ${reference.id} is missing.`);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    bytes += data.byteLength;
    if (!data.byteLength || bytes > MAX_BACKUP_BYTES) throw new Error('Backup assets are empty or exceed the 100 MiB limit.');
    entries.push([reference.id, { ...reference, fileName: file.fileName,
      mimeType: reference.kind === 'pdf' ? 'application/pdf' : file.mimeType ?? `${reference.kind}/octet-stream`,
      createdAt: file.createdAt ?? Date.now(), byteLength: data.length, sha256: await sha256Bytes(data), base64: encodeBase64(data) }]);
  }
  return Object.fromEntries(entries);
}

export function validateBackupAssetManifest(input: unknown): Record<string, BackupAsset> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid backup asset manifest.');
  let total = 0;
  for (const [id, value] of Object.entries(input)) {
    const asset = value as BackupAsset;
    if (!asset || !isBackupId(id) || asset.id !== id || !isBackupId(asset.ownerId)
      || !['image', 'pdf', 'audio'].includes(asset.kind) || typeof asset.fileName !== 'string' || asset.fileName.length > 1024
      || /[\u0000-\u001f]/.test(asset.fileName) || typeof asset.mimeType !== 'string' || asset.mimeType.length > 160
      || (asset.kind === 'pdf' ? asset.mimeType !== 'application/pdf' : !asset.mimeType.startsWith(`${asset.kind}/`))
      || !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0 || asset.byteLength > MAX_BACKUP_BYTES
      || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256) || typeof asset.base64 !== 'string'
      || asset.base64.length !== Math.ceil(asset.byteLength / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.base64)
      || !Number.isFinite(asset.createdAt)) throw new Error(`Invalid backup asset ${id}.`);
    total += asset.byteLength;
    if (total > MAX_BACKUP_BYTES) throw new Error('Backup assets exceed the 100 MiB limit.');
  }
  return input as Record<string, BackupAsset>;
}

/** All checks finish before the caller starts a storage transaction/staging. */
export async function verifyBackupAssets(source: BackupAssetSource & { header: { version: number }; assets?: Record<string, BackupAsset> }): Promise<{
  bytes: Map<string, Uint8Array>; warnings: string[];
}> {
  const assets = source.header.version === 1 ? {} : validateBackupAssetManifest(source.assets);
  const references = collectBackupAssetReferences(source), decoded = new Map<string, Uint8Array>();
  for (const [id, asset] of Object.entries(assets)) {
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(asset.base64), character => character.charCodeAt(0)); }
    catch { throw new Error(`Backup asset ${id} contains invalid binary data.`); }
    if (bytes.byteLength !== asset.byteLength || encodeBase64(bytes) !== asset.base64 || await sha256Bytes(bytes) !== asset.sha256) {
      throw new Error(`Backup asset ${id} failed its SHA-256 integrity check. Nothing was restored.`);
    }
    const reference = references.get(id);
    if (reference && reference.kind !== asset.kind) throw new Error(`Backup asset ${id} has an incompatible type.`);
    decoded.set(id, bytes);
  }
  const missing = [...references.keys()].filter(id => !decoded.has(id));
  if (missing.length && source.header.version !== 1) throw new Error(`Backup is incomplete: ${missing.length} referenced asset(s) are missing. Nothing was restored.`);
  return { bytes: decoded, warnings: missing.length ? [`This v1 backup omitted ${missing.length} referenced image/PDF/audio asset(s). Their bytes cannot be recovered from this file; the restored references are isolated from existing assets.`] : [] };
}

const pageFields = new Set(['workspaceId', 'notebookId', 'sectionId', 'pageId', 'targetPageId', 'sourcePageId', 'ownerPageId', 'canvasFileId', 'canvasId', 'folderId', 'parentId', 'ownerId', 'deletedByAncestorId']);
const assetFields = new Set(['fileId', 'pdfDataId', 'audioDataId', 'imageDataId']);
const blockFields = new Set(['blockId', 'targetBlockId', 'sourceBlockId', 'parentBlockId']);
export function collectBackupBlockIds(value: unknown, ids = new Set<string>()): Set<string> {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) { for (const child of current) stack.push(child); continue; }
    const record = current as Record<string, unknown>;
    if (typeof record.blockId === 'string' && record.blockId) ids.add(record.blockId);
    if (Array.isArray(record.customBlocks)) for (const block of record.customBlocks) if (block && typeof block.id === 'string') ids.add(block.id);
    for (const child of Object.values(record)) if (child && typeof child === 'object') stack.push(child);
  }
  return ids;
}
export function remapBackupReferences<T>(value: T, entities: Map<string, string>, assets: Map<string, string>, blocks: Map<string, string>, depth = 0): T {
  if (depth > 128) throw new Error('Backup nesting exceeds the supported limit.');
  if (Array.isArray(value)) return value.map(child => remapBackupReferences(child, entities, assets, blocks, depth + 1)) as T;
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, child]) => {
    if (typeof child === 'string') {
      if (pageFields.has(key)) child = entities.get(child) ?? child;
      else if (assetFields.has(key)) child = assets.get(child) ?? child;
      else if (blockFields.has(key)) child = blocks.get(child) ?? child;
      else if (key === 'content' && (record.type === 'pdf' || record.type === 'audio')) child = assets.get(child) ?? child;
      else if (key === 'href') {
        try {
          const url = new URL(child);
          if (['http:', 'https:', 'file:'].includes(url.protocol)) {
            const page = url.searchParams.get('panvasPage'), block = url.searchParams.get('panvasBlock');
            if (page && entities.has(page)) url.searchParams.set('panvasPage', entities.get(page)!);
            if (block && blocks.has(block)) url.searchParams.set('panvasBlock', blocks.get(block)!);
            if ((page && entities.has(page)) || (block && blocks.has(block))) child = url.href;
          }
        } catch { /* Ordinary non-URL link text is preserved. */ }
      }
    }
    if (key === 'customBlocks' && Array.isArray(child)) child = child.map(block => ({ ...block, id: blocks.get(block.id) ?? block.id }));
    return [key, remapBackupReferences(child, entities, assets, blocks, depth + 1)];
  })) as T;
}
