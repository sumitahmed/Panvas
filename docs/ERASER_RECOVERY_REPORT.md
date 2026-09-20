# Eraser recovery — 2026-09-20

## Outcome and limits

The replacement passes the automated no-catastrophic-backlog gate. In the final isolated Electron run, realistic 2,000-stroke handwriting, existing-clip and ruler fixtures completed their 1.44-second input streams in about 1.46 seconds. Their pointer-up tails were 14–15 ms. No >=50 ms long tasks were observed in that final run, including the two straight-line stress cases.

This is **not** a claim that every latency target is met. The heavily overlapping straight-line stress cases still exceeded the desired 50 ms p95 presentation target. Frame-opportunity measurements are proxies, not physical stylus-to-display measurements. The user's same-page manual verification remains necessary.

## Knowledge-base findings

The architecture, data-model, storage, codebase and handover documents establish an imperative notebook engine outside React, local-first persistence, stable page ownership, and gesture-level history. Older statements about rendering/culling are not reliable descriptions of the current source.

The important documented incident is the September 8 ruler/eraser correction in `docs/panvas-handover/STICKY_LAYERS_ELEMENTS_HANDOFF.md`, section 7:

- Sampled eraser circles left exposed broad ink beside the ruler. Blocking a whole circle created a dead zone.
- Centerline splitting regenerated caps and changed translucent overlaps. Width-based fragment removal discarded intentional small marks.
- The correction introduced continuous capsules, subtraction of the full ruler body, relative `inkClip` contours, original pressure-path retention, and a pencil raster surface to preserve grain under clipping.
- Subsequent work made clips follow resize/undo and corrected underestimated dotted-fountain bounds using actual nib geometry.
- The documented browser matrix covered six instruments, three angles and three zoom levels; it did not establish dense-page Electron responsiveness.

`CANVAS_V1_HARDENING.md` concerns the separate Excalidraw-backed Canvas domain, not the notebook eraser. Its storage/theme corrections are retained. No separate documented Gemini recovery implementation was found in the searched eraser records; the user's distinction between the safe baseline and truly responsive architecture is preserved rather than invented from those docs.

## Historical Panvas comparison

| Version | Input and geometry | Rendering and completion |
|---|---|---|
| `f8702e0` | Point-based hit testing and polyline splitting; no retained polygon domain | Full redraws, including per-hit redraws in some branches; gesture history |
| `4a5ab90` | Continuous capsule discovery through subdivisions; exact polygon intersections/differences; growing `inkClip` | Original paths preserved; layer/backing-resolution and ruler correctness additions |
| `65f5f99` | Adds raw pointer events through the shared movement handler | Additional input pressure without making eraser geometry cheaper |
| `849f1df` | Eraser/ink-region geometry unchanged from `4a5ab90` | Safe pre-experiment baseline, **not** proof of the genuinely responsive architecture |
| Previous dirty A+B | One authoritative stream, ordered queued capsules; same polygon geometry | Fewer redraws, but expensive indivisible sweeps and synchronous pointer-up drain |
| This recovery | Analytic capsule/segment intersections and surviving polyline fragments | Immediate cheap mutation, frame-batched damaged-area presentation, one completion capture/history entry |

`f8702e0` remains the likely responsive architecture by source/history evidence, not a newly measured historical build. No historical app was opened against user data.

## Upstream source comparison

Sources were current upstream checkouts, not blog descriptions. Their performance was not benchmarked on this machine; the comparison concerns implementation structure.

