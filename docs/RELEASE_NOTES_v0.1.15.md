# Panvas v0.1.15

This release delivers major Cloud Sync V2 conflict resolution reliability improvements, hardened Google Drive authentication diagnostics across browser extensions, and deterministic multi-device workspace convergence. No changes to core note-taking or handwriting models were introduced; existing user data and local workspaces remain completely intact.

## Highlights

### 1. Deterministic Google Drive Conflict Resolution
- **Reliable "Use this device" and "Use Google Drive" resolution**: Choosing a resolution option for a conflicted workspace now deterministically stages, publishes, and converges manifests without leaving behind unresolved pending items.
- **Atomic manifest and baseline synchronization**: Manifest revision updates and baseline snapshots are committed in lockstep, ensuring the workspace returns to a clean `synced` status on the subsequent cycle.
- Covered by dedicated browser regression suites (`tests/cloud-drive-choice-browser.test.mjs`, `tests/cloud-store-device-choice-browser.test.mjs`, and `tests/cloud-ws-conflict-probe.mjs`).

### 2. Resilient Remote Workspace Import
- **Dangling parent tolerance**: Remote workspace imports gracefully handle missing or dangling parent relationships (such as orphaned PDF annotations or asset references) without failing the entire workspace sync.
- **Safe local adapter commits**: Atomic local database transactions normalize legacy or divergent records safely before applying remote changes.
- Covered by `tests/cloud-import-parents-browser.test.mjs`.

### 3. Clear Google Identity & Browser Extension Diagnostics
- **Actionable sign-in error feedback**: Google Identity Services (GIS) error handlers distinguish between popup blockers (such as desktop Chrome ad-blocker extensions), user-initiated cancellations, and network timeouts.
- **User activation preservation**: Synchronous popup launch preserves user activation tokens in compliant Chromium and Electron runtimes.

### 4. Zero-Leak Local Development Sync Tracing
- **Sanitized diagnostic logging**: Local development tracing (`syncTrace.ts`) strictly limits logged events to safe stage identifiers, operation codes, and anonymized workspace IDs.
- **Privacy preservation**: Tokens, emails, filenames, and document payloads never enter trace logs, ensuring complete diagnostic safety.

## Verification

- `npm run typecheck`, `npm run test:release-units`, `npm run test:package-c`, and `npm run check:release` pass.
- End-to-end browser suites for conflict choices, remote imports, returning devices, and real provider emulation pass.
- Packaged Windows binaries built and verified against SHA-256 manifests.

## Notes & Limitations

- Windows installer and portable executables are unsigned open-source binaries and may trigger Windows SmartScreen. Verify the published SHA-256 manifest before running either file.
- Existing storage, notebooks, canvases, and local configuration are strictly preserved across upgrades.
