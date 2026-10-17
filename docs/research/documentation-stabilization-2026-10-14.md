# Panvas documentation stabilization review

Continued the existing documentation-flow and Infinite Pages work on `main`, based on `a1f3017`. Investigation and paired profiling began on October 13; the final correctness checks completed on October 14. This report supplements the [previous milestone handoff](documentation-flow-milestone-2026-10-13.md); its historical evidence has not been rewritten.

The recorded table collapse, explicit language normalization, long-paste editor handoff, redundant pagination, and code-control layout have corrective changes with local runtime evidence. The final flow, authoring, persistence, input, and PDF/mobile checks pass. **The large-document performance gate remains partial:** Chromium latency regressed in several paired workloads, and native 5,000-paragraph code editing and reopening still have substantial stalls. These results do not establish production readiness or uniformly responsive editing at arbitrary sizes.

## Skills used

The available catalog and tool metadata were checked before substantial implementation. Filesystem discovery found **215 SKILL.md files with 143 distinct names**, including duplicate installations and cached packages: 82 under the user Codex skills directory, 70 under the user agents directory, 47 in plugin caches, 14 in the project, and two in memory. Cached files are not all active tool capabilities. No callable skill-list/read API was exposed by the enabled tools. The complete local inventory is [skill-inventory.json](../../artifacts/documentation-stabilization/skill-inventory.json).

| Read and applied skill | Effect on this patch |
| --- | --- |
| focused-fix | Scoped the investigation to the existing editor/layout flow; traced the actual saved attributes and runtime ownership before changing code. Preserved the starting work and persistence model. |
| performance-profiler, including its optimization playbook | Captured paired production profiling builds, CPU samples, React durations, transaction counts, layout costs, long tasks and heap snapshots. Kept regressions in the results and measured intermediate changes. |
| [frontend-design](../../.agents/skills/frontend-design/SKILL.md) | Retained Panvas's warm interface and existing code surface, with an attached utility header and restrained syntax palette. The rest of the application was not redesigned. |
| [emil-design-eng](../../.agents/skills/emil-design-eng/SKILL.md) | Used clear grouping, visible copy feedback, optional caption controls, keyboard focus states, pointer-specific hover styles and no extra animation in frequent editing operations. The UI comparison below follows its Before/After/Why format. |
| playwright-pro | Exercised real notebook components, UI controls, native input, repositories and Electron IPC in disposable profiles; used semantic locators, explicit readiness and actual screenshots. |

The focused-fix skill references `superpowers:systematic-debugging` and `superpowers:verification-before-completion`; those packages were unavailable and are not claimed as used. No dependencies or unrelated tools were installed for stabilization.

## Recording and reproduced defects

The recording was found at `Screen Recording 2026-10-13 190559.mp4`. Its 19:05 local-minute stamp and visible scenes match the supplied recording description. It is 42.700 seconds, 1918×1198 at 30 fps. The complete visual timeline was inspected at one-second intervals, with closer inspection of 34–38 seconds and full-resolution frames at the reported problem points. Audio was not used. [Timeline one](../../artifacts/documentation-stabilization/recording/timeline-01.png), [timeline two](../../artifacts/documentation-stabilization/recording/timeline-02.png), and [navigation transition](../../artifacts/documentation-stabilization/recording/transition.png) are local artifacts.

Read-only inspection of the corresponding saved Page 3 found one Freeform TextObject, **300 logical pixels wide**, containing 132 nodes. The page and object had no document-flow metadata. Its code blocks were saved as `plaintext` and `yaml`; its three-column table had `colspan: "undefined"` in the cells. The independent `java` text was already part of the saved content. The original external clipboard HTML is unavailable, so the upstream cause of that separate label and the first Plain Text value cannot be established from the recording alone. They were not inferred from the code's appearance or silently removed.

The actual source drawing file was only read. Its SHA-256 remained `6D57EAF3FFEDB00A6897531F2DDF062F8C2899E1EB7B75624FC7DCAE799A5166` at the final check. A content-only copy was used in disposable local fixtures, kept in ignored artifacts rather than shipped tests.

