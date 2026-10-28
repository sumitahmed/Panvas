# v0.1.11 Verification — 2026-10-28

The owner manually tested and accepted the release test builds. Tag `v0.1.11` identifies release commit `101b77e812b186b5b5420ee9b691be055871f302`.

- **GitHub Release & CI:** [GitHub Release v0.1.11](https://github.com/sumitahmed/Panvas/releases/tag/v0.1.11) and [Workflow Run #40687237023](https://github.com/sumitahmed/Panvas/actions/runs/40687237023) completed with exit code 0 (`build` in 9m 20s, `publish` in 38s).
- **Automated Verification:** Full test suite, 29 release-unit tests, 109 feature regression tests (template boilerplate formatting, bookmarks, stylus cursor parity, laser duration/connectivity, 60fps selection performance), TypeScript typecheck, release packaging checks, and package ASAR audit passed cleanly.
- **Production Dependency Audit:** `npm audit --omit=dev --audit-level=moderate` reports 0 vulnerabilities following the updates to `dompurify` (3.4.17) and `zod` (4.6.7).
- **Public Assets & Cryptographic Checksums:**
  - `Panvas-0.1.11-Setup.exe` (284,266,204 bytes, SHA-256: `e3da02c1bf2d9727ab55ffded452daeb867cfc96ccc75ade8273d6ae5919a7db`)
  - `Panvas-0.1.11-Portable.exe` (283,950,702 bytes, SHA-256: `d70f34766e3a58f93decdc00720da905e22bc7b33091a45ace2ec59c68bfed67`)
  - `Panvas-0.1.11-Web.zip` (38,814,980 bytes, SHA-256: `24f2eae3d5be958397051e924846a24743396aae857a1a2c39e4591d689e72a4`)
  - Manifest `SHA256SUMS.txt` published on GitHub Releases.
- **Notes & Limitations:** Windows installer and portable executables are unsigned open-source binaries and may trigger Windows SmartScreen. Existing storage and application data are preserved across upgrades.

