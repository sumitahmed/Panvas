# Local development

The repository-level [CONTRIBUTING.md](../CONTRIBUTING.md) is the canonical setup and review guide. This page is a quick reference for running the current tree.

## Prerequisites

- Node.js 20 or 22 LTS
- npm and Git
- Windows 10/11 for Electron-specific work

## Setup and run

```bash
git clone https://github.com/sumitahmed/Panvas.git
cd Panvas
npm ci

# Browser workspace: http://localhost:3000/app
npm run dev

# Electron desktop shell (builds before launch)
npm start

# Marketing surface
npm run dev:landing
```

The browser profile stores data in origin-scoped IndexedDB. The Electron profile stores workspaces under `Documents/Panvas/` by default. Use a local `.env` only for explicitly configured integrations; never commit it.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run check:release
```

Focused suites and browser/Electron harnesses are documented in [TESTING.md](TESTING.md). There is no `electron:dev` script in the package manifest; use `npm start` for Electron.
