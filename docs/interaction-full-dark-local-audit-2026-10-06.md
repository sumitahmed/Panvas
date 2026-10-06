# Panvas interaction and Full Dark View local audit — 2026-10-06

All four requested corrections are implemented locally. Release actions remain gated on the user's browser and Electron manual verification.

## Existing local patch

The initial working tree was captured in `C:\Users\sksum\AppData\Local\Temp\panvas-ux-local-baseline-F6fWRI` before this pass. Branch `main`, HEAD `1c82b708c216f4558ccf976331cee4d336abf4ad`, and version `0.1.4` remain unchanged.

Nine of the sixteen prior patch files remain byte-identical: the previous audit, document cursor helper, PDF zoom hook, original interaction/profiling runners, fixture HTML, WetInkSurface, touch viewport gesture helper, and Electron pipeline test. The other seven received incremental additions for this request. The prior wet-buffer reuse, committed-preview optimization, stable PDF engine ownership, debounced raster replacement, cursor behavior, and native PDF Hand scrolling remain in place. No reset, revert, stash overwrite, or patch replacement was used.

The prior audit remains at [handwriting-pdf-local-audit-2026-10-05.md](handwriting-pdf-local-audit-2026-10-05.md). The preservation comparison is [previous-patch-preservation.json](../artifacts/interaction-ux/previous-patch-preservation.json).

## PDF Research Space

The remaining failure was pointer hit ownership. Before the fix, the right Page Utilities wrapper was a stretched, full-height flex item with `pointer-events-auto`. Its visually empty lower portion intercepted fresh pointerdowns over the outer right Research Space. Canvas, wrapper, and engine dimensions already represented the full sheet.

A stroke begun on the canvas had pointer capture, so held movement continued through the same region. A lifted pointer's next down used hit testing and landed on the utility wrapper instead. Adding `self-start` confines that wrapper to its visible controls; no geometry offsets or transparent overlays were added.

The test PDF source is 595×842. Both runtimes used actual native Chromium mouse/pen dispatch, checked `elementFromPoint`, confirmed a new retained stroke, and measured the following canonical coordinates at all four rotations:

| Research extent on each side | Horizontal fresh starts at y=250 | Top/bottom starts at x=100 | Unrotated logical sheet |
| --- | --- | --- | --- |
| 40 | -35, 585, 605, 630 | -35, 877 | 675×922 |
| 140 | -135, 585, 605, 635, 665, 695, 725, 730 | -135, 977 | 875×1122 |
| 300 | -295, 585, 605, 635, 665, 695, 725, 890 | -295, 1137 | 1195×1442 |

Each runtime passed 208 fresh mouse/pen starts, 24 held source-to-right crossings, and 12 additional fresh visual-right-edge starts beneath the utilities. Canonical start error stayed below 1 px; canvas and wrapper bounds agreed within 0.1 px; logical engine dimensions matched the input canvas. Rotations 0/90/180/270 are included. The full measurements are in [web results](../artifacts/interaction-ux/regressions-web.json) and [Electron results](../artifacts/interaction-ux/regressions-electron.json).

## Full Dark View

Standard Dark retains the original document appearance. Full Dark View is a separate local preference effective only while the application theme is Dark.

Deliberately entering Dark from Light or Ink opens the existing small confirmation dialog: “Enable Full Dark View?”, with the requested explanatory copy and `Full Dark View` / `Standard Dark` actions. Choosing either stores the latest boolean under `panvas-full-dark-view`. Startup, document opening, route changes, and ordinary renders do not reopen the prompt. Settings → Appearance exposes a `Full Dark View` switch while Dark is selected.

Bright notebook paper and Research Space receive a transient dark surface color. Rule lines become restrained; dark ink and rich text become readable while red, blue, orange, and green retain their hue. Colored Sticky Notes are muted rather than replaced with black. Text presentation uses a scoped stylesheet outside TipTap's author document. Normal notebook images are preserved.

