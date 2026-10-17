# Panvas third-party notices

Panvas is an independent MIT-licensed application. This file identifies the major direct runtime dependencies declared in `package.json`. The lockfile and each installed package's `LICENSE`/`NOTICE` file are authoritative for exact text and resolved versions; this document does not replace those files.

## Dependencies and attribution

| Dependency | Declared version | License in installed package | Upstream |
| --- | --- | --- | --- |
| React, React DOM | `^18.3.1` | MIT | [facebook/react](https://github.com/facebook/react) |
| Electron | `43.5.0` (development dependency) | MIT | [electron/electron](https://github.com/electron/electron) |
| Excalidraw | `^0.17.6` | MIT | [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) |
| TipTap and extensions | `3.30.5` | MIT | [ueberdosis/tiptap](https://github.com/ueberdosis/tiptap) |
| Dexie, dexie-react-hooks | `^4.0.11`, `^1.1.7` | Apache-2.0 | [dexie/Dexie.js](https://github.com/dexie/Dexie.js) |
| PDF.js (`pdfjs-dist`) | `^4.10.38` | Apache-2.0 | [mozilla/pdf.js](https://github.com/mozilla/pdf.js) |
| `pdf-lib` | `^1.17.1` | MIT | [Hopding/pdf-lib](https://github.com/Hopding/pdf-lib) |
| KaTeX (`katex`) | `0.18.2` | MIT | [KaTeX/KaTeX](https://github.com/KaTeX/KaTeX) |
| Lucide React | `^0.469.0` | ISC | [lucide-icons/lucide](https://github.com/lucide-icons/lucide) |
| Fontsource families | `5.3.0` | OFL-1.1 or Apache-2.0, per family | [fontsource/fontsource](https://github.com/fontsource/fontsource) |
| Zustand | `^5.0.0` | MIT | [pmndrs/zustand](https://github.com/pmndrs/zustand) |
| `@huggingface/transformers` | `^4.2.0` | Apache-2.0 | [huggingface/transformers.js](https://github.com/huggingface/transformers.js) |
| PostHog JS | `^1.380.0` | Apache-2.0 AND MIT | [PostHog/posthog-js](https://github.com/PostHog/posthog-js) |
| Supabase JS | `^2.49.0` | MIT | [supabase/supabase-js](https://github.com/supabase/supabase-js) |

Other direct runtime packages (including `@base-ui/react`, `react-hook-form`, `react-markdown`, `react-syntax-highlighter`, `remark-*`, `lowlight`, `highlight.js`, `framer-motion`, `nanoid`, `polygon-clipping`, `three`, `tippy.js`, `vanta`, `wouter`, `zod`, and their transitive dependencies) retain the license metadata shipped in `node_modules` and the lockfile. Review the package's own license before redistributing a modified copy.

## Fonts and bundled assets

Fontsource packages bundle the upstream font files and their license metadata. Excalidraw assets copied into the web build retain the upstream attribution files supplied by the package. Do not remove those files from a redistributed build.

## Product inspiration

Panvas may be informed by established note-taking, handwriting, PDF, and whiteboard applications. Product inspiration is not bundled software, copied source, or an affiliation. No third-party application's branding or proprietary assets are included as Panvas code.

## License review

For a release or binary redistribution, inspect the installed dependency licenses after `npm ci`, preserve required notices, and rerun the review when dependencies change. Panvas source code remains available under the [MIT License](LICENSE).
