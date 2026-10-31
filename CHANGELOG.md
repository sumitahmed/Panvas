# Changelog

All notable Panvas changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.14] - 2026-10-31

- Fixed image move ghosting: moving a pasted image now previews imperatively through the DOM overlay and commits on drop, leaving no stale copy at the original position.
- Fixed infinite pages to behave as one continuous, content-driven document: the page grows during the live stroke toward the content bottom plus a quarter-A4 trailing margin, with a viewport-following raster overhang window instead of repeated A4 sheets.
- Fixed page navigation while scrolling: the workspace tree now follows the visible page through fast and upward scrolls (passive activation commits against the store instead of a stale in-component reference).
- Fixed freeform lasso selection: the drawn polygon is the visible, movable boundary, dragging inside the region moves the selection, and a rectangular lasso is available as a toolbar option.
- Added text alignment controls (left/center/right/justify) to the text formatting strip.
- Raised maximum zoom from 400% to 800% with canvas backing-scale budgets intact, and added aspect-ratio-preserving corner resize for shapes and images.
- Smoothed the stylus cursor overlay by caching the container rect at most once per frame (removes per-event layout thrash at 120–240 Hz).
- Pasted images render above text and pasted notes no longer apply a backdrop blur.
- Fixed silent page drag-reorder no-ops on quick drags by computing drop position from event geometry.
- Made straight-line, scribble-erase, circle-select, and rough-shape gestures zoom-consistent via screen-scale normalization, and added bounded incremental checkpoints for out-of-order stylus sample recovery.

## [0.1.13] - 2026-10-29

- Fluid live handwriting: enabled immediate synchronous inking for solid pen strokes, eliminated synchronous style queries on pen down, and extended buffer retention across pauses to eliminate GC churn.
- Fixed intermittent frame drop and stroke jitter during active handwriting: introduced sub-millisecond memoized canonical JSON hashing with StrokePoint fast paths (from ~198ms to 0.03ms), eliminated spurious React re-renders on save cycles, deferred external state updates during active stylus contact, and added event-loop yielding in background cloud sync scans.
- Fixed Select tool geometry distortion and stretching during drag transforms on dense notebook pages.
- Fixed Cloud Sync "Use this device" conflict resolution failure, ensuring unresolved conflicts cleanly complete and review state dismisses.
- Maintained smooth dense multi-page scrolling and high-fidelity handwriting input across 60Hz and 120Hz displays.

## [0.1.12] - 2026-10-28

- Optimized Select tool and transform manipulation on dense notebook pages (2,000+ strokes), replacing per-frame geometry re-extrusion with GPU affine transforms on pre-compiled Path2D and backing-canvas damage caching (<1.8ms frames under 4× CPU throttling).
- Optimized vertical page-boundary scroll performance by bypassing scene serialization on unmutated pages and eliminating redundant canvas redraws in NotebookEngine.
- Added O(1) stroke lookup and cached AABB bounding-box spatial rejection for hit-testing, handles, and lasso loop selection.
- Unified Cloud Sync Status UI across StatusBar, SyncIndicator, and Settings to reflect Google Drive V2 status when legacy sync is disabled.
- Ensured Cloud Sync initialization and network connectivity event listeners run properly under the V2 feature gate.
- Resolved browser Google Drive sign-in issues by guaranteeing production Web Client ID fallback in web builds and CI.
- Safely captured and propagated Google Identity Services (GIS) token and popup diagnostics while redacting sensitive tokens.
- Persistent error presentation in Cloud Sync panel without leaking internal diagnostics or secrets.

## [0.1.11] - 2026-10-28

- Fixed text formatting and styling on Date and Mood template placeholder fields, supporting bold, italic, font styling, color, and undo/redo.
- Added persistent page bookmarks for notebook pages and PDF documents, with navigation indicators in the sidebar and thumbnail views.
- Added laser pointer duration (500ms–10,000ms) and inter-stroke trail connectivity controls.
- Restored authentic tool cursor designs (pen, pencil, highlighter, marker, eraser) for stylus/pen input with immediate tracking.
- Optimized multi-element selection transforms (translation, scaling, rotation) for smooth frame rendering on large stroke sets.
- Improved middle-mouse auto-scroll directional feedback and responsiveness.
- Patched production dependencies dompurify (3.4.17) and zod (4.6.7).

## [0.1.10] - 2026-10-28

