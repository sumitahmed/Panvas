# Formatting toolbar correction — 2026-10-15

This pass changes the notebook formatting toolbar and its menus. It preserves the existing editor, canonical Tiptap JSON, command dispatch, and local persistence.

## Root cause and interaction change

`TextFormattingStrip` was a portal positioned from the native selected range or ProseMirror `coordsAtPos`. Its overlay subscribed to selection and scroll geometry. Every different selection could therefore move the persistent controls. The notebook chrome reserved no space for them. Aa repeated the primary controls, and the main toolbar could expose another formatting entry.

| Before | After | Why |
| --- | --- | --- |
| Selection-following portal | Normal-flow secondary row owned by the main toolbar | Selection updates active states without changing row coordinates |
| Controls over the paper | Desktop chrome reserves a layout row; mobile dock reserves its height | Document content remains outside the toolbar region |
| Permanent “No background” button | Highlight palette starts with None and a crossed transparent swatch | Removes the real highlight mark through `unsetHighlight()` while keeping the strip compact |
| Duplicated primary actions in Aa | One primary row: B, I, U, Strike, Link, Text color, Highlight, Aa | Typography, paragraph and block tools remain organized inside Aa |
| Estimated context-menu dimensions | Existing overlay manager measures the panel and handles viewport collisions | Pointer menus remain accessible near window edges |

The strip stays visible when its menus take focus. Menus retain the native editor selection and map it through document transactions. Aa and color palettes anchor to their own buttons. Slash insertion menus retain their existing caret ownership.

An explicit dismissal check also found that ProseMirror prevents the default Escape behavior after formatting returns focus to its editable DOM. The overlay now recognizes that editor-owned Escape path, closes the active formatting menu, and returns editor focus. Consumed Escape events inside nested controls retain their local behavior.

## Exact files changed in this pass

Product files:

- [NotebookFloatingToolbar.tsx](../../src/components/notebook/NotebookFloatingToolbar.tsx): toolbar ownership, single primary row, menu state, retained selection, Aa organization.
- [TextColorPalette.tsx](../../src/components/notebook/TextColorPalette.tsx) (new): None/Default, six presets, custom color, keyboard navigation, existing overlay infrastructure.
- [OverlayManager.tsx](../../src/components/ui/OverlayManager.tsx): optional initial focus after placement and Escape focus restoration.
- [NotebookContextMenu.tsx](../../src/components/notebook/NotebookContextMenu.tsx): measured pointer anchoring and existing overlay collision handling.
- [index.css](../../src/styles/index.css): scoped reserved toolbar layout, responsive strip dimensions, transparent swatch.

Test files:

- [formatting-toolbar-cases.mjs](../../tests/formatting-toolbar-cases.mjs) (new): actual application toolbar acceptance checks and screenshots.
- [notebook-formatting.mjs](../../tests/helpers/notebook-formatting.mjs) (new): palette interactions shared by existing consumer tests; historical source comparisons retain their old UI path.
- [documentation-workflow-browser.mjs](../../tests/documentation-workflow-browser.mjs): route the toolbar checks through the existing Chromium/Electron application harness.
- [documentation-editing-cases.mjs](../../tests/documentation-editing-cases.mjs): palette actions and reserved-space geometry assertions.
- [documentation-final-cases.mjs](../../tests/documentation-final-cases.mjs): use the palette removal action.
- [rich-text.test.ts](../../tests/rich-text.test.ts): current primary controls and editor usability assertions.

This report is the only new documentation file. Pagination, PDF, sync, editor schemas, and block implementations were not changed.

## Runtime evidence

The actual application entry point was built for Chromium. Electron used the real main/preload shell with disposable profile and workspace folders. Clipboard content was dispatched through the real ProseMirror HTML paste path; it was a synthetic clipboard event, not a native Windows clipboard test.

At 1440 × 1100, the row measured exactly `x=538.5, y=131.984375, width=300, height=42` for top, middle and bottom selections in both applications. The page viewport started at `y=188.578125`, below the strip's `173.984375` bottom edge. Selection scrolling and notebook zoom did not move the strip.

| Check | Result |
| --- | --- |
| Chromium toolbar flow | Passed; 1440, 780, 460 and 320px widths |
| Electron toolbar flow | Passed; 1440, 780 and 680px widths |
| Existing formatting/block core regression, Chromium | Passed |
| Unit suite / pretest gates | 652 passed, 1 existing skip, 0 failures |
| TypeScript / production build | Passed |