| Reproduction | Root cause and corrective change | Evidence |
| --- | --- | --- |
| Comparison Summary collapsed into narrow columns in active and static views | Native table column generation iterated over the malformed string span and produced no columns, including an inline `width: 0px`. Valid spans are now parsed explicitly; legacy spans are repaired for the view without mutating saved JSON on opening. Columns have a 120-pixel logical minimum and native horizontal scrolling when the table exceeds its container. Authored table structure and merged-cell attributes remain intact. | Baseline static columns were approximately 34/36/34 px; final static columns are 120/120/120 px. The actual recorded document remains editable and survives save/reopen. |
| Explicit language names such as `Java`/`JAVA` could miss the grammar casing; an explicit HTML wrapper bypassed the common alias path | Known names and aliases now use the installed Lowlight grammar keys on view preparation and import. HTML maps to the XML grammar; unknown labels retain their exact spelling. Source bytes are preserved. Raw stored language values are unchanged on opening, and no language is guessed from a nearby heading. | Runtime highlighting, whitespace, native undo, active/static token parity and unknown-language tests pass. The recorded first block highlights after choosing Java explicitly. |
| Copying Panvas's static HTML could paste derived language/caption UI as extra prose | The sanitizer now removes only known Panvas control/caption elements before parsing code. Semantic caption attributes and independent source paragraphs remain. | Static-HTML round-trip tests assert no duplicate control/caption text. |
| Long native Freeform paste switched engine ownership to the next manual page and destroyed the editor | The dominant-page observer previously protected only the document body. It now preserves the owner of any connected focused notebook editor or its associated control surface during passive visibility changes. Explicit navigation still works. | Baseline paste lost the original owner and destroyed the editor in both runtimes; final paired paste retains ownership with no editor destruction. |
| Hidden static preview work repeated on every live Freeform edit | The hidden static text tree regenerated HTML, sanitization and highlighting while a live editor already owned the page. Its snapshot now stays stable until handoff, where the current data is rendered. PDF static text remains live because that subtree is visible. | The intermediate native Freeform React measurements below isolate the large drop after this change; sanitization samples disappeared from the final typing CPU profile. |
| Schema reconstruction repeated after the editor's own edits; a code-only Freeform edit could miss schema-version tagging | JSON produced by the current editor is trusted within that editor instance, while externally loaded/replaced content still receives compatibility/schema checks. Freeform metadata now uses the content's required version even when only code options or combined marks require schema 3. | Unknown/newer payload protections, no-op opening, valid editing and code-caption version tagging pass. Immutable drawing snapshots remain enabled. |
| Opening a language menu caused pagination and toolbar work; Infinite dispatched unnecessary page decorations | Language-picker disclosure no longer schedules document pagination. Infinite measures height without publishing empty decorations. Fixed pages avoid empty clears and unnecessary short-table fitting; the toolbar ignores presentation-only transactions. Selecting the current language is a no-op document command. | A4 menu pagination: 18→0 transactions for three opens; Infinite: 12→0. Keyboard selection of the current language makes zero document writes and preserves the code caret. |
| Shift+ArrowUp could stick after ArrowDown crossed a paper seam | At a wrapped line's far edge, `posAtCoords` returned the next visual line's caret. A bounded adjustment now keeps the requested target in the intended visible row and respects UTF-16 surrogate pairs. | The reproduced down target changed from 1936 to 1935; backward selection crosses the same seam. Final Chromium/Electron flow suites pass without changing canonical JSON. |
| Distant Infinite pen caps lost pixels during a partial redraw | Absolute Path2D coordinates and successive large canvas offsets exposed raster precision loss at 50 million pixels. Distant cached paths now use a local origin, and cancelling offsets are composed before sending the small final matrix to the rasterizer. Ordinary paths keep their previous rendering. Persisted samples are unchanged. | Repeated native failure had the nearest painted pixel three backing pixels away; the corrected native and Chromium gestures paint the endpoint. Three fractional-position comparisons have zero channel difference from equivalent nearby strokes. |

