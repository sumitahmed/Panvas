# Handwriting fidelity and live-ink recovery

2026-09-20. Implementation on the existing dirty worktree at HEAD `849f1dffc5cf39cb9ade92e5cc925507b650be4b`. Ready for physical-stylus evaluation, **not accepted as physically fixed**. No commit, push, deployment, installer build, or real-profile benchmark was performed.

## Independent findings, including corrections to Luna

The current source confirms two separate mechanisms: the input follower displaced accepted XY samples, and classic-pen midpoint quadratics displaced the rendered path again. The old live renderer restored a complete backing snapshot and replayed the growing stroke. Dense-page finalization also requested a scene redraw. These are demonstrated source-level costs/deformations; the recording alone cannot identify their contribution to physical latency.

Important corrections:

- At stabilization 52, alpha is capped at **0.9168**, reached at distance 16.32. It never reaches 1 at approximately 20 pixels. Near zero it is 0.5632.
- Higher sample rates change the old distance-dependent filter, but do **not necessarily worsen** its spatial lag. On identical time-parametrized trajectories, increased sampling often reduces lag. A lower per-sample alpha alone does not prove worse handwriting.
- The old live redraw ran per dispatch containing new samples, not once per individual coalesced sample. Growing-stroke replay still accumulates quadratic work when dispatch count grows with stroke length.
- The previous profiler's rate-dependent path construction changed the trajectory with sample count. It could not establish sample-rate invariance. The replacement evaluates the same one-second path at 60/120/240 Hz.
- Sample conservation was substantially correct in the reviewed cases. `inkSamples.ts` is unchanged by this recovery: chronological insertion, raw/move overlap, pressure-only changes, timestamps, ownership and terminal handling are retained.
- A GPU/compositor backlog and physical event-to-photon latency were **not measured**. Neither earlier tests nor this synthetic benchmark prove that the physical few-hundred-millisecond sensation is gone.

## Knowledge and historical evidence

Read the canonical architecture/data-model/state/persistence documents, notebook/drawing codebase guides, relevant handover material and knowledge-infrastructure notes. Some descriptions of curve construction are stale; current source was authoritative.

Relevant historical checkpoints: `f8702e0` had direct sample storage with the older quadratic rendering/full-redraw path; `4a5ab90` introduced the spatial/pressure follower; `65f5f99` added raw/coalesced input and snapshot-based live rendering. The more recent uncommitted sample-conservation work is retained. These checkpoints separate input filtering, curve construction and presentation costs; they are not a physical-stylus bisect proving a unique regression commit.

I searched available history/reflogs and documentation for the reported failed incremental experiments. I did not recover a distinct implementation that could honestly be declared audited. Instead, the new prefix has an explicit future-invariance test: geometry is not made permanent while later samples can still alter it.

## Upstream inspected and how it influenced the design

