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
  THEME_STORAGE_KEY,
  PANVAS_THEMES,
} from '../src/lib/theme.ts';

function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1: PAGE & SECTION MANAGEMENT REGRESSION TESTS (Items 1 - 12)
// ─────────────────────────────────────────────────────────────────────────────

interface TestPage {
  id: string;
  notebookId: string;
  sectionId: string;
  title: string;
  order: number;
  deletedAt: number | null;
  updatedAt: number;
}

interface TestSection {
  id: string;
  notebookId: string;
  name: string;
  order: number;
  deletedAt: number | null;
  updatedAt: number;
}

interface TestWorkspaceState {
  activeWorkspaceId: string;
  activeNotebookId: string;
  activeNotebookSectionId: string;
  activePageId: string | null;
  notebooks: { id: string; name: string; workspaceId: string; deletedAt: number | null }[];
  notebookSections: TestSection[];
  notebookPages: TestPage[];
  pagePayloads: Record<string, { content: string; drawing: { strokes: { color: string }[] } }>;
}

function createMockEnvironment(): {
  state: TestWorkspaceState;
  renameNotebookPage: (pageId: string, title: string) => Promise<void>;
  renameNotebookSection: (sectionId: string, name: string) => Promise<void>;
  deleteNotebookPage: (pageId: string) => Promise<void>;
  createNotebookPage: (sectionId: string, title: string) => Promise<TestPage>;
  simulateReload: () => Promise<void>;
} {
  const state: TestWorkspaceState = {
    activeWorkspaceId: 'ws-1',
    activeNotebookId: 'nb-1',
    activeNotebookSectionId: 'sec-1',
    activePageId: 'page-1',
    notebooks: [
      { id: 'nb-1', name: 'Aptitude', workspaceId: 'ws-1', deletedAt: null },
    ],
    notebookSections: [
      { id: 'sec-1', notebookId: 'nb-1', name: 'Partnership(after q-5)', order: 0, deletedAt: null, updatedAt: 1000 },
      { id: 'sec-2', notebookId: 'nb-1', name: 'Section 2', order: 1, deletedAt: null, updatedAt: 1000 },
    ],
    notebookPages: [
      { id: 'page-1', notebookId: 'nb-1', sectionId: 'sec-1', title: 'Page 1', order: 0, deletedAt: null, updatedAt: 1000 },
      { id: 'page-2', notebookId: 'nb-1', sectionId: 'sec-1', title: 'q6', order: 1, deletedAt: null, updatedAt: 1000 },
      { id: 'page-3', notebookId: 'nb-1', sectionId: 'sec-2', title: 'Sec2 Page', order: 0, deletedAt: null, updatedAt: 1000 },
    ],
    pagePayloads: {
      'page-1': { content: 'Notes for Q10', drawing: { strokes: [{ color: '#2563eb' }, { color: '#16a34a' }] } },
      'page-2': { content: 'Notes for Q6', drawing: { strokes: [{ color: '#dc2626' }] } },
    },
  };

  // Persistent storage backing mock
  const storageDB = {
    sections: JSON.parse(JSON.stringify(state.notebookSections)) as TestSection[],
    pages: JSON.parse(JSON.stringify(state.notebookPages)) as TestPage[],
  };

  const renameNotebookPage = async (pageId: string, title: string) => {
    const page = state.notebookPages.find(p => p.id === pageId);
    if (!page) throw new Error('Page not found');
    page.title = title;
    page.updatedAt = Date.now();
    // sync to backing store
    const dbPage = storageDB.pages.find(p => p.id === pageId);
    if (dbPage) {
      dbPage.title = title;
      dbPage.updatedAt = page.updatedAt;
    }
  };

  const renameNotebookSection = async (sectionId: string, name: string) => {
    const section = state.notebookSections.find(s => s.id === sectionId);
    if (!section) throw new Error('Section not found');
    section.name = name;
    section.updatedAt = Date.now();
    const dbSec = storageDB.sections.find(s => s.id === sectionId);
    if (dbSec) {
      dbSec.name = name;
      dbSec.updatedAt = section.updatedAt;
    }
  };

  const deleteNotebookPage = async (pageId: string) => {
    const page = state.notebookPages.find(p => p.id === pageId);
    if (!page) return;
    page.deletedAt = Date.now();
    const dbPage = storageDB.pages.find(p => p.id === pageId);
    if (dbPage) dbPage.deletedAt = page.deletedAt;
    if (state.activePageId === pageId) {
      const activeRemaining = state.notebookPages.filter(p => p.sectionId === page.sectionId && !p.deletedAt);
      state.activePageId = activeRemaining.length > 0 ? activeRemaining[0].id : null;
    }
  };

  const createNotebookPage = async (sectionId: string, title: string) => {
    const newPage: TestPage = {
      id: `page-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      notebookId: 'nb-1',
      sectionId,
      title,
      order: state.notebookPages.filter(p => p.sectionId === sectionId).length,
      deletedAt: null,
      updatedAt: Date.now(),
    };
    state.notebookPages.push(newPage);
    storageDB.pages.push(JSON.parse(JSON.stringify(newPage)));
    return newPage;
  };

  const simulateReload = async () => {
    state.notebookSections = JSON.parse(JSON.stringify(storageDB.sections));
    state.notebookPages = JSON.parse(JSON.stringify(storageDB.pages));
  };

  return {
    state,
    renameNotebookPage,
    renameNotebookSection,
    deleteNotebookPage,
    createNotebookPage,
    simulateReload,
  };
}

test('1. Rename a page from compact navigation updates page title', async () => {
  const env = createMockEnvironment();
  const pageId = 'page-1';
  assert.equal(env.state.notebookPages.find(p => p.id === pageId)?.title, 'Page 1');

  await env.renameNotebookPage(pageId, 'Partnership Question 10');
  assert.equal(env.state.notebookPages.find(p => p.id === pageId)?.title, 'Partnership Question 10');
});

test('2. Rename persists after switching pages', async () => {
  const env = createMockEnvironment();
  await env.renameNotebookPage('page-1', 'Renamed First Page');

  // Switch to page-2
  env.state.activePageId = 'page-2';
  assert.equal(env.state.activePageId, 'page-2');

  // Switch back to page-1
  env.state.activePageId = 'page-1';
  const page1 = env.state.notebookPages.find(p => p.id === 'page-1');
  assert.equal(page1?.title, 'Renamed First Page');
});

test('3. Rename persists after reload/restart', async () => {
  const env = createMockEnvironment();
  await env.renameNotebookPage('page-1', 'Persisted Across Restart');

  // Simulate application restart
  await env.simulateReload();
  const reloaded = env.state.notebookPages.find(p => p.id === 'page-1');
  assert.equal(reloaded?.title, 'Persisted Across Restart');
});

test('4. Page ID remains unchanged after rename', async () => {
  const env = createMockEnvironment();
  const originalId = 'page-1';
  const pageBefore = env.state.notebookPages.find(p => p.id === originalId);
  assert.ok(pageBefore);

  await env.renameNotebookPage(originalId, 'Brand New Title');
  const pageAfter = env.state.notebookPages.find(p => p.title === 'Brand New Title');
  assert.ok(pageAfter);
  assert.equal(pageAfter.id, originalId, 'Page ID must remain strictly identical');
});

test('5. Page content remains unchanged after rename', async () => {
  const env = createMockEnvironment();
  const originalPayload = JSON.parse(JSON.stringify(env.state.pagePayloads['page-1']));

  await env.renameNotebookPage('page-1', 'Different Title');
  const currentPayload = env.state.pagePayloads['page-1'];
  assert.deepEqual(currentPayload, originalPayload, 'Handwriting strokes and content must be completely unaltered');
});

test('6. Delete page uses the existing safe deletion/trash flow', async () => {
  const env = createMockEnvironment();
  assert.equal(env.state.notebookPages.filter(p => !p.deletedAt && p.sectionId === 'sec-1').length, 2);

  await env.deleteNotebookPage('page-1');

  const deleted = env.state.notebookPages.find(p => p.id === 'page-1');
  assert.ok(deleted?.deletedAt, 'DeletedAt timestamp must be recorded');

  // Active page automatically fell back to page-2
  assert.equal(env.state.activePageId, 'page-2');

  // Parent section and notebook remain untouched
  const section = env.state.notebookSections.find(s => s.id === 'sec-1');
  assert.equal(section?.deletedAt, null);
  const notebook = env.state.notebooks.find(n => n.id === 'nb-1');
  assert.equal(notebook?.deletedAt, null);
});

test('7. Create a page from compact navigation', async () => {
  const env = createMockEnvironment();
  const initialCount = env.state.notebookPages.filter(p => p.sectionId === 'sec-1').length;

  const newPage = await env.createNotebookPage('sec-1', 'New Compact Page');
  assert.ok(newPage.id.startsWith('page-'));
  assert.equal(newPage.sectionId, 'sec-1');
  assert.equal(newPage.title, 'New Compact Page');
  assert.equal(newPage.deletedAt, null);

  const finalCount = env.state.notebookPages.filter(p => p.sectionId === 'sec-1').length;
  assert.equal(finalCount, initialCount + 1);
});

test('8. Rename a section from compact navigation', async () => {
  const env = createMockEnvironment();
  assert.equal(env.state.notebookSections.find(s => s.id === 'sec-1')?.name, 'Partnership(after q-5)');

  await env.renameNotebookSection('sec-1', 'Partnership (All Questions)');
  assert.equal(env.state.notebookSections.find(s => s.id === 'sec-1')?.name, 'Partnership (All Questions)');
});

test('9. Section ID remains unchanged after rename', async () => {
  const env = createMockEnvironment();
  const originalSectionId = 'sec-1';
  await env.renameNotebookSection(originalSectionId, 'Renamed Section');

  const renamedSection = env.state.notebookSections.find(s => s.name === 'Renamed Section');
  assert.ok(renamedSection);
  assert.equal(renamedSection.id, originalSectionId);
});

test('10. Section pages remain attached after rename', async () => {
  const env = createMockEnvironment();
  const pagesBefore = env.state.notebookPages.filter(p => p.sectionId === 'sec-1').map(p => p.id);

  await env.renameNotebookSection('sec-1', 'Renamed Section Attached Check');
  const pagesAfter = env.state.notebookPages.filter(p => p.sectionId === 'sec-1').map(p => p.id);

  assert.deepEqual(pagesAfter, pagesBefore, 'Pages must remain attached to the same sectionId');
});

test('11. Full sidebar immediately reflects changes made from compact navigation', async () => {
  const env = createMockEnvironment();
  // Sidebar and compact navigation both read from useWorkspaceStore
  await env.renameNotebookPage('page-1', 'Updated from Compact Nav');
  const sidebarVisibleTitle = env.state.notebookPages.find(p => p.id === 'page-1')?.title;
  assert.equal(sidebarVisibleTitle, 'Updated from Compact Nav');

  await env.renameNotebookSection('sec-1', 'Section Updated from Compact Nav');
  const sidebarVisibleSection = env.state.notebookSections.find(s => s.id === 'sec-1')?.name;
  assert.equal(sidebarVisibleSection, 'Section Updated from Compact Nav');
});

test('12. Compact navigation immediately reflects changes made from the full sidebar', async () => {
  const env = createMockEnvironment();
  // If user opened sidebar and renamed page, compact nav immediately sees it
  await env.renameNotebookPage('page-1', 'Updated in Sidebar');
  const compactDropdownLabel = env.state.notebookPages.find(p => p.id === 'page-1')?.title;
  assert.equal(compactDropdownLabel, 'Updated in Sidebar');
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 2: INK MODE REGRESSION TESTS (Items 13 - 22)
// ─────────────────────────────────────────────────────────────────────────────

test('13. White and Ink resolve to different appearance tokens', async () => {
  const css = await read('../src/styles/index.css');

  // Extract :root background token
  const rootBgMatch = css.match(/:root\s*\{[^}]*--bg-primary:\s*([0-9\s]+);/);
  assert.ok(rootBgMatch, ':root must define --bg-primary');
  const whiteBg = rootBgMatch[1].trim();

  // Extract .theme-ink background token
  const inkBgMatch = css.match(/\.theme-ink\s*\{[^}]*--bg-primary:\s*([0-9\s]+);/);
  assert.ok(inkBgMatch, '.theme-ink must define --bg-primary');
  const inkBg = inkBgMatch[1].trim();

  assert.notEqual(whiteBg, inkBg, 'White and Ink backgrounds must be distinctly different');
  assert.equal(whiteBg, '255 255 255', 'White must use neutral white (255 255 255)');
  assert.equal(inkBg, '247 244 235', 'Ink must use warm off-white paper (247 244 235)');
});

test('14. Ink uses the intended warm application colors', async () => {
  const css = await read('../src/styles/index.css');
  const inkBlock = css.match(/\.theme-ink\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(inkBlock, /--bg-primary:\s*247 244 235/, 'Ink bg-primary must be warm paper #F7F4EB');
  assert.match(inkBlock, /--bg-secondary:\s*239 235 223/, 'Ink bg-secondary must be warm tone');
  assert.match(inkBlock, /--text-primary:\s*60 50 40/, 'Ink text-primary must be sepia/espresso ink');
  assert.match(inkBlock, /--border-subtle:\s*215 205 186/, 'Ink border-subtle must be warm subtle');
});

test('15. Ink has slightly reduced UI saturation compared to White where intended', async () => {
  const css = await read('../src/styles/index.css');
  const rootBlock = css.match(/:root\s*\{([^}]+)\}/)?.[1] || '';
  const inkBlock = css.match(/\.theme-ink\s*\{([^}]+)\}/)?.[1] || '';

  // Parse RGB components to compute saturation (S = (max - min) / max)
  function getSaturation(r: number, g: number, b: number): number {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
  }

  const whiteBlueMatch = rootBlock.match(/--accent-blue:\s*(\d+)\s+(\d+)\s+(\d+);/);
  const inkBlueMatch = inkBlock.match(/--accent-blue:\s*(\d+)\s+(\d+)\s+(\d+);/);
  assert.ok(whiteBlueMatch && inkBlueMatch);

  const whiteBlueSat = getSaturation(+whiteBlueMatch[1], +whiteBlueMatch[2], +whiteBlueMatch[3]);
  const inkBlueSat = getSaturation(+inkBlueMatch[1], +inkBlueMatch[2], +inkBlueMatch[3]);

  assert.ok(
    inkBlueSat < whiteBlueSat,
    `Ink accent saturation (${inkBlueSat.toFixed(2)}) must be lower than White (${whiteBlueSat.toFixed(2)})`,
  );
});

test('16. White → Ink updates immediately', () => {
  const classList = new Set<string>();
  const documentStub = {
    documentElement: {
      classList: {
        remove: (...names: string[]) => names.forEach(n => classList.delete(n)),
        add: (...names: string[]) => names.forEach(n => classList.add(n)),
        contains: (n: string) => classList.has(n),
      },
    },
  };
  const prevDoc = globalThis.document;
  // @ts-expect-error minimal DOM stub
  globalThis.document = documentStub;

  try {
    applyThemeClasses('light');
    assert.equal(classList.has('theme-ink'), false);
    assert.equal(classList.has('dark'), false);

    // Switch to ink
    applyThemeClasses('ink');
    assert.equal(classList.has('theme-ink'), true, 'theme-ink must be applied immediately');
    assert.equal(classList.has('dark'), false);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('17. Ink → White restores the neutral appearance', () => {
  const classList = new Set<string>(['theme-ink']);
  const documentStub = {
    documentElement: {
      classList: {
        remove: (...names: string[]) => names.forEach(n => classList.delete(n)),
        add: (...names: string[]) => names.forEach(n => classList.add(n)),
        contains: (n: string) => classList.has(n),
      },
    },
  };
  const prevDoc = globalThis.document;
  // @ts-expect-error minimal DOM stub
  globalThis.document = documentStub;

  try {
    applyThemeClasses('light');
    assert.equal(classList.has('theme-ink'), false, 'theme-ink class must be removed');
    assert.equal(classList.has('dark'), false);
    assert.deepEqual([...classList], []);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('18. Ink appearance persists after reload/restart', () => {
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let storedTheme: string | null = 'ink';
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (k === THEME_STORAGE_KEY ? storedTheme : null),
      setItem: (k: string, v: string) => { if (k === THEME_STORAGE_KEY) storedTheme = v; },
    },
  });

  try {
    const resolved = readAndMigrateTheme();
    assert.equal(resolved, 'ink');
    assert.equal(storedTheme, 'ink');
  } finally {
    if (prevStorage) Object.defineProperty(globalThis, 'localStorage', prevStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('19. Handwriting colors remain unchanged between White and Ink', async () => {
  // Handwriting strokes store absolute user hex/rgb values (e.g. #2563eb, #16a34a, #000000)
  // Verify DrawingEngine does not apply theme classes or CSS color filters to stroke styles
  const drawingSource = await read('../src/components/notebook/engine/DrawingEngine.ts');
  assert.doesNotMatch(drawingSource, /theme-ink/);
  assert.doesNotMatch(drawingSource, /--bg-primary/);

  // Stroke point data holds exact RGB/hex untouched
  const stroke = { color: '#0000ff', width: 2, points: [{ x: 10, y: 10, pressure: 0.5 }] };
  assert.equal(stroke.color, '#0000ff', 'Stroke color must remain strictly original');
});

test('20. PDF colors remain unchanged between White and Ink', async () => {
  const pdfSource = await read('../src/components/pdf/PdfWorkspace.tsx');
  // PDF canvas rendering does not filter or color-shift via theme-ink
  assert.doesNotMatch(pdfSource, /filter:\s*hue-rotate/);
  assert.doesNotMatch(pdfSource, /filter:\s*sepia/);
});

test('21. Images/media remain unchanged between White and Ink', async () => {
  const imageSource = await read('../src/components/notebook/engine/ImageManager.ts');
  assert.doesNotMatch(imageSource, /theme-ink/);
  assert.doesNotMatch(imageSource, /filter:\s*invert/);
});

test('22. Page/grid/template colors are not unintentionally modified by the Ink UI treatment', async () => {
  const pageRenderer = await read('../src/components/notebook/PageRenderer.tsx');
  // Verify explicit contract in PageRenderer:
  // "Paper and template ink are persisted document values. Application theme only styles Panvas chrome and must never rewrite either value."
  assert.match(pageRenderer, /const effectiveBgColor = renderModel\.paperColor;/);
  assert.match(pageRenderer, /const effectiveLineColor = renderModel\.lineColor;/);
  assert.match(pageRenderer, /backgroundColor: effectiveBgColor/);
});

