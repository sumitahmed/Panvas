# Production preparation — 2026-10-17

The unpublished local candidate is `0.1.8-rc.1`. It is awaiting owner review, not declared stable or approved for publication.

Full A–H report, actual Windows/web/Docker deliverables, evidence and manual checklist:

`artifacts/release-candidate/Panvas-0.1.8-rc.1/QA_REPORT.md`

## Implemented

- Retained native shared-media roots for PDF/image/audio reads, portable backup reads and the existing sync scanner. Reproduced ordinary folder changes and an unavailable legacy root, then verified exact bytes after changes, reconnection and restart without relocating files.
- Packaged applications ignore an inherited development-server URL. The real executable reproduced the failure before the guard; final packaged/portable UI checks exercise the corrected boundary.
- Clean native output, implementation-chunk budgets, x64/package/private-value audit, actual NSIS/portable packaging and local checksums.
- Production/development Docker for the actual static web architecture, health, non-root/read-only production operation, hot reload, explicit public configuration and truthful browser-owned persistence.
- CI and manual future release workflows, current environment/setup/contribution/security/troubleshooting/review docs, application-vs-published version separation, sitemap/OG metadata and duplicate footer cleanup.

## Verification and limits

The broad command passed 919 of 920 test executions with one optional Windows recognition skip; 29 additional unit regressions and 24 controlled sync/integration cases passed. Real Chromium/Electron code controls, persistent highlight gestures, save/reopen, native failure/trash/recovery, browser migration and HTTPS offline reload passed. The 1000-paragraph accelerated workload used 480 typed transactions and 24 notebook switches per app, with exact save checkpoints and bounded heap/listener observations. No editor/pagination/sync-model rewrite was made.

Production dependency audit reports zero vulnerabilities; the full development audit still reports 16 (5 high, 11 moderate). Container OS-CVE scanning has no verdict: Scout requires login and Grype timed out. See [security review](production-readiness-security-2026-10-17.md).

The actual packaged and portable executables ran on Windows. Binaries are unsigned. Full NSIS install/upgrade/uninstall, the final native Custom-picker popup, live authorized provider acceptance, physical stylus/hours-long sessions and hosted workflows remain manual/blocked checks. The report distinguishes these from passing local simulations.

The working tree, prior outputs and user data were preserved. No commit, push, tag, upload, release, deployment, issue modification or landing-page publication was performed. Stop here for manual review; publication requires explicit subsequent owner approval.
