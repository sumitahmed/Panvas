import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createEmptyDrawingData, type DrawingData } from '../src/components/notebook/engine/drawingTypes.ts';
import { SceneMutationCoordinator } from '../src/components/notebook/engine/sceneMutationCoordinator.ts';
import { captureFreshPageOwnedDrawing } from '../src/components/notebook/notebookPageRenderState.ts';

const nextTask = () => new Promise<void>(resolve => queueMicrotask(resolve));

test('ordinary commits and reverse-order undo/redo publish one logical mutation each', async () => {
  const coordinator = new SceneMutationCoordinator();
  let mutations = 0;
  const publish = (channel: 'drawing' | 'history') => {
    if (coordinator.accept(channel)) mutations += 1;
  };
  publish('history');
  publish('drawing');
  assert.equal(mutations, 1, 'history then drawing is one ordinary commit');
  await nextTask();
  publish('drawing');
  publish('history');
  assert.equal(mutations, 2, 'drawing then history is one undo/redo commit');
  await nextTask();
  publish('drawing');
  await nextTask();
  publish('drawing');
  assert.equal(mutations, 4, 'independent text/input edits remain independent');
  await nextTask();
  publish('history');
  publish('history');
  assert.equal(mutations, 6, 'independent history-only transforms are never collapsed');
});

test('fresh page-owned capture validates ownership before one immutable scene read', () => {
  const live = createEmptyDrawingData();
  live.properties.paperColor = '#fff4cc';
  live.objects = [
    { id: 'ink', type: 'stroke', tool: 'pen', color: '#111', thickness: 2, opacity: 1, createdAt: 1, points: [{ x: 1, y: 2, pressure: .5, t: 0 }] },
    { id: 'shape', type: 'shape', shapeType: 'rectangle', x: 1, y: 2, width: 3, height: 4, color: '#222', strokeWidth: 1, fill: null, rotation: 0, opacity: 1, createdAt: 2 },
    { id: 'text', type: 'text', x: 5, y: 6, width: 100, height: 30, createdAt: 3, content: { type: 'doc', content: [] } },
    { id: 'image', type: 'image', x: 7, y: 8, width: 90, height: 70, rotation: 0, opacity: 1, createdAt: 4, fileId: 'asset' },
  ] as DrawingData['objects'];
  let reads = 0;
  const snapshot = captureFreshPageOwnedDrawing('book', 'A', 'A', 7, () => {
    reads += 1;
    return structuredClone(live);
  });
  assert.ok(snapshot);
  assert.equal(reads, 1);
  live.objects = [];
  live.properties.paperColor = '#000000';
  assert.deepEqual(snapshot.data.objects?.map(object => object.id), ['ink', 'shape', 'text', 'image']);
  assert.equal(snapshot.data.properties.paperColor, '#fff4cc');
  const blocked = captureFreshPageOwnedDrawing('book', 'A', 'B', 8, () => {
    reads += 1;
    return structuredClone(live);
  });
  assert.equal(blocked, null);
  assert.equal(reads, 1, 'cross-page ownership is rejected before reading mutable scene state');
});

test('Stage C renderer uses one mutation subscription, no render-time clone, and memoized inactive/text surfaces', async () => {
  const [renderer, preview, editor, pageView] = await Promise.all([
    readFile('src/components/notebook/NotebookRenderer.tsx', 'utf8'),
    readFile('src/components/notebook/InactivePagePreview.tsx', 'utf8'),
    readFile('src/components/notebook/FloatingTextEditor.tsx', 'utf8'),
    readFile('src/components/notebook/NotebookPageView.tsx', 'utf8'),
  ]);
  assert.match(renderer, /notebookEngine\.onSceneMutation\(onUserDrawingAction\)/);
  assert.doesNotMatch(renderer, /input\.onDrawingChange\(onUserDrawingAction\)/);
  assert.doesNotMatch(renderer, /history\.subscribe\([\s\S]{0,180}onUserDrawingAction/);
  assert.match(renderer, /captureFreshPageOwnedDrawing\([\s\S]*\(\) => notebookEngine\.getDrawingData\(\)/);
  assert.match(renderer, /latestCapturedDrawingRef[\s\S]*latest\.drawingRevision === owner\.revision/);
  const renderMap = renderer.slice(renderer.indexOf('layoutConfig.positions.map'), renderer.indexOf('</main>'));
  assert.doesNotMatch(renderMap, /getDrawingData\(\)/, 'React render must consume the captured cache');
  assert.match(preview, /React\.memo\(InactivePagePreviewComponent\)/);
  assert.match(editor, /React\.memo\(FloatingTextEditorComponent\)/);
  assert.match(pageView, /notebookEngine\.onSceneMutation/);
  assert.doesNotMatch(pageView, /notebookEngine\.history\.subscribe/);
});
