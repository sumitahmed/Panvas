// Regression test for Bug 5 (Research Space Zoom Stability & Source-Frame Scroll Anchoring)
// Verifies in both Chromium and Electron:
// 1. Desktop (1440x900, 1100x800) with NO manual zoom: expanding Left/Top/Right/Bottom
//    Research Space never rescales zoom; scrolling Page 1 <-> Page 2 never ping-pongs zoom;
//    expanding Left/Top anchors the source page frame within <= 3px when scroll can compensate;
//    Reset all + closing inspector settles cleanly back to baseline A4 fit without oscillation.
// 2. Mobile (390x844 <-> 844x390): initial portrait fit, Research Space expansion keeps zoom stable,
//    Page 1 <-> Page 2 scrolling keeps zoom stable, manual zoom (1.25) is preserved across scroll,
//    Fit page width works, and rotating 390x844 -> 844x390 refits cleanly without oscillation.
// Usage: node tests/research-space-zoom-stability-browser.mjs [--electron]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, _electron } from 'playwright';

const electronMode = process.argv.includes('--electron');
const outDir = 'artifacts/research-space-zoom-stability';
await mkdir(outDir, { recursive: true });
const server = await createServer({
  mode: 'web',
  cacheDir: path.join(outDir, 'vite-cache'),
  optimizeDeps: { entries: ['tests/fixtures/notebook-responsive.html'] },
  server: { port: 0, open: false },
});

let browser;
let electronApp;
let electronTempDir;
const launchElectron = async (width = 1440, height = 900) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panvas-rspace-electron-'));
  const bootstrap = path.join(dir, 'fixture.cjs');
  await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', require('node:path').join(__dirname, 'profile'));
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: ${width},
    height: ${height},
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadURL('about:blank');
});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const app = await _electron.launch({ args: [bootstrap], env, timeout: 30_000 });
  const page = await app.firstWindow();
  return { app, page, dir };
};

const frames = (page, count = 12) => page.evaluate(async count => {
  for (let i = 0; i < count; i += 1) await new Promise(requestAnimationFrame);
}, count);

const settleCheck = async (page, label) => {
  const scales = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 16; i += 1) {
      await new Promise(requestAnimationFrame);
      out.push(window.navigationEngine().viewport.getState().scale);
    }
    return out;
  });
  assert.ok(Math.max(...scales) - Math.min(...scales) < 1e-6, `${label}: zoom settled without oscillation (${Math.min(...scales)}..${Math.max(...scales)})`);
  return scales[scales.length - 1];
};

const clickButton = async (locator) => {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.evaluate(el => el.click());
};

const ensureResearchSpaceOpen = async (page) => {
  const rsHeading = page.getByRole('button', { name: /Research space/i });
  if (!(await rsHeading.isVisible().catch(() => false))) {
    const openBtn = page.locator('button[aria-label="Open page and view inspector"]:visible').first();
    await clickButton(openBtn);
    await frames(page, 10);
  }
  const controls = page.locator('#research-space-controls');
  if (!(await controls.isVisible().catch(() => false))) {
    await clickButton(rsHeading.first());
    await controls.waitFor({ state: 'visible', timeout: 10000 });
  }
};

const sourceFrameScreenMetrics = page => page.evaluate(() => {
  const scroller = document.querySelector('.notebook-viewport');
  const pageEl = document.querySelector('[data-page-index="0"]');
  const sourceOutline = pageEl?.querySelector('.border-panvas-border-default\\/45');
  const target = sourceOutline ?? pageEl;
  const rect = target.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    scrollLeft: scroller.scrollLeft,
    scrollTop: scroller.scrollTop,
    scrollWidth: scroller.scrollWidth,
    clientWidth: scroller.clientWidth,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    scale: window.navigationEngine().viewport.getState().scale,
  };
});

const scrollBetweenPages = async (page, initialScale) => {
  for (let round = 0; round < 2; round += 1) {
    // Scroll to Page 2
    await page.evaluate(() => {
      const scroller = document.querySelector('.notebook-viewport');
      const p2 = document.querySelector('[data-page-index="1"]');
      scroller.scrollTop = p2.offsetTop * window.navigationEngine().viewport.getState().scale;
      window.navigationSelect(1);
    });
    await frames(page, 15);
    const s2 = await settleCheck(page, `round-${round}-page2`);
    assert.ok(Math.abs(s2 - initialScale) < 1e-4, `page 2 scroll keeps zoom stable (${s2} vs ${initialScale})`);

    // Scroll back to Page 1
    await page.evaluate(() => {
      const scroller = document.querySelector('.notebook-viewport');
      scroller.scrollTop = 0;
      window.navigationSelect(0);
    });
    await frames(page, 15);
    const s1 = await settleCheck(page, `round-${round}-page1`);
    assert.ok(Math.abs(s1 - initialScale) < 1e-4, `page 1 return scroll keeps zoom stable (${s1} vs ${initialScale})`);
  }
};

