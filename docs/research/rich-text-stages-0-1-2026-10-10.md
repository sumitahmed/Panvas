# Rich-text pipeline: Stages 0–1 delivery

Date: 2026-10-10. Checkout: main at a1f301797a72eac165ca37afb87df2bd78c3b695, with the changes below left uncommitted.

Stages 0 and 1 are complete for review. The existing Tiptap/ProseMirror schema and shared extensions remain in use. No new Notion nodes, general Markdown importer/exporter, document storage, infinite geometry, PDF pagination, or frontend feature was added. The existing closed triple-backtick paste feature was reused. Work stops here until the owner reviews these stages.

The pre-existing, untracked [documentation-engine audit](documentation-engine-infinite-pages-2026-10-09.md) was preserved. No reset, deployment, release, push, merge, or commit was performed.

## Repairs

- Combined CSS formatting now retains simultaneous bold, italic, underline, strike, color, highlight, font family, and font size. Semantic tags with font styles retain those styles too.
- Workspace HTML import and active-editor HTML paste use the same sanitizer and normalization. Closed fenced-code text paste shares the existing parser. Active-editor paste continues through ProseMirror's native clipboard handling, retaining selection replacement, caret marks, open-slice metadata, code-context literal text, paste-as-plain-text, and editor undo/redo.
- Explicit code language attributes and prefixed classes are preserved; common aliases are normalized and unknown valid labels remain stored. Adjacent prose and automatic language detection no longer choose a language. Missing or unregistered languages highlight as plaintext. Prototype-like labels such as constructor remain ordinary strings.
- Static previews derive the same syntax token classes as the active editor, including nested tokens. Copied token HTML is discarded; code text is escaped and highlighting is derived rather than persisted.
- DOMPurify 3.4.16 is a pinned direct dependency, replacing 3.4.14 previously present transitively. The [upstream release](https://github.com/cure53/DOMPurify/releases/tag/3.4.16) was checked, and the dependency passed this checkout's renderer/Electron typecheck and runtime tests. Only DOMPurify changed in the dependency lockfile.
- Sanitization uses an explicit allowlist for the existing schema, restricts CSS properties and HTTP(S) links, removes executable/resource markup and event attributes, validates highlight-color and native slice-context attributes, and fails closed without a supported DOM parser. Native table widths and legitimate ProseMirror copy context remain intact.
- Blur cleanup recognizes structural content instead of relying on getText(): dividers, empty tables, tasks, and code blocks survive. Unsupported stored image/math payloads also survive blur without registering those nodes. Deferred cleanup rechecks focus, live/stored content, object identity, editability, and page ownership.
- Blank-object cleanup is undoable. Undo restores the complete object, original coordinates, bounds, metadata, and order. Cleanup does not clear another object's selection. Explicit text deletion also restores original order on undo.
- Plain-text link conversion retains sentence punctuation that the previous workspace helper dropped.

## Exact files changed

| File | Purpose |
| --- | --- |
| [package.json](../../package.json) | Direct dependency and reproducible browser/Electron test command |
| [package-lock.json](../../package-lock.json) | Pin DOMPurify 3.4.16 |
| [notebookClipboard.ts](../../src/components/notebook/notebookClipboard.ts) — new | Shared sanitization, code-language normalization, existing fenced paste, native clipboard extension |
| [tiptapExtensions.ts](../../src/components/notebook/tiptapExtensions.ts) | Register shared clipboard extension; disable language guessing |
| [NotebookRenderer.tsx](../../src/components/notebook/NotebookRenderer.tsx) | Reuse shared workspace paste helpers |
| [notebookStaticHtml.ts](../../src/components/notebook/notebookStaticHtml.ts) — new | Safe static syntax rendering matching editor decorations |
| [StaticTextPreview.tsx](../../src/components/notebook/StaticTextPreview.tsx) | Use shared static renderer |
| [FloatingTextEditor.tsx](../../src/components/notebook/FloatingTextEditor.tsx) | Meaningful-content detection, guarded blur cleanup, undoable deletion |
| [SelectionEngine.ts](../../src/components/notebook/engine/SelectionEngine.ts) | Restore deleted text objects at original indices |
| [rich-text-pipeline.html](../../tests/fixtures/rich-text-pipeline.html) — new | Isolated renderer fixture entry |
| [rich-text-pipeline.tsx](../../tests/fixtures/rich-text-pipeline.tsx) — new | Real notebook renderer, repositories, editor, static preview, save/reopen |
| [rich-text-pipeline-browser.mjs](../../tests/rich-text-pipeline-browser.mjs) — new | Runtime regression runner for browser and Electron |
| [This handoff](rich-text-stages-0-1-2026-10-10.md) — new | Scope, evidence, limits, and deferred architecture decisions |

## Fresh validation

The initial 14-group runtime baseline reproduced 10 failures in both browser and Electron; four groups passed in each. The final suite contains 24 groups, and two consecutive complete final runs passed in both environments. These exercise actual mounted editors, clipboard events, selections, toolbar undo/redo, static DOM, and repository save/page handoff/reopen. They do not depend only on source assertions.

| Command | Browser runtime | Windows Electron runtime | Other checks |
| --- | --- | --- | --- |
| npm run test:rich-text-pipeline | 24/24 groups | 24/24 groups | Zero renderer errors; zero malicious clipboard resource requests |
| npm run test:handwriting-placement | 42 geometry scenarios | 42 geometry scenarios | 9 unit checks passed |
| npm run test:document-input | 16 groups | 16 groups | Ink/eraser, wet-frame pixels, zoom, pan, pinch, ownership, persistence |
| npm run test:interaction-ux | 24 groups | 24 groups | 47 unit/source checks passed |
| npm run test:editor-regressions | 25 unique pages and 14 bundled fonts; save/navigation/reload scenarios passed | No separate Electron leg in this command | 75 tests passed, one existing WinRT test skipped |
| npm run test:notebook-navigation | 29 real-renderer regressions | No Electron leg in this command | 19 lifecycle tests passed |
| npm test | — | — | 904 passed, one existing skip, zero failures across pretest and main suite |
| npm run typecheck | Renderer passed | Electron passed | Both TypeScript configurations |

The skipped check is the existing optional “Windows production provider and worker complete the real WinRT async path” test. Real WinRT recognition acceptance is not established by these results.

Reproduce the new coverage with npm run test:rich-text-pipeline. The runner starts its own Vite server and uses disposable browser/Electron profiles and a disposable native workspace root. It does not operate on the owner's notebook data or OS clipboard.

Evidence is retained under the ignored artifacts/rich-text-pipeline directory:

- baseline-web.json and baseline-electron.json: original runtime failures.
- web.json and electron.json: final 24-group results, renderer errors, and resource requests.
- rich-text-runtime-delivery.log and unit-suite-delivery.log: final repeat.
- typecheck-final.log, handwriting-placement.log, document-input.log, interaction-ux-rerun.log, editor-regressions.log, and notebook-navigation.log: preservation checks.
- Earlier failed setup/rerun logs remain available; they were not replaced with passing assertions.

## Remaining limits

Clipboard coverage dispatches synthetic DataTransfer/ClipboardEvent objects through the real mounted ProseMirror editor in Chromium and Windows Electron. It tests native copy serialization and paste handling without touching the system clipboard. Manual copy/paste from external applications and physical pen/touch behavior remain unverified.

Rapid creation of disposable Electron fixture pages initially produced “Notebook page does not belong to requested notebook” errors before editor cases ran. Inspection of unchanged workspaceStore page activation and WorkspaceService metadata writes points to overlapping recent-file read/modify/write updates as a likely cause; this is an inference, not a completed production storage diagnosis. The final fixture creates and saves its hierarchy sequentially before page activation. The actual editor/paste/save/reopen paths remain under test. Production storage and IPC were not changed, so rapid native creation concurrency is outside this acceptance.

An earlier interaction-UX browser run timed out during fixture startup; the complete isolated rerun passed in browser and Electron. The rich-text persistence assertion also now waits for the expected saved JSON revision, rather than mistaking an earlier blank-object save for the current content.

Preserving unsupported stored nodes on blur does not add their rendering or editing support, or guarantee round-trip preservation after editing them. Unknown code languages retain metadata but render without syntax colors. Large-document save/performance acceptance has not been performed.

The tested existing notebook behavior was preserved: rich formatting, handwriting-to-text placement and focus parity, document input and gesture ownership, sticky-note geometry/history, navigation, and save/reload. These are local automated results, not packaged-release or physical-device acceptance.

## Owner decisions retained for later stages

1. Infinite height and document-flow layout are independent. Selecting Infinite must not convert or reposition freeform content. New infinite pages default to A4 portrait width; existing-page conversion preserves content and logical coordinates.
2. Freeform annotations retain fixed logical coordinates when document text reflows. Automatic paragraph anchoring is out of scope.
3. Browser print-only PDF delivery is not approved as the final solution. Revisit Stage 6 and prefer retaining downloadable PDF export on Electron and web.
4. A single document-body TextObject is provisionally accepted. It must pass meaningful large-document save/performance tests before Stage 5.

No implementation of these deferred decisions begins in this delivery.
