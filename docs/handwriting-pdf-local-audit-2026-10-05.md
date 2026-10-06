# Local handwriting and PDF audit — 2026-10-05

Baseline: clean `main`, `1c82b708c216f4558ccf976331cee4d336abf4ad`, version `0.1.4`.

PDF cursor and zoom/pan defects have local fixes. Two measured sources of notebook drawing work have also been removed. The recorded Research Space stroke-start failure and disappearing eraser cursor were **not reproduced**, so their causes and resolution remain unproven. Physical mouse/trackpad and Windows Ink acceptance requires the user's manual verification.

## Recording review

All three complete timelines were decoded and reviewed in chronological contact sheets at 0.5-second intervals before production edits: 143, 38, and 121 sampled frames respectively, across 17 sheets. This was sequential frame review, rather than real-time playback of every encoded frame.

| Recording | Evidence reviewed |
| --- | --- |
| `193142` — 71.27 s | Eraser hover/erase during approximately 0–24 s; settings around 25–27 s; green notebook handwriting around 28–50 s, including scrolling; remaining hover/idle. Relevant to bugs 4 and 5. |
| `192444` — 20.16 s including audio | Right-edge attempts around 0–4 s; central handwriting around 6–19 s. Relevant to bugs 3 and 4. |
| `192124` — 60.33 s | Annotated Roberts/Prewitt/Sobel PDF, zoom/pan around 0–15 s, generic crosshair, settings around 16–18 s, green annotation around 19–50 s, remaining idle. Relevant to bugs 1 and 2. |

Extracted review frames and sheets are retained under `C:\Users\sksum\AppData\Local\Temp\panvas-input-audit-20261005`.

## Proven causes and fixes

### Bug 1 — PDF cursor

The baseline PDF annotation canvas explicitly selected `cursor-crosshair` for drawing and erasing. Notebook pages already used colored SVG tool cursors.

The existing notebook resolver was moved, without changing its SVGs or tool rules, to `documentToolCursor.ts`. Notebook and PDF now call that resolver. Pen, Pencil, Highlighter, Eraser, color changes, and H2T ink color have runtime parity coverage. Hand/Text/Select retain their existing cursor behavior.

### Bug 2 — PDF zoom/pan

The baseline annotation mount effect depended on scale. The same 24-event reversal mounted/unmounted the annotation engine 24 times and started/cancelled 24 PDF render tasks. The scroll anchor calculation scaled document offsets that also contained fixed CSS padding, centering, and page gaps. Measured anchor drift reached approximately 39 × 28 px in web and 41 × 27 px in Electron.

Baseline PDF Hand input changed camera pan offsets even though the PDF renderer used native scrolling and disabled that pan transform.

The local fix:

- Coalesces incoming zoom changes on animation frames and anchors an actual page fraction in both axes. The React layout update and scroll correction complete before paint.
- Keeps annotation input mounted while CSS scales its base-size surface; refreshes bounded backing resolution after 180 ms of quiet, and defers that refresh during an active drawing gesture.
- Memoizes PDF page rendering and retains the completed raster until a detached replacement finishes. An epsilon avoids rerasterizing solely because zoom reversal leaves a floating-point scale difference.
- Adds scroll room around a fitted page so an off-center anchor can remain attainable; disables browser scroll anchoring on the document scroller.
- Sends Hand drags to the native PDF scroller. Two-finger input uses the same page anchor and `NavigationGestureLifecycle`; page ownership stays with the captured engine until release.
- Waits for the incoming page's annotations before making its live canvas visible. Its correct page-owned preview remains available during that load.

### Bug 3 — Research Space stroke starts

No source-width rejection or incorrect interaction-canvas width was found in the audited notebook path. The baseline already accepted all seven recording-derived native mouse starts. After the scoped changes, web and Electron each accepted 108 native mouse/pen starts spanning 40/140/300 px extents, two zooms, and all four sides. Separate mouse/pen checks crossed into the outer right region, lifted, and started there again.

No speculative bounds change was made. A continuous stroke can continue through pointer capture even when a fresh pointerdown would hit another element or fail eligibility. That explains the *possible mechanism* of the recorded distinction; it does not prove which condition occurred in that recording.

### Bug 4 — handwriting latency

Profiling proved two sources of avoidable work:

1. The focused page's hidden committed preview replayed the full scene twice after every committed stroke.
2. Every stroke allocated two full-size wet-ink canvases, then released their backing stores. Eight strokes caused 48 canvas width/height writes.

The focused page now refreshes that preview synchronously when live ownership leaves, rather than after each commit. Wet buffers are cleared over the previous ink bounds, reused during a short writing burst, removed from the DOM immediately on completion, and released after 250 ms idle or when the target changes/resizes/detaches.

