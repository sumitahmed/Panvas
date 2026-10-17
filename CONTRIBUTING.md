# Contributing to Panvas

Panvas is a local-first visual workspace. Contributions are welcome from people working on code, tests, accessibility, documentation, design, and platform support.

## Before you start

- Node.js 24 LTS and npm; CI and Docker pin 24.21.0. The declared alternative is Node 22.18+. Node 20 is not supported by the TypeScript test workflow.
- Git.
- Windows 10/11 for Electron-specific work. The browser build and most tests can run on other platforms.
- Familiarity with TypeScript, React, and the Node test runner is useful but not required for documentation or small UI changes.

## Set up a checkout

```bash
git clone https://github.com/sumitahmed/Panvas.git
cd Panvas
npm ci
```

Copy `.env.example` to a local `.env` only when a feature explicitly needs configuration. Keep credentials, OAuth secrets, tokens, and private workspace data out of commits and issue reports.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/` | React renderer, repositories, stores, engines, and shared services |
| `electron/` | Electron main process, preload bridge, IPC handlers, and filesystem persistence |
| `tests/` | Node test-runner suites and selected browser/Electron harnesses |
| `public/` | Static site and application assets |
| `scripts/` | Release and audit helpers |
| `docs/` | Canonical contributor and system documentation |


## Development commands

```bash
# Browser/Vite development server; open http://localhost:3000/app
npm run dev:web

# Electron desktop shell (prestart runs the build first)
npm start

npm run typecheck
npm test
npm run build
npm run check:release
npm run test:release-units
npm run build:web
```

`npm run dev:landing` also serves the public routes; open `/landing` explicitly. `npm start` builds and launches Electron. `npm run dev` starts Vite with Electron integration. Use `dev:web` for a browser-only server. There is no separate Panvas backend service. Local editing works without Supabase, Google or PostHog credentials.

## Docker contribution workflow

Docker Desktop must use Linux containers. See [DOCKER.md](docs/DOCKER.md) for production operation. Use the standalone development Compose file:

```bash
docker compose --env-file .env.example -f compose.dev.yaml up --build -d --wait
docker compose --env-file .env.example -f compose.dev.yaml logs -f web-dev
docker compose --env-file .env.example -f compose.dev.yaml exec web-dev npm run typecheck
docker compose --env-file .env.example -f compose.dev.yaml exec web-dev node --test tests/documentation-flow.test.ts tests/notebook-code-highlight.test.ts
docker compose --env-file .env.example -f compose.dev.yaml restart web-dev
docker compose --env-file .env.example -f compose.dev.yaml up --build -d
docker compose --env-file .env.example -f compose.dev.yaml down
```

Source files are mounted read-only and Vite watches them; edit on the host. Rebuild after dependency/configuration changes. Linux dependencies belong to the image, not your Windows `node_modules`. No application data volume exists: web workspaces stay in browser IndexedDB. For a disposable test, use a fresh browser profile. Never clear a contributor's normal site data or run `docker system prune` as a project reset.

Use native Windows development for Electron IPC, Windows Ink, native dialogs/clipboard, installer work and real filesystem behavior. The container does not supply a GUI or a substitute for native acceptance testing.

## Working agreements

1. Check existing issues and the [roadmap](docs/ROADMAP.md) before starting substantial work.
2. Keep changes focused. Avoid drive-by rewrites of the notebook engine, storage/migrations, sync, OAuth, or Electron security boundary.
3. Preserve the local-first invariant: ordinary editing must remain usable without a network connection, and local data remains authoritative.
4. Update or add tests for behavior changes. Document user-visible changes and limitations.
5. Do not commit build output, `dist/`, `dist-electron/`, `release/`, `.env` files, recordings, private notes, or credentials.

Discuss scope on an existing issue before a large change; avoid posting private workspace content. Use small changes and the existing two-space TypeScript/React style. Tests must preserve exact document JSON and unrelated marks where formatting or persistence changes. Code-block changes must pass `node tests/code-block-release-browser.mjs` and its `--electron` variant after a native build.

## Branches and commits

Create a branch from `main` with a short descriptive name, for example:

```text
fix/pdf-annotation-offset
docs/storage-guide
test/notebook-recovery
```

Use a clear imperative commit subject. Conventional Commits are welcome (`fix:`, `docs:`, `test:`, `chore:`), but clarity matters more than a rigid format.

## Pull requests

The expected flow is:

```text
fork -> branch -> focused change -> tests -> typecheck -> build -> pull request
```

In the pull request, explain what changed, why it changed, and how it was tested. Call out any effect on persistence, migrations, cloud sync, OAuth, or the Electron security boundary. Include screenshots or a short recording for UI changes and update documentation when behavior or setup changes.

Maintainers review correctness, data safety, accessibility, security boundaries, test coverage, and scope. A passing local check is useful evidence, not a substitute for review.

CI checks formatting whitespace (`git diff --check`), both TypeScript projects, unit/fault tests, browser/Electron code controls, web packaging, Docker health and Windows packaging. There is no ESLint configuration; do not report an ESLint pass. Documentation-only pull requests should verify local links and commands; screenshots should show actual behavior.

Release workflows are manual. Their default is build-only; publication additionally requires the explicit `publish` input and the `public-release` environment. Maintainers must configure required environment reviewers before using that path. Do not create a release tag or run publication for a candidate awaiting owner review.

## Reporting problems

Use the [bug report template](https://github.com/sumitahmed/Panvas/issues/new?template=bug_report.md) for reproducible bugs and the [feature request template](https://github.com/sumitahmed/Panvas/issues/new?template=feature_request.md) for proposals. Do not include secrets, OAuth tokens, private notes, personal files, or credentials. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Thank you for helping make Panvas more useful and more dependable.
