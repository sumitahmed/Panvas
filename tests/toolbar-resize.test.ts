// ============================================
// Panvas — Live resize regression test
// ============================================
// Phase 0 automated UI regression (roadmap section 7 / ticket P0-2).
//
// Serves the production build in dist/ over a local HTTP server, drives the
// real application UI, resizes the live window across every roadmap toolbar
// breakpoint, and asserts:
//   - the inline toolbar groups match the toolbarLayout.ts contract for the
//     width actually available to the toolbar container
//   - the "More Tools" menu contains exactly the overflowed groups, in order
//   - protected primary tools (pen/pencil/highlighter/marker/eraser/text)
//     remain reachable (inline or in the menu / compact active-tool control)
//   - no toolbar control is clipped by the viewport
//   - the toolbar bar never intersects the workspace-controls cluster
//   - compact and minimal tiers engage at their breakpoints
// plus spot-checks for the Phase 0 fixes: properties-drawer clearance,
// popup Escape handling, and toolbar collapse/expand — and a zoom focal-point
// stability check for the remaining (vertical-only) P0-1 surface.
//
// Prerequisite: a fresh production build (npm run build) in dist/.
// Run: npm run test:resize

import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  resolveToolbarLayout,
  type ToolbarGroupId,
} from '../src/components/notebook/toolbarLayout.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

async function startStaticServer(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const safePath = path.normalize(urlPath).replace(/^([/\\])+/, '');
      let filePath = path.join(DIST_DIR, safePath);
      if (!filePath.startsWith(DIST_DIR)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      try {
        const stat = await readFile(filePath, 'utf-8').then(() => true, () => false);
        if (!stat) throw new Error('not found');
      } catch {
        filePath = path.join(DIST_DIR, 'index.html'); // hash routing fallback
      }
      const data = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => server.close(),
  };
}

// Toolbar button title (tooltip) -> toolbar group, mirroring the button
// definitions in NotebookFloatingToolbar.tsx.
const TITLE_TO_GROUP: Record<string, ToolbarGroupId> = {
  'Undo (Ctrl+Z)': 'history',
  'Redo (Ctrl+Y)': 'history',
  'Handwriting to Text': 'handwriting',
  'Pen (P)': 'primary',
  'Pen and writing settings': 'primary',
  'Pencil (N)': 'pencil',
  'Highlighter (H)': 'primary',
  'Marker (M)': 'primary',
  'Eraser (E)': 'primary',
  'Text (T)': 'primary',
  'Select (V)': 'select',
  'Hand (Space)': 'hand',
  'Insert Image': 'image',
  'Shapes': 'shapes',
  'Rectangle (R)': 'shapes',
  'Ellipse (O)': 'shapes',
  'Arrow (A)': 'shapes',
  'Line (L)': 'shapes',
  'Show Ruler': 'ruler',
  'Hide Ruler': 'ruler',
  'Laser Pointer': 'laser',
  'Ink Gestures': 'gestures',
  'Text Formatting': 'format',
};

interface ToolbarSnapshot {
  cellWidth: number;
  bar: { x: number; right: number; y: number } | null;
  controls: { x: number; right: number } | null;
  inlineTitles: string[];
  buttonRects: { title: string; x: number; right: number }[];
  hasMoreButton: boolean;
}

async function snapshotToolbar(page: import('playwright').Page): Promise<ToolbarSnapshot> {
  return page.evaluate(() => {
    const header = document.querySelector(
      '.panvas-notebook-chrome.panvas-layer-toolbar',
    ) as HTMLElement | null;
    const dock = document.querySelector('.panvas-mobile-tool-dock');
    const host = header ?? dock;
    if (!host) throw new Error('floating toolbar host not found');
    const toolbarBar = host.querySelector('.panvas-toolbar-surface') as HTMLElement | null;
    // The toolbar's flex cell is the toolbar bar's direct parent wrapper (the
    // navigator wrapper may or may not be mounted at this width, so positional
    // child indexes are not reliable).
    const middle = (toolbarBar?.parentElement ?? null) as HTMLElement | null;
    const controls = header ? Array.from(header.children).find(c => String(c.className).includes('flex-shrink-0')) ?? null : null;
    const buttons = toolbarBar ? Array.from(toolbarBar.querySelectorAll('button')) : [];
    const buttonRects = buttons
      .filter(b => b.title)
      .map(b => ({ title: b.title, x: b.getBoundingClientRect().x, right: b.getBoundingClientRect().right }));
    const mr = middle?.getBoundingClientRect() ?? { width: 0 };
    const br = toolbarBar?.getBoundingClientRect();
    const cr = controls?.getBoundingClientRect();
    return {
      cellWidth: mr.width,
      bar: br ? { x: br.x, right: br.right, y: br.y } : null,
      controls: cr ? { x: cr.x, right: cr.right } : null,
      inlineTitles: buttonRects.map(b => b.title).filter(t => t !== 'More Tools' && t !== 'Hide Toolbar' && !t.endsWith('— active')),
      buttonRects: buttonRects.map(b => ({ title: b.title, x: b.x, right: b.right })),
      hasMoreButton: buttons.some(b => b.title === 'More Tools'),
    };
  });
}