At 34–37 seconds the recording activates **empty manual Page 4**, then returns to Page 3. That observed blank view was expected navigation. No data-loss claim is made. The separate long-paste ownership defect above was reproduced through runtime instrumentation. Final save/reopen and page-handoff checks found no lost or duplicated canonical content.

## UI review and screenshots

| Before | After | Why |
| --- | --- | --- |
| Cramped controls mixed with a full caption input | Attached language header, grouped Wrap/Copy actions and a compact caption button; caption input appears when requested or saved | Keeps frequent actions visible and reserves writing space for source code. |
| A dropdown offset from its trigger | Searchable popup aligned to the language trigger, clamped or flipped within the viewport | Retains a clear connection to the block while avoiding the paper mask. |
| Ambiguous copy feedback | Copy changes to Copied or Retry, with a live status announcement | Makes the result observable without moving focus. |
| Oversaturated token colors and inconsistent static presentation | Shared code typography, charcoal surface, muted token palette, language header and caption treatment in static rendering | Makes reading consistent across editing and page handoff. |
| Narrow columns forced words into letters | Minimum column widths, horizontal scrolling, visible scrollbar and a keyboard-focusable region | Keeps content readable without shrinking typography or clipping it away. |
| Per-block global popup listeners always active | Outside-click, resize and scroll listeners exist only while the popup is open and are removed on close/destroy | Avoids unnecessary listener work in documents with multiple code blocks. |

Screenshots below come from the real NotebookRenderer in disposable application fixtures, including file-backed Electron. They were visually inspected. They are local artifacts, not design mockups or screenshots of a released installer.

- [Recorded Java block, light](../../artifacts/documentation-stabilization/electron-file-code-light.png) and [dark](../../artifacts/documentation-stabilization/electron-file-code-dark.png).
- [Recorded Comparison Summary after repair](../../artifacts/documentation-stabilization/electron-file-recorded-table.png).
- [A4 technical document with separate code/output and wide table](../../artifacts/documentation-stabilization/final-electron-A4-120-table.png) and [the same content in Infinite](../../artifacts/documentation-stabilization/final-electron-Infinite-120-table.png).
- [300-pixel static table with visible overflow scrollbar](../../artifacts/documentation-stabilization/final-electron-malformed-static-table.png) and [keyboard horizontal scroll to the last column](../../artifacts/documentation-stabilization/final-electron-table-horizontal-scroll.png).
- [Narrow code controls](../../artifacts/documentation-stabilization/final-electron-narrow-code.png) and [language menu at 800-pixel window width / 75% zoom](../../artifacts/documentation-stabilization/final-electron-code-menu-800-0.75.png).
- Combined acceptance document: [A4 table and lists](../../artifacts/documentation-stabilization/electron-combined-A4-table.png), [rendered inline/block equations at an A4 seam](../../artifacts/documentation-stabilization/electron-combined-A4-math.png), and [the same equations in Infinite](../../artifacts/documentation-stabilization/electron-combined-Infinite-math.png).

Both runtimes also checked control bounds and popup bounds at 800/1440-pixel window widths and 75%/150% notebook zoom. Native scrolling exposes the remaining table columns. These checks do not establish physical touch-target usability at every document zoom.

## Performance method and results

Paired runs used the same 120-, 1,000- and 5,000-paragraph technical corpus with headings, formatted prose, links, lists, Java, separate output and a seven-column table. Freeform was measured at 120 paragraphs, A4 at 120/1,000, and Infinite at 120/1,000/5,000. Actual equations and structural math were exercised in the flow/authoring suites; the profiling corpus's TeX delimiter example remained literal text and is not evidence of rendered math.

Hardware: Ryzen 5 5600H, 12 logical CPUs, approximately 16 GB RAM, Windows build 26300, DPR 1. Browser: Chromium 148.0.7778.96. Native: Electron 43.3.0 / Chromium 150.0.7871.212. Each profiling runtime used a disposable production bundle with `react-dom/profiling`; the native fixture bundled the current preload and domain handlers and used an isolated workspace/profile. This measures the actual notebook implementation, not a packaged installer, live cloud provider or physical pen device.

