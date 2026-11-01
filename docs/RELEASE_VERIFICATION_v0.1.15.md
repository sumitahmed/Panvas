# v0.1.15 Verification — 2026-11-01

Release consolidating Cloud Sync V2 conflict resolution, dangling parent import resilience, and hardened browser Google Identity Services diagnostics.

- **Release Scope & Highlights:**
  - **Deterministic Conflict Resolution:** Resolving workspace conflicts with "Use this device" or "Use Google Drive" deterministically updates remote manifests and local baselines, returning the workspace cleanly to `synced` (`tests/cloud-drive-choice-browser.test.mjs`, `tests/cloud-store-device-choice-browser.test.mjs`, `tests/cloud-ws-conflict-probe.mjs`).
  - **Dangling Parent Tolerance:** Remote workspace imports safely tolerate missing or unlinked parents without failing the entire cycle (`tests/cloud-import-parents-browser.test.mjs`).
  - **Google Identity Diagnostics:** Clear feedback for popup blockers, cancellation, and timeout states.
  - **Sanitized Tracing:** Zero-leak local sync diagnostic tracing with strict privacy contracts.

- **Automated Verification:**
  - `npm run typecheck`: 0 errors across main and Electron TypeScript configs.
  - `npm run test:release-units`: 29/29 passed.
  - `npm run test:package-c`: 61/61 passed.
  - `npm run test:cloud-workspace-flow`: 17/17 passed.
  - `npm run test:cloud-returning-browser`: 6/6 passed.
  - `npm run test:cloud-choice-browser`: 4/4 passed.
  - `npm run test:cloud-import-parents`: 5/5 passed.
  - `npm run test:cloud-store-choice`: 3/3 passed.
  - `npm run test:cloud-ws-conflict`: 3/3 passed.
  - `node --test tests/cloud-real-provider-probe.mjs`: 2/2 passed.
  - `node --test tests/release-readiness.test.ts`: 7/7 passed.
  - `npm run check:release`: All bundle and security budgets verified:
    - Main entry gzip: 171,845 bytes (limit: 1,500,000)
    - Support JavaScript gzip: 1,701,473 bytes (limit: 1,800,000)
    - Total application JavaScript gzip: 1,873,318 bytes (limit: 3,000,000)
    - Largest Electron chunk: 251,668 bytes (limit: 260,000)
    - Source maps in bundle: 0
    - Sensitive config files packaged: 0

- **Public Assets & Cryptographic Checksums:**
  - `Panvas-0.1.15-Setup.exe` (284,281,791 bytes, SHA-256: `82e977afd73e6813a1c22852d91de2c9723c153911bd97a67c9e961ab45208bc`)
  - `Panvas-0.1.15-Portable.exe` (283,966,307 bytes, SHA-256: `4297a764a1ff152f64c415d882d046d71027ec26ca5a3104b479a49cc2dd615f`)
  - `Panvas-0.1.15-Web.zip` (38,827,365 bytes, SHA-256: `ec3be079f5e9cb2d1cfc3de88bf68fd44550398af4fda1c8e565584946a8d7cc`)
  - Manifest `SHA256SUMS.txt` generated in `release/`.

- **Notes & Limitations:** Windows installer and portable executables are unsigned open-source binaries and may trigger Windows SmartScreen. Existing storage and application data are preserved across upgrades.
