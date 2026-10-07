import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolveTwoFingerViewport } from '../src/components/notebook/engine/touchViewportGesture.ts';

function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

test('Library exposes Recent/Favorites/Trash below lg and keeps the grid/list preference for >=600px', async () => {
  const source = await read('../src/components/library/LibraryWorkspace.tsx');
  // The compact switcher is hidden at >=lg where the real navigator aside shows.
  assert.match(source, /lg:hidden/);
  assert.match(source, /selectView\(item\.id\)/);
  for (const view of ['recent', 'favorites', 'library', 'trash']) {
    assert.match(source, new RegExp(`\\{ id: '${view}', label:`));
  }
  // Presentation-only fallback: phones render the card grid, preference untouched.
  assert.match(source, /isMobileViewport \? 'grid' : viewMode/);
  assert.match(source, /effectiveViewMode === 'grid'/);
});

test('mobile shell sidebar overlays content and closes on navigation and Escape', async () => {
  const shell = await read('../src/components/layout/AppShell.tsx');
  assert.match(shell, /max-\[599px\]:absolute/);
  assert.match(shell, /aria-label="Close library sidebar"/);
  assert.match(shell, /event\.key !== 'Escape'/);
  assert.match(shell, /lastDismissSignalRef/);
  assert.match(shell, /enteredMobileViewportRef/);
  assert.match(shell, /if \(open\) toggleSidebar\(\)/);
  assert.match(shell, /max-\[1023px\]:max-w-\[14rem\]/);
  assert.match(shell, /flex-1 flex overflow-hidden relative/);
});

