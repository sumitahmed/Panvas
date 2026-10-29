# Panvas v0.1.13

## Highlights

### 1. Fluid Live Handwriting & Zero-Lag Inking
- **Immediate Synchronous Inking**: Eliminated artificial `requestAnimationFrame` queue delays for solid pen strokes (`isFastWetInk`), delivering direct immediate ink rendering on stylus contact.
- **Removed Synchronous Style Reads on Pen Down**: Eliminated synchronous `getComputedStyle` queries in `WetInkSurface` during initial contact, eliminating input stalls at the start of writing.
- **Inter-Word Buffer Retention**: Extended spare wet-ink surface retention across inter-word pauses (from 250ms to 30,000ms), eliminating repetitive 50MB canvas reallocation and garbage-collection churn during continuous note-taking.

### 2. Elimination of Frame Drops and Inking Jitter
- **Sub-Millisecond Canonical JSON Hashing**: Upgraded `canonicalizeJson` with an allocation-free fast path for `StrokePoint` coordinates (`x`, `y`, `pressure`, `t`) and `WeakMap` object memoization. Dropped hashing on resource-dense drawings (1,200 strokes / 115,200 points) from ~198ms to 0.03ms (>5,000× speedup).
- **Spurious React Re-render Elimination**: Corrected `publishSnapshotPageData` in `NotebookRenderer` to avoid re-rendering the entire 3,270-line component tree on background save cycles when drawing revisions are unchanged.
- **Active Pen Gesture Deferral**: Added `pendingSectionPublishRef` in `NotebookRenderer` to defer any state publication while the stylus is actively in contact with the glass (`drawingGestureActive`), flushing cleanly on pen-up.
- **Cooperative Event-Loop Yielding in Cloud Sync**: Added cooperative event-loop yielding in `mapBounded` worker loops during background workspace scans and downloads, ensuring background cloud sync never starves the main thread or causes dropped pointer events.

### 3. Select Tool Geometry & Transform Fidelity
- **Eliminated Selection Distortion**: Fixed unintentional geometry stretching and magnification during drag-manipulation on dense notebook pages.
- **Zero-Allocation GPU Transforms**: Selection move, rotate, and scale operations utilize affine Canvas2D GPU transforms (`translate`, `rotate`, `scale`) with pre-compiled `Path2D` geometry rather than re-extruding strokes per frame.
- **Spatial AABB Bounding Box Filtering**: $O(1)$ spatial bounding box checks cull non-overlapping scene elements before testing point arrays.

### 4. Cloud Sync Local Conflict Resolution
- **Reliable Local Device Resolution**: Fixed the "The conflict is still present" failure when clicking **Use this device** in Storage → Cloud Sync, ensuring unresolved conflict records cleanly transition to `synced` and the review banner dismisses.
- **Consistent V2 Status Presentation**: Synchronized status indicators across `StatusBar`, `SyncIndicator`, and `SettingsCloudConnection` under the Google Drive V2 sync engine.

### 5. Multi-Page Scroll Optimization
- **Smooth Page Scrolling**: Eliminated synchronous scene serialization across page boundaries during passive vertical scrolling, keeping scrolling responsive even through multi-page dense notebooks.

## Notes & Limitations

- Windows installer and portable executables are unsigned open-source binaries and may trigger Windows SmartScreen. Verify the published SHA-256 manifest before running them.
- Existing storage and application data are preserved across upgrades.

