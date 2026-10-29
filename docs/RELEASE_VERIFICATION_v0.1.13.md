# v0.1.13 Verification — 2026-10-29

The owner verified the drawing performance, selection responsiveness, and cloud-sync resolution in local testing. This production release consolidates all performance optimizations and stability fixes into tag `v0.1.13`.

- **Release Scope & Highlights:**
  - **Fluid Live Handwriting & Frame-Drop Elimination:** Completely removed the intermittent frame drops during pen contact by deferring drawing persistence cache notifications during active strokes, adding allocation-free fast-path and `WeakMap` memoization to `canonicalizeJson`, and introducing cooperative event-loop yielding (`setImmediate` / `setTimeout(0)`) in background cloud-sync hashing.
  - **Selection Stability & Responsiveness:** Resolved coordinate space and bounding-box magnification bugs during selection transformations. Group translation, rotation, and scaling execute in under 16ms per frame even with 500+ dense strokes.
  - **Cloud Sync Review & Resolution Reliability:** Stabilized the Cloud Sync conflict review interface. The three conflict resolution actions (**Use Google Drive**, **Use this device**, **Keep both**) render reliably whenever review is active, and resolving conflicts via **Use this device** completes the resolution flow and restores synced status cleanly.
  - **Dense Multi-Page Scrolling:** Smooth page transitions, residency virtualization, and debounced position tracking.

- **Automated Verification:**
  - `npm run typecheck`: 0 errors across main and Electron TypeScript configs.
  - `npm run test:release-units`: 29/29 passed (backup serialization, custom blocks, TipTap headings, math delimiters, storage overview).
  - `npm run check:release` & `npm run check:release:web`: All bundle and security budgets verified:
    - Main entry gzip: 171,837 bytes (limit: 1,500,000)
    - Support JavaScript gzip: 1,697,271 bytes (limit: 1,800,000)
    - Total application JavaScript gzip: 1,869,108 bytes (limit: 3,000,000)
    - Largest Electron chunk: 250,461 bytes (limit: 260,000)
    - Source maps in bundle: 0
    - Sensitive config files packaged: 0
  - Regression Suites:
    - `tests/handwriting-frame-drop-regression.test.ts`: 4/4 passed.
    - `tests/handwriting-fidelity.test.ts`: 27/27 passed.
    - `tests/selection-performance-regression.test.ts`: 8/8 passed.
    - `tests/release-readiness.test.ts`: 7/7 passed.
    - `tests/browser-bootstrap.test.ts`: 7/7 passed.
    - `tests/cloud-sync-production-ui.test.mjs`: 5/5 passed.

- **Public Assets & Cryptographic Checksums:**
  - `Panvas-0.1.13-Setup.exe` (284,275,816 bytes, SHA-256: `2a64d3d54a53e5291dd39508e1f5625e3e02772a92c61f2bdbc5747cda87693d`)
  - `Panvas-0.1.13-Portable.exe` (283,960,327 bytes, SHA-256: `d0b837e68d1aba6caecbeef269dfa105c7c5bd7cc5b20667c9cff2b2bce44ccd`)
  - `Panvas-0.1.13-Web.zip` (38,823,166 bytes, SHA-256: `2a4567025f13e6024f332ed80c6a96a0a240d5c8e7f876ab4f3ad9097f5af3f1`)
  - Manifest `SHA256SUMS.txt` published on GitHub Releases.

- **Notes & Limitations:** Windows installer and portable executables are unsigned open-source binaries and may trigger Windows SmartScreen. Existing storage and application data are preserved across upgrades.
