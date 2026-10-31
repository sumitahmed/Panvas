# Panvas v0.1.14

This is a stability release. It fixes four reported regressions in the notebook workspace and hardens the surrounding select/ink machinery. No new subsystems are introduced; existing handwriting quality, gesture behavior, and Cloud Sync semantics are unchanged.

## Highlights

### 1. Image Move Ghosting Fixed
- **No stale image copy while dragging**: Moving a pasted image previously left a ghost of the image at its original position because the raster canvas and the DOM image overlay double-rendered it and the memoized overlay never re-rendered on in-place position changes. The overlay is now synchronized imperatively during the drag (`previewImageOverlay`/`hideImageOverlay`), committed on drop, and reconciled when the selection clears.
- The overlay element is no longer memoized, so crop, rotation, and opacity changes render immediately.
- Covered by a new browser regression (`tests/image-ghost-browser.mjs`) that moves a real pasted image with pointer events and pixel-probes the old location for blankness.

### 2. Genuine Content-Driven Infinite Page
- **Continuous single document**: Infinite pages no longer behave like stacked A4 sheets. The page grows while you draw toward the bottom — during the live gesture, not only after pen-up — and the raster window follows the viewport into the overhang region instead of being capped at the committed extent.
- **Quarter-A4 trailing margin**: Growth reserves a trailing margin of one quarter of the A4 height below the lowest content, rounded up to 256-px increments, and growth only happens when there is content (scrolling alone no longer stretches the page).
- Covered by a new browser regression (`tests/infinite-page-browser.mjs`) that draws past the previous boundary and asserts the page height expands mid-stroke and commits after pen-up.

### 3. Page Navigation Follows Scroll
- **Tree highlight tracks the visible page**: While scrolling a multi-page notebook — including fast and upward scrolls — the left workspace tree now reliably follows the page currently in view. The passive-activation observer no longer loses navigation commits to a stale in-component page reference (the commit check is made against the store, not the reference the observer just overwrote).
- Covered by an extended browser regression (`tests/page-navigation-browser.mjs`) that scrolls organically through intermediate pages and asserts both the active page commit and the tree highlight, plus `tests/page-reorder-browser.mjs` for drag-reordering with event-geometry drop positions.

### 4. Freeform Lasso Outline Is the Selection
- **The drawn polygon is visible and movable**: Completing a freeform lasso now shows the actual irregular boundary (not a rectangular frame), and dragging inside the enclosed region moves the selection — the rectangular bounding box is no longer the only drag affordance. The outline tracks the live move preview, bakes into the document at commit, and is invalidated when a resize or rotate begins.
- **Optional rectangular lasso**: The toolbar exposes a Freeform/Rectangle toggle for the select tool; Shift constrains rectangular drags to squares.
- Covered by a new browser regression (`tests/freeform-lasso-browser.mjs`) and engine interaction tests covering the outline lifecycle (preview delta, commit bake, resize invalidation).

## Other fixes and improvements in this release

- **Text alignment controls**: Left/center/right/justify buttons added to the text formatting strip, with active-state tracking.
- **Zoom extended to 800%**: Maximum zoom raised from 400% to 800%; canvas backing-scale budgets continue to bound raster detail at high zoom.
- **Aspect-ratio corner resize**: Corner resizing of shapes and images preserves the original aspect ratio.
- **Smoother stylus cursor**: The stylus cursor overlay caches the container rect and refreshes at most once per frame, removing per-event layout thrash at 120–240 Hz pen input.
- **Image/text stacking and paste clarity**: Pasted images render above text; the translucent backdrop blur on pasted notes was removed.
- **Reliable page drag-reorder**: Drop position is computed from event geometry at drop time in both the workspace tree and sidebar thumbnails, fixing silent no-ops on quick drags.
- **Zoom-consistent gesture recognition**: Straight-line, scribble-erase, circle-select, and rough-shape gestures normalize screen scale before recognition, so results no longer depend on zoom level.
- **Incremental ink filter checkpointing**: Out-of-order stylus sample recovery now uses bounded checkpoints in the input filter and centerline builder instead of full refilters.

## Verification

- `npm run typecheck`, `npm test` (729 tests, 1 pre-existing skip), `npm run test:release-units`, `npm run check:release`, and `npm audit --omit=dev --audit-level=moderate` pass.
- The four focused browser regressions (image ghost, infinite page, page navigation, freeform lasso) pass against the real component tree with real pointer input.
- Ink quality harness (11 phases, Chromium and Electron) and notebook navigation/responsive/performance suites pass.

## Notes & Limitations

- Windows installer and portable executables are unsigned open-source binaries and may trigger Windows SmartScreen. Verify the published SHA-256 manifest before running them.
- Existing storage and application data are preserved across upgrades.
