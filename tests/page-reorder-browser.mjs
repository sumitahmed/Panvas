// Page reorder regression: drives the real WorkspaceTree, workspace store, and
// repositories with real HTML5 drag events, asserting that a quick drag reorders
// (the drop position is computed from event geometry, not stale hover state),
// persists across a repository reload, and that store-level reorders render.
// Usage: node tests/page-reorder-browser.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const outDir = 'artifacts/page-reorder-probe';
await mkdir(outDir, { recursive: true });
const server = await createServer({ mode: 'web', cacheDir: path.join(outDir, 'vite-cache'), optimizeDeps: { entries: ['tests/fixtures/reorder-probe.html'] }, server: { port: 0, open: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(url + 'tests/fixtures/reorder-probe.html', { timeout: 90000 });
await page.waitForFunction(() => Boolean(window.reorderProbe?.treeLabels), null, { timeout: 60000 });
await page.evaluate(() => window.reorderProbe.expand());
const probe = () => page.evaluate(() => ({
  tree: window.reorderProbe.treeLabels(),
  store: window.reorderProbe.storePageOrder(),
}));

const initial = await probe();
console.log('initial:', JSON.stringify(initial));

// Drag "Page 3" onto "Page 1" (top quarter => 'before') with real HTML5 events.
const dragResult = await page.evaluate(async () => {
  const host = document.getElementById('root');
  const rowByLabel = label => [...host.querySelectorAll('[role="treeitem"]')].find(row => row.getAttribute('aria-label') === label);
  const source = rowByLabel('Note 3');
  const target = rowByLabel('Note 1');
  if (!source || !target) return { ok: false, reason: 'rows not found' };
  const rect = target.getBoundingClientRect();
  const dataTransfer = new DataTransfer();
  dataTransfer.setData('application/json', JSON.stringify({ type: 'page', id: source.getAttribute('data-tree-id') }));
  const fire = (element, type, clientY) => {
    const event = new DragEvent(type, { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    element.dispatchEvent(event);
  };
  fire(source, 'dragstart', rect.top);
  fire(target, 'dragover', rect.top + rect.height * 0.1);
  fire(target, 'drop', rect.top + rect.height * 0.1);
  fire(source, 'dragend', rect.top);
  await new Promise(resolve => setTimeout(resolve, 600));
  return { ok: true };
});
console.log('drag performed:', JSON.stringify(dragResult));

const afterDrag = await probe();
console.log('after drag:', JSON.stringify(afterDrag));
assert.deepEqual(afterDrag.store, ['Note 3', 'Note 1', 'Note 2', 'Note 4'], 'quick drag must reorder immediately');
assert.deepEqual(afterDrag.tree.slice(-4), afterDrag.store, 'tree must render the new order');

// Reload from the repository and verify persistence.
await page.evaluate(async () => {
  const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
  await useWorkspaceStore.getState().loadWorkspaceContents(window.reorderProbe.workspaceId);
});
const afterReload = await probe();
console.log('after reload:', JSON.stringify(afterReload));
assert.deepEqual(afterReload.store, afterDrag.store, 'reorder must persist across a repository reload');
assert.deepEqual(afterReload.tree.slice(-4), afterReload.store, 'tree order must follow the reloaded order');

// Store-level reorderItems (navigator Move Up/Down path): move 3rd page up one.
await page.evaluate(async () => {
  const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
  const store = useWorkspaceStore.getState();
  const ids = store.notebookPages
    .filter(p => p.sectionId === window.reorderProbe.sectionId && !p.deletedAt)
    .sort((a, b) => a.order - b.order).map(p => p.id);
  const moved = [...ids];
  const [item] = moved.splice(2, 1);
  moved.splice(1, 0, item);
  await store.reorderItems('page', moved);
  await store.loadWorkspaceContents(window.reorderProbe.workspaceId);
});
const afterStoreMove = await probe();
console.log('after store move:', JSON.stringify(afterStoreMove));
assert.deepEqual(afterStoreMove.store, ['Note 3', 'Note 2', 'Note 1', 'Note 4'], 'store-level reorderItems must apply and render');
console.log('PAGE REORDER REGRESSION: PASS');

console.log('page errors:', JSON.stringify(errors));
await page.screenshot({ path: path.join(outDir, 'final.png') });
await browser.close();
await server.close();
console.log('REORDER PROBE DONE');
