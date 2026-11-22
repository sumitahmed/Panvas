import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  HANDWRITING_FONT_FAMILIES,
  PANVAS_TEXT_FONT_FAMILIES,
  STANDARD_TEXT_FONT_FAMILIES,
  loadTextFont,
} from '../src/components/notebook/textFonts.ts';
import { createEmptyDrawingData, type DrawingData } from '../src/components/notebook/engine/drawingTypes.ts';
import {
  capturePageOwnedDrawing,
  mayPersistPagePropertyChange,
  mergeLoadedPageData,
  resolveNotebookPageRenderData,
} from '../src/components/notebook/notebookPageRenderState.ts';

const expectedStandardFonts = [
  'Inter, sans-serif',
  "'Newsreader', serif",
  "'Times New Roman', serif",
  "'JetBrains Mono', monospace",
  "'Courier New', monospace",
  "'Comic Sans MS', cursive",
];

const expectedHandwritingFonts = [
  "'Patrick Hand', cursive",
  "'Kalam', cursive",
  "'Caveat', cursive",
  "'Permanent Marker', cursive",
  "'Shadows Into Light', cursive",
  "'Architects Daughter', cursive",
  "'Dancing Script', cursive",
  "'Indie Flower', cursive",
  "'Gochi Hand', cursive",
  "'Schoolbell', cursive",
  "'Sacramento', cursive",
];

test('complete editor font registry is retained and every non-system face is self-hosted', async () => {
  assert.deepEqual([...STANDARD_TEXT_FONT_FAMILIES], expectedStandardFonts);
  assert.deepEqual([...HANDWRITING_FONT_FAMILIES], expectedHandwritingFonts);
  assert.deepEqual([...PANVAS_TEXT_FONT_FAMILIES], [...expectedStandardFonts, ...expectedHandwritingFonts]);

  const [manifestText, fontStyles, handwritingLoaders, bootstrap] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('src/styles/editor-fonts.css', 'utf8'),
    readFile('src/components/notebook/handwritingFontLoaders.ts', 'utf8'),
    readFile('src/bootstrap.tsx', 'utf8'),
  ]);
  const dependencies = JSON.parse(manifestText).dependencies as Record<string, string>;
  const combinedFontSources = `${fontStyles}\n${handwritingLoaders}`;
  for (const family of [
    'inter', 'newsreader', 'jetbrains-mono', 'patrick-hand', 'kalam', 'caveat',
    'permanent-marker', 'shadows-into-light', 'architects-daughter',
    'dancing-script', 'indie-flower', 'gochi-hand', 'schoolbell', 'sacramento',
  ]) {
    assert.ok(dependencies[`@fontsource/${family}`], `${family} must be a pinned local dependency`);
    assert.match(combinedFontSources, new RegExp(`@fontsource/${family.replaceAll('-', '\\-')}/`));
  }
  assert.match(bootstrap, /import\('@\/styles\/editor-fonts\.css'\)/);
  assert.doesNotMatch(fontStyles, /https?:\/\//);
  assert.doesNotMatch(handwritingLoaders, /https?:\/\//);
});

test('font availability waits for the registered face instead of OS-only width guessing', async () => {
  const originalDocument = (globalThis as { document?: unknown }).document;
  const loads: string[] = [];
  (globalThis as { document?: unknown }).document = {
    fonts: {
      load: async (query: string) => {
        loads.push(query);
        return query.includes('Sacramento') ? [{ family: 'Sacramento' }] : [];
      },
    },
    createElement: () => ({
      getContext: () => ({
        font: '',
        measureText: () => ({ width: 100 }),
      }),
    }),
  };
  try {
    assert.equal(await loadTextFont("'Sacramento', cursive"), 'loaded');
    assert.equal(await loadTextFont("'Missing Panvas Face', cursive"), 'unavailable');
    assert.deepEqual(loads, ['32px "Sacramento"', '32px "Missing Panvas Face"']);
  } finally {
    (globalThis as { document?: unknown }).document = originalDocument;
  }
});

