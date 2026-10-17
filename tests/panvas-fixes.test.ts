import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readLastLibraryView,
  writeLastLibraryView,
} from '../src/services/library/libraryRouteState.ts';
import {
  projectLibraryTrashFiles,
} from '../src/components/library/libraryModel.ts';
import {
  DEFAULT_PAGE_LAYER_ID,
} from '../src/components/notebook/engine/drawingTypes.ts';
import {
  STICKY_NOTE_COLORS,
  STICKY_NOTE_SHAPES,
  createStickyNote,
  getShapeBorderRadius,
  getStickyNoteColor,
  getStickyNoteOpacity,
  getStickyNoteShape,
  hexToRgba,
  isStickyNote,
  isStickyNoteColor,
  isValidHexColor,
  updateStickyNote,
  updateStickyNoteColor,
} from '../src/components/notebook/stickyNotes.ts';
import {
  serializeSnapshotForComparison,
  validateElementSnapshot,
  getStarterElements,
} from '../src/services/elements/LocalElementRepository.ts';
import { LayerManager } from '../src/components/notebook/engine/LayerManager.ts';
import { ViewportManager } from '../src/components/notebook/engine/ViewportManager.ts';
import { ShapeManager } from '../src/components/notebook/engine/ShapeManager.ts';

// ----------------------------------------------------
// 1. Default Opening View = Recent
// ----------------------------------------------------
test('readLastLibraryView defaults to "recent" on fresh app launch', () => {
  const sessionStore = new Map<string, string>();
  const localStore = new Map<string, string>();
  const prevWindow = (globalThis as any).window;

  const mockWindow = {
    sessionStorage: {
      getItem: (key: string) => sessionStore.get(key) ?? null,
      setItem: (key: string, val: string) => sessionStore.set(key, val),
      removeItem: (key: string) => sessionStore.delete(key),
    },
    localStorage: {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, val: string) => localStore.set(key, val),
      removeItem: (key: string) => localStore.delete(key),
    },
    dispatchEvent: () => true,
  };
  (globalThis as any).window = mockWindow;

  try {
    const view = readLastLibraryView();
    assert.equal(view, 'recent', 'Must default to recent on open');
    assert.equal(sessionStore.get('panvas.initialLandingHandled'), 'true', 'Must mark session landed');

    writeLastLibraryView('library');
    assert.equal(readLastLibraryView(), 'library', 'User explicit choice must be respected');
  } finally {
    (globalThis as any).window = prevWindow;
  }
});

// ----------------------------------------------------
// 2. Global Trash with Origin Paths
// ----------------------------------------------------
test('projectLibraryTrashFiles includes items from all workspaces with correct origin paths', () => {
  const workspaces = [
    { id: 'ws-1', name: 'Work Project', updatedAt: 1 },
    { id: 'ws-2', name: 'Personal Sketches', updatedAt: 1 },
  ];
  const folders = [
    { id: 'folder-1', workspaceId: 'ws-1', parentId: null, name: 'Design', updatedAt: 1 },
  ];
  const notebooks = [
    { id: 'nb-1', workspaceId: 'ws-1', folderId: 'folder-1', name: 'Architecture', updatedAt: 1 },
    { id: 'nb-2', workspaceId: 'ws-2', folderId: null, name: 'Ideas', updatedAt: 1 },
  ];
  const sections = [
    { id: 'sec-1', notebookId: 'nb-1', name: 'Sprint 1', updatedAt: 1 },
  ];

  const now = Date.now();
  const deletedPages = [
    {
      id: 'page-del-1',
      title: 'UI Mockups',
      type: 'page',
      notebookId: 'nb-1',
      sectionId: 'sec-1',
      deletedAt: now,
      updatedAt: now,
    },
  ];
  const deletedNotebooks = [
    {
      id: 'nb-del-2',
      name: 'Old Sketches',
      workspaceId: 'ws-2',
      folderId: null,
      deletedAt: now - 5000,
      updatedAt: now - 5000,
    },
  ];

  const projected = projectLibraryTrashFiles({
    activeWorkspaceId: 'ws-1', // activeWorkspace is ws-1, but trash projection must be global!
    workspaces: [],
    folders: [],
    notebooks: deletedNotebooks,
    sections: [],
    pages: deletedPages,
    canvasFiles: [],
    activeWorkspaces: workspaces as any,
    activeFolders: folders as any,
    activeNotebooks: notebooks as any,
    activeSections: sections as any,
  }, now);

  assert.equal(projected.length, 2, 'Must include items from both workspaces');

  const pageItem = projected.find(p => p.id === 'page-del-1');
  assert.ok(pageItem, 'Page item must be present');
  assert.equal(pageItem?.originPath, 'Work Project / Design / Architecture / Sprint 1');

  const nbItem = projected.find(p => p.id === 'nb-del-2');
  assert.ok(nbItem, 'Notebook item from ws-2 must be present');
  assert.equal(nbItem?.originPath, 'Personal Sketches');
});

