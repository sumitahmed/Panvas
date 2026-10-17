# Panvas documentation workflow repair - 2026-10-14

The application now exposes **New item -> New Document**, with flowing text and A4 selected by default. A substantial formatted paste produces eleven automatic sheets through that UI in Chromium and Electron. Earlier edits add sheets, deletion pulls later text backward, and the same canonical document survives undo/redo and repository save/reopen. Existing Freeform pages and their movable objects retain their content and geometry.

Checkpoints A, B and C have end-to-end runtime evidence. Checkpoint D has runtime evidence for the compact controls and measured reductions in selection rendering and some layout/dispatch work. Performance remains mixed; this is not a claim that every operation or very large document is free of lag.

## A - Diagnosis

The matching local recording is `Screen Recording 2026-10-14 084546.mp4` (59.833 seconds, 1918 x 1198). I sampled its entire visual timeline at one frame per second and inspected three contact sheets. This is visual sampling, not a claim of continuous playback or access to the original clipboard bytes. The recording shows a movable Freeform object on Page 2, an independently owned following page, and the crowded Aa panel.

Ordinary creation followed Sidebar -> New Page -> the inline page-name row -> `createNotebookPage(section, title)`. That path initialized an empty Freeform drawing. Text-tool paste then created a positioned text object: the measured width was 300 logical pixels in both runtimes. Automatic document flow existed, but its entry was the Writing layout setting inside the page inspector. Enabling it there created the special document body. The following manual notebook page was never a continuation target for the Freeform box.

The old Aa surface mounted typography, paragraph controls, block operations, table tools, equations, references and a Markdown textarea together. Its default panel exposed 45 controls and reached 660px in Chromium and 648px in the controlled Electron comparison. Merely having pagination code did not make ordinary creation use it.

An additional first-run Electron problem reproduced during the full application test: a deferred workspace refresh retained a startup snapshot, so later creation reloads could publish stale metadata. Notebook/section activation and expansion also issued overlapping native metadata writes. The repair limits the snapshot to startup reads, orders activation before expansion, and guards against a later user selection changing the target.

Evidence: [recording timeline](../../artifacts/documentation-workflow-repair/recording/timeline-01.jpg), [ordinary Chromium paste](../../artifacts/documentation-workflow-repair/paired-before-web-ordinary-paste.png), [old controls](../../artifacts/documentation-workflow-repair/paired-before-electron-formatting.png), [initial native failure](../../artifacts/documentation-workflow-repair/native-first-run-stale-bootstrap.log).

## B - Functional repair

The existing New item menu now offers New Document. Its existing creation dialog starts in Document layout and A4 paper, with A3, A5, Letter and Infinite choices and an explicit Freeform alternative. The repository receives page-owned overrides and one schema-v3 `TextObject` with `documentRole: body` before activation. A transient focus request selects the Text tool and focuses only the newly created document. Generic New Page and existing notebook defaults keep their Freeform behavior.

The visible Document/Freeform and paper-size label belongs to the existing workspace controls. It sits outside toolbar sizing, so it does not remove Text or Hand access at narrower widths. The same writing-layout setting remains in the inspector. Existing boxes and annotations are not converted into fragments or repositioned.

One logical ProseMirror document, editor history and drawing persistence record own all automatic sheets. They are derived physical writing areas, not independently saved notebook pages. No editor framework, database, new block types or data migration was added.

| Full application assertion | Chromium | Electron |
| --- | ---: | ---: |
| A4 writing width, Normal margins | 666px | 666px |
| Automatic sheets after the 60-paragraph formatted paste | 11 | 11 |
| Sheets after twelve substantial paragraphs inserted near the beginning | 13 | 13 |
| Later paragraph 40: initial logical Y | 8218 | 8218 |
| Later paragraph 40: after early insertion | 10776 | 10776 |
| Later paragraph 40: after deletion near the beginning | 8490 | 8490 |
| Undo/redo restores exact canonical JSON | Pass | Pass |
| All sixty original paragraph markers occur exactly once | Pass | Pass |
| Cross-sheet selection and bold formatting | Pass | Pass |
| Code editing, table-cell editing and row insertion/undo | Pass | Pass |
| One body and exact JSON after autosave/reload | Pass | Pass |
| Freeform content and geometry survive page handoff unchanged | Pass | Pass |

Evidence: [three automatic sheets](../../artifacts/documentation-workflow-repair/verify-final-web-three-sheets.png), [readable code and table](../../artifacts/documentation-workflow-repair/verify-final-electron-readable-code-table.png), [sheet continuation](../../artifacts/documentation-workflow-repair/verify-final-web-a4-continuation.png), [Chromium assertions](../../artifacts/documentation-workflow-repair/verify-final-web.json), [Electron assertions](../../artifacts/documentation-workflow-repair/verify-final-electron.json). The three-sheet overview is intentionally zoomed out; the separate code/table image provides readable detail.

## C - Infinite verification

