# Panvas technology stack

This table is a concise map of the current `package.json`. The lockfile and installed package metadata remain authoritative for exact resolved versions and licenses.

## Runtime and build

| Technology | Declared version | Role |
| --- | --- | --- |
| Node.js | 24 LTS; CI/container 24.21.0 | Build, scripts, and Electron tooling |
| Electron | `43.5.0` | Windows desktop host and privileged main process |
| React / React DOM | `^18.3.1` | Renderer UI |
| TypeScript | `^5.7.3` | Static checking for renderer and Electron code |
| Vite | `^6.4.3` | Development server and renderer bundler |
| `vite-plugin-electron` | `^1.1.1` | Electron main/preload build integration |

## State and storage

| Technology | Declared version | Role |
| --- | --- | --- |
| Zustand | `^5.0.0` | Workspace, notebook, canvas, UI, and sync state |
| Dexie / `dexie-react-hooks` | `^4.0.11` / `^1.1.7` | Browser IndexedDB adapter and reactive queries |
| Node `fs/promises` | built in | Electron filesystem persistence |
| Panvas write queue | internal | Serialized, temporary-file-backed desktop writes |

## Editors and rendering

| Technology | Declared version | Role |
| --- | --- | --- |
| TipTap extensions | `3.30.5` | Structured rich text and editor features |
| `@excalidraw/excalidraw` | `^0.17.6` | Infinite canvas scene and drawing surface |
| PDF.js (`pdfjs-dist`) | `^4.10.38` | PDF rendering and text extraction |
| `pdf-lib` | `^1.17.1` | Annotated-PDF export |
| KaTeX / `rehype-katex` | `0.18.2` / `^7.0.1` | Formula rendering |
| `lowlight` / `highlight.js` | `^3.3.0` / `11.11.2` | Code-block highlighting |
| `polygon-clipping` | `^0.15.7` | Geometry operations used by ink tools |

## UI and platform integrations

Tailwind CSS, Base UI, Lucide React, Framer Motion, Wouter, and the Fontsource packages provide styling, accessible primitives, icons, animation, routing, and bundled fonts. `@huggingface/transformers` remains in the dependency graph for the disabled local-recognition experiment. Google Drive OAuth/sync and the Electron preload bridge are Panvas-owned integrations. Supabase and PostHog are optional/configuration-gated code paths; ordinary local editing does not require them.

## Quality and packaging

The project uses Node's built-in `node:test` runner, Playwright for selected browser/Electron checks, Vite for production builds, and `electron-builder` for Windows packaging. Run the documented gates in [TESTING.md](TESTING.md) before a release.

For license identifiers and upstream links, see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
