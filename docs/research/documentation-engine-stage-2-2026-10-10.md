# Panvas documentation engine: Stage 2 delivery

Date: 2026-10-10. Scope: Stage 2 core editor functionality only. This builds on the preserved, uncommitted Stages 0–1 work. The earlier audit and Stage 0–1 handoff remain unchanged. This report supersedes their one-document-body-per-physical-page proposal for future document flow.

## Implemented

The existing shared Tiptap/ProseMirror editor remains the editor and its JSON remains the persisted content. There is no new block database, document database, page geometry, pagination, or complete frontend.

- One unified/remark Markdown adapter handles H1–H6, paragraphs, combined bold/italic/strike, inline and fenced code, explicit language metadata, nested bullet/numbered/task lists, blockquotes, dividers, GFM tables, safe HTTP(S) links, reference definitions, images by reference, and inline/display LaTeX. It exposes actual .md File import and Blob export plus explicit editor import/paste commands.
- Standard structures export as Markdown. Structures Markdown cannot represent, including callouts, toggles, merged/multi-paragraph/headerless tables, typography, colors, alignment, image dimensions, and meaningful empty paragraphs, use sanitized Panvas HTML with conversion warnings. Internal link targets and TOC heading identities also use HTML when necessary to retain their IDs. Unknown schema content exports in a panvas-json recovery fence rather than disappearing.
- Official mathematics extensions provide inline/block equation insertion and source editing. Active and static views use the same KaTeX settings: trust disabled, bounded expansion/size, and readable error output. Markdown supports dollar mathematics and deliberate LaTeX delimiters; authoring input rules use \\( ... \\) and \\[ ... \\] rather than auto-converting dollar currency. Source-backed KaTeX clipboard HTML recovers original LaTeX.
- Callouts contain ordinary nested blocks. Official Details/Summary/Content schemas provide toggles and collapsible sections/headings. Native details rendering shares collapse state between authoring and preview, retains all attributes when toggled, and keeps a heading title inside the summary's native disclosure semantics.
- Blocks acquire stable UUIDs on actual document changes or an explicit identity command. Opening/focusing legacy content does not assign IDs or rewrite its JSON. Native clipboard paste and duplicate operations create new identities and remap references to targets included in the copied fragment/subtree. Movement, reordering, formatting, and undo retain identities.
- Page/block reference nodes, copy-link commands, and derived table-of-contents nodes use those IDs. Reference navigation goes through existing page ownership and page handoff, then focuses the referenced block. Missing or invalid targets fail safely. References resolve within the loaded notebook/workspace.
- Block and inline image schemas retain existing fileId assets, alt text, source references, and optional dimensions. Existing supported raster bytes render through the existing repository with blob-URL cleanup. External references remain inert placeholders. No image upload/insertion menu or portable asset bundle is presented as supported.
- Existing shared Lowlight support is retained. Explicit languages, aliases, unknown language labels, code text, and whitespace survive import/editing. Unsupported languages render as plaintext. Language-change commands are undoable.
- Unknown nodes, unknown attributes, unknown marks/mark attributes, invalid structures, and newer schema metadata produce a readable protected editor. Transactions cannot replace the original stored payload; blur cannot delete it. New documentation nodes mark the TextObject metadata with richTextSchemaVersion 2. No bulk migration runs.
- Search extracts LaTeX source, asset alt text, reference labels, and collapsed content. The outline model understands all six heading levels and collapsible headings, using stable IDs when present.

The existing formatting toolbar, fonts, text/highlight colors, alignment, table commands, list editing, slash menu, handwriting placement, positioned TextObjects, and native editor history are reused. Minimal node presentation is scoped to notebook text.

## Core API and keyboard access

All later menu integrations should call these editor commands:

- importDocumentationMarkdown / pasteDocumentationMarkdown.
- ensureDocumentationBlockIds; turnDocumentationBlockInto; insertDocumentationBlock.
- duplicateDocumentationBlock; deleteDocumentationBlock; moveDocumentationBlock; reorderDocumentationBlocks.
- setDocumentationBlockColor; setDocumentationBlockBackground; toggleDocumentationCollapse.
- setDocumentationCodeLanguage; focusDocumentationBlock.
- insertDocumentationReference; followDocumentationReference; copyDocumentationBlockLink.
- Existing insertTable, setColor, setHighlight, typography/alignment/list commands, official insert/updateInlineMath and insert/updateBlockMath, undo and redo.