Each document measured formatted paste, idle, 12 ordinary keystrokes, eight code keystrokes, three menu opens, three language changes, six table keystrokes, 60 scrolling frames, tool changes, and save/leave/reopen. Existing-object movement was measured separately through a native drag with 12 move steps. CPU sampling was 1 ms. React durations, transaction/serialization/clone counters, ResizeObserver callbacks, browser layout/style/script time, long tasks and post-workload heap usage were recorded. Inclusive counters overlap and must not be added together. Heap values are not a retained-memory/leak study.

The input latency measure is **beforeinput to the second requested animation frame**, not proof of when pixels reached a physical display. Samples are small, profiling adds overhead, and no repeated-run confidence interval is claimed. Chromium and offscreen Electron are separate environments and should not be compared as a platform ranking. Complete measurements and CPU profile filenames are in [comparison.csv](../../artifacts/documentation-stabilization/comparison.csv), [comparison.json](../../artifacts/documentation-stabilization/comparison.json), and the [final browser](../../artifacts/documentation-stabilization/final-web.json)/[native](../../artifacts/documentation-stabilization/final-electron.json) reports.

The paired profiling snapshot precedes the final caret-affinity, HTML-wrapper alias and distant-path correctness adjustments. Those cases are outside the typing corpus; the benchmark was not relabelled as a new timing run after those edits. Final functional checks use the final source.

### Electron latency

All values are p95 milliseconds. Typing/code/table use 12/8/6 input samples; scrolling uses 60 frame intervals.

| Layout / paragraphs | Ordinary typing | Code editing | Table editing | Scroll frame |
| --- | ---: | ---: | ---: | ---: |
| freeform / 120 | 59.7 ? 32.2 | 43.5 ? 32.1 | 33.7 ? 32.3 | 18.2 ? 18.3 |
| A4 / 120 | 48.1 ? 33.3 | 46.4 ? 32.8 | 43.7 ? 32.3 | 17.7 ? 17.8 |
| A4 / 1000 | 106.6 ? 93 | 94.5 ? 60 | 79.6 ? 51.1 | 17.7 ? 17.6 |
| Infinite / 120 | 32.5 ? 33.6 | 32.9 ? 33.5 | 33.1 ? 32.4 | 17.9 ? 17.5 |
| Infinite / 1000 | 32.9 ? 33 | 40.7 ? 37.8 | 32.8 ? 31.9 | 17.8 ? 17.7 |
| Infinite / 5000 | 144.4 ? 69.5 | 85.8 ? 122.3 | 71.5 ? 61 | 18.7 ? 18.1 |

Cumulative React work below is commit count / milliseconds for the whole keystroke workload, not per key.

| Layout / paragraphs | Typing commits / ms | Code commits / ms | Typing pagination transactions |
| --- | --- | --- | --- |
| freeform / 120 | 25 / 171.8 ? 25 / 23.8 | 17 / 142.7 ? 17 / 14.4 | 0 ? 0 |
| A4 / 120 | 45 / 28.8 ? 36 / 15.2 | 25 / 18.4 ? 24 / 12.5 | 36 ? 12 |
| A4 / 1000 | 36 / 46.5 ? 36 / 20 | 24 / 29.2 ? 24 / 11.9 | 36 ? 14 |
| Infinite / 120 | 48 / 22.3 ? 36 / 14 | 31 / 14.9 ? 24 / 10.1 | 24 ? 0 |
| Infinite / 1000 | 49 / 40.4 ? 36 / 14.6 | 25 / 28.8 ? 24 / 9.3 | 24 ? 0 |
| Infinite / 5000 | 42 / 153.6 ? 36 / 14.5 | 24 / 90.8 ? 24 / 14.1 | 24 ? 0 |

### Chromium latency

All values are p95 milliseconds. Typing/code/table use 12/8/6 input samples; scrolling uses 60 frame intervals.

