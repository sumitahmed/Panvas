# Panvas v0.1.2 Hotfix

Panvas v0.1.2 is a production-critical hotfix resolving Google Drive reconnect loops and hardening the cloud synchronization authentication lifecycle.

## What's Changed

### Fixed
- **Google Drive Reconnect Loops**: Fixed reconnect loops occurring after OAuth authentication expires or consent is renewed.
- **Refresh Token Preservation**: Correctly preserved refresh tokens in encrypted storage when Google does not return a new refresh token during reauthentication.
- **Cache Invalidation**: Cleared stale Google Drive provider/session folder caches during reconnect attempts to avoid stale 401/403 states.
- **OAuth Loopback Listener Hygiene**: Fixed repeated OAuth attempts leaving dangling loopback listeners by tracking and cleanly closing active server instances.
- **Immediate State Synchronization**: Fixed stale reconnect warnings persisting in the UI after successful authentication.
- **Sanitized Error Diagnostics**: Improved Google Drive connection/auth error handling with structured, non-leaking diagnostic codes.
- **Browser Reconnect Persistence**: Improved browser-local Google account reconnect persistence and session recovery.

### Reliability
- **Preserved Sync Relationship**: Reconnecting the same Google account now cleanly resumes the existing sync relationship.
- **Zero Data Disruption**: Existing workspaces, workspace IDs, local storage, and sync baselines are fully preserved.
- **No Duplicate Entities**: Reauthentication no longer creates duplicate workspaces or accounts.

### Validation
- **Full tests**: 609 passed, 1 skipped
- **Cloud reliability tests**: 54 passed, 0 failed
- **Targeted reconnect suite**: 18 passed, 0 failed
- **TypeScript**: passed (`tsc --noEmit && tsc -p tsconfig.electron.json --noEmit`)
- **Production web & Electron build**: passed
- **Release check**: passed

## Availability & Downloads
- **Web App**: Live at [panvas.vercel.app/app](https://panvas.vercel.app/app)
- **Windows 10/11 (64-bit)**: `Panvas-0.1.2-Setup.exe` (265,324,472 bytes), distributed directly from this GitHub Release.
- **Project Site**: [panvas.vercel.app](https://panvas.vercel.app/)
- **Source Code**: [github.com/sumitahmed/Panvas](https://github.com/sumitahmed/Panvas)

## Installer Verification

The Windows installer is unsigned (v0.1.2); verify the SHA-256 checksum locally against `SHA256SUMS.txt`:

```powershell
Get-FileHash Panvas-0.1.2-Setup.exe -Algorithm SHA256
```

Expected SHA-256 hash:
`1bd99a9b292d308dfd420b4a1abccfe34dc08cdc50b75f9ad806f612b9121d3c`
