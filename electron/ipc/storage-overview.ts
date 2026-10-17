import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import type { StorageOverview, StorageRootInfo } from '../../src/types/storageOverview.js';

const OWNED_DIRS = ['.panvas', 'Canvas', 'Notebooks', 'PDF', 'Assets'];
const MAX_CANDIDATES = 2_000;
const MAX_ENTRIES = 100_000;
const MAX_METADATA_BYTES = 10 * 1024 * 1024;

/** Read-only Settings inspection. Never provisions, repairs, or moves data. */
export async function inspectNativeStorage(options: {
  root: StorageRootInfo; roots: string[]; registeredDirs: string[];
  budgetMs?: number; maxEntries?: number;
}): Promise<StorageOverview> {
  const deadline = Date.now() + (options.budgetMs ?? 2_000);
  const issues = new Set<string>();
  const candidates = new Set(options.registeredDirs.map(dir => path.resolve(dir)));
  const counts = { workspaces: 0, canvases: 0, notebooks: 0, pages: 0 };
  let countsComplete = true, partial = false, visited = 0, usedBytes = 0, rootAvailable = options.root.available;
  const limit = options.maxEntries ?? MAX_ENTRIES;
  try {
    if (!(await fs.stat(options.root.path)).isDirectory()) throw new Error('not-directory');
    await fs.access(options.root.path, constants.R_OK | constants.W_OK);
  } catch { rootAvailable = false; }
  if (!rootAvailable) issues.add('The configured storage folder is not available to Panvas in this session. Check access or reopen Panvas after the folder becomes available.');

  for (const root of new Set(options.roots)) {
    if (candidates.size >= MAX_CANDIDATES || Date.now() >= deadline) { countsComplete = false; break; }
    candidates.add(path.resolve(root));
    try {
      const directory = await fs.opendir(root);
      for await (const entry of directory) {
        if (candidates.size >= MAX_CANDIDATES || Date.now() >= deadline) { countsComplete = false; break; }
        if (entry.isDirectory()) candidates.add(path.join(root, entry.name));
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') { countsComplete = false; issues.add('A storage folder could not be listed.'); }
    }
  }

  const usageRoots = new Set(options.roots.map(root => path.join(root, 'Assets')));
  const workspaceIds = new Set<string>();
  for (const dir of candidates) {
    if (Date.now() >= deadline) { countsComplete = false; break; }
    try {
      const file = path.join(dir, '.panvas', 'workspace.json');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) throw new Error('invalid metadata');
      const workspace = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!workspace || typeof workspace.id !== 'string') throw new Error('invalid metadata');
      for (const name of OWNED_DIRS) usageRoots.add(path.join(dir, name));
      if (workspaceIds.has(workspace.id)) continue;
      workspaceIds.add(workspace.id);
      if (workspace.deletedAt) continue;
      counts.workspaces++;
      const active = (key: string): any[] => {
        const items = workspace[key] ?? [];
        if (!Array.isArray(items) || items.length > MAX_ENTRIES || items.some(item => !item || typeof item.id !== 'string')) throw new Error('invalid collection');
        return items.filter(item => !item.deletedAt);
      };
      counts.canvases += active('canvasFiles').length;
      const notebooks = active('notebooks');
      counts.notebooks += notebooks.length;
      const notebookIds = new Set(notebooks.map(item => item.id));
      const sectionIds = new Set(active('notebookSections').filter(item => notebookIds.has(item.notebookId)).map(item => item.id));
      counts.pages += active('notebookPages').filter(item => notebookIds.has(item.notebookId) && sectionIds.has(item.sectionId)).length;
    } catch (error: any) {
      if (error.code !== 'ENOENT' || options.registeredDirs.includes(dir)) {
        countsComplete = false; issues.add('Some registered workspace metadata is missing or unreadable.');
      }
    }
  }

  // Bound both elapsed work and entries. No payload reads and no symlink walks.
  // A lower bound is labeled partial; it is never presented as exact usage.
  const seen = new Set<string>();
  const pending = [...usageRoots];
  const visit = async (file: string): Promise<void> => {
    const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    if (seen.has(key)) return;
    seen.add(key);
    if (++visited > limit || Date.now() >= deadline) { partial = true; return; }
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) { partial = true; return; }
      if (stat.isFile()) { usedBytes += stat.size; return; }
      if (!stat.isDirectory()) return;
      const directory = await fs.opendir(file);
      for await (const entry of directory) {
        if (visited + pending.length >= limit || Date.now() >= deadline) { partial = true; break; }
        pending.push(path.join(file, entry.name));
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') { partial = true; issues.add('Some local files could not be measured.'); }
    }
  };
  while (pending.length && visited < limit && Date.now() < deadline) {
    await Promise.all(pending.splice(0, 8).map(visit));
  }
  partial ||= pending.length > 0 || !countsComplete || !rootAvailable;
  if (!countsComplete) issues.add('Counts are incomplete. Refresh when the storage folders are available.');
  if (partial) issues.add('Usage is a lower bound; the bounded scan did not measure every file.');
  const health = !rootAvailable ? 'unavailable' : issues.size || partial ? 'attention' : 'accessible';
  return {
    backend: 'filesystem', counts: !rootAvailable && workspaceIds.size === 0 ? null : counts, countsComplete: countsComplete && rootAvailable, usedBytes: !rootAvailable && usedBytes === 0 ? null : usedBytes,
    usageKind: !rootAvailable && usedBytes === 0 ? 'unavailable' : partial ? 'partial' : 'measured', quotaBytes: null,
    health, healthDetail: health === 'accessible'
      ? 'Storage folder is readable and writable; workspace metadata was read successfully. Document contents were not integrity-checked.'
      : [...issues].join(' '),
    root: { ...options.root, available: rootAvailable }, measuredAt: Date.now(), issues: [...issues],
  };
}
