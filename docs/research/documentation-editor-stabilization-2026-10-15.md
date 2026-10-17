# Documentation editor stabilization — 2026-10-15

This pass continues the existing working tree on `main` at `a1f301797a72eac165ca37afb87df2bd78c3b695`. It keeps the existing Tiptap/ProseMirror editor, Lowlight, KaTeX, pagination, TextObject JSON, repository persistence and native clipboard routes. No dependencies were added. No user workspace was reset, migrated or released.

## Evidence and skills

The starting 103 modified/untracked files were copied to `local snapshot: panvas-documentation-polish-20261015`, with SHA-256 manifest. The final comparison is [working-tree-audit.json](../../artifacts/documentation-polish-20261015/working-tree-audit.json). Changes below are relative to that snapshot, not an assumption that everything in the Git diff belongs to this pass.

Final audit: all 103 starting files remain, 90 are byte-identical, 13 were extended, and seven files were added. The exact final product source hashes are in [final-source-hashes.json](../../artifacts/documentation-polish-20261015/final-source-hashes.json). Git branch/HEAD are unchanged and `git diff --check` passes.

Inventoried 157 installed skill entries, including duplicate roots: [skill-inventory.json](../../artifacts/documentation-polish-20261015/skill-inventory.json). Applied the installed instructions from:

| Skill | Application |
|---|---|
| `focused-fix` | Trace and reproduce the actual paste, node-view, sidebar and persistence paths before editing. |
| `senior-frontend` | Existing React conventions, targeted render boundaries, keyboard access and text contrast. |
| Repository `frontend-design` | Match the current Panvas surfaces, tokens and compact controls. |
| Repository `emil-design-eng` | Restrained states, small control surfaces, visual inspection and the review table below. |
| `performance-profiler` | CPU profiles, transaction/highlight counters, style/layout, long tasks and heap observations before/after. |
| `playwright-pro` | Browser and Electron acceptance through real editor/paste/UI paths and disposable profiles. |

Reviewed all 94 one-second recording frames using four contact sheets in `artifacts/documentation-polish-20261015/recording/`. The local recording is `Screen Recording 2026-10-15 082954.mp4`, 93.97 seconds. Its time and content appear to match the supplied UTC-style filename; that literal filename was not present. The recording shows Plain Text, followed by an explicit JavaScript selection while Java source remains present. It does not establish an automatic language-initialization bug. Explicit Java metadata and Java/Plain Text choices are separately exercised by the tests.

## Root causes and changes

**LaTeX paste.** The existing Markdown command understood these delimiters, and existing math nodes rendered correctly, but ordinary HTML/plain clipboard paste did not recognize raw delimiter text. Typing input rules do not solve that clipboard path. Added a small delimiter recognizer to the existing clipboard plugin, producing the existing `inlineMath`/`blockMath` nodes. It preserves their LaTeX source and surrounding marks. It protects code nodes, code marks, backtick spans/fences, escaped/unmatched delimiters, prices and ordinary dollars. Display delimiters must be isolated on their lines. Recognition cannot span into protected code. Separator blank lines around display equations no longer create extra empty paragraphs. An empty prose buffer emits no paragraph, preserving the original first-node behavior of bare fenced-code paste.

**Highlighting.** The installed Tiptap 3.30.2 Lowlight plugin rebuilt highlighting across every code block on relevant document transactions. A single key could trigger two whole-document passes. Replaced only that decoration plugin with a ProseMirror plugin that maps existing decorations and highlights changed code content/language. It retains the same Lowlight instance, grammars, token classes and base code-paste plugin. Selection, wrapping and caption changes retain syntax decorations. Tests also cover replacing the entire document, converting code to prose and removing obsolete syntax classes. State retains only current-document nodes/decorations; no global AST cache or second model was added.

**Code controls.** Language choices were constructed both on trigger click and on the subsequent details toggle. Removed the duplicate build. Node-view updates caused by pagination/decorations also rewrote controls with unchanged attributes; they now refresh controls only when attributes change. The current node reference still updates on every call, so Copy reads newly typed source. Existing editability observation continues to update enabled states.

