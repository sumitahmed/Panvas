# Highlight selection investigation — 2026-10-15

A first-focus selection bug is reproduced and corrected. The complete cause of the Blue/Purple failures around 12–19 seconds in `Screen Recording 2026-10-15 183739.mp4` remains unconfirmed. This is a bounded fix with runtime evidence, pending manual review, not a claim that every recorded failure is resolved.

## Reproduced cause and correction

The formatting strip was mounted only after an editor became active. Existing workspace CSS reserves space when that strip exists. On the first mouse drag after reopening a text object, focusing the editor mounted the strip and moved the paper **135.6 CSS pixels during the drag**. ProseMirror consequently selected earlier text. The palette then correctly operated on that already-wrong range.

The failure reproduces in Chromium and Electron using the preserved pre-change production build, the copied Rust document, its original 520px width and rotation, and actual mouse drags and palette clicks:

| Observation | Before | After |
|---|---|---|
| Intended range, “high-level constructs … machine code via LLVM” | 440–504 | 440–504 |
| Actual ProseMirror selection after first drag | **254–300** | **440–504** |
| Paper viewport top, before → after focus | 52 → 187.6 | 187.6 → 187.6 |
| Actual Blue click | Adds Blue at 254–269 and 284–300; 269–284 was already Blue | Adds Blue at 440–504 |

`TextFormattingStrip` now mounts when Text mode starts. The same existing controls remain disabled until a usable editor is available. Editor focus updates their state without changing the toolbar's occupied space. No toolbar controls, CSS, extensions, pagination logic, editor implementation, or persistence format were added or redesigned.

Before evidence: [Electron transactions](../../artifacts/highlight-selection-20261015/production/before-electron.json), [Chromium transactions](../../artifacts/highlight-selection-20261015/production/before-web.json). The Chromium negative-control run reproduced the wrong first selection and Blue transaction, then stopped at a later black-text reselection assertion; it is not a passing full baseline run.

After evidence: [Electron transactions](../../artifacts/highlight-selection-20261015/production/after-electron.json), [Chromium transactions](../../artifacts/highlight-selection-20261015/production/after-web.json), [compact comparison](../../artifacts/highlight-selection-20261015/acceptance-summary.json).

## Selection, imported formatting, and rendering findings

- For each tested palette click, the evidence captures selection and document JSON before opening, with the palette open, immediately before the click, immediately after it, and after settling. Transaction steps include document changes and editor identity. Character comparisons check foreground color, unrelated marks, exact selected positions, and all unselected text.
- In the stable-selection cases, opening the palette caused focus/blur events without changing the ProseMirror range. Yellow added a highlight; Purple removed the prior color and added Purple over that range; None removed the highlight. The traces did not show a collapsed cursor, stale range, wrong editor, or position changes caused by pagination in these cases.
- The copied red/green example stores **red as `highlight.color: #ff4242`** and **green as paragraph foreground `blockColor: #49d72d`**. None removes red and retains green. The black “Getting started:” text stores `highlight.color: rgb(20, 20, 21)`; None removes it while retaining its light gray foreground.
- The runtime TextStyle schema contains foreground color, font family, and font size, not `backgroundColor`. Existing clipboard normalization converts supported inline CSS background colors into highlight marks. Active and inactive rendering share the schema. No additional extension or mark-removal command was justified by the observed documents.
- The current user drawing also contains a separate pale `blockBackground: #efe1e1` on the Zero-cost list item. The inline highlight palette does **not** remove that whole-block attribute. Clearing it would affect text outside a partial selection. It is preserved and remains a limitation if “None” is expected to erase block backgrounds too.
- Screenshots with the native text selection collapsed distinguish persisted highlighting from selection-blue styling. Native blue disappearing on toolbar focus in the recording does not establish that the ProseMirror selection was lost.

## Fresh runtime results

The user launches with `npm run start`, whose `prestart` runs `npm run build`. The production checks use that build's unmodified `dist` and `dist-electron` output, with visible Chromium and Electron windows at 125% scaling. Test documents and storage live in disposable profiles. The Rust fixture is copied into test storage and reopened before interaction; formatting commands are triggered exclusively through the existing toolbar and palette.

