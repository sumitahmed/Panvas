import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { isDrawingRecentlyActive, setDrawingGestureActive } from '../src/services/cloudsync/drawingActivity.ts';

function resetActivityAt(now: number): void {
  setDrawingGestureActive({}, false, now);
}

test('drawing activity remains recent through contact and the idle window', () => {
  const t0 = 10_000;
  const owner = {};
  resetActivityAt(t0 - 3_000);
  assert.equal(isDrawingRecentlyActive(3_000, t0), false);
  setDrawingGestureActive(owner, true, t0);
  assert.equal(isDrawingRecentlyActive(3_000, t0 + 120_000), true);
  setDrawingGestureActive(owner, false, t0 + 120_000);
  assert.equal(isDrawingRecentlyActive(3_000, t0 + 122_999), true);
  assert.equal(isDrawingRecentlyActive(3_000, t0 + 123_000), false);
});

test('one active drawing owner keeps the gate closed after another owner ends', () => {
  const t0 = 200_000;
  const first = {};
  const second = {};
  resetActivityAt(t0);
  setDrawingGestureActive(first, true, t0);
  setDrawingGestureActive(second, true, t0);
  setDrawingGestureActive(first, false, t0 + 1_000);
  assert.equal(isDrawingRecentlyActive(3_000, t0 + 5_000), true);
  setDrawingGestureActive(second, false, t0 + 5_000);
  assert.equal(isDrawingRecentlyActive(3_000, t0 + 7_999), true);
  assert.equal(isDrawingRecentlyActive(3_000, t0 + 8_000), false);
});

test('auto cloud sync waits for drawing contact and the idle window, then runs', async t => {
  const previousWindow = (globalThis as any).window;
  const previousStorage = (globalThis as any).localStorage;
  const values = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  (globalThis as any).window = { panvas: {
    workspace: { getAll: async () => [] },
    trash: { getAll: async () => ({ workspaces: [] }) },
    cloudsync: { connect: async () => ({ success: false }), disconnect: async () => ({ success: true }), logDiagnostic: () => {} },
  } };

  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    resolve: { alias: { '@': path.resolve('src') } },
  });
  let store: any;
  let scheduleAutoCloudSync: (() => void) | undefined;
  try {
    const activity = await server.ssrLoadModule('/src/services/cloudsync/drawingActivity.ts');
    const storeModule = await server.ssrLoadModule('/src/stores/cloudSyncStore.ts');
    store = storeModule.useCloudSyncStore;
    scheduleAutoCloudSync = storeModule.scheduleAutoCloudSync;

    let runs = 0;
    store.setState({
      connectionByProvider: { googledrive: { provider: 'googledrive', accountIdentifier: 'synthetic-account', connectedAt: 1 } },
      autoSync: true,
      triggerSync: async () => { runs += 1; },
    });

    const owner = {};
    const t0 = 1_000_000;
    activity.setDrawingGestureActive(owner, true, t0);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
    scheduleAutoCloudSync!();

    t.mock.timers.tick(storeModule.AUTO_CLOUD_SYNC_DELAY_MS);
    assert.equal(runs, 0, 'the initial auto-sync timer must not scan during contact');
    t.mock.timers.tick(storeModule.AUTO_CLOUD_SYNC_DRAWING_RETRY_MS);
    assert.equal(runs, 0, 'the retry must stay deferred while contact is active');

    activity.setDrawingGestureActive(owner, false, t0 + storeModule.AUTO_CLOUD_SYNC_DELAY_MS + storeModule.AUTO_CLOUD_SYNC_DRAWING_RETRY_MS);
    t.mock.timers.tick(storeModule.AUTO_CLOUD_SYNC_DRAWING_IDLE_MS - 1);
    assert.equal(runs, 0, 'pen-up alone must not release the scan before the idle window');
    t.mock.timers.tick(storeModule.AUTO_CLOUD_SYNC_DRAWING_RETRY_MS);
    assert.equal(runs, 1, 'the pending sync runs after drawing has been idle');
    t.diagnostic(`auto-sync deferred through contact and released after ${storeModule.AUTO_CLOUD_SYNC_DRAWING_IDLE_MS}ms idle`);
  } finally {
    store?.setState({ autoSync: false, triggerSync: async () => {} });
    t.mock.timers.reset();
    await server.close();
    (globalThis as any).window = previousWindow;
    (globalThis as any).localStorage = previousStorage;
  }
});