Only bright PDF raster canvases receive `invert(0.9) hue-rotate(180deg) brightness(0.9)`. A small 12×12 median brightness sample avoids inverting already-dark pages. The annotation layer, chrome, and normal notebook images are not filtered. The PDF raster itself and original bytes remain unchanged. This intentionally simple page-level rule can also transform photographs embedded inside a bright PDF raster; it does not identify regions within PDF artwork.

Turning Full Dark off restores original presentation. Light and Ink disable its visual effect while retaining the latest local choice. Print lifecycle handling temporarily restores original presentation, then restores the viewing preference. PDF export continues to render original stored properties and colors.

Verified: no stored page, rule, ink, rich-text, shape, Sticky Note, image, template, or annotation colors were rewritten by the preference. PDF byte hashes remained identical, notebook image pixels matched, and exported PDF paint remained original. No export service, storage schema, migration, backend, or Dark Reader dependency was added.

Screenshots: [notebook](../artifacts/interaction-ux/full-dark-notebook-web.png), [PDF and Research Space](../artifacts/interaction-ux/full-dark-pdf-web.png), [Electron notebook](../artifacts/interaction-ux/full-dark-notebook-electron.png).

## Toolbar

The full row is Undo, Redo, handwriting conversion, Pen, Highlighter, Marker, Eraser, Text, Select, Hand, More. Pencil is in More and retains settings, shortcut N, drawing behavior, and understandable active state. Hand appears beside Select where the responsive contract permits it, without another Hand in overflow.

The deterministic primary group now contains five writing controls and has its corresponding width updated. Pencil has a separate overflow group. Compact writing rows and fullscreen fallback preserve reachability. Notebook and PDF checks include widths 1280/900/680/620/480/360; the production resize sweep covers 20 windows from 400 to 1920 pixels.

The production sweep also exposed a compact-header Page Properties overlap: the tablet CSS's `inset:auto` cancelled the existing `right-72` reservation. The header now reserves the already-defined drawer width through its margin in compact layouts. The drawer, controls, and toolbar clearance check passes.

## Sticky Notes

The double-selection appearance came from both SelectionEngine's generic canvas box and FloatingTextEditor's own DOM handles. Single Sticky Notes keep logical selection ownership while using only the DOM handles. Multi-selection retains generic group bounds and suppresses individual handles.

The resize floor is now 32×32 rather than 140×100. The 32 px edge keeps three 12 px handle targets from overlapping. Long TipTap content does not enlarge a deliberately small Sticky Note. Creation presets and default initial size remain intact.

Rectangle and Oval resize independently; Square and Circle enforce equal dimensions. Selecting Square/Circle fits the smaller existing edge instead of growing the larger one. Rounded and Star retain their independent bounds. Native resize is checked at every PDF rotation.

The color/custom/opacity palette measures 176×112 CSS pixels; the shape palette measures 122×46. They use the existing OverlayManager portal, remain independent of document zoom, and stay within window edges. All distinct preset colors remain; duplicate aliases no longer occupy repeated swatches. Color targets remain 28×28.

Multi-selection testing exposed two related existing issues: quick clicks on different objects could be treated as a double-click, and deleted text objects were absent from history restoration. The double-click gate now requires the same pointer type and nearby position and excludes Shift/multi-selection; deleted text is restored alongside existing shape/image history behavior. Real single-note double-click editing still works.

Verified: resize undo/redo, 32×32 save/reload, color/custom color, opacity, all shapes, multi-selection/group drag, lasso, copy/paste, duplicate, delete undo/redo, long text, and unchanged Local Elements presets.

Screenshots: [color at 1×](../artifacts/interaction-ux/sticky-color-1-web.png), [shape at 2.5×](../artifacts/interaction-ux/sticky-shape-2.5-web.png), [Electron color at 2.5×](../artifacts/interaction-ux/sticky-color-2.5-electron.png).

## Tests

These are fresh local results. Overlapping suites are listed separately, not added into one total.

