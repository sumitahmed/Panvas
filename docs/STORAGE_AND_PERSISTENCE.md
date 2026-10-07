# Storage and persistence

Panvas keeps local data authoritative in both execution profiles. The adapter changes by platform; the domain model and user-visible recovery flows remain shared.

## Windows Electron layout

The default root is `Documents/Panvas` (`app.getPath('documents')/Panvas`). The user can select another validated storage root in settings. A workspace is stored below that root:

```text
<storage-root>/
  <workspace>/
    .panvas/
      workspace.json
      settings.json
      recovery/
        workspace.last-good.json
    Notebooks/
      <notebook-id>/
        notebook.json
        pages/
          <page-id>.json
          <page-id>.content.json
          <page-id>.drawing.json
    Canvas/
      <canvas-id>.json
    Assets/
      images/
      pdfs/
      videos/
      audio/
      attachments/
```

The exact payload fields are defined in `src/types/` and the Electron IPC handlers. Existing workspace directories are not moved merely because the preferred root changes; explicitly opened roots remain discoverable.

## Write and recovery path

Desktop JSON writes use `electron/ipc/write-queue.ts`. Operations are serialized, written to a temporary path, and then replaced so an interrupted write does not intentionally publish a partial primary file. The workspace service refreshes a last-good metadata mirror under `.panvas/recovery/` and can use it when the primary manifest is unreadable.

Binary assets are kept separate from JSON payloads. Cropping, page ordering, and annotation metadata do not rewrite the original imported bytes unless an explicit export creates a new file.

## Browser profile

The web adapter uses Dexie over origin-scoped IndexedDB (`src/database/schema.ts`). The database belongs to the browser profile and origin; another browser or device does not see it automatically. Browser quotas, eviction, private-window behavior, and site-data clearing are outside Panvas's control. Use workspace backup/export for portability and independent recovery.

## Migration and backup

Electron may import legacy Dexie records into filesystem storage after startup. The migration is idempotent and keeps source records when an attempt does not complete. Workspace backup export/import is the supported user-facing migration and recovery path.

## Optional cloud layer

The example environment disables Google Drive sync with `VITE_ENABLE_CLOUD_SYNC=false` and `VITE_PANVAS_SYNC_V2=false`. When explicitly enabled and configured, it operates as an asynchronous remote layer; local records and local recovery remain the authority. See [CLOUD_SYNC_V0_1_ARCHITECTURE.md](CLOUD_SYNC_V0_1_ARCHITECTURE.md) and [CLOUD_SYNC_DEVICE_RESET.md](CLOUD_SYNC_DEVICE_RESET.md).

## Contributor rules

Treat storage and migration changes as high-risk. Update repositories, schema versions, migration tests, recovery behavior, and this document together. Never log or commit private workspace contents, absolute personal paths, OAuth credentials, or generated storage directories.
