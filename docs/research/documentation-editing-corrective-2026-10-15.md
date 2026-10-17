# Documentation editing corrective checkpoint — 15 October 2026

The formatting and stuck-toggle corrections work through the application UI. Full acceptance remains incomplete: the extended multi-page sequence can restore older content or an empty Freeform page after reload. Isolated typing/save/reopen passes in Chromium and Electron, and the isolated pre-change Chromium comparison passes. A separate A4 Document to Freeform handoff test also fails against all seven pre-change product files, establishing that the Freeform handoff/reopen defect predates this patch. Its root cause is not confirmed.

No release, deployment, commit, push, migration, or user-data cleanup was performed. The 112 initially dirty/untracked files were copied with SHA-256 hashes to `local snapshot: panvas-editing-corrective-20261015`; unrelated starting files remain unchanged.

## Confirmed causes and corrections

| Before | After | Why |
| --- | --- | --- |
| Rust paste retained black rectangles when unselected; the recording used block controls to try to remove them. | Visible **No background** on the strip, a labelled **Clear highlight**, **Reset text color**, and a distinct **Reset text formatting** in Aa. | Clipboard `background-color` is intentionally normalized into persisted `highlight` marks; foreground is a `textStyle.color` attribute. Reset block colors never removes those inline marks. The old clear action was a small X buried in Aa. No global CSS override was added. |
| Colors could display inaccurate swatches or an apparently uniform selection. | CSS colors are normalized for native color inputs, mixed inline colors are identified, block controls refresh after successful commands, and a low-contrast hint offers the existing reset actions. | Pasted rgb()/named colors are not valid six-digit values for `<input type="color">`; block inputs previously used hard-coded defaults. Color resets preserve headings, links, and other semantic structure. Intentional highlights remain stored until explicitly cleared. |
| Summary deletion/duplication failed, leaving the toggle. | Summary/content/body targets resolve to the nearest complete toggle. Ordinary code/equation/image targets keep their own identity inside containers. | The old deepest-node lookup returned `detailsSummary` or `detailsContent`, but the schema requires both children of `details`; removing or duplicating either independently is invalid. |
| Turn into Text refused populated toggles. | The conversion unwraps summaries and nested body content into editable blocks, retaining inline marks and embedded content; undo restores the original structure. | The old converter accepted only wrappers containing one textblock. A toggle always has two structural children. Unsafe conversions are now disabled with a reason. |
| Empty toggles trapped the cursor. | Backspace removes a wholly empty toggle; at the start of a summary or its first empty body paragraph it unwraps retained content. **Ctrl+Enter** inserts an editable paragraph after the current toggle. | Native Details is isolating, and its inherited Backspace handler only addressed the summary. These changes use the existing schema and ProseMirror transactions/history. |
| Formatting sessions restored only sorted numeric endpoints. | Sessions retain native TextSelection direction, NodeSelection, and AllSelection, map across document transactions, and refuse stale/disconnected targets. | Converting every saved range into TextSelection discarded selection type/direction and could reuse positions from an older document. |
| The strip was absolutely positioned below the main toolbar. | The existing OverlayManager positions it using the visible selection, flips above/below, and clamps to the notebook viewport and the top toolbar or bottom mobile dock. It stays below application dialogs. | The old strip did not measure selection/viewport/sidebar geometry. Selection-position callbacks also need to tolerate an editor being disposed during page handoff. |

**Reset text formatting** removes supported inline styling and keeps headings, hyperlinks, and block colors. **Reset block colors** changes block attributes and keeps inline styles. Deleting the last required list item removes its enclosing list through the same validated block command.

## Changed files

Product:

- `src/components/notebook/notebookBlockCommands.ts`
- `src/components/notebook/notebookDocumentationNodes.ts`
- `src/components/notebook/textFormatting.ts`
- `src/components/notebook/NotebookFloatingToolbar.tsx`
- `src/components/notebook/DocumentationControls.tsx`
- `src/components/notebook/SlashMenuList.tsx`
- `src/components/ui/OverlayManager.tsx`

Tests:

- `tests/documentation-editing-cases.mjs` — new actual-application corrective cases and isolated diagnostics.
- `tests/documentation-workflow-browser.mjs` — corrective runner and read-only pre-change source comparison.
- `tests/documentation-engine-browser.mjs` — complete-toggle targeting and nested code identity regressions; renderer errors retain their stack.
- `tests/panvas-interactions.test.ts` — native all/node/backward selection regression.

The corrective-only diff and preservation manifest are in [the evidence directory](../../artifacts/editing-corrective-20261015/).

## Runtime evidence and limits

