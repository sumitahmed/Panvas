# Contributing to Panvas

Panvas is a local-first visual workspace. Contributions are welcome from people working on code, tests, accessibility, documentation, design, and platform support.

## Before you start

- Node.js 20 or 22 LTS and npm.
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
npm run dev

# Electron desktop shell (prestart runs the build first)
npm start

npm run typecheck
npm test
npm run build
npm run check:release
```

`npm run dev:landing` starts the marketing surface. There is no `electron:dev` script in v0.1.0; use `npm start` when you need Electron.

## Working agreements

1. Check existing issues and the [roadmap](docs/ROADMAP.md) before starting substantial work.
2. Keep changes focused. Avoid drive-by rewrites of the notebook engine, storage/migrations, sync, OAuth, or Electron security boundary.
3. Preserve the local-first invariant: ordinary editing must remain usable without a network connection, and local data remains authoritative.
4. Update or add tests for behavior changes. Document user-visible changes and limitations.
5. Do not commit build output, `dist/`, `dist-electron/`, `release/`, `.env` files, recordings, private notes, or credentials.

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

## Reporting problems

Use the [bug report template](https://github.com/sumitahmed/Panvas/issues/new?template=bug_report.md) for reproducible bugs and the [feature request template](https://github.com/sumitahmed/Panvas/issues/new?template=feature_request.md) for proposals. Do not include secrets, OAuth tokens, private notes, personal files, or credentials. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Thank you for helping make Panvas more useful and more dependable.
