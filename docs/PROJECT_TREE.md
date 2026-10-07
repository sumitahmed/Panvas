# Project tree

The repository-level [CODEBASE_MAP.md](CODEBASE_MAP.md) is the contributor-oriented guide. This compact tree shows the public top-level layout.

```text
Panvas/
├── electron/        Electron main process, preload, IPC, and filesystem services
├── src/              React renderer, engines, repositories, stores, and services
├── tests/            Node, browser, and Electron verification suites
├── public/           Static web assets and marketing media
├── scripts/          Build, release, checksum, and audit helpers
├── docs/             User and contributor documentation
├── .github/          Issue and pull-request templates
├── package.json      Scripts and dependency declarations
├── vite.config.ts    Renderer/Electron build configuration
└── tsconfig*.json    TypeScript projects
```

Generated directories (`dist/`, `dist-electron/`, `release/`, and `node_modules/`) are build or release outputs and are not source documentation.