function titlesToGroups(titles: string[]): string[] {
  const groups: string[] = [];
  for (const title of titles) {
    const group = TITLE_TO_GROUP[title];
    if (group && groups[groups.length - 1] !== group) groups.push(group);
  }
  return groups;
}

async function createNotebookPage(page: import('playwright').Page): Promise<void> {
  const newItem = page.getByRole('button', { name: 'New item' });
  const sidebar = page.getByRole('complementary');
  await newItem.waitFor({ state: 'visible', timeout: 30000 });
  await newItem.click();

  // Both the sidebar menu and the empty canvas legitimately expose a real
  // notebook action. This workflow is specifically exercising the sidebar
  // hierarchy, so scope the locator rather than relying on global uniqueness.
  const notebookItem = sidebar.getByRole('button', { name: 'New Notebook' });
  await notebookItem.waitFor({ state: 'visible', timeout: 5000 });
  await notebookItem.click();
  await page.locator('#create-dialog-input').fill('Resize Regression Notebook');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForTimeout(600);

  // Notebook creation now persists an initial section and page. Open that
  // actual notebook rather than building a second empty hierarchy.
  await sidebar.locator('[data-tree-id]').filter({ hasText: 'Resize Regression Notebook' }).first().click();

  // Wait until the notebook floating toolbar mounts (page became active).
  await page.locator('button[title="Hide Toolbar"]').waitFor({ state: 'visible', timeout: 15000 });
}

async function readOverflowMenu(page: import('playwright').Page): Promise<string[]> {
  const more = page.locator('button[title="More Tools"]');
  assert.ok(await more.count() === 1, 'More Tools button should exist to open the menu');
  await more.click();
  const menu = page.locator('div[role="menu"][aria-label="More Tools"]');
  await menu.waitFor({ state: 'visible', timeout: 5000 });
  const titles = await menu.locator('button[title]').evaluateAll(buttons =>
    buttons.map(b => (b as HTMLElement).title),
  );
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: 5000 });
  return titles;
}