test('phone and landscape More menus and drawing popups stay inside the viewport', async () => {
  const toolbar = await read('../src/components/notebook/NotebookFloatingToolbar.tsx');
  assert.match(toolbar, /max-\[1023px\]:w-\[min\(20rem,calc\(100vw-1\.5rem\)\)\]/);
  assert.match(toolbar, /panvas-more-menu/);
  const styles = await read('../src/styles/index.css');
  assert.match(styles, /\.panvas-more-menu \{ max-height: inherit; overflow-y: auto; overscroll-behavior: contain;/);
  assert.match(toolbar, /max-\[1023px\]:flex-wrap/);
});

test('H→Text strip leads with color/thickness on phones and moves text settings into a popover', async () => {
  const toolbar = await read('../src/components/notebook/NotebookFloatingToolbar.tsx');
  const mobileBranchStart = toolbar.indexOf('if (isMobileViewport)');
  assert.ok(mobileBranchStart > -1, 'HandwritingSettingsStrip must have a mobile presentation branch');
  const mobileBranch = toolbar.slice(mobileBranchStart, mobileBranchStart + 3_500);
  const presetIndex = mobileBranch.indexOf('{presetControls}');
  const popoverIndex = mobileBranch.indexOf('<OverlayManager');
  assert.ok(presetIndex > -1, 'color/thickness/palette controls lead the mobile strip');
  assert.ok(popoverIndex > presetIndex, 'text output settings popover follows the color/thickness controls');
  assert.match(mobileBranch, /Text output settings/);
});

test('Page & View renders as a viewport-level bottom sheet on phones without reserving chrome width', async () => {
  const panel = await read('../src/components/notebook/NotebookToolPropertiesPanel.tsx');
  assert.match(panel, /max-\[599px\]:fixed/);
  assert.match(panel, /max-\[599px\]:bottom-0/);
  assert.match(panel, /max-\[599px\]:max-h-\[70vh\]/);
  assert.match(panel, /max-\[599px\]:rounded-t-2xl/);

  const renderer = await read('../src/components/notebook/NotebookRenderer.tsx');
  assert.match(renderer, /!isMobileViewport \? 288 : 0/);
  assert.match(renderer, /max-\[599px\]:right-0/);
  assert.match(renderer, /if \(isMobileViewport\) return;/);

  const styles = await read('../src/styles/index.css');
  assert.match(styles, /@media \(max-width: 599px\)/);
  assert.match(styles, /safe-area-inset-bottom/);
});

test('Canvas toolbar never extends beyond a phone viewport and keeps its menus inside it', async () => {
  const source = await read('../src/components/canvas/CanvasToolbar.tsx');
  assert.match(source, /max-\[599px\]:max-w-\[calc\(100vw-1rem\)\]/);
  assert.match(source, /max-\[599px\]:overflow-x-auto/);
  assert.match(source, /max-\[599px\]:w-\[min\(16rem,calc\(100vw-1\.5rem\)\)\]/);
  assert.match(source, /max-\[599px\]:w-\[min\(18rem,calc\(100vw-1\.5rem\)\)\]/);
});

test('phone toolbar chrome is visually compact while keeping reachable touch targets', async () => {
  const toolbar = await read('../src/components/notebook/NotebookFloatingToolbar.tsx');
  // Primary toolbar: 36px buttons/More, tighter gaps, padding, dividers.
  assert.match(toolbar, /max-\[599px\]:h-9 max-\[599px\]:w-9 max-\[599px\]:rounded-lg/);
  assert.match(toolbar, /max-\[599px\]:gap-0\.5/);
  assert.match(toolbar, /px-3 py-2 max-\[599px\]:px-1\.5 max-\[599px\]:py-1/);
  assert.match(toolbar, /max-\[599px\]:h-4 max-\[599px\]:mx-0\.5/);
  // Pen/Pencil/H→Text contextual strips: 36px tall, tighter padding.
  assert.match(toolbar, /h-10 shrink-0 items-center gap-1 px-2 max-\[599px\]:h-9 max-\[599px\]:gap-0\.5 max-\[599px\]:px-1\.5/);
  assert.match(toolbar, /panvas-floating-surface flex min-h-9 max-w-full flex-wrap items-center gap-0\.5 px-1\.5/);
  // Colors, palette, and thickness stay reachable on phones.
  assert.match(toolbar, /recentColors\.slice\(0, 5\)/);
  assert.match(toolbar, /role="group" aria-label=\{`\$\{label\} thickness`\}/);

  const controls = await read('../src/components/notebook/NotebookWorkspaceControls.tsx');
  assert.match(controls, /max-\[599px\]:gap-1/);
  assert.match(controls, /p-1\.5 max-\[599px\]:p-1/);

  const styles = await read('../src/styles/index.css');
  assert.match(styles, /border-radius: 0\.75rem;\s*\n\s*box-shadow: 0 6px 18px/);
});

test('Document mode is a compact segmented control with selected pill and focus ring', async () => {
  const source = await read('../src/components/workspace/WorkspaceViewControls.tsx');
  assert.match(source, /grid grid-cols-3 gap-1 rounded-lg border/);
  assert.match(source, /bg-panvas-bg-active font-medium shadow-sm/);
  assert.match(source, /hover:bg-panvas-bg-hover/);
  assert.match(source, /focus-ring/);
  // Edit/Read/Present behavior and semantics unchanged: same three toggles,
  // same aria-pressed selected state.
  assert.match(source, /aria-pressed=\{active\}/);
  for (const mode of ['Edit', 'Read', 'Present']) {
    assert.match(source, new RegExp(`label="${mode}"`));
  }
});

test('two-finger gestures keep their document anchor while pinching and panning', () => {
  const anchor = { distance: 100, scale: 1, documentX: 210, documentY: 420 };
  const pinched = resolveTwoFingerViewport({
    anchor,
    currentDistance: 200,
    currentCenter: { x: 160, y: 220 },
    bounds: { left: 10, top: 20 },
  });
  assert.deepEqual(pinched, { scale: 2, scrollLeft: 270, scrollTop: 640 });

  const panned = resolveTwoFingerViewport({
    anchor,
    currentDistance: 100,
    currentCenter: { x: 130, y: 230 },
    bounds: { left: 10, top: 20 },
  });
  assert.deepEqual(panned, { scale: 1, scrollLeft: 90, scrollTop: 210 });
});

test('notebook and PDF surfaces promote a second finger to the shared viewport gesture', async () => {
  const notebook = await read('../src/components/notebook/NotebookRenderer.tsx');
  const pdf = await read('../src/components/pdf/PdfWorkspace.tsx');
  const input = await read('../src/components/notebook/engine/InputManager.ts');
  for (const source of [notebook, pdf]) {
    assert.match(source, /attachTwoFingerViewportGesture/);
    assert.match(source, /cancelActivePointerInteraction/);
  }
  assert.match(input, /cancelActivePointerInteraction\(\): void/);
});