Raw/coalesced sample handling, pressure normalization, filters, stabilization, geometry, save format, and H2T placement were not changed. These work reductions are proven; elimination of the recording's intermittent physical-pointer latency is not yet proven.

### Bug 5 — eraser cursor disappearance

Baseline and fixed notebook CSS retained the same SVG cursor during hover/down/move/up. Actual native mouse and CDP pen input erased ink in stroke and pixel modes in both notebook and PDF, with the computed SVG cursor retained throughout.

No CSS/SVG override was reproduced. No floating eraser indicator was introduced. Visible OS cursor behavior under the user's physical Windows Ink driver and mouse/trackpad remains a manual acceptance item.

## Performance measurements

Fresh baseline source was served from the exact Git baseline through the profiler's source transform; no checkout/reset was used. Baseline and fixed runs used the same fixture and workloads in independent temporary profiles. Artifacts are local and ignored by Git.

### PDF: 24 frame-paced Ctrl-wheel events, reversing direction

| Measured work | Web before → after | Windows Electron before → after |
| --- | --- | --- |
| Annotation engine mounts / unmounts | 24 / 24 → 0 / 0 | 24 / 24 → 0 / 0 |
| PDF raster starts / cancellation calls | 24 / 24 → 0 / 0 | 24 / 24 → 0 / 0 |
| Canvas width/height writes | 96 → 0 | 96 → 0 |
| Drawing-engine full redraw calls | 24 → 0 | 24 → 0 |
| PDF page component renders | 25 → 0 | 26 → 0 |
| PDF workspace renders | 24 → 25 | 24 → 25 |
| React profiler commits | 25 → 26 | 27 → 26 |
| Viewport notifications | 24 → 24 | 24 → 24 |
| DOM bounds reads | 114 → 102 | 66 → 102 |
| scrollLeft / scrollTop assignments | 24 / 24 → 24 / 24 | 24 / 24 → 24 / 24 |
| Active-page calculations | 16 → 1 | 4 → 1 |
| Page-descriptor mutations | 0 → 0 | 0 → 0 |
| ResizeObserver callbacks in the PDF window | 0 → 0 | 0 → 0 |
| Maximum anchor drift, X / Y | 38.64 / 28.03 px → 1.14 / 0.97 px | 41.09 / 26.74 px → 0.66 / 1.10 px |

The expensive raster and canvas work is removed from intermediate zoom. React renders and necessary page-relative bounds reads remain; Electron's bounds-read count increased. Active-page and background-save counts depend on scheduling, so these observations are not wall-clock or universal count guarantees.

In the final regressions, 12 wheel events in one frame produced exactly one viewport notification, one workspace render, one React commit, and one correction per scroll axis. Settling to a new scale produced one raster start, one engine resize, six canvas width/height writes, and zero engine remounts in each runtime. The returned raster dimensions matched the final scale and existing backing-resolution policy. Real buttons and Ctrl-plus/minus retained the page-center anchor and unchanged canonical annotations.

The same 24-event notebook trace retained its existing coalescing behavior: two viewport notifications, no mount/unmount, and one engine resize before and after. Its section also contains an adjacent PDF preview; the raw notebook counters include that preview's work and are not a comparison at an identical PDF zoom range.

### Notebook: eight strokes, each with 60 raw + 60 move samples

| Measured work | Web before → after | Windows Electron before → after |
| --- | --- | --- |
| Hidden full-scene redraws | 16 → 0 | 16 → 0 |
| Canvas width/height writes | 48 → 6 | 48 → 4 |
| Immutable scene snapshots | 8 → 8 | 8 → 8 |
| React profiler commits | 9 → 9 | 9 → 9 |
| Live render requests | 968 → 968 | 968 → 968 |
| Wet frame draws | 248 → 248 | 248 → 248 |
| Wet primitives | 1208 → 1208 | 1208 → 1208 |
| DOM bounds reads | 9 → 9 | 9 → 9 |
| Retained points per stroke | 121 → 121 | 121 → 121 |

The web run includes idle backing-store release in its count. A separate synchronous 16-stroke regression deterministically allocated only the two wet buffers: four width/height writes, 16 snapshots, and idle release verified. Forty wet-frame pixel comparisons plus the final committed target comparison had zero mismatched values across pressure, opacity, nib families, and rotated transforms in each runtime.

These counts do not establish physical Windows Ink end-to-end latency. No fragile 16 ms pass threshold or claim of measured physical-device latency was introduced.

Raw evidence:

- [Web baseline](../artifacts/document-input/fresh-baseline-web.json) and [web fixed](../artifacts/document-input/fresh-after-web.json).
- [Electron baseline](../artifacts/document-input/fresh-baseline-electron.json) and [Electron fixed](../artifacts/document-input/fresh-after-electron.json).
- [Web regressions](../artifacts/document-input/regressions-web.json) and [Electron regressions](../artifacts/document-input/regressions-electron.json).

