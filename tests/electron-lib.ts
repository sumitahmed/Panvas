// ============================================
// Panvas — shared Electron test helpers
// ============================================
// Used by tests/electron-pipeline.test.ts and tests/electron-integrity.test.ts.
// All helpers assume a freshly built app (npm run build) and clean up after
// themselves.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const disposableRoot = fs.mkdtempSync(path.join(tmpdir(), 'panvas-native-regression-'));
const ownedProcesses = new Set<ChildProcess>();
// These integration tests must never discover or modify a user's workspace.
export function resolvePanvasBase(): string {
  return path.join(disposableRoot, 'workspaces');
}

export const PANVAS_BASE = resolvePanvasBase();

// DOM-level click: Electron + framer-motion intermittently defeat Playwright's
// coordinate-based actionability in this app (hit-testing verifies fine via
// elementFromPoint), so UI driving dispatches clicks directly on the element.
export async function domClick(locator: import('playwright').Locator): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.evaluate(el => (el as HTMLElement).click());
}

export function launchElectron(port: number, windowSize?: string): ChildProcess {
  const env = { ...process.env };
  // Codex and some Node-based runners set this globally. Passing it through
  // makes electron.exe behave as a Node binary and exit without creating a
  // BrowserWindow or CDP endpoint, so native integration tests must remove it.
  delete env.ELECTRON_RUN_AS_NODE;
  // Node's test worker markers are runner-internal. Electron embeds Node and
  // must not be launched as though it were another test worker process.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  env.PANVAS_GATE0_PROFILE = '1';
  env.PANVAS_GATE0_USER_DATA = path.join(disposableRoot, 'profile');
  env.PANVAS_GATE0_WORKSPACE_ROOT = PANVAS_BASE;
  if (windowSize) env.PANVAS_TEST_WINDOW = windowSize;
  const command = process.platform === 'win32'
    ? path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
    : 'npx';
  const args = process.platform === 'win32'
    ? ['.', `--remote-debugging-port=${port}`]
    : ['electron', '.', `--remote-debugging-port=${port}`];
  const child = spawn(command, args, {
    cwd: process.cwd(),
    shell: false,
    stdio: 'ignore',
    detached: false,
    env,
  });
  ownedProcesses.add(child);
  return child;
}

// Stop only processes launched by this test file, including their children.
export async function stopAllElectron(): Promise<void> {
  for (const child of ownedProcesses) {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* Already closed. */ } }
      else child.kill();
    }
  }
  ownedProcesses.clear();
}

export async function stopElectron(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill();
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 2500);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await stopAllElectron();
}

export async function connect(port: number, timeoutMs = 30000): Promise<import('playwright').Browser> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 });
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 700));
    }
  }
  throw new Error(`could not connect to Electron CDP: ${String(lastErr)}`);
}

export async function appPage(browser: import('playwright').Browser): Promise<import('playwright').Page> {
  const pages = browser.contexts().flatMap(c => c.pages());
  const page = pages.find(p => p.url().includes('index.html')) ?? pages[0];
  if (!page) throw new Error('no Electron page found');
  await page.waitForLoadState('domcontentloaded');
  return page;
}

export async function waitForApp(page: import('playwright').Page): Promise<void> {
  await page.getByRole('button', { name: 'New item' }).waitFor({ state: 'visible', timeout: 30000 });
  const root = await page.evaluate(() => window.panvas?.storage.getRoot());
  if (!root?.path || path.resolve(root.path) !== path.resolve(PANVAS_BASE)) {
    throw new Error('Refusing to operate on an Electron window outside this test workspace.');
  }
}

// Tree rows appear only under an expanded workspace; creation flows can leave
// the parent collapsed. Wait, then toggle the workspace node once and retry.
export function makeEnsureTreeRowVisible(workspaceName: string) {
  return async function ensureTreeRowVisible(page: import('playwright').Page, name: RegExp): Promise<void> {
    const sidebar = page.getByRole('complementary');
    const row = sidebar.getByRole('treeitem', { name }).first();
    try {
      await row.waitFor({ state: 'visible', timeout: 12000 });
      return;
    } catch { /* fall through: expand the workspace */ }
    const ws = sidebar.getByRole('button', { name: `Expand ${workspaceName}`, exact: true });
    await domClick(ws);
    await page.waitForTimeout(800);
    await row.waitFor({ state: 'visible', timeout: 12000 });
  };
}

