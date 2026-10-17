# Persistent text-highlighter mode — verification, 2026-10-16

Implemented the missing gesture mode through the existing text highlight icon and palette. The highlighting engine, document schema, pagination, CSS, and drawing highlighter are unchanged.

## Root cause

The previous implementation supported a single formatting operation on the current selection. Its palette callback ran `setHighlight()` or `unsetHighlight()` and closed the palette. It had no armed state, retained gesture color, or completed-selection handler. A later native selection therefore did not apply a highlight.

This absence was reproduced before application edits in both production Chromium and Electron builds: choose Yellow at a collapsed cursor, then drag positions **440–504** in the copied Rust document. The selection was correct, but the document JSON remained unchanged and there was no automatic highlight command. The existing engine was working as implemented; the requested interaction was missing.

The supplied `Screen Recording 2026-10-15 222659.mp4` was reviewed across its full 24.9 seconds. Extracted frames are under `artifacts/text-highlight-mode-20261015/recording`.

## Implemented interaction

- Choose a color in the existing palette to arm the text highlighter. Choose **None** to arm its erasing gesture. The existing icon uses the normal active styling and `aria-pressed`; the swatch displays the armed color or None.
- Drag a nonempty native text selection, release, and repeat. The final native range is read after mouseup and applied with the existing Tiptap command. Movement itself never runs a formatting command or updates React state.
- Clicking Highlight while armed disarms it and opens the existing palette. Choosing a color arms it again. Escape and changing editing tools also disarm it. Opening another text-formatting palette disarms it so that palette retains its normal keyboard behavior.
- The chosen color is retained through disarming, focus changes, and tool switches within the current toolbar session. Arming at a collapsed cursor does not set a stored typing mark. An existing nonempty selection still receives a palette choice immediately, preserving select-first formatting.
- Every changing gesture uses one document transaction and starts a separate undo group. It retains selection direction and all unrelated marks.
- Each pending gesture belongs to one registered editor, page, and document snapshot. Editing or replacing that document, changing tools, a cancelled pointer, native drag-and-drop, blur, or a new pointer gesture cancels pending work. A4 view-only pagination does not invalidate document positions.

No second toolbar, permanent button, floating panel, or editor extension was added.

## Actual UI results

The new suite runs the unmodified production `dist` / `dist-electron` build used by `npm run start`, with visible Chromium and Electron windows at 125% scaling. All highlight choices and selections use actual toolbar mouse clicks and native drags. Initial document fixtures are copied into disposable storage or inserted through the existing paste handler; tests do not invoke highlight commands directly.

| Check | Chromium | Electron |
|---|---|---|
| Persistent-mode selection cases | **19/19 passed** | **19/19 passed** |
| Yellow A → Yellow B, with no toolbar or caret key between drags | Passed | Passed |
| Blue on later selections; repeated None erasing | Passed | Passed |
| Bold, italic, colored links, imported black/red backgrounds | Passed | Passed |
| Multiple paragraphs, later A4 sheet, selection across a page gap, backward erasing | Passed | Passed |
| No formatting during movement, clicks, keyboard selections, or caret movement | Passed | Passed |
| Ordinary typing while armed; gesture after the edit | Passed | Passed |
| Escape during a drag; intervening edit invalidates a pending drag | Passed | Passed |
| Escape, icon toggle, and editing-tool change exit mode | Passed | Passed |
| Remembered color; link dialog and its Escape behavior | Passed | Passed |
| Undo/redo and exact saved/reopened JSON | Passed | Passed |
| Active versus actual inactive read-only rendering, including computed backgrounds and foregrounds | Passed | Passed |
| Canvas ink highlighter creates a stroke without changing text JSON | Passed | Passed |

The 19 selection cases include **16 changing gestures**, each with exactly one document-changing transaction, and **3 disabled-mode gestures**, each with zero. Every case compares selected positions, document JSON, per-character marks, computed backgrounds, foreground colors, and unselected text. Before-pointerup JSON remains unchanged. Repeated gestures retain native selection between the first and second drag.

The independent production select-first suite passed **15/15** palette operations in **each** of Chromium and Electron, including exact ranges, original red/black removal, undo/redo, and save/reopen. The existing Document-layout select-first suite also passed **15/15** palette operations in Chromium, including palette state and inactive rendering.

`npm run build` passed. `npm test` passed its prerequisite gates and main suite: **652 passed, 1 skipped, 0 failed**.

Evidence:

- [Compact verification summary: selections, transactions, and checks](../../artifacts/text-highlight-mode-20261015/acceptance-summary.json)
- [Chromium production trace](../../artifacts/text-highlight-mode-20261015/production/after-web.json)
- [Electron production trace](../../artifacts/text-highlight-mode-20261015/production/after-electron.json)
- [Before Chromium](../../artifacts/text-highlight-mode-20261015/production/before-web.json) and [before Electron](../../artifacts/text-highlight-mode-20261015/production/before-electron.json)
- [Two Yellow selections with the icon still active](../../artifacts/text-highlight-mode-20261015/production/after-electron-yellow-B.png)
- [Repeated erasing with None still active](../../artifacts/text-highlight-mode-20261015/production/after-electron-erase-B.png)
- [Mixed formatting and colored link preserved](../../artifacts/text-highlight-mode-20261015/production/after-electron-a4-mixed-marks.png)

Reproduce the main production checks:

```powershell
npm run build
node tests/text-highlight-mode-browser.mjs
node tests/text-highlight-mode-browser.mjs --electron
```

These local replay tests use `artifacts/highlight-correctness-20261015/recording-document.json`. The A4 fixture is declared in the new test. Imported HTML fixture insertion uses a dispatched paste event; this pass does not claim Windows clipboard transfer, live cloud sync, or physical pen/touch acceptance.

## Exact files changed in this pass

1. `src/components/notebook/useTextHighlightMode.ts` — new mode state and guarded completed-selection lifecycle.
2. `src/components/notebook/NotebookFloatingToolbar.tsx` — connect the existing icon/palette to that mode and retain immediate selected-range formatting.
3. `tests/text-highlight-mode-browser.mjs` — new production Chromium/Electron gesture, transaction, persistence, rendering, and ink checks.
4. `tests/highlight-production-browser.mjs` — explicitly exit mode between independent select-first cases; accept a separate output directory to preserve previous evidence.
5. `tests/highlight-correctness-cases.mjs` — explicitly exit mode between independent select-first cases.
6. `docs/research/text-highlight-mode-verification-2026-10-16.md` — this report.

The starting 124 dirty/untracked files and existing generated build were backed up before edits. Of those files, **121 remain byte-identical**; only the toolbar and two existing test files listed above changed. The hook, new browser test, and this report are additional files. No files were removed. HEAD remains `a1f301797a72eac165ca37afb87df2bd78c3b695`.

The user drawing is read only throughout; its SHA-256 remains `6318230c11f2e91157089e85a521ddc989f99b128b146161feae3fd416fc6c73`. Verification uses disposable profiles. No resets, commits, pushes, merges, deployments, or releases were performed.

Stopped for manual review of this specific interaction.