| Check | Final result |
| --- | --- |
| Nine focused PDF/input suites | 150 passed, 0 failed, 0 skipped |
| Seven focused theme/Sticky/Local Elements/toolbar suites | 77 passed, 0 failed, 0 skipped |
| Ink compact-navigation contract suite | 22 passed, 0 failed, 0 skipped |
| `npm run test:interaction-ux` | 46 unit tests + 23 browser groups + 23 Electron groups passed; 0 failed, 0 runtime errors |
| `npm run typecheck` | Passed; also repeated by both builds |
| `npm run test:editor-regressions` | 74 passed, 1 existing skip; 14 fonts and 25 browser page workflows passed |
| `npm run test:notebook-navigation` | 18 unit tests + 29 browser groups passed |
| `npm run test:notebook-responsive` | 10 unit tests + 33 browser groups passed; repeated after compact-header correction |
| `npm run test:notebook-performance` | 12 unit tests + 3 runtime profiles passed |
| `npm run test:document-input` | 16 browser + 16 Windows Electron groups passed |
| `npm run test:handwriting-placement` | 9 unit tests + 42 browser + 42 Electron geometry scenarios passed |
| `npm run test:resize` | 1 production-build regression passed: 20 widths, overflow reachability, drawer clearance, popup behavior, collapse/expand, and keyboard zoom |
| `npm test`, including pretest | 888 tests: 887 passed, 1 existing skip, 0 failed; repeated after the compact-header correction |
| Isolated production Electron PDF pipeline | 1 passed, 0 failed: preload boundary, native chrome/scale, filesystem persistence, restart, and temporary-profile IndexedDB loss |
| `npm run build` | Passed after the compact-header correction |
| `npm run build:web` | Passed |
| `git diff --check` | Passed |

The initial full unit run failed one old source assertion that assumed paper colors could never have a viewing transform. It now verifies that Light/Ink use original colors and only the separate Dark preference can adapt presentation. The new Electron harness was corrected to use versioned PDF page state, unique temporary workspace names across reload, and production-style native title-bar overlay. The old resize harness was updated for automatic first-page creation, the existing compact/mobile rows, the current Shapes-family button, current left navigation controls, and measuring the document point under the zoom anchor. These corrections did not relax product reachability or geometry checks. Final runs passed.

The resize suite's existing notebook keyboard-zoom threshold is 60 px; its measured anchor drift was 31.7 px. The separate PDF profiler measured maximum X/Y drift of 1.14/0.97 px in Chromium and 0.66/1.10 px in Electron across 24 zoom events. Both had zero PDF engine remounts, raster starts/cancellations, or drawing redraws during that zoom workload. Eight Electron ink bursts produced 968 live requests, 248 wet paints, four canvas dimension writes, and eight scene snapshots. The earlier web probe counted 36 canvas dimension writes while other acceptance work was active; this all-canvas counter is recorded, not presented as a quiet allocation benchmark.

Non-failing Vite warnings concern the existing pdf.js dynamic worker import and large application chunks.

## Browser and Electron verification limits

Chromium and Windows Electron exercised real application components with native CDP mouse/pen dispatch and isolated workspaces. Native pen dispatch validates trusted Chromium pointer routing and pressure handling, not a physical Windows Ink digitizer or its driver. Hardware pen hover/barrel/eraser behavior remains for the user's manual check.

Browser copy/paste uses the browser clipboard permission. Electron copy/paste tests the real selection serialization with an isolated in-memory clipboard adapter to avoid changing the Windows clipboard; system clipboard integration remains manual.

The production Electron test redirected USERPROFILE, APPDATA, userData, and workspace root into a temporary directory. Its IndexedDB clearing affected only that temporary profile. The original pipeline PDF and tracked screenshot were restored byte-for-byte after the test. User workspaces/profiles and the installed Panvas application were not reset or deleted.

## Files changed

This lists the entire local patch, including retained files from the previous pass.

