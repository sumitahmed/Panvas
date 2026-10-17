# Known limitations

This list describes the current release scope. It is intentionally short; a behavior belongs here only when it is a known product or distribution constraint.

## Windows distribution

- The Windows installer is unsigned. Windows SmartScreen may show an unrecognized-app warning on first launch.
- Verify the installer against the `SHA256SUMS.txt` manifest supplied with the same GitHub Release. Do not use a hash copied from another page or mirror.
- For an unpublished local candidate, use its local checksum manifest. Clean install/upgrade/uninstall and the final native custom-color popup interaction require owner review in an isolated environment.

## Browser storage and compatibility

- The web build stores workspace records in origin-scoped Dexie/IndexedDB. Browser quota, eviction, private browsing policies, and manual site-data clearing can remove or limit local data. Export important workspaces regularly.
- The Windows Electron build is the primary release target. Chromium-based browsers are the main web target; Firefox and Safari are best-effort and may differ in pointer, storage, or handwriting capabilities.

## Handwriting-to-text

- Windows recognition uses the Windows Ink bridge when available. The web build uses the browser-native handwriting API only where that API is present. Unsupported environments preserve the original ink but do not convert it.
- The experimental local neural recognition fallback is disabled because it has not met the project's accuracy bar.

## PDFs and large documents

- Rendering and exporting a large PDF with many pages or annotations can require substantial memory and time. Password-protected PDFs may need to be unlocked before import.

## Cloud Sync

- Google Drive Cloud Sync is controlled by build-time flags, disabled in the example environment (`VITE_ENABLE_CLOUD_SYNC=false` and `VITE_PANVAS_SYNC_V2=false`). It is not required for local editing, and local storage remains authoritative.
- Deterministic two-replica/fault tests do not establish live Google Drive or Supabase acceptance. Provider credentials and approved disposable accounts are required for that release gate.

## Build tooling

- The development toolchain currently has unpatched/upgrade-dependent denial-of-service advisories. Production dependency audit is a separate check. Use trusted source/configuration, keep dev servers on loopback and consult the candidate security/QA report before release. Do not use `npm audit fix --force` to migrate the UI/build stack implicitly.

## Scope boundaries

- The web build is local to its browser origin; it is not a hosted Panvas workspace or a cross-device service by default.
- Panvas is below 1.0. It is not a guarantee of zero defects, universal browser support, or permanent data compatibility. Keep independent backups of important work.

Report reproducible issues with the [bug report template](https://github.com/sumitahmed/Panvas/issues/new?template=bug_report.md). Remove secrets, private notes, personal files, and credentials from all reports.
