# Panvas documentation flow milestone

Implemented locally on `main`, based on `a1f3017`, for manual review. The original Stage 0–2 reports and implementation were preserved. No dependency changes, migration, commit, push, release, or deployment was performed. The milestone runtime harnesses use disposable workspaces and Electron profiles; an accidentally selected legacy integrity harness is disclosed under regression results.

This is a working editing/layout milestone with the limitations below. It is not a declaration of production readiness for arbitrary document sizes, old unguarded clients, or document PDF export.

## Use it

1. Open Page Properties, then Document Mode. Set **Writing layout → Document flow** on the current page. This adds a separate body and preserves the existing positioned objects.
2. Select **A4**, **A3**, **A5**, or **Letter**. Text fills the writing width and continues onto automatically derived paper sheets. Select **Infinite** for a continuous page. Current-page conversion retains the source width; a new Infinite page defaults to A4 portrait width.
3. Select the Text tool to write, select text, or use `/`. Open **More text formatting**, or right-click a document block, for documentation operations. Select words and press **Ctrl+K** or the link button to edit their link. Switch to Select, Hand, or Pen for positioned content and navigation. Infinite has a **Vertical position → Go** control for distant coordinates.

Freeform remains the default for old pages. Switching back to Freeform retains the document body in the drawing payload and hides it until Document flow is selected again. Existing objects can overlap the new body; they are not moved or converted automatically.

## Reproduction and classification

Both attachment directories contained only request text; no supplied screenshot or recording was available. A disposable instance of the actual NotebookRenderer reproduced the narrow positioned-text behavior. [Baseline screenshot](../../artifacts/documentation-flow/baseline-freeform.png) and [clipboard HTML/JSON evidence](../../artifacts/documentation-flow/baseline.json) are available locally.

- A positioned TextObject has no reading-order relationship with the following manually created page. Its narrow width and overflowing content were limitations of freeform placement, not a clipboard truncation bug.
- The reproduction explicitly included a separate `java` paragraph and a code node with `language: "java"`. The persisted/editor representation retained the language, and Lowlight already emitted nine syntax tokens. The independent label was present in the supplied synthetic HTML; it was not manufactured by the parser.
- Stage 2 commands existed but lacked normal controls for several essential operations. This milestone connects those commands and adds the integrated code-language control. The functioning HTML/fenced-code parsers were retained.

## Canonical content and layout

One NotebookPage owns one body TextObject with `metadata.documentRole = "body"` and `richTextSchemaVersion = 3`. Its Tiptap JSON is stored through the existing DrawingData, repositories, and save scheduler. There is one editor and native history for that body.

Continuation sheets are derived paper frames inside that logical page. An eight-sheet document remains one entry in the notebook hierarchy; a pre-existing manual Page 2 remains its own page. No continuation sheet owns a copied JSON fragment. This implements the logical-document model in the Stage 2 report without introducing another editor or database.

Pagination uses view-only ProseMirror decorations. Paragraph/list/code lines can continue across a seam while their canonical nodes remain intact. Headings retain the following line where possible. Deliberate page-break nodes are canonical and undoable. Tables use the installed table schema, TableMap and commands, with derived grid tracks and cell spacers; row/column spans and the source DOM row count remain intact. Paper margin/gap masking applies only after successful layout.

Annotations retain absolute logical coordinates in the root drawing payload. Deleting earlier text does not move ink, images, shapes, or floating text. Fixed sheets reclaim only space beyond the body and all positioned content. Infinite retains its high-water extent while editing or scrolling.

Expanded pages use moving raster windows rather than page-sized bitmaps. A finite 1,000,000-pixel CSS scroll window is recentered around logical coordinates; it is not a document-height limit. The editing owner alone can rebase that shared scroll window. Render origins remain transient and are reset on engine unmount.

## Confirmed integration defects fixed