Reproduce profiling locally with `node tests/document-input-profile.mjs --baseline-ref 1c82b708c216f4558ccf976331cee4d336abf4ad`, then without `--baseline-ref`; add `--electron` to each for Windows Electron.

## Research Space geometry

The existing contract is preserved:

```text
sourceX = extraLeft
sourceY = extraTop
surfaceWidth  = extraLeft + sourceWidth  + extraRight
surfaceHeight = extraTop  + sourceHeight + extraBottom
canonical X domain = [-extraLeft, sourceWidth + extraRight]
canonical Y domain = [-extraTop, sourceHeight + extraBottom]
```

The A4 source is 794 × 1123. At 140 px on all sides the single writable surface is 1074 × 1403. Negative left/top coordinates and coordinates beyond the source right/bottom are stored canonically.

Each runtime tested mouse and pen at zoom 0.85 and 1.25:

| Extent | X start positions, Y = 100 | Outer-right top/bottom start Y |
| --- | --- | --- |
| 40 | -35, -20, 100, 789, 799, 814, 829 | -35, 1158 |
| 140 | -135, -70, 100, 789, 799, 864, 929 | -135, 1258 |
| 300 | -295, -150, 100, 789, 799, 944, 1089 | -295, 1418 |

Every tested start first proved `elementFromPoint` hit the actual interaction canvas, then created a stroke and preserved canonical coordinates within one pixel. Native pen pressure 0.65 was preserved. Initial recording-derived X checks were -130, -70, 100, 784, 804, 864, 924. Separate source-to-right strokes ran from X 784 to 924, followed by a fresh start at 924 after release.

## Cursor behavior

Notebook and PDF computed cursors match for Pen with two colors, Pencil, Highlighter, H2T handwriting ink, and Eraser. Eight real erasing cases per runtime cover notebook/PDF × mouse/pen × stroke/pixel erasing. Ink actually changed, and the same SVG cursor remained assigned during capture and after release. This verifies CSS ownership; physical OS cursor visibility remains subject to manual verification.

## Files changed

Production:

- `src/components/notebook/documentToolCursor.ts` — shared existing cursor resolver.
- `src/components/notebook/NotebookPageView.tsx` — resolver use and preview work at ownership handoff.
- `src/components/notebook/engine/DrawingEngine.ts` — short-lived wet-buffer reuse and cleanup.
- `src/components/notebook/engine/WetInkSurface.ts` — bounded clearing and buffer resume.
- `src/components/notebook/engine/InputManager.ts` — PDF native-scroll pan target.
- `src/components/notebook/engine/touchViewportGesture.ts` — optional page-anchor callback; default notebook path preserved.
- `src/components/pdf/usePdfViewportZoom.ts` — coalesced DOM page anchoring.
- `src/components/pdf/PdfWorkspace.tsx` — stable input ownership, settled backing resolution, native scroll, cursor parity.
- `src/components/pdf/PdfPageRenderer.tsx` — memoization and completed-raster replacement.

Verification and documentation:

- `tests/document-input-browser.mjs` — 16 web/Electron regression groups.
- `tests/document-input-profile.mjs` — reproducible baseline/fixed work measurements.
- `tests/fixtures/document-input.html` — isolated fixture entry.
- `tests/fixtures/document-input.tsx` — real notebook/PDF components, isolated data, counters.
- `tests/electron-pipeline.test.ts` — identify persisted parent rows, expand the correct notebook, select navigation before asserting page count.
- `package.json` — adds `test:document-input`; version and dependencies unchanged.
- `docs/handwriting-pdf-local-audit-2026-10-05.md` — this report.

Generated evidence remains under ignored `artifacts/document-input`. The pipeline-generated tracked PDF fixture and screenshot were restored to their original bytes. No Cloud Sync, theme/template, persistence-format, landing-page, release, or installer source was changed.

## Automated tests

All final commands completed with native exit code 0. Older setup failures and a PowerShell stderr/redirection exit-code issue were resolved before these final results.

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS — renderer and Electron TypeScript |
| Focused Node suites listed below | 150 passed, 0 failed, 0 skipped |
| `npm run test:document-input` | 16 groups passed in web + 16 in Windows Electron; no renderer errors |
| `npm run test:editor-regressions` | 74 passed, 1 existing skip; browser check passed 14 fonts and 25 unique page workflows |
| `npm run test:notebook-navigation` | 18 unit tests + 29 real-renderer cases passed |
| `npm run test:notebook-responsive` | 10 unit tests + 33 browser cases passed |
| `npm run test:notebook-performance` | 12 unit tests + 3 runtime profiles passed |
| `npm run test:handwriting-placement` | 9 unit tests + 42 browser + 42 Electron scenarios passed |
| `npm test`, including pretest | 878 passed, 1 existing skip, 0 failed across 879 tests |
| Production `tests/electron-pipeline.test.ts` in an isolated temporary profile/workspace | 1 passed: import/render, annotation save, restart, renderer PDF cache clear, filesystem reopen and annotation survival; native window chrome/scale and preload boundary |
| `npm run build` | PASS — current renderer, Electron main and preload; no installer packaging |
| `npm run build:web` | PASS |
| `git diff --check` | PASS |