The two supplied recordings were reviewed using every one-second frame and representative full-resolution frames. The clipboard payload itself was not available in the videos: tests reconstruct the named Rust examples with the observed black backgrounds/light foreground. Electron additionally pastes that HTML through the Windows clipboard and restores its prior standard formats afterward.

Chromium runs the actual production application entry. Electron runs the real main/preload and renderer with isolated temporary profiles/workspaces. Test data setup sometimes uses ProseMirror JSON; the assertions exercise real menus, keyboard commands, persistence, and rendered content, rather than replacement editor components.

Passed UI assertions in both runtimes include single-word and multiline highlight removal; exact formatting undo/redo; semantic-preserving text-color reset; A4 formatting reopen; duplicate/delete both toggle copies; nested toggle-to-text and undo; collapsed/expanded conversion/deletion; body-context targeting; empty-toggle Backspace and undo; keyboard exit; paragraph/heading/empty/code/callout/list/equation deletion and undo; native NodeSelection Delete for structural blocks; multiline mixed bold on/off; spanning Backspace and undo; move and undo; separate block/inline resets; and bounds at 1440, 780, and 460 CSS pixels plus zoom shortcuts.

- Documentation engine: **36/36 Chromium + 36/36 Electron**.
- Rich-text pipeline: **26/26 Chromium + 26/26 Electron** earlier in this pass.
- Unit suite: **652 passed, 1 existing skip, 0 failed**.
- Final production build/typechecks: **passed**.
- Core corrective UI run: **passed Chromium (37 observations) and Electron (38, including native clipboard)**.
- Pre-change A4 Document to Freeform handoff/reopen: **failed Chromium**; isolated Freeform clear/undo/redo succeeds in Electron, but its reopen also **fails**.
- Extended multi-page corrective sequence: **failed save/reopen in both runtimes**. Do not treat the core UI checks or isolated persistence checks as a passing full acceptance gate.

Profiling observed one document-changing transaction for multiline highlight removal plus one derived pagination transaction. An earlier extended ten-character typing sample produced ten document transactions, with zero React commits in Electron and one in Chromium during that sample. These are local observations, not a broad performance certification; concurrent test processes affect timing.

Screenshots and machine-readable observations:

- [Before: persistent black runs](../../artifacts/editing-corrective-20261015/before-web-black-unselected.png)
- [After: cleared background and reset foreground](../../artifacts/editing-corrective-20261015/after-web-formatting-cleared.png)
- [Before: stuck toggle and error](../../artifacts/editing-corrective-20261015/before-web-stuck-toggle.png)
- [After: nested content converted to paragraphs](../../artifacts/editing-corrective-20261015/after-electron-toggle-unwrapped.png)
- [Narrow strip placement](../../artifacts/editing-corrective-20261015/after-web-toolbar-460.png)
- [Core Chromium result](../../artifacts/editing-corrective-20261015/core-web.json), [core Electron result](../../artifacts/editing-corrective-20261015/core-electron.json), [execution summary with exit codes](../../artifacts/editing-corrective-20261015/execution-summary.json)
- [Pre-change handoff failure](../../artifacts/editing-corrective-20261015/handoff-before-web.json), [isolated Freeform failure](../../artifacts/editing-corrective-20261015/freeform-isolated-electron.json)
- [Chromium extended result](../../artifacts/editing-corrective-20261015/after-web.json), [Electron extended result](../../artifacts/editing-corrective-20261015/after-electron.json)
- [Isolated Chromium durability](../../artifacts/editing-corrective-20261015/persistence-isolated-web.json), [isolated Electron durability](../../artifacts/editing-corrective-20261015/persistence-isolated-electron.json), [isolated pre-change comparison](../../artifacts/editing-corrective-20261015/persistence-before-web.json)

## Remaining work for acceptance

The extended sequence observed a nonempty page in the repository, followed by older or empty content after reload. Isolated direct typing/reopen is healthy. The pre-change handoff reproduction restores an empty Freeform page after nonempty content was observed in the repository. This failure predates the seven product changes in this checkpoint. It needs a dedicated write/load trace; its root cause is not confirmed. The earlier Infinite typed-text discrepancy was observed in the extended sequence, without a matching pre-change reproduction. No changes were made to drawing, PDF, sync, or shared persistence services to guess at a repair.

Synthetic bulk replacement also showed derived A4 whitespace in some screenshots; it has not been established as a normal-typing defect. The previously stuck block itself can now be removed and converted through the UI.

Stop here for manual review of this checkpoint. The requested formatting and toggle actions are verified; full editor stabilization is not claimed.
