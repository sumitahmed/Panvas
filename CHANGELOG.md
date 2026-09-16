# Changelog

All notable Panvas changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and versions follow [Semantic Versioning](https://semver.org/).

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