Ctrl/Cmd+Alt+Up/Down moves a block; Ctrl/Cmd+Shift+D duplicates; Ctrl/Cmd+Alt+Backspace deletes; Ctrl/Cmd+Alt+0/1–6 converts paragraph/heading; Ctrl/Cmd+Alt+Shift+E toggles collapse. Native Markdown typing rules remain in use. Required structural children reject operations that would produce invalid documents. Conversions that would discard multiple blocks return false.

## Dependency evaluation and additions

An actual mounted-editor spike evaluated @tiptap/markdown 3.30.2 before choosing the adapter. With the official mathematics extensions, its default pipeline interpreted “Costs $5 and $10 today.” as inline math, flattened a merged multi-paragraph table cell, and serialized an unknown future node as an empty string. These observations are preserved in the ignored local official-markdown-spike artifacts. The package was then removed.

Tiptap documents Markdown as beta and explicitly limits table cells to one child. The adapter uses the already established remark ecosystem and places the existing sanitizer before embedded HTML reaches the schema. There is one notebook Markdown parser/serializer, and ordinary clipboard handling retains the Stage 0–1 behavior. [Tiptap Markdown documentation](https://tiptap.dev/docs/editor/markdown), [remark project](https://github.com/remarkjs/remark).

| Dependency | Version | Reason |
| --- | --- | --- |
| @tiptap/extension-mathematics | 3.30.2 | Official source-backed inline/block math; matches the existing editor |
| @tiptap/extension-details | 3.30.2 | Official collapsible node schemas and native editor commands |
| unified | 11.0.5 | Explicit direct dependency for the single adapter; already present transitively |
| remark-parse | 11.0.0 | Maintained Markdown AST parser; already present transitively |
| remark-stringify | 11.0.0 | Maintained Markdown AST serializer; already present transitively |

Existing remark-gfm, remark-math, KaTeX, Lowlight, image extension, and DOMPurify 3.4.16 are reused. DOMPurify was added in Stage 1; it was not upgraded again for Stage 2. Other Tiptap versions remain unchanged.

## Exact Stage 2 file changes

This list describes Stage 2, not all differences against HEAD; the latter also include the preserved Stages 0–1 work.

| File | Change |
| --- | --- |
| package.json | Dependencies and reproducible test:documentation-engine script |
| package-lock.json | Matching dependency lock entries |
| src/components/notebook/tiptapExtensions.ts | Shared new extensions and cached schema; suppress opening-time trailing-node rewrites |
| src/components/notebook/FloatingTextEditor.tsx | Unsupported/newer schema protection and version metadata |
| src/components/notebook/NotebookRenderer.tsx | Existing page/block reference navigation integration |
| src/components/notebook/StaticTextPreview.tsx | Existing asset hydration and cleanup in preview |
| src/components/notebook/notebookClipboard.ts | Extend the Stage 1 sanitizer for structural authoring nodes and source-backed math/images |
| src/components/notebook/notebookStaticHtml.ts | Shared safe math, TOC, compatibility, and highlighting rendering |
| src/components/notebook/outlineModel.ts | H1–H6 and collapsible headings with stable block targets |
| src/services/search/pageSearchContent.ts | Semantic search text for new nodes |
| src/styles/index.css | Minimal notebook-scoped node presentation |
| src/components/notebook/notebookAssetImage.ts | New existing-asset inline/block image extensions |
| src/components/notebook/notebookBlockCommands.ts | New identities, validated block transactions, and keyboard commands |
| src/components/notebook/notebookContentCompatibility.ts | New unsupported-content detection and protected fallback |
| src/components/notebook/notebookDocumentationNodes.ts | New callout/reference/TOC nodes and extended official details schemas |
| src/components/notebook/notebookMarkdown.ts | New single Markdown adapter, file APIs, and explicit editor commands |
| src/components/notebook/notebookMath.ts | New official math integration and shared secure rendering |
| src/components/notebook/notebookReferences.ts | New bounded page/block resolution through existing ownership |
| tests/documentation-engine-browser.mjs | New real browser/Electron editor regression runner |
| tests/fixtures/documentation-engine.html | New disposable mounted-editor entry |
| tests/fixtures/documentation-engine.tsx | New adapter/repository test fixture, reusing the Stage 1 notebook fixture |
| tests/rich-text-pipeline-browser.mjs | Stage 1 semantic assertions tolerate identity-only metadata; unsupported representations remain protected |
| tests/rich-text.test.ts | Existing source check recognizes the shared JSON snapshot; runtime persistence is tested separately |
| tests/outline.test.ts | Updated six-level heading contract, invalid-level guard, and collapsible semantic title/target coverage |
| docs/research/documentation-engine-stage-2-2026-10-10.md | This delivery report and revised future architecture |

The pre-existing SelectionEngine change, rich-text fixture files, original audit, and Stage 0–1 handoff were preserved without Stage 2 edits.

## Runtime verification

All listed commands completed successfully. These are fresh local runtime results, not production, physical-device, backup-portability, or large-document pagination acceptance.

| Verification | Browser | Windows Electron |
| --- | --- | --- |
| Documentation engine | 35/35 groups | 35/35 groups |
| Stage 0–1 rich-text pipeline | 24/24 groups | 24/24 groups |
| Document input | 16/16 groups | 16/16 groups |
| Handwriting placement | 42/42 geometry scenarios | 42/42 geometry scenarios |
| Interaction UX | 24/24 checks | 24/24 checks |
| Notebook navigation | 29/29 regressions | Browser-only existing runner; real Electron page handoff/references and input navigation covered above |
| Editor persistence/navigation | 25 distinct pages, 14 fonts; delayed saves, remount, delete/restore, reorder, blank-page creation, reload passed | Covered by the Electron shared rich-text/new-node repository tests above, not this browser-only runner |

Application and Electron typechecks pass. The full npm test pipeline passes 904 tests with one existing skip and zero failures (905 total across pretest and test). The targeted outline/search/rich-text unit run passes 24/24 after updating the old H4-is-unsupported expectation to the requested H1–H6 contract.

Reproduce with npm run test:documentation-engine, npm run test:rich-text-pipeline, npm run test:document-input, npm run test:handwriting-placement, npm run test:interaction-ux, npm run test:notebook-navigation, npm run test:editor-regressions, npm test, and npm run typecheck. The additional targeted command is node --test tests/outline.test.ts tests/search-pdf.test.ts tests/rich-text.test.ts.

Local evidence is under artifacts/documentation-stage-2: web.json, electron.json, runtime-final.log, rich-text-final.log, document-input-final.log, handwriting-final.log, interaction-final.log, navigation-final.log, editor-final.log, notebook-tests-final.log, outline-search-final.log, and typecheck-final.log. The new browser and Electron runner reports both have zero renderer errors and zero requests to the malicious-resource test host.

Runtime failures repaired during development included opening-time trailing paragraphs that rewrote legacy JSON, shared ProseMirror attribute objects mutated by duplicate operations, closed-slice Markdown paste splitting a selected paragraph, lost converted-block alignment/selection, dropped Markdown image alt text, currency misclassification, copied references retaining stale target IDs, and active/static TOC label differences for equations/references. Native code exit and table gap-cursor editing were verified without custom replacements for their keyboard handling. No known failing Stage 2 regression remains.

All new runtime tests mount the real NotebookRenderer, FloatingTextEditor, shared extensions, and static preview. Browser tests use fresh browser storage. Electron tests use disposable profiles/workspace roots with the real sandboxed preload and repository IPC handlers. Clipboard tests dispatch native DOM clipboard events to the real editor handlers; copy-link tests substitute only the clipboard writer to avoid changing the owner's OS clipboard.

The documentation runner checks semantic Markdown/LaTeX round trips; actual File/Blob APIs; HTML fallback and sanitization; unknown payload recovery; schema-version protection; legacy coordinates/JSON; nested structures; IDs; insertion/conversion/duplication/deletion/movement; forward/backward selection; undo/redo; collapse; math security and active/static parity; language token parity; derived TOC; actual cross-page references; native code/table exits; repository asset bytes; search; and save/page-handoff/reopen.

## Compatibility findings and remaining limits

- The current editor protects incompatible payloads before parsing and rejects content-changing transactions. It preserves originals in repository saves and recovery export. Already released binaries cannot be retroactively made schema-aware: an older build that lacks this guard may drop unsupported content if it edits/saves a new document. Stage 3 needs an explicit version/backup/sync acceptance gate before wider interchange of new nodes.
- Standard Markdown cannot carry every Panvas feature. HTML fallbacks are faithful when imported by Panvas, but external Markdown tools may ignore custom attributes, internal references, collapse state, or TOC nodes. Recovery fences deliberately favor preservation over editability.
- Dollar amounts remain text; numerically ambiguous math can use deliberate LaTeX delimiters. Block display delimiters embedded in prose remain literal rather than turning part of a paragraph into a block equation.
- References are local to the loaded workspace/notebook. A copied application URL is not a cross-device sharing or web-publishing feature. Missing blocks/pages report an unavailable target.
- Structural images can display existing local raster assets. Referenced image files are not imported from the network or filesystem, and .md exports contain references, not asset bytes. Backup/restore/sync portability awaits Stage 3.
- Static canvas previews retain their existing non-interactive role; full editing, reference commands, and persisted collapse changes use the active editor.
- Core file/Markdown/block/math commands are implemented. New file dialogs, context/slash menus, equation editors, the language picker, and expanded toolbar wiring await the UI stage.
- No meaningful large-document save/performance or physical mobile/stylus acceptance claim is made here. The large-document gate remains required before Stage 5.
- New-node PDF rendering/print parity is not implemented. Existing PDF code was not changed; new documentation types require the Stage 6 export work.

## Revised architecture for Stages 4–6 — proposal only

The smallest viable direction is **one canonical TextObject per logical flowing document, owned by a root notebook page**, with multiple physical pages representing its layout. This replaces one document-body object per physical page. It reuses existing DrawingData, TextObject metadata, NotebookPage records, repositories, save scheduling, trash/recovery, and sync paths; it does not introduce a second document database.

1. **Single content authority.** The root page's drawing record holds the complete Tiptap JSON, using the TextObject ID as stable document identity. A future additive document-role marker distinguishes it from freeform text. Continuation pages hold only document/root-owner relationships, stable physical identities, lifecycle/order hints, their paper properties, and their existing page-local annotation drawing data. They never store independent copies or slices of the canonical text.
2. **One editor state/view/history.** Keep one editor mounted while selection crosses physical pages or notebook activation changes. Render paper frames and per-page annotation layers around a continuous editable DOM. A measured layout plugin maintains mappings from logical positions/stable block IDs to physical sheets and offsets; page boundaries are derived view state, not persisted split JSON. Selection, IME, clipboard, and undo operate on the one logical document.
3. **Pagination is an unproven layout problem.** A Stage 4 spike must test line boundaries, code lines, lists, nested toggles/callouts, table rows/merged cells, tall rows, images, and equations. Gaps between lines inside one paragraph and split tables need a dedicated layout participant strategy; widget decorations alone are not proof that this works. Oversized indivisible blocks need explicit bounded rules instead of clipping or unbounded continuation loops. A deliberate page-break node can be considered then, without creating independent editor states.
4. **Fixed-size continuation.** A4/A3/A5/Letter use their selected width, height, orientation, and margins. The planner creates enough adjacent, auto-owned pages in the same section, reuses their IDs on reflow, and leaves unrelated page order intact. Insertions push following text forward; deletions pull it back. Automatic pages are reclaimed only if no manual/freeform annotations or user-owned content would be lost. Annotated surplus pages remain recoverable, with an explicit detach/retention policy rather than silent deletion.
5. **Fixed drawing coordinates.** Handwriting, shapes, images, and freeform boxes remain owned by their existing physical page at fixed logical coordinates. Text reflow does not move them. There is no automatic paragraph anchoring. Block links resolve the canonical document/root and then use the current derived sheet mapping.
6. **Infinite is separate from layout.** Infinite uses one logical notebook page, default A4 portrait width, and a growing current vertical extent. It creates no physical continuation pages while editing. Height choice and freeform/document layout remain independent. Changing an existing page's height preserves its current objects and coordinates; entering flowing-document mode requires a separate deliberate action.
7. **Durability and lifecycle.** Text saves must explicitly target the root content owner even when a continuation is the active drawing page. Commit canonical content before derived continuation hints; reconcile stale hints on recovery. Browser transactions and Electron atomic writes need a recoverable grouped update protocol through existing adapters. Root/continuation deletion, restore, section moves, duplication, backup, and sync must all understand the relationship before shipping.
8. **Performance and export gates.** Measure large-document editing, save/reopen, history, layout, and memory before Stage 5. Bound annotation canvases and expensive inactive rendering; do not fake editable virtualization until selection/IME tests pass. Stage 6 should reuse the logical-to-sheet mapping for printable output and retain downloadable PDFs in web and Electron. Browser print-only delivery remains unapproved.

Decorations can provide derived presentation without changing document content, which supports the direction; the actual paginated editing implementation still needs the above spike. [Tiptap decorations documentation](https://tiptap.dev/docs/editor/core-concepts/decorations).

The official Pages product is useful research, not an adopted dependency. Its documentation identifies oversized non-splittable content and table limitations, and requires a dedicated pagination-aware table extension rather than the open-source table extension. This is evidence that pagination cannot be treated as a small styling change. No Pro package or conversion service was added. [Tiptap Pages limitations](https://tiptap.dev/docs/pages/core-concepts/limitations).

Stages 3–7 remain deferred. Stop after this Stage 2 delivery for owner review.