- Fixed text formatting and styling on Date and Mood template placeholder fields, supporting bold, italic, font styling, color, and undo/redo.
- Added persistent page bookmarks for notebook pages and PDF documents, with navigation indicators in the sidebar and thumbnail views.
- Added laser pointer duration (500ms–10,000ms) and inter-stroke trail connectivity controls.
- Restored authentic tool cursor designs (pen, pencil, highlighter, marker, eraser) for stylus/pen input with immediate tracking.
- Optimized multi-element selection transforms (translation, scaling, rotation) for smooth frame rendering on large stroke sets.
- Improved middle-mouse auto-scroll directional feedback and responsiveness.

## [0.1.9] - 2026-10-17

- Fixed drawing and laser-pointer lag on populated notebook pages.
- Fixed mobile viewport jitter and zoom-related instability.
- Improved canvas rendering, navigation, and memory management.
- Reduced unnecessary redraws and improved interaction responsiveness.

## [0.1.8] - 2026-10-17

Documentation editor, notebook performance and release infrastructure updates.

### Added

- Technical document flow with automatic A4 continuation, math, tables, code controls and persistent text-highlighter gestures.
- Rolling six-color highlight palette, portable media backups and expanded Chromium/Electron regression coverage.
- Docker production/development web workflows, CI build/package checks and a manual future publication workflow.

### Fixed

- Formatting selection/background normalization and rich-document PDF rendering from the current stabilization work.
- Shared desktop media remains readable from previous roots after changing the storage folder; no relocation is performed.
- Settings counts/provider/version reporting, populated-page rendering costs and drawing serialization paths.
- Stale native output cleanup and package/bundle auditing, including imported Electron implementation chunks.
- Packaged desktop startup ignores inherited development-server URLs instead of redirecting to a development host.

### Known limitations

- Windows x64 binaries are unsigned. Live provider acceptance and isolated installer behavior are reported separately from automated checks. See [release notes](docs/RELEASE_NOTES_v0.1.8.md).

## [0.1.1] - 2026-09-16

Production hotfix restoring Ink mode aesthetic fidelity and adding compact navigation page and section management.

### Fixed

- **Ink Mode Visual Contrast**: Restored warm, slightly desaturated appearance (`#F7F4EB` / `247 244 235`) for Ink mode by resetting `:root` Light mode tokens back to neutral white (`#FFFFFF`). Ink mode now has its intended distinct warm-paper look while Light mode remains crisp white.
- **User Content Preservation**: Verified complete isolation of canvas handwriting strokes, highlighter lines, pen swatches, page templates (such as yellow legal pad and dark paper), PDF annotations, and images from UI theme variables.

### Added

- **Compact Navigation Management**: When the 3-column navigation panel is collapsed, the top breadcrumb dropdowns for sections and pages now provide full management capabilities:
  - Inline renaming with Enter to commit, Escape to cancel, and dedicated save/cancel buttons.
  - Context action menus (`...`) with Rename, Move Up, Move Down, and Delete actions.
  - Direct "+ Add Page" and "+ Add Section" actions in dropdown headers.
  - Real-time synchronization with workspace persistence without page reload, entity ID regeneration, or data loss.

## [0.1.0] - 2026-09-14

Initial public release of the local-first visual workspace.

### Added

- Workspace, folder, notebook, section, and page hierarchy.
- Vector notebook ink with pressure-aware input, smoothing, erasing, ruler tools, paper templates, layers, sticky notes, images, and voice notes.
- Rich-text editing and local search.
- PDF import, viewing, vector annotation, and annotated-PDF export.
- Excalidraw-powered visual canvases with Panvas content blocks.
- Trash and restore flows plus workspace backup export/import.
- Windows Electron distribution and a browser build backed by local storage.
- Electron filesystem persistence with queued atomic writes and recovery data.

### Changed

- v0.1.0 is the first public release. There are no earlier public release entries in this repository.

### Security

- Electron renderer isolation and validated preload/IPC boundaries are enabled in the current build.
- Release assets are accompanied by a SHA-256 manifest when published.

### Known limitations

- The Windows installer is unsigned and may trigger SmartScreen.
- Browser storage is subject to browser/device quotas and clearing policies.
- Handwriting recognition depends on a platform-native or browser-native provider; the experimental local neural fallback is disabled.
- Cloud Sync is release-gated and disabled by default.
- See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for the current list.
