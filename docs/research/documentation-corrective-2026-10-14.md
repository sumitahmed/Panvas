# Panvas documentation corrective follow-up - 2026-10-14

The existing paginator already worked. The ordinary New Page route still created a positioned Freeform text box, and the writing-mode caption offered no direct action. This follow-up connects the normal creation, conversion and paste routes to the existing document editor, refines its menus and removes measured redundant React work.

## How to use the local implementation

Run `npm start` from this checkout. The production renderer, Electron main process and preload have been rebuilt locally.

1. Choose **New item > New Page**. **Document** and **A4** are selected initially. The new page focuses its document body; type or paste there. Automatic sheets belong to this one page and one canonical text body.
2. For an existing Freeform text box, select it or place the text caret inside it. Open **Freeform · A4 > Convert selected text to document**. The Document mode button also performs this explicit conversion when a suitable source is available. With several ambiguous boxes, Panvas asks for a selected source.
3. Use the same writing-mode menu to select **Infinite**. It retains the current paper width, grows vertically and removes physical sheet gaps. Choose **Freeform** when positioned text and handwriting are wanted.
4. The page-footer **+** opens the same chooser and inserts after the current logical page. Its pointer event is isolated from Hand-mode viewport panning.

Existing Freeform pages retain their layout until the user changes it. Conversion retains the source ID, complete original object in `documentConversionOriginal`, rich JSON, object typography and other positioned objects. Undo restores the source and geometry exactly; redo restores the document. Returning to Freeform retains current authored text and restores the original position and width. Resuming Document reuses that body.

## Recording and baseline evidence

The matching local recordings were `Videos/Screen Recordings/Screen Recording 2026-10-14 175941.mp4` (25 seconds) and `Screen Recording 2026-10-14 180100.mp4` (54.53 seconds). The correspondence to the supplied UTC-style recording names is inferred from time and content. Their complete one-frame-per-second timelines were inspected in five contact sheets under [recordings](../../artifacts/documentation-corrective/recordings/).

They show the Freeform caption, a narrow movable text object, code/language controls and blank manually added pages. Before these corrections, the real application was exercised in Chromium and Electron: an explicit document layout already produced **11 A4 sheets at a 666-pixel writing width**, while ordinary page creation produced a **300-pixel Freeform box**. See [before Chromium](../../artifacts/documentation-corrective/corrective-before-web.json) and [before Electron](../../artifacts/documentation-corrective/corrective-before-electron.json). Pagination was retained.

## Implementation and UI review

The installed-skill inventory contains 157 entries, including duplicate roots: [inventory](../../artifacts/documentation-corrective/skill-inventory.json). Relevant UI entries included frontend-design, emil-design-eng, senior-frontend, ui-design-system, ux-researcher-designer, apple-design and design-taste-frontend. Applied workflows were focused-fix, frontend-design, emil-design-eng, performance-profiler and playwright-pro. The interface follows existing Panvas surfaces and tokens; it adds no UI dependency.

| Before | After | Why |
| --- | --- | --- |
| New Page bypassed the document chooser | Sidebar, navigator, context and footer routes share the Doc/Freeform chooser; Doc/A4 default | Put working flow on the ordinary creation route |
| Read-only Freeform/paper caption | Compact writing-mode/paper control and explicit conversion action | Make the current mode and next action discoverable |
| Aa text pane: 17 controls, 334.8 px high | Same 17 controls, 270.2 px high; typography and alignment grouped | Reduce height by about 19% without removing commands |
| Font picker opened another panel | Scrollable font list replaces content inside the same Aa panel | Keep selection, keyboard focus and one panel |
| Long native block-type select | Searchable Turn into list reuses the slash-list component and shared command catalog | Find transformations quickly, with arrow/Enter/Escape support |
| Separate menu lifetimes could overlap | Formatting, writing mode, context, slash and code-language menus close competing documentation menus | Keep the active operation clear |
| Reopened toggle-summary context menu could not collapse its parent | Collapse resolves the enclosing details node | Make the existing command work after reopening the menu |

