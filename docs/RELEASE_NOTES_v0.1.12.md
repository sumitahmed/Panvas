# Panvas v0.1.12

## Highlights

### 1. Selection Tool & Dense-Page Interaction Performance
- **Zero-Allocation Transform Blitting**: Transformed selection move, rotate, and scale performance on resource-dense notebook pages (2,000+ strokes, 100,000+ points). Eliminated continuous per-frame CPU geometry re-extrusion during drag by rendering pre-compiled `Path2D` vector geometry with affine Canvas2D GPU transforms (`translate`, `rotate`, `scale`).
- **Persistent Selection Backing Canvas**: Unselected scene elements are preserved on a cached backing canvas during active manipulation, blitting in ~0.2ms and clearing only the localized damage bounding box, dropping per-frame drag rendering time from >25ms to <1.8ms under 4× CPU throttling (>10× speedup, rock-solid 60+ FPS).
- **Spatial AABB Bounding Box Rejection**: Added an $O(1)$ stroke lookup map and cached AABB spatial filtering across `findStrokesNearPoint`, handle detection, and lasso loop selection, culling non-overlapping scene elements in $O(1)$ float comparisons before inspecting point arrays.
- **Continuous Multi-Page Scroll Optimization**: Eliminated expensive synchronous scene serialization (`getDrawingData()`) across page boundaries during passive vertical scrolling when pages are unmutated, and eliminated duplicate canvas redraws on page load in `NotebookEngine`.

### 2. Cloud Sync V2 Presentation & Reliability
- **Unified Cloud Sync Status UI**: Synchronized status presentation across `StatusBar`, `SyncIndicator`, and `SettingsCloudConnection` to accurately reflect Google Drive V2 status (`Connected`, `Syncing`, `Synced`, `Offline`, `Reconnect required`) when legacy cloud sync is quarantined (`VITE_ENABLE_CLOUD_SYNC=false`).
- **Startup Sync & Network Event Initialization**: Ensured cloud sync state restoration, saved connection hydration, and online/offline connectivity listeners initialize reliably on application start under the V2 sync gate.

### 3. Browser Google Drive OAuth & Diagnostics
- **Robust Browser Google OAuth Flow**: Resolved browser Google Drive sign-in failures by ensuring the production Web Client ID is guaranteed with a safe build fallback, and capturing full Google Identity Services (GIS) token and popup diagnostics (`popup_closed_by_user`, `access_denied`, `popup_failed_to_open`, origin mismatches).
- **Safe Diagnostic Retention & Redaction**: Sanitized all diagnostic data to prevent leaking sensitive OAuth bearer tokens or client secrets while providing actionable error messages and persistent error banners in the Cloud Sync panel.

### 4. Comprehensive Regression Verification
- Added automated regression suites verifying Google Drive V2 status presentation consistency, browser OAuth error capture, and high-density selection/scroll frame budgets.

## Notes & Limitations

- Windows installer and portable executables are unsigned open-source binaries and may trigger Windows SmartScreen. Verify the published SHA-256 manifest before running them.
- Existing storage and application data are preserved across upgrades.