| Layout / paragraphs | Ordinary typing | Code editing | Table editing | Scroll frame |
| --- | ---: | ---: | ---: | ---: |
| freeform / 120 | 87.9 ? 86.3 | 112.1 ? 88.3 | 117.8 ? 198.8 | 53.9 ? 66.2 |
| A4 / 120 | 92.7 ? 146.9 | 92.8 ? 112.1 | 128.8 ? 86.3 | 71.2 ? 77.7 |
| A4 / 1000 | 116.2 ? 128.1 | 111.7 ? 133.2 | 139.9 ? 94.6 | 68.7 ? 71.8 |
| Infinite / 120 | 100.8 ? 123.1 | 72.8 ? 148.7 | 67.4 ? 84.9 | 59 ? 77.6 |
| Infinite / 1000 | 114.3 ? 82.5 | 71 ? 87.6 | 76.4 ? 76.6 | 63.3 ? 63.9 |
| Infinite / 5000 | 84.3 ? 58.5 | 90.6 ? 64.2 | 167.5 ? 135.7 | 84.1 ? 66.8 |

Cumulative React work below is commit count / milliseconds for the whole keystroke workload, not per key.

| Layout / paragraphs | Typing commits / ms | Code commits / ms | Typing pagination transactions |
| --- | --- | --- | --- |
| freeform / 120 | 25 / 125.9 ? 27 / 18.1 | 17 / 88.9 ? 17 / 11.2 | 0 ? 0 |
| A4 / 120 | 44 / 23.6 ? 36 / 15.9 | 27 / 14.6 ? 24 / 10.2 | 36 ? 14 |
| A4 / 1000 | 42 / 41.2 ? 36 / 16.3 | 27 / 25 ? 24 / 11.4 | 39 ? 14 |
| Infinite / 120 | 54 / 23.9 ? 36 / 18.5 | 31 / 12.8 ? 24 / 17.5 | 24 ? 0 |
| Infinite / 1000 | 50 / 43.8 ? 36 / 16.5 | 25 / 24.2 ? 24 / 10.7 | 24 ? 0 |
| Infinite / 5000 | 48 / 120.1 ? 36 / 14.4 | 24 / 89.8 ? 24 / 9.8 | 24 ? 0 |

### Existing-object movement

The small fixture moved the same rectangle through 12 native move steps. Timings include instrumentation and are not a general benchmark for ink-heavy pages.

| Runtime | React commits / cumulative ms | Canvas redraws / cumulative ms | Final object moved |
| --- | --- | --- | --- |
| web | 9 / 10.3 ? 9 / 6.1 | 14 / 4.6 ? 14 / 2.6 | (47.7, 93.0) from (25, 80) |
| electron | 5 / 7.8 ? 5 / 4.7 | 14 / 3.6 ? 14 / 2.7 | (47.8, 93.0) from (25, 80) |

The initial schema/transaction changes alone did not establish a Freeform render improvement. Native cumulative React typing time was 171.8 ms at baseline, 228.4 ms after that first step, **21.0 ms after freezing the hidden preview**, and 23.8 ms in the final profile. Eight code edits were 142.7→144.6→14.8→14.4 ms. This intermediate result determined the next change rather than treating memoization as sufficient.

Native A4/1,000 typing long tasks fell from 12 to two; code editing fell from eight to zero; language changes from nine to zero. Native Infinite/5,000 ordinary typing went from six long tasks to zero, but **code editing still had seven long tasks, up to 89 ms**, and its latency p95 regressed from 85.8 to 122.3 ms. Three language changes still had six long tasks, up to 148 ms. The table/owner correction is therefore not evidence that the largest documents are consistently responsive.

The full canonical `getDrawingData()` capture remains a bottleneck: at 5,000 paragraphs the final native code workload spent 130.7 ms across eight captures, with a 23.2 ms maximum; clone time was 130.5 ms of that overlapping work. The editable ProseMirror DOM is not virtualized. Lowlight work, large DOM construction, selection/layout and repository remounts remain relevant costs. Final post-workload heap readings ranged from 14.5–94.4 MiB in Chromium and 15.1–103.5 MiB in Electron; garbage collection timing makes individual before/after values variable.

