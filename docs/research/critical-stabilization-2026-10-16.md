# Critical stabilization and release preparation - October 16

Status: development and verification completed for manual review, with an open performance blocker. Rich PDF export, portable backup, production builds and the listed functional regressions pass. The latest 4x CPU run still reaches a 500 ms page-switch frame. Live Google Drive and physical-stylus acceptance remain unverified. This is not release approval.

## Work recovered and completed

Before the interruption, the populated-page geometry/snapshot/image improvements, compatible security patches and portable backup v2 had been implemented and tested. Rich PDF output had not completed visual verification, and the support-bundle gate was over budget. Those implementations and the existing documentation/sidebar/highlight work were preserved.

After resuming, the existing rich-document exporter was finished, real files were downloaded through both application UIs, and all output pages were inspected. Unreferenced worker assets were removed and native backup helpers were split on demand, bringing the unchanged bundle gate below budget. Immutable snapshot JSON is now reused across the renderer fingerprint and repository transport when audio merging has not changed it. Final UI, ink, persistence, backup, security-artifact and performance checks were completed. Newly reproduced layer/shape, duplicate Trash and offline-bootstrap defects were repaired.

## Preservation and test-isolation disclosure

Branch remains `main`, HEAD `a1f301797a72eac165ca37afb87df2bd78c3b695`. No reset, commit, push, merge, installer generation, publication or deployment was performed. The starting 144 dirty/untracked files and generated builds were preserved outside the repository; additional clean originals were copied before their edits. Of those 144 initial files, 124 still match their starting SHA-256 values exactly. The remaining 20 contain additive changes for this task. The regenerated tracked pipeline PDF fixture was restored to its entry-state bytes.

[Preserved baseline location](../../artifacts/critical-stabilization-20261016/baseline-location.json), [exact task delta](../../artifacts/critical-stabilization-20261016/changed-files.json), [earlier checkpoint report](../../artifacts/critical-stabilization-20261016/checkpoint-history-before-final.md).

New harnesses use disposable data. During the broad regression run, two legacy Electron tests were discovered launching the default profile/workspace and using a global Electron process stop. Both failed before their editor steps; startup-side effects and interruption of an existing Electron process cannot be ruled out. No actual-workspace editor writes were observed, and no further inspection of user workspaces was performed. The shared helper now assigns unique temporary workspace/profile roots, checks cleanup containment, and stops only processes it owns. The successful native reruns used that isolation. The earlier checkpoint's blanket statement that no test used the default profile was incorrect.

## Reproduced causes and implementation

The supplied recording was inspected, including frames around the 27-30 second transition. It demonstrates delayed page paint. Its exact real-workspace sequence was not conclusively reproduced, and the recording alone does not establish data loss.

The disposable populated fixture confirmed repeated geometry preparation: detached scene snapshots missed object-identity WeakMap caches, rebuilding thousands of filled paths during live/preview handoff. Cached fills duplicated closure/shared-disk work. Already-decoded image hits requested redundant redraws. Generic snapshot cloning, repeated JSON serialization and native object IPC added synchronous work.

The existing engine now retains bounded geometry across detached snapshots, validates style and every point before reuse, uses equivalent implicit closure for cached fills, skips duplicate shared disks/distance work where unnecessary, and avoids no-op image redraws. The existing detached scalar-stroke helper is reused, including nested metadata aliasing and DataCloneError behavior. Preview geometry is bounded to six entries/500,000 samples, with an individually oversized current page allowed; detached surfaces/images are released.

Large browser saves use a module worker calling the same ownership-checked `notebookDB.saveDrawingData`; active Dexie transactions retain the original path and rollback. Native JSON transport uses existing channels, validation and atomic storage. Immutable, revision-owned snapshot JSON is shared between fingerprinting and transport. Ordinary mutable callers and changed audio merges encode fresh data. Experimental indexed-loop changes produced inconsistent results and were removed.

