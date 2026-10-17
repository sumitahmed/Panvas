# Highlight correctness — 2026-10-15

This correction changes two product files: mouse/pen selection ownership in positioned text, and color comparisons used by the palette. The existing toolbar, Highlight extension, clipboard normalization, mark commands, renderer, and persistence format are reused.

## Reproduced causes

1. `FloatingTextEditor` allowed editable-text pointer-down events to reach the notebook viewport. The viewport calls `focus()` on pointer-down, so a drag first blurred ProseMirror, focused the viewport, and then refocused the editor during the browser's mouse handling. Document mode already isolates that event path. A rapid Electron run against a disposable copy of the recorded Rust document opened the palette with a collapsed caret and failed to apply Yellow to the requested range. The event trace independently reproduced the competing focus path on every drag.
2. Palette mixed-color detection compared stored color strings through `isActive()`. Adjacent `#BFDBFE` and `rgb(191, 219, 254)` marks render as the same blue but were reported as mixed, with no Blue option selected. Comparisons now normalize CSS colors, preserve alpha during comparison, and distinguish actual highlight/default marks from absent foreground color. Font differences alone do not mark the foreground color as mixed.

| Before | After |
| --- | --- |
| Ten viewport focus interruptions in the ten-operation recorded-document control run | Zero viewport focus interruptions in corrected runs |
| One observed rapid Electron apply used a collapsed range | Corrected operations assert retained range/direction and every affected character |
| Equivalent blue hex/RGB marks showed mixed palette state | Blue is selected; None removes both mark representations |

Mouse/pen events originating in the editable ProseMirror DOM now remain owned by that editor. Formatting commands and selection restoration retain their existing implementation. No CSS concealment or additional background-removal control was introduced.

## Imported formatting inspection

The 32.9-second reference recording was reviewed from `Screen Recording 2026-10-15 183739.mp4` (creation metadata: `2026-10-15T13:07:07Z`). The matching saved Rust text object was inspected read-only and copied into disposable test storage.

Its dark background is a `highlight` mark with `color: rgb(20, 20, 21)`; the red background is a `highlight` mark with `color: #ff4242`. Foreground colors, font family, and size are separate `textStyle` attributes. The green foreground on the red paragraph is a separate `blockColor`. No additional stored background format was found in that text object.

Supported pasted `background-color` styles on spans/paragraphs/semantic text elements already normalize to `highlight` marks through `sanitizeHtml()`. `<mark data-color>` uses that same mark. The shared schema registers multicolor Highlight and TextStyle with foreground/font attributes. None continues to call the existing `unsetHighlight()` command; it removes only the selected highlight range and preserves the other marks and block attributes.

## Exact files changed

- [FloatingTextEditor.tsx](../../src/components/notebook/FloatingTextEditor.tsx): prevent the viewport from stealing focus during editable mouse/pen text selection.
- [textFormatting.ts](../../src/components/notebook/textFormatting.ts): normalize equivalent CSS color representations and calculate mixed state across the selected inline content.
- [highlight-correctness-cases.mjs](../../tests/highlight-correctness-cases.mjs) (new): actual mouse selections and palette clicks, per-character JSON/computed-style comparisons, undo/redo, latest-revision persistence, actual inactive rendering, and a copied-document stress flow.
- [documentation-workflow-browser.mjs](../../tests/documentation-workflow-browser.mjs): add the highlighting flow to the existing actual-application harness and allow isolated builds against the preserved pre-fix sources.
- This report (new).

## Runtime verification

Chromium runs the actual application entry point. Electron runs its actual main/preload shell. Each run owns a disposable profile and workspace. No user notebook is edited.

| Actual UI flow | Chromium | Electron |
| --- | --- | --- |
| Freeform: 13 palette operations | Passed | Passed |
| Document: 13 palette operations | Passed | Passed |
| Recorded Rust copy: 30 operations, including 20 rapid selections | Passed | Passed |

The normal flow covers Yellow → Blue → None, Green/Pink/Orange/Purple, word and sentence selections, multiline/cross-paragraph ranges, reverse selections, pasted black/red backgrounds, equivalent hex/RGB colors, and bold + italic + linked text. Every operation checks the exact selected range, persisted mark attributes, rendered background colors, unchanged text, unchanged non-highlight marks, and unchanged block attributes. Palette state is asserted before each choice. Screenshots collapse the native selection so selection blue cannot stand in for a persisted highlight.

All 112 palette operations passed. Every final run has zero viewport focus interruptions, exact undo/redo and save/reopen JSON, unchanged computed foreground colors, and matching active/inactive background rendering. Both flows exercise the original page after activating another page. That step inspects and screenshots the application's actual inactive renderer rather than a separately reconstructed HTML sample. All six final runtime files contain no renderer error or run failure.

