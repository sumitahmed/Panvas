# Browser and desktop capability matrix

This matrix describes the current platform boundary. It is a practical guide, not a promise of identical behavior on every browser or device.

| Capability | Windows Electron | Web build |
| --- | --- | --- |
| Workspace storage | Filesystem under `Documents/Panvas/` by default; configurable root | Origin-scoped Dexie/IndexedDB |
| Offline local editing | Yes, subject to local filesystem availability | Yes after the app is loaded and storage is available |
| Notebook ink | Pointer/stylus input through the Electron renderer; Windows Ink H2T bridge where available | Pointer/stylus input; browser-native H2T only where the API exists |
| Rich text | Yes | Yes |
| PDF rendering/annotation | Yes | Yes, subject to browser memory and worker support |
| Visual canvas | Excalidraw-powered | Excalidraw-powered |
| Backup/export | Native file dialogs and local files | Browser downloads/uploads |
| Cloud Sync | Optional Google Drive integration; build-time configuration required | Optional Google Drive integration; build-time configuration required |

Chromium-based desktop browsers are the primary web target. Firefox and Safari are best-effort. Browser storage can be limited or cleared by the browser or operating system; it is not a substitute for an exported backup.

See [STORAGE_AND_PERSISTENCE.md](STORAGE_AND_PERSISTENCE.md) for data handling and [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md) for current constraints.
