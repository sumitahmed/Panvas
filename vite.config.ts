import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import path from 'path';
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import dotenv from 'dotenv';
import { applyDevelopmentBrowserCsp } from './src/config/browserCsp';

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '.env.local') });

const googleClientId = process.env.PANVAS_GOOGLE_CLIENT_ID || '';
const googleClientSecret = process.env.PANVAS_GOOGLE_CLIENT_SECRET || process.env.PANVAS_GOOGLE_SECRET || '';

const excalidrawAssetsDir = path.resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/excalidraw-assets');

function localExcalidrawAssets() {
  return {
    name: 'panvas-local-excalidraw-assets',
    configureServer(server: { middlewares: { use: (route: string, handler: (request: any, response: any, next: () => void) => void) => void } }) {
      // Development Excalidraw requests a separate vendor directory. Serve it
      // with the same bounded local-asset path checks as production assets.
      for (const directory of ['excalidraw-assets', 'excalidraw-assets-dev']) {
      const servedAssetsDir = path.resolve(excalidrawAssetsDir, '..', directory);
      server.middlewares.use(`/${directory}`, (request, response, next) => {
        try {
          const relativePath = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^[/\\]+/, '');
          const assetPath = path.resolve(servedAssetsDir, relativePath);
          if (!assetPath.startsWith(`${servedAssetsDir}${path.sep}`) || !existsSync(assetPath) || !statSync(assetPath).isFile()) {
            next();
            return;
          }
          const extension = path.extname(assetPath);
          response.setHeader('Content-Type', extension === '.js' ? 'text/javascript'
            : extension === '.woff2' ? 'font/woff2'
              : extension === '.json' ? 'application/json' : 'application/octet-stream');
          createReadStream(assetPath).pipe(response);
        } catch {
          next();
        }
      });
      }
    },
    writeBundle(outputOptions: { dir?: string }) {
      const outputDir = path.resolve(__dirname, outputOptions.dir ?? 'dist');
      cpSync(excalidrawAssetsDir, path.join(outputDir, 'excalidraw-assets'), { recursive: true });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const isWebOnly = mode === 'web' || mode === 'landing' || process.env.PANVAS_DEV_WEB === 'true' || Boolean(process.env.VERCEL);

  return {
    base: './',
    plugins: [
      react(),
      {
        name: 'panvas-browser-development-csp',
        transformIndexHtml: html => applyDevelopmentBrowserCsp(html, command === 'serve'),
      },
      localExcalidrawAssets(),
      ...(!isWebOnly
        ? [
            electron({
              main: {
                entry: 'electron/main.ts',
                vite: {
                  define: {
                    'process.env.PANVAS_GOOGLE_CLIENT_ID': JSON.stringify(googleClientId),
                    'process.env.PANVAS_GOOGLE_CLIENT_SECRET': JSON.stringify(googleClientSecret),
                  },
                },
              },
              preload: {
                input: 'electron/preload.ts',
              },
              renderer: {},
            }),
          ]
        : []),
    ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  worker: {
    // The neural recognition worker uses dynamic imports (transformers.js is
    // only fetched when local recognition is first used), which requires ES
    // module worker output instead of the default IIFE bundle.
    format: 'es',
  },
  define: {
    'process.env': {
      IS_PREACT: 'false',
      NODE_ENV: JSON.stringify(process.env.NODE_ENV || 'development')
    }
  },
  server: {
    port: 3000,
    open: true,
    watch: {
      ignored: ['**/src/Background Images/**'],
    },
  },
  build: {
    target: 'esnext',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Keep the shared runtime explicit; let dynamic route imports determine
        // editor ownership instead of hoisting shared utilities into editor chunks.
        manualChunks(id) {
          if (/node_modules[/\\](react|react-dom|scheduler)[/\\]/.test(id)) return 'vendor-react';
        },
      },
    },
  },
};
});