**Wrapping.** A genuinely long-line baseline already wrapped correctly: Chromium pre height 129 → 753 px; Electron 135 → 753 px. The reported Wrap failure was not reproduced. Hardened the shared card/pre width and overflow rules and scoped the ON/OFF rules to code cards. Final active tests use two lines exceeding 1,000 characters, including an unbroken identifier: Chromium 125 → 749 px and Electron 131 → 749 px. The canonical source/indentation and selection remain intact; ON stays inside the page, OFF scrolls horizontally inside the block. Freeform ON and OFF both survive actual repository save and reload. Shared-component tests exercise the real `StaticTextPreview` separately; Hand mode on the focused page is a live read-only editor and is not mislabeled as the static component.

**Sidebar.** Removed the persistent canvas mode selector. The existing properties sidebar now presents the Document/Freeform button group under Writing Layout, beside the independent Page Size select. Explicit conversion remains a separate action with the existing original-content backup. Opening existing notebooks performs no new conversion. All four A4/Infinite and Document/Freeform combinations are checked with canonical content preserved.

**Full Dark View.** The nested Tailwind prose element reset inherited document color variables, leaving ordinary Freeform text/math too dark. The existing Full Dark View rule now also targets that nested prose element. This is view styling; saved document colors/source are unchanged.

| Before | After | Why |
|---|---|---|
| Near-black code card and pastel-only syntax | Light paper tint; separate restrained Full Dark View surface; existing theme syntax tokens | Integrate with Panvas and preserve readable contrast. |
| Detached-feeling code actions | Shared, subtly tinted header; compact searchable language, Wrap and Copy; no card shadow | Keep controls and source together without oversized hover effects. |
| Persistent floating layout badge | Sidebar Writing Layout plus independent Page Size | Clear the canvas and avoid duplicate selectors. |
| Raw supported LaTeX clipboard text | Existing editable KaTeX nodes | Reuse the current math system and canonical source. |
| Dark Freeform prose/math on dark paper | Existing Full Dark View ink applied to nested prose | Make the actual rendered content readable. |

Measured minimum contrast for the sampled Java syntax tokens and controls: **5.47:1 light, 5.15:1 Standard Dark with white paper, 5.06:1 Full Dark View**, in both Chromium and Electron. The language label inherits the code header ink rather than the dark application chrome's light text. These are sampled Java/control colors, not a claim that every possible custom user color has been audited.

Real application captures: [light code](../../artifacts/documentation-polish-20261015/polish-acceptance-electron-code-light.png), [Standard Dark code](../../artifacts/documentation-polish-20261015/polish-acceptance-electron-code-standard-dark.png), [Full Dark View code](../../artifacts/documentation-polish-20261015/polish-acceptance-electron-code-dark.png), [sidebar](../../artifacts/documentation-polish-20261015/polish-acceptance-electron-sidebar-layout.png), [exact pasted equations](../../artifacts/documentation-polish-20261015/polish-acceptance-electron-math-plain.png), [Freeform read-only equations and wrap](../../artifacts/documentation-polish-20261015/polish-acceptance-electron-freeform-static.png). The last filename uses a harness label; its contents show the live page in Hand mode.

## Performance measurements

Sequential, disposable full-application runs use the same 40-block Java document and eight typed keys. The before build restores all seven affected existing product files from the starting snapshot; the harness asserts every override was applied. Chromium uses the real production application entry; Electron compiles the real main/preload and uses its file renderer and native IPC. The Electron window is offscreen with background throttling disabled. Observation adds counters and React profiling, not replacement stores/editors.

| Interaction/metric | Chromium before → after | Electron before → after |
|---|---:|---:|
| Eight keys: highlight calls | 640 → 8 | 640 → 8 |
| Eight keys: highlight time | 118.3 → 3.4 ms | 113.4 → 3.0 ms |
| Eight keys: inclusive PM dispatch | 728.5 → 469.2 ms | 887.8 → 558.7 ms |
| Eight keys: long tasks, count / total | 16 / 1061 → 9 / 561 ms | 16 / 1286 → 9 / 636 ms |
| Eight keys: input-to-two-rAF p95 proxy | 150.1 → 139.6 ms | 199.9 → 144.1 ms |
| Eight keys: layout | 88.1 → 77.8 ms | 124.3 → 95.7 ms |
| Eight keys: style recalculation | 252.5 → 254.2 ms | 331.9 → 308.5 ms |
| Java → Plain Text: highlight calls / dispatch | 80 / 109.5 → 1 / 57.2 ms | 80 / 133.0 → 1 / 69.1 ms |
| Plain Text → Java: highlight calls / dispatch | 80 / 67.0 → 1 / 29.2 ms | 80 / 75.7 → 1 / 35.8 ms |
| Copy: click-to-feedback acknowledgment | 19.0 → 16.2 ms | 6.1 → 6.4 ms |
| Language popup: observed long task | 51 → 50 ms | 64 → 84 ms |
| Text → code: dispatch, one small document | 2.7 → 2.6 ms | 4.1 → 3.5 ms |