Large paste and reopening remain blocking operations. Native Infinite/5,000 paste's maximum transaction dispatch was 331.6→325.1 ms and maximum long task 630→622 ms. Native save/leave/reopen's maximum long task regressed 898→1,054 ms, with total instrumented workload time about 2.25 seconds. Browser equivalents were 275.1→325.9 ms for paste dispatch and 841→720 ms for reopen's maximum long task. All six documents in each final runtime still saved/reopened with exactly equal canonical JSON and zero renderer errors.

Canvas redraws were not the dominant typing bottleneck: final native Freeform typing had zero redraws, and Infinite/5,000 typing had zero, compared with one each before. Movement retains the existing redraw behavior; the diagnostics include its counters rather than claiming drawing has been universally accelerated. At menu open, native A4 React commits were 12→0 and presentation transactions 18→0. Selecting the already selected language leaves the document untouched.

## Regression evidence

| Fresh local check | Result | Log |
| --- | --- | --- |
| TypeScript, browser and Electron configs | Pass | [typecheck-accepted.log](../../artifacts/documentation-stabilization/typecheck-accepted.log) |
| npm test, including pretest packages | 254 pretest checks; main suite 651 passed, one opt-in WinRT skip, zero failed | [unit-full-accepted.log](../../artifacts/documentation-stabilization/unit-full-accepted.log) |
| Table/language view unit regressions | 3/3 | [table-unit-accepted.log](../../artifacts/documentation-stabilization/table-unit-accepted.log) |
| Documentation flow | 4 model checks; 25/25 Chromium; 26/26 Electron; zero renderer errors | [flow-combined-accepted.log](../../artifacts/documentation-stabilization/flow-combined-accepted.log) |
| Documentation authoring | 16/16 Chromium and 16/16 Electron; zero renderer errors | [authoring-stabilized.log](../../artifacts/documentation-stabilization/authoring-stabilized.log) |
| File-backed Electron + recorded document | 17/17, including native copy and exact save/reopen; zero renderer errors | [authoring-recorded-file-stabilized.log](../../artifacts/documentation-stabilization/authoring-recorded-file-stabilized.log) |
| Recorded document, Chromium | 1/1 focused real-content group; zero renderer errors | [authoring-recorded-web-stabilized.log](../../artifacts/documentation-stabilization/authoring-recorded-web-stabilized.log) |
| Rich text pipeline | 24/24 in each runtime | [richtext-stabilized.log](../../artifacts/documentation-stabilization/richtext-stabilized.log) |
| Documentation engine | 35/35 in each runtime | [engine-stabilized.log](../../artifacts/documentation-stabilization/engine-stabilized.log) |
| Document input | 16 groups in each runtime, including 108 native starts and rapid-stroke pixel comparisons | [input-stabilized.log](../../artifacts/documentation-stabilization/input-stabilized.log) |
| Handwriting placement | 42 geometry scenarios in each runtime | [regression-handwriting-placement.log](../../artifacts/documentation-stabilization/regression-handwriting-placement.log) |
| Notebook navigation | 29 Chromium runtime regressions | [regression-notebook-navigation.log](../../artifacts/documentation-stabilization/regression-notebook-navigation.log) |
| Interaction UX | 24 runtime groups in each runtime, including Research Space, rotation, toolbar sizing and palettes | [regression-interaction-ux.log](../../artifacts/documentation-stabilization/regression-interaction-ux.log) |
| Table/code/movement diagnostic, Chromium | Pass; four window/zoom combinations; zero renderer errors | [diagnostics-web-accepted.log](../../artifacts/documentation-stabilization/diagnostics-web-accepted.log) |
| Table/code/movement diagnostic, Electron | Pass; four window/zoom combinations; zero renderer errors | [diagnostics-electron-accepted.log](../../artifacts/documentation-stabilization/diagnostics-electron-accepted.log) |
| PDF/mobile continuity, Chromium | Pass; 1,670 observations, zero visible missing/unready raster or annotations | [pdf-web-stabilized.log](../../artifacts/documentation-stabilization/pdf-web-stabilized.log) |
| PDF/mobile continuity, Electron | Pass; 2,016 observations, zero visible missing/unready raster or annotations | [pdf-electron-stabilized.log](../../artifacts/documentation-stabilization/pdf-electron-stabilized.log) |

