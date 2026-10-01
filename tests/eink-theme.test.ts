import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  applyThemeClasses,
  isPanvasTheme,
  resolveTheme,
  THEME_CLASSES,
  themeClassesFor,
  readAndMigrateTheme,
  PANVAS_THEMES,
} from '../src/lib/theme.ts';

function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

test('public theme choices are exactly light, ink and dark', () => {
  assert.deepEqual(PANVAS_THEMES, ['light', 'ink', 'dark']);
  for (const value of ['light', 'dark', 'ink']) assert.equal(isPanvasTheme(value), true);
  assert.equal(isPanvasTheme('system'), false);
  assert.equal(isPanvasTheme('eink'), false);
});

test('legacy E-Ink storage resolves to the original Ink choice', () => {
  assert.equal(resolveTheme('dark'), 'dark');
  assert.equal(resolveTheme('light'), 'light');
  assert.equal(resolveTheme('ink'), 'ink');
  assert.equal(resolveTheme('eink'), 'ink');
  assert.equal(resolveTheme('system'), 'dark');
  assert.equal(resolveTheme('unknown'), 'dark');
});

test('theme classes use the original dark and Ink markers only', () => {
  assert.deepEqual(themeClassesFor('dark'), ['dark']);
  assert.deepEqual(themeClassesFor('ink'), ['theme-ink']);
  assert.deepEqual(themeClassesFor('light'), []);
  assert.deepEqual(THEME_CLASSES, ['dark', 'theme-ink']);

  const classList = new Set<string>(['dark', 'theme-eink']);
  const documentStub = {
    documentElement: {
      classList: {
        remove: (...names: string[]) => names.forEach(name => classList.delete(name)),
        add: (...names: string[]) => names.forEach(name => classList.add(name)),
      },
    },
  };
  const previousDocument = globalThis.document;
  // @ts-expect-error minimal DOM stub for the helper contract
  globalThis.document = documentStub;
  try {
    applyThemeClasses('ink');
    assert.deepEqual([...classList].sort(), ['theme-ink']);
    applyThemeClasses('light');
    assert.deepEqual([...classList], []);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('legacy theme migration persists canonical Ink without OS-dependent modes', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored: string | null = 'eink';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
  } });
  try {
    assert.equal(readAndMigrateTheme(), 'ink');
    assert.equal(stored, 'ink');
    stored = 'system';
    assert.equal(readAndMigrateTheme(), 'dark');
    assert.equal(stored, 'dark');
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('bootstrap and UI store apply the canonical theme before the app renders', async () => {
  const store = await read('../src/stores/uiStore.ts');
  assert.match(store, /readAndMigrateTheme/);
  assert.match(store, /applyThemeClasses\(resolvedTheme\)/);
  assert.doesNotMatch(store, /theme-eink/);
  const bootstrap = await read('../src/bootstrap.tsx');
  assert.match(bootstrap, /readAndMigrateTheme\(\)/);
  assert.match(bootstrap, /applyThemeClasses\(theme\)/);
  assert.ok(bootstrap.indexOf('applyThemeClasses(theme)') < bootstrap.indexOf('ReactDOM.createRoot'));
});

test('Ink has distinct warm-gray tablet surfaces and a presentation-only content filter', async () => {
  const css = await read('../src/styles/index.css');
  assert.match(css, /^  \.theme-ink \{/m);
  assert.match(css, /--bg-primary: 216 213 200/);
  assert.match(css, /--content-filter: saturate\(0\.5\)/);
  const ink = css.match(/\.theme-ink\s*\{([^}]+)\}/)![1];
  for (const token of ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-elevated', 'bg-hover', 'bg-active', 'border-subtle', 'border-default', 'border-strong', 'text-primary', 'text-secondary', 'text-tertiary']) {
    const channels = ink.match(new RegExp(`--${token}: (\\d+) (\\d+) (\\d+);`))!.slice(1).map(Number);
    assert.ok(channels[0] > channels[1] && channels[1] > channels[2], `${token} has a warm yellow-neutral undertone`);
  }
  assert.doesNotMatch(css, /(?:sepia|hue-rotate)\(/);
  assert.doesNotMatch(css, /theme-eink/);
  const blocks = await read('../src/styles/blocks.css');
  assert.doesNotMatch(blocks, /theme-eink/);
});

test('imported PDF previews retain source colors while authored annotation layers use theme presentation', async () => {
  const preview = await read('../src/components/notebook/NotebookPageView.tsx');
  assert.match(preview, /filter: page\.type === 'pdf' \? 'none' : undefined/);
  const workspace = await read('../src/components/pdf/PdfWorkspace.tsx');
  assert.match(workspace, /className=.*panvas-colored-content panvas-layer-canvas-decoration/);
});

test('electron title-bar overlay accepts only the three public themes', async () => {
  const source = await read('../electron/ipc/domain-handlers.ts');
  assert.match(source, /\['light', 'dark', 'ink'\]\.includes\(String\(args\[0\]\)\)/);
  assert.match(source, /theme: 'light' \| 'dark' \| 'ink'/);
  assert.doesNotMatch(source, /'eink'/);
});

test('appearance settings offer exactly Light, Ink, Dark cards with the original Ink icon', async () => {
  const source = await read('../src/components/settings/sections/AppearanceSection.tsx');
  assert.deepEqual([...source.matchAll(/name="([^"]+)"/g)].map(match => match[1]), ['Light', 'Ink', 'Dark']);
  assert.match(source, /icon=\{<PenTool/);
  assert.doesNotMatch(source, /<Tablet|<Monitor/);
});

test('top bar cycles the same three themes', async () => {
  const source = await read('../src/components/layout/TopBar.tsx');
  assert.match(source, /THEME_CYCLE = \['light', 'ink', 'dark'\]/);
  assert.match(source, /Switch to \$\{nextThemeInCycle\(\)\} theme/);
});

test('notebook ruler and canvas use the original theme state', async () => {
  const drawing = await read('../src/components/notebook/engine/DrawingEngine.ts');
  assert.doesNotMatch(drawing, /theme-eink/);
  const ruler = await read('../src/components/notebook/engine/RulerManager.ts');
  assert.match(ruler, /themeMode: 'light' \| 'dark'/);
  assert.doesNotMatch(ruler, /eink/);
  const canvas = await read('../src/components/canvas/CanvasView.tsx');
  assert.match(canvas, /const panvasTheme = useUIStore\(\(state\) => state\.theme\);/);
});

test('tailwind exposes no E-Ink-only variant', async () => {
  const config = await read('../tailwind.config.ts');
  assert.doesNotMatch(config, /addVariant\('eink'/);
});