The save barrier explicitly awaits storage reads and the latest completed scene revision. During investigation, an async `waitForFunction` predicate was found to return a resolved false handle without repolling in this installed Playwright version. Those early persistence probes were replaced with an awaited polling loop; only the final evidence files are used for acceptance.

`npm test`: 652 passed, one existing skip, zero failures. The existing Chromium formatting/block core regression passed. TypeScript and the production build passed; `git diff --check` passed. Logs: [unit suite](../../artifacts/highlight-correctness-20261015/unit.log), [production build](../../artifacts/highlight-correctness-20261015/build.log), [consumer regression](../../artifacts/highlight-correctness-20261015/regression-web.json). [Acceptance and preservation summary](../../artifacts/highlight-correctness-20261015/acceptance-summary.json), [scoped patch](../../artifacts/highlight-correctness-20261015/scoped.patch).

## Screenshots and evidence

- [Apply Yellow](../../artifacts/highlight-correctness-20261015/after-web-freeform-apply-yellow.png)
- [Replace with Blue](../../artifacts/highlight-correctness-20261015/after-web-freeform-replace-blue.png)
- [Remove with None](../../artifacts/highlight-correctness-20261015/after-web-freeform-remove-none.png)
- [Remove imported black](../../artifacts/highlight-correctness-20261015/after-web-freeform-imported-black-none.png)
- [Remove imported red](../../artifacts/highlight-correctness-20261015/after-web-freeform-imported-red-none.png)
- [Preserve bold, italic and links](../../artifacts/highlight-correctness-20261015/after-web-freeform-mixed-marks-none.png)
- [Freeform inactive renderer](../../artifacts/highlight-correctness-20261015/after-electron-freeform-static.png)
- [Recorded Rust copy after reopen](../../artifacts/highlight-correctness-20261015/recorded/after-electron-freeform-reopened.png)
- [Recorded Rust copy in inactive renderer](../../artifacts/highlight-correctness-20261015/recorded/after-electron-freeform-static.png)

Final machine evidence: [Chromium Freeform](../../artifacts/highlight-correctness-20261015/after-web.json), [Electron Freeform](../../artifacts/highlight-correctness-20261015/after-electron.json), [Chromium Document](../../artifacts/highlight-correctness-20261015/document/after-web.json), [Electron Document](../../artifacts/highlight-correctness-20261015/document/after-electron.json), [Chromium Rust copy](../../artifacts/highlight-correctness-20261015/recorded/after-web.json), [Electron Rust copy](../../artifacts/highlight-correctness-20261015/recorded/after-electron.json).

Pre-fix controls: [color state and focus](../../artifacts/highlight-correctness-20261015/final-baseline/before-web.json), [recorded-document focus trace](../../artifacts/highlight-correctness-20261015/final-baseline/before-electron.json), [observed intermittent Electron miss](../../artifacts/highlight-correctness-20261015/recorded/before-electron.json).

Reproduction commands:

```powershell
node tests/documentation-workflow-browser.mjs --production-entry --highlight-correctness --phase=after --out=artifacts/highlight-correctness-20261015 --acceptance-only
node tests/documentation-workflow-browser.mjs --app-shell --electron --highlight-correctness --highlight-layout=document --phase=after --out=artifacts/highlight-correctness-20261015/document --acceptance-only
node tests/documentation-workflow-browser.mjs --app-shell --electron --highlight-correctness --recorded-content --highlight-stress=20 --phase=after --out=artifacts/highlight-correctness-20261015/recorded --acceptance-only
npm test
npm run build
```

The recorded-content run reads the local diagnostic copy under `artifacts/highlight-correctness-20261015`; the standard fixture needs no copy of user data. `--before-highlight --phase=before` builds with the two preserved product files without restoring or modifying the working tree.

## Limits and preservation

These are local mouse-driven Chromium/Electron checks. Physical touch/pen input and the operating system's native custom-color dialog were not exercised. Paste setup uses the application's real HTML paste handler with a synthetic clipboard event; the recorded-content fixture starts from copied JSON. Formatting itself always uses actual toolbar/palette mouse interactions.

None preserves intentional foreground colors, including a light imported foreground that may remain faint on white paper after its dark highlight is removed. Explicit block/container backgrounds are separate formatting and are not erased by inline highlight removal.

All 120 starting changed/untracked files were backed up before edits. Of those, 117 retain identical hashes; the other three are the two product files and the browser harness listed above. The test case and this report are new. The original saved Rust drawing file retains the same SHA-256 after inspection and verification. No reset, commit, push, merge, deployment, or release was performed. Work stops after this highlighting correction for manual review.
