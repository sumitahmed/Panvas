# Legacy sync transport contract

This contract explains the legacy provider-neutral transport. The renderer-side Supabase engine remains **legacy/quarantined**. For the current Google Drive v2 protocol, see [CLOUD_SYNC_V0_1_ARCHITECTURE.md](CLOUD_SYNC_V0_1_ARCHITECTURE.md).

## Boundary and selected architecture

Panvas remains local-first. A successful local save is complete without a network, account, or provider. Sync is an explicitly enabled transport for a selected workspace; it never becomes the canonical store and disabling it never removes or hides local content.

Electron keeps refresh/access tokens in the main process and OS-protected storage. Browser/PWA uses the Google Identity Services token model: the build contains only a public Web OAuth client ID, the short-lived access token remains in memory, and expiry requires token reacquisition. Browser canonical documents remain in IndexedDB and use the same provider-neutral object/manifest engine.

No Electron provider token, refresh token, client secret, raw path, or unrestricted filesystem operation may cross the preload boundary. Electron remote application uses only a validated record capability. In browser builds there is no client secret or refresh token; the short-lived access token is memory-only and provider requests remain constrained to the Google Drive adapter.

The renderer-side Supabase data-sync engine is **legacy/quarantined** and is not the Google Drive transport. `VITE_ENABLE_CLOUD_SYNC` remains a release gate; enablement requires provider configuration and validation.

## Canonical local sources

| Record family | Electron canonical source | Browser canonical source | Sync-0 requirement |
| --- | --- | --- | --- |
| Workspace, folder, canvas/notebook/page metadata and tombstones | `.panvas/workspace.json` plus recovery mirror | IndexedDB domain tables | Versioned records with stable IDs and parent references |
| Canvas scene and custom blocks | `Canvas/<canvasId>.json` | `canvasData` and `customBlocks` | One opaque, hash-verified scene record in v1 |
| Rich page content | `Notebooks/<notebookId>/pages/<pageId>.content.json` | `notebookPageContents` | Independent versioned record |
| Page/PDF drawing, layers, shapes and audio references | `Notebooks/<notebookId>/pages/<pageId>.drawing.json` | `notebookPageDrawings` | Independent versioned record |
| PDF, image and audio bytes | validated global asset stores keyed by generated ID | `pdfFiles`, `imageFiles`, and browser audio blobs | Immutable content-addressed objects plus reference metadata |
| Local Elements and workspace tool presets | `.panvas/settings.json` | workspace-scoped local storage/settings | Versioned workspace settings records; built-ins are not uploaded |
| View/session state | local UI stores | local UI stores | Never synchronized in v1 |
| Obsidian knowledge vault | separate read-only knowledge contract | unavailable | Never synchronized by Panvas cloud sync |

## Remote format

Each opted-in workspace has one manifest and immutable record/object payloads. JSON is UTF-8 with canonical key ordering before SHA-256 hashing.

```ts
interface SyncManifestV1 {
  format: 'panvas-sync';
  schemaVersion: 1;
  workspaceId: string;
  revision: number;
  previousRevision: number | null;
  writerDeviceId: string;
  generatedAt: string; // diagnostic only; never used for conflict ordering
  records: RecordPointer[];
}

interface RecordPointer {
  kind: SyncEntityKind;
  id: string;
  parentId: string | null;
  revision: number;
  baseRevision: number | null;
  contentHash: string;
  tombstone: boolean;
}
```

Provider writes use optimistic concurrency: `readManifest` returns the provider revision/ETag and `writeManifest` requires it through `ifMatch`. A rejected precondition triggers pull/reconciliation; it is never retried as an unconditional overwrite. Client timestamps are display evidence only.

Required adapter operations are `authorize`, `disconnect`, `getStatus`, `readManifest`, `writeManifest(ifMatch)`, `getObject(hash)`, `putObjectIfAbsent(hash, bytes)`, and `listRecoveryVersions`. Provider-specific identifiers remain inside the adapter.

## Local journal and commit protocol

1. Commit and verify the canonical local write first.
2. Append a versioned journal entry containing stable entity ID, kind, base revision, content hash, and action. Desktop journal updates use the existing atomic write queue; browser support, when separately approved, uses one IndexedDB transaction.
3. Upload immutable payloads and binary objects before publishing references to them.
4. Fetch the current remote manifest and ETag, reconcile, then publish with `ifMatch`.
5. Mark journal entries acknowledged only after the manifest read-back contains the expected hashes.

Retries are idempotent and use bounded exponential backoff with jitter. Repeated failures pause sync and remain visible; no failed network/auth/RLS operation may delete or reassign local content. Account switching leaves every local workspace intact and clears only in-memory provider capability state.

## Deterministic conflict policy

Sync v1 treats canvas scenes, rich text payloads, and drawing payloads as opaque records. It does not silently combine document JSON or advertise CRDT behavior.

- Identical hashes coalesce.
- A non-concurrent update replaces its base revision.
- Concurrent edit/edit creates a durable conflict sidecar containing both hashes and device/revision provenance. The remote version remains the shared head; the local edit stays intact and locally visible with `syncStatus: conflict` until the user selects one or explicitly keeps both.
- Concurrent delete/edit is always a visible conflict. Neither side is discarded.
- A tombstone wins only when the deleted record is based on the current head and no concurrent edit exists.
- Conflict resolution is a new optimistic manifest revision and is itself retryable/auditable.

Automatic hard deletion is out of scope for v1. Tombstones and referenced objects are retained indefinitely. A later, separately confirmed compaction protocol may purge only after all registered devices acknowledge a checkpoint and a recoverable backup exists.

## Privacy, recovery, and diagnostics

- Transport uses provider HTTPS and provider-at-rest protection. End-to-end encryption is not claimed in v1; adding it requires a key-recovery/product decision.
- Sync logs contain operation IDs, entity kinds, hashes, redacted provider error classes, attempts, and timingsâ€”never note text, binary contents, tokens, email addresses, or absolute local paths.
- Telemetry remains off unless independently opted in; sync correctness never depends on telemetry.
- Initial restore downloads to a staging area, validates schema/IDs/parents/hashes and size limits, writes a local backup, then imports atomically. An existing local workspace with the same ID becomes a visible reconciliation case, never an overwrite.
- Disconnecting or losing authorization stops network work only. Local data remains usable and exportable.
