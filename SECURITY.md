# Security policy

## Supported versions

Panvas is below 1.0. Security fixes are applied to the current `0.1.x` release line when practical. Development builds from `main` are not guaranteed to have the same support or update cadence as a tagged release.

| Version | Supported |
| --- | --- |
| Current `0.1.x` release | Yes |
| Older pre-`0.1.0` builds | No; upgrade before reporting a fixed issue |

## Report a vulnerability privately

Please do not open a public issue or discussion for an active vulnerability. Use [GitHub Security Advisories](https://github.com/sumitahmed/Panvas/security/advisories) to send a private report to the maintainers. If the advisory form is unavailable, contact the maintainer at the address listed in the repository's public release metadata and avoid including secrets in email.

Include, when safe to share:

- affected Panvas version and distribution (Windows Electron or web build);
- operating system, browser, and relevant configuration;
- a concise reproduction or proof of concept;
- security impact and realistic attack preconditions; and
- suggested mitigation or a patch, if available.

Never send passwords, OAuth tokens, private keys, API keys, private notes, personal files, or full production data. Redact logs and screenshots before attaching them.

We will acknowledge and triage reports as promptly as practical. Please allow time for validation, a fix, and coordinated disclosure before publishing details.

## Security boundaries

The Windows build separates the Chromium renderer from privileged filesystem and native operations. The current Electron configuration enables `contextIsolation`, disables `nodeIntegration`, enables the renderer sandbox, and exposes a narrow `window.panvas` preload bridge. IPC handlers validate the trusted top-level renderer and validate operation inputs before filesystem work.

The browser build is origin-scoped. Browser storage and any enabled network integrations remain subject to the browser, operating system, and provider security models. Cloud Sync requires explicit build-time configuration and Google OAuth setup; the example environment leaves it disabled.

These controls reduce risk but are not a security guarantee. Keep your operating system updated, download releases only from the project release page, verify release checksums, and maintain independent backups of important work.

For architecture details, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/STORAGE_AND_PERSISTENCE.md](docs/STORAGE_AND_PERSISTENCE.md).