Code language, wrapping, copy and caption controls remain integrated with each code block. Keyboard menu choices restore editor focus synchronously, preserving the selected range and the next undo shortcut. No animation is added to frequently used keyboard menus.

`DocumentFlowEditor`, the existing Tiptap schema, pagination plugin, TextObject persistence, save scheduler and repositories remain the canonical path. Explicit layout changes use the existing canvas history command infrastructure; text edits across derived sheets use one ProseMirror history. Layout undo is available after text history is exhausted, scoped to the current page. Protected or unsupported source content cannot be converted. Positioned annotations do not move with text reflow.

Canvas-focused HTML/plain-text paste in Document mode now reaches the same live body and existing ProseMirror clipboard parser. Clipboard text formats are copied before the event ends, and dispatch waits for the current body to be editable. It does not create a second positioned text box.

## Full application proof

The acceptance runner builds the actual `index.html`/`src/main.tsx` entry and boots the real application. Its probe observes real editors, engines, stores and repository writes; it does not replace the application or seed document objects. The sample is labelled synthetic formatted HTML, not reconstructed private clipboard content.

Electron acceptance also compiles and runs the actual `electron/main.ts` and preload with native file URLs, IPC, sandbox and context isolation. Profile/workspace roots are disposable. The automation window is hidden, offscreen, unthrottled and sized for testing. Offscreen rendering is required because a hidden ordinary test window stopped delivering animation frames after reload; the proposed application geometry workaround was removed when this was diagnosed. Disposable setup marks legacy migration complete; these runs are not a claim about first-run migration or a user's existing profile.

Fresh full-app evidence:

- [Chromium results](../../artifacts/documentation-corrective/verify-ui-web-web.json), [Electron results](../../artifacts/documentation-corrective/verify-ui-electron-electron.json).
- [Three filled sheets](../../artifacts/documentation-corrective/verify-ui-web-web-three-sheets.png), [readable Electron code/table](../../artifacts/documentation-corrective/verify-ui-electron-electron-readable-code-table.png), [conversion action](../../artifacts/documentation-corrective/verify-ui-electron-electron-conversion-action.png), [font panel](../../artifacts/documentation-corrective/verify-ui-web-web-font-panel.png).

The long paste fills sheets **1 through 11**, verified using actual rendered text ranges rather than empty frame count. Twelve early paragraphs increase the sheet count from **11 to 13** and move later text by more than one sheet. Deletion pulls text backward; native undo/redo restore exact JSON. Save completion and reload preserve one body. Table edits, Markdown cancel/insert, cross-sheet formatting, searchable transformations and slash keyboard commands use the visible UI and existing editor history.

Conversion preserves the complete source backup, a second positioned note and a drawn rectangle, including exact undo/redo and persisted reopen. The same document switches to Infinite without changing its JSON; its writing width remains **666 px**, its content height is approximately **10,397 px**, and its canvases remain bounded. The earlier Freeform page remains unchanged on page handoff.

Final full-app runs also pass the footer chooser/insertion and exact saved Freeform reopen checks: [Chromium final](../../artifacts/documentation-corrective/verify-footer-web-web.json) and [Electron final at 125% display scaling](../../artifacts/documentation-corrective/verify-footer-native-electron.json). The Electron run inserts after the earlier Freeform page in the middle of the section and verifies the resulting order. See [reopened Freeform](../../artifacts/documentation-corrective/verify-footer-native-electron-freeform-reopened.png) and [final three-sheet overview](../../artifacts/documentation-corrective/verify-footer-native-electron-three-sheets.png).

## Performance measurements

Four sequential controlled runs use the same application entry, content, UI and nine workloads. The before build changes only `notifyChange('document-text')` back to `notifyChange()`, restoring the earlier scene publication path. The transform is asserted to have applied. Electron uses the real main process/file renderer in both cases. See [complete comparison](../../artifacts/documentation-corrective/performance-comparison.json) and its referenced Chrome DevTools CPU profiles.

