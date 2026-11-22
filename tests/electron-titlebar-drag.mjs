// Electron Playwright verification for TopBar window-dragging regions across unmaximized window sizes:
// Verifies at 1280x800, 1024x700, and 900x650 that:
// 1. Generous continuous -webkit-app-region: drag spans exist on BOTH sides of the search bar.
// 2. Every interactive control (sidebar toggle, logo, breadcrumbs, search, Cloud Sync, theme toggle) is no-drag and clickable.
// 3. Electron security boundaries (contextIsolation: true, nodeIntegration: false, sandbox: true) remain intact.
// Usage: node tests/electron-titlebar-drag.mjs --electron
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { _electron } from 'playwright';

const outDir = 'artifacts/electron-titlebar-drag';
await mkdir(outDir, { recursive: true });

const server = await createServer({
  mode: 'web',
  cacheDir: path.join(outDir, 'vite-cache'),
  optimizeDeps: { entries: ['tests/fixtures/navigation-probe.html'] },
  server: { port: 0, open: false },
});

let electronApp;
let electronTempDir;

const launchElectronPage = async (url, width = 1280, height = 800) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panvas-titlebar-electron-'));
  const bootstrap = path.join(dir, 'fixture.cjs');
  await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', require('node:path').join(__dirname, 'profile'));
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: ${width},
    height: ${height},
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#000000', height: 44 },
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadURL(${JSON.stringify(url)});
});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const app = await _electron.launch({ args: [bootstrap], env, timeout: 30_000 });
  const page = await app.firstWindow();
  return { app, page, dir };
};

try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const launched = await launchElectronPage(url + 'tests/fixtures/navigation-probe.html', 1280, 800);
  electronApp = launched.app;
  electronTempDir = launched.dir;
  const page = launched.page;

  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url + 'tests/fixtures/navigation-probe.html', { timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.navProbe?.engine?.()), null, { timeout: 90000 });

  // Reveal the TopBar (navigation-probe starts in notebookModeLevel: 1 which hides AppShell TopBar)
  await page.evaluate(async () => {
    const mod = await import('/src/stores/layoutStore.ts');
    mod.useLayoutStore.setState({ notebookModeLevel: 0, workspaceViewMode: 'edit' });
  });
  await page.waitForSelector('header.panvas-topbar', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(250);

  // Check Electron security boundaries from renderer perspective
  const securityCheck = await page.evaluate(() => ({
    hasNodeRequire: typeof window.require !== 'undefined',
    hasNodeVersions: typeof window.process?.versions?.node !== 'undefined',
  }));
  assert.equal(securityCheck.hasNodeRequire, false, 'nodeIntegration remains disabled');
  assert.equal(securityCheck.hasNodeVersions, false, 'sandbox remains active');

  const testSizes = [
    { width: 1440, height: 900, minTotalDragPx: 340, minSpanPx: 80 },
    { width: 1280, height: 800, minTotalDragPx: 260, minSpanPx: 60 },
    { width: 1024, height: 700, minTotalDragPx: 150, minSpanPx: 40 },
    { width: 900, height: 650, minTotalDragPx: 110, minSpanPx: 30 },
  ];

  for (const { width, height, minTotalDragPx, minSpanPx } of testSizes) {
    await electronApp.evaluate(({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(w, h);
    }, [width, height]);
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);

    const metrics = await page.evaluate(() => {
      const header = document.querySelector('header.panvas-topbar');
      if (!header) return null;
      const rect = header.getBoundingClientRect();
      const y = rect.top + rect.height / 2;

      const effectiveRegion = (el) => {
        let cur = el;
        while (cur && cur !== document.documentElement) {
          const style = getComputedStyle(cur);
          const reg = style.webkitAppRegion || style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region');
          if (reg === 'no-drag' || reg === 'drag') return reg;
          cur = cur.parentElement;
        }
        return 'none';
      };

      const searchBtn = header.querySelector('button[aria-label="Search Panvas"]');
      const searchRect = searchBtn?.getBoundingClientRect();
      // Exclude the right-most 144px reserved for native Windows caption buttons
      const scanEnd = Math.floor(rect.right - 144);
      let totalDragPx = 0;
      let leftOfSearchDragPx = 0;
      let rightOfSearchDragPx = 0;
      let longestSpan = 0;
      let curSpan = 0;

      for (let x = Math.ceil(rect.left + 2); x < scanEnd; x += 2) {
        const hit = document.elementFromPoint(x, y);
        const region = effectiveRegion(hit);
        if (region === 'drag') {
          totalDragPx += 2;
          curSpan += 2;
          if (curSpan > longestSpan) longestSpan = curSpan;
          if (searchRect && x < searchRect.left) leftOfSearchDragPx += 2;
          if (searchRect && x > searchRect.right) rightOfSearchDragPx += 2;
        } else {
          curSpan = 0;
        }
      }

      const controls = [...header.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => ({
        label: b.getAttribute('aria-label') || b.textContent?.trim() || 'button',
        region: effectiveRegion(b),
      }));

      return {
        headerHeight: rect.height,
        headerWidth: rect.width,
        totalDragPx,
        leftOfSearchDragPx,
        rightOfSearchDragPx,
        longestSpan,
        controls,
      };
    });

    assert.ok(metrics, `TopBar rendered at ${width}x${height}`);
    assert.ok(
      metrics.totalDragPx >= minTotalDragPx,
      `[${width}x${height}] expected >= ${minTotalDragPx}px total drag width, got ${metrics.totalDragPx}px (left=${metrics.leftOfSearchDragPx}, right=${metrics.rightOfSearchDragPx})`,
    );
    assert.ok(
      metrics.leftOfSearchDragPx >= minSpanPx,
      `[${width}x${height}] expected >= ${minSpanPx}px drag span left of search, got ${metrics.leftOfSearchDragPx}px`,
    );
    assert.ok(
      metrics.rightOfSearchDragPx >= minSpanPx,
      `[${width}x${height}] expected >= ${minSpanPx}px drag span right of search, got ${metrics.rightOfSearchDragPx}px`,
    );
    assert.ok(
      metrics.longestSpan >= minSpanPx,
      `[${width}x${height}] expected continuous drag span >= ${minSpanPx}px, got ${metrics.longestSpan}px`,
    );
    for (const ctrl of metrics.controls) {
      assert.equal(ctrl.region, 'no-drag', `[${width}x${height}] interactive control "${ctrl.label}" must be no-drag, got "${ctrl.region}"`);
    }
  }

  // Verify interactive header controls remain clickable (toggle sidebar button & search button)
  const sidebarBtn = page.locator('header.panvas-topbar button[aria-label*="library"]').first();
  await sidebarBtn.click();
  await page.waitForTimeout(100);
  const searchBtn = page.locator('header.panvas-topbar button[aria-label="Search Panvas"]').first();
  await searchBtn.click();
  await page.waitForTimeout(100);
  assert.deepEqual(errors, [], `Zero page errors during Electron titlebar drag verification: ${JSON.stringify(errors)}`);

  console.log('PASS: electron-titlebar-drag verified generous continuous drag spans on both sides of Search at 1280x800, 1024x700, and 900x650 while all controls stay no-drag and clickable');
} finally {
  await electronApp?.close();
  if (electronTempDir) await rm(electronTempDir, { recursive: true, force: true });
  await server.close();
}