- Native rich paste could reach both the contenteditable and workspace handlers while focus was pending, duplicating content. The workspace handler now recognizes the actual contenteditable event target.
- Ordinary plain text pasted outside the editor in Hand mode used the floating-object fallback. It now uses the document body, native identity/reference remapping, and one history action.
- Changing between one and several paper sheets remounted the editor. A stable content container preserves its editor and undo history.
- Reflow could let the passive page observer steal the document owner. Focused document editing and captured drawing gestures keep ownership.
- Browser arrow keys could get trapped at a visual page spacer. Boundary-aware horizontal/vertical movement preserves native document selection, including backward selections.
- Tall merged table cells required coordinated row tracks; fake spacer rows could not preserve rowspan layout. Table participants now paginate cell lines without adding source rows.
- A flowing body's math inherited an unreadable light color. It now uses the existing scoped notebook text/theme presentation.
- Research Space changes now trigger repagination with the correct source offsets and sheet stride.
- Infinite transitions could apply a fixed-page normalized geometry anchor and jump. They use the logical window instead.
- A distant inactive Infinite neighbor could rebase the shared viewport and pull a manually selected page away. Both the page view and renderer now restrict rebasing to the editing owner.
- Raster movement during ink capture could use stale canvas geometry or clear the live preview. Input geometry is refreshed and live ink is rebuilt from its retained samples.
- Positioned paste/drop coordinates account for the logical window base. Body objects are excluded from drawing-selection hit tests.

## Documentation controls

The existing formatting surface retains headings, typography, bold/italic/underline/strike, inline colors/highlights, alignment and lists. Inline code and a link button are exposed. The bundled inline-code mark now allows combined marks instead of discarding links, bold/italic/underline/strike, colors and highlights. New combined-code payloads require schema version 3 so older guarded writers preserve them. The expanded slash menu adds numbered lists, tables, callouts, toggles, toggle headings H1–H6, equations, dividers, page breaks and H4–H6.

More text formatting and the existing right-click menu call shared commands for Text/H1–H6/list/checklist/code/quote/callout/toggle/equation conversion, duplicate/delete/move, block links and colors, collapse, table insertion/row/column/merge/split operations, dividers, contents, inline/block LaTeX insertion or update, internal page links, and explicit Markdown paste. Unsupported structural conversions show an unavailable-operation message. Page breaks inside tables remain rejected.

Code blocks have a searchable selector covering all 37 currently registered languages, including Plain Text, Java, C, C++, Python, JavaScript, TypeScript, SQL, HTML/XML, CSS and JSON. Explicit unknown language labels remain intact and highlight as plaintext. Copy code uses the native clipboard; wrapping and captions are attributes of the existing code node. Tab/Shift+Tab use the installed code extension's two-space indentation. Language, wrap and caption actions use the body's history. The language popup is outside the paper mask so it remains usable at sheet boundaries; closed pickers do not retain 37 hidden option buttons per code block. Captions and code padding stay with the final source line during pagination.

The shared link dialog supports insert/edit/open/copy/remove for selected words, paragraphs and headings. Ctrl+K opens it inside the editable notebook; the existing command palette shortcut remains active outside the editor. Safe HTTP(S) links and same-origin Panvas page/block URLs retain visible words. Packaged Electron also accepts a `file:` link only to the current renderer's exact host/path with valid page/block IDs, rejecting other local files. These links require schema version 3 and use existing navigation; HTML/Markdown/persistence preserve their marks. Authoring controls pin the body owner while focus is in their inputs; detached editors and page changes close or reject stale actions.

Copy code, embedded links and block links share the existing browser Clipboard API or a new Electron text-write bridge. The bridge uses the existing trusted-sender and argument validation, rejects non-string or over-10-MiB text, and verifies native readback before reporting success, accounting for Windows CRLF normalization. It exposes no clipboard-read API. A locked Windows desktop produced error 5 at the native clipboard and initially blocked these checks; after the user unlocked it, all copy checks passed. Clipboard unavailability now produces a failure message instead of a false success.