The gate caught and retained failed attempts: the initial seam selection failure, distant ink failures, a cold browser startup timeout, the file-renderer's missing native titlebar-overlay setting, and an assertion that expected HTML rather than its canonical XML grammar. These were investigated; the native fixture now matches Panvas's titlebar configuration, fixture dependency scans are restricted to their own HTML entry points, and assertions check the corrected language contract plus actual highlighting. A diagnostic that expected a Java keyword token for `double`/`int` was corrected to the installed grammar's `hljs-type` class after inspecting that grammar's actual output. Assertions for content, selection, overflow, input and native clipboard were not disabled.

The final combined acceptance group uses a single technical document with a seven-column long-value table, embedded link, Java, separate Plain Text output, nested bullets, numbered steps, inline code, rendered inline/block equations and 32 substantial paragraphs. It spans eight A4 sheets, then switches to Infinite with identical canonical JSON. Both runtimes check all paragraphs exactly once, both equation nodes and renderings, readable column widths, keyboard horizontal scrolling, zero layout issues and exact JSON after repository leave/reopen. Its navigation readiness check uses the target page owner: the next manual page legitimately has its own document body from the earlier preservation scenario.

The earlier milestone's PDF readiness failure remains historical evidence in its original handoff. **Both fresh stabilization PDF/mobile runs passed**: Chromium observed zero missing/unready raster or annotation samples across 1,670 observations; native observed zero across 2,016. This does not prove the unrelated historical issue can never recur. The legacy integrity harness described in the prior milestone was not rerun against the user's normal profile.

## Preserved behavior and remaining gate

There is still one canonical Tiptap/ProseMirror document and history per body, saved in the existing TextObject/DrawingData repositories. A4/A3/A5/Letter continuation is derived; manual notebook pages remain separate. Infinite keeps fixed width and bounded raster/rebased scrolling. Absolute handwriting, shapes, images and positioned Freeform text keep their coordinates. No parallel editor or database was introduced.

Rendered math, lists, callouts, toggles, links, block operations, code/output separation, native undo, current-page annotation positions, fixed-paper boundaries, Infinite distant transforms and unknown/newer content protection are covered by the runtime suites. Table contents and structural edits survive persistence. No source document is rewritten merely by opening the repaired view.

The remaining performance evidence warrants manual review before further feature expansion. An incremental immutable scene-capture design and a dedicated editable-DOM scaling proposal would be needed to address the largest capture/remount costs without weakening history, persistence or compatibility. Neither was introduced as an unreviewed architectural rewrite in this patch. Dense documents with many independently highlighted code blocks, physical IME/pen/touch hardware, long-session retained-memory behavior and live cloud synchronization have not received fresh acceptance here. Extremely large indivisible blocks retain the existing layout limits. Document-flow/Infinite PDF export and Stage 3 inline-asset work remain deferred as recorded in the earlier milestone.

## Exact stabilization files

The starting snapshot contains 73 already dirty/untracked files. At final inspection, **54 were byte-identical**, 19 were extended, and none were missing. One initially clean tracked test was also updated. Package manifests/lockfile, the original research reports and other pre-existing work remained byte-identical to the stabilization snapshot. [Preservation audit](../../artifacts/documentation-stabilization/preservation.json) records the exact lists. Local evidence artifacts are ignored and are not part of the source patch.