Highlight calls fell **98.75%**; dispatch fell **35.6% Chromium / 37.1% Electron** for this workload. Copy already performed no PM dispatch, highlighting, scene capture or React commit in either measured copy window; the data does not establish a meaningful Copy speed improvement. Clipboard output is checked after editing as well, accounting only for Windows CRLF normalization.

React application commits during those eight keys were already zero before and remain zero. Code node views receive 296 update callbacks in both runs, with **zero creates/destroys**; the guard avoids unnecessary control writes rather than claiming to remove PM callbacks. Eight JSON reads, eight scene captures and eight clones remain; their total measured costs were below 3 ms each. The save contract remains intact. Later windows include asynchronous repository writes and verified reopen.

Eight scroll inputs produced five canvas redraws totaling about 0.2 ms and zero long tasks in both final platform runs. Formatting menus still showed 142 ms Chromium / 167 ms Electron maximum long tasks in the final windows. Autosave timing differed between these windows; no causal formatting-menu improvement is claimed. Final typing still had 73/85 ms maximum long tasks. Style recalculation and document layout remain material costs in this large workload.

Heap observations after typing were 23.6 → 24.2 MiB Chromium and 42.7 → 26.8 MiB Electron. GC timing makes these snapshots unsuitable for a memory-leak claim. Input-to-two-rAF is an eight-sample automation proxy, not physical display latency or a field INP measurement. Inclusive timings overlap and must not be summed. Single-run timings are local observations, not statistically stable benchmarks or live-device guarantees.

Raw data, counters for ten interactions, and CPU profiles: [comparison](../../artifacts/documentation-polish-20261015/performance-comparison.json), [Chromium before](../../artifacts/documentation-polish-20261015/polish-before-final-web.json), [Chromium after](../../artifacts/documentation-polish-20261015/polish-final-web.json), [Electron before](../../artifacts/documentation-polish-20261015/polish-before-final-electron.json), [Electron after](../../artifacts/documentation-polish-20261015/polish-final-electron.json). Later paste-boundary, separator-spacing and Standard Dark label corrections are covered by focused acceptance reruns; the profiled highlighting/control implementation is unchanged.

## Validation

The first rich-text run was invalidated by Vite reloading during the separator-spacing edit; that failed log is retained. The subsequent focused run caught an extra empty paragraph before bare fences, corrected by the empty-buffer guard. Static math parity compares rendered KaTeX and normalized annotation source because the existing HTML sanitizer trims attribute-edge whitespace; canonical JSON remains exact. The original workflow test was also corrected to check conversion focus before clicking a different sidebar button, which legitimately takes focus. Failed runs are not treated as passes.

| Check | Chromium | Electron |
|---|---:|---:|
| Full application focused acceptance, final paste/contrast source | Pass | Pass; real main/preload, file renderer, native clipboard |
| Original full application workflow: conversion, preserved objects, undo/redo, reopening | Pass | Pass; real main/preload and file renderer |
| Rich clipboard/static preview | 25/25 | 25/25 |
| Documentation engine | 35/35 | 35/35 |
| Documentation flow | 25/25 | 26/26 |
| Documentation authoring | 16/16 | 16/16 |
| Document/PDF input | 16/16 | 16/16 |
| Handwriting/H2T/ordinary text geometry | 42/42 | 42/42 |
| Navigation | 29/29 | Not separately run; native navigation is also exercised by input/interaction suites |
| Interaction/dark-view/PDF/sticky UI | 24/24 | 24/24 |

New delimiter/highlight unit tests: **9/9**. `npm test`, including its pretest gates, passed; the main test command reports **651 passed, 1 existing WinRT skip, 0 failed**. This pass does not turn that skip into physical handwriting recognition acceptance.