The constructor fixture retains separate Java source, Plain Text output, description, explanation, lists and the standalone `java` prose label. It is synthetic, not a claimed Notion/ChatGPT clipboard capture. A fresh anonymous rendered excerpt from the [Highlight.js GitHub README](https://github.com/highlightjs/highlight.js/blob/main/README.md) was also transferred as HTML through the real editor: headings, links, lists, and three code blocks retained available structure. Its explicit `highlight-text-html-basic` wrapper metadata identifies HTML; the sanitizer recognizes that metadata and `highlight-source-*` wrappers without guessing from surrounding prose. [Source captures and provenance](../../artifacts/documentation-flow/public-source-captures.json). LeetCode's anonymous page stopped at Cloudflare security verification. No Notion or ChatGPT clipboard sample was supplied; those providers are not live-accepted here.

There is no inline-image upload/insertion menu. Stage 3 asset portability remains deferred. Existing positioned images and existing asset references are retained. Authored code nodes with wrap/caption attributes require schema version 3; unchanged legacy payloads are not rewritten merely by opening them.

## Runtime evidence

The harness mounts the actual NotebookRenderer, page properties, toolbar, editors, drawing engine and repositories. Electron uses freshly bundled source IPC/preload code and an isolated native workspace/profile. Chromium uses isolated browser storage. These are source application tests, not verification of an installed release, live Google Drive, or physical input hardware.

Typing, arrow keys, undo/redo, tool switching, mouse dragging and wheel input use Playwright/CDP. IME and pressure-varying pen/two-finger gestures use CDP. Clipboard tests dispatch representative HTML/text ClipboardEvents through the mounted editor/workspace handlers; they do not claim capture of the user's original OS clipboard.

Original expanded acceptance, including measured performance diagnostics: **25/25 Chromium, 26/26 Electron**, with zero renderer errors. The performance groups assert measurements and payload integrity, not a latency threshold. After the additional authoring requirements, standard flow acceptance passed **23/23 Chromium and 24/24 Electron**, separately from those earlier performance measurements. Source runtimes: Chromium 148.0.7778.96; Electron 43.3.0 / Chromium 150.0.7871.212. Reproduce with `npm run test:documentation-flow` or `npm run test:documentation-flow-performance`.

Additional authoring acceptance: **14/14 Chromium and 14/14 Electron**, zero renderer errors, using `npm run test:documentation-authoring`. This checks the visible searchable language UI and active/static token classes and colors, native copy controls, caption/wrap/indentation and undo, linked headings/paragraphs and Ctrl+K routing, eight simultaneous marks on linked inline code, right-click conversions and keyboard duplication, movement/undo/redo, block colors/links/deletion, internal link opening and local-file URL validation, slash commands, available public-source paste, HTML/Markdown round trips, repository handoff/full renderer reopen, and long wrapped Java/caption bounds at A4 seams. The native clipboard test accounts for Windows CRLF output and verifies restoration of the pre-test clipboard text. [Chromium authoring report](../../artifacts/documentation-flow/web-authoring.json), [Electron authoring report](../../artifacts/documentation-flow/electron-authoring.json).

File-based desktop acceptance also passed **14/14**, zero renderer errors, using `npm run test:documentation-authoring-file`. It builds the source application fixture to a temporary `dist/index.html`, loads it by `file:`, and uses the freshly bundled native IPC/preload with a disposable profile/workspace. Renderer resume parameters use a URL fragment so the existing exact-file trusted-sender policy remains unchanged. Tests cover native copy and same-renderer file links through authoring, HTML, Markdown, saving and navigation. This verifies the production bundle's file-origin behavior, not an installer or release package. [File-renderer report](../../artifacts/documentation-flow/electron-file-authoring.json).

Acceptance covers long formatted paste with 45 unique paragraphs, nested lists, a table, Java and LaTeX; zero text-rectangle violations at paper seams; early-edit reflow/undo; A3/A5/Letter/A4 widths; annotation-safe reclamation; 120-line Java and tall rowspan cells; native caret/backward/vertical selection; Research Space changes; Infinite conversion; language metadata/colors/history; IME; workspace plain paste; touch/pointer ownership; distant drawing/selection/pen pressure; old object pixels and drag/undo; controls; repository reopen; browser reload and full Electron restart; future-payload protection. Electron also checks rejection of nonfinite extent, invalid width and unknown layout metadata.

Screenshots from those running application checks:

| Demonstration | Evidence |
| --- | --- |
| A4, page 1 and automatic continuation, Java control/highlighting and LaTeX | [Chromium](../../artifacts/documentation-flow/web-a4.png), [Electron](../../artifacts/documentation-flow/electron-a4.png) |
| Same canonical body on a continuous Infinite page | [Chromium](../../artifacts/documentation-flow/web-infinite.png), [Electron](../../artifacts/documentation-flow/electron-infinite.png) |
| Long merged table cells at paper boundaries | [Chromium](../../artifacts/documentation-flow/web-boundary-blocks.png), [Electron](../../artifacts/documentation-flow/electron-boundary-blocks.png) |
| Distant logical drawing | [Chromium](../../artifacts/documentation-flow/web-distant.png), [Electron](../../artifacts/documentation-flow/electron-distant.png) |
| Existing ink, positioned text, shape and image after entering flow | [Chromium](../../artifacts/documentation-flow/web-legacy.png), [Electron](../../artifacts/documentation-flow/electron-legacy.png) |
| User-accessible shared documentation operations | [Chromium](../../artifacts/documentation-flow/web-controls.png), [Electron](../../artifacts/documentation-flow/electron-controls.png) |
| Separate Java source/output, linked heading and explanation | [Chromium](../../artifacts/documentation-flow/web-authoring-code.png), [Electron](../../artifacts/documentation-flow/electron-authoring-code.png) |
| Searchable language selector | [Chromium](../../artifacts/documentation-flow/web-authoring-language-search.png), [Electron](../../artifacts/documentation-flow/electron-authoring-language-search.png) |
| Embedded link editor | [Chromium](../../artifacts/documentation-flow/web-authoring-link.png), [Electron](../../artifacts/documentation-flow/electron-authoring-link.png) |
| Existing right-click menu with shared block operations | [Chromium](../../artifacts/documentation-flow/web-authoring-block-menu.png), [Electron](../../artifacts/documentation-flow/electron-authoring-block-menu.png) |
| Reopened caption, code metadata and linked document | [Chromium](../../artifacts/documentation-flow/web-authoring-reopened.png), [Electron](../../artifacts/documentation-flow/electron-authoring-reopened.png) |
| Wrapped long code and caption at continuation boundaries | [Chromium](../../artifacts/documentation-flow/web-authoring-caption-boundary.png), [Electron](../../artifacts/documentation-flow/electron-authoring-caption-boundary.png) |
| File-based desktop renderer with embedded internal block link | [Electron file renderer](../../artifacts/documentation-flow/electron-file-authoring-internal-link.png) |

These local screenshots and JSON/log files are in ignored `artifacts/documentation-flow/`, not release assets. Final standard flow reports are [web.json](../../artifacts/documentation-flow/web.json) and [electron.json](../../artifacts/documentation-flow/electron.json). Earlier measured performance reports are [web-performance.json](../../artifacts/documentation-flow/web-performance.json) and [electron-performance.json](../../artifacts/documentation-flow/electron-performance.json).

## Regression results

The full suite, navigation, handwriting, PDF, interaction and general persistence rows were run for the initial flow milestone. After the final authoring/native-clipboard changes, typecheck, 91 focused unit checks, standard flow acceptance, the rich-text pipeline and documentation-engine runtime suites were repeated. An earlier authoring batch passed 97 unit checks. Performance measurements were not relabelled as newly measured after those UI changes.

| Check | Recorded result |
| --- | --- |
| `npm test` | 651 passed, 1 existing opt-in skip, 0 failed; 254 pretest checks also passed |
| New geometry/window/inheritance tests | 4 passed; focused regression batch 57 passed; final geometry/render/export batch 29 passed |
| `test:rich-text-pipeline` | 24/24 Chromium and 24/24 Electron |
| `test:documentation-engine` | 35/35 Chromium and 35/35 Electron |
| Additional authoring checks | 14/14 Chromium, 14/14 Electron and 14/14 file-based Electron; latest 91 focused unit checks passed |
| Standard flow after authoring changes | 23/23 Chromium and 24/24 Electron; 4 geometry checks |
| `test:notebook-navigation` | 19 unit checks and 29 real-renderer cases at DPR 2/3 plus desktop; passed again after the owner-rebase fix |
| `test:handwriting-placement` | 9 unit checks and 42 geometry scenarios in each runtime |
| `test:document-input` | 16 groups in each runtime, including erasing, native mouse/pen, H2T cursor, two-finger ownership and PDF geometry |
| `test:interaction-ux` | 47 unit checks and 24 groups in each runtime, including themes, PDF annotations, sticky placement and persistence |
| `test:editor-regressions` | 75 passed/1 existing opt-in skip plus real 25-page persistence/reload/font checks |
| `test:pdf-mobile` | Chromium failed the existing raster-readiness assertion: 2 visible-unready samples out of 1,579, with zero missing raster/annotation samples. The `&&` script stopped before Electron. A separate Electron run passed, with 0 unready samples out of 2,096. |
| `typecheck` | Renderer and Electron passed |
| Accidentally selected legacy `electron-integrity.test.ts` | Failed during setup: `button[aria-label$="Integrity Notebook"]` matched both Expand and More actions in `tests/electron-lib.ts:168`. No document-editing assertions ran. The accompanying 69 pure unit checks passed. |

The PDF failure remains a failed gate, not a waiver or a pass. No PDF raster redesign was undertaken. Regression logs are named `regression-*.log` in the evidence directory. Some existing harnesses print Vite dependency-scan warnings for the old ignored official-Markdown spike and pdf.js dynamic import; their recorded runtime pass/error results are separate from those warnings.

The legacy integrity harness above launches the existing compiled app with the default desktop profile and has a broad Electron teardown; this accidental invocation did not meet the requested disposable-profile boundary. Its synthetic `P1 Integrity Test` workspace was removed by its teardown; read-only verification found no remaining matching workspace directory. It failed before page content or ACL fault injection. It was not rerun or changed as part of this scoped task. All milestone source runtime harnesses use disposable profiles/workspaces and close only their own application. [Legacy failure log](../../artifacts/documentation-flow/additional-native-unit.log).

Latest checks: [typecheck](../../artifacts/documentation-flow/typecheck-complete.log), [91 focused units](../../artifacts/documentation-flow/unit-complete.log), [rich-text runtime](../../artifacts/documentation-flow/richtext-complete.log), [documentation-engine runtime with native block-copy verification](../../artifacts/documentation-flow/documentation-native-final.log), [standard flow runtime](../../artifacts/documentation-flow/flow-complete.log), [authoring](../../artifacts/documentation-flow/authoring-final.log), [file-based authoring](../../artifacts/documentation-flow/authoring-file-final.log).

## Performance measurements

Machine: AMD Ryzen 5 5600H, 12 logical processors, approximately 16 GiB RAM, Windows 11 build 26300. The browser run is headless; Electron is an offscreen source window. Runtimes and heap readings are recorded in the JSON reports. Runs were sequential during the timed document cases.

Each size uses twelve native insertText samples from beforeinput through two animation frames; the table reports their p95. Scrolling advances the real viewport through sixty animation frames and records the frame intervals. Save cost is split into scene capture, JSON serialization and the existing repository write. Canvas memory estimates cover measured DOM surfaces and retained drawing buffers at four bytes per pixel, not all process/GPU memory. Heap readings use CDP Runtime.getHeapUsage without forcing GC.

All timing values are milliseconds. Cases ran at DPR 1 and approximately 1.54× viewport scale.

| Runtime | Layout / blocks | Input paint p95 | Scroll frame p95 | Capture / serialize / write | ID-less setup | JS heap MiB, before GC | Canvas MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | Infinite / 1,000 | 80.2 | 71.8 | 2.6 / 1.7 / 5.1 | 272.6 | 79.0 | 22.1 |
| Chromium | Infinite / 5,000 | 56.2 | 75.9 | 11.6 / 4.3 / 14.5 | 5809.8 | 449.9 | 22.1 |
| Chromium | Infinite / 10,000 | 140.2 | 70.2 | 39.5 / 15.0 / 26.0 | 25823.5 | 1572.2 | 22.1 |
| Chromium | A4 / 1,000 | 91.6 | 89.3 | 2.5 / 2.0 / 6.0 | 321.4 | 1596.8 | 22.1 |
| Electron | Infinite / 1,000 | 33.3 | 17.6 | 2.6 / 1.8 / 13.7 | 277.3 | 56.3 | 24.2 |
| Electron | Infinite / 5,000 | 63.2 | 17.6 | 15.8 / 5.9 / 48.5 | 6304.3 | 329.1 | 24.2 |
| Electron | Infinite / 10,000 | 108.8 | 18.0 | 31.1 / 10.8 / 95.6 | 24211.4 | 1565.1 | 24.2 |
| Electron | A4 / 1,000 | 49.8 | 17.7 | 2.1 / 1.6 / 17.9 | 368.4 | 1617.0 | 24.2 |

The 10,000-block JSON payload was approximately 2.46 MB. Large heap readings include uncollected bulk-identity transaction/history work from the direct fixture replacement; they are not a steady-state post-GC memory claim. The editable DOM and whole snapshots still need memory/performance work at this scale.

The large-document setup column measures direct `setContent` with initially ID-less fixture blocks. The existing lazy block-identity pass makes this substantially slower than the normal clipboard path. It is reported separately from real clipboard dispatch below. It is not a claimed paste/reopen time.

Real mounted-editor rich paste retained **10,000 paragraphs / 818,888 characters** in each runtime. Chromium: 786.3 ms clipboard dispatch; 25.4 / 8.4 / 26.1 ms capture / serialize / repository write. Electron: 909.8 ms clipboard dispatch; 22.3 / 10.4 / 100.5 ms capture / serialize / repository write. This uses the native clipboard transforms before inserting identities, rather than the ID-less fixture replacement path.

Bounded canvas allocation and correct distant coordinates passed. Large-document responsiveness is not uniformly below the audit's proposed 50 ms p95 typing target; the Chromium scroll frame measurements also do not establish smooth 60 fps scrolling. The full editable DOM, whole drawing snapshots and bulk identity work remain practical performance limits. This milestone does not claim a matched finite-baseline speedup.

## Exact task files

This list is relative to the preserved starting working tree, not all differences from HEAD. Existing Stage 0–2 changes in these files were extended in place.

| File | Task change |
| --- | --- |
| `electron/ipc/domain-handlers.ts` | Validate optional layout/extent/converted width and Infinite; bounded trusted native clipboard writes with readback |
| `electron/preload.ts` | Expose the native text clipboard-write bridge |
| `package.json` | Flow, performance and authoring scripts; dependencies unchanged |
| `src/types/electron.d.ts` | Type the shared native clipboard-write API |
| `src/types/notebook.ts` | Optional page-owned layout metadata and Infinite size |
| `src/lib/pageProperties.ts` | Base versus expanded geometry; page-owned inheritance and extent |
| `src/stores/notebookSettingsStore.ts` | Infinite size preference support |
| `src/components/notebook/DocumentFlowEditor.tsx` | One protected canonical body/editor and measured layout |
| `src/components/notebook/documentPagination.ts` | Derived spacers, line/table participants, composition deferral and boundary keys |
| `src/components/notebook/DocumentTableView.ts` | Native table schema with derived grid tracks and protected view styles |
| `src/components/notebook/documentFlowGeometry.ts` | Insets, sheet stride, positioned-content retention and extent |
| `src/components/notebook/documentPageBreak.ts` | Canonical page-break node/shared command/history guard |
| `src/components/notebook/logicalScrollWindow.ts` | Finite scroll-window rebasing |
| `src/components/notebook/notebookCodeBlockView.ts` | Integrated code language control using the existing Lowlight extension |
| `src/components/notebook/DocumentationControls.tsx` | Existing formatting surface integration with shared commands |
| `src/components/notebook/DocumentationLinkDialog.tsx` | Shared selected-text link editing and page/block targeting |
| `src/components/notebook/notebookLinkEditing.ts` | Editor Ctrl+K and existing internal navigation |
| `src/components/notebook/NotebookContextMenu.tsx` | Shared documentation actions in the existing contextual menu |
| `src/hooks/useKeyboardShortcuts.ts` | Respect handled editor key events; preserve outside Ctrl+K |
| `src/components/notebook/notebookStaticHtml.ts` | Render saved captions with the same Lowlight tokens |
| `src/components/notebook/NotebookFloatingToolbar.tsx` | Mount documentation controls inside existing text options |
| `src/components/notebook/NotebookToolPropertiesPanel.tsx` | Writing-layout choice, Infinite and distant-position navigation |
| `src/components/notebook/NoteSpaceControl.tsx` | Infinite research-space controls respect fixed width |
| `src/components/notebook/slashSuggestion.ts` | Essential document block commands and all six headings |
| `src/components/notebook/tiptapExtensions.ts` | Shared code/table views, combined inline-code marks and page-break registration |
| `src/components/notebook/notebookClipboard.ts` | Shared paste/copy routing, native identity/reference transforms, observed GitHub metadata and restricted same-renderer file links |
| `src/components/notebook/notebookBlockCommands.ts` | Page-break identities, source-preserving equation conversion, code options and clipboard results |
| `src/components/notebook/notebookContentCompatibility.ts` | Require version 3 for page breaks, code options, combined inline code and file links; preserve old payloads |
| `src/components/notebook/notebookMarkdown.ts` | Page-break, wrap/caption and restricted internal file-link round trips |
| `src/components/notebook/FloatingTextEditor.tsx` | Select the appropriate schema requirement when freeform content changes |
| `src/components/notebook/NotebookRenderer.tsx` | Body creation/paste routing, logical window, safe ownership and positioned coordinates |
| `src/components/notebook/NotebookPageView.tsx` | Bounded live/static/layer windows, body mounting, growth and owner-only rebasing |
| `src/components/notebook/PageRenderer.tsx` | Derived paper frames, bounded template surface, stable content container |
| `src/components/notebook/engine/ViewportManager.ts` | Transient render origin, bidirectional logical transforms and object culling |
| `src/components/notebook/engine/InputManager.ts` | Body routing and captured-input geometry refresh |
| `src/components/notebook/engine/DrawingEngine.ts` | Stroke culling and live-ink rebase from retained samples |
| `src/components/notebook/engine/ShapeManager.ts` | Render-window culling |
| `src/components/notebook/engine/ImageManager.ts` | Render-window culling |
| `src/components/notebook/engine/NotebookEngine.ts` | Reset transient raster origin on unmount |
| `src/components/notebook/engine/TextManager.ts` | Current document-body routing ID |
| `src/components/notebook/engine/SelectionEngine.ts` | Keep the document body out of positioned-object selection |
| `src/services/pdf/notebookPdfExport.ts` | Reject unsupported flow/Infinite export; exclude the retained hidden body when exporting Freeform |
| `src/styles/index.css` | Scoped document, gap, code-control and block-control presentation |
| `tests/documentation-flow-baseline.mjs` | Actual renderer reproduction and clipboard/JSON evidence |
| `tests/documentation-flow-browser.mjs` | Chromium/Electron UI acceptance, restart, pixel/selection and performance measurements |
| `tests/documentation-authoring-browser.mjs` | Visible controls, native clipboard, available public sources, file renderer, reopen and caption seam checks |
| `tests/documentation-engine-browser.mjs` | Expect schema 3 for edited code nodes; await real native block-copy completion and restore clipboard |
| `tests/rich-text-pipeline-browser.mjs` | Compare omitted and default wrap/caption attributes semantically |
| `tests/documentation-flow.test.ts` | Geometry, annotation retention, logical rebase and inheritance tests |
| `tests/fixtures/documentation-flow.html` | Disposable source renderer entry |
| `tests/fixtures/documentation-flow.tsx` | Body/ownership/repository timing inspection |
| `tests/fixtures/rich-text-pipeline.tsx` | Await initial hierarchy activation and resume existing disposable data on restart |
| `tests/ink-mode-compact-navigation.test.ts` | Update paper-background assertion for derived sheets |
| `tests/notebook-scroll-render-regression.test.ts` | Update positioned-editor rendering assertion |
| `tests/page-properties.test.ts` | Update bounded canvas/SVG geometry assertions |
| `tests/notebook-export.test.ts` | Verify Freeform export preserves its hidden canonical body and exports only visible text |
| `docs/research/documentation-flow-milestone-2026-10-13.md` | This handoff |

The three original research reports, `package-lock.json`, Stage 2 math/assets/reference/documentation-node modules and original outline/search tests remain byte-identical to the saved starting snapshot. Sixteen of the 30 original dirty files remain byte-identical; the other original files were extended in place, and the exact task list contains 57 files. [Preservation audit](../../artifacts/documentation-flow/preservation.json). The original snapshot is outside the repository at `<local-review-data>/tmp\panvas-flow-baseline-20261013`.

## Remaining limits and review boundary

- The editable document DOM is not virtualized. Browser DOM size/height and memory limits still apply to extreme text volumes, although positioned-object geometry and the scroll window have no arbitrary application height cap. Distant logical drawing was tested beyond normal browser CSS-height ranges.
- An indivisible block or font line taller than a writing area cannot be safely split. Layout shows a message to reduce its size or use Infinite. Complex table spans that exceed the bounded correction pass likewise report a layout issue; repeated headers and all possible nested/oversized table structures are not universally accepted.
- This milestone preserves absolute annotations, not text-anchored annotations. Continuation sheets are not separate sidebar page records. Template patterns use the bounded surface; exact patterned-template phase across distant Infinite rebases remains unverified.
- Flow and Infinite PDF export/printing return the explicit pending-export message. Freeform export excludes the retained hidden document body and leaves its JSON intact. Existing fixed freeform/PDF paths remain on their existing exporter. Full document PDF fidelity is deferred as requested.
- Current and Stage 2 guarded writers respect unsupported/newer payloads. This does not retroactively protect already-distributed binaries that predate those guards; cross-version live sync with such clients remains unverified. No live Google Drive, cloud asset-portability or backup/restore acceptance is claimed.
- CDP touch, pen pressure and IME checks are local emulation. Physical devices, real OS IME candidate windows and unusual third-party clipboard sources still need manual review.
- Many-stroke/positioned-object stress, payloads above 10 MiB, interrupted large saves and every notebook-wide Infinite property conversion were not accepted here. The measurements concern the documented fixtures and current-page conversion.

Work stops at this local milestone. Manual review should start with the A4/Infinite demonstrations, selection/undo at a seam, an existing notebook with positioned objects, and the stated performance/export/client limits before any further stage or release work.