- **Xournal++:** point storage, incremental overlay/mask drawing, dirty-area updates and final overlay transfer support keeping historical content out of the wet path. Its stabilization is configurable: the base/default path is not equivalent to all optional stabilizers. Pressure changes can produce subdivision. The transferable principle is sample ownership plus incremental rendering, not simply C++ or universally unfiltered input. Sources: [StrokeHandler](https://github.com/xournalpp/xournalpp/blob/master/src/core/control/tools/StrokeHandler.cpp), [StrokeToolView](https://github.com/xournalpp/xournalpp/blob/master/src/core/view/overlays/StrokeToolView.cpp).
- **js-draw/Joplin:** js-draw separates wet and dry display, consumes pressure and handles final pressure explicitly. Its preview can clear/rebuild the wet stroke; it is not universally an immutable incremental prefix. Curve fitting also has bounded approximation rather than exact raw-centerline preservation. Joplin's plugin embeds js-draw and handles integration/autosave, rather than supplying a separate handwriting algorithm. Sources: [Pen](https://github.com/personalizedrefrigerator/js-draw/blob/main/packages/js-draw/src/tools/Pen.ts), [Display](https://github.com/personalizedrefrigerator/js-draw/blob/main/packages/js-draw/src/rendering/Display.ts), [Joplin plugin](https://github.com/laurent22/joplin-plugin-freehand-drawing).
- **Excalidraw:** separate new-element/static scene surfaces and frame-throttled presentation are architectural lessons. Its new-element rendering can still replay the active element. Its aesthetic freehand processing is not a requirement for Panvas. Source: [new-element renderer](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/renderNewElementScene.ts).
- **perfect-freehand:** streamlining interpolates points intentionally; pressure simulation, completion/last handling and one/two-point cases are useful design references. Adopting its streamlining would conflict with the chosen zero-deviation centerline contract. It was not added. Source: [getStrokePoints](https://github.com/steveruizok/perfect-freehand/blob/main/packages/perfect-freehand/src/getStrokePoints.ts).

License inspection: Panvas, js-draw, the inspected Joplin plugin, Excalidraw and perfect-freehand have MIT license text; Xournal++ has GPLv2 license text. No upstream implementation was copied or vendored. This is independently written code informed by architectural principles; no GPL source was incorporated.

## Chosen architecture and reviewable change groups

| Group | Implementation | Compatibility boundary |
| --- | --- | --- |
| A: sampling/filter/pressure | Preserve the sample merger; pass accepted XY through unchanged; linear pressure mapping without the second temporal follower | Explicit maximum added XY deviation: **zero**, at every stabilization value. Stored slider values remain, but currently do not cause spatial smoothing. More visible natural jitter is an intentional tradeoff. |
| B: geometry | Shared local tapered segments and endpoint disks, through every accepted sample; nib width retains existing family strategies | New strokes carry optional `centerline: 'polyline'`. Older saved strokes lacking it retain their old appearance. PDF export dispatches new strokes through the same geometry, not the legacy quadratics. |
| C: live presentation | Dedicated wet canvas beside the active layer; opaque stable-prefix buffer plus replaceable tail; one pending rAF | No historical page copy/clear during solid-pen movement. Opacity applied once to avoid dark overlap seams. All samples remain in geometry even when presentation is coalesced. |
| D: completion | Flush pending ink, transfer the completed mark once, retain one history command and Stage C capture | If shapes occupy the same layer, use the existing clipped damage-redraw path to preserve their ordering/alpha. Non-pen/patterned previews retain their legacy completion fallback. |

The geometry/presentation/completion code is separated into `inkInput.ts`, `penGeometry.ts`, `WetInkSurface.ts` and explicit `DrawingEngine` lifecycle methods. The new geometry marker is persisted by existing stroke-copy/data paths. Reverting a group still requires respecting these explicit interfaces; the changes are not independent feature flags.

For classic, ballpoint, fountain and felt, only the terminal primitive remains replaceable. Fountain width's lookahead is not frozen early. Brush keeps its distance-bounded taper region replaceable; this is bounded in spatial length, not a fixed sample count. A genuinely late chronological sample rebuilds the wet prefix instead of silently discarding the sample or leaving stale geometry.

Pressure remains a nib-width input, not an XY smoother. Positive pen pressure is mapped linearly with a 0.01 floor; existing disabled/mouse/invalid/zero fallbacks remain. A novel pointer-up endpoint with zero release pressure uses the last contact pressure. Dots and terminal endpoints use the same shared geometry.

**Scope limitation:** the dedicated incremental path covers solid pen/classic and nib families. Pencil, highlighter, marker and patterned strokes share rAF scheduling but retain their previous growing-stroke rendering/appearance. Recognition deliberately replaces recognized ink with shapes where enabled; exact raw-centerline guarantees describe freehand pen strokes, not recognized shapes or ruler-constrained input.

## Geometry and sample-rate results

All 12 mandatory paths were sampled at 60/120/240 Hz from the same trajectory. After filtering: mean deviation, maximum deviation, endpoint error and turn-angle error are zero against accepted input; path-length ratio is 1 and nondegenerate loop-area ratio is 1. The renderer uses those centerlines directly, rather than a second midpoint-curve transformation.

| Path | Old filter maximum deviation, worst of three rates (page units) | New added deviation |
| --- | ---: | ---: |
| Straight | 1.016 | 0 |
| Right angle | 0.851 | 0 |
| V | 0.931 | 0 |
| Zigzag | 1.508 | 0 |
| Reversal | 1.271 | 0 |
| Tight circle | 0.570 | 0 |
| Tight loop | 0.849 | 0 |
| Hook | 1.053 | 0 |
| Terminal flick | 1.079 | 0 |
| Cursive e | 1.239 | 0 |
| Cursive m | 1.545 | 0 |
| Multi-turn cursive | 2.178 | 0 |

These before values isolate the old filter at stabilization 52; they are **not** the total old quadratic-rendered error. Detailed before/after mean, endpoint, length, turn and area metrics are retained in `artifacts/handwriting-fidelity/recovery-summary.json`.

Relative to the 960 Hz reference, the largest sampled-polyline chord deviation was 0.2294 page units (multi-turn cursive). Other curved paths were below 0.110. This establishes approximate equivalence for the test paths, not reconstruction of corners that hardware never sampled. In the actual engine browser runs, committed XY differed from mapped accepted input by at most approximately 6.36e-14 due to floating-point mapping.

## Latency measurements

81 isolated Chromium engine scenarios: 0/500/2000 historical strokes, 60/120/240 Hz, DPR 1/1.25/2, zoom 50/100/150%. Historical strokes have 24 points. Each gesture follows the same one-second cursive trajectory and exercises overlapping raw/move/coalesced events. The benchmark uses the real NotebookEngine and one actual Stage C drawing-data capture, but not the full React/Electron/IPC/disk/autosave application.

Numbers below are **worst per-scenario statistics** across the 27 combinations at each density, not pooled percentiles. Handler and wet columns show p50 / p95 / maximum milliseconds. Pointer-up is the largest single completion measurement; there is one completion per scenario, not enough repetitions for a robust completion p95.

| Historical strokes | Handler p50 / p95 / max | Wet p50 / p95 / max | Scheduling-delay p95 / max | Pointer-up max |
| --- | --- | --- | --- | ---: |
| 0 | 0.10 / 0.20 / 1.50 | 0.30 / 0.40 / 17.90 | 17.10 / 34.40 | 4.50 |
| 500 | 0.10 / 0.30 / 2.30 | 0.20 / 0.50 / 20.40 | 16.90 / 40.70 | 8.00 |
| 2000 | 0.10 / 0.20 / 7.20 | 0.30 / 0.40 / 17.20 | 17.00 / 35.90 | 21.40 |

| Input rate | Worst handler p95 | Worst wet p95 | Latest-event-to-frame p95 | Pointer-up max |
| --- | ---: | ---: | ---: | ---: |
| 60 Hz | 0.30 | 0.50 | 16.30 | 21.40 |
| 120 Hz | 0.20 | 0.40 | 8.74 | 15.70 |
| 240 Hz | 0.20 | 0.50 | 8.04 | 17.90 |

No observed gesture long task exceeded 50 ms. Wet p95 and completion meet the requested synthetic thresholds, but the worst single wet call was 20.4 ms, including initial-surface work. Across 4,850 frame/completion submissions there were **48 intervals above 25 ms**, with a maximum 84.9 ms. These headless rAF intervals are not a measurement of compositor dropped frames. Latest-sample-to-frame maximum was 16.7 ms; no accumulating multi-hundred-millisecond sample backlog appeared in this workload. **Physical event-to-visible-ink below 30/50 ms remains unverified.**

Older local profiling artifacts had dense pointer-up tails around 121–180 ms. Those used a different path/background workload; they are indicative context, not a controlled speedup ratio.

The timing matrix was collected before the final cache-preservation, shape-order regression check and trace-phase-label refinements. Those refinements were verified by focused browser checks and tests, not another 81-case timing run. Per-stage completion timing fields (`commitPaintMs`, `historyAndCaptureMs`, `notificationMs`) are available for subsequent traces; no separate authoritative aggregate is claimed for them here.

## Correctness and regression verification

- Stable-prefix invariance for classic and all four nib families; no geometry frozen while its future-dependent width can change.
- Raw/coalesced overlap, chronological ordering, same-position pressure, timestamps, ownership, endpoint, dots and late-sample rebuild cases covered.
- Fifteen real-browser wet/commit raster comparisons (five pens/nibs at three DPRs) had exact zero pixel difference at transfer. Full redraw/reload has small edge-antialias differences, so it is **not bit-identical**; tests also check ink-coverage overlap rather than hiding differences in a mostly blank screenshot.
- Active-layer placement, translucent shape order and committed background preservation checked at all three DPRs. Layer/shape commit matched subsequent redraw in those fixtures. Page replacement cancels/disposes pending wet ink.
- Existing ruler, recognition, layers, history/undo/redo, persistence, page ownership, Stage C, eraser scheduling, page properties and cloud/auth test coverage passed. This does not replace physical regressions, especially erasing newly drawn nibs and crossing layers/shapes.
- Retained the existing eraser geometry/cache architecture and page-color changes; no eraser or page-color redesign. The shared width accessor exposes an existing formula; it does not replace the eraser algorithm. New centerline paths participate in the existing cached redraw path.
- Narrow PDF consistency test verifies all new nibs and dots serialize through shared geometry and produce a reloadable PDF; this is compatibility work, not PDF optimization.

Full `npm test` passes (808 passed, 1 platform-specific skip; includes pretest groups). `npm run typecheck` passes. `git diff --check` passes. The last additional targeted handwriting/export run passed 38 tests. Browser verification: `node scripts/handwriting-profile.mjs --verify-only` passes. The complete timing matrix used `node scripts/handwriting-profile.mjs`.

Artifacts are local/ignored: `recovery-summary.json`, `recovery-trace.json`, and final `recovery-browser-checks.json` under `artifacts/handwriting-fidelity/`. Existing earlier artifacts remain available. No benchmarks accessed a real Panvas profile.

## Files changed by this recovery

- Geometry/input: `src/components/notebook/engine/inkInput.ts`, `drawingTypes.ts`, `inkFamilyGeometry.ts`; new `penGeometry.ts`.
- Presentation/completion: `src/components/notebook/engine/DrawingEngine.ts`, `InputManager.ts`; new `WetInkSurface.ts`.
- Export compatibility: `src/services/pdf/drawPdfStroke.ts`.
- Existing tracing/profiling extended: `src/dev/handwritingTrace.ts`, `scripts/handwriting-profile.mjs`.
- Tests: `tests/ink-input.test.ts`, `tests/handwriting-fidelity.test.ts`, `tests/panvas-interactions.test.ts`, `tests/notebook-export.test.ts`; new `tests/fixtures/handwritingPaths.ts`.
- This report: `docs/HANDWRITING_RECOVERY_REPORT.md`.

Several listed files already contained earlier uncommitted work; their complete diff against HEAD is **not solely this recovery**. Initial status had 27 tracked-status entries and 16 untracked entries. Final status has 32 tracked-status entries and 20 untracked entries, including this report. All remain uncommitted. Existing auth/cloud, eraser, page-color and Stage C work was preserved; nothing was reset, cleaned, staged, committed or pushed.

## Manual acceptance and physical trace

Run `npm start` as requested. Test fast cursive e/m, small loops, hooks, V/reversals and terminal flicks; compare slow/fast writing on empty and dense pages. Check pen/nibs, pressure, taps, eraser, page color, ruler/recognition, layers, undo/redo and reopening. Look especially for new jitter, nib-width changes, edge seams after redraw, missing dots and any catch-up. Physical stylus/device-driver/coalesced behavior and actual display latency are still the acceptance gate.

Tracing is deliberately **DEV-only, opt-in and disabled by default**. `npm start` runs a production build and does not expose the dev recorder. For a separate physical trace, use `npm run dev`, then in that development renderer's DevTools console:

```js
localStorage.setItem('panvas.handwritingTrace', '1');
```

Draw one representative stroke, then export from the console:

```js
copy(JSON.stringify(window.__panvasHandwritingTraces.at(-1), null, 2));
```

The record includes raw/coalesced input, normalized samples, mapped page points, `stabilized` (now pass-through), rendered/committed samples, frame timestamps, completion timings and outcome. Only the last eight records are retained. Disable with `localStorage.removeItem('panvas.handwritingTrace')`. The URL option `handwritingTrace=1` also enables it in development; remove that option to disable. Trace timings end at JS/canvas submission, not measured photons on the display.

Panvas handwriting recovery is ready for MANUAL PHYSICAL-STYLUS verification with npm start. Automated results are not final acceptance.
