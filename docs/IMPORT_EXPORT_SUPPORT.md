# Import and export support

This page describes the current import/export surface. It is deliberately explicit about fidelity: exports report approximated or unsupported objects instead of silently claiming a perfect copy.

## PDF import

- Local `.pdf` files can be imported into a notebook section.
- The current validation limit is 200 MB. Empty, corrupt, encrypted, zero-page, and unsupported files are rejected before a page record is created.
- Imported bytes remain local. Electron uses its filesystem-backed asset store with the browser database as a compatibility path; web mode uses origin-scoped IndexedDB.

## Annotated PDF export

- The dedicated PDF workspace exports a new PDF and leaves the imported source bytes unchanged.
- Vector strokes and supported shape, text, image, and annotation objects are rendered onto their source pages. Unsupported or unavailable objects are counted and reported in the export result.
- Exported output may approximate rich-text layout, fonts, or other objects that do not have a direct PDF representation. Review the warning shown by Panvas after export.

## Notebook export and print

- Notebook, section, and page export commands generate PDFs from page content and drawings.
- Imported PDF pages are handled by the annotated-PDF export path and may be skipped by a standard notebook export; Panvas reports that condition.
- Printing uses the generated PDF surface. Electron uses its native print lifecycle; browser mode opens a print target and does not print the live workspace DOM.

## Backup and search

- Workspace backup export/import is the portable recovery path for local data.
- Local search indexes titles, metadata, persisted page content, drawing text, canvas block text, and extractable PDF text. The index is a rebuildable derivative, not the source of truth.

See [STORAGE_AND_PERSISTENCE.md](STORAGE_AND_PERSISTENCE.md) for asset durability and [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md) for large-document constraints.
