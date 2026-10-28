# Panvas v0.1.12

- **Unified Cloud Sync Status UI**: Fixed sync state synchronization so the status bar, top bar sync indicator, and settings surfaces accurately reflect Google Drive V2 status (`Connected`, `Syncing`, `Synced`, `Offline`, `Reconnect required`) when legacy cloud sync is quarantined (`VITE_ENABLE_CLOUD_SYNC=false`).
- **Startup Sync & Network Event Initialization**: Ensured cloud sync state restoration, saved connection hydration, and online/offline connectivity listeners initialize reliably on application start under the V2 sync gate.
- **Robust Browser Google OAuth Flow**: Resolved browser Google Drive sign-in failures by ensuring the production Web Client ID is guaranteed with a safe build fallback, and capturing full Google Identity Services (GIS) token and popup diagnostics (`popup_closed_by_user`, `access_denied`, `popup_failed_to_open`, origin mismatches).
- **Safe Diagnostic Retention & Redaction**: Sanitized all diagnostic data to prevent leaking sensitive OAuth bearer tokens or client secrets while providing actionable error messages and persistent error banners in the Cloud Sync panel.
- **Regression Coverage**: Added dedicated test suites verifying V2 status presentation consistency and browser Google OAuth error handling.

## Notes & Limitations

- Windows installer and portable executables are unsigned open-source binaries and may trigger Windows SmartScreen. Verify the published SHA-256 manifest before running them.
- Existing storage and application data are preserved across upgrades.
