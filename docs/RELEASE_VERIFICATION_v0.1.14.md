# v0.1.14 Verification — 2026-10-31

Stability release consolidating four reported notebook regressions — image move ghosting, finite-behaving infinite pages, scroll-following page navigation, and freeform lasso selection — plus supporting select/ink hardening. Tag `v0.1.14` points at source commit `0b7cf8566791f9be927f836d656ff2a8b79c49e1`.

- **Release Scope & Highlights:**
  - **Image Move Ghosting:** Pasted images now preview imperatively through the DOM overlay during the drag and commit on drop; the stale canvas copy at the original position is eliminated (`tests/image-ghost-browser.mjs`).
  - **Continuous Infinite Page:** Infinite pages grow during the live stroke toward the content bottom plus a quarter-A4 trailing margin, with a viewport-following overhang raster window (`tests/infinite-page-browser.mjs`).
  - **Scroll-Following Navigation:** Passive page activation commits against the store, so the workspace tree follows the visible page through fast and upward scrolls, including intermediate pages (`tests/page-navigation-browser.mjs`, `tests/page-reorder-browser.mjs`).
  - **Freeform Lasso Selection:** The drawn polygon is the visible and movable selection boundary; the rectangular lasso remains available as a toolbar option (`tests/freeform-lasso-browser.mjs`).

- **Automated Verification:**
  - `npm run typecheck`: 0 errors across main and Electron TypeScript configs.
  - `npm test`: 729 passed, 0 failed, 1 pre-existing skip.
  - `npm run test:release-units`: 29/29 passed.
  - `npm audit --omit=dev --audit-level=moderate`: 0 vulnerabilities.
  - `npm run check:release` & `npm run check:release:web`: All bundle and security budgets verified:
    - Main entry gzip: 171,837 bytes (limit: 1,500,000)
    - Support JavaScript gzip: 1,699,812 bytes (limit: 1,800,000)
    - Total application JavaScript gzip: 1,871,649 bytes (limit: 3,000,000)
    - Largest Electron chunk: 250,461 bytes (limit: 260,000)
    - Source maps in bundle: 0
    - Sensitive config files packaged: 0
  - Browser regressions (real pointer input, Chromium): image-ghost, infinite-page, page-navigation, page-reorder, freeform-lasso — all PASS.
  - Regression suites: notebook-navigation (29 cases), notebook-responsive (33 regressions), notebook-performance (3 profiles), document-input, interaction-ux, mobile-overlays, pdf-mobile, panvas-performance, and the ink-quality harness (Chromium 11 phases; Electron 11 phases; Electron/DPR quick runs 10 phases each) — all PASS.
  - GitHub Actions `Verify` run 41187047670 (source, docker, windows-package): all green on `0b7cf85`.

- **Public Assets & Cryptographic Checksums:**
  - `Panvas-0.1.14-Setup.exe` (284,279,157 bytes, SHA-256: `b3d433215fabe8055e9b69f7b422d262213da3017823a8e31edd7e7d66ea4957`)
  - `Panvas-0.1.14-Portable.exe` (283,963,765 bytes, SHA-256: `908330c02559689344b77050bc667488b4685f6b10b4917cd15dd29cdf425bae`)
  - `Panvas-0.1.14-Web.zip` (38,825,586 bytes, SHA-256: `32a4f689ae0c7a315a3d4e4a22e8112b288ce5a40d46ebc40475b88dd3248c2e`)
  - Manifest `SHA256SUMS.txt` published on GitHub Releases; downloaded assets independently re-hashed and matched.

- **Notes & Limitations:** Windows installer and portable executables are unsigned open-source binaries and may trigger Windows SmartScreen. Existing storage and application data are preserved across upgrades.
