# Release readiness

Build Windows releases from a reviewed, clean source commit. Browser data lives in origin-scoped IndexedDB and desktop data lives in the configured filesystem root.

## Verification

Run `npm run build` before this gate so Electron runtime tests have fresh renderer, main and preload output.

```bash
npm run typecheck
npm test
npm run test:cloud-reliability
npm run test:notebook-navigation
npm run test:notebook-responsive
npm run test:notebook-performance
npm run test:document-input
npm run test:interaction-ux
npm run test:mobile-overlays
npm run test:pdf-mobile
npm run test:panvas-performance
npm run build:web
npm run build
npm run check:release
git diff --check
```

Stop on a failed gate. Review explicitly staged paths and their diff before each commit. Exclude private configuration, credentials, personal workspace data, local notes, generated QA output and build output.

## Source and artifact

1. Confirm the target version and tag do not already exist. Update the package, lockfile and canonical marketing metadata using `npm version <version> --no-git-tag-version`.
2. Before packaging, leave the artifact hash empty and size as `See GitHub release`. Run the release gates, commit the release source and push `main` without force.
3. From that clean commit, remove old build/release output safely and run `npm run package:win`.
4. Inspect package exclusions and launch the packaged app with a disposable profile. Confirm the x64 NSIS installer is non-empty and has the intended version.
5. Run `npm run checksum` and independently verify the installer with `Get-FileHash -Algorithm SHA256`. Record exact bytes and hash. Do not rebuild after calculating the final checksum.
6. Create an annotated version tag at the exact source commit used for packaging and push it without force.
7. Publish a stable GitHub Release with only `Panvas-<version>-Setup.exe` and `SHA256SUMS.txt`. State signing status accurately; current Windows releases are unsigned.
8. Download both published assets and verify installer bytes and hash against the local final binary.
9. Only then publish the actual hash and size in `src/components/marketing/releaseMetadata.ts` and current README download references. Run `npm test`, `npm run build:web` and `git diff --check`, commit and push.

The tag identifies the installer source; final web download metadata may be a later commit. Never commit installers or unpacked applications.

See [DEPLOYMENT_CHECKLIST.md](../DEPLOYMENT_CHECKLIST.md) for production route checks and [TESTING.md](TESTING.md) for focused tests.