| Concern | Previous Panvas polygon path | Panvas `f8702e0` | Xournal++ | js-draw / Joplin | Excalidraw |
|---|---|---|---|---|---|
| Input work | Raw/move pressure; A+B later deduplicated and queued | Work per movement | Erase handler per input | Erase-to movement, ignores identical position | Latest trail segment, pending element IDs |
| Primitive | Subdivided candidate samples + swept capsule | Point/circle-oriented splitting | Padded eraser box | Rectangle / convex hull between positions | Segment/element hit tests |
| Partial representation | Original stroke + polygon domain | Stroke fragments | Remaining path intervals, then strokes | Split paths/components | Not partial ink erasure: whole elements |
| Candidate lookup | Repeated page scans; rejected D added bounds | Stroke scans | Selected layer bounds | Spatial tree region query | Visible unlocked elements + bounds |
| Exact work | Repeated general polygon clipping | Polyline work | Segment/box intersections | Path intersections and splitting; filled paths have limitations | Element/outline intersections |
| Repaint | Full surfaces; A+B reduces frequency only | Full redraw | Damaged ranges; overlap-aware invalidation | Queued rAF, spatial rendering cache, wet-ink surface | Static/interacting surfaces, throttled static renderer, element caches |
| History/up | One command, but A+B drains accumulated geometry first | Gesture completion | Grouped erase action; materializes remaining sections | Combines temporary changes into one command | Commits pending element deletion |
| Worst case | Sample count × scans + growing polygon complexity + painting | Scans/segments and full paint | Bounds scan plus affected segments/overlaps | Tree can still visit all overlapping components | Visible-element scan plus exact tests |

Concrete references:

