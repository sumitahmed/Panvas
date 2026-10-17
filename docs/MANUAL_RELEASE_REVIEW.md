# Manual review before publication

The local candidate is **0.1.8-rc.1**, not an approved stable release. No commit, push, tag, public artifact upload or deployment is authorized by automated test results.

## Windows

1. Verify `desktop/Panvas-0.1.8-rc.1-Setup.exe` and `desktop/Panvas-0.1.8-rc.1-Portable.exe` against the candidate's `checksums/SHA256SUMS.txt` with `Get-FileHash -Algorithm SHA256`.
2. Open a new PowerShell terminal in the candidate directory and use the commands below to open a separate review profile/workspace. Use synthetic review data there, then close that terminal so its test environment does not affect later launches.
3. Create/rename/switch workspaces, folders and notebooks. Create, edit, rename, reorder, delete and restore a page. Test search, keyboard navigation and error/empty states.
4. Type rich text, math, tables and long code. Select a language, copy code, toggle Wrap On/Off and scroll long unwrapped lines. Check that bold/italic/links and code source remain intact. Test undo/redo, resize, close and reopen.
5. Arm the text highlighter, choose Yellow, select repeated ranges, change color, erase with None and exit with Esc. Test the native Custom picker and two custom colors entering the six-slot rolling palette. The final OS-picker completion is a manual acceptance item.
6. Check the separate pen/ink highlighter, page templates, images, audio and a real PDF. Export a portable backup; import it into another disposable workspace/profile and inspect media. Confirm PDF export visually.
7. Test a storage-folder change only with disposable roots. Existing notebooks and shared media should remain readable from their original accessible folders. A folder change does not migrate or back up files.
8. Test the NSIS installer, upgrade and uninstall in Windows Sandbox/a disposable VM. Do not silently install over your normal Panvas installation for this check. Both binaries are unsigned; the installer preserves application data by configuration, but that does not replace an actual isolated uninstall test.

## Web / Docker

1. In the candidate `docker/` directory, load `Panvas-0.1.8-rc.1-Web-Image.tar` with `docker load --input ...` and run `docker compose up -d --wait`. The image is local-only; it is not pulled from a registry. Open `http://localhost:8080/app`. `/` shows the landing page.
2. Create a note, format it and save. Run `docker compose restart web`, refresh, then close/reopen the same browser profile at the same origin. Check exact saved content. Type while offline and verify local persistence after reconnecting.
3. Test both a wide window and a phone-sized viewport. Check `/download`, `/privacy`, `/terms`, `/security`, `/roadmap` and direct `/app/library` navigation/refresh. Library remembers its selected Recent/Library/etc. view.
4. HTTP localhost intentionally does not register the offline shell. Test full offline reload through an HTTPS host; automated QA used a disposable self-signed HTTPS test proxy, not a public deployment. Real host TLS, cache policy and OAuth origins need hosting review.
5. Stop only the review containers with `docker compose down`. Do not remove volumes, clear normal browser site data or delete desktop workspace roots as a reset procedure.

The `web/Panvas-0.1.8-rc.1-Web.zip` archive contains the actual compiled web files. Serve them with SPA fallback, correct MIME types and the documented security/cache headers. `file://` is not an appropriate browser deployment. Docker development recipes in `docker/source/` need the full checkout; see [DOCKER.md](DOCKER.md).

## Isolated Windows launch

Run these manually from the candidate directory in a fresh PowerShell terminal:

```powershell
$review = Join-Path $env:LOCALAPPDATA 'PanvasCandidateReview/0.1.8-rc.1'
$profile = Join-Path $review 'profile'
$env:PANVAS_GATE0_PROFILE = '1'
$env:PANVAS_GATE0_WORKSPACE_ROOT = Join-Path $review 'workspaces'
$env:ELECTRON_RUN_AS_NODE = $null
New-Item -ItemType Directory -Path $profile,$env:PANVAS_GATE0_WORKSPACE_ROOT -Force
& './desktop/Panvas-0.1.8-rc.1-Portable.exe' "--user-data-dir=$profile"
```

These are the same isolation mechanisms used in the actual portable-executable test. Keep review data separate from important work. The packaged application ignores inherited `VITE_DEV_SERVER_URL` automatically.

## Cloud and release decision

This candidate uses local-only defaults. Live Google Drive/Supabase acceptance requires a separate approved build/configuration with authorized disposable accounts and OAuth origins. Test initial sync, local/remote/offline edits, reauthentication, two sessions, concurrent edits, each conflict choice, failed requests, retry and restart. Compare exact data and independent backups on both replicas. Do not test destructive reset/conflict choices on important notebooks.

Review the QA report's Failed, Blocked, Not tested and Known limitation entries, including development dependency advisories and image-scanning results. Choose the final release version and signing plan. Only explicit owner approval after manual testing permits the publication phase. Public download metadata must remain on the last uploaded/verified release until the new upload exists and is independently checked.