Final integrity testing also reproduced three small app defects: layer UI changes did not advance scene revision, a duplicate layer guard rejected shapes without an explicit default-layer ID, and Trash rendered deleted pages/sections twice. These were repaired without changing the interface. Production offline registration had both a duplicate cache constant and a late-load listener problem; fresh nested web routes also registered a relative worker URL at the wrong path. Registration now handles an already-loaded document and uses the configured build base.

Harness corrections were grounded in runtime/source evidence: installed Playwright treats an async `waitForFunction` predicate's Promise as truthy before its eventual false result, so completed IDB reads are now polled from the runner; browser reload tests use the web build instead of Electron's relative-base build; selectors distinguish visible live text, tree toggles and the Trash expander. Stale source expectations for staging, the retained Hand control and existing sticky-note aliases were corrected after checking actual behavior. No storage/formatting assertion was removed to conceal a regression.

## PDF export: real UI downloads and inspected output

The exporter uses a disposable read-only view of the existing Tiptap schema and pagination. It never registers that view with the drawing engine or saves it. Normal prose/code is written as searchable PDF text using measured layout; mathematical atoms and characters unavailable in PDF core fonts are rasterized at 3x. Images, links, colors/highlights, headings, lists, task boxes, continued tables/code, positioned ink/objects and imported annotated PDF pages are retained by the supported paths. Infinite content uses multiple normal A4 sheets, including a wider logical page scaled uniformly to fit.

| Export fixture | Pages per application |
| --- | ---: |
| Rich A4 | 2 |
| Infinite, normal width | 2 |
| Infinite, wide with right-edge image | 2 |
| Rich A3 | 3 |
| Rich A5 | 6 |
| Rich Letter | 4 |
| Mixed notebook, including original two-page PDF and annotation | 24 |

All **14 downloads** pass structural checks: expected dimensions, every paragraph marker/table cell/code-line sentinel exactly once, source PDF text, links/images, all extracted text within the page, no accessibility-only labels painted, and content on every page. The source canonical page JSON is unchanged after export. Native tests wait for completed Electron downloads.

Visual inspection caught a real remaining mathematical defect: KaTeX's SVG markup retained `width="400em"`, while CSS supplied its small visible viewport. Serializing the intrinsic SVG and squeezing it into that viewport erased the square-root stem. Export now copies the actual viewport dimensions and inherited paint to a detached SVG. The exported radical region changed from zero to 195 dark pixels; a PDF-content regression assertion now checks it.

All **43 Electron pages** were rendered and inspected as contact sheets, with larger representative pages/equation checks. Corresponding Chromium renders are pixel-identical at 72 dpi across all 43 pages. No unexpected blank pages or observed clipping remain in these fixtures.

[Download/unchanged-source evidence](../../artifacts/critical-stabilization-20261016/pdf-final-verified/pdf-ui-results.json), [structural assertions](../../artifacts/critical-stabilization-20261016/pdf-final-verified/structural-results.json), [visual comparison](../../artifacts/critical-stabilization-20261016/pdf-final-verified/visual-results.json), [contact 1](../../artifacts/critical-stabilization-20261016/pdf-final-verified/visual-contact-1.jpg), [contact 2](../../artifacts/critical-stabilization-20261016/pdf-final-verified/visual-contact-2.jpg), [contact 3](../../artifacts/critical-stabilization-20261016/pdf-final-verified/visual-contact-3.jpg), [equation](../../artifacts/critical-stabilization-20261016/pdf-final-verified/inline-equation.png), [before-radical proof](../../artifacts/critical-stabilization-20261016/pdf-math-before.json).

Reviewable PDFs: [Chromium A3](../../artifacts/critical-stabilization-20261016/pdf-final-verified/pdf-chromium-Rich-A3.pdf), [Electron mixed notebook](../../artifacts/critical-stabilization-20261016/pdf-final-verified/pdf-electron-Portable-research.pdf).