try {
  await server.listen();
  const baseUrl = `${server.resolvedUrls.local[0]}tests/fixtures/notebook-responsive.html?responsive=1`;
  const errors = [];

  if (electronMode) {
    const launched = await launchElectron(1440, 900);
    electronApp = launched.app;
    electronTempDir = launched.dir;
  } else {
    browser = await chromium.launch({ headless: true });
  }

  const openFreshPage = async ({ width, height, mobile = false, hasTouch = false, dpr = 1 }) => {
    if (electronApp) {
      const page = await electronApp.firstWindow();
      const cdp = await electronApp.context().newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: hasTouch });
      page.removeAllListeners('pageerror');
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(baseUrl, { timeout: 120000 });
      await page.waitForFunction(() => Boolean(window.navigationReady?.() && window.navigationEngine?.()), null, { timeout: 90000 });
      await frames(page, 15);
      return { page, close: async () => { await cdp.detach(); } };
    }
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch, deviceScaleFactor: dpr });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseUrl, { timeout: 120000 });
    await page.waitForFunction(() => Boolean(window.navigationReady?.() && window.navigationEngine?.()), null, { timeout: 90000 });
    await frames(page, 15);
    return { page, close: async () => { await context.close(); } };
  };

  // 1. Desktop tests: 1440x900 and 1100x800 (fresh notebook, NO manual zoom).
  for (const size of [{ width: 1440, height: 900 }, { width: 1100, height: 800 }]) {
    const label = `${electronMode ? 'electron' : 'web'}-${size.width}x${size.height}`;
    const { page, close } = await openFreshPage({ width: size.width, height: size.height, dpr: 1 });
    try {
      const initialFitScale = await settleCheck(page, `${label}-initial`);

      await ensureResearchSpaceOpen(page);
      await frames(page, 12);
      const panelOpenScale = await settleCheck(page, `${label}-panel-open`);

      const addTop = page.getByRole('button', { name: 'Add top research space', exact: true });
      const addLeft = page.getByRole('button', { name: 'Add left research space', exact: true });
      const addRight = page.getByRole('button', { name: 'Add right research space', exact: true });
      const addBottom = page.getByRole('button', { name: 'Add bottom research space', exact: true });

      // Scroll slightly down inside Page 1 so vertical scroll compensation has headroom for Top expansion.
      await page.evaluate(() => {
        const scroller = document.querySelector('.notebook-viewport');
        scroller.scrollTop = 180;
      });
      await frames(page, 6);

      // Expand Top twice -> verify zero rescale and source frame vertical stability <= 3px when scrollable.
      for (let i = 0; i < 2; i += 1) {
        const before = await sourceFrameScreenMetrics(page);
        await clickButton(addTop);
        await frames(page, 10);
        const after = await sourceFrameScreenMetrics(page);
        assert.ok(Math.abs(after.scale - panelOpenScale) < 1e-4, `${label} Top+${i + 1}: zero rescaling (${after.scale} vs ${panelOpenScale})`);
        if (before.scrollTop > 0 && after.scrollTop > before.scrollTop) {
          assert.ok(Math.abs(after.top - before.top) <= 3, `${label} Top+${i + 1}: source frame vertically anchored (${after.top} vs ${before.top})`);
        }
      }

      // Expand Right + Bottom -> verify zero rescale.
      for (const [name, btn] of [['Right', addRight], ['Bottom', addBottom]]) {
        await clickButton(btn);
        await frames(page, 10);
        const s = await settleCheck(page, `${label}-${name}`);
        assert.ok(Math.abs(s - panelOpenScale) < 1e-4, `${label} ${name}: zero rescaling (${s} vs ${panelOpenScale})`);
      }

      // Expand Left twice -> verify zero rescale; when horizontal scroll has room, verify horizontal anchoring <= 3px.
      for (let i = 0; i < 2; i += 1) {
        const pre = await sourceFrameScreenMetrics(page);
        if (pre.scrollWidth > pre.clientWidth + 40 && pre.scrollLeft === 0) {
          await page.evaluate(() => { document.querySelector('.notebook-viewport').scrollLeft = 40; });
          await frames(page, 4);
        }
        const before = await sourceFrameScreenMetrics(page);
        await clickButton(addLeft);
        await frames(page, 10);
        const after = await sourceFrameScreenMetrics(page);
        assert.ok(Math.abs(after.scale - panelOpenScale) < 1e-4, `${label} Left+${i + 1}: zero rescaling (${after.scale} vs ${panelOpenScale})`);
        if (before.scrollWidth > before.clientWidth + 4 && after.scrollLeft > before.scrollLeft) {
          assert.ok(Math.abs(after.left - before.left) <= 3, `${label} Left+${i + 1}: source frame horizontally anchored (${after.left} vs ${before.left})`);
        }
      }

      // Scroll Page 1 <-> Page 2 twice: zero zoom ping-pong!
      await scrollBetweenPages(page, panelOpenScale);

      if (size.width === 1440) {
        const resetBtn = page.getByRole('button', { name: 'Reset all', exact: true });
        await clickButton(resetBtn);
        await frames(page, 10);
        const afterReset = await settleCheck(page, `${label}-reset`);
        assert.ok(Math.abs(afterReset - panelOpenScale) < 1e-4, `${label} Reset all preserves zoom before closing inspector`);

        const closeBtn = page.locator('button[aria-label="Close Page Properties"]:visible, button[aria-label="Open page and view inspector"]:visible').first();
        await clickButton(closeBtn);
        await frames(page, 15);
        const afterClose = await settleCheck(page, `${label}-panel-closed`);
        assert.ok(Math.abs(afterClose - initialFitScale) < 1e-4, `${label} closing inspector settles cleanly back to baseline A4 fit (${afterClose} vs ${initialFitScale})`);
      }
      console.log(`PASS: ${label}`);
    } finally {
      await close();
    }
  }

  // 2. Mobile 390x844 <-> 844x390 checks.
  const mobileLabel = `${electronMode ? 'electron' : 'web'}-mobile`;
  const { page: mobPage, close: closeMob } = await openFreshPage({ width: 390, height: 844, mobile: true, hasTouch: true, dpr: 3 });
  try {
    const portraitScale = await settleCheck(mobPage, `${mobileLabel}-portrait-init`);
    const initMetrics = await sourceFrameScreenMetrics(mobPage);
    assert.ok(initMetrics.width <= 392 && initMetrics.width >= 340, `${mobileLabel}: initial portrait A4 fit (${initMetrics.width}px)`);

    // Open inspector on mobile, expand Research Space Left + Right -> zoom unchanged.
    await ensureResearchSpaceOpen(mobPage);
    await frames(mobPage, 10);
    await clickButton(mobPage.getByRole('button', { name: 'Add left research space', exact: true }));
    await frames(mobPage, 10);
    await clickButton(mobPage.getByRole('button', { name: 'Add right research space', exact: true }));
    await frames(mobPage, 10);
    const expandedScale = await settleCheck(mobPage, `${mobileLabel}-rspace`);
    assert.ok(Math.abs(expandedScale - portraitScale) < 1e-4, `${mobileLabel}: Research Space expansion keeps portrait zoom unchanged (${expandedScale} vs ${portraitScale})`);

    const closeBtn = mobPage.locator('button[aria-label="Close Page Properties"]:visible').first();
    await clickButton(closeBtn);
    await frames(mobPage, 10);

    // Scroll Page 1 <-> Page 2 keeps portraitScale.
    await scrollBetweenPages(mobPage, portraitScale);

    // Manual zoom preserved across scroll.
    await mobPage.evaluate(() => window.navigationEngine().viewport.setZoom(1.25));
    await frames(mobPage, 10);
    await scrollBetweenPages(mobPage, 1.25);

    // Fit page width exits manual zoom cleanly without oscillation.
    const fitBtn = mobPage.locator('button[aria-label="Fit page width"]:visible').first();
    await clickButton(fitBtn);
    await frames(mobPage, 15);
    const afterFit = await settleCheck(mobPage, `${mobileLabel}-fit-width`);
    assert.ok(afterFit < 0.7 && Math.abs(afterFit - 1.25) > 0.2, `${mobileLabel}: Fit page width resets manual zoom cleanly (${afterFit})`);

    // Rotate 390x844 -> 844x390: refits cleanly to landscape without oscillation.
    if (electronApp) {
      const cdp = await electronApp.context().newCDPSession(mobPage);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true });
      await cdp.detach();
    } else {
      await mobPage.setViewportSize({ width: 844, height: 390 });
    }
    await frames(mobPage, 20);
    const landscapeScale = await settleCheck(mobPage, `${mobileLabel}-landscape`);
    assert.ok(landscapeScale > afterFit * 1.3, `${mobileLabel}: rotating to 844x390 refits larger (${landscapeScale} vs ${afterFit})`);
    console.log(`PASS: ${mobileLabel}`);
  } finally {
    await closeMob();
  }

  assert.deepEqual(errors, [], `no page errors: ${JSON.stringify(errors)}`);
  console.log(`RESEARCH SPACE ZOOM STABILITY REGRESSION (${electronMode ? 'electron' : 'browser'}): PASS`);
} finally {
  if (browser) await browser.close();
  if (electronApp) await electronApp.close();
  if (electronTempDir) await rm(electronTempDir, { recursive: true, force: true }).catch(() => {});
  await server.close();
}