| File | Stabilization change |
| --- | --- |
| [src/components/notebook/DocumentFlowEditor.tsx](../../src/components/notebook/DocumentFlowEditor.tsx) | View normalization and trust of current-editor JSON; external content remains guarded. |
| [src/components/notebook/DocumentTableView.ts](../../src/components/notebook/DocumentTableView.ts) | Readable native column widths, horizontal region and stable pagination tracks. |
| [src/components/notebook/FloatingTextEditor.tsx](../../src/components/notebook/FloatingTextEditor.tsx) | View normalization, current-editor validation path, transaction render policy and schema tagging. |
| [src/components/notebook/NotebookFloatingToolbar.tsx](../../src/components/notebook/NotebookFloatingToolbar.tsx) | Ignore presentation-only editor transactions. |
| [src/components/notebook/NotebookPageView.tsx](../../src/components/notebook/NotebookPageView.tsx) | Avoid hidden static text regeneration; refresh at handoff and preserve visible PDF text. |
| [src/components/notebook/NotebookRenderer.tsx](../../src/components/notebook/NotebookRenderer.tsx) | Protect the focused Freeform editor from passive ownership changes. |
| [src/components/notebook/documentPagination.ts](../../src/components/notebook/documentPagination.ts) | Reduce presentation transactions and unnecessary table/menu work; correct caret row targeting. |
| [src/components/notebook/engine/DrawingEngine.ts](../../src/components/notebook/engine/DrawingEngine.ts) | Local cached geometry and small final canvas transforms for distant pen paths. |
| [src/components/notebook/notebookBlockCommands.ts](../../src/components/notebook/notebookBlockCommands.ts) | Do not publish a document transaction for unchanged code options. |
| [src/components/notebook/notebookClipboard.ts](../../src/components/notebook/notebookClipboard.ts) | Canonical explicit language aliases and removal of derived Panvas controls on import. |
| [src/components/notebook/notebookCodeBlockView.ts](../../src/components/notebook/notebookCodeBlockView.ts) | Attached utility header, search/keyboard/focus/copy/caption behavior and scoped popup listeners. |
| [src/components/notebook/notebookDocumentView.ts](../../src/components/notebook/notebookDocumentView.ts) | Pure copy-on-change adapters for known language and legacy table attributes. |
| [src/components/notebook/notebookStaticHtml.ts](../../src/components/notebook/notebookStaticHtml.ts) | View normalization, readable table wrapper and static code header/typography parity. |
| [src/components/notebook/tiptapExtensions.ts](../../src/components/notebook/tiptapExtensions.ts) | Explicit numeric span parsing and minimum native table column width. |
| [src/styles/index.css](../../src/styles/index.css) | Table scrolling, code-control layout, shared typography/token colors and interaction states. |
| [tests/document-input-browser.mjs](../../tests/document-input-browser.mjs) | Isolate dependency scan; include exact coordinate details on a failing assertion. |
| [tests/documentation-authoring-browser.mjs](../../tests/documentation-authoring-browser.mjs) | Language/static-paste/caret/no-op regressions, recorded-document option, real themes/screenshots and correct native titlebar fixture. |
| [tests/documentation-engine-browser.mjs](../../tests/documentation-engine-browser.mjs) | Canonical HTML/XML expectation plus token parity; isolate dependency scan. |
| [tests/documentation-flow-browser.mjs](../../tests/documentation-flow-browser.mjs) | Caret diagnostics, distant pixel evidence and fractional-coordinate render/sample regression. |
| [tests/documentation-stabilization-profile.mjs](../../tests/documentation-stabilization-profile.mjs) | Paired production CPU/workload profiling and responsive/table/movement diagnostics. |
| [tests/fixtures/documentation-stabilization.html](../../tests/fixtures/documentation-stabilization.html) | Disposable profiling fixture entry point. |
| [tests/fixtures/documentation-stabilization.tsx](../../tests/fixtures/documentation-stabilization.tsx) | Inclusive instrumentation of actual editor, rendering and repository work. |
| [tests/fixtures/rich-text-pipeline.tsx](../../tests/fixtures/rich-text-pipeline.tsx) | Profiling hook and view/preview/theme fixture helpers. |
| [tests/notebook-table-layout.test.ts](../../tests/notebook-table-layout.test.ts) | Legacy span, known language and unknown-payload preservation checks. |
| [tests/rich-text-pipeline-browser.mjs](../../tests/rich-text-pipeline-browser.mjs) | Isolate dependency scan to the fixture. |
| `docs/research/documentation-stabilization-2026-10-14.md` | This review report. |

No Git reset, migration, user-data overwrite, commit, push, merge, deployment or release was performed. The local patch and this report are the handoff for manual review.