// ----------------------------------------------------
// 3. Layer Management & Fallback for Undefined Layer IDs
// ----------------------------------------------------
test('ShapeManager and LayerManager fallback undefined layerId to DEFAULT_PAGE_LAYER_ID', () => {
  const layers = new LayerManager();
  const viewport = new ViewportManager();
  const shapeManager = new ShapeManager(viewport, layers);

  const legacyShape: any = {
    id: 'shape-legacy',
    type: 'shape',
    shapeType: 'rectangle',
    x: 10,
    y: 10,
    width: 100,
    height: 50,
    color: '#000000',
    strokeWidth: 2,
    fill: null,
    rotation: 0,
    createdAt: Date.now(),
  };
  shapeManager.setShapes([legacyShape]);

  let rendered = false;
  const mockCtx = {
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    beginPath: () => {},
    rect: () => { rendered = true; },
    roundRect: () => { rendered = true; },
    strokeRect: () => {},
    fillRect: () => {},
    stroke: () => {},
    fill: () => {},
  } as any;

  shapeManager.renderShapes(mockCtx, DEFAULT_PAGE_LAYER_ID);
  assert.equal(rendered, true, 'Legacy shape without layerId must render on default layer');

  rendered = false;
  shapeManager.renderShapes(mockCtx, 'other-layer');
  assert.equal(rendered, false, 'Legacy shape must not render on other layer');
});

// ----------------------------------------------------
// 4. Local Elements: Capture, Insertion, and Deduplication
// ----------------------------------------------------
test('LocalElementRepository prevents saving duplicate identical snapshots', () => {
  const snapshotA = {
    type: 'panvas/elements' as const,
    strokes: [],
    shapes: [{
      id: 'shp-1',
      type: 'shape' as const,
      shapeType: 'rectangle' as const,
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      color: '#ff0000',
      strokeWidth: 2,
      fill: null,
      rotation: 0,
      createdAt: 1000,
    }],
    texts: [],
    images: [],
  };

  const snapshotB = {
    type: 'panvas/elements' as const,
    strokes: [],
    shapes: [{
      id: 'shp-2-diff-id',
      type: 'shape' as const,
      shapeType: 'rectangle' as const,
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      color: '#ff0000',
      strokeWidth: 2,
      fill: null,
      rotation: 0,
      createdAt: 2000,
    }],
    texts: [],
    images: [],
  };

  const keyA = serializeSnapshotForComparison(snapshotA);
  const keyB = serializeSnapshotForComparison(snapshotB);
  assert.equal(keyA, keyB, 'Normalized comparison keys must match for identical content');

  const snapshotC = {
    ...snapshotA,
    shapes: [{ ...snapshotA.shapes[0], color: '#00ff00' }],
  };
  const keyC = serializeSnapshotForComparison(snapshotC);
  assert.notEqual(keyA, keyC, 'Different content must produce different keys');
});

// ----------------------------------------------------
// 5. Sticky Notes: Colors, Shapes, Opacity, and Persistence
// ----------------------------------------------------
test('Sticky notes support expanded palette, custom hex colors, 6 shapes, and opacity', () => {
  assert.ok(STICKY_NOTE_COLORS.length >= 7);
  assert.ok(STICKY_NOTE_COLORS.every(color => isValidHexColor(color.value)));
  const colorNames = STICKY_NOTE_COLORS.map(c => c.name);
  assert.ok(colorNames.includes('Warm Yellow'));
  assert.ok(colorNames.includes('Soft Green'));
  assert.ok(colorNames.includes('Sky Blue'));
  assert.ok(colorNames.includes('Rose Pink'));
  assert.ok(colorNames.includes('Lavender'));
  assert.ok(colorNames.includes('Warm Peach'));
  assert.ok(colorNames.includes('Neutral Gray'));

  assert.equal(isValidHexColor('#fff'), true);
  assert.equal(isValidHexColor('#123456'), true);
  assert.equal(isValidHexColor('#12345678'), true);
  assert.equal(isValidHexColor('rgb(0,0,0)'), false);
  assert.equal(isValidHexColor('#xyz'), false);

  assert.equal(isStickyNoteColor('#fef08a'), true);
  assert.equal(isStickyNoteColor('#3b82f6'), true);
  assert.equal(isStickyNoteColor('invalid'), false);

  assert.equal(hexToRgba('#fef08a', 1), 'rgba(254, 240, 138, 1)');
  assert.equal(hexToRgba('#fef08a', 0.5), 'rgba(254, 240, 138, 0.5)');
  assert.equal(hexToRgba('#fef08a', 0), 'rgba(254, 240, 138, 0)');

  const shapeIds = STICKY_NOTE_SHAPES.map(s => s.id);
  assert.deepEqual(shapeIds, ['rounded-rect', 'square', 'rectangle', 'circle', 'oval', 'star']);
  assert.equal(getShapeBorderRadius('square'), '0px');
  assert.equal(getShapeBorderRadius('rectangle'), '0px');
  assert.equal(getShapeBorderRadius('circle'), '9999px');
  assert.equal(getShapeBorderRadius('oval'), '50%');
  assert.equal(getShapeBorderRadius('rounded-rect'), '12px');

  const note = createStickyNote({
    id: 'note-1',
    x: 50,
    y: 50,
    color: '#bae6fd',
    opacity: 0.8,
    shape: 'star',
  });
  assert.equal(isStickyNote(note), true);
  assert.equal(getStickyNoteColor(note), '#bae6fd');
  assert.equal(getStickyNoteOpacity(note), 0.8);
  assert.equal(getStickyNoteShape(note), 'star');

  const updated = updateStickyNote(note, {
    color: '#fed7aa',
    opacity: 0.5,
    shape: 'circle',
  });
  assert.equal(getStickyNoteColor(updated), '#fed7aa');
  assert.equal(getStickyNoteOpacity(updated), 0.5);
  assert.equal(getStickyNoteShape(updated), 'circle');

  const reColored = updateStickyNoteColor(updated, '#bbf7d0');
  assert.equal(getStickyNoteColor(reColored), '#bbf7d0');
  assert.equal(getStickyNoteShape(reColored), 'circle', 'Shape must be preserved on color update');
});
