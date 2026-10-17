# Panvas documentation release preparation — October 16, 2026

**Release status: blocked.** The rolling palette, sidebar, targeted editor security patches, two documentation sync defects, and bundle gate are implemented and locally verified. Asset-complete backup/restore and rich-document PDF export remain unimplemented. Their proposed contracts and review boundary are in [the portability/export proposal](documentation-portability-export-proposal-2026-10-16.md).

## Checkpoints and current status

| Checkpoint | Result |
| --- | --- |
| 1 — Palette and sidebar | Implemented; actual production Chromium and Electron UI passes, with before/after screenshots |
| 2 — Confirmed UI defects | Workspace rename, Escape handling in form controls, native canvas duplication and SPA canvas asset loading corrected; editor/control regressions pass |
| 3 — Security, backup and sync | Requested editor advisories patched; sync corrections/59 fixtures pass; overall security and asset backup gates remain open |
| 4 — Rich PDF | Not implemented; both applications still reject Document PDF export through the actual menu; architecture proposal awaits review |
| 5 — Performance and bundle | Measured tree improvement and passing unchanged bundle gate; large expanded trees still have noticeable latency |
| 6 — Acceptance | Local regressions pass within the scope below; full release acceptance is not achieved |

[Cross-checked acceptance summary](../../artifacts/documentation-release-prep-20261016/acceptance-summary.json) · [Changes from the preserved starting tree](../../artifacts/documentation-release-prep-20261016/this-pass.diff)

## Palette and selection behavior

The previous six swatches were hard-coded, and the armed highlighter color was component-local. The new versioned preference contains six literal colors, the next FIFO slot and the chosen color, including None. It uses existing global settings, rather than notebook JSON. Existing swatches and duplicate custom colors do not advance the ring; a new color replaces the next slot. Reset restores defaults/order while retaining the chosen highlighter color. Arming itself does not persist across restart.

Native restart testing found the saved preference on disk but missing from Electron's startup settings allowlist. That allowlist now includes the palette. Preference writes are serialized so rapid color commits retain replacement order. Native color-input `input` events update the picker draft; `change` commits once, instead of rotating the ring for every preview.

The existing highlighting commands and gesture engine remain in use. A further UI check reproduced Escape disarming the highlighter while swallowing cancellation of a sidebar rename. Form controls now receive their normal Escape handling after the mode disarms.

Actual UI acceptance covers seven custom replacements, duplicates, selecting existing colors, reset, notebook switching, full browser/Electron process restart using the same disposable profile, remembered color, ordinary select-first formatting, repeated drags, None, undo/redo, persistence and unchanged unselected JSON/marks. The palette remains **224 × 232.4 CSS px**, with exactly six color swatches.

Actual captures: [defaults](../../artifacts/documentation-release-prep-20261016/checkpoint1/palette-captures/web-defaults.png), [first two replacements](../../artifacts/documentation-release-prep-20261016/checkpoint1/palette-captures/web-two-custom.png), [seven replacements](../../artifacts/documentation-release-prep-20261016/checkpoint1/palette-captures/web-rolled.png). [Electron captures and JSON](../../artifacts/documentation-release-prep-20261016/checkpoint1/palette-captures/electron.json) use the same sequence.

## Sidebar review

Applied skills from the available catalog: focused-fix, playwright-pro, frontend-design, emil-design-eng and performance-profiler. Retained Panvas's existing fonts, warm surface/color tokens, Lucide icons and canonical notebook cover thumbnails. No new UI/icon/font dependency was added.