Final `npm run build`, including both TypeScript checks, passes. The broader regression pass ran once; targeted rich-text and full-application reruns cover the final small corrections. [verification-results.json](../../artifacts/documentation-polish-20261015/verification-results.json) consolidates the final results while retaining the initial failed-run logs. Original workflow evidence: [Chromium](../../artifacts/documentation-polish-20261015/workflow-final/verify-web.json), [Electron](../../artifacts/documentation-polish-20261015/workflow-final/verify-electron.json).

Final focused acceptance artifacts: [Chromium](../../artifacts/documentation-polish-20261015/polish-acceptance-web.json), [Electron](../../artifacts/documentation-polish-20261015/polish-acceptance-electron.json). Each confirms two prose paragraphs, two inline equations and three display equations for both clipboard representations; no renderer errors; exact math edit/reopen; Copy after edits; four mode combinations; Wrap ON/OFF reopening; and text-to-code undo/redo. The Electron result additionally records a successful real OS-clipboard Ctrl+V math paste.

The full application acceptance path creates notebooks/pages through the UI, pastes through the real App/ProseMirror clipboard path, edits equation source using the actual context menu, waits for the real repository and reloads. Structured paste cases use ClipboardEvents with synthetic test payloads; Electron additionally uses the OS clipboard and actual Ctrl+V for the supplied LaTeX. Native Copy reads the OS clipboard. Tests preserve/restore the standard text/HTML/RTF/image/bookmark clipboard formats. Disposable browser and Electron workspace paths are retained in the evidence JSON. The native disposable-profile bootstrap skips an unrelated first-run legacy import because this profile has no legacy data; migration acceptance is not claimed.

No production Google Drive, real-account synchronization, physical pen/mobile hardware, new installer, PDF export release gate or deployment acceptance is claimed. Cloud-sync warning diagnosis remains outside this change. Shared persistence, drawing/handwriting and editor boundaries are covered by the regressions rather than a cloud rewrite.

## Exact files changed in this pass

Product source:

- `src/components/notebook/notebookMathDelimiters.ts` — new protected delimiter recognizer.
- `src/components/notebook/notebookClipboard.ts` — route clipboard math into existing nodes and normalize display separators.
- `src/components/notebook/notebookCodeHighlight.ts` — new selective Lowlight decoration plugin.
- `src/components/notebook/notebookCodeBlockView.ts` — use that plugin, remove duplicate choices work, skip unchanged control writes.
- `src/components/notebook/NotebookWritingModeControl.tsx` — inline sidebar layout group and existing explicit conversion action.
- `src/components/notebook/NotebookToolPropertiesPanel.tsx` — sidebar Writing Layout section.
- `src/components/notebook/NotebookWorkspaceControls.tsx` — remove the floating layout selector.
- `src/components/notebook/NotebookRenderer.tsx` — remove its obsolete floating-selector props.
- `src/styles/index.css` — code surfaces/tokens, bounded wrapping and nested Full Dark View prose.

Verification and documentation:

- `package.json` — reproducible `test:documentation-polish` command; no dependency changes.
- `tests/notebook-math-delimiters.test.ts` — exact input, currency, escaping, protected code and display boundaries.
- `tests/notebook-code-highlight.test.ts` — incremental highlighting and decoration correctness.
- `tests/documentation-polish-cases.mjs` — focused full-app acceptance/performance interactions.
- `tests/helpers/notebook-properties.mjs` — current sidebar UI helpers.
- `tests/documentation-workflow-browser.mjs` — production/native app harness, preserved-source baseline and acceptance-only option.
- `tests/fixtures/documentation-workflow.tsx` — read-only profiling counters and clipboard feedback observation.
- `tests/documentation-authoring-browser.mjs` — updated sidebar selectors.
- `tests/documentation-flow-browser.mjs` — updated sidebar selectors.
- `tests/rich-text-pipeline-browser.mjs` — long-line active/static component parity with exact pasted equations.
- `docs/research/documentation-editor-stabilization-2026-10-15.md` — this report.

Run the focused repeatable checks with `npm run test:documentation-polish`. Start the current application with `npm start` (its existing prestart rebuilds it). Open the right Page & View inspector to find Writing Layout and Page Size. This pass stops for manual review; large-document style/layout latency and menu long tasks remain the measured limitations.