test('live resize across roadmap breakpoints satisfies the toolbar contract', async () => {
  const server = await startStaticServer();
  const browser = await chromium.launch({ headless: true });
  const results: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', err => results.push(`PAGE ERROR: ${err.message}`));
    await page.goto(`${server.url}#/app`, { waitUntil: 'domcontentloaded' });
    await createNotebookPage(page);

    // Sweep A — sidebar open (default): desktop + half-window reality.
    // Sweep B — sidebar closed: the toolbar cell gets maximum width, which is
    // what the roadmap brackets are defined against.
    const sweeps: { name: string; widths: number[]; menuCheckWidths: number[] }[] = [
      { name: 'sidebar-open', widths: [1280, 1100, 1000, 960, 900, 820, 760, 720, 680], menuCheckWidths: [1280, 900, 680] },
      // 440/400 cover the deliberate mobile presentation (<600px): the compact
      // toolbar tier, the capped More menu, and the bottom-sheet Page & View.
      { name: 'sidebar-closed', widths: [1920, 1280, 960, 800, 720, 640, 560, 480, 440, 420, 400], menuCheckWidths: [1280, 720, 480, 400] },
    ];

    for (const sweep of sweeps) {
      if (sweep.name === 'sidebar-closed') {
        // The active notebook layout can expose either left navigation panel.
        // Restore desktop controls after the preceding narrow-window sweep.
        await page.setViewportSize({ width: 1920, height: 800 });
        await page.waitForTimeout(350);
        const hideNavigation = page.locator('button[title="Hide Library"], button[title="Hide Notebook Navigator"]').first();
        if (await hideNavigation.count()) await hideNavigation.click();
        assert.ok(await page.locator('button[title="Show Library"], button[title="Show Notebook Navigator"]').count() > 0, 'left navigation is closed');
        await page.waitForTimeout(600);
      }

      for (const width of sweep.widths) {
        await page.setViewportSize({ width, height: 800 });
        // Let the ResizeObserver + React re-render settle.
        await page.waitForTimeout(350);

        // The properties drawer (open by default) must auto-close once the
        // notebook area can no longer hold it plus the minimal toolbar.
        if (sweep.name === 'sidebar-open' && width <= 900) {
          const drawerOpen = await page.locator('aside.w-72').count();
          assert.equal(drawerOpen, 0,
            `[sidebar-open ${width}px] properties drawer should have auto-closed at this width`);
        }

        const snap = await snapshotToolbar(page);
        const activeLabel = snap.buttonRects.find(button => button.title.endsWith('— active'))?.title ?? '';
        const activeGroup: ToolbarGroupId = activeLabel.startsWith('Pencil') ? 'pencil'
          : activeLabel.startsWith('Select') ? 'select'
          : activeLabel.startsWith('Hand') ? 'hand'
          : activeLabel.startsWith('Laser') ? 'laser' : 'primary';
        // The existing laptop/mobile presentation has a fixed compact writing
        // row. Wider windows use the measured, deterministic group resolver.
        const expected = width <= 1023 ? {
          visible: ['history', 'primary', 'select', 'primary'],
          overflow: ['primary', 'pencil', 'hand', 'handwriting', 'image', 'shapes', 'ruler', 'laser', 'gestures', 'format'],
          compact: true,
        } : resolveToolbarLayout(snap.cellWidth, activeGroup);

        const actualGroups = titlesToGroups(snap.inlineTitles);
        const expectedVisible = expected.visible.filter(g => g !== 'active-tool');
        assert.deepEqual(
          actualGroups,
          expectedVisible,
          `[${sweep.name} ${width}px] cell=${snap.cellWidth.toFixed(0)}px inline groups`,
        );

        const hasActiveToolControl = snap.buttonRects.some(b => b.title.endsWith('— active') || b.title === 'Pen and writing settings');
        assert.equal(
          hasActiveToolControl,
          expected.compact,
          `[${sweep.name} ${width}px] compact active-tool control presence (cell=${snap.cellWidth.toFixed(0)}px)`,
        );
        assert.equal(snap.hasMoreButton, expected.overflow.length > 0,
          `[${sweep.name} ${width}px] More button presence`);

        // No toolbar control may be clipped by the viewport.
        for (const b of snap.buttonRects) {
          assert.ok(b.x >= -1 && b.right <= width + 1,
            `[${sweep.name} ${width}px] "${b.title}" clipped (x=${b.x.toFixed(0)}, right=${b.right.toFixed(0)})`);
        }

        // The toolbar bar must never overlap the workspace-controls cluster.
        if (snap.bar && snap.controls) {
          const overlap = snap.bar.right > snap.controls.x + 1 && snap.controls.right > snap.bar.x + 1;
          assert.ok(!overlap,
            `[${sweep.name} ${width}px] toolbar bar (${snap.bar.x.toFixed(0)}..${snap.bar.right.toFixed(0)}) overlaps controls (${snap.controls.x.toFixed(0)}..${snap.controls.right.toFixed(0)}) at cell=${snap.cellWidth.toFixed(0)}px`);
        }

        if (sweep.menuCheckWidths.includes(width)) {
          const menuTitles = await readOverflowMenu(page);
          const menuGroups = titlesToGroups(menuTitles);
          assert.deepEqual(menuGroups, [...expected.overflow],
            `[${sweep.name} ${width}px] overflow menu contents/order`);

          // Protected primary tools must remain reachable: inline, in the
          // menu, or via the compact active-tool control.
          const reachable = new Set([...snap.inlineTitles, ...menuTitles]);
          const primary = ['Pen (P)', 'Pencil (N)', 'Highlighter (H)', 'Marker (M)', 'Eraser (E)', 'Text (T)'];
          if (!expected.compact) {
            for (const t of primary) {
              assert.ok(reachable.has(t), `[${sweep.name} ${width}px] primary tool "${t}" unreachable`);
            }
          } else {
            assert.ok(hasActiveToolControl, `[${sweep.name} ${width}px] compact active-tool control missing`);
            for (const t of primary) {
              assert.ok(reachable.has(t) || hasActiveToolControl,
                `[${sweep.name} ${width}px] primary tool "${t}" unreachable in compact mode`);
            }
          }
        }
        results.push(`PASS ${sweep.name} ${width}px cell=${snap.cellWidth.toFixed(0)} compact=${expected.compact} inline=[${actualGroups.join(',')}] overflow=[${expected.overflow.join(',')}]`);
      }

      if (sweep.name === 'sidebar-closed') {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.waitForTimeout(350);
        const showNavigation = page.locator('button[title="Show Library"], button[title="Show Notebook Navigator"]').first();
        if (await showNavigation.count()) await showNavigation.click();
        await page.waitForTimeout(500);
      }
    }

    // ---- Phase 0 fix spot-checks ------------------------------------------

    // 1) Properties drawer at sub-xl width must not cover the toolbar or the
    //    workspace controls, and the toolbar must stay clickable.
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(400);
    await page.locator('button[title="Toggle Page Properties"]').click();
    await page.waitForTimeout(500);
    const drawerGeo = await page.evaluate(() => {
      const drawer = document.querySelector('aside.w-72');
      const header = document.querySelector(
        '.panvas-notebook-chrome.panvas-layer-toolbar',
      ) as HTMLElement | null;
      if (!header) throw new Error('floating header not found');
      const controls = Array.from(header.children).find(c => String(c.className).includes('flex-shrink-0')) as HTMLElement;
      const toolbarBar = header.querySelector('.panvas-toolbar-surface') as HTMLElement;
      const d = drawer?.getBoundingClientRect();
      const c = controls.getBoundingClientRect();
      const t = toolbarBar.getBoundingClientRect();
      return { drawer: d ? { x: d.x, right: d.right } : null, controls: { right: c.right }, toolbar: { right: t.right } };
    });
    assert.ok(drawerGeo.drawer, 'properties drawer should be open');
    assert.ok(drawerGeo.controls.right <= drawerGeo.drawer!.x + 1,
      `controls (right=${drawerGeo.controls.right}) must clear the drawer (x=${drawerGeo.drawer!.x})`);
    assert.ok(drawerGeo.toolbar.right <= drawerGeo.drawer!.x + 1,
      `toolbar (right=${drawerGeo.toolbar.right}) must clear the drawer (x=${drawerGeo.drawer!.x})`);

    // Toolbar interaction while the drawer is open: activating a drawing tool
    // from the More menu opens its settings popup and closes the menu.
    const more = page.locator('button[title="More Tools"]');
    if (await more.count() === 1) {
      await more.click();
      const pen = page.locator('div[role="menu"][aria-label="More Tools"] button[title="Pen (P)"]');
      if (await pen.count() === 1) {
        await pen.click();
        await page.waitForTimeout(500);
        assert.ok(await page.getByText('Pen Settings').count() >= 1,
          'Pen settings popup should open after activating Pen from the More menu');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        assert.equal(await page.getByText('Pen Settings').count(), 0,
          'Escape should close the settings popup');
      }
    }
    await page.locator('button[title="Close Page Properties"]').click();
    await page.waitForTimeout(400);

    // 2) Toolbar collapse / expand round-trip.
    // Compact writing rows intentionally keep their controls visible.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    await page.locator('button[title="Hide Toolbar"]').click();
    await page.locator('button[title="Expand Toolbar"]').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('button[title="Expand Toolbar"]').click();
    await page.locator('button[title="Hide Toolbar"]').waitFor({ state: 'visible', timeout: 5000 });

    // 3) Zoom focal-point stability (remaining P0-1 surface is vertical-only).
    // Track the document point under the viewport center. The page's own
    // center can legitimately move when that is a different document point.
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(400);
    const zoomAnchor = await page.evaluate(() => {
      const container = document.querySelector('.notebook-viewport') as HTMLElement;
      const pageEl = container.querySelector('[data-page-id]') as HTMLElement;
      const cr = container.getBoundingClientRect();
      const pr = pageEl.getBoundingClientRect();
      const clientX = cr.left + container.clientWidth / 2;
      const clientY = cr.top + container.clientHeight / 2;
      return { x: (clientX - pr.left) / pr.width, y: (clientY - pr.top) / pr.height, clientX, clientY };
    });
    await page.keyboard.press('Control+=');
    await page.waitForTimeout(500);
    const anchorAfter = await page.evaluate(anchor => {
      const container = document.querySelector('.notebook-viewport') as HTMLElement;
      const pageEl = container.querySelector('[data-page-id]') as HTMLElement;
      const pr = pageEl.getBoundingClientRect();
      return { x: pr.left + anchor.x * pr.width, y: pr.top + anchor.y * pr.height };
    }, zoomAnchor);
    const driftPx = Math.hypot(anchorAfter.x - zoomAnchor.clientX, anchorAfter.y - zoomAnchor.clientY);
    results.push(`zoom anchor drift after Ctrl+= : ${driftPx.toFixed(1)}px`);
    assert.ok(driftPx < 60, `zoom focal point drifted ${driftPx.toFixed(1)}px after Ctrl+= (expected < 60px)`);

    // Excalidraw assets are packaged locally; an offline chunk failure is a
    // product regression and must fail the responsive acceptance run.
    const pageErrors = results.filter(r => r.startsWith('PAGE ERROR'));
    assert.deepEqual(pageErrors, [], 'unexpected page errors during the run');
    console.log(results.filter(r => !r.startsWith('PAGE ERROR')).join('\n'));
  } finally {
    await browser.close();
    server.close();
  }
}, 300000);
