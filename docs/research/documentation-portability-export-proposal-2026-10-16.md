# Documentation portability and PDF: remaining architecture review

This is a proposal, not an implemented backup/PDF feature. The current application still cannot produce an asset-complete backup or export flowing/Infinite documents to PDF. No existing workspace, backup format, or exporter was migrated or replaced during this pass.

The current October 16 brief says: **“Stop for approval before any major storage/compatibility migration.”** The companion brief also says: **“If a checkpoint requires major architectural work, stop and explain the issue rather than expanding scope without review.”** These are the review boundaries used here; routine palette, sidebar, dependency and sync corrections were implemented without additional approval.

## Current evidence

- `backupService.ts` accepts version 1 only. Its portable object contains metadata and JSON payloads, with no separate asset manifest or bytes.
- `backupBrowserStorage.ts` does not export or restore the PDF/image/audio stores. Native `WorkspaceService` likewise exports page/canvas JSON only.
- Restore allocates new page IDs but copies rich JSON unchanged. A `pageReference.targetPageId` and a link containing `panvasPage` still point at the original page in the audited fixture.
- Native restore currently publishes workspace metadata before all page/canvas payloads finish. Adding binary restore requires an explicit validation/staging/publication contract, rather than attaching bytes to that order of operations.
- The current native backup import/IPC limit is 100 MiB. Binary encoding and decoded limits need to be specified together.
- The exporter deliberately rejects any Document or Infinite page. The actual export menu rejection is captured in the UI audit artifacts. Its existing finite renderer flattens complex rich nodes and has no general rich-document layout/font pipeline.
- Small corrections to the existing sync collector and workspace copier have been completed: nested document images are collected; copied structured page targets and internal link parameters are remapped. The sync transport and binary envelope format are unchanged.

Reproduction: `node tests/documentation-portability-audit.mjs`. A nonzero result currently identifies the three remaining backup checks, rather than accepting the missing feature.

## Proposed backup v2 contract

Keep the existing single JSON backup file and add a versioned asset manifest. Keep v1 reading; do not rewrite existing backups or migrate live workspace files.

```ts
interface BackupAsset {
  id: string;
  ownerId: string;
  kind: 'image' | 'pdf' | 'audio';
  fileName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;             // Hash of decoded binary bytes.
  base64: string;
}
// Existing metadata / pagePayloads / canvasPayloads remain canonical JSON.
// header.version becomes 2; assets is keyed by original asset ID.
// Explicit missing-asset entries carry IDs/owners; no false success or fetching URLs.
```

This avoids a new database, archive dependency, or sync service. Base64 increases binary size by about one third; files exceeding the existing import limit must fail explicitly before writing, with a useful size message. Streaming archives would be a separate future format decision, not part of this proposal.

Export should walk supported references in positioned images, rich block/inline images, PDF page sources/annotation records, audio notes, canvas custom blocks and relevant notebook assets. Deduplicate by asset ID, then read bytes through existing repositories/native stores. Include assets referenced by this workspace even when their original owner is elsewhere; do not fetch imported external image URLs. Keep existing inline Excalidraw files in their canonical scene payloads.

Restore should:

1. Validate the whole package, entity ownership, reference IDs, encoded/decoded lengths, MIME/kind and every binary hash before publishing anything.
2. Allocate new workspace, folder, notebook, section, page, canvas, custom-block and asset IDs. Rewrite supported reference fields and internal page-link parameters; preserve prose, external URLs, marks and literal colors. Keep page-scoped document block IDs stable unless their owning copied structure requires remapping, and remap their internal targets consistently.
3. Restore into a new workspace only. Preserve unresolved references from v1 and show a missing-asset warning; never borrow an existing same-ID binary as proof of a successful restore.
4. In browsers, put metadata, page/canvas payloads and asset records in the existing Dexie transaction after preflight integrity checks.
5. In Electron, write into a disposable restore staging area, verify bytes, write new asset IDs through the existing atomic writer, then publish/register the new workspace last. Failure cleanup must target only that restore's new IDs and staging directory. Existing asset files and workspaces must remain untouched.
6. Return an explicit completion/warnings result to the existing backup UI. Keep sync optional, and preserve its existing ownership/account checks.

Files affected: `backupService.ts`, `backupBrowserStorage.ts`, `electron/ipc/WorkspaceService.ts`, native backup validation/IPC/types, the existing backup UI, and a small shared reference/integrity helper. The existing binary repositories remain the storage boundary.

Acceptance must cover browser→browser, Electron→Electron and cross-platform exports restored into independently empty profiles. Compare every binary hash and rich JSON after ID normalization; follow restored page/block links; reopen images/PDF/audio; preserve annotations; test v1, duplicate references, missing assets, corrupt/truncated bytes, oversized payloads, cancellation and failure before publication. Fixture sync acceptance and any real Drive acceptance remain separate.

## PDF approaches compared

| Approach | Strength | Required compromise / architecture cost |
| --- | --- | --- |
| Chromium print layout | Uses the browser's rich text, tables, font shaping and KaTeX layout; Electron can return PDF bytes | A normal browser exposes a print dialog, not a cross-browser direct PDF-byte/download API. It does not satisfy the requested browser download by itself. Annotation composition and mixed notebooks still need work. |
| Shared rich renderer feeding existing `pdf-lib` | Keeps both current browser/Electron download routes and finite-page vector annotation exporter | Requires a new rich layout/rendering pipeline, explicit font/glyph strategy, math/image composition, table/line splitting and continuous-to-sheet projection. This is substantial work even though the PDF writing library stays the same. |
| Per-sheet raster snapshots | Straightforward visual capture and delivery through the existing PDF writer | Text search/selection is lost; large documents produce large images and PDFs. This is not the recommended default and needs an explicit fidelity compromise. |

**Recommended bounded next step:** keep `pdf-lib`, retain the existing finite Freeform path, and build a separate rich-document rendering branch using read-only existing schema views and the existing document geometry. Do not replace the notebook exporter or add an editor framework/server. Start with a representative two-sheet comparison artifact before rolling it out to every layout.

The prototype must settle:

- Searchable text with bold/italic/underline, foreground/highlight colors and links. Determine supported embedded fonts/glyphs explicitly; no silent dropped characters or unsupported-font crashes.
- Tables, task markers, code whitespace/wrap/token colors and visible overflow policy.
- LaTeX/source fidelity. Per-equation image fallback can preserve appearance while ordinary prose stays text, but the compromise must be visible in the comparison artifact.
- A4/A3/A5/Letter dimensions/margins and page breaks, plus Infinite projected into normal sheets. Reuse physical document geometry and preserve reading order across boundaries.
- Positioned annotations and images on each corresponding physical sheet. Mixed notebooks must compose every supported page in order and fail explicitly for unsupported content, instead of silently skipping it.
- Full-document export of lazy/offscreen content without modifying live editor selection, toggles, pagination, undo or saved JSON.
- Memory/cancellation behavior for long documents, output size and the unchanged production bundle gate.

Likely files: an isolated rich-document PDF renderer/layout adapter beside `notebookPdfExport.ts`, existing export command collection/delivery, document geometry/view helpers, and PDF/browser/Electron acceptance fixtures. A font dependency or other large module must be justified by the comparison and included in the bundle measurement.

Approve these two bounded milestones before changing the backup contract or implementing the substantial rich PDF renderer. Neither approval would authorize commits, pushes, installers, releases or deployment.