function markerData(pageNumber: number): DrawingData {
  const marker = `PAGE_${String(pageNumber).padStart(2, '0')}`;
  const data = createEmptyDrawingData();
  data.properties = {
    ...data.properties,
    template: pageNumber % 2 === 0 ? 'Dotted' : 'Ruled',
    paperColor: pageNumber % 3 === 0 ? '#fff4cc' : '#ffffff',
    ruleLineColor: pageNumber % 5 === 0 ? '#2563eb' : '#94a3b8',
  };
  data.objects = [
    { id: `${marker}_TEXT`, type: 'text', x: pageNumber, y: pageNumber, width: 200, height: 40, createdAt: pageNumber, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: marker }] }] } },
    { id: `${marker}_DRAWING`, type: 'stroke', tool: 'pen', color: '#111111', thickness: 2, opacity: 1, createdAt: pageNumber, points: [{ x: pageNumber, y: pageNumber, pressure: 0.5, t: 0 }] },
  ] as DrawingData['objects'];
  return data;
}

function markerIds(data: DrawingData | undefined): string[] {
  return (data?.objects ?? []).map(object => object.id);
}

test('25-page cache, remount, reload, reorder, and page creation preserve strict page ownership', () => {
  const pageIds = Array.from({ length: 25 }, (_, index) => `page-${index + 1}`);
  const persisted = Object.fromEntries(pageIds.map((pageId, index) => [pageId, markerData(index + 1)]));
  let cache: Record<string, DrawingData> = {};

  for (const count of [1, 5, 10, 15, 25]) {
    cache = mergeLoadedPageData(cache, Object.fromEntries(pageIds.slice(0, count).map(id => [id, persisted[id]])));
    for (let index = 0; index < count; index += 1) {
      assert.deepEqual(
        markerIds(resolveNotebookPageRenderData(pageIds[index], pageIds[count - 1], cache, persisted[pageIds[count - 1]])),
        [`PAGE_${String(index + 1).padStart(2, '0')}_TEXT`, `PAGE_${String(index + 1).padStart(2, '0')}_DRAWING`],
      );
    }
  }

  const delayedSave = capturePageOwnedDrawing('notebook-1', 'page-8', 'page-8', 8, persisted['page-8']);
  assert.ok(delayedSave);
  persisted['page-8'].objects = [];
  assert.equal(delayedSave.sheetId, 'page-8');
  assert.equal(delayedSave.sceneOwnerSheetId, 'page-8');
  assert.equal(delayedSave.saveTargetSheetId, 'page-8');
  assert.equal(delayedSave.drawingRevision, 8);
  assert.deepEqual(markerIds(delayedSave.data), ['PAGE_08_TEXT', 'PAGE_08_DRAWING']);
  assert.equal(capturePageOwnedDrawing('notebook-1', 'page-8', 'page-9', 9, persisted['page-8']), null);
  assert.equal(mayPersistPagePropertyChange('load'), false, 'mounting a page must never autosave it');
  assert.equal(mayPersistPagePropertyChange('user'), true);

  const reordered = [...pageIds].reverse();
  const reloaded = mergeLoadedPageData({}, Object.fromEntries(reordered.map(id => [id, cache[id]])));
  for (const pageId of reordered) assert.deepEqual(markerIds(reloaded[pageId]), markerIds(cache[pageId]));

  const page26 = createEmptyDrawingData();
  const withNewPage = mergeLoadedPageData(reloaded, { 'page-26': page26 });
  assert.deepEqual(markerIds(withNewPage['page-26']), [], 'a newly created page must not inherit page 25');
  assert.deepEqual(markerIds(withNewPage['page-25']), ['PAGE_25_TEXT', 'PAGE_25_DRAWING']);
});

test('fresh and loaded drawing state does not alias nested mutable sheet data', () => {
  const first = markerData(1);
  const second = markerData(2);
  assert.notEqual(first, second);
  assert.notEqual(first.objects, second.objects);
  assert.notEqual(first.layers, second.layers);
  assert.notEqual(first.audioNotes, second.audioNotes);
  assert.notEqual(first.properties, second.properties);
  assert.notEqual((first.objects?.[1] as { points: unknown[] }).points, (second.objects?.[1] as { points: unknown[] }).points);

  const captured = capturePageOwnedDrawing('notebook-1', 'page-1', 'page-1', 1, first)!;
  assert.notEqual(captured.data, first);
  assert.notEqual(captured.data.objects, first.objects);
  assert.notEqual((captured.data.objects?.[1] as { points: unknown[] }).points, (first.objects?.[1] as { points: unknown[] }).points);
});