Both applications passed top/middle/bottom selections, selected scrolling, B/I/U/Strike toggles, text-color reset, imported black highlight removal, exact undo/redo, keyboard palette navigation, Aa font selection, heading/list commands, explicit Escape dismissal and editor focus, pointer-menu collisions, A4 canonical-JSON save/reopen, Text → Hand → Text, zoom changes, and responsive layout. Aa stayed outside the primary strip at narrow widths. Emulated touch taps applied Yellow and removed it through None without changing the selected range. Both final runtime files report no renderer errors.

Commands:

```powershell
node tests/documentation-workflow-browser.mjs --production-entry --toolbar-ux --phase=after --out=artifacts/toolbar-ux-20261015
node tests/documentation-workflow-browser.mjs --app-shell --electron --toolbar-ux --phase=after --out=artifacts/toolbar-ux-20261015
node tests/documentation-workflow-browser.mjs --production-entry --editing --core-only --phase=regression --out=artifacts/toolbar-ux-20261015 --acceptance-only
npm test
npm run build
```

Screenshots:

| Selection / menu | Chromium | Electron |
| --- | --- | --- |
| Top | [Top](../../artifacts/toolbar-ux-20261015/after-web-top.png) | [Top](../../artifacts/toolbar-ux-20261015/after-electron-top.png) |
| Middle | [Middle](../../artifacts/toolbar-ux-20261015/after-web-middle.png) | [Middle](../../artifacts/toolbar-ux-20261015/after-electron-middle.png) |
| Bottom | [Bottom](../../artifacts/toolbar-ux-20261015/after-web-bottom.png) | [Bottom](../../artifacts/toolbar-ux-20261015/after-electron-bottom.png) |
| Highlight palette with None | [Palette](../../artifacts/toolbar-ux-20261015/after-web-highlight-palette.png) | [Palette](../../artifacts/toolbar-ux-20261015/after-electron-highlight-palette.png) |
| None selected after removal | [None](../../artifacts/toolbar-ux-20261015/after-web-none-selected.png) | [None](../../artifacts/toolbar-ux-20261015/after-electron-none-selected.png) |

Responsive screenshots: Chromium [780px](../../artifacts/toolbar-ux-20261015/after-web-780.png), [460px](../../artifacts/toolbar-ux-20261015/after-web-460.png), [320px](../../artifacts/toolbar-ux-20261015/after-web-320.png); Electron [780px](../../artifacts/toolbar-ux-20261015/after-electron-780.png), [680px](../../artifacts/toolbar-ux-20261015/after-electron-680.png).

Machine-readable evidence: [Chromium](../../artifacts/toolbar-ux-20261015/after-web.json), [Electron](../../artifacts/toolbar-ux-20261015/after-electron.json), [core regression](../../artifacts/toolbar-ux-20261015/regression-web.json), [unit log](../../artifacts/toolbar-ux-20261015/unit.log), [build log](../../artifacts/toolbar-ux-20261015/build.log), [scoped patch](../../artifacts/toolbar-ux-20261015/scoped.patch), [preservation check](../../artifacts/toolbar-ux-20261015/preservation.json).

## Performance and remaining limits

The strip no longer reads a selected range's bounds, calls `coordsAtPos`, or subscribes to selection geometry. Its existing formatting signature refreshes React only when formatting state changes. The six-character steady-typing workload recorded zero React commits, six document transactions and eight derived pagination transactions in both applications. The broader editor still performed 203 measured caret/layout reads (14.1ms aggregate in Chromium; 23.0ms in Electron). These local instrumented runs overlapped other checks, so their absolute timings are observations rather than a controlled performance benchmark. Existing pagination work remains outside this correction.

Electron has an existing 680px minimum window width, so narrower phone layouts are verified in Chromium. Emulated touch does not establish physical-device or software-keyboard acceptance. The custom color control uses the platform's native color picker.

The long A4 fixture still exposes existing pagination whitespace. The previously documented Freeform handoff/save/reopen issue was not addressed; see [the earlier corrective report](documentation-editing-corrective-2026-10-15.md). Save/reopen acceptance here concerns the A4 document fixture and exact canonical JSON after palette/font edits.

All 115 files captured at the start remain present: 107 retain identical hashes, and eight have scoped UI/test edits. Prior work was backed up before modification. User data was not used by the disposable runtime checks. No commit, push, merge, deployment, or release was performed.
