# Production candidate security review — 2026-10-17

This is a scoped source/runtime/package review, not an external penetration test or a guarantee of security. The candidate defaults to local-only operation. The QA report records which runtime checks actually completed.

## Boundaries reviewed

| Area | Controls and evidence | Practical limit |
| --- | --- | --- |
| Renderer / native boundary | Sandboxed, isolated Electron renderer; Node integration and webviews disabled; trusted top-frame IPC sender and payload validation; HTTPS-only external links; audio-only permission policy. Regression suites cover IPC, navigation, payloads and file IDs. | Native OS dialog behavior and OS security remain platform responsibilities. |
| Files and saves | Validated IDs, queued atomic writes, bounded retries, recovery snapshots, portable backup validation. Storage-root reads retain native-owned paths and never relocate files. | Unavailable drives, OS permissions, exhausted storage and damaged files need explicit recovery; retained roots are not backups. |
| Browser content | DOMPurify/import normalization, supported mark/schema validation, restrictive script/object/worker policies. Actual code controls preserve source JSON instead of injecting rendered syntax markup into saved code. | A local source audit cannot prove absence of every XSS vector. |
| Accounts / providers | Google Drive V2 hashes/baselines, ETag guards, exact object verification and explicit conflict recovery; browser GIS tokens are memory-only, native OAuth storage uses Electron security facilities. Legacy Supabase replication is quarantined. Optional Supabase has checked-in RLS policies. | Live provider tenant/RLS deployment, authentication, token renewal and two-device acceptance were not established without an approved disposable account. No hosted migration was run. |
| Hosting | Stateless static web server; no Panvas API endpoints or database to expose/rate-limit. Loopback Compose binding; non-root/read-only runtime, dropped capabilities, health, bounded logs and graceful stop. Security/cache headers and missing-asset handling are exercised locally. | TLS termination, domain/OAuth configuration and provider policies must be reviewed on the eventual host. Local HTTP is not an HTTPS deployment test. |
| Secrets | `.env` excluded from Git/Docker/package inputs; only listed public Vite arguments reach web builds. Candidate helper explicitly uses local-only template values. Package audit compares confidential local values without printing them. | Any `VITE_` configuration is public. Never place service-role credentials or user tokens there. |
| CI / publication | Pinned action revisions, read-only default token, separate publication job with write scope, manual dispatch and `public-release` environment. | Required environment reviewers must be configured by the owner. Hosted workflows were prepared locally, not triggered. |

## Dependency findings

Fresh `npm audit --omit=dev` reports **0 production dependency vulnerabilities**. The full audit reports **16 development-tooling findings: 5 high, 11 moderate**. This is not a clean full-dependency security gate.

The three root advisory families are:

- Deep brace patterns can exhaust the build tool's stack; the advisory has no patched release for the installed family. It propagates through glob/watch/Tailwind tooling. [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
- Selector parsing has a CPU exhaustion advisory, fixed in selector-parser 7.1.6. Older parser majors are used by Tailwind 3 and typography/build plugins; overriding them across major versions or migrating Tailwind is a separate compatibility change. [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).
- `sprintf-js` precision handling can exhaust resources; no patched version is listed for the installed family. It is reached through desktop packaging/proxy logging tooling. [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

No force audit fix, UI-stack migration or dependency downgrade was applied. These findings concern the trusted build/development inputs and remain a release review item. Keep development servers on loopback, do not build untrusted source/configuration with privileged credentials and revisit upstream patches. `npm audit` does not audit the operating-system packages in Docker base images or establish Electron/Chromium vulnerability freedom. Container image scanning status is recorded separately in QA.

Docker Scout required an authenticated Docker account. A separately downloaded, checksum-verified Grype 0.120.1 scan of the actual saved image exceeded its 300-second limit without producing a vulnerability report. **No container OS-CVE verdict is claimed.** Complete image scanning in an available scanning environment before approving a public release.

## Release limits

The candidate executables are unsigned unless an actual Authenticode result says otherwise. The build log's “signing” step is not proof of a trusted certificate. Package execution in a disposable profile is separate from a clean installer upgrade/uninstall. No production account, actual notebook root, release tag, remote deployment or published asset was changed during this preparation.
