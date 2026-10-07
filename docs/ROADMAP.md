# Panvas roadmap

This roadmap describes direction, not commitments. It contains no promised dates. A feature is current only when it is present in the source and covered by the release documentation.

## v0.1.x - Current

The current release focuses on a useful local workspace:

- workspace, folder, notebook, section, and page organization;
- vector notebook ink, page appearance controls, rich text, sticky notes, layers, images, voice notes, and local search;
- PDF viewing, annotation, and export;
- Excalidraw-based visual canvases and Panvas custom blocks;
- desktop filesystem persistence with queued writes and recovery data;
- browser-local storage and a web build;
- trash, restore, and workspace backup flows.

Google Drive sync is an optional configured integration. Local editing does not require a provider account.

## v0.1.x - Maintenance

Near-term work should improve the release without changing its core data contract:

- bug fixes and regression coverage;
- accessibility and keyboard navigation;
- clearer empty states, tooltips, and responsive behavior;
- PDF, canvas, import/export, and browser-compatibility polish;
- documentation, localization groundwork, and packaging/signing improvements;
- profiling and targeted performance fixes backed by measurements.

## Future proposals

These are ideas for later design and review, not scheduled releases:

- broader and easier-to-operate Cloud Sync;
- richer knowledge-canvas workflows and cross-document references;
- extensibility or plugin surfaces;
- improved handwriting recognition and optional on-device intelligence;
- additional platform targets.

Future work must preserve local ownership, explicit migration paths, and the Electron security boundary. See [docs/CONTRIBUTOR_ROADMAP.md](CONTRIBUTOR_ROADMAP.md) for contribution-sized areas.
