# v0.1.8 verification — 2026-10-17

The owner accepted 0.1.8-rc.1 and authorized the stable release. The implementation was retained; final changes cover stable versioning, repository hygiene, release metadata/automation and verification harnesses.

## Final local checks

| Check | Result |
| --- | --- |
| Native/web type checks and production builds | Passed |
| Main unit gate | 919 passed, one optional Windows recognition skip |
| Release unit gate | 29 passed |
| Controlled cloud/provider recovery integration | 24 passed; not live provider acceptance |
| Final packaged and portable Windows applications | Executed on Windows; exact save/reopen and secure renderer checks passed |
| Published 0.1.7 native data to final 0.1.8 | 26 legacy workspace files remained byte-identical before opening; hierarchy, rich text, ink, image/PDF/audio, PDF annotations and preferences read correctly and survived restart |
| Code controls | Actual Chromium and packaged Electron UI: language, syntax, copy, wrap, undo/redo, exact saved JSON and reopen passed |
| Backup/restore | All four Chromium/native source/destination combinations passed, including media hashes, corrupt-input rejection, v1 warnings and reopen |
| PDF export | Seven native UI exports passed structural/content/page-bound checks; A4, Infinite and Letter samples were rendered and visually inspected |
| Document flow | Four focused runtime groups passed, including A4 continuation, Infinite mode and repository reopening |
| Populated notebook | Scroll, pan, draw, switch, erase and select regression scenarios passed; these fixture measurements are not an hours-long acceptance test |
| Docker | Config, build, health, startup/logs, UI, offline saves, restart, browser reopen, routes, responsive widths and headers passed |
| Repository/package hygiene | Explicitly enumerated staging; no generated binaries, user data, local credentials or personal absolute paths in staged inputs; package audit passed |

One full backup harness attempt timed out waiting for native fixture startup while other builds were running. A subsequent full matrix passed without a product change or weaker data assertions. Pre-deployment browser data is a synthetic legacy IndexedDB fixture rendered by the existing production application in a disposable profile; it is retained for the post-deployment check.

The first hosted CI run exposed electron-builder's inferred CI publisher and a Windows Node test-process assertion in the single-instance harness. Packaging now explicitly uses `--publish never`; the dedicated release step owns uploads. The test now isolates its workspace as well as its profile, clears its losing timeout and waits for owned processes to exit before cleanup. Its seven assertions pass under the exact checksum-verified Node 24.21.0 Windows runtime used by CI. The application implementation and data formats were unchanged by these CI corrections.

The hosted Node test-worker assertion recurred after the cleanup correction. The native lifecycle now runs in a plain child process, with the original lock/exit assertions retained; a child crash, failed assertion or timeout still fails the parent test. The complete unit gate passes with that arrangement on the exact CI Node runtime. The rebuilt setup/portable wrappers contain byte-identical `app.asar` and `Panvas.exe` payloads; the final portable's serial save/reopen UI run passed. One parallel portable reopen attempt timed out and is retained in local evidence rather than counted as a pass.

## Security and practical limits

- Fresh production npm audit: zero findings. Full audit: 16 development-tooling findings (5 high, 11 moderate), rooted in `braces`, `postcss-selector-parser` and `sprintf-js`. They affect build/development input processing; no forced major-version migration or audit suppression was applied. See the [advisory review](research/production-readiness-security-2026-10-17.md).
- The checksum-verified Grype scanner's vulnerability database download exceeded its 150-second final retry. No container OS-CVE verdict is claimed.
- Existing Desktop OAuth public-client configuration matches the previously published native payload. It stays in the native main bundle, with PKCE; no user access/refresh tokens are distributed. The package audit permits only this explicitly selected native public-client case and still rejects renderer copies or other confidential values. [Google documents installed apps as public clients](https://developers.google.com/identity/protocols/oauth2/native-app). Source control contains configuration names, never the local values.
- Future workflow publication of a sync-enabled binary requires the existing Desktop OAuth configuration in Actions secrets. Build-only CI artifacts do not establish configured/live authentication. The current Windows release uses the existing configured local production build.
- Installer and portable executables are unsigned. Upgrade verification executed the published and final packaged applications against disposable data; it did not run a full NSIS install/upgrade/uninstall cycle or alter the normal installation. The unchanged app ID/storage defaults and `deleteAppDataOnUninstall: false` are checked separately.
- Complex PDF fixtures can report fidelity warnings; export tests do not imply perfect fidelity for every CSS/font construct. Physical stylus, hours-long use, live authorized Drive/Supabase accounts and other OS/browser targets remain separate acceptance scopes.
- The normal profile, notebooks, workspace roots, IndexedDB and remote account data were not cleared or migrated. No dependency version was changed for this release finalization.

Public download and deployment verification is recorded separately after the upload; local passes alone are not proof that public assets exist.