The existing Infinite implementation remains in place: a fixed 794px physical width, 666px writing width with Normal margins, a continuous body and finite viewport raster windows. The same paste grows the editor from an empty document to 10,396 logical pixels high, with a finite 11,008px extent. There are zero pagination-gap widgets inside the Infinite body. Ending edits persist exactly after autosave and reload.

Observed maximum canvas areas in the final full-app scenes were 2,032,640 pixels in Chromium, 2,016,760 in Electron and 1,846,050 in the DPR 1.25 verification. Every inspected allocation stayed under the existing 16MP cap. The editable DOM remains unvirtualized.

A real zoom integration defect was corrected: inspector buttons and keyboard supplied relative factors, but the notebook handler treated them as absolute scales. Before the repair, two In clicks produced 1.1 -> 1.1. They now produce 1.0 -> 1.1 -> 1.21; the 100% action returns to 1.0. Fit-width was adjusted for that same factor contract. Existing input, PDF zoom, navigation and distant-coordinate regression suites passed.

Evidence: [Infinite application view](../../artifacts/documentation-workflow-repair/verify-final-electron-infinite.png), [failing zoom check](../../artifacts/documentation-workflow-repair/zoom-before-web.log), [DPR 1.25 assertions](../../artifacts/documentation-workflow-repair/verify-dpr-electron.json), [first-run desktop assertions](../../artifacts/documentation-workflow-repair/verify-first-run-electron.json).

## D - Controls and measured performance

The refreshed skill inventory contains 215 SKILL.md files / 143 unique names: 82 Codex, 70 agent, 47 cached-plugin, 14 project and two memory entries. Cached duplicates are included in that inventory; it does not assert that every listed package is active. Applied guidance: focused-fix, frontend-design, emil-design-eng, performance-profiler and playwright-pro. The UI uses existing Panvas color tokens, Inter chrome, editor fonts, focus rings and anchored overlays. New high-frequency menu interactions do not add animation.

| Before | After | Why |
| --- | --- | --- |
| One long panel containing 45 controls | Text, Paragraph, Insert, Block, and contextual Table sections; 17 controls in the default section | Keep the current task visible without exposing every command |
| Default Aa panel up to 660px tall | 288px wide by 335px tall in both full-app runtimes | Reduce document coverage |
| Markdown textarea inside ordinary formatting | Dedicated Paste Markdown dialog; originating menu closes | Make a deliberate paste operation separate from formatting |
| Headings/lists mixed with every document feature | Existing heading/list/quote/code toggles in Paragraph; block conversion/actions in Block | Preserve selected-range commands and shared block commands |
| Equations and references always exposed | Small named Insert subpanels | Show source fields only when requested |
| Keyboard command could leave focus in a closing menu | Synchronous editor focus after commands and dialog close | Keep immediate undo and subsequent typing in the canonical editor |
| Mode label reduced available tool width | Small persistent caption below workspace controls | Preserve toolbar access and show the active writing mode |

Code blocks retain the existing attached language/wrap/copy/caption controls and Lowlight highlighting. Links, lists, table operations, equations, conversion and Markdown use the existing commands. The full application verifies tab arrow navigation, cross-sheet bold, editable cells, row undo, Markdown cancel without mutation and Markdown insertion followed by exact undo.

Evidence: [document formatting](../../artifacts/documentation-workflow-repair/verify-final-electron-document-formatting.png), [dedicated Markdown dialog](../../artifacts/documentation-workflow-repair/verify-final-web-markdown.png), [skill inventory](../../artifacts/documentation-workflow-repair/skill-inventory.json).

### Performance method and limits

Profiles use the full `mountPanvas` application with its Library, creation UI, stores, persistence and notebook renderer. The observer fixture does not seed a fake editor or drawing state. It uses disposable Chromium contexts and disposable native filesystem/profile roots, production React profiling builds, CDP CPU sampling at 1ms, layout-duration metrics and counters for transactions, React commits, editor JSON, scene capture/cloning, serialization, redraws, ResizeObserver and repository writes.

The controlled before build substitutes the three original controls/pagination files from the 80-file task-start snapshot into the repaired application. Both variants therefore reach the same A4 document through New Document. The after build uses the repaired files. Each runtime executes the variants sequentially with the same corpus: 12 prose keys, nine code keys, 40 selection keys, ten wheel scrolls, rich paste, save observation and a two-page transition. Raw CPU profiles and JSON remain available. The later full-app and regression verification runs are functional evidence, not additional performance comparisons.

The source changes remove an offsetWidth read from every pagination view update; ResizeObserver and existing explicit layout/font events retain invalidation. The formatting strip now refreshes its own state only when visible marks, attributes or contextual tools change. Remaining per-character document snapshots, pagination, code highlighting, layout and page-mount work are visible in the profiles. Inclusive measurements overlap and must not be added together as independent wall time.