Limits: math/fallback glyphs are visible raster atoms and are not searchable; font families are approximated by PDF core faces with measured widths. Existing finite/freeform rich-text fallbacks and explicit fidelity warnings remain. This is fixture-backed support, not a claim that every arbitrary font/node combination is lossless. The original imported-PDF/annotation path is reused.

## Production bundle and security

Final TypeScript checks, desktop production build, separate web production build, and unchanged `check:release` all pass. Support JavaScript is **1,667,640 / 1,800,000 gzip bytes**. Renderer entry is 171,853 gzip bytes; total Panvas application JavaScript is 1,839,493 gzip bytes. The largest emitted Electron main implementation chunk is **241,094 bytes**, below 250,000; the 242-byte entry facade is not used as a substitute for measuring that implementation. No source maps or sensitive configuration files were found by the gate.

Vite emitted neural/benchmark workers even after disabled callers were tree-shaken. The build now prunes only unreachable asset-type JS/WASM after traversing references; live drawing/PDF workers remain. Native backup validation/serialization is imported on demand, and IPC validation is awaited before dispatch. No budget was increased and no gate was disabled.

Dependency pins include Electron 43.5.0, KaTeX 0.18.2 and Transformers 4.3.1, with compatible transitive patches and no force/legacy-peer bypass. Tiptap mathematics 3.30.5 supports KaTeX ^0.18.0. Relevant advisories: [Electron](https://github.com/advisories/GHSA-qmv3-fv6v-rmhq), [KaTeX](https://github.com/advisories/GHSA-238p-pmpm-9mq7), [ProseMirror](https://github.com/ProseMirror/prosemirror-view/security/advisories/GHSA-c8x8-7fp4-3x9w), [Sharp](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).

Current production dependency audit: **0 findings**. Full audit: **16 affected entries: 5 high, 11 moderate**, in Tailwind watcher/glob/parser and electron-builder downloader/logging chains. Compatible parent updates do not eliminate these; [braces 3 has no patched release](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). No major Tailwind migration or builder downgrade was made merely to reduce the count.

The final desktop/web/main/preload module journals cover **43 emitted chunk records / 1,557 unique rendered modules** plus external imports. None of the 16 affected package names occurs in those actual rendered module/import sets. Their code still executes as build tooling. No installer/EXE was built, so this is production-artifact reachability evidence rather than installed-package acceptance.

Electron retains context isolation, sandboxing, disabled node integration and web security. Clipboard HTML, protocols/Markdown, inherited KaTeX trust/maxExpand/maxSize, embedded content, IPC/path bounds, backup relationships/hashes and malformed input are covered by the passing relevant tests. The editor runtime security regressions passed 36 groups in each application after the dependency updates. Neural inference remained disabled.

[Production audit](../../artifacts/critical-stabilization-20261016/audit-resume-production.json), [full audit](../../artifacts/critical-stabilization-20261016/audit-resume-full.json), [actual artifact reachability](../../artifacts/critical-stabilization-20261016/security-artifact-reachability-accepted.json), [bundle gate](../../artifacts/critical-stabilization-20261016/bundle-accepted.log), [desktop build](../../artifacts/critical-stabilization-20261016/build-accepted.log), [web build](../../artifacts/critical-stabilization-20261016/build-web-accepted.log).

## Backup, restore and sync compatibility

Portable v2 includes canonical page/canvas JSON and deduplicated image/PDF/audio bytes with lengths/SHA-256, MIME/original names, PDF annotations and supported structured references. Restore validates before writes, allocates fresh metadata/block/asset IDs, and remaps known references without replacing prose/code/foreground colors. Browser publication is one transaction; native staging and fresh binary files are published through workspace metadata last. V1 remains readable with isolated missing-asset references and a warning that its absent binary bytes cannot be recovered. The unchanged encoded-package cap is 100 MiB, including base64 overhead; missing/corrupt v2 assets fail explicitly. External images are not fetched into backups. Raw Markdown strings are preserved rather than searched/replaced for IDs.

Fresh full-app UI exports/restores pass **Chromium -> Chromium, Chromium -> Electron, Electron -> Chromium and Electron -> Electron**, including actual built native main/lazy chunks, clean profiles, re-export/reopen, rich A4/Infinite JSON, code/math/table/image rendering, inline canvas bytes, remapped links, asset hashes and PDF annotation ownership. Stored PNG, WAV and two-page PDF assets were decoded. Corrupt bytes were rejected without publishing a workspace. Legacy warnings pass. Separate injected browser/native publication failures roll back; the final native rollback rerun passes. Native OS chooser responses are supplied by the harness; UI buttons, IPC, file IO and restore code are real.

[Final four-direction matrix](../../artifacts/critical-stabilization-20261016/backup-main-verified/ui-results.json), [final native rollback](../../artifacts/critical-stabilization-20261016/backup-rollback-final/ui-results.json), [collector/copy compatibility](../../artifacts/critical-stabilization-20261016/portability-audit.json).

Existing sync collector/copy and local V2 conflict/retry/interruption tests pass, including the 59-test V2 suite in the broader run. This does not establish authenticated Google Drive upload/download or account recovery. No credentials were supplied to new harnesses; live-provider acceptance remains manual.

## Final performance measurements

Workload: eight pages, each with 1,200 strokes/115,200 pressure-time samples, three 960x640 stored images and rich positioned text/code/table. Host: Ryzen 5 5600H, six cores/twelve logical processors, about 16 GB RAM. Final runs use the same newly compiled production-React fixture and real pointer/menu/sidebar input. CPU profiling was disabled while RAF/long-task/React/boundary counters remained enabled. No other builds or suites ran during measurement.

| Interaction | Chromium worst frame | Electron worst frame | Chromium, 4x CPU |
| --- | ---: | ---: | ---: |
| Scroll | 99.9 ms | 133.5 ms | 350.0 ms |
| Hand drag | 66.7 ms | 66.7 ms | 50.1 ms |
| Draw | 17.1 ms | 17.3 ms | 100.0 ms |
| Five page switches | 183.5 ms | 216.6 ms | 500.0 ms |
| Erase | 17.0 ms | 16.8 ms | 66.8 ms |
| Select | 66.7 ms | 83.7 ms | 99.9 ms |
| Menus | 17.0 ms | 17.0 ms | 16.8 ms |

Drawing p95 is 16.8 ms in all three final runs. Standard-run mount work peaks at 5.9 ms in Chromium and 10.4 ms in Electron during switching. Standard drawing/Hand/erasing/selection/menus record no long tasks; scroll/switch still do. Exact canonical storage before reopening, exact scene reopening, worker execution, foreign-owner rejection and unchanged original content all pass; browser transaction rollback passes. The final stress run also passes these functional assertions.

The original baseline measured worst scrolling/switching near 1,500/3,233 ms in Chromium and 750/1,583 ms in Electron on the same workload. Earlier optimized runs measured about 133/183 ms and 133/217 ms. These establish the initial large improvement; small differences between later runs are not additional speedup claims.

Stress remains an open blocker. The earlier afternoon run reached 467 ms switching; a later matched preserved-optimized-control/current pair reached 1,530/1,511 ms with both builds slowing substantially. The cause of that host timing variation was not established. The fresh quiet run above reaches 500 ms. All runs are retained; the 1.5-second observations are not discarded. The JSON reuse removes confirmed duplicate work but did not establish a reliable worst-frame improvement. Cold geometry/redraw, full-scene snapshots and navigation still cost too much under throttling. Further engine/worker ownership changes need a separate profiled design decision; no speculative cache expansion or engine replacement was added here. Universal 60 FPS and low-powered-device acceptance are not claimed.

[Final measurements and earlier controls](../../artifacts/critical-stabilization-20261016/performance-final-summary.json), [original comparison](../../artifacts/critical-stabilization-20261016/performance-summary.json). Earlier full long-document checks pass in both applications: 11 to 13 A4 sheets, undo/redo, over 30,000 px Infinite content, conversion and exact reopen. Fifty-source-page annotated PDF navigation passes with twelve resident canvases. [Long-document evidence](../../artifacts/critical-stabilization-20261016/long-document-summary.json), [PDF navigation](../../artifacts/critical-stabilization-20261016/pdf-navigation).

## Regression results and limits

| Check | Result |
| --- | --- |
| Broad Node regression suite, 88 files | 973 tests: 972 pass, 0 fail, 1 skip |
| Opt-in test skipped | Windows production Ink provider/worker real WinRT async path |
| Final browser/native integrity | 4/4, including audio/ink/text/layers reopen, v4 migration, Trash restore, honest save failure/retry and metadata recovery |
| Fresh HTTPS deep-link offline reload | 1/1, no registration errors |
| Native PDF pipeline and toolbar resize | Both passed in the preceding final regression run |
| Small final bootstrap/layer/Trash checks | 42/42 |
| Persistent highlight UI | 19 recorded operations per application; one transaction per gesture, Apply/Replace/None, mixed marks, black/red imports, stale selection cancellation, undo/redo, reopen and active/static equality |
| Rolling palette/sidebar UI | Both pass; 13 recorded palette operations and 8 sidebar cases per application, persisted FIFO colors/restart, select-first, keyboard/tree/drag/rename/Trash/canvas/status/narrow window |
| Ink UI/engine fidelity | 12 Chromium / 11 Electron groups pass; 700 input cases, 48 style cases, 140 ruler cases, pressure, partial erasing, exact undo/redo, PDF RMS <=1/255 and ten-second 240 Hz synthetic strokes |
| Rich PDF downloads | 14/14 structural assertions; 43 corresponding pages visually inspected and cross-platform pixel comparison passes |
| Backup matrix / native rollback | 4/4 directions and separate fault-injection rerun pass |
| TypeScript / desktop build / web build / bundle gate | Pass |

Completed final UI harnesses report no uncaught page errors. Vite retains nonfatal large-chunk, mixed static/dynamic import, Virgil runtime-asset and PDF-worker import-analysis warnings in logs; runtime/PDF/ink assertions pass. Earlier failed logs are retained to document investigation; the corresponding listed final runs pass. Remaining failure is performance acceptance under throttling, plus the manual coverage gaps below.

[Unit log](../../artifacts/critical-stabilization-20261016/unit-suite-final.log), [integrity log](../../artifacts/critical-stabilization-20261016/integrity-verified.log), [deep-link log](../../artifacts/critical-stabilization-20261016/offline-deeplink-verified.log), [highlight evidence](../../artifacts/critical-stabilization-20261016/highlight-verified), [palette/sidebar evidence](../../artifacts/critical-stabilization-20261016/palette-sidebar-verified), [ink evidence](../../artifacts/critical-stabilization-20261016/ink-verified).

## Exact files changed for stabilization and resume

The list below compares this task against the preserved starting tree, rather than attributing all existing uncommitted work to this task. Details are in `changed-files.json`.

### Product and build configuration

- `src/components/notebook/documentPagination.ts`
- `src/services/backup/backupAssets.ts`
- `src/services/pdf/richDocumentPdf.ts`
- `src/services/storage/drawingSaveWorker.ts`
- `src/services/storage/drawingSaveWorkerClient.ts`
- `src/services/storage/drawingSnapshotJson.ts`
- `electron/ipc/WorkspaceService.ts`
- `electron/ipc/domain-handlers.ts`
- `electron/preload.ts`
- `package-lock.json`
- `package.json`
- `public/service-worker.js`
- `src/bootstrap.tsx`
- `src/components/layout/TrashSection.tsx`
- `src/components/library/LibraryWorkspace.tsx`
- `src/components/notebook/NotebookLayersControl.tsx`
- `src/components/notebook/NotebookPageView.tsx`
- `src/components/notebook/NotebookRenderer.tsx`
- `src/components/notebook/engine/DrawingEngine.ts`
- `src/components/notebook/engine/ImageManager.ts`
- `src/components/notebook/engine/NotebookEngine.ts`
- `src/components/notebook/engine/ShapeManager.ts`
- `src/components/notebook/engine/cloneStrokeSnapshot.ts`
- `src/components/notebook/engine/penGeometry.ts`
- `src/repositories/NotebookRepository.ts`
- `src/services/audio/pageAudioPersistence.ts`
- `src/services/backup/backupBrowserStorage.ts`
- `src/services/backup/backupService.ts`
- `src/services/pdf/notebookExportCommands.ts`
- `src/services/pdf/notebookPdfExport.ts`
- `src/types/electron.d.ts`
- `vite.config.ts`

### Tests and fixtures

- `tests/backup-portability-browser.mjs`
- `tests/documentation-portability-audit.mjs`
- `tests/documentation-release-checkpoint1-browser.mjs`
- `tests/documentation-security.test.ts`
- `tests/documentation-workflow-browser.mjs`
- `tests/fixtures/backup-portability.ts`
- `tests/fixtures/populated-notebook.html`
- `tests/fixtures/populated-notebook.tsx`
- `tests/populated-notebook-browser.mjs`
- `tests/verify-document-pdfs.py`
- `tests/audio-notes.test.ts`
- `tests/backup.test.ts`
- `tests/browser-integrity.test.ts`
- `tests/canvas-persistence.test.ts`
- `tests/electron-integrity.test.ts`
- `tests/electron-lib.ts`
- `tests/electron-pipeline.test.ts`
- `tests/handwriting-fidelity.test.ts`
- `tests/ink-quality-browser.mjs`
- `tests/notebook-scroll-render-regression.test.ts`
- `tests/panvas-fixes.test.ts`
- `tests/panvas-performance-browser.mjs`
- `tests/toolbar-resize.test.ts`

### Documentation

- `docs/research/critical-stabilization-2026-10-16.md`

## Manual review and release blockers

Run `npm run start`; its prestart builds the current desktop app. Use a new disposable review workspace.

1. Arm Yellow and drag two separate ranges, switch to Blue, choose None and erase, then Esc. Check mixed bold/italic/links, unselected text and reopen. Review the six-color FIFO palette and sidebar keyboard/navigation in the normal app.
2. Edit a flowing A4 document and an Infinite document with code Wrap On/Off, language changes, tables, links, toggle conversion/deletion and equations. Export A3/A4/A5/Letter and a mixed notebook. Inspect the supplied PDFs, especially continued code/table cells and the square root.
3. Export a backup and import it as a separate workspace. Restart and inspect its images, playable audio, PDF annotations, canvas, links and rich content. The automated tests used synthetic data and the 100 MiB package cap remains.
4. With a physical pen, verify pressure, handwriting/ink highlighter, erasing, zoom and undo on populated pages. The synthetic results and skipped opt-in provider test do not establish physical-device acceptance.

For live Google Drive acceptance, use a test workspace/account: upload the image/audio/PDF/rich-document/canvas set, open it in a clean second browser/native profile and compare; interrupt an asset upload then reconnect/restart and verify retry/integrity; make conflicting offline edits on the two clients and exercise the existing conflict/retry flow; sync a restored copy and verify remapped links/annotations without replacing the original workspace. These are manual checks, not previously observed live results.

Release remains blocked by the 4x CPU navigation pause and pending provider/device acceptance. The 16 development-tool findings and PDF font/searchability limits remain disclosed. Installer packaging/installed-app acceptance belongs to a separately approved release stage. The legacy default-profile startup uncertainty is also recorded above. No commit or release action is pending in the background. Stop here for the owner's manual review and decision before any commit or release.
