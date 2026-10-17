# Troubleshooting

## Development or build

Use Node 24 LTS and `npm ci` with the checked-in lockfile. Check `node --version` if Node reports unknown `.ts` files: Node 20 cannot run the current tests. `npm start` builds and starts Electron; `npm run dev:web` starts only the browser server. Open `/app` for editing or `/` for the public site. A cloud account is optional.

If Electron behaves like Node or cannot import `ipcMain`, remove the inherited `ELECTRON_RUN_AS_NODE` variable for that launch only. In PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`, then `npm start`. Do not kill every Node/Electron process; other projects or the normal Panvas window may be using them.

The build's Virgil font warning refers to a vendor asset copied after bundling; verify `/excalidraw-assets/Virgil.woff2` returns a font before treating it as missing. Large chunk warnings are tracked by `npm run check:release` budgets; do not raise a budget simply to pass a failing check.

## Local data

Desktop files are under the configured root (default Documents/Panvas). Settings and registered workspace locations live in the Electron profile. Do not reset either to fix a rendering problem. Back up important workspaces first. A missing/unwritable custom folder is reported; restore access or choose an accessible folder. Changing the root does not move existing workspaces/media. Previous media roots remain readable when available; do not delete the original folders.

Browser data belongs to its origin and profile. A new port, different hostname, private window, or native app will not automatically show the same data. Export/import a portable backup or configure supported sync. Quota/eviction, site-data clearing and private browsing are limitations; the server/container has no copy of your browser workspace.

## Cloud and recovery

Cloud Sync must be enabled at build time and configured with the correct provider client/origin. `Reconnect Google Drive` means the provider needs a fresh token; it does not mean local data is corrupt. Preserve recovery copies before choosing cloud/device/keep-both during a conflict. Auth expiry, offline editing, retries and conflict simulations are tested locally; a live provider test still needs an authorized disposable account.

Do not clear baselines, delete remote objects or repeatedly reset a device to suppress a conflict. Report the sanitized error/status with version and reproduction steps. Never attach tokens, secrets or private notebook contents.

## Distribution

The candidate Windows binaries are unsigned. Use the SHA-256 manifest from the same artifact set and an isolated test profile. Full installer upgrade/uninstall testing belongs in Windows Sandbox/a disposable VM; installing the candidate over an existing installation can change the installed application. Browser builds require SPA routing, static MIME types and appropriate security/cache headers; see [DOCKER.md](DOCKER.md).
