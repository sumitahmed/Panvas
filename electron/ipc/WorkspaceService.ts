import path from 'path';
import { promises as fsPromises, constants as fsConstants } from 'fs';
import { app } from 'electron';
import { writeQueue } from './write-queue.js';
import { generateId } from '../../src/lib/utils/id.js';
import { buildWorkspaceBackup, remapWorkspaceBackup, validateWorkspaceBackup, type BackupImportResult, type WorkspaceBackup } from '../../src/services/backup/backupService.js';
import type { CanvasData } from '../../src/types/canvas.js';
import type { SyncEntityKind } from '../../src/services/cloudsync/types.js';
import { parsePdfAnnotationStorageId } from '../../src/lib/pdfAnnotationStorage.js';
import { getDeletedWorkspaceItems } from './workspace-trash.js';
import type { PanvasBootstrapSnapshot } from '../../src/types/bootstrap.js';
import { NativeRemoteRecordApplyError, prepareRemoteWorkspaceRecords, type NativeRemoteRecord } from './workspace-sync-order.js';
import { DEFAULT_PAGE_PROPERTY_SET } from '../../src/types/notebook.js';

const SYSTEM_DEFAULT_WORKSPACE_ID = 'ws-system-default-v1';
const SYSTEM_WELCOME_CANVAS_ID = 'canvas-system-welcome-v1';
const SYSTEM_DEFAULT_NOTEBOOK_ID = 'nb-system-default-v1';
const SYSTEM_DEFAULT_SECTION_ID = 'sec-system-default-v1';
const SYSTEM_DEFAULT_PAGE_ID = 'page-system-default-v1';