| Check | Chromium | Electron |
|---|---|---|
| Production first drag and Blue; Blue → Purple → None; sentence Yellow → Purple → None; original red and black → None; recolor/remove both | **15 palette operations passed** | **15 palette operations passed** |
| Ordinary sentence, bold + italic + colored link, imported CSS black/red, and cross-paragraph ranges, retaining the selection across consecutive clicks | **15 passed** | **15 passed** |
| Same cases in Document layout | **15 passed** | **15 passed** |
| Undo/redo, saved JSON, reopen, foreground/unrelated marks/unselected text | Passed | Passed |
| Active/inactive computed backgrounds in ordinary and Document cases | Passed | Passed |
| Copied Rust document with original bounds: palette state, rendering, undo/reopen | — | **12 passed**, active/static parity passed |

The ordinary and Document runs use the existing instrumented application harness. Their imported HTML enters the production paste handler through a dispatched `ClipboardEvent`; this pass does not establish Windows native clipboard behavior. The independent production runs use no source transforms or editor fixture hooks. They read the actual editor state, click actual controls, and verify the stored drawing JSON.

All after runs reported no page errors. Existing toolbar regression checks also passed in Chromium. `npm test` passed its prerequisite suites and the main suite (**652 passed, 1 skipped, 0 failed**); the focused rich-text/toolbar suite passed **42/42**. `npm run build` passed. Existing font-asset and chunk-size warnings remain.

Visible evidence: [Yellow](../../artifacts/highlight-selection-20261015/production/after-web-sentence-Yellow.png), [Purple](../../artifacts/highlight-selection-20261015/production/after-electron-sentence-Purple.png), [None](../../artifacts/highlight-selection-20261015/production/after-web-sentence-None.png), [red removed / green retained](../../artifacts/highlight-selection-20261015/production/after-electron-red-green-imported-None.png), [black removed](../../artifacts/highlight-selection-20261015/production/after-electron-black-imported-None.png).

Reproduce the production after checks:

```powershell
npm run build
node tests/highlight-production-browser.mjs
node tests/highlight-production-browser.mjs --electron
```

These commands require the local copied recording fixture under `artifacts/highlight-correctness-20261015/recording-document.json`. Detailed instrumented results are under `artifacts/highlight-selection-20261015/{ordinary,document,recorded-static,toolbar}`.

## Exact files changed in this pass

1. `src/components/notebook/NotebookFloatingToolbar.tsx` — keep the existing formatting row mounted in Text mode; disable controls until an editor is available.
2. `tests/highlight-production-browser.mjs` — new production-build reproduction and UI transaction/persistence checks.
3. `tests/highlight-correctness-cases.mjs` — transaction/selection tracing, continuous selection tests, original recorded bounds, visible selection endpoints.
4. `tests/documentation-workflow-browser.mjs` — optional headed test execution.
5. `tests/rich-text.test.ts` — update the old source guard assertion for the stable mounted row.
6. `tests/toolbar-layout.test.ts` — update the same old source guard assertion.
7. `docs/research/highlight-selection-investigation-2026-10-15.md` — this report.

The starting dirty tree was backed up before edits. Of its 122 files, 117 remain byte-identical; only the five existing files listed above changed. No files were removed. The new production test and this report are additional files. Generated build output was backed up before rebuilding. HEAD remains `a1f301797a72eac165ca37afb87df2bd78c3b695`.

The actual user drawing was read only; its SHA-256 remains `0a11607f95a2281489a34b9b546f8ea29067836abf398332b65c1a0e4bd667c0`. No resets, commits, pushes, merges, or releases occurred.

## Remaining uncertainty / manual review

The supplied recording already shows the formatting row during some failures, so the confirmed first-focus bug cannot honestly explain every Blue/Purple interaction in it. Stable-selection palette clicks worked even in the pre-change build. The historical recording has no transaction trace that would identify those individual failures. Live cloud synchronization, Windows clipboard transfer, and physical pen/touch input were not verified in this pass.

The first-focus correction and its evidence are ready for manual review. Overall resolution of every recorded highlighting failure remains unconfirmed.
