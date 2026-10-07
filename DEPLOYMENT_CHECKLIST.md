# Deployment and release checklist

Follow [release readiness](docs/RELEASE_READINESS.md) for source review, test gates, Windows packaging, checksums and GitHub publication.

- Verify the repository is `https://github.com/sumitahmed/Panvas.git` and the branch is `main`.
- Review each staged file explicitly. Keep credentials, private notes, personal paths, workspace data and generated output out of Git and packages.
- Build the installer from a clean release-source commit. The annotated tag must identify that exact commit.
- Publish only the final installer and its checksum manifest. Download the published assets and verify their size and hash before updating website metadata.
- Confirm GitHub marks the release stable and Latest, with the correct signing status.
- Confirm the Vercel production deployment corresponds to final `main`.

## Production web checks

At [panvas.vercel.app](https://panvas.vercel.app/), verify `/`, `/app`, `/app/library`, `/download`, `/privacy`, `/terms`, `/security` and `/roadmap`.

Confirm the browser app loads, the download page shows the current version and every Windows installer button uses the canonical release URL. Check installer, release notes and checksum links independently.

Configure optional integrations through the hosting provider or local environment. The example environment leaves Google Drive sync disabled; enabling it requires both feature flags and Google OAuth configuration. Never commit secrets.