Focused command:

```powershell
node --test tests/pdf-annotation.test.ts tests/search-pdf.test.ts tests/page-properties.test.ts tests/panvas-interactions.test.ts tests/ink-input.test.ts tests/handwriting-fidelity.test.ts tests/stage-c-performance.test.ts tests/editor-regression-recovery.test.ts tests/notebook-performance.test.ts
```

The installed Panvas process and real user profiles/data were left untouched. Runtime interaction fixtures used temporary browser/Electron profiles. The production restart test redirected USERPROFILE, APPDATA, Electron userData, and workspace root into its temporary directory. Clearing IndexedDB affected only that test profile.

Existing large-bundle and pdf.js dynamic-import warnings remain non-fatal. Early restart-test failures were setup assumptions: the wrong tree parent was toggled, and page navigation was asserted while Pen hid it. The updated harness checks actual persisted parentage and exercises Select before the navigation assertion; application library behavior was not changed.

## Electron verification

The installed local Electron dependency is 43.3.0. The 16 interaction groups used a real Windows Electron renderer with isolated preload/domain handlers, CDP mouse and pen input, real PDF rasterization, erasing, canonical storage, zoom/pinch, and captured page-crossing drags. H2T geometry passed 42 Electron scenarios. The built production Electron app separately passed filesystem/restart/cache-loss, annotation persistence, window chrome, native scale, and renderer isolation checks.

CDP pen input is not a physical Windows Ink device. OS cursor visibility and physical-device handwriting feel remain unverified.

## Browser verification

The same 16 interaction groups passed in an isolated Chromium context using the actual notebook and PDF components. Existing editor/navigation/responsive/performance browser suites passed. H2T geometry passed 42 browser scenarios. Saved screenshot evidence was visually inspected for both document runtimes; screenshots do not prove OS cursor visibility.

## Manual verification

Quit the installed Panvas normally before starting local Electron, so its single-instance lock does not redirect the launch to the older running app.

Electron:

```powershell
Set-Location -LiteralPath 'C:\Users\sksum\OneDrive\Documents\OSS ExcaliDraw'
npm start
```

Web, in a separate terminal:

```powershell
Set-Location -LiteralPath 'C:\Users\sksum\OneDrive\Documents\OSS ExcaliDraw'
npm run dev:web -- --host 127.0.0.1 --port 3011 --strictPort
```

Open `http://127.0.0.1:3011/app/library`.

Repeat these in both runtimes with both mouse/trackpad and the physical Windows Ink pen:

1. Open an annotated PDF. Check Pen, Pencil, Highlighter, Eraser, and two drawing colors. Check H2T ink color if used.
2. Reverse Ctrl-wheel repeatedly at the center and near an edge. Check zoom buttons and Ctrl-plus/minus. Pan with Hand; pinch if supported. Confirm stable anchoring, no blank flashing, aligned annotations, sharp settled content, and correct page navigation.
3. In a normal A4 page, set Left/Right Research Space to 140. Lift between letters at far left, near right, and far right. Start on the source, cross into far right, lift, and start again there. Repeat at 40 and 300; check top/bottom and different zooms.
4. Write for 30–60 seconds: separate letters, short words, fast cursive, and several lines. Check whether ink stays under the pointer and whether the next letter starts promptly.
5. Erase several strokes without releasing. Watch the cursor before contact, throughout movement/capture, and after release. Check stroke and pixel erasing in notebook and PDF.
6. Navigate away/back, restart, and reopen. Verify annotations, Research Space, and H2T placement; export an annotated PDF and inspect the result.

Report any surviving issue with its runtime, tool, input device, zoom, Research Space sizes, and whether the stroke began in that region or entered it while already held.

## Release status

**LOCAL FIX ONLY. NOT PUSHED. NOT DEPLOYED. NO NEW EXE. NO GITHUB RELEASE. LANDING PAGE UNCHANGED. WAITING FOR USER MANUAL VERIFICATION.**

No commit, version bump, tag, installer packaging, release publication, deployment, or landing-page download update was performed. The next production release requires the user to explicitly report `MANUAL VERIFICATION PASSED`.