| Workload | Chromium before / after | Electron before / after |
| --- | --- | --- |
| 12 A4 keys: application React commits | 36 / 0 | 36 / 0 |
| 12 A4 keys: React work, ms | 35.7 / 0 | 35.4 / 0 |
| 12 A4 keys: editor dispatch, ms | 114.4 / 122.9 | 151.8 / 153.6 |
| 12 A4 keys: browser layout, ms | 49.3 / 54.8 | 71.1 / 69.5 |
| 12 A4 keys: immutable scene captures | 12 / 12 | 12 / 12 |
| 12 A4 keys: canvas redraws | 0 / 0 | 0 / 0 |
| 9 code keys: application React commits | 27 / 0 | 27 / 0 |
| 9 code keys: React work, ms | 26.1 / 0 | 27.4 / 0 |
| A4 input-to-two-frames p50 / p95, ms | Before 117.6 / 126.9; after 113.1 / 126.0 | Before 30.9 / 39.2; after 30.0 / 36.1 |

The measured fix avoids publishing identical notebook geometry and layer state on each document edit. The live editor owns its DOM. Every edit still synchronously captures immutable page-owned data and enters the existing save scheduler; property changes, save completion and page handoff publish normally. Twelve keys still produce twelve editor JSON reads and captures, with no per-key repository write. Each selection workload observed one later debounced write, and exact persisted/reopened content is checked separately.

These are single-run inclusive timings from a profiling build. Frame markers begin at `beforeinput` and end after two animation-frame callbacks; they are not physical input-to-paint latency. React work decreases reliably by count, while dispatch/layout and Chromium frame timings vary. This does not establish a general latency improvement. Paste and page transitions still produce long tasks; large-document DOM and cold application chunks remain costs. Canvas scrolling still redraws ten times for ten wheel steps. Selection/save work is retained.

## Validation and boundaries

| Fresh check | Result |
| --- | --- |
| Final local production build, including application/Electron typechecks | Passed; [build log](../../artifacts/documentation-corrective/build-delivery.log) |
| Main npm test suite and pretest gates | 651 passed, 1 WinRT-production-path skip, 0 failed in the 652-test main suite |
| Focused final unit checks | 72 passed |
| Pagination runtime | Chromium 25/25; Electron 26/26 |
| Authoring runtime | Chromium 16/16; Electron 16/16; native file renderer 16/16 |
| Rich text runtime | Chromium 24/24; Electron 24/24 |
| Documentation engine runtime | Electron 35/35 |
| Notebook/PDF input | 16 groups in each runtime |
| Handwriting placement | 42 geometry scenarios in each runtime |
| Navigation after the footer pointer fix | 29 browser regressions; [log](../../artifacts/documentation-corrective/navigation-final.log) |
| Notebook/PDF interaction and toolbar layout | 24 groups in each runtime |

[Regression summary](../../artifacts/documentation-corrective/regression-summary.json) and individual logs are retained with earlier failed diagnostic runs. Stale menu selectors, presentation-only JSON defaults, omitted undefined fields and hidden-window frame delivery were corrected in the harness. Source-selection priority, keyboard focus restoration, conversion typography, toggle targeting and footer pointer ownership were application fixes. Native code-copy tests used and restored the clipboard's standard formats. Whole-document formatted input used synthetic ClipboardEvents through real application handlers.

The original 91-file dirty-tree snapshot is preserved outside the repository. [Preservation audit](../../artifacts/documentation-corrective/working-tree-preservation.json) records zero missing original files; [corrective-only comparison](../../artifacts/documentation-corrective/corrective-only.diff) compares extensions against that snapshot rather than assuming HEAD was clean. Existing handwriting, PDF, navigation, drawing, cloud and compatibility implementations remain in place. This is local build/runtime evidence, not live Google Drive, physical-device, PDF document-export or release acceptance. No user profile or notebook data was reset or migrated; no commit, push, merge, deployment or release was performed.