| Runtime / operation | Before | After |
| --- | ---: | ---: |
| Chromium / A4 typing, input-to-two-rAF p95 (ms) | 111 | 109 |
| Chromium / A4 code editing, input-to-two-rAF p95 (ms) | 108.4 | 110.6 |
| Chromium / 40 selection keys, React commits | 50 | 9 |
| Chromium / 40 selection keys, inclusive React work (ms) | 16.2 | 6.5 |
| Chromium / page transitions, dispatch work (ms) | 11.8 | 4.9 |
| Chromium / A4 rich paste, workload elapsed (ms) | 273.6 | 270.6 |
| Chromium / Infinite rich paste, workload elapsed (ms) | 207.7 | 268.1 |
| Electron / A4 typing, input-to-two-rAF p95 (ms) | 33.3 | 32.8 |
| Electron / A4 code editing, input-to-two-rAF p95 (ms) | 33.2 | 32.5 |
| Electron / 40 selection keys, React commits | 50 | 10 |
| Electron / 40 selection keys, inclusive React work (ms) | 19 | 7.6 |
| Electron / page transitions, dispatch work (ms) | 15.1 | 5.6 |
| Electron / A4 rich paste, workload elapsed (ms) | 285.4 | 179.7 |
| Electron / Infinite rich paste, workload elapsed (ms) | 116 | 130.3 |

Selection rendering decreased reliably in these runs: 50 commits became nine in Chromium and ten in Electron. Typing changed slightly; Chromium code p95 worsened, Infinite paste elapsed increased in both runtimes, and cold page transitions still produced long tasks. Scroll time was essentially flat. A4 typing/code/selection/scroll produced no observed long tasks in the paired workload. There is no uniform speedup or zero-lag claim. Input-to-two-rAF is a sampled scheduling metric, not physical-device input latency.

The complete [comparison](../../artifacts/documentation-workflow-repair/performance-comparison.json) includes elapsed, layout, React, dispatch, capture, transaction, redraw, heap and long-task figures for all ten workloads. Original [before Chromium data](../../artifacts/documentation-workflow-repair/paired-before-web.json) and [after Electron data](../../artifacts/documentation-workflow-repair/paired-after-electron.json) link CPU profiles by filename.

## Fresh validation

| Check | Fresh result |
| --- | --- |
| Application + Electron TypeScript | Pass |
| npm test | 651 pass, one WinRT production-provider test skipped; pretest gates passed |
| Full application UI / save-reopen | Pass, Chromium and Electron |
| Full application native first-run and DPR 1.25 | Pass |
| Document-flow runtime | 25/25 Chromium; 26/26 Electron |
| Authoring runtime | 16/16 each; 16/16 native file renderer, including system clipboard |
| Shared documentation engine | 35/35 each |
| Rich-text pipeline / persistence | 24/24 each |
| Document input, including PDF input/zoom | 16 groups each |
| Handwriting/H2T placement geometry | 42 scenarios each |
| Navigation | 29 real-renderer groups |
| Responsive layout/input | 33 groups |
| Interaction / sticky / theme | 24 groups each |
| Final shared-controls check after dialog dismissal change | 3/3 each |
| Diff whitespace check with repository CRLF handling | Pass |

Logs are in [the evidence directory](../../artifacts/documentation-workflow-repair/). Handwriting placement and input suites are simulated geometry/input regression evidence. The skipped test is **Windows production provider and worker complete the real WinRT async path**; this task does not establish fresh physical-pen or live WinRT recognition acceptance.

Initial failures remain separate from final passes. The wider mode caption initially pushed Text into overflow in a standalone flow fixture; the final caption no longer participates in toolbar width. An interaction run was interrupted by Vite HMR while source was being edited; the frozen-source native rerun passed. A reload helper initially accepted an async predicate before autosave completed; it now polls the actual repository body and awaits an exact match. Those failed/interrupted runs are not counted as final acceptance.

## Preservation and remaining work

Branch remains `main`, HEAD `a1f301797a72eac165ca37afb87df2bd78c3b695`. Against `local snapshot: panvas-documentation-workflow-baseline-20261014`, all 80 starting files remain present: 71 are byte-identical and nine are extended. Six previously clean application files were modified for entry/creation/mode/navigation, and the Markdown dialog plus full-app test fixtures are new. Historical reports, the lockfile and drawing/input engine work remain byte-identical to that snapshot. No reset, destructive migration, commit, push, merge, release or deployment was performed.

All application writes in these tests target disposable profiles/workspaces. The existing user workspace was not opened by the test application or restored from a snapshot. An end-of-task read-only drawing hash differs from the earlier stabilization-run hash; that older hash is not a contemporaneous baseline and is not used as proof of byte identity. No user drawing was rewritten or restored by this task.

Cold page transitions and very large unvirtualized documents remain performance limits. The existing document/Infinite PDF-export and document-asset work stays deferred from the earlier milestone. Physical Windows Ink provider acceptance remains unverified because that production-provider test was skipped. The automated runtime evidence above is local acceptance, not a released installer, production cloud or physical-device certification.

For manual use, select a notebook section and choose **New item -> New Document -> A4 -> Create**, then paste into the automatically focused body. Choose New Page for Freeform handwriting and movable text. The already-running normal app was not replaced; close it and run `npm start` to build and launch the updated working tree. Repeat the application acceptance with `npm run test:documentation-workflow`.