The supplied VS Code/NvimTree screenshots informed density and alignment. [Component Gallery's tree examples](https://component.gallery/components/tree-view/) and the [W3C tree keyboard pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/) informed hierarchy/focus behavior. Uncut, Hugeicons and public Mobbin/60fps/Sleek pages were accessible, but no authenticated Mobbin screens were reviewed. Curations returned no readable content; Rebrand Gallery, Landing Love and SaaSpo were unavailable to the research tool. None is claimed as a visual template.

| Before | After | Why |
| --- | --- | --- |
| Repeated filled workspace/notebook/section/page states | One strongest active leaf; quiet ancestor text | Makes the current page identifiable |
| Offset borders, inconsistent indent and double section chevrons | 16 px indent steps, aligned 28 px rows and subtle straight guides | Clarifies nesting without decorative brackets |
| Canvas/page icons looked alike; notebook covers needed preservation | Distinct canvas/section/workspace icons; original notebook covers retained in aligned slots | Preserves identity and differentiates item types |
| Enter/Space only; hidden actions depended on hover | Roving tree focus, arrows/Home/End, Shift+F10, visible focus and focus-within actions | Supports keyboard navigation and menus |
| Two-line permanent storage footer | Compact “On this device” control opening existing storage settings | Preserves location/usage/control discoverability without duplicating save/sync status |

[Before, light](../../artifacts/documentation-release-prep-20261016/checkpoint1/before-web-light-sidebar.png) · [After, light](../../artifacts/documentation-release-prep-20261016/checkpoint1/after-web-light-sidebar.png) · [Before, dark](../../artifacts/documentation-release-prep-20261016/checkpoint1/before-web-dark-sidebar.png) · [After, dark](../../artifacts/documentation-release-prep-20261016/checkpoint1/after-web-dark-sidebar.png) · [Phone viewport](../../artifacts/documentation-release-prep-20261016/checkpoint1/palette-captures/web-phone-sidebar.png)

Browser/Electron UI checks preserve expand/collapse, navigation, page creation/rename/trash, drag reorder, canvas duplication, workspace rename/cancel, long-title truncation/tooltips, storage details, sidebar hide/show, light/dark and 780 px overlay behavior. Chromium also checks a 390 px phone viewport. Actual screen-reader/physical-touch acceptance is pending manual review; Electron's existing minimum window width was preserved.

Native canvas duplication previously used the browser IndexedDB path and silently found no desktop canvas after restart. It now reads/copies through the canonical native repository, including new custom-block identities. UI assertions compare copied shape/content data. Canvas loading also exposed relative Excalidraw split-chunk URLs resolving under an SPA route; the existing asset configuration now anchors them to its own script URL. [Excalidraw documents the asset-path setting](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation).

## Runtime and regression evidence

All application UI work used disposable profiles/workspaces. Fixture content setup is distinguished from the palette, toolbar, tree and native mouse interactions under test.

| Suite | Chromium | Electron |
| --- | --- | --- |
| Production palette/sidebar acceptance | Pass, including full profile restart | Pass, including full profile restart |
| Persistent highlighting | 19 gestures pass | 19 gestures pass |
| Rich editor/schema/clipboard/component regressions | 36/36 groups pass | 36/36 groups pass |
| Production-shell document workflow | Pass | Pass |
| Actual math/code/font controls | Pass | Pass |
| Document PDF export | Confirmed unsupported through real menu | Confirmed unsupported through real menu |

The 19-gesture checks assert exact ProseMirror positions, persisted JSON, per-character unrelated marks/foreground/background, 16 changing gestures with one document transaction each, and three disabled-mode selections with zero. They include imported black/red backgrounds, mixed bold/italic/links, cross-paragraph/sheet/backward selections, stale-document cancellation, save/reopen, active/static rendering and the separate canvas ink highlighter.

The document workflow pasted an 11-sheet A4 document, expanded it to 13 sheets, edited/deleted earlier text, verified exact undo/redo and reopened one canonical body. Infinite mode retained width and distant content beyond 30,000 px of scrolling. Freeform/conversion/positioned annotation preservation and generated-page ordering checks passed. The control checks exercise literal/converted LaTeX, selection styles in light/standard/full dark, SQL Wrap Off/On/reopen, language choices and font selection/loading. SQL wrap retained source text; horizontal content changed from 8,067 px to 664 px when wrapping.

Two older assertions read selection before ProseMirror's native pointer processing finished. The tests now wait for the intended ProseMirror text range, rather than focus or a fixed number of frames alone. They do not set the selection programmatically to pass, suppress failures or alter the LaTeX/highlight rendering.

`npm test`: **662 passed, 1 skipped, 0 failed** in the main 663-test run; its package/cloud prechecks also passed. The skipped test is the real Windows production-provider/worker WinRT path. New palette/security regressions are included in `npm test`. Type checks and production build passed. The notebook-cover preservation regression was corrected in the implementation; its existing assertion was retained.

Evidence: [palette/sidebar JSON](../../artifacts/documentation-release-prep-20261016/checkpoint1/after-web.json), [Electron JSON](../../artifacts/documentation-release-prep-20261016/checkpoint1/after-electron.json), [highlighting web](../../artifacts/documentation-release-prep-20261016/highlight-mode/after-web.json), [highlighting Electron](../../artifacts/documentation-release-prep-20261016/highlight-mode/after-electron.json), [full regression log](../../artifacts/documentation-release-prep-20261016/full-regressions-final.log), [workflow evidence](../../artifacts/documentation-release-prep-20261016/flow-acceptance/verify-release-final-electron.json), [control evidence](../../artifacts/documentation-release-prep-20261016/control-acceptance/release-controls-final-electron.json).

## Security

Installed and locked ProseMirror View **1.42.2 → 1.42.3**, the minimum patch identified by [GHSA-c8x8-7fp4-3x9w](https://github.com/advisories/GHSA-c8x8-7fp4-3x9w). Tiptap's existing packages were aligned **3.30.2 → 3.30.5** to satisfy exact peers and address both [mergeAttributes prototype manipulation](https://github.com/advisories/GHSA-cp6q-959q-f8rh) and [Markdown attribute ReDoS](https://github.com/advisories/GHSA-j95f-988m-3j2f). Optional menu overrides keep that family aligned; no force/legacy-peer-deps bypass was used.

Actual installed versions and lockfile agree; the editor advisories are absent from the fresh audit. New regressions verify own-`__proto__` handling and complete adversarial Markdown tokens; the two parser probes completed in about 4 ms. Rich-component runtime checks cover HTML sanitization, unsafe URLs/handlers, inert external media, clipboard source/slice normalization and active/static KaTeX behavior. Existing restricted KaTeX settings and CSP were retained.

**Overall security gate remains open:** the final audit reports **33 affected package entries: 17 high, 12 moderate, 4 low** (down from 78 entries). Counts are package entries, not independent exploit demonstrations. Unrelated Electron/tooling/recognition dependency chains were not blindly upgraded. KaTeX 0.16.47 also remains affected by [the prerequisite-prototype-pollution trust bypass advisory](https://github.com/advisories/GHSA-238p-pmpm-9mq7); passing current rendering boundaries is not a claim that its dependency advisory is fixed. [Final audit](../../artifacts/documentation-release-prep-20261016/audit-final.json) and [exact dependency changes](../../artifacts/documentation-release-prep-20261016/dependency-changes.json) retain details.

## Backup and Google Drive

The function-level portability audit reproduced omitted separate binaries and stale restored rich page targets/links in backup v1. **No asset-complete backup/clean-profile restore acceptance is claimed.** The backup contract was not silently changed.

The native sync collector now traverses rich block/inline image nodes. Workspace copies remap structured reference fields and internal link parameters, preserving prose, code/math/Infinite metadata and binary content. All **59 sync fixtures** pass, including new rich A4/Infinite interrupted-upload/retry/fresh-replica and copy cases, alongside existing conflict/recovery/integrity cases. The current audit passes its sync checks and intentionally still fails its three backup checks: [before](../../artifacts/documentation-release-prep-20261016/portability-audit-before.json), [current](../../artifacts/documentation-release-prep-20261016/portability-audit.json).

These are automated local fixtures. Live Google authentication, real Drive upload/download/interruption, a second physical device and cross-platform opening of restored asset-rich workspaces still require owner-authorized acceptance. No live account or real user workspace was used for destructive tests.

## PDF

Existing finite-page exporter/delivery/print regressions pass. Structured Document and Infinite export remain explicitly rejected; both applications reproduced that through the current export menu. No rich-document PDF bytes/pages were produced or visually certified in this pass. Mixed notebooks containing such pages therefore do not meet release acceptance.

The proposal compares Chromium print, a shared rich renderer using the current PDF writer, and per-sheet raster output. Browser download, fonts, tables/math, annotations and continuous-to-sheet layout require a substantial renderer decision before implementation. No exporter/backend replacement was made.

## Measured performance and bundle

Same 100-notebook/800-page fixture, six actual expand/collapse interactions per runtime; timings include action delivery, metadata work and layout settling. Initial visual cleanup removed height animations; measured remaining whole-store subscriptions then justified memoized leaf rows with narrow active/rename selectors and fresh event-time metadata reads.

| Measurement | Before | Current |
| --- | ---: | ---: |
| Chromium tree median settling | 595.7 ms | 191.8 ms |
| Electron tree median settling | 799.7 ms | 317.3 ms |
| Longest observed tree long task, Chromium | 151 ms | 68 ms |
| Longest observed tree long task, Electron | 95 ms | 67 ms |
| Palette median open, Chromium, 10 samples | 44.4 ms | 44.1 ms |
| Palette median open, Electron, 10 samples | 44.8 ms | 45.6 ms |

Palette timing is essentially unchanged; its ten color interactions cause **zero editor `getJSON` calls and zero editor DOM mutations**. Tree settling improved, but 1,000-row navigation is not instant; metadata/parent-tree work and cold activation remain measurable. No save debounce, pagination rewrite or speculative document cache was introduced. [Raw tree samples](../../artifacts/documentation-release-prep-20261016/checkpoint1/large-tree/after-electron.json) include the slower first action.

Current final gate: **1,771,583 support-JS gzip bytes / 1,800,000 allowed**; total application JS is 1,943,405 bytes gzip. The fresh post-security pre-optimization support build was 1,851,248 bytes. Developer benchmark UI is now development-only and disabled model preparation is statically guarded. Standard [Vite 6 Terser minification](https://v6.vite.dev/config/build-options#build-minify), two safe compression passes, supplied most of the reduction; Terser 5.51.2 is a build-only dependency with two new helper packages. No product feature, budget, asset exclusion rule or security check was removed to pass. This trades some build time for smaller generated JavaScript. [Gate output](../../artifacts/documentation-release-prep-20261016/bundle-gate.json).

## Exact files changed in this pass

Palette and startup:

- [src/lib/highlightPalette.ts](../../src/lib/highlightPalette.ts)
- [src/stores/notebookSettingsStore.ts](../../src/stores/notebookSettingsStore.ts)
- [src/components/notebook/TextColorPalette.tsx](../../src/components/notebook/TextColorPalette.tsx)
- [src/components/notebook/useTextHighlightMode.ts](../../src/components/notebook/useTextHighlightMode.ts)
- [electron/ipc/WorkspaceService.ts](../../electron/ipc/WorkspaceService.ts)

Sidebar and confirmed legacy interaction defects:

- [src/components/layout/Sidebar.tsx](../../src/components/layout/Sidebar.tsx)
- [src/components/workspace/WorkspaceTree.tsx](../../src/components/workspace/WorkspaceTree.tsx)
- [src/components/workspace/workspaceTreeKeyboard.ts](../../src/components/workspace/workspaceTreeKeyboard.ts)
- [src/styles/index.css](../../src/styles/index.css)
- [src/repositories/CanvasRepository.ts](../../src/repositories/CanvasRepository.ts)
- [public/excalidraw-config.js](../../public/excalidraw-config.js)

Security, build and existing sync path:

- [package.json](../../package.json)
- [package-lock.json](../../package-lock.json)
- [vite.config.ts](../../vite.config.ts)
- [src/app/App.tsx](../../src/app/App.tsx)
- [src/services/recognition/modelPreparation.ts](../../src/services/recognition/modelPreparation.ts)
- [src/services/cloudsync/payloadSource.ts](../../src/services/cloudsync/payloadSource.ts)
- [src/services/cloudsync/v2/workspaceCopy.ts](../../src/services/cloudsync/v2/workspaceCopy.ts)

Tests/reports:

- [tests/highlight-palette.test.ts](../../tests/highlight-palette.test.ts)
- [tests/documentation-security.test.ts](../../tests/documentation-security.test.ts)
- [tests/documentation-release-checkpoint1-browser.mjs](../../tests/documentation-release-checkpoint1-browser.mjs)
- [tests/documentation-portability-audit.mjs](../../tests/documentation-portability-audit.mjs)
- [tests/cloud-sync-v2.test.ts](../../tests/cloud-sync-v2.test.ts)
- [tests/documentation-engine-browser.mjs](../../tests/documentation-engine-browser.mjs)
- [tests/documentation-final-cases.mjs](../../tests/documentation-final-cases.mjs)
- [tests/text-highlight-mode-browser.mjs](../../tests/text-highlight-mode-browser.mjs)
- This report and [the portability/export proposal](documentation-portability-export-proposal-2026-10-16.md)

## Remaining release decisions

**Must fix before stable release:** asset-complete backup/restore with correct reference remapping and clean-profile integrity; rich fixed/Infinite/mixed PDF export; unresolved dependency security findings and the required end-to-end acceptance of those paths. Live Drive acceptance must be established separately before claiming that integration verified.

**Beta limitations requiring explicit owner acceptance:** remaining large-tree settling latency; browser storage durability depending on its existing permission/status model; unavailable physical touch/stylus/real WinRT acceptance. None is silently marked accepted.

**Future improvements:** streaming backups beyond the current size limit, further tree virtualization/indexing if justified by larger measured workloads, and broader assistive-technology/device coverage.

Implemented local behavior still awaits your visual/manual acceptance. Use the documented `npm run start` for Electron review. Native OS picker preview behavior should also receive a manual check; automated color-input commits and palette mouse/keyboard interactions passed.

All 127 starting dirty/untracked files remain present; 116 remain byte-identical and the other 11 have intentional scoped edits. The sampled real user drawing hash and HEAD `a1f301797a72eac165ca37afb87df2bd78c3b695` are unchanged. Starting files and previous generated builds were preserved outside the worktree. No reset, commit, push, merge, installer/release packaging, deployment or landing-page edit was performed. Ordinary production builds were made only for local validation. [Preservation audit](../../artifacts/documentation-release-prep-20261016/preservation-audit.json).

Stop here for manual review of this implementation and the two bounded milestones in the proposal. The major backup-contract and rich-PDF architecture work requires the review specified in your current briefs.