- [Xournal++ erase handler](https://github.com/xournalpp/xournalpp/blob/283c36756a42058883829a7370626ffa4bec65ca/src/core/control/tools/EraseHandler.cpp), [remaining sections and damage](https://github.com/xournalpp/xournalpp/blob/283c36756a42058883829a7370626ffa4bec65ca/src/core/model/eraser/ErasableStroke.cpp), [undo](https://github.com/xournalpp/xournalpp/blob/283c36756a42058883829a7370626ffa4bec65ca/src/core/undo/EraseUndoAction.cpp).
- [Xournal++ rewrite #3532](https://github.com/xournalpp/xournalpp/pull/3532) links marker erasure #997, Surface lag #949 and dotted-line artifacts #3537. Its discussion explains why repainting whole stroke bounds is costly and why transparent split overlaps need special invalidation. The implementation tracks sections and uses an overlap tree; the lesson is not merely “C++ is faster.”
- [js-draw eraser](https://github.com/personalizedrefrigerator/js-draw/blob/d11df39b2dec987f10922bbd2aaf50b289296d69/packages/js-draw/src/tools/Eraser.ts), [partial stroke implementation](https://github.com/personalizedrefrigerator/js-draw/blob/d11df39b2dec987f10922bbd2aaf50b289296d69/packages/js-draw/src/components/Stroke.ts), [display cache](https://github.com/personalizedrefrigerator/js-draw/blob/d11df39b2dec987f10922bbd2aaf50b289296d69/packages/js-draw/src/rendering/Display.ts). Its hit-query approximation and filled-path limitations were not adopted as Panvas correctness guarantees.
- [Joplin integration](https://github.com/personalizedrefrigerator/joplin-plugin-freehand-drawing/blob/7d3baea200f010f28813643df3daf6b80ab40095/src/dialog/webview/makeJsDrawEditor.ts) instantiates the js-draw editor; it is not an independent eraser algorithm.
- [Excalidraw eraser](https://github.com/excalidraw/excalidraw/blob/97c68dd371e13c017a8dcca49f8b3995ba7890a8/packages/excalidraw/eraser/index.ts), [static render scheduling](https://github.com/excalidraw/excalidraw/blob/97c68dd371e13c017a8dcca49f8b3995ba7890a8/packages/excalidraw/renderer/staticScene.ts). Its useful lessons are bounded interaction state, culling and render separation—not partial-stroke geometry or a claim of zero React involvement.

The checked repositories identify Xournal++ as GPL-2.0 and the other three as MIT. No upstream implementation code was copied or dependency added. Analytic geometry and the integration were implemented independently from the architectural principles.

## Why previous attempts failed

Stage D rejected most irrelevant candidates but retained costly exact polygon work on real hits and full redraws. A+B reduced redraws from 181 to 21/8 for 500/2,000 strokes, yet individual sweeps still reached approximately 127/433 ms. Queue age reached about 11/45 seconds and pointer-up synchronously drained that work. A frame budget cannot interrupt one indivisible polygon operation.

Thus the delayed feedback was real main-thread work and queued geometry, not an intentional 1–2 second debounce. The new handwriting fixture also exposed repeated fountain-path construction during repaint; making geometry cheap alone was insufficient.

## Exact implementation

1. `capsuleErase.ts`: constant-size analytic segment-versus-capsule intersection, continuous sparse A-to-B coverage, interpolated pressure/time at boundaries, and unchanged surviving source samples. No distance-dependent stroke subdivision.
2. `EraserEngine.ts`: whole-stroke fast deletion; gesture-local bounds; collision-free fragment IDs; original-ID retention where possible; before/after history with original/final ordering. Existing clips are translated to each fragment's new origin.
3. Ruler handling partitions touched ink into protected and exposed domains once per source stroke per gesture. Protected ink keeps its original geometry. Subsequent exposed-fragment sweeps use analytic splitting. The final ruler fixture exercised 64 such separations. Polygon work is not claimed to be universally eliminated: ruler partitioning, legacy whole-stroke hit checks, and clear-all-with-ruler still use it.
4. `InputManager` uses one authoritative raw stream (move/coalesced fallback), applies cheap geometry immediately, and batches presentation. Normal pen filtering/input and the SVG cursor are unchanged. Completion/page replacement remains an ownership barrier; there is no accumulated geometry backlog to drain in the production eraser path.
5. `DrawingEngine` clips repaint to damaged pixel-aligned bounds on every backing surface, redraws all overlapping contributors in order, and caches committed nib `Path2D` geometry. Cache validation checks geometry-affecting fields and sample values, including in-place edits. Live pen strokes bypass that cache.
6. `cloneStrokeSnapshot.ts` detaches numeric samples/clip coordinates directly and still deeply clones extensible metadata. History and `NotebookEngine.getDrawingData()` use it. This targets the measured eraser completion-copy cost while preserving Stage C's one-capture ownership contract.
7. Conservative nib broad-phase bounds are derived from each width strategy's maximum; tests include solid/dashed/dotted pressure geometry. The rejected Stage D module remains removed. Bounds are now an accessory to cheap geometry, not the proposed cure by themselves.

## Compatibility and tradeoffs

No document migration or schema change. Existing `inkClip` contours continue loading/rendering and remain attached to fragments, so prior holes do not reappear. Pixel/stroke/highlighter modes, layer editability, ruler protection, pressure samples, page ownership, local persistence and one undo per gesture are retained. Clear-all now also respects editable layers.

This is a polyline-fragment eraser, not arbitrary polygon hole punching inside thick ink. Cut caps, brush taper, dash phase and self-overlap opacity can differ from the polygon implementation; thick-stroke cuts can remove a cross-section rather than a tiny interior notch. These are meaningful fidelity tradeoffs, not promises of pixel-identical output. Undo restores the original data exactly. Ruler-protected coverage/alpha passed the existing strict browser matrix.

Dirty and full canvas rasterization were also compared separately from timing. They are not bit-identical: the dense handwriting comparison found 444 composited color-channel differences above two levels, with a maximum about 38/255, among millions of channels. Raster edge differences remain a manual visual-check item. Pixel-readback runs are not the final performance evidence because readback can alter Chromium's rendering backend.

## Final Electron measurements

Evidence: `artifacts/gate0-profile/eraser-recovery.json`. Fresh profile and workspace root: `C:\Users\sksum\AppData\Local\Temp\panvas-eraser-ab-zU3ZQz`.

Visible maximized Electron; DPR 1.25; zoom 1.3386; backing 1328×1879. Each gesture used 180 positions over an intended 1,440 ms, with both raw and duplicate move transports. Every case processed exactly 180 positions. Physical input was excluded only in this disposable benchmark window after an earlier run was found contaminated by a real mouse gesture.

| Fixture | Geometry p95 / max ms | Render batch max ms | Input→canvas p95 ms | Next-frame proxy p95 ms | Pointer-up ms |
|---|---:|---:|---:|---:|---:|
| 500 overlapping long strokes | 1.3 / 17.2 | 2.8 | 85.4 | 163.3 | 15.3 |
| 2,000 overlapping long strokes | 6.8 / 26.9 | 5.7 | 73.4 | 105.7 | 41.9 |
| 2,000 pressure handwriting strokes + image/shape | 2.1 / 8.6 | 15.7 | 20.0 | 33.6 | 15.0 |
| 2,000 handwriting strokes with old clips | 1.6 / 3.9 | 9.7 | 22.0 | 31.6 | 14.1 |
| 2,000 handwriting strokes, ruler crossing | 1.7 / 4.8 | 10.0 | 20.7 | 33.2 | 13.9 |

Maximum application queue age: **0.8 ms**, one position at a time, no growing backlog. Maximum movement/down dispatch: **27.3 ms**; maximum measured pointer-up task: **41.9 ms**. No >=50 ms long tasks in the final run. The straight-line cases still show presentation scheduling variability despite cheap CPU work; their 50 ms p95 target is not met. None reproduces the prior seconds-long catch-up or giant terminal drain.

Before A+B: the recorded scheduled 2,000-stroke run had a 433 ms maximum sweep, roughly 45-second queue age and 45.7-second pointer-up drain. Those older runs used a different window/zoom and are architectural regression evidence, not a controlled percentage-speedup claim.

The 2,000-stroke long fixture visited 482,842 stroke candidates and accumulated a 116,450 candidate-segment budget. Handwriting visited 374,863 candidates / 145,962 candidate segments; ruler 373,829 / 146,575. The segment counter is a candidate-list budget, not an exact count of every arithmetic intersection across both hit and split passes. Allocation volume and physical display scanout were not measured.

## Verification

- Full `npm test`: **785 total, 784 passed, 1 skipped, 0 failed**, including pretest packages. The skip is the existing environment-gated Windows Ink integration.
- Final focused eraser + Stage C suite: **23 passed**.
- Existing real-pointer browser ruler suite: **54/54 passed**, covering six instruments, angles 0/25/70°, zoom 50/100/150%, protected alpha, exposed edges/ends, exact undo/redo, reopen and browser reload.
- Renderer and Electron `npm run typecheck`: passed.
- `git diff --check`: passed (Git emits existing CRLF conversion warnings).
- Coverage includes sparse sweeps, corners/loops/reversals, pressure interpolation, old clips, serialization/reload, fragment-ID collisions, modes/layers, pointer cancel/capture loss/detach/destroy, immediate page replacement, exact history and detached snapshot metadata.

## Changed files and git state

Recovery edits: `DrawingEngine.ts`, `EraserEngine.ts`, `EraserGesture.ts`, `InputManager.ts`, `NotebookEngine.ts`, `inkFamilyGeometry.ts`, new `capsuleErase.ts`, new `cloneStrokeSnapshot.ts`, `tests/eraser-scheduling.test.ts`, `tests/panvas-interactions.test.ts`, and `scripts/gate0-profile-eraser-ab.mjs`, plus this report.

HEAD remains `849f1df`. The worktree remains dirty; existing Gate 0, Stage C, Google Drive/auth and unrelated UI/data changes were retained. No reset, clean, broad checkout, commit, push, deployment or EXE build was performed. No real user storage/profile/workspace or cloud state was opened for experimental mutation. Test profiles and research clones remain in disposable temporary directories.

Stage D status: **REMOVE the rejected standalone implementation; already removed.** Its broad-phase idea is useful only alongside the replaced geometry and bounded rendering, implemented here as gesture-local state rather than restoring its shared cache/invalidation architecture.

Manual gate: run `npm start`, test the same dense page and compare the supplied recording, especially ruler boundaries, thick ink, translucent crossings, patterned/brush cuts, undo/redo and immediate page switching. Actual physical-pen feel is not certified by synthetic timing.