const SAFE_SYNC_FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_STARTUP_WORKSPACES = 2_000;
const MAX_STARTUP_ITEMS = 100_000;
const WORKSPACE_DISCOVERY_CONCURRENCY = 16;
const MAX_RECOVERY_ENTRIES = 512;
const MAX_RECOVERY_DEPTH = 7;

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export class WorkspaceService {
  private readonly defaultBaseDir: string;
  private baseDir: string;
  private workspaceRegistry: Map<string, string> = new Map(); // workspaceId -> workspaceDir
  private persistedWorkspaceLocations: Map<string, string> = new Map();
  /**
   * Cloud reconstruction can deliver records in dependency phases, but the
   * native workspace metadata is one read/modify/write JSON document. Keep
   * remote applications for a workspace serialized so concurrent page or
   * notebook writes cannot each start from the same stale metadata snapshot.
   */
  private readonly remoteApplyTails = new Map<string, Promise<void>>();
  private storageRootLoaded = false;
  private storageRootUnavailable = false;
  private workspaceDiscoveryComplete = false;

  constructor() {
    const profileRoot = process.env.PANVAS_GATE0_PROFILE === '1'
      ? process.env.PANVAS_GATE0_WORKSPACE_ROOT
      : undefined;
    if (profileRoot && !path.isAbsolute(profileRoot)) {
      throw new Error('PANVAS_GATE0_WORKSPACE_ROOT must be absolute.');
    }
    this.defaultBaseDir = profileRoot ? path.resolve(profileRoot) : path.join(app.getPath('documents'), 'Panvas');
    this.baseDir = this.defaultBaseDir;
  }

  private getGlobalSettingsPath(): string {
    return path.join(app.getPath('userData'), 'panvas', 'settings.json');
  }

  private async readGlobalSettings(): Promise<Record<string, unknown>> {
    try {
      const content = await fsPromises.readFile(this.getGlobalSettingsPath(), 'utf8');
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      return parsed as Record<string, unknown>;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return {};
      throw new Error('Panvas settings are unreadable.');
    }
  }

  private async writeGlobalSettings(settings: Record<string, unknown>): Promise<void> {
    const settingsPath = this.getGlobalSettingsPath();
    await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeQueue.enqueue(settingsPath, JSON.stringify(settings, null, 2));
  }

  private async loadStorageRoot(): Promise<void> {
    if (this.storageRootLoaded) return;
    const settings = await this.readGlobalSettings();
    const locations = settings.workspaceLocations;
    if (locations && typeof locations === 'object' && !Array.isArray(locations) && Object.keys(locations).length <= MAX_STARTUP_WORKSPACES) {
      for (const [workspaceId, workspaceDir] of Object.entries(locations)) {
        if (SAFE_SYNC_FILE_ID.test(workspaceId) && typeof workspaceDir === 'string' && path.isAbsolute(workspaceDir)) this.persistedWorkspaceLocations.set(workspaceId, path.resolve(workspaceDir));
      }
    }
    const configured = typeof settings.storageRoot === 'string' ? settings.storageRoot.trim() : '';
    if (!configured) {
      this.baseDir = this.defaultBaseDir;
      this.storageRootLoaded = true;
      return;
    }

    const resolved = path.resolve(configured);
    try {
      const stat = await fsPromises.stat(resolved);
      if (!stat.isDirectory()) throw new Error('not-directory');
      await fsPromises.access(resolved, fsConstants.W_OK);
      this.baseDir = resolved;
    } catch {
      // Never silently rewrite or delete the configured value.  Keep the
      // default root as a safe discovery fallback and expose the condition to
      // the settings UI so the owner can choose a new valid folder.
      this.baseDir = this.defaultBaseDir;
      this.storageRootUnavailable = true;
    }
    this.storageRootLoaded = true;
  }

  async getStorageRootInfo(): Promise<{ path: string; configuredPath: string | null; isDefault: boolean; available: boolean }> {
    await this.loadStorageRoot();
    const settings = await this.readGlobalSettings();
    const configuredPath = typeof settings.storageRoot === 'string' && settings.storageRoot.trim()
      ? path.resolve(settings.storageRoot.trim())
      : null;
    return {
      path: configuredPath ?? this.baseDir,
      configuredPath,
      isDefault: (configuredPath ?? this.baseDir) === this.defaultBaseDir,
      available: !this.storageRootUnavailable,
    };
  }

  async assertStorageRootAvailable(): Promise<void> {
    await this.loadStorageRoot();
    if (this.storageRootUnavailable) throw new Error('The configured storage folder is unavailable. Choose a new folder in Settings.');
  }

  async setStorageRoot(candidate: string): Promise<{ path: string; configuredPath: string; isDefault: boolean; available: boolean }> {
    await this.loadStorageRoot();
    if (typeof candidate !== 'string' || !candidate.trim() || !path.isAbsolute(candidate)) {
      throw new Error('Choose a valid absolute folder path.');
    }
    const resolved = path.resolve(candidate.trim());
    let probePath: string | null = null;
    try {
      const stat = await fsPromises.stat(resolved);
      if (!stat.isDirectory()) throw new Error('not-directory');
      await fsPromises.access(resolved, fsConstants.W_OK);
      probePath = path.join(resolved, `.panvas-write-check-${process.pid}-${Date.now()}`);
      const handle = await fsPromises.open(probePath, 'wx');
      await handle.close();
    } catch {
      throw new Error('The selected storage folder is unavailable or not writable.');
    } finally {
      if (probePath) await fsPromises.rm(probePath, { force: true }).catch(() => undefined);
    }

    // Preserve discoverability of every workspace already under the previous
    // root when the default/new-workspace root changes. This records paths
    // only; it never moves or rewrites those workspaces.
    const priorEntries = await fsPromises.readdir(this.baseDir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[]);
    for (const entry of priorEntries) if (entry.isDirectory()) {
      const priorDir = path.join(this.baseDir, entry.name);
      try {
        const workspace = await this.readWorkspaceJson(priorDir);
        this.persistedWorkspaceLocations.set(workspace.id, priorDir);
        this.workspaceRegistry.set(workspace.id, priorDir);
      } catch { /* ignore non-workspace folders */ }
    }
    const settings = await this.readGlobalSettings();
    const next = {
      ...settings,
      storageRoot: resolved,
      workspaceLocations: Object.fromEntries(this.persistedWorkspaceLocations),
    };
    await this.writeGlobalSettings(next);
    this.baseDir = resolved;
    this.storageRootUnavailable = false;
    this.storageRootLoaded = true;
    this.workspaceDiscoveryComplete = false;
    return { path: resolved, configuredPath: resolved, isDefault: resolved === this.defaultBaseDir, available: true };
  }

  getWorkspaceDirById(workspaceId: string): string {
    const dir = this.workspaceRegistry.get(workspaceId);
    if (!dir) throw new Error(`Workspace ${workspaceId} not found in registry`);
    return dir;
  }

  registerWorkspace(workspaceId: string, workspaceDir: string) {
    const resolved = path.resolve(workspaceDir);
    // The workspace.json ID is canonical. Drop stale aliases that point a
    // different ID at the same directory so one filesystem destination never
    // has two owners in the registry.
    for (const [otherId, otherDir] of this.workspaceRegistry) {
      if (otherId !== workspaceId && path.resolve(otherDir) === resolved) this.workspaceRegistry.delete(otherId);
    }
    for (const [otherId, otherDir] of this.persistedWorkspaceLocations) {
      if (otherId !== workspaceId && path.resolve(otherDir) === resolved) this.persistedWorkspaceLocations.delete(otherId);
    }
    this.workspaceRegistry.set(workspaceId, resolved);
    this.persistedWorkspaceLocations.set(workspaceId, resolved);
  }

  /** Resolve an existing workspace by its stored canonical ID, never by name. */
  async findWorkspaceDirByCanonicalId(workspaceId: string): Promise<string | null> {
    if (!SAFE_SYNC_FILE_ID.test(workspaceId)) throw new Error('Invalid workspace identifier.');
    let candidate = this.workspaceRegistry.get(workspaceId);
    if (!candidate && !this.workspaceDiscoveryComplete) {
      await this.discoverWorkspaces();
      candidate = this.workspaceRegistry.get(workspaceId);
    }
    if (!candidate) return null;
    try {
      const workspace = await this.readWorkspaceJson(candidate);
      if (workspace.id === workspaceId) return candidate;
    } catch { /* stale locations are ignored below */ }
    this.workspaceRegistry.delete(workspaceId);
    if (this.persistedWorkspaceLocations.get(workspaceId) === candidate) this.persistedWorkspaceLocations.delete(workspaceId);
    return null;
  }

  /** Best-effort persistence for explicitly opened workspaces. */
  async rememberWorkspaceLocation(workspaceId: string, workspaceDir: string): Promise<void> {
    await this.loadStorageRoot();
    this.registerWorkspace(workspaceId, workspaceDir);
    try {
      const settings = await this.readGlobalSettings();
      await this.writeGlobalSettings({
        ...settings,
        workspaceLocations: Object.fromEntries(this.persistedWorkspaceLocations),
      });
    } catch (error) {
      // The workspace itself is already durable. A registry preference failure
      // must not turn an explicit open/create operation into data loss.
      console.warn('[WorkspaceService] Could not persist workspace location registry.', error instanceof Error ? error.name : 'unknown');
    }
  }

  unregisterWorkspace(workspaceId: string) {
    this.workspaceRegistry.delete(workspaceId);
    this.persistedWorkspaceLocations.delete(workspaceId);
  }

  getWorkspaceDirByName(name: string) {
    return path.join(this.baseDir, name);
  }

  /** Enumerate workspace metadata from the configured root and any roots that
   * were explicitly opened/registered earlier in this process.  Registration
   * is intentionally retained when the default-new-workspace root changes: no
   * existing workspace is moved, copied, or deleted by a storage preference.
   */
  async discoverWorkspaces(): Promise<Array<{ workspace: any; workspaceDir: string }>> {
    await this.ensureBaseDir();
    const candidates = new Set<string>([this.baseDir]);
    const collect = async (root: string) => {
      const entries = await fsPromises.readdir(root, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[]);
      for (const entry of entries) if (entry.isDirectory()) candidates.add(path.join(root, entry.name));
    };
    await collect(this.baseDir);
    for (const registered of this.workspaceRegistry.values()) candidates.add(registered);
    for (const persisted of this.persistedWorkspaceLocations.values()) candidates.add(persisted);

    const discovered = await mapWithConcurrency([...candidates], WORKSPACE_DISCOVERY_CONCURRENCY, async workspaceDir => {
      try {
        const workspace = await this.readWorkspaceJson(workspaceDir);
        return { workspace, workspaceDir };
      } catch {
        // Non-workspace folders and unreadable folders are ignored during
        // discovery; an explicit open/chooser operation reports its own
        // sanitized validation error.
        return null;
      }
    });
    const found = new Map<string, { workspace: any; workspaceDir: string }>();
    for (const entry of discovered) {
      if (!entry) continue;
      this.registerWorkspace(entry.workspace.id, entry.workspaceDir);
      found.set(entry.workspace.id, entry);
    }

    if (found.size === 0 && !this.storageRootUnavailable) {
      const settings = await this.readGlobalSettings();
      if (!settings.hasCompletedFirstRunBootstrap) {
        try {
          const initial = await this.provisionInitialDefaultWorkspace();
          found.set(initial.workspace.id, initial);
          await this.writeGlobalSettings({
            ...settings,
            hasCompletedFirstRunBootstrap: true,
          });
        } catch (error) {
          console.warn('[WorkspaceService] Could not provision initial default workspace.', error instanceof Error ? error.name : 'unknown');
        }
      }
    }

    this.workspaceDiscoveryComplete = true;
    return [...found.values()].sort((left, right) => left.workspace.name.localeCompare(right.workspace.name));
  }

  private async provisionInitialDefaultWorkspace(): Promise<{ workspace: any; workspaceDir: string }> {
    const workspaceId = SYSTEM_DEFAULT_WORKSPACE_ID;
    const workspaceName = 'My Workspace';
    const workspaceDir = this.getWorkspaceDirByName(workspaceName);
    const panvasDir = this.getPanvasDir(workspaceDir);
    const canvasId = SYSTEM_WELCOME_CANVAS_ID;
    const notebookId = SYSTEM_DEFAULT_NOTEBOOK_ID;
    const sectionId = SYSTEM_DEFAULT_SECTION_ID;
    const pageId = SYSTEM_DEFAULT_PAGE_ID;
    const now = Date.now();

    const canvasFile = {
      id: canvasId,
      workspaceId,
      folderId: null,
      notebookId: null,
      sectionId: null,
      name: 'Welcome Canvas',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      order: 0,
      isPinned: false,
      deletedAt: null,
      isSystem: true,
      systemType: 'welcome',
    };

    const notebook = {
      id: notebookId,
      workspaceId,
      folderId: null,
      name: 'My Notebook',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      order: 0,
      isPinned: false,
      defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET },
      deletedAt: null,
    };

    const section = {
      id: sectionId,
      notebookId,
      name: 'Section 1',
      createdAt: now,
      updatedAt: now,
      order: 0,
      deletedAt: null,
    };

    const page = {
      id: pageId,
      notebookId,
      sectionId,
      title: 'Page 1',
      type: 'default',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      order: 0,
      pagePropertyOverrides: {},
      deletedAt: null,
    };

    const workspaceObj = {
      id: workspaceId,
      name: workspaceName,
      createdAt: now,
      updatedAt: now,
      isPinned: false,
      syncStatus: 'local',
      userId: null,
      deletedAt: null,
      isSystem: true,
      systemType: 'default',
      version: 1,
      folders: [],
      canvasFiles: [canvasFile],
      notebooks: [notebook],
      notebookSections: [section],
      notebookPages: [page],
    };

    await fsPromises.mkdir(panvasDir, { recursive: true });
    await fsPromises.mkdir(path.join(panvasDir, 'journal'), { recursive: true });
    await fsPromises.mkdir(path.join(panvasDir, 'recovery'), { recursive: true });
    await fsPromises.mkdir(path.join(panvasDir, 'temp'), { recursive: true });
    await fsPromises.mkdir(path.join(panvasDir, 'Plugins'), { recursive: true });

    await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'images'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'pdfs'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'videos'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'audio'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'Assets', 'attachments'), { recursive: true });

    await fsPromises.mkdir(path.join(workspaceDir, 'Canvas'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'Notebooks', notebookId, 'pages'), { recursive: true });
    await fsPromises.mkdir(path.join(workspaceDir, 'PDF'), { recursive: true });

    await writeQueue.enqueue(path.join(panvasDir, 'system.json'), JSON.stringify({ version: 1, migration_complete: true }, null, 2));
    await writeQueue.enqueue(path.join(panvasDir, 'settings.json'), JSON.stringify({ version: 1 }, null, 2));
    await writeQueue.enqueue(path.join(panvasDir, 'workspace.json'), JSON.stringify(workspaceObj, null, 2));
    await writeQueue.enqueue(this.getWorkspaceRecoveryPath(workspaceDir), JSON.stringify(workspaceObj, null, 2));

    const canvasData = { canvasFileId: canvasId, elements: [], appState: {}, files: {}, customBlocks: [], version: 1, updatedAt: now };
    await writeQueue.enqueue(path.join(workspaceDir, 'Canvas', `${canvasId}.json`), JSON.stringify(canvasData, null, 2));

    await writeQueue.enqueue(path.join(workspaceDir, 'Notebooks', notebookId, 'notebook.json'), JSON.stringify(notebook, null, 2));
    await writeQueue.enqueue(path.join(workspaceDir, 'Notebooks', notebookId, 'pages', `${pageId}.json`), JSON.stringify(page, null, 2));
    await writeQueue.enqueue(path.join(workspaceDir, 'Notebooks', notebookId, 'pages', `${pageId}.content.json`), JSON.stringify({ type: 'doc', content: [] }, null, 2));
    await writeQueue.enqueue(path.join(workspaceDir, 'Notebooks', notebookId, 'pages', `${pageId}.drawing.json`), JSON.stringify({ objects: [], layers: [] }, null, 2));

    this.registerWorkspace(workspaceId, workspaceDir);
    await this.rememberWorkspaceLocation(workspaceId, workspaceDir);
    return { workspace: workspaceObj, workspaceDir };
  }

  /** One bounded metadata pass used by the Electron renderer bootstrap. */
  async getStartupSnapshot(): Promise<PanvasBootstrapSnapshot> {
    const entries = await this.discoverWorkspaces();
    const all = entries.map(entry => entry.workspace);
    if (all.length > MAX_STARTUP_WORKSPACES || all.some(workspace => [
      workspace.folders, workspace.canvasFiles, workspace.notebooks,
      workspace.notebookSections, workspace.notebookPages,
    ].some((items: unknown) => Array.isArray(items) && items.length > MAX_STARTUP_ITEMS))) {
      throw new Error('Workspace metadata exceeds the safe startup limit.');
    }
    const active = all.filter(workspace => !workspace.deletedAt);
    const folders = active.flatMap(workspace => (workspace.folders ?? []).filter((item: any) => !item.deletedAt));
    const canvasFiles = active.flatMap(workspace => (workspace.canvasFiles ?? []).filter((item: any) => !item.deletedAt));
    const notebooks = active.flatMap(workspace => (workspace.notebooks ?? []).filter((item: any) => !item.deletedAt));
    const notebookSections = active.flatMap(workspace => (workspace.notebookSections ?? []).filter((item: any) => !item.deletedAt));
    const notebookPages = active.flatMap(workspace => (workspace.notebookPages ?? []).filter((item: any) => !item.deletedAt));
    if (folders.length + canvasFiles.length + notebooks.length + notebookSections.length + notebookPages.length > MAX_STARTUP_ITEMS) {
      throw new Error('Workspace metadata exceeds the safe startup limit.');
    }
    const trash = all.reduce((result, workspace) => {
      const roots = getDeletedWorkspaceItems({ ...workspace, workspaces: [workspace] });
      result.workspaces.push(...roots.workspaces);
      result.folders.push(...roots.folders);
      result.canvasFiles.push(...roots.canvasFiles);
      result.notebooks.push(...roots.notebooks);
      result.sections.push(...roots.sections);
      result.pages.push(...roots.pages);
      return result;
    }, { workspaces: [], folders: [], canvasFiles: [], notebooks: [], sections: [], pages: [] } as PanvasBootstrapSnapshot['trash']);
    const trashItemCount = trash.workspaces.length + trash.folders.length + trash.canvasFiles.length
      + trash.notebooks.length + trash.sections.length + trash.pages.length;
    if (trashItemCount > MAX_STARTUP_ITEMS) throw new Error('Workspace metadata exceeds the safe startup limit.');
    const recentFiles = [...canvasFiles]
      .sort((left, right) => (right.lastOpenedAt ?? right.updatedAt ?? 0) - (left.lastOpenedAt ?? left.updatedAt ?? 0))
      .slice(0, 8);
    const settings = await this.readGlobalSettings();
    const lightSettings = Object.fromEntries(Object.entries(settings).filter(([key]) => [
      'notebook_paperColor', 'notebook_template', 'notebook_orientation',
      'notebook_pageSize', 'notebook_margins', 'notebook_scrollDirection',
    ].includes(key)));
    const configuredStorageRoot = typeof settings.storageRoot === 'string' && settings.storageRoot.trim()
      ? path.resolve(settings.storageRoot.trim())
      : null;
    const defaultWorkspace = active.find(workspace => workspace.systemType === 'default' || workspace.isSystem) ?? active[0] ?? null;

    return {
      storageRoot: configuredStorageRoot ?? this.baseDir,
      defaultWorkspaceId: defaultWorkspace?.id ?? null,
      workspaces: active,
      folders,
      canvasFiles,
      notebooks,
      notebookSections,
      notebookPages,
      recentFiles,
      trash,
      settings: lightSettings,
    };
  }

  // Binary assets (imported PDFs) are keyed only by their generated id, not by
  // workspace: the renderer creates the PDF record before the owning page
  // exists, and the id already encodes uniqueness. The renderer's IndexedDB is
  // origin/profile scoped, so the filesystem below the configured Panvas
  // storage root is the durability boundary for these bytes.
  getPdfStoreDir(): string {
    return path.join(this.baseDir, 'Assets', 'pdf-store');
  }

  getImageStoreDir(): string {
    return path.join(this.baseDir, 'Assets', 'image-store');
  }

  getAudioStoreDir(): string {
    return path.join(this.baseDir, 'Assets', 'audio-store');
  }

  private getPanvasDir(workspaceDir: string) {
    return path.join(workspaceDir, '.panvas');
  }

  private getWorkspaceJsonPath(workspaceDir: string) {
    return path.join(this.getPanvasDir(workspaceDir), 'workspace.json');
  }

  private getWorkspaceRecoveryPath(workspaceDir: string) {
    return path.join(this.getPanvasDir(workspaceDir), 'recovery', 'workspace.last-good.json');
  }

  /** Read-only exact-ID recovery discovery for an absent workspace root. */
  async getRecoveryWorkspaceRoot(workspaceId: string): Promise<Record<string, unknown> | null> {
    if (!SAFE_SYNC_FILE_ID.test(workspaceId)) throw new Error('Invalid workspace identifier.');
    await this.loadStorageRoot();
    const candidateFiles = new Set<string>();
    const registered = this.workspaceRegistry.get(workspaceId) ?? this.persistedWorkspaceLocations.get(workspaceId);
    if (registered) {
      candidateFiles.add(this.getWorkspaceRecoveryPath(registered));
      candidateFiles.add(this.getWorkspaceJsonPath(registered));
    }
    const recoveryRoots = new Set([
      path.join(path.dirname(this.baseDir), 'Panvas Recovery Backups'),
      path.join(path.dirname(this.defaultBaseDir), 'Panvas Recovery Backups'),
    ]);
    let visited = 0;
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_RECOVERY_DEPTH || visited >= MAX_RECOVERY_ENTRIES) return;
      const entries = await fsPromises.readdir(dir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[]);
      for (const entry of entries) {
        if (visited >= MAX_RECOVERY_ENTRIES) break;
        visited += 1;
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(filePath, depth + 1);
        else if (entry.isFile() && (entry.name === 'workspace.json' || entry.name === 'workspace.last-good.json')) candidateFiles.add(filePath);
      }
    };
    for (const root of recoveryRoots) await visit(root, 0);
    const matches: Array<{ value: Record<string, unknown>; mtime: number }> = [];
    for (const filePath of candidateFiles) {
      try {
        const stat = await fsPromises.stat(filePath);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        const value = this.parseWorkspaceJson(await fsPromises.readFile(filePath, 'utf8')) as Record<string, unknown>;
        if (value.id !== workspaceId || typeof value.name !== 'string' || value.deletedAt) continue;
        if (value.userId !== undefined && value.userId !== null && typeof value.userId !== 'string') continue;
        const collections = ['folders', 'canvasFiles', 'notebooks', 'notebookSections', 'notebookPages'] as const;
        if (collections.some(key => !Array.isArray(value[key]) || value[key].length > MAX_STARTUP_ITEMS
          || value[key].some((item: unknown) => !item || typeof item !== 'object' || Array.isArray(item)
            || typeof (item as { id?: unknown }).id !== 'string' || !SAFE_SYNC_FILE_ID.test((item as { id: string }).id)))) continue;
        matches.push({ value, mtime: stat.mtimeMs });
      } catch { /* unrelated or corrupt recovery files are ignored */ }
    }
    matches.sort((left, right) => right.mtime - left.mtime);
    return matches[0]?.value ?? null;
  }

  private parseWorkspaceJson(content: string) {
    const ws = JSON.parse(content);
    if (!ws || typeof ws !== 'object' || Array.isArray(ws) || typeof ws.id !== 'string') {
      throw new Error('Workspace metadata is not a valid object.');
    }
    ws.folders = Array.isArray(ws.folders) ? ws.folders : [];
    ws.canvasFiles = Array.isArray(ws.canvasFiles) ? ws.canvasFiles : [];
    ws.notebooks = Array.isArray(ws.notebooks) ? ws.notebooks : [];
    ws.notebookSections = Array.isArray(ws.notebookSections) ? ws.notebookSections : [];
    ws.notebookPages = Array.isArray(ws.notebookPages) ? ws.notebookPages : [];
    return ws;
  }

  async readWorkspaceJson(workspaceDir: string) {
    const workspacePath = this.getWorkspaceJsonPath(workspaceDir);
    try {
      return this.parseWorkspaceJson(await fsPromises.readFile(workspacePath, 'utf8'));
    } catch (primaryError) {
      try {
        const recoveryContent = await fsPromises.readFile(this.getWorkspaceRecoveryPath(workspaceDir), 'utf8');
        const recovered = this.parseWorkspaceJson(recoveryContent);
        await writeQueue.enqueue(workspacePath, JSON.stringify(recovered, null, 2));
        console.warn('[WorkspaceService] Restored corrupt workspace metadata from last-good recovery.');
        return recovered;
      } catch (recoveryError) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
        const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        throw new Error(`Workspace metadata and recovery copy are unreadable: ${workspaceDir} (primary: ${primaryMessage}; recovery: ${recoveryMessage})`);
      }
    }
  }

  async writeWorkspaceJson(workspaceDir: string, data: any) {
    const filePath = this.getWorkspaceJsonPath(workspaceDir);
    const serialized = JSON.stringify(this.parseWorkspaceJson(JSON.stringify(data)), null, 2);
    await writeQueue.enqueue(filePath, serialized);
    // This is a last-known-good recovery mirror, not a second source of truth.
    // It is written only after the canonical metadata write succeeds.
    try {
      await writeQueue.enqueue(this.getWorkspaceRecoveryPath(workspaceDir), serialized);
    } catch (error) {
      // Canonical metadata is already durable. A mirror failure must not turn a
      // successful save into a false failure, but it remains diagnosable.
      console.warn('[WorkspaceService] Could not refresh last-good recovery.', error instanceof Error ? error.name : 'UnknownError');
    }
  }
  
  async ensureBaseDir() {
    await this.loadStorageRoot();
    if (this.storageRootUnavailable) return;
    await fsPromises.mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Explicitly reset this Electron device without touching Google Drive or
   * OAuth settings. A dated recovery snapshot is created before local roots
   * and global binary stores are removed. Only directories discovered through
   * a valid workspace.json are eligible; the Panvas root itself is never
   * removed.
   */
  async resetLocalData(): Promise<{ workspaceIds: string[]; recoveryPath: string | null }> {
    await this.ensureBaseDir();
    await writeQueue.flush();
    const entries = (await this.discoverWorkspaces()).filter(entry => (
      SAFE_SYNC_FILE_ID.test(String(entry.workspace.id))
      && path.resolve(entry.workspaceDir) !== path.resolve(this.baseDir)
    ));
    const workspaceIds = [...new Set(entries.map(entry => String(entry.workspace.id)))];
    const recoveryPath = entries.length > 0
      ? path.join(path.dirname(this.baseDir), 'Panvas Recovery Backups', `device-reset-${Date.now()}`)
      : null;
    if (recoveryPath) {
      await fsPromises.mkdir(path.join(recoveryPath, 'workspaces'), { recursive: true });
      for (const entry of entries) {
        await fsPromises.cp(entry.workspaceDir, path.join(recoveryPath, 'workspaces', entry.workspace.id), { recursive: true, errorOnExist: false });
      }
      // Binary stores are device-local and may be referenced by canvas
      // payloads. Snapshot them alongside the workspace roots before removal.
      for (const directory of [this.getPdfStoreDir(), this.getImageStoreDir(), this.getAudioStoreDir()]) {
        if (await fsPromises.stat(directory).then(stat => stat.isDirectory()).catch(() => false)) {
          await fsPromises.cp(directory, path.join(recoveryPath, path.basename(directory)), { recursive: true, errorOnExist: false });
        }
      }
    }
    for (const entry of entries) await fsPromises.rm(entry.workspaceDir, { recursive: true, force: true });
    for (const directory of [this.getPdfStoreDir(), this.getImageStoreDir(), this.getAudioStoreDir()]) {
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
    const settings = await this.readGlobalSettings();
    await this.writeGlobalSettings({ ...settings, workspaceLocations: {} });
    this.workspaceRegistry.clear();
    this.persistedWorkspaceLocations.clear();
    this.workspaceDiscoveryComplete = false;
    this.remoteApplyTails.clear();
    return { workspaceIds, recoveryPath };
  }

  private async readOptionalJson(filePath: string): Promise<unknown | null> {
    try {
      return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw new Error(`Backup payload is unreadable: ${filePath}`);
    }
  }

  async exportWorkspaceBackup(workspaceId: string): Promise<WorkspaceBackup> {
    const workspaceDir = this.getWorkspaceDirById(workspaceId);
    const metadata = await this.readWorkspaceJson(workspaceDir);
    const pages = metadata.notebookPages ?? [];
    const pagePayloads: Record<string, { drawing: unknown; content: unknown }> = {};
    for (const page of pages) {
      if (!SAFE_SYNC_FILE_ID.test(String(page.id)) || !SAFE_SYNC_FILE_ID.test(String(page.notebookId))) {
        throw new Error('Workspace metadata contains invalid page identifiers.');
      }
      const pagesDir = path.join(workspaceDir, 'Notebooks', page.notebookId, 'pages');
      pagePayloads[page.id] = {
        content: await this.readOptionalJson(path.join(pagesDir, `${page.id}.content.json`)),
        drawing: await this.readOptionalJson(path.join(pagesDir, `${page.id}.drawing.json`)),
      };
    }
    const canvasPayloads: Record<string, CanvasData> = {};
    for (const canvas of metadata.canvasFiles ?? []) {
      if (!SAFE_SYNC_FILE_ID.test(String(canvas.id))) throw new Error('Workspace metadata contains invalid canvas identifiers.');
      const payload = await this.readOptionalJson(path.join(workspaceDir, 'Canvas', `${canvas.id}.json`));
      canvasPayloads[canvas.id] = (payload && typeof payload === 'object' ? payload : {
        canvasFileId: canvas.id, elements: [], appState: {}, files: {}, customBlocks: [], version: 1, updatedAt: canvas.updatedAt, userId: canvas.userId ?? null,
      }) as CanvasData;
    }
    return buildWorkspaceBackup({
      workspace: metadata,
      folders: metadata.folders ?? [],
      notebooks: metadata.notebooks ?? [],
      sections: metadata.notebookSections ?? [],
      pages,
      canvases: metadata.canvasFiles ?? [],
      pagePayloads,
      canvasPayloads,
    });
  }

  async importWorkspaceBackup(input: unknown): Promise<BackupImportResult> {
    const backup = validateWorkspaceBackup(input);
    await this.ensureBaseDir();
    await this.assertStorageRootAvailable();
    const baseName = backup.header.workspaceName.trim();
    let workspaceName = `${baseName} (Restored)`;
    let suffix = 2;
    while (true) {
      try {
        await fsPromises.access(this.getWorkspaceDirByName(workspaceName));
        workspaceName = `${baseName} (Restored ${suffix++})`;
      } catch {
        break;
      }
    }
    const restored = remapWorkspaceBackup(backup, { idFactory: prefix => generateId(prefix), workspaceName, userId: null, now: Date.now() });
    const workspaceDir = this.getWorkspaceDirByName(workspaceName);
    await Promise.all([
      fsPromises.mkdir(path.join(workspaceDir, '.panvas', 'recovery'), { recursive: true }),
      fsPromises.mkdir(path.join(workspaceDir, 'Notebooks'), { recursive: true }),
      fsPromises.mkdir(path.join(workspaceDir, 'Canvas'), { recursive: true }),
    ]);
    const metadata = {
      ...restored.workspace,
      name: workspaceName,
      version: 1,
      folders: restored.folders,
      canvasFiles: restored.canvases,
      notebooks: restored.notebooks,
      notebookSections: restored.sections,
      notebookPages: restored.pages,
    };
    await this.writeWorkspaceJson(workspaceDir, metadata);
    for (const page of restored.pages) {
      const pagesDir = path.join(workspaceDir, 'Notebooks', page.notebookId, 'pages');
      await fsPromises.mkdir(pagesDir, { recursive: true });
      const payload = restored.pagePayloads[page.id];
      if (payload.content !== null && payload.content !== undefined) await writeQueue.enqueue(path.join(pagesDir, `${page.id}.content.json`), JSON.stringify(payload.content, null, 2));
      if (payload.drawing !== null && payload.drawing !== undefined) await writeQueue.enqueue(path.join(pagesDir, `${page.id}.drawing.json`), JSON.stringify(payload.drawing, null, 2));
    }
    for (const canvas of restored.canvases) {
      await writeQueue.enqueue(path.join(workspaceDir, 'Canvas', `${canvas.id}.json`), JSON.stringify(restored.canvasPayloads[canvas.id], null, 2));
    }
    this.registerWorkspace(restored.workspace.id, workspaceDir);
    await this.rememberWorkspaceLocation(restored.workspace.id, workspaceDir);
    return { workspaceId: restored.workspace.id, workspaceName };
  }

  /** Enumerates persisted drawing identities without exposing their contents. */
  async listPageDrawingRecords(workspaceId: string): Promise<Array<{ id: string; notebookId: string; ownerPageId: string }>> {
    const workspaceDir = this.getWorkspaceDirById(workspaceId);
    const metadata = await this.readWorkspaceJson(workspaceDir);
    const activePages = (metadata.notebookPages ?? []).filter((page: any) => !page.deletedAt && SAFE_SYNC_FILE_ID.test(String(page.id)) && SAFE_SYNC_FILE_ID.test(String(page.notebookId)));
    const pagesById = new Map<string, any>(activePages.map((page: any) => [String(page.id), page]));
    const records: Array<{ id: string; notebookId: string; ownerPageId: string }> = [];

    for (const notebookId of [...new Set<string>(activePages.map((page: any) => String(page.notebookId)))]) {
      const pagesDir = path.join(workspaceDir, 'Notebooks', notebookId, 'pages');
      let entries: import('fs').Dirent[];
      try { entries = await fsPromises.readdir(pagesDir, { withFileTypes: true }); }
      catch (error: any) { if (error?.code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.drawing.json')) continue;
        const id = entry.name.slice(0, -'.drawing.json'.length);
        if (!SAFE_SYNC_FILE_ID.test(id)) continue;
        const annotation = parsePdfAnnotationStorageId(id);
        const ownerPageId = annotation?.ownerPageId ?? id;
        const owner = pagesById.get(ownerPageId) as any;
        if (!owner || owner.notebookId !== notebookId || (annotation && owner.type !== 'pdf')) continue;
        records.push({ id, notebookId, ownerPageId });
      }
    }
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Applies a validated cloud record while preserving its stable Panvas ID. */
  async applyRemoteRecord(workspaceId: string, kind: SyncEntityKind, id: string, payload: any, tombstone: boolean, parentId?: string | null): Promise<void> {
    const previous = this.remoteApplyTails.get(workspaceId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.applyRemoteRecordUnlocked(workspaceId, kind, id, payload, tombstone, parentId));
    this.remoteApplyTails.set(workspaceId, current);
    try {
      await current;
    } finally {
      if (this.remoteApplyTails.get(workspaceId) === current) this.remoteApplyTails.delete(workspaceId);
    }
  }

  /** Apply one dependency-ordered workspace batch with filesystem rollback. */
  async applyRemoteRecords(workspaceId: string, records: NativeRemoteRecord[]): Promise<void> {
    const previous = this.remoteApplyTails.get(workspaceId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.applyRemoteRecordsUnlocked(workspaceId, records));
    this.remoteApplyTails.set(workspaceId, current);
    try { await current; }
    finally { if (this.remoteApplyTails.get(workspaceId) === current) this.remoteApplyTails.delete(workspaceId); }
  }

  private async snapshotWorkspaceFiles(workspaceDir: string): Promise<Map<string, Buffer>> {
    const snapshot = new Map<string, Buffer>();
    const visit = async (dir: string): Promise<void> => {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(filePath);
        else if (entry.isFile()) snapshot.set(path.relative(workspaceDir, filePath), await fsPromises.readFile(filePath));
      }
    };
    await visit(workspaceDir);
    return snapshot;
  }

  private async restoreWorkspaceFiles(workspaceDir: string, snapshot: Map<string, Buffer>): Promise<void> {
    await fsPromises.rm(workspaceDir, { recursive: true, force: true });
    await fsPromises.mkdir(workspaceDir, { recursive: true });
    for (const [relative, bytes] of snapshot) {
      const filePath = path.join(workspaceDir, relative);
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, bytes);
    }
  }

  private async applyRemoteRecordsUnlocked(workspaceId: string, records: NativeRemoteRecord[]): Promise<void> {
    let workspaceDir = await this.findWorkspaceDirByCanonicalId(workspaceId) ?? undefined;
    const ordered = prepareRemoteWorkspaceRecords(workspaceId, records, Boolean(workspaceDir));
    const existed = Boolean(workspaceDir && await fsPromises.stat(workspaceDir).then(stat => stat.isDirectory()).catch(() => false));
    const snapshot = existed ? await this.snapshotWorkspaceFiles(workspaceDir!) : null;
    try {
      for (const record of ordered) {
        try {
          await this.applyRemoteRecordUnlocked(workspaceId, record.kind, record.id, record.payload, record.tombstone, record.parentId);
        } catch (error) {
          throw new NativeRemoteRecordApplyError(error, record);
        }
      }
    } catch (error) {
      const currentDir = workspaceDir ?? this.workspaceRegistry.get(workspaceId);
      if (snapshot && currentDir) await this.restoreWorkspaceFiles(currentDir, snapshot);
      else if (!existed && currentDir) {
        await fsPromises.rm(currentDir, { recursive: true, force: true });
        this.workspaceRegistry.delete(workspaceId);
        this.persistedWorkspaceLocations.delete(workspaceId);
      }
      throw error;
    }
  }

  private async applyRemoteRecordUnlocked(workspaceId: string, kind: SyncEntityKind, id: string, payload: any, tombstone: boolean, parentId?: string | null): Promise<void> {
    let workspaceDir: string;
    try {
      workspaceDir = this.getWorkspaceDirById(workspaceId);
    } catch {
      await this.findWorkspaceDirByCanonicalId(workspaceId);
      try { workspaceDir = this.getWorkspaceDirById(workspaceId); }
      catch {
        // A tombstone against an entity that is already absent is idempotent.
        // Do not invent a workspace root just so reconstruction can delete a
        // child that this device never had.
        if (tombstone) return;
        if (kind !== 'workspace' || tombstone) throw new Error('Remote workspace root record is missing for local reconstruction.');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Remote workspace root payload is invalid.');
        if (payload.id !== workspaceId) throw new Error('Remote workspace root identity does not match the manifest workspace.');
        await this.assertStorageRootAvailable();
        const safeBase = String(payload.name || workspaceId).replace(/[\\/:*?"<>|\u0000-\u001F]/g, ' ').trim().slice(0, 120) || workspaceId;
        let directoryName = safeBase;
        let suffix = 2;
        while (true) {
          const candidate = this.getWorkspaceDirByName(directoryName);
          try { await fsPromises.access(candidate); directoryName = `${safeBase} (Cloud ${suffix++})`; } catch { workspaceDir = candidate; break; }
        }
        await Promise.all([
          fsPromises.mkdir(path.join(workspaceDir!, '.panvas', 'recovery'), { recursive: true }),
          fsPromises.mkdir(path.join(workspaceDir!, 'Notebooks'), { recursive: true }),
          fsPromises.mkdir(path.join(workspaceDir!, 'Canvas'), { recursive: true }),
        ]);
        this.registerWorkspace(workspaceId, workspaceDir!);
        await this.rememberWorkspaceLocation(workspaceId, workspaceDir!);
        // The root is committed before descendants, so its canonical
        // relationship arrays are safe to retain. Descendant records then
        // reconcile those arrays in the same serialized transaction instead
        // of forcing a second metadata shape (which made recovery roots hash
        // differently on the next sync).
        await this.writeWorkspaceJson(workspaceDir!, { ...payload, id: workspaceId });
      }
    }

    // Tombstones are idempotent. They must not require a live parent: a
    // parent may have been deleted first on another device, and asking for it
    // here used to turn a valid deletion into a local-record-apply failure.
    if (tombstone && (kind === 'pageContent' || kind === 'pageDrawing')) {
      const metadata = await this.readWorkspaceJson(workspaceDir!);
      const pageId = parsePdfAnnotationStorageId(id)?.ownerPageId ?? id;
      const page = (metadata.notebookPages ?? []).find((item: any) => item.id === pageId);
      if (!page || !SAFE_SYNC_FILE_ID.test(String(page.notebookId))) return;
      const suffix = kind === 'pageContent' ? 'content' : 'drawing';
      await fsPromises.rm(path.join(workspaceDir!, 'Notebooks', page.notebookId, 'pages', `${id}.${suffix}.json`), { force: true });
      return;
    }
    if (tombstone && kind === 'canvasScene') {
      if (!SAFE_SYNC_FILE_ID.test(String(id))) return;
      await fsPromises.rm(path.join(workspaceDir!, 'Canvas', `${id}.json`), { force: true });
      return;
    }
    if (tombstone && kind === 'customBlock') {
      const metadata = await this.readWorkspaceJson(workspaceDir!);
      for (const canvas of metadata.canvasFiles ?? []) {
        if (!SAFE_SYNC_FILE_ID.test(String(canvas.id))) continue;
        const canvasPath = path.join(workspaceDir!, 'Canvas', `${canvas.id}.json`);
        try {
          const scene = JSON.parse(await fsPromises.readFile(canvasPath, 'utf8'));
          if (!Array.isArray(scene.customBlocks)) continue;
          const next = scene.customBlocks.filter((item: any) => item?.id !== id);
          if (next.length !== scene.customBlocks.length) {
            scene.customBlocks = next;
            await writeQueue.enqueue(canvasPath, JSON.stringify(scene, null, 2));
            return;
          }
        } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      }
      return;
    }
    if (kind === 'pageContent' || kind === 'pageDrawing') {
      if (!SAFE_SYNC_FILE_ID.test(String(id))) throw new Error('Remote page payload has an invalid page identifier.');
      const metadata = await this.readWorkspaceJson(workspaceDir!);
      const annotation = kind === 'pageDrawing' ? parsePdfAnnotationStorageId(id) : null;
      const ownerPageId = annotation?.ownerPageId ?? id;
      const page = (metadata.notebookPages ?? []).find((item: any) => item.id === ownerPageId);
      if (!page || !SAFE_SYNC_FILE_ID.test(String(page.id)) || !SAFE_SYNC_FILE_ID.test(String(page.notebookId)) || (annotation && page.type !== 'pdf')) {
        throw new Error('Remote page payload has no canonical page metadata.');
      }
      const pagesDir = path.join(workspaceDir!, 'Notebooks', page.notebookId, 'pages');
      await fsPromises.mkdir(pagesDir, { recursive: true });
      const suffix = kind === 'pageContent' ? 'content' : 'drawing';
      await writeQueue.enqueue(path.join(pagesDir, `${id}.${suffix}.json`), JSON.stringify(payload?.data ?? payload, null, 2));
      return;
    }
    if (kind === 'canvasScene') {
      if (!SAFE_SYNC_FILE_ID.test(String(id))) throw new Error('Remote canvas scene has an invalid canvas identifier.');
      await fsPromises.mkdir(path.join(workspaceDir!, 'Canvas'), { recursive: true });
      const scene = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...payload, canvasFileId: payload.canvasFileId ?? payload.id ?? id }
        : null;
      if (!scene || scene.canvasFileId !== id) throw new Error('Remote canvas scene has an invalid canvas owner.');
      await writeQueue.enqueue(path.join(workspaceDir!, 'Canvas', `${id}.json`), JSON.stringify(scene, null, 2));
      return;
    }

    const metadata = await this.readWorkspaceJson(workspaceDir!);
    if (kind === 'workspace') {
      const nested = { folders: metadata.folders, canvasFiles: metadata.canvasFiles, notebooks: metadata.notebooks, notebookSections: metadata.notebookSections, notebookPages: metadata.notebookPages };
      await this.writeWorkspaceJson(workspaceDir!, { ...metadata, ...payload, ...nested, id: workspaceId, deletedAt: tombstone ? Date.now() : payload.deletedAt ?? null });
      return;
    }
    const collections: Partial<Record<SyncEntityKind, string>> = { folder: 'folders', notebook: 'notebooks', notebookSection: 'notebookSections', notebookPage: 'notebookPages', canvasFile: 'canvasFiles' };
    const collectionName = collections[kind];
    if (collectionName) {
      const sectionId = payload?.sectionId ?? parentId ?? payload?.notebookId;
      const section = typeof sectionId === 'string' ? (metadata.notebookSections ?? []).find((item: any) => item.id === sectionId) : undefined;
      const notebookId = payload?.notebookId ?? section?.notebookId;
      if (!tombstone && kind === 'notebookPage' && (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || !SAFE_SYNC_FILE_ID.test(String(notebookId)) || !SAFE_SYNC_FILE_ID.test(String(sectionId)))) {
        throw new Error('Remote notebook page has invalid relationship identifiers.');
      }
      if (!tombstone && kind === 'notebookPage' && ((!section && sectionId !== notebookId) || (section && section.notebookId !== notebookId))) {
        throw new Error('Remote notebook page has an unavailable or mismatched section parent.');
      }
      const collection = Array.isArray(metadata[collectionName]) ? metadata[collectionName] : [];
      const index = collection.findIndex((item: any) => item.id === id);
      if (tombstone && index < 0) return;
      const value = tombstone ? { ...(index >= 0 ? collection[index] : payload ?? {}), id, deletedAt: Date.now() } : {
        ...payload,
        id,
        ...(kind === 'notebookPage' ? { notebookId, sectionId } : {}),
      };
      if (index >= 0) collection[index] = value; else collection.push(value);
      metadata[collectionName] = collection;
      await this.writeWorkspaceJson(workspaceDir!, metadata);
      return;
    }
    if (kind === 'customBlock') {
      const canvasId = payload?.canvasFileId ?? payload?.canvasId ?? parentId;
      if (typeof canvasId !== 'string' || !SAFE_SYNC_FILE_ID.test(canvasId)) throw new Error('Remote custom block has an invalid canvas owner.');
      const canvasPath = path.join(workspaceDir!, 'Canvas', `${canvasId}.json`);
      const scene = JSON.parse(await fsPromises.readFile(canvasPath, 'utf8'));
      scene.customBlocks = Array.isArray(scene.customBlocks) ? scene.customBlocks : [];
      const index = scene.customBlocks.findIndex((item: any) => item.id === id);
      if (tombstone) { if (index >= 0) scene.customBlocks.splice(index, 1); }
      else {
        const value = { ...payload, id: payload?.id ?? id, canvasFileId: canvasId };
        if (index >= 0) scene.customBlocks[index] = value; else scene.customBlocks.push(value);
      }
      await writeQueue.enqueue(canvasPath, JSON.stringify(scene, null, 2));
    }
  }
}

export const workspaceService = new WorkspaceService();