export async function createWorkspaceNotebookSection(
  page: import('playwright').Page,
  workspaceName: string,
  readFileFn: (p: string) => Promise<string>,
): Promise<void> {
  const sidebar = page.getByRole('complementary');
  const newItem = sidebar.getByRole('button', { name: 'New item' });

  await domClick(sidebar.getByRole('button', { name: 'Create workspace' }));
  await page.locator('#create-dialog-input').fill(workspaceName);
  await domClick(page.getByRole('button', { name: 'Create', exact: true }));
  await page.locator('#create-dialog-input').waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(1200);
  // Make the new workspace active (creation does not auto-select it), and
  // VERIFY the switch through the persisted active-id before creating any
  // entities: a missed click would otherwise create them in whatever
  // workspace was active before — possibly the user's real data.
  const wsId = JSON.parse(await readFileFn(path.join(PANVAS_BASE, workspaceName, '.panvas', 'workspace.json'))).id;
  const wsRow = sidebar.getByRole('treeitem', { name: workspaceName, exact: true });
  await domClick(wsRow);
  try {
    await page.waitForFunction(id => localStorage.getItem('panvas.activeWorkspaceId') === id, wsId, { timeout: 6000 });
  } catch {
    await domClick(wsRow);
    await page.waitForFunction(id => localStorage.getItem('panvas.activeWorkspaceId') === id, wsId, { timeout: 10000 });
  }
  await page.waitForTimeout(900);

  await domClick(newItem);
  await domClick(page.getByRole('button', { name: 'New Notebook' }));
  await page.locator('#create-dialog-input').fill('Integrity Notebook');
  await domClick(page.getByRole('button', { name: 'Create', exact: true }));
  await page.locator('#create-dialog-input').waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(900);

  const afterNotebook = JSON.parse(await readFileFn(path.join(PANVAS_BASE, workspaceName, '.panvas', 'workspace.json')));
  const notebook = afterNotebook.notebooks.find((item: any) => item.name === 'Integrity Notebook');
  if (!notebook) throw new Error('Integrity notebook was not persisted in the isolated workspace.');
  const notebookRow = sidebar.locator(`[data-tree-id="${notebook.id}"]`);
  await domClick(notebookRow);
  const notebookToggle = sidebar.locator(`button[data-tree-toggle][aria-label$="${notebook.name}"]`);
  if ((await notebookToggle.count()) > 0 && (await notebookToggle.getAttribute('aria-label'))?.startsWith('Expand')) {
    await domClick(notebookToggle);
  }
  await page.waitForTimeout(800);

  await domClick(newItem);
  await domClick(page.getByRole('button', { name: 'New Section' }));
  await page.locator('#create-dialog-input').fill('Integrity Section');
  await domClick(page.getByRole('button', { name: 'Create', exact: true }));
  await page.locator('#create-dialog-input').waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(900);

  const afterSection = JSON.parse(await readFileFn(path.join(PANVAS_BASE, workspaceName, '.panvas', 'workspace.json')));
  const section = afterSection.notebookSections.find((item: any) => item.notebookId === notebook.id && item.name === 'Integrity Section');
  if (!section) throw new Error('Integrity section was not persisted in the isolated workspace.');
  const notebookToggleAfter = sidebar.locator(`button[data-tree-toggle][aria-label$="${notebook.name}"]`);
  if ((await notebookToggleAfter.count()) > 0 && (await notebookToggleAfter.getAttribute('aria-label'))?.startsWith('Expand')) {
    await domClick(notebookToggleAfter);
    await page.waitForTimeout(500);
  }
  const sectionRow = sidebar.locator(`[data-tree-id="${section.id}"]`);
  await sectionRow.waitFor({ state: 'visible', timeout: 12000 });
  await domClick(sectionRow);
  await page.waitForTimeout(700);
}

// Removes every test workspace created by these suites plus only its own
// binary-store files.
export async function cleanupTestWorkspaces(prefixes: string[]): Promise<void> {
  const { readdir, rm } = await import('node:fs/promises');
  const entries = await readdir(PANVAS_BASE).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!prefixes.some(p => entry.startsWith(p))) continue;
    const ownedDirectory = path.resolve(PANVAS_BASE, entry);
    if (!ownedDirectory.startsWith(path.resolve(disposableRoot) + path.sep)) throw new Error('Test cleanup escaped its disposable root.');
    const wsJsonPath = path.join(PANVAS_BASE, entry, '.panvas', 'workspace.json');
    if (fs.existsSync(wsJsonPath)) {
      const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
      for (const p of wsJson.notebookPages ?? []) {
        if (p?.pdfDataId) {
          await rm(path.join(PANVAS_BASE, 'Assets', 'pdf-store', `${p.pdfDataId}.bin`), { force: true });
          await rm(path.join(PANVAS_BASE, 'Assets', 'pdf-store', `${p.pdfDataId}.meta.json`), { force: true });
        }
      }
    }
    await rm(ownedDirectory, { recursive: true, force: true });
  }
}