- `package.json`
- `src/components/layout/AppShell.tsx`
- `src/components/notebook/FloatingTextEditor.tsx`
- `src/components/notebook/InactivePagePreview.tsx`
- `src/components/notebook/NotebookFloatingToolbar.tsx`
- `src/components/notebook/NotebookPageView.tsx`
- `src/components/notebook/NotebookRenderer.tsx`
- `src/components/notebook/PageRenderer.tsx`
- `src/components/notebook/StaticTextPreview.tsx`
- `src/components/notebook/documentToolCursor.ts`
- `src/components/notebook/stickyNotes.ts`
- `src/components/notebook/toolbarLayout.ts`
- `src/components/notebook/useDocumentTextPresentation.ts`
- `src/components/notebook/engine/DrawingEngine.ts`
- `src/components/notebook/engine/InputManager.ts`
- `src/components/notebook/engine/SelectionEngine.ts`
- `src/components/notebook/engine/ShapeManager.ts`
- `src/components/notebook/engine/WetInkSurface.ts`
- `src/components/notebook/engine/touchViewportGesture.ts`
- `src/components/pdf/PdfPageRenderer.tsx`
- `src/components/pdf/PdfWorkspace.tsx`
- `src/components/pdf/usePdfViewportZoom.ts`
- `src/components/settings/sections/AppearanceSection.tsx`
- `src/hooks/useFullDarkView.ts`
- `src/lib/fullDarkView.ts`
- `src/lib/theme.ts`
- `src/stores/uiStore.ts`
- `src/styles/index.css`
- `tests/document-input-browser.mjs`
- `tests/document-input-profile.mjs`
- `tests/eink-theme.test.ts`
- `tests/electron-pipeline.test.ts`
- `tests/full-dark-view.test.ts`
- `tests/ink-mode-compact-navigation.test.ts`
- `tests/interaction-ux-browser.mjs`
- `tests/sticky-notes-runtime.test.ts`
- `tests/toolbar-layout.test.ts`
- `tests/toolbar-resize.test.ts`
- `tests/fixtures/document-input.html`
- `tests/fixtures/document-input.tsx`
- `docs/handwriting-pdf-local-audit-2026-10-05.md`
- `docs/interaction-full-dark-local-audit-2026-10-06.md`

Temporary QA helpers/logs and screenshots/measurement artifacts are ignored by Git. No landing-page, Cloud Sync, Drive, persistence-schema, dependency-lock, or release file was changed.

## Manual test instructions

From the repository, start browser mode:

```powershell
npm run dev:web -- --host 127.0.0.1 --port 3011 --strictPort
```

Open `http://127.0.0.1:3011/#/app`. For the local Electron build, quit any installed Panvas normally first so its single-instance lock does not redirect the launch, then run:

```powershell
npm start
```

1. PDF: set Left/Right Research Space to 140. With mouse and a physical Windows Ink pen, lift between separate strokes across the entire right strip, including its outer edge beneath Page Utilities. Compare with a held stroke from the PDF into the strip. Repeat at 40/300 and 0/90/180/270°; check cursor, erasing, zoom, and save/reopen.
2. Full Dark: enter Dark from both Light and Ink. Try Standard Dark, then Full Dark View. Check white/yellow/green/blue/black/custom pages, bright and already-dark PDFs, Research Space, colored pens/highlighter, Sticky Notes, rich text, and a photograph. Toggle Settings → Appearance → Full Dark View off/on; original appearance should return. Verify PDF export and print retain original colors. Restart/open another document: no unsolicited prompt.
3. Toolbar: check Pencil in More, shortcut N and Pencil settings/drawing, Select/Hand adjacency when room permits, narrow windows, and Full Page View. Open Page Properties in a compact window and confirm controls stay clear of the drawer.
4. Sticky: select one note, resize tiny/wide/tall, add long text, change every shape, and inspect palettes at different zooms/window edges. Check Shift multi-selection, group drag, lasso, system clipboard copy/paste, duplicate/delete undo/redo, Local Elements presets, and save/reload of size/color/opacity/shape/text.

## Status

LOCAL ONLY / NOT PUSHED / NOT DEPLOYED / NO VERSION BUMP / NO NEW EXE / NO GITHUB RELEASE / LANDING PAGE UNCHANGED / WAITING FOR USER MANUAL VERIFICATION
